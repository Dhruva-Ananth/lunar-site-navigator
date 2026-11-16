"""Fetch REAL lunar terrain + imagery and write them in the site's data format (see CONTRACT.md).

    python tools/fetch_terrain.py          (or: python tools/fetch_data.py to run every fetcher)

Deps: numpy, pillow, requests only (no GDAL). Downloads are cached in tools/_downloads/ - if a
download is blocked on your network you can fetch the file in a browser and drop it there under
the same file name, then re-run. Delete a cached file to force a re-download.

WHAT IS FETCHED, AND WHAT WAS CHECKED WHEN THIS WAS WRITTEN (Nov 2026)
----------------------------------------------------------------------
The script was written in a sandbox that could not reach NASA hosts, so NOTHING here has been
downloaded end-to-end by the author. Pages were read through a web-fetch tool only. Status of
each fact is given below; the code self-checks what could not be confirmed (see "Self-checks").

1. NASA SVS "CGI Moon Kit", https://svs.gsfc.nasa.gov/4720  (Ernie Wright, NASA GSFC SVS)
   Read on the page (file links listed there, so the URLs are verified to be *linked*; the files
   themselves were not downloaded):
     .../a004720/ldem_4.tif        1440x720   4.0 MB   float
     .../a004720/ldem_4_uint.tif   1440x720   2.0 MB   uint16
     .../a004720/ldem_16.tif       5760x2880  63.3 MB  float
     .../a004720/ldem_16_uint.tif  5760x2880  31.7 MB  uint16
     .../a004720/lroc_color_poles_4k.tif (4096x2048, 12.5 MB), _2k.tif (2048x1024, 3.2 MB),
     .../a004720/lroc_color_poles_1k.jpg (1024x512), lroc_color_2k.jpg (2048x1024, "2025 color map")
   Page text (quoted): displacement maps are "floating-point TIFFs in kilometers, relative to a
   radius of 1737.4 km, or unsigned 16-bit TIFFs in half-meters"; "For the floating-point TIFFs,
   the source data was divided by 2000"; "For the unsigned 16-bit TIFFs, the source data was
   offset by +20,000 (10 km) so that all of the values are positive"; they come from the LOLA
   "global cylindrical projections at 4, 16, and 64 pixels per degree".
       => float:  metres = value * 1000          uint16:  metres = (value - 20000) * 0.5
   Longitude: the page says "The map is centered on 0 deg longitude" (colour and displacement).
       => left edge = -180, which is already the contract layout: NO roll for SVS files.
   NOT confirmed: TIFF compression / bit depth of the colour TIFFs (assumed 8-bit RGB), and that
   row 0 is north (assumed, it is a normal displayable image).

2. Fallback: LRO LOLA Gridded Data Records (PDS), the source of the SVS maps.
     https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/LDEM_4.IMG   (+ .LBL)
     https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/LDEM_16.IMG  (+ .LBL)
   Verified from the directory listing: all four files exist; LDEM_4.IMG is 2,073,600 bytes
   (= 1440*720*2) and LDEM_16.IMG is 33,177,600 bytes (= 5760*2880*2), i.e. headerless 16-bit.
   Verified from the PDS Geosciences LOLA FAQ (pds-geosciences.wustl.edu/missions/lro/lola_faq.htm):
   "simple binary arrays of 16-bit signed integers, without any headers or compression";
   SCALING_FACTOR 0.5, OFFSET 1737400 (m).  Height above the 1737.4 km sphere = DN * 0.5 m.
   Verified from the ODE help page: LDEM_4..LDEM_128 are global, longitude 0-360.
   NOT confirmed (label text could not be read): byte order (believed LSB_INTEGER), east-positive
   with the first sample at 0 deg E (believed), first line at +90 (believed).
       => believed layout is 0..360 E, so the array is rolled by half its width.
   The PDS Geosciences copies (pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/
   data/lola_gdr/cylindrical/img/ldem_4.img) are listed as a last candidate; that exact file path
   is UNVERIFIED (only the volume root .../lrolol_1xxx/DATA/LOLA_GDR/ was confirmed).

   Not used: USGS Astrogeology "Moon LRO LOLA DEM 118m" - a single multi-GB GeoTIFF, too large
   for a browser-side demo and awkward without GDAL.

Self-checks done at run time (because of the unconfirmed items above)
   * the .LBL is downloaded and parsed (SAMPLE_TYPE, SCALING_FACTOR, WESTERNMOST_LONGITUDE, ...)
     and overrides the built-in assumptions; without a label, byte order is auto-detected;
   * value ranges must be physically plausible for the Moon (about -9.2 .. +10.8 km);
   * orientation: Mare Crisium (17N, 59E) must be a low, dark basin while the same latitude on the
     far side (17N, 121W) is high, bright highland. If the test only passes after a 180 deg roll,
     the roll is applied and a warning printed; a north/south check prints a warning only.
"""
import os
import re
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

Image.MAX_IMAGE_PIXELS = None  # the 16 px/deg maps are large but legitimate

SVS_PAGE = "https://svs.gsfc.nasa.gov/4720"
SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
IMBRIUM = "https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/"
PDSGEO = ("https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/"
          "data/lola_gdr/cylindrical/img/")  # exact file path unverified
LOLA_PAGE = "https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/"

ELEV_MIN_OK, ELEV_MAX_OK = -9500.0, 11000.0   # Moon: about -9.1 km .. +10.8 km


class DecodeError(RuntimeError):
    pass


# ----------------------------------------------------------------------------- parsing (local paths)

def read_tiff_raw(path):
    """Read a single-band TIFF (32-bit float or 16-bit integer) with Pillow -> (2D array, kind).
    kind is 'float' or 'uint16'. Raises DecodeError with a readable message otherwise."""
    try:
        im = Image.open(path)
        im.load()
    except Exception as e:  # noqa: BLE001  (Pillow raises many types)
        raise DecodeError(
            f"Pillow could not decode {os.path.basename(path)} ({e}). It may use a TIFF "
            "compression/predictor Pillow does not support, or the download is incomplete "
            "(delete it from tools/_downloads and retry).") from e
    if im.mode == "F":
        return np.asarray(im, dtype=np.float64), "float"
    if im.mode in ("I;16", "I;16L", "I;16B", "I;16N", "I"):
        return np.asarray(im).astype(np.float64), "uint16"
    raise DecodeError(f"{os.path.basename(path)}: expected a 1-band float32/uint16 TIFF, "
                      f"got Pillow mode {im.mode!r} size {im.size}")


def svs_to_metres(raw, kind):
    """SVS CGI Moon Kit displacement -> metres above the 1737.4 km sphere (see module docstring)."""
    if kind == "float":
        if np.nanmax(np.abs(raw)) > 100:      # would mean the file is not in km after all
            raise DecodeError("float DEM values exceed +-100: not kilometres as documented")
        m = raw * 1000.0
    else:
        m = (raw - 20000.0) * 0.5
    check_range(m)
    return m


def read_svs_dem(path):
    """SVS ldem_*.tif / ldem_*_uint.tif -> metres, contract layout (SVS maps are centred on lon 0)."""
    raw, kind = read_tiff_raw(path)
    if raw.ndim != 2 or raw.shape[1] != 2 * raw.shape[0]:
        raise DecodeError(f"{os.path.basename(path)}: unexpected shape {raw.shape}, want 2:1 global map")
    return svs_to_metres(raw, kind)


def parse_pds_label(path):
    """Minimal PDS3 label reader: {KEY: first value as string} (units in <> stripped)."""
    out = {}
    with open(path, "r", encoding="latin-1") as f:
        for line in f:
            m = re.match(r"\s*([A-Z_^:0-9]+)\s*=\s*(.+?)\s*$", line)
            if m and m.group(1) not in out:
                out[m.group(1)] = re.sub(r"<[^>]*>", "", m.group(2)).strip().strip('"')
    return out


def _roughness(a):
    return float(np.mean(np.abs(np.diff(a[::4, :].astype(np.float64), axis=1))))


def read_lola_img(path, label_path=None):
    """PDS LOLA GDR LDEM_n.IMG (headerless int16) -> metres above the 1737.4 km sphere, rolled
    into the contract layout (lon -180 at the left). Uses the .LBL when given, else assumptions
    documented at the top of this file (int16, 0.5 m/DN, 0..360 E, north up) + byte-order detection."""
    size = os.path.getsize(path)
    lbl = parse_pds_label(label_path) if label_path and os.path.exists(label_path) else {}
    if "LINES" in lbl and "LINE_SAMPLES" in lbl:
        h, w = int(lbl["LINES"]), int(lbl["LINE_SAMPLES"])
    else:
        h = int(round((size / 4) ** 0.5))
        w = 2 * h
    bits = int(lbl.get("SAMPLE_BITS", 16))
    if bits != 16 or size != w * h * 2:
        raise DecodeError(f"{os.path.basename(path)}: size {size} bytes does not match "
                          f"{w}x{h} 16-bit samples (incomplete download or unexpected format)")
    stype = lbl.get("SAMPLE_TYPE", "").upper()
    if stype:
        order = ">" if ("MSB" in stype or "SUN" in stype) else "<"
        dn = np.fromfile(path, dtype=order + "i2").reshape(h, w)
    else:  # no label: the correct byte order gives a far smoother surface
        le = np.fromfile(path, dtype="<i2").reshape(h, w)
        be = le.byteswap()
        dn = le if _roughness(le) <= _roughness(be) else be
        print("    (no label: byte order auto-detected as",
              "little-endian)" if dn is le else "big-endian)")
    scale = float(lbl.get("SCALING_FACTOR", 0.5))
    m = dn.astype(np.float64) * scale            # height; OFFSET (1737400 m) would give radius
    if "MISSING_CONSTANT" in lbl:
        try:
            m[dn == int(float(lbl["MISSING_CONSTANT"]))] = np.nan
        except ValueError:
            pass
    west = float(lbl.get("WESTERNMOST_LONGITUDE", 0.0))
    if abs(west) < 1e-6:                          # 0..360 E  ->  -180..180
        m = np.roll(m, w // 2, axis=1)
    elif abs(west + 180.0) > 1e-6:
        raise DecodeError(f"unexpected WESTERNMOST_LONGITUDE {west} in label")
    if lbl.get("POSITIVE_LONGITUDE_DIRECTION", "EAST").upper().startswith("W"):
        m = m[:, ::-1]
    check_range(m)
    return m


def check_range(m):
    lo, hi = float(np.nanmin(m)), float(np.nanmax(m))
    if not (ELEV_MIN_OK <= lo < -3000 and 3000 < hi <= ELEV_MAX_OK):
        raise DecodeError(f"decoded elevation range [{lo:.0f}, {hi:.0f}] m is not plausible for the "
                          "Moon (expected about -9100 .. +10800) - wrong units/byte order?")


# ----------------------------------------------------------------------------- orientation checks

def box_mean(a, lat, lon, half=3.0):
    """Mean of a contract-layout global grid (2D, or 3D image) in a +-half degree box."""
    h, w = a.shape[:2]
    r0, r1 = int((90 - lat - half) / 180 * h), int((90 - lat + half) / 180 * h)
    c0, c1 = int((lon - half + 180) / 360 * w), int((lon + half + 180) / 360 * w)
    return float(np.nanmean(a[max(r0, 0):r1, max(c0, 0):c1]))


CRISIUM, FAR = (17.0, 59.0), (17.0, -121.0)   # mare basin vs. far-side highland at the same latitude


def fix_orientation_elev(m, what="elevation"):
    """Mare Crisium must be much lower than (17N, 121W). Roll by 180 deg if that is what fixes it."""
    d = box_mean(m, *CRISIUM) - box_mean(m, *FAR)
    if d < -1500:
        ok = True
    elif d > 1500:
        print(f"  WARNING: {what} looked 180 deg out in longitude (Crisium test) - rolled it. "
              "Please report: the source convention differs from what was documented.")
        m, ok = np.roll(m, m.shape[1] // 2, axis=1), True
    else:
        ok = False
        print(f"  WARNING: {what} longitude sanity test was inconclusive (diff {d:.0f} m); check the map.")
    # north/south: Mare Imbrium (38N, 18W) should be lower than the southern highlands (38S, 18W)
    if ok and box_mean(m, 38, -18) > box_mean(m, -38, -18):
        print(f"  WARNING: {what} may be upside down (Imbrium not lower than southern highlands).")
    return m


def fix_orientation_albedo(rgb):
    g = rgb.astype(np.float64).mean(axis=2) if rgb.ndim == 3 else rgb.astype(np.float64)
    c, f = box_mean(g, *CRISIUM), box_mean(g, *FAR)
    if c < f * 0.95:
        return rgb
    if f < c * 0.95:
        print("  WARNING: albedo looked 180 deg out in longitude (Crisium test) - rolled it.")
        return np.roll(rgb, rgb.shape[1] // 2, axis=1)
    print("  WARNING: albedo longitude sanity test was inconclusive; check the map.")
    return rgb


# ----------------------------------------------------------------------------- helpers

def block_mean(a, f):
    h, w = a.shape
    return np.nanmean(a.reshape(h // f, f, w // f, f), axis=(1, 3))


def first_working(sources):
    """sources: [(label, [urls], cache_name, loader(path) -> array)]. Tries each in order, falling
    through on download OR decode failure. Returns (array, label, url_list) or (None, None, None)."""
    for label, urls, name, loader in sources:
        try:
            path = common.download_first(urls, name)
            arr = loader(path)
            print(f"  using {label}")
            return arr, label, urls
        except Exception as e:  # noqa: BLE001
            print(f"  {label} failed: {e}")
    return None, None, None


def load_lola(img_name):
    """Loader factory for the PDS fallback: fetches the matching label too (optional)."""
    def loader(path):
        lbl_name = img_name[:-4] + ".LBL"
        try:
            lbl = common.download_first([IMBRIUM + lbl_name, PDSGEO + lbl_name.lower()], lbl_name)
        except Exception as e:  # noqa: BLE001
            print(f"    label not available ({str(e).splitlines()[0]}); using documented defaults")
            lbl = None
        return read_lola_img(path, lbl)
    return loader


def dem_sources(n):
    """Candidates for the n px/deg DEM, in order of preference."""
    img = f"LDEM_{n}.IMG"
    return [
        (f"NASA SVS CGI Moon Kit ldem_{n}_uint.tif (uint16 half-metres)",
         [SVS + f"ldem_{n}_uint.tif"], f"ldem_{n}_uint.tif", read_svs_dem),
        (f"NASA SVS CGI Moon Kit ldem_{n}.tif (float km)",
         [SVS + f"ldem_{n}.tif"], f"ldem_{n}.tif", read_svs_dem),
        (f"PDS LOLA GDR {img} (int16, 0.5 m)",
         [IMBRIUM + img, PDSGEO + img.lower()], img, load_lola(img)),
    ]


def read_albedo(path):
    try:
        im = Image.open(path)
        im.load()
    except Exception as e:  # noqa: BLE001
        raise DecodeError(f"Pillow could not decode {os.path.basename(path)}: {e}") from e
    if im.mode not in ("RGB", "RGBA", "L"):
        raise DecodeError(f"{os.path.basename(path)}: unsupported image mode {im.mode!r} "
                          "(probably a 16-bit colour TIFF)")
    im = im.convert("RGB")
    if im.size[0] != 2 * im.size[1]:
        raise DecodeError(f"{os.path.basename(path)}: not a 2:1 global map {im.size}")
    return np.asarray(im)


ALBEDO_SOURCES = [
    ("LROC WAC colour map lroc_color_poles_4k.tif", [SVS + "lroc_color_poles_4k.tif"],
     "lroc_color_poles_4k.tif", read_albedo),
    ("LROC WAC colour map lroc_color_poles_2k.tif", [SVS + "lroc_color_poles_2k.tif"],
     "lroc_color_poles_2k.tif", read_albedo),
    ("LROC WAC colour map lroc_color_2k.jpg", [SVS + "lroc_color_2k.jpg"],
     "lroc_color_2k.jpg", read_albedo),
    ("LROC WAC colour map lroc_color_poles_1k.jpg", [SVS + "lroc_color_poles_1k.jpg"],
     "lroc_color_poles_1k.jpg", read_albedo),
]


def shaded_relief(elev, w=2048, h=1024):
    """Grey hill-shade from elevation: honest stand-in when no imagery could be downloaded."""
    e = np.asarray(Image.fromarray(elev.astype(np.float32), "F").resize((w, h), Image.BILINEAR),
                   dtype=np.float64)
    lat = np.radians(90 - (np.arange(h) + 0.5) / h * 180)[:, None]
    dx = 2 * np.pi * 1737400.0 / w * np.maximum(np.cos(lat), 0.05)
    slope_e = (np.roll(e, -1, axis=1) - np.roll(e, 1, axis=1)) / (2 * dx)
    g = np.clip(140 - 900 * slope_e, 20, 240)
    return np.repeat(g[..., None], 3, axis=2).astype(np.uint8)


def save_albedo(rgb, info):
    h, w = rgb.shape[:2]
    tw = 4096 if w >= 4096 else 2048
    im = Image.fromarray(rgb, "RGB")
    if (w, h) != (tw, tw // 2):
        im = im.resize((tw, tw // 2), Image.LANCZOS)
    os.makedirs(common.DATA, exist_ok=True)
    im.save(os.path.join(common.DATA, "albedo.jpg"), quality=88)
    m = common.load_manifest()
    m["albedo"] = "data/albedo.jpg"
    m["albedo_info"] = info
    common.save_manifest(m)
    print(f"  wrote data/albedo.jpg {tw}x{tw // 2}: {info['description']}")


# ----------------------------------------------------------------------------- main

def main():
    print("== terrain: LRO LOLA elevation ==")
    hi, hi_label, _ = first_working(dem_sources(16))
    lo, lo_label, _ = first_working(dem_sources(4))
    if hi is not None:
        hi = fix_orientation_elev(hi, "16 px/deg elevation")
    if lo is not None:
        lo = fix_orientation_elev(lo, "4 px/deg elevation")
    if lo is None and hi is not None:
        lo, lo_label = block_mean(hi, hi.shape[1] // 1440), hi_label + ", block-averaged to 4 px/deg"
    if lo is None:
        raise RuntimeError("no elevation source could be downloaded and decoded "
                           "(demo elevation, if any, is left in place and stays flagged as demo)")
    if lo.shape != (720, 1440):
        raise RuntimeError(f"coarse elevation has shape {lo.shape}, expected (720, 1440)")
    from_pds = "PDS" in lo_label
    desc = ("Lunar Orbiter Laser Altimeter global elevation, metres above the 1737.4 km reference "
            "sphere, 4 px/deg (about 7.6 km per pixel at the equator)"
            + (", detail view 16 px/deg (about 1.9 km)" if hi is not None else "")
            + f". Source file: {lo_label}.")
    common.write_layer("elev", lo, name="Elevation", mission="LRO LOLA", agency="NASA", units="m",
                       description=desc, source=LOLA_PAGE if from_pds else SVS_PAGE,
                       better=None, hires=hi, demo=False)

    print("== terrain: LROC WAC colour map ==")
    rgb, a_label, _ = first_working(ALBEDO_SOURCES)
    if rgb is not None:
        save_albedo(fix_orientation_albedo(rgb), {
            "description": f"{a_label} (NASA SVS CGI Moon Kit, LRO LROC WAC mosaic)",
            "mission": "LRO LROC", "agency": "NASA", "source": SVS_PAGE, "demo": False})
    else:
        save_albedo(shaded_relief(hi if hi is not None else lo), {
            "description": "Shaded relief computed from LOLA elevation (LROC colour map could not "
                           "be downloaded) - this is NOT a photograph or albedo measurement",
            "mission": "LRO LOLA", "agency": "NASA", "source": SVS_PAGE, "demo": False})
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Fetch real lunar resource layers (hydrogen, FeO, TiO2, Th, K, ...) and write them as site layers.

Run on a machine that can reach NASA PDS (the build sandbox could not):

    python tools/fetch_resources.py                 # all standard layers
    python tools/fetch_resources.py --only h,fe     # a subset
    python tools/fetch_resources.py --experimental  # also try the JAXA Kaguya GRS maps (unverified reader)

Deps: numpy, pillow, requests (via common.py). No GDAL. See CONTRACT.md.

Data sources (all Lunar Prospector, NASA; hosted by the PDS Geosciences Node, WUSTL)
-------------------------------------------------------------------------------
A. "LP reduced special products" (LP Spectrometer Team, not a peer-reviewed PDS archive)
   landing page : https://pds-geosciences.wustl.edu/missions/lunarp/reduced_special.html
   files        : https://pds-geosciences.wustl.edu/missions/lunarp/reduced/<name>.txt  and  <name>.dat
   .txt : '#' header lines, then comma-separated rows; first four columns are the min/max latitude and
          min/max longitude of the pixel (east positive), then the value (and a std-dev for some products).
   .dat : 720 x 360 simple-cylindrical image, 0.5 deg pixels, 2-byte MSB integers, first line = south
          pole, first sample = -180 E; values are 10 x the ASCII value (potassium: 1 x).
B. LP GRS Elemental Abundance, PDS data set LP-L-GRS-5-ELEM-ABUNDANCE-V1.0 (Prettyman et al. 2006), peer reviewed
   landing page : https://pds-geosciences.wustl.edu/missions/lunarp/grs_elem_abundance.html
   files        : .../lunar/lp-l-grs-5-elem-abundance-v1/lp_9001/data/lpgrs_high1_elem_abundance_{2,5,20}deg.tab
   fixed width (i10, 4 f7.1, 56 (1x, e14.4)), 880-byte records, equal-area pixels with lat/lon bounds
   (east lon, -180..180); oxides MgO Al2O3 SiO2 CaO TiO2 FeO as weight fraction g/g; K Th U in ppm.

Every layer has an ordered list of sources; the first that downloads AND parses wins.
"""
import os
import sys
import traceback

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

W, H = 720, 360  # output grid: 0.5 deg, row 0 = lat +90, col 0 = lon -180

SPECIAL_PAGE = "https://pds-geosciences.wustl.edu/missions/lunarp/reduced_special.html"
SPECIAL_BASES = ["https://pds-geosciences.wustl.edu/missions/lunarp/reduced/",
                 "http://pds-geosciences.wustl.edu/missions/lunarp/reduced/"]
ELEM_PAGE = "https://pds-geosciences.wustl.edu/missions/lunarp/grs_elem_abundance.html"
ELEM_BASES = ["https://pds-geosciences.wustl.edu/lunar/lp-l-grs-5-elem-abundance-v1/lp_9001/data/",
              "https://pds-geosciences.wustl.edu/Lunar/lp-l-grs-5-elem-abundance-v1/lp_9001/data/",
              "http://pds-geosciences.wustl.edu/lunar/lp-l-grs-5-elem-abundance-v1/lp_9001/data/"]
KAGUYA_PAGE = "https://darts.isas.jaxa.jp/en/datasets/sln-l-grs-5-nuclide-map-v1.0"
KAGUYA_BASES = ["https://data.darts.isas.jaxa.jp/pub/pds3/sln-l-grs-5-nuclide-map-v1.0/data/"]

# element -> oxide mass factors (oxide molar mass / element mass in it)
FE_TO_FEO, TI_TO_TIO2 = 1.2865, 1.6681
MG_TO_MGO, AL_TO_AL2O3, CA_TO_CAO, SI_TO_SIO2 = 1.6583, 1.8895, 1.3992, 2.1393

# 0-based column numbers in the PDS elemental-abundance table (label LPGRS_ELEM_ABUNDANCE.FMT)
ELEM_COLS = {"mgo": 7, "al2o3": 8, "sio2": 9, "cao": 10, "tio2": 11, "feo": 12, "k": 13, "th": 14, "u": 15}


# ----------------------------------------------------------------------------------------------
# Rasteriser: lat/lon rectangles -> regular equirectangular grid
# ----------------------------------------------------------------------------------------------
def rasterize_bins(lat0, lat1, lon0, lon1, val, width=W, height=H):
    """Fill each bin's lat/lon rectangle into a (height, width) grid; row 0 = +90, col 0 = -180.
    A grid pixel belongs to a bin when its CENTRE lies inside the bin. Longitudes may be given as
    -180..180 or 0..360 east; bins crossing the +-180 seam are split. NaN where no bin."""
    lat0, lat1, lon0, lon1, val = (np.asarray(x, dtype=np.float64) for x in (lat0, lat1, lon0, lon1, val))
    lat0, lat1 = np.minimum(lat0, lat1), np.maximum(lat0, lat1)
    out = np.full((height, width), np.nan)
    dy, dx = 180.0 / height, 360.0 / width
    eps = 1e-6
    # rows whose centre latitude 90-(r+.5)dy is within [lat0, lat1]
    r0 = np.ceil((90.0 - lat1) / dy - 0.5 - eps).astype(int)
    r1 = np.ceil((90.0 - lat0) / dy - 0.5 - eps).astype(int)
    rc = np.clip(np.floor((90.0 - 0.5 * (lat0 + lat1)) / dy).astype(int), 0, height - 1)

    def cols(a, b):
        c0 = int(np.ceil((a + 180.0) / dx - 0.5 - eps))
        c1 = int(np.ceil((b + 180.0) / dx - 0.5 - eps))
        if c1 <= c0:  # bin narrower than a pixel: give it the pixel containing its centre
            c0 = int(np.floor((0.5 * (a + b) + 180.0) / dx))
            c1 = c0 + 1
        return max(c0, 0), min(c1, width)

    for i in range(val.size):
        v = val[i]
        if not np.isfinite(v):
            continue
        a, b = lon0[i], lon1[i]
        full = abs(b - a) >= 360.0 - 1e-9 or (a > b and abs(a - b) < 1e-9)
        if full:
            spans = [(-180.0, 180.0)]
        else:
            a = (a + 180.0) % 360.0 - 180.0          # into [-180, 180)
            b = (b + 180.0) % 360.0 - 180.0
            if b <= a:                               # ends at/over the seam
                spans = [(a, 180.0)] + ([(-180.0, b)] if b > -180.0 + 1e-9 else [])
            else:
                spans = [(a, b)]
        ra, rb = max(r0[i], 0), min(r1[i], height)
        if rb <= ra:
            ra, rb = rc[i], rc[i] + 1
        for sa, sb in spans:
            c0, c1 = cols(sa, sb)
            out[ra:rb, c0:c1] = v
    return out


# ----------------------------------------------------------------------------------------------
# Parsers
# ----------------------------------------------------------------------------------------------
def _numeric_rows(path, min_cols):
    """Rows of floats from a comma/whitespace separated text file; '#' and non-numeric lines skipped."""
    rows = []
    with open(path, "r", encoding="latin-1") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            parts = s.replace(",", " ").replace(";", " ").split()
            if len(parts) < min_cols:
                continue
            try:
                rows.append([float(p) for p in parts])
            except ValueError:
                continue
    if not rows:
        raise ValueError(f"no numeric rows with >= {min_cols} columns in {os.path.basename(path)}")
    n = min(len(r) for r in rows)
    return np.array([r[:n] for r in rows], dtype=np.float64)


def parse_special_txt(path, value_col=4):
    """LP special-product ASCII table -> (lat0, lat1, lon0, lon1, value).
    Documented: first four columns = min/max latitude and min/max longitude. The exact order of the
    two pairs is not documented, so it is detected: the pair that exceeds +-90 is longitude."""
    t = _numeric_rows(path, value_col + 1)
    p, q = t[:, 0:2], t[:, 2:4]
    p_is_lon = np.nanmax(np.abs(p)) > 90.5
    q_is_lon = np.nanmax(np.abs(q)) > 90.5
    if p_is_lon == q_is_lon:
        raise ValueError("cannot tell latitude from longitude columns in " + os.path.basename(path)
                         + f" (|cols 0-1| max {np.nanmax(np.abs(p)):.1f}, |cols 2-3| max {np.nanmax(np.abs(q)):.1f})")
    lat, lon = (q, p) if p_is_lon else (p, q)
    v = t[:, value_col].copy()
    v[(v <= -990.0) | ~np.isfinite(v)] = np.nan   # defensive: common no-data sentinels (-999, -9999)
    print(f"    {os.path.basename(path)}: {len(v)} bins, lat {np.nanmin(lat):g}..{np.nanmax(lat):g}, "
          f"lon {np.nanmin(lon):g}..{np.nanmax(lon):g}, value {np.nanmin(v):g}..{np.nanmax(v):g}")
    return lat[:, 0], lat[:, 1], lon[:, 0], lon[:, 1], v


def parse_special_dat(path, scale=10.0):
    """LP special-product binary image: 720x360, int16 big-endian, first line = south pole, first
    sample = -180 E, stored value = scale x physical value. Returns (360, 720) array, row 0 = +90."""
    raw = np.fromfile(path, dtype=">i2")
    if raw.size != W * H:
        raise ValueError(f"{os.path.basename(path)}: expected {W * H} int16 samples, got {raw.size}")
    a = raw.reshape(H, W).astype(np.float64)
    a[a <= -9990] = np.nan            # no-data value is not documented; guard the usual sentinels
    return np.flipud(a) / scale


def parse_elem_tab(path):
    """PDS LP GRS elemental-abundance table -> (lat0, lat1, lon0, lon1, table[n, 61])."""
    rows = []
    with open(path, "r", encoding="latin-1") as f:
        for line in f:
            s = line.rstrip("\r\n")
            if not s.strip():
                continue
            parts = s.split()
            if len(parts) != 61:      # fields touching: fall back to the documented fixed widths
                parts = [s[0:10], s[10:17], s[17:24], s[24:31], s[31:38]] + \
                        [s[38 + 15 * k: 53 + 15 * k] for k in range(56)]
            try:
                rows.append([float(p) for p in parts[:16]])
            except ValueError:
                continue
    if not rows:
        raise ValueError("no parsable rows in " + os.path.basename(path))
    t = np.array(rows, dtype=np.float64)
    print(f"    {os.path.basename(path)}: {len(t)} equal-area pixels")
    return t[:, 1], t[:, 2], t[:, 3], t[:, 4], t


def elem_column(t, key):
    """Column from the elemental table in display units: oxides -> wt%, K/Th/U -> ppm.
    The label lists oxides as weight fraction (g/g) and K/Th/U with unit ppm but description
    'weight fraction', so the scale is checked against the data instead of assumed."""
    v = t[:, ELEM_COLS[key]].copy()
    mx = np.nanmax(v)
    if key in ("k", "th", "u"):
        if mx < 0.05:                 # stored as weight fraction g/g -> ppm
            v *= 1e6
            print(f"    {key}: values look like weight fraction (max {mx:.3g}); converted x1e6 to ppm")
    else:
        if mx <= 1.5:                 # weight fraction -> wt%
            v *= 100.0
        else:
            print(f"    {key}: values look like wt% already (max {mx:.3g}); not rescaled")
    return v


# ----------------------------------------------------------------------------------------------
# Source loaders (each returns a (360, 720) array + a short note of what was used)
# ----------------------------------------------------------------------------------------------
def _urls(bases, fname):
    return [b + fname for b in bases]


def src_special(name, factor=1.0, dat_scale=10.0, note=""):
    def load():
        try:
            p = common.download_first(_urls(SPECIAL_BASES, name + ".txt"))
            lat0, lat1, lon0, lon1, v = parse_special_txt(p)
            arr = rasterize_bins(lat0, lat1, lon0, lon1, v)
            used = name + ".txt"
        except Exception as e:  # noqa: BLE001
            print(f"    {name}.txt unusable ({str(e).splitlines()[0]}); trying binary {name}.dat")
            p = common.download_first(_urls(SPECIAL_BASES, name + ".dat"))
            arr = parse_special_dat(p, dat_scale)
            used = name + ".dat"
        return arr * factor, f"LP special product {used}" + (f"; {note}" if note else ""), SPECIAL_PAGE
    return load


def src_elem(deg, key, note=""):
    def load():
        fname = f"lpgrs_high1_elem_abundance_{deg}deg.tab"
        p = common.download_first(_urls(ELEM_BASES, fname))
        lat0, lat1, lon0, lon1, t = parse_elem_tab(p)
        arr = rasterize_bins(lat0, lat1, lon0, lon1, elem_column(t, key))
        return arr, f"PDS LP-L-GRS-5-ELEM-ABUNDANCE-V1.0 {fname}" + (f"; {note}" if note else ""), ELEM_PAGE
    return load


# ---- experimental: JAXA Kaguya GRS nuclide maps (PDS3 label + binary image; label NOT verified) ----
def parse_pds3_label(text):
    kv = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            kv.setdefault(k.strip().upper(), v.strip().strip('"').strip())
    return kv


def _num(s):
    return float(s.split("<")[0].strip().strip('"'))


def read_pds3_global_image(lbl_path, img_path):
    """Generic reader for a single-band, global, simple-cylindrical PDS3 image. Refuses anything it
    cannot place unambiguously on the globe."""
    with open(lbl_path, "r", encoding="latin-1") as f:
        kv = parse_pds3_label(f.read())
    lines, samples = int(_num(kv["LINES"])), int(_num(kv["LINE_SAMPLES"]))
    bits = int(_num(kv["SAMPLE_BITS"]))
    st = kv.get("SAMPLE_TYPE", "").upper()
    if int(_num(kv.get("BANDS", "1"))) != 1:
        raise ValueError("multi-band image not supported")
    order = "<" if ("LSB" in st or "PC" in st or "VAX" in st) else ">"
    kind = "f" if "REAL" in st else ("u" if "UNSIGNED" in st else "i")
    dt = np.dtype(f"{order}{kind}{bits // 8}")
    raw = np.fromfile(img_path, dtype=np.uint8)
    need = lines * samples * dt.itemsize
    if raw.size < need:
        raise ValueError(f"image too small: {raw.size} < {need} bytes")
    a = np.frombuffer(raw[raw.size - need:].tobytes(), dtype=dt).reshape(lines, samples).astype(np.float64)
    a = a * _num(kv.get("SCALING_FACTOR", "1")) + _num(kv.get("OFFSET", "0"))
    for key in ("MISSING_CONSTANT", "INVALID_CONSTANT", "NULL", "CORE_NULL"):
        if key in kv:
            try:
                a[a == _num(kv[key])] = np.nan
            except ValueError:
                pass
    try:
        north, south = _num(kv["MAXIMUM_LATITUDE"]), _num(kv["MINIMUM_LATITUDE"])
        west, east = _num(kv["WESTERNMOST_LONGITUDE"]), _num(kv["EASTERNMOST_LONGITUDE"])
    except KeyError as e:
        raise ValueError(f"label has no {e} keyword; cannot georeference") from None
    if abs(north - 90) > 1 or abs(south + 90) > 1 or abs((east - west) - 360) > 1:
        raise ValueError(f"not a global map (lat {south}..{north}, lon {west}..{east})")
    if abs(west) < 1:                       # 0..360 east -> -180..180
        a = np.roll(a, samples // 2, axis=1)
    elif abs(west + 180) > 1:
        raise ValueError(f"unsupported westernmost longitude {west}")
    return a, kv.get("UNIT", "?")


def src_kaguya(stem):
    def load():
        lbl = common.download_first(_urls(KAGUYA_BASES, stem + ".lbl"))
        img = common.download_first(_urls(KAGUYA_BASES, stem + ".img"))
        a, unit = read_pds3_global_image(lbl, img)
        print(f"    {stem}: {a.shape[1]}x{a.shape[0]}, label UNIT={unit}")
        return a, f"JAXA DARTS {stem}.img (label UNIT={unit}; EXPERIMENTAL reader, first line assumed north)", KAGUYA_PAGE
    return load


# ----------------------------------------------------------------------------------------------
# Layer table
# ----------------------------------------------------------------------------------------------
LP = "Lunar Prospector"
NS, GRS = LP + " Neutron Spectrometer", LP + " Gamma Ray Spectrometer"

LAYERS = [
    dict(id="h", name="Hydrogen", mission=NS, agency="NASA", units="ppm", better="high", clip0=True, plausible=(0, 3000),
         description="Hydrogen abundance (ppm by weight) inferred from epithermal neutron counts corrected with "
                     "thermal neutrons (Feldman et al. 2001). Sensitive to the top ~1 m; the footprint is tens of km, "
                     "so polar cold-trap ice is diluted. Not reliable where thorium / rare-earth elements are high "
                     "(e.g. Procellarum KREEP terrane). Negative retrievals clipped to 0.",
         sources=[src_special("hydrogenhd", note="0.5 deg grid"),
                  src_special("hydrogenlow", note="low-altitude data, ~60 km equal-area bins")]),
    dict(id="fe", name="Iron oxide (FeO)", mission=GRS, agency="NASA", units="wt%", better="high", plausible=(0, 35),
         description="FeO weight percent from Lunar Prospector gamma-ray spectroscopy. High in mare basalts "
                     "(ilmenite/pyroxene: feedstock for oxygen and iron extraction), low in feldspathic highlands.",
         sources=[src_special("ironhd", note="0.5 deg grid, already FeO wt%"),
                  src_elem(2, "feo", "2 deg equal-area pixels, FeO weight fraction x100"),
                  src_elem(5, "feo", "5 deg equal-area pixels, FeO weight fraction x100"),
                  src_special("iron5d", FE_TO_FEO, note="5 deg bins, elemental Fe wt% x1.2865 -> FeO")]),
    dict(id="ti", name="Titanium oxide (TiO2)", mission=GRS, agency="NASA", units="wt%", better="high", plausible=(0, 20),
         description="TiO2 weight percent from Lunar Prospector gamma-ray/neutron spectroscopy. Tracks ilmenite "
                     "(FeTiO3), the classic ore for hydrogen-reduction oxygen production; ilmenite-rich regolith also "
                     "retains more solar-wind volatiles.",
         sources=[src_elem(2, "tio2", "2 deg equal-area pixels, TiO2 weight fraction x100"),
                  src_special("titanium2d", TI_TO_TIO2, note="~60 km bins, elemental Ti wt% x1.6681 -> TiO2"),
                  src_elem(5, "tio2", "5 deg equal-area pixels, TiO2 weight fraction x100"),
                  src_special("titanium5d", TI_TO_TIO2, note="5 deg bins, elemental Ti wt% x1.6681 -> TiO2")]),
    dict(id="th", name="Thorium", mission=GRS, agency="NASA", units="ppm", better="high", plausible=(0, 30),
         description="Thorium abundance (ppm) from the 2.61 MeV gamma-ray line. Tracer of KREEP material "
                     "(potassium, rare-earth elements, phosphorus) and of radiogenic heat-producing elements.",
         sources=[src_special("thoriumhd", note="0.5 deg grid"),
                  src_elem(2, "th", "2 deg equal-area pixels"),
                  src_special("thoriumlow", note="low-altitude data, ~60 km bins"),
                  src_special("thorium5d", note="5 deg bins")]),
    dict(id="k", name="Potassium", mission=GRS, agency="NASA", units="ppm", better="high", plausible=(0, 10000),
         description="Potassium abundance (ppm) from Lunar Prospector gamma-ray spectroscopy; KREEP tracer.",
         sources=[src_special("potassium2d", dat_scale=1.0, note="~60 km bins"),
                  src_elem(2, "k", "2 deg equal-area pixels"),
                  src_special("potassium5d", dat_scale=1.0, note="5 deg bins")]),
    dict(id="mg", name="Magnesium oxide (MgO)", mission=GRS, agency="NASA", units="wt%", better="high", plausible=(0, 40),
         description="MgO weight percent, Lunar Prospector GRS, 5 degree (~150 km) pixels.",
         sources=[src_elem(5, "mgo", "5 deg equal-area pixels, MgO weight fraction x100"),
                  src_special("magnesium5d", MG_TO_MGO, note="5 deg bins, elemental Mg wt% x1.6583 -> MgO")]),
    dict(id="al", name="Aluminium oxide (Al2O3)", mission=GRS, agency="NASA", units="wt%", better="high", plausible=(0, 45),
         description="Al2O3 weight percent, Lunar Prospector GRS, 5 degree (~150 km) pixels. High in anorthositic "
                     "highlands (aluminium / oxygen feedstock).",
         sources=[src_elem(5, "al2o3", "5 deg equal-area pixels, Al2O3 weight fraction x100"),
                  src_special("aluminum5d", AL_TO_AL2O3, note="5 deg bins, elemental Al wt% x1.8895 -> Al2O3")]),
    dict(id="ca", name="Calcium oxide (CaO)", mission=GRS, agency="NASA", units="wt%", better="high", plausible=(0, 30),
         description="CaO weight percent, Lunar Prospector GRS, 5 degree (~150 km) pixels.",
         sources=[src_elem(5, "cao", "5 deg equal-area pixels, CaO weight fraction x100"),
                  src_special("calcium5d", CA_TO_CAO, note="5 deg bins, elemental Ca wt% x1.3992 -> CaO")]),
    dict(id="si", name="Silicon dioxide (SiO2)", mission=GRS, agency="NASA", units="wt%", better="high", plausible=(20, 65),
         description="SiO2 weight percent, Lunar Prospector GRS, 5 degree (~150 km) pixels (silicon for solar cells / glass).",
         sources=[src_elem(5, "sio2", "5 deg equal-area pixels, SiO2 weight fraction x100"),
                  src_special("silicon5d", SI_TO_SIO2, note="5 deg bins, elemental Si wt% x2.1393 -> SiO2")]),
    dict(id="u", name="Uranium", mission=GRS, agency="NASA", units="ppm", better="high", plausible=(0, 10),
         description="Uranium abundance (ppm), Lunar Prospector GRS, 5 degree pixels. In the PDS product U is tied "
                     "to thorium (U = 0.27 x Th), so it is not an independent measurement.",
         sources=[src_special("uranium5d", note="5 deg bins"),
                  src_elem(5, "u", "5 deg equal-area pixels; tied to Th (U = 0.27 Th)")]),
    dict(id="sm", name="Samarium", mission=LP + " GRS/NS", agency="NASA", units="ppm", better="high", plausible=(0, 100),
         description="Samarium abundance (micrograms per gram = ppm), Lunar Prospector, ~60 km bins. "
                     "Rare-earth-element (KREEP) tracer.",
         sources=[src_special("samarium2d", note="~60 km bins")]),
    dict(id="epi", name="Epithermal neutron flux", mission=NS, agency="NASA", units="counts/32 s", better="low", plausible=(0, 5000),
         description="Epithermal neutron counts per 32 s, Lunar Prospector, ~60 km bins. LOWER counts mean more "
                     "hydrogen in the top metre; this is the measurement the hydrogen map is derived from.",
         sources=[src_special("epis", note="~60 km bins")]),
]

EXPERIMENTAL = [
    dict(id="th_kaguya", name="Thorium (Kaguya GRS, experimental)", mission="SELENE (Kaguya) GRS", agency="JAXA",
         units="ppm", better="high", plausible=(0, 30),
         description="Thorium map from the JAXA SELENE/Kaguya gamma-ray spectrometer. Read with an unverified "
                     "generic PDS3 reader: check against the Lunar Prospector thorium map before relying on it.",
         sources=[src_kaguya("GRS_NMAP_Th_071214_081216")]),
    dict(id="k_kaguya", name="Potassium (Kaguya GRS, experimental)", mission="SELENE (Kaguya) GRS", agency="JAXA",
         units="ppm", better="high", plausible=(0, 10000),
         description="Potassium map from the JAXA SELENE/Kaguya gamma-ray spectrometer. Read with an unverified "
                     "generic PDS3 reader: check against the Lunar Prospector potassium map before relying on it.",
         sources=[src_kaguya("GRS_NMAP_K_071214_081216")]),
]


# ----------------------------------------------------------------------------------------------
def build_layer(spec):
    """Try each source in order; write the layer from the first that works. Returns (note, warnings)."""
    errors = []
    for load in spec["sources"]:
        try:
            arr, note, page = load()
            arr = np.asarray(arr, dtype=np.float64)
            if arr.ndim != 2 or arr.shape[1] != 2 * arr.shape[0]:
                raise ValueError(f"unexpected grid shape {arr.shape}")
            cover = float(np.isfinite(arr).mean())
            if cover < 0.5:
                raise ValueError(f"only {cover:.0%} of the globe has data")
            warns = []
            if spec.get("clip0"):
                arr = np.where(arr < 0, 0.0, arr)       # NaN stays NaN
            lo, hi = float(np.nanmin(arr)), float(np.nanmax(arr))
            plo, phi = spec["plausible"]
            if lo < plo - 1e-9 or hi > phi:
                warns.append(f"range {lo:.4g}..{hi:.4g} {spec['units']} outside expected {plo}..{phi} - CHECK UNITS")
            if cover < 0.98:
                warns.append(f"coverage {cover:.0%}")
            common.write_layer(spec["id"], arr, name=spec["name"], mission=spec["mission"], agency=spec["agency"],
                               units=spec["units"], description=spec["description"] + " [Source file: " + note + "]",
                               source=page, better=spec["better"], demo=False)
            return note, warns
        except Exception as e:  # noqa: BLE001
            msg = [x.strip() for x in str(e).strip().splitlines() if x.strip()]
            errors.append(" ".join(msg[:2])[:300] if msg else type(e).__name__)
            if os.environ.get("LSN_DEBUG"):
                traceback.print_exc()
    raise RuntimeError(" | ".join(errors))


def main(only=None, experimental=False):
    """Fetch every resource layer independently. Returns {layer_id: (ok, message)}."""
    specs = LAYERS + (EXPERIMENTAL if experimental else [])
    if only:
        specs = [s for s in LAYERS + EXPERIMENTAL if s["id"] in set(only)]
    results = {}
    for spec in specs:
        print(f"[{spec['id']}] {spec['name']} ({spec['mission']})")
        try:
            note, warns = build_layer(spec)
            results[spec["id"]] = (True, note + ("  WARNING: " + "; ".join(warns) if warns else ""))
        except Exception as e:  # noqa: BLE001
            results[spec["id"]] = (False, str(e))
            print(f"  FAILED: {e}")
    print("\nResource layers summary")
    print("-" * 78)
    for lid, (ok, msg) in results.items():
        print(f"  {lid:<10} {'OK    ' if ok else 'FAILED'}  {msg[:400]}")
    n_ok = sum(1 for ok, _ in results.values() if ok)
    print("-" * 78)
    print(f"  {n_ok}/{len(results)} layers written to {common.DATA}")
    missing = [l for l in ("h", "fe", "ti", "th") if l in results and not results[l][0]]
    if missing:
        print(f"  REQUIRED layers missing: {', '.join(missing)} (any demo versions of them are left untouched)")
    return results


if __name__ == "__main__":
    args = sys.argv[1:]
    only_ids = None
    if "--only" in args:
        only_ids = args[args.index("--only") + 1].split(",")
    res = main(only=only_ids, experimental="--experimental" in args)
    sys.exit(0 if any(ok for ok, _ in res.values()) else 1)

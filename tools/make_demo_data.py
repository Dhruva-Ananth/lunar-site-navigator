"""Generate SYNTHETIC placeholder data so the site can be developed/demoed offline.

Everything written here is fake (seeded noise) and is labelled as such in the manifest
(demo=True -> the UI shows a warning banner). Run tools/fetch_data.py to replace it with real data.

Deps: numpy, pillow.   Usage:  python tools/make_demo_data.py
"""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

SYN = "SYNTHETIC placeholder — not real data"
SEED = 20261115


def grid(w, h):
    """Pixel-centre lat/lon (radians) for a w x h equirectangular grid (contract layout)."""
    lon = (np.arange(w) + 0.5) / w * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(h) + 0.5) / h * np.pi
    return np.meshgrid(lon, lat)


def xyz(w, h):
    lon, lat = grid(w, h)
    return np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)


def sphere_noise(rng, w, h, octaves=6, base=1.5, persistence=0.55, waves=10):
    """Seamless fractal noise on the sphere: sums of sinusoids of 3D position (no pole/seam artefacts)."""
    x, y, z = (a.astype(np.float32) for a in xyz(w, h))
    out = np.zeros((h, w), dtype=np.float32)
    amp, freq = 1.0, base
    for _ in range(octaves):
        for _ in range(waves):
            k = rng.normal(size=3)
            k = k / np.linalg.norm(k) * freq * rng.uniform(0.7, 1.3)
            out += amp * np.sin(k[0] * x + k[1] * y + k[2] * z + rng.uniform(0, 2 * np.pi))
        amp *= persistence
        freq *= 2.0
    return out / np.abs(out).max()


def ang_dist(w, h, lat0, lon0):
    """Great-circle angle (radians) from (lat0, lon0) in degrees to each pixel."""
    x, y, z = xyz(w, h)
    la, lo = np.radians(lat0), np.radians(lon0)
    d = x * np.cos(la) * np.cos(lo) + y * np.cos(la) * np.sin(lo) + z * np.sin(la)
    return np.arccos(np.clip(d, -1, 1))


def blob(w, h, lat0, lon0, radius_deg):
    """Smooth 0..1 bump centred on a point."""
    d = np.degrees(ang_dist(w, h, lat0, lon0))
    return np.exp(-(d / radius_deg) ** 2)


# Fake "maria" (lat, lon, radius deg) on the near side, and a western "thorium" province.
MARIA = [(35, -20, 18), (25, 18, 11), (8, 30, 10), (-20, -38, 9), (18, -57, 20), (-2, 52, 7), (16, 59, 6)]


def mare_mask(w, h):
    m = np.zeros((h, w))
    for la, lo, r in MARIA:
        m = np.maximum(m, blob(w, h, la, lo, r))
    return m


def upsample(a, w, h):
    """Bicubic upsample of a global grid, wrapping in longitude so the +-180 seam stays seamless."""
    pad = 8
    src = np.concatenate([a[:, -pad:], a, a[:, :pad]], axis=1).astype(np.float32)
    f = w / a.shape[1]
    big = Image.fromarray(src, "F").resize((int(round(src.shape[1] * f)), h), Image.BICUBIC)
    off = int(round(pad * f))
    return np.asarray(big, dtype=np.float64)[:, off:off + w]


def add_craters(e, rng, count=160):
    """Crater-like bowls with raised rims, each evaluated only in a local window (fast)."""
    h, w = e.shape
    lon1 = (np.arange(w) + 0.5) / w * 2 * np.pi - np.pi
    lat1 = np.pi / 2 - (np.arange(h) + 0.5) / h * np.pi
    for _ in range(count):
        la = np.arcsin(rng.uniform(-1, 1))
        lo = rng.uniform(-np.pi, np.pi)
        rdeg = rng.uniform(0.8, 1.0) * 10 ** rng.uniform(-0.2, 0.9)
        r = np.radians(rdeg)
        depth = 600 + 2500 * (rdeg / 8.0) ** 0.6
        reach = 1.6 * r
        rows = np.nonzero(np.abs(lat1 - la) <= reach)[0]
        if abs(la) + reach > np.radians(80):
            cols = np.arange(w)
        else:
            half = int(np.ceil(reach / np.cos(abs(la) + reach) / (2 * np.pi) * w)) + 1
            c0 = int((lo + np.pi) / (2 * np.pi) * w)
            cols = np.arange(c0 - half, c0 + half + 1) % w
        LA, LO = lat1[rows][:, None], lon1[cols][None, :]
        d = np.sin(LA) * np.sin(la) + np.cos(LA) * np.cos(la) * np.cos(LO - lo)
        t = np.arccos(np.clip(d, -1, 1)) / r
        e[np.ix_(rows, cols)] += (np.where(t < 1, -depth * (1 - t ** 2), 0)
                                  + 0.25 * depth * np.exp(-((t - 1.05) / 0.18) ** 2))
    return e


def make_elev(seed, w=2880, h=1440):
    """Synthetic elevation (m) at w x h. Broad structure is built at 1/4 size and upsampled."""
    rng = np.random.default_rng(seed)
    lw, lh = w // 4, h // 4
    e = 4200.0 * sphere_noise(rng, lw, lh, octaves=6)
    e += 1500.0 * (1 - np.cos(ang_dist(lw, lh, 0, 180))) - 1500.0   # far side sits higher
    e -= 2500.0 * mare_mask(lw, lh)                                  # "mare" basins are low
    e -= 5000.0 * blob(lw, lh, -55, -170, 22)                        # big far-side southern basin
    e = upsample(e, w, h)
    e += 120.0 * sphere_noise(rng, w, h, octaves=2, base=90, waves=5)  # fine texture
    e = add_craters(e, rng)
    return np.clip(e, -8000, 8000)


def mean2(a):
    """2x2 block mean (hires -> coarse)."""
    h, w = a.shape
    return a.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))


def main():
    rng = np.random.default_rng(SEED)
    meta = dict(mission="demo", agency="demo", description=SYN, source="")

    print("generating synthetic demo layers ...")
    elev_hi = make_elev(SEED, 2880, 1440)
    elev = mean2(elev_hi)
    common.write_layer("elev", elev, name="Elevation", units="m", better=None,
                       hires=elev_hi, demo=True, **meta)

    w, h = 720, 360
    _, lat = grid(w, h)
    latd = np.degrees(lat)
    mare = mare_mask(w, h)
    n = lambda: sphere_noise(rng, w, h, octaves=5)  # noqa: E731

    hyd = 35 + 15 * n() + 110 * (np.abs(latd) / 90) ** 6
    common.write_layer("h", np.clip(hyd, 5, None), name="Hydrogen", units="ppm", better="high",
                       vmin=0, vmax=200, demo=True, **meta)

    fe = 5 + 1.5 * n() + 13 * mare
    common.write_layer("fe", np.clip(fe, 1, 22), name="Iron oxide (FeO)", units="wt%", better="high",
                       vmin=0, vmax=25, demo=True, **meta)

    ti = 0.6 + 0.3 * n() + 7 * mare * np.clip(0.5 + 0.8 * n(), 0, 1)
    common.write_layer("ti", np.clip(ti, 0.05, 12), name="Titanium oxide (TiO2)", units="wt%", better="high",
                       vmin=0, vmax=12, demo=True, **meta)

    th = 1.0 + 0.5 * n() + 9 * blob(w, h, 20, -30, 22) + 2 * blob(w, h, -50, -170, 18)
    common.write_layer("th", np.clip(th, 0.1, 13), name="Thorium", units="ppm", better="high",
                       vmin=0, vmax=13, demo=True, **meta)

    # Albedo: grey, darker in "maria", with slope shading from the synthetic elevation.
    aw, ah = 2048, 1024
    e = np.asarray(Image.fromarray(elev_hi.astype(np.float32), "F").resize((aw, ah), Image.BILINEAR))
    shade = np.clip((np.roll(e, 1, axis=1) - np.roll(e, -1, axis=1)) / 900.0, -1, 1)
    fe_big = upsample(np.clip(fe, 1, 22), aw, ah)   # darker where the synthetic FeO is high
    tex = upsample(sphere_noise(rng, aw // 4, ah // 4, octaves=6), aw, ah)
    g = 175 - 5.5 * fe_big + 14 * tex + 45 * shade
    g = np.clip(g, 0, 255)
    rgb = np.stack([g, g * 0.98, g * 0.95], axis=-1).astype(np.uint8)
    os.makedirs(common.DATA, exist_ok=True)
    Image.fromarray(rgb, "RGB").save(os.path.join(common.DATA, "albedo.jpg"), quality=88)
    m = common.load_manifest()
    m["albedo"] = "data/albedo.jpg"
    m["demo"] = True
    common.save_manifest(m)
    print("  wrote data/albedo.jpg 2048x1024 (DEMO)")

    check(elev=elev, elev_hi=elev_hi, h=np.clip(hyd, 5, None), fe=np.clip(fe, 1, 22))
    print("done - manifest demo =", common.load_manifest()["demo"])


def decode_png(path, vmin, vmax):
    """Inverse of common.encode_png (same formula as js/data.js). NaN where alpha == 0."""
    px = np.asarray(Image.open(path).convert("RGBA")).astype(np.float64)
    v = vmin + (px[..., 0] * 256 + px[..., 1]) / 65535.0 * (vmax - vmin)
    v[px[..., 3] == 0] = np.nan
    return v


def check(**arrays):
    """Round-trip check: PNGs decode back to the source values within one quantisation step."""
    m = common.load_manifest()
    assert m["demo"] is True, "manifest demo flag should be true"
    by_id = {l["id"]: l for l in m["layers"]}
    for key, src in arrays.items():
        lid, hi = (key[:-3], True) if key.endswith("_hi") else (key, False)
        meta = by_id[lid]["hires"] if hi else by_id[lid]
        dec = decode_png(os.path.join(common.ROOT, meta["file"]), meta["min"], meta["max"])
        assert dec.shape == src.shape == (meta["height"], meta["width"]), (key, dec.shape)
        err = np.nanmax(np.abs(dec - src))
        step = (meta["max"] - meta["min"]) / 65535.0
        assert err <= step * 0.51 + 1e-9, f"{key}: round-trip error {err} > half-step {step / 2}"
        print(f"  round-trip {key}: max error {err:.4g} {by_id[lid]['units']} (step {step:.4g}) OK")


if __name__ == "__main__":
    main()

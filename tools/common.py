"""Shared helpers for the data tools. Deps: numpy, pillow, requests. See CONTRACT.md."""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(ROOT, "tools", "_downloads")  # raw downloads, git-ignored
MANIFEST = os.path.join(DATA, "manifest.json")


def download(url, name=None, timeout=120):
    """Download url into tools/_downloads (skips if already there). Returns the local path."""
    import requests
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name or url.rstrip("/").split("/")[-1])
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    print(f"  downloading {url}")
    with requests.get(url, stream=True, timeout=timeout,
                      headers={"User-Agent": "lunar-site-navigator/0.1"}) as r:
        r.raise_for_status()
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        os.replace(tmp, path)
    return path


def download_first(urls, name=None):
    """Try several candidate URLs; return the first that downloads, else raise."""
    errs = []
    for u in urls:
        try:
            return download(u, name)
        except Exception as e:  # noqa: BLE001
            errs.append(f"{u}: {e}")
    raise RuntimeError("all candidate URLs failed:\n  " + "\n  ".join(errs))


def encode_png(arr, vmin, vmax, path):
    """arr: 2D float array, row 0 = lat +90, col 0 = lon -180; NaN = no-data."""
    a = np.asarray(arr, dtype=np.float64)
    valid = np.isfinite(a)
    q = np.zeros(a.shape, dtype=np.uint16)
    q[valid] = np.round(np.clip((a[valid] - vmin) / (vmax - vmin), 0, 1) * 65535).astype(np.uint16)
    rgba = np.zeros(a.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = q >> 8
    rgba[..., 1] = q & 255
    rgba[..., 3] = np.where(valid, 255, 0)
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)


def load_manifest():
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    return {"demo": True, "albedo": "data/albedo.jpg", "layers": []}


def save_manifest(m):
    os.makedirs(DATA, exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=1)


def write_layer(layer_id, arr, *, name, mission, agency, units, description, source,
                better=None, vmin=None, vmax=None, hires=None, demo=False):
    """Encode `arr` to data/<id>.png and add/replace its manifest entry.
    hires: optional second 2D array written to data/<id>_hi.png.
    demo=False marks this layer as real; manifest["demo"] becomes False once no demo layers remain."""
    os.makedirs(DATA, exist_ok=True)
    a = np.asarray(arr, dtype=np.float64)
    lo = float(np.nanmin(a)) if vmin is None else float(vmin)
    hi = float(np.nanmax(a)) if vmax is None else float(vmax)
    if hi <= lo:
        hi = lo + 1.0
    encode_png(a, lo, hi, os.path.join(DATA, f"{layer_id}.png"))
    entry = {"id": layer_id, "name": name, "mission": mission, "agency": agency, "units": units,
             "file": f"data/{layer_id}.png", "width": int(a.shape[1]), "height": int(a.shape[0]),
             "min": lo, "max": hi, "better": better, "description": description,
             "source": source, "demo": bool(demo)}
    if hires is not None:
        h = np.asarray(hires, dtype=np.float64)
        hlo, hhi = float(np.nanmin(h)), float(np.nanmax(h))
        encode_png(h, hlo, hhi, os.path.join(DATA, f"{layer_id}_hi.png"))
        entry["hires"] = {"file": f"data/{layer_id}_hi.png", "width": int(h.shape[1]),
                          "height": int(h.shape[0]), "min": hlo, "max": hhi}
    m = load_manifest()
    m["layers"] = [l for l in m["layers"] if l["id"] != layer_id] + [entry]
    m["demo"] = any(l.get("demo") for l in m["layers"])
    save_manifest(m)
    print(f"  wrote layer {layer_id}: {a.shape[1]}x{a.shape[0]} [{lo:.4g}, {hi:.4g}] {units}"
          + ("  (DEMO)" if demo else ""))


if __name__ == "__main__":
    sys.exit("import me")

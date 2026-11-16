# Lunar Site Navigator — build contract (all agents read this)

Static site (no server code, no build step) for GitHub Pages. Root: /home/claude/site
Everything must work from `python -m http.server` in the site root, with relative URLs only.
No CDN: three.js is vendored at vendor/three.module.js (r170) and vendor/OrbitControls.js
(OrbitControls imports from 'three' → index.html needs an importmap: {"imports":{"three":"./vendor/three.module.js"}}).

## Coordinates
Planetocentric lat (-90..90), east-positive lon (-180..180). Moon radius 1737.4 km.
Sub-Earth point is lat 0, lon 0.

## Data format (data/)
- data/manifest.json:
  {
    "demo": true|false,            // true = synthetic placeholder data → UI must show a clear warning banner
    "albedo": "data/albedo.jpg",   // equirectangular colour/grey image, lon -180 at left edge, lat +90 at top
    "layers": [ {
        "id": "elev", "name": "Elevation", "mission": "LRO LOLA", "agency": "NASA",
        "units": "m", "file": "data/elev.png", "width": 1440, "height": 720,
        "min": -9000, "max": 10800,          // value range used by the encoding
        "hires": {"file":"data/elev_hi.png","width":5760,"height":2880,"min":..,"max":..},   // optional
        "better": "high"|"low"|null,          // hint for scoring direction
        "description": "...", "source": "https://..."
    }, ... ]
  }
- Layer PNG: 8-bit RGBA, equirectangular, full globe, lon -180 at left, lat +90 at top (pixel centres).
  value = min + ((R*256 + G) / 65535) * (max - min);  B unused (0);  A = 255 valid, A = 0 no-data.
- Guaranteed layer ids: elev (m), h (hydrogen ppm), fe (FeO wt%), ti (TiO2 wt%), th (thorium ppm).
  Other layers may appear (e.g. k, temp, mg, psr …). The UI must be driven by the manifest, never hard-coded to this list
  (except `elev`, which is used for terrain/slope).

## Shared JS (already written, do not change signatures): js/data.js
  loadManifest() → manifest
  loadLayer(id, {hires=false}) → {id, meta, width, height, min, max, data: Float32Array (NaN = no-data)}
  sample(layer, lat, lon) → bilinear value (NaN if no-data)
  latLonToXY / colormap helpers — read the file.

## Module ownership
- Agent FRONTEND: index.html, css/style.css, js/main.js, js/scoring.js
- Agent ANALYSIS: js/region.js, js/comms.js, js/deltav.js
    region.js : export async function renderRegion(container, {latMin,latMax,lonMin,lonMax}, {manifest, weights})
                (weights = {layerId: {weight:Number 0..1, prefer:'high'|'low'}} may be null)
    comms.js  : export function earthVisibility(lat, lon) → {elevMeanDeg, elevMinDeg, elevMaxDeg, fracVisible}  (pure, fast, no DOM)
                export function renderCommsPanel(container, lat, lon)
    deltav.js : export function renderDeltaVPanel(container, lat, lon)
  Each render* function fills `container` (an empty div) with its own DOM; styles go in a <style> the module injects
  itself with class names prefixed `rg-`, `cm-`, `dv-`. Use CSS variables --bg, --panel, --text, --muted, --accent, --border
  (defined by FRONTEND) with sensible fallbacks.
- Agent TERRAIN-DATA: tools/fetch_terrain.py, tools/make_demo_data.py
- Agent RESOURCE-DATA: tools/fetch_resources.py
  Python tools share tools/common.py (already written: write_layer(), read the file).
  Python deps allowed: numpy, pillow, requests only (must run on Windows, Python 3.9+). No GDAL/rasterio.

## Honesty rules
No invented numbers presented as measurements. Approximations (delta-V, link budget, visibility) are labelled as such
in the UI with the assumption stated. Synthetic demo data is always labelled as synthetic.

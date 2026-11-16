# Lunar Landing Site Navigator

A static website (no server code, no build step) for exploring candidate lunar landing sites.
It shows the Moon as an interactive 3D globe with real orbital data sets draped on it - elevation
from NASA's Lunar Reconnaissance Orbiter, plus global resource maps (hydrogen, iron, titanium,
thorium, ...) - and lets you weight those layers to score regions, inspect a region in detail, and
get rough, clearly labelled estimates of Earth visibility / communications and delta-V for a site.

Built for the NASA Space Apps Challenge. Everything runs in the browser from plain files, so it can
be hosted on GitHub Pages.


> **Update — LODESTAR, six steps and a PDF report.** The app is now titled LODESTAR (Lunar Outpost Decision Engine for Site
> Targeting And Reachability). A new step 5, **Power** (`js/power.js`), estimates sunlight at the selected site from the LOLA
> elevation grid, the output of a vertical mast array for a chosen solar-cell efficiency, the storage needed for the longest
> darkness, and compares the total mass with a 40 kWe fission unit. Step 6, **Mission**, can add the chosen power system to the
> landed mass and has a **Download design report (PDF)** button (`js/report.js`) that writes the requirements and the design for
> that run. The PDF is built in the browser with the vendored jsPDF and jsPDF-AutoTable (see `vendor/LICENSES.md`).
>
> **Update — five-step wizard.** The site is now a guided flow: 1 Resources → 2 Terrain → 3 Comms → 4 Select site (matching
> areas) → 5 Mission (launcher + orbital configuration). Launcher data lives in `assets/launchers.json` (each entry has its
> source and says whether the trans-lunar figure is published or estimated); rocket pictures are original to-scale schematics
> in `assets/rockets/` and can be replaced with photos (see `assets/rockets/README.md`). Interfaces: `CONTRACT_V2.md`.

## Run it locally

Requires Python 3.9+ (only for fetching data and for a local web server).

```
pip install -r tools/requirements.txt
python tools/fetch_data.py
python -m http.server 8000
```

Then open <http://localhost:8000/>. (Opening `index.html` directly from disk will not work:
browsers block module scripts and data loading on `file://`.)

- `python tools/fetch_data.py` downloads the real data (roughly 50-120 MB of downloads, cached in
  `tools/_downloads/`, which is git-ignored) and writes the small web-ready files into `data/`.
  It runs the terrain fetcher and the resource fetcher independently and prints a summary of which
  layers are real.
- If a download is blocked on your network, download that file in a browser, put it in
  `tools/_downloads/` under the same file name, and run the script again.
- `python tools/make_demo_data.py` writes **synthetic placeholder data** instead (seeded noise, no
  network needed). It exists only so the site can be developed offline. Any layer that is still
  synthetic is flagged in `data/manifest.json` (`"demo": true`) and the site shows a warning banner.
  Running it after a real fetch overwrites the real layers with placeholders again.

## Publish on GitHub Pages

1. Run `python tools/fetch_data.py` so that `data/` holds real data, and check the summary says the
   manifest demo flag is `False`.
2. Commit everything, including `data/` and `vendor/` (but not `tools/_downloads/`), and push the
   repository to GitHub.
3. On GitHub: **Settings -> Pages -> Build and deployment -> Source: Deploy from a branch**, choose
   your branch (e.g. `main`) and folder **/ (root)**, then Save.
4. After a minute the site is live at `https://<user>.github.io/<repo>/`. All URLs in the site are
   relative, so it works from that sub-path.

## Data format

See `CONTRACT.md`. In short: every layer is a global equirectangular PNG (longitude -180 at the left
edge, latitude +90 at the top) holding 16-bit values in the red and green channels, and
`data/manifest.json` lists the layers with their units, value range, mission and source.

## Data sources

### Terrain and imagery (`tools/fetch_terrain.py`)

| Layer | Mission / instrument | Agency | What is used | Resolution on the site | Source |
|---|---|---|---|---|---|
| `elev` Elevation (m, relative to a 1737.4 km sphere) | Lunar Reconnaissance Orbiter, Lunar Orbiter Laser Altimeter (LOLA) | NASA | SVS "CGI Moon Kit" displacement maps `ldem_4` / `ldem_16` (derived from the LOLA gridded data records) | 4 px/deg (~7.6 km/px at the equator) globally; 16 px/deg (~1.9 km/px) for detail views | <https://svs.gsfc.nasa.gov/4720> |
| `elev` (fallback, used only if the above cannot be downloaded or decoded) | LRO LOLA Gridded Data Record `LDEM_4.IMG` / `LDEM_16.IMG` | NASA (PDS LOLA node, MIT/GSFC) | Raw 16-bit grids, 0.5 m per count | same | <https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/> |
| Globe image (`data/albedo.jpg`) | Lunar Reconnaissance Orbiter Camera, Wide Angle Camera (LROC WAC) colour mosaic | NASA | SVS "CGI Moon Kit" colour map `lroc_color_poles_4k` (smaller versions as fallback) | 4096x2048 (or 2048x1024) | <https://svs.gsfc.nasa.gov/4720> |

If no colour map can be downloaded, the fetcher writes a grey shaded-relief image computed from the
LOLA elevation instead and says so in `manifest.json` (`albedo_info`); that image is not a
photograph.

The fetcher's header comment records exactly which facts about these files were confirmed from
the providers' pages (units, encodings, longitude convention) and which were not, and the script
checks the unconfirmed ones itself when it runs (value range, east/west and north/south orientation
against known lunar features).

## Resource layers

Written by `python tools/fetch_resources.py` (also run by `tools/fetch_data.py`). Options: `--only h,fe,ti,th`,
`--experimental` (adds the JAXA Kaguya maps), env `LSN_DEBUG=1` for tracebacks. Each layer tries its sources in
order and keeps the first that downloads and parses; a failed layer never touches the manifest.
All layers are rasterised to 720x360 (0.5 deg) equirectangular; coarser products keep their native bin size
(blocky pixels are real resolution, not an artefact).

| id | Layer (units) | Mission / agency | Primary file | Fallbacks | Conversion |
|---|---|---|---|---|---|
| h | Hydrogen (ppm) | Lunar Prospector NS / NASA | `reduced/hydrogenhd.txt` (0.5 deg) | `hydrogenhd.dat`, `hydrogenlow.txt` | none; negatives clipped to 0 |
| fe | FeO (wt%) | Lunar Prospector GRS / NASA | `reduced/ironhd.txt` (0.5 deg, FeO wt%) | PDS elem. abundance 2 deg, 5 deg (FeO g/g x100); `iron5d` (Fe wt% x1.2865) | none for primary |
| ti | TiO2 (wt%) | Lunar Prospector GRS / NASA | PDS `lpgrs_high1_elem_abundance_2deg.tab` (TiO2 g/g) | `titanium2d` (Ti wt% x1.6681), PDS 5 deg, `titanium5d` | x100 |
| th | Thorium (ppm) | Lunar Prospector GRS / NASA | `reduced/thoriumhd.txt` (0.5 deg) | PDS 2 deg, `thoriumlow`, `thorium5d` | none |
| k | Potassium (ppm) | Lunar Prospector GRS / NASA | `reduced/potassium2d.txt` (~60 km) | PDS 2 deg, `potassium5d` | none |
| mg, al, ca, si | MgO, Al2O3, CaO, SiO2 (wt%) | Lunar Prospector GRS / NASA | PDS `lpgrs_high1_elem_abundance_5deg.tab` (oxide g/g) | `magnesium5d`, `aluminum5d`, `calcium5d`, `silicon5d` (element wt% x1.6583 / 1.8895 / 1.3992 / 2.1393) | x100 |
| u | Uranium (ppm) | Lunar Prospector GRS / NASA | `reduced/uranium5d.txt` | PDS 5 deg (U tied to 0.27 x Th) | none |
| sm | Samarium (ppm = ug/g) | Lunar Prospector / NASA | `reduced/samarium2d.txt` | `.dat` | none |
| epi | Epithermal neutrons (counts / 32 s; low = more H) | Lunar Prospector NS / NASA | `reduced/epis.txt` | `.dat` | none |
| th_kaguya, k_kaguya | Th, K (experimental, opt-in) | SELENE/Kaguya GRS / JAXA | `GRS_NMAP_Th_071214_081216.img`, `GRS_NMAP_K_071214_081216.img` + `.lbl` | - | per label |

Sources:
- Lunar Prospector reduced "special products" (LP Spectrometer Team; not a peer-reviewed PDS archive):
  landing page https://pds-geosciences.wustl.edu/missions/lunarp/reduced_special.html ,
  files under https://pds-geosciences.wustl.edu/missions/lunarp/reduced/
- Lunar Prospector GRS Elemental Abundance, PDS data set LP-L-GRS-5-ELEM-ABUNDANCE-V1.0 (Prettyman et al. 2006):
  landing page https://pds-geosciences.wustl.edu/missions/lunarp/grs_elem_abundance.html ,
  files under https://pds-geosciences.wustl.edu/lunar/lp-l-grs-5-elem-abundance-v1/lp_9001/data/
- SELENE (Kaguya) GRS nuclide maps, JAXA DARTS: https://darts.isas.jaxa.jp/en/datasets/sln-l-grs-5-nuclide-map-v1.0

Caveats to state when presenting: the hydrogen map has a footprint of tens of km and senses only the top ~1 m, so it
shows bulk hydrogen enrichment, not individual ice deposits, and is unreliable in high-thorium/rare-earth terrain;
5 deg products are ~150 km per pixel; the 2 deg MgO/Al2O3/SiO2/CaO values in the PDS archive are flagged by its
authors as poorly constrained, which is why those four layers use the 5 deg table.
Not included (no simple global file found that numpy alone can read in the time available): LRO Diviner
(global products are 18 large local-time-binned tables), LRO LEND, Chandrayaan-1 M3 water/OH, Clementine FeO/TiO2
(GeoTIFF mosaics), LRO LAMP.

## Honest limits

- **Coarse global data.** Elevation is shown at ~7.6 km per pixel globally (~1.9 km in detail
  views). Slopes computed from it are regional slopes over kilometres, not the metre-scale slopes
  and boulder hazards that decide whether a lander can actually touch down. Resource maps from
  orbital spectrometers are far coarser still (tens of kilometres or more per pixel).
- **Not a landing-site certification tool.** Scores are a weighted combination of the layers you
  choose; they are a way to explore trade-offs, not a mission analysis.
- **Approximations are labelled.** Earth visibility, communications and delta-V figures are simple
  models with the assumptions stated next to them in the site; they are not mission-design values.
- **Polar regions.** Equirectangular global grids are stretched near the poles, and permanently
  shadowed regions / illumination are not modelled from this elevation data.
- **The imagery is a mosaic** made for visualisation; brightness is not a calibrated albedo.
- **Synthetic data is always flagged.** If any layer is still placeholder data, the manifest says
  so and the site shows a warning.

## Repository layout

```
index.html, css/, js/     the site
vendor/                   three.js (vendored, no CDN)
data/                     web-ready layers + manifest.json (generated by tools/)
tools/fetch_data.py       fetch everything (terrain + resources)
tools/fetch_terrain.py    elevation + globe image
tools/fetch_resources.py  resource layers
tools/make_demo_data.py   synthetic placeholder data for offline development
tools/common.py           shared encoder / manifest helpers
```

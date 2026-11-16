# Rocket pictures

The mission step (js/mission.js) shows one picture per launch vehicle.

## What is here

`<id>.svg` — original schematic side views drawn for this project from basic shapes
(core, fairing, strap-on boosters, stage breaks). They contain no logos, liveries,
wordmarks or flags and are not traced from any photo.

- All files share one canvas (24 m x 126 m at 4 px per metre), so shown at the same
  height they are **to scale with each other**. Only the overall height is taken from
  the published vehicle height in `../launchers.json`; diameters, stage breaks and
  booster shapes are approximate.
- Colours are neutral greys on purpose.

## Using your own photos

1. Put the photo in this folder, e.g. `assets/rockets/sls-b1.jpg` (JPEG or PNG; a
   portrait crop of roughly 150 x 400 px or larger works best, keep it under ~300 kB).
2. In `assets/launchers.json`, set that vehicle's `"photo"` field to the path relative
   to the site root, and credit it:

   ```json
   "photo": "assets/rockets/sls-b1.jpg",
   "photo_credit": "NASA/Joel Kowsky"
   ```

3. Reload. The card shows the photo instead of the schematic; the credit appears in the
   detail line under the cards when that vehicle is selected. If the file is missing or
   broken the card falls back to the schematic by itself. Vehicles with `"photo": null`
   never request a photo, so there are no failed requests by default.

Note that a photo is not to scale with the other cards — only the schematics are.

## Where to find photos you are allowed to use

- **NASA Image and Video Library — https://images.nasa.gov** — images made by NASA
  (for example SLS, Saturn V) are generally not copyrighted and can be used with a
  credit line. Check each image's page: pictures credited to a company or another
  agency (SpaceX, Blue Origin, ULA, ESA, JAXA, ISRO ...) keep their own terms even when
  they appear on a NASA site, and NASA's logo may not be used to imply endorsement.
- For every other source, **check the licence before publishing the site**. Photos on
  operator websites and in news articles are normally copyrighted. Wikimedia Commons
  lists a licence for each file (often CC BY or CC BY-SA, which need attribution and,
  for SA, sharing under the same licence); some space agencies publish their own image
  terms.
- When in doubt, keep the schematic.

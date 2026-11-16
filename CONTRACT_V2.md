# Lunar Site Navigator — V2 contract: five-step wizard (all agents read this, plus CONTRACT.md)

The page becomes a guided five-step process. The 3D Moon stays on screen for steps 1–4; step 5 replaces it.
Real NASA data is now in data/ (manifest "demo": false; layers elev, h, fe, ti, th, k, mg, al, ca, si, u, sm, epi).
Do NOT write to data/. No CDN, no build step, relative URLs, plain ES modules (unchanged rules).

## Steps (owner: WIZARD agent — index.html, css/style.css, js/main.js, js/scoring.js)
1. RESOURCES — choose mineral / volatile criteria (every non-elevation manifest layer): weight, prefer high/low, min/max limits. Presets.
2. TERRAIN — step-1 choices shown frozen (read-only summary, with an "edit" link that goes back). Criteria here: elevation
   (min/max) and slope (max, weight). Overlays are a free choice here: user can drape any one layer (minerals, elevation, slope, suitability).
3. COMMS — steps 1–2 frozen. The suitable area shrinks again by comms availability. A separate side menu (right-hand side)
   rendered by comms.js lets the user pick Direct-to-Earth (DSN) or a lunar relay orbiter and shows approximate link times.
4. SELECT SITE — all chosen criteria listed; the Moon shows the AREAS that satisfy every criterion (filled regions with outlines,
   not points). User clicks an area on the globe (or in the list) to select it. "Analyse area" opens the existing region modal.
5. MISSION — rendered by mission.js: payload mass, launcher choice (pictures), orbital configuration, Earth on one side and Moon on the other.
At every step the UI shows how much of the lunar surface is still suitable (% of area, cos-lat weighted) so the user sees it shrink.

## comms.js additions (owner: COMMS agent — only js/comms.js; keep every existing export working)
  export const RELAY_PRESETS = [{id, name, kind, description, real:Boolean, note, ...orbit params}]
  export const DEFAULT_COMMS_STATE = {mode:'dte', relayId:<id>, dsnDishM:34, band:'X', maskDeg:5}
  export function commsAvailability(lat, lon, state) → Number 0..1   // long-run fraction of time a link to Earth exists.
        PURE, no DOM, cheap: called ~65,000–260,000 times per grid, whole grid must take well under 1 s.
        mode 'dte'  → Earth above maskDeg (libration model, as earthVisibility).
        mode 'relay'→ fraction of time the chosen relay is above maskDeg at the site (and the relay can see Earth).
  export function linkTimes(lat, lon, state) → {availability, contactHoursPerDay, passesPerDay, typicalPassMin, longestGapH,
        oneWayLightTimeS, dataRateBps, dataVolumePerDayBits, notes:[String]}   // approximate; every assumption in notes
  export function renderCommsMenu(container, state, onChange, getSite)
        Fills `container` (a narrow ~320 px column) with: DTE vs relay choice, relay picker (from RELAY_PRESETS), DSN antenna
        (34 m BWG / 70 m), band (S / X / Ka), mask angle; and a "Link times" readout for the site returned by getSite()
        (→ {lat, lon, label} or null → show a prompt to click the Moon). Calls onChange(newState) on every user change.
        Must also export/update function: container.__refresh?.()  — set container.__refresh = () => re-read getSite() and redraw readout.
  CSS class prefix cm-. Uses CSS vars --bg --panel --text --muted --accent --border.

## mission.js (owner: MISSION agent — js/mission.js, assets/launchers.json, assets/rockets/*)
  export async function renderMission(container, {site:{lat, lon, label, areaKm2?}, onBack})
  Fills `container` (the whole main area, ≥ 1000 px wide, full height). Self-contained (own <style>, prefix ms-).
  May import computeDeltaV / DEFAULTS from ./deltav.js (read it) and constants from ./comms.js.

// Earth visibility + direct-to-Earth link budget + relay geometry.
// First-order engineering estimates. Every assumption is stated in the UI ("Assumptions" blocks).
// Pure functions (earthVisibility, earthDirection, linkBudget, relayGeometry) do not touch the DOM.

const DEG = Math.PI / 180;
export const R_MOON_KM = 1737.4;
export const C_KM_S = 299792.458;
export const RANGE_MEAN_KM = 384400;   // mean Earth-Moon centre distance
export const RANGE_PERI_KM = 356400;   // approximate extreme perigee (centre to centre)
export const RANGE_APO_KM = 406700;    // approximate extreme apogee (centre to centre)
export const LIB_LON_DEG = 7.9;        // optical libration amplitude in longitude (approx.)
export const LIB_LAT_DEG = 6.7;        // optical libration amplitude in latitude (approx.)
const BOLTZ_DB = 228.599;              // -10 log10(k), dBW/K/Hz
const H_PLANCK = 6.62607015e-34;

// ---- libration sample set -------------------------------------------------------------------
// Sub-Earth point = (B, L) = (LIB_LAT sin b, LIB_LON sin a). The two phases a, b have different
// periods (anomalistic 27.55 d vs draconic 27.21 d) so over years they are effectively independent:
// we integrate over both phases uniformly (trapezoid rule on [-90°, 90°], which includes the extremes).
const M = 13;
const NS = M * M;
const SX = new Float64Array(NS), SY = new Float64Array(NS), SZ = new Float64Array(NS), SW = new Float64Array(NS);
(function build() {
  let k = 0, wsum = 0;
  for (let i = 0; i < M; i++) {
    const L = LIB_LON_DEG * Math.sin(-Math.PI / 2 + Math.PI * i / (M - 1)) * DEG;
    const wi = (i === 0 || i === M - 1) ? 0.5 : 1;
    for (let j = 0; j < M; j++) {
      const B = LIB_LAT_DEG * Math.sin(-Math.PI / 2 + Math.PI * j / (M - 1)) * DEG;
      const wj = (j === 0 || j === M - 1) ? 0.5 : 1;
      SX[k] = Math.cos(B) * Math.cos(L); SY[k] = Math.cos(B) * Math.sin(L); SZ[k] = Math.sin(B);
      SW[k] = wi * wj; wsum += SW[k]; k++;
    }
  }
  for (let i = 0; i < NS; i++) SW[i] /= wsum;
})();
const RHO = R_MOON_KM / RANGE_MEAN_KM; // finite-distance correction (≈0.26° at the limb)

/**
 * Geometric visibility of Earth's centre from a lunar site, averaged over optical libration.
 * Ignores: local terrain (pass a terrain horizon as maskDeg), Earth's ~0.95° disc radius,
 * the ~1° diurnal parallax of a particular ground station, and physical libration (<0.05°).
 * @returns {{elevMeanDeg:number, elevMinDeg:number, elevMaxDeg:number, fracVisible:number}}
 */
export function earthVisibility(lat, lon, maskDeg = 0) {
  const cl = Math.cos(lat * DEG);
  const x = cl * Math.cos(lon * DEG), y = cl * Math.sin(lon * DEG), z = Math.sin(lat * DEG);
  // Elevation is monotonic in d = cos(angle to sub-Earth point), so "el > mask" is a threshold on d
  // and min/max elevation come from min/max d: the 169-sample loop needs no trigonometry.
  if (maskDeg !== _maskCached) { _maskCached = maskDeg; _dThresh = Math.cos(Math.acos(RHO * Math.cos(maskDeg * DEG)) - maskDeg * DEG); }
  const dT = _dThresh;
  let mn = 2, mx = -2, vis = 0;
  for (let i = 0; i < NS; i++) {
    const d = x * SX[i] + y * SY[i] + z * SZ[i];
    if (d < mn) mn = d;
    if (d > mx) mx = d;
    if (d > dT) vis += SW[i];
  }
  // Mean elevation: trapezoid rule on a 5 x 5 subset of the phase grid (smooth integrand).
  let sum = 0;
  for (let q = 0; q < NSUB; q++) {
    const i = SUB_I[q];
    sum += elevFromDot(x * SX[i] + y * SY[i] + z * SZ[i]) * SUB_W[q];
  }
  return { elevMeanDeg: sum, elevMinDeg: elevFromDot(mn), elevMaxDeg: elevFromDot(mx), fracVisible: vis > 1 - 1e-9 ? 1 : vis };
}
let _maskCached = NaN, _dThresh = 0;
function elevFromDot(d) {
  if (d > 1) d = 1; else if (d < -1) d = -1;
  return Math.atan2(d - RHO, Math.sqrt(1 - d * d)) / DEG;
}
const NSUB = 25, SUB_I = new Int32Array(NSUB), SUB_W = new Float64Array(NSUB);
(function buildSub() {
  let q = 0;
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
    SUB_I[q] = (a * 3) * M + b * 3;
    SUB_W[q] = ((a === 0 || a === 4) ? 0.5 : 1) * ((b === 0 || b === 4) ? 0.5 : 1) / 16;
    q++;
  }
})();

/** Elevation and azimuth (deg, clockwise from local north) of Earth for a given sub-Earth point. */
export function earthDirection(lat, lon, subLat = 0, subLon = 0) {
  const p1 = lat * DEG, p2 = subLat * DEG, dl = (subLon - lon) * DEG;
  let d = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  d = Math.max(-1, Math.min(1, d));
  const el = Math.atan2(d - RHO, Math.sqrt(1 - d * d)) / DEG;
  const az = Math.atan2(Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / DEG;
  return { elevDeg: el, azDeg: (az + 360) % 360 };
}

const dB = v => 10 * Math.log10(v);

/**
 * Direct-to-Earth link budget.
 * RF:      {type:'rf', freqHz, txPowerW, txDiamM, txEff, txGainDbi?, rxDiamM, rxEff, tsysK, rateBps,
 *           reqEbN0Db, lossPointDb, lossAtmDb, lossImplDb, rangeKm, marginTargetDb=3}
 * Optical: {type:'optical', wavelengthM, txPowerW, txDiamM, txEff, rxDiamM, rxEff, rateBps,
 *           reqPhotonsPerBit, lossPointDb, lossAtmDb, lossImplDb, rangeKm, marginTargetDb=3}
 */
export function linkBudget(p) {
  const type = p.type || 'rf';
  const lambda = type === 'optical' ? p.wavelengthM : (C_KM_S * 1000) / p.freqHz;
  const rangeM = (p.rangeKm ?? RANGE_MEAN_KM) * 1000;
  const target = p.marginTargetDb ?? 3;
  const hasOverride = type === 'rf' && p.txGainDbi !== null && p.txGainDbi !== undefined && Number.isFinite(p.txGainDbi);
  const txGainDbi = hasOverride ? p.txGainDbi : dB(p.txEff * Math.pow(Math.PI * p.txDiamM / lambda, 2));
  const rxGainDbi = dB(p.rxEff * Math.pow(Math.PI * p.rxDiamM / lambda, 2));
  const txPowerDbW = dB(p.txPowerW);
  const eirpDbW = txPowerDbW + txGainDbi;
  const fsplDb = 20 * Math.log10(4 * Math.PI * rangeM / lambda);
  const lossesDb = (p.lossPointDb || 0) + (p.lossAtmDb || 0) + (p.lossImplDb || 0);
  const prxDbW = eirpDbW - fsplDb - lossesDb + rxGainDbi;
  const out = {
    type, lambdaM: lambda, rangeKm: rangeM / 1000, txGainDbi, txGainFromDiameter: !hasOverride, rxGainDbi,
    txPowerDbW, eirpDbW, fsplDb, lossesDb, prxDbW, marginTargetDb: target,
    txHpbwDeg: hasOverride ? NaN : 70 * lambda / p.txDiamM,
    rxHpbwDeg: 70 * lambda / p.rxDiamM,
    lightTimeS: rangeM / 1000 / C_KM_S,
  };
  if (type === 'optical') {
    const ePhoton = H_PLANCK * C_KM_S * 1000 / lambda;
    out.photonEnergyJ = ePhoton;
    out.photonRate = Math.pow(10, prxDbW / 10) / ePhoton;          // detected photons / s
    out.photonsPerBit = out.photonRate / p.rateBps;
    out.marginDb = dB(out.photonsPerBit / p.reqPhotonsPerBit);
    out.maxRateBps = out.photonRate / (p.reqPhotonsPerBit * Math.pow(10, target / 10));
    out.txDivergenceUrad = (lambda / p.txDiamM) * 1e6;             // ~ full-angle diffraction scale λ/D
    out.footprintKm = (lambda / p.txDiamM) * rangeM / 1000;
  } else {
    out.gOverTDbK = rxGainDbi - dB(p.tsysK);
    out.cn0DbHz = eirpDbW - fsplDb - lossesDb + out.gOverTDbK + BOLTZ_DB;
    out.ebn0Db = out.cn0DbHz - dB(p.rateBps);
    out.marginDb = out.ebn0Db - p.reqEbN0Db;
    out.maxRateBps = Math.pow(10, (out.cn0DbHz - p.reqEbN0Db - target) / 10);
  }
  return out;
}

/** Slant range and one-way light time from a surface site to a relay at altitude h seen at elevation e. */
export function relayGeometry(altKm, elevDeg = 90) {
  const R = R_MOON_KM, s = Math.sin(elevDeg * DEG);
  const slantKm = -R * s + Math.sqrt(R * R * s * s + altKm * altKm + 2 * R * altKm);
  // Half-angle (Moon-centred) of the surface cap from which the relay is above elevDeg at this instant
  const capDeg = Math.acos(Math.max(-1, Math.min(1, (R / (R + altKm)) * Math.cos(elevDeg * DEG)))) / DEG - elevDeg;
  return { slantKm, lightTimeS: slantKm / C_KM_S, capHalfAngleDeg: capDeg };
}

// ---- UI --------------------------------------------------------------------------------------
const PRESETS = {
  s: { label: 'S-band 2.2 GHz', type: 'rf', freqHz: 2.2e9, txPowerW: 5, txDiamM: 0.3, txEff: 0.55, txGainDbi: null,
       rxDiamM: 18, rxEff: 0.6, tsysK: 200, rateBps: 1e5, reqEbN0Db: 2, lossPointDb: 0.5, lossAtmDb: 0.1, lossImplDb: 1.5 },
  x: { label: 'X-band 8.45 GHz', type: 'rf', freqHz: 8.45e9, txPowerW: 10, txDiamM: 0.5, txEff: 0.55, txGainDbi: null,
       rxDiamM: 34, rxEff: 0.65, tsysK: 250, rateBps: 2e6, reqEbN0Db: 2, lossPointDb: 0.5, lossAtmDb: 0.2, lossImplDb: 1.5 },
  ka: { label: 'Ka-band 26 GHz', type: 'rf', freqHz: 26e9, txPowerW: 10, txDiamM: 0.5, txEff: 0.55, txGainDbi: null,
        rxDiamM: 18, rxEff: 0.55, tsysK: 300, rateBps: 1e8, reqEbN0Db: 2, lossPointDb: 1.0, lossAtmDb: 1.0, lossImplDb: 1.5 },
  opt: { label: 'Optical 1550 nm', type: 'optical', wavelengthM: 1550e-9, txPowerW: 0.5, txDiamM: 0.1, txEff: 0.6,
         rxDiamM: 1.0, rxEff: 0.5, rateBps: 6.22e8, reqPhotonsPerBit: 4, lossPointDb: 2, lossAtmDb: 1, lossImplDb: 2 },
};
const FIELDS_RF = [
  ['freqHz', 'Carrier frequency (Hz)'], ['txPowerW', 'Tx RF power (W)'], ['txDiamM', 'Tx antenna diameter (m)'],
  ['txEff', 'Tx aperture efficiency (0–1)'], ['txGainDbi', 'Tx gain override (dBi; blank = from diameter)'],
  ['rxDiamM', 'Ground dish diameter (m)'], ['rxEff', 'Ground aperture efficiency (0–1)'],
  ['tsysK', 'System noise temperature (K)'], ['rateBps', 'Data rate (bit/s)'], ['reqEbN0Db', 'Required Eb/N0 (dB)'],
  ['lossPointDb', 'Pointing loss (dB)'], ['lossAtmDb', 'Atmospheric loss (dB)'], ['lossImplDb', 'Implementation / line / polarisation loss (dB)'],
  ['rangeKm', 'Range (km)'],
];
const FIELDS_OPT = [
  ['wavelengthM', 'Wavelength (m)'], ['txPowerW', 'Tx optical power, average (W)'], ['txDiamM', 'Tx aperture diameter (m)'],
  ['txEff', 'Tx optics efficiency (0–1)'], ['rxDiamM', 'Ground telescope diameter (m)'],
  ['rxEff', 'Rx optics × detector efficiency (0–1)'], ['rateBps', 'Data rate (bit/s)'],
  ['reqPhotonsPerBit', 'Receiver sensitivity (detected photons/bit)'],
  ['lossPointDb', 'Pointing loss (dB)'], ['lossAtmDb', 'Atmospheric loss (dB)'], ['lossImplDb', 'Implementation loss (dB)'],
  ['rangeKm', 'Range (km)'],
];
const DISHES = [['34', '34 m (DSN-class)'], ['18', '18 m (LEGS-class)'], ['7', '7 m (commercial)'], ['3.7', '3.7 m (commercial)']];

function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('cm-style')) return;
  const s = document.createElement('style');
  s.id = 'cm-style';
  s.textContent = `
.cm-root{color:var(--text,#e6e9ef);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.cm-root h3{margin:0 0 6px;font-size:16px}.cm-root h4{margin:16px 0 6px;font-size:14px;color:var(--accent,#6cb4ff)}
.cm-card{background:var(--panel,#161b24);border:1px solid var(--border,#2a3242);border-radius:8px;padding:12px;margin:0 0 12px}
.cm-muted{color:var(--muted,#93a0b5);font-size:12.5px}
.cm-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:8px 0}
.cm-kv div{background:var(--bg,#0d1117);border:1px solid var(--border,#2a3242);border-radius:6px;padding:6px 8px}
.cm-kv b{display:block;font-size:17px;font-variant-numeric:tabular-nums}.cm-kv span{color:var(--muted,#93a0b5);font-size:12px}
.cm-verdict{padding:8px 10px;border-radius:6px;border-left:4px solid var(--accent,#6cb4ff);background:var(--bg,#0d1117);margin:8px 0}
.cm-verdict.cm-good{border-left-color:#3fb97a}.cm-verdict.cm-warn{border-left-color:#e0a83a}.cm-verdict.cm-bad{border-left-color:#e2605a}
.cm-presets{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}
.cm-root button{background:var(--bg,#0d1117);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3242);border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
.cm-root button.cm-on{border-color:var(--accent,#6cb4ff);color:var(--accent,#6cb4ff)}
.cm-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:6px 14px}
.cm-form label{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;color:var(--muted,#93a0b5)}
.cm-root input,.cm-root select{width:110px;background:var(--bg,#0d1117);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3242);border-radius:4px;padding:3px 6px;font:inherit;font-size:13px}
.cm-table{width:100%;border-collapse:collapse;margin:10px 0;font-variant-numeric:tabular-nums}
.cm-table td{padding:3px 6px;border-bottom:1px solid var(--border,#2a3242)}.cm-table td:last-child{text-align:right;white-space:nowrap}
.cm-table tr.cm-key td{font-weight:600}
.cm-pos{color:#3fb97a}.cm-neg{color:#e2605a}
.cm-root details{margin:8px 0}.cm-root summary{cursor:pointer;color:var(--accent,#6cb4ff)}
.cm-root code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
.cm-root ul{margin:6px 0;padding-left:20px}.cm-root li{margin:3px 0}
.cm-root a{color:var(--accent,#6cb4ff)}`;
  document.head.appendChild(s);
}

const f = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '–';
function fmtRate(r) {
  if (!Number.isFinite(r)) return '–';
  if (r >= 1e9) return (r / 1e9).toFixed(2) + ' Gbit/s';
  if (r >= 1e6) return (r / 1e6).toFixed(2) + ' Mbit/s';
  if (r >= 1e3) return (r / 1e3).toFixed(2) + ' kbit/s';
  return r.toFixed(1) + ' bit/s';
}
const fmtLon = lon => { let l = ((lon + 180) % 360 + 360) % 360 - 180; if (l === -180) l = 180; return `${Math.abs(l).toFixed(2)}°${l < 0 ? 'W' : 'E'}`; };
const fmtLat = lat => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`;

/**
 * Fill `container` with the comms analysis for a site.
 * opts.maskDeg : initial local-horizon mask (deg) e.g. a terrain horizon from region.js
 * opts.maskNote: short text describing where the mask came from
 */
export function renderCommsPanel(container, lat, lon, opts = {}) {
  injectStyle();
  lat = Math.max(-90, Math.min(90, Number(lat) || 0));
  lon = Number(lon) || 0;
  const state = { preset: 'x', p: { ...PRESETS.x, rangeKm: RANGE_MEAN_KM }, mask: Number(opts.maskDeg) || 0, relayAlt: 7500, relayElev: 10 };
  container.innerHTML = `<div class="cm-root">
  <div class="cm-card">
    <h3>Earth visibility &amp; communications — ${fmtLat(lat)}, ${fmtLon(lon)}</h3>
    <div class="cm-muted">Geometric approximation from libration statistics, not an ephemeris computation.</div>
    <label class="cm-muted" style="display:block;margin-top:8px">Local horizon mask (deg above the ideal horizon):
      <input type="number" step="0.5" class="cm-mask" value="${state.mask}"></label>
    ${opts.maskNote ? `<div class="cm-muted">${opts.maskNote}</div>` : ''}
    <div class="cm-vis"></div>
    <details><summary>Assumptions — Earth visibility</summary><ul class="cm-muted">
      <li>The Moon is tidally locked; the sub-Earth point is taken as (0°, 0°) displaced by optical libration of ±${LIB_LON_DEG}° in longitude and ±${LIB_LAT_DEG}° in latitude (approximate amplitudes).</li>
      <li>Both librations are modelled as sinusoids with independent, uniformly distributed phases (periods 27.55 d and 27.21 d drift against each other), integrated numerically over ${NS} samples (mean elevation on a 25-sample subset). "% of time" is therefore a long-term average; within any one month the pattern is a specific Lissajous arc.</li>
      <li>Elevation is that of Earth's <em>centre</em>: <code>el = atan2(cos γ − R/d, sin γ)</code>, γ = angle between the site and the sub-Earth point, R = 1737.4 km, d = 384 400 km (a 0.26° correction at the limb).</li>
      <li>Ignored: local terrain unless you enter a mask above; Earth's angular radius (≈0.95°, so part of the disc is visible slightly below 0°); the ≈1° diurnal parallax between different ground stations; physical libration; ground-station availability and its own elevation limits.</li>
      <li>Near the poles and limb the Earth sits within a few degrees of the horizon, where real terrain dominates — use a terrain horizon from a DEM (e.g. LOLA polar products) before trusting any percentage here.</li></ul></details>
  </div>
  <div class="cm-card">
    <h3>Direct-to-Earth link budget (first-order)</h3>
    <div class="cm-presets">${Object.entries(PRESETS).map(([k, v]) => `<button data-preset="${k}">${v.label}</button>`).join('')}</div>
    <div class="cm-dish cm-muted"></div>
    <div class="cm-form"></div>
    <div class="cm-muted cm-range"></div>
    <table class="cm-table"><tbody class="cm-out"></tbody></table>
    <div class="cm-notes cm-muted"></div>
    <details><summary>Assumptions &amp; formulas — link budget</summary><div class="cm-formulas cm-muted"></div></details>
  </div>
  <div class="cm-card">
    <h3>Relay options</h3>
    <div class="cm-relay-intro"></div>
    <ul class="cm-muted">
      <li><b>Elliptical lunar frozen orbit (ELFO), apolune over the south pole</b> — a relay dwells for most of its orbit high above the southern hemisphere, giving long passes for polar sites while keeping Earth in view. This is the orbit class of ESA's Lunar Pathfinder / Moonlight and of NASA's Lunar Communications Relay and Navigation Systems (LCRNS) plans under the LunaNet framework. One satellite gives long but not continuous passes; continuous coverage needs a small constellation.</li>
      <li><b>Near-rectilinear halo orbit (NRHO)</b> — Gateway's planned southern L2 NRHO (≈6.5-day period) spends most of each revolution far above the south pole with an unobstructed view of Earth; good south-polar and partial far-side coverage, with a gap around perilune.</li>
      <li><b>Earth–Moon L2 halo orbit</b> — sees the far side and Earth simultaneously; used by Queqiao for Chang'e-4. Long range (tens of thousands of km) costs link margin compared with a low relay.</li>
      <li><b>Low lunar orbiter store-and-forward</b> — short range, but passes last only minutes and are separated by an orbit period or more.</li>
    </ul>
    <div class="cm-muted">Coverage statements above are qualitative; real coverage needs orbit propagation and terrain masks.</div>
    <h4>Relay geometry calculator</h4>
    <div class="cm-presets">
      <button data-alt="100">Low orbiter 100 km</button>
      <button data-alt="7500">ELFO apolune ≈7 500 km</button>
      <button data-alt="65000">E–M L2 halo ≈65 000 km</button>
      <button data-alt="70000">NRHO apolune ≈70 000 km</button>
    </div>
    <div class="cm-muted">Preset altitudes are round, approximate figures for the orbit class, not a specific mission's elements.</div>
    <div class="cm-form" style="margin-top:6px">
      <label>Relay altitude above the surface (km) <input type="number" class="cm-ralt" min="1" step="100" value="${state.relayAlt}"></label>
      <label>Relay elevation at the site (deg) <input type="number" class="cm-relev" min="0" max="90" step="1" value="${state.relayElev}"></label>
    </div>
    <table class="cm-table"><tbody class="cm-rout"></tbody></table>
  </div></div>`;

  const root = container.firstElementChild; // listeners live on the root so a re-render discards them
  const $ = s => container.querySelector(s);

  function drawVis() {
    const v0 = earthVisibility(lat, lon, 0);
    const v = earthVisibility(lat, lon, state.mask);
    const pct = v.fracVisible * 100;
    let cls, txt;
    if (v.fracVisible >= 0.9995) {
      cls = v.elevMinDeg - state.mask < 5 ? 'cm-warn' : 'cm-good';
      txt = `<b>Continuous direct-to-Earth (DTE) geometry.</b> Earth's centre stays above the ${f(state.mask, 1)}° mask through the whole libration cycle (whenever a ground station has the Moon in view).` +
        (cls === 'cm-warn' ? ` Minimum clearance above the mask is only ${f(v.elevMinDeg - state.mask, 1)}° — low-elevation links are exposed to terrain blockage and surface multipath; verify with a terrain horizon.` : '');
    } else if (v.fracVisible > 0.0005) {
      cls = 'cm-warn';
      txt = `<b>Intermittent DTE (libration-dependent).</b> Earth's centre is above the ${f(state.mask, 1)}° mask for about ${f(pct, 0)}% of the libration cycle; outages last days at a time. A relay is needed for continuous contact.`;
    } else {
      cls = 'cm-bad';
      txt = `<b>No direct-to-Earth link → relay required.</b> Earth's centre never rises above the ${f(state.mask, 1)}° mask at this site.`;
    }
    $('.cm-vis').innerHTML = `<div class="cm-kv">
      <div><b>${f(v0.elevMeanDeg, 1)}°</b><span>mean Earth elevation</span></div>
      <div><b>${f(v0.elevMinDeg, 1)}°</b><span>minimum (libration)</span></div>
      <div><b>${f(v0.elevMaxDeg, 1)}°</b><span>maximum (libration)</span></div>
      <div><b>${f(pct, pct > 0 && pct < 100 ? 1 : 0)}%</b><span>of time above ${f(state.mask, 1)}° mask (approx.)</span></div>
      <div><b>${f(earthDirection(lat, lon).azDeg, 0)}°</b><span>mean Earth azimuth (from north, clockwise)</span></div>
    </div><div class="cm-verdict ${cls}">${txt}</div>`;
    $('.cm-relay-intro').innerHTML = v.fracVisible >= 0.9995
      ? `<div class="cm-muted">This site has continuous DTE geometry in this model; a relay would still add redundancy, coverage during descent, and service to assets in nearby shadowed terrain.</div>`
      : `<div class="cm-verdict ${cls}">DTE visibility at this site is ${v.fracVisible > 0.0005 ? 'intermittent' : 'absent'} in this model, so sustained operations need a relay.</div>`;
  }

  function drawForm() {
    const p = state.p, fields = p.type === 'optical' ? FIELDS_OPT : FIELDS_RF;
    container.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('cm-on', b.dataset.preset === state.preset));
    $('.cm-dish').innerHTML = p.type === 'rf'
      ? `Ground station class: <select class="cm-dishsel"><option value="">custom</option>${DISHES.map(([d, n]) => `<option value="${d}" ${+d === p.rxDiamM ? 'selected' : ''}>${n}</option>`).join('')}</select> (sets the dish diameter only; efficiency and noise temperature stay editable)`
      : `Ground receiver: photon-counting telescope; set its diameter and sensitivity below.`;
    $('.cm-form').innerHTML = fields.map(([k, label]) =>
      `<label>${label} <input type="text" inputmode="decimal" data-k="${k}" value="${p[k] === null || p[k] === undefined ? '' : p[k]}"></label>`).join('');
    drawOut();
  }

  function drawOut() {
    const p = state.p, r = linkBudget(p);
    const near = linkBudget({ ...p, rangeKm: RANGE_PERI_KM }), far = linkBudget({ ...p, rangeKm: RANGE_APO_KM });
    $('.cm-range').innerHTML = `Range span: perigee ≈ ${RANGE_PERI_KM.toLocaleString('en-US')} km … mean ${RANGE_MEAN_KM.toLocaleString('en-US')} km … apogee ≈ ${RANGE_APO_KM.toLocaleString('en-US')} km (centre to centre, approximate extremes) → path loss ${f(near.fsplDb, 2)} … ${f(far.fsplDb, 2)} dB, a ${f(far.fsplDb - near.fsplDb, 2)} dB swing. One-way light time at the entered range: ${f(r.lightTimeS, 3)} s.`;
    const mcls = r.marginDb >= r.marginTargetDb ? 'cm-pos' : (r.marginDb >= 0 ? '' : 'cm-neg');
    const rows = [];
    const row = (a, b, key) => rows.push(`<tr${key ? ' class="cm-key"' : ''}><td>${a}</td><td>${b}</td></tr>`);
    row('Wavelength', p.type === 'optical' ? `${f(r.lambdaM * 1e9, 0)} nm` : `${f(r.lambdaM * 100, 2)} cm`);
    row(`Tx gain ${r.txGainFromDiameter ? '(from diameter)' : '(override)'}`, `${f(r.txGainDbi, 2)} dBi`);
    row('EIRP', `${f(r.eirpDbW, 2)} dBW`, true);
    row('Free-space path loss', `${f(r.fsplDb, 2)} dB`, true);
    row('Pointing + atmospheric + implementation losses', `${f(r.lossesDb, 2)} dB`);
    row('Ground receive gain', `${f(r.rxGainDbi, 2)} dBi`);
    if (p.type === 'optical') {
      row('Tx beam divergence scale λ/D → footprint at Earth', `${f(r.txDivergenceUrad, 1)} µrad → ≈${f(r.footprintKm, 1)} km`);
      row('Received (detected) power', `${f(r.prxDbW, 2)} dBW = ${(Math.pow(10, r.prxDbW / 10) * 1e9).toPrecision(3)} nW`);
      row('Detected photon rate', `${r.photonRate.toExponential(3)} photons/s`, true);
      row('Detected photons per bit at the entered rate', `${r.photonsPerBit.toPrecision(3)}`, true);
      row(`Margin vs ${p.reqPhotonsPerBit} photons/bit`, `<span class="${mcls}">${f(r.marginDb, 2)} dB</span>`, true);
    } else {
      row('Ground G/T', `${f(r.gOverTDbK, 2)} dB/K`, true);
      row('Received carrier power', `${f(r.prxDbW, 2)} dBW`);
      row('C/N0', `${f(r.cn0DbHz, 2)} dB-Hz`, true);
      row(`Eb/N0 at ${fmtRate(p.rateBps)}`, `${f(r.ebn0Db, 2)} dB`, true);
      row(`Margin vs required ${f(p.reqEbN0Db, 1)} dB`, `<span class="${mcls}">${f(r.marginDb, 2)} dB</span>`, true);
    }
    row(`Maximum data rate at ${f(r.marginTargetDb, 0)} dB margin`, fmtRate(r.maxRateBps), true);
    $('.cm-out').innerHTML = rows.join('');

    const notes = [];
    if (![r.marginDb, r.maxRateBps].every(Number.isFinite)) notes.push('Some inputs are missing or non-numeric — results incomplete.');
    if (p.type === 'rf') {
      const hp = r.rxHpbwDeg;
      notes.push(`Ground beamwidth (HPBW ≈ 70 λ/D) ≈ ${hp < 0.1 ? f(hp, 3) : f(hp, 2)}°; the Moon's disc is ≈0.52° across. ` +
        (hp < 0.52 ? 'The Moon fills the main beam, so the lunar disc (brightness temperature roughly 200–250 K at microwave frequencies) adds directly to the system noise temperature — the default noise temperature here is an assumed round value that includes a hot Moon, not a station specification.'
          : 'The Moon only partly fills the beam, so its noise contribution is diluted roughly by (0.52°/HPBW)²; the default noise temperature is an assumed round value.'));
      if (Number.isFinite(r.txHpbwDeg)) notes.push(`Lander antenna HPBW ≈ ${f(r.txHpbwDeg, 1)}° (Earth is ≈1.9° across from the Moon and moves by up to ≈±8° with libration, so narrow beams need steering).` + (p.txDiamM / r.lambdaM < 3 ? ' The Tx aperture is under 3 wavelengths across — the dish formula is only indicative; enter a measured antenna gain as the override.' : ''));
    } else {
      notes.push('Photon-starved bound only: ignores background light (sunlit Moon/sky), detector dark counts, dead time and jitter, and modulation/slot-rate limits, any of which can cap the rate below the value shown. Cloud blockage is an availability problem handled by ground-site diversity, not by link margin.');
      notes.push('Cross-check: NASA\'s LLCD (LADEE, 2013) returned 622 Mbit/s from lunar orbit with a 0.5 W, 10 cm terminal — the default inputs are of that class, but they are illustrative, not LLCD\'s actual link table.');
    }
    $('.cm-notes').innerHTML = notes.map(n => `<div style="margin:4px 0">• ${n}</div>`).join('');

    $('.cm-formulas').innerHTML = p.type === 'optical' ? `<ul>
      <li><code>G_t = η_t (π D_t / λ)²</code>, <code>G_r = η_r (π D_r / λ)²</code> (on-axis, diffraction-limited aperture gains; η_t lumps optics throughput and truncation/obscuration, η_r lumps optics throughput and detector efficiency, so photons are <em>detected</em> photons).</li>
      <li><code>L_fs = (4π d / λ)²</code>; <code>P_r = P_t G_t G_r / (L_fs · L_point · L_atm · L_impl)</code>.</li>
      <li><code>photon rate = P_r λ / (h c)</code>; <code>photons/bit = rate / R_b</code>; margin = 10·log10(photons per bit ÷ required photons per bit).</li>
      <li>Maximum rate = photon rate ÷ (required photons/bit × 10^(margin/10)).</li>
      <li>Required photons/bit is a user input describing the receiver (photon-counting PPM receivers with strong coding operate at the order of one to a few detected photons per bit); it is not derived here.</li>
      <li>Range is treated as the Earth–Moon centre distance; the surface-to-surface correction (≤ about 8 000 km, &lt;0.2 dB) is ignored.</li></ul>` : `<ul>
      <li><code>G = η (π D / λ)²</code> for both antennas unless a Tx gain override is entered; <code>λ = c / f</code>.</li>
      <li><code>EIRP = P_t + G_t</code> (dBW); <code>FSPL = 20·log10(4π d / λ)</code>.</li>
      <li><code>G/T = G_r − 10·log10(T_sys)</code>.</li>
      <li><code>C/N0 = EIRP − FSPL − L_point − L_atm − L_impl + G/T + 228.6</code> (dB-Hz; 228.6 = −10·log10 k).</li>
      <li><code>Eb/N0 = C/N0 − 10·log10(R_b)</code>; margin = Eb/N0 − required Eb/N0.</li>
      <li>Maximum rate = 10^((C/N0 − required Eb/N0 − margin)/10). All received power is assumed to be in the data channel (no residual carrier or ranging allocation).</li>
      <li>Default required Eb/N0 of 2 dB is representative of rate-½ LDPC/turbo-coded BPSK/QPSK; uncoded BPSK at 10⁻⁵ BER needs ≈9.6 dB.</li>
      <li>Default power, antenna, efficiency, loss and noise-temperature values are illustrative round numbers, not the specification of any real lander or station. Atmospheric loss at Ka-band is strongly weather- and elevation-dependent.</li>
      <li>Range is treated as the Earth–Moon centre distance; the surface-to-surface correction (≤ about 8 000 km, &lt;0.2 dB) is ignored. Spectrum-allocation and bandwidth limits are not checked.</li></ul>`;
  }

  function drawRelay() {
    const g = relayGeometry(state.relayAlt, state.relayElev), z = relayGeometry(state.relayAlt, 90);
    $('.cm-rout').innerHTML = `
      <tr class="cm-key"><td>Slant range site → relay at ${f(state.relayElev, 0)}° elevation</td><td>${f(g.slantKm, 0)} km</td></tr>
      <tr><td>One-way light time, site → relay</td><td>${f(g.lightTimeS * 1000, 1)} ms</td></tr>
      <tr><td>Slant range with the relay at zenith</td><td>${f(z.slantKm, 0)} km (${f(z.lightTimeS * 1000, 1)} ms)</td></tr>
      <tr><td>Instantaneous coverage cap half-angle (relay above ${f(state.relayElev, 0)}°, spherical Moon, no terrain)</td><td>${f(g.capHalfAngleDeg, 1)}°</td></tr>
      <tr><td>Path-loss advantage over DTE at mean range (same frequency)</td><td>${f(20 * Math.log10(RANGE_MEAN_KM / g.slantKm), 1)} dB</td></tr>
      <tr><td>Relay → Earth hop, one-way light time at mean distance (approx.)</td><td>${f(RANGE_MEAN_KM / C_KM_S, 2)} s</td></tr>`;
  }

  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.preset) {
      state.preset = b.dataset.preset;
      state.p = { ...PRESETS[state.preset], rangeKm: state.p.rangeKm };
      drawForm();
    } else if (b.dataset.alt) {
      state.relayAlt = +b.dataset.alt; $('.cm-ralt').value = state.relayAlt; drawRelay();
    }
  });
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.k) {
      const raw = t.value.trim();
      state.p[t.dataset.k] = raw === '' ? (t.dataset.k === 'txGainDbi' ? null : NaN) : Number(raw);
      if (t.dataset.k === 'rxDiamM' && $('.cm-dishsel')) $('.cm-dishsel').value = DISHES.some(d => +d[0] === state.p.rxDiamM) ? String(state.p.rxDiamM) : '';
      drawOut();
    } else if (t.classList.contains('cm-mask')) { state.mask = Number(t.value) || 0; drawVis(); }
    else if (t.classList.contains('cm-ralt')) { state.relayAlt = Math.max(0.001, Number(t.value) || 0); drawRelay(); }
    else if (t.classList.contains('cm-relev')) { state.relayElev = Math.max(0, Math.min(90, Number(t.value) || 0)); drawRelay(); }
  });
  root.addEventListener('change', e => {
    if (e.target.classList.contains('cm-dishsel') && e.target.value) {
      state.p.rxDiamM = +e.target.value;
      const inp = container.querySelector('[data-k="rxDiamM"]'); if (inp) inp.value = state.p.rxDiamM;
      drawOut();
    }
  });

  drawVis(); drawForm(); drawRelay();
}

// ================================================================================================
// V2 — wizard step 3: comms-availability grid, approximate link times, and the side menu.
// Everything below is a first-order geometric estimate (spherical Moon, no terrain, two-body or
// fixed-shape orbits, no ephemeris). Every assumption is repeated in linkTimes().notes and shown
// in the menu. Pure functions: commsAvailability, linkTimes, dsnMoonCoverage (no DOM).
// ================================================================================================
export const MU_MOON_KM3_S2 = 4902.8;          // lunar GM
export const MOON_SIDEREAL_DAYS = 27.321661;   // rotation period of the Moon (= sidereal month)
const MOON_SIDEREAL_S = MOON_SIDEREAL_DAYS * 86400;
const LIB_CYCLE_DAYS = 27.3;                   // libration cycle (27.55 d in longitude, 27.21 d in latitude)
const LUNAR_DAY_AT_EARTH_H = 24.84;            // mean interval between lunar transits at a ground station
const MOON_DEC_MAX_DEG = 28.6;                 // extreme lunar declination (23.44° + 5.14°, major standstill)
const TWO_PI = 2 * Math.PI;

/**
 * Relay presets. `status`: 'real' = a relay spacecraft has flown this orbit; 'planned' = an announced
 * relay not yet launched (as of Nov 2026); 'hypothetical' = an orbit class with no relay in it.
 * `real` is true only for status 'real'. `kind` is the orbit model used ('circular' | 'elliptical' |
 * 'halo' | 'nrho'). Orbit numbers are quoted from the listed sources where the note says so, otherwise
 * they are stated as assumed. `userAntDiamM` is an ASSUMED relay antenna for the surface link.
 */
export const RELAY_PRESETS = [
  {
    id: 'lro-like', name: 'Low polar orbiter, 100 km (LRO-like orbit)', kind: 'circular', status: 'hypothetical', real: false,
    description: 'Circular polar orbit, 100 km altitude, period ≈ 118 min.',
    note: 'Hypothetical relay payload. NASA\'s Lunar Reconnaissance Orbiter is a science orbiter and carries no relay service for surface assets (none is described on NASA\'s mission pages). Its own orbit was ≈50 km circular polar (2009–11) and has been elliptical polar since, ≈20 × 165 km with the low point near the south pole after May 2015 (NASA). Nearest real precedent for a low orbiter talking to a lander: ISRO\'s Chandrayaan-2 orbiter set up a two-way link with the Chandrayaan-3 lander in Aug 2023.',
    altKm: 100, incDeg: 90, userAntDiamM: 0.3,
    sources: [
      { label: 'NASA — LRO mission page', url: 'https://science.nasa.gov/mission/lro/about/' },
      { label: 'Chandrayaan-2 ↔ Chandrayaan-3 link (news report of ISRO statement)', url: 'https://organiser.org/2023/08/21/191037/bharat/chandrayaan-3-two-way-communication-established-with-the-lander-ch-2-orbiter-greets-says-welcome-buddy/' },
    ],
  },
  {
    id: 'queqiao2', name: 'Queqiao-2 (CNSA) — elliptical frozen orbit', kind: 'elliptical', status: 'real', real: true,
    description: 'Elliptical frozen orbit ≈200 × 16 000 km, 62.4° inclination, ≈24 h period (as planned for Chang\'e-6).',
    note: 'Real relay, launched 20 Mar 2024, relayed for Chang\'e-6. Operated by CNSA with Chinese ground stations — it is not a DSN service; shown for its geometry. Elements are the planned values quoted on Wikipedia (its infobox lists tracked values of ≈254 × 16 941 km, 119.25°, 26.2 h). Apolune over the southern hemisphere (argument of perilune 90°) is ASSUMED here. A move to a 12 h orbit for Chang\'e-7/8 was planned (Planetary Society); its orbit today is unverified.',
    periAltKm: 200, apoAltKm: 16000, incDeg: 62.4, argPeriDeg: 90, userAntDiamM: 4.2,
    sources: [
      { label: 'Wikipedia — Queqiao-2', url: 'https://en.wikipedia.org/wiki/Queqiao-2' },
      { label: 'The Planetary Society — Queqiao-2', url: 'https://www.planetary.org/space-missions/queqiao-2-chinas-bridge-for-lunar-exploration' },
    ],
  },
  {
    id: 'lunar-pathfinder', name: 'Lunar Pathfinder (ESA / SSTL) — ELFO', kind: 'elliptical', status: 'planned', real: false,
    description: 'Elliptical lunar frozen orbit: a = 5 740 km, e = 0.58, i = 54.9°, ≈673 × 7 331 km altitude, period ≈ 10.8 h, apolune in the south.',
    note: 'Planned, not launched: no earlier than 2027 on Firefly Blue Ghost Mission 2 (in final environmental tests, Oct 2026). Orbit elements are the "indicative, subject to change" values in SSTL\'s Lunar Pathfinder Service Guide; S-band/UHF user links up to 2 Mbit/s and an X-band return up to 5 Mbit/s are from the same guide and are applied as rate caps.',
    smaKm: 5740, ecc: 0.58, incDeg: 54.856, argPeriDeg: 86.322, userAntDiamM: 1.0, userCapBps: 2e6, trunkCapBps: 5e6,
    sources: [
      { label: 'SSTL — Lunar Pathfinder Service Guide', url: 'https://www.sstl.co.uk/getmedia/9efe3cc5-6b5b-4fd1-bbd7-443bc2d21848/Lunar-Pathfinder-Service-Guide-V004.pdf' },
      { label: 'Wikipedia — Lunar Pathfinder', url: 'https://en.wikipedia.org/wiki/Lunar_Pathfinder' },
    ],
  },
  {
    id: 'queqiao1-eml2', name: 'Queqiao-1 (CNSA) — Earth–Moon L2 halo', kind: 'halo', status: 'real', real: true,
    description: 'Halo orbit about Earth–Moon L2, ≈65 000 km beyond the Moon, ≈14-day period: a far-side relay.',
    note: 'Real relay, launched 2018 for Chang\'e-4 on the far side; CNSA-operated, not a DSN service; whether it is still operating in late 2026 is unverified. Only the ≈65 000 km distance and ≈14-day period are from the sources; the halo size used (±35 000 km east–west, ±13 000 km north–south) is an ASSUMED illustrative shape, not its ephemeris.',
    distKm: 65000, ampYKm: 35000, ampZKm: 13000, periodDays: 14, userAntDiamM: 4.2, userCapBps: 555e3,
    sources: [
      { label: 'Wikipedia — Queqiao-1', url: 'https://en.wikipedia.org/wiki/Queqiao-1' },
      { label: 'Wikipedia — Queqiao-2 (Queqiao-1 comparison)', url: 'https://en.wikipedia.org/wiki/Queqiao-2' },
    ],
  },
  {
    id: 'nrho', name: 'NRHO relay (Gateway-type orbit)', kind: 'nrho', status: 'hypothetical', real: false,
    description: 'Southern L2 near-rectilinear halo orbit, 9:2 resonant, ≈6.5-day period: perilune near the north pole, long dwell high over the south pole.',
    note: 'Hypothetical: nothing is in this orbit. It is the orbit NASA chose for Gateway, which NASA put on hold in March 2026. NASA\'s NRHO white paper gives the ≈6.5-day period, perilune near the north pole, uninterrupted Earth view and south-pole coverage for most of the orbit; the radii used here (perilune ≈3 400 km, apolune ≈71 000 km from the Moon\'s centre) are recalled approximate values, unverified in this build.',
    periRadiusKm: 3400, apoRadiusKm: 71000, periodDays: 6.56, userAntDiamM: 4.2,
    sources: [
      { label: 'NASA — Why NRHO: the Artemis orbit (white paper)', url: 'https://nasa.gov/wp-content/uploads/2023/10/acr22-wp-why-nrho-the-artemis-orbit.pdf' },
      { label: 'The Register — NASA pauses Gateway (24 Mar 2026)', url: 'https://www.theregister.com/2026/03/24/goodbye_lunar_gateway_nasa_ditches/' },
    ],
  },
];
for (const p of RELAY_PRESETS) p.source = p.sources[0].url;

/** Announced relay systems that are NOT modelled because no orbit elements were found in the sources read. */
export const RELAYS_NOT_MODELLED = [
  { name: 'NASA LCRNS / Near Space Network lunar relay (Intuitive Machines)', status: 'planned',
    note: 'Five data-relay satellites planned for continuous south-pole and partial far-side coverage; the first is to fly with IM-3, no earlier than Q1 2027. Orbit elements not found, so not modelled.',
    url: 'https://www.nasa.gov/technology/space-comms/near-space-network/leveraging-lunar-relays' },
  { name: 'ESA Moonlight constellation', status: 'planned',
    note: 'A handful of satellites targeted by the end of the decade; still being defined. Not modelled.',
    url: 'https://www.satellitetoday.com/space-economy/2026/07/27/building-the-connectivity-backbone-for-the-next-era-of-lunar-exploration/' },
];

export const DEFAULT_COMMS_STATE = { mode: 'dte', relayId: 'lro-like', dsnDishM: 34, band: 'X', maskDeg: 5 };

/** DSN complexes (approximate geodetic coordinates, east-positive longitude). */
export const DSN_COMPLEXES = [
  { id: 'gdscc', name: 'Goldstone', latDeg: 35.43, lonDeg: -116.89 },
  { id: 'mdscc', name: 'Madrid', latDeg: 40.43, lonDeg: -4.25 },
  { id: 'cdscc', name: 'Canberra', latDeg: -35.40, lonDeg: 148.98 },
];

// Illustrative hardware (round numbers; the surface terminal matches the link-budget panel presets).
const LANDER_TX = {
  S: { label: 'S-band 2.2 GHz', freqHz: 2.2e9, txPowerW: 5, txDiamM: 0.3, txEff: 0.55, lossPointDb: 0.5, lossAtmDb: 0.1, lossImplDb: 1.5 },
  X: { label: 'X-band 8.45 GHz', freqHz: 8.45e9, txPowerW: 10, txDiamM: 0.5, txEff: 0.55, lossPointDb: 0.5, lossAtmDb: 0.2, lossImplDb: 1.5 },
  Ka: { label: 'Ka-band 26 GHz', freqHz: 26e9, txPowerW: 10, txDiamM: 0.5, txEff: 0.55, lossPointDb: 1.0, lossAtmDb: 1.0, lossImplDb: 1.5 },
};
const DSN_RX = { S: { rxEff: 0.70, tsysK: 250 }, X: { rxEff: 0.70, tsysK: 250 }, Ka: { rxEff: 0.55, tsysK: 300 } };
const BAND_CAP_BPS = { S: 5e6, X: 1e7, Ka: Infinity };   // assumed channel limits: 5 MHz (S), 10 MHz (X) at ≈1 bit/s/Hz
const RELAY_TRUNK_TX = { txPowerW: 20, txDiamM: 0.6, txEff: 0.55 };
const RELAY_USER_RX = { rxEff: 0.55, tsysK: 400 };
const REQ_EBN0_DB = 2, MARGIN_DB = 3, DSN_STATION_MASK_DEG = 10;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function normState(state) {
  const s = { ...DEFAULT_COMMS_STATE, ...(state || {}) };
  s.mode = s.mode === 'relay' ? 'relay' : 'dte';
  if (!RELAY_PRESETS.some(p => p.id === s.relayId)) s.relayId = DEFAULT_COMMS_STATE.relayId;
  s.dsnDishM = Number(s.dsnDishM) === 70 ? 70 : 34;
  s.band = LANDER_TX[s.band] ? s.band : 'X';
  s.maskDeg = clamp(Number.isFinite(Number(s.maskDeg)) ? Number(s.maskDeg) : DEFAULT_COMMS_STATE.maskDeg, 0, 45);
  return s;
}
const normLon = lon => { let l = ((lon + 180) % 360 + 360) % 360 - 180; return l; };

// ---- direct-to-Earth: fraction of the libration cycle with Earth above the mask ----------------
let _dteMask = NaN, _dteThr = 0, _dteHi = 0, _dteLo = 0;
const LIB_REACH = Math.acos(Math.cos(LIB_LON_DEG * DEG) * Math.cos(LIB_LAT_DEG * DEG)) + 0.02 * DEG;
/** Same number as earthVisibility(lat, lon, maskDeg).fracVisible, without the elevation statistics. */
function dteFraction(lat, lon, maskDeg) {
  if (maskDeg !== _dteMask) {
    _dteMask = maskDeg;
    const gT = Math.acos(RHO * Math.cos(maskDeg * DEG)) - maskDeg * DEG;   // limiting angle from the sub-Earth point
    _dteThr = Math.cos(gT);
    _dteHi = Math.cos(Math.max(0, gT - LIB_REACH));    // closer than this to (0,0): always visible
    _dteLo = Math.cos(Math.min(Math.PI, gT + LIB_REACH)); // farther than this: never visible
  }
  const cl = Math.cos(lat * DEG);
  const x = cl * Math.cos(lon * DEG);
  if (x > _dteHi) return 1;
  if (x < _dteLo) return 0;
  const y = cl * Math.sin(lon * DEG), z = Math.sin(lat * DEG), dT = _dteThr;
  let vis = 0;
  for (let i = 0; i < NS; i++) if (x * SX[i] + y * SY[i] + z * SZ[i] > dT) vis += SW[i];
  return vis > 1 - 1e-9 ? 1 : vis;
}

// ---- relay orbit models ------------------------------------------------------------------------
function keplerE(M, e) {
  let E = e < 0.8 ? M + e * Math.sin(M) : Math.PI;
  for (let i = 0; i < 30; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}
/**
 * Sample one orbit at n instants uniformly spaced in TIME.
 * type 'rot'  : positions in an inertially fixed orbit frame (x along the ascending node); the Moon
 *               rotates underneath once per sidereal month (circular and elliptical frozen orbits).
 * type 'fixed': positions in the Moon-fixed frame (+x to Earth, +z north) — libration-point orbits
 *               repeat in the rotating frame (halo, NRHO).
 */
function sampleOrbit(p, n) {
  const ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n), r = new Float64Array(n);
  let type = 'rot', periodS;
  if (p.kind === 'circular') {
    const a = R_MOON_KM + p.altKm, i = p.incDeg * DEG;
    periodS = TWO_PI * Math.sqrt(a * a * a / MU_MOON_KM3_S2);
    for (let k = 0; k < n; k++) {
      const u = TWO_PI * k / n;
      ux[k] = Math.cos(u); uy[k] = Math.sin(u) * Math.cos(i); uz[k] = Math.sin(u) * Math.sin(i); r[k] = a;
    }
  } else if (p.kind === 'elliptical') {
    let a = p.smaKm, e = p.ecc;
    if (!(a > 0)) { const rp = R_MOON_KM + p.periAltKm, ra = R_MOON_KM + p.apoAltKm; a = (rp + ra) / 2; e = (ra - rp) / (ra + rp); }
    const i = p.incDeg * DEG, w = p.argPeriDeg * DEG;
    periodS = TWO_PI * Math.sqrt(a * a * a / MU_MOON_KM3_S2);
    for (let k = 0; k < n; k++) {
      const E = keplerE(TWO_PI * k / n, e);
      const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
      const u = w + nu;
      ux[k] = Math.cos(u); uy[k] = Math.sin(u) * Math.cos(i); uz[k] = Math.sin(u) * Math.sin(i); r[k] = a * (1 - e * Math.cos(E));
    }
  } else if (p.kind === 'halo') {
    type = 'fixed'; periodS = p.periodDays * 86400;
    for (let k = 0; k < n; k++) {
      const th = TWO_PI * k / n, x = -p.distKm, y = p.ampYKm * Math.sin(th), z = p.ampZKm * Math.cos(th);
      const rr = Math.hypot(x, y, z);
      ux[k] = x / rr; uy[k] = y / rr; uz[k] = z / rr; r[k] = rr;
    }
  } else { // 'nrho': Kepler-shaped ellipse fixed in the Moon-fixed y–z plane, perilune over the north pole
    type = 'fixed'; periodS = p.periodDays * 86400;
    const a = (p.periRadiusKm + p.apoRadiusKm) / 2, e = (p.apoRadiusKm - p.periRadiusKm) / (p.apoRadiusKm + p.periRadiusKm);
    for (let k = 0; k < n; k++) {
      const E = keplerE(TWO_PI * k / n, e);
      const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
      ux[k] = 0; uy[k] = Math.sin(nu); uz[k] = Math.cos(nu); r[k] = a * (1 - e * Math.cos(E));
    }
  }
  return { type, n, periodS, ux, uy, uz, r };
}
/** Per-sample thresholds for a mask: cos of the visibility-cone half-angle λ = acos(R cos ε / r) − ε, and the
 *  Earth-occultation limit (relay hidden behind the Moon when its unit x-component < −sqrt(1 − (R/r)²)). */
function addThresholds(o, maskDeg) {
  const eps = maskDeg * DEG, n = o.n;
  o.cosLam = new Float64Array(n); o.cOcc = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const q = R_MOON_KM / o.r[k];
    o.cosLam[k] = Math.cos(Math.acos(Math.min(1, q * Math.cos(eps))) - eps);
    o.cOcc[k] = Math.sqrt(Math.max(0, 1 - q * q));
  }
  return o;
}

const N_TAB = 480, N_SIM = 720, N_SIM_FIXED = 4000;
const _models = new Map();
let _lastKeyId = null, _lastKeyMask = NaN, _lastModel = null;
function relayModel(relayId, maskDeg) {
  if (relayId === _lastKeyId && maskDeg === _lastKeyMask) return _lastModel;
  const key = relayId + '|' + maskDeg;
  let m = _models.get(key);
  if (!m) {
    const preset = RELAY_PRESETS.find(p => p.id === relayId) || RELAY_PRESETS[0];
    const tab = addThresholds(sampleOrbit(preset, N_TAB), maskDeg);
    if (tab.type === 'rot') {   // half-width (in longitude) of the band from which the relay sees Earth
      tab.dE = new Float64Array(tab.n);
      for (let k = 0; k < tab.n; k++) {
        const cps = Math.sqrt(Math.max(0, 1 - tab.uz[k] * tab.uz[k]));
        tab.dE[k] = cps <= tab.cOcc[k] ? Math.PI : Math.acos(-tab.cOcc[k] / cps);
      }
    }
    m = { preset, maskDeg, tab, rows: new Array(181), sim: null };
    if (_models.size > 40) _models.clear();
    _models.set(key, m);
  }
  _lastKeyId = relayId; _lastKeyMask = maskDeg; _lastModel = m;
  return m;
}
/** Long-run availability for one latitude (deg, integer grid) at |lon| = 0…180° in 1° steps. */
function buildRow(m, latDeg) {
  const t = m.tab, n = t.n, row = new Float32Array(181);
  const sinP = Math.sin(latDeg * DEG), cosP = Math.cos(latDeg * DEG);
  if (t.type === 'rot') {
    // The relay's sub-satellite longitude is uniformly distributed in the Moon-fixed frame over many
    // lunar rotations. For each time sample: the site sees the relay for sub-satellite longitudes within
    // ±a of the site's, the relay sees Earth within ±b of longitude 0 → overlap of two arcs / 2π.
    for (let k = 0; k < n; k++) {
      const sps = t.uz[k], cps = Math.sqrt(Math.max(0, 1 - sps * sps));
      const num = t.cosLam[k] - sinP * sps, den = cosP * cps;
      let a;
      if (den < 1e-9) a = num <= 0 ? Math.PI : 0;
      else { const c = num / den; a = c >= 1 ? 0 : c <= -1 ? Math.PI : Math.acos(c); }
      if (a === 0) continue;
      const b = t.dE[k];
      for (let j = 0; j <= 180; j++) {
        let ov;
        if (a >= Math.PI) ov = 2 * b; else if (b >= Math.PI) ov = 2 * a;
        else {
          const d = j * DEG;
          let lo = Math.max(-a, d - b), hi = Math.min(a, d + b);
          ov = hi > lo ? hi - lo : 0;
          lo = Math.max(-a, d - b - TWO_PI); hi = Math.min(a, d + b - TWO_PI);
          if (hi > lo) ov += hi - lo;
        }
        row[j] += ov;
      }
    }
    const s = 1 / (TWO_PI * n);
    for (let j = 0; j <= 180; j++) row[j] = Math.min(1, row[j] * s);
  } else {
    for (let j = 0; j <= 180; j++) {
      const nx = cosP * Math.cos(j * DEG), ny = cosP * Math.sin(j * DEG);
      let c = 0;
      for (let k = 0; k < n; k++) if (nx * t.ux[k] + ny * t.uy[k] + sinP * t.uz[k] >= t.cosLam[k] && t.ux[k] >= -t.cOcc[k]) c++;
      row[j] = c / n;
    }
  }
  return row;
}
function relayFraction(m, lat, lon) {
  const fi = clamp(lat, -90, 90) + 90, fj = Math.abs(normLon(lon));
  const i0 = Math.min(179, Math.floor(fi)), j0 = Math.min(179, Math.floor(fj));
  const a = fi - i0, b = fj - j0;
  const r0 = m.rows[i0] || (m.rows[i0] = buildRow(m, i0 - 90));
  const r1 = m.rows[i0 + 1] || (m.rows[i0 + 1] = buildRow(m, i0 - 89));
  const v = (1 - a) * ((1 - b) * r0[j0] + b * r0[j0 + 1]) + a * ((1 - b) * r1[j0] + b * r1[j0 + 1]);
  return v < 1e-6 ? 0 : v > 1 ? 1 : v;
}

/**
 * Long-run fraction of time (0..1) that a link from the site to Earth exists.
 *  mode 'dte'  : Earth's centre above state.maskDeg, averaged over libration (= earthVisibility().fracVisible).
 *                Assumes a DSN complex always has the Moon in view (see dsnMoonCoverage) and is available.
 *  mode 'relay': the chosen relay is above state.maskDeg at the site AND is not hidden from Earth by the Moon
 *                (real-time bent-pipe; store-and-forward is not credited). First-order orbit models, 1° lookup
 *                table built lazily per (relay, mask) and interpolated bilinearly.
 * Pure, no DOM. Cheap enough for a 0.5° global grid.
 */
export function commsAvailability(lat, lon, state) {
  const mode = state && state.mode === 'relay' ? 'relay' : 'dte';
  let mask = state ? Number(state.maskDeg) : DEFAULT_COMMS_STATE.maskDeg;
  if (!(mask >= 0)) mask = mask < 0 ? 0 : DEFAULT_COMMS_STATE.maskDeg; else if (mask > 45) mask = 45;
  if (!(lat >= -90 && lat <= 90) || !Number.isFinite(lon)) return 0;
  if (mode === 'dte') return dteFraction(lat, lon, mask);
  return relayFraction(relayModel(state.relayId, mask), lat, lon);
}

/**
 * DSN view of the Moon for a given lunar declination: hours per lunar transit cycle (≈24.84 h) that each
 * complex has the Moon above stationMaskDeg, and the worst handover (negative overlap = gap).
 * Spherical Earth, the Moon treated as a point at fixed declination, no local horizon masks.
 */
export function dsnMoonCoverage(decDeg = 0, stationMaskDeg = DSN_STATION_MASK_DEG) {
  const sd = Math.sin(decDeg * DEG), cd = Math.cos(decDeg * DEG), sm = Math.sin(stationMaskDeg * DEG);
  const H = DSN_COMPLEXES.map(c => {
    const cH = (sm - Math.sin(c.latDeg * DEG) * sd) / (Math.cos(c.latDeg * DEG) * cd);
    return cH >= 1 ? 0 : cH <= -1 ? 180 : Math.acos(cH) / DEG;
  });
  const order = DSN_COMPLEXES.map((_, i) => i).sort((a, b) => DSN_COMPLEXES[b].lonDeg - DSN_COMPLEXES[a].lonDeg); // westward
  let minOverlapDeg = Infinity, gapDeg = 0, worst = '';
  for (let q = 0; q < order.length; q++) {
    const i = order[q], j = order[(q + 1) % order.length];
    const sep = ((DSN_COMPLEXES[i].lonDeg - DSN_COMPLEXES[j].lonDeg) % 360 + 360) % 360;
    const ov = H[i] + H[j] - sep;
    if (ov < minOverlapDeg) { minOverlapDeg = ov; worst = `${DSN_COMPLEXES[i].name} → ${DSN_COMPLEXES[j].name}`; }
    if (ov < 0) gapDeg -= ov;
  }
  return {
    decDeg, stationMaskDeg,
    complexes: DSN_COMPLEXES.map((c, i) => ({ id: c.id, name: c.name, viewHoursPerDay: 2 * H[i] / 360 * LUNAR_DAY_AT_EARTH_H })),
    minOverlapMin: minOverlapDeg / 360 * LUNAR_DAY_AT_EARTH_H * 60, worstHandover: worst,
    coverageFraction: Math.max(0, 1 - gapDeg / 360),
  };
}

// ---- time-domain pass simulation for one site (used only by linkTimes) -------------------------
function simulate(m, lat, lon) {
  if (!m.sim) m.sim = addThresholds(sampleOrbit(m.preset, m.tab.type === 'rot' ? N_SIM : N_SIM_FIXED), m.maskDeg);
  const o = m.sim, n = o.n, dt = o.periodS / n;
  const cl = Math.cos(lat * DEG), nx = cl * Math.cos(lon * DEG), ny = cl * Math.sin(lon * DEG), nz = Math.sin(lat * DEG);
  const rot = o.type === 'rot';
  const totalS = rot ? 2 * MOON_SIDEREAL_S : o.periodS;
  const steps = rot ? Math.ceil(totalS / dt) : n;
  const wm = TWO_PI / MOON_SIDEREAL_S, th0 = (lon + 90) * DEG;   // start with the orbit plane 90° of longitude from the site
  const passes = [];
  let inView = false, start = 0, startTrunc = false, prevG = 0, inS = 0, siteS = 0, maxSlant = 0, pathSum = 0, pathN = 0;
  for (let s = 0; s <= steps; s++) {
    const k = s % n, t = s * dt;
    let xm, ym;
    if (rot) { const a = th0 - wm * t, c = Math.cos(a), sn = Math.sin(a); xm = c * o.ux[k] - sn * o.uy[k]; ym = sn * o.ux[k] + c * o.uy[k]; }
    else { xm = o.ux[k]; ym = o.uy[k]; }
    const dot = nx * xm + ny * ym + nz * o.uz[k];
    const g1 = dot - o.cosLam[k], g2 = xm + o.cOcc[k], g = g1 < g2 ? g1 : g2;
    if (s < steps) {
      if (g1 >= 0) siteS += dt;
      if (g >= 0) {
        inS += dt;
        const r = o.r[k], slant = Math.sqrt(r * r + R_MOON_KM * R_MOON_KM - 2 * r * R_MOON_KM * dot);
        if (slant > maxSlant) maxSlant = slant;
        pathSum += slant + Math.sqrt(RANGE_MEAN_KM * RANGE_MEAN_KM + r * r - 2 * RANGE_MEAN_KM * r * xm); pathN++;
      }
    }
    const now = g >= 0;
    if (s === 0) { inView = now; start = 0; startTrunc = now; }
    else if (now !== inView) {
      const tc = t - dt + dt * (prevG / (prevG - g));   // linear interpolation of the horizon crossing
      if (now) { start = tc; startTrunc = false; } else passes.push({ s: start, e: tc, trunc: startTrunc });
      inView = now;
    }
    prevG = g;
  }
  if (inView) passes.push({ s: start, e: totalS, trunc: true });
  let continuous = passes.length === 1 && passes[0].s === 0 && passes[0].e === totalS;
  if (!rot && !continuous && passes.length > 1 && passes[0].s === 0 && passes[passes.length - 1].e === totalS) {
    const last = passes.pop();   // periodic trajectory: join the pass that wraps round the period boundary
    passes[0] = { s: last.s - totalS, e: passes[0].e, trunc: false };
  } else if (!rot) for (const p of passes) p.trunc = false;
  // gaps
  let longestGapS = 0;
  if (!passes.length) longestGapS = Infinity;
  else if (!continuous) {
    for (let i = 1; i < passes.length; i++) longestGapS = Math.max(longestGapS, passes[i].s - passes[i - 1].e);
    if (rot) longestGapS = Math.max(longestGapS, passes[0].s, totalS - passes[passes.length - 1].e);
    else longestGapS = Math.max(longestGapS, passes[0].s + totalS - passes[passes.length - 1].e);
  }
  const full = passes.filter(p => !p.trunc), use = full.length ? full : passes;
  const durs = use.map(p => p.e - p.s).sort((a, b) => a - b);
  // windows: runs of passes on (nearly) consecutive orbits
  const windows = [];
  if (rot && passes.length) {
    const edge = 1.6 * o.periodS;   // a window touching the start/end of the simulation is cut short
    let w = { s: passes[0].s, e: passes[0].e, n: 1, cut: passes[0].s < edge };
    for (let i = 1; i < passes.length; i++) {
      if (passes[i].s - passes[i - 1].e <= edge) { w.e = passes[i].e; w.n++; } else { windows.push(w); w = { s: passes[i].s, e: passes[i].e, n: 1, cut: false }; }
    }
    if (totalS - w.e < edge) w.cut = true;
    windows.push(w);
  }
  return {
    rot, totalS, periodS: o.periodS, passes, continuous, fraction: inS / (steps * dt), siteFraction: siteS / (steps * dt),
    passCount: passes.length, medianPassS: durs.length ? durs[durs.length >> 1] : 0, maxPassS: durs.length ? durs[durs.length - 1] : 0,
    longestGapS, maxSlantKm: maxSlant, meanPathKm: pathN ? pathSum / pathN : NaN, windows,
  };
}
let _simKey = '', _simVal = null;
function simulateCached(m, lat, lon) {
  const key = m.preset.id + '|' + m.maskDeg + '|' + lat + '|' + lon;
  if (key !== _simKey) { _simVal = simulate(m, lat, lon); _simKey = key; }
  return _simVal;
}

const fmtDur = min => !Number.isFinite(min) ? (min > 0 ? 'never' : '–') : min < 1 ? `${(min * 60).toFixed(0)} s` : min < 180 ? `${min.toFixed(min < 10 ? 1 : 0)} min` : min < 48 * 60 ? `${(min / 60).toFixed(1)} h` : `${(min / 1440).toFixed(1)} d`;
const fmtBits = b => !Number.isFinite(b) ? '–' : b >= 8e12 ? `${(b / 8e12).toFixed(2)} TB` : b >= 8e9 ? `${(b / 8e9).toFixed(2)} GB` : b >= 8e6 ? `${(b / 8e6).toFixed(1)} MB` : b >= 8e3 ? `${(b / 8e3).toFixed(1)} kB` : `${(b / 8).toFixed(0)} B`;

/**
 * Approximate link times for one site. All values are first-order estimates; every assumption is in notes[].
 * @returns {{availability:number, contactHoursPerDay:number, passesPerDay:number, typicalPassMin:number,
 *   longestGapH:number, oneWayLightTimeS:number, dataRateBps:number, dataVolumePerDayBits:number, notes:string[],
 *   mode:string, continuous:boolean, pattern:string, longestPassMin:number, rate:object, dsn?:object,
 *   earthCycle?:object, relay?:object}}
 * Conventions: no link at all → availability 0, longestGapH Infinity, oneWayLightTimeS NaN, rates 0.
 *   DTE: a "pass" is one DSN complex's view period of the Moon (≈3 per day while Earth is above the site's mask);
 *        at libration-limited sites longestGapH is the typical Earth-hidden stretch.
 *   Relay: a pass is one contiguous interval with the relay above the mask and in view of Earth; with unbroken
 *        coverage passesPerDay is 0, typicalPassMin is 1440 and continuous is true.
 */
export function linkTimes(lat, lon, state) {
  const s = normState(state);
  lat = clamp(Number(lat) || 0, -90, 90); lon = normLon(Number(lon) || 0);
  const notes = [];
  const availability = commsAvailability(lat, lon, s);
  const tx = LANDER_TX[s.band], rxd = DSN_RX[s.band];
  const out = { mode: s.mode, availability, notes };
  const gamma = Math.acos(clamp(Math.cos(lat * DEG) * Math.cos(lon * DEG), -1, 1));
  const dteRangeKm = Math.sqrt(RANGE_MEAN_KM * RANGE_MEAN_KM + R_MOON_KM * R_MOON_KM - 2 * RANGE_MEAN_KM * R_MOON_KM * Math.cos(gamma));
  const dsnGain = linkBudget({ type: 'rf', ...tx, rxDiamM: s.dsnDishM, ...rxd, rateBps: 1, reqEbN0Db: REQ_EBN0_DB, rangeKm: RANGE_MEAN_KM }).rxGainDbi;
  const hwNote = `Receive end: DSN ${s.dsnDishM} m dish modelled as an aperture of efficiency ${rxd.rxEff} (gain ≈ ${dsnGain.toFixed(1)} dBi at ${tx.label}) with a system noise temperature of ${rxd.tsysK} K — an assumed round value dominated by the hot lunar disc in the beam, not a DSN specification (see the DSN Telecommunications Link Design Handbook, 810-005, for real figures; not checked against it in this build).`;
  const codeNote = `Rate = highest bit rate that leaves ${MARGIN_DB} dB margin over a required Eb/N0 of ${REQ_EBN0_DB} dB (rate-½ coded BPSK/QPSK class), at mean Earth–Moon distance (${RANGE_MEAN_KM.toLocaleString('en-US')} km; ±1 dB between perigee and apogee).`;
  const capTxt = b => Number.isFinite(BAND_CAP_BPS[b]) ? `capped at ${fmtRate(BAND_CAP_BPS[b])}, an assumed ${b === 'S' ? '5' : '10'} MHz channel at ≈1 bit/s/Hz (allocation-class limit, not a spectrum analysis)` : 'no bandwidth cap applied at Ka-band (the power-limited figure ignores modem, receiver and allocation limits, which will bind first)';
  if (s.dsnDishM === 70 && s.band === 'Ka') notes.push('The DSN 70 m antennas have, to my knowledge, no Ka-band downlink (S- and X-band only; unverified in this build) — this combination is shown as a hypothetical 70 m aperture.');

  if (s.mode === 'dte') {
    const d0 = dsnMoonCoverage(0), dN = dsnMoonCoverage(MOON_DEC_MAX_DEG), dS = dsnMoonCoverage(-MOON_DEC_MAX_DEG);
    const worst = [d0, dN, dS].reduce((a, b) => b.minOverlapMin < a.minOverlapMin ? b : a);
    const d6 = [0, MOON_DEC_MAX_DEG, -MOON_DEC_MAX_DEG].map(d => dsnMoonCoverage(d, 6)).reduce((a, b) => b.minOverlapMin < a.minOverlapMin ? b : a);
    // DSN geometric coverage averaged over a monthly declination cycle of amplitude ±28.6° (the least favourable years)
    let dsnFrac = 0;
    for (let q = 0; q < 24; q++) dsnFrac += dsnMoonCoverage(MOON_DEC_MAX_DEG * Math.sin(TWO_PI * (q + 0.5) / 24)).coverageFraction / 24;
    const lb = linkBudget({ type: 'rf', ...tx, rxDiamM: s.dsnDishM, ...rxd, rateBps: 1, reqEbN0Db: REQ_EBN0_DB, marginTargetDb: MARGIN_DB, rangeKm: RANGE_MEAN_KM });
    const cap = BAND_CAP_BPS[s.band];
    const rate = availability > 0 ? Math.min(lb.maxRateBps, cap) : 0;
    const meanView = d0.complexes.reduce((a, c) => a + c.viewHoursPerDay, 0) / d0.complexes.length;
    out.contactHoursPerDay = 24 * availability * dsnFrac;
    out.passesPerDay = availability > 0 ? 3 * 24 / LUNAR_DAY_AT_EARTH_H * availability : 0;
    out.typicalPassMin = availability > 0 ? meanView * 60 : 0;
    out.longestPassMin = availability > 0 ? Math.max(...dN.complexes.map(c => c.viewHoursPerDay), ...dS.complexes.map(c => c.viewHoursPerDay)) * 60 : 0;
    out.continuous = availability >= 1 && worst.minOverlapMin >= 0;
    out.oneWayLightTimeS = availability > 0 ? dteRangeKm / C_KM_S : NaN;
    out.dataRateBps = rate;
    out.dataVolumePerDayBits = rate * out.contactHoursPerDay * 3600;
    out.rate = { powerLimitedBps: lb.maxRateBps, capBps: cap, limitedBy: lb.maxRateBps > cap ? 'bandwidth cap' : 'link power', cn0DbHz: lb.cn0DbHz };
    out.dsn = {
      stationMaskDeg: DSN_STATION_MASK_DEG,
      complexes: d0.complexes.map((c, i) => ({ name: c.name, viewHoursAtDec0: c.viewHoursPerDay,
        viewHoursMin: Math.min(dN.complexes[i].viewHoursPerDay, dS.complexes[i].viewHoursPerDay),
        viewHoursMax: Math.max(dN.complexes[i].viewHoursPerDay, dS.complexes[i].viewHoursPerDay) })),
      worstHandover: worst.worstHandover, worstOverlapMin: worst.minOverlapMin, worstDecDeg: worst.decDeg,
    };
    if (availability >= 1) {
      out.longestGapH = Math.max(0, -worst.minOverlapMin) / 60;
      out.pattern = worst.minOverlapMin >= 0
        ? 'Earth is always above the mask: contact is continuous, handed over between the three DSN complexes.'
        : `Earth is always above the mask. Contact is handed over between the three DSN complexes: unbroken for most of the month, with a daily gap of up to ≈${(-worst.minOverlapMin).toFixed(0)} min at the ${worst.worstHandover} handover when the Moon is near ${worst.decDeg > 0 ? '+' : '−'}${Math.abs(worst.decDeg)}° declination.`;
    } else if (availability > 0) {
      const vis = availability * LIB_CYCLE_DAYS, hid = (1 - availability) * LIB_CYCLE_DAYS;
      out.earthCycle = { visibleDays: vis, hiddenDays: hid, cycleDays: LIB_CYCLE_DAYS };
      out.longestGapH = hid * 24;
      out.pattern = `Earth rises and sets with libration: on average ≈${vis.toFixed(1)} d above the mask, then ≈${hid.toFixed(1)} d hidden, per ≈${LIB_CYCLE_DAYS} d cycle.`;
      notes.push(`Visible/hidden durations are the long-run fraction × the ≈${LIB_CYCLE_DAYS}-day libration cycle. Individual cycles differ (longitude libration repeats every 27.55 d, latitude libration every 27.21 d, and they drift in and out of phase over ≈6 years), so some months are much better or worse than the average.`);
    } else {
      out.longestGapH = Infinity;
      out.pattern = 'Earth never rises above the mask at this site: no direct link — a relay is required.';
    }
    notes.push(`Availability = fraction of time Earth's centre is above the ${s.maskDeg}° mask at the site, from the libration model (sub-Earth point (0°, 0°) ± ${LIB_LON_DEG}° in longitude and ± ${LIB_LAT_DEG}° in latitude, independent phases). Spherical Moon: no terrain, which dominates within a few degrees of the limb and at the poles.`);
    notes.push(`DSN view periods use approximate complex coordinates and a ${DSN_STATION_MASK_DEG}° station elevation limit, with the Moon as a point at fixed declination: each complex sees the Moon for ≈${d0.complexes.map(c => `${c.viewHoursPerDay.toFixed(1)} h (${c.name})`).join(', ')} per ≈${LUNAR_DAY_AT_EARTH_H} h lunar transit cycle at 0° declination. The range shown per complex is for declinations of ±${MOON_DEC_MAX_DEG}° (the extreme, reached near a major lunar standstill such as 2024–25).`);
    notes.push(`"Always one complex in view" is an approximation: the tightest handover is ${worst.worstHandover} with the Moon at ${worst.decDeg > 0 ? '+' : worst.decDeg < 0 ? '−' : ''}${Math.abs(worst.decDeg)}° declination, where the views ${worst.minOverlapMin >= 0 ? `overlap by only ≈${worst.minOverlapMin.toFixed(0)} min` : `leave a gap of ≈${(-worst.minOverlapMin).toFixed(0)} min`} at a ${DSN_STATION_MASK_DEG}° limit (${d6.minOverlapMin >= 0 ? `≈${d6.minOverlapMin.toFixed(0)} min overlap` : `≈${(-d6.minOverlapMin).toFixed(0)} min gap`} at 6°). Contact per day includes the resulting geometric DSN coverage, ${(dsnFrac * 100).toFixed(1)}% averaged over a monthly declination swing of ±${MOON_DEC_MAX_DEG}°; the map's availability does not. Handovers happen at low elevation, where Ka-band in particular is weather-limited.`);
    notes.push('DSN scheduling is NOT modelled. The network is heavily oversubscribed; a real mission gets scheduled tracks, typically a few hours per day, not every hour the geometry allows. Treat contact time and data volume as geometric upper bounds.');
    notes.push(`Surface terminal (illustrative, not a real lander): ${tx.txPowerW} W RF into a ${tx.txDiamM} m dish (efficiency ${tx.txEff}) at ${tx.label}; pointing ${tx.lossPointDb} dB, atmosphere ${tx.lossAtmDb} dB, implementation ${tx.lossImplDb} dB.`);
    notes.push(hwNote);
    notes.push(`${codeNote} Power-limited rate ${fmtRate(lb.maxRateBps)} (C/N0 ${lb.cn0DbHz.toFixed(1)} dB-Hz); ${capTxt(s.band)}.`);
    notes.push(`One-way light time is site → Earth's centre at mean distance (a ground station is up to ≈21 ms closer); it varies between ≈1.19 s and ≈1.36 s from perigee to apogee.`);
    return out;
  }

  // ---- relay ----
  const m = relayModel(s.relayId, s.maskDeg), p = m.preset, sim = simulateCached(m, lat, lon);
  const o = m.sim, days = sim.totalS / 86400;
  const userTx = LANDER_TX.S;
  const hasLink = availability > 0 && sim.passCount > 0;
  const user = linkBudget({ type: 'rf', ...userTx, lossAtmDb: 0, rxDiamM: p.userAntDiamM, ...RELAY_USER_RX, rateBps: 1, reqEbN0Db: REQ_EBN0_DB, marginTargetDb: MARGIN_DB, rangeKm: hasLink ? sim.maxSlantKm : 1 });
  const trunk = linkBudget({ type: 'rf', ...tx, ...RELAY_TRUNK_TX, rxDiamM: s.dsnDishM, ...rxd, rateBps: 1, reqEbN0Db: REQ_EBN0_DB, marginTargetDb: MARGIN_DB, rangeKm: RANGE_MEAN_KM });
  const limits = [
    ['surface → relay link power', user.maxRateBps], ['S-band channel cap (surface → relay)', BAND_CAP_BPS.S],
    ['relay → Earth link power', trunk.maxRateBps], [`${s.band}-band channel cap (relay → Earth)`, BAND_CAP_BPS[s.band]],
  ];
  if (p.userCapBps) limits.push(['published user-link rate of this relay', p.userCapBps]);
  if (p.trunkCapBps) limits.push(['published Earth-link rate of this relay', p.trunkCapBps]);
  const lim = limits.reduce((a, b) => b[1] < a[1] ? b : a);
  const rate = hasLink ? lim[1] : 0;
  out.contactHoursPerDay = 24 * availability;
  out.continuous = sim.continuous;
  out.passesPerDay = sim.continuous ? 0 : sim.passCount / days;
  out.typicalPassMin = sim.continuous ? 1440 : sim.medianPassS / 60;
  out.longestPassMin = sim.continuous ? Infinity : sim.maxPassS / 60;
  out.longestGapH = hasLink ? sim.longestGapS / 3600 : Infinity;
  out.oneWayLightTimeS = hasLink ? sim.meanPathKm / C_KM_S : NaN;
  out.dataRateBps = rate;
  out.dataVolumePerDayBits = rate * out.contactHoursPerDay * 3600;
  out.rate = { userLinkBps: user.maxRateBps, trunkBps: trunk.maxRateBps, limitedBy: lim[0], userRangeKm: sim.maxSlantKm };
  // The plane/Moon geometry repeats every lunar rotation and the simulation spans two, so a window cut at both
  // ends of the simulation is one window seen twice.
  const wins = sim.windows, wrap = wins.length > 1 && wins[0].cut && wins[wins.length - 1].cut;
  const perRot = (wins.length - (wrap ? 1 : 0)) / 2;
  const wFull = wins.filter(w => !w.cut), wUse = wFull.length ? wFull : wins;
  out.relay = {
    id: p.id, name: p.name, status: p.status, kind: p.kind, periodMin: sim.periodS / 60,
    siteVisibleFraction: sim.siteFraction, simulatedFraction: sim.fraction, simulatedDays: days,
    windowsPerLunarRotation: sim.rot ? perRot : null,
    meanWindowDays: wUse.length ? wUse.reduce((a, w) => a + (w.e - w.s), 0) / wUse.length / 86400 : 0,
    passesPerWindow: wUse.length ? wUse.reduce((a, w) => a + w.n, 0) / wUse.length : 0,
  };
  if (p.kind === 'circular') out.relay.capHalfAngleDeg = relayGeometry(p.altKm, s.maskDeg).capHalfAngleDeg;

  if (!hasLink) out.pattern = sim.siteFraction > 0
    ? 'The relay rises above the mask here only while it is behind the Moon as seen from Earth: no real-time link (store-and-forward only).'
    : 'This relay never rises above the mask at this site.';
  else if (sim.continuous) out.pattern = 'The relay stays above the mask and in view of Earth for its whole orbit: continuous contact.';
  else if (!sim.rot) out.pattern = `${sim.passCount === 1 ? 'One contact' : sim.passCount + ' contacts'} per ${(sim.periodS / 86400).toFixed(1)}-day orbit, ≈${fmtDur(sim.medianPassS / 60)} each, with a gap of ≈${fmtDur(sim.longestGapS / 60)}.`;
  else if (wins.length === 1 && sim.passCount > 0.9 * sim.totalS / sim.periodS) out.pattern = `A pass on every orbit (period ${fmtDur(sim.periodS / 60)}), ≈${fmtDur(sim.medianPassS / 60)} each.`;
  else if (out.relay.passesPerWindow >= 1.5) out.pattern = `Passes come in ≈${perRot % 1 ? perRot.toFixed(1) : perRot} window${perRot === 1 ? '' : 's'} per ${MOON_SIDEREAL_DAYS.toFixed(1)}-day lunar rotation, each ≈${out.relay.meanWindowDays.toFixed(1)} d long with ≈${out.relay.passesPerWindow.toFixed(0)} passes (one per ${fmtDur(sim.periodS / 60)} orbit), while the orbit plane sweeps over the site; no contact for up to ≈${fmtDur(sim.longestGapS / 60)} in between.`;
  else out.pattern = `≈${(sim.passCount / days).toFixed(1)} passes per day, ≈${fmtDur(sim.medianPassS / 60)} each (orbit period ${fmtDur(sim.periodS / 60)}).`;

  notes.push(`Relay status: ${p.status.toUpperCase()}. ${p.note}`);
  notes.push(`Availability = long-run fraction of time the relay is ≥ ${s.maskDeg}° above the site's horizon AND not hidden from Earth by the Moon (real-time link). Store-and-forward is not credited: the relay is above the mask here ${(sim.siteFraction * 100).toFixed(sim.siteFraction < 0.1 ? 1 : 0)}% of the time regardless of Earth view (simulated).`);
  if (p.kind === 'circular' || p.kind === 'elliptical') {
    notes.push(`Orbit model: two-body ${p.kind === 'circular' ? 'circular' : 'Keplerian ellipse'} orbit with an inertially fixed plane${p.kind === 'elliptical' ? ' and fixed argument of perilune (the "frozen" condition)' : ''}; the Moon rotates under it once per ${MOON_SIDEREAL_DAYS.toFixed(2)} d. Lunar gravity harmonics, Earth/Sun perturbations, nodal drift, station-keeping and eclipses are ignored.`);
    notes.push(`Visibility cone: the relay is above the mask when the angle between site and sub-satellite point is ≤ λ = acos(R cos ε / r) − ε${p.kind === 'circular' ? ` = ${out.relay.capHalfAngleDeg.toFixed(1)}° here` : ' (r varies round the orbit)'}. The long-run fraction integrates this over the orbit with the sub-satellite longitude uniformly distributed (valid over many lunar rotations), on a 1° table.`);
    notes.push(`Pass count, pass length and gaps come from a ${days.toFixed(1)}-day step simulation of the same model from one arbitrary starting geometry (simulated fraction ${(sim.fraction * 100).toFixed(2)}% vs long-run ${(availability * 100).toFixed(2)}%); a real month depends on the actual orbit phase and node.`);
  } else if (p.kind === 'halo') {
    notes.push('Orbit model: the relay moves uniformly round a fixed ellipse (assumed size, see relay note) centred 65 000 km behind the Moon on the Earth–Moon line, in the Moon-fixed frame. Real halo orbits are not elliptical or uniform, and libration of the Moon relative to the Earth–Moon line is ignored — treat the edge of the coverage area as uncertain by several degrees.');
  } else {
    notes.push(`Orbit model: a Kepler-shaped ellipse fixed in the Moon-fixed plane through the poles and the 90°E/90°W meridians, perilune over the north pole, timed along a ${p.periodDays}-day period. The real NRHO is a three-body orbit that leans a few degrees toward L2 (slightly more far-side, slightly less near-side coverage than shown) and its timing differs from Kepler's equation.`);
  }
  notes.push('Earth is taken to lie exactly on the Moon-fixed +x axis (no libration) at infinite distance for the occultation test; the relay → Earth leg assumes a DSN complex is in view and available (DSN scheduling not modelled).');
  notes.push(`Surface → relay hop (illustrative): S-band 2.2 GHz, ${userTx.txPowerW} W into a steered ${userTx.txDiamM} m dish on the surface, an ASSUMED ${p.userAntDiamM} m relay antenna (efficiency ${RELAY_USER_RX.rxEff}, system noise ${RELAY_USER_RX.tsysK} K looking at the Moon), evaluated at the longest in-view slant range (${hasLink ? Math.round(sim.maxSlantKm).toLocaleString('en-US') + ' km' : 'n/a'}) → ${hasLink ? fmtRate(user.maxRateBps) : '–'} power-limited.`);
  notes.push(`Relay → Earth trunk (illustrative, the same generic payload for every preset): ${RELAY_TRUNK_TX.txPowerW} W into a ${RELAY_TRUNK_TX.txDiamM} m dish at ${tx.label} → ${fmtRate(trunk.maxRateBps)} power-limited into the DSN ${s.dsnDishM} m. Relays seen well away from the lunar disc would enjoy a colder sky (several dB better G/T); not credited.`);
  notes.push(hwNote);
  notes.push(`${codeNote} End-to-end rate = the smallest of both hops (regenerative relay) and the caps: S-band 5 Mbit/s, ${s.band}-band ${Number.isFinite(BAND_CAP_BPS[s.band]) ? fmtRate(BAND_CAP_BPS[s.band]) : 'uncapped'} (assumed channel limits)${p.userCapBps || p.trunkCapBps ? ', plus the published rates of this relay' : ''}. Here it is limited by: ${hasLink ? lim[0] : 'n/a'}.`);
  notes.push('One-way light time is the mean of site → relay → Earth centre over the in-view samples, at mean Earth–Moon distance; relay processing delay is not included.');
  return out;
}

// ---- side menu ---------------------------------------------------------------------------------
function injectMenuStyle() {
  if (typeof document === 'undefined' || document.getElementById('cm-menu-style')) return;
  const s = document.createElement('style');
  s.id = 'cm-menu-style';
  s.textContent = `
.cm-menu{box-sizing:border-box;width:100%;max-height:100%;overflow:auto;padding:12px;color:var(--text,#e6e9ef);background:var(--panel,#161b24);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
.cm-menu *{box-sizing:border-box}
.cm-menu h3{margin:0 0 2px;font-size:15px}.cm-menu h4{margin:0 0 6px;font-size:13.5px;color:var(--accent,#6cb4ff)}
.cm-m-sub{color:var(--muted,#93a0b5);font-size:12px;margin:0 0 10px}
.cm-m-sec{border:0;border-top:1px solid var(--border,#2a3242);margin:0;padding:10px 0;min-width:0}
.cm-m-sec legend,.cm-m-lbl{padding:0;margin:0 0 6px;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#93a0b5);display:block}
.cm-m-radio{display:flex;gap:8px;align-items:flex-start;padding:7px 8px;margin:0 0 6px;border:1px solid var(--border,#2a3242);border-radius:6px;background:var(--bg,#0d1117);cursor:pointer}
.cm-m-radio:has(input:checked){border-color:var(--accent,#6cb4ff)}
.cm-m-radio input{margin:3px 0 0;accent-color:var(--accent,#6cb4ff);flex:none}
.cm-m-radio b{display:block;font-weight:600}.cm-m-radio small{display:block;color:var(--muted,#93a0b5);font-size:11.5px}
.cm-menu select,.cm-menu input[type=number]{width:100%;background:var(--bg,#0d1117);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3242);border-radius:5px;padding:5px 6px;font:inherit}
.cm-m-seg{display:flex;gap:6px}
.cm-m-seg button{flex:1 1 0;min-width:0;background:var(--bg,#0d1117);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3242);border-radius:5px;padding:6px 4px;cursor:pointer;font:inherit}
.cm-m-seg button[aria-pressed=true]{border-color:var(--accent,#6cb4ff);color:var(--accent,#6cb4ff);font-weight:600}
.cm-menu button:focus-visible,.cm-menu select:focus-visible,.cm-menu input:focus-visible,.cm-menu summary:focus-visible{outline:2px solid var(--accent,#6cb4ff);outline-offset:1px}
.cm-m-mask{display:flex;gap:8px;align-items:center}
.cm-m-mask input[type=range]{flex:1 1 auto;min-width:0;accent-color:var(--accent,#6cb4ff)}
.cm-m-mask input[type=number]{flex:none;width:62px}
.cm-m-hint{color:var(--muted,#93a0b5);font-size:11.5px;margin:5px 0 0}
.cm-m-chip{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:10px;padding:1px 8px;border:1px solid currentColor;margin:8px 6px 4px 0}
.cm-m-chip.cm-real{color:#3fb97a}.cm-m-chip.cm-planned{color:#e0a83a}.cm-m-chip.cm-hypothetical{color:#c09bf0}
.cm-m-info{font-size:12px}.cm-m-info p{margin:4px 0}.cm-m-info .cm-m-note{color:var(--muted,#93a0b5)}
.cm-menu a{color:var(--accent,#6cb4ff)}
.cm-m-site{margin:0 0 8px;font-weight:600}.cm-m-site span{display:block;font-weight:400;color:var(--muted,#93a0b5);font-size:12px}
.cm-m-prompt{border:1px dashed var(--border,#2a3242);border-radius:6px;padding:12px;color:var(--muted,#93a0b5);text-align:center}
.cm-m-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.cm-m-grid div{background:var(--bg,#0d1117);border:1px solid var(--border,#2a3242);border-radius:6px;padding:6px 8px;min-width:0}
.cm-m-grid b{display:block;font-size:15px;font-variant-numeric:tabular-nums}.cm-m-grid span{display:block;color:var(--muted,#93a0b5);font-size:11.5px}
.cm-m-grid .cm-m-wide,.cm-m-grid div:last-child:nth-child(odd){grid-column:1 / -1}
.cm-m-pattern{margin:8px 0;padding:7px 9px;border-left:3px solid var(--accent,#6cb4ff);background:var(--bg,#0d1117);border-radius:4px;font-size:12.5px}
.cm-m-pattern.cm-m-bad{border-left-color:#e2605a}.cm-m-pattern.cm-m-warn{border-left-color:#e0a83a}.cm-m-pattern.cm-m-good{border-left-color:#3fb97a}
.cm-m-tbl{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;margin:6px 0}
.cm-m-tbl th{text-align:left;font-weight:400;color:var(--muted,#93a0b5);padding:2px 4px 2px 0}.cm-m-tbl td{padding:2px 0 2px 4px;text-align:right}
.cm-m-tbl caption{text-align:left;color:var(--muted,#93a0b5);font-size:11.5px;padding:0 0 2px}
.cm-menu details{margin:8px 0 0}.cm-menu summary{cursor:pointer;color:var(--accent,#6cb4ff)}
.cm-menu details ul{margin:6px 0 0;padding-left:16px;color:var(--muted,#93a0b5);font-size:12px}.cm-menu details li{margin:0 0 5px}`;
  document.head.appendChild(s);
}
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let _menuUid = 0;

/**
 * Side menu for wizard step 3. Fills `container` (a narrow column, ≈320 px) with the link-path choice, relay picker,
 * DSN antenna, band and mask controls, and a "Link times (approximate)" readout for getSite() → {lat, lon, label} | null.
 * Calls onChange(newState) with a NEW object on every user change. Sets container.__refresh() to re-read getSite()
 * and redraw the readout.
 */
export function renderCommsMenu(container, state, onChange, getSite) {
  injectMenuStyle();
  let st = normState(state);
  const uid = ++_menuUid;
  container.innerHTML = `<div class="cm-menu">
  <h3>Communications</h3>
  <p class="cm-m-sub">How the site talks to Earth. All figures are first-order estimates.</p>
  <fieldset class="cm-m-sec"><legend>Link path</legend>
    <label class="cm-m-radio"><input type="radio" name="cm-mode-${uid}" value="dte"><span><b>Direct to Earth (DSN)</b><small>Surface antenna → Deep Space Network dish</small></span></label>
    <label class="cm-m-radio"><input type="radio" name="cm-mode-${uid}" value="relay"><span><b>Via lunar relay orbiter</b><small>Surface → relay satellite → DSN dish</small></span></label>
  </fieldset>
  <div class="cm-m-sec cm-m-relay">
    <label class="cm-m-lbl" for="cm-relay-${uid}">Relay orbit</label>
    <select id="cm-relay-${uid}" class="cm-m-relaysel">${RELAY_PRESETS.map(p => `<option value="${esc(p.id)}">${esc(p.name)} [${p.status}]</option>`).join('')}</select>
    <div class="cm-m-info"></div>
  </div>
  <div class="cm-m-sec"><span class="cm-m-lbl" id="cm-dish-${uid}">DSN antenna</span>
    <div class="cm-m-seg" role="group" aria-labelledby="cm-dish-${uid}"><button type="button" data-dish="34">34 m BWG</button><button type="button" data-dish="70">70 m</button></div>
  </div>
  <div class="cm-m-sec"><span class="cm-m-lbl cm-m-bandlbl" id="cm-band-${uid}">Band</span>
    <div class="cm-m-seg" role="group" aria-labelledby="cm-band-${uid}"><button type="button" data-band="S">S</button><button type="button" data-band="X">X</button><button type="button" data-band="Ka">Ka</button></div>
    <p class="cm-m-hint cm-m-bandhint"></p>
  </div>
  <div class="cm-m-sec"><label class="cm-m-lbl" for="cm-mask-${uid}">Minimum elevation at the site (mask)</label>
    <div class="cm-m-mask"><input type="range" class="cm-m-maskr" min="0" max="30" step="1" aria-label="Mask angle slider"><input type="number" id="cm-mask-${uid}" class="cm-m-maskn" min="0" max="45" step="0.5"><span>°</span></div>
    <p class="cm-m-hint cm-m-maskhint"></p>
  </div>
  <div class="cm-m-sec cm-m-read" aria-live="polite">
    <h4>Link times (approximate)</h4>
    <div class="cm-m-body"></div>
    <details class="cm-m-assume" hidden><summary>Assumptions</summary><ul></ul></details>
  </div></div>`;
  const root = container.firstElementChild;
  const $ = q => root.querySelector(q);

  function drawControls() {
    root.querySelectorAll(`input[name="cm-mode-${uid}"]`).forEach(r => { r.checked = r.value === st.mode; });
    $('.cm-m-relay').hidden = st.mode !== 'relay';
    $('.cm-m-relaysel').value = st.relayId;
    const p = RELAY_PRESETS.find(q => q.id === st.relayId);
    $('.cm-m-info').innerHTML = `<span class="cm-m-chip cm-${p.status}">${p.status}</span>
      <p>${esc(p.description)}</p><p class="cm-m-note">${esc(p.note)}</p>
      <p class="cm-m-note">Source${p.sources.length > 1 ? 's' : ''}: ${p.sources.map(q => `<a href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">${esc(q.label)}</a>`).join('; ')}</p>
      <details><summary>Announced relays not modelled</summary><ul>${RELAYS_NOT_MODELLED.map(q => `<li><b>${esc(q.name)}</b> [${q.status}] — ${esc(q.note)} <a href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">source</a></li>`).join('')}</ul></details>`;
    root.querySelectorAll('[data-dish]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.dish === st.dsnDishM)));
    root.querySelectorAll('[data-band]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.band === st.band)));
    $('.cm-m-bandlbl').textContent = st.mode === 'relay' ? 'Band (relay → Earth)' : 'Band (surface → Earth)';
    $('.cm-m-bandhint').textContent = `${LANDER_TX[st.band].label}${st.mode === 'relay' ? '; the surface → relay hop is modelled at S-band.' : '.'}`;
    if (document.activeElement !== $('.cm-m-maskn')) $('.cm-m-maskn').value = st.maskDeg;
    $('.cm-m-maskr').value = Math.min(30, st.maskDeg);
    $('.cm-m-maskhint').textContent = st.mode === 'relay'
      ? 'Lowest elevation of the relay above the local horizon that counts as a usable link (stands in for terrain and multipath).'
      : 'Lowest elevation of Earth above the local horizon that counts as a usable link (stands in for terrain and multipath).';
  }

  function drawReadout() {
    let site = null;
    try { site = typeof getSite === 'function' ? getSite() : null; } catch (e) { site = null; }
    const body = $('.cm-m-body'), det = $('.cm-m-assume');
    if (!site || !Number.isFinite(Number(site.lat)) || !Number.isFinite(Number(site.lon))) {
      body.innerHTML = `<div class="cm-m-prompt">Click a point on the Moon to see approximate link times for that site.</div>`;
      det.hidden = true;
      return;
    }
    const lat = Number(site.lat), lon = Number(site.lon), r = linkTimes(lat, lon, st);
    const pct = r.availability * 100;
    const pctTxt = pct === 0 ? '0%' : pct >= 100 ? '100%' : pct < 1 ? pct.toFixed(2) + '%' : pct.toFixed(1) + '%';
    const cls = r.availability <= 0 ? 'cm-m-bad' : r.availability >= 0.9995 ? 'cm-m-good' : 'cm-m-warn';
    const tile = (v, l, wide) => `<div${wide ? ' class="cm-m-wide"' : ''}><b>${v}</b><span>${l}</span></div>`;
    const none = r.availability <= 0;
    const tiles = [tile(pctTxt, st.mode === 'relay' ? 'availability (relay up and seeing Earth)' : `availability (Earth above ${f(st.maskDeg, st.maskDeg % 1 ? 1 : 0)}°)`),
      tile(none ? '0 h' : `${f(r.contactHoursPerDay, r.contactHoursPerDay < 10 ? 2 : 1)} h`, 'contact per day (long-run mean)')];
    if (st.mode === 'relay') {
      tiles.push(tile(none ? '–' : r.continuous ? 'continuous' : fmtDur(r.typicalPassMin), 'typical pass length'));
      tiles.push(tile(none ? '0' : r.continuous ? '–' : r.passesPerDay >= 1 ? f(r.passesPerDay, 1) + ' / day' : f(r.passesPerDay * MOON_SIDEREAL_DAYS, 1) + ' / 27.3 d', 'passes (average)'));
      tiles.push(tile(none ? '–' : r.continuous ? '–' : fmtDur(r.longestPassMin), 'longest pass'));
    } else {
      tiles.push(tile(none ? '–' : r.earthCycle ? `${f(r.earthCycle.visibleDays, 1)} d` : 'continuous', r.earthCycle ? `Earth up per ≈${LIB_CYCLE_DAYS} d cycle` : 'Earth visibility'));
      tiles.push(tile(none ? '–' : fmtDur(r.typicalPassMin), 'one DSN complex\'s view of the Moon'));
    }
    tiles.push(tile(none ? 'no contact' : r.longestGapH <= 0 ? 'none' : fmtDur(r.longestGapH * 60), st.mode === 'dte' && r.availability >= 1 ? 'longest gap (worst DSN handover)' : st.mode === 'dte' ? 'longest gap (Earth below mask)' : 'longest gap'));
    tiles.push(tile(none ? '–' : `${f(r.oneWayLightTimeS, 3)} s`, st.mode === 'relay' ? 'one-way light time via relay' : 'one-way light time'));
    tiles.push(tile(none ? '–' : fmtRate(r.dataRateBps), 'indicative data rate'));
    tiles.push(tile(none ? '–' : fmtBits(r.dataVolumePerDayBits), 'volume per day (upper bound)'));
    let extra = '';
    if (st.mode === 'dte' && !none) {
      extra = `<table class="cm-m-tbl"><caption>DSN view of the Moon per day, ${r.dsn.stationMaskDeg}° station limit (range over lunar declination)</caption><tbody>${
        r.dsn.complexes.map(c => `<tr><th scope="row">${esc(c.name)}</th><td>${f(c.viewHoursAtDec0, 1)} h (${f(c.viewHoursMin, 1)}–${f(c.viewHoursMax, 1)})</td></tr>`).join('')}</tbody></table>`;
    } else if (st.mode === 'relay' && !none) {
      extra = `<table class="cm-m-tbl"><tbody>
        <tr><th scope="row">Relay orbit period</th><td>${fmtDur(r.relay.periodMin)}</td></tr>
        <tr><th scope="row">Rate limited by</th><td>${esc(r.rate.limitedBy)}</td></tr>
        <tr><th scope="row">Longest slant range to relay</th><td>${Math.round(r.rate.userRangeKm).toLocaleString('en-US')} km</td></tr></tbody></table>`;
    }
    body.innerHTML = `<div class="cm-m-site">${esc(site.label || 'Selected site')}<span>${fmtLat(lat)}, ${fmtLon(lon)} · ${st.mode === 'relay' ? esc(RELAY_PRESETS.find(q => q.id === st.relayId).name) : `direct to DSN ${st.dsnDishM} m`}</span></div>
      <div class="cm-m-grid">${tiles.join('')}</div>
      <div class="cm-m-pattern ${cls}">${esc(r.pattern)}</div>${extra}`;
    det.hidden = false;
    det.querySelector('summary').textContent = `Assumptions (${r.notes.length})`;
    det.querySelector('ul').innerHTML = r.notes.map(n => `<li>${esc(n)}</li>`).join('');
  }

  function commit(patch) {
    st = normState({ ...st, ...patch });
    drawControls(); drawReadout();
    if (typeof onChange === 'function') onChange({ ...st });
  }
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.name === `cm-mode-${uid}` && t.checked) commit({ mode: t.value });
    else if (t.classList.contains('cm-m-relaysel')) commit({ relayId: t.value });
    else if (t.classList.contains('cm-m-maskn')) { t.value = st.maskDeg; }
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.dish && +b.dataset.dish !== st.dsnDishM) commit({ dsnDishM: +b.dataset.dish });
    else if (b.dataset.band && b.dataset.band !== st.band) commit({ band: b.dataset.band });
  });
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.classList.contains('cm-m-maskr')) commit({ maskDeg: Number(t.value) });
    else if (t.classList.contains('cm-m-maskn') && t.value.trim() !== '' && Number.isFinite(Number(t.value))) commit({ maskDeg: Number(t.value) });
  });

  drawControls(); drawReadout();
  container.__refresh = () => drawReadout();
}

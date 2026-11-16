// LODESTAR — step 5: surface power. Solar illumination from the LOLA elevation grid, array output for a
// user-set cell efficiency, storage to bridge the longest darkness, and a comparison with a fission unit.
// Plain ES module, no dependencies. First-order estimates: every assumption is shown in the panel.
import { loadLayer, sample, MOON_RADIUS_KM } from './data.js';

export const SOLAR_CONST_W_M2 = 1361;      // mean solar irradiance at 1 AU (the Moon's distance varies it by about ±3.4% over a year)
const SYNODIC_D = 29.5306;                 // lunar day (sunrise to sunrise), Earth days
const DRACONIC_YEAR_D = 346.62;            // period of the Sun's latitude cycle on the Moon, Earth days
const SUN_LAT_MAX_DEG = 1.5424;            // tilt of the Moon's equator to the ecliptic: the sub-solar latitude stays within ± this
const D2R = Math.PI / 180;
const N_AZ = 72;                           // horizon profile every 5°
const C1 = '#3987e5', C2 = '#d95926';      // chart series colours (checked for colour-blind separation on the dark panel)

// Reference systems (figures quoted from the sources, not specifications of flight hardware).
export const REFERENCE = {
  vsat: {
    name: 'NASA Vertical Solar Array Technology (VSAT)',
    text: '10 kW-class arrays on masts (threshold 5 m, goal 10 m) that turn through 360° about one axis; specific power threshold 45 W/kg, goal 65 W/kg (project key performance parameters, 2023 review — "not yet in an approved state").',
    source: 'https://ntrs.nasa.gov/api/citations/20230012849/downloads/GCD%20Annual%20Review%20VSAT%20September%202023%20Final.pdf',
  },
  fsp: {
    name: 'NASA Fission Surface Power (Phase 1 requirement, 2022)',
    kWe: 40, massKg: 6000, lifeYears: 10,
    text: '40 kW electric, under 6 metric tons, about ten years without human intervention. A 2025 NASA directive raised the goal to at least 100 kWe by 2030; no mass figure for that unit is used here.',
    source: 'https://newspaceeconomy.ca/2026/04/07/nasas-fission-surface-power-project/',
  },
};

export const DEFAULT_INPUTS = {
  effPct: 30,          // cell efficiency (user input)
  areaM2: 35,          // panel area per mast
  mastM: 10,           // height of the array above the ground
  arrayType: 'vertical',
  fillPct: 85,         // share of panel area that is active cell
  lossPct: 15,         // dust, wiring, conversion, degradation
  specPowerWkg: 45,    // array-level specific power for the mass estimate
  loadKw: 10,          // continuous electrical load
  storeWhKg: 200,      // storage specific energy (pack level)
  dodPct: 80,          // usable depth of discharge
  rtPct: 85,           // storage round-trip efficiency
};

export const ARRAY_TYPES = [
  { id: 'vertical', name: 'Vertical mast, turns to face the Sun', note: 'VSAT-like. Panel stands upright and follows the Sun in azimuth; output scales with cos(Sun elevation), so it is best near the poles.' },
  { id: 'horizontal', name: 'Flat on the ground, fixed', note: 'Output scales with sin(Sun elevation): good near the equator, poor near the poles.' },
  { id: 'twoaxis', name: 'Two-axis Sun tracker', note: 'Always square to the Sun; the upper bound for any site.' },
];

// ---------- geometry ----------
function destination(latDeg, lonDeg, bearingDeg, dRad) {
  const p = latDeg * D2R, t = bearingDeg * D2R;
  const sinLat2 = Math.sin(p) * Math.cos(dRad) + Math.cos(p) * Math.sin(dRad) * Math.cos(t);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 = lonDeg * D2R + Math.atan2(Math.sin(t) * Math.sin(dRad) * Math.cos(p), Math.cos(dRad) - Math.sin(p) * sinLat2);
  return [lat2 / D2R, ((lon2 / D2R + 540) % 360) - 180];
}

// Terrain horizon elevation angle (degrees) in N_AZ directions (0 = north, clockwise through east).
export function horizonProfile(elev, lat, lon, mastM = 0, maxKm = 250) {
  const R = MOON_RADIUS_KM * 1000;
  const h0 = sample(elev, lat, lon);
  const r0 = R + (Number.isFinite(h0) ? h0 : 0) + mastM;
  const stepKm = (180 / elev.height) * (Math.PI * MOON_RADIUS_KM / 180);   // native pixel size in latitude
  const out = new Float32Array(N_AZ);
  for (let a = 0; a < N_AZ; a++) {
    let best = -90;
    for (let dKm = stepKm; dKm <= maxKm; dKm += dKm < 60 ? stepKm : stepKm * 2.5) {
      const d = dKm / MOON_RADIUS_KM;
      const [la, lo] = destination(lat, lon, a * (360 / N_AZ), d);
      const h = sample(elev, la, lo);
      if (!Number.isFinite(h)) continue;
      const r1 = R + h;
      const ang = Math.atan2(r1 * Math.cos(d) - r0, r1 * Math.sin(d)) / D2R;
      if (ang > best) best = ang;
    }
    out[a] = best;
  }
  return { horizon: out, siteElevM: Number.isFinite(h0) ? h0 : NaN, pixelKm: stepKm };
}

// One draconic year of Sun positions at 1-hour steps against the terrain horizon.
export function simulateSun(lat, lon, horizon) {
  const stepH = 1, n = Math.round(DRACONIC_YEAR_D * 24 / stepH);
  const p = lat * D2R, l = lon * D2R;
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const months = new Float64Array(12), monthN = new Float64Array(12);
  const sunMax = new Float32Array(N_AZ).fill(NaN);
  let nLit = 0, sV = 0, sH = 0, run = 0, longest = 0, firstRun = -1, litRun = 0, longestLit = 0;
  const lit = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const tD = i * stepH / 24;
    const sl = (lon - 360 * tD / SYNODIC_D) * D2R;                       // sub-solar longitude drifts west
    const sd = SUN_LAT_MAX_DEG * Math.sin(2 * Math.PI * tD / DRACONIC_YEAR_D) * D2R;
    const s = [Math.cos(sd) * Math.cos(sl), Math.cos(sd) * Math.sin(sl), Math.sin(sd)];
    const su = s[0] * up[0] + s[1] * up[1] + s[2] * up[2];
    const el = Math.asin(Math.max(-1, Math.min(1, su))) / D2R;
    let az = Math.atan2(s[0] * east[0] + s[1] * east[1], s[0] * north[0] + s[1] * north[1] + s[2] * north[2]) / D2R;
    if (az < 0) az += 360;
    const f = az / (360 / N_AZ), a0 = Math.floor(f) % N_AZ, a1 = (a0 + 1) % N_AZ, k = f - Math.floor(f);
    const hor = horizon[a0] * (1 - k) + horizon[a1] * k;
    const b = Math.round(f) % N_AZ;
    if (!(sunMax[b] >= el)) sunMax[b] = el;
    const isLit = el > hor;
    const m = Math.min(11, Math.floor(i / n * 12));
    monthN[m]++;
    if (isLit) {
      nLit++; months[m]++; lit[i] = 1;
      sV += Math.cos(el * D2R); sH += Math.max(0, Math.sin(el * D2R));
      if (run > 0) { if (firstRun < 0 && i === run) firstRun = run; if (run > longest) longest = run; run = 0; }
      litRun++; if (litRun > longestLit) longestLit = litRun;
    } else { run++; litRun = 0; }
  }
  if (run > 0) {                                                          // dark at the end: join with a dark start
    const joined = run + (lit[0] ? 0 : Math.max(0, firstRun));
    if (joined > longest) longest = Math.min(n, joined);
  }
  const fracLit = nLit / n;
  return {
    fracLit,
    longestDarkH: nLit === 0 ? Infinity : longest * stepH,
    longestLitH: longestLit * stepH,
    cf: { vertical: sV / n, horizontal: sH / n, twoaxis: fracLit },      // year-average output ÷ output square to the Sun
    months: Array.from(months, (v, i) => (monthN[i] ? v / monthN[i] : 0)),
    sunMax: Array.from(sunMax),
  };
}

export function illumination(elev, lat, lon, mastM) {
  const hp = horizonProfile(elev, lat, lon, mastM);
  return { ...hp, ...simulateSun(lat, lon, hp.horizon), horizon: Array.from(hp.horizon) };
}

// ---------- sizing ----------
export function sizePower(inp, il) {
  const eff = inp.effPct / 100;
  const peakW = SOLAR_CONST_W_M2 * eff * inp.areaM2 * (inp.fillPct / 100) * (1 - inp.lossPct / 100);   // one mast, square to the Sun
  const types = ARRAY_TYPES.map(t => ({ ...t, cf: il.cf[t.id], meanW: peakW * il.cf[t.id] }));
  const sel = types.find(t => t.id === inp.arrayType) || types[0];
  const loadW = inp.loadKw * 1000, f = il.fracLit, rt = inp.rtPct / 100;
  const needMeanW = loadW * (f + (1 - f) / rt);                           // year-average generation that covers the load plus storage losses
  const units = sel.meanW > 0 ? Math.ceil(needMeanW / sel.meanW - 1e-9) : Infinity;
  const storageWh = Number.isFinite(il.longestDarkH) ? loadW * il.longestDarkH / (inp.dodPct / 100) : Infinity;
  const arrayMassKg = Number.isFinite(units) ? units * peakW / inp.specPowerWkg : Infinity;
  const storageMassKg = storageWh / inp.storeWhKg;
  const solarMassKg = arrayMassKg + storageMassKg;
  const fUnits = Math.max(1, Math.ceil(inp.loadKw / REFERENCE.fsp.kWe - 1e-9));
  const fissionMassKg = fUnits * REFERENCE.fsp.massKg;
  let recommended, reason;
  if (!(f > 0.01)) { recommended = 'fission'; reason = 'The site is sunlit less than 1% of the time in this model, so solar power is not workable.'; }
  else if (!Number.isFinite(solarMassKg)) { recommended = 'fission'; reason = 'This array type produces no usable power at this site.'; }
  else if (solarMassKg <= fissionMassKg) { recommended = 'solar'; reason = `Solar arrays with storage come to about ${fmtMass(solarMassKg)}, lighter than the ${fmtMass(fissionMassKg)} upper bound for fission.`; }
  else { recommended = 'fission'; reason = `Solar arrays with storage come to about ${fmtMass(solarMassKg)}, heavier than the ${fmtMass(fissionMassKg)} upper bound for fission. Storage for the ${fmtDark(il.longestDarkH)} of darkness is ${fmtMass(storageMassKg)} of that.`; }
  return {
    peakW, types, arrayType: sel, units, needMeanW, storageWh, arrayMassKg, storageMassKg, solarMassKg,
    fission: { units: fUnits, kWe: fUnits * REFERENCE.fsp.kWe, massKg: fissionMassKg }, recommended, reason,
  };
}

// ---------- formatting ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
export function fmtMass(kg) {
  if (!Number.isFinite(kg)) return 'not possible';
  return kg >= 1000 ? `${num(kg / 1000, kg >= 100000 ? 0 : 1)} t` : `${num(kg, 0)} kg`;
}
function fmtPower(w) { return !Number.isFinite(w) ? '—' : w >= 1000 ? `${num(w / 1000, w >= 100000 ? 0 : 1)} kW` : `${num(w, 0)} W`; }
function fmtEnergy(wh) { return !Number.isFinite(wh) ? 'not possible' : wh >= 1e6 ? `${num(wh / 1e6, 2)} MWh` : `${num(wh / 1000, 0)} kWh`; }
export function fmtDark(h) {
  if (!Number.isFinite(h)) return 'permanent';
  if (h <= 0) return '0 hours';
  return h >= 48 ? `${num(h / 24, 1)} Earth days` : `${num(h, 0)} hours`;
}
const fmtLatLon = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

// ---------- charts (inline SVG) ----------
function horizonChart(il) {
  const W = 620, H = 210, L = 44, R = 12, T = 12, B = 30, pw = W - L - R, ph = H - T - B;
  const hor = il.horizon, sun = il.sunMax;
  const vals = [...hor, ...sun.filter(Number.isFinite)];
  let lo = Math.min(-2, Math.floor(Math.min(...vals))), hi = Math.max(4, Math.ceil(Math.max(...vals) + 0.5));
  lo = Math.max(lo, -6);
  const x = a => L + (a / 360) * pw, y = v => T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ph;
  const step = (hi - lo) > 40 ? 20 : (hi - lo) > 16 ? 5 : 2;
  let grid = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? '#5a6780' : '#2a3347'}" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}°</text>`;
  const dirs = [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['N', 360]].map(([n, a]) => `<text x="${x(a)}" y="${H - 10}" text-anchor="middle">${n}</text>`).join('');
  const ptsH = [...hor, hor[0]].map((v, i) => `${x(i * 360 / N_AZ).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M${L},${y(lo)} L${ptsH.join(' L')} L${W - R},${y(lo)} Z`;
  let sunPath = '', pen = false;
  [...sun, sun[0]].forEach((v, i) => {
    if (!Number.isFinite(v) || v < lo) { pen = false; return; }
    sunPath += `${pen ? 'L' : 'M'}${x(i * 360 / N_AZ).toFixed(1)},${y(v).toFixed(1)} `; pen = true;
  });
  const hits = hor.map((v, i) => `<rect x="${x(i * 360 / N_AZ) - pw / N_AZ / 2}" y="${T}" width="${pw / N_AZ}" height="${ph}" fill="transparent"><title>Direction ${i * 5}° from north: terrain horizon ${v.toFixed(1)}°, highest Sun ${Number.isFinite(sun[i]) ? sun[i].toFixed(1) + '°' : 'never in this direction'}</title></rect>`).join('');
  return `<svg class="pw-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Terrain horizon and the highest Sun elevation, by compass direction">
    ${grid}${dirs}
    <path d="${area}" fill="${C1}" fill-opacity=".28"/><path d="M${ptsH.join(' L')}" fill="none" stroke="${C1}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${sunPath}" fill="none" stroke="${C2}" stroke-width="2" stroke-linejoin="round"/>${hits}
  </svg>
  <div class="pw-legend"><span><i style="background:${C1}"></i>Terrain horizon</span><span><i style="background:${C2}"></i>Highest Sun over the year</span><span class="pw-muted">The site is lit when the Sun is above the horizon line.</span></div>`;
}
function monthChart(il) {
  const W = 620, H = 150, L = 44, R = 12, T = 10, B = 26, pw = W - L - R, ph = H - T - B, bw = pw / 12;
  const y = v => T + (1 - v) * ph;
  let s = '';
  for (const v of [0, 0.5, 1]) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#2a3347" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  il.months.forEach((v, i) => {
    const h = Math.max(v > 0 ? 2 : 0, v * ph), x0 = L + i * bw + 2;
    s += `<path d="M${x0},${y(0)} v${-(h - Math.min(4, h))} q0,${-Math.min(4, h)} ${Math.min(4, h)},${-Math.min(4, h)} h${bw - 4 - 2 * Math.min(4, h)} q${Math.min(4, h)},0 ${Math.min(4, h)},${Math.min(4, h)} v${h - Math.min(4, h)} Z" fill="${C1}"/>`;
    s += `<rect x="${L + i * bw}" y="${T}" width="${bw}" height="${ph}" fill="transparent"><title>Part ${i + 1} of 12 of the year: lit ${(v * 100).toFixed(0)}% of the time</title></rect>`;
    s += `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${i + 1}</text>`;
  });
  return `<svg class="pw-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of time the site is sunlit in each twelfth of the year">${s}</svg>`;
}
function massChart(z) {
  const rows = [['Solar arrays', z.arrayMassKg, ''], ['Energy storage', z.storageMassKg, ''], [`Fission, ${z.fission.units} × 40 kWe`, z.fission.massKg, 'at most ']];
  const fin = rows.map(r => r[1]).filter(Number.isFinite), mx = Math.max(1, ...fin);
  const W = 620, rowH = 30, L = 170, R = 110, pw = W - L - R;
  let s = '';
  rows.forEach(([name, v, pre], i) => {
    const yy = 6 + i * rowH, w = Number.isFinite(v) ? Math.max(2, v / mx * pw) : pw, r = Math.min(4, w / 2);
    s += `<text x="${L - 8}" y="${yy + 14}" text-anchor="end">${esc(name)}</text>`;
    s += Number.isFinite(v)
      ? `<path d="M${L},${yy} h${w - r} q${r},0 ${r},${r} v${18 - 2 * r} q0,${r} ${-r},${r} h${-(w - r)} Z" fill="${C1}"><title>${esc(name)}: ${pre}${fmtMass(v)}</title></path>`
      : `<rect x="${L}" y="${yy}" width="${pw}" height="18" fill="none" stroke="#5a6780" stroke-dasharray="4 4"/>`;
    s += `<text class="pw-val" x="${L + w + 8}" y="${yy + 14}">${pre}${fmtMass(v)}</text>`;
  });
  return `<svg class="pw-chart" viewBox="0 0 ${W} ${6 + rows.length * rowH}" role="img" aria-label="Mass of the solar option against the fission option">${s}</svg>`;
}

// ---------- panel ----------
function injectStyle() {
  if (document.getElementById('pw-style')) return;
  const st = document.createElement('style'); st.id = 'pw-style';
  st.textContent = `
.pw-root{height:100%;overflow:auto;padding:16px 20px 28px;color:var(--text,#e6e9ef);font-size:14px;box-sizing:border-box}
.pw-head{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.pw-head h2{margin:0;font-size:20px}.pw-head .pw-site{flex:1 1 auto;min-width:200px}
.pw-muted{color:var(--muted,#8f9bb3)}.pw-small{font-size:12.5px;line-height:1.45}
.pw-btn{background:var(--panel,#141925);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3347);border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
.pw-btn:hover{border-color:var(--accent,#5fb4ff)}.pw-btn.pw-primary{background:var(--accent,#5fb4ff);color:#06121f;border-color:var(--accent,#5fb4ff);font-weight:600}
.pw-grid{display:grid;grid-template-columns:minmax(300px,360px) minmax(0,1fr);gap:16px;align-items:start}
.pw-grid>div:first-child{position:sticky;top:0}
@media (max-width:900px){.pw-grid{grid-template-columns:1fr}.pw-grid>div:first-child{position:static}}
.pw-card{background:var(--panel,#141925);border:1px solid var(--border,#2a3347);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.pw-card h3{margin:0 0 10px;font-size:15px}
.pw-field{display:block;margin:0 0 12px}.pw-field>span{display:block;margin-bottom:4px}
.pw-field input,.pw-field select{width:100%;box-sizing:border-box;background:var(--bg,#0b0e14);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3347);border-radius:6px;padding:7px 8px;font:inherit}
.pw-field input.pw-bad{border-color:#e66767}
.pw-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.pw-chip{background:transparent;color:var(--muted,#8f9bb3);border:1px solid var(--border,#2a3347);border-radius:999px;padding:3px 10px;font:inherit;font-size:12.5px;cursor:pointer}
.pw-chip:hover,.pw-chip.pw-on{color:var(--text,#e6e9ef);border-color:var(--accent,#5fb4ff)}
.pw-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pw-verdict{border-left:4px solid var(--accent,#5fb4ff);background:var(--panel,#141925);border-radius:8px;padding:12px 16px;margin-bottom:14px}
.pw-verdict b{font-size:16px}.pw-verdict p{margin:6px 0 0}
.pw-choice{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
.pw-choice label{display:flex;gap:8px;align-items:center;border:1px solid var(--border,#2a3347);border-radius:8px;padding:8px 12px;cursor:pointer}
.pw-choice label.pw-on{border-color:var(--accent,#5fb4ff);background:rgba(95,180,255,.08)}
.pw-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}
@media (max-width:1100px){.pw-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pw-stat{background:var(--panel,#141925);border:1px solid var(--border,#2a3347);border-radius:12px;padding:12px 14px}
.pw-stat b{display:block;font-size:22px;line-height:1.2}.pw-stat span{color:var(--muted,#8f9bb3);font-size:12.5px}
.pw-table{width:100%;border-collapse:collapse}.pw-table th,.pw-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border,#2a3347);vertical-align:top}
.pw-table th{color:var(--muted,#8f9bb3);font-weight:600;font-size:12.5px}.pw-table tr.pw-sel td{background:rgba(95,180,255,.08)}
.pw-table td.pw-n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.pw-table th.pw-n{text-align:right}
.pw-chart{width:100%;max-width:700px;height:auto;display:block}.pw-chart text{fill:var(--muted,#8f9bb3);font-size:11.5px}.pw-chart text.pw-val{fill:var(--text,#e6e9ef);font-size:12.5px}
.pw-legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;margin-top:6px}.pw-legend i{display:inline-block;width:12px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.pw-note{border-left:3px solid var(--border,#2a3347);padding-left:10px;margin:8px 0 0}
.pw-busy{padding:40px;text-align:center;color:var(--muted,#8f9bb3)}
.pw-root details summary{cursor:pointer;color:var(--accent,#5fb4ff);margin:4px 0 8px}
.pw-root a{color:var(--accent,#5fb4ff)}
`;
  document.head.append(st);
}

const LOAD_PICKS = [[2, 'Robotic lander'], [10, 'Science station'], [40, 'Crewed outpost'], [100, 'Base with ISRU']];
const EFF_PICKS = [[20, 'Silicon'], [30, 'Triple-junction'], [35, 'Advanced multi-junction']];
const STORE_PICKS = [[200, 'Lithium-ion pack'], [500, 'Regenerative fuel cell']];

// renderPower(container, {site:{lat,lon,label,areaKm2}, initial, onChange(summary), onBack(), onNext()})
export async function renderPower(container, { site, initial, onChange, onBack, onNext } = {}) {
  injectStyle();
  const lat = Math.max(-90, Math.min(90, Number(site?.lat) || 0)), lon = Number(site?.lon) || 0;
  const label = site?.label || `Site ${fmtLatLon(lat, lon)}`;
  const inp = { ...DEFAULT_INPUTS, ...(initial?.inputs || {}) };
  let choice = initial?.choice || null;            // null → follow the recommendation
  const token = (container.__pwToken = (container.__pwToken || 0) + 1);
  const field = (key, text, attrs, picks, hint) => `<label class="pw-field"><span>${esc(text)}</span>
      <input type="number" data-k="${key}" value="${inp[key]}" ${attrs}>${picks ? `<div class="pw-chips">${picks.map(([v, n]) => `<button type="button" class="pw-chip" data-k="${key}" data-v="${v}">${esc(n)} · ${v}</button>`).join('')}</div>` : ''}
      ${hint ? `<div class="pw-muted pw-small">${esc(hint)}</div>` : ''}</label>`;
  container.innerHTML = `<div class="pw-root">
    <div class="pw-head">
      <button type="button" class="pw-btn pw-back">← Back</button>
      <div class="pw-site"><h2>Surface power</h2><div class="pw-muted">${esc(label)} · ${esc(fmtLatLon(lat, lon))}</div></div>
      <button type="button" class="pw-btn pw-primary pw-next">Next: Mission →</button>
    </div>
    <div class="pw-grid">
      <div>
        <div class="pw-card"><h3>Solar array</h3>
          ${field('effPct', 'Solar cell efficiency (%)', 'min="1" max="60" step="1"', EFF_PICKS)}
          <label class="pw-field"><span>Array type</span><select data-k="arrayType">${ARRAY_TYPES.map(t => `<option value="${t.id}"${t.id === inp.arrayType ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
          <div class="pw-two">${field('areaM2', 'Panel area per mast (m²)', 'min="1" max="2000" step="1"')}${field('mastM', 'Mast height (m)', 'min="0" max="50" step="1"')}</div>
        </div>
        <div class="pw-card"><h3>Demand and storage</h3>
          ${field('loadKw', 'Continuous electrical load (kW)', 'min="0.1" max="5000" step="1"', LOAD_PICKS)}
          ${field('storeWhKg', 'Storage specific energy (Wh/kg)', 'min="20" max="2000" step="10"', STORE_PICKS, 'Illustrative pack-level values, not a specific product.')}
          <details><summary>More assumptions</summary>
            <div class="pw-two">${field('fillPct', 'Active cell share of panel (%)', 'min="10" max="100" step="1"')}${field('lossPct', 'System losses (%)', 'min="0" max="80" step="1"')}</div>
            <div class="pw-two">${field('specPowerWkg', 'Array specific power (W/kg)', 'min="5" max="500" step="5"')}${field('dodPct', 'Usable depth of discharge (%)', 'min="10" max="100" step="5"')}</div>
            ${field('rtPct', 'Storage round-trip efficiency (%)', 'min="20" max="100" step="5"')}
          </details>
        </div>
      </div>
      <div class="pw-out"><div class="pw-busy">Reading the elevation grid and tracing the Sun for a year…</div></div>
    </div>
  </div>`;
  const root = container.firstElementChild, $ = s => root.querySelector(s), out = $('.pw-out');
  $('.pw-back').addEventListener('click', () => onBack?.());
  $('.pw-next').addEventListener('click', () => onNext?.());

  let elev = null, il = null, ilMast = NaN, demNote = '';
  try { elev = await loadLayer('elev', { hires: true }); }
  catch (e) { try { elev = await loadLayer('elev'); } catch (e2) { elev = null; demNote = String(e2?.message || e2); } }
  if (container.__pwToken !== token) return;
  if (!elev) { out.innerHTML = `<div class="pw-card">The elevation layer could not be loaded (${esc(demNote)}), so illumination cannot be estimated.</div>`; return; }

  function summary(z) {
    const useChoice = choice || z.recommended;
    return {
      inputs: { ...inp }, site: { lat, lon, label },
      illumination: { fracLit: il.fracLit, longestDarkH: il.longestDarkH, longestLitH: il.longestLitH, demPixelKm: il.pixelKm, siteElevM: il.siteElevM },
      perMast: { peakW: z.peakW, meanW: z.arrayType.meanW, capacityFactor: z.arrayType.cf, arrayTypeName: z.arrayType.name },
      arrayTypes: z.types.map(t => ({ name: t.name, capacityFactor: t.cf, meanW: t.meanW })),
      solar: { masts: z.units, arrayPeakW: z.units * z.peakW, storageWh: z.storageWh, arrayMassKg: z.arrayMassKg, storageMassKg: z.storageMassKg, totalMassKg: z.solarMassKg },
      fission: { ...z.fission }, recommended: z.recommended, reason: z.reason, choice: useChoice, userOverride: !!choice && choice !== z.recommended,
      systemMassKg: useChoice === 'solar' ? z.solarMassKg : z.fission.massKg,
      systemText: useChoice === 'solar'
        ? `${Number.isFinite(z.units) ? z.units : 'no workable number of'} solar mast(s) with ${fmtEnergy(z.storageWh)} of storage`
        : `${z.fission.units} fission unit(s) of ${REFERENCE.fsp.kWe} kWe`,
      references: REFERENCE,
    };
  }

  function draw() {
    if (ilMast !== inp.mastM) { il = illumination(elev, lat, lon, inp.mastM); ilMast = inp.mastM; }
    const z = sizePower(inp, il), s = summary(z), use = s.choice;
    for (const c of root.querySelectorAll('.pw-chip')) c.classList.toggle('pw-on', Number(c.dataset.v) === inp[c.dataset.k]);
    const polar = Math.abs(lat) > 80;
    out.innerHTML = `
      <div class="pw-verdict"><b>${z.recommended === 'solar' ? 'Solar with storage is enough here' : 'A reactor is the lighter option here'}</b>
        <p>${esc(z.reason)}</p>
        <div class="pw-choice" role="radiogroup" aria-label="Power system to carry into the mission step">
          <label class="${use === 'solar' ? 'pw-on' : ''}"><input type="radio" name="pw-choice" value="solar"${use === 'solar' ? ' checked' : ''}${Number.isFinite(z.solarMassKg) ? '' : ' disabled'}> Solar + storage · ${fmtMass(z.solarMassKg)}</label>
          <label class="${use === 'fission' ? 'pw-on' : ''}"><input type="radio" name="pw-choice" value="fission"${use === 'fission' ? ' checked' : ''}> Fission · at most ${fmtMass(z.fission.massKg)}</label>
        </div>
        <p class="pw-muted pw-small">The chosen system’s mass can be added to the landed mass in the mission step.</p>
      </div>
      <div class="pw-stats">
        <div class="pw-stat"><b>${(il.fracLit * 100).toFixed(il.fracLit < 0.1 ? 1 : 0)}%</b><span>of the year in sunlight</span></div>
        <div class="pw-stat"><b>${esc(fmtDark(il.longestDarkH))}</b><span>longest darkness</span></div>
        <div class="pw-stat"><b>${fmtPower(z.peakW)}</b><span>per mast, facing the Sun</span></div>
        <div class="pw-stat"><b>${Number.isFinite(z.units) ? z.units : '—'}</b><span>masts for a ${num(inp.loadKw, inp.loadKw < 10 ? 1 : 0)} kW load</span></div>
      </div>
      <div class="pw-card"><h3>Output by array type, one mast of ${num(inp.areaM2)} m² at ${num(inp.effPct)}% efficiency</h3>
        <table class="pw-table"><thead><tr><th>Array type</th><th class="pw-n">Year-average output</th><th class="pw-n">Share of full output</th></tr></thead><tbody>
        ${z.types.map(t => `<tr class="${t.id === inp.arrayType ? 'pw-sel' : ''}"><td>${esc(t.name)}<div class="pw-muted pw-small">${esc(t.note)}</div></td><td class="pw-n">${fmtPower(t.meanW)}</td><td class="pw-n">${(t.cf * 100).toFixed(0)}%</td></tr>`).join('')}
        </tbody></table>
        <p class="pw-muted pw-small pw-note">Full output = ${num(SOLAR_CONST_W_M2)} W/m² × ${num(inp.effPct)}% × ${num(inp.areaM2)} m² × ${num(inp.fillPct)}% active area × ${num(100 - inp.lossPct)}% after losses = ${fmtPower(z.peakW)}. Year-average output includes darkness and the Sun’s angle to the panel.</p>
      </div>
      <div class="pw-card"><h3>Mass to land for a ${num(inp.loadKw, inp.loadKw < 10 ? 1 : 0)} kW continuous load</h3>
        ${massChart(z)}
        <p class="pw-muted pw-small pw-note">Solar: ${Number.isFinite(z.units) ? z.units : '—'} mast(s) at ${num(inp.specPowerWkg)} W/kg, plus ${fmtEnergy(z.storageWh)} of storage at ${num(inp.storeWhKg)} Wh/kg to carry the load through the longest darkness (${num(inp.dodPct)}% usable). Fission: ${esc(REFERENCE.fsp.text)}</p>
      </div>
      <div class="pw-card"><h3>Horizon around the site</h3>${horizonChart(il)}</div>
      <div class="pw-card"><h3>Share of time in sunlight through the year</h3>${monthChart(il)}
        <p class="pw-muted pw-small">Twelve equal parts of the ${DRACONIC_YEAR_D}-day cycle of the Sun’s latitude; ${polar ? 'near the poles this is the summer and winter pattern' : 'away from the poles every part is close to half'}.</p>
      </div>
      <div class="pw-card pw-small"><h3>How this was estimated</h3>
        <ul>
          <li>Illumination: the Sun’s centre is traced hour by hour for one ${DRACONIC_YEAR_D}-day cycle (lunar day ${SYNODIC_D} Earth days, Sun latitude within ±${SUN_LAT_MAX_DEG}°) against a terrain horizon read from the LRO LOLA grid in ${N_AZ} directions out to 250 km, from ${num(inp.mastM)} m above the ground.</li>
          <li>The elevation grid here is about ${il.pixelKm.toFixed(1)} km per pixel. It cannot see small sunlit peaks or crater rims, so ${polar ? 'polar results are indicative only: real site work uses 5–20 m polar elevation models' : 'local shadows from nearby hills are missed'}.</li>
          <li>Storage is sized to carry the full load through the single longest dark period. Thermal control, landing mass of structures and cabling, and dust build-up are not modelled.</li>
          <li>Reference systems: <a href="${esc(REFERENCE.vsat.source)}" target="_blank" rel="noopener noreferrer">${esc(REFERENCE.vsat.name)}</a> — ${esc(REFERENCE.vsat.text)} <a href="${esc(REFERENCE.fsp.source)}" target="_blank" rel="noopener noreferrer">${esc(REFERENCE.fsp.name)}</a>.</li>
          <li>These are first-order numbers for comparing options, not a power system design.</li>
        </ul>
      </div>`;
    for (const r of out.querySelectorAll('input[name="pw-choice"]')) r.addEventListener('change', () => { choice = r.value; draw(); });
    onChange?.(s);
  }

  root.addEventListener('input', ev => {
    const t = ev.target, k = t.dataset?.k; if (!k) return;
    if (t.tagName === 'SELECT') { inp[k] = t.value; draw(); return; }
    const v = Number(t.value), ok = t.value.trim() !== '' && Number.isFinite(v) && v >= Number(t.min) && v <= Number(t.max);
    t.classList.toggle('pw-bad', !ok);
    if (ok) { inp[k] = v; draw(); }
  });
  root.addEventListener('click', ev => {
    const c = ev.target.closest('.pw-chip'); if (!c) return;
    const k = c.dataset.k; inp[k] = Number(c.dataset.v);
    const box = root.querySelector(`input[data-k="${k}"]`); box.value = inp[k]; box.classList.remove('pw-bad');
    draw();
  });
  draw();
}

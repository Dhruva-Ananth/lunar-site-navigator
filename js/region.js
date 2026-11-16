// "Zoomed-in" analysis of a lat/lon box using the finest data the site has.
// 2D canvases only. Simple equirectangular view of the box (stated in the UI).
import { loadManifest, loadLayer, sample, colormap, MOON_RADIUS_KM } from './data.js';
import { earthVisibility, earthDirection, LIB_LON_DEG, LIB_LAT_DEG } from './comms.js';

const DEG = Math.PI / 180;
const R_KM = MOON_RADIUS_KM || 1737.4;
const KM_PER_DEG = R_KM * DEG;

function injectStyle() {
  if (document.getElementById('rg-style')) return;
  const s = document.createElement('style');
  s.id = 'rg-style';
  s.textContent = `
.rg-root{color:var(--text,#e6e9ef);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.rg-root h3{margin:0 0 6px;font-size:16px}.rg-root h4{margin:0 0 6px;font-size:14px;color:var(--accent,#6cb4ff)}
.rg-card{background:var(--panel,#161b24);border:1px solid var(--border,#2a3242);border-radius:8px;padding:12px;margin:0 0 12px}
.rg-muted{color:var(--muted,#93a0b5);font-size:12.5px}
.rg-warn{padding:6px 9px;border-radius:6px;border-left:4px solid #e0a83a;background:var(--bg,#0d1117);margin:6px 0;font-size:12.5px}
.rg-row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.rg-fig{flex:0 1 auto;max-width:100%}
.rg-fig canvas{display:block;max-width:100%;height:auto;border:1px solid var(--border,#2a3242);border-radius:4px;background:#05070a}
.rg-axis{display:flex;justify-content:space-between;font-size:11px;color:var(--muted,#93a0b5);font-variant-numeric:tabular-nums}
.rg-bar{margin-top:6px}.rg-bar canvas{width:100%;height:10px;border-radius:2px}
.rg-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:8px 0;flex:1 1 240px}
.rg-kv div{background:var(--bg,#0d1117);border:1px solid var(--border,#2a3242);border-radius:6px;padding:6px 8px}
.rg-kv b{display:block;font-size:16px;font-variant-numeric:tabular-nums}.rg-kv span{color:var(--muted,#93a0b5);font-size:12px}
.rg-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.rg-tile{background:var(--bg,#0d1117);border:1px solid var(--border,#2a3242);border-radius:6px;padding:8px}
.rg-tile h5{margin:0 0 4px;font-size:13px}
.rg-root a{color:var(--accent,#6cb4ff)}
.rg-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.rg-root code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}`;
  document.head.appendChild(s);
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const wrapLon = l => ((l + 180) % 360 + 360) % 360 - 180;
const fLat = v => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
const fLon = v => { let l = wrapLon(v); if (l === -180) l = 180; return `${Math.abs(l).toFixed(2)}°${l < 0 ? 'W' : 'E'}`; };
function num(v, units = '') {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const s = a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toPrecision(2);
  return units ? `${s} ${units}` : s;
}
const km = v => !Number.isFinite(v) ? '–' : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3);

function normBox(b) {
  let latMin = Math.max(-90, Math.min(90, Number(b.latMin))), latMax = Math.max(-90, Math.min(90, Number(b.latMax)));
  if (!Number.isFinite(latMin)) latMin = -5;
  if (!Number.isFinite(latMax)) latMax = 5;
  if (latMin > latMax) [latMin, latMax] = [latMax, latMin];
  if (latMax - latMin < 0.02) { const c = Math.max(-89.99, Math.min(89.99, (latMin + latMax) / 2)); latMin = c - 0.01; latMax = c + 0.01; }
  let lo = Number(b.lonMin), hi = Number(b.lonMax);
  if (!Number.isFinite(lo)) lo = -5;
  if (!Number.isFinite(hi)) hi = 5;
  let span = hi - lo >= 360 ? 360 : ((hi - lo) % 360 + 360) % 360;   // lonMax < lonMin means "crosses ±180°"
  let lonMin = wrapLon(lo);
  if (span < 0.02) { lonMin = wrapLon(lonMin - 0.01); span = 0.02; }
  const latMid = (latMin + latMax) / 2;
  return {
    latMin, latMax, lonMin, lonSpan: span, latSpan: latMax - latMin, latMid, lonMid: wrapLon(lonMin + span / 2),
    crosses: lonMin + span > 180 && span < 360,
  };
}

// Sample a layer on an nx × ny grid of cell centres over the box (row 0 = north).
function sampleGrid(layer, b, nx, ny) {
  const g = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = b.latMax - (j + 0.5) / ny * b.latSpan;
    for (let i = 0; i < nx; i++) g[j * nx + i] = sample(layer, lat, b.lonMin + (i + 0.5) / nx * b.lonSpan);
  }
  return g;
}

// min / max / area-weighted mean (weights cos(lat)) of a grid
function gridStats(g, nx, ny, b) {
  let mn = Infinity, mx = -Infinity, sum = 0, wsum = 0, n = 0;
  for (let j = 0; j < ny; j++) {
    const w = Math.max(1e-6, Math.cos((b.latMax - (j + 0.5) / ny * b.latSpan) * DEG));
    for (let i = 0; i < nx; i++) {
      const v = g[j * nx + i];
      if (Number.isNaN(v)) continue;
      if (v < mn) mn = v; if (v > mx) mx = v;
      sum += v * w; wsum += w; n++;
    }
  }
  return n ? { min: mn, max: mx, mean: sum / wsum, n, frac: n / (nx * ny) } : { min: NaN, max: NaN, mean: NaN, n: 0, frac: 0 };
}

// Grid spacing for statistics: native pixel spacing of the layer, capped for speed.
function nativeGrid(layer, b, cap = 500) {
  const degX = 360 / layer.width, degY = 180 / layer.height;
  const pxX = b.lonSpan / degX, pxY = b.latSpan / degY;
  return {
    nx: Math.max(3, Math.min(cap, Math.round(pxX))), ny: Math.max(3, Math.min(cap, Math.round(pxY))),
    pxX, pxY, coarse: pxX < 3 || pxY < 3,
    nativeKmLat: degY * KM_PER_DEG, nativeKmLonEq: degX * KM_PER_DEG,
  };
}

function gridToCanvas(g, nx, ny, lo, hi, cmap, shade) {
  const c = document.createElement('canvas');
  c.width = nx; c.height = ny;
  const ctx = c.getContext('2d'), im = ctx.createImageData(nx, ny), d = im.data, span = hi - lo || 1;
  for (let k = 0, p = 0; k < g.length; k++, p += 4) {
    const v = g[k];
    if (Number.isNaN(v)) { d[p] = 20; d[p + 1] = 22; d[p + 2] = 28; d[p + 3] = 255; continue; }
    const rgb = colormap((v - lo) / span, cmap), s = shade ? shade[k] : 1;
    d[p] = Math.min(255, rgb[0] * s); d[p + 1] = Math.min(255, rgb[1] * s); d[p + 2] = Math.min(255, rgb[2] * s); d[p + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

function upscale(src, W, H, smooth = true) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(src, 0, 0, W, H);
  return c;
}

function colourBar(lo, hi, cmap, units) {
  const wrap = document.createElement('div');
  wrap.className = 'rg-bar';
  const c = document.createElement('canvas');
  c.width = 200; c.height = 1;
  const ctx = c.getContext('2d'), im = ctx.createImageData(200, 1);
  for (let i = 0; i < 200; i++) { const rgb = colormap(i / 199, cmap); im.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4); }
  ctx.putImageData(im, 0, 0);
  wrap.appendChild(c);
  const ax = document.createElement('div');
  ax.className = 'rg-axis';
  ax.innerHTML = `<span>${num(lo)}</span><span>${esc(units || '')}</span><span>${num(hi)}</span>`;
  wrap.appendChild(ax);
  return wrap;
}

// Figure = canvas + lon axis labels (+ optional colour bar)
function figure(canvas, b, bar) {
  const f = document.createElement('div');
  f.className = 'rg-fig';
  f.style.width = canvas.width + 'px';
  f.appendChild(canvas);
  const ax = document.createElement('div');
  ax.className = 'rg-axis';
  ax.innerHTML = `<span>${fLon(b.lonMin)}</span><span>${fLat(b.latMin)} … ${fLat(b.latMax)}</span><span>${fLon(b.lonMin + b.lonSpan)}</span>`;
  f.appendChild(ax);
  if (bar) f.appendChild(bar);
  return f;
}

function displaySize(b, W) {
  const aspect = Math.max(0.5, Math.min(2.2, (b.lonSpan * Math.max(0.05, Math.cos(b.latMid * DEG))) / b.latSpan));
  return { W, H: Math.max(40, Math.round(W / aspect)) };
}

// Slope (deg) by finite differences on a grid of cell centres, true metres per cell.
function slopeGrid(z, nx, ny, b) {
  const out = new Float32Array(nx * ny).fill(NaN);
  const dym = b.latSpan / ny * KM_PER_DEG * 1000;
  for (let j = 0; j < ny; j++) {
    const lat = b.latMax - (j + 0.5) / ny * b.latSpan;
    const dxm = b.lonSpan / nx * KM_PER_DEG * 1000 * Math.max(0.01, Math.cos(lat * DEG));
    const j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1);
      const a = z[j * nx + i0], c = z[j * nx + i1], n = z[j0 * nx + i], s = z[j1 * nx + i];
      if (Number.isNaN(a + c + n + s) || i1 === i0 || j1 === j0) continue;
      const gx = (c - a) / ((i1 - i0) * dxm), gy = (n - s) / ((j1 - j0) * dym);
      out[j * nx + i] = Math.atan(Math.hypot(gx, gy)) / DEG;
    }
  }
  return out;
}

// Hillshade factor (0.45..1.25) for display; light from the upper left; vertical exaggeration chosen for contrast.
function hillshade(z, nx, ny, b) {
  const sh = new Float32Array(nx * ny).fill(1);
  const dym = b.latSpan / ny * KM_PER_DEG * 1000;
  const gxs = new Float32Array(nx * ny), gys = new Float32Array(nx * ny);
  const mags = [];
  for (let j = 0; j < ny; j++) {
    const lat = b.latMax - (j + 0.5) / ny * b.latSpan;
    const dxm = b.lonSpan / nx * KM_PER_DEG * 1000 * Math.max(0.01, Math.cos(lat * DEG));
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
      const gx = (z[j * nx + i1] - z[j * nx + i0]) / (Math.max(1, i1 - i0) * dxm);
      const gy = (z[j0 * nx + i] - z[j1 * nx + i]) / (Math.max(1, j1 - j0) * dym);   // d/d(north)
      const k = j * nx + i;
      gxs[k] = Number.isNaN(gx) ? 0 : gx; gys[k] = Number.isNaN(gy) ? 0 : gy;
      if ((i + j * 7) % 11 === 0) mags.push(Math.hypot(gxs[k], gys[k]));
    }
  }
  mags.sort((p, q) => p - q);
  const p90 = mags[Math.floor(mags.length * 0.9)] || 0;
  const ex = p90 > 0 ? 0.8 / p90 : 1;                       // exaggerate so the 90th-percentile gradient reads ~40°
  const lx = -0.5, ly = 0.5, lz = 0.707;                    // light vector (east, north, up): from the north-west
  for (let k = 0; k < sh.length; k++) {
    const gx = gxs[k] * ex, gy = gys[k] * ex;
    const dot = (-gx * lx - gy * ly + lz) / Math.sqrt(gx * gx + gy * gy + 1);
    sh[k] = 0.45 + 0.8 * Math.max(0, dot);
  }
  return { shade: sh, exaggeration: ex };
}

function histogramCanvas(slopes, W = 300, H = 120) {
  const bins = new Array(20).fill(0);
  let n = 0;
  for (const v of slopes) if (!Number.isNaN(v)) { bins[Math.min(19, Math.floor(v / 2))]++; n++; }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const muted = cs.getPropertyValue('--muted').trim() || '#93a0b5', accent = cs.getPropertyValue('--accent').trim() || '#6cb4ff';
  ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, W, H);
  const mx = Math.max(1, ...bins), x0 = 6, y0 = H - 16, bw = (W - 12) / 20;
  ctx.fillStyle = accent;
  bins.forEach((v, i) => { const h = (v / mx) * (y0 - 6); ctx.fillRect(x0 + i * bw + 1, y0 - h, bw - 2, h); });
  ctx.fillStyle = muted; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'center';
  for (const t of [0, 10, 20, 30, 40]) ctx.fillText(t === 40 ? '≥40°' : t + '°', Math.min(W - 14, x0 + (t / 2) * bw), H - 4);
  return { canvas: c, n };
}

// Destination point along a great circle
function destPoint(lat, lon, azDeg, angRad) {
  const p = lat * DEG, a = azDeg * DEG;
  const sp = Math.sin(p) * Math.cos(angRad) + Math.cos(p) * Math.sin(angRad) * Math.cos(a);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sp)));
  const l2 = lon * DEG + Math.atan2(Math.sin(a) * Math.sin(angRad) * Math.cos(p), Math.cos(angRad) - Math.sin(p) * sp);
  return [p2 / DEG, l2 / DEG];
}

// Max terrain elevation angle (deg) seen from (lat, lon) along azimuth az, out to maxKm. Spherical datum + DEM heights.
function terrainHorizon(elev, lat, lon, az, stepKm, maxKm, mastM = 2) {
  const h0 = sample(elev, lat, lon);
  if (Number.isNaN(h0)) return NaN;
  const r0 = R_KM + (h0 + mastM) / 1000;
  let best = -90;
  for (let d = stepKm; d <= maxKm; d += stepKm) {
    const g = d / R_KM, [la, lo] = destPoint(lat, lon, az, g);
    const h = sample(elev, la, lo);
    if (Number.isNaN(h)) continue;
    const r = R_KM + h / 1000;
    const ang = Math.atan2(r * Math.cos(g) - r0, r * Math.sin(g)) / DEG;
    if (ang > best) best = ang;
  }
  return best;
}

export async function renderRegion(container, box, { manifest, weights } = {}) {
  injectStyle();
  const token = {};
  container.__rgToken = token;
  const alive = () => container.__rgToken === token;
  container.innerHTML = '<div class="rg-root"><div class="rg-card rg-muted">Loading region data…</div></div>';
  const root = container.firstElementChild;
  try {
    manifest = manifest || await loadManifest();
    const b = normBox(box || {});
    const layers = manifest.layers || [];
    const loaded = new Map();
    await Promise.all(layers.map(async m => {
      try { loaded.set(m.id, await loadLayer(m.id, { hires: true })); } catch (e) { loaded.set(m.id, { error: e.message || String(e) }); }
    }));
    if (!alive()) return null;
    root.innerHTML = '';
    const card = (title) => {
      const c = document.createElement('div');
      c.className = 'rg-card';
      if (title) c.innerHTML = `<h3>${title}</h3>`;
      root.appendChild(c);
      return c;
    };
    const add = (parent, html, cls = 'rg-muted') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; parent.appendChild(d); return d; };

    // ---- header -----------------------------------------------------------------------------
    const nsKm = b.latSpan * KM_PER_DEG, ewKm = b.lonSpan * KM_PER_DEG * Math.cos(b.latMid * DEG);
    const head = card(`Region ${fLat(b.latMin)} … ${fLat(b.latMax)}, ${fLon(b.lonMin)} … ${fLon(b.lonMin + b.lonSpan)}`);
    add(head, `Approximate size: ${km(nsKm)} km north–south × ${km(ewKm)} km east–west at the mid-latitude (Moon radius ${R_KM} km). Centre ${fLat(b.latMid)}, ${fLon(b.lonMid)}.${b.crosses ? ' The box crosses the ±180° meridian.' : ''}`);
    add(head, 'Maps are drawn in a simple equirectangular (latitude–longitude) view of the box, north up; statistics use true ground distances and cos(latitude) area weights.');
    if (manifest.demo) add(head, 'The loaded data set is flagged as SYNTHETIC demo data — every number below describes placeholder terrain and composition, not the Moon.', 'rg-warn');
    if (Math.max(Math.abs(b.latMin), Math.abs(b.latMax)) > 80) add(head, 'This box reaches within 10° of a pole. The equirectangular view stretches east–west distances strongly there (all longitudes converge at the pole), and equirectangular source grids oversample the pole in longitude — a polar-stereographic product is the right tool for detailed polar work.', 'rg-warn');
    const links = add(head, `<a href="https://trek.nasa.gov/moon/" target="_blank" rel="noopener">Open NASA Moon Trek</a><a href="https://quickmap.lroc.asu.edu/" target="_blank" rel="noopener">Open LROC QuickMap</a><span>Then navigate to lat ${b.latMid.toFixed(3)}, lon ${b.lonMid.toFixed(3)} (east-positive) — these links open the tools' home pages, not this region.</span>`, 'rg-links rg-muted');
    void links;

    // ---- elevation & slope --------------------------------------------------------------------
    const elev = loaded.get('elev');
    let summary = { box: b, best: null, terrainMaskDeg: null };
    if (elev && !elev.error) {
      const ec = card('Terrain — elevation and slope');
      const ng = nativeGrid(elev, b, 600);
      const usedKmLat = b.latSpan / ng.ny * KM_PER_DEG, usedKmLon = b.lonSpan / ng.nx * KM_PER_DEG * Math.cos(b.latMid * DEG);
      const z = sampleGrid(elev, b, ng.nx, ng.ny);
      const st = gridStats(z, ng.nx, ng.ny, b);
      const slopes = slopeGrid(z, ng.nx, ng.ny, b);
      let nS = 0, b5 = 0, b10 = 0, b15 = 0, sMax = 0, sSum = 0;
      for (const v of slopes) if (!Number.isNaN(v)) { nS++; sSum += v; if (v < 5) b5++; if (v < 10) b10++; if (v < 15) b15++; if (v > sMax) sMax = v; }
      const hiUsed = elev.width !== elev.meta.width;
      add(ec, `Source: ${esc(elev.meta.mission || 'unknown mission')}${elev.meta.agency ? ' (' + esc(elev.meta.agency) + ')' : ''}${elev.meta.source ? ` — <a href="${esc(elev.meta.source)}" target="_blank" rel="noopener">source</a>` : ''}. ` +
        `Grid used: ${elev.width} × ${elev.height} px global (${hiUsed ? 'high-resolution file' : 'standard file'}), native ≈ ${km(ng.nativeKmLat)} km/px in latitude, ≈ ${km(ng.nativeKmLonEq * Math.cos(b.latMid * DEG))} km/px east–west at this latitude. ` +
        `Analysis grid: ${ng.nx} × ${ng.ny} cells, ≈ ${km(usedKmLon)} × ${km(usedKmLat)} km per cell${(ng.pxX > 600 || ng.pxY > 600) ? ' (subsampled from native for speed)' : ''}.`);
      if (ng.coarse) add(ec, `The box spans only ≈ ${ng.pxX.toFixed(1)} × ${ng.pxY.toFixed(1)} native elevation pixels — the map below is interpolation between a handful of samples, and the slope figures carry no real information at this scale.`, 'rg-warn');

      const row = document.createElement('div'); row.className = 'rg-row'; ec.appendChild(row);
      const ds = displaySize(b, 460);
      const zd = sampleGrid(elev, b, ds.W, ds.H);
      const hs = hillshade(zd, ds.W, ds.H, b);
      const lo = st.min, hi = st.max > st.min ? st.max : st.min + 1;
      const f1 = figure(gridToCanvas(zd, ds.W, ds.H, lo, hi, 'terrain', hs.shade), b, colourBar(lo, hi, 'terrain', `elevation, ${elev.meta.units || 'm'}`));
      row.appendChild(f1);
      const sHi = Math.max(5, Math.min(40, Math.ceil(sMax)));
      const f2 = figure(upscale(gridToCanvas(slopes, ng.nx, ng.ny, 0, sHi, 'magma'), ds.W > 300 ? 300 : ds.W, Math.round((ds.W > 300 ? 300 : ds.W) * ds.H / ds.W), ng.nx > 40), b, colourBar(0, sHi, 'magma', 'slope, degrees'));
      row.appendChild(f2);

      const kv = document.createElement('div'); kv.className = 'rg-kv';
      const pct = v => nS ? (100 * v / nS).toFixed(1) + '%' : '–';
      kv.innerHTML = [
        [num(st.min, 'm'), 'minimum elevation'], [num(st.max, 'm'), 'maximum elevation'], [num(st.mean, 'm'), 'mean elevation (area-weighted)'],
        [num(st.max - st.min, 'm'), 'relief'], [nS ? (sSum / nS).toFixed(2) + '°' : '–', 'mean slope'], [nS ? sMax.toFixed(1) + '°' : '–', 'maximum slope'],
        [pct(b5), 'of cells below 5°'], [pct(b10), 'of cells below 10°'], [pct(b15), 'of cells below 15°'],
      ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
      row.appendChild(kv);
      const hg = histogramCanvas(slopes);
      const hf = document.createElement('div'); hf.className = 'rg-fig'; hf.style.width = hg.canvas.width + 'px';
      hf.appendChild(hg.canvas); add(hf, `Slope histogram (2° bins, ${hg.n} cells)`);
      row.appendChild(hf);
      add(ec, `Slope = atan|∇z| from centred finite differences over a baseline of two cells (≈ ${km(2 * usedKmLon)} km east–west, ≈ ${km(2 * usedKmLat)} km north–south), with longitude spacing scaled by cos(latitude). Slopes measured over kilometre baselines are much gentler than the metre-scale slopes a lander's footpads see; treat these as regional tilt, not a landing-hazard assessment. Elevation is relative to the data set's reference sphere. Hillshading is exaggerated ×${hs.exaggeration >= 10 ? hs.exaggeration.toFixed(0) : hs.exaggeration.toFixed(1)} for display (light from the north-west) and is not a lighting simulation.`);
      if (st.frac < 0.999) add(ec, `${((1 - st.frac) * 100).toFixed(1)}% of the cells have no elevation data.`);
    } else {
      add(card('Terrain — elevation and slope'), `No usable elevation layer (${esc(elev?.error || 'layer "elev" missing from the manifest')}).`, 'rg-warn');
    }
    if (!alive()) return null;

    // ---- other layers: small multiples -------------------------------------------------------
    const others = layers.filter(m => m.id !== 'elev');
    const tileSize = displaySize(b, 230);
    if (others.length) {
      const oc = card('Other data layers in this box');
      add(oc, 'Colour scales span the minimum–maximum found inside the box (so colours are not comparable between regions). Display uses bilinear interpolation; statistics are taken at each layer\'s native pixel spacing.');
      const tiles = document.createElement('div'); tiles.className = 'rg-tiles'; oc.appendChild(tiles);
      for (const m of others) {
        const L = loaded.get(m.id);
        const t = document.createElement('div'); t.className = 'rg-tile'; tiles.appendChild(t);
        t.innerHTML = `<h5>${esc(m.name || m.id)}${m.units ? ` <span class="rg-muted">(${esc(m.units)})</span>` : ''}</h5>`;
        if (!L || L.error) { add(t, `Could not load this layer: ${esc(L?.error || 'unknown error')}`, 'rg-warn'); continue; }
        const ng = nativeGrid(L, b, 300);
        const st = gridStats(sampleGrid(L, b, ng.nx, ng.ny), ng.nx, ng.ny, b);
        if (!st.n) { add(t, 'No data in this box.', 'rg-warn'); }
        else {
          const lo = st.min, hi = st.max > st.min ? st.max : st.min + (Math.abs(st.min) * 1e-3 || 1);
          const g = sampleGrid(L, b, tileSize.W, tileSize.H);
          t.appendChild(figure(gridToCanvas(g, tileSize.W, tileSize.H, lo, hi, 'viridis'), b, colourBar(lo, hi, 'viridis', m.units)));
          add(t, `min ${num(st.min)} · mean ${num(st.mean)} · max ${num(st.max)} ${esc(m.units || '')}${st.frac < 0.999 ? ` · ${(st.frac * 100).toFixed(0)}% of box has data` : ''}`);
        }
        const kmEw = ng.nativeKmLonEq * Math.cos(b.latMid * DEG);
        add(t, `${esc(m.mission || 'unknown mission')}${m.agency ? ', ' + esc(m.agency) : ''}${m.source ? ` — <a href="${esc(m.source)}" target="_blank" rel="noopener">source</a>` : ''}. Grid ${L.width} × ${L.height} px: ≈ ${km(ng.nativeKmLat)} km/px (N–S), ≈ ${km(kmEw)} km/px (E–W here); box = ${ng.pxX.toFixed(1)} × ${ng.pxY.toFixed(1)} px.`);
        if (ng.coarse) add(t, `Native resolution ≈ ${km(ng.nativeKmLat)} km/px — coarser than this box. The picture is interpolation between ${ng.pxX < 1.5 && ng.pxY < 1.5 ? 'one or two' : 'a few'} pixels; there is no sub-pixel detail here.`, 'rg-warn');
        else add(t, 'Pixel spacing is the grid of this file; the instrument\'s true spatial resolution (footprint) may be much coarser — see the layer source.');
      }
    }
    if (!alive()) return null;

    // ---- composite suitability ----------------------------------------------------------------
    const wEntries = weights ? Object.entries(weights).filter(([, w]) => w && Number(w.weight) > 0) : [];
    if (weights) {
      const sc = card('Composite suitability within this box');
      const usable = wEntries.filter(([id]) => loaded.get(id) && !loaded.get(id).error);
      const skipped = wEntries.filter(([id]) => !(loaded.get(id) && !loaded.get(id).error)).map(([id]) => id);
      if (!usable.length) add(sc, 'No criteria with a non-zero weight and loadable data — set weights in the criteria panel to see a composite map.');
      else {
        const cs = displaySize(b, 300);
        const nx = Math.min(150, cs.W), ny = Math.max(4, Math.round(nx * cs.H / cs.W));
        const acc = new Float32Array(nx * ny), wacc = new Float32Array(nx * ny);
        const wTot = usable.reduce((s, [, w]) => s + Number(w.weight), 0);
        const used = [];
        for (const [id, w] of usable) {
          const g = sampleGrid(loaded.get(id), b, nx, ny);
          let lo = Infinity, hi = -Infinity;
          for (const v of g) if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
          const flat = !(hi > lo);
          for (let k = 0; k < g.length; k++) {
            if (Number.isNaN(g[k])) continue;
            let t = flat ? 0.5 : (g[k] - lo) / (hi - lo);
            if (w.prefer === 'low') t = 1 - t;
            acc[k] += t * w.weight; wacc[k] += Number(w.weight);
          }
          const meta = loaded.get(id).meta;
          used.push(`${esc(meta.name || id)} (weight ${Number(w.weight).toFixed(2)}, prefer ${w.prefer === 'low' ? 'low' : 'high'}${flat ? ', constant in box' : ''})`);
        }
        const score = new Float32Array(nx * ny).fill(NaN);
        let bk = -1, bv = -Infinity;
        for (let k = 0; k < score.length; k++) if (wacc[k] >= 0.5 * wTot) { score[k] = acc[k] / wacc[k]; if (score[k] > bv) { bv = score[k]; bk = k; } }
        const cv = upscale(gridToCanvas(score, nx, ny, 0, 1, 'viridis'), cs.W, cs.H, true);
        const row = document.createElement('div'); row.className = 'rg-row'; sc.appendChild(row);
        let bestTxt = 'No cell has data for at least half of the total weight.';
        if (bk >= 0) {
          const bi = bk % nx, bj = Math.floor(bk / nx);
          const blat = b.latMax - (bj + 0.5) / ny * b.latSpan, blon = wrapLon(b.lonMin + (bi + 0.5) / nx * b.lonSpan);
          const ctx = cv.getContext('2d'), px = (bi + 0.5) / nx * cs.W, py = (bj + 0.5) / ny * cs.H;
          ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.arc(px, py, 7, 0, 7); ctx.stroke();
          ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 7, 0, 7); ctx.stroke();
          bestTxt = `Best cell (circled): <b>${fLat(blat)}, ${fLon(blon)}</b>, score ${bv.toFixed(2)} on a 0–1 scale.`;
          summary.best = { lat: blat, lon: blon, score: bv };
        }
        row.appendChild(figure(cv, b, colourBar(0, 1, 'viridis', 'relative suitability (0–1)')));
        const txt = document.createElement('div'); txt.style.flex = '1 1 240px'; row.appendChild(txt);
        add(txt, bestTxt, '');
        add(txt, `Criteria: ${used.join('; ')}.`);
        add(txt, 'Method: each layer is rescaled to 0–1 between its minimum and maximum <em>inside this box</em>, inverted where low values are preferred, and combined as a weighted mean (cells need data for at least half of the total weight). It ranks places within the box relative to each other; scores are not comparable with the global map or with other boxes, and a "best" cell in a uniformly poor region is still poor.');
        if (skipped.length) add(txt, `Not included (no matching data layer): ${skipped.map(esc).join(', ')}.`);
      }
    }

    // ---- Earth visibility & terrain horizon ---------------------------------------------------
    {
      const vc = card('Earth visibility across the box (direct-to-Earth communications)');
      const n = 24, fr = new Float32Array(n * n);
      let fmin = 1, fmax = 0, emin = Infinity, emax = -Infinity;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const la = b.latMax - (j + 0.5) / n * b.latSpan, lo = b.lonMin + (i + 0.5) / n * b.lonSpan;
        const v = earthVisibility(la, lo);
        fr[j * n + i] = v.fracVisible;
        fmin = Math.min(fmin, v.fracVisible); fmax = Math.max(fmax, v.fracVisible);
        emin = Math.min(emin, v.elevMeanDeg); emax = Math.max(emax, v.elevMeanDeg);
      }
      const c0 = earthVisibility(b.latMid, b.lonMid);
      const row = document.createElement('div'); row.className = 'rg-row'; vc.appendChild(row);
      const vs = displaySize(b, 230);
      row.appendChild(figure(upscale(gridToCanvas(fr, n, n, 0, 1, 'viridis'), vs.W, vs.H, true), b, colourBar(0, 1, 'viridis', 'fraction of time Earth above 0°')));
      const txt = document.createElement('div'); txt.style.flex = '1 1 260px'; row.appendChild(txt);
      const verdict = fmin >= 0.9995 ? 'Earth stays above the ideal horizon everywhere in the box: continuous direct-to-Earth geometry (terrain permitting).'
        : fmax <= 0.0005 ? 'Earth never rises above the ideal horizon anywhere in the box: no direct-to-Earth link — a relay is required.'
          : 'Earth visibility is libration-dependent (intermittent) in at least part of the box: direct-to-Earth links have multi-day outages there, so a relay is needed for continuous contact.';
      add(txt, `<b>${verdict}</b>`, '');
      const kv = document.createElement('div'); kv.className = 'rg-kv';
      kv.innerHTML = [
        [`${(fmin * 100).toFixed(0)}–${(fmax * 100).toFixed(0)}%`, 'time Earth is above 0° (range over box)'],
        [`${emin.toFixed(1)}° … ${emax.toFixed(1)}°`, 'mean Earth elevation (range over box)'],
        [`${c0.elevMinDeg.toFixed(1)}° … ${c0.elevMaxDeg.toFixed(1)}°`, 'Earth elevation swing at box centre'],
      ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
      txt.appendChild(kv);
      add(txt, `Model: Earth at the sub-Earth point (0°, 0°) displaced by optical libration (±${LIB_LON_DEG}° longitude, ±${LIB_LAT_DEG}° latitude, independent phases), spherical Moon, Earth's centre, no terrain. An approximation — see the Earth comms panel for the full assumption list and the link budget.`);

      // terrain horizon check at box centre
      if (elev && !elev.error) {
        const hc = document.createElement('div'); vc.appendChild(hc);
        hc.innerHTML = '<h4 style="margin-top:12px">Terrain horizon check at the box centre</h4>';
        const stepKm = Math.max(0.25, (180 / elev.height) * KM_PER_DEG), maxKm = 300;
        if (c0.elevMinDeg > 30) {
          add(hc, `Earth stays at least ${c0.elevMinDeg.toFixed(0)}° above the horizon at the centre, far above any plausible terrain obstruction — no horizon scan needed.`);
          summary.terrainMaskDeg = 0;
        } else if (c0.elevMaxDeg < -3) {
          add(hc, `Earth is always at least ${(-c0.elevMaxDeg).toFixed(0)}° below the ideal horizon at the centre; terrain cannot change that (only a site on a very high peak right at the limb gains a degree or two).`);
        } else {
          const subs = [[0, 0], [0, LIB_LON_DEG], [0, -LIB_LON_DEG], [LIB_LAT_DEG, 0], [-LIB_LAT_DEG, 0]];
          let worst = -90; const parts = [];
          for (const [sl, so] of subs) {
            const dir = earthDirection(b.latMid, b.lonMid, sl, so);
            const th = terrainHorizon(elev, b.latMid, b.lonMid, dir.azDeg, stepKm, maxKm);
            if (Number.isNaN(th)) continue;
            parts.push(`az ${dir.azDeg.toFixed(0)}°: terrain ${th.toFixed(2)}°, Earth ${dir.elevDeg.toFixed(1)}°`);
            if (th > worst) worst = th;
          }
          if (!parts.length) add(hc, 'No elevation data at the box centre — horizon check skipped.', 'rg-warn');
          else {
            const mask = Math.max(0, worst), vm = earthVisibility(b.latMid, b.lonMid, mask);
            summary.terrainMaskDeg = mask;
            add(hc, `Highest terrain elevation angle towards Earth's range of azimuths: <b>${worst.toFixed(2)}°</b> (sampled every ${km(stepKm)} km out to ${maxKm} km along five azimuths spanning the libration extremes; observer 2 m above the DEM surface; spherical datum with curvature). Using ${mask.toFixed(2)}° as a horizon mask, Earth's centre is visible about <b>${(vm.fracVisible * 100).toFixed(0)}%</b> of the time at the centre (versus ${(c0.fracVisible * 100).toFixed(0)}% with an ideal horizon).`, '');
            add(hc, parts.join(' · ') + ' (mean and four extreme sub-Earth positions).');
            add(hc, `Limited by DEM resolution: at ≈ ${km(stepKm)} km/px the grid smooths away the crater rims, massifs and boulders that set the real local horizon, and the observer's own height within its pixel is unknown. Near the poles a difference of a fraction of a degree decides visibility, so this is an indication only — use a horizon computed from a high-resolution polar DEM for any real assessment. You can enter this mask in the Earth comms panel's "local horizon mask" field.`, 'rg-warn');
          }
        }
      }
    }
    return summary;
  } catch (e) {
    if (alive()) root.innerHTML = `<div class="rg-card"><div class="rg-warn">Region analysis failed: ${esc(e && e.message ? e.message : e)}</div></div>`;
    console.error('renderRegion failed', e);
    return null;
  }
}

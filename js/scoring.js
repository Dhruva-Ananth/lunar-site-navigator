// Pure scoring / area functions for the Lunar Landing Site Navigator (no DOM, no three.js).
// Grid convention matches the data layers: row 0 = northernmost, col 0 = lon -180, cell centres.
// Cell index k = j * nLon + i.

export const MOON_RADIUS_KM = 1737.4;
const D2R = Math.PI / 180;

export function makeGrid(stepDeg = 1) {
  const nLon = Math.round(360 / stepDeg), nLat = Math.round(180 / stepDeg);
  return {
    step: stepDeg, nLon, nLat,
    lat: j => 90 - (j + 0.5) * stepDeg,
    lon: i => -180 + (i + 0.5) * stepDeg,
  };
}

// Exact area (km²) of one cell in each row: R² · Δλ · (sin φ_top − sin φ_bottom).
export function rowAreasKm2(grid, radiusKm = MOON_RADIUS_KM) {
  const out = new Float64Array(grid.nLat), dLon = grid.step * D2R;
  for (let j = 0; j < grid.nLat; j++) {
    const top = (90 - j * grid.step) * D2R, bot = (90 - (j + 1) * grid.step) * D2R;
    out[j] = radiusKm * radiusKm * dLon * (Math.sin(top) - Math.sin(bot));
  }
  return out;
}
export const sphereAreaKm2 = (radiusKm = MOON_RADIUS_KM) => 4 * Math.PI * radiusKm * radiusKm;

// Robust [lo, hi] value range from the pLo..pHi percentiles of the finite values (unweighted, for colour scales).
export function percentileRange(data, pLo = 2, pHi = 98, maxSamples = 60000) {
  const stride = Math.max(1, Math.floor(data.length / maxSamples));
  const vals = [];
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return [0, 1];
  vals.sort((a, b) => a - b);
  const q = p => vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))];
  let lo = q(pLo), hi = q(pHi);
  if (!(hi > lo)) { lo = vals[0]; hi = vals[vals.length - 1]; }
  if (!(hi > lo)) hi = lo + 1;
  return [lo, hi];
}

// Sample a layer onto the scoring grid by point sampling. sampleFn(layer, lat, lon) → value (NaN = no data).
export function resampleToGrid(layer, grid, sampleFn) {
  const out = new Float32Array(grid.nLon * grid.nLat);
  for (let j = 0; j < grid.nLat; j++) {
    const lat = grid.lat(j);
    for (let i = 0; i < grid.nLon; i++) out[j * grid.nLon + i] = sampleFn(layer, lat, grid.lon(i));
  }
  return out;
}

// Resample a layer {width, height, data} onto the grid. When the layer is an integer multiple finer than the
// grid, each cell is the mean of the source pixels inside it (NaN ignored; all-NaN → NaN). Otherwise falls back
// to point sampling with sampleFn. Block means avoid aliasing fine data (e.g. 0.25° elevation) onto a 1° grid.
export function blockResample(layer, grid, sampleFn) {
  const fx = layer.width / grid.nLon, fy = layer.height / grid.nLat;
  if (!(Number.isInteger(fx) && Number.isInteger(fy) && fx >= 1 && fy >= 1)) return resampleToGrid(layer, grid, sampleFn);
  const out = new Float32Array(grid.nLon * grid.nLat), w = layer.width, d = layer.data;
  for (let j = 0; j < grid.nLat; j++) for (let i = 0; i < grid.nLon; i++) {
    let s = 0, n = 0;
    for (let y = j * fy; y < (j + 1) * fy; y++) {
      const row = y * w;
      for (let x = i * fx; x < (i + 1) * fx; x++) { const v = d[row + x]; if (v === v) { s += v; n++; } }
    }
    out[j * grid.nLon + i] = n ? s / n : NaN;
  }
  return out;
}

// Area-weighted quantiles of a grid layer. q(p) (p in 0..1) → value below which a fraction p of the area with
// data lies; cdf(v) → fraction of the area with data whose value is ≤ v.
export function makeQuantiler(grid, values, rowArea = rowAreasKm2(grid)) {
  const idx = [];
  for (let k = 0; k < values.length; k++) if (Number.isFinite(values[k])) idx.push(k);
  idx.sort((a, b) => values[a] - values[b]);
  const n = idx.length, vals = new Float64Array(n), cum = new Float64Array(n);
  let t = 0;
  for (let r = 0; r < n; r++) { const k = idx[r]; vals[r] = values[k]; t += rowArea[Math.floor(k / grid.nLon)]; cum[r] = t; }
  const total = t;
  return {
    n, min: n ? vals[0] : NaN, max: n ? vals[n - 1] : NaN,
    q(p) {
      if (!n) return NaN;
      const target = Math.min(1, Math.max(0, p)) * total;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < target) lo = m + 1; else hi = m; }
      return vals[lo];
    },
    // fraction of the area with data whose value lies in [min, max] (null = open end)
    fracBetween(min, max) {
      if (!n) return NaN;
      let lo = 0, hi = n;
      if (min != null) { while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < min) lo = m + 1; else hi = m; } }
      const first = min != null ? lo : 0;          // first index with vals >= min
      lo = 0; hi = n;
      if (max != null) { while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] <= max) lo = m + 1; else hi = m; } }
      const end = max != null ? lo : n;            // one past the last index with vals <= max
      if (end <= first) return 0;
      return (cum[end - 1] - (first ? cum[first - 1] : 0)) / total;
    },
    cdf(v) {
      if (!n) return NaN;
      let lo = 0, hi = n; // first index with vals > v
      while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] <= v) lo = m + 1; else hi = m; }
      return lo ? cum[lo - 1] / total : 0;
    },
  };
}

// Map a raw value to 0..1 desirability.
export function normalise(v, lo, hi, prefer = 'high') {
  let t = (v - lo) / (hi - lo);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return prefer === 'low' ? 1 - t : t;
}

// Hard limits → mask. limits: [{values, min: number|null, max: number|null}]; cells with no data in a limited
// layer fail. base (optional Uint8Array) is ANDed in. opts.latMin/latMax restrict cell-centre latitude.
export function limitsMask(grid, limits, base = null, opts = {}) {
  const { latMin = -90, latMax = 90 } = opts;
  const n = grid.nLon * grid.nLat, out = new Uint8Array(n);
  const lim = limits.filter(c => c.min != null || c.max != null);
  for (let j = 0; j < grid.nLat; j++) {
    const lat = grid.lat(j);
    if (lat < latMin || lat > latMax) continue;
    for (let i = 0; i < grid.nLon; i++) {
      const k = j * grid.nLon + i;
      if (base && !base[k]) continue;
      let ok = 1;
      for (const c of lim) {
        const v = c.values[k];
        if (!(v === v) || (c.min != null && v < c.min) || (c.max != null && v > c.max)) { ok = 0; break; }
      }
      out[k] = ok;
    }
  }
  return out;
}

// Fraction of the sphere's area covered by mask (cos-latitude weighted through exact cell areas).
export function maskAreaKm2(grid, mask, rowArea = rowAreasKm2(grid)) {
  let a = 0;
  for (let j = 0; j < grid.nLat; j++) {
    let c = 0; const o = j * grid.nLon;
    for (let i = 0; i < grid.nLon; i++) c += mask[o + i] ? 1 : 0;
    a += c * rowArea[j];
  }
  return a;
}

// criteria: [{id, values: Float32Array on grid, range:[lo,hi], weight 0..1, prefer:'high'|'low',
//             min: number|null, max: number|null}]
// opts: {latMin, latMax, minCoverage, mask}  — minCoverage = fraction of total weight that must have data;
//       mask (Uint8Array) = only these cells are scored. If no criterion has weight > 0 every passing cell scores 1.
// Returns {score: Float32Array (NaN = excluded), nValid, totalWeight}.
export function computeScore(grid, criteria, opts = {}) {
  const { latMin = -90, latMax = 90, minCoverage = 0.5, mask = null } = opts;
  const n = grid.nLon * grid.nLat;
  const score = new Float32Array(n).fill(NaN);
  const weighted = criteria.filter(c => c.weight > 0);
  const limited = criteria.filter(c => c.min != null || c.max != null);
  const totalWeight = weighted.reduce((s, c) => s + c.weight, 0);
  let nValid = 0;
  for (let j = 0; j < grid.nLat; j++) {
    const lat = grid.lat(j);
    if (lat < latMin || lat > latMax) continue;
    for (let i = 0; i < grid.nLon; i++) {
      const k = j * grid.nLon + i;
      if (mask && !mask[k]) continue;
      let ok = true;
      for (const c of limited) {
        const v = c.values[k];
        if (!Number.isFinite(v) || (c.min != null && v < c.min) || (c.max != null && v > c.max)) { ok = false; break; }
      }
      if (!ok) continue;
      if (!(totalWeight > 0)) { score[k] = 1; nValid++; continue; }
      let sum = 0, wt = 0;
      for (const c of weighted) {
        const v = c.values[k];
        if (!Number.isFinite(v)) continue;
        sum += c.weight * normalise(v, c.range[0], c.range[1], c.prefer);
        wt += c.weight;
      }
      if (wt <= 0 || wt < minCoverage * totalWeight) continue;
      score[k] = sum / wt;
      nValid++;
    }
  }
  return { score, nValid, totalWeight };
}

export function angularSepDeg(lat1, lon1, lat2, lon2) {
  const a = Math.sin(lat1 * D2R) * Math.sin(lat2 * D2R) +
            Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lon1 - lon2) * D2R);
  return Math.acos(Math.max(-1, Math.min(1, a))) / D2R;
}

// Greedy non-maximum suppression: best-first, each pick at least minSepDeg (great circle) from earlier picks.
export function topSites(grid, score, { n = 10, minSepDeg = 10 } = {}) {
  const idx = [];
  for (let k = 0; k < score.length; k++) if (Number.isFinite(score[k])) idx.push(k);
  idx.sort((a, b) => score[b] - score[a]);
  const picks = [];
  for (const k of idx) {
    const lat = grid.lat(Math.floor(k / grid.nLon)), lon = grid.lon(k % grid.nLon);
    if (picks.some(p => angularSepDeg(lat, lon, p.lat, p.lon) < minSepDeg)) continue;
    picks.push({ lat, lon, score: score[k], index: k });
    if (picks.length >= n) break;
  }
  return picks;
}

// Score threshold that keeps the best `keepFrac` (0..1) of the masked AREA (cell areas as weights).
// Returns -Infinity when everything is kept, +Infinity when the mask is empty.
export function scoreThreshold(grid, score, mask, keepFrac, rowArea = rowAreasKm2(grid)) {
  const idx = [];
  for (let k = 0; k < score.length; k++) if (mask[k] && Number.isFinite(score[k])) idx.push(k);
  if (!idx.length) return Infinity;
  if (keepFrac >= 1) return -Infinity;
  idx.sort((a, b) => score[b] - score[a]);
  let total = 0;
  for (const k of idx) total += rowArea[Math.floor(k / grid.nLon)];
  const target = Math.max(0, keepFrac) * total;
  let acc = 0, thr = score[idx[0]];
  for (const k of idx) {
    thr = score[k];
    acc += rowArea[Math.floor(k / grid.nLon)];
    if (acc >= target) break;
  }
  return thr;
}

// Group the cells of `mask` into connected areas on the lat/lon grid.
//   opts.connectivity  4 or 8 (default 8)
//   opts.minAreaKm2    areas smaller than this are dropped (default 0)
//   opts.score         optional Float32Array → meanScore (area weighted) and best cell per area
//   opts.radiusKm      sphere radius (default Moon)
// Longitude wraps (col 0 is adjacent to col nLon-1). All cells of the northernmost row meet at the pole, so they
// are treated as mutually adjacent; likewise the southernmost row.
// Returns {labels: Int32Array (area index into `areas`, -1 = none), areas: [...], nDropped, droppedAreaKm2}.
// Each area: {id, cells: Int32Array, nCells, areaKm2, centroid:{lat,lon}, label:{lat,lon,index} (the member cell
//   nearest the centroid), bbox:{latMin,latMax,lonMin,lonMax,wraps,allLon}, meanScore, best:{index,lat,lon,score},
//   touchesNorthPole, touchesSouthPole}.  bbox.lonMin > bbox.lonMax when the area crosses ±180° (wraps = true).
// Areas are sorted by meanScore (descending) when a score is given (opts.sortBy = 'area' → by size instead),
// otherwise by area; `id` = rank starting at 1.
export function findAreas(grid, mask, opts = {}) {
  const { connectivity = 8, minAreaKm2 = 0, score = null, radiusKm = MOON_RADIUS_KM, sortBy = 'score' } = opts;
  const { nLon, nLat } = grid, n = nLon * nLat;
  const rowArea = rowAreasKm2(grid, radiusKm);
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const raw = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || comp[start] !== -1) continue;
    const id = raw.length, cells = [];
    let sp = 0, polarN = false, polarS = false;
    stack[sp++] = start; comp[start] = id;
    const push = k => { if (mask[k] && comp[k] === -1) { comp[k] = id; stack[sp++] = k; } };
    while (sp) {
      const k = stack[--sp];
      cells.push(k);
      const j = Math.floor(k / nLon), i = k - j * nLon;
      const il = i === 0 ? nLon - 1 : i - 1, ir = i === nLon - 1 ? 0 : i + 1;
      push(j * nLon + il); push(j * nLon + ir);
      if (j > 0) { push((j - 1) * nLon + i); if (connectivity === 8) { push((j - 1) * nLon + il); push((j - 1) * nLon + ir); } }
      if (j < nLat - 1) { push((j + 1) * nLon + i); if (connectivity === 8) { push((j + 1) * nLon + il); push((j + 1) * nLon + ir); } }
      if (j === 0 && !polarN) { polarN = true; for (let x = 0; x < nLon; x++) push(x); }
      if (j === nLat - 1 && !polarS) { polarS = true; for (let x = 0; x < nLon; x++) push((nLat - 1) * nLon + x); }
    }
    raw.push({ cells, polarN, polarS });
  }

  const areas = [];
  let nDropped = 0, droppedAreaKm2 = 0;
  for (const r of raw) {
    let area = 0, sx = 0, sy = 0, sz = 0, sSum = 0, sW = 0, best = -1, bestS = -Infinity, jMin = nLat, jMax = -1;
    const cols = new Uint8Array(nLon);
    for (const k of r.cells) {
      const j = Math.floor(k / nLon), i = k - j * nLon, a = rowArea[j];
      const lat = grid.lat(j) * D2R, lon = grid.lon(i) * D2R, cl = Math.cos(lat);
      area += a; sx += a * cl * Math.cos(lon); sy += a * cl * Math.sin(lon); sz += a * Math.sin(lat);
      cols[i] = 1; if (j < jMin) jMin = j; if (j > jMax) jMax = j;
      if (score) {
        const s = score[k];
        if (Number.isFinite(s)) { sSum += s * a; sW += a; if (s > bestS) { bestS = s; best = k; } }
      }
    }
    if (area < minAreaKm2) { nDropped++; droppedAreaKm2 += area; continue; }
    const norm = Math.hypot(sx, sy, sz) || 1;
    const cx = sx / norm, cy = sy / norm, cz = sz / norm;
    const centroid = { lat: Math.asin(Math.max(-1, Math.min(1, cz))) / D2R, lon: Math.atan2(cy, cx) / D2R };
    // member cell nearest the centroid (a centroid can fall outside a ring- or C-shaped area)
    let lk = r.cells[0], ld = -2;
    for (const k of r.cells) {
      const j = Math.floor(k / nLon), i = k - j * nLon;
      const lat = grid.lat(j) * D2R, lon = grid.lon(i) * D2R, cl = Math.cos(lat);
      const d = cl * Math.cos(lon) * cx + cl * Math.sin(lon) * cy + Math.sin(lat) * cz;
      if (d > ld) { ld = d; lk = k; }
    }
    // longitude extent = complement of the widest run of empty columns (circular)
    let nCols = 0; for (let i = 0; i < nLon; i++) nCols += cols[i];
    let lonMin = -180, lonMax = 180, wraps = false;
    const allLon = nCols === nLon;
    if (!allLon) {
      let bestLen = 0, bestStart = 0, run = 0;
      for (let t = 0; t < 2 * nLon; t++) {
        const i = t % nLon;
        if (!cols[i]) { run++; if (run > bestLen && run <= nLon) { bestLen = run; bestStart = t - run + 1; } }
        else run = 0;
      }
      const first = (bestStart + bestLen) % nLon;                  // first occupied column after the gap
      const last = ((bestStart - 1) % nLon + nLon) % nLon;         // last occupied column before the gap
      lonMin = -180 + first * grid.step; lonMax = -180 + (last + 1) * grid.step;
      wraps = first > last;
    }
    if (best < 0) best = lk;
    const bj = Math.floor(best / nLon), bi = best - bj * nLon, lj = Math.floor(lk / nLon), li = lk - lj * nLon;
    areas.push({
      cells: Int32Array.from(r.cells), nCells: r.cells.length, areaKm2: area, centroid,
      label: { lat: grid.lat(lj), lon: grid.lon(li), index: lk },
      bbox: { latMin: 90 - (jMax + 1) * grid.step, latMax: 90 - jMin * grid.step, lonMin, lonMax, wraps, allLon },
      meanScore: sW > 0 ? sSum / sW : NaN,
      best: { index: best, lat: grid.lat(bj), lon: grid.lon(bi), score: score && Number.isFinite(score[best]) ? score[best] : NaN },
      touchesNorthPole: r.polarN, touchesSouthPole: r.polarS,
    });
  }
  areas.sort((a, b) => (score && sortBy !== 'area' ? (b.meanScore - a.meanScore) : 0) || b.areaKm2 - a.areaKm2);
  const labels = new Int32Array(n).fill(-1);
  areas.forEach((a, r) => { a.id = r + 1; for (const k of a.cells) labels[k] = r; });
  return { labels, areas, nDropped, droppedAreaKm2 };
}

// Area-weighted mean of a grid layer over a list of cells (NaN cells ignored; NaN if none).
export function areaMean(grid, cells, values, rowArea = rowAreasKm2(grid)) {
  let s = 0, w = 0;
  for (const k of cells) {
    const v = values[k];
    if (v === v) { const a = rowArea[Math.floor(k / grid.nLon)]; s += v * a; w += a; }
  }
  return w > 0 ? s / w : NaN;
}

// Outline of labelled areas: cell edges whose other side has a different label.
// Returns Float32Array of segments [lat1, lon1, lat2, lon2, label, ...] (5 numbers per segment). Longitudes are
// cell-edge values in -180..180; the edge between col nLon-1 and col 0 lies at ±180. Edges at the poles (zero
// length) are skipped. A boundary between two areas appears once per area.
export function areaEdges(grid, labels) {
  const { nLon, nLat, step } = grid, out = [];
  for (let j = 0; j < nLat; j++) {
    const top = 90 - j * step, bot = top - step;
    for (let i = 0; i < nLon; i++) {
      const l = labels[j * nLon + i];
      if (l < 0) continue;
      const west = -180 + i * step, east = west + step;
      const il = i === 0 ? nLon - 1 : i - 1, ir = i === nLon - 1 ? 0 : i + 1;
      if (labels[j * nLon + il] !== l) out.push(top, west, bot, west, l);
      if (labels[j * nLon + ir] !== l) out.push(top, east, bot, east, l);
      if (j > 0 && labels[(j - 1) * nLon + i] !== l) out.push(top, west, top, east, l);
      if (j < nLat - 1 && labels[(j + 1) * nLon + i] !== l) out.push(bot, west, bot, east, l);
    }
  }
  return Float32Array.from(out);
}

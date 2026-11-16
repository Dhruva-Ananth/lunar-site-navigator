// LODESTAR (Lunar Landing Site Navigator) — six-step wizard: UI, globe and glue. Plain ES module, no build step.
// Steps: 1 Resources → 2 Terrain → 3 Comms → 4 Select site (areas) → 5 Power (js/power.js) → 6 Mission (js/mission.js).
// The mission step can download a PDF design report (js/report.js).
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { loadManifest, loadLayer, sample, colormap, MOON_RADIUS_KM } from './data.js';
import {
  makeGrid, percentileRange, blockResample, computeScore, rowAreasKm2, sphereAreaKm2, makeQuantiler,
  limitsMask, maskAreaKm2, scoreThreshold, findAreas, areaMean, areaEdges,
} from './scoring.js';

const R_M = MOON_RADIUS_KM * 1000;
const D2R = Math.PI / 180;
const SPHERE_KM2 = sphereAreaKm2(MOON_RADIUS_KM);
const SLOPE_ID = '_slope', COMMS_ID = '_comms', SUIT_ID = '_suit';
const CORE_IDS = ['h', 'fe', 'ti', 'th'];
const STEP_NAMES = ['', 'Resources', 'Terrain', 'Comms', 'Select site', 'Power', 'Mission'];
const FALLBACK_COMMS_STATE = { mode: 'dte', relayId: null, dsnDishM: 34, band: 'X', maskDeg: 5 };
const AREA_COLORS = [[95, 180, 255], [255, 209, 102], [6, 214, 160], [239, 71, 111], [199, 125, 255], [255, 159, 67],
  [72, 219, 251], [186, 220, 88], [255, 121, 198], [149, 175, 192]];
const MAX_LIST = 40, MAX_LABELS = 30;
const $ = id => document.getElementById(id);

const state = {
  manifest: null,
  layers: new Map(),      // id → full-resolution layer object (manifest layers + derived slope)
  failed: [],             // [{id, error}]
  step: 1, maxStep: 1,
  grid: makeGrid(1), rowArea: null,
  G: new Map(),           // id → Float32Array on the analysis grid (block means)
  Q: new Map(),           // id → area-weighted quantiler on the grid
  resIds: [],             // resource layers (every non-elevation manifest layer that loaded), core first
  res: new Map(),         // id → {weight, prefer, min, max}
  preset: null,
  terrain: { elevMin: null, elevMax: null, slopeOn: true, slopeMax: 7, slopeWeight: 0.15, latMin: -90, latMax: 90 },
  comms: { minAvail: 0.25, weight: 0.1, state: { ...FALLBACK_COMMS_STATE }, mod: null, error: null, fallback: false, presets: [], busy: false },
  sel: { keepPct: 30, minAreaKm2: 5000, sortBy: 'score', areas: [], labels: null, selected: -1, thr: NaN, nDropped: 0, droppedKm2: 0, km2: 0 },
  masks: [null, null, null, null],   // [all, after resources, after terrain, after comms]
  km2: [SPHERE_KM2, NaN, NaN, NaN],
  score: null, scoreFull: null, scoreRange: [0, 1], totalWeight: 0,
  overlayId: SUIT_ID, opacity: 0.75, exag: 10,
  pinned: null,           // {lat, lon}
  lastMs: 0, ready: false,
};

// ---------- small helpers ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
function fmt(v) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
const sig = (v, n = 4) => Number(Number(v).toPrecision(n));
const fmtLatLon = (lat, lon, d = 2) =>
  `${Math.abs(lat).toFixed(d)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(d)}°${lon >= 0 ? 'E' : 'W'}`;
const fmtPct = f => !Number.isFinite(f) ? '—' : f >= 0.0995 ? (f * 100).toFixed(1) + '%' : f >= 0.00995 ? (f * 100).toFixed(2) + '%' : f > 0 ? (f * 100).toFixed(3) + '%' : '0%';
function fmtKm2(a) {
  if (!Number.isFinite(a)) return '—';
  if (a >= 1e6) return (a / 1e6).toFixed(2) + ' million km²';
  if (a >= 1e4) return Math.round(a / 1000).toLocaleString('en-US') + ',000 km²';
  return Math.round(a).toLocaleString('en-US') + ' km²';
}
const unitStr = meta => (meta.units ? ' ' + meta.units : '');
const shortName = meta => (meta.name || meta.id).replace(/ \(.*\)$/, '');
function setStatus(msg, isErr = false) {
  const s = $('status'); s.textContent = msg; s.classList.toggle('err', isErr);
}
const rangeOf = layer => layer._range || (layer._range = percentileRange(layer.data));
const cmapFor = id => (id === 'elev' ? 'terrain' : id === SUIT_ID ? 'magma' : 'viridis');
const wrapLon = l => ((l + 180) % 360 + 360) % 360 - 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const stage = () => Math.min(state.step, 3);

// ---------- coordinate convention ----------
// lat/lon → unit vector: lon 0 faces +Z (towards the default camera), east is +X, north is +Y.
// Texture UV: u = (lon+180)/360 (lon -180 at the image's left edge), v = (lat+90)/180 (flipY → lat +90 = top row).
function dirFromLatLon(lat, lon, out = new THREE.Vector3()) {
  const cl = Math.cos(lat * D2R);
  return out.set(cl * Math.sin(lon * D2R), Math.sin(lat * D2R), cl * Math.cos(lon * D2R));
}
function latLonFromVec(v) {
  const r = v.length();
  return { lat: Math.asin(v.y / r) / D2R, lon: Math.atan2(v.x, v.z) / D2R };
}
function surfaceRadius(lat, lon) {
  const elev = state.layers.get('elev');
  if (!elev) return 1;
  const h = sample(elev, lat, lon);
  return 1 + (Number.isFinite(h) ? (state.exag * h) / R_M : 0);
}
const surfacePoint = (lat, lon, lift = 0) => dirFromLatLon(lat, lon).multiplyScalar(surfaceRadius(lat, lon) + lift);

// ---------- three.js scene ----------
const canvas = $('globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
camera.position.set(0, 0, 4.4);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.12;
controls.enablePan = false; controls.minDistance = 1.25; controls.maxDistance = 9; controls.rotateSpeed = 0.5;

const ambient = new THREE.AmbientLight(0xffffff, 0.9);
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
scene.add(ambient, sun);
function setSun(lonDeg) { sun.position.copy(dirFromLatLon(8, lonDeg)).multiplyScalar(10); }
setSun(-40);

const NW = 256, NH = 128;
const geom = new THREE.BufferGeometry();
const vDirs = new Float32Array((NW + 1) * (NH + 1) * 3);
const vElev = new Float32Array((NW + 1) * (NH + 1));
{
  const uv = new Float32Array((NW + 1) * (NH + 1) * 2);
  const idx = [];
  const d = new THREE.Vector3();
  for (let j = 0; j <= NH; j++) {
    const lat = 90 - (j / NH) * 180;
    for (let i = 0; i <= NW; i++) {
      const lon = -180 + (i / NW) * 360, k = j * (NW + 1) + i;
      dirFromLatLon(lat, lon, d);
      vDirs.set([d.x, d.y, d.z], k * 3);
      uv[k * 2] = i / NW; uv[k * 2 + 1] = 1 - j / NH;
      if (i < NW && j < NH) {
        const a = k, b = k + 1, c = k + NW + 1, e = c + 1; // a=NW corner, b=NE, c=SW, e=SE (seen from outside)
        idx.push(a, c, b, b, c, e);
      }
    }
  }
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vDirs), 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex(idx);
  geom.computeVertexNormals();
}
const moonMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1, metalness: 0 });
const moon = new THREE.Mesh(geom, moonMat);
const overlayMat = new THREE.MeshBasicMaterial({
  transparent: true, opacity: state.opacity, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const overlay = new THREE.Mesh(geom, overlayMat);
overlay.visible = false; overlay.renderOrder = 1;
const graticule = new THREE.Group(), markers = new THREE.Group(), areaLines = new THREE.Group(), selLines = new THREE.Group(), areaLabels = new THREE.Group();
areaLines.renderOrder = 2; selLines.renderOrder = 3;
scene.add(moon, overlay, graticule, areaLines, selLines, markers, areaLabels);

function sampleVertexElevation() {
  const elev = state.layers.get('elev');
  for (let j = 0; j <= NH; j++) {
    const lat = 90 - (j / NH) * 180;
    for (let i = 0; i <= NW; i++) {
      const h = elev ? sample(elev, lat, -180 + (i / NW) * 360) : 0;
      vElev[j * (NW + 1) + i] = Number.isFinite(h) ? h : 0;
    }
  }
  // identical values on the ±180° seam and at the poles so the mesh stays closed
  for (let j = 0; j <= NH; j++) vElev[j * (NW + 1) + NW] = vElev[j * (NW + 1)];
  for (const j of [0, NH]) {
    let s = 0; for (let i = 0; i < NW; i++) s += vElev[j * (NW + 1) + i];
    for (let i = 0; i <= NW; i++) vElev[j * (NW + 1) + i] = s / NW;
  }
}
function applyDisplacement() {
  const pos = geom.attributes.position.array;
  for (let k = 0; k < vElev.length; k++) {
    const r = 1 + (state.exag * vElev[k]) / R_M;
    pos[k * 3] = vDirs[k * 3] * r; pos[k * 3 + 1] = vDirs[k * 3 + 1] * r; pos[k * 3 + 2] = vDirs[k * 3 + 2] * r;
  }
  geom.attributes.position.needsUpdate = true;
  geom.computeVertexNormals();
  const n = geom.attributes.normal.array; // average normals across the seam
  for (let j = 0; j <= NH; j++) {
    const a = j * (NW + 1) * 3, b = (j * (NW + 1) + NW) * 3;
    for (let c = 0; c < 3; c++) { const m = (n[a + c] + n[b + c]) / 2; n[a + c] = m; n[b + c] = m; }
  }
  geom.attributes.normal.needsUpdate = true;
  geom.computeBoundingSphere();
}
// Radius of the displayed (coarse, displaced) mesh at a lat/lon — piecewise linear like its triangles — so that
// lines and labels sit just above what is actually drawn rather than above the finer elevation grid.
function meshRadius(lat, lon) {
  const fj = clamp(((90 - lat) / 180) * NH, 0, NH), fi = clamp(((wrapLon(lon) + 180) / 360) * NW, 0, NW);
  const j0 = Math.min(NH - 1, Math.floor(fj)), i0 = Math.min(NW - 1, Math.floor(fi)), tj = fj - j0, ti = fi - i0;
  const k = j0 * (NW + 1) + i0;
  const a = vElev[k], b = vElev[k + 1], c = vElev[k + NW + 1], e = vElev[k + NW + 2];
  const h = ti + tj <= 1 ? a + (b - a) * ti + (c - a) * tj : e + (c - e) * (1 - ti) + (b - e) * (1 - tj);
  return 1 + (state.exag * h) / R_M;
}
const meshPoint = (lat, lon, lift = 0, out = new THREE.Vector3()) => dirFromLatLon(lat, lon, out).multiplyScalar(meshRadius(lat, lon) + lift);

function lineFromLatLons(pts, color, lift, opacity = 1) {
  const arr = new Float32Array(pts.length * 3);
  pts.forEach(([lat, lon], i) => { const p = surfacePoint(lat, lon, lift); arr.set([p.x, p.y, p.z], i * 3); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}
function clearGroup(g) {
  for (const c of [...g.children]) { g.remove(c); c.geometry?.dispose(); c.material?.map?.dispose(); c.material?.dispose(); }
}
function buildGraticule() {
  clearGroup(graticule);
  const lift = 0.004 + 0.0006 * state.exag;
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = []; for (let lon = -180; lon <= 180; lon += 1) pts.push([lat, lon]);
    graticule.add(lineFromLatLons(pts, lat === 0 ? 0xffd166 : 0x7fb8ff, lift, lat === 0 ? 0.8 : 0.45));
  }
  for (let lon = -180; lon < 180; lon += 30) {
    const pts = []; for (let lat = -90; lat <= 90; lat += 1) pts.push([lat, lon]);
    graticule.add(lineFromLatLons(pts, lon === 0 ? 0xffd166 : 0x7fb8ff, lift, lon === 0 ? 0.8 : 0.45));
  }
}
function buildMarkers() {
  clearGroup(markers);
  if (!state.pinned) return;
  const p = meshPoint(state.pinned.lat, state.pinned.lon, 0.012 + 0.0006 * state.exag);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 10), new THREE.MeshBasicMaterial({ color: 0xff4d6d }));
  dot.position.copy(p);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.037, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  ring.position.copy(p); ring.lookAt(p.clone().multiplyScalar(2));
  markers.add(dot, ring);
}
function rebuildDecorations() { buildGraticule(); buildMarkers(); buildAreaGraphics(); }

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('view'));

let fly = null;
// dist (optional) = camera distance to end at, in Moon radii; default: keep the current one, but no farther than 3.4
function flyTo(lat, lon, dist = null) {
  const from = camera.position.clone().normalize();
  const to = dirFromLatLon(clamp(lat, -84, 84), lon);
  const q = new THREE.Quaternion();
  if (from.dot(to) < -0.98) { // (nearly) opposite side: turn about the axis closest to the Moon's spin axis, not over a pole
    const axis = new THREE.Vector3(0, 1, 0).addScaledVector(from, -from.y);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0).addScaledVector(from, -from.x);
    q.setFromAxisAngle(axis.normalize(), from.angleTo(to));
    // exact for antipodes on the equator; otherwise close enough for a view change
  } else q.setFromUnitVectors(from, to);
  fly = {
    from, q,
    r0: camera.position.length(), r1: dist ?? Math.min(camera.position.length(), 3.4), t0: performance.now(), dur: 900,
  };
}
const _tmpV = new THREE.Vector3();
function tick(now) {
  requestAnimationFrame(tick);
  if (state.step >= 5) return;
  if (fly) {
    const t = Math.min(1, (now - fly.t0) / fly.dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const q = new THREE.Quaternion().slerp(fly.q, e);
    camera.position.copy(fly.from).applyQuaternion(q).multiplyScalar(fly.r0 + (fly.r1 - fly.r0) * e);
    if (t >= 1) fly = null;
  }
  controls.update();
  if (areaLabels.children.length) { // labels ignore depth, so hide the ones beyond the limb
    const d = camera.position.length(), cx = camera.position.x / d, cy = camera.position.y / d, cz = camera.position.z / d;
    for (const s of areaLabels.children) {
      const p = s.position, r = p.length();
      s.visible = (p.x * cx + p.y * cy + p.z * cz) / r > r / d + 0.04;
    }
  }
  renderer.render(scene, camera);
}

// ---------- derived layers ----------
function makeSlopeLayer(elev) {
  const { width: w, height: h, data } = elev;
  const out = new Float32Array(w * h);
  const dLat = (Math.PI / h) * R_M;
  let max = 0;
  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180, c = Math.cos(lat * D2R);
    // east–west baseline: step kx pixels so its length on the ground stays close to the north–south one near the poles
    const kx = Math.max(1, Math.min(w / 4, Math.round(1 / c)));
    const dLon = kx * ((2 * Math.PI) / w) * R_M * c;
    const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xl = (x + w - kx) % w, xr = (x + kx) % w;
      const gx = (data[y * w + xr] - data[y * w + xl]) / (2 * dLon);
      const gy = (data[yu * w + x] - data[yd * w + x]) / ((yd - yu) * dLat);
      const s = Math.atan(Math.hypot(gx, gy)) / D2R;
      out[y * w + x] = s; // NaN propagates from no-data neighbours
      if (s > max) max = s;
    }
  }
  const pxKm = (2 * Math.PI * MOON_RADIUS_KM) / w;
  return {
    id: SLOPE_ID, width: w, height: h, min: 0, max, data: out,
    meta: {
      id: SLOPE_ID, name: 'Regional slope (from elevation)', mission: (elev.meta.mission || 'elevation') + ' — derived', agency: elev.meta.agency || '',
      units: '°', better: 'low', derived: true, demo: elev.meta.demo,
      description: `Computed in the browser by central differences on the global elevation grid (${pxKm.toFixed(1)} km per pixel, baseline ≈ ${(2 * pxKm).toFixed(0)} km). ` +
        'This is a regional slope and understates lander-scale slopes; use the area detail view for finer terrain.',
    },
  };
}

// ---------- analysis grid ----------
const isDemo = meta => !!(meta.demo || (state.manifest?.demo && !meta.derived));
function buildGridData() {
  const g = state.grid;
  state.rowArea = rowAreasKm2(g, MOON_RADIUS_KM);
  state.G.clear(); state.Q.clear();
  for (const [id, layer] of state.layers) {
    const v = blockResample(layer, g, sample);
    state.G.set(id, v);
    state.Q.set(id, makeQuantiler(g, v, state.rowArea));
  }
  state.masks[0] = new Uint8Array(g.nLon * g.nLat).fill(1);
  suitCanvas = null;
}
const gridIndex = (lat, lon) => {
  const g = state.grid;
  const j = clamp(Math.floor((90 - lat) / g.step), 0, g.nLat - 1), i = clamp(Math.floor((wrapLon(lon) + 180) / g.step), 0, g.nLon - 1);
  return j * g.nLon + i;
};

// ---------- comms (js/comms.js is owned by another module: every use is guarded) ----------
let commsModP = null;
function commsModule() {
  if (!commsModP) commsModP = import('./comms.js').then(mod => {
    state.comms.mod = mod;
    if (mod.DEFAULT_COMMS_STATE && typeof mod.DEFAULT_COMMS_STATE === 'object') state.comms.state = { ...mod.DEFAULT_COMMS_STATE };
    if (Array.isArray(mod.RELAY_PRESETS)) state.comms.presets = mod.RELAY_PRESETS;
    return mod;
  });
  return commsModP;
}
let commsToken = 0;
async function computeCommsGrid() {
  const my = ++commsToken, c = state.comms, g = state.grid;
  c.busy = true; setBusy();
  try {
    const mod = await commsModule();
    let fn;
    if (typeof mod.commsAvailability === 'function') { fn = (lat, lon) => mod.commsAvailability(lat, lon, c.state); c.fallback = false; }
    else if (typeof mod.earthVisibility === 'function') {
      const mask = Number.isFinite(c.state.maskDeg) ? c.state.maskDeg : 5;
      fn = (lat, lon) => mod.earthVisibility(lat, lon, mask).fracVisible; c.fallback = true;
    } else throw new Error('js/comms.js exports neither commsAvailability() nor earthVisibility()');
    const out = new Float32Array(g.nLon * g.nLat);
    let t0 = performance.now();
    for (let j = 0; j < g.nLat; j++) {
      const lat = g.lat(j);
      for (let i = 0; i < g.nLon; i++) { const v = fn(lat, g.lon(i)); out[j * g.nLon + i] = Number.isFinite(v) ? clamp(v, 0, 1) : NaN; }
      if (performance.now() - t0 > 40) { // keep the page responsive on slow models / the 0.5° grid
        await new Promise(r => setTimeout(r, 0));
        if (my !== commsToken || g !== state.grid) return;
        t0 = performance.now();
      }
    }
    if (my !== commsToken || g !== state.grid) return;
    state.G.set(COMMS_ID, out);
    state.Q.set(COMMS_ID, makeQuantiler(g, out, state.rowArea));
    c.error = null;
  } catch (e) {
    console.warn('[comms] availability grid failed', e);
    if (my !== commsToken) return;
    state.G.delete(COMMS_ID); state.Q.delete(COMMS_ID);
    c.error = e?.message || String(e);
  }
  c.busy = false; setBusy();
  buildOverlayOptions();
  recompute();
}
function setBusy() { $('busy').hidden = !state.comms.busy; }
function commsModeText() {
  const s = state.comms.state || {};
  if (s.mode === 'relay') {
    const p = state.comms.presets.find(p => p.id === s.relayId);
    return `Relay: ${p?.name || s.relayId || 'orbiter'}`;
  }
  return `Direct-to-Earth · DSN ${s.dsnDishM ?? '?'} m · ${s.band ?? '?'}-band`;
}

// ---------- suitability pipeline ----------
function resCriteria() {
  return state.resIds.map(id => {
    const c = state.res.get(id);
    return { id, values: state.G.get(id), range: rangeOf(state.layers.get(id)), weight: c.weight, prefer: c.prefer, min: c.min, max: c.max };
  });
}
function recompute() {
  if (!state.ready) return;
  const t0 = performance.now();
  const g = state.grid, t = state.terrain, c = state.comms;
  const res = resCriteria();
  const m1 = limitsMask(g, res);
  const terr = [];
  if (state.G.has('elev')) terr.push({ values: state.G.get('elev'), min: t.elevMin, max: t.elevMax });
  if (state.G.has(SLOPE_ID)) terr.push({ values: state.G.get(SLOPE_ID), min: null, max: t.slopeOn ? t.slopeMax : null });
  const m2 = limitsMask(g, terr, m1, { latMin: Math.min(t.latMin, t.latMax), latMax: Math.max(t.latMin, t.latMax) });
  const cg = state.G.get(COMMS_ID);
  const m3 = cg ? limitsMask(g, [{ values: cg, min: c.minAvail > 0 ? c.minAvail : null, max: null }], m2) : m2;
  state.masks = [state.masks[0], m1, m2, m3];
  state.km2 = [SPHERE_KM2, maskAreaKm2(g, m1, state.rowArea), maskAreaKm2(g, m2, state.rowArea), maskAreaKm2(g, m3, state.rowArea)];

  const st = stage();
  const crit = res.map(r => ({ ...r, min: null, max: null }));
  if (st >= 2 && state.G.has(SLOPE_ID)) crit.push({ id: SLOPE_ID, values: state.G.get(SLOPE_ID), range: rangeOf(state.layers.get(SLOPE_ID)), weight: t.slopeWeight, prefer: 'low', min: null, max: null });
  if (st >= 3 && cg) crit.push({ id: COMMS_ID, values: cg, range: [0, 1], weight: c.weight, prefer: 'high', min: null, max: null });
  const { score, totalWeight } = computeScore(g, crit, { mask: state.masks[st] });
  state.score = score; state.totalWeight = totalWeight;
  // colour range = 2–98 percentile of the scores that are on show
  const vals = []; for (let k = 0; k < score.length; k += 1) if (score[k] === score[k]) vals.push(score[k]);
  if (vals.length) {
    vals.sort((a, b) => a - b);
    let lo = vals[Math.floor(0.02 * (vals.length - 1))], hi = vals[Math.ceil(0.98 * (vals.length - 1))];
    if (!(hi > lo)) { lo = Math.max(0, lo - 0.05); hi = lo + 0.1; }
    state.scoreRange = [lo, hi];
  } else state.scoreRange = [0, 1];

  // areas (step 4) always use the full score: resources + slope + comms weights on the final mask
  if (state.maxStep >= 4) {
    if (st === 3) state.scoreFull = score;
    else {
      const all = res.map(r => ({ ...r, min: null, max: null }));
      if (state.G.has(SLOPE_ID)) all.push({ id: SLOPE_ID, values: state.G.get(SLOPE_ID), range: rangeOf(state.layers.get(SLOPE_ID)), weight: t.slopeWeight, prefer: 'low', min: null, max: null });
      if (cg) all.push({ id: COMMS_ID, values: cg, range: [0, 1], weight: c.weight, prefer: 'high', min: null, max: null });
      state.scoreFull = computeScore(g, all, { mask: m3 }).score;
    }
    computeAreas();
  }
  state.lastMs = performance.now() - t0;
  refreshOverlay();
  renderFunnel(); renderSummaries(); renderKeeps(); renderStepMessages(); updateNav();
  if (state.step === 4) renderAreas();
  if (state.pinned) showReadout(state.pinned, true);
}
let recomputeTimer = 0;
function scheduleRecompute(ms = 70) { clearTimeout(recomputeTimer); recomputeTimer = setTimeout(recompute, ms); }

// ---------- step 4: areas ----------
function computeAreas() {
  const g = state.grid, s = state.sel, m3 = state.masks[3], score = state.scoreFull;
  const prevBest = s.selected >= 0 && s.areas[s.selected] ? s.areas[s.selected].best.index : -1;
  const thr = scoreThreshold(g, score, m3, s.keepPct / 100, state.rowArea);
  const mask = new Uint8Array(m3.length);
  if (thr !== Infinity) for (let k = 0; k < mask.length; k++) mask[k] = m3[k] && score[k] >= thr ? 1 : 0;
  const r = findAreas(g, mask, { connectivity: 8, minAreaKm2: s.minAreaKm2, score, sortBy: s.sortBy, radiusKm: MOON_RADIUS_KM });
  s.thr = thr; s.areas = r.areas; s.labels = r.labels; s.nDropped = r.nDropped; s.droppedKm2 = r.droppedAreaKm2;
  s.km2 = r.areas.reduce((a, b) => a + b.areaKm2, 0);
  s.selected = prevBest >= 0 ? r.labels[prevBest] : -1;
  // per-area means of the layers that matter
  const ids = activeLayerIds();
  for (const a of r.areas) a.means = ids.map(id => ({ id, v: areaMean(g, a.cells, state.G.get(id), state.rowArea) }));
  buildAreaGraphics();
}
// layers worth reporting: weighted or limited resources, then elevation, slope, comms
function activeLayerIds() {
  const ids = state.resIds.filter(id => { const c = state.res.get(id); return c.weight > 0 || c.min != null || c.max != null; });
  for (const id of ['elev', SLOPE_ID, COMMS_ID]) if (state.G.has(id)) ids.push(id);
  return ids;
}
function layerMeta(id) {
  if (id === COMMS_ID) return { id, name: 'Link availability', units: '%', derived: true };
  return state.layers.get(id)?.meta || { id, name: id };
}
const fmtVal = (id, v) => id === COMMS_ID ? (Number.isFinite(v) ? (v * 100).toFixed(0) + '%' : '—') : fmt(v) + unitStr(layerMeta(id));
const areaColor = r => AREA_COLORS[r % AREA_COLORS.length];

function buildAreaGraphics() {
  clearGroup(areaLines); clearGroup(selLines); clearGroup(areaLabels);
  const s = state.sel;
  if (state.step !== 4 || !s.labels || !s.areas.length) return;
  const seg = areaEdges(state.grid, s.labels), nSeg = seg.length / 5;
  const lift = 0.006 + 0.0006 * state.exag;
  const pos = new Float32Array(nSeg * 6), col = new Float32Array(nSeg * 6), selPos = [];
  const p = new THREE.Vector3();
  for (let q = 0; q < nSeg; q++) {
    const o = q * 5, lab = seg[o + 4], c = areaColor(lab);
    for (let e = 0; e < 2; e++) {
      meshPoint(seg[o + e * 2], seg[o + e * 2 + 1], lift, p);
      pos.set([p.x, p.y, p.z], q * 6 + e * 3);
      col.set([Math.min(1, c[0] / 255 + 0.25), Math.min(1, c[1] / 255 + 0.25), Math.min(1, c[2] / 255 + 0.25)], q * 6 + e * 3);
      if (lab === s.selected) { meshPoint(seg[o + e * 2], seg[o + e * 2 + 1], lift + 0.004, p); selPos.push(p.x, p.y, p.z); }
    }
  }
  const gA = new THREE.BufferGeometry();
  gA.setAttribute('position', new THREE.BufferAttribute(pos, 3)); gA.setAttribute('color', new THREE.BufferAttribute(col, 3));
  areaLines.add(new THREE.LineSegments(gA, new THREE.LineBasicMaterial({ vertexColors: true })));
  if (selPos.length) {
    const gS = new THREE.BufferGeometry();
    gS.setAttribute('position', new THREE.BufferAttribute(new Float32Array(selPos), 3));
    selLines.add(new THREE.LineSegments(gS, new THREE.LineBasicMaterial({ color: 0xffffff })));
  }
  s.areas.slice(0, MAX_LABELS).forEach((a, r) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'), c = areaColor(r), isSel = r === s.selected;
    g.beginPath(); g.arc(32, 32, 26, 0, 2 * Math.PI);
    g.fillStyle = isSel ? '#ffffff' : 'rgba(10,14,20,0.82)'; g.fill();
    g.lineWidth = 5; g.strokeStyle = `rgb(${c.join(',')})`; g.stroke();
    g.fillStyle = isSel ? '#06121f' : '#ffffff'; g.font = `bold ${a.id > 9 ? 28 : 34}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(a.id), 32, 34);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
    sp.scale.setScalar(isSel ? 0.062 : 0.05); sp.renderOrder = 5;
    meshPoint(a.label.lat, a.label.lon, lift + 0.01, sp.position);
    areaLabels.add(sp);
  });
}
function selectArea(r, { fly: doFly = false, scroll = false } = {}) {
  const s = state.sel;
  s.selected = r >= 0 && r < s.areas.length ? r : -1;
  buildAreaGraphics(); refreshOverlay(); renderAreas(); updateNav(); renderFunnel();
  if (s.selected >= 0) {
    const a = s.areas[s.selected];
    if (doFly) flyTo(a.label.lat, a.label.lon, clamp(2.0 + 14 * Math.sqrt(a.areaKm2 / SPHERE_KM2), 2.2, 3.8));
    if (scroll) document.querySelector(`#areas li[data-r="${s.selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}
// The step whose limits removed the largest share of the area that reached it → [step, km² removed, share removed].
function whichStepRemovedMost() {
  const k = state.km2, drops = [];
  for (let s = 1; s <= 3; s++) if (k[s - 1] > 0) drops.push([s, k[s - 1] - k[s], (k[s - 1] - k[s]) / k[s - 1]]);
  drops.sort((a, b) => b[2] - a[2] || b[1] - a[1]);
  return drops[0];
}
function renderAreas() {
  const s = state.sel, box = $('areas'), msg = $('areas-msg'), act = $('area-actions');
  box.textContent = ''; msg.textContent = ''; msg.className = '';
  const funnelTxt = `resources left ${fmtPct(state.km2[1] / SPHERE_KM2)}, terrain ${fmtPct(state.km2[2] / SPHERE_KM2)}, comms ${fmtPct(state.km2[3] / SPHERE_KM2)} of the surface`;
  if (!s.areas.length) {
    act.hidden = true; msg.className = 'nomatch';
    if (!(state.km2[3] > 0)) {
      const [st, lost, share] = whichStepRemovedMost();
      msg.append(el('b', { text: 'No area matches every criterion.' }),
        el('div', { text: `Nothing on the Moon passes all the hard limits (${funnelTxt}). Step ${st} (${STEP_NAMES[st]}) removed the most: ${fmtPct(share)} of the area that reached it (${fmtKm2(lost)}).` }),
        el('button', { class: 'small', text: `Relax step ${st} — ${STEP_NAMES[st]}`, onclick: () => goStep(st) }));
    } else {
      msg.append(el('b', { text: 'Matching cells exist, but no group is big enough.' }),
        el('div', { text: `${s.nDropped} group${s.nDropped === 1 ? '' : 's'} (${fmtKm2(s.droppedKm2)} in total) are smaller than the minimum area of ${fmtKm2(s.minAreaKm2)}. Lower “Drop areas smaller than”, or keep a larger share of the suitable area.` }));
    }
    return;
  }
  msg.append(el('div', { class: 'muted small-text', text:
    `${s.areas.length} area${s.areas.length === 1 ? '' : 's'}, ${fmtKm2(s.km2)} in total (${fmtPct(s.km2 / SPHERE_KM2)} of the Moon)` +
    (state.totalWeight > 0 ? `; score ≥ ${s.thr === -Infinity ? 'any' : s.thr.toFixed(3)}` : '; no weights set, so every suitable cell ranks equally') +
    (s.nDropped ? `; ${s.nDropped} smaller group${s.nDropped === 1 ? '' : 's'} dropped (${fmtKm2(s.droppedKm2)})` : '') +
    (s.areas.length > MAX_LIST ? `. Showing the first ${MAX_LIST}.` : '.') }));
  act.hidden = s.selected < 0;
  if (s.selected >= 0) {
    const a = s.areas[s.selected];
    $('area-sel-title').textContent = `Area ${a.id} selected — ${fmtKm2(a.areaKm2)}, best cell ${fmtLatLon(a.best.lat, a.best.lon, 1)}`;
  } else msg.append(el('div', { class: 'hint', text: 'Click a coloured area on the Moon, or a row below, to select it.' }));
  const ol = el('ol');
  s.areas.slice(0, MAX_LIST).forEach((a, r) => {
    const c = areaColor(r);
    const vals = (a.means || []).map(({ id, v }) => `${shortName(layerMeta(id))} ${fmtVal(id, v)}`).join(' · ');
    ol.append(el('li', { 'data-r': r, class: r === s.selected ? 'sel' : '', onclick: () => selectArea(r, { fly: true }) },
      el('div', { class: 's-head' },
        el('span', {}, el('span', { class: 'swatch', style: `background:rgb(${c.join(',')})` }), el('span', { class: 's-rank', text: 'Area ' + a.id }), fmtLatLon(a.centroid.lat, a.centroid.lon, 1)),
        el('span', { class: 's-score', text: fmtKm2(a.areaKm2) })),
      el('div', { class: 's-sub', text: `mean score ${Number.isFinite(a.meanScore) ? a.meanScore.toFixed(3) : '—'} · ${a.nCells} cell${a.nCells === 1 ? '' : 's'} · lat ${a.bbox.latMin}…${a.bbox.latMax}°, lon ${a.bbox.allLon ? 'all' : a.bbox.lonMin + '…' + a.bbox.lonMax + '°'}` }),
      el('div', { class: 's-vals', text: 'means: ' + vals })));
  });
  box.append(ol);
}
function areaBox(a) {
  // bounding box for the detail modal, clamped to 30° × 40° around the best-scoring cell
  const MAXLAT = 30, MAXLON = 40, b = a.bbox;
  let latMin = b.latMin, latMax = b.latMax, clamped = false;
  if (latMax - latMin > MAXLAT) {
    clamped = true;
    latMin = clamp(a.best.lat - MAXLAT / 2, b.latMin, b.latMax - MAXLAT); latMax = latMin + MAXLAT;
  }
  let lonMin = b.lonMin, lonMax = b.lonMax;
  const span = b.allLon ? 360 : b.wraps ? lonMax + 360 - lonMin : lonMax - lonMin;
  if (span > MAXLON) {
    clamped = true;
    lonMin = wrapLon(a.best.lon - MAXLON / 2); lonMax = wrapLon(a.best.lon + MAXLON / 2);
    if (lonMax === -180) lonMax = 180;
  }
  const r = v => Math.round(v * 100) / 100;
  return { box: { latMin: r(latMin), latMax: r(latMax), lonMin: r(lonMin), lonMax: r(lonMax) }, clamped };
}

// ---------- overlays ----------
let overlayTex = null, suitCanvas = null, suitSmall = null;
function layerToCanvas(layer, range, cmap) {
  const stride = Math.max(1, Math.ceil(layer.width / 2048));
  const w = Math.floor(layer.width / stride), h = Math.floor(layer.height / stride);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), px = img.data;
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) lut.set(colormap(i / 255, cmap), i * 3);
  const [lo, hi] = range, k = 255 / (hi - lo);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = layer.data[y * stride * layer.width + x * stride], o = (y * w + x) * 4;
    if (!Number.isFinite(v)) { px[o + 3] = 0; continue; }
    const t = Math.max(0, Math.min(255, Math.round((v - lo) * k))) * 3;
    px[o] = lut[t]; px[o + 1] = lut[t + 1]; px[o + 2] = lut[t + 2]; px[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
const MAGMA_LUT = (() => { const l = new Uint8Array(256 * 3); for (let i = 0; i < 256; i++) l.set(colormap(0.12 + 0.88 * (i / 255), 'magma'), i * 3); return l; })();
const DIM = [6, 9, 16, 185], PALE = [120, 160, 220, 105];
// Suitability texture: excluded cells are dimmed, passing cells coloured by score; in step 4 the matching areas
// are filled with their own colours instead. Drawn at grid resolution, then enlarged without smoothing.
function drawSuitCanvas() {
  const g = state.grid, n = g.nLon * g.nLat;
  if (!suitSmall || suitSmall.width !== g.nLon) {
    suitSmall = document.createElement('canvas'); suitSmall.width = g.nLon; suitSmall.height = g.nLat;
    const f = Math.max(1, Math.round(1440 / g.nLon));
    suitCanvas = document.createElement('canvas'); suitCanvas.width = g.nLon * f; suitCanvas.height = g.nLat * f;
  }
  const ctx = suitSmall.getContext('2d'), img = ctx.createImageData(g.nLon, g.nLat), px = img.data;
  const mask = state.masks[stage()], score = state.score, [lo, hi] = state.scoreRange, kk = 255 / (hi - lo);
  const areasMode = state.step === 4 && state.sel.labels, lab = state.sel.labels, selI = state.sel.selected;
  for (let k = 0; k < n; k++) {
    const o = k * 4;
    let c = DIM, a = DIM[3];
    if (areasMode) {
      const l = lab[k];
      if (l >= 0) { c = areaColor(l); a = l === selI ? 255 : selI >= 0 ? 150 : 215; }
      else if (mask[k]) { c = PALE; a = PALE[3]; }
    } else if (mask[k] && score[k] === score[k]) {
      const t = clamp(Math.round((score[k] - lo) * kk), 0, 255) * 3;
      px[o] = MAGMA_LUT[t]; px[o + 1] = MAGMA_LUT[t + 1]; px[o + 2] = MAGMA_LUT[t + 2]; px[o + 3] = 235;
      continue;
    }
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  const big = suitCanvas.getContext('2d');
  big.imageSmoothingEnabled = false;
  big.clearRect(0, 0, suitCanvas.width, suitCanvas.height);
  big.drawImage(suitSmall, 0, 0, suitCanvas.width, suitCanvas.height);
  return suitCanvas;
}
function overlayLayer(id) {
  if (id === COMMS_ID) {
    const d = state.G.get(COMMS_ID);
    return d ? { id, width: state.grid.nLon, height: state.grid.nLat, data: d, meta: { id, name: 'Link availability — ' + commsModeText(), units: '% of time', derived: true },
      _range: [0, Math.max(0.01, state.Q.get(COMMS_ID)?.max ?? 1)] } : null;
  }
  return state.layers.get(id) || null;
}
function setTexture(cv) {
  if (overlayTex && overlayTex.image === cv) { overlayTex.needsUpdate = true; return; }
  overlayTex?.dispose();
  overlayTex = new THREE.CanvasTexture(cv);
  overlayTex.colorSpace = THREE.SRGBColorSpace;
  overlayTex.minFilter = THREE.LinearFilter; overlayTex.generateMipmaps = false;
  overlayMat.map = overlayTex; overlayMat.needsUpdate = true;
}
function setOverlay(id) {
  if (id !== SUIT_ID && !(id && overlayLayer(id))) id = id ? SUIT_ID : null;
  state.overlayId = id || null;
  for (const r of document.querySelectorAll('input[name=overlay]')) r.checked = r.value === (state.overlayId || '');
  $('overlay-select').value = state.overlayId || '';
  for (const b of document.querySelectorAll('.res .eye')) b.classList.toggle('on', b.dataset.id === state.overlayId);
  refreshOverlay(true);
}
function legendBar(cmap, lo = 0, hi = 1) {
  const bar = el('canvas', { width: 256, height: 1 });
  const g = bar.getContext('2d');
  for (let i = 0; i < 256; i++) { g.fillStyle = `rgb(${colormap(lo + (hi - lo) * (i / 255), cmap).join(',')})`; g.fillRect(i, 0, 1, 1); }
  return bar;
}
function refreshOverlay(force = false) {
  const legend = $('legend'), id = state.overlayId;
  const showAreas = state.step === 4;
  areaLines.visible = selLines.visible = areaLabels.visible = showAreas;
  if (!id) { overlay.visible = false; legend.hidden = true; return; }
  legend.hidden = false; legend.textContent = '';
  if (id === SUIT_ID) {
    if (!state.score) { overlay.visible = false; legend.hidden = true; return; }
    setTexture(drawSuitCanvas());
    overlay.visible = true;
    if (state.step === 4) {
      legend.append(el('div', { class: 'lg-title', text: 'Matching areas' }),
        el('div', { class: 'lg-keys' },
          el('span', {}, el('i', { style: 'background:linear-gradient(90deg,#5fb4ff,#ffd166,#06d6a0,#ef476f)' }), 'areas (numbered)'),
          el('span', {}, el('i', { style: 'background:#8fa3c0;opacity:.6' }), 'suitable, below score cut'),
          el('span', {}, el('i', { style: 'background:#06090f' }), 'excluded')),
        el('div', { class: 'lg-note', text: `Analysis grid ${state.grid.step}°. Coarse global maps — regional guidance only.` }));
    } else {
      const [lo, hi] = state.scoreRange, st = stage();
      legend.append(el('div', { class: 'lg-title', text: `Suitability after step ${st} (${STEP_NAMES[st]})` }),
        legendBar('magma', 0.12, 1),
        el('div', { class: 'lg-range' }, el('span', { text: 'score ≤ ' + lo.toFixed(2) }), el('span', { text: '≥ ' + hi.toFixed(2) })),
        el('div', { class: 'lg-keys' }, el('span', {}, el('i', { style: 'background:#06090f' }), 'fails a hard limit (dimmed)')),
        el('div', { class: 'lg-note', text: state.totalWeight > 0 ? 'Colour = weighted score of the cells that pass every limit so far.' : 'No weights set: every passing cell has the same score.' }));
    }
    return;
  }
  const layer = overlayLayer(id);
  if (!layer) { overlay.visible = false; legend.hidden = true; return; }
  const range = rangeOf(layer), cmap = cmapFor(layer.id);
  if (force || !overlayTex || overlayTex.image !== layer._canvas || id === COMMS_ID) {
    if (!layer._canvas || id === COMMS_ID) layer._canvas = layerToCanvas(layer, range, cmap);
    setTexture(layer._canvas);
  }
  overlay.visible = true;
  const ext = dataExtent(layer);
  legend.append(
    el('div', { class: 'lg-title', text: layer.meta.name + (layer.meta.units ? ` (${layer.meta.units})` : '') }),
    legendBar(cmap),
    id === COMMS_ID
      ? el('div', { class: 'lg-range' }, el('span', { text: (range[0] * 100).toFixed(0) + '%' }), el('span', { text: (range[1] * 100).toFixed(0) + '%' }))
      : el('div', { class: 'lg-range' }, el('span', { text: '≤ ' + fmt(range[0]) }), el('span', { text: '≥ ' + fmt(range[1]) + unitStr(layer.meta) })),
    el('div', { class: 'lg-note', text: id === COMMS_ID ? 'Share of time a link exists. Geometric model on the analysis grid, not a measurement; no local terrain horizon.'
      : `Colour range = 2–98 percentile. Data range ${fmt(ext[0])} … ${fmt(ext[1])}.` + (isDemo(layer.meta) ? ' SYNTHETIC DEMO DATA.' : '') }));
}
function dataExtent(layer) {
  if (!layer._ext) {
    let lo = Infinity, hi = -Infinity;
    for (const v of layer.data) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    layer._ext = [lo, hi];
  }
  return layer._ext;
}
function overlayChoices() {
  const out = [{ id: '', name: 'None (albedo only)', sub: '' },
    { id: SUIT_ID, name: 'Suitability / matching areas', sub: 'cells passing the limits so far, coloured by score', badges: ['derived'] }];
  const m = state.manifest;
  const add = meta => {
    const ok = state.layers.has(meta.id);
    out.push({ id: meta.id, name: meta.name || meta.id, disabled: !ok, badges: isDemo(meta) ? ['demo'] : [],
      sub: [meta.mission, meta.agency].filter(Boolean).join(' · ') + (meta.units ? ` · ${meta.units}` : '') + (ok ? '' : ' · FAILED TO LOAD') });
  };
  for (const meta of m.layers) if (meta.id === 'elev') add(meta);
  const sl = state.layers.get(SLOPE_ID);
  out.push({ id: SLOPE_ID, name: 'Regional slope (from elevation)', sub: sl ? `${sl.meta.mission} · °` : 'unavailable', badges: ['derived'], disabled: !sl });
  out.push({ id: COMMS_ID, name: 'Link availability (comms)', badges: ['derived'], disabled: !state.G.has(COMMS_ID),
    sub: state.G.has(COMMS_ID) ? commsModeText() + ' · geometric model' : 'unavailable' + (state.comms.error ? ' — ' + state.comms.error : '') });
  for (const meta of m.layers) if (meta.id !== 'elev') add(meta);
  return out;
}
function buildOverlayOptions() {
  if (!state.manifest) return;
  const list = $('overlay-list'), sel = $('overlay-select'), choices = overlayChoices();
  list.textContent = ''; sel.textContent = '';
  for (const c of choices) {
    const input = el('input', { type: 'radio', name: 'overlay', value: c.id, disabled: c.disabled, onchange: () => setOverlay(c.id || null) });
    input.checked = (state.overlayId || '') === c.id;
    const nm = el('span', { class: 'nm', text: c.name });
    for (const b of c.badges || []) nm.append(el('span', { class: 'badge ' + b, text: b.toUpperCase() }));
    list.append(el('label', { class: 'overlay-item' + (c.disabled ? ' disabled' : '') }, input, nm, c.sub ? el('span', { class: 'sub', text: c.sub }) : null));
    sel.append(el('option', { value: c.id, text: c.name.replace(' (albedo only)', ''), disabled: c.disabled }));
  }
  sel.value = state.overlayId || '';
}

// ---------- step 1: resources ----------
// lim: {best: N} = keep the best N% of the surface in the preferred direction; {keepLow: N} / {keepHigh: N} = keep the
// lowest / highest N% regardless of preference. Percentiles are area-weighted and taken from the loaded maps.
const PRESETS = [
  { name: 'Water / volatiles', w: { h: 1, epi: 0.3 }, lim: { h: { best: 5 }, th: { keepLow: 85 } },
    note: 'Top 5% of the surface by Lunar Prospector hydrogen. Thorium-rich (KREEP) terrain is excluded because the hydrogen retrieval is not reliable there. The half-degree hydrogen map is noisy away from the poles; small isolated patches are dropped in step 4.' },
  { name: 'Ilmenite (Ti / Fe)', w: { ti: 1, fe: 0.6 }, lim: { ti: { best: 10 }, fe: { best: 25 } },
    note: 'Top 10% of the surface by TiO₂ and top 25% by FeO: high-titanium mare basalt, the classic oxygen-extraction feedstock.' },
  { name: 'KREEP / thorium', w: { th: 1, k: 0.5, sm: 0.3 }, lim: { th: { best: 10 } },
    note: 'Top 10% of the surface by thorium, ranked with potassium and samarium (KREEP tracers).' },
  { name: 'Balanced', w: { h: 0.5, ti: 0.5, fe: 0.4, th: 0.3 }, lim: { h: { best: 60 }, fe: { best: 50 } },
    note: 'A mix: above-median iron and the upper 60% of hydrogen, ranked by hydrogen, titanium, iron and thorium.' },
];
const defaultPrefer = meta => (meta.better === 'low' ? 'low' : 'high');
function limitForBest(id, pct, dir) {
  const Q = state.Q.get(id);
  if (!Q || !Q.n) return { min: null, max: null };
  return dir === 'low' ? { min: null, max: sig(Q.q(pct / 100)) } : { min: sig(Q.q(1 - pct / 100)), max: null };
}
function applyPreset(p) {
  for (const id of state.resIds) {
    const c = state.res.get(id), meta = state.layers.get(id).meta;
    c.weight = p.w[id] ?? 0; c.prefer = defaultPrefer(meta); c.min = null; c.max = null;
    const l = p.lim?.[id];
    if (l) Object.assign(c, l.best != null ? limitForBest(id, l.best, c.prefer) : l.keepLow != null ? limitForBest(id, l.keepLow, 'low') : limitForBest(id, l.keepHigh, 'high'));
  }
  state.preset = p.name;
  buildResources(); markPreset();
  recompute();
}
function markPreset() {
  for (const b of $('presets').children) b.classList.toggle('active', b.textContent === state.preset);
  $('preset-note').textContent = PRESETS.find(p => p.name === state.preset)?.note || (state.preset === null ? 'Custom criteria.' : '');
}
function buildPresets() {
  const box = $('presets'); box.textContent = '';
  for (const p of PRESETS) box.append(el('button', { text: p.name, onclick: () => applyPreset(p) }));
}
function resChanged() { if (state.preset !== null) { state.preset = null; markPreset(); } scheduleRecompute(); }
function buildResources() {
  const core = $('res-core'), more = $('res-more'); core.textContent = ''; more.textContent = '';
  let nMore = 0, moreActive = false;
  for (const id of state.resIds) {
    const layer = state.layers.get(id), meta = layer.meta, c = state.res.get(id), Q = state.Q.get(id);
    const row = el('div', { class: 'res' + (c.weight > 0 || c.min != null || c.max != null ? '' : ' off'), 'data-id': id });
    const out = el('output', { text: c.weight.toFixed(2) });
    const keeps = el('span', { class: 'keeps' });
    const upd = () => { row.classList.toggle('off', !(c.weight > 0 || c.min != null || c.max != null)); keepsText(id, keeps); };
    const slider = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: c.weight, 'aria-label': `${meta.name} weight`,
      oninput: e => { c.weight = +e.target.value; out.textContent = c.weight.toFixed(2); upd(); resChanged(); } });
    const pref = el('select', { 'aria-label': `${meta.name} prefer`, onchange: e => { c.prefer = e.target.value; resChanged(); } },
      el('option', { value: 'high', text: 'prefer high' }), el('option', { value: 'low', text: 'prefer low' }));
    pref.value = c.prefer;
    const num = key => el('input', { type: 'number', step: 'any', class: 'lim-' + key, value: c[key] ?? '', 'aria-label': `${meta.name} ${key}`,
      placeholder: `${key} ${fmt(key === 'min' ? Q.min : Q.max)}`,
      title: `Hard ${key}imum (${meta.units || 'value'}); blank = no limit. Data range on the ${state.grid.step}° grid: ${fmt(Q.min)} … ${fmt(Q.max)}${unitStr(meta)}`,
      oninput: e => { const v = parseFloat(e.target.value); c[key] = Number.isFinite(v) ? v : null; upd(); resChanged(); } });
    const minIn = num('min'), maxIn = num('max');
    const quick = pct => el('button', { class: 'q', text: pct + '%', title: `Keep the ${c.prefer === 'low' ? 'lowest' : 'highest'} ${pct}% of the lunar surface for this layer`,
      onclick: () => { Object.assign(c, limitForBest(id, pct, c.prefer)); minIn.value = c.min ?? ''; maxIn.value = c.max ?? ''; upd(); resChanged(); } });
    row.append(
      el('div', { class: 'res-head' },
        el('span', { class: 'res-name', title: meta.description || '' }, meta.name || id, ' ', el('small', { text: `${fmt(Q.min)} … ${fmt(Q.max)}${unitStr(meta)}` })),
        el('button', { class: 'eye' + (state.overlayId === id ? ' on' : ''), 'data-id': id, text: 'map', title: 'Show this map on the Moon (click again for suitability)',
          onclick: () => setOverlay(state.overlayId === id ? SUIT_ID : id) })),
      el('div', { class: 'res-w' }, el('span', { class: 'cap', text: 'weight' }), slider, out, pref),
      el('div', { class: 'res-lim' }, el('span', { class: 'cap', text: 'limits' }), minIn, el('span', { text: 'to' }), maxIn, el('span', { class: 'units', text: meta.units || '' })),
      el('div', { class: 'res-quick' }, el('span', { class: 'cap', text: 'best' }), quick(10), quick(20), quick(50),
        el('button', { class: 'q', text: 'clear', onclick: () => { c.min = c.max = null; minIn.value = maxIn.value = ''; upd(); resChanged(); } }), keeps));
    keepsText(id, keeps);
    if (CORE_IDS.includes(id)) core.append(row);
    else { more.append(row); nMore++; if (c.weight > 0 || c.min != null || c.max != null) moreActive = true; }
  }
  $('res-more-box').hidden = !nMore;
  $('res-more-count').textContent = `(${nMore})`;
  if (moreActive) $('res-more-box').open = true;
}
function keepsText(id, node) {
  const c = state.res.get(id), Q = state.Q.get(id);
  node.textContent = (c.min == null && c.max == null) ? 'no limit' : 'keeps ' + fmtPct(Q.fracBetween(c.min, c.max)) + ' of surface';
}

// ---------- frozen summaries ----------
function chipsFor(step) {
  const out = [], t = state.terrain, c = state.comms;
  if (step === 1) {
    for (const id of state.resIds) {
      const r = state.res.get(id), meta = state.layers.get(id).meta;
      if (!(r.weight > 0) && r.min == null && r.max == null) continue;
      const parts = [];
      if (r.weight > 0) parts.push(`weight ${r.weight.toFixed(2)} ${r.prefer === 'low' ? '↓ low' : '↑ high'}`);
      if (r.min != null && r.max != null) parts.push(`${fmt(r.min)} – ${fmt(r.max)}${unitStr(meta)}`);
      else if (r.min != null) parts.push(`≥ ${fmt(r.min)}${unitStr(meta)}`);
      else if (r.max != null) parts.push(`≤ ${fmt(r.max)}${unitStr(meta)}`);
      out.push({ k: shortName(meta), v: parts.join(' · '), hard: r.min != null || r.max != null });
    }
    if (!out.length) out.push({ k: 'No resource criteria', v: 'everything passes' });
  } else if (step === 2) {
    if (t.elevMin != null || t.elevMax != null) out.push({ k: 'Elevation', v: `${t.elevMin != null ? fmt(t.elevMin) : '−∞'} … ${t.elevMax != null ? fmt(t.elevMax) : '+∞'} m`, hard: true });
    else out.push({ k: 'Elevation', v: 'any' });
    out.push({ k: 'Regional slope', v: (t.slopeOn ? `≤ ${t.slopeMax}°` : 'no limit') + (t.slopeWeight > 0 ? ` · weight ${t.slopeWeight.toFixed(2)}` : ''), hard: t.slopeOn });
    if (t.latMin > -90 || t.latMax < 90) out.push({ k: 'Latitude', v: `${Math.min(t.latMin, t.latMax)}° … ${Math.max(t.latMin, t.latMax)}°`, hard: true });
  } else {
    out.push({ k: 'Link', v: commsModeText() + (Number.isFinite(c.state?.maskDeg) ? ` · mask ${c.state.maskDeg}°` : '') });
    out.push({ k: 'Availability', v: (c.minAvail > 0 ? `≥ ${(c.minAvail * 100).toFixed(0)}% of the time` : 'no minimum') + (c.weight > 0 ? ` · weight ${c.weight.toFixed(2)}` : ''), hard: c.minAvail > 0 });
    if (!state.G.has(COMMS_ID)) out.push({ k: 'Comms model', v: 'unavailable — not applied' });
  }
  return out;
}
function renderSummaries() {
  for (const box of document.querySelectorAll('.frozen')) {
    const s = +box.dataset.sum;
    box.textContent = '';
    box.append(el('div', { class: 'frozen-head' },
      el('span', { text: `Step ${s} · ${STEP_NAMES[s]}` }), el('span', { class: 'lock', text: 'fixed' }),
      el('span', { class: 'frozen-area', text: 'leaves ' + fmtPct(state.km2[s] / SPHERE_KM2) }),
      el('a', { href: '#', class: 'edit', text: 'edit', onclick: e => { e.preventDefault(); goStep(s); } })));
    const chips = el('div', { class: 'chips' });
    for (const c of chipsFor(s)) chips.append(el('span', { class: 'chip' + (c.hard ? ' hard' : '') }, el('b', { text: c.k }), ' ', c.v));
    box.append(chips);
  }
}

// ---------- area readout + funnel ----------
function renderFunnel() {
  const k = state.km2, st = stage(), s = state.sel;
  const atAreas = state.step >= 4;
  const cur = atAreas ? s.km2 : k[st];
  document.querySelector('#area-box .area-cap').textContent = atAreas ? 'Matching areas' : 'Suitable area';
  $('area-pct').textContent = fmtPct(cur / SPHERE_KM2);
  $('area-km2').textContent = fmtKm2(cur) + (atAreas ? '' : ' of the Moon');
  const box = $('funnel'); box.textContent = '';
  const items = [['All', k[0], 0], ['Resources', k[1], 1], ['Terrain', k[2], 2], ['Comms', k[3], 3]];
  if (state.maxStep >= 4) items.push(['Areas', s.km2, 4]);
  items.forEach(([name, v, i], n) => {
    const reached = i <= Math.max(state.maxStep, 1), f = v / SPHERE_KM2;
    if (n) box.append(el('span', { class: 'f-arrow', text: '›' }));
    const fill = el('i'); fill.style.height = reached ? Math.max(f > 0 ? 4 : 0, f * 100) + '%' : '0%';
    box.append(el('div', { class: 'f-item' + (reached ? '' : ' pending') + (i === (atAreas ? 4 : st) ? ' cur' : ''), title: reached ? `${name}: ${fmtPct(f)} of the lunar surface (${fmtKm2(v)})` : `${name}: not set yet` },
      el('div', { class: 'f-bar' }, fill),
      el('div', { class: 'f-txt' }, el('span', { class: 'f-pct', text: reached ? (f >= 0.0995 || f === 0 ? (f * 100).toFixed(0) : f >= 0.00995 ? (f * 100).toFixed(1) : (f * 100).toFixed(2)) + '%' : '·' }), el('span', { class: 'f-name', text: name }))));
  });
}
function renderKeeps() {
  const t = state.terrain, Qe = state.Q.get('elev'), Qs = state.Q.get(SLOPE_ID), Qc = state.Q.get(COMMS_ID);
  $('elev-keeps').textContent = Qe ? ((t.elevMin == null && t.elevMax == null) ? 'No elevation limit.' : `Elevation limit alone keeps ${fmtPct(Qe.fracBetween(t.elevMin, t.elevMax))} of the surface.`) : 'Elevation layer unavailable.';
  $('slope-keeps').textContent = Qs ? (t.slopeOn ? `Slope limit alone keeps ${fmtPct(Qs.fracBetween(null, t.slopeMax))} of the surface.` : 'No slope limit.') : 'Slope unavailable (no elevation layer).';
  $('avail-keeps').textContent = Qc ? (state.comms.minAvail > 0 ? `Availability limit alone keeps ${fmtPct(Qc.fracBetween(state.comms.minAvail, null))} of the surface. ` : 'No minimum. ') +
    `${commsModeText()}: availability ranges ${(Qc.min * 100).toFixed(0)}–${(Qc.max * 100).toFixed(0)}% over the Moon.` : '';
}
function renderStepMessages() {
  const k = state.km2, anyW = state.resIds.some(id => state.res.get(id).weight > 0);
  $('msg-1').textContent = !(k[1] > 0) ? 'No part of the Moon passes these resource limits — relax a min/max.' : !anyW ? 'No resource has a weight yet: every passing cell ranks equally. Give at least one a weight to rank areas.' : '';
  $('msg-2').textContent = k[1] > 0 && !(k[2] > 0) ? 'The terrain limits remove everything that passed step 1 — relax elevation, slope or the latitude band.' : '';
  const c = state.comms;
  $('msg-3').textContent = c.error ? `Comms model unavailable (js/comms.js): ${c.error}. The comms limit is not applied.`
    : c.fallback ? 'js/comms.js does not provide commsAvailability() — using its Earth-visibility model (direct-to-Earth only); the relay choice has no effect on the map.'
    : k[2] > 0 && !(k[3] > 0) ? `No suitable area has this link availability${state.Q.get(COMMS_ID) ? ` (the best anywhere with this link is ${(state.Q.get(COMMS_ID).max * 100).toFixed(0)}% of the time)` : ''} — lower the minimum, or choose another link in the menu on the right.` : '';
}

// ---------- steps / navigation ----------
function canEnter(n) {
  if (!state.ready) return n === 1;
  if (n >= 5) return state.sel.selected >= 0 && state.sel.areas.length > 0;
  return true;
}
function updateNav() {
  for (const b of document.querySelectorAll('#stepper button')) {
    const n = +b.dataset.step;
    b.classList.toggle('cur', n === state.step);
    b.classList.toggle('done', n < state.step || (n <= state.maxStep && n !== state.step));
    b.disabled = !(n <= state.maxStep && canEnter(n)) && n !== state.step;
  }
  const back = $('back'), next = $('next');
  back.disabled = state.step === 1;
  next.hidden = state.step === 6;
  next.textContent = `Next: ${STEP_NAMES[state.step + 1] || ''} →`;
  next.disabled = !state.ready || (state.step === 4 && !canEnter(5));
  next.title = state.step === 4 && !canEnter(5) ? 'Select an area first' : '';
}
function goStep(n) {
  n = clamp(n, 1, 6);
  if (n >= 5 && !canEnter(5)) return;
  const prev = state.step;
  if (n >= 5 && prev <= 4) captureSiteImage();
  state.step = n; state.maxStep = Math.max(state.maxStep, n);
  document.body.dataset.step = n;
  for (let i = 1; i <= 4; i++) $('panel-' + i).hidden = i !== n;
  $('comms-col').hidden = n !== 3;
  $('app').hidden = n >= 5; $('power').hidden = n !== 5; $('mission').hidden = n !== 6;
  $('sidebar').scrollTop = 0;
  if (n === 5) { renderFunnel(); updateNav(); enterPower(); return; }
  if (n === 6) { renderFunnel(); updateNav(); enterMission(); return; }
  if (n === 3) ensureCommsMenu();
  // steps 1, 3 and 4 open on the suitability / areas view; step 2 keeps whatever overlay the user picked
  if (n !== 2 && (n !== prev || n === 4) && state.overlayId !== SUIT_ID) setOverlay(SUIT_ID);
  recompute();
  resize();
}

// ---------- step 3: comms menu ----------
let commsMenuDone = false;
const getSite = () => state.pinned ? { lat: state.pinned.lat, lon: state.pinned.lon, label: fmtLatLon(state.pinned.lat, state.pinned.lon) } : null;
function onCommsChange(ns) {
  if (!ns || typeof ns !== 'object') return;
  state.comms.state = { ...ns };
  renderSummaries();
  computeCommsGrid();
}
async function ensureCommsMenu() {
  if (commsMenuDone) return;
  commsMenuDone = true;
  const box = $('comms-menu');
  try {
    const mod = await commsModule();
    if (typeof mod.renderCommsMenu !== 'function') throw new Error('js/comms.js does not export renderCommsMenu()');
    box.textContent = '';
    mod.renderCommsMenu(box, { ...state.comms.state }, onCommsChange, getSite);
  } catch (e) {
    console.warn('[comms] menu failed', e);
    paneErr(box, 'Comms menu (js/comms.js)', e);
  }
}

// ---------- steps 5–6: power, mission, design report ----------
const design = { siteImage: null, power: null, mission: null };
function selectedSite() {
  const a = state.sel.areas[state.sel.selected];
  return a ? { a, site: { lat: a.best.lat, lon: a.best.lon, label: `Area ${a.id} — ${fmtLatLon(a.best.lat, a.best.lon, 1)}`, areaKm2: a.areaKm2 } } : null;
}
function captureSiteImage() {              // the globe as the user left it in step 4, for the PDF report
  try { renderer.render(scene, camera); design.siteImage = { url: canvas.toDataURL('image/jpeg', 0.85), w: canvas.width, h: canvas.height }; }
  catch { design.siteImage = null; }
}
function stepFallback(box, title, what, e, site) {
  box.textContent = '';
  box.append(el('div', { class: 'mission-fallback' },
    el('h2', { text: title }),
    el('p', { text: `Selected site: ${site.label} (area ${fmtKm2(site.areaKm2)}).` }),
    el('div', { class: 'pane-error', text: `${what} is unavailable:\n${e?.stack || e?.message || e}` }),
    el('button', { text: '← Back to site selection', onclick: () => goStep(4) })));
}
let powerKey = null;
async function enterPower() {
  const sel = selectedSite();
  if (!sel) { goStep(4); return; }
  const key = JSON.stringify(sel.site), box = $('power');
  if (powerKey === key && box.firstChild) return;      // same site: keep the user's power settings
  powerKey = key; design.power = null; design.mission = null;
  box.textContent = '';
  const host = el('div', { class: 'power-host' });
  box.append(host);
  try {
    const mod = await import('./power.js');
    await mod.renderPower(host, { site: sel.site, onChange: p => { design.power = p; }, onBack: () => goStep(4), onNext: () => goStep(6) });
  } catch (e) {
    console.warn('[power] failed', e);
    powerKey = null;
    stepFallback(box, 'Surface power', 'Power estimate (js/power.js)', e, sel.site);
  }
}
let missionKey = null;
async function enterMission() {
  const sel = selectedSite();
  if (!sel) { goStep(4); return; }
  const site = sel.site, p = design.power;
  const power = p && Number.isFinite(p.systemMassKg) ? { systemMassKg: p.systemMassKg, systemText: p.systemText } : null;
  const key = JSON.stringify({ site, power: power ? Math.round(power.systemMassKg) : 0 });
  const box = $('mission');
  if (missionKey === key && box.firstChild) return; // same site and power system: keep whatever the user set up there
  missionKey = key;
  box.textContent = '';
  const host = el('div', { class: 'mission-host' });
  box.append(host);
  try {
    const mod = await import('./mission.js');
    if (typeof mod.renderMission !== 'function') throw new Error('js/mission.js does not export renderMission()');
    await mod.renderMission(host, { site, power, onBack: () => goStep(5), onChange: m => { design.mission = m; }, onReport: downloadReport });
  } catch (e) {
    console.warn('[mission] failed', e);
    missionKey = null;
    stepFallback(box, 'Mission planning', 'Mission planner (js/mission.js)', e, site);
  }
}

// Everything chosen in this run, as plain data for js/report.js.
async function buildDesign() {
  const sel = selectedSite();
  if (!sel) throw new Error('No site selected');
  const { a, site } = sel, s = state.sel, t = state.terrain, c = state.comms, k = state.km2;
  const meanOf = id => a.means?.find(m => m.id === id)?.v;
  const at = id => { const g = state.G.get(id); return g ? g[a.best.index] : NaN; };
  const now = new Date(), pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let link = null, relayName = null;
  try {
    const mod = await commsModule();
    if (typeof mod.linkTimes === 'function') link = mod.linkTimes(site.lat, site.lon, c.state);
    if (c.state?.mode === 'relay') relayName = c.presets.find(p => p.id === c.state.relayId)?.name || c.state.relayId;
  } catch (e) { console.warn('[report] link times unavailable', e); }
  return {
    app: { name: 'LODESTAR', full: 'Lunar Outpost Decision Engine for Site Targeting And Reachability' },
    iteration: { id: `LODESTAR-${stamp}`, created: now.toISOString(), createdLocal: now.toLocaleString() },
    demo: !!state.manifest?.demo,
    site, siteImage: design.siteImage,
    area: { id: a.id, rank: s.selected + 1, areaKm2: a.areaKm2, nCells: a.nCells, centroid: a.centroid, best: { lat: a.best.lat, lon: a.best.lon, score: a.best.score },
      meanScore: a.meanScore, bbox: a.bbox },
    selection: { keepPct: s.keepPct, minAreaKm2: s.minAreaKm2, nAreas: s.areas.length, totalKm2: s.km2, gridStepDeg: state.grid.step, scoreThreshold: s.thr },
    funnel: [['Whole Moon', k[0]], ['After resource limits', k[1]], ['After terrain limits', k[2]], ['After comms limit', k[3]], ['In the matching areas', s.km2]]
      .map(([name, km2]) => ({ name, km2, frac: km2 / SPHERE_KM2 })),
    resources: state.resIds.map(id => ({ id, r: state.res.get(id), meta: state.layers.get(id).meta }))
      .filter(x => x.r.weight > 0 || x.r.min != null || x.r.max != null)
      .map(({ id, r, meta }) => ({ id, name: meta.name || id, units: meta.units || '', mission: meta.mission || '', weight: r.weight, prefer: r.prefer, min: r.min, max: r.max,
        areaMean: meanOf(id), bestCell: at(id) })),
    terrain: { elevMin: t.elevMin, elevMax: t.elevMax, slopeOn: t.slopeOn, slopeMax: t.slopeMax, slopeWeight: t.slopeWeight, latMin: Math.min(t.latMin, t.latMax), latMax: Math.max(t.latMin, t.latMax),
      elevMean: meanOf('elev'), slopeMean: meanOf(SLOPE_ID), elevBest: at('elev'), slopeBest: at(SLOPE_ID) },
    comms: { modeText: commsModeText(), mode: c.state?.mode, relayName, dsnDishM: c.state?.dsnDishM, band: c.state?.band, maskDeg: c.state?.maskDeg,
      minAvail: c.minAvail, weight: c.weight, availMean: meanOf(COMMS_ID), availBest: at(COMMS_ID), link, applied: state.G.has(COMMS_ID) },
    power: design.power, mission: design.mission,
    sources: (state.manifest?.layers || []).filter(l => state.layers.has(l.id)).map(l => ({ name: l.name, mission: l.mission, agency: l.agency, units: l.units, source: l.source, demo: !!l.demo })),
    albedo: state.manifest?.albedo_info || null,
  };
}
async function downloadReport() {
  const d = await buildDesign();
  const mod = await import('./report.js');
  return mod.generateReport(d);
}

// ---------- picking / readout ----------
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  let hit = raycaster.intersectObject(moon, false)[0];
  if (!hit) { // a ray exactly through a mesh vertex / edge can miss every triangle: nudge it by a fraction of a pixel
    ndc.x += 0.5 / r.width; ndc.y += 0.5 / r.height;
    raycaster.setFromCamera(ndc, camera);
    hit = raycaster.intersectObject(moon, false)[0];
  }
  return hit ? latLonFromVec(hit.point) : null;
}
function showReadout(p, pinned) {
  const box = $('readout'); box.textContent = '';
  if (!p) { box.append(el('div', { class: 'muted', text: 'Hover the globe for values; click to pin a point.' })); return; }
  box.append(el('div', { class: 'pos' }, `lat ${p.lat.toFixed(2)}°, lon ${p.lon.toFixed(2)}°  (${fmtLatLon(p.lat, p.lon)})`, pinned ? el('span', { class: 'pin', text: 'pinned' }) : null));
  if (!state.ready) return;
  const tb = el('table'), k = gridIndex(p.lat, p.lon);
  const ids = activeLayerIds();
  if (state.overlayId && state.overlayId !== SUIT_ID && !ids.includes(state.overlayId)) ids.unshift(state.overlayId);
  for (const id of ids) {
    const v = id === COMMS_ID ? state.G.get(COMMS_ID)[k] : sample(state.layers.get(id), p.lat, p.lon);
    tb.append(el('tr', {}, el('td', { text: shortName(layerMeta(id)) }), el('td', { text: Number.isFinite(v) ? fmtVal(id, v) : 'no data' })));
  }
  const sc = state.score?.[k];
  tb.append(el('tr', {}, el('td', { text: 'Score' }), el('td', { text: Number.isFinite(sc) ? sc.toFixed(3) : '—' })));
  box.append(tb);
  const names = ['', 'resources', 'terrain', 'comms'], pass = el('div', { class: 'passline' });
  for (let s = 1; s <= Math.min(3, Math.max(state.step, 1)); s++) {
    // each stage mask includes the earlier ones, so report the first failing stage as ✗ and later ones as n/a
    const ok = state.masks[s]?.[k], prevOk = s === 1 || state.masks[s - 1]?.[k];
    pass.append(el('span', { class: ok ? 'ok' : prevOk ? 'no' : 'na', text: `${ok ? '✓' : prevOk ? '✗' : '–'} ${names[s]}` }));
  }
  if (state.step === 4 && state.sel.labels) {
    const l = state.sel.labels[k];
    pass.append(el('span', { class: l >= 0 ? 'ok' : 'na', text: l >= 0 ? `in Area ${state.sel.areas[l].id}` : 'not in an area' }));
  }
  box.append(pass);
}
function pin(lat, lon, doFly = false) {
  state.pinned = { lat, lon };
  buildMarkers(); showReadout(state.pinned, true);
  try { $('comms-menu').__refresh?.(); } catch (e) { console.warn('[comms] __refresh failed', e); }
  if (doFly) flyTo(lat, lon);
}
let hoverEv = null, hoverQueued = false, down = null;
canvas.addEventListener('pointermove', ev => {
  hoverEv = ev;
  if (hoverQueued || ev.buttons) return;
  hoverQueued = true;
  requestAnimationFrame(() => { hoverQueued = false; const p = pick(hoverEv); showReadout(p || state.pinned, !p && !!state.pinned); });
});
canvas.addEventListener('pointerleave', () => showReadout(state.pinned, !!state.pinned));
canvas.addEventListener('pointerdown', ev => { down = { x: ev.clientX, y: ev.clientY }; fly = null; });
canvas.addEventListener('pointerup', ev => {
  if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4) return;
  const p = pick(ev);
  if (!p) return;
  pin(p.lat, p.lon);
  if (state.step === 4 && state.sel.labels) {
    const l = state.sel.labels[gridIndex(p.lat, p.lon)];
    if (l >= 0) selectArea(l, { scroll: true });
  }
});

// ---------- regional modal (existing three tabs) ----------
let region = null; // {box, lat, lon, done:Set}
const paneErr = (pane, what, e) => { pane.textContent = ''; pane.append(el('div', { class: 'pane-error', text: `${what} is unavailable:\n${e?.stack || e?.message || e}` })); };
async function renderTab(tab) {
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.tab === tab);
  for (const t of ['region', 'comms', 'deltav']) $('pane-' + t).hidden = t !== tab;
  if (!region || region.done.has(tab)) return;
  region.done.add(tab);
  const pane = $('pane-' + tab), mine = region;
  pane.textContent = '';
  const div = el('div'); pane.append(div);
  try {
    if (tab === 'region') {
      const weights = {};
      for (const id of state.resIds) { const c = state.res.get(id); weights[id] = { weight: c.weight, prefer: c.prefer }; }
      const { renderRegion } = await import('./region.js');
      await renderRegion(div, { ...mine.box }, { manifest: state.manifest, weights });
    } else if (tab === 'comms') {
      const { renderCommsPanel } = await import('./comms.js');
      await renderCommsPanel(div, mine.lat, mine.lon);
    } else {
      const { renderDeltaVPanel } = await import('./deltav.js');
      await renderDeltaVPanel(div, mine.lat, mine.lon);
    }
  } catch (e) {
    console.warn(`[${tab}] panel failed`, e);
    paneErr(pane, { region: 'Region analysis (js/region.js)', comms: 'Earth comms panel (js/comms.js)', deltav: 'Delta-V panel (js/deltav.js)' }[tab], e);
  }
}
function openAreaModal() {
  const a = state.sel.areas[state.sel.selected];
  if (!a) return;
  const { box, clamped } = areaBox(a);
  region = { box, lat: a.best.lat, lon: a.best.lon, done: new Set() };
  $('modal-title').textContent = `Area ${a.id} — lat ${box.latMin}…${box.latMax}°, lon ${box.lonMin}…${box.lonMax}°` +
    (clamped ? ' (area is larger: showing 30° × 40° around its best cell)' : '') + ` · comms / delta-V at ${fmtLatLon(a.best.lat, a.best.lon, 1)}`;
  for (const t of ['region', 'comms', 'deltav']) $('pane-' + t).textContent = '';
  $('modal').hidden = false;
  renderTab('region');
}
function closeModal() { $('modal').hidden = true; region = null; }

// ---------- data sources ----------
function buildSources() {
  const box = $('sources'); box.textContent = '';
  const add = (meta, ok = true) => {
    const head = el('div', {}, el('b', { text: meta.name || meta.id }));
    if (isDemo(meta)) head.append(el('span', { class: 'badge demo', text: 'SYNTHETIC DEMO' }));
    if (meta.derived) head.append(el('span', { class: 'badge derived', text: 'DERIVED' }));
    const d = el('div', { class: 'src' }, head,
      el('div', { text: [meta.mission, meta.agency].filter(Boolean).join(' — ') + (meta.units ? ` · units: ${meta.units}` : '') }),
      meta.description ? el('div', { text: meta.description }) : null);
    if (meta.source) d.append(el('div', {}, el('a', { href: meta.source, target: '_blank', rel: 'noopener', text: meta.source })));
    if (!ok) d.append(el('div', { class: 'error', text: 'Failed to load this layer.' }));
    box.append(d);
  };
  const m = state.manifest;
  if (m.demo) box.append(el('div', { class: 'error', text: 'All layers below are synthetic placeholders, not real measurements.' }));
  if (m.albedo_info) add({ name: 'Surface image (albedo)', ...m.albedo_info });
  for (const meta of m.layers) add(meta, state.layers.has(meta.id));
  if (state.layers.has(SLOPE_ID)) add(state.layers.get(SLOPE_ID).meta);
  add({ name: 'Link availability (comms)', derived: true, mission: 'Geometric model in js/comms.js', units: 'fraction of time',
    description: 'Long-run fraction of time a link to Earth exists (direct-to-Earth with lunar libration, or through the chosen relay orbiter). A model estimate, not a measurement; local terrain horizons are not included.' });
}

// ---------- wiring ----------
$('exag').addEventListener('input', e => {
  state.exag = +e.target.value; $('exag-out').textContent = state.exag + '×';
  applyDisplacement(); rebuildDecorations();
});
$('sun').addEventListener('input', e => { setSun(+e.target.value); $('sun-out').textContent = e.target.value + '°'; });
$('graticule').addEventListener('change', e => { graticule.visible = e.target.checked; });
$('opacity').addEventListener('input', e => {
  state.opacity = +e.target.value; overlayMat.opacity = state.opacity; $('opacity-out').textContent = Math.round(state.opacity * 100) + '%';
});
const resetView = () => { fly = null; camera.position.set(0, 0, 4.4); controls.update(); };
$('reset-view').addEventListener('click', resetView);
for (const b of document.querySelectorAll('#view-btns button')) b.addEventListener('click', () => {
  if (b.dataset.view === 'best') { // turn to the best-scoring cell that still passes
    const sc = state.step === 4 ? state.scoreFull : state.score, g = state.grid;
    let bk = -1, bs = -Infinity;
    if (sc) for (let k = 0; k < sc.length; k++) if (sc[k] > bs && (state.step !== 4 || !state.sel.labels || state.sel.labels[k] >= 0)) { bs = sc[k]; bk = k; }
    if (bk >= 0) flyTo(g.lat(Math.floor(bk / g.nLon)), g.lon(bk % g.nLon), 3.2);
    return;
  }
  const [lat, lon] = b.dataset.view.split(',').map(Number);
  flyTo(lat, lon, 4.4);
});
$('overlay-select').addEventListener('change', e => setOverlay(e.target.value || null));
$('grid-step').addEventListener('change', e => {
  if (!state.ready) return;
  state.grid = makeGrid(parseFloat(e.target.value) || 1);
  $('grid-txt').textContent = state.grid.step + '°';
  state.sel.areas = []; state.sel.labels = null; state.sel.selected = -1;
  buildGridData(); buildResources(); recompute(); computeCommsGrid();
});
// step 2
const numOrNull = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
$('elev-min').addEventListener('input', e => { state.terrain.elevMin = numOrNull(e.target.value); scheduleRecompute(); });
$('elev-max').addEventListener('input', e => { state.terrain.elevMax = numOrNull(e.target.value); scheduleRecompute(); });
$('slope-max').addEventListener('input', e => { state.terrain.slopeMax = +e.target.value; $('slope-max-out').textContent = '≤ ' + state.terrain.slopeMax + '°'; scheduleRecompute(); });
$('slope-on').addEventListener('change', e => { state.terrain.slopeOn = e.target.checked; $('slope-max').disabled = !e.target.checked; scheduleRecompute(0); });
$('slope-w').addEventListener('input', e => { state.terrain.slopeWeight = +e.target.value; $('slope-w-out').textContent = state.terrain.slopeWeight.toFixed(2); scheduleRecompute(); });
$('lat-lo').addEventListener('input', e => { const v = numOrNull(e.target.value); state.terrain.latMin = v == null ? -90 : clamp(v, -90, 90); scheduleRecompute(); });
$('lat-hi').addEventListener('input', e => { const v = numOrNull(e.target.value); state.terrain.latMax = v == null ? 90 : clamp(v, -90, 90); scheduleRecompute(); });
// step 3
$('avail-min').addEventListener('input', e => { state.comms.minAvail = +e.target.value; $('avail-out').textContent = state.comms.minAvail > 0 ? '≥ ' + (state.comms.minAvail * 100).toFixed(0) + '%' : 'none'; scheduleRecompute(); });
$('avail-w').addEventListener('input', e => { state.comms.weight = +e.target.value; $('avail-w-out').textContent = state.comms.weight.toFixed(2); scheduleRecompute(); });
// step 4
$('keep').addEventListener('input', e => { state.sel.keepPct = +e.target.value; $('keep-out').textContent = state.sel.keepPct + '%'; scheduleRecompute(); });
$('minarea').addEventListener('input', e => { state.sel.minAreaKm2 = +e.target.value; $('minarea-out').textContent = fmtKm2(state.sel.minAreaKm2); scheduleRecompute(); });
$('area-sort').addEventListener('change', e => { state.sel.sortBy = e.target.value; scheduleRecompute(0); });
$('analyse').addEventListener('click', openAreaModal);
$('to-mission').addEventListener('click', () => goStep(5));
// navigation
$('back').addEventListener('click', () => goStep(state.step - 1));
$('next').addEventListener('click', () => goStep(state.step + 1));
$('stepper').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) goStep(+b.dataset.step); });
// modal
$('tabs').addEventListener('click', e => { const t = e.target.closest('button')?.dataset.tab; if (t) renderTab(t); });
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('pointerdown', e => { if (e.target === $('modal')) closeModal(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

function syncControls() {
  const t = state.terrain, c = state.comms, s = state.sel;
  $('slope-max').value = t.slopeMax; $('slope-max-out').textContent = '≤ ' + t.slopeMax + '°';
  $('slope-on').checked = t.slopeOn; $('slope-w').value = t.slopeWeight; $('slope-w-out').textContent = t.slopeWeight.toFixed(2);
  $('avail-min').value = c.minAvail; $('avail-out').textContent = c.minAvail > 0 ? '≥ ' + (c.minAvail * 100).toFixed(0) + '%' : 'none';
  $('avail-w').value = c.weight; $('avail-w-out').textContent = c.weight.toFixed(2);
  $('keep').value = s.keepPct; $('keep-out').textContent = s.keepPct + '%';
  $('minarea').value = s.minAreaKm2; $('minarea-out').textContent = fmtKm2(s.minAreaKm2);
  const Qe = state.Q.get('elev'), Qs = state.Q.get(SLOPE_ID);
  if (Qe) {
    $('elev-range').textContent = `data ${fmt(Qe.min)} … ${fmt(Qe.max)} m`;
    $('elev-min').placeholder = 'min ' + fmt(Qe.min); $('elev-max').placeholder = 'max ' + fmt(Qe.max);
  }
  if (Qs) $('slope-range').textContent = `data ${fmt(Qs.min)} … ${fmt(Qs.max)}° (median ${fmt(Qs.q(0.5))}°)`;
}

async function init() {
  resize();
  requestAnimationFrame(tick);
  updateNav();
  let manifest;
  try { manifest = await loadManifest(); }
  catch (e) {
    setStatus('Could not load data/manifest.json — run tools/make_demo_data.py or tools/fetch_data.py first. (' + e.message + ')', true);
    buildGraticule();
    return;
  }
  state.manifest = manifest;
  manifest.layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  $('demo-banner').hidden = !manifest.demo;
  resize();

  if (manifest.albedo) {
    new THREE.TextureLoader().load(manifest.albedo, tex => {
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      moonMat.map = tex; moonMat.color.set(0xffffff); moonMat.needsUpdate = true;
    }, undefined, () => { state.failed.push({ id: 'albedo', error: 'image failed to load' }); reportStatus(); });
  }

  setStatus(`Loading ${manifest.layers.length} layers…`);
  const res = await Promise.allSettled(manifest.layers.map(m => loadLayer(m.id)));
  res.forEach((r, i) => {
    const id = manifest.layers[i].id;
    if (r.status === 'fulfilled') state.layers.set(id, r.value);
    else state.failed.push({ id, error: r.reason?.message || String(r.reason) });
  });
  const elev = state.layers.get('elev');
  if (elev) {
    try { state.layers.set(SLOPE_ID, makeSlopeLayer(elev)); }
    catch (e) { state.failed.push({ id: SLOPE_ID, error: e.message }); }
  } else state.failed.push({ id: SLOPE_ID, error: 'no elev layer' });

  const ids = manifest.layers.map(m => m.id).filter(id => id !== 'elev' && state.layers.has(id));
  state.resIds = [...CORE_IDS.filter(id => ids.includes(id)), ...ids.filter(id => !CORE_IDS.includes(id))];
  for (const id of state.resIds) state.res.set(id, { weight: 0, prefer: defaultPrefer(state.layers.get(id).meta), min: null, max: null });

  buildGridData();
  // default slope limit: the area-weighted 90th percentile of the regional slope, to the nearest 0.5°
  const Qs = state.Q.get(SLOPE_ID);
  if (Qs?.n) state.terrain.slopeMax = clamp(Math.round(Qs.q(0.9) * 2) / 2, 0.5, 20); else state.terrain.slopeOn = false;

  sampleVertexElevation(); applyDisplacement(); buildGraticule();
  state.ready = true;
  syncControls(); buildOverlayOptions(); buildPresets(); buildSources();
  applyPreset(PRESETS[PRESETS.length - 1]);   // also runs the first recompute
  setOverlay(SUIT_ID);
  goStep(1);
  reportStatus();
  computeCommsGrid();   // async; refreshes the masks when the availability grid is ready
}
function reportStatus() {
  const n = state.manifest.layers.filter(m => state.layers.has(m.id)).length;
  const msg = `${n}/${state.manifest.layers.length} data layers loaded` + (state.manifest.demo ? ' (synthetic demo data)' : ' · NASA LRO + Lunar Prospector') +
    (state.failed.length ? ' — problems: ' + state.failed.map(f => `${f.id} (${f.error})`).join('; ') : '');
  setStatus(msg, state.failed.length > 0);
}

// test/debug hook
window.__lsn = { state, camera, pin, flyTo, setOverlay, surfacePoint, meshPoint, dirFromLatLon, pick, goStep, recompute, selectArea, applyPreset, PRESETS, gridIndex };

init().catch(e => { console.error(e); setStatus('Startup failed: ' + (e?.message || e), true); });

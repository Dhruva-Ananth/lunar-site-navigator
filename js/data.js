// Shared data access for the Lunar Site Navigator. See CONTRACT.md.
let _manifest = null;
const _cache = new Map();

export const MOON_RADIUS_KM = 1737.4;

export async function loadManifest() {
  if (_manifest) return _manifest;
  const r = await fetch('data/manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('Cannot load data/manifest.json');
  _manifest = await r.json();
  return _manifest;
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('Cannot load ' + url));
    im.src = url;
  });
}

// Returns {id, meta, width, height, min, max, data: Float32Array} with NaN for no-data.
export async function loadLayer(id, { hires = false } = {}) {
  const m = await loadManifest();
  const meta = m.layers.find(l => l.id === id);
  if (!meta) throw new Error('Unknown layer ' + id);
  const src = hires && meta.hires ? meta.hires : meta;
  const key = id + (hires && meta.hires ? ':hi' : '');
  if (_cache.has(key)) return _cache.get(key);
  const p = (async () => {
    const im = await loadImage(src.file);
    const w = im.naturalWidth, h = im.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(im, 0, 0);
    const px = g.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    const span = src.max - src.min;
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = px[j + 3] < 128 ? NaN : src.min + ((px[j] * 256 + px[j + 1]) / 65535) * span;
    }
    return { id, meta, width: w, height: h, min: src.min, max: src.max, data: out };
  })();
  _cache.set(key, p);
  return p;
}

// Fractional pixel coordinates of a lat/lon (pixel centres; lon -180 at left, lat +90 at top).
export function latLonToXY(layer, lat, lon) {
  let l = ((lon + 180) % 360 + 360) % 360; // 0..360
  return { x: (l / 360) * layer.width - 0.5, y: ((90 - lat) / 180) * layer.height - 0.5 };
}

// Bilinear sample; wraps in longitude, clamps in latitude; ignores NaN neighbours.
export function sample(layer, lat, lon) {
  const { x, y } = latLonToXY(layer, lat, lon);
  const w = layer.width, h = layer.height;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let sum = 0, wt = 0;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const xi = ((x0 + dx) % w + w) % w;
    const yi = Math.min(h - 1, Math.max(0, y0 + dy));
    const v = layer.data[yi * w + xi];
    if (Number.isNaN(v)) continue;
    const k = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    sum += v * k; wt += k;
  }
  return wt > 0 ? sum / wt : NaN;
}

// Perceptual colour ramps. t in 0..1 → [r,g,b] 0..255.
const RAMPS = {
  viridis: [[68,1,84],[72,40,120],[62,74,137],[49,104,142],[38,130,142],[31,158,137],[53,183,121],[109,205,89],[180,222,44],[253,231,37]],
  magma: [[0,0,4],[28,16,68],[79,18,123],[129,37,129],[181,54,122],[229,80,100],[251,135,97],[254,194,135],[252,253,191]],
  terrain: [[40,60,130],[60,120,170],[90,160,140],[150,180,110],[210,200,130],[190,150,100],[160,110,90],[230,230,230]],
};
export function colormap(t, name = 'viridis') {
  const r = RAMPS[name] || RAMPS.viridis;
  if (!(t >= 0)) t = 0; if (t > 1) t = 1;
  const f = t * (r.length - 1), i = Math.min(r.length - 2, Math.floor(f)), k = f - i;
  return [0, 1, 2].map(c => Math.round(r[i][c] + (r[i + 1][c] - r[i][c]) * k));
}

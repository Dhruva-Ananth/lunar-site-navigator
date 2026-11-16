// Step 5 — MISSION: landed mass, launch vehicle and orbital configuration for the selected landing site.
// First-order estimates for COMPARING options, not mission design. Delta-V physics is reused from deltav.js
// (computeDeltaV); this module only adds the rocket-equation mass bookkeeping, the launcher comparison
// (data: assets/launchers.json, every figure sourced / flagged there) and the Earth–Moon schematic.

import { computeDeltaV, DEFAULTS } from './deltav.js';

const DEG = Math.PI / 180, TAU = Math.PI * 2;
const G0 = 9.80665e-3;                                   // km/s^2
const DATA_URL = new URL('../assets/launchers.json', import.meta.url);
const siteUrl = p => new URL('../' + String(p).replace(/^\.?\//, ''), import.meta.url).href;

const CFG = {
  llo: { tag: 'A', short: 'Low lunar orbit, then descent' },
  direct: { tag: 'B', short: 'Direct descent' },
  nrho: { tag: 'C', short: 'Via NRHO, then LLO and descent' },
  blt: { tag: 'D', short: 'Low-energy ballistic transfer' },
};
const MASS_PICKS = [                                     // generic round numbers, not specific vehicles
  { kg: 500, label: 'Small robotic lander' },
  { kg: 2000, label: 'Mid-size robotic lander' },
  { kg: 5000, label: 'Large cargo lander' },
  { kg: 15000, label: 'Crewed-class lander' },
];
const BLT_DERATE_PER_KMS = 0.45;   // launcher TLI capability lost per km/s of extra injection delta-V (approx., ≈3% per 65 m/s)

// ---------------------------------------------------------------------------------------------
// Pure maths (no DOM) — exported so it can be checked independently
// ---------------------------------------------------------------------------------------------

/** Ideal rocket equation over the legs after TLI (and optionally TLI itself) at one Isp. Masses in kg. */
export function missionMasses(landedKg, ispS, opt) {
  const ve = G0 * ispS;                                  // km/s
  const tliDv = opt.legs[0].dv;                          // injection burn of this configuration
  const mTli = landedKg * Math.exp(opt.afterTli / ve);   // mass that must be injected towards the Moon
  const mLeo = mTli * Math.exp(tliDv / ve);              // if the same stage also had to fly TLI from LEO
  return { ve, tliDv, mTli, mLeo, propAfterTli: mTli - landedKg };
}

/**
 * Can launcher L send mass m.mTli towards the Moon?  ctx = {stdTliDv, maxLaunches}
 * kind: 'fits' | 'multi' (N launches) | 'refuel' (tanker flights) | 'no' | 'unknown'
 */
export function launcherVerdict(L, m, ctx) {
  const maxN = ctx.maxLaunches || 4;
  if (L.mode === 'refuel' && L.refuel && L.leo_kg) {
    const f = L.refuel;
    if (m.mTli > L.leo_kg) {
      return { kind: 'no', need: m.mTli, cap: L.leo_kg, basis: 'LEO', launches: Math.ceil(m.mTli / L.leo_kg),
        text: 'cannot lift this in one launch', why: `the stack needs ${fmtT(m.mTli)} in LEO, above the ≈${fmtT(L.leo_kg)} design payload` };
    }
    const prop = (f.ship_dry_kg + m.mTli) * (Math.exp(m.tliDv / (G0 * f.ship_isp_s)) - 1);
    if (prop > f.prop_capacity_kg) {
      return { kind: 'no', need: m.mTli, cap: L.leo_kg, basis: 'LEO', text: 'cannot lift this',
        why: `the TLI burn would need ≈${fmtT(prop)} of propellant, more than the ship holds` };
    }
    const [tMin, tMax] = f.tanker_payload_kg_range;
    const lo = Math.max(1, Math.ceil(prop / tMax)), hi = Math.max(lo, Math.ceil(prop * (1 + (f.loss_allowance || 0)) / tMin));
    return { kind: 'refuel', need: m.mTli, cap: L.leo_kg, basis: 'LEO', prop, tankers: [lo, hi],
      marginPct: (1 - m.mTli / L.leo_kg) * 100,
      text: `needs ≈${lo === hi ? lo : lo + '–' + hi} tanker flights (orbital refuelling, est.)` };
  }
  let need, cap, basis;
  if (L.mode === 'leo' && L.leo_kg) { need = m.mLeo; cap = L.leo_kg; basis = 'LEO'; }
  else if (Number.isFinite(L.tli_kg) && L.tli_kg > 0) {
    need = m.mTli; basis = 'TLI';
    cap = L.tli_kg * Math.max(0.5, 1 - BLT_DERATE_PER_KMS * Math.max(0, m.tliDv - ctx.stdTliDv));
  } else return { kind: 'unknown', text: 'no lunar capability figure — unverified', why: 'no TLI figure available' };
  if (need <= cap) {
    const marginPct = (1 - need / cap) * 100;
    return { kind: 'fits', need, cap, basis, marginPct, tight: marginPct < 10, text: `fits with ${fmtPct(marginPct)}% margin` };
  }
  const n = Math.ceil(need / cap);
  if (n <= maxN) {
    return { kind: 'multi', need, cap, basis, launches: n, text: `needs ${n} launches + in-orbit assembly`,
      why: `needs ${fmtT(need)} ${basis === 'LEO' ? 'in LEO' : 'at TLI'} but one launch delivers ${fmtT(cap)}` };
  }
  return { kind: 'no', need, cap, basis, launches: n, text: 'cannot lift this',
    why: `needs ${fmtT(need)} ${basis === 'LEO' ? 'in LEO' : 'at TLI'} but one launch delivers ${fmtT(cap)} (${n}+ launches)` };
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKg = v => Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–';
function fmtT(kg) {
  if (!Number.isFinite(kg)) return '–';
  if (kg < 1000) return `${Math.round(kg)} kg`;
  const t = kg / 1000;
  return `${t >= 100 ? Math.round(t) : t >= 10 ? +t.toFixed(1) : +t.toFixed(2)} t`;
}
const fmtPct = v => v < 1 ? v.toFixed(1) : String(Math.floor(v));
const fmtDays = d => d < 30 ? `≈${d.toFixed(1)} days` : `≈${(d / 30.44).toFixed(1)} months (${Math.round(d)} d)`;
const fmtDaysShort = d => d < 30 ? `≈${d.toFixed(1)} d` : `≈${Math.round(d)} d`;
function fmtLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
}
function sideOf(lat, lon) {
  const ang = Math.acos(Math.max(-1, Math.min(1, Math.cos(lat * DEG) * Math.cos(lon * DEG)))) / DEG;   // from sub-Earth point
  if (Math.abs(lat) >= 85) return { key: 'pole', text: `${lat < 0 ? 'south' : 'north'} polar region (Earth sits at the horizon)` };
  if (ang < 82) return { key: 'near', text: 'near side' };
  if (ang <= 98) return { key: 'limb', text: 'limb region (Earth near the horizon)' };
  return { key: 'far', text: 'far side (no direct view of Earth)' };
}

let _data = null;
async function loadLaunchers() {
  if (_data) return _data;
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`launchers.json: HTTP ${res.status}`);
  const d = await res.json();
  if (!d || !Array.isArray(d.launchers)) throw new Error('launchers.json: unexpected format');
  _data = d;
  return d;
}

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------
function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('ms-style')) return;
  const s = document.createElement('style');
  s.id = 'ms-style';
  s.textContent = `
.ms-root{box-sizing:border-box;height:100%;min-height:0;width:100%;display:flex;flex-direction:column;gap:6px;padding:8px 12px;overflow:auto;
  background:var(--bg,#0b0e14);color:var(--text,#e6e9ef);font:12.5px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ms-root *{box-sizing:border-box}
.ms-muted{color:var(--muted,#8f9bb3)}
.ms-head{flex:0 0 auto;display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;background:var(--panel,#141925);border:1px solid var(--border,#2a3347);border-radius:8px;padding:6px 10px}
.ms-btn{background:transparent;color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3347);border-radius:6px;padding:5px 10px;font:inherit;cursor:pointer;white-space:nowrap}
.ms-btn:hover,.ms-btn:focus-visible{border-color:var(--accent,#5fb4ff);outline:none}
.ms-site{min-width:150px;max-width:330px}
.ms-site b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-site span{font-size:11.5px}
.ms-field{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--muted,#8f9bb3)}
.ms-field input{width:104px;background:var(--bg,#0b0e14);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3347);border-radius:5px;padding:4px 6px;font:inherit;font-size:13px;font-variant-numeric:tabular-nums}
.ms-field input:focus{outline:none;border-color:var(--accent,#5fb4ff)}
.ms-field input.ms-bad{border-color:#ff6b6b}
.ms-field.ms-isp input{width:70px}
.ms-chips{display:flex;gap:5px;flex-wrap:wrap;max-width:420px}
.ms-chip{background:var(--bg,#0b0e14);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3347);border-radius:999px;padding:2px 9px;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.ms-chip:hover,.ms-chip:focus-visible{border-color:var(--accent,#5fb4ff);outline:none}
.ms-chip.ms-on{border-color:var(--accent,#5fb4ff);color:var(--accent,#5fb4ff)}
.ms-pane{background:var(--panel,#141925);border:1px solid var(--border,#2a3347);border-radius:8px;padding:6px 10px 8px;display:flex;flex-direction:column;gap:5px;min-height:0}
.ms-pane-l{flex:1 1 44%;min-height:218px}
.ms-pane-o{flex:1.15 1 56%;min-height:246px}
.ms-pane-h{flex:0 0 auto;display:flex;align-items:baseline;gap:12px;justify-content:space-between}
.ms-pane-h h3{margin:0;font-size:13px;letter-spacing:.02em;white-space:nowrap}
.ms-pane-h span{font-size:11px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-cards{flex:1 1 auto;min-height:0;display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;padding-bottom:4px;scrollbar-color:var(--border,#2a3347) transparent}
.ms-card{flex:0 0 232px;display:flex;gap:8px;align-items:stretch;text-align:left;background:var(--bg,#0b0e14);color:inherit;border:1px solid var(--border,#2a3347);border-radius:8px;padding:6px 8px 6px 6px;font:inherit;cursor:pointer;min-height:0;overflow:hidden}
.ms-card:hover{border-color:var(--muted,#8f9bb3)}
.ms-card:focus-visible{outline:2px solid var(--accent,#5fb4ff);outline-offset:-2px}
.ms-card.ms-sel{border-color:var(--accent,#5fb4ff);box-shadow:inset 0 0 0 1px var(--accent,#5fb4ff);background:color-mix(in srgb,var(--accent,#5fb4ff) 9%,var(--bg,#0b0e14))}
.ms-card.ms-retired{opacity:.72}
.ms-pic{flex:0 0 44px;display:flex;align-items:flex-end;justify-content:center;min-height:0;border-bottom:1px solid var(--border,#2a3347)}
.ms-pic img{display:block;height:100%;width:auto;max-width:100%;object-fit:contain;object-position:bottom}
.ms-pic.ms-photo{flex-basis:74px;border-bottom:0}
.ms-pic.ms-photo img{width:100%;object-fit:cover;object-position:center;border-radius:5px}
.ms-ctext{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;overflow:hidden}
.ms-ctext>*{flex-shrink:0}
.ms-cname{font-size:13px;font-weight:700;line-height:1.15}
.ms-cop{font-size:10.5px;color:var(--muted,#8f9bb3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-badge{align-self:flex-start;font-size:10px;line-height:1.3;border-radius:4px;padding:0 5px;margin:2px 0;border:1px solid currentColor;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.ms-st-ok{color:#58c98b}.ms-st-warn{color:#ffb020}.ms-st-dev{color:#b99cff}.ms-st-ret{color:var(--muted,#8f9bb3)}
.ms-spec{font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ms-spec i{font-style:normal;color:var(--muted,#8f9bb3);margin-right:5px}
.ms-spec i+i,.ms-spec .ms-sep{margin-left:7px}
.ms-flag{font-size:9.5px;font-style:normal;font-weight:700;color:#ffb020;border:1px solid #ffb020;border-radius:3px;padding:0 3px;margin-left:3px;vertical-align:1px}
.ms-verdict{margin-top:auto;font-size:11.5px;font-weight:700;line-height:1.2;border-left:3px solid currentColor;padding:2px 0 2px 6px}
.ms-verdict small{display:block;font-weight:400;font-size:10px;color:var(--muted,#8f9bb3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-v-fits{color:#58c98b}.ms-v-tight{color:#d6c94a}.ms-v-multi,.ms-v-refuel{color:#ffb020}.ms-v-no,.ms-v-unknown{color:#ff6b6b}
.ms-ldetail{flex:0 0 auto;font-size:11px;line-height:1.3;color:var(--muted,#8f9bb3);max-height:2.65em;overflow-y:auto;scrollbar-width:thin}
@media (min-height:800px){.ms-ldetail{max-height:3.95em}}
.ms-ldetail b{color:var(--text,#e6e9ef)}
.ms-root a{color:var(--accent,#5fb4ff)}
.ms-orb{flex:1 1 auto;min-height:0;display:flex;gap:10px}
.ms-cfgs{flex:0 0 236px;display:flex;flex-direction:column;gap:5px;min-height:0;overflow-y:auto}
.ms-cfg{flex:1 1 0;min-height:42px;display:flex;flex-direction:column;justify-content:center;gap:1px;text-align:left;background:var(--bg,#0b0e14);color:inherit;border:1px solid var(--border,#2a3347);border-radius:7px;padding:3px 9px;font:inherit;cursor:pointer}
.ms-cfg:hover{border-color:var(--muted,#8f9bb3)}
.ms-cfg:focus-visible{outline:2px solid var(--accent,#5fb4ff);outline-offset:-2px}
.ms-cfg.ms-sel{border-color:var(--accent,#5fb4ff);box-shadow:inset 0 0 0 1px var(--accent,#5fb4ff);background:color-mix(in srgb,var(--accent,#5fb4ff) 9%,var(--bg,#0b0e14))}
.ms-cfg b{font-size:12px}
.ms-cfg span{font-size:10.5px;color:var(--muted,#8f9bb3);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-sch{flex:1 1 auto;min-width:0;min-height:0;position:relative;background:#05070c;border:1px solid var(--border,#2a3347);border-radius:7px;overflow:hidden}
.ms-sch svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.ms-det{flex:0 0 318px;min-height:0;overflow-y:auto;font-size:11.5px;scrollbar-width:thin;padding-right:2px}
.ms-det h4{margin:0 0 3px;font-size:12px;line-height:1.2}
.ms-legs{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.ms-legs td{padding:1.5px 3px;border-bottom:1px solid var(--border,#2a3347);vertical-align:baseline}
.ms-legs td:last-child{text-align:right;white-space:nowrap}
.ms-legs small{color:var(--muted,#8f9bb3)}
.ms-legs tr.ms-tot td{font-weight:700;border-bottom:0}
.ms-num{display:inline-block;width:15px;height:15px;line-height:14px;text-align:center;border-radius:50%;border:1px solid var(--accent,#5fb4ff);color:var(--accent,#5fb4ff);font-size:10px;font-weight:700;margin-right:4px}
.ms-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;margin:5px 0 3px}
.ms-kv dt{color:var(--muted,#8f9bb3);white-space:nowrap}
.ms-kv dd{margin:0}
.ms-kv dd b{font-variant-numeric:tabular-nums}
.ms-note{font-size:10.5px;color:var(--muted,#8f9bb3);margin:3px 0 0}
.ms-sum{flex:0 0 auto;background:var(--panel,#141925);border:1px solid var(--border,#2a3347);border-left:4px solid var(--accent,#5fb4ff);border-radius:8px;padding:5px 10px}
.ms-sum.ms-s-fits{border-left-color:#58c98b}.ms-sum.ms-s-refuel,.ms-sum.ms-s-multi{border-left-color:#ffb020}.ms-sum.ms-s-no,.ms-sum.ms-s-unknown{border-left-color:#ff6b6b}
.ms-sum{display:flex;gap:12px;align-items:center}.ms-sum-txt{flex:1 1 auto;min-width:0}
.ms-report{flex:0 0 auto;background:var(--accent,#5fb4ff);color:#06121f;border-color:var(--accent,#5fb4ff);font-weight:600}.ms-report:disabled{opacity:.7;cursor:default}
.ms-sum-main{font-size:13.5px;font-weight:700}
.ms-sum-sub{font-size:10.5px;color:var(--muted,#8f9bb3)}
.ms-err{color:#ff6b6b;padding:8px}
.ms-svg-t{font:12px system-ui,sans-serif;fill:var(--text,#e6e9ef);paint-order:stroke;stroke:#05070c;stroke-width:3px;stroke-linejoin:round}
.ms-svg-m{fill:var(--muted,#8f9bb3)}
.ms-svg-n{font:700 10.5px system-ui,sans-serif;fill:var(--accent,#5fb4ff);text-anchor:middle;dominant-baseline:central}
.ms-p-coast{fill:none;stroke:var(--accent,#5fb4ff);stroke-width:1.8;stroke-dasharray:6 4}
.ms-p-orbit{fill:none;stroke:#9fb3c8;stroke-width:1.3}
.ms-p-desc{fill:none;stroke:#ffb020;stroke-width:2}
.ms-p-park{fill:none;stroke:#9fb3c8;stroke-width:1;stroke-dasharray:3 3}`;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------------------------
// Earth–Moon schematic (SVG, explicitly not to scale)
// ---------------------------------------------------------------------------------------------
const VB = { w: 900, h: 330 };
const EA = { x: 105, y: 168, r: 52, rp: 66 };            // Earth disc, parking-orbit radius
const MO = { x: 675, y: 150, r: 46, rl: 60 };            // Moon disc, low-lunar-orbit radius
const P = (x, y) => ({ x, y });

function arcPts(cx, cy, rx, ry, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push(P(cx + rx * Math.cos(a), cy + ry * Math.sin(a))); }
  return out;
}
function bezPts(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push(P(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y));
  }
  return out;
}
function splinePts(pts, before, after, n) {              // Catmull–Rom through pts, phantom end points set the end tangents
  const q = [before, ...pts, after], out = [];
  for (let i = 1; i < q.length - 2; i++) {
    const [p0, p1, p2, p3] = [q[i - 1], q[i], q[i + 1], q[i + 2]];
    for (let k = (i === 1 ? 0 : 1); k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push(P(
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)));
    }
  }
  return out;
}
function keepOffMoon(pts) {                               // push samples that would cut through the Moon disc out to its limb
  const rr = MO.r + 9;
  return pts.map(p => { const dx = p.x - MO.x, dy = p.y - MO.y, d = Math.hypot(dx, dy); return d >= rr || d === 0 ? p : P(MO.x + dx / d * rr, MO.y + dy / d * rr); });
}
const dOf = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
const norm = a => ((a % TAU) + TAU) % TAU;

/** Geometry of one configuration: animated segments + numbered burn markers (numbers match the delta-V legs). */
function buildScheme(cfgId, lat, lon, opt) {
  const e = Math.cos(lat * DEG) * Math.cos(lon * DEG), z = Math.sin(lat * DEG);     // towards Earth, towards north
  const site = P(MO.x - MO.r * e, MO.y - MO.r * z);                                 // side view: Earth is to the left
  const off = Math.hypot(site.x - MO.x, site.y - MO.y);
  const th = off < 0.15 * MO.r ? (e >= 0 ? Math.PI : 0) : Math.atan2(site.y - MO.y, site.x - MO.x);
  const onLlo = a => P(MO.x + MO.rl * Math.cos(a), MO.y + MO.rl * Math.sin(a));
  const D = P(EA.x, EA.y + EA.rp), T = P(MO.x, MO.y - MO.rl);                       // departure (bottom of LEO), top of LLO
  const park = { name: 'Low Earth parking orbit', cls: 'ms-p-park', dur: 1.3, pts: arcPts(EA.x, EA.y, EA.rp, EA.rp, TAU, Math.PI / 2, 40), hide: true };
  const coast = pts => ({ name: 'Coast to the Moon', cls: 'ms-p-coast', dur: cfgId === 'blt' ? 6 : 4.2, pts, days: opt.days, label: true });
  const toTop = () => bezPts(D, P(D.x + 250, D.y + 20), P(T.x - 200, T.y), T, 70);
  const lloCW = () => ({ name: 'Low lunar orbit', cls: 'ms-p-orbit', dur: 2.6, pts: arcPts(MO.x, MO.y, MO.rl, MO.rl, -Math.PI / 2, -Math.PI / 2 + norm(th + Math.PI / 2) + TAU, 110) });
  const lloCCW = () => ({ name: 'Low lunar orbit', cls: 'ms-p-orbit', dur: 2.6, pts: arcPts(MO.x, MO.y, MO.rl, MO.rl, -Math.PI / 2, -Math.PI / 2 - norm(-Math.PI / 2 - th) - TAU, 110) });
  const descent = { name: 'Powered descent', cls: 'ms-p-desc', dur: 1.2, pts: [onLlo(th), site] };
  let segs, marks;
  if (cfgId === 'direct') {
    const A = P(MO.x + (MO.rl + 28) * Math.cos(th), MO.y + (MO.rl + 28) * Math.sin(th));
    const c2 = P(A.x + 80 * Math.cos(th) - 70, A.y + 80 * Math.sin(th));
    segs = [park, coast(keepOffMoon(bezPts(D, P(D.x + 250, D.y + 20), c2, A, 70))),
      { name: 'Braking burn and landing', cls: 'ms-p-desc', dur: 1.4, pts: [A, site] }];
    marks = [D, A];
  } else if (cfgId === 'nrho') {
    const B = 104, RX = 34;
    segs = [park, coast(toTop()),
      { name: 'Near-rectilinear halo orbit (NRHO)', cls: 'ms-p-orbit', dur: 2.8, pts: arcPts(MO.x, MO.y - MO.rl + B, RX, B, -Math.PI / 2, 1.5 * Math.PI, 120) },
      lloCW(), descent];
    marks = [D, P(T.x - 14, T.y - 3), onLlo(-Math.PI / 2 + 0.5), onLlo(th)];
  } else if (cfgId === 'blt') {
    const way = [D, P(330, 296), P(600, 304), P(835, 258), P(884, 150), P(832, 58), P(752, 84), T];
    segs = [park, coast(splinePts(way, P(D.x - 200, D.y), P(T.x - 130, T.y + 6), 16)), lloCCW(), descent];
    marks = [D, T, onLlo(th)];
  } else {
    segs = [park, coast(toTop()), lloCW(), descent];
    marks = [D, T, onLlo(th)];
  }
  return { site, th, e, segs, marks };
}

function schemeSvg(cfgId, lat, lon, opt, siteText) {
  const g = buildScheme(cfgId, lat, lon, opt);
  let stars = '', seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) stars += `<circle cx="${(rnd() * VB.w).toFixed(0)}" cy="${(rnd() * VB.h).toFixed(0)}" r="${(0.4 + rnd() * 0.7).toFixed(1)}" fill="#fff" opacity="${(0.15 + rnd() * 0.35).toFixed(2)}"/>`;
  const paths = g.segs.map(s => `<path class="${s.cls}" d="${dOf(s.pts)}"/>`).join('');
  const coast = g.segs.find(s => s.label), mid = coast.pts[Math.floor(coast.pts.length * (cfgId === 'blt' ? 0.3 : 0.45))];
  const coastLabel = cfgId === 'blt' ? `coast ${fmtDaysShort(opt.days)}, out to ≈1.5 million km (≈4× the Moon's distance) and back`
    : cfgId === 'nrho' ? `coast ≈5 d to NRHO` : `coast ${fmtDaysShort(opt.days)}`;
  const marks = g.marks.map((m, i) => `<g><circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="8.5" fill="#05070c" stroke="var(--accent,#5fb4ff)" stroke-width="1.3"/><text class="ms-svg-n" x="${m.x.toFixed(1)}" y="${(m.y + 0.5).toFixed(1)}">${i + 1}</text></g>`).join('');
  const anchor = Math.cos(g.th) > 0.3 ? 'start' : Math.cos(g.th) < -0.3 ? 'end' : 'middle';
  const labR = MO.rl + (cfgId === 'direct' ? 46 : 17);
  const lab = P(MO.x + labR * Math.cos(g.th), MO.y + labR * Math.sin(g.th) + (Math.sin(g.th) > 0.3 ? 9 : Math.sin(g.th) < -0.3 ? -3 : 4));
  return { g, html: `
<svg viewBox="0 0 ${VB.w} ${VB.h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Schematic, not to scale: Earth on the left, Moon on the right, with the selected transfer trajectory and the landing site marked on the Moon">
  <defs>
    <radialGradient id="ms-gE" cx="38%" cy="35%" r="75%"><stop offset="0" stop-color="#5aa9ff"/><stop offset="0.6" stop-color="#1f5fb8"/><stop offset="1" stop-color="#0b2a5c"/></radialGradient>
    <radialGradient id="ms-gM" cx="38%" cy="35%" r="75%"><stop offset="0" stop-color="#d9dce2"/><stop offset="0.7" stop-color="#8e949f"/><stop offset="1" stop-color="#555b66"/></radialGradient>
    <clipPath id="ms-cE"><circle cx="${EA.x}" cy="${EA.y}" r="${EA.r}"/></clipPath>
  </defs>
  ${stars}
  <circle cx="${EA.x}" cy="${EA.y}" r="${EA.r}" fill="url(#ms-gE)"/>
  <g clip-path="url(#ms-cE)" fill="#3f9a63" opacity=".85">
    <path d="M70 135q14-14 30-6q8 10-4 20q-6 14-16 8q-14-8-10-22z"/><path d="M112 168q16-6 24 8q4 18-8 30q-12 4-14-12q-8-14-2-26z"/><path d="M62 190q10-4 16 6q0 12-8 14q-10-6-8-20z"/>
  </g>
  <circle cx="${EA.x}" cy="${EA.y}" r="${EA.r}" fill="none" stroke="#9fd0ff" stroke-opacity=".5" stroke-width="2"/>
  <circle class="ms-p-park" cx="${EA.x}" cy="${EA.y}" r="${EA.rp}"/>
  <text class="ms-svg-t" x="${EA.x}" y="${EA.y + 4}" text-anchor="middle" style="font-weight:700;font-size:13px">EARTH</text>
  <text class="ms-svg-t ms-svg-m" x="${EA.x}" y="${EA.y - EA.rp - 7}" text-anchor="middle">parking orbit (LEO, ${opt.leoAltKm} km)</text>
  <circle cx="${MO.x}" cy="${MO.y}" r="${MO.r}" fill="url(#ms-gM)"/>
  <g fill="#000" opacity=".13"><circle cx="${MO.x - 18}" cy="${MO.y - 12}" r="9"/><circle cx="${MO.x - 24}" cy="${MO.y + 14}" r="6"/><circle cx="${MO.x + 14}" cy="${MO.y + 20}" r="5"/><circle cx="${MO.x + 20}" cy="${MO.y - 16}" r="4"/></g>
  <line x1="${MO.x}" y1="${MO.y - MO.r}" x2="${MO.x}" y2="${MO.y + MO.r}" stroke="#05070c" stroke-opacity=".55" stroke-dasharray="3 3"/>
  <text x="${MO.x}" y="${MO.y - 25}" text-anchor="middle" style="font:700 11px system-ui,sans-serif;fill:#10141c">MOON</text>
  <text x="${MO.x - 5}" y="${MO.y + 3}" text-anchor="end" style="font:9.5px system-ui,sans-serif;fill:#10141c">near</text>
  <text x="${MO.x + 5}" y="${MO.y + 3}" text-anchor="start" style="font:9.5px system-ui,sans-serif;fill:#10141c">far</text>
  ${paths}
  <text class="ms-svg-t" x="${Math.min(VB.w - 250, Math.max(250, mid.x)).toFixed(0)}" y="${(mid.y - 10).toFixed(0)}" text-anchor="middle" style="fill:var(--accent,#5fb4ff)">${esc(coastLabel)}</text>
  ${marks}
  <circle cx="${g.site.x.toFixed(1)}" cy="${g.site.y.toFixed(1)}" r="6.5" fill="none" stroke="#ffb020" stroke-width="1.2" opacity=".8"/>
  <circle cx="${g.site.x.toFixed(1)}" cy="${g.site.y.toFixed(1)}" r="3.4" fill="#ffb020" stroke="#05070c" stroke-width="1"/>
  <text class="ms-svg-t" x="${lab.x.toFixed(1)}" y="${lab.y.toFixed(1)}" text-anchor="${anchor}" style="fill:#ffb020">${esc(siteText)}</text>
  <circle class="ms-craft-glow" r="6" fill="#ffb020" opacity=".28"/>
  <circle class="ms-craft" r="2.8" fill="#fff"/>
  <text class="ms-svg-t ms-phase" x="${VB.w / 2 - 60}" y="17" text-anchor="middle"></text>
  <text class="ms-svg-t ms-svg-m" x="8" y="${VB.h - 7}">Schematic — NOT to scale. Side view; the Moon's near side faces Earth (left).</text>
</svg>` };
}

function animate(svg, g, opt) {
  const craft = svg.querySelector('.ms-craft'), glow = svg.querySelector('.ms-craft-glow'), phase = svg.querySelector('.ms-phase');
  const segs = g.segs.map(s => {
    const cum = [0];
    for (let i = 1; i < s.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].y - s.pts[i - 1].y));
    return { ...s, cum, len: cum[cum.length - 1] };
  });
  const PAUSE = 1.6, total = segs.reduce((s, x) => s + x.dur, 0) + PAUSE;
  const place = (seg, f) => {
    const d = f * seg.len; let i = 1;
    while (i < seg.cum.length - 1 && seg.cum[i] < d) i++;
    const span = seg.cum[i] - seg.cum[i - 1] || 1, t = (d - seg.cum[i - 1]) / span, a = seg.pts[i - 1], b = seg.pts[i];
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    craft.setAttribute('cx', x.toFixed(1)); craft.setAttribute('cy', y.toFixed(1));
    glow.setAttribute('cx', x.toFixed(1)); glow.setAttribute('cy', y.toFixed(1));
  };
  const last = segs[segs.length - 1];
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || typeof requestAnimationFrame !== 'function') {
    place(last, 1); phase.textContent = `Landed · transfer ${fmtDaysShort(opt.days)}`;
    return () => {};
  }
  let raf = 0, stopped = false, missed = 0;
  const t0 = performance.now();
  const tick = now => {
    if (stopped) return;
    if (!svg.isConnected) { if (++missed > 900) return; raf = requestAnimationFrame(tick); return; }
    missed = 0;
    let t = ((now - t0) / 1000) % total, done = true;
    for (const s of segs) {
      if (t < s.dur) {
        const f = t / s.dur;
        place(s, f);
        phase.textContent = s.days ? `${s.name} · T+${(f * s.days).toFixed(s.days > 30 ? 0 : 1)} d` : s.name;
        done = false; break;
      }
      t -= s.dur;
    }
    if (done) { place(last, 1); phase.textContent = `Landed · transfer ${fmtDaysShort(opt.days)} (plus any time waiting in orbit)`; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------
function inclinationText(cfgId, absLat) {
  const a = absLat.toFixed(1);
  const kind = absLat >= 75 ? 'a polar orbit (≈90°)' : absLat < 10 ? 'a near-equatorial orbit is enough' : 'an inclined orbit';
  if (cfgId === 'direct') return `none — no parking orbit. The approach trajectory itself must be aimed at latitude ${a}°, which ties the landing to the arrival geometry and date.`;
  if (cfgId === 'nrho') return `NRHO is near-polar; the low orbit after it needs i ≥ ${a}° (${kind}).${absLat < 60 ? ' Low-latitude sites cost more from NRHO than the default figure.' : ''}`;
  return `i ≥ ${a}° — ${kind}. Chosen by aiming the lunar approach, at little delta-V cost.`;
}

function statusBadge(L) {
  const st = String(L.status || 'unverified');
  const cls = st === 'operational' ? (L.status_short ? 'ms-st-warn' : 'ms-st-ok') : st === 'retired' ? 'ms-st-ret' : st === 'in development' ? 'ms-st-dev' : 'ms-st-warn';
  return `<span class="ms-badge ${cls}">${esc(st)}${L.status_short ? ' · ' + esc(L.status_short) : ''}</span>`;
}
function tliCell(L) {
  if (L.mode === 'refuel') return `refuel<em class="ms-flag" title="No direct TLI figure: modelled as a number of tanker flights; estimate range">est.</em>`;
  if (L.mode === 'leo') return `none`;
  if (!Number.isFinite(L.tli_kg)) return `unverified`;
  const flag = L.tli_basis === 'estimate' ? `<em class="ms-flag" title="Estimate made for this tool, not a published figure">est.</em>` : '';
  return `${L.tli_lower_bound ? '&gt;' : ''}${fmtT(L.tli_kg)}${flag}`;
}
function basisText(L) {
  switch (L.tli_basis) {
    case 'published': return 'published by the operator';
    case 'published-secondary': return 'published figure, as quoted by a secondary source';
    case 'estimate': return 'ESTIMATE made for this tool';
    case 'refuelling-model': return 'no direct figure — refuelling model, ESTIMATE';
    case 'leo-only': return 'launcher reaches LEO only';
    default: return 'unverified';
  }
}

export async function renderMission(container, { site, onBack, power, onChange, onReport } = {}) {
  injectStyle();
  container.__msStop?.();
  const lat = Math.max(-90, Math.min(90, Number(site?.lat) || 0));
  let lon = ((Number(site?.lon) || 0) + 180) % 360; lon = (lon < 0 ? lon + 360 : lon) - 180;
  const coords = fmtLatLon(lat, lon), side = sideOf(lat, lon);
  const label = (site?.label && String(site.label).trim()) || `Site ${coords}`;
  const area = Number.isFinite(site?.areaKm2) && site.areaKm2 > 0 ? ` · area ≈${fmtKg(site.areaKm2)} km²` : '';
  const pwrKg = Number.isFinite(power?.systemMassKg) && power.systemMassKg > 0 ? Math.round(power.systemMassKg) : 0;
  const state = { landedKg: 2000, ispS: DEFAULTS.ispS, cfgId: 'llo', launcherId: null, userPicked: false, incPower: false };
  const landed = () => state.landedKg + (state.incPower ? pwrKg : 0);

  container.innerHTML = `<div class="ms-root">
    <div class="ms-head">
      <button type="button" class="ms-btn ms-back" title="Back to site selection">← Back</button>
      <div class="ms-site"><b title="${esc(label)}">${esc(label)}</b><span class="ms-muted">${esc(coords)} · ${esc(side.text)}${esc(area)}</span></div>
      <label class="ms-field" title="Everything that touches down: lander dry mass + payload + residual propellant. One number.">Landed mass on the surface (kg)
        <input type="number" class="ms-mass" min="1" step="100" value="${state.landedKg}" inputmode="decimal"></label>
      <div class="ms-chips">${MASS_PICKS.map(p => `<button type="button" class="ms-chip" data-kg="${p.kg}" title="Generic round number for this class of lander — not a specific vehicle">${esc(p.label)} · ${fmtKg(p.kg)} kg</button>`).join('')}${pwrKg ? `<button type="button" class="ms-chip ms-pwr" aria-pressed="false" title="Adds the power system chosen in the Power step (${esc(power.systemText || '')}) to the landed mass">+ power system · ${fmtKg(pwrKg)} kg</button>` : ''}</div>
      <label class="ms-field ms-isp" title="Specific impulse of the lander's own engine, used for every burn after TLI. Typical: storable bipropellant ≈310–325 s, methane/oxygen ≈350–370 s, hydrogen/oxygen ≈440–460 s.">Lander engine Isp (s)
        <input type="number" class="ms-ispin" min="100" max="1000" step="5" value="${state.ispS}" inputmode="decimal"></label>
    </div>
    <section class="ms-pane ms-pane-l">
      <div class="ms-pane-h"><h3>1 · Launch vehicle</h3><span class="ms-muted ms-lcap"></span></div>
      <div class="ms-cards" role="listbox" aria-label="Launch vehicles"><div class="ms-muted">Loading launch vehicles…</div></div>
      <div class="ms-ldetail"></div>
    </section>
    <section class="ms-pane ms-pane-o">
      <div class="ms-pane-h"><h3>2 · Orbital configuration</h3><span class="ms-muted">Delta-V from two-body / patched-conic formulas (see the delta-V panel for assumptions). Numbers ①… on the drawing are the burns listed on the right.</span></div>
      <div class="ms-orb">
        <div class="ms-cfgs" role="listbox" aria-label="Orbital configurations"></div>
        <div class="ms-sch"></div>
        <div class="ms-det"></div>
      </div>
    </section>
    <div class="ms-sum"><div class="ms-sum-txt"><div class="ms-sum-main">Loading…</div><div class="ms-sum-sub"></div></div>${typeof onReport === 'function' ? '<button type="button" class="ms-btn ms-report" title="Builds a PDF with the requirements and the design for this iteration">Download design report (PDF)</button>' : ''}</div>
  </div>`;
  const root = container.firstElementChild;
  const $ = s => root.querySelector(s);
  let stopAnim = () => {};
  container.__msStop = () => { stopAnim(); };
  $('.ms-back').addEventListener('click', () => { stopAnim(); if (typeof onBack === 'function') onBack(); });
  $('.ms-report')?.addEventListener('click', async ev => {
    const b = ev.currentTarget, txt = b.textContent;
    b.disabled = true; b.textContent = 'Building PDF…';
    try { await onReport(); b.textContent = 'Report downloaded'; }
    catch (err) { console.warn('[report] failed', err); b.textContent = 'Report failed — see console'; }
    setTimeout(() => { b.disabled = false; b.textContent = txt; }, 2500);
  });

  let data;
  try { data = await loadLaunchers(); }
  catch (err) {
    $('.ms-cards').innerHTML = `<div class="ms-err">Could not load the launch-vehicle data (assets/launchers.json): ${esc(err.message)}</div>`;
    $('.ms-sum-main').textContent = 'Launch-vehicle data unavailable.';
    return;
  }
  if (container.firstElementChild !== root) return;                           // re-rendered meanwhile
  const launchers = data.launchers;
  const maxLaunches = data.max_launches_considered || 4;
  const anyPhoto = launchers.some(L => L.photo);
  $('.ms-lcap').textContent = `${anyPhoto ? 'Photos where provided; otherwise original' : 'Pictures: original'} schematics, heights to scale with each other · data as of ${data.as_of || 'unknown date'} · scroll sideways →`;

  // ---- launcher cards (built once; verdicts refreshed in update()) ----
  $('.ms-cards').innerHTML = launchers.map(L => `
    <button type="button" class="ms-card${L.status === 'retired' ? ' ms-retired' : ''}" role="option" aria-selected="false" data-id="${esc(L.id)}" title="${esc(L.name)} — ${esc(L.config || '')}">
      <span class="ms-pic${L.photo ? ' ms-photo' : ''}"><img alt="${esc(L.name)} — ${L.photo ? 'photo' : 'schematic side view, to scale'}" src="${esc(siteUrl(L.photo || L.svg))}" data-svg="${esc(siteUrl(L.svg))}" draggable="false"></span>
      <span class="ms-ctext">
        <span class="ms-cname">${esc(L.name)}</span>
        <span class="ms-cop">${esc(L.operator)} · ${esc(L.country)}</span>
        ${statusBadge(L)}
        <span class="ms-spec"><i>Height</i>${Number.isFinite(L.height_m) ? `${+L.height_m.toFixed(1)} m` : 'unverified'}</span>
        <span class="ms-spec" title="Payload to low Earth orbit and to trans-lunar injection (TLI) for the configuration named in the tooltip / detail line"><i>LEO</i>${Number.isFinite(L.leo_kg) ? fmtT(L.leo_kg) : 'n/a'}<i class="ms-sep">TLI</i>${tliCell(L)}</span>
        <span class="ms-verdict"></span>
      </span>
    </button>`).join('');
  for (const img of root.querySelectorAll('.ms-pic img')) {
    img.addEventListener('error', () => {                 // missing / broken photo → fall back to the schematic once
      if (img.src !== img.dataset.svg) { img.parentElement.classList.remove('ms-photo'); img.src = img.dataset.svg; }
    });
  }
  $('.ms-cards').addEventListener('click', ev => {
    const b = ev.target.closest('.ms-card'); if (!b) return;
    state.launcherId = b.dataset.id; state.userPicked = true; update(false);
  });
  $('.ms-cfgs').addEventListener('click', ev => {
    const b = ev.target.closest('.ms-cfg'); if (!b) return;
    state.cfgId = b.dataset.id; update(true);
  });
  root.querySelector('.ms-chips').addEventListener('click', ev => {
    const b = ev.target.closest('.ms-chip'); if (!b) return;
    if (b.classList.contains('ms-pwr')) { state.incPower = !state.incPower; update(false); return; }
    state.landedKg = Number(b.dataset.kg); $('.ms-mass').value = state.landedKg; $('.ms-mass').classList.remove('ms-bad'); update(false);
  });
  $('.ms-mass').addEventListener('input', ev => {
    const v = Number(ev.target.value), ok = ev.target.value.trim() !== '' && Number.isFinite(v) && v > 0 && v <= 1e7;
    ev.target.classList.toggle('ms-bad', !ok);
    if (ok) { state.landedKg = v; update(false); }
  });
  $('.ms-ispin').addEventListener('input', ev => {
    const v = Number(ev.target.value), ok = ev.target.value.trim() !== '' && Number.isFinite(v) && v >= 100 && v <= 1000;
    ev.target.classList.toggle('ms-bad', !ok);
    if (ok) { state.ispS = v; update(false); }
  });

  let drawnCfg = null;
  function update(cfgChanged) {
    const dv = computeDeltaV({ ispS: state.ispS }, lat);
    const opts = dv.options;
    const opt = opts.find(o => o.id === state.cfgId) || opts[0];
    state.cfgId = opt.id;
    const m = missionMasses(landed(), state.ispS, opt);
    const ctx = { stdTliDv: dv.tli, maxLaunches };
    const verdicts = new Map(launchers.map(L => [L.id, launcherVerdict(L, m, ctx)]));

    if (!state.userPicked) {                               // default: smallest operational vehicle that fits on one launch
      const fit = launchers.filter(L => L.status === 'operational' && verdicts.get(L.id).kind === 'fits')
        .sort((a, b) => verdicts.get(a.id).cap - verdicts.get(b.id).cap)[0];
      const alt = launchers.find(L => L.status !== 'retired' && ['refuel', 'multi'].includes(verdicts.get(L.id).kind));
      state.launcherId = (fit || alt || launchers[0]).id;
    }
    const L = launchers.find(x => x.id === state.launcherId) || launchers[0];
    const v = verdicts.get(L.id);

    // chips
    for (const c of root.querySelectorAll('.ms-chip')) {
      if (c.classList.contains('ms-pwr')) { c.classList.toggle('ms-on', state.incPower); c.setAttribute('aria-pressed', state.incPower ? 'true' : 'false'); }
      else c.classList.toggle('ms-on', Number(c.dataset.kg) === state.landedKg);
    }

    // cards
    for (const card of root.querySelectorAll('.ms-card')) {
      const vv = verdicts.get(card.dataset.id), sel = card.dataset.id === L.id;
      card.classList.toggle('ms-sel', sel); card.setAttribute('aria-selected', sel ? 'true' : 'false');
      const el = card.querySelector('.ms-verdict');
      el.className = `ms-verdict ms-v-${vv.kind === 'fits' && vv.tight ? 'tight' : vv.kind}`;
      const sub = vv.kind === 'unknown' ? '' : vv.kind === 'refuel' ? `${fmtT(vv.need)} stack → LEO (≤${fmtT(vv.cap)})`
        : `needs ${fmtT(vv.need)} ${vv.basis === 'LEO' ? 'in LEO' : 'at TLI'} · lifts ${fmtT(vv.cap)}`;
      el.innerHTML = `${esc(vv.text)}<small>${esc(sub)}</small>`;
    }
    if (!state.userPicked || cfgChanged === 'init') root.querySelector('.ms-card.ms-sel')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

    // launcher detail strip
    const extra = L.mode === 'refuel' && L.refuel ? ` Assumptions: ship dry mass ${fmtT(L.refuel.ship_dry_kg)} and Isp ${L.refuel.ship_isp_s} s (both unverified), ${fmtT(L.refuel.tanker_payload_kg_range[0])}–${fmtT(L.refuel.tanker_payload_kg_range[1])} of propellant per tanker, +${Math.round((L.refuel.loss_allowance || 0) * 100)}% losses at the high end. ${L.refuel.published_hls_estimates || ''}` : '';
    $('.ms-ldetail').innerHTML = `<b>${esc(L.name)}</b> — ${esc(L.config || '')}. <b>Status (${esc(data.as_of || '')}):</b> ${esc(L.status)}${L.status_short ? ' · ' + esc(L.status_short) : ''}. ${esc(L.status_note || '')} <b>TLI figure:</b> ${esc(basisText(L))}. ${esc(L.tli_note || '')}${esc(extra)}${L.lunar_heritage ? ` <b>Lunar missions:</b> ${esc(L.lunar_heritage)}.` : ''} ${L.source ? `<a href="${esc(L.source)}" target="_blank" rel="noopener noreferrer">source</a>` : 'source: unverified'}${L.tli_source && L.tli_source !== L.source ? ` · <a href="${esc(L.tli_source)}" target="_blank" rel="noopener noreferrer">TLI source</a>` : ''}${L.photo && L.photo_credit ? ` · photo: ${esc(L.photo_credit)}` : ''}`;

    // configuration buttons
    $('.ms-cfgs').innerHTML = opts.map(o => {
      const mm = missionMasses(landed(), state.ispS, o), c = CFG[o.id] || { tag: '', short: o.name };
      return `<button type="button" class="ms-cfg${o.id === opt.id ? ' ms-sel' : ''}" role="option" aria-selected="${o.id === opt.id}" data-id="${esc(o.id)}" title="${esc(o.name)}">
        <b>${esc(c.tag)}${c.tag ? ' · ' : ''}${esc(c.short)}</b>
        <span>ΔV ${o.total.toFixed(2)} km/s · ${fmtDaysShort(o.days)} · ${fmtT(mm.mTli)} at TLI</span></button>`;
    }).join('');

    // details
    const absLat = Math.abs(lat);
    $('.ms-det').innerHTML = `<h4>${esc(opt.name)}</h4>
      <table class="ms-legs"><tbody>
        ${opt.legs.map((l, i) => `<tr><td><span class="ms-num">${i + 1}</span>${esc(l.name)} <small>${i === 0 ? '(by the launcher) ' : ''}${esc(l.kind)}</small></td><td>${l.dv.toFixed(3)} km/s</td></tr>`).join('')}
        <tr class="ms-tot"><td>Total from LEO <small>· after TLI ${opt.afterTli.toFixed(2)} km/s</small></td><td>${opt.total.toFixed(2)} km/s</td></tr>
      </tbody></table>
      <dl class="ms-kv">
        <dt>Transfer time</dt><dd><b>${esc(fmtDays(opt.days))}</b> <span class="ms-muted">— ${esc(opt.timeNote)}</span></dd>
        <dt>Mass at TLI</dt><dd><b>${fmtKg(m.mTli)} kg</b> <span class="ms-muted">= ${fmtKg(landed())} kg${state.incPower ? ` (${fmtKg(state.landedKg)} + ${fmtKg(pwrKg)} power system)` : ''} × e^(${opt.afterTli.toFixed(3)} ÷ ${m.ve.toFixed(3)}); ${fmtKg(m.propAfterTli)} kg (${Math.round(m.propAfterTli / m.mTli * 100)}%) is propellant</span></dd>
        <dt>Mass in LEO</dt><dd><b>${fmtKg(m.mLeo)} kg</b> <span class="ms-muted">only if the lander's own stage also flew TLI (used for LEO-only launchers)</span></dd>
        <dt>Lunar orbit</dt><dd>${esc(inclinationText(opt.id, absLat))}</dd>
      </dl>
      <p class="ms-note">${esc(opt.notes)}</p>
      <p class="ms-note">Approximations: ideal rocket equation, one stage at Isp ${state.ispS} s for every burn after TLI, impulsive burns, no tank-mass growth, no margins, no launch adapter. Real landers need more.${opt.id === 'blt' ? ` The low-energy injection needs ≈${Math.round((m.tliDv - dv.tli) * 1000)} m/s more than a standard TLI, so each launcher's TLI figure is reduced by ≈${(BLT_DERATE_PER_KMS * (m.tliDv - dv.tli) * 100).toFixed(0)}% here (approximation).` : ''}</p>`;

    // schematic (only rebuilt when the configuration changes)
    if (cfgChanged || drawnCfg !== opt.id) {
      stopAnim();
      const siteText = `${!site?.label || label.length > 26 ? 'landing site' : label} · ${Math.abs(lat).toFixed(1)}°${lat < 0 ? 'S' : 'N'} · ${side.key === 'far' ? 'far side' : side.key === 'near' ? 'near side' : side.key === 'pole' ? 'pole' : 'limb'}`;
      const sch = schemeSvg(opt.id, lat, lon, { ...opt, leoAltKm: dv.inputs.leoAltKm }, siteText);
      $('.ms-sch').innerHTML = sch.html;
      stopAnim = animate($('.ms-sch svg'), sch.g, opt);
      drawnCfg = opt.id;
    }

    // summary
    const c = CFG[opt.id] || { short: opt.name };
    const what = `${fmtKg(landed())} kg to ${label}`;
    let main;
    if (v.kind === 'fits') main = `${what} in ${fmtDays(opt.days)}, margin ${fmtPct(v.marginPct)}%`;
    else if (v.kind === 'refuel') main = `${what} in ${fmtDays(opt.days)} — only with in-orbit refuelling: ≈${v.tankers[0] === v.tankers[1] ? v.tankers[0] : v.tankers[0] + '–' + v.tankers[1]} tanker flights (estimate); margin ${fmtPct(v.marginPct)}% on the lift to LEO`;
    else if (v.kind === 'multi') main = `infeasible on a single launch for ${what} — ${v.why}; would take ${v.launches} launches plus in-orbit assembly or refuelling (not modelled)`;
    else main = `infeasible for ${what} — ${v.why || v.text}`;
    const cave = [];
    if (L.status === 'retired') { main = `not available (retired) — for reference only: ${main}`; cave.push(`${L.name} is retired.`); }
    else if (L.status === 'in development') cave.push(`${L.name} is still in development${L.mode === 'refuel' ? '; ship-to-ship propellant transfer has not been demonstrated' : ''}.`);
    else if (L.status_short) cave.push(`Launcher status: ${L.status_short}.`);
    if (L.tli_basis === 'estimate') cave.push('Its TLI capability is an estimate (roughly ±20%), not a published figure.');
    if (v.kind === 'fits' && v.tight) cave.push('A margin under 10% is within the uncertainty of these estimates.');
    cave.push(`Margin = unused share of the launcher's ${v.basis === 'LEO' ? 'LEO' : 'TLI'} capability. First-order comparison only, not mission design.`);
    $('.ms-sum').className = `ms-sum ms-s-${v.kind}`;
    $('.ms-sum-main').textContent = `${L.name} + ${c.short}: ${main}`;
    $('.ms-sum-sub').textContent = cave.join(' ');

    if (typeof onChange === 'function') {
      onChange({
        landedKg: landed(), payloadKg: state.landedKg, powerKgIncluded: state.incPower ? pwrKg : 0, ispS: state.ispS,
        launcher: { id: L.id, name: L.name, operator: L.operator, country: L.country, config: L.config || '', status: L.status,
          statusShort: L.status_short || '', leoKg: L.leo_kg, tliText: basisText(L), tliBasis: L.tli_basis || '', source: L.source || '' },
        verdict: { kind: v.kind, text: v.text, marginPct: v.marginPct, needKg: v.need, capKg: v.cap, basis: v.basis, tankers: v.tankers || null, launches: v.launches || null },
        config: { id: opt.id, name: opt.name, short: c.short, legs: opt.legs.map(l => ({ name: l.name, kind: l.kind, dv: l.dv })), total: opt.total,
          afterTli: opt.afterTli, days: opt.days, timeText: fmtDays(opt.days), timeNote: opt.timeNote, inclination: inclinationText(opt.id, absLat), notes: opt.notes },
        masses: { mTli: m.mTli, mLeo: m.mLeo, propAfterTli: m.propAfterTli },
        summaryLine: `${L.name} + ${c.short}: ${main}`, caveats: cave, dataAsOf: data.as_of || '',
      });
    }
  }
  update('init');
}

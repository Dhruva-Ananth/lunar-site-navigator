// Earth → lunar-surface architecture comparison with first-order delta-V budgets.
// Patched-conic / vis-viva formulas evaluated live from editable inputs. NOT mission design.

const DEG = Math.PI / 180;
export const MU_EARTH = 398600.4418;   // km^3/s^2
export const R_EARTH = 6378.137;       // km (equatorial)
export const MU_MOON = 4902.8;         // km^3/s^2
export const R_MOON = 1737.4;          // km
export const A_MOON = 384400;          // km, mean Earth-Moon distance (Moon's orbit treated as circular)
const G0 = 9.80665e-3;                 // km/s^2

export const DEFAULTS = {
  leoAltKm: 200, lloAltKm: 100,
  descentLossKmS: 0.25,      // gravity loss + throttling + hazard avoidance allowance on descent
  ascentLossKmS: 0.15,       // gravity/steering loss allowance on ascent
  directLossKmS: 0.25,       // allowance on direct descent
  nrhoInsertKmS: 0.45,       // literature approx.: powered lunar flyby + NRHO insertion, ~5-day transfer
  nrhoToLloKmS: 0.73,        // literature approx.: NRHO → 100 km polar LLO, ~0.5-day transfer
  bltApogeeKm: 1.5e6,        // apogee of the low-energy transfer (Sun-perturbed region)
  ispS: 320,
};

/** All numbers in km/s, days, or dimensionless. Pure function. */
export function computeDeltaV(inp = {}, lat = 0) {
  const p = { ...DEFAULTS, ...inp };
  const r1 = R_EARTH + p.leoAltKm, rM = R_MOON + p.lloAltKm;
  const vLeo = Math.sqrt(MU_EARTH / r1);
  // Minimum-energy (Hohmann-like) transfer ellipse: perigee at LEO, apogee at the Moon's distance
  const aT = (r1 + A_MOON) / 2;
  const vPerigee = Math.sqrt(MU_EARTH * (2 / r1 - 1 / aT));
  const tli = vPerigee - vLeo;
  const transferDays = Math.PI * Math.sqrt(aT ** 3 / MU_EARTH) / 86400;
  const vApogee = Math.sqrt(MU_EARTH * (2 / A_MOON - 1 / aT));
  const vMoon = Math.sqrt(MU_EARTH / A_MOON);
  const vInf = vMoon - vApogee;                         // coplanar, tangential arrival
  const vLlo = Math.sqrt(MU_MOON / rM);
  const vHypPeri = Math.sqrt(vInf * vInf + 2 * MU_MOON / rM);
  const loi = vHypPeri - vLlo;
  // Descent from circular LLO: Hohmann-like ellipse with periapsis at the surface, then null the periapsis speed
  const aD = (rM + R_MOON) / 2;
  const doi = vLlo - Math.sqrt(MU_MOON * (2 / rM - 1 / aD));
  const vSurfPeri = Math.sqrt(MU_MOON * (2 / R_MOON - 1 / aD));
  const descentIdeal = doi + vSurfPeri;
  const descent = descentIdeal + p.descentLossKmS;
  const ascent = descentIdeal + p.ascentLossKmS;        // ideal ascent is the time-reverse of ideal descent
  // Direct descent: no orbit insertion; arrive at the surface on the approach hyperbola
  const vImpact = Math.sqrt(vInf * vInf + 2 * MU_MOON / R_MOON);
  const direct = vImpact + p.directLossKmS;
  // Low-energy (ballistic) transfer: injection to a ~1.5 million km apogee; arrival modelled as parabolic (v_inf = 0)
  const aB = (r1 + p.bltApogeeKm) / 2;
  const tliBlt = Math.sqrt(MU_EARTH * (2 / r1 - 1 / aB)) - vLeo;
  const loiBlt = (Math.SQRT2 - 1) * vLlo;
  // Plane change in LLO needed if arriving equatorial (illustrative)
  const planeChange = 2 * vLlo * Math.sin(Math.abs(lat) * DEG / 2);
  const lloPeriodMin = 2 * Math.PI * Math.sqrt(rM ** 3 / MU_MOON) / 60;
  const ve = G0 * p.ispS;
  const mf = dv => Math.exp(-dv / ve);

  const mk = (id, name, legs, days, timeNote, notes) => {
    const total = legs.reduce((s, l) => s + l.dv, 0);
    const afterTli = legs.slice(1).reduce((s, l) => s + l.dv, 0);
    return { id, name, legs, total, afterTli, days, timeNote, notes, fracOfLeo: mf(total), fracOfTli: mf(afterTli) };
  };
  const options = [
    mk('llo', 'A. LEO → TLI → polar LLO → powered descent', [
      { name: 'TLI', dv: tli, kind: 'computed' },
      { name: 'LOI', dv: loi, kind: 'computed' },
      { name: 'Descent', dv: descent, kind: 'computed + allowance' },
    ], transferDays, `≈${transferDays.toFixed(1)} d minimum-energy coast (crewed missions fly ≈3–4 d at slightly higher TLI and LOI) + loiter in LLO`,
      'Classic architecture (Apollo, Chandrayaan-3, most CLPS landers). A parking orbit allows checkout, phasing to the landing site and lighting, and a wave-off option.'),
    mk('direct', 'B. Direct descent from the translunar trajectory', [
      { name: 'TLI', dv: tli, kind: 'computed' },
      { name: 'Braking + landing', dv: direct, kind: 'computed + allowance' },
    ], transferDays, `≈${transferDays.toFixed(1)} d (same coast; no lunar orbit phase)`,
      'Surveyor / Luna 9 style. Slightly lower total than A in this model, but a single uninterruptible braking burn, no orbit to wait in, and the reachable sites are tied to the approach geometry and arrival date.'),
    mk('nrho', 'C. Via NRHO (Gateway-type staging), then LLO and descent', [
      { name: 'TLI', dv: tli, kind: 'computed' },
      { name: 'Flyby + NRHO insertion', dv: p.nrhoInsertKmS, kind: 'literature approx.' },
      { name: 'NRHO → LLO', dv: p.nrhoToLloKmS, kind: 'literature approx.' },
      { name: 'Descent', dv: descent, kind: 'computed + allowance' },
    ], 5.5, '≈5 d to NRHO + ≈0.5 d NRHO → LLO (literature approx.), plus any stay in NRHO',
      'Artemis-type staging. Costs more lander delta-V than A, but NRHO is cheap to reach for a heavy crew vehicle, has near-continuous Earth view and favourable south-pole access. NRHO figures are published approximations (e.g. Whitley & Martinez 2016, "Options for staging orbits in cislunar space") and depend on transfer time — verify before use.'),
    mk('blt', 'D. Low-energy (ballistic) lunar transfer → LLO → descent', [
      { name: 'TLI (to high apogee)', dv: tliBlt, kind: 'computed' },
      { name: 'LOI (v∞ ≈ 0)', dv: loiBlt, kind: 'approx. model' },
      { name: 'Descent', dv: descent, kind: 'computed + allowance' },
    ], 105, '≈3–4 months (≈90–130 d typical of flown missions)',
      'Uses solar gravity near ≈1–1.5 million km to raise perigee to the Moon and arrive at low relative speed (GRAIL, CAPSTONE, Hakuto-R, Danuri, SLIM flew transfers of this family). Arrival is modelled as a parabolic approach; real trajectories differ by tens of m/s and need extra trajectory-correction budget. Saves LOI propellant at the cost of months of flight time and operations.'),
  ];
  return {
    inputs: p, vLeo, tli, transferDays, vApogee, vMoon, vInf, vLlo, vHypPeri, loi, doi, vSurfPeri,
    descentIdeal, descent, ascent, vImpact, direct, tliBlt, loiBlt, planeChange, lloPeriodMin, ve,
    ascentFrac: mf(ascent), options,
  };
}

function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('dv-style')) return;
  const s = document.createElement('style');
  s.id = 'dv-style';
  s.textContent = `
.dv-root{color:var(--text,#e6e9ef);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.dv-root h3{margin:0 0 6px;font-size:16px}.dv-root h4{margin:14px 0 6px;font-size:14px;color:var(--accent,#6cb4ff)}
.dv-card{background:var(--panel,#161b24);border:1px solid var(--border,#2a3242);border-radius:8px;padding:12px;margin:0 0 12px}
.dv-muted{color:var(--muted,#93a0b5);font-size:12.5px}
.dv-banner{padding:8px 10px;border-radius:6px;border-left:4px solid #e0a83a;background:var(--bg,#0d1117);margin:8px 0;font-size:13px}
.dv-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:6px 14px;margin:8px 0}
.dv-form label{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;color:var(--muted,#93a0b5)}
.dv-root input{width:90px;background:var(--bg,#0d1117);color:var(--text,#e6e9ef);border:1px solid var(--border,#2a3242);border-radius:4px;padding:3px 6px;font:inherit;font-size:13px}
.dv-scroll{overflow-x:auto}
.dv-table{width:100%;border-collapse:collapse;margin:8px 0;font-variant-numeric:tabular-nums;font-size:13px}
.dv-table th{text-align:left;color:var(--muted,#93a0b5);font-weight:600;border-bottom:1px solid var(--border,#2a3242);padding:4px 6px;vertical-align:bottom}
.dv-table td{padding:5px 6px;border-bottom:1px solid var(--border,#2a3242);vertical-align:top}
.dv-table td.dv-num,.dv-table th.dv-num{text-align:right;white-space:nowrap}
.dv-leg{display:flex;justify-content:space-between;gap:10px;white-space:nowrap}
.dv-leg small{color:var(--muted,#93a0b5)}
.dv-tot{font-weight:700;font-size:15px}
.dv-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin:8px 0}
.dv-kv div{background:var(--bg,#0d1117);border:1px solid var(--border,#2a3242);border-radius:6px;padding:6px 8px}
.dv-kv b{display:block;font-size:16px;font-variant-numeric:tabular-nums}.dv-kv span{color:var(--muted,#93a0b5);font-size:12px}
.dv-root details{margin:8px 0}.dv-root summary{cursor:pointer;color:var(--accent,#6cb4ff)}
.dv-root code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
.dv-root ul{margin:6px 0;padding-left:20px}.dv-root li{margin:3px 0}`;
  document.head.appendChild(s);
}

const INPUTS = [
  ['leoAltKm', 'LEO parking orbit altitude (km)', 10],
  ['lloAltKm', 'Low lunar orbit altitude (km)', 10],
  ['descentLossKmS', 'Descent loss allowance (km/s)', 0.05],
  ['ascentLossKmS', 'Ascent loss allowance (km/s)', 0.05],
  ['directLossKmS', 'Direct-descent loss allowance (km/s)', 0.05],
  ['nrhoInsertKmS', 'NRHO insertion incl. powered flyby (km/s, literature)', 0.01],
  ['nrhoToLloKmS', 'NRHO → LLO transfer (km/s, literature)', 0.01],
  ['bltApogeeKm', 'Low-energy transfer apogee (km)', 50000],
  ['ispS', 'Specific impulse Isp (s)', 5],
];
const k3 = v => Number.isFinite(v) ? v.toFixed(3) : '–';
const k2 = v => Number.isFinite(v) ? v.toFixed(2) : '–';
const pc = v => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '–';

export function renderDeltaVPanel(container, lat, lon) {
  injectStyle();
  lat = Math.max(-90, Math.min(90, Number(lat) || 0));
  lon = Number(lon) || 0;
  let lonN = ((lon + 180) % 360 + 360) % 360 - 180; if (lonN === -180) lonN = 180;
  const state = { ...DEFAULTS };
  const absLat = Math.abs(lat);
  container.innerHTML = `<div class="dv-root"><div class="dv-card">
    <h3>Getting there — delta-V by architecture (site ${absLat.toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lonN).toFixed(2)}°${lonN < 0 ? 'W' : 'E'})</h3>
    <div class="dv-banner">First-order estimates from two-body / patched-conic formulas with impulsive burns. They are for comparing architectures, not for mission design: no launch-window, plane-geometry, three-body, finite-burn or navigation effects, and no margins.</div>
    <div class="dv-form">${INPUTS.map(([k, label, step]) => `<label>${label} <input type="number" step="${step}" data-k="${k}" value="${state[k]}"></label>`).join('')}</div>
    <div class="dv-scroll"><table class="dv-table"><thead><tr>
      <th>Architecture</th><th>Delta-V legs (km/s)</th><th class="dv-num">Total from LEO<br>(km/s)</th><th class="dv-num">After TLI<br>(km/s)</th>
      <th class="dv-num">Landed mass ÷<br>mass in LEO</th><th class="dv-num">Landed mass ÷<br>mass after TLI</th><th>Transfer time</th></tr></thead>
      <tbody class="dv-body"></tbody></table></div>
    <div class="dv-muted">Mass ratios are the ideal rocket equation <code>m_f/m_0 = exp(−ΔV / (g₀·Isp))</code> for a single stage at the entered Isp; "landed mass" is everything that reaches the surface (dry stage + residuals + payload), so real payload fractions are lower. In practice TLI is usually flown by the launcher's upper stage at a different Isp — use the "after TLI" column for the lander itself.</div>
    <h4>Building blocks (computed from the inputs)</h4>
    <div class="dv-kv dv-blocks"></div>
    <h4>Orbit inclination and site access</h4>
    <div class="dv-incl dv-muted"></div>
    <h4>Return leg</h4>
    <div class="dv-asc dv-muted"></div>
    <details><summary>Assumptions &amp; formulas</summary><ul class="dv-muted">
      <li>Constants: μ_Earth = 398 600.44 km³/s², R_Earth = 6378.137 km, μ_Moon = 4902.8 km³/s², R_Moon = 1737.4 km, Earth–Moon distance 384 400 km (Moon's orbit taken as circular; real distance varies 356–407 thousand km, shifting TLI by a few m/s and LOI by tens of m/s).</li>
      <li><b>TLI</b>: vis-viva on a transfer ellipse with perigee at the LEO radius and apogee at the Moon's distance: <code>ΔV = √(μ(2/r₁ − 1/a_t)) − √(μ/r₁)</code>, <code>a_t = (r₁ + 384 400)/2</code>. Lunar gravity during the coast is ignored. Coast time = half the ellipse period (the slowest, minimum-energy case).</li>
      <li><b>LOI</b>: patched conic. <code>v∞ = v_Moon − v_apogee</code> (coplanar, tangential arrival), then <code>ΔV = √(v∞² + 2μ_M/r_p) − √(μ_M/r_p)</code> at periapsis radius r_p = R_Moon + LLO altitude. Faster transfers raise v∞ and LOI.</li>
      <li><b>Descent from LLO</b>: ideal = de-orbit burn onto an ellipse with periapsis at the surface, plus cancelling the periapsis speed there (Hohmann-like, impulsive, no gravity loss), then a user-set allowance for gravity loss, throttling, pitch-over and hazard avoidance. Flown and designed landers from ≈100 km orbits typically budget about 1.9–2.1 km/s in total — that range is quoted as typical, the ideal part is computed.</li>
      <li><b>Direct descent</b>: ideal = hyperbolic arrival speed at the surface radius, <code>√(v∞² + 2μ_M/R_M)</code>, plus the allowance.</li>
      <li><b>NRHO</b> legs are not computed here (NRHOs are three-body orbits with no two-body formula). Defaults are literature approximations: ≈0.45 km/s for outbound powered flyby + insertion on a ≈5-day transfer, ≈0.73 km/s for NRHO → 100 km polar LLO in ≈0.5 d. Published values vary with transfer duration and the specific NRHO; verify against a current source.</li>
      <li><b>Low-energy transfer</b>: TLI from vis-viva to the entered high apogee (two-body; the Sun does the perigee-raising for free); LOI modelled as capture from a parabolic approach, <code>(√2 − 1)·v_circ</code>. True ballistic-capture trajectories need a three/four-body solver; flown missions report LOI savings of roughly 0.1–0.2 km/s relative to a direct transfer, consistent with this model.</li>
      <li>Launch to LEO (roughly 9.3–9.5 km/s including losses, typical textbook value) is not included.</li>
      <li>Ascent: ideal value equals ideal descent (time-reversed), plus its own allowance.</li>
    </ul></details>
  </div></div>`;
  const root = container.firstElementChild;
  const $ = s => root.querySelector(s);

  function draw() {
    const r = computeDeltaV(state, lat);
    $('.dv-body').innerHTML = r.options.map(o => `<tr>
      <td><b>${o.name}</b><div class="dv-muted">${o.notes}</div></td>
      <td>${o.legs.map(l => `<div class="dv-leg"><span>${l.name} <small>(${l.kind})</small></span><span>${k3(l.dv)}</span></div>`).join('')}</td>
      <td class="dv-num dv-tot">${k2(o.total)}</td><td class="dv-num">${k2(o.afterTli)}</td>
      <td class="dv-num">${pc(o.fracOfLeo)}</td><td class="dv-num">${pc(o.fracOfTli)}</td>
      <td>${o.timeNote}</td></tr>`).join('');
    $('.dv-blocks').innerHTML = [
      [k3(r.vLeo), 'LEO circular speed (km/s)'], [k3(r.tli), 'TLI (km/s)'], [r.transferDays.toFixed(2), 'minimum-energy coast (days)'],
      [k3(r.vInf), 'v∞ at the Moon (km/s)'], [k3(r.vLlo), 'LLO circular speed (km/s)'], [r.lloPeriodMin.toFixed(1), 'LLO period (min)'],
      [k3(r.loi), 'LOI (km/s)'], [k3(r.descentIdeal), 'ideal descent from LLO (km/s)'],
      [k3(r.descent), 'descent incl. allowance (km/s)'], [k3(r.vImpact), 'ideal direct-descent braking (km/s)'],
      [k3(r.tliBlt), 'low-energy TLI (km/s)'], [k3(r.loiBlt), 'low-energy LOI model (km/s)'],
    ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
    $('.dv-incl').innerHTML = `
      <p>A lunar orbit's ground track only reaches latitudes up to its inclination, so landing at this site from orbit needs inclination <b>i ≥ ${absLat.toFixed(1)}°</b> (or ≤ ${(180 - absLat).toFixed(1)}° retrograde). A polar orbit (i = 90°) passes over every latitude, and because the Moon rotates once per 27.3 days beneath it, a given site crosses the orbit plane about every 13.7 days.</p>
      <p>${absLat < 10 ? 'This near-equatorial site is reachable from low-inclination orbits, including those compatible with free-return trajectories (as on early Apollo missions).'
        : absLat < 60 ? 'This mid-latitude site needs a moderately inclined orbit; the inclination is normally chosen by targeting the lunar approach (B-plane) at TLI or a small mid-course burn, at little delta-V cost, but it rules out a simple equatorial free-return profile.'
          : 'This high-latitude site effectively needs a polar or near-polar orbit. That is normally set up by targeting the lunar approach (B-plane) at TLI or mid-course at little delta-V cost; it is incompatible with a simple free-return trajectory, and lighting and Earth-view constraints at the pole narrow the landing opportunities.'}</p>
      <p>For scale: if the inclination had to be changed by ${absLat.toFixed(1)}° with a single burn <em>inside</em> the ${state.lloAltKm} km orbit instead, it would cost <code>2·v·sin(Δi/2)</code> = <b>${k3(r.planeChange)} km/s</b> — which is why the plane is chosen on approach, not after capture.</p>
      <p>Direct descent (B) has no orbit plane, but the reachable landing points are set by the approach direction on the arrival date. Architecture C starts from a near-polar NRHO, which suits polar sites; reaching low-latitude sites from NRHO generally costs more or takes longer than the default figure.</p>`;
    $('.dv-asc').innerHTML = `Ascent from the surface back to the ${state.lloAltKm} km orbit: ideal ${k3(r.descentIdeal)} km/s + ${k2(state.ascentLossKmS)} allowance = <b>${k3(r.ascent)} km/s</b> (mass in orbit ÷ lift-off mass = ${pc(r.ascentFrac)} at Isp ${state.ispS} s). Return to Earth then needs trans-Earth injection ≈ the LOI value (${k3(r.loi)} km/s in this model) with direct atmospheric entry. From NRHO-based architectures add the LLO → NRHO leg (≈ the same literature figure as NRHO → LLO).`;
  }
  root.addEventListener('input', e => {
    const k = e.target.dataset.k;
    if (!k) return;
    const v = Number(e.target.value);
    if (e.target.value.trim() === '' || !Number.isFinite(v) || v < 0 || (k === 'ispS' && v <= 0)) return;
    state[k] = v; draw();
  });
  draw();
}

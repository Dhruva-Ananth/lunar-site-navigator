// LODESTAR — design report. Builds a PDF in the browser from the choices made in one run of the wizard
// and downloads it. Uses the vendored jsPDF + AutoTable (MIT licences), loaded only when a report is asked for.
// generateReport(design) → file name. `design` is the plain object built by buildDesign() in js/main.js.

let libP = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('Cannot load ' + src));
    document.head.append(s);
  });
}
function loadPdfLib() {
  if (!libP) libP = (async () => {
    if (!window.jspdf?.jsPDF) await loadScript(new URL('../vendor/jspdf.umd.min.js', import.meta.url).href);
    if (!window.jspdf?.jsPDF?.API?.autoTable) await loadScript(new URL('../vendor/jspdf.plugin.autotable.min.js', import.meta.url).href);
    if (!window.jspdf?.jsPDF?.API?.autoTable) throw new Error('PDF table plugin did not load');
    return window.jspdf;
  })().catch(e => { libP = null; throw e; });
  return libP;
}

// The built-in PDF fonts only cover Latin-1, so symbols outside it are written out.
const SUBS = { '≥': '>=', '≤': '<=', '→': '->', '←': '<-', '≈': 'about ', '−': '-', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"',
  '…': '...', '•': '-', 'Δ': 'Delta-', '↑': 'high', '↓': 'low', '₂': '2', '₃': '3', '★': '*', '∞': 'infinity', '√': 'sqrt', '≠': '!=' };
export function clean(v) {
  return String(v ?? '').replace(/[^\x00-\xFF]/g, ch => SUBS[ch] ?? '?').replace(/about (\d)/g, 'about $1');
}

const fin = Number.isFinite;
const n = (v, d = 0) => fin(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d }) : 'n/a';
const sig = v => !fin(v) ? 'n/a' : Math.abs(v) >= 1000 ? n(v, 0) : Math.abs(v) >= 100 ? n(v, 1) : Math.abs(v) >= 1 ? n(v, 2) : n(v, 3);
const pct = (f, d = 1) => fin(f) ? (f * 100).toFixed(f > 0 && f < 0.01 ? 3 : d) + '%' : 'n/a';
const ll = (lat, lon, d = 2) => `${Math.abs(lat).toFixed(d)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(d)}°${lon >= 0 ? 'E' : 'W'}`;
const km2 = a => fin(a) ? `${n(a, 0)} km²` : 'n/a';
const mass = kg => !fin(kg) ? 'not possible' : kg >= 1000 ? `${n(kg / 1000, 2)} t` : `${n(kg, 0)} kg`;
const power = w => !fin(w) ? 'n/a' : w >= 1000 ? `${n(w / 1000, 1)} kW` : `${n(w, 0)} W`;
const hours = h => !fin(h) ? 'permanent' : h >= 48 ? `${n(h / 24, 1)} Earth days (${n(h, 0)} h)` : `${n(h, 0)} h`;
const u = units => (units ? ' ' + units : '');

function limitText(name, min, max, units) {
  if (min != null && max != null) return `${name} shall be between ${sig(min)} and ${sig(max)}${u(units)}`;
  if (min != null) return `${name} shall be at least ${sig(min)}${u(units)}`;
  return `${name} shall be at most ${sig(max)}${u(units)}`;
}

// Requirements derived from what the user entered. Each: [id, requirement, set in, status at the site].
export function buildRequirements(d) {
  const rows = [], id = (p, i) => `${p}-${String(i).padStart(2, '0')}`;
  let i = 0, j = 0;
  for (const r of d.resources || []) {
    const achieved = `area mean ${sig(r.areaMean)}${u(r.units)}; selected cell ${sig(r.bestCell)}${u(r.units)}`;
    if (r.min != null || r.max != null) rows.push([id('REQ-RES', ++i), limitText(r.name, r.min, r.max, r.units), 'Step 1', `Met by every cell of the area (${achieved})`]);
    if (r.weight > 0) rows.push([id('PRF-RES', ++j), `Prefer ${r.prefer === 'low' ? 'low' : 'high'} ${r.name} (weight ${r.weight.toFixed(2)})`, 'Step 1', achieved.charAt(0).toUpperCase() + achieved.slice(1)]);
  }
  if (!rows.length) rows.push(['REQ-RES-00', 'No resource requirement was set', 'Step 1', 'n/a']);
  const t = d.terrain || {};
  i = 0;
  if (t.elevMin != null || t.elevMax != null) rows.push([id('REQ-TER', ++i), limitText('Elevation', t.elevMin, t.elevMax, 'm'), 'Step 2', `Met by every cell of the area (area mean ${sig(t.elevMean)} m)`]);
  if (t.slopeOn) rows.push([id('REQ-TER', ++i), `Regional slope shall not exceed ${sig(t.slopeMax)}°`, 'Step 2', `Met by every cell of the area (area mean ${sig(t.slopeMean)}°; selected cell ${sig(t.slopeBest)}°)`]);
  if (t.latMin > -90 || t.latMax < 90) rows.push([id('REQ-TER', ++i), `Latitude shall be between ${t.latMin}° and ${t.latMax}°`, 'Step 2', `Site at ${ll(d.site.lat, d.site.lon)}`]);
  if (t.slopeWeight > 0) rows.push(['PRF-TER-01', `Prefer flat ground (slope weight ${t.slopeWeight.toFixed(2)})`, 'Step 2', `Area mean slope ${sig(t.slopeMean)}°`]);
  const c = d.comms || {};
  rows.push(['REQ-COM-01', `Link to Earth: ${c.modeText}${fin(c.maskDeg) ? `, counted only above ${c.maskDeg}° elevation at the site` : ''}`, 'Step 3',
    c.link ? `Modelled availability at the site ${pct(c.link.availability, 0)}` : 'Link model not available']);
  if (c.minAvail > 0) rows.push(['REQ-COM-02', `A link to Earth shall exist at least ${pct(c.minAvail, 0)} of the time`, 'Step 3',
    c.applied ? `Met by every cell of the area (area mean ${pct(c.availMean, 0)}; selected cell ${pct(c.availBest, 0)})` : 'Not applied: comms model unavailable']);
  const p = d.power;
  if (p) {
    rows.push(['REQ-PWR-01', `Supply a continuous electrical load of ${sig(p.inputs.loadKw)} kW`, 'Step 5', `Chosen system: ${p.systemText}, about ${mass(p.systemMassKg)}`]);
    rows.push(['REQ-PWR-02', `Carry the load through the longest darkness at the site (${hours(p.illumination.longestDarkH)})`, 'Step 5',
      p.choice === 'solar' ? `Storage of ${n(p.solar.storageWh / 1000, 0)} kWh, ${mass(p.solar.storageMassKg)}` : 'Fission power does not depend on sunlight']);
  }
  const m = d.mission;
  if (m) {
    rows.push(['REQ-MIS-01', `Deliver ${n(m.landedKg, 0)} kg to the surface at the site${m.powerKgIncluded ? ` (${n(m.payloadKg, 0)} kg lander and payload + ${n(m.powerKgIncluded, 0)} kg power system)` : ''}`, 'Step 6',
      `Needs ${mass(m.masses.mTli)} at trans-lunar injection`]);
    rows.push(['REQ-MIS-02', `Launch on ${m.launcher.name} (${m.launcher.config || 'configuration not stated'})`, 'Step 6', m.verdict.text.charAt(0).toUpperCase() + m.verdict.text.slice(1)]);
    rows.push(['REQ-MIS-03', `Reach the site by: ${m.config.name}`, 'Step 6', `Total delta-V from low Earth orbit ${m.config.total.toFixed(2)} km/s; transfer ${m.config.timeText}`]);
  }
  return rows;
}

export async function generateReport(d) {
  const { jsPDF } = await loadPdfLib();
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 46, CW = W - 2 * M, BOTTOM = H - 54;
  const INK = [34, 40, 52], MUTED = [98, 108, 126], NAVY = [20, 33, 61], BLUE = [57, 135, 229];
  let y = M;
  const ensure = h => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
  const h1 = text => {
    ensure(70); y += 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13.5); doc.setTextColor(...NAVY); doc.text(clean(text), M, y);
    y += 7; doc.setDrawColor(...BLUE); doc.setLineWidth(1.2); doc.line(M, y, M + CW, y); y += 16;
  };
  const h2 = text => { ensure(40); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...NAVY); doc.text(clean(text), M, y); y += 13; };
  const para = (text, { size = 9.5, color = INK, gap = 8, indent = 0 } = {}) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(size); doc.setTextColor(...color);
    for (const line of doc.splitTextToSize(clean(text), CW - indent)) { ensure(size * 1.4); doc.text(line, M + indent, y); y += size * 1.38; }
    y += gap;
  };
  const bullets = items => { for (const it of items) { ensure(14); doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK); doc.text('-', M + 2, y); para(it, { gap: 3, indent: 12 }); } y += 6; };
  const table = (head, body, opts = {}) => {
    ensure(64);
    doc.autoTable({
      rowPageBreak: 'avoid',
      startY: y, head: head ? [head.map(clean)] : undefined, body: body.map(r => r.map(c => clean(c))),
      margin: { left: M, right: M, top: M, bottom: H - BOTTOM }, theme: 'grid',
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 4, textColor: INK, lineColor: [212, 218, 228], lineWidth: 0.5, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: NAVY, textColor: 255, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [246, 248, 251] }, ...opts,
    });
    y = doc.lastAutoTable.finalY + 14;
  };
  const kv = rows => table(null, rows.filter(Boolean), { columnStyles: { 0: { cellWidth: 150, fontStyle: 'bold' } } });

  const { site, area, selection: sel, terrain: t, comms: c, power: p, mission: m } = d;

  // ---- title block ----
  doc.setFillColor(...NAVY); doc.rect(0, 0, W, 132, 'F');
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(30); doc.text('LODESTAR', M, 60);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.text(clean(d.app.full), M, 78);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('Site and mission design report', M, 110);
  y = 156;
  kv([
    ['Iteration', d.iteration.id],
    ['Generated', `${d.iteration.createdLocal} (local time); ${d.iteration.created} (UTC)`],
    ['Landing site', `Area ${area.id}, design point ${ll(site.lat, site.lon)}`],
    ['Status of this document', 'Generated automatically from the choices made in one run of the LODESTAR web tool. All values are first-order estimates from coarse global data, for comparing options. It is not a mission design.'],
  ]);
  if (d.demo) para('WARNING: this run used SYNTHETIC DEMO DATA, not real measurements. Nothing in this report describes the real Moon.', { color: [180, 40, 40] });

  // ---- 1 summary ----
  h1('1  Summary');
  kv([
    ['Selected area', `Area ${area.id} (rank ${area.rank} of ${sel.nAreas}), ${km2(area.areaKm2)}, centred ${ll(area.centroid.lat, area.centroid.lon)}`],
    ['Design point', `${ll(site.lat, site.lon)} - the best-scoring cell of the area (score ${fin(area.best.score) ? area.best.score.toFixed(3) : 'n/a'})`],
    ['Communications', `${c.modeText}${c.link ? `; modelled availability at the site ${pct(c.link.availability, 0)}` : ''}`],
    p ? ['Power', `${p.systemText}, about ${mass(p.systemMassKg)} (${p.choice === p.recommended ? 'the lighter option in this model' : 'chosen by the user against the lighter option'})`] : ['Power', 'Not evaluated in this run'],
    m ? ['Launch and transfer', m.summaryLine] : ['Launch and transfer', 'Not evaluated in this run'],
  ]);

  // ---- 2 requirements ----
  h1('2  Requirements');
  para('These are the limits and choices entered in this run, written as requirements. REQ rows are hard limits; PRF rows are preferences that only rank the candidates. "Met" refers to the coarse global data and first-order models described in section 8.', { color: MUTED, size: 9 });
  table(['ID', 'Requirement', 'Set in', 'Status at the selected site'], buildRequirements(d), { columnStyles: { 0: { cellWidth: 62, fontStyle: 'bold' }, 2: { cellWidth: 40 }, 3: { cellWidth: 185 } } });

  // ---- 3 site ----
  h1('3  Site selection');
  kv([
    ['Area', `Area ${area.id}: ${km2(area.areaKm2)} in ${n(area.nCells)} grid cells of ${sel.gridStepDeg}°`],
    ['Centroid', ll(area.centroid.lat, area.centroid.lon)],
    ['Bounding box', `latitude ${area.bbox.latMin}° to ${area.bbox.latMax}°, longitude ${area.bbox.allLon ? 'all' : `${area.bbox.lonMin}° to ${area.bbox.lonMax}°${area.bbox.wraps ? ' (crosses 180°)' : ''}`}`],
    ['Mean score', fin(area.meanScore) ? area.meanScore.toFixed(3) : 'n/a'],
    ['Area filter', `Best ${sel.keepPct}% of the suitable surface by score; areas under ${km2(sel.minAreaKm2)} dropped; ${sel.nAreas} area(s) found, ${km2(sel.totalKm2)} in total`],
  ]);
  h2('How the suitable surface narrowed');
  table(['Stage', 'Surface left', 'Share of the Moon'], d.funnel.map(f => [f.name, km2(f.km2), pct(f.frac, 2)]), { columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } } });
  if (d.siteImage?.url) {
    const w = Math.min(CW, 380), h = w * d.siteImage.h / d.siteImage.w;
    ensure(h + 30);
    try {
      doc.addImage(d.siteImage.url, 'JPEG', M, y, w, h); y += h + 14;
      para('Figure 1. The globe as shown in step 4, with the matching areas outlined.', { color: MUTED, size: 8.5 });
    } catch (e) { para('(The globe image could not be embedded.)', { color: MUTED, size: 8.5 }); }
  }

  // ---- 4 comms ----
  h1('4  Communications');
  const L = c.link;
  kv([
    ['Link path', c.modeText],
    c.mode === 'relay' ? ['Relay', c.relayName || 'n/a'] : null,
    ['Earth station and band', `DSN ${c.dsnDishM ?? '?'} m dish, ${c.band ?? '?'}-band`],
    ['Site elevation mask', fin(c.maskDeg) ? `${c.maskDeg}°` : 'n/a'],
    ['Minimum availability required', c.minAvail > 0 ? pct(c.minAvail, 0) : 'none'],
    L ? ['Availability at the site', pct(L.availability, 0)] : null,
    L ? ['Contact time', `${fin(L.contactHoursPerDay) ? n(L.contactHoursPerDay, 1) : 'n/a'} h per day (long-run mean)`] : null,
    L && fin(L.passesPerDay) ? ['Passes', `${n(L.passesPerDay, 1)} per day, typically ${fin(L.typicalPassMin) ? n(L.typicalPassMin, 0) + ' min' : 'n/a'}`] : null,
    L ? ['Longest gap', fin(L.longestGapH) ? hours(L.longestGapH) : 'no link at this site'] : null,
    L && fin(L.oneWayLightTimeS) ? ['One-way light time', `${L.oneWayLightTimeS.toFixed(2)} s`] : null,
    L && fin(L.dataRateBps) ? ['Indicative data rate', `${n(L.dataRateBps / 1e6, 1)} Mbit/s (illustrative link budget)`] : null,
    L && fin(L.dataVolumePerDayBits) ? ['Indicative data volume', `${n(L.dataVolumePerDayBits / 8e9, 1)} GB per day`] : null,
  ]);
  if (L?.notes?.length) { h2('Model notes'); bullets(L.notes.slice(0, 8)); }

  // ---- 5 power ----
  h1('5  Surface power');
  if (!p) para('The power step was not completed in this run.');
  else {
    const il = p.illumination, inp = p.inputs;
    kv([
      ['Continuous load', `${sig(inp.loadKw)} kW`],
      ['Sunlight', `${pct(il.fracLit, 0)} of the year; longest darkness ${hours(il.longestDarkH)}`],
      ['Solar cells', `${sig(inp.effPct)}% efficient; ${sig(inp.areaM2)} m² per mast, ${sig(inp.fillPct)}% active area, ${sig(inp.lossPct)}% system losses`],
      ['Array type', `${p.perMast.arrayTypeName}, ${sig(inp.mastM)} m above the ground`],
      ['One mast', `${power(p.perMast.peakW)} facing the Sun; ${power(p.perMast.meanW)} averaged over the year (${pct(p.perMast.capacityFactor, 0)} of full output)`],
      ['Storage assumptions', `${sig(inp.storeWhKg)} Wh/kg, ${sig(inp.dodPct)}% usable, ${sig(inp.rtPct)}% round-trip efficiency`],
    ]);
    table(['Option', 'Make-up', 'Mass to land'], [
      ['Solar with storage', fin(p.solar.masts) ? `${p.solar.masts} mast(s), ${power(p.solar.arrayPeakW)} peak (${mass(p.solar.arrayMassKg)} at ${sig(inp.specPowerWkg)} W/kg) + ${n(p.solar.storageWh / 1000, 0)} kWh storage (${mass(p.solar.storageMassKg)})` : 'Not workable at this site', mass(p.solar.totalMassKg)],
      ['Fission', `${p.fission.units} unit(s) of 40 kWe (${p.fission.kWe} kWe)`, `at most ${mass(p.fission.massKg)}`],
    ], { columnStyles: { 0: { cellWidth: 110, fontStyle: 'bold' }, 2: { cellWidth: 90, halign: 'right' } } });
    para(`Assessment: ${p.reason}`);
    para(`Carried into the mission step: ${p.systemText}, about ${mass(p.systemMassKg)}${p.userOverride ? ' (the user chose this against the lighter option)' : ''}.`);
    h2('Output by array type (one mast)');
    table(['Array type', 'Year-average output', 'Share of full output'], p.arrayTypes.map(a => [a.name, power(a.meanW), pct(a.capacityFactor, 0)]), { columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } } });
    para(`Illumination is estimated by tracing the Sun for one year against a terrain horizon read from the LRO LOLA elevation grid (about ${il.demPixelKm.toFixed(1)} km per pixel here). That grid cannot resolve small sunlit peaks or crater rims, so polar values are indicative only. Fission reference: ${p.references.fsp.text} (${p.references.fsp.source}). Solar reference: ${p.references.vsat.name} - ${p.references.vsat.text}`, { color: MUTED, size: 8.5 });
  }

  // ---- 6 mission ----
  h1('6  Launch and transfer');
  if (!m) para('The mission step was not completed in this run.');
  else {
    kv([
      ['Landed mass', `${n(m.landedKg, 0)} kg${m.powerKgIncluded ? ` = ${n(m.payloadKg, 0)} kg lander and payload + ${n(m.powerKgIncluded, 0)} kg power system` : p ? ' (power system mass not included)' : ''}`],
      ['Lander engine', `Specific impulse ${sig(m.ispS)} s for every burn after trans-lunar injection`],
      ['Launch vehicle', `${m.launcher.name} - ${m.launcher.operator}, ${m.launcher.country}; ${m.launcher.config}`],
      ['Launcher status', `${m.launcher.status}${m.launcher.statusShort ? ' - ' + m.launcher.statusShort : ''} (data as of ${m.dataAsOf || 'unknown'})`],
      ['Trans-lunar capability', m.launcher.tliText],
      ['Verdict', m.summaryLine],
      ['Transfer', `${m.config.name}; ${m.config.timeText}`],
      ['Lunar orbit', m.config.inclination],
      ['Mass at trans-lunar injection', `${n(m.masses.mTli, 0)} kg, of which ${n(m.masses.propAfterTli, 0)} kg is propellant`],
    ]);
    h2('Delta-V budget');
    table(['Burn', 'Basis', 'Delta-V (km/s)'], [...m.config.legs.map((l, i) => [`${i + 1}. ${l.name}`, l.kind, l.dv.toFixed(3)]), ['Total from low Earth orbit', '', m.config.total.toFixed(3)], ['After trans-lunar injection (by the lander)', '', m.config.afterTli.toFixed(3)]],
      { columnStyles: { 2: { halign: 'right', cellWidth: 90 } } });
    if (m.caveats?.length) bullets(m.caveats);
    if (m.launcher.source) para(`Launcher data source: ${m.launcher.source}`, { color: MUTED, size: 8.5 });
  }

  // ---- 7 data sources ----
  h1('7  Data sources');
  table(['Layer', 'Instrument and mission', 'Agency', 'Source'], [
    ...(d.albedo ? [['Surface imagery', d.albedo.mission || '', d.albedo.agency || '', d.albedo.source || '']] : []),
    ...d.sources.map(s => [`${s.name}${s.units ? ` (${s.units})` : ''}${s.demo ? ' - SYNTHETIC' : ''}`, s.mission || '', s.agency || '', s.source || '']),
  ], { styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 3, textColor: INK, lineColor: [212, 218, 228], lineWidth: 0.5, overflow: 'linebreak' }, columnStyles: { 0: { cellWidth: 130 }, 2: { cellWidth: 40 }, 3: { cellWidth: 190 } } });

  // ---- 8 assumptions ----
  h1('8  Assumptions and limits');
  bullets([
    `Site screening uses global maps on a ${sel.gridStepDeg}° grid. Lunar Prospector element maps have pixels of roughly 15 to 150 km and the elevation grid used for screening is about 7.6 km per pixel, so area outlines and areas in km² are regional guidance, not surveyed boundaries.`,
    'Slope is a regional slope over kilometres. Lander-scale slopes, boulders and shadows are not resolved.',
    'Link availability is a geometric model (libration of Earth in the lunar sky, or a single relay on a fixed orbit) with a smooth Moon and no local terrain. Earth-station scheduling is not modelled, so contact time and data volume are upper bounds, and data rates are illustrative.',
    'Illumination and solar output come from a one-year Sun trace against a coarse terrain horizon. Storage is sized for the single longest darkness. Thermal control, structures, cabling and dust are not modelled. The fission mass is the upper bound of a published requirement, not a design.',
    'Delta-V comes from two-body, patched-conic formulas with impulsive burns. Masses use the ideal rocket equation with one stage and no margins. Some launcher capabilities to trans-lunar injection are estimates rather than published figures; the report marks which.',
    'Nothing here replaces mission analysis, a site survey with high-resolution data, or a power and communications system design.',
  ]);

  // ---- footers ----
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.setDrawColor(212, 218, 228); doc.setLineWidth(0.5); doc.line(M, H - 40, W - M, H - 40);
    doc.text(clean(`LODESTAR design report  -  ${d.iteration.id}  -  first-order estimates, not a mission design`), M, H - 28);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 28, { align: 'right' });
  }
  const file = `${d.iteration.id}_design-report.pdf`;
  doc.save(file);
  return file;
}

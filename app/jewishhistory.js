/* ============================================================================
   Jewish History Explorer — a globe shaded by Jewish population over time, with
   migration arcs, event pins, and a dual-track ("record" vs "tradition") timeline.
   Data: data/timeline.js (TAXO, EVENTS, MIGRATIONS) + data/jewish-data.js (JEWISH_DATA).
   Engine: globe.gl (bundled, MV3-CSP-safe). Forked from World Religions Explorer.
   ========================================================================== */
'use strict';

const TAXO   = window.TAXO || {};
const SLICES = TAXO.TIME_SLICES || [];
const CATS   = TAXO.categories || {};
const VERD   = TAXO.verdicts || {};
const EVENTS = (window.EVENTS || []).slice().sort((a, b) => a.year - b.year);
const MIGR   = window.MIGRATIONS || [];
const DATA   = window.JEWISH_DATA || {};
const EV_BY_ID = {}; EVENTS.forEach(e => (EV_BY_ID[e.id] = e));

const yr = id => parseInt(id, 10);
const NOW = 2025;
// STEPS = the time anchors (the slider steps straight through them).
const STEPS = SLICES.map(s => ({ year: yr(s.id), era: s.era, label: s.label }));
const N = STEPS.length;
const curYear = () => STEPS[state.stepIdx].year;
function nearestStep(year) { let bi = 0, bd = Infinity; STEPS.forEach((s, i) => { const d = Math.abs(s.year - year); if (d < bd) { bd = d; bi = i; } }); return bi; }

const NEUTRAL = 'rgba(70, 80, 105, 0.16)';        // no data ever / uninhabited
const EMPTIED = 'rgba(36, 48, 78, 0.20)';         // had a community, now ~none
const ERA_LABEL = { ancient: 'antiquity', classical: 'classical', medieval: 'medieval', earlymodern: 'early modern', modern: 'modern', contemporary: 'contemporary' };
const A3_TO_A2 = { FRA: 'FR', NOR: 'NO', CYN: 'CY', SOL: 'SO' };
const MIG_COL = { forced: '224,86,31', return: '26,161,121', voluntary: '90,160,239', tradition: '216,163,46' };

const state = {
  stepIdx: N - 1,        // open on today
  hovered: null, selected: null, selectedEvent: null,
  playing: false, playDir: 1,
  metric: 'pop',         // 'pop' | 'share' | 'world'
  flat: false,
  layers: { events: true, migrations: true, tradition: true },
};
let playTimer = null, spinOn = true;

/* ----------------------------- data helpers ----------------------------- */
function isoOf(props) { const a2 = props.ISO_A2; if (a2 && a2 !== '-99') return a2; return A3_TO_A2[props.ADM0_A3] || null; }

// Interpolated { pop, share } at a given YEAR; null before a country's first anchor.
function valAt(rec, year) {
  if (!rec || !rec.s) return null;
  const av = Object.keys(rec.s).map(id => ({ y: yr(id), v: rec.s[id] })).sort((a, b) => a.y - b.y);
  if (!av.length || year < av[0].y) return null;
  if (year >= av[av.length - 1].y) return av[av.length - 1].v;
  let lo = av[0], hi = av[av.length - 1];
  for (let i = 0; i < av.length - 1; i++) { if (av[i].y <= year && year <= av[i + 1].y) { lo = av[i]; hi = av[i + 1]; break; } }
  if (year === lo.y) return lo.v;
  const t = (year - lo.y) / (hi.y - lo.y);
  const pop = Math.round((lo.v.pop || 0) + ((hi.v.pop || 0) - (lo.v.pop || 0)) * t);
  let share = null, ls = lo.v.share, hs = hi.v.share;
  if (ls != null && hs != null) share = ls + (hs - ls) * t;
  else if (ls != null) share = ls; else if (hs != null) share = hs;
  return { pop, share };
}
const _wt = {};
function worldTotal(year) {
  if (year in _wt) return _wt[year];
  let s = 0; for (const iso in DATA) { const v = valAt(DATA[iso], year); if (v && v.pop > 0) s += v.pop; }
  return (_wt[year] = s);
}
const clamp01 = t => Math.max(0, Math.min(1, t));
// Map a country's value to 0..1 intensity for the active metric.
function metricT(v, year) {
  if (!v || v.pop <= 0) return null;
  if (state.metric === 'share') return clamp01(Math.sqrt((v.share || 0) / 100));
  if (state.metric === 'world') { const w = worldTotal(year) || 1; return clamp01(Math.sqrt((v.pop / w) / 0.45)); }
  return clamp01((Math.log10(v.pop) - 1) / (Math.log10(7e6) - 1));   // pop, log scale (10 → 7M)
}
// Map a year → fractional index among the anchors (for the timeline x-axis).
function anchorXFrac(year) {
  const ys = STEPS.map(s => s.year);
  if (year <= ys[0]) return 0;
  if (year >= ys[N - 1]) return N - 1;
  for (let i = 0; i < N - 1; i++) if (ys[i] <= year && year <= ys[i + 1]) return i + (year - ys[i]) / (ys[i + 1] - ys[i]);
  return N - 1;
}

const RAMP = ['#1b2c49', '#1f4f9e', '#2f8fe0', '#5ad0ff', '#eaf6ff'];
function lerpHex(h1, h2, t) {
  const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}
function rampColor(t) { t = clamp01(t); const seg = t * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(seg)); return lerpHex(RAMP[i], RAMP[i + 1], seg - i); }
function hexA(hex, a) { if (hex[0] !== '#') { const m = hex.match(/\d+/g); return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${a})`; } const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; }
function rgbaT(t, a) { const c = rampColor(t).match(/\d+/g); return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`; }

function fmtPop(n) { if (n == null) return '—'; if (n <= 0) return '0'; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.0+$/, '') + 'M'; if (n >= 1e3) return Math.round(n / 1e3) + 'k'; return '' + Math.round(n); }
function fmtYear(y) { return y < 0 ? (-y) + ' BCE' : y <= 1500 ? y + ' CE' : '' + y; }
const catColor = k => (CATS[k] && CATS[k].color) || '#888';
const catLabel = k => (CATS[k] && CATS[k].label) || k;

/* active window: events/migrations that the current slice "covers" */
function activeBand(i) {
  const y = STEPS[i].year;
  const lo = i > 0 ? (STEPS[i - 1].year + y) / 2 : y - 200;
  const hi = i < N - 1 ? (STEPS[i + 1].year + y) / 2 : y + 60;
  return [lo, hi];
}
const evActive = (e, lo, hi) => (e.end != null ? e.end : e.year) >= lo && e.year <= hi;
const migActive = (m, lo, hi) => m.end >= lo && m.start <= hi;
const evVisible = e => state.layers.events && (state.layers.tradition || e.track === 'record');
const migVisible = m => state.layers.migrations && (state.layers.tradition || m.track !== 'tradition');

/* -------------------------------- globe -------------------------------- */
let globe, countries = [];
const elViz = document.getElementById('globeViz');
const tooltip = document.getElementById('tooltip');

function capColor(feat) {
  const iso = isoOf(feat.properties);
  const v = iso ? valAt(DATA[iso], curYear()) : null;
  const sel = state.selected && iso === state.selected, hov = state.hovered && iso === state.hovered;
  if (!v || v.pop <= 0) {
    if (v && v.pop <= 0) return (sel || hov) ? 'rgba(90,100,130,0.4)' : EMPTIED;
    return (sel || hov) ? 'rgba(120,130,160,0.4)' : NEUTRAL;
  }
  const t = metricT(v, curYear());
  return rgbaT(t, sel ? 0.99 : hov ? 0.95 : 0.86);
}
function altOf(feat) {
  const iso = isoOf(feat.properties);
  const v = iso ? valAt(DATA[iso], curYear()) : null;
  let base = 0.01;
  if (v && v.pop > 0) base = 0.01 + (metricT(v, curYear()) || 0) * 0.13;
  if (state.selected && iso === state.selected) base += 0.04;
  else if (state.hovered && iso === state.hovered) base += 0.025;
  return base;
}

function initGlobe(geo) {
  countries = geo.features.filter(f => (f.properties.ADMIN || f.properties.NAME) !== 'Antarctica');
  globe = Globe()(elViz)
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true).atmosphereColor('#8fb7ff').atmosphereAltitude(0.16)
    .polygonsData(countries)
    .polygonCapColor(capColor)
    .polygonSideColor(() => 'rgba(20, 30, 55, 0.7)')
    .polygonStrokeColor(() => 'rgba(8, 12, 24, 0.85)')
    .polygonAltitude(altOf)
    .polygonsTransitionDuration(350)
    .onPolygonHover(onHover)
    .onPolygonClick(onClick)
    // migration arcs
    .arcStartLat(m => m.from.lat).arcStartLng(m => m.from.lng)
    .arcEndLat(m => m.to.lat).arcEndLng(m => m.to.lng)
    .arcColor(arcColor).arcStroke(m => 0.4 + (m.magnitude || 1) * 0.45)
    .arcAltitudeAutoScale(0.45)
    .arcDashLength(0.45).arcDashGap(0.18).arcDashInitialGap(m => (m.magnitude || 1) * 0.7)
    .arcDashAnimateTime(m => m.kind === 'forced' ? 2600 : 4200)
    .arcsTransitionDuration(0)
    // event pins (clickable DOM markers)
    .htmlElement(makePin).htmlLat(d => d.lat).htmlLng(d => d.lng).htmlAltitude(0.012);

  if (globe.onArcHover) globe.onArcHover(onArcHover);
  if (globe.onArcClick) globe.onArcClick(m => m && showMigrationToast(m));

  const mat = globe.globeMaterial();
  mat.color.set('#0a1626'); mat.emissive.set('#06101f'); mat.emissiveIntensity = 0.9; mat.shininess = 5;
  const c = globe.controls();
  c.autoRotate = true; c.autoRotateSpeed = 0.45; c.enableDamping = true; c.dampingFactor = 0.12;
  c.minDistance = 108; c.maxDistance = 600;
  globe.pointOfView({ lat: 31, lng: 25, altitude: 2.5 }, 0);
  window.globe = globe;

  sizeGlobe(); requestAnimationFrame(sizeGlobe);
  if (window.ResizeObserver) new ResizeObserver(sizeGlobe).observe(elViz);
  requestAnimationFrame(() => { const cv = elViz.querySelector('canvas'); if (cv) cv.addEventListener('webglcontextlost', e => { e.preventDefault(); showGlobeError(); }); });
  refreshArcs(); refreshPins();
}
function sizeGlobe() { if (globe) globe.width(elViz.clientWidth || window.innerWidth).height(elViz.clientHeight || (window.innerHeight - 242)); }
function refreshGlobe() { if (globe) globe.polygonCapColor(capColor).polygonAltitude(altOf); }

function arcColor(m) { const c = MIG_COL[m.track === 'tradition' ? 'tradition' : m.kind] || MIG_COL.voluntary; return [`rgba(${c},0.05)`, `rgba(${c},0.95)`]; }
function refreshArcs() {
  if (!globe) return;
  if (!state.layers.migrations) { globe.arcsData([]); return; }
  const [lo, hi] = activeBand(state.stepIdx);
  globe.arcsData(MIGR.filter(m => migActive(m, lo, hi) && migVisible(m)));
}

/* event pins */
function makePin(d) {
  const el = document.createElement('div');
  const col = catColor(d.cat);
  el.title = d.title + ' · ' + fmtYear(d.year);
  el.style.cssText = 'width:15px;height:15px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);cursor:pointer;' +
    'box-shadow:0 1px 4px rgba(0,0,0,.6);transition:transform .12s';
  if (d.track === 'tradition') { el.style.background = 'rgba(216,163,46,.18)'; el.style.border = '2px dashed ' + TAXO.tracks.tradition.color; }
  else { el.style.background = col; el.style.border = '1.5px solid rgba(8,12,24,.7)'; }
  if (d.track === 'both') el.style.boxShadow = '0 0 0 2px rgba(216,163,46,.65), 0 1px 4px rgba(0,0,0,.6)';
  if (state.selectedEvent === d.id) { el.style.transform = 'rotate(-45deg) scale(1.5)'; el.style.boxShadow = '0 0 0 3px #fff, 0 1px 6px rgba(0,0,0,.7)'; }
  el.addEventListener('click', ev => { ev.stopPropagation(); selectEvent(d.id, true); });
  return el;
}
function refreshPins() {
  if (!globe) return;
  if (!state.layers.events) { globe.htmlElementsData([]); return; }
  const [lo, hi] = activeBand(state.stepIdx);
  const act = EVENTS.filter(e => evActive(e, lo, hi) && evVisible(e));
  if (state.selectedEvent && EV_BY_ID[state.selectedEvent] && !act.includes(EV_BY_ID[state.selectedEvent])) act.push(EV_BY_ID[state.selectedEvent]);
  globe.htmlElementsData(act);
}

function showGlobeError() {
  if (document.getElementById('glLost')) return;
  const ov = document.createElement('div');
  ov.id = 'glLost';
  ov.style.cssText = 'position:absolute; inset:0; z-index:6; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; text-align:center; padding:24px; background:rgba(6,14,28,.74); backdrop-filter:blur(2px)';
  ov.innerHTML = '<div style="font-size:15px;max-width:380px;line-height:1.55;color:#dfe8f5">The 3D globe lost its graphics context. Reload to restore it, or switch to the flat map (it needs no 3D).</div>';
  const row = document.createElement('div'); row.style.cssText = 'display:flex; gap:10px';
  const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'padding:9px 16px;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600;background:#2f6fe0;color:#fff;border:1px solid #6fb3ff'; b.addEventListener('click', fn); return b; };
  row.appendChild(mk('↻ Reload', () => location.reload()));
  row.appendChild(mk('🗺 Use flat map', () => { ov.remove(); if (!state.flat) setFlat(true); }));
  ov.appendChild(row); elViz.appendChild(ov);
}

/* ----------------------------- hover / tooltip ----------------------------- */
const nameOf = (iso, feat) => (DATA[iso] && DATA[iso].n) || (feat && (feat.properties.ADMIN || feat.properties.NAME)) || iso;
function flagEmoji(iso) { if (!iso || iso.length !== 2) return '🏳️'; return String.fromCodePoint(...[...iso.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)); }

function tooltipHTML(iso, feat) {
  const v = valAt(iso && DATA[iso], curYear());
  const head = `<div class="tt-head"><span class="tt-flag">${flagEmoji(iso)}</span><span class="tt-name">${nameOf(iso, feat)}</span><span class="tt-era">${STEPS[state.stepIdx].label}</span></div>`;
  if (!v) return head + `<div class="tt-nd">No recorded community this era</div>`;
  const w = worldTotal(curYear()) || 1;
  let body = `<div class="tt-pop"><b>${fmtPop(v.pop)}</b> Jews</div>`;
  const bits = [];
  if (v.share != null) bits.push(v.share >= 1 ? Math.round(v.share) + '% of country' : v.share.toFixed(1) + '% of country');
  if (v.pop > 0) bits.push((v.pop / w * 100 < 1 ? (v.pop / w * 100).toFixed(1) : Math.round(v.pop / w * 100)) + '% of world Jewry');
  body += `<div class="tt-sub">${bits.join(' · ')}</div>`;
  return head + body;
}
function onHover(feat) {
  const iso = feat ? isoOf(feat.properties) : null;
  state.hovered = iso; refreshGlobe();
  if (globe) globe.controls().autoRotate = !feat && spinOn && !state.playing;
  if (!feat) { tooltip.classList.add('hidden'); return; }
  tooltip.innerHTML = tooltipHTML(iso, feat); tooltip.classList.remove('hidden');
}
function onArcHover(m) {
  if (!m) { if (state.hovered === '__arc') { state.hovered = null; tooltip.classList.add('hidden'); } return; }
  state.hovered = '__arc';
  tooltip.innerHTML = `<div class="tt-head"><span class="tt-name">${m.label}</span></div><div class="tt-sub">${fmtYear(m.start)}–${fmtYear(m.end)} · ${m.kind}</div><div class="tt-pop" style="font-size:12px;margin-top:5px;color:#cdd8ea">${m.why}</div>`;
  tooltip.classList.remove('hidden');
}
function showMigrationToast(m) { showToast('➹ ' + m.label + ' — ' + m.why); }
elViz.addEventListener('mousemove', e => { if (tooltip.classList.contains('hidden')) return; const r = elViz.getBoundingClientRect(); tooltip.style.left = (e.clientX - r.left) + 'px'; tooltip.style.top = (e.clientY - r.top) + 'px'; });

function featBBox(feat) { let mnx = 180, mny = 90, mxx = -180, mxy = -90; const walk = c => { if (typeof c[0] === 'number') { mnx = Math.min(mnx, c[0]); mxx = Math.max(mxx, c[0]); mny = Math.min(mny, c[1]); mxy = Math.max(mxy, c[1]); } else c.forEach(walk); }; walk(feat.geometry.coordinates); return [mnx, mny, mxx, mxy]; }
function polyCentroid(feat) { const b = featBBox(feat); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }

function onClick(feat) {
  if (!feat) return;
  const iso = isoOf(feat.properties);
  state.selected = iso; state.selectedEvent = null;
  document.getElementById('eventCard').classList.add('hidden');
  refreshGlobe(); refreshPins(); showDetail(iso, feat);
  const [lng, lat] = polyCentroid(feat);
  if (globe) { globe.controls().autoRotate = false; globe.pointOfView({ lat, lng, altitude: 1.8 }, 800); }
  spinOn = false; syncSpin();
}

/* ----------------------------- country detail ----------------------------- */
const detailCard = document.getElementById('detailCard');
function popTrendSVG(rec) {
  const W = 254, H = 92, padT = 6, padB = 14;
  const xAt = i => (i / (N - 1)) * W;
  const vals = STEPS.map(s => { const v = valAt(rec, s.year); return v ? v.pop : null; });
  const max = Math.max(1, ...vals.map(v => v || 0));
  const yAt = p => padT + (1 - (p || 0) / max) * (H - padT - padB);
  let area = '', line = '', started = false, d0 = '';
  for (let i = 0; i < N; i++) { if (vals[i] == null) continue; const x = xAt(i), y = yAt(vals[i]); if (!started) { d0 = `${x.toFixed(1)},${(H - padB).toFixed(1)} `; started = true; } line += (line ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1); area += `${x.toFixed(1)},${y.toFixed(1)} `; }
  let lastX = 0; for (let i = N - 1; i >= 0; i--) { if (vals[i] != null) { lastX = xAt(i); break; } }
  const areaPoly = started ? `<polygon points="${d0}${area}${lastX.toFixed(1)},${(H - padB).toFixed(1)}" fill="rgba(90,160,239,.25)"/>` : '';
  const linePath = started ? `<path d="${line}" fill="none" stroke="#5aa0ef" stroke-width="1.6"/>` : '';
  const mx = xAt(anchorXFrac(curYear()));
  const marker = `<line x1="${mx.toFixed(1)}" y1="${padT}" x2="${mx.toFixed(1)}" y2="${H - padB}" stroke="#fff" stroke-width="1.4"/>`;
  const lbls = [0, Math.round((N - 1) * 0.33), Math.round((N - 1) * 0.66), N - 1].map(i => `<text x="${Math.max(12, Math.min(W - 12, xAt(i))).toFixed(1)}" y="${H - 3}" font-size="8" fill="#7e8aa3" text-anchor="middle">${STEPS[i].label}</text>`).join('');
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${areaPoly}${linePath}${marker}${lbls}</svg>`;
}
function eventsInCountry(iso) { return EVENTS.filter(e => e.iso === iso); }
function showDetail(iso, feat) {
  detailCard.classList.remove('hidden');
  const rec = iso && DATA[iso];
  const v = valAt(rec, curYear()), w = worldTotal(curYear()) || 1;
  document.getElementById('detailFlag').textContent = flagEmoji(iso);
  document.getElementById('detailName').textContent = nameOf(iso, feat);
  document.getElementById('detailEra').textContent = STEPS[state.stepIdx].label;
  document.getElementById('stPop').textContent = v ? fmtPop(v.pop) : '—';
  document.getElementById('stShare').textContent = (v && v.share != null) ? (v.share >= 1 ? Math.round(v.share) + '%' : v.share.toFixed(1) + '%') : '—';
  document.getElementById('stWorld').textContent = (v && v.pop > 0) ? ((v.pop / w * 100) < 1 ? (v.pop / w * 100).toFixed(1) + '%' : Math.round(v.pop / w * 100) + '%') : '—';
  document.getElementById('detailTrend').innerHTML = rec ? popTrendSVG(rec) : '<div class="tt-nd">No population data.</div>';
  const evs = eventsInCountry(iso);
  const evBox = document.getElementById('detailEvents');
  if (evs.length) {
    evBox.innerHTML = `<div class="de-cap">Events here (${evs.length})</div>` + evs.map(e =>
      `<div class="de-item" data-ev="${e.id}"><span class="de-dot" style="background:${catColor(e.cat)}"></span><span class="de-yr">${fmtYear(e.year)}</span><span class="de-t">${e.title}</span></div>`).join('');
  } else evBox.innerHTML = '';
  const noteEl = document.getElementById('detailNote');
  noteEl.textContent = (rec && rec.note) ? rec.note : '';
  noteEl.style.display = (rec && rec.note) ? '' : 'none';
}
document.getElementById('detailClose').addEventListener('click', () => { detailCard.classList.add('hidden'); state.selected = null; refreshGlobe(); if (state.flat) syncFlatSelection(); });
document.getElementById('detailTrend').addEventListener('click', e => { const svg = e.currentTarget.querySelector('svg'); if (!svg) return; const r = svg.getBoundingClientRect(); if (!r.width) return; const i = Math.round(((e.clientX - r.left) / r.width) * (N - 1)); gotoStep(Math.max(0, Math.min(N - 1, i))); });
document.getElementById('detailEvents').addEventListener('click', e => { const it = e.target.closest('.de-item'); if (it) selectEvent(it.dataset.ev, true); });

/* ----------------------------- event verdict card ----------------------------- */
const eventCard = document.getElementById('eventCard');
function selectEvent(id, fly) {
  const e = EV_BY_ID[id]; if (!e) return;
  state.selectedEvent = id; state.selected = null;
  detailCard.classList.add('hidden');
  // jump time to the event's era so the map matches
  gotoStep(nearestStep(e.year), true);
  showEventCard(e);
  refreshPins();
  if (fly && globe && !state.flat) { globe.controls().autoRotate = false; globe.pointOfView({ lat: e.lat, lng: e.lng, altitude: 1.7 }, 850); spinOn = false; syncSpin(); }
  if (fly && state.flat) flyFlatTo(e.lng, e.lat);
}
function showEventCard(e) {
  document.getElementById('evCatDot').style.background = catColor(e.cat);
  document.getElementById('evCat').textContent = catLabel(e.cat);
  document.getElementById('evTitle').textContent = e.title;
  document.getElementById('evMeta').textContent = (e.end != null ? fmtYear(e.year) + ' – ' + fmtYear(e.end) : fmtYear(e.year)) + ' · ' + e.place;
  const vd = VERD[e.verdict] || VERD.documented;
  const vEl = document.getElementById('evVerdict');
  vEl.style.background = hexA(vd.color, 0.16); vEl.style.color = '#fff';
  vEl.querySelector('.vd-dot').style.background = vd.color;
  document.getElementById('evVerdictL').textContent = vd.label;
  document.getElementById('evVerdictBlurb').textContent = vd.blurb || '';
  document.getElementById('evRec').textContent = e.rec || '—';
  // tradition side — hide entirely for record-only events
  const tradWrap = document.getElementById('evTradWrap');
  if (e.trad && e.trad.trim()) {
    tradWrap.classList.remove('hidden');
    document.getElementById('evTrad').textContent = e.trad;
    const whyWrap = document.getElementById('evWhyWrap');
    if (e.why) { whyWrap.classList.remove('hidden'); document.getElementById('evWhy').textContent = e.why; } else whyWrap.classList.add('hidden');
  } else tradWrap.classList.add('hidden');
  const srcWrap = document.getElementById('evSrcWrap');
  if (e.src && e.src.length) { srcWrap.classList.remove('hidden'); document.getElementById('evSrc').innerHTML = e.src.map(s => `<span class="ev-tag">${s}</span>`).join(''); } else srcWrap.classList.add('hidden');
  eventCard.classList.remove('hidden');
  updateTimelineState();
}
document.getElementById('eventClose').addEventListener('click', () => { eventCard.classList.add('hidden'); state.selectedEvent = null; refreshPins(); updateTimelineState(); });

/* -------------------------- world panel (left) -------------------------- */
function updateWorldBox() {
  const year = curYear();
  document.getElementById('gbYear').textContent = STEPS[state.stepIdx].label;
  const total = worldTotal(year);
  document.getElementById('gbTotal').textContent = fmtPop(total);
  const rows = Object.keys(DATA).map(iso => { const v = valAt(DATA[iso], year); return v && v.pop > 0 ? { iso, n: DATA[iso].n, pop: v.pop, share: v.share } : null; })
    .filter(Boolean).sort((a, b) => b.pop - a.pop);
  document.getElementById('gbRows').innerHTML = rows.map((r, i) => {
    let val = state.metric === 'world' ? Math.round(r.pop / (total || 1) * 100) + '%' : fmtPop(r.pop);
    return `<div class="gb-row" data-iso="${r.iso}"><span class="gb-rank">${i + 1}</span><span class="gb-l">${r.n}</span><span class="gb-v">${val}</span></div>`;
  }).join('') || '<div class="tt-nd" style="padding:6px">No recorded communities this era.</div>';
  const gbNote = document.querySelector('#legendBox .gb-note');
  if (gbNote) gbNote.textContent = rows.length ? rows.length + ' countries with Jews · scroll for all · click to explore' : 'No communities recorded this era';
}
document.getElementById('gbRows').addEventListener('click', e => { const row = e.target.closest('.gb-row'); if (row) gotoCountry(row.dataset.iso); });

/* ====================== dual-track timeline (SVG) ====================== */
const TLW = 1000, TLH = 104, TL_X0 = 70, TL_X1 = 986, TL_REC = 30, TL_TRAD = 74, TL_AXIS = 52;
const tlChart = document.getElementById('tlChart');
const xOfFrac = f => TL_X0 + (f / (N - 1)) * (TL_X1 - TL_X0);
const xOfYear = y => xOfFrac(anchorXFrac(y));
let tlDots = {};
function buildTimeline() {
  const plotW = TL_X1 - TL_X0;
  let svg = '';
  // lane bands
  svg += `<rect class="tl-band" x="${TL_X0}" y="${TL_REC - 11}" width="${plotW}" height="22" rx="7" fill="rgba(90,160,239,.10)"/>`;
  svg += `<rect class="tl-band tl-trad" x="${TL_X0}" y="${TL_TRAD - 11}" width="${plotW}" height="22" rx="7" fill="rgba(216,163,46,.12)"/>`;
  // axis + ticks
  svg += `<line class="tl-axis" x1="${TL_X0}" y1="${TL_AXIS}" x2="${TL_X1}" y2="${TL_AXIS}"/>`;
  const tickIdx = [0, 5, 9, 14, 19, 24, 30, 38, N - 1];
  for (const i of tickIdx) { if (i < 0 || i >= N) continue; const x = xOfFrac(i); svg += `<line class="tl-axis" x1="${x.toFixed(1)}" y1="${TL_AXIS - 3}" x2="${x.toFixed(1)}" y2="${TL_AXIS + 3}" opacity=".5"/><text class="tl-tick" x="${x.toFixed(1)}" y="${TL_AXIS + 14}" text-anchor="middle">${STEPS[i].label}</text>`; }
  // bridges (both-track events): vertical link coloured by verdict
  for (const e of EVENTS) { if (e.track !== 'both') continue; const x = xOfYear(e.year), col = (VERD[e.verdict] || VERD.documented).color; svg += `<line class="tl-bridge tl-trad" data-br="${e.id}" x1="${x.toFixed(1)}" y1="${TL_REC + 6}" x2="${x.toFixed(1)}" y2="${TL_TRAD - 6}" stroke="${col}" stroke-width="3" opacity=".55"/>`; }
  // dots
  for (const e of EVENTS) {
    const x = xOfYear(e.year);
    if (e.track === 'record' || e.track === 'both') svg += `<circle class="tl-dot" data-ev="${e.id}" data-lane="rec" cx="${x.toFixed(1)}" cy="${TL_REC}" r="5" fill="${TAXO.tracks.record.color}" stroke="rgba(8,12,24,.4)" stroke-width="1"/>`;
    if (e.track === 'tradition' || e.track === 'both') svg += `<circle class="tl-dot tl-trad" data-ev="${e.id}" data-lane="trad" cx="${x.toFixed(1)}" cy="${TL_TRAD}" r="5" fill="${TAXO.tracks.tradition.color}" stroke="rgba(8,12,24,.4)" stroke-width="1"/>`;
  }
  // lane labels
  svg += `<text class="tl-lane-l" x="${TL_X0 - 8}" y="${TL_REC + 3}" text-anchor="end">record</text>`;
  svg += `<text class="tl-lane-l tl-trad" x="${TL_X0 - 8}" y="${TL_TRAD + 3}" text-anchor="end">tradition</text>`;
  // playhead
  svg += `<line id="tlPlay" class="tl-playhead" x1="${xOfFrac(state.stepIdx).toFixed(1)}" y1="10" x2="${xOfFrac(state.stepIdx).toFixed(1)}" y2="94"/><circle id="tlPlayGrip" class="tl-playhead-grip" cx="${xOfFrac(state.stepIdx).toFixed(1)}" cy="10" r="3.5"/>`;
  tlChart.innerHTML = svg;
  tlDots = {};
  tlChart.querySelectorAll('.tl-dot').forEach(d => { (tlDots[d.dataset.ev] = tlDots[d.dataset.ev] || []).push(d); d.addEventListener('click', ev => { ev.stopPropagation(); selectEvent(d.dataset.ev, true); }); });
  updateTimelineState();
}
function updateTimelineState() {
  const px = xOfFrac(state.stepIdx).toFixed(1);
  const pl = document.getElementById('tlPlay'), pg = document.getElementById('tlPlayGrip');
  if (pl) { pl.setAttribute('x1', px); pl.setAttribute('x2', px); } if (pg) pg.setAttribute('cx', px);
  const [lo, hi] = activeBand(state.stepIdx);
  tlChart.querySelectorAll('.tl-dot').forEach(d => {
    const e = EV_BY_ID[d.dataset.ev], active = evActive(e, lo, hi), sel = state.selectedEvent === e.id;
    d.classList.toggle('sel', sel);
    d.setAttribute('r', sel ? 7 : active ? 6 : 4);
    d.style.opacity = sel ? 1 : active ? 0.98 : 0.4;
  });
  tlChart.classList.toggle('no-trad', !state.layers.tradition);
}
// scrub by clicking/dragging the chart background
function tlScrub(clientX) { const r = tlChart.getBoundingClientRect(); const vx = (clientX - r.left) / r.width * TLW; const i = Math.round((vx - TL_X0) / (TL_X1 - TL_X0) * (N - 1)); gotoStep(Math.max(0, Math.min(N - 1, i))); }
let tlDragging = false;
tlChart.addEventListener('pointerdown', e => { if (e.target.classList.contains('tl-dot')) return; tlDragging = true; tlChart.setPointerCapture(e.pointerId); stopPlay(); tlScrub(e.clientX); });
tlChart.addEventListener('pointermove', e => { if (tlDragging) tlScrub(e.clientX); });
tlChart.addEventListener('pointerup', () => { tlDragging = false; });

/* ------------------------------ time stepping ------------------------------ */
const slider = document.getElementById('timeSlider');
function applyStep(skipPins) {
  const s = STEPS[state.stepIdx];
  slider.value = state.stepIdx;
  document.getElementById('eraLabel').textContent = s.label;
  const badge = document.getElementById('eraBadge');
  badge.textContent = ERA_LABEL[s.era] || s.era; badge.className = 'era-badge era-' + s.era;
  if (state.flat) { updateFlatColors(); updateFlatArcsPins(); } else { refreshGlobe(); refreshArcs(); if (!skipPins) refreshPins(); }
  updateWorldBox(); updateTimelineState();
  if (state.selected) { const f = countries.find(c => isoOf(c.properties) === state.selected); showDetail(state.selected, f); }
}
function gotoStep(i, skipPins) { state.stepIdx = i; stopPlay(); applyStep(skipPins); }
slider.min = 0; slider.max = N - 1; slider.step = 1;
slider.addEventListener('input', () => { state.stepIdx = +slider.value; stopPlay(); applyStep(); });
document.getElementById('prevEra').addEventListener('click', () => gotoStep(Math.max(0, state.stepIdx - 1)));
document.getElementById('nextEra').addEventListener('click', () => gotoStep(Math.min(N - 1, state.stepIdx + 1)));
document.getElementById('nowBtn').addEventListener('click', () => gotoStep(N - 1));

const playBtn = document.getElementById('playBtn'), playRevBtn = document.getElementById('playRevBtn');
function syncPlayBtns() { const f = state.playing && state.playDir > 0, r = state.playing && state.playDir < 0; playBtn.textContent = f ? '⏸' : '▶'; playBtn.classList.toggle('on', f); playRevBtn.textContent = r ? '⏸' : '◀'; playRevBtn.classList.toggle('on', r); }
function stopPlay() { state.playing = false; if (playTimer) { clearInterval(playTimer); playTimer = null; } syncPlayBtns(); if (globe) globe.controls().autoRotate = spinOn && !state.flat; }
function startPlay(dir) {
  state.playDir = dir;
  if (dir > 0 && state.stepIdx >= N - 1) state.stepIdx = 0;
  if (dir < 0 && state.stepIdx <= 0) state.stepIdx = N - 1;
  state.playing = true; syncPlayBtns(); if (globe) globe.controls().autoRotate = false; applyStep();
  playTimer = setInterval(() => { const nx = state.stepIdx + state.playDir; if (nx < 0 || nx >= N) { stopPlay(); return; } state.stepIdx = nx; applyStep(); }, 900);
}
playBtn.addEventListener('click', () => { if (state.playing && state.playDir > 0) stopPlay(); else { stopPlay(); startPlay(1); } });
playRevBtn.addEventListener('click', () => { if (state.playing && state.playDir < 0) stopPlay(); else { stopPlay(); startPlay(-1); } });

/* ------------------------------ metric + layers ------------------------------ */
const RAMP_LABELS = { pop: ['Jewish population', 'few', '7M+'], share: ['% of country Jewish', '0%', '80%+'], world: ['Share of world Jewry', 'tiny', 'largest'] };
function setMetric(m) {
  state.metric = m;
  document.querySelectorAll('.metric-btn').forEach(b => b.classList.toggle('on', b.dataset.metric === m));
  const L = RAMP_LABELS[m]; document.getElementById('rampCap').textContent = L[0]; document.getElementById('rampLo').textContent = L[1]; document.getElementById('rampHi').textContent = L[2];
  if (state.flat) updateFlatColors(); else refreshGlobe();
  updateWorldBox();
  if (state.selected) { const f = countries.find(c => isoOf(c.properties) === state.selected); showDetail(state.selected, f); }
}
document.querySelectorAll('.metric-btn').forEach(b => b.addEventListener('click', () => setMetric(b.dataset.metric)));
function setLayer(k) {
  state.layers[k] = !state.layers[k];
  document.getElementById(k === 'events' ? 'lyEvents' : k === 'migrations' ? 'lyMig' : 'lyTrad').classList.toggle('on', state.layers[k]);
  if (state.flat) updateFlatArcsPins(); else { refreshArcs(); refreshPins(); }
  updateTimelineState();
}
document.getElementById('lyEvents').addEventListener('click', () => setLayer('events'));
document.getElementById('lyMig').addEventListener('click', () => setLayer('migrations'));
document.getElementById('lyTrad').addEventListener('click', () => setLayer('tradition'));

/* ============================ flat 2D map ============================ */
const FW = 2000, FH = 1000;
const fpx = lng => (lng + 180) / 360 * FW, fpy = lat => (90 - lat) / 180 * FH;
const geomOf = f => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);
function flatPathD(f) { let d = ''; for (const poly of geomOf(f)) for (const ring of poly) d += 'M' + ring.map(p => fpx(p[0]).toFixed(1) + ',' + fpy(p[1]).toFixed(1)).join('L') + 'Z'; return d; }
let flatBuilt = false; const flatMeta = {};
function buildFlatMap() {
  if (flatBuilt) return;
  const svg = document.getElementById('flatViz');
  svg.setAttribute('viewBox', '0 0 ' + FW + ' ' + FH);
  let cells = '', hits = '';
  for (const f of countries) {
    const iso = isoOf(f.properties); if (!iso || flatMeta[iso]) continue;
    const d = flatPathD(f), b = featBBox(f);
    flatMeta[iso] = { d, cx: fpx((b[0] + b[2]) / 2), cy: fpy((b[1] + b[3]) / 2), w: fpx(b[2]) - fpx(b[0]) };
    cells += `<path class="flat-cell" data-iso="${iso}" d="${d}"/>`;
    hits += `<path class="flat-hit" data-iso="${iso}" d="${d}"/>`;
  }
  svg.innerHTML = `<rect class="flat-ocean" width="${FW}" height="${FH}"/><g id="flatCells">${cells}</g><g id="flatArcs"></g><g id="flatPins"></g><g id="flatHits">${hits}</g>`;
  svg.querySelectorAll('.flat-hit').forEach(el => { const iso = el.dataset.iso; el.addEventListener('mousemove', e => flatHover(iso, e)); el.addEventListener('mouseleave', () => { state.hovered = null; tooltip.classList.add('hidden'); }); el.addEventListener('click', () => { if (flatPanned) return; state.selected = iso; state.selectedEvent = null; document.getElementById('eventCard').classList.add('hidden'); showDetail(iso, countries.find(c => isoOf(c.properties) === iso)); syncFlatSelection(); }); });
  initFlatInteract(); flatBuilt = true;
}
function updateFlatColors() {
  if (!flatBuilt) return;
  const year = curYear();
  for (const iso in flatMeta) {
    const el = document.querySelector('.flat-cell[data-iso="' + iso + '"]'); if (!el) continue;
    const v = valAt(DATA[iso], year);
    if (!v || v.pop <= 0) { el.setAttribute('fill', v && v.pop <= 0 ? EMPTIED : NEUTRAL); continue; }
    el.setAttribute('fill', rgbaT(metricT(v, year), 0.9));
  }
  syncFlatSelection();
}
function updateFlatArcsPins() {
  if (!flatBuilt) return;
  const [lo, hi] = activeBand(state.stepIdx);
  const arcG = document.getElementById('flatArcs'), pinG = document.getElementById('flatPins');
  if (state.layers.migrations) {
    arcG.innerHTML = MIGR.filter(m => migActive(m, lo, hi) && migVisible(m)).map(m => {
      const x1 = fpx(m.from.lng), y1 = fpy(m.from.lat), x2 = fpx(m.to.lng), y2 = fpy(m.to.lat);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.hypot(x2 - x1, y2 - y1) * 0.22;
      const c = MIG_COL[m.track === 'tradition' ? 'tradition' : m.kind] || MIG_COL.voluntary;
      return `<path class="flat-arc" d="M${x1.toFixed(0)},${y1.toFixed(0)} Q${mx.toFixed(0)},${my.toFixed(0)} ${x2.toFixed(0)},${y2.toFixed(0)}" stroke="rgba(${c},.9)" stroke-width="${(1 + (m.magnitude || 1) * 0.8).toFixed(1)}"${m.track === 'tradition' ? ' stroke-dasharray="8 6"' : ''}/>`;
    }).join('');
  } else arcG.innerHTML = '';
  if (state.layers.events) {
    pinG.innerHTML = EVENTS.filter(e => evActive(e, lo, hi) && evVisible(e)).map(e =>
      `<g class="flat-pin" data-ev="${e.id}"><circle cx="${fpx(e.lng).toFixed(0)}" cy="${fpy(e.lat).toFixed(0)}" r="7" fill="${e.track === 'tradition' ? 'rgba(216,163,46,.25)' : catColor(e.cat)}" stroke="${e.track === 'tradition' ? TAXO.tracks.tradition.color : 'rgba(6,12,24,.8)'}" stroke-width="${e.track === 'tradition' ? 2 : 1}"/></g>`).join('');
    pinG.querySelectorAll('.flat-pin').forEach(g => g.addEventListener('click', ev => { ev.stopPropagation(); selectEvent(g.dataset.ev, true); }));
  } else pinG.innerHTML = '';
}
function syncFlatSelection() { if (flatBuilt) document.querySelectorAll('.flat-hit').forEach(el => el.classList.toggle('sel', el.dataset.iso === state.selected)); }
function flatHover(iso, e) { if (flatDragging) return; state.hovered = iso; tooltip.innerHTML = tooltipHTML(iso, countries.find(c => isoOf(c.properties) === iso)); tooltip.classList.remove('hidden'); tooltip.style.left = e.clientX + 'px'; tooltip.style.top = e.clientY + 'px'; }
const flatView = { x: 0, y: 0, w: FW, h: FH };
let flatDragging = false, flatPanned = false;
function applyFlatView() { const svg = document.getElementById('flatViz'); if (svg) svg.setAttribute('viewBox', flatView.x.toFixed(1) + ' ' + flatView.y.toFixed(1) + ' ' + flatView.w.toFixed(1) + ' ' + flatView.h.toFixed(1)); }
function clampFlatView() { flatView.w = Math.max(FW / 16, Math.min(FW, flatView.w)); flatView.h = flatView.w * (FH / FW); flatView.x = Math.max(0, Math.min(FW - flatView.w, flatView.x)); flatView.y = Math.max(0, Math.min(FH - flatView.h, flatView.y)); }
function resetFlatView() { flatView.x = 0; flatView.y = 0; flatView.w = FW; flatView.h = FH; applyFlatView(); }
function flyFlatTo(lng, lat) { flatView.w = FW / 4; flatView.h = flatView.w * (FH / FW); flatView.x = fpx(lng) - flatView.w / 2; flatView.y = fpy(lat) - flatView.h / 2; clampFlatView(); applyFlatView(); }
function flatClientToSvg(cx, cy) { const svg = document.getElementById('flatViz'), r = svg.getBoundingClientRect(); const scale = Math.min(r.width / flatView.w, r.height / flatView.h); return { x: flatView.x + (cx - r.left - (r.width - flatView.w * scale) / 2) / scale, y: flatView.y + (cy - r.top - (r.height - flatView.h * scale) / 2) / scale }; }
let flatInteractBound = false;
function initFlatInteract() {
  if (flatInteractBound) return;
  const svg = document.getElementById('flatViz');
  svg.addEventListener('wheel', e => { e.preventDefault(); const p = flatClientToSvg(e.clientX, e.clientY); const nw = Math.max(FW / 16, Math.min(FW, flatView.w * (e.deltaY < 0 ? 0.84 : 1 / 0.84))), k = nw / flatView.w; flatView.x = p.x - (p.x - flatView.x) * k; flatView.y = p.y - (p.y - flatView.y) * k; flatView.w = nw; clampFlatView(); applyFlatView(); }, { passive: false });
  svg.addEventListener('mousedown', e => {
    flatDragging = true; flatPanned = false; svg.style.cursor = 'grabbing'; tooltip.classList.add('hidden');
    const r = svg.getBoundingClientRect(), scale = Math.min(r.width / flatView.w, r.height / flatView.h);
    const sx = e.clientX, sy = e.clientY, ox = flatView.x, oy = flatView.y;
    const move = ev => { if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) flatPanned = true; flatView.x = ox - (ev.clientX - sx) / scale; flatView.y = oy - (ev.clientY - sy) / scale; clampFlatView(); applyFlatView(); };
    const up = () => { flatDragging = false; svg.style.cursor = ''; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setTimeout(() => { flatPanned = false; }, 30); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
  flatInteractBound = true;
}

/* ------------------------------- menu / view ------------------------------- */
const menu = document.getElementById('menu'), menuBtn = document.getElementById('menuBtn');
const closeMenu = () => menu.classList.add('hidden');
menuBtn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
document.addEventListener('click', e => { if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== menuBtn) closeMenu(); });
function setFlat(flat) {
  state.flat = flat;
  document.getElementById('flatViz').classList.toggle('hidden', !flat);
  elViz.classList.toggle('hidden', flat);
  const mv = document.getElementById('miView');
  mv.querySelector('.mi-ic').textContent = flat ? '🌐' : '🗺'; mv.querySelector('.mi-tx').textContent = flat ? 'Globe view' : 'Flat map';
  document.querySelectorAll('.mi-globe').forEach(el => el.classList.toggle('hidden', flat));
  if (flat) { buildFlatMap(); updateFlatColors(); updateFlatArcsPins(); try { if (!localStorage.getItem('jhe_seen_flat') && document.getElementById('tutorial').classList.contains('hidden')) showFlatTip(); } catch (e) {} }
  else { refreshGlobe(); refreshArcs(); refreshPins(); if (globe) globe.controls().autoRotate = spinOn && !state.playing; }
}
document.getElementById('miView').addEventListener('click', () => { setFlat(!state.flat); closeMenu(); });
const miSpin = document.getElementById('miSpin');
function syncSpin() { const s = miSpin.querySelector('.mi-state'); if (s) s.textContent = spinOn ? 'On' : 'Off'; miSpin.classList.toggle('on', spinOn); }
miSpin.addEventListener('click', () => { spinOn = !spinOn; if (globe && !state.playing) globe.controls().autoRotate = spinOn; syncSpin(); });
syncSpin();
document.getElementById('miReset').addEventListener('click', () => { closeDetailAll(); if (state.flat) resetFlatView(); if (globe) globe.pointOfView({ lat: 31, lng: 25, altitude: 2.5 }, 700); closeMenu(); });
document.getElementById('miFull').addEventListener('click', () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); closeMenu(); });
document.getElementById('miHelp').addEventListener('click', () => { closeMenu(); if (state.flat) showFlatTip(); else showTutorial(); });
const aboutOverlay = document.getElementById('aboutOverlay');
document.getElementById('miAbout').addEventListener('click', () => { closeMenu(); aboutOverlay.classList.remove('hidden'); });
document.getElementById('aboutClose').addEventListener('click', () => aboutOverlay.classList.add('hidden'));
aboutOverlay.addEventListener('click', e => { if (e.target === aboutOverlay) aboutOverlay.classList.add('hidden'); });
function closeDetailAll() { detailCard.classList.add('hidden'); eventCard.classList.add('hidden'); state.selected = null; state.selectedEvent = null; refreshGlobe(); refreshPins(); updateTimelineState(); }

/* ------------------------------- tutorial / tips ------------------------------- */
function showTutorial() { document.getElementById('tutorial').classList.remove('hidden'); }
function closeTutorial() { const t = document.getElementById('tutorial'); if (t.classList.contains('hidden')) return; t.classList.add('hidden'); try { localStorage.setItem('jhe_seen_tutorial', '1'); } catch (e) {} }
document.getElementById('tutStart').addEventListener('click', closeTutorial);
document.getElementById('tutorial').addEventListener('click', e => { if (e.target.id === 'tutorial') closeTutorial(); });
function showFlatTip() { document.getElementById('flatTip').classList.remove('hidden'); }
function closeFlatTip() { const t = document.getElementById('flatTip'); if (t.classList.contains('hidden')) return; t.classList.add('hidden'); try { localStorage.setItem('jhe_seen_flat', '1'); } catch (e) {} }
document.getElementById('ftStart').addEventListener('click', closeFlatTip);
document.getElementById('flatTip').addEventListener('click', e => { if (e.target.id === 'flatTip') closeFlatTip(); });

/* ------------------------------- search + share ------------------------------- */
function gotoCountry(iso) {
  const f = countries.find(c => isoOf(c.properties) === iso); if (!f) return;
  state.selectedEvent = null; eventCard.classList.add('hidden');
  if (state.flat) { state.selected = iso; showDetail(iso, f); syncFlatSelection(); const [lng, lat] = polyCentroid(f); flyFlatTo(lng, lat); }
  else onClick(f);
}
const searchEl = document.getElementById('search'), searchRes = document.getElementById('searchResults');
let searchHits = [];
function runSearch() {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) { searchRes.classList.add('hidden'); searchHits = []; return; }
  searchHits = Object.keys(DATA).map(iso => ({ iso, n: DATA[iso].n })).filter(c => c.n.toLowerCase().includes(q)).sort((a, b) => a.n.toLowerCase().indexOf(q) - b.n.toLowerCase().indexOf(q) || a.n.localeCompare(b.n)).slice(0, 8);
  if (!searchHits.length) { searchRes.innerHTML = '<div class="sr-none">No match</div>'; searchRes.classList.remove('hidden'); return; }
  searchRes.innerHTML = searchHits.map((c, i) => `<div class="sr-item${i === 0 ? ' sel' : ''}" data-iso="${c.iso}"><span class="sr-flag">${flagEmoji(c.iso)}</span>${c.n}</div>`).join('');
  searchRes.classList.remove('hidden');
}
function pickSearch(iso) { if (!iso && searchHits.length) iso = searchHits[0].iso; if (!iso) return; gotoCountry(iso); searchEl.value = ''; searchRes.classList.add('hidden'); searchHits = []; searchEl.blur(); }
searchEl.addEventListener('input', runSearch);
searchEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pickSearch(); } else if (e.key === 'Escape') { searchEl.value = ''; searchRes.classList.add('hidden'); searchEl.blur(); } });
searchRes.addEventListener('click', e => { const it = e.target.closest('.sr-item'); if (it) pickSearch(it.dataset.iso); });
document.addEventListener('click', e => { if (!document.getElementById('searchWrap').contains(e.target)) searchRes.classList.add('hidden'); });

let toastTimer = null;
function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.remove('hidden'); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600); }
function buildShareURL() { const seg = [SLICES[state.stepIdx].id, state.metric, state.selected || '', state.selectedEvent || '']; if (state.flat) seg.push('flat'); while (seg.length > 1 && seg[seg.length - 1] === '') seg.pop(); return location.origin + location.pathname + '#' + seg.join(','); }
function fallbackCopy(text, cb) { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); cb(); } catch (e) {} document.body.removeChild(ta); }
document.getElementById('miShare').addEventListener('click', () => { closeMenu(); const url = buildShareURL(), done = () => showToast('🔗 Link to this view copied'); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done)); else fallbackCopy(url, done); });

/* ------------------------------- world-trend overlay ------------------------------- */
function worldTrendSVG() {
  const W = 760, H = 300, padT = 10, padB = 28;
  const xAt = i => (i / (N - 1)) * W;
  const vals = STEPS.map(s => worldTotal(s.year));
  const max = Math.max(1, ...vals);
  const yAt = v => padT + (1 - v / max) * (H - padT - padB);
  let line = '', area = `${xAt(0).toFixed(1)},${(H - padB).toFixed(1)} `;
  for (let i = 0; i < N; i++) { line += (line ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + yAt(vals[i]).toFixed(1); area += `${xAt(i).toFixed(1)},${yAt(vals[i]).toFixed(1)} `; }
  area += `${xAt(N - 1).toFixed(1)},${(H - padB).toFixed(1)}`;
  const labs = [0, 5, 9, 14, 19, 24, 30, 37, N - 1].map(i => { const x = xAt(i), anc = x < 30 ? 'start' : x > W - 30 ? 'end' : 'middle', tx = anc === 'start' ? 2 : anc === 'end' ? W - 2 : x; return `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${H - padB}" stroke="rgba(255,255,255,.06)"/><text x="${tx.toFixed(1)}" y="${H - 9}" font-size="10" fill="#9aa7c0" text-anchor="${anc}">${STEPS[i].label}</text>`; }).join('');
  const mx = xAt(state.stepIdx);
  return `<svg viewBox="0 0 ${W} ${H}" class="wt-svg"><polygon points="${area}" fill="rgba(90,160,239,.25)"/><path d="${line}" fill="none" stroke="#5aa0ef" stroke-width="2"/>${labs}<line x1="${mx.toFixed(1)}" y1="${padT}" x2="${mx.toFixed(1)}" y2="${H - padB}" stroke="#fff" stroke-width="1.5"/></svg>`;
}
function showWorldTrend() { document.getElementById('wtChart').innerHTML = worldTrendSVG(); document.getElementById('trendOverlay').classList.remove('hidden'); }
document.getElementById('miTrend').addEventListener('click', () => { closeMenu(); showWorldTrend(); });
document.getElementById('trendClose').addEventListener('click', () => document.getElementById('trendOverlay').classList.add('hidden'));
document.getElementById('trendOverlay').addEventListener('click', e => { if (e.target.id === 'trendOverlay') document.getElementById('trendOverlay').classList.add('hidden'); });
document.getElementById('wtChart').addEventListener('click', e => { const svg = e.currentTarget.querySelector('svg'); if (!svg) return; const r = svg.getBoundingClientRect(); if (!r.width) return; const i = Math.round(((e.clientX - r.left) / r.width) * (N - 1)); gotoStep(Math.max(0, Math.min(N - 1, i))); showWorldTrend(); });

/* ------------------------------- keyboard ------------------------------- */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeMenu(); closeTutorial(); closeFlatTip(); aboutOverlay.classList.add('hidden'); document.getElementById('trendOverlay').classList.add('hidden'); if (!eventCard.classList.contains('hidden') || !detailCard.classList.contains('hidden')) closeDetailAll(); }
  else if (e.target && e.target.tagName === 'INPUT') return;
  else if (e.key === 'ArrowRight') gotoStep(Math.min(N - 1, state.stepIdx + 1));
  else if (e.key === 'ArrowLeft') gotoStep(Math.max(0, state.stepIdx - 1));
});
window.addEventListener('resize', sizeGlobe);

/* --------------------------------- boot --------------------------------- */
function boot() {
  // Deep-link: #<sliceId>[,<metric>][,<ISO2>][,<eventId>][,flat]
  const parts = decodeURIComponent((location.hash || '').slice(1)).split(',').map(s => s.trim());
  const sid = parts[0], met = parts[1], iso = parts[2], evid = parts[3];
  if (sid) { const i = SLICES.findIndex(s => s.id === sid); if (i >= 0) state.stepIdx = i; else { const y = yr(sid); if (!isNaN(y)) state.stepIdx = nearestStep(y); } }
  if (met && RAMP_LABELS[met]) state.metric = met;
  setMetric(state.metric);
  buildTimeline(); applyStep();
  try { if (!localStorage.getItem('jhe_seen_tutorial')) showTutorial(); } catch (e) {}
  fetch('data/countries.geojson').then(r => r.json()).then(geo => {
    initGlobe(geo); applyStep();
    if (/(^|,)flat($|,)/i.test(location.hash)) setFlat(true);
    if (iso) { const f = countries.find(c => isoOf(c.properties) === iso.toUpperCase()); if (f) gotoCountry(iso.toUpperCase()); }
    if (evid && EV_BY_ID[evid]) selectEvent(evid, true);
  }).catch(err => { console.error('geojson load failed', err); elViz.innerHTML = '<div style="color:#93a0c5;text-align:center;padding-top:35vh">Could not load map data.</div>'; });
}
document.addEventListener('DOMContentLoaded', boot);

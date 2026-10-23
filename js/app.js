import { buildBoundary, splitRing, acres, distanceM, utmZoneFor, pointInRing, makeProjector } from './geo.js';
import { computeAreas, fmtAc, buildShapefileZip, buildKml, buildGeoJson, importFile, projectCenterLng, exportFeatures, safeName } from './formats.js';
import { startSimulator } from './sim.js';

const L = window.L;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const FT = 0.3048;
// Shown on the Projects screen so you can tell an updated copy has loaded.
// Keep in step with VERSION in sw.js (bump both when shipping).
const APP_VERSION = 13;
const STORE_KEY = 'bab.projects.v1';
const DRIVE_KEY = 'bab.drive.v1';
const PREF_KEY = 'bab.prefs.v1';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const thisYear = () => new Date().getFullYear();

// ---------- icons ----------
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  nav: '<path d="M21 3 3 10.5l7.5 3L14 21z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  rec: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5" fill="#ef4444" stroke="none"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  poly: '<path d="M12 3 21 9.5 17.5 20h-11L3 9.5z"/>',
  move: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>',
  // Add / remove point: a corner on an edge, with the + or − lifted clear to the top right.
  addpt: '<path d="M3 20 14 11.75"/><circle cx="8.5" cy="15.9" r="2.6" fill="currentColor"/><path d="M18.5 2.5v6M15.5 5.5h6"/>',
  rmpt: '<path d="M3 20 14 11.75"/><circle cx="8.5" cy="15.9" r="2.6" fill="currentColor"/><path d="M15.5 5.5h6"/>',
  // Obstacle: a field with an irregular area cut out of it.
  obstacle: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8.5 8.2c1.3-1.4 3.2-.6 4.4-1 1.6-.5 3.3.4 3.4 2.1.1 1.3-.9 2-.6 3.2.4 1.5-.5 3.2-2.3 3.2-1.4 0-2-.9-3.3-.8-1.7.2-3.1-.8-3-2.4.1-1.2 1-1.8.9-2.8-.1-.6.1-1.1.5-1.5z"/>',
  // Split: the field as two halves with a solid cut line through the gap.
  split: '<path d="M9.5 4H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5.5M14.5 4H20a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5.5"/><path d="M12 2v20"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  offset: '<path d="M4 4v16M14 4v16" stroke-dasharray="3 2"/><path d="M7 12h10M14 9l3 3-3 3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
};
const svgIcon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = svgIcon(el.dataset.icon); });
}

// ---------- storage ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) {
    toast('Could not save: phone storage is full. Export and delete old projects.');
    return false;
  }
}
const packFix = (f) => [+f.lat.toFixed(8), +f.lng.toFixed(8), f.t, f.speed == null ? null : +f.speed.toFixed(2), f.heading == null || Number.isNaN(f.heading) ? null : +f.heading.toFixed(1), f.acc == null ? null : +f.acc.toFixed(1)];
const unpackFix = (a) => ({ lat: a[0], lng: a[1], t: a[2], speed: a[3], heading: a[4], acc: a[5] });

const S = {
  projects: load(STORE_KEY, []),
  prefs: load(PREF_KEY, { offsetFt: 0, side: 'left', lastView: null, layer: 'satellite', theme: 'night' }),
  current: null,
  editing: false, // edit tools shown (Edit button on the rail)
  tool: 'move',
  selectedId: null,
  draw: null, // { type, pts }
  split: null, // { fieldId, pts }
  history: [],
  drive: null,
};

let saveTimer = null;
function saveProjects(now = false) {
  if (S.current) S.current.updatedAt = Date.now();
  clearTimeout(saveTimer);
  const go = () => store(STORE_KEY, S.projects);
  if (now) go(); else saveTimer = setTimeout(go, 250);
}
const savePrefs = () => store(PREF_KEY, S.prefs);

// ---------- toast ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- sheets ----------
let openSheetEl = null;
function openSheet(id) {
  closeSheet();
  openSheetEl = $(id);
  openSheetEl.hidden = false;
  $('#scrim').hidden = false;
}
function closeSheet() {
  if (openSheetEl) openSheetEl.hidden = true;
  openSheetEl = null;
  $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', closeSheet);
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

function segValue(sel) { return $(`${sel} [aria-checked="true"]`)?.dataset.val ?? $(`${sel} [aria-checked="true"]`)?.dataset.side; }
function setSeg(sel, val) {
  $$(`${sel} [role="radio"]`).forEach((b) => b.setAttribute('aria-checked', String((b.dataset.val ?? b.dataset.side) === val)));
}
function wireSeg(sel, onChange) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('[role="radio"]');
    if (!b) return;
    const v = b.dataset.val ?? b.dataset.side;
    setSeg(sel, v);
    onChange?.(v);
  });
}

// ---------- projects screen ----------
function showProjects() {
  S.current = null;
  $('#screen-map').classList.add('hidden');
  $('#screen-projects').classList.remove('hidden');
  renderProjectList();
}

function thumbSvg(p) {
  const pts = p.boundaries.flatMap((b) => b.ring);
  if (!pts.length) return '<svg class="thumb" viewBox="0 0 44 44" aria-hidden="true"><rect width="44" height="44" rx="10" fill="#0a0b06"/></svg>';
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [la, lo] of pts) { minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); minLng = Math.min(minLng, lo); maxLng = Math.max(maxLng, lo); }
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = (maxLng - minLng) * k || 1e-9, h = maxLat - minLat || 1e-9;
  const sc = 32 / Math.max(w, h);
  const ox = 6 + (32 - w * sc) / 2, oy = 6 + (32 - h * sc) / 2;
  const path = (r) => 'M' + r.map(([la, lo]) => `${(ox + (lo - minLng) * k * sc).toFixed(1)} ${(oy + (maxLat - la) * sc).toFixed(1)}`).join('L') + 'Z';
  const shapes = p.boundaries.map((b) => `<path d="${path(b.ring)}" fill="none" stroke="${b.type === 'slough' ? '#5fc8f0' : '#f5d33a'}" stroke-width="${b.type === 'slough' ? 1.5 : 2}"/>`).join('');
  return `<svg class="thumb" viewBox="0 0 44 44" aria-hidden="true"><rect width="44" height="44" rx="10" fill="#0a0b06"/>${shapes}</svg>`;
}

function renderProjectList() {
  const list = $('#project-list');
  const ps = [...S.projects].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('#proj-empty').hidden = ps.length > 0;
  $('#proj-count').textContent = ps.length ? `${ps.length} saved on this device` : '';
  list.innerHTML = '';
  for (const p of ps) {
    const a = computeAreas(p);
    const nF = p.boundaries.filter((b) => b.type === 'field').length;
    const nS = p.boundaries.filter((b) => b.type === 'slough').length;
    const card = document.createElement('div');
    card.className = 'proj-card';
    card.innerHTML = `<button type="button" class="open">${thumbSvg(p)}<span class="meta"><span class="title"></span><span class="sub">${p.year} · ${nF} field${nF === 1 ? '' : 's'}${nS ? ` · ${nS} obstacle${nS === 1 ? '' : 's'}` : ''}</span></span><span class="ac"><b>${fmtAc(a.net)}</b><span>net ac</span></span></button><button type="button" class="more-btn" aria-label="Project options">⋯</button>`;
    card.querySelector('.title').textContent = p.name;
    card.querySelector('.open').addEventListener('click', () => openProject(p.id));
    card.querySelector('.more-btn').addEventListener('click', () => openProjectActions(p));
    list.appendChild(card);
  }
}

let actionProject = null;
function openProjectActions(p) {
  actionProject = p;
  $('#sa-title').textContent = `${p.name} ${p.year}`;
  openSheet('#sheet-actions');
}
$('#sheet-actions').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !actionProject) return;
  const p = actionProject;
  if (act === 'edit') openProjectForm(p);
  if (act === 'dup') {
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = uid(); copy.name = `${p.name} copy`; copy.updatedAt = Date.now();
    copy.boundaries.forEach((b) => { b.id = uid(); });
    S.projects.push(copy); saveProjects(true); closeSheet(); renderProjectList();
  }
  if (act === 'delete') {
    if (!confirm(`Delete "${p.name} ${p.year}"? This can't be undone.`)) return;
    S.projects = S.projects.filter((x) => x.id !== p.id);
    saveProjects(true); closeSheet(); renderProjectList();
  }
});

let projectFormTarget = null;
function openProjectForm(p = null) {
  projectFormTarget = p;
  const f = $('#form-project');
  f.name.value = p ? p.name : '';
  f.year.value = p ? p.year : thisYear();
  $('#sp-title').textContent = p ? 'Edit project' : 'New project';
  $('#sp-submit').textContent = p ? 'Save' : 'Create';
  openSheet('#sheet-project');
  if (!p) setTimeout(() => f.name.focus(), 50);
}
$('#btn-new-project').addEventListener('click', () => openProjectForm());
$('#form-project').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const name = f.name.value.trim(), year = Number(f.year.value);
  if (!name || !(year > 1900 && year < 3000)) return toast('Enter a field name and a 4-digit year');
  if (projectFormTarget) {
    Object.assign(projectFormTarget, { name, year });
    saveProjects(true);
    closeSheet();
    if (S.current) updateAreaChip(); else renderProjectList();
  } else {
    const p = { id: uid(), name, year, createdAt: Date.now(), updatedAt: Date.now(), boundaries: [] };
    S.projects.push(p);
    saveProjects(true);
    closeSheet();
    openProject(p.id, { locate: true });
  }
});

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const items = await importFile(file);
    const name = file.name.replace(/\.(zip|kml|geojson|json)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported';
    const p = { id: uid(), name, year: thisYear(), createdAt: Date.now(), updatedAt: Date.now(), boundaries: items.filter((i) => i.ring.length >= 3).map((i) => ({ id: uid(), name: String(i.name).slice(0, 40), type: i.type, ring: i.ring })) };
    S.projects.push(p);
    saveProjects(true);
    openProject(p.id);
    toast(`Imported ${p.boundaries.length} boundar${p.boundaries.length === 1 ? 'y' : 'ies'}. Check the name and year.`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, 4500);
  }
});

// ---------- theme ----------
// prefs.theme: 'day' | 'night' | 'auto' (follows the phone). index.html sets it before first paint too.
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = S.prefs.theme || 'night';
  const dark = t === 'night' || (t === 'auto' && darkMq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0f1108' : '#eef0e8';
  setSeg('#theme-seg', t);
}
darkMq.addEventListener('change', applyTheme);
wireSeg('#theme-seg', (v) => { S.prefs.theme = v; savePrefs(); applyTheme(); });
applyTheme();

// ---------- map ----------
// prefs.layer: 'satellite' | 'none' (older versions stored a number; all of those had satellite).
if (S.prefs.layer !== 'none') S.prefs.layer = 'satellite';
const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
// crossOrigin makes tile responses readable (not opaque), so the service worker
// caches their real size instead of a padded one that eats the storage quota.
const satLayer = L.tileLayer(SAT_URL, { maxNativeZoom: 19, maxZoom: 21, crossOrigin: true, attribution: 'Esri, Maxar, Earthstar Geographics' });

const map = L.map('map', { zoomControl: false, attributionControl: true, tap: true, maxZoom: 21, preferCanvas: false }).setView([50.45, -104.6], 13);
map.attributionControl.setPrefix(false); // no "Leaflet" link; Esri's imagery credit stays (required by their terms)
// Layer None is just the plain black map background (#map in CSS).
function setLayer(name) {
  S.prefs.layer = name;
  if (name === 'satellite') satLayer.addTo(map); else satLayer.remove();
  setSeg('#layer-seg', name);
  savePrefs();
}
setLayer(S.prefs.layer);
const canvas = L.canvas({ padding: 0.3 });
const gShapes = L.layerGroup().addTo(map);
const gEdit = L.layerGroup().addTo(map);
const gDraw = L.layerGroup().addTo(map);
const gDrive = L.layerGroup().addTo(map);
let meMarker = null;

map.on('moveend', () => { S.prefs.lastView = { c: map.getCenter(), z: map.getZoom() }; savePrefs(); });

// ---------- view panel (eye button: theme + map layer) ----------
let openPanel = null; // 'view' | null
function togglePanel(name) {
  openPanel = openPanel === name ? null : name;
  $('#panel-view').hidden = !openPanel;
  $('#btn-view').classList.toggle('open', !!openPanel);
  $('#btn-view').setAttribute('aria-expanded', String(!!openPanel));
  $('#screen-map').classList.toggle('panel-open', !!openPanel);
  if (openPanel) { updateSatThumb(); updateDiag(); }
}

// TEMP: screen measurements to track down the black bar at the bottom of the home-screen app.
function updateDiag() {
  const cs = getComputedStyle($('#safe-probe'));
  const vv = window.visualViewport;
  $('#diag').textContent = [
    `app ${document.documentElement.classList.contains('standalone') ? 'home-screen' : 'browser'}`,
    `window ${innerWidth}×${innerHeight}`,
    `screen ${screen.width}×${screen.height}`,
    vv ? `visual ${Math.round(vv.width)}×${Math.round(vv.height)}` : '',
    `page ${document.body.clientHeight} / ${document.documentElement.clientHeight}`,
    `safe ${parseFloat(cs.paddingTop)} / ${parseFloat(cs.paddingBottom)}`,
    `iOS ${(navigator.userAgent.match(/OS (\d+)_(\d+)/) || []).slice(1).join('.') || '?'}`,
  ].filter(Boolean).join(' · ');
}
const closePanel = () => { if (openPanel) togglePanel(openPanel); };
$('#btn-view').addEventListener('click', () => togglePanel('view'));
wireSeg('#layer-seg', setLayer);

// Thumbnail of the imagery around the current map centre.
function updateSatThumb() {
  const z = Math.max(3, Math.min(17, map.getZoom() - 1));
  const t = map.project(map.getCenter(), z).divideBy(256).floor();
  $('#thumb-sat').style.backgroundImage = `url("${L.Util.template(SAT_URL, { z, x: t.x, y: t.y })}")`;
}

const geo = new URLSearchParams(location.search).has('sim') ? startSimulator(map, new URLSearchParams(location.search).get('sim')) : navigator.geolocation;

function showMe(lat, lng) {
  if (!meMarker) meMarker = L.marker([lat, lng], { icon: L.divIcon({ className: 'me-dot', iconSize: [18, 18] }), interactive: false, zIndexOffset: 900 }).addTo(map);
  else meMarker.setLatLng([lat, lng]);
}
function locate(quiet = false) {
  if (!geo) return toast('Location is not available on this device');
  geo.getCurrentPosition((pos) => {
    showMe(pos.coords.latitude, pos.coords.longitude);
    map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 16));
  }, (err) => { if (!quiet) toast(geoErrText(err)); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
}
const geoErrText = (err) => (err.code === 1 ? 'Location permission is off. Allow it for this app in Settings.' : 'Could not get a GPS position yet');
$('#btn-locate').addEventListener('click', () => locate());
$('#btn-home').addEventListener('click', () => {
  if (S.drive) return toast('Finish or discard the drive first');
  cancelDraw();
  closePanel();
  showProjects();
});

// ---------- open project ----------
function openProject(id, opts = {}) {
  S.current = S.projects.find((p) => p.id === id);
  if (!S.current) return;
  S.history = [];
  S.selectedId = null;
  $('#screen-projects').classList.add('hidden');
  $('#screen-map').classList.remove('hidden');
  map.invalidateSize();
  setEditing(false);
  const pts = S.current.boundaries.flatMap((b) => b.ring);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });
  else if (S.prefs.lastView) map.setView(S.prefs.lastView.c, S.prefs.lastView.z);
  if (opts.locate || !pts.length) locate(true);
}

function pushHistory() {
  S.history.push(JSON.stringify(S.current.boundaries));
  if (S.history.length > 40) S.history.shift();
}
$('#btn-undo').addEventListener('click', () => {
  if (S.draw && S.draw.pts.length) { S.draw.pts.pop(); renderDraw(); return; }
  const prev = S.history.pop();
  if (!prev) return toast('Nothing to undo');
  S.current.boundaries = JSON.parse(prev);
  if (!S.current.boundaries.some((b) => b.id === S.selectedId)) S.selectedId = null;
  saveProjects();
  render();
});

// Keyboard on a PC / iPad keyboard: Esc backs out of whatever is open, Ctrl/Cmd+Z undoes while editing.
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'Escape') {
    if (openSheetEl) closeSheet();
    else if (openPanel) closePanel();
    else if (S.draw || S.split) cancelDraw();
    else if (S.current && S.selectedId) { S.selectedId = null; render(); }
  } else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey && S.editing && !S.drive && !openSheetEl) {
    e.preventDefault();
    $('#btn-undo').click();
  }
});

const selected = () => S.current?.boundaries.find((b) => b.id === S.selectedId) || null;

// ---------- rendering ----------
// Boundary type 'slough' is shown as "Obstacle" (sloughs, tree bluffs, yards…).
// The stored value stays 'slough' so saved projects keep working.
const STYLE = {
  field: { color: '#f5d33a', weight: 3, fillColor: '#f5d33a', fillOpacity: 0.12, className: 'bnd-field' },
  slough: { color: '#5fc8f0', weight: 2.5, fillColor: '#2f6d8a', fillOpacity: 0.6, className: 'bnd-slough' },
};
let shapeLayers = new Map();

function render() {
  gShapes.clearLayers();
  shapeLayers = new Map();
  const bs = [...S.current.boundaries].sort((a, b) => (a.type === 'slough') - (b.type === 'slough'));
  for (const b of bs) {
    if (b.ring.length < 2) continue;
    const sel = b.id === S.selectedId;
    const poly = L.polygon(b.ring, { ...STYLE[b.type], weight: sel ? STYLE[b.type].weight + 2 : STYLE[b.type].weight, bubblingMouseEvents: false });
    poly.on('click', (e) => onShapeTap(b, e.latlng));
    if (b.type === 'field' || sel) {
      L.tooltip({ permanent: true, direction: 'center', className: 'part-label', interactive: false })
        .setLatLng(labelPoint(b)).setContent(`${escapeHtml(b.name)} · ${fmtAc(acres(b.ring))} ac`).addTo(gShapes);
    }
    poly.addTo(gShapes);
    shapeLayers.set(b.id, poly);
  }
  renderEditHandles();
  updateAreaChip();
}

// A label spot inside the boundary that avoids sitting on top of a slough.
function labelPoint(b) {
  const lats = b.ring.map((p) => p[0]), lngs = b.ring.map((p) => p[1]);
  const s = Math.min(...lats), n = Math.max(...lats), w = Math.min(...lngs), e = Math.max(...lngs);
  const others = b.type === 'field' ? S.current.boundaries.filter((x) => x.type === 'slough') : [];
  for (const fy of [0.5, 0.68, 0.32, 0.82, 0.18]) {
    for (const fx of [0.5, 0.35, 0.65]) {
      const pt = [s + (n - s) * fy, w + (e - w) * fx];
      if (pointInRing(pt, b.ring) && !others.some((o) => pointInRing(pt, o.ring))) return pt;
    }
  }
  return [(s + n) / 2, (w + e) / 2];
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function vxIcon(cls) { return L.divIcon({ className: `vx ${cls}`, html: '<i></i>', iconSize: [32, 32] }); }

function renderEditHandles() {
  gEdit.clearLayers();
  const b = selected();
  if (!b || !S.editing || S.draw || S.split || S.drive) return;
  const poly = shapeLayers.get(b.id);
  // Only show handles at least ~28 px apart at this zoom; zoom in to reach the rest.
  const shown = new Set();
  let lastPx = null;
  b.ring.forEach((ll, i) => {
    const px = map.latLngToLayerPoint(ll);
    if (!lastPx || px.distanceTo(lastPx) >= 28) { shown.add(i); lastPx = px; }
  });
  const show = (i) => shown.has(i);
  if (S.tool === 'move') {
    b.ring.forEach((ll, i) => {
      if (!show(i)) return;
      const m = L.marker(ll, { icon: vxIcon(''), draggable: true, autoPan: true, zIndexOffset: 500 });
      // Style the drag with a class: setIcon() mid-drag rebuilds the element and cancels the drag.
      m.on('dragstart', () => { pushHistory(); m.getElement()?.classList.add('dragging'); });
      m.on('drag', (e) => { b.ring[i] = [e.latlng.lat, e.latlng.lng]; poly.setLatLngs(b.ring); });
      m.on('dragend', () => { delete b.drive; saveProjects(); render(); });
      m.addTo(gEdit);
    });
  } else if (S.tool === 'add') {
    b.ring.forEach((ll, i) => { if (show(i)) L.marker(ll, { icon: vxIcon(''), interactive: false }).addTo(gEdit); });
    b.ring.forEach((ll, i) => {
      if (!show(i) && !show((i + 1) % b.ring.length)) return;
      const nx = b.ring[(i + 1) % b.ring.length];
      const mid = [(ll[0] + nx[0]) / 2, (ll[1] + nx[1]) / 2];
      const m = L.marker(mid, { icon: vxIcon('mid'), zIndexOffset: 600 });
      m.on('click', () => { pushHistory(); b.ring.splice(i + 1, 0, mid); delete b.drive; saveProjects(); render(); });
      m.addTo(gEdit);
    });
  } else if (S.tool === 'remove') {
    b.ring.forEach((ll, i) => {
      if (!show(i)) return;
      const m = L.marker(ll, { icon: vxIcon('rm'), zIndexOffset: 500 });
      m.on('click', () => {
        if (b.ring.length <= 3) return toast('A boundary needs at least 3 points. Delete it from the list instead.');
        pushHistory(); b.ring.splice(i, 1); delete b.drive; saveProjects(); render();
      });
      m.addTo(gEdit);
    });
  }
}

function updateAreaChip() {
  const p = S.current;
  if (!p) return;
  const a = computeAreas(p);
  $('#chip-label').textContent = `${p.name} ${p.year} · net`;
  $('#chip-net').textContent = `${fmtAc(a.net)} ac`;
  $('#chip-sub').textContent = a.slough > 0 ? `${fmtAc(a.gross)} gross − ${fmtAc(a.slough)} obstacles` : '';
}

// ---------- tools ----------
// Outside edit mode the toolbar and undo are hidden and taps only select (highlight) a boundary.
function setEditing(on) {
  S.editing = on;
  $('#screen-map').classList.toggle('editing', on);
  $('#btn-edit').classList.toggle('open', on);
  $('#btn-edit').setAttribute('aria-pressed', String(on));
  setTool('move');
}
$('#btn-edit').addEventListener('click', () => setEditing(!S.editing));

$('#toolbar').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tool]')?.dataset.tool;
  if (t) setTool(t);
});

function setTool(t) {
  cancelDraw(false);
  S.tool = t;
  $$('#toolbar [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  if (t === 'boundary' || t === 'slough') {
    S.draw = { type: t === 'slough' ? 'slough' : 'field', pts: [] };
    S.selectedId = null;
  }
  if (t === 'split') {
    const b = selected();
    if (b && b.type === 'field') S.split = { fieldId: b.id, pts: [] };
  }
  if (S.current) render();
  renderDraw();
}

function cancelDraw(reRender = true) {
  S.draw = null;
  S.split = null;
  gDraw.clearLayers();
  $('#draw-bar').hidden = true;
  $('#screen-map').classList.remove('placing');
  map.doubleClickZoom.enable();
  if (reRender && S.current) { S.tool = 'move'; $$('#toolbar [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === 'move'))); render(); }
}


function onShapeTap(b, latlng) {
  if (openPanel) return closePanel(); // a tap outside an open panel just closes it
  if (S.drive) return;
  if (S.draw) return onMapTap(latlng);
  if (S.tool === 'split') {
    if (S.split) return onMapTap(latlng);
    if (b.type !== 'field') return toast('Tap a field, not an obstacle');
    S.selectedId = b.id;
    S.split = { fieldId: b.id, pts: [] };
    render();
    renderDraw();
    return;
  }
  S.selectedId = b.id;
  render();
}

function onMapTap(latlng) {
  if (S.drive) return;
  const pt = [latlng.lat, latlng.lng];
  if (S.draw) { S.draw.pts.push(pt); renderDraw(); return; }
  if (S.split) {
    if (S.split.pts.length >= 2) S.split.pts = [];
    S.split.pts.push(pt);
    renderDraw();
    return;
  }
  if (S.selectedId) { S.selectedId = null; render(); }
}
map.on('click', (e) => { if (openPanel) closePanel(); else onMapTap(e.latlng); });
map.on('zoomend', () => { if (S.current && S.selectedId && !S.drive) renderEditHandles(); });

function renderDraw() {
  gDraw.clearLayers();
  // While placing points, quick taps/clicks must not double-tap zoom; crosshair cursor on PC.
  const placing = !!(S.draw || S.split);
  $('#screen-map').classList.toggle('placing', placing);
  if (placing) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  const bar = $('#draw-bar');
  if (S.draw) {
    bar.hidden = false;
    $('#draw-undo').hidden = false;
    $('#draw-done').disabled = S.draw.pts.length < 3;
    const st = STYLE[S.draw.type];
    if (S.draw.pts.length >= 2) L.polygon(S.draw.pts, { ...st, dashArray: '6 6', interactive: false }).addTo(gDraw);
    S.draw.pts.forEach((p) => L.marker(p, { icon: vxIcon('drawpt'), interactive: false }).addTo(gDraw));
  } else if (S.split) {
    bar.hidden = false;
    $('#draw-undo').hidden = true;
    $('#draw-done').disabled = S.split.pts.length < 2;
    if (S.split.pts.length === 2) L.polyline(S.split.pts, { color: '#f08a24', weight: 3, dashArray: '8 6', interactive: false }).addTo(gDraw);
    S.split.pts.forEach((p) => L.marker(p, { icon: vxIcon('drawpt'), interactive: false }).addTo(gDraw));
  } else {
    bar.hidden = true;
  }
}

$('#draw-undo').addEventListener('click', () => { if (S.draw?.pts.length) { S.draw.pts.pop(); renderDraw(); } });
$('#draw-cancel').addEventListener('click', () => cancelDraw());
$('#draw-done').addEventListener('click', () => {
  if (S.draw) {
    if (S.draw.pts.length < 3) return;
    pushHistory();
    const n = S.current.boundaries.filter((b) => b.type === S.draw.type).length + 1;
    const b = { id: uid(), name: S.draw.type === 'slough' ? `Obstacle ${n}` : `Field ${n}`, type: S.draw.type, ring: S.draw.pts };
    S.current.boundaries.push(b);
    saveProjects();
    cancelDraw();
    S.selectedId = b.id;
    render();
    toast(`${b.name}: ${fmtAc(acres(b.ring))} ac`);
  } else if (S.split && S.split.pts.length === 2) {
    const f = S.current.boundaries.find((b) => b.id === S.split.fieldId);
    const parts = f && splitRing(f.ring, S.split.pts[0], S.split.pts[1]);
    if (!parts) return toast('The line has to cross the field. Tap two points on opposite sides.');
    pushHistory();
    const idx = S.current.boundaries.indexOf(f);
    const nb = parts.map((ring, i) => ({ id: uid(), name: `${f.name} ${'AB'[i]}`, type: 'field', ring }));
    S.current.boundaries.splice(idx, 1, ...nb);
    saveProjects();
    cancelDraw();
    S.selectedId = null;
    render();
    toast(`Split into ${fmtAc(acres(nb[0].ring))} and ${fmtAc(acres(nb[1].ring))} ac`);
  }
});

// ---------- boundaries sheet ----------
$('#area-chip').addEventListener('click', openBoundaries);
function openBoundaries() {
  const p = S.current;
  const a = computeAreas(p);
  $('#sb-title').textContent = p.name;
  $('#sb-sub').textContent = `Crop year ${p.year} · acres`;
  const list = $('#sb-list');
  list.innerHTML = '';
  const row = (b, area, child, sub) => {
    const r = document.createElement('div');
    r.className = `b-row ${b.type}${child ? ' child' : ''}`;
    r.innerHTML = `<button type="button" class="sel"><span class="sw"></span><span class="nm"><b></b><small></small></span><span class="area"></span></button><button type="button" class="more-btn" aria-label="Edit boundary">⋯</button>`;
    r.querySelector('b').textContent = b.name;
    r.querySelector('small').textContent = sub;
    r.querySelector('.area').textContent = area;
    r.querySelector('.sel').addEventListener('click', () => { closeSheet(); if (S.draw || S.split) setTool('move'); S.selectedId = b.id; render(); map.fitBounds(L.latLngBounds(b.ring), { padding: [80, 80] }); });
    r.querySelector('.more-btn').addEventListener('click', () => openBoundaryEdit(b));
    list.appendChild(r);
  };
  for (const pf of a.perField) {
    row(pf.field, `${fmtAc(pf.gross)} ac`, false, `Field · ${pf.field.ring.length} points${pf.field.drive ? ' · GPS' : ''}`);
    for (const s of pf.sloughs) row(s, `− ${fmtAc(acres(s.ring))} ac`, true, 'Obstacle');
  }
  for (const s of a.loose) row(s, `${fmtAc(acres(s.ring))} ac`, false, 'Obstacle · outside any field');
  if (!p.boundaries.length) list.innerHTML = '<div class="b-empty">No boundaries yet.</div>';
  $('#t-gross').textContent = fmtAc(a.gross);
  $('#t-slough').textContent = fmtAc(a.slough);
  $('#t-net').textContent = fmtAc(a.net);
  openSheet('#sheet-boundaries');
}
$('#sb-edit').addEventListener('click', () => openProjectForm(S.current));
$('#sb-export').addEventListener('click', () => openExport());

// ---------- boundary edit ----------
let beTarget = null, beOffFt = 0;
function openBoundaryEdit(b) {
  beTarget = b;
  const f = $('#form-bedit');
  f.name.value = b.name;
  setSeg('#be-type', b.type);
  $('#be-drive').hidden = !b.drive;
  if (b.drive) {
    beOffFt = b.drive.offsetFt;
    $('#be-off-val').textContent = beOffFt;
    setSeg('#be-side', b.drive.side);
  }
  openSheet('#sheet-bedit');
}
wireSeg('#be-type');
wireSeg('#be-side');
$('#be-off-minus').addEventListener('click', () => { beOffFt = Math.max(0, beOffFt - 1); $('#be-off-val').textContent = beOffFt; });
$('#be-off-plus').addEventListener('click', () => { beOffFt = Math.min(500, beOffFt + 1); $('#be-off-val').textContent = beOffFt; });
$('#form-bedit').addEventListener('submit', (e) => {
  e.preventDefault();
  const b = beTarget;
  pushHistory();
  b.name = e.target.name.value.trim() || b.name;
  b.type = segValue('#be-type') || b.type;
  if (b.drive) {
    const side = segValue('#be-side');
    if (side !== b.drive.side || beOffFt !== b.drive.offsetFt) {
      const { line } = buildBoundary(b.drive.fixes.map(unpackFix), { offsetM: beOffFt * FT, side, closed: true });
      if (line.length >= 3) { b.ring = line; b.drive.offsetFt = beOffFt; b.drive.side = side; }
    }
  }
  saveProjects();
  closeSheet();
  render();
});
$('#be-delete').addEventListener('click', () => {
  if (!confirm(`Delete ${beTarget.name}?`)) return;
  pushHistory();
  S.current.boundaries = S.current.boundaries.filter((x) => x !== beTarget);
  if (S.selectedId === beTarget.id) S.selectedId = null;
  saveProjects();
  closeSheet();
  render();
});

// ---------- drive ----------
let sdOffFt = 0;
$('#btn-drive').addEventListener('click', () => openDriveSetup());
function openDriveSetup() {
  if (!geo) return toast('GPS is not available on this device');
  cancelDraw();
  closePanel();
  const f = $('#form-drive');
  const nF = S.current.boundaries.filter((b) => b.type === 'field').length;
  setSeg('#sd-type', 'field');
  f.name.value = nF ? `Field ${nF + 1}` : 'Field 1';
  sdOffFt = S.prefs.offsetFt || 0;
  $('#sd-off-val').textContent = sdOffFt;
  setSeg('#sd-side', S.prefs.side || 'left');
  openSheet('#sheet-drive');
}
wireSeg('#sd-type', (v) => {
  const n = S.current.boundaries.filter((b) => b.type === v).length + 1;
  $('#form-drive').name.value = v === 'slough' ? `Obstacle ${n}` : `Field ${n}`;
});
wireSeg('#sd-side');
$('#sd-off-minus').addEventListener('click', () => { sdOffFt = Math.max(0, sdOffFt - 1); $('#sd-off-val').textContent = sdOffFt; });
$('#sd-off-plus').addEventListener('click', () => { sdOffFt = Math.min(500, sdOffFt + 1); $('#sd-off-val').textContent = sdOffFt; });
$('#form-drive').addEventListener('submit', (e) => {
  e.preventDefault();
  const side = segValue('#sd-side') || 'left';
  S.prefs.offsetFt = sdOffFt; S.prefs.side = side; savePrefs();
  closeSheet();
  startDrive({ projectId: S.current.id, type: segValue('#sd-type') || 'field', name: e.target.name.value.trim() || 'Field', offsetFt: sdOffFt, side, fixes: [], paused: false, startedAt: Date.now() });
});

const D = { watchId: null, wakeLock: null, raw: null, dots: null, frozen: null, live: null, truck: null, frozenUpto: 0, follow: true, lastSaved: 0, lastPos: null };

function driveOpts(closed) {
  return { offsetM: S.drive.offsetFt * FT, side: S.drive.side, closed };
}

function startDrive(state) {
  S.drive = state;
  S.selectedId = null;
  render();
  $('#screen-map').classList.add('driving');
  $('#drive-title').textContent = `${S.current.name} ${S.current.year} · ${state.name}`;
  $('#off-val').textContent = state.offsetFt;
  setSeg('#side-seg', state.side);
  // Offset was just set in the drive sheet; the Offset button brings the panel back if needed.
  $('#offset-panel').hidden = true;
  $('#drv-offset').classList.remove('on');
  D.raw = L.polyline([], { color: '#4da3ff', weight: 2.5, interactive: false, renderer: canvas }).addTo(gDrive);
  D.dots = L.layerGroup().addTo(gDrive);
  D.frozen = L.layerGroup().addTo(gDrive);
  D.live = L.polyline([], { color: '#f5d33a', weight: 3.5, interactive: false, className: 'bnd-field' }).addTo(gDrive);
  D.frozenUpto = 0;
  D.follow = true;
  $('#drv-follow').classList.add('on');
  const fixes = state.fixes.map(unpackFix);
  fixes.forEach((f) => addDot(f));
  D.raw.setLatLngs(fixes.map((f) => [f.lat, f.lng]));
  D._fixes = fixes;
  D.distM = fixes.reduce((s, f, i) => (i ? s + distanceM([fixes[i - 1].lat, fixes[i - 1].lng], [f.lat, f.lng]) : 0), 0);
  D.bounds = L.latLngBounds(fixes.map((f) => [f.lat, f.lng]));
  D.maxFromStart = fixes.reduce((m, f) => Math.max(m, distanceM([fixes[0].lat, fixes[0].lng], [f.lat, f.lng])), 0);
  if (fixes.length) setTimeout(() => fitDrive(false), 0); // resumed drive: show what's recorded so far
  updateTrackStats();
  clearInterval(D.clock);
  D.clock = setInterval(updateClock, 1000);
  updateClock();
  refreshPreview(true);
  setPausedUi();
  D.watchId = geo.watchPosition(onFix, (err) => toast(geoErrText(err)), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  requestWakeLock();
  persistDrive(true);
}

function addDot(f) {
  L.circleMarker([f.lat, f.lng], { radius: 3.5, color: '#0f1108', weight: 1.5, fillColor: '#ffffff', fillOpacity: 1, interactive: false, renderer: canvas }).addTo(D.dots);
}

function truckIcon(heading) {
  return L.divIcon({ className: 'truck', iconSize: [34, 34], html: `<svg viewBox="-17 -17 34 34" style="transform: rotate(${heading || 0}deg)"><circle r="16" fill="#4da3ff" fill-opacity="0.22"/><path d="M0 -12 L9 10 L0 5 L-9 10 Z" fill="#4da3ff" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>` });
}

function onFix(pos) {
  if (!S.drive) return;
  const c = pos.coords;
  const f = { lat: c.latitude, lng: c.longitude, t: pos.timestamp || Date.now(), speed: c.speed, heading: c.heading, acc: c.accuracy };
  const prev = D._fixes[D._fixes.length - 1];
  if (f.speed == null && prev) {
    const dt = (f.t - prev.t) / 1000;
    if (dt > 0) f.speed = distanceM([prev.lat, prev.lng], [f.lat, f.lng]) / dt;
  }
  D.lastPos = f;
  const hdg = f.heading != null && !Number.isNaN(f.heading) ? f.heading : D._lastHeading;
  D._lastHeading = hdg;
  if (!D.truck) D.truck = L.marker([f.lat, f.lng], { icon: truckIcon(hdg), interactive: false, zIndexOffset: 1000 }).addTo(gDrive);
  else { D.truck.setLatLng([f.lat, f.lng]); D.truck.setIcon(truckIcon(hdg)); }
  D.bounds.extend([f.lat, f.lng]);
  if (D.follow) fitDrive();
  updateStats(f);
  if (S.drive.paused) return;
  if (f.acc != null && f.acc > 30) return; // too poor to use
  if (prev && f.t <= prev.t) return;
  if (prev) D.distM += distanceM([prev.lat, prev.lng], [f.lat, f.lng]);
  D._fixes.push(f);
  S.drive.fixes.push(packFix(f));
  updateTrackStats();
  if (closesLoop(prev, f)) { finishDrive(true); return; }
  D.raw.addLatLng([f.lat, f.lng]);
  addDot(f);
  refreshPreview();
  persistDrive();
}

// Follow: keep the whole track so far and the truck in view, clear of the data card, rail and toolbar.
function fitDrive(animate = true) {
  if (!D.bounds.isValid()) return;
  const top = $('#drive-stats').getBoundingClientRect().bottom + 16;
  const left = $('#rail').getBoundingClientRect().right + 16;
  const bottom = map.getSize().y - $('#drive-bottom').getBoundingClientRect().top + 16;
  map.fitBounds(D.bounds, { paddingTopLeft: [left, top], paddingBottomRight: [16, bottom], maxZoom: 18, animate, duration: 0.5 });
}
function stopFollowing() {
  if (!S.drive || !D.follow) return;
  D.follow = false;
  $('#drv-follow').classList.remove('on');
}

// Auto-close: once the drive has been well away from its start, passing back within 20 ft of the
// first fix finishes it. Checks the whole segment between fixes, since at speed 1 Hz fixes are
// further apart than 20 ft and could step right over the start.
const CLOSE_M = 20 * FT;
const CLOSE_AWAY_M = 30; // must first get this far from the start
function closesLoop(prev, f) {
  const s = D._fixes[0];
  if (!prev || !s || s === f) return false;
  const P = makeProjector(s.lat, s.lng);
  const a = P.toXY([prev.lat, prev.lng]), b = P.toXY([f.lat, f.lng]);
  D.maxFromStart = Math.max(D.maxFromStart, Math.hypot(b[0], b[1]));
  if (D.maxFromStart < CLOSE_AWAY_M) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2)) : 0;
  return Math.hypot(a[0] + t * dx, a[1] + t * dy) <= CLOSE_M;
}

const CHUNK = 100;
function refreshPreview(reset = false) {
  const fx = D._fixes;
  if (reset) { D.frozen.clearLayers(); D.frozenUpto = 0; }
  const opts = driveOpts(false);
  while (D.frozenUpto + CHUNK + 2 <= fx.length) {
    const s = Math.max(0, D.frozenUpto - 1);
    const line = buildBoundary(fx.slice(s, D.frozenUpto + CHUNK + 2), opts).line;
    L.polyline(line, { color: '#f5d33a', weight: 3.5, interactive: false, className: 'bnd-field' }).addTo(D.frozen);
    D.frozenUpto += CHUNK;
  }
  D.live.setLatLngs(buildBoundary(fx.slice(Math.max(0, D.frozenUpto - 1)), opts).line);
}

function updateStats(f) {
  const kmh = f.speed != null && f.speed >= 0 ? f.speed * 3.6 : null;
  $('#st-speed').textContent = kmh == null ? '–' : `${Math.round(kmh)} km/h`;
  const now = f.t;
  D._times = (D._times || []).filter((t) => now - t < 10000);
  D._times.push(now);
  const span = (now - D._times[0]) / 1000;
  $('#st-rate').textContent = D._times.length > 1 && span > 0 ? `${((D._times.length - 1) / span).toFixed(1)} Hz` : '–';
  $('#st-acc').textContent = f.acc == null ? '–' : `± ${Math.round(f.acc / FT)} ft`;
  $('#st-acc').classList.toggle('warn', f.acc != null && f.acc > 5); // worse than ~16 ft
  const moving = f.speed != null && f.speed > 0.5 && f.heading != null && !Number.isNaN(f.heading);
  $('#st-heading').textContent = moving ? `${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(f.heading / 45) % 8]} ${Math.round(f.heading)}°` : '–';
}

function updateTrackStats() {
  $('#st-points').textContent = S.drive.fixes.length.toLocaleString('en-CA');
  const km = D.distM / 1000;
  $('#st-dist').textContent = `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

// Elapsed time since the drive started (older saved drives: since the first fix).
function updateClock() {
  if (!S.drive) return;
  const t0 = S.drive.startedAt || S.drive.fixes[0]?.[2] || Date.now();
  const s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
  $('#st-time').textContent = hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function persistDrive(force = false) {
  const now = Date.now();
  if (!force && now - D.lastSaved < 4000) return;
  D.lastSaved = now;
  store(DRIVE_KEY, S.drive);
}

function setPausedUi() {
  const p = S.drive?.paused;
  $('#drv-pause-lbl').textContent = p ? 'Resume' : 'Pause';
  $('#drv-pause .ico').innerHTML = svgIcon(p ? 'play' : 'pause');
  $('#rec-dot').classList.toggle('paused', !!p);
  $('#drive-state').textContent = p ? 'PAUSED' : 'REC';
}

async function requestWakeLock() {
  try { D.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.drive) requestWakeLock();
  if (document.visibilityState === 'hidden') {
    if (S.drive) persistDrive(true);
    // Write any pending edit now; iOS may kill the app before the debounce fires.
    clearTimeout(saveTimer);
    store(STORE_KEY, S.projects);
  }
});

function stopDrive() {
  if (D.watchId != null) geo.clearWatch(D.watchId);
  D.watchId = null;
  try { D.wakeLock?.release(); } catch { /* ignore */ }
  D.wakeLock = null;
  gDrive.clearLayers();
  D.truck = null;
  clearInterval(D.clock);
  D.lastPos = null;
  D._times = [];
  D._lastHeading = null;
  S.drive = null;
  try { localStorage.removeItem(DRIVE_KEY); } catch { /* ignore */ }
  $('#screen-map').classList.remove('driving');
}

$('#drv-pause').addEventListener('click', () => { S.drive.paused = !S.drive.paused; setPausedUi(); persistDrive(true); toast(S.drive.paused ? 'Paused. Fixes are not recorded.' : 'Recording'); });
$('#drv-offset').addEventListener('click', () => { const p = $('#offset-panel'); p.hidden = !p.hidden; $('#drv-offset').classList.toggle('on', !p.hidden); });
$('#drv-follow').addEventListener('click', () => { D.follow = !D.follow; $('#drv-follow').classList.toggle('on', D.follow); if (D.follow) fitDrive(); });
// Moving or pinching the map yourself turns Follow off until you tap it again.
map.on('dragstart', stopFollowing);
map.getContainer().addEventListener('touchstart', (e) => { if (e.touches.length > 1) stopFollowing(); }, { passive: true });
function changeDriveOffset(ft, side) {
  S.drive.offsetFt = ft; S.drive.side = side;
  S.prefs.offsetFt = ft; S.prefs.side = side; savePrefs();
  $('#off-val').textContent = ft;
  refreshPreview(true);
  persistDrive(true);
}
$('#off-minus').addEventListener('click', () => changeDriveOffset(Math.max(0, S.drive.offsetFt - 1), S.drive.side));
$('#off-plus').addEventListener('click', () => changeDriveOffset(Math.min(500, S.drive.offsetFt + 1), S.drive.side));
wireSeg('#side-seg', (v) => changeDriveOffset(S.drive.offsetFt, v));
$('#drv-cancel').addEventListener('click', () => {
  if (S.drive.fixes.length > 5 && !confirm('Discard this drive? The recorded GPS points will be lost.')) return;
  stopDrive();
  render();
});
$('#drv-finish').addEventListener('click', () => finishDrive());
function finishDrive(auto = false) {
  const fx = D._fixes;
  if (fx.length < 3) return toast('Not enough GPS points yet. Keep driving.');
  const { line } = buildBoundary(fx, driveOpts(true));
  if (line.length < 3) return toast('Not enough distance covered yet. Keep driving.');
  const dr = S.drive;
  pushHistory();
  const b = { id: uid(), name: dr.name, type: dr.type, ring: line, drive: { fixes: dr.fixes, offsetFt: dr.offsetFt, side: dr.side } };
  const p = S.projects.find((x) => x.id === dr.projectId) || S.current;
  p.boundaries.push(b);
  stopDrive();
  saveProjects(true);
  S.selectedId = b.id;
  render();
  map.fitBounds(L.latLngBounds(b.ring), { padding: [70, 70] });
  toast(`${auto ? 'Back at the start. ' : ''}${b.name}: ${fmtAc(acres(b.ring))} ac`, 3500);
}

// ---------- export ----------
let exportFormat = 'shp';
function openExport() {
  const p = S.current;
  if (!p.boundaries.length) return toast('Nothing to export yet');
  const f = $('#form-export');
  f.name.value = p.name;
  f.year.value = p.year;
  const zone = utmZoneFor(projectCenterLng(p));
  $('#se-proj').innerHTML = `<option value="wgs84">WGS 84 (lat/lon)</option><option value="utm:${zone}">NAD83 / UTM zone ${zone}N</option>`;
  setSeg('#se-format', exportFormat);
  $('#se-n-cut').textContent = `${exportFeatures(p, 'cutout').length} shape${exportFeatures(p, 'cutout').length === 1 ? '' : 's'}`;
  $('#se-n-sep').textContent = `${exportFeatures(p, 'separate').length} shapes`;
  updateExportUi();
  openSheet('#sheet-export');
}
function updateExportUi() {
  const f = $('#form-export');
  const isShp = exportFormat === 'shp';
  $('#se-points-row').hidden = !isShp;
  $('#se-proj-row').hidden = !isShp;
  const base = `${safeName(f.name.value)}_${f.year.value}`;
  $('#se-file').textContent = `${base}.${isShp ? 'zip' : exportFormat}`;
}
wireSeg('#se-format', (v) => { exportFormat = v; updateExportUi(); });
$('#form-export').addEventListener('input', updateExportUi);
$('#form-export').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const p = S.current;
  const name = f.name.value.trim(), year = Number(f.year.value);
  if (name && year) { p.name = name; p.year = year; saveProjects(); updateAreaChip(); }
  const mode = f.mode.value;
  let file;
  if (exportFormat === 'shp') {
    const pv = f.projection.value;
    const projection = pv.startsWith('utm') ? { kind: 'utm', zone: Number(pv.split(':')[1]) } : { kind: 'wgs84' };
    file = buildShapefileZip(p, { mode, points: f.points.checked, projection });
  } else if (exportFormat === 'kml') file = buildKml(p, mode);
  else file = buildGeoJson(p, mode);
  await shareOrDownload(file);
  closeSheet();
});

async function shareOrDownload({ name, data, type }) {
  const file = new File([data], name, { type });
  // Share sheet on phones and tablets (iPad Safari reports itself as a Mac, but has touch).
  const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (navigator.canShare?.({ files: [file] }) && mobile) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Saved ${name}`);
}

// ---------- startup ----------
paintIcons();
$('#app-version').textContent = `Version ${APP_VERSION}`;
const pendingDrive = load(DRIVE_KEY, null);
if (pendingDrive && S.projects.some((p) => p.id === pendingDrive.projectId)) {
  openProject(pendingDrive.projectId);
  if (confirm(`Resume the GPS drive in progress (${pendingDrive.fixes.length} points recorded)?`)) startDrive(pendingDrive);
  else { try { localStorage.removeItem(DRIVE_KEY); } catch { /* ignore */ } }
} else {
  // A saved drive whose project was deleted can never be resumed.
  if (pendingDrive) { try { localStorage.removeItem(DRIVE_KEY); } catch { /* ignore */ } }
  showProjects();
}
navigator.storage?.persist?.();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__app = { S, map };

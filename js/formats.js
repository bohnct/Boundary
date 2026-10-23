// Turn a project into export files, and import files into boundaries.

import { acres, centroid, pointInRing, utmZoneFor, signedAreaLL } from './geo.js';
import { writePolygons, writePoints, prjFor, readPolygons } from './shapefile.js';
import { makeZip, readZip } from './zip.js';

// ---------- areas ----------
export function computeAreas(project) {
  const fields = project.boundaries.filter((b) => b.type === 'field' && b.ring.length >= 3);
  const sloughs = project.boundaries.filter((b) => b.type === 'slough' && b.ring.length >= 3);
  // Each slough belongs to the smallest field that contains it, so it is only subtracted once.
  const owner = new Map();
  for (const s of sloughs) {
    const c = centroid(s.ring);
    let best = null, bestA = Infinity;
    for (const f of fields) {
      if (!pointInRing(c, f.ring)) continue;
      const a = acres(f.ring);
      if (a < bestA) { best = f; bestA = a; }
    }
    if (best) owner.set(s.id, best.id);
  }
  const perField = fields.map((f) => {
    const inside = sloughs.filter((s) => owner.get(s.id) === f.id);
    const gross = acres(f.ring);
    const slough = inside.reduce((s, b) => s + acres(b.ring), 0);
    return { field: f, sloughs: inside, gross, slough, net: gross - slough };
  });
  const assigned = new Set(perField.flatMap((p) => p.sloughs.map((s) => s.id)));
  const loose = sloughs.filter((s) => !assigned.has(s.id));
  const gross = perField.reduce((s, p) => s + p.gross, 0);
  const slough = perField.reduce((s, p) => s + p.slough, 0);
  return { perField, loose, gross, slough, net: gross - slough };
}

export const fmtAc = (v) => (Math.round(v * 100) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const POLY_FIELDS = [
  { name: 'NAME', type: 'C', length: 50 },
  { name: 'PART', type: 'C', length: 40 },
  { name: 'YEAR', type: 'N', length: 4, decimals: 0 },
  { name: 'TYPE', type: 'C', length: 10 },
  { name: 'ACRES', type: 'N', length: 12, decimals: 2 },
];
const POINT_FIELDS = [
  { name: 'NAME', type: 'C', length: 50 },
  { name: 'PART', type: 'C', length: 40 },
  { name: 'YEAR', type: 'N', length: 4, decimals: 0 },
  { name: 'TYPE', type: 'C', length: 10 },
  { name: 'IDX', type: 'N', length: 6, decimals: 0 },
];

// Stored type 'slough' is called "obstacle" in the app and in exported files.
const typeOut = (t) => (t === 'slough' ? 'obstacle' : t);
const isObstacle = (s) => /^(obstacle|slough)$/i.test(String(s || '').trim());

// mode: 'cutout' (obstacles as holes) | 'separate'
export function exportFeatures(project, mode) {
  const areas = computeAreas(project);
  const base = { NAME: project.name, YEAR: Number(project.year) || null };
  const feats = [];
  if (mode === 'cutout') {
    for (const p of areas.perField) {
      feats.push({ rings: [p.field.ring, ...p.sloughs.map((s) => s.ring)], attrs: { ...base, PART: p.field.name, TYPE: 'field', ACRES: p.net } });
    }
    for (const s of areas.loose) feats.push({ rings: [s.ring], attrs: { ...base, PART: s.name, TYPE: typeOut('slough'), ACRES: acres(s.ring) } });
  } else {
    for (const b of project.boundaries) {
      if (b.ring.length < 3) continue;
      feats.push({ rings: [b.ring], attrs: { ...base, PART: b.name, TYPE: typeOut(b.type), ACRES: acres(b.ring) } });
    }
  }
  return feats;
}

export function safeName(s) {
  return String(s || 'boundary').trim().replace(/[^A-Za-z0-9_-]+/g, '') || 'boundary';
}

export function projectCenterLng(project) {
  const pts = project.boundaries.flatMap((b) => b.ring);
  return pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : -105;
}

// opts: { mode, points: bool, projection: {kind, zone} }
export function buildShapefileZip(project, opts) {
  const base = `${safeName(project.name)}_${project.year || ''}`.replace(/_$/, '');
  const proj = opts.projection;
  const files = [];
  const polys = writePolygons(exportFeatures(project, opts.mode), POLY_FIELDS, proj);
  const prj = new TextEncoder().encode(prjFor(proj));
  const cpg = new TextEncoder().encode('UTF-8');
  files.push({ name: `${base}.shp`, data: polys.shp }, { name: `${base}.shx`, data: polys.shx }, { name: `${base}.dbf`, data: polys.dbf }, { name: `${base}.prj`, data: prj }, { name: `${base}.cpg`, data: cpg });
  if (opts.points) {
    const pts = [];
    for (const b of project.boundaries) b.ring.forEach((ll, i) => pts.push({ ll, attrs: { NAME: project.name, PART: b.name, YEAR: Number(project.year) || null, TYPE: typeOut(b.type), IDX: i + 1 } }));
    const p = writePoints(pts, POINT_FIELDS, proj);
    files.push({ name: `${base}_points.shp`, data: p.shp }, { name: `${base}_points.shx`, data: p.shx }, { name: `${base}_points.dbf`, data: p.dbf }, { name: `${base}_points.prj`, data: prj }, { name: `${base}_points.cpg`, data: cpg });
  }
  return { name: `${base}.zip`, data: makeZip(files), type: 'application/zip' };
}

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function buildKml(project, mode) {
  const feats = exportFeatures(project, mode);
  const ringKml = (r) => {
    const c = [...r, r[0]].map(([lat, lng]) => `${lng.toFixed(8)},${lat.toFixed(8)},0`).join(' ');
    return `<LinearRing><coordinates>${c}</coordinates></LinearRing>`;
  };
  const marks = feats.map((f) => `<Placemark><name>${esc(f.attrs.PART)}</name><styleUrl>#${f.attrs.TYPE}</styleUrl><ExtendedData>${Object.entries(f.attrs).map(([k, v]) => `<Data name="${k}"><value>${esc(k === 'ACRES' ? v.toFixed(2) : v)}</value></Data>`).join('')}</ExtendedData><Polygon><outerBoundaryIs>${ringKml(f.rings[0])}</outerBoundaryIs>${f.rings.slice(1).map((h) => `<innerBoundaryIs>${ringKml(h)}</innerBoundaryIs>`).join('')}</Polygon></Placemark>`).join('\n');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(project.name)} ${esc(project.year)}</name>
<Style id="field"><LineStyle><color>ff3ad3f5</color><width>3</width></LineStyle><PolyStyle><color>333ad3f5</color></PolyStyle></Style>
<Style id="obstacle"><LineStyle><color>fff0c85f</color><width>2</width></LineStyle><PolyStyle><color>66f0c85f</color></PolyStyle></Style>
${marks}
</Document></kml>`;
  return { name: `${safeName(project.name)}_${project.year}.kml`, data: new TextEncoder().encode(kml), type: 'application/vnd.google-earth.kml+xml' };
}

export function buildGeoJson(project, mode) {
  const feats = exportFeatures(project, mode).map((f) => {
    const rings = f.rings.map((r, i) => {
      let c = r.map(([lat, lng]) => [lng, lat]);
      // RFC 7946: outer counter-clockwise, holes clockwise.
      const ccw = signedAreaLL(r) > 0;
      if ((i === 0) !== ccw) c = c.reverse();
      return [...c, c[0]];
    });
    return { type: 'Feature', properties: { ...f.attrs, ACRES: Math.round(f.attrs.ACRES * 100) / 100 }, geometry: { type: 'Polygon', coordinates: rings } };
  });
  const json = JSON.stringify({ type: 'FeatureCollection', features: feats });
  return { name: `${safeName(project.name)}_${project.year}.geojson`, data: new TextEncoder().encode(json), type: 'application/geo+json' };
}

// ---------- import ----------
// Returns [{ name, type, ring }]
export async function importFile(file) {
  const lower = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (lower.endsWith('.zip')) return importShapeZip(buf);
  const text = new TextDecoder().decode(buf);
  if (lower.endsWith('.kml')) return importKml(text);
  if (lower.endsWith('.geojson') || lower.endsWith('.json')) return importGeoJson(JSON.parse(text));
  throw new Error('Supported files: zipped shapefile (.zip), KML or GeoJSON');
}

async function importShapeZip(buf) {
  const files = await readZip(buf);
  const names = Object.keys(files).filter((n) => !n.startsWith('__MACOSX'));
  const shpName = names.find((n) => n.toLowerCase().endsWith('.shp') && !/_points\.shp$/i.test(n)) || names.find((n) => n.toLowerCase().endsWith('.shp'));
  if (!shpName) throw new Error('No .shp file found in the zip');
  const stem = shpName.slice(0, -4);
  const find = (ext) => names.find((n) => n.toLowerCase() === (stem + ext).toLowerCase());
  const prj = find('.prj') ? new TextDecoder().decode(files[find('.prj')]) : '';
  const polys = readPolygons(files[shpName], find('.dbf') ? files[find('.dbf')] : null, prj);
  const out = [];
  polys.forEach((p, i) => {
    const a = p.attrs || {};
    const type = isObstacle(a.TYPE) ? 'slough' : 'field';
    const name = a.PART || a.NAME || a.FIELD || a.Name || a.name || (type === 'field' ? `Field ${i + 1}` : `Obstacle ${i + 1}`);
    out.push({ name, type, ring: p.outer });
    p.holes.forEach((h, k) => out.push({ name: `Obstacle ${k + 1}`, type: 'slough', ring: h }));
  });
  return out;
}

function importKml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const parse = (el) => el.textContent.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((c) => c.length >= 2 && !c.some(Number.isNaN)).map(([lng, lat]) => [lat, lng]);
  const out = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = pm.getElementsByTagName('name')[0]?.textContent?.trim();
    for (const poly of pm.getElementsByTagName('Polygon')) {
      const outer = poly.getElementsByTagName('outerBoundaryIs')[0]?.getElementsByTagName('coordinates')[0];
      if (!outer) continue;
      const isObs = /slough|obstacle/i.test(pm.getElementsByTagName('styleUrl')[0]?.textContent || '') || /slough|obstacle/i.test(name || '');
      out.push({ name: name || `Field ${out.length + 1}`, type: isObs ? 'slough' : 'field', ring: dropClose(parse(outer)) });
      [...poly.getElementsByTagName('innerBoundaryIs')].forEach((ib, k) => {
        const c = ib.getElementsByTagName('coordinates')[0];
        if (c) out.push({ name: `Obstacle ${k + 1}`, type: 'slough', ring: dropClose(parse(c)) });
      });
    }
  }
  if (!out.length) throw new Error('No polygons found in the KML');
  return out;
}

function importGeoJson(gj) {
  const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ type: 'Feature', properties: {}, geometry: gj }];
  const out = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const props = f.properties || {};
    const type = isObstacle(props.TYPE || props.type) ? 'slough' : 'field';
    for (const rings of polys) {
      const ll = rings.map((r) => dropClose(r.map(([lng, lat]) => [lat, lng])));
      out.push({ name: props.PART || props.NAME || props.name || `Field ${out.length + 1}`, type, ring: ll[0] });
      ll.slice(1).forEach((h, k) => out.push({ name: `Obstacle ${k + 1}`, type: 'slough', ring: h }));
    }
  }
  if (!out.length) throw new Error('No polygons found in the GeoJSON');
  return out;
}

function dropClose(r) {
  if (r.length > 1) {
    const a = r[0], b = r[r.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return r.slice(0, -1);
  }
  return r;
}

export { utmZoneFor };

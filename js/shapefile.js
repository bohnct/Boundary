// ESRI shapefile writer/reader (polygons + points) with a DBF attribute table.

import { signedAreaLL, utmZoneFor, toUTM, fromUTM, pointInRing } from './geo.js';

export const PRJ_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

export function prjNad83Utm(zone) {
  const cm = (zone - 1) * 6 - 180 + 3;
  return `PROJCS["NAD_1983_UTM_Zone_${zone}N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${cm.toFixed(1)}],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`;
}

// projection: { kind: 'wgs84' } | { kind: 'utm', zone }
export function makeTransform(projection) {
  if (projection.kind === 'utm') return ([lat, lng]) => toUTM(lat, lng, projection.zone);
  return ([lat, lng]) => [lng, lat];
}

export function prjFor(projection) {
  return projection.kind === 'utm' ? prjNad83Utm(projection.zone) : PRJ_WGS84;
}

export { utmZoneFor };

// Signed area in an x/y plane (> 0 = counter-clockwise).
function signedXY(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function closeRing(r) {
  const a = r[0], b = r[r.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? r : [...r, a];
}

// features: [{ rings: [[[lat,lng]...] outer, ...holes], attrs }]
// fields: [{ name, type: 'C'|'N', length, decimals }]
export function writePolygons(features, fields, projection) {
  const tf = makeTransform(projection);
  const shapes = features.map((f) => {
    const rings = f.rings.map((ring, idx) => {
      let xy = ring.map(tf);
      const ccw = signedXY(xy) > 0;
      // Shapefile rule: outer rings clockwise, holes counter-clockwise.
      if ((idx === 0 && ccw) || (idx > 0 && !ccw)) xy = xy.slice().reverse();
      return closeRing(xy);
    });
    return rings;
  });
  return writeShp(5, shapes, features.map((f) => f.attrs), fields);
}

// points: [{ ll: [lat,lng], attrs }]
export function writePoints(points, fields, projection) {
  const tf = makeTransform(projection);
  return writeShp(1, points.map((p) => tf(p.ll)), points.map((p) => p.attrs), fields);
}

function writeShp(type, shapes, attrs, fields) {
  const contents = shapes.map((s) => (type === 1 ? pointContent(s) : polyContent(s)));
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of shapes) {
    const pts = type === 1 ? [s] : s.flat();
    for (const [x, y] of pts) {
      bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y);
      bbox[2] = Math.max(bbox[2], x); bbox[3] = Math.max(bbox[3], y);
    }
  }
  if (!shapes.length) bbox.fill(0);
  const shpLen = 100 + contents.reduce((s, c) => s + 8 + c.byteLength, 0);
  const shp = new DataView(new ArrayBuffer(shpLen));
  const shx = new DataView(new ArrayBuffer(100 + 8 * contents.length));
  header(shp, shpLen, type, bbox);
  header(shx, shx.byteLength, type, bbox);
  let off = 100;
  contents.forEach((c, i) => {
    shx.setInt32(100 + i * 8, off / 2);
    shx.setInt32(104 + i * 8, c.byteLength / 2);
    shp.setInt32(off, i + 1);
    shp.setInt32(off + 4, c.byteLength / 2);
    new Uint8Array(shp.buffer).set(new Uint8Array(c), off + 8);
    off += 8 + c.byteLength;
  });
  return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer), dbf: writeDbf(fields, attrs) };
}

function header(dv, len, type, bbox) {
  dv.setInt32(0, 9994);
  dv.setInt32(24, len / 2);
  dv.setInt32(28, 1000, true);
  dv.setInt32(32, type, true);
  bbox.forEach((v, i) => dv.setFloat64(36 + i * 8, v, true));
}

function pointContent([x, y]) {
  const dv = new DataView(new ArrayBuffer(20));
  dv.setInt32(0, 1, true);
  dv.setFloat64(4, x, true);
  dv.setFloat64(12, y, true);
  return dv.buffer;
}

function polyContent(rings) {
  const pts = rings.flat();
  const dv = new DataView(new ArrayBuffer(44 + 4 * rings.length + 16 * pts.length));
  dv.setInt32(0, 5, true);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => dv.setFloat64(4 + i * 8, v, true));
  dv.setInt32(36, rings.length, true);
  dv.setInt32(40, pts.length, true);
  let start = 0;
  rings.forEach((r, i) => { dv.setInt32(44 + i * 4, start, true); start += r.length; });
  let o = 44 + 4 * rings.length;
  for (const [x, y] of pts) { dv.setFloat64(o, x, true); dv.setFloat64(o + 8, y, true); o += 16; }
  return dv.buffer;
}

const enc = new TextEncoder();

function writeDbf(fields, rows) {
  const recLen = 1 + fields.reduce((s, f) => s + f.length, 0);
  const headLen = 32 + 32 * fields.length + 1;
  const buf = new Uint8Array(headLen + recLen * rows.length + 1);
  const dv = new DataView(buf.buffer);
  const d = new Date();
  buf[0] = 0x03;
  buf[1] = d.getFullYear() - 1900; buf[2] = d.getMonth() + 1; buf[3] = d.getDate();
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, headLen, true);
  dv.setUint16(10, recLen, true);
  fields.forEach((f, i) => {
    const o = 32 + i * 32;
    buf.set(enc.encode(f.name.slice(0, 10)), o);
    buf[o + 11] = f.type.charCodeAt(0);
    buf[o + 16] = f.length;
    buf[o + 17] = f.decimals || 0;
  });
  buf[headLen - 1] = 0x0d;
  rows.forEach((row, r) => {
    let o = headLen + r * recLen;
    buf[o++] = 0x20;
    for (const f of fields) {
      const v = row[f.name];
      let s;
      if (f.type === 'N') {
        s = v == null || v === '' || Number.isNaN(Number(v)) ? '' : Number(v).toFixed(f.decimals || 0);
        s = s.slice(0, f.length).padStart(f.length, ' ');
        buf.set(enc.encode(s), o);
      } else {
        let bytes = enc.encode(String(v ?? ''));
        if (bytes.length > f.length) bytes = truncUtf8(String(v), f.length);
        buf.fill(0x20, o, o + f.length);
        buf.set(bytes, o);
      }
      o += f.length;
    }
  });
  buf[buf.length - 1] = 0x1a;
  return buf;
}

function truncUtf8(s, max) {
  let out = '';
  for (const ch of s) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return enc.encode(out);
}

// ---------- reading ----------
export function readDbf(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(4, true), headLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
  const dec = new TextDecoder();
  const fields = [];
  for (let o = 32; o < headLen - 1 && u8[o] !== 0x0d; o += 32) {
    const name = dec.decode(u8.subarray(o, o + 11)).replace(/\0.*$/s, '').trim();
    fields.push({ name, type: String.fromCharCode(u8[o + 11]), length: u8[o + 16] });
  }
  const rows = [];
  for (let r = 0; r < n; r++) {
    let o = headLen + r * recLen + 1;
    const row = {};
    for (const f of fields) {
      const s = dec.decode(u8.subarray(o, o + f.length)).trim();
      row[f.name] = f.type === 'N' || f.type === 'F' ? (s === '' ? null : Number(s)) : s;
      o += f.length;
    }
    rows.push(row);
  }
  return rows;
}

// Returns [{ outer: [[lat,lng]], holes: [[[lat,lng]]], attrs }]
export function readPolygons(shpU8, dbfU8, prjText = '') {
  const dv = new DataView(shpU8.buffer, shpU8.byteOffset, shpU8.byteLength);
  const fileLen = dv.getInt32(24) * 2;
  const utm = prjText.match(/UTM[_ ]?Zone[_ ]?(\d{1,2})\s*([NS])?/i);
  const isProjected = /PROJCS/i.test(prjText);
  if (isProjected && !utm) throw new Error('This shapefile uses a projection the app cannot read yet. Re-save it in WGS 84 or UTM.');
  const toLL = utm
    ? ([x, y]) => fromUTM(x, y, Number(utm[1]), (utm[2] || 'N').toUpperCase() === 'S')
    : ([x, y]) => [y, x];
  const attrs = dbfU8 ? readDbf(dbfU8) : [];
  const out = [];
  let o = 100, rec = 0;
  while (o + 8 <= fileLen) {
    const len = dv.getInt32(o + 4) * 2;
    const c = o + 8;
    const type = dv.getInt32(c, true);
    if ([5, 15, 25].includes(type)) {
      const nParts = dv.getInt32(c + 36, true), nPts = dv.getInt32(c + 40, true);
      const parts = [];
      for (let i = 0; i < nParts; i++) parts.push(dv.getInt32(c + 44 + i * 4, true));
      const p0 = c + 44 + nParts * 4;
      const rings = parts.map((s, i) => {
        const e = i + 1 < nParts ? parts[i + 1] : nPts;
        const ring = [];
        for (let k = s; k < e; k++) ring.push(toLL([dv.getFloat64(p0 + k * 16, true), dv.getFloat64(p0 + k * 16 + 8, true)]));
        if (ring.length > 1) {
          const a = ring[0], b = ring[ring.length - 1];
          if (a[0] === b[0] && a[1] === b[1]) ring.pop();
        }
        return ring;
      });
      // Clockwise (negative signed area) = outer ring.
      const outers = [], holes = [];
      for (const r of rings) (signedAreaLL(r) < 0 ? outers : holes).push(r);
      if (!outers.length && holes.length) outers.push(holes.shift());
      const polys = outers.map((outer) => ({ outer, holes: [], attrs: attrs[rec] || {} }));
      for (const h of holes) {
        const host = polys.find((p) => pointInRing(h[0], p.outer)) || polys[0];
        host.holes.push(h);
      }
      out.push(...polys);
    }
    o = c + len;
    rec++;
  }
  return out;
}

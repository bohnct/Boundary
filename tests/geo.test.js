// Run: node tests/geo.test.js  (writes test output files to tests/out/)
// Also runs in a browser (import it from a page served from this folder); files are skipped there.
const fs = typeof process !== 'undefined' && process.versions?.node ? await import('node:fs') : null;
fs?.mkdirSync('tests/out', { recursive: true });
const writeFileSync = (path, data) => fs?.writeFileSync(path, data);
import { makeProjector, acres, buildBoundary, splitRing, toUTM, fromUTM } from '../js/geo.js';
import { buildShapefileZip, buildGeoJson, buildKml, computeAreas, exportFeatures } from '../js/formats.js';
import { readZip } from '../js/zip.js';
import { readPolygons } from '../js/shapefile.js';

let fails = 0;
const check = (label, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${info}`); if (!ok) fails++; };

const lat0 = 50.45, lng0 = -104.6;
const P = makeProjector(lat0, lng0);
const side = 804.672; // half a mile
const square = [[0, 0], [0, side], [side, side], [side, 0]].map(P.toLL);
check('quarter section ≈ 160 ac', Math.abs(acres(square) - 160) < 0.05, acres(square).toFixed(3));

// Simulated drive: clockwise around a rounded rectangle 30 m inside the edge, 1 Hz at 40 km/h.
function simDrive(inset, r, speedKmh) {
  const v = speedKmh / 3.6, s = side - 2 * inset;
  const path = [];
  // Build a dense clockwise path starting on the west edge heading north.
  const seg = (x0, y0, x1, y1) => { const L = Math.hypot(x1 - x0, y1 - y0); const n = Math.ceil(L / 0.1); for (let i = 0; i < n; i++) path.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); };
  const arc = (cx, cy, a0, a1) => { const n = 200; for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * i / n; path.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  const a = inset, b = inset + s;
  seg(a, a + r, a, b - r); arc(a + r, b - r, Math.PI, Math.PI / 2);
  seg(a + r, b, b - r, b); arc(b - r, b - r, Math.PI / 2, 0);
  seg(b, b - r, b, a + r); arc(b - r, a + r, 0, -Math.PI / 2);
  seg(b - r, a, a + r, a); arc(a + r, a + r, -Math.PI / 2, -Math.PI);
  path.push(path[0]);
  // Resample at 1 Hz along arc length; continue a little past the start (overshoot).
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const total = cum[cum.length - 1];
  const fixes = [];
  let k = 0;
  for (let d = 0; d <= total + 2 * v; d += v) {
    const dd = d % total;
    while (cum[k + 1] < dd) k = (k + 1) % (path.length - 1);
    if (cum[k] > dd) k = 0;
    while (cum[k + 1] < dd) k++;
    const p = path[k], q = path[k + 1];
    const hdg = (Math.atan2(q[0] - p[0], q[1] - p[1]) * 180 / Math.PI + 360) % 360;
    const ll = P.toLL(p);
    fixes.push({ lat: ll[0], lng: ll[1], t: fixes.length * 1000, speed: v, heading: hdg });
  }
  return fixes;
}

for (const kmh of [20, 40, 60]) {
  const inset = 30, r = 12;
  const fixes = simDrive(inset, r, kmh);
  const { line } = buildBoundary(fixes, { offsetM: inset, side: 'left', closed: true });
  const R = r + inset;
  const expected = (side * side - (4 - Math.PI) * R * R) / 4046.8564224;
  const got = acres(line);
  check(`drive ${kmh} km/h, 30 m offset: area within 0.5%`, Math.abs(got - expected) / expected < 0.005, `got ${got.toFixed(2)} expected ${expected.toFixed(2)} (${line.length} pts, ${fixes.length} fixes)`);
  // Unsmoothed straight-segment polygon of the raw fixes, offset only, for comparison.
  const raw = buildBoundary(fixes.map((f) => ({ ...f, heading: null })), { offsetM: inset, side: 'left', closed: true, spacingM: 1e9 });
  console.log(`      raw-chords area ${acres(raw.line).toFixed(2)} ac`);
}

// Lag while driving: the open line should stop before the last fix.
{
  const fixes = simDrive(30, 12, 40).slice(0, 20);
  const { line } = buildBoundary(fixes, { offsetM: 0, side: 'off', closed: false });
  const end = P.toXY(line[line.length - 1]), lastFix = P.toXY([fixes[19].lat, fixes[19].lng]), prev = P.toXY([fixes[18].lat, fixes[18].lng]);
  check('open line lags one fix', Math.hypot(end[0] - prev[0], end[1] - prev[1]) < 0.5 && Math.hypot(end[0] - lastFix[0], end[1] - lastFix[1]) > 5);
}

// Split
{
  const parts = splitRing(square, P.toLL([side / 2, -10]), P.toLL([side / 2, side + 10]));
  check('split quarter into two 80 ac halves', parts && Math.abs(acres(parts[0]) - 80) < 0.05 && Math.abs(acres(parts[1]) - 80) < 0.05, parts ? `${acres(parts[0]).toFixed(2)} / ${acres(parts[1]).toFixed(2)}` : 'null');
}

// UTM round trip
{
  const [x, y] = toUTM(50.45, -104.6, 13);
  const [la, lo] = fromUTM(x, y, 13);
  check('UTM round trip < 1 mm', Math.abs(la - 50.45) < 1e-8 && Math.abs(lo + 104.6) < 1e-8, `${x.toFixed(3)}, ${y.toFixed(3)}`);
  writeFileSync('tests/out/utm_point.txt', `${x} ${y}`);
}

// Export a project with a slough hole
const slough = [[200, 200], [200, 300], [300, 300], [300, 200]].map(P.toLL); // 1 ha
const project = { id: 't', name: 'Home Quarter', year: 2026, boundaries: [
  { id: 'f', name: 'Field', type: 'field', ring: square },
  { id: 's', name: 'Slough 1', type: 'slough', ring: slough },
] };
const a = computeAreas(project);
check('net = gross - slough', Math.abs(a.net - (160 - 10000 / 4046.8564224)) < 0.05, `${a.net.toFixed(3)}`);
check('exported TYPE is field/obstacle', exportFeatures(project, 'separate').map((f) => f.attrs.TYPE).join() === 'field,obstacle');
for (const [mode, kind] of [['cutout', 'wgs84'], ['separate', 'utm']]) {
  const z = buildShapefileZip(project, { mode, points: true, projection: kind === 'utm' ? { kind, zone: 13 } : { kind } });
  writeFileSync(`tests/out/${mode}_${kind}.zip`, z.data);
  const files = await readZip(z.data);
  const shp = Object.keys(files).find((n) => n.endsWith('.shp') && !n.includes('_points'));
  const polys = readPolygons(files[shp], files[shp.replace('.shp', '.dbf')], new TextDecoder().decode(files[shp.replace('.shp', '.prj')]));
  const outer = polys[0].outer;
  check(`${mode}/${kind}: round-trip import`, polys.length === (mode === 'cutout' ? 1 : 2) && Math.abs(acres(outer) - 160) < 0.05 && (mode !== 'cutout' || polys[0].holes.length === 1)
    && (mode !== 'separate' || polys[1].attrs.TYPE === 'obstacle'), `${polys.length} polys, ${acres(outer).toFixed(3)} ac`);
}
writeFileSync('tests/out/project.geojson', buildGeoJson(project, 'cutout').data);
writeFileSync('tests/out/project.kml', buildKml(project, 'cutout').data);
console.log(fails ? `${fails} FAILED` : 'all passed');
if (fs) process.exitCode = fails ? 1 : 0;

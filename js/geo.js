// Geometry helpers. Points are [lat, lng] in WGS84 unless noted.
// Local work is done in a flat x/y (metres east/north) around an origin,
// which is accurate to well under a centimetre per metre at field scale.

export const SQM_PER_ACRE = 4046.8564224;
const D2R = Math.PI / 180;
const WGS_A = 6378137, WGS_E2 = 0.00669437999014;

// Radii of curvature of the WGS84 ellipsoid at a latitude: [meridian M, prime vertical N].
function radii(lat) {
  const s2 = Math.sin(lat * D2R) ** 2;
  const w = 1 - WGS_E2 * s2;
  return [WGS_A * (1 - WGS_E2) / w ** 1.5, WGS_A / Math.sqrt(w)];
}

// ---------- local projection ----------
export function makeProjector(lat0, lng0) {
  const [M, N] = radii(lat0);
  const kx = Math.cos(lat0 * D2R) * N * D2R;
  const ky = M * D2R;
  return {
    toXY: ([lat, lng]) => [(lng - lng0) * kx, (lat - lat0) * ky],
    toLL: ([x, y]) => [lat0 + y / ky, lng0 + x / kx],
  };
}

export function distanceM(a, b) {
  const p = makeProjector(a[0], a[1]);
  const [x, y] = p.toXY(b);
  return Math.hypot(x, y);
}

// ---------- area ----------
// Ring area on the WGS84 ellipsoid, metres². Uses a local sinusoidal (equal-area)
// projection centred on the ring, which is exact to a few ppm at field scale.
export function ringAreaSqM(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let lat0 = 0, lng0 = 0;
  for (const p of ring) { lat0 += p[0]; lng0 += p[1]; }
  lat0 /= n; lng0 /= n;
  const [M] = radii(lat0);
  const xy = ring.map(([lat, lng]) => {
    const [, N] = radii(lat);
    return [(lng - lng0) * D2R * N * Math.cos(lat * D2R), (lat - lat0) * D2R * M];
  });
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

export const acres = (ring) => ringAreaSqM(ring) / SQM_PER_ACRE;

// Signed area in lng/lat plane: > 0 means counter-clockwise.
export function signedAreaLL(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [y1, x1] = ring[i];
    const [y2, x2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function centroid(ring) {
  let lat = 0, lng = 0;
  for (const p of ring) { lat += p[0]; lng += p[1]; }
  return [lat / ring.length, lng / ring.length];
}

export function pointInRing(pt, ring) {
  const [py, px] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- simplification (Douglas-Peucker on x/y) ----------
export function simplifyXY(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segDist2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

// ---------- segment intersection ----------
function segIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { t, u, pt: [p1[0] + t * d1x, p1[1] + t * d1y] };
}

// Remove small self-intersection loops that an offset curve makes on the
// inside of tight turns. Looks ahead a limited window so it stays fast.
export function removeLoops(pts, windowSize = 400) {
  const out = pts.slice();
  for (let i = 0; i < out.length - 3; i++) {
    const lim = Math.min(out.length - 1, i + windowSize);
    for (let j = lim - 1; j > i + 1; j--) {
      const hit = segIntersect(out[i], out[i + 1], out[j], out[j + 1]);
      if (hit) {
        out.splice(i + 1, j - i, hit.pt);
        break;
      }
    }
  }
  return out;
}

// ---------- GPS track smoothing + offset ----------
// fixes: [{lat, lng, t (ms), speed (m/s|null), heading (deg|null)}]
// opts: { offsetM, side: 'left'|'right'|'off', closed, spacingM, simplifyM }
// Returns { line: [[lat,lng]...] } — the smoothed, offset boundary.
// When !closed, the last fix is held back (lag) because the curve into a fix
// needs the direction you leave it in.
export function buildBoundary(fixes, opts = {}) {
  const { offsetM = 0, side = 'left', closed = false, spacingM = 1.5, simplifyM = 0.5 } = opts;
  const pts = dedupe(fixes, 0.75);
  if (pts.length < 2) return { line: pts.map((f) => [f.lat, f.lng]) };
  const proj = makeProjector(pts[0].lat, pts[0].lng);
  const P = pts.map((f) => {
    const [x, y] = proj.toXY([f.lat, f.lng]);
    return { x, y, speed: f.speed, heading: f.heading };
  });
  const n = P.length;
  const last = closed ? n - 1 : n - 2; // lag one fix while driving
  if (last < 1) return { line: [] };

  const dirs = P.map((p, k) => tangentDir(P, k));
  const samples = [[P[0].x, P[0].y]];
  for (let i = 0; i < last; i++) {
    const a = P[i], b = P[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(L / spacingM));
    if (L > 150) { // GPS dropout: don't invent a curve over a long gap
      samples.push([b.x, b.y]);
      continue;
    }
    const m0 = [dirs[i][0] * L, dirs[i][1] * L];
    const m1 = [dirs[i + 1][0] * L, dirs[i + 1][1] * L];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      samples.push([
        h00 * a.x + h10 * m0[0] + h01 * b.x + h11 * m1[0],
        h00 * a.y + h10 * m0[1] + h01 * b.y + h11 * m1[1],
      ]);
    }
  }

  let line = side === 'off' || !offsetM ? samples : offsetLine(samples, side === 'left' ? offsetM : -offsetM);
  line = removeLoops(line);
  if (closed) line = trimClosure(line);
  line = simplifyXY(line, simplifyM);
  return { line: line.map((p) => proj.toLL(p)) };
}

function dedupe(fixes, minM) {
  const out = [];
  for (const f of fixes) {
    if (!out.length || distanceM([out[out.length - 1].lat, out[out.length - 1].lng], [f.lat, f.lng]) >= minM) out.push(f);
  }
  return out;
}

// Direction at fix k: GPS course when moving and it agrees with the track,
// otherwise the chord through the neighbouring fixes.
function tangentDir(P, k) {
  const prev = P[Math.max(0, k - 1)], next = P[Math.min(P.length - 1, k + 1)];
  let cx = next.x - prev.x, cy = next.y - prev.y;
  const cl = Math.hypot(cx, cy) || 1;
  cx /= cl; cy /= cl;
  const p = P[k];
  if (p.heading != null && !Number.isNaN(p.heading) && p.speed != null && p.speed > 1.5) {
    const hx = Math.sin(p.heading * D2R), hy = Math.cos(p.heading * D2R);
    if (hx * cx + hy * cy > 0.5) return [hx, hy]; // within ~60° of the track
  }
  return [cx, cy];
}

// Positive d = left of travel direction.
export function offsetLine(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    out.push([pts[i][0] - dy * d, pts[i][1] + dx * d]);
  }
  return out;
}

// If the drive overshoots the start, cut the ring where the end crosses the beginning.
function trimClosure(pts) {
  const n = pts.length;
  if (n < 8) return pts;
  const head = Math.floor(n * 0.25), tailStart = Math.floor(n * 0.75);
  for (let j = n - 2; j >= tailStart; j--) {
    for (let i = 0; i < head; i++) {
      const hit = segIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1]);
      if (hit) return [hit.pt, ...pts.slice(i + 1, j + 1)];
    }
  }
  return pts;
}

// ---------- split a ring by an infinite line through a and b ----------
export function splitRing(ring, a, b) {
  const proj = makeProjector(a[0], a[1]);
  const R2 = ring.map(proj.toXY);
  const A = proj.toXY(a), B = proj.toXY(b);
  const side = (p) => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
  const clip = (sign) => {
    const out = [];
    for (let i = 0; i < R2.length; i++) {
      const cur = R2[i], nxt = R2[(i + 1) % R2.length];
      const sc = side(cur) * sign, sn = side(nxt) * sign;
      if (sc >= 0) out.push(cur);
      if ((sc >= 0) !== (sn >= 0)) {
        const t = sc / (sc - sn);
        out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
      }
    }
    return out;
  };
  const left = clip(1), right = clip(-1);
  if (left.length < 3 || right.length < 3) return null;
  return [left.map(proj.toLL), right.map(proj.toLL)];
}

// ---------- Transverse Mercator (UTM) on GRS80 / NAD83 ----------
const A_GRS80 = 6378137, F_GRS80 = 1 / 298.257222101;
const K0 = 0.9996;

export function utmZoneFor(lng) {
  return Math.floor((lng + 180) / 6) + 1;
}

export function toUTM(lat, lng, zone) {
  const e2 = F_GRS80 * (2 - F_GRS80), ep2 = e2 / (1 - e2);
  const phi = lat * D2R, lam = lng * D2R, lam0 = ((zone - 1) * 6 - 180 + 3) * D2R;
  const N = A_GRS80 / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
  const M = meridianArc(phi, e2);
  const x = K0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let y = K0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) y += 10000000;
  return [x, y];
}

export function fromUTM(x, y, zone, south = false) {
  const e2 = F_GRS80 * (2 - F_GRS80), ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const lam0 = ((zone - 1) * 6 - 180 + 3) * D2R;
  const M = (south ? y - 10000000 : y) / K0;
  const mu = M / (A_GRS80 * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const N1 = A_GRS80 / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const T1 = Math.tan(phi1) ** 2, C1 = ep2 * Math.cos(phi1) ** 2;
  const R1 = A_GRS80 * (1 - e2) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = (x - 500000) / (N1 * K0);
  const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lng = lam0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(phi1);
  return [lat / D2R, lng / D2R];
}

function meridianArc(phi, e2) {
  return A_GRS80 * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
}

// GPS simulator for testing on a laptop: open the app with ?sim or ?sim=fast.
// Drives clockwise around a rounded 700 m square centred where the map is,
// at 40 km/h, one fix per second (fast mode plays it 10x quicker).

import { makeProjector } from './geo.js';

export function startSimulator(map, mode) {
  const fast = mode === 'fast';
  let path = null, cum = null, total = 0, proj = null;
  let dist = 0, t0 = Date.now();
  const speed = 40 / 3.6;
  const watchers = new Map();
  let nextId = 1;

  function build() {
    const c = map.getCenter();
    proj = makeProjector(c.lat, c.lng);
    const h = 350, r = 12;
    const pts = [];
    const seg = (x0, y0, x1, y1) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5); for (let i = 0; i < n; i++) pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); };
    const arc = (cx, cy, a0, a1) => { for (let i = 0; i < 60; i++) { const a = a0 + (a1 - a0) * i / 60; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
    seg(-h, -h + r, -h, h - r); arc(-h + r, h - r, Math.PI, Math.PI / 2);
    seg(-h + r, h, h - r, h); arc(h - r, h - r, Math.PI / 2, 0);
    seg(h, h - r, h, -h + r); arc(h - r, -h + r, 0, -Math.PI / 2);
    seg(h - r, -h, -h + r, -h); arc(-h + r, -h + r, -Math.PI / 2, -Math.PI);
    pts.push(pts[0]);
    path = pts;
    cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    total = cum[cum.length - 1];
  }

  function position() {
    if (!path) build();
    const d = dist % total;
    let k = 0;
    while (cum[k + 1] < d) k++;
    const a = path[k], b = path[k + 1];
    const f = (d - cum[k]) / (cum[k + 1] - cum[k] || 1);
    const x = a[0] + (b[0] - a[0]) * f + (Math.random() - 0.5) * 0.8;
    const y = a[1] + (b[1] - a[1]) * f + (Math.random() - 0.5) * 0.8;
    const heading = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
    const [lat, lng] = proj.toLL([x, y]);
    return { coords: { latitude: lat, longitude: lng, accuracy: 2.5, speed, heading }, timestamp: t0 + (dist / speed) * 1000 };
  }

  return {
    getCurrentPosition(ok) { setTimeout(() => ok(position()), 200); },
    watchPosition(ok) {
      const id = nextId++;
      const tick = () => { dist += speed; ok(position()); };
      ok(position());
      watchers.set(id, setInterval(tick, fast ? 100 : 1000));
      return id;
    },
    clearWatch(id) { clearInterval(watchers.get(id)); watchers.delete(id); },
  };
}

// App shell is cached for offline use; map tiles are cached as you view them.
const VERSION = 'v4';
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles-v2'; // v1 held opaque tiles, which CORS tile requests can't use
const MAX_TILES = 3000;
const NET_TIMEOUT_MS = 3000;
const FILES = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'js/app.js', 'js/geo.js', 'js/formats.js', 'js/shapefile.js', 'js/zip.js', 'js/sim.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

let tilePuts = 0;
async function trimTiles(c) {
  const keys = await c.keys(); // oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await c.delete(k);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (/arcgisonline\.com$/.test(url.host)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone()).then(() => { if (++tilePuts % 100 === 0) trimTiles(c); });
        return res;
      } catch { return Response.error(); }
    }));
    return;
  }
  if (url.origin === location.origin) {
    // Network first so updates arrive, but use the cache after a few seconds:
    // out in a field the signal is often too weak to load anything.
    const net = fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
      }
      return res;
    });
    net.catch(() => {});
    const timeout = new Promise((_, reject) => setTimeout(reject, NET_TIMEOUT_MS));
    e.respondWith(Promise.race([net, timeout]).catch(async () => (await caches.match(e.request))
      || net.catch(() => caches.match('index.html'))));
  }
});

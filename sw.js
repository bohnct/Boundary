// App shell is cached for offline use; map tiles are cached as you view them.
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles-v1';
const FILES = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'js/app.js', 'js/geo.js', 'js/formats.js', 'js/shapefile.js', 'js/zip.js', 'js/sim.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (/arcgisonline\.com|tile\.openstreetmap\.org/.test(url.host)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
        return res;
      } catch { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin === location.origin) {
    // Network first so updates arrive; fall back to cache offline.
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
  }
});

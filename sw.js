// Offline support: the app itself is cached; map tiles and road data always come from the network.
const VERSION = 'sl-v28';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/analysis.js', 'js/charts.js', 'js/compare.js', 'js/directions.js', 'js/export.js', 'js/guide.js', 'js/turns.js', 'js/livemap.js', 'js/plan.js', 'js/basemap.js', 'js/map3d.js', 'js/planmap.js',
  'js/limits.js', 'js/recorder.js', 'js/sample.js', 'js/share.js', 'js/store.js',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-192.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // network first so updates arrive straight away, cache when offline
  e.respondWith(
    // always check with the server (GitHub Pages lets browsers cache files for 10 minutes otherwise)
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});

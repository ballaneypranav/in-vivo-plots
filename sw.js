// Offline support: cache the app shell, serve from cache, refresh the cache in the background.
// Paths are relative so the app works under /in-vivo-plots/ on GitHub Pages.
// Bump CACHE when the shell file list changes.
const CACHE = 'in-vivo-plots-v4';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'vendor/chart.umd.min.js',
  'vendor/xlsx.mini.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'demo/synthetic-demo.xlsx',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('in-vivo-plots-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(fresh); return cached; }
    return (await fresh) || (req.mode === 'navigate' && (await cache.match('./'))) || Response.error();
  }));
});

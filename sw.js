// Offline support: cache the app shell; serve from the network, falling back to the cache.
// Paths are relative so the app works under /in-vivo-plots/ on GitHub Pages.
// Bump CACHE when the shell file list changes.
const CACHE = 'in-vivo-plots-v5';
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

// Network first, so a new version shows on the first visit after it is pushed; the cache when offline, or when
// the network takes longer than 3 s (the response still refreshes the cache for next time).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const fresh = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    event.waitUntil(fresh);
    const slow = new Promise(resolve => setTimeout(() => resolve('slow'), 3000));
    const first = await Promise.race([fresh, slow]);
    if (first && first !== 'slow') return first;
    const cached = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await cache.match('./')));
    if (cached) return cached;
    return (await fresh) || Response.error();
  }));
});

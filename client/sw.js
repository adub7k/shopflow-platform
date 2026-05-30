const CACHE = 'shopflow-v1';
const STATIC = [
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/css/app.css',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Never intercept API calls
  if (e.request.url.includes('/api/')) return;
  // Network-first for HTML pages so updates land immediately
  if (e.request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Cache-first for static assets
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

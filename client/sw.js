// Web-push + notification-click handlers (kept as a drop-in module).
importScripts('/sw-push.js');

const CACHE = 'shopflow-v5';
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
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok && e.request.method === 'GET') {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request).then(r =>
            r || new Response(
              '<!DOCTYPE html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title><body style="font-family:sans-serif;text-align:center;padding:4rem 1rem"><h2>You\'re offline</h2><p>Check your connection and try again.</p></body>',
              { status: 503, headers: { 'Content-Type': 'text/html' } }
            )
          )
        )
    );
    return;
  }
  // Network-first for CODE (JS/CSS). Cache-first here kept phones running
  // weeks-old bundles after every deploy — fixes "never landed" on installed
  // PWAs. The cache is only the offline fallback now.
  const isCode = e.request.destination === 'script' || e.request.destination === 'style'
    || e.request.url.includes('/js/') || e.request.url.includes('/css/');
  if (isCode) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok && e.request.method === 'GET') {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || new Response('', { status: 504 })))
    );
    return;
  }
  // Cache-first only for images/icons (safe to be stale).
  e.respondWith(
    caches.match(e.request).then(r =>
      r || fetch(e.request).catch(() => new Response('', { status: 504 }))
    )
  );
});

const CACHE = 'woods-test-v1';
const ASSETS = ['/', '/index.html', '/css/app.css', '/js/api.js', '/js/utils.js', '/js/app.js',
  '/js/dashboard.js', '/js/leads.js', '/js/jobs.js', '/js/customers.js', '/js/appointments.js',
  '/js/invoices.js', '/js/fleet.js', '/js/followups.js', '/js/revenue.js', '/js/settings.js'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

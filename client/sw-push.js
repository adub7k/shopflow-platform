/**
 * Service worker push handlers — merge into the ShopFlow PWA's existing
 * service worker (or importScripts this file from it).
 */

self.addEventListener('push', (event) => {
  let data = { title: 'ShopFlow', body: 'New activity', url: '/' };
  try { data = { ...data, ...event.data.json() }; } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',      // existing PWA home-screen icon
      badge: '/icons/badge-72.png',     // small monochrome Android badge (add one)
      tag: data.tag || 'shopflow',      // same-tag notifications collapse
      renotify: true,                   // ...but still buzz on updates
      data: { url: data.url },
      vibrate: [100, 50, 100],
    })
  );
});

// Tap → open (or focus) the PWA at the deep link, e.g. the Response Center
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});

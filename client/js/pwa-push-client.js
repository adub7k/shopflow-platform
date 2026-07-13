/**
 * Client-side subscribe — drop into the ShopFlow PWA (settings page or
 * first login). Call enablePushNotifications(tenantId, userName) from an
 * "Enable notifications" button — MUST be a user gesture, browsers block
 * permission prompts otherwise.
 */

async function enablePushNotifications(tenantId, userName) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Notifications need the installed app. Add ShopFlow to your home screen first.');
    return false;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const reg = await navigator.serviceWorker.ready;

  // /api/push/* is mounted behind the app's JWT auth (server/index.js).
  const authHeaders = (typeof Auth !== 'undefined' && Auth.getToken())
    ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {};

  const { key } = await fetch('/api/push/vapid-public-key', { headers: authHeaders }).then((r) => r.json());

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      tenant_id: tenantId,
      user: userName,
      subscription: subscription.toJSON(),
    }),
  });
  return res.ok;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

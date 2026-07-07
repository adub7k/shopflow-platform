/**
 * ShopFlow — Web Push notifications
 * -----------------------------------
 * Real phone notifications for shop owners via the ShopFlow PWA.
 * Free (no Twilio cost), no A2P 10DLC involvement, works on locked phones.
 *
 * Setup (once):
 *   npm install web-push
 *   npx web-push generate-vapid-keys
 *   → put in env:
 *       VAPID_PUBLIC_KEY=...
 *       VAPID_PRIVATE_KEY=...
 *       VAPID_SUBJECT=mailto:aidan@shopflowtech.com
 *
 * Mount in server.js:
 *   const createPush = require('./routes/push');
 *   const push = createPush({ getShopDb });
 *   app.use('/api/push', requireAuth, push.router); // staff-only endpoints
 *
 *   // then hand push.sendPush to the leads router + automations:
 *   websiteLeads({ ..., sendPush: push.sendPush })
 *   createAutomations({ ..., sendPush: push.sendPush })
 *
 * PWA side: see pwa-push-client.js + sw-push.js in this folder.
 */

const express = require('express');
const webpush = require('web-push');

module.exports = function createPush({ getShopDb }) {
  const configured =
    !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;

  if (configured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@shopflowtech.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } else {
    console.warn('[push] VAPID keys not set — push disabled');
  }

  const router = express.Router();
  router.use(express.json());

  /* ---------- client fetches the public key to subscribe ---------- */
  router.get('/vapid-public-key', (req, res) => {
    if (!configured) return res.status(503).json({ error: 'Push not configured' });
    res.json({ key: process.env.VAPID_PUBLIC_KEY });
  });

  /* ---------- store a device subscription for a tenant's staff ----------
   * body: { tenant_id, user, subscription }  (subscription = PushSubscription.toJSON())
   * One user can have several devices; each is stored separately.
   */
  router.post('/subscribe', async (req, res) => {
    const { tenant_id, user, subscription } = req.body || {};
    if (!subscription?.endpoint)
      return res.status(422).json({ error: 'Missing subscription' });
    const db = await getShopDb(tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });

    db.data.push_subscriptions ||= [];
    // De-dupe by endpoint (re-subscribing same device just refreshes it)
    db.data.push_subscriptions = db.data.push_subscriptions.filter(
      (s) => s.subscription.endpoint !== subscription.endpoint
    );
    db.data.push_subscriptions.push({
      user: String(user || 'owner').slice(0, 100),
      subscription,
      created_at: new Date().toISOString(),
    });
    await db.write();
    res.status(201).json({ ok: true, devices: db.data.push_subscriptions.length });
  });

  router.post('/unsubscribe', async (req, res) => {
    const { tenant_id, endpoint } = req.body || {};
    const db = await getShopDb(tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    const before = (db.data.push_subscriptions || []).length;
    db.data.push_subscriptions = (db.data.push_subscriptions || []).filter(
      (s) => s.subscription.endpoint !== endpoint
    );
    await db.write();
    res.json({ ok: true, removed: before - db.data.push_subscriptions.length });
  });

  /* ---------- "test my notifications" button in settings ---------- */
  router.post('/test', async (req, res) => {
    const result = await sendPush(req.body.tenant_id, {
      title: 'ShopFlow',
      body: '🔔 Test notification — you\'re all set. New leads will hit this phone instantly.',
      url: '/response-center',
    });
    res.json(result);
  });

  /* ---------- the send function everything else uses ----------
   * sendPush(tenantId, { title, body, url, tag })
   * Sends to every registered device for the tenant. Dead subscriptions
   * (410/404 = user cleared data or revoked) are pruned automatically.
   */
  async function sendPush(tenantId, { title, body, url = '/', tag }) {
    if (!configured) return { ok: false, error: 'not configured' };
    const db = await getShopDb(tenantId);
    if (!db) return { ok: false, error: 'unknown tenant' };

    const subs = db.data.push_subscriptions || [];
    if (!subs.length) return { ok: true, sent: 0 };

    const payload = JSON.stringify({ title, body, url, tag: tag || 'shopflow' });
    let sent = 0;
    const dead = [];

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(s.subscription, payload, { TTL: 3600 });
          sent++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            dead.push(s.subscription.endpoint); // device gone — prune
          } else {
            console.error('[push] send failed:', err.statusCode || err.message);
          }
        }
      })
    );

    if (dead.length) {
      db.data.push_subscriptions = subs.filter(
        (s) => !dead.includes(s.subscription.endpoint)
      );
      await db.write();
    }
    return { ok: true, sent, pruned: dead.length };
  }

  return { router, sendPush };
};

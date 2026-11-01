// One browser, several shops: a CRM page for shop A must never show shop B.
//  - requireAuth refuses (421) a token for a different shop than the page's
//    X-Shop-Slug, accepts a matching one, and ignores a missing header
//    (portal, push client and older bundles don't send it).
//  - Push deep links carry the shop (/shop/<slug>/pipeline) so tapping an
//    alert opens the shop it's about.
// Run: node test/shop-sessions.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-sessions-' + process.pid);

const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
const sent = [];
webpush.sendNotification = async (sub, payload) => { sent.push(JSON.parse(payload)); };

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, JWT_SECRET } = require('../server/db');
const { requireAuth } = require('../server/middleware');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

master.get('shops').push({ id: 'shop_evo', shopName: 'Evo Test', slug: 'evo-test', active: true }).write();
master.get('shops').push({ id: 'shop_hps', shopName: 'HPS Test', slug: 'hps-test', active: true }).write();
const evoToken = jwt.sign({ shopId: 'shop_evo', accountId: 'a1', role: 'full' }, JWT_SECRET);

const app = express();
app.get('/api/shop/whoami', requireAuth, (req, res) => res.json({ shopId: req.shopId }));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (headers) => fetch(base + '/api/shop/whoami', { headers: { authorization: 'Bearer ' + evoToken, ...headers } })
    .then(async r => ({ status: r.status, body: await r.json() }));
  try {
    const wrong = await call({ 'x-shop-slug': 'hps-test' });
    eq('Evo token on the HPS page → 421 WRONG_SHOP', [wrong.status, wrong.body.code], [421, 'WRONG_SHOP']);
    const right = await call({ 'x-shop-slug': 'evo-test' });
    eq('Evo token on the Evo page → Evo data', [right.status, right.body.shopId], [200, 'shop_evo']);
    const none = await call({});
    eq('no page header (portal, push client) → unchanged', [none.status, none.body.shopId], [200, 'shop_evo']);

    // ── Push deep links ──────────────────────────────────────────────────────
    const push = require('../server/routes/push')({
      getShopDb: (id) => { const d = getShopDb(id); return { data: { push_subscriptions: d.get('push_subscriptions').value() || [] } }; },
    });
    getShopDb('shop_hps').set('push_subscriptions', [{ subscription: { endpoint: 'https://push.test/1' } }]).write();
    await push.sendPush('shop_hps', { title: 't', body: 'b', url: '/pipeline' });
    await push.sendPush('shop_hps', { title: 't', body: 'b' });
    await push.sendPush('shop_hps', { title: 't', body: 'b', url: '/shop/hps-test/leads' });
    eq('push links open under the shop', sent.map(p => p.url), ['/shop/hps-test/pipeline', '/shop/hps-test', '/shop/hps-test/leads']);
  } catch (e) {
    failures++;
    console.log('FAIL  threw', e);
  } finally {
    server.close();
    console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
});

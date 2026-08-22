// Integration test for native Meta Lead Ads ingestion (server/routes/meta-webhook.js).
// Run: node test/meta-webhook.test.js
//
// Exercises the REAL router against a throwaway shop in a temp DATA_DIR, mounted
// behind the same express.json verify hook index.js uses, with global fetch
// stubbed to stand in for the Graph API. Verifies (1) the GET verification
// handshake echoes the raw challenge and rejects a wrong token, (2) the POST
// signature check accepts a correctly-signed body and rejects a forged one,
// (3) field_data is mapped by NAME and survives the form's fields being
// reordered, (4) unknown fields are preserved rather than dropped, (5) Meta's
// re-delivery of the same leadgen_id does not create a second lead, and (6) a
// page_id belonging to no tenant is a logged no-op, not a throw.
const path = require('path');
const os = require('os');
const crypto = require('crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-meta-' + process.pid);
process.env.META_VERIFY_TOKEN = 'verify-me-please';
process.env.META_APP_SECRET = 'app-secret-abc123';
process.env.ADMIN_KEY = 'test-admin-key';

const express = require('express');
const { master, getShopDb } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shoptest_meta', PAGE_ID = '102938475600';
master.get('shops').push({
  id: shopId, accountId: 'acct_meta', shopName: 'Meta Test Detail', slug: 'meta-test',
  industry: 'detail', active: true, metaPageId: PAGE_ID, metaPageToken: 'PAGE-TOKEN-XYZ',
}).write();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'Meta Test Detail' }).write();
db.set('leads', []).write();
db.set('customers', []).write();

// ── Graph API stub ────────────────────────────────────────────────────────────
// Keyed by leadgen_id. Records the token each call was made with so we can prove
// the per-shop token (not the env fallback) was used.
const GRAPH = {};
const graphCalls = [];
const realFetch = global.fetch;   // the test's own HTTP client must not be stubbed
global.fetch = async (url, opts) => {
  const u = new URL(url);
  if (u.hostname !== 'graph.facebook.com') return realFetch(url, opts);
  const leadgenId = u.pathname.split('/').pop();
  graphCalls.push({ leadgenId, token: u.searchParams.get('access_token') });
  const body = GRAPH[leadgenId];
  if (!body) return { ok: false, status: 400, text: async () => '{"error":{"message":"no such lead"}}' };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

// The real Instant Form answers. Contact fields are deliberately NOT in a
// contact-first order, and the second lead below reverses them entirely — an
// index-based mapper would pass one of these and fail the other.
GRAPH['LEADGEN_1'] = {
  id: 'LEADGEN_1',
  created_time: '2026-08-20T15:04:05+0000',
  field_data: [
    { name: 'what_service_are_you_interested_in?', values: ['Ceramic tint'] },
    { name: 'email', values: ['angelo@example.com'] },
    { name: 'vehicle_year_make_model', values: ['2021 Toyota Tacoma'] },
    { name: 'full_name', values: ['Angelo Ramirez'] },
    { name: 'phone_number', values: ['+15055550142'] },
  ],
};
GRAPH['LEADGEN_2'] = {
  id: 'LEADGEN_2',
  field_data: [
    { name: 'phone_number', values: ['+15055559999'] },
    { name: 'first_name', values: ['Dana'] },
    { name: 'last_name', values: ['Cruz'] },
    { name: 'email', values: ['dana@example.com'] },
  ],
};

const app = express();
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.split('?')[0] === '/webhooks/meta') req.rawBody = buf;
  },
}));
app.use(require('../server/routes/meta-webhook'));
app.use(require('../server/routes/admin'));   // for the config-surface assertions below

const leadgenBody = (leadgenId, pageId) => JSON.stringify({
  object: 'page',
  entry: [{
    id: pageId, time: 1755700000,
    changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: pageId, form_id: 'FORM_88', ad_id: 'AD_77', created_time: 1755700000 } }],
  }],
});
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');

const leads = () => getShopDb(shopId).get('leads').value() || [];
// Processing is detached from the ACK by design, so poll rather than assume.
const waitFor = async (fn, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
};

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (qs) => fetch(`${base}/webhooks/meta?${qs}`);
  const post = (raw, sig) => fetch(`${base}/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) },
    body: raw,
  });

  try {
    // ── 1. Verification handshake ────────────────────────────────────────────
    const ok = await get('hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=1158201444');
    eq('handshake: correct token → 200', ok.status, 200);
    eq('handshake: echoes RAW challenge (no JSON wrapper)', await ok.text(), '1158201444');

    const bad = await get('hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=1158201444');
    eq('handshake: wrong token → 403', bad.status, 403);
    const none = await get('hub.mode=subscribe&hub.challenge=1158201444');
    eq('handshake: missing token → 403', none.status, 403);

    // ── 2. Signature enforcement ─────────────────────────────────────────────
    const raw1 = leadgenBody('LEADGEN_1', PAGE_ID);
    eq('POST: no signature header → 403', (await post(raw1)).status, 403);
    eq('POST: forged signature → 403', (await post(raw1, sign('different body'))).status, 403);
    eq('POST: signature over a DIFFERENT app secret → 403',
      (await post(raw1, 'sha256=' + crypto.createHmac('sha256', 'wrong-secret').update(raw1).digest('hex'))).status, 403);
    eq('no leads written by any rejected request', leads().length, 0);

    // ── 3. Happy path ────────────────────────────────────────────────────────
    eq('POST: valid signature → 200', (await post(raw1, sign(raw1))).status, 200);
    eq('lead was saved', await waitFor(() => leads().length === 1), true);

    const l1 = leads()[0];
    eq('name mapped from full_name', l1.name, 'Angelo Ramirez');
    eq('phone mapped from phone_number', l1.phone, '+15055550142');
    eq('email mapped by name, not position', l1.email, 'angelo@example.com');
    eq('source is facebook', l1.source, 'facebook');
    eq('utm carries ad + form ids', l1.utm, { source: 'facebook', medium: 'lead-ad', campaign: 'AD_77', content: 'FORM_88' });
    eq('leadgen_id stored for idempotency', l1.metaLeadgenId, 'LEADGEN_1');
    eq('unknown fields preserved, not dropped', l1.metaCustomFields, {
      'what_service_are_you_interested_in?': 'Ceramic tint',
      vehicle_year_make_model: '2021 Toyota Tacoma',
    });
    eq('custom answers readable in notes', l1.notes.includes('Ceramic tint') && l1.notes.includes('2021 Toyota Tacoma'), true);
    eq('lands in the CRM pipeline as a new lead', l1.status, 'new');
    eq('used the shop\'s own page token', graphCalls[0], { leadgenId: 'LEADGEN_1', token: 'PAGE-TOKEN-XYZ' });

    // ── 4. Idempotency: Meta re-delivers ─────────────────────────────────────
    const before = graphCalls.length;
    eq('POST: re-delivery → 200', (await post(raw1, sign(raw1))).status, 200);
    await new Promise(r => setTimeout(r, 300));
    eq('re-delivery created NO second lead', leads().length, 1);
    eq('re-delivery did not re-fetch from Graph', graphCalls.length, before);
    eq('re-delivery did not bump formSubmits', leads()[0].formSubmits, 1);

    // ── 4b. Durable idempotency (the post-restart case) ──────────────────────
    // The check above was answered by the in-memory in-flight guard, which is
    // empty after a Railway restart. Seed a lead that already carries a
    // leadgen_id the process has never seen, so only the on-disk check can
    // catch the re-delivery.
    getShopDb(shopId).get('leads').push({
      id: 'lead_seeded', name: 'Seeded Earlier', phone: '+15055551111', email: '',
      source: 'facebook', status: 'new', metaLeadgenId: 'LEADGEN_RESTART', createdAt: new Date().toISOString(),
    }).write();
    GRAPH['LEADGEN_RESTART'] = { id: 'LEADGEN_RESTART', field_data: [{ name: 'full_name', values: ['Should Not Import'] }] };
    const rawR = leadgenBody('LEADGEN_RESTART', PAGE_ID);
    const graphBeforeR = graphCalls.length;
    eq('POST: re-delivery after restart → 200', (await post(rawR, sign(rawR))).status, 200);
    await new Promise(r => setTimeout(r, 300));
    eq('on-disk leadgen_id blocked the re-import', leads().filter(l => l.metaLeadgenId === 'LEADGEN_RESTART').length, 1);
    eq('on-disk check ran BEFORE the Graph call', graphCalls.length, graphBeforeR);

    // ── 5. Field order reversed — name mapping must still hold ───────────────
    const raw2 = leadgenBody('LEADGEN_2', PAGE_ID);
    await post(raw2, sign(raw2));
    eq('second lead saved', await waitFor(() => leads().length === 3), true);
    const l2 = leads().find(l => l.metaLeadgenId === 'LEADGEN_2');
    eq('first_name + last_name joined when full_name absent', l2.name, 'Dana Cruz');
    eq('phone still correct with fields reordered', l2.phone, '+15055559999');
    eq('email still correct with fields reordered', l2.email, 'dana@example.com');

    // ── 6. Unknown page: log loudly, never throw ─────────────────────────────
    const raw3 = leadgenBody('LEADGEN_1', '999999999999');
    eq('POST: unknown page_id still ACKs 200', (await post(raw3, sign(raw3))).status, 200);
    await new Promise(r => setTimeout(r, 300));
    eq('unknown page_id wrote nothing', leads().length, 3);

    // ── 6b. Config surface: the page token must not leak to the browser ──────
    const adminHdr = { 'x-admin-key': 'test-admin-key', 'content-type': 'application/json' };
    const profile = await (await fetch(`${base}/api/admin/shop/${shopId}`, { headers: adminHdr })).json();
    eq('admin profile does NOT return metaPageToken', profile.shop.metaPageToken, undefined);
    eq('admin profile reports the token IS configured', profile.shop.metaPageTokenSet, true);
    eq('admin profile still returns metaPageId', profile.shop.metaPageId, PAGE_ID);

    // A client echoing the redacted profile back must not wipe the real token.
    await fetch(`${base}/api/admin/shop/${shopId}`, {
      method: 'PATCH', headers: adminHdr, body: JSON.stringify({ metaPageToken: '', plan: 'pro' }),
    });
    const afterBlank = master.get('shops').find({ id: shopId }).value();
    eq('blank metaPageToken leaves the stored token intact', afterBlank.metaPageToken, 'PAGE-TOKEN-XYZ');
    eq('the rest of that PATCH still applied', afterBlank.plan, 'pro');

    // Clearing is possible, but has to be explicit.
    await fetch(`${base}/api/admin/shop/${shopId}`, {
      method: 'PATCH', headers: adminHdr, body: JSON.stringify({ metaPageToken: null }),
    });
    eq('explicit null clears the token', master.get('shops').find({ id: shopId }).value().metaPageToken, '');
    // Restore for the assertions that follow.
    master.get('shops').find({ id: shopId }).assign({ metaPageToken: 'PAGE-TOKEN-XYZ' }).write();

    // ── 7. Graph failure is survivable ───────────────────────────────────────
    const raw4 = leadgenBody('LEADGEN_MISSING', PAGE_ID);
    eq('POST: Graph 400 still ACKs 200', (await post(raw4, sign(raw4))).status, 200);
    await new Promise(r => setTimeout(r, 300));
    eq('failed Graph fetch wrote no partial lead', leads().length, 3);
    eq('process still alive after Graph failure', true, true);
  } catch (e) {
    failures++;
    console.log('FAIL  threw:', e.stack || e.message);
  } finally {
    server.close();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll assertions passed.');
    process.exit(failures ? 1 : 0);
  }
});

// Integration test for the client-portal lead view (server/routes/client.js +
// middleware.js requireClient). Run: node test/client-portal.test.js
//
// The portal's whole point is that a competing marketing vendor can read it, so
// the assertions are adversarial: tenant isolation, an exact response-key
// whitelist (sensitive fields seeded with sentinel strings that must never
// appear anywhere in a response), coarsened source/status, the new→contacted
// transition rule, and client tokens being rejected on every /api/shop route.
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-clienttest-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, JWT_SECRET } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

// ── Seed: two shops, mixed-schema leads with sentinel-tagged sensitive fields ──
const A = 'shop_client_a', B = 'shop_client_b';
master.get('shops').push(
  { id: A, accountId: 'acA', shopName: 'Shop A', slug: 'shop-a', active: true },
  { id: B, accountId: 'acB', shopName: 'Shop B', slug: 'shop-b', active: true },
).write();
// Real master account behind the client token, so activity attribution + the
// login event (routes/auth.js) can be asserted end-to-end.
const bcrypt = require('bcryptjs');
master.get('accounts').push({
  id: 'ca', shopId: A, email: 'clienta@test.com', name: 'Client A',
  passwordHash: bcrypt.hashSync('clientpass', 4), role: 'client', active: true,
}).write();

const now = new Date().toISOString();
const old = new Date(Date.now() - 200 * 86400000).toISOString();

const dbA = getShopDb(A);
dbA.set('settings', { shopName: 'Shop A' }).write();
dbA.set('calls', []).write();
dbA.set('leads', [
  // Legacy call-tracking lead, status new — sensitive: notes, utm campaign.
  { id: 'la1', name: 'Cal Caller', phone: '5550000001', email: '', source: 'call', status: 'new',
    notes: 'SENTINEL-NOTES', utm: { utm_source: 'facebook', campaign: 'SENTINEL-CAMPAIGN' },
    callCount: 3, missedCount: 2, createdAt: now, lastContactAt: now,
    vehicle: { year: '2019', make: 'Ford', model: 'F-150' }, servicesInterested: ['Full detail'] },
  // Legacy lead already booked → portal must show plain "contacted".
  { id: 'la2', name: 'Fiona Form', phone: '5550000002', source: 'facebook', status: 'booked',
    createdAt: now, lastContactAt: now, servicesInterested: [], firstResponseAt: now },
  // Website-intake lead (snake_case NEW_LEAD machine) with the full ad payload.
  { id: 'la3', name: 'Wes Web', phone: '5550000003', email: 'wes@example.com', channel: 'website',
    status: 'NEW_LEAD', contact_status: 'UNCONTACTED', created_at: now, updated_at: now,
    source: 'meta', medium: 'paid-social', campaign: 'SENTINEL-ADCAMPAIGN', ad_set: 'SENTINEL-ADSET',
    ad_name: 'SENTINEL-ADNAME', fbclid: 'SENTINEL-FBCLID', gclid: '', utm_parameters: { c: 'SENTINEL-UTM' },
    estimated_value: 777, lead_quality_score: 95, response_time_seconds: null, first_response_at: null,
    contact_attempts: [], photo: 'data:image/png;base64,SENTINELPHOTO',
    service_requested: 'Ceramic tint', vehicle_year: '2022', vehicle_make: 'Tesla', vehicle_model: 'Model Y' },
  // Outside the default 90-day window → hidden unless from= reaches back.
  { id: 'laOld', name: 'Olda Lead', phone: '5550000009', source: 'google', status: 'new',
    createdAt: old, lastContactAt: old },
]).write();

const dbB = getShopDb(B);
dbB.set('settings', { shopName: 'Shop B' }).write();
dbB.set('leads', [
  { id: 'lb1', name: 'Bee Only', phone: '5551111111', source: 'call', status: 'new', createdAt: now },
]).write();

// ── App under test: the real routers behind the real middleware ───────────────
const app = express();
app.use(express.json());
app.use(require('../server/routes/client'));
app.use(require('../server/routes/shop'));
app.use(require('../server/routes/auth'));

const WHITELIST = ['createdAt', 'email', 'id', 'name', 'phone', 'serviceRequested', 'source', 'status', 'vehicle'];
const SENTINELS = ['SENTINEL-NOTES', 'SENTINEL-CAMPAIGN', 'SENTINEL-ADCAMPAIGN', 'SENTINEL-ADSET',
  'SENTINEL-ADNAME', 'SENTINEL-FBCLID', 'SENTINEL-UTM', 'SENTINELPHOTO', '777', '"lead_quality_score"', '"response_time_seconds"'];

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const clientA = jwt.sign({ shopId: A, accountId: 'ca', role: 'client' }, JWT_SECRET);
  const clientB = jwt.sign({ shopId: B, accountId: 'cb', role: 'client' }, JWT_SECRET);
  const ownerA  = jwt.sign({ shopId: A, accountId: 'acA', role: 'full' }, JWT_SECRET);
  const call = (method, p, token, body) => fetch(base + p, {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    // ── 1. List: scoping, coarsening, whitelist ──
    let r = await call('GET', '/api/client/leads', clientA);
    let j = await r.json();
    eq('list http 200', r.status, 200);
    eq('default 90-day window hides the old lead (3 of 4)', j.total, 3);
    eq('only whitelisted keys on every lead', j.leads.every(l => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(WHITELIST)), true);
    const body = JSON.stringify(j);
    eq('no sentinel/sensitive value leaks anywhere in the response', SENTINELS.filter(s => body.includes(s)), []);
    const byId = {}; j.leads.forEach(l => { byId[l.id] = l; });
    eq('call lead source coarsened to Call', byId.la1.source, 'Call');
    eq('facebook lead source coarsened to Meta', byId.la2.source, 'Meta');
    eq('booked lead shown as contacted', byId.la2.status, 'contacted');
    eq('website NEW_LEAD shown as new', byId.la3.status, 'new');
    eq('website lead source coarsened to Meta', byId.la3.source, 'Meta');
    eq('website vehicle flattened', byId.la3.vehicle, '2022 Tesla Model Y');
    eq('website serviceRequested mapped', byId.la3.serviceRequested, 'Ceramic tint');
    eq('legacy vehicle flattened', byId.la1.vehicle, '2019 Ford F-150');
    eq('no shop-B lead in shop-A list', byId.lb1, undefined);

    // Date range reaches back to the old lead when asked. Query from the day
    // BEFORE its UTC date — from= is parsed as local midnight, which can land
    // after the lead's timestamp when local date and UTC date straddle midnight.
    const dayBeforeOld = new Date(new Date(old).getTime() - 86400000).toISOString().slice(0, 10);
    r = await call('GET', '/api/client/leads?from=' + dayBeforeOld, clientA);
    j = await r.json();
    eq('explicit from= includes the old lead', j.total, 4);
    // Status filter.
    r = await call('GET', '/api/client/leads?status=contacted', clientA);
    j = await r.json();
    eq('status filter returns only contacted', j.leads.map(l => l.id), ['la2']);

    // ── 2. Client tokens are locked out of the CRM API ──
    for (const p of ['/api/shop/leads', '/api/shop/settings', '/api/shop/customers']) {
      r = await call('GET', p, clientA);
      eq(`client token rejected on ${p}`, r.status, 403);
    }
    // ── and owner tokens are locked out of the portal API ──
    r = await call('GET', '/api/client/leads', ownerA);
    eq('owner token rejected on /api/client/leads', r.status, 403);
    r = await fetch(base + '/api/client/leads');
    eq('no token → 401', r.status, 401);

    // ── 3. Manual lead logging ──
    r = await call('POST', '/api/client/leads', clientA, { name: 'Walter Walkin', phone: '5552223333', source: 'Meta', status: 'contacted' });
    eq('forged source rejected', r.status, 400);
    r = await call('POST', '/api/client/leads', clientA,
      { name: 'Walter Walkin', phone: '5552223333', email: 'w@x.com', serviceRequested: 'Wash', vehicle: '2021 BMW M3', source: 'Call', status: 'contacted', campaign: 'INJECTED' });
    j = await r.json();
    eq('manual log http 201', r.status, 201);
    eq('status forced to new (forged value ignored)', j.lead.status, 'new');
    eq('POST response only has whitelisted keys', JSON.stringify(Object.keys(j.lead).sort()), JSON.stringify(WHITELIST));
    const stored = getShopDb(A).get('leads').find({ id: j.lead.id }).value();
    eq('stored internally with source call', stored.source, 'call');
    eq('unknown fields not written to storage', stored.campaign, undefined);
    eq('stored vehicle parsed', stored.vehicle, { year: '2021', make: 'BMW', model: 'M3' });
    r = await call('POST', '/api/client/leads', clientA, { name: 'No Phone', source: 'Call' });
    eq('missing phone rejected', r.status, 400);

    // ── 4. Status transitions ──
    r = await call('PATCH', '/api/client/leads/la1/status', clientA, { status: 'booked' });
    eq('non-contacted target rejected (422)', r.status, 422);
    r = await call('PATCH', '/api/client/leads/la1/status', clientA, { status: 'contacted' });
    j = await r.json();
    eq('new → contacted allowed', j.lead.status, 'contacted');
    eq('firstResponseAt stamped on legacy lead', !!getShopDb(A).get('leads').find({ id: 'la1' }).value().firstResponseAt, true);
    r = await call('PATCH', '/api/client/leads/la1/status', clientA, { status: 'contacted' });
    eq('repeat transition rejected (409)', r.status, 409);
    r = await call('PATCH', '/api/client/leads/la2/status', clientA, { status: 'contacted' });
    eq('already-past-new lead rejected (409)', r.status, 409);
    r = await call('PATCH', '/api/client/leads/la3/status', clientA, { status: 'contacted' });
    j = await r.json();
    eq('website NEW_LEAD → contacted allowed', j.lead.status, 'contacted');
    const la3 = getShopDb(A).get('leads').find({ id: 'la3' }).value();
    eq('website machine advanced to CONTACTED internally', la3.status, 'CONTACTED');
    eq('website first_response_at stamped', !!la3.first_response_at, true);
    // Cross-tenant: shop B's lead id through shop A's token → 404 (never found).
    r = await call('PATCH', '/api/client/leads/lb1/status', clientA, { status: 'contacted' });
    eq('cross-tenant lead id → 404', r.status, 404);
    r = await call('GET', '/api/client/leads', clientB);
    j = await r.json();
    eq('shop B client still sees only its own lead', j.leads.map(l => l.id), ['lb1']);

    // ── 5. Activity journal + attribution ──
    r = await fetch(base + '/api/accounts/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'clienta@test.com', password: 'clientpass' }),
    });
    j = await r.json();
    eq('client login ok, lands on /portal', [j.ok, j.crmUrl], [true, '/portal']);
    const acts = getShopDb(A).get('clientActivity').value() || [];
    const byAction = {}; acts.filter(a => a.accountId === 'ca').forEach(a => { byAction[a.action] = (byAction[a.action] || 0) + 1; });
    eq('one throttled view despite three list fetches', byAction['view'], 1);
    eq('one lead.created entry (rejected POSTs never log)', byAction['lead.created'], 1);
    eq('two lead.contacted entries (409/422s never log)', byAction['lead.contacted'], 2);
    eq('login event journaled', byAction['login'], 1);
    eq('activity attributed to the account email', acts.every(a => a.email === 'clienta@test.com'), true);
    const wendy = getShopDb(A).get('leads').find(l => l.name === 'Walter Walkin').value();
    eq('manual lead stamped createdBy', wendy.createdBy, 'clienta@test.com');
    eq('contacted lead stamped contactedBy', getShopDb(A).get('leads').find({ id: 'la1' }).value().contactedBy, 'clienta@test.com');
    // Stamps stay internal — the client list response still has only whitelisted keys.
    r = await call('GET', '/api/client/leads', clientA);
    j = await r.json();
    eq('whitelist still exact after stamping', j.leads.every(l => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(WHITELIST)), true);
    // Owner reads the journal; the client token cannot.
    r = await call('GET', '/api/shop/client-activity', ownerA);
    j = await r.json();
    const csum = (j.clients || []).find(c => c.email === 'clienta@test.com');
    eq('owner activity endpoint summarizes the client', [csum.logins, csum.views, csum.created, csum.contacted], [1, 1, 1, 2]);
    r = await call('GET', '/api/shop/client-activity', clientA);
    eq('client token rejected on the activity endpoint', r.status, 403);
  } catch (e) { failures++; console.log('FAIL  threw', e.stack || e.message); }

  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
});

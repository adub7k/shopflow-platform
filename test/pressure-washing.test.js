// Pressure-washing vertical: a field-service profile whose leads carry a
// property instead of a vehicle.
//  - The `pressure` profile turns on the field-service pages and seeds a new
//    shop with its services, statuses and property fields.
//  - POST /api/public/:slug/lead requires the Service Address and keeps the
//    shop's own non-vehicle fields on lead.customFields (unknown keys dropped,
//    a re-submit merges).
//  - Converting the lead to a client files the address as a Property, once.
//  - GET /api/shop/settings backfills fieldService for shops created before
//    it was a profile flag.
//  - POST /api/admin/shop/:id/industry turns a shop created as the wrong type
//    (HQ used to default to barbershop) into a pressure washer, keeping its leads.
// Run: node test/pressure-washing.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-pressure-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, initShopDb, JWT_SECRET } = require('../server/db');
const { INDUSTRIES } = require('../server/industries');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

// ── Profile ──────────────────────────────────────────────────────────────────
const P = INDUSTRIES.pressure;
eq('pressure is a field-service vertical', P.fieldService, true);
eq('cleaning is a field-service vertical', INDUSTRIES.cleaning.fieldService, true);
eq('detail is not', !!INDUSTRIES.detail.fieldService, false);
eq('service address is the one required field', P.customFields.filter(f => f.required).map(f => f.key), ['serviceAddress']);
eq('service names match the website lead options',
  P.services.map(s => s.name), ['House Washing', 'Concrete Cleaning', 'Deck & Fence', 'Roof Soft Wash', 'Commercial']);
eq('every service category is offered in the picker', P.services.every(s => P.serviceCategories.includes(s.category)), true);

// ── Shop seeded from the profile ─────────────────────────────────────────────
const shopId = 'shoptest_pw', slug = 'pressure-test';
master.get('shops').push({ id: shopId, shopName: 'Pressure Test', slug, industry: 'pressure', active: true }).write();
const db = getShopDb(shopId);
initShopDb(db, { shopName: 'Pressure Test', email: 'owner@pressure.test', industry: 'pressure' });
const seeded = db.get('settings').value();
eq('new shop: fieldService on', seeded.fieldService, true);
eq('new shop: property fields from the profile', seeded.propertyFields.map(f => f.key), ['propertyType', 'stories', 'squareFootage']);
eq('new shop: statuses include En Route', seeded.statuses.some(s => s.key === 'en-route'), true);
eq('new shop: services seeded', (db.get('services').value() || []).map(s => s.name).includes('House Washing'), true);

// A cleaning shop from before fieldService existed: no flag in its settings.
const oldId = 'shoptest_oldclean', oldSlug = 'old-clean-test';
master.get('shops').push({ id: oldId, shopName: 'Old Clean', slug: oldSlug, industry: 'cleaning', active: true }).write();
const oldDb = getShopDb(oldId);
oldDb.set('industry', 'cleaning').write();
oldDb.set('settings', { shopName: 'Old Clean', customFields: [] }).write();

// Created from HQ before the business type was asked for: a barbershop with a
// real lead already in it.
const barbId = 'shoptest_barb';
master.get('shops').push({ id: barbId, shopName: 'Wrong Type', slug: 'wrong-type-test', active: true }).write();
const barbDb = getShopDb(barbId);
initShopDb(barbDb, { shopName: 'Wrong Type', email: 'x@wrong.test' });
barbDb.set('leads', [{ id: 'lead_keep', name: 'Keep Me', phone: '5055550111' }]).write();

const token = (id) => jwt.sign({ shopId: id, accountId: 'acct', email: 'x@y.test', role: 'full' }, JWT_SECRET);

const app = express();
app.use(express.json());
app.use(require('../server/routes/public'));
app.use(require('../server/routes/shop'));
app.use(require('../server/routes/admin'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, tok) => fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));
  const get = (p, tok) => fetch(base + p, { headers: { authorization: 'Bearer ' + tok } }).then(r => r.json());
  // Re-read from disk: the routes write through their own lowdb handle.
  const fresh = () => getShopDb(shopId);
  const lead = () => (fresh().get('leads').value() || []).find(l => l.phone === '(505) 555-0199');

  try {
    // ── Lead capture ─────────────────────────────────────────────────────────
    const missing = await post(`/api/public/${slug}/lead`, {
      name: 'Pat Doe', phone: '(505) 555-0199', email: 'pat@example.test',
      services: ['House Washing'], customFields: { propertyType: 'House' },
    });
    eq('lead without an address is rejected', [missing.status, /Service Address/.test(missing.body.error)], [400, true]);

    const ok = await post(`/api/public/${slug}/lead`, {
      name: 'Pat Doe', phone: '(505) 555-0199', email: 'pat@example.test',
      services: ['House Washing'],
      customFields: { serviceAddress: '123 Oak St, 87110', propertyType: 'House', stories: '2 stories', bogus: 'nope' },
    });
    eq('lead with an address is accepted', ok.status, 200);
    eq('property fields stored on the lead (unknown keys dropped)', lead().customFields,
      { serviceAddress: '123 Oak St, 87110', propertyType: 'House', stories: '2 stories' });
    eq('no vehicle on a property lead', lead().vehicle, null);
    eq('service tagged from the profile service names', lead().servicesInterested, ['House Washing']);

    await post(`/api/public/${slug}/lead`, {
      name: 'Pat Doe', phone: '(505) 555-0199',
      services: ['Concrete Cleaning'], customFields: { serviceAddress: '123 Oak St, 87110', stories: '1 story' },
    });
    eq('re-submit merges the property fields', lead().customFields,
      { serviceAddress: '123 Oak St, 87110', propertyType: 'House', stories: '1 story' });

    // ── Convert → property ───────────────────────────────────────────────────
    const conv = await post(`/api/shop/leads/${lead().id}/convert`, {}, token(shopId));
    eq('convert ok', conv.status, 200);
    const props = () => (fresh().get('properties').value() || []).filter(p => p.customerId === lead().customerId);
    eq('convert files the address as a property', props().map(p => [p.address, p.propertyType, p.stories]),
      [['123 Oak St, 87110', 'House', '1 story']]);
    await post(`/api/shop/leads/${lead().id}/convert`, {}, token(shopId));
    eq('converting again does not duplicate it', props().length, 1);

    // ── Settings backfill ────────────────────────────────────────────────────
    const s = await get('/api/shop/settings', token(shopId));
    eq('settings: pressure shop reports fieldService', [s.fieldService, s.industry], [true, 'pressure']);
    const old = await get('/api/shop/settings', token(oldId));
    eq('settings: pre-flag cleaning shop backfilled', [old.fieldService, old.propertyFields.map(f => f.key)],
      [true, ['bedrooms', 'bathrooms', 'squareFootage']]);

    // ── Switch a wrong-type shop ─────────────────────────────────────────────
    const adminPost = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'shopflow-admin' }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() }));
    eq('unknown industry rejected', (await adminPost(`/api/admin/shop/${barbId}/industry`, { industry: 'nope' })).status, 400);
    const sw = await adminPost(`/api/admin/shop/${barbId}/industry`, { industry: 'pressure', resetServices: true });
    eq('switch ok', sw.body, { ok: true, shopId: barbId, industry: 'pressure' });
    const b = getShopDb(barbId);
    const bs = b.get('settings').value();
    eq('switched: profile settings', [b.get('industry').value(), bs.fieldService, bs.vocab.staff, bs.customFields.map(f => f.key)],
      ['pressure', true, 'Technician', ['serviceAddress', 'propertyType', 'stories']]);
    eq('switched: services replaced', b.get('services').value().map(x => x.name)[0], 'House Washing');
    eq('switched: placeholder staff renamed', b.get('barbers').value()[0].name, 'Technician 1');
    eq('switched: existing lead kept', (b.get('leads').value() || []).map(l => l.name), ['Keep Me']);
    eq('switched: shop name untouched', bs.shopName, 'Wrong Type');
    eq('master record notes the industry', master.get('shops').find({ id: barbId }).value().industry, 'pressure');
  } catch (e) {
    failures++;
    console.log('FAIL  threw', e);
  } finally {
    server.close();
    console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
});

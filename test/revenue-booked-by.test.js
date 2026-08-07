// Integration test for "Booked by" sales attribution: the server stamps WHO
// entered each appointment (createdBy = accountId from the auth token) and
// GET /api/shop/revenue reports per-person booked/closed money in byCreator.
// Run: node test/revenue-booked-by.test.js
//
// Verifies against the REAL route handlers: registers a throwaway shop with two
// staff accounts in a temp DATA_DIR, creates appointments through the API with
// each account's JWT, and asserts that (1) createdBy comes from the token and
// never the request body, (2) edits and completes never re-attribute, and
// (3) the revenue rollup buckets booked-this-month vs closed-this-month right.
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-bookedby-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, JWT_SECRET, today } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shoptest_bb', ownerId = 'acct_owner', techId = 'acct_tech';
master.get('shops').push({ id: shopId, accountId: ownerId, shopName: 'BookedBy Test', slug: 'bookedby-test', industry: 'detail', active: true }).write();
master.get('accounts').push(
  { id: ownerId, shopId, email: 'owner@test.com', name: 'Me', role: 'full', active: true },
  { id: techId,  shopId, email: 'angelo@test.com', name: 'Angelo', role: 'technician', active: true },
).write();

const td = today();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'BookedBy Test', loyalty: { enabled: false } }).write();
db.set('services', [{ id: 's1', name: 'Tint', price: 300, cost: 0 }]).write();
db.set('barbers', []).write();
db.set('expenses', []).write();
// Legacy appointment from before attribution existed — no createdBy, must not
// appear in byCreator but still counts in overall revenue.
db.set('appointments', [
  { id: 'a_old', status: 'done', price: 999, date: td, customerName: 'Legacy', service: 'Tint', source: 'crm' },
]).write();

const app = express();
app.use(express.json());
app.use(require('../server/routes/shop'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokOwner = jwt.sign({ shopId, accountId: ownerId, role: 'full' }, JWT_SECRET);
  const tokTech  = jwt.sign({ shopId, accountId: techId,  role: 'technician' }, JWT_SECRET);
  const post = (p, body, tok) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    // Owner books a $500 job — and maliciously claims the tech booked it.
    // The body's createdBy must be ignored; the token wins.
    await post('/api/shop/appointments', { id: 'a1', customerName: 'C1', customerPhone: '5550000001', service: 'Tint', price: 500, date: td, time: '10:00 AM', status: 'confirmed', source: 'crm', createdBy: techId, createdByName: 'Angelo' }, tokOwner);
    // Tech books two jobs: $300 (stays open) and $200 (closed below).
    await post('/api/shop/appointments', { id: 'a2', customerName: 'C2', customerPhone: '5550000002', service: 'Tint', price: 300, date: td, time: '11:00 AM', status: 'confirmed', source: 'crm' }, tokTech);
    await post('/api/shop/appointments', { id: 'a3', customerName: 'C3', customerPhone: '5550000003', service: 'Tint', price: 200, date: td, time: '12:00 PM', status: 'confirmed', source: 'crm' }, tokTech);
    // Owner edits the tech's $300 job to $350 — must NOT steal attribution.
    await post('/api/shop/appointments', { id: 'a2', price: 350, status: 'confirmed' }, tokOwner);
    // Owner completes the tech's $200 job — closes it, still the tech's booking.
    await post('/api/shop/appointments/a3/complete', { price: 200 }, tokOwner);

    const fresh = getShopDb(shopId).get('appointments').value();
    eq('a1 attributed to owner (body createdBy ignored)', fresh.find(a => a.id === 'a1').createdBy, ownerId);
    eq('a1 name snapshot is owner', fresh.find(a => a.id === 'a1').createdByName, 'Me');
    eq('a2 still attributed to tech after owner edit', fresh.find(a => a.id === 'a2').createdBy, techId);
    eq('a3 still attributed to tech after owner completes it', fresh.find(a => a.id === 'a3').createdBy, techId);
    eq('CRM create stamps createdAt', typeof fresh.find(a => a.id === 'a1').createdAt, 'string');

    const r = await fetch(base + '/api/shop/revenue', { headers: { authorization: 'Bearer ' + tokOwner } });
    const j = await r.json();
    eq('http 200', r.status, 200);
    eq('byCreator has 2 people (legacy appt excluded)', (j.byCreator || []).length, 2);
    const tech = (j.byCreator || []).find(p => p.accountId === techId) || {};
    const owner = (j.byCreator || []).find(p => p.accountId === ownerId) || {};
    eq('tech name resolved from master accounts', tech.name, 'Angelo');
    eq('tech booked this month = 350 + 200', tech.bookedMonth, 550);
    eq('tech booked jobs = 2', tech.bookedMonthJobs, 2);
    eq('tech closed this month = 200', tech.closedMonth, 200);
    eq('tech closed jobs = 1', tech.closedMonthJobs, 1);
    eq('owner booked this month = 500', owner.bookedMonth, 500);
    eq('owner closed this month = 0', owner.closedMonth, 0);
    eq('sorted by booked desc (tech first)', j.byCreator[0].accountId, techId);
    // totalRevenue counts DONE jobs only: legacy 999 + the closed 200.
    eq('legacy appt still in overall revenue', j.totalRevenue, 999 + 200);
  } catch (e) { failures++; console.log('FAIL  threw', e.message); }
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
});

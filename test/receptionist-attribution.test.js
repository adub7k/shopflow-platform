// Integration test for GET /api/shop/receptionist/attribution (server/routes/shop.js).
// "Revenue recovered" = revenue from CLOSED (done) jobs joined via booking_id to
// AI-answered calls the shop did NOT pick up. Registers a throwaway shop in a temp
// DATA_DIR, writes calls + appointments, forges a JWT, and asserts.
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-attrib-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, JWT_SECRET } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shop_attrib', accountId = 'acct_attrib';
master.get('shops').push({ id: shopId, accountId, shopName: 'Attrib Test', slug: 'attrib', industry: 'detail', active: true }).write();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'Attrib Test' }).write();

const D = '2026-07-20';                 // in range
const OUT = '2026-06-01';               // out of range
db.set('appointments', [
  { id: 'a1', status: 'done',      price: 300, date: D },   // AI booked, closed → recovered
  { id: 'a2', status: 'done',      price: 200, date: D },   // owner-booked capture, closed → recovered
  { id: 'a3', status: 'done',      price: 999, date: D },   // closed BUT staff answered that call → NOT recovered
  { id: 'a4', status: 'confirmed', price: 400, date: D },   // AI booked but not done yet → not recovered
]).write();
db.set('calls', [
  // AI answered, staff did NOT pick up, booked → job closed → counts ($300)
  { id: 'kA', voiceAI: { outcome: { type: 'booked' } }, staff_answered: false, call_started_at: D, booking_id: 'a1', outcome: 'booked' },
  // AI captured, owner later booked (booking_id back-filled), job closed → counts ($200)
  { id: 'kB', voiceAI: { outcome: { type: 'captured' } }, staff_answered: false, call_started_at: D, booking_id: 'a2', outcome: 'booked' },
  // AI answered but STAFF picked up → excluded from revenue even though a3 is done
  { id: 'kC', voiceAI: { outcome: { type: 'booked' } }, staff_answered: true, call_started_at: D, booking_id: 'a3', outcome: 'booked' },
  // AI answered, staff missed, booked but job not done yet → no revenue
  { id: 'kD', voiceAI: { outcome: { type: 'booked' } }, staff_answered: false, call_started_at: D, booking_id: 'a4', outcome: 'booked' },
  // AI answered, staff missed, only captured (no booking) → counts as answered, no revenue
  { id: 'kE', voiceAI: { outcome: { type: 'captured' } }, staff_answered: false, call_started_at: D, booking_id: null, outcome: 'captured' },
  // Out of date range → excluded entirely
  { id: 'kOld', voiceAI: { outcome: { type: 'booked' } }, staff_answered: false, call_started_at: OUT, booking_id: 'a1', outcome: 'booked' },
  // Not an AI call (no voiceAI) → excluded
  { id: 'kHuman', from: '+15550000000', staff_answered: true },
]).write();

const app = express();
app.use(express.json());
app.use(require('../server/routes/shop'));
const server = app.listen(0, async () => {
  try {
    const token = jwt.sign({ shopId, accountId, role: 'full' }, JWT_SECRET);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/shop/receptionist/attribution?from=2026-07-01&to=2026-07-31`, { headers: { authorization: 'Bearer ' + token } });
    const j = await r.json();
    eq('http 200', r.status, 200);
    eq('aiAnswered = 5 (in-range AI calls; kOld + kHuman excluded)', j.aiAnswered, 5);
    eq('staffNotAnswered = 4 (kC staff-answered excluded)', j.staffNotAnswered, 4);
    eq('revenueRecovered = 300 + 200 (staff-missed, done, booked)', j.revenueRecovered, 500);
    eq('recoveredJobs = 2', j.recoveredJobs, 2);
    eq('byOutcome tally', j.byOutcome, { booked: 4, captured: 1 });
  } catch (e) { failures++; console.log('FAIL threw', e.message); }
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
});

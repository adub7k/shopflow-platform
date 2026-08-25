// Integration test for the "Revenue Recovered" fields on GET /api/shop/revenue
// (server/routes/shop.js). Run: node test/revenue-recovered.test.js
//
// Verifies the AI-attribution math against the REAL route handler: registers a
// throwaway shop in a temp DATA_DIR, writes exact appts/leads, forges a JWT, and
// asserts. "Recovered" = done jobs the AI booked (source ai-voice) OR AI-captured
// quote-first leads later closed into a done job (matched by customer/phone, on or
// after capture). "Pipeline" = quoted price on AI-captured leads not yet realized.
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-rectest-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, shopHelpers, JWT_SECRET, today } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shoptest_rec', accountId = 'acct_rec';
master.get('shops').push({ id: shopId, accountId, shopName: 'Rec Test', slug: 'rec-test', industry: 'detail', active: true }).write();

const td = today();
const past = td.slice(0, 8) + '01';   // 1st of this month = capture date (before jobs)
const db = getShopDb(shopId);
const h = shopHelpers(db);
db.set('settings', { shopName: 'Rec Test', loyalty: { enabled: false } }).write();
db.set('services', [{ id: 's1', name: 'Full Detail', price: 300, cost: 0 }]).write();
db.set('barbers', [{ id: 'b1', name: 'Bay 1', active: true }]).write();
db.set('customers', [{ id: 'cB', name: 'Converted', phone: '+15550000002' }]).write();
db.set('expenses', []).write();
db.set('appointments', [
  { id: 'a1', status: 'done', source: 'ai-voice',    price: 300, date: td, customerId: 'cA', customerPhone: '+15550000001', service: 'Full Detail' }, // AI booked → counts
  { id: 'a2', status: 'done', source: 'booking-page', price: 200, date: td, customerId: 'cB', customerPhone: '+15550000002', service: 'Full Detail' }, // AI-captured lead, closed → counts
  { id: 'a3', status: 'done', source: 'booking-page', price: 999, date: td, customerId: 'cX', customerPhone: '+15559999999', service: 'Full Detail' }, // non-AI → not counted
  { id: 'a4', status: 'confirmed', source: 'ai-voice', price: 500, date: td, customerId: 'cD', customerPhone: '+15550000004', service: 'Full Detail' }, // ai-voice but not done → not realized
]).write();
db.set('leads', [
  { id: 'lB',       phone: '+15550000002', customerId: 'cB', status: 'closed',    ai: { source: 'voice', quotedPrice: 200, quality: 'hot',  generatedAt: past } }, // realized via a2
  { id: 'lOpen',    phone: '+15550000009',                   status: 'contacted', ai: { source: 'voice', quotedPrice: 400, quality: 'warm', generatedAt: past } }, // open pipeline $400
  { id: 'lNoQuote', phone: '+15550000010',                   status: 'contacted', ai: { source: 'voice', quotedPrice: null, budget: null,   generatedAt: past } }, // no quote → ignored
  { id: 'lManual',  phone: '+15550000011',                   status: 'contacted', quotedAmount: 175 }, // owner typed a quote on the lead (AI gave it but didn't log it)
]).write();
db.set('calls', [
  // answered + engaged + captured; outcome logged NO price, but its lead has a
  // manual quotedAmount → still counts as a quote given.
  { id: 'k1', leadId: 'lManual', voiceAI: { turns: [{ role: 'assistant', text: 'hi' }, { role: 'user', text: 'I need a detail' }], outcome: { type: 'captured' } } },
  // answered + engaged + quoted-then-booked (a price was given, then they booked)
  { id: 'k2', voiceAI: { turns: [{ role: 'assistant', text: 'hi' }, { role: 'user', text: 'book me' }], outcome: { type: 'booked', quotedPrice: 250 } } },
  // answered but hung up on the greeting (no user turn) → not engaged, no outcome
  { id: 'k3', voiceAI: { turns: [{ role: 'assistant', text: 'hi' }], outcome: null } },
  // a plain non-AI call (no voiceAI) → excluded from the funnel entirely
  { id: 'k4', from: '+15551112222', missed: true },
]).write();

const app = express();
app.use(express.json());
app.use(require('../server/routes/shop'));
const server = app.listen(0, async () => {
  try {
    const token = jwt.sign({ shopId, accountId, role: 'full' }, JWT_SECRET);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/shop/revenue`, { headers: { authorization: 'Bearer ' + token } });
    const j = await r.json();
    eq('http 200', r.status, 200);
    eq('aiRecoveredTotal = 300 (ai-voice) + 200 (converted)', j.aiRecoveredTotal, 500);
    eq('aiRecoveredMonth = 500', j.aiRecoveredMonth, 500);
    eq('aiRecoveredJobs = 2', j.aiRecoveredJobs, 2);
    eq('aiPipelineOpen = 400 (open quote only)', j.aiPipelineOpen, 400);
    eq('aiPipelineCount = 1', j.aiPipelineCount, 1);
    eq('non-AI job still counts in overall totalRevenue (300+200+999)', j.totalRevenue, 1499);
    // Scorecard funnel (from the call log; k4 has no voiceAI so it's excluded)
    eq('funnel: answered = 3', j.aiReceptionist.answered, 3);
    eq('funnel: engaged = 2 (k3 hung up on greeting)', j.aiReceptionist.engaged, 2);
    eq('funnel: captured = 1', j.aiReceptionist.captured, 1);
    eq('funnel: booked = 1', j.aiReceptionist.booked, 1);
    eq('funnel: quoted = 2 (k2 outcome price + k1 lead manual quotedAmount)', j.aiReceptionist.quoted, 2);
    eq('funnel: quotedTotal = 200+400 (nulls ignored)', j.aiReceptionist.quotedTotal, 600);
  } catch (e) { failures++; console.log('FAIL  threw', e.message); }
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
});

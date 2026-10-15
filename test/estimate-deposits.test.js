// Estimates & deposits by sender: the server stamps WHO created / first sent each
// estimate (from the auth token), and GET /api/shop/revenue reports each
// sender's deposit rate, approved-without-deposit leaks, and no-shows, plus a
// shop-wide no-show rate with vs. without a deposit.
// Run: node test/estimate-deposits.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-estdep-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, JWT_SECRET, today } = require('../server/db');
const { computeEstimateDeposits } = require('../server/estimate-deposits');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

// ── Pure rollup ──────────────────────────────────────────────────────────────
{
  const quotes = [
    { id: 'q1', sentBy: 'b', sentByName: 'Bryce', firstSentAt: '2026-10-02T10:00:00Z', status: 'scheduled', depositPaid: true, depositAmount: 100, total: 600, appointmentId: 'a1' },
    { id: 'q2', sentBy: 'b', sentByName: 'Bryce', firstSentAt: '2026-10-03T10:00:00Z', status: 'scheduled', approvedAt: '2026-10-04', total: 400, appointmentId: 'a2' },
    { id: 'q3', createdBy: 'o', createdByName: 'Owner', createdAt: '2026-10-05T10:00:00Z', status: 'sent', total: 300 },
    { id: 'q4', sentBy: 'b', firstSentAt: '2026-09-28T10:00:00Z', status: 'sent', total: 900 },   // last month
    { id: 'q5', createdAt: '2026-10-06T10:00:00Z', status: 'sent', total: 200 },                     // legacy, no attribution
  ];
  const appointments = [
    { id: 'a1', status: 'done' },
    { id: 'a2', status: 'no-show' },
    { id: 'a9', status: 'no-show', depositPaid: true },   // booking-page deposit, still flaked
    { id: 'a8', status: 'done' },
    { id: 'a7', status: 'confirmed' },                   // no outcome yet → ignored
  ];
  const r = computeEstimateDeposits({ quotes, appointments, accounts: [{ id: 'b', name: 'Bryce M' }], inWindow: d => d.slice(0, 7) === '2026-10' });
  const b = r.bySender.find(x => x.accountId === 'b');
  eq('pure: live account name wins', b.name, 'Bryce M');
  eq('pure: Bryce sent 2 this month (Sept one excluded)', b.sent, 2);
  eq('pure: Bryce 1 deposit, $100', [b.deposits, b.depositTotal], [1, 100]);
  eq('pure: Bryce deposit rate 50%', b.depositRate, 50);
  eq('pure: Bryce approved w/o deposit = 1 ($400)', [b.approvedNoDeposit, b.approvedNoDepositValue], [1, 400]);
  eq('pure: Bryce showed 1, no-show 1', [b.showed, b.noShows, b.noShowsNoDeposit], [1, 1, 1]);
  eq('pure: created-but-unsent estimate credits creator', r.bySender.find(x => x.accountId === 'o').sent, 1);
  eq('pure: team counts legacy too', r.team.sent, 4);
  eq('pure: unattributed = 1', r.unattributed, 1);
  eq('pure: with-deposit no-show 1 of 2 (a1 done, a9 flaked)', r.noShowByDeposit.withDeposit, { jobs: 2, noShows: 1, rate: 50 });
  eq('pure: no-deposit no-show 1 of 2 (a2 flaked, a8 done)', r.noShowByDeposit.withoutDeposit, { jobs: 2, noShows: 1, rate: 50 });
}

// ── Route attribution + revenue payload ──────────────────────────────────────
const shopId = 'shoptest_ed', ownerId = 'acct_owner_ed', techId = 'acct_tech_ed';
master.get('shops').push({ id: shopId, accountId: ownerId, shopName: 'EstDep Test', slug: 'estdep-test', industry: 'detail', active: true }).write();
master.get('accounts').push(
  { id: ownerId, shopId, email: 'owner@test.com', name: 'Me', role: 'full', active: true },
  { id: techId,  shopId, email: 'bryce@test.com', name: 'Bryce', role: 'technician', active: true },
).write();
const td = today();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'EstDep Test', loyalty: { enabled: false } }).write();
db.set('services', []).write(); db.set('barbers', []).write(); db.set('expenses', []).write();
db.set('appointments', []).write(); db.set('quotes', []).write();

const app = express();
app.use(express.json());
app.use(require('../server/routes/shop'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokOwner = jwt.sign({ shopId, accountId: ownerId, role: 'full' }, JWT_SECRET);
  const tokTech  = jwt.sign({ shopId, accountId: techId,  role: 'technician' }, JWT_SECRET);
  const post = (p, body, tok) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }).then(r => r.json());
  const getQ = id => getShopDb(shopId).get('quotes').value().find(q => q.id === id);
  try {
    // Owner creates an estimate; Bryce is the one who texts it out.
    const { id: q1 } = await post('/api/shop/quotes', { customerName: 'C1', customerPhone: '5550000001', lineItems: [{ name: 'Ceramic tint', price: 500 }], createdBy: techId }, tokOwner);
    eq('create stamps createdBy from token (body ignored)', getQ(q1).createdBy, ownerId);
    eq('not sent yet → no sentBy', getQ(q1).sentBy, undefined);
    const t1 = new Date().toISOString();
    await post('/api/shop/quotes', { id: q1, smsSentAt: t1, sentBy: ownerId }, tokTech);
    eq('text send credits the sender (Bryce)', [getQ(q1).sentBy, getQ(q1).sentByName], [techId, 'Bryce']);
    eq('firstSentAt stamped', getQ(q1).firstSentAt, t1);
    // Owner edits it, echoing the stored smsSentAt — not a send, no re-credit.
    await post('/api/shop/quotes', { id: q1, smsSentAt: t1, notes: 'edit' }, tokOwner);
    eq('edit echoing smsSentAt keeps Bryce', getQ(q1).sentBy, techId);
    // Owner re-texts later — first sender keeps the credit and the date.
    await post('/api/shop/quotes', { id: q1, smsSentAt: new Date(Date.now() + 1000).toISOString() }, tokOwner);
    eq('resend by someone else keeps first sender', [getQ(q1).sentBy, getQ(q1).firstSentAt], [techId, t1]);

    // Bryce sends a second; owner sends a third.
    const { id: q2 } = await post('/api/shop/quotes', { customerName: 'C2', lineItems: [{ name: 'PPF', price: 1000 }] }, tokTech);
    await post('/api/shop/quotes', { id: q2, smsSentAt: new Date().toISOString() }, tokTech);
    const { id: q3 } = await post('/api/shop/quotes', { customerName: 'C3', lineItems: [{ name: 'Tint', price: 300 }] }, tokOwner);
    await post('/api/shop/quotes', { id: q3, smsSentAt: new Date().toISOString() }, tokOwner);

    // Outcomes (deposits arrive via Square/Stripe webhooks — set directly).
    const sdb = getShopDb(shopId);
    sdb.get('quotes').find({ id: q1 }).assign({ status: 'scheduled', depositPaid: true, depositAmount: 100, appointmentId: 'a1' }).write();
    sdb.get('quotes').find({ id: q2 }).assign({ status: 'scheduled', approvedAt: new Date().toISOString(), appointmentId: 'a2' }).write();
    sdb.set('appointments', [
      { id: 'a1', status: 'done', price: 500, date: td, customerName: 'C1' },
      { id: 'a2', status: 'no-show', price: 1000, date: td, customerName: 'C2' },
    ]).write();

    const r = await fetch(base + '/api/shop/revenue', { headers: { authorization: 'Bearer ' + tokOwner } });
    const j = await r.json();
    eq('http 200', r.status, 200);
    const ed = j.estimatesBySender || {};
    const bryce = (ed.bySender || []).find(p => p.accountId === techId) || {};
    const me = (ed.bySender || []).find(p => p.accountId === ownerId) || {};
    eq('Bryce sent 2', bryce.sent, 2);
    eq('Bryce deposit rate 50%', bryce.depositRate, 50);
    eq('Bryce 1 approved w/o deposit, 1 no-show', [bryce.approvedNoDeposit, bryce.noShows], [1, 1]);
    eq('owner sent 1, 0% deposit rate', [me.sent, me.depositRate], [1, 0]);
    eq('team sent 3', ed.team && ed.team.sent, 3);
    eq('no-show with deposit 0/1', ed.noShowByDeposit.withDeposit, { jobs: 1, noShows: 0, rate: 0 });
    eq('no-show without deposit 1/1', ed.noShowByDeposit.withoutDeposit, { jobs: 1, noShows: 1, rate: 100 });

    // ── Assigning older estimates ──
    // Two legacy estimates (no createdBy/sentBy), one from last year with a deposit.
    sdb.get('quotes').push(
      { id: 'q_old1', number: 'Q-900', status: 'approved', total: 400, depositPaid: true, depositAmount: 50, sentAt: '2025-03-01T10:00:00Z', createdAt: '2025-03-01T10:00:00Z' },
      { id: 'q_old2', number: 'Q-901', status: 'sent', total: 250, createdAt: '2025-03-02T10:00:00Z' },
    ).write();
    let j2 = await fetch(base + '/api/shop/revenue', { headers: { authorization: 'Bearer ' + tokOwner } }).then(r => r.json());
    eq('unattributedAll counts both legacy estimates', j2.estimatesBySender.unattributedAll, 2);
    eq('all-time view includes them in team total', j2.estimatesBySender.allTime.team.sent, 5);

    const techTry = await fetch(base + '/api/shop/quotes/assign-sender', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokTech }, body: JSON.stringify({ ids: ['q_old1'], accountId: techId }) });
    eq('technician cannot assign credit (403)', techTry.status, 403);
    master.get('accounts').push({ id: 'acct_other_shop', shopId: 'some_other_shop', email: 'x@x.com', name: 'X', role: 'full' }).write();
    const bad = await post('/api/shop/quotes/assign-sender', { ids: ['q_old1'], accountId: 'acct_other_shop' }, tokOwner);
    eq('other shop’s account rejected', bad.ok, false);
    const ok = await post('/api/shop/quotes/assign-sender', { ids: ['q_old1', 'q_old2', 'nope'], accountId: techId }, tokOwner);
    eq('owner assigns 2 (unknown id skipped)', [ok.ok, ok.updated], [true, 2]);
    eq('assignment stamped', [getQ('q_old1').sentBy, getQ('q_old1').sentByName, getQ('q_old1').sentByAssignedBy], [techId, 'Bryce', ownerId]);
    j2 = await fetch(base + '/api/shop/revenue', { headers: { authorization: 'Bearer ' + tokOwner } }).then(r => r.json());
    const bAll = j2.estimatesBySender.allTime.bySender.find(p => p.accountId === techId);
    eq('nothing left unassigned', j2.estimatesBySender.unattributedAll, 0);
    eq('Bryce all-time: 4 sent, 2 deposits → 50%', [bAll.sent, bAll.deposits, bAll.depositRate], [4, 2, 50]);
    eq('this-month view unchanged by old assignments', j2.estimatesBySender.bySender.find(p => p.accountId === techId).sent, 2);
    // A later send of an assigned estimate doesn't steal the credit.
    await post('/api/shop/quotes', { id: 'q_old2', smsSentAt: new Date().toISOString() }, tokOwner);
    eq('send after assignment keeps assigned sender', getQ('q_old2').sentBy, techId);
  } catch (e) { failures++; console.log('FAIL  threw', e.message); }
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
});

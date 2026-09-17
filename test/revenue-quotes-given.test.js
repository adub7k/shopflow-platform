// Integration test for "Quotes given": GET /api/shop/revenue reports every
// dollar the shop put in front of a customer — formal estimates (quotes
// collection, fleet contracts at full term) plus phone quotes logged on leads
// (quotedAmount / AI quotedPrice) that never became an estimate — with won /
// open / lost splits, this month and all time. /revenue/month/:ym buckets the
// same rollup by month and ships the rows for the CSV export.
// Run: node test/revenue-quotes-given.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-quotesgiven-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, JWT_SECRET, today } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shoptest_qg', ownerId = 'acct_owner_qg';
master.get('shops').push({ id: shopId, accountId: ownerId, shopName: 'QuotesGiven Test', slug: 'quotesgiven-test', industry: 'detail', active: true }).write();
master.get('accounts').push({ id: ownerId, shopId, email: 'owner@qg.test', name: 'Me', role: 'full', active: true }).write();

const td = today();
const thisMonth = td.slice(0, 7);
const lastMonth = (() => { const d = new Date(td + 'T00:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'QuotesGiven Test', loyalty: { enabled: false }, quoteCounter: 1000 }).write();
db.set('services', []).write(); db.set('barbers', []).write(); db.set('expenses', []).write(); db.set('appointments', []).write();
// c1 also paid a $50 BOOKING deposit this month (customer.deposits stream).
db.set('customers', [{ id: 'c1', name: 'Cust One', phone: '5550000001', deposits: [{ id: 'd1', amount: 50, status: 'paid', paidAt: td + 'T08:00:00.000Z' }] }]).write();
db.set('quotes', [
  // Won this month, $500
  // ...and paid a $100 ESTIMATE deposit on it (Approve & pay) — lives on the quote, must count too
  { id: 'q1', number: 'Q-1001', status: 'approved',  total: 500,  customerId: 'c1', customerName: 'Cust One', customerPhone: '5550000001', lineItems: [{ name: 'Ceramic tint', price: 500, qty: 1 }], createdAt: td + 'T10:00:00.000Z', depositRequired: true, depositAmount: 100, depositPaid: true, depositPaidAt: td + 'T10:30:00.000Z' },
  // Still out this month, $300
  { id: 'q2', number: 'Q-1002', status: 'sent',      total: 300, depositRequired: true, depositAmount: 75, depositPaid: false,  customerName: 'Cust Two', customerPhone: '5550000002', lineItems: [{ name: 'Carbon tint', price: 300, qty: 1 }], createdAt: td + 'T11:00:00.000Z' },
  // Lost LAST month, $200
  { id: 'q3', number: 'Q-1003', status: 'lost',      total: 200,  customerName: 'Cust Three', customerPhone: '5550000003', lineItems: [{ name: 'Wash', price: 200, qty: 1 }], createdAt: lastMonth + '-05T10:00:00.000Z' },
  // Fleet contract last month: counts at full term ($12,000), not per-visit ($1,000)
  // Last-month fleet estimate with a $300 deposit paid but no depositPaidAt (pre-stamp Stripe) → dated by approvedAt
  { id: 'q4', number: 'Q-1004', status: 'completed', total: 1000, depositAmount: 300, depositPaid: true, approvedAt: lastMonth + '-21T10:00:00.000Z', contract: { frequency: 'monthly', termMonths: 12 }, contractValue: 12000, fleetName: 'ABQ Plumbing', customerName: 'Fleet Co', customerPhone: '5550000004', lineItems: [{ name: 'Fleet wash', price: 100, qty: 10 }], createdAt: lastMonth + '-20T10:00:00.000Z' },
]).write();
db.set('leads', [
  // Phone quote on a lead with NO estimate → counts ($150, open) this month
  { id: 'l1', name: 'Phone Lead', phone: '5550000009', status: 'quoted', quotedAmount: 150, quotedAt: td + 'T12:00:00.000Z', createdAt: td + 'T09:00:00.000Z' },
  // Same phone as estimate q2 → NOT double-counted
  { id: 'l2', name: 'Cust Two', phone: '(555) 000-0002', status: 'quoted', quotedAmount: 999, createdAt: td + 'T09:00:00.000Z' },
  // AI-captured price on a lead, won (booked), no quotedAt → dated by createdAt (last month)
  { id: 'l3', name: 'AI Lead', phone: '5550000010', status: 'booked', ai: { source: 'voice', quotedPrice: 250 }, createdAt: lastMonth + '-10T09:00:00.000Z' },
  // No quote at all → ignored
  { id: 'l4', name: 'Nobody', phone: '5550000011', status: 'new', createdAt: td + 'T09:00:00.000Z' },
]).write();

const app = express();
app.use(express.json());
app.use(require('../server/routes/shop'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = jwt.sign({ shopId, accountId: ownerId, role: 'full' }, JWT_SECRET);
  const get = p => fetch(base + p, { headers: { authorization: 'Bearer ' + tok } }).then(r => r.json());
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    const rev = await get('/api/shop/revenue');
    const m = rev.quotesGiven.month, t = rev.quotesGiven.total;
    // This month: q1 500 (won) + q2 300 (open) + l1 150 (open, phone). l2 deduped.
    eq('month count', m.count, 3);
    eq('month value', m.value, 950);
    eq('month mix', [m.estimates, m.phone], [2, 1]);
    eq('month won', [m.won, m.wonValue], [1, 500]);
    eq('month open', [m.open, m.openValue], [2, 450]);
    eq('month win rate (1 won / 1 decided)', m.winRate, 100);
    // All time adds q3 200 (lost), q4 12000 (won, full term), l3 250 (won, phone)
    eq('total count', t.count, 6);
    eq('total value', t.value, 950 + 200 + 12000 + 250);
    eq('total won', [t.won, t.wonValue], [3, 500 + 12000 + 250]);
    eq('total lost', [t.lost, t.lostValue], [1, 200]);
    eq('total win rate (3 won / 4 decided)', t.winRate, 75);
    eq('rows not shipped on live route', t.rows, undefined);

    // Deposits: booking deposit ($50, this month) + estimate deposits ($100 this
    // month, $300 last month). Unpaid estimate deposit (q2) is ignored.
    eq('month deposits = booking + estimate', rev.monthDeposits, 150);
    eq('total deposits', rev.totalDeposits, 450);
    eq('deposit split', rev.depositSplit, { bookingMonth: 50, bookingTotal: 50, estimateMonth: 100, estimateTotal: 400, estimateCount: 2 });

    // Month history: last month = q3, q4, l3
    const hist = await get('/api/shop/revenue/month/' + lastMonth);
    eq('hist ok', hist.ok, true);
    eq('hist last-month count/value', [hist.summary.quotes.count, hist.summary.quotes.value], [3, 12450]);
    eq('hist last-month won', [hist.summary.quotes.won, hist.summary.quotes.wonValue], [2, 12250]);
    eq('hist last-month deposits include estimate deposit', hist.summary.deposits, 300);
    eq('hist rows for CSV', hist.quotes.map(r => [r.number || r.kind, r.value]), [['Q-1003', 200], ['phone', 250], ['Q-1004', 12000]]);
    const histNow = await get('/api/shop/revenue/month/' + thisMonth);
    eq('hist this-month prev = last month', histNow.prev.quotes.value, 12450);

    // Entering a phone quote on a lead stamps quotedAt; clearing it clears the stamp;
    // re-pricing keeps the original date.
    await post('/api/shop/leads/l4', { quotedAmount: 400 });
    let l4 = db.read().get('leads').find({ id: 'l4' }).value();
    eq('quotedAt stamped on entry', typeof l4.quotedAt, 'string');
    const first = l4.quotedAt;
    await post('/api/shop/leads/l4', { quotedAmount: 450 });
    l4 = db.read().get('leads').find({ id: 'l4' }).value();
    eq('re-pricing keeps quotedAt', l4.quotedAt, first);
    const rev2 = await get('/api/shop/revenue');
    eq('new phone quote counted this month', [rev2.quotesGiven.month.count, rev2.quotesGiven.month.value], [4, 1400]);
    await post('/api/shop/leads/l4', { quotedAmount: null });
    l4 = db.read().get('leads').find({ id: 'l4' }).value();
    eq('clearing amount clears quotedAt', [l4.quotedAmount, l4.quotedAt], [null, null]);
  } catch (e) { failures++; console.log('FAIL  threw', e); }
  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nAll passed');
  process.exit(failures ? 1 : 0);
});

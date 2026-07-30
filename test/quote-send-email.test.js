// Integration test for POST /api/shop/quotes/:id/send-email (server/routes/shop.js).
// Run: node test/quote-send-email.test.js   (exits non-zero on any failure)
//
// Hits the REAL route against a throwaway shop in a temp DATA_DIR. The Resend
// HTTPS call is intercepted (global.fetch is wrapped) so nothing is actually
// emailed — we assert on the payload Resend would have received. Covers: sending
// to the quote's own email, falling back to the linked customer record, the
// no-email-anywhere 400, and that a successful send is persisted (emailSentAt).
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-qemail-' + process.pid);
process.env.RESEND_API_KEY = 'test-key';           // route the send down the Resend HTTPS path
process.env.RESEND_FROM = 'Test Shop <t@example.com>';

// Intercept only Resend calls; the test's own fetch() to the local server passes through.
const realFetch = global.fetch;
const sent = [];
global.fetch = (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    try { sent.push(JSON.parse(opts.body)); } catch (e) { sent.push(null); }
    return Promise.resolve({ ok: true, json: async () => ({ id: 'test-email-id' }) });
  }
  return realFetch(url, opts);
};

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, shopHelpers, JWT_SECRET } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };
const ok = (name, cond, detail) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (${detail || ''})`}`); };

const shopId = 'shoptest_qe', accountId = 'acct_qe';
master.get('shops').push({ id: shopId, accountId, shopName: 'QE Test', slug: 'qe-test', industry: 'detail', active: true }).write();

const db = getShopDb(shopId);
const h = shopHelpers(db);
db.set('settings', { shopName: 'QE Test', accentColor: '#0ea5e9' }).write();
db.set('customers', [
  { id: 'cWithEmail', name: 'Pat Owner', phone: '+15550000001', email: 'pat@example.com' },
  { id: 'cNoEmail',   name: 'No Mail',   phone: '+15550000002', email: '' },
]).write();
db.set('quotes', [
  // Direct email on the quote → sends there.
  { id: 'qDirect', number: 'Q-1001', status: 'sent', customerName: 'Direct Dan', customerEmail: 'dan@example.com',
    lineItems: [{ name: 'Ceramic Coating', price: 900 }], subtotal: 900, taxAmount: 0, total: 900 },
  // No email on the quote, but linked customer has one → fallback resolves it.
  { id: 'qFallback', number: 'Q-1002', status: 'sent', customerName: 'Pat Owner', customerId: 'cWithEmail',
    lineItems: [{ name: 'Paint Correction', price: 500 }], subtotal: 500, taxAmount: 0, total: 500 },
  // No email anywhere → 400.
  { id: 'qNone', number: 'Q-1003', status: 'sent', customerName: 'No Mail', customerId: 'cNoEmail',
    lineItems: [{ name: 'Wash', price: 60 }], subtotal: 60, taxAmount: 0, total: 60 },
]).write();

const app = express();
app.use(express.json());
app.use(require('../server/routes/shop'));
app.use(require('../server/routes/public'));  // for the open-tracking pixel route
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ shopId, accountId, role: 'full' }, JWT_SECRET);
  const send = (id) => fetch(`${base}/api/shop/quotes/${id}/send-email`, { method: 'POST', headers: { authorization: 'Bearer ' + token } });
  try {
    // 1) Direct email on the quote
    let r = await send('qDirect'); let j = await r.json();
    eq('qDirect → 200', r.status, 200);
    eq('qDirect → ok:true, to=dan@example.com', { ok: j.ok, to: j.to }, { ok: true, to: 'dan@example.com' });
    const last = sent[sent.length - 1];
    eq('Resend payload addressed to dan@example.com', last && last.to, 'dan@example.com');
    ok('email subject names the estimate number', /Q-1001/.test(last.subject), last && last.subject);
    ok('email body contains the total $900.00', last.html.includes('$900.00'), 'total missing');
    ok('email body links to the public quote page', last.html.includes(`/quote/qe-test/qDirect`), 'link missing');
    ok('email uses the shop accent color', last.html.includes('#0ea5e9'), 'accent missing');
    ok('email embeds the open-tracking pixel', last.html.includes('/api/public/qe-test/quote/qDirect/opened.gif'), 'pixel missing');
    // Persistence: emailSentAt stamped, customerEmail kept
    const stored = shopHelpers(getShopDb(shopId)).getById('quotes', 'qDirect');
    ok('qDirect emailSentAt persisted', !!stored.emailSentAt, 'not stamped');
    ok('qDirect not opened yet', !stored.emailOpenedAt, 'unexpectedly opened');

    // Open tracking: fetching the pixel stamps emailOpenedAt + counts opens.
    let px = await fetch(`${base}/api/public/qe-test/quote/qDirect/opened.gif`);
    eq('pixel → 200', px.status, 200);
    eq('pixel → image/gif', px.headers.get('content-type'), 'image/gif');
    await fetch(`${base}/api/public/qe-test/quote/qDirect/opened.gif`); // second open
    const opened = shopHelpers(getShopDb(shopId)).getById('quotes', 'qDirect');
    ok('emailOpenedAt stamped after pixel fetch', !!opened.emailOpenedAt, 'not stamped');
    eq('emailOpenCount counts both opens', opened.emailOpenCount, 2);

    // 2) Fallback to the linked customer's email
    r = await send('qFallback'); j = await r.json();
    eq('qFallback → 200', r.status, 200);
    eq('qFallback → to=pat@example.com (from customer record)', j.to, 'pat@example.com');
    const storedFb = shopHelpers(getShopDb(shopId)).getById('quotes', 'qFallback');
    eq('qFallback back-fills customerEmail on the quote', storedFb.customerEmail, 'pat@example.com');

    // 3) No email anywhere → 400, no send attempted
    const before = sent.length;
    r = await send('qNone'); j = await r.json();
    eq('qNone → 400', r.status, 400);
    eq('qNone → ok:false', j.ok, false);
    eq('qNone → no Resend call made', sent.length, before);

    // 4) Unknown quote → 404
    r = await send('nope'); eq('unknown id → 404', r.status, 404);

    // 5) renderQuoteEmail reminder variant softens copy + prefixes subject
    const { renderQuoteEmail } = require('../server/email');
    const first = renderQuoteEmail({ shop: { name: 'QE Test' }, quote: { number: 'Q-1001', total: 900, lineItems: [{ name: 'x', price: 900 }] }, link: 'http://x/q' });
    const rem = renderQuoteEmail({ shop: { name: 'QE Test' }, quote: { number: 'Q-1001', total: 900, lineItems: [{ name: 'x', price: 900 }] }, link: 'http://x/q', reminder: true, openPixel: 'http://x/px.gif' });
    ok('first-send subject is neutral', /^Estimate Q-1001 from/.test(first.subject), first.subject);
    ok('reminder subject signals a follow-up', /Following up/i.test(rem.subject), rem.subject);
    ok('reminder body softens the copy', /checking in/i.test(rem.html), 'copy not softened');
    ok('openPixel embedded when provided', rem.html.includes('http://x/px.gif'), 'pixel missing');
    ok('no pixel when openPixel omitted', !first.html.includes('px.gif'), 'unexpected pixel');
  } catch (e) { failures++; console.log('FAIL  threw', e.message, e.stack); }
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
});

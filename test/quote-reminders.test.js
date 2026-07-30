// Unit test for remindStaleQuotes (server/scheduler.js) — the email follow-up
// cadence for unapproved estimates. Run: node test/quote-reminders.test.js
//
// No real email: the Resend HTTPS call is intercepted. Sets up quotes at various
// ages/states in a throwaway shop and asserts exactly which ones get nudged and
// that counters advance. (Scheduler's setInterval keeps the loop alive; the test
// ends with process.exit.)
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-qrem-' + process.pid);
process.env.RESEND_API_KEY = 'test-key';
process.env.RESEND_FROM = 'Test Shop <t@example.com>';
process.env.PUBLIC_BASE_URL = 'https://app.example.com';

const realFetch = global.fetch;
const sent = [];
global.fetch = (url, opts) => {
  if (String(url).includes('api.resend.com')) { try { sent.push(JSON.parse(opts.body)); } catch (e) { sent.push(null); } return Promise.resolve({ ok: true, json: async () => ({ id: 'x' }) }); }
  return realFetch(url, opts);
};

const { master, getShopDb, shopHelpers } = require('../server/db');
const { remindStaleQuotes } = require('../server/scheduler');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };
const ok = (name, cond, detail) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (${detail || ''})`}`); };

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const shopId = 'shoptest_qrem', accountId = 'acct_qrem';
const shopRow = { id: shopId, accountId, shopName: 'Rem Test', slug: 'rem-test', industry: 'detail', active: true };
master.get('shops').push(shopRow).write();

const db = getShopDb(shopId);
const settings = { shopName: 'Rem Test', accentColor: '#16a34a' }; // quoteReminders unset → defaults (after 3, every 3, max 2)
db.set('settings', settings).write();
db.set('customers', [{ id: 'cE', name: 'Has Email', email: 'has@example.com' }]).write();
db.set('quotes', [
  { id: 'qDue',      number: 'Q-1', status: 'sent',      customerName: 'Due',   customerEmail: 'due@example.com',  total: 100, lineItems: [{ name: 'a', price: 100 }], emailSentAt: daysAgo(5) },   // due → remind
  { id: 'qFresh',    number: 'Q-2', status: 'sent',      customerName: 'Fresh', customerEmail: 'fresh@example.com', total: 100, lineItems: [{ name: 'a', price: 100 }], emailSentAt: daysAgo(1) },   // <3d → skip
  { id: 'qFallback', number: 'Q-3', status: 'sent',      customerName: 'Has Email', customerId: 'cE',             total: 100, lineItems: [{ name: 'a', price: 100 }], emailSentAt: daysAgo(4) },   // due, email via customer
  { id: 'qMaxed',    number: 'Q-4', status: 'sent',      customerName: 'Maxed', customerEmail: 'max@example.com',  total: 100, lineItems: [{ name: 'a', price: 100 }], emailSentAt: daysAgo(20), reminderCount: 2, lastReminderAt: daysAgo(4) }, // hit cap → skip
  { id: 'qApproved', number: 'Q-5', status: 'approved',  customerName: 'Appr',  customerEmail: 'appr@example.com', total: 100, lineItems: [{ name: 'a', price: 100 }], emailSentAt: daysAgo(9) },   // resolved → skip
  { id: 'qNoEmail',  number: 'Q-6', status: 'sent',      customerName: 'NoMail',                                   total: 100, lineItems: [{ name: 'a', price: 100 }], emailSentAt: daysAgo(9) },   // no address → skip
  { id: 'qStale',    number: 'Q-7', status: 'sent',      customerName: 'Stale', customerEmail: 'stale@example.com', total: 100, lineItems: [{ name: 'a', price: 100 }], emailSentAt: daysAgo(40) },  // >30d → skip
  { id: 'qNeverEmailed', number: 'Q-8', status: 'sent',  customerName: 'Link',  customerEmail: 'link@example.com', total: 100, lineItems: [{ name: 'a', price: 100 }] },                             // texted only, no emailSentAt → skip
]).write();

(async () => {
  try {
    await remindStaleQuotes(db, shopRow, settings);
    const toSet = new Set(sent.map((m) => m.to));
    eq('exactly 2 reminders sent', sent.length, 2);
    ok('reminded qDue', toSet.has('due@example.com'), [...toSet].join(','));
    ok('reminded qFallback via customer email', toSet.has('has@example.com'), [...toSet].join(','));
    ok('did NOT remind fresh/approved/maxed/none/stale/never', !['fresh@example.com','appr@example.com','max@example.com','stale@example.com','link@example.com'].some((e) => toSet.has(e)), [...toSet].join(','));
    ok('reminder subject signals follow-up', sent[0] && /Following up/i.test(sent[0].subject), sent[0] && sent[0].subject);

    const h = shopHelpers(getShopDb(shopId));
    eq('qDue reminderCount → 1', h.getById('quotes', 'qDue').reminderCount, 1);
    ok('qDue lastReminderAt stamped', !!h.getById('quotes', 'qDue').lastReminderAt, 'missing');
    eq('qFresh untouched', h.getById('quotes', 'qFresh').reminderCount, undefined);
    eq('qMaxed still at 2', h.getById('quotes', 'qMaxed').reminderCount, 2);

    // Idempotency within cadence: immediately re-running sends nothing more (just reminded → not due).
    const before = sent.length;
    await remindStaleQuotes(db, shopRow, settings);
    eq('second run sends nothing (cadence gate holds)', sent.length, before);

    // Disabled → no sends even when due.
    const db2 = getShopDb(shopId);
    db2.get('quotes').find({ id: 'qFresh' }).assign({ emailSentAt: daysAgo(9) }).write(); // now due
    await remindStaleQuotes(db2, shopRow, { ...settings, quoteReminders: { enabled: false } });
    eq('disabled setting suppresses all sends', sent.length, before);
  } catch (e) { failures++; console.log('FAIL  threw', e.message, e.stack); }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})();

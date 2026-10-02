// Every new lead — any source, any intake path — starts the 30-day follow-up
// sequence (Day 0 due now). Owner decision 2026-10-02: the Tasks-page sequence
// is the single playbook for every lead touch, so enrollment can no longer
// depend on the lead being a Meta ad lead.
// Run: node test/followup-all-leads.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-fuall-' + process.pid);

const { master, getShopDb } = require('../server/db');
const { upsertLead, freshFollowUp } = require('../server/leads-core');
const { upsertLeadFromCall } = require('../server/routes/twilio');

let failures = 0;
const eq = (name, got, exp) => {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
};

const shopId = 'shoptest_fuall';
master.get('shops').push({ id: shopId, accountId: 'acct_fuall', shopName: 'FU All', slug: 'fu-all', industry: 'detail', active: true }).write();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'FU All' }).write();
db.set('leads', []).write();
const shop = master.get('shops').find({ id: shopId }).value();
const byPhone = (tail) => db.get('leads').value().find(l => String(l.phone || '').endsWith(tail));

const fresh = freshFollowUp('2026-10-02T12:00:00.000Z');
eq('freshFollowUp shape', fresh, { idx: 0, status: 'active', nextAt: '2026-10-02T12:00:00.000Z', startedAt: '2026-10-02T12:00:00.000Z', log: [] });

// Web form, Google ad, manual/unknown source — all enrol.
[['website', '5055550001'], ['google', '5055550002'], ['walk-in', '5055550003'], ['', '5055550004']].forEach(([source, phone], i) => {
  upsertLead(db, shop, { name: 'Lead ' + i, phone, source });
  const l = byPhone(phone.slice(-7));
  eq(`${source || '(empty)'} lead enrolled`, l.followUp && l.followUp.status, 'active');
  eq(`${source || '(empty)'} lead at Day 0`, l.followUp && l.followUp.idx, 0);
  eq(`${source || '(empty)'} lead due immediately`, l.followUp && l.followUp.nextAt <= new Date().toISOString(), true);
});

// A repeat submit from an already-known lead must not reset its sequence.
const before = byPhone('5550001');
before.followUp.idx = 3; before.followUp.log = [{ step: 'd0a', at: '2026-10-01T00:00:00.000Z' }];
db.get('leads').find({ id: before.id }).assign(before).write();
upsertLead(db, shop, { name: 'Lead 0', phone: '5055550001', source: 'website' });
eq('re-submit keeps sequence progress', byPhone('5550001').followUp.idx, 3);

// First-time inbound caller (twilio path) enrols too; a repeat caller is untouched.
const ctx = { h: { getAll: (k) => db.get(k).value(), upsert: (k, rec) => {
  const arr = db.get(k).value(); const i = arr.findIndex(x => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec); db.set(k, arr).write();
} } };
const callLead = upsertLeadFromCall(ctx, '+15055550099', 'Albuquerque', 'NM');
eq('call lead source', callLead.source, 'call');
eq('call lead enrolled', callLead.followUp && callLead.followUp.status, 'active');
eq('call lead Day 0', callLead.followUp && callLead.followUp.idx, 0);
eq('call lead has stage baseline', typeof callLead.stageChangedAt, 'string');
const saved = byPhone('5550099');
saved.followUp.idx = 2; db.get('leads').find({ id: saved.id }).assign(saved).write();
const again = upsertLeadFromCall(ctx, '+15055550099', 'Albuquerque', 'NM');
eq('repeat caller keeps sequence progress', again.followUp.idx, 2);
eq('repeat caller counted', again.callCount, 2);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

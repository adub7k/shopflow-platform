// Objection follow-ups: server/objections.js + the lead PATCH route + the
// client defaults (loaded from the real leads.js) + the advisor breakdown.
// Run: node test/objection-followups.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-objtest-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, shopHelpers, JWT_SECRET } = require('../server/db');
const obj = require('../server/objections');
const adv = require('../server/advisor/growthAdvisor');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };
const ok = (name, c) => eq(name, !!c, true);
const DAY = 86400000;

// ── classifier ───────────────────────────────────────────────────────────────
eq('classify: price', obj.classifyObjection("that's a bit too expensive for me"), 'price');
eq('classify: think / partner', [obj.classifyObjection('I need to talk to my wife about it'), obj.classifyObjection('has to talk to his wife first'), obj.classifyObjection('let me run it by my husband'), obj.classifyObjection('wife has to sign off')], ['think', 'think', 'think', 'think']);
eq('classify: timing', obj.classifyObjection('not right now, maybe next month'), 'timing');
eq('classify: competitor beats price', [obj.classifyObjection('the other shop quoted me cheaper'), obj.classifyObjection('went with a cheaper shop'), obj.classifyObjection('got a lower quote down the street')], ['competitor', 'competitor', 'competitor']);
eq('classify: wants a person beats everything', obj.classifyObjection('can I talk to a real person about the price'), 'human');
eq('classify: unknown → other', obj.classifyObjection('the color is wrong'), 'other');
eq('classify: empty → null', [obj.classifyObjection(''), obj.classifyObjection(null)], [null, null]);

// ── follow-up state ──────────────────────────────────────────────────────────
const NOW = Date.parse('2026-09-18T15:00:00Z');
let fu = obj.objectionFollowUp('price', NOW, { idx: 3, status: 'active', log: [{ step: 'Day 0 Initial', day: 0, at: '2026-09-10T00:00:00.000Z', by: 'A' }] });
eq('followUp: seq key + idx reset + first-day scheduling', [fu.seq, fu.idx, fu.status, fu.nextAt], ['obj_price', 0, 'active', new Date(NOW + DAY).toISOString()]);
eq('followUp: prior log kept + switch noted as a grey entry', [fu.log.length, fu.log[0].step, fu.log[1].step, fu.log[1].skipped], [2, 'Day 0 Initial', '→ Price / shopping around follow-up', true]);
eq('followUp: human = today', obj.objectionFollowUp('human', NOW).nextAt, new Date(NOW).toISOString());
eq('followUp: unknown type → other', obj.objectionFollowUp('nope', NOW).seq, 'obj_other');
eq('cleanObjection: string type', obj.cleanObjection('timing').type, 'timing');
eq('cleanObjection: object with note; bad type classified from note', [obj.cleanObjection({ type: 'zzz', note: 'need to sleep on it' }).type, obj.cleanObjection({ type: 'price', note: 'x'.repeat(300) }).note.length], ['think', 200]);
eq('cleanObjection: null clears', [obj.cleanObjection(null), obj.cleanObjection('')], [null, null]);
eq('cleanObjection: source ai kept', obj.cleanObjection({ type: 'price', source: 'ai' }).source, 'ai');

// ── client defaults agree with the server ────────────────────────────────────
// Load the real client file in a sandbox: it only needs a few globals at
// definition time; everything else is referenced lazily inside methods.
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'client', 'js', 'pages', 'leads.js'), 'utf8');
const sandbox = { Modal: { close() {} }, Shop: { settings: {} }, console };
vm.createContext(sandbox);
vm.runInContext(clientSrc + '\nthis.Leads = Leads;', sandbox);
const Leads = sandbox.Leads;
ok('client: OBJECTION_TYPES match server TYPES (keys + order)', JSON.stringify(Leads.OBJECTION_TYPES.map(t => t.key)) === JSON.stringify(obj.KEYS));
obj.TYPES.forEach(t => {
  const seq = Leads.DEFAULT_OBJECTION_SEQS[t.key];
  ok(`client: ${t.key} has a default sequence`, Array.isArray(seq) && seq.length >= 2);
  eq(`client: ${t.key} step 0 day == server firstDay`, seq[0].day, t.firstDay);
  ok(`client: ${t.key} steps ascend by day with unique ids`, seq.every((s, i) => i === 0 || s.day >= seq[i - 1].day) && new Set(seq.map(s => s.id)).size === seq.length);
  ok(`client: ${t.key} uses only known placeholders`, seq.every(s => (s.sms.match(/\[([A-Z]+)\]/g) || []).every(p => ['[NAME]', '[VEHICLE]', '[SHOP]', '[OFFER]', '[PRICE]', '[SALESPERSON]', '[PHONE]', '[DATE]', '[TIME]'].includes(p))));
});
eq('client: seqFor(meta) is the 30-day sequence', Leads.seqFor({ idx: 0 }).length, Leads.DEFAULT_FOLLOWUP_SEQ.length);
eq('client: seqFor(obj_think) is the think sequence', Leads.seqFor({ seq: 'obj_think', idx: 0 })[0].id, 'ot1');
eq('client: seqFor(unknown obj) falls back to the 30-day sequence', Leads.seqFor({ seq: 'obj_zzz', idx: 0 }).length, Leads.DEFAULT_FOLLOWUP_SEQ.length);
eq('client: seqMeta labels', [Leads.seqMeta({ seq: 'obj_price' }).short, Leads.seqMeta({ seq: 'obj_price' }).label, Leads.seqMeta({}).label], ['Price', 'Price / shopping around follow-up', '30-day follow-up']);
sandbox.Shop.settings.objectionSeqs = { price: [{ id: 'mine', label: 'Mine', day: 2, sms: 'custom [NAME]' }], think: [] };
eq('client: owner override per type; emptied type falls back to default', [Leads.objectionSeqs().price[0].id, Leads.objectionSeqs().think[0].id], ['mine', 'ot1']);
eq('client: fuFill keeps [SALESPERSON] readable without Auth', /from (our shop|Demo)/.test(Leads.fuFill("it's [SALESPERSON] from [SHOP]", { name: 'Sam' })), true);

// ── PATCH route + advisor ────────────────────────────────────────────────────
const shopId = 'shoptest_obj', accountId = 'acct_obj';
master.get('shops').push({ id: shopId, accountId, shopName: 'Obj Test', slug: 'obj-test', industry: 'detail', active: true }).write();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'Obj Test', timezone: 'America/Denver' }).write();
db.set('leads', [
  { id: 'l1', name: 'Pat', phone: '5055550001', createdAt: new Date(NOW - 2 * DAY).toISOString(), status: 'contacted', firstResponseAt: new Date(NOW - 2 * DAY + 60000).toISOString(), source: 'facebook', followUp: { idx: 2, status: 'active', nextAt: new Date(NOW).toISOString(), startedAt: new Date(NOW - 2 * DAY).toISOString(), log: [{ step: 'Day 0 Initial', day: 0, at: new Date(NOW - 2 * DAY).toISOString(), by: 'A' }] } },
  { id: 'l2', name: 'AIcap', phone: '5055550002', createdAt: new Date(NOW - 3 * DAY).toISOString(), status: 'contacted', firstResponseAt: new Date(NOW - 3 * DAY).toISOString(), source: 'call', ai: { source: 'voice', objection: 'has to talk to his wife first' } },
  { id: 'l3', name: 'Lost', phone: '5055550003', createdAt: new Date(NOW - 4 * DAY).toISOString(), status: 'lost', lostAt: new Date(NOW - DAY).toISOString(), lostReason: 'went with a cheaper shop', source: 'facebook' },
  { id: 'l4', name: 'Booked', phone: '5055550004', createdAt: new Date(NOW - 5 * DAY).toISOString(), status: 'booked', source: 'facebook', objection: { type: 'price', at: new Date(NOW - 4 * DAY).toISOString(), source: 'owner' }, followUp: { seq: 'obj_price', idx: 1, status: 'completed', log: [] } },
]).write();
db.set('appointments', []).write(); db.set('quotes', []).write(); db.set('calls', []).write(); db.set('customers', []).write();

(async () => {
  const app = express();
  app.use(express.json());
  app.use(require('../server/routes/shop'));
  const srv = app.listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port;
  const token = jwt.sign({ shopId, accountId, role: 'full' }, JWT_SECRET);
  const H = { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const call = (method, p, body) => fetch(base + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));

  // Owner picks "price" on l1: objection stamped, note logged, switched onto obj_price (client sends both).
  const fuNew = obj.objectionFollowUp('price', NOW, db.get('leads').find({ id: 'l1' }).value().followUp);
  let r = await call('POST', '/api/shop/leads/l1', { objection: { type: 'price', note: 'too much' }, followUp: fuNew });
  eq('PATCH: objection stored (bounded) + note logged', [r.status, r.body.lead.objection.type, r.body.lead.objection.note, r.body.lead.objection.source, r.body.lead.noteLog[0].text], [200, 'price', 'too much', 'owner', 'Objection: Price / shopping around — too much']);
  eq('PATCH: followUp.seq survives the sanitizer, idx reset, prior log kept', [r.body.lead.followUp.seq, r.body.lead.followUp.idx, r.body.lead.followUp.log.length, r.body.lead.followUp.log[1].skipped], ['obj_price', 0, 2, true]);
  r = await call('POST', '/api/shop/leads/l1', { followUp: { ...fuNew, seq: 'meta30-bogus' } });
  eq('PATCH: a non obj_ seq is dropped (defaults to the 30-day sequence)', r.body.lead.followUp.seq, undefined);
  r = await call('POST', '/api/shop/leads/l1', { objection: null });
  eq('PATCH: null clears the objection', r.body.lead.objection, null);
  r = await call('POST', '/api/shop/leads/l1', { objection: { type: 'nonsense' } });
  eq('PATCH: unknown type with no note → cleared, not stored', r.body.lead.objection, null);
  srv.close();

  // Advisor: objections by type over the period, from owner chips, AI text, and lost reasons.
  const shop = master.get('shops').find({ id: shopId }).value();
  const m = adv.snapshot(getShopDb(shopId), shop, { range: { preset: '7d' }, now: NOW }).metrics;
  const bo = Object.fromEntries(m.by_objection.map(x => [x.objection, x]));
  eq('advisor: by_objection covers owner chip (price, booked), AI text (think), lost reason (competitor)', [Object.keys(bo).sort(), bo.price.booked, bo.think.leads, bo.competitor.lost], [['competitor', 'price', 'think'], 1, 1, 1]);
  eq('advisor: labels + booking rate', [bo.price.label, bo.price.booking_rate_pct], ['Price / shopping around', 100]);
  const facts = adv.leadFacts(getShopDb(shopId));
  eq('advisor: lead rows carry objection + follow-up sequence', [facts.find(f => f.id === 'l4').objection, facts.find(f => f.id === 'l4').followUpSeq, facts.find(f => f.id === 'l1').followUpSeq], ['price', 'obj_price', 'meta30']);

  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

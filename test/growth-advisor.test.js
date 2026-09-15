// Growth Advisor (server/advisor/growthAdvisor.js + the admin routes).
// Run: node test/growth-advisor.test.js
//
// Covers the adapter from ShopFlow's real lead records (nested utm, stageLog,
// firstResponseAt, appointment/estimate matching by phone), the windowed
// metrics + spend proration + flags, the report/feedback store, the weekly
// auto-run gate, and the admin endpoints — with the model call stubbed, so no
// API key or network is needed.
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-advtest-' + process.pid);
delete process.env.ANTHROPIC_API_KEY;

const express = require('express');
const { master, getShopDb } = require('../server/db');
const adv = require('../server/advisor/growthAdvisor');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };
const ok = (name, cond) => eq(name, !!cond, true);

const NOW = Date.parse('2026-09-15T18:00:00.000Z');       // a Tuesday
const iso = (daysAgo, h = 0) => new Date(NOW - daysAgo * 86400000 - h * 3600000).toISOString();
const dstr = (daysAgo) => iso(daysAgo).slice(0, 10);

const shopId = 'shoptest_adv';
master.get('shops').push({ id: shopId, accountId: 'acct_adv', shopName: 'Adv Test Tint', slug: 'adv-test', industry: 'detail', active: true, advisorNotes: 'Owner only works Tue–Sat.' }).write();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'Adv Test Tint', pipeline: { stages: [
  { key: 'new', label: 'New' }, { key: 'contacted', label: 'Contacted' }, { key: 'booked', label: 'Booked', won: true }, { key: 'closed', label: 'Closed', won: true, terminal: true }, { key: 'lost', label: 'Lost', terminal: true },
] } }).write();
db.set('customers', [{ id: 'cB', name: 'Booked Via Appt', phone: '+15055550002' }]).write();
db.set('leads', [
  // this week: form lead, tagged ad, responded in 3 min, booked via stageLog, quoted $450
  { id: 'l1', name: 'Fast', phone: '5055550001', createdAt: iso(1), firstResponseAt: iso(1, -0.05), status: 'booked', quotedAmount: 450, source: 'facebook',
    utm: { source: 'facebook', campaign: 'Tint Offer', content: 'phone-video' }, servicesInterested: ['Ceramic tint'],
    stageLog: [{ from: 'new', to: 'contacted', at: iso(1, -0.05) }, { from: 'contacted', to: 'booked', at: iso(0, 20) }] },
  // this week: no response stamp, still 'new' — but an appointment exists for the phone (booked outside the pipeline)
  { id: 'l2', name: 'ApptMatch', phone: '(505) 555-0002', createdAt: iso(2), status: 'new', source: 'website', utm: { source: 'facebook', campaign: 'Tint Offer', content: 'phone-video' } },
  // this week: untagged paid lead, uncontacted, hot
  { id: 'l3', name: 'Hot', phone: '5055550003', createdAt: iso(0, 3), status: 'new', source: 'facebook', hot: true },
  // this week: native Meta lead-ad, contacted 2 days ago, not booked → stalled
  { id: 'l4', name: 'Stalled', phone: '5055550004', createdAt: iso(4), firstResponseAt: iso(3), status: 'contacted', source: 'facebook', utm: { source: 'facebook', medium: 'lead-ad', campaign: '120212345', content: 'form9' } },
  // last week: lost
  { id: 'l5', name: 'Lost', phone: '5055550005', createdAt: iso(10), firstResponseAt: iso(10, -1), status: 'lost', lostAt: iso(8), lostReason: 'price', source: 'google', utm: { source: 'google', campaign: 'lsa' } },
  // last week: call lead, AI quoted $300, booked (status only, no stageLog)
  { id: 'l6', name: 'Caller', phone: '5055550006', createdAt: iso(9), status: 'closed', stageChangedAt: iso(7), source: 'call', ai: { source: 'voice', quotedPrice: 300, serviceNeeded: 'Full detail' } },
  // 40 days ago: outside every window, but still "open" for nothing (too old)
  { id: 'l7', name: 'Old', phone: '5055550007', createdAt: iso(40), status: 'new', source: 'website' },
]).write();
db.set('appointments', [
  { id: 'a1', customerId: 'cB', customerPhone: '+15055550002', status: 'done', price: 600, date: dstr(0), createdAt: iso(1), source: 'booking-page' },
  { id: 'a2', customerId: 'cX', customerPhone: '+15055550001', status: 'no-show', price: 450, date: dstr(0), createdAt: iso(0, 10), source: 'booking-page' },
  // appointment BEFORE the lead came in — must not count as this lead's booking
  { id: 'a0', customerId: 'cY', customerPhone: '+15055550003', status: 'done', price: 999, date: dstr(60), createdAt: iso(60) },
]).write();
db.set('quotes', []).write();
db.set('calls', [
  { id: 'c1', startedAt: iso(1), missed: true, leadId: 'l6' },
  { id: 'c2', startedAt: iso(2), voiceAI: true },
]).write();
// Monthly spend on the offer campaign (Sep 1–30) + a weekly row for last week.
db.set('ad_spend', [
  { id: 's1', campaign: 'phone-video', source: 'facebook', amount: 300, period_start: '2026-09-01', period_end: '2026-09-30' },
  { id: 's2', campaign: 'lsa', source: 'google', amount: 70, period_start: dstr(13), period_end: dstr(7) },
]).write();

// ── adapter ──────────────────────────────────────────────────────────────────
const facts = adv.leadFacts(db);
const F = Object.fromEntries(facts.map(f => [f.id, f]));
eq('facts: every lead adapted', facts.length, 7);
eq('l1 responded from firstResponseAt', F.l1.respondedAt, iso(1, -0.05));
eq('l1 booked via stageLog at the booked transition', [F.l1.booked, F.l1.bookedAt], [true, iso(0, 20)]);
eq('l1 value = owner quotedAmount', F.l1.value, 450);
eq('l1 ad key = utm.content', F.l1.ad, 'phone-video');
eq('l1 no-show from matched appointment', F.l1.noShow, true);
eq('l2 booked via appointment matched by last-10 phone', [F.l2.booked, F.l2.completed, F.l2.revenue, F.l2.value], [true, true, 600, 600]);
eq('l2 not contacted (no response stamp)', F.l2.responded, null);
eq('l3 untagged paid source label', F.l3.ad, 'facebook (untagged)');
eq('l3 old appointment before lead does NOT count', [F.l3.booked, F.l3.completed], [false, false]);
eq('l4 native Meta lead-ad label', F.l4.ad, 'meta ad 120212345');
eq('l5 lost', F.l5.lost, true);
eq('l6 booked via won status, value from AI quote, service from AI', [F.l6.booked, F.l6.bookedAt, F.l6.value, F.l6.service], [true, iso(7), 300, 'Full detail']);
eq('l6 source stays "call"', F.l6.source, 'call');

// ── metrics ──────────────────────────────────────────────────────────────────
const m = adv.computeMetrics({ facts, spendRows: db.get('ad_spend').value(), calls: db.get('calls').value(), now: NOW });
eq('this week leads', m.this_week.leads, 4);
eq('this week contacted', m.this_week.contacted, 2);
eq('this week booked (stageLog + appointment)', m.this_week.booked, 2);
eq('this week booked value', m.this_week.booked_value, 1050);
eq('this week completed revenue', m.this_week.completed_revenue, 600);
eq('this week no-shows', m.this_week.no_shows, 1);
eq('median minutes to contact (3m and 1440m → 722)', m.this_week.median_minutes_to_contact, 722);
eq('last week leads / booked / lost', [m.last_week.leads, m.last_week.booked, m.last_week.lost], [2, 1, 1]);
eq('30-day leads (excludes the 40-day-old one)', m.last_30_days.leads, 6);
// Spend: $300 over Sep 1–30 (30 days) = $10/day → 7 days in this week's window = $70,
// plus the lsa row (Sep 2–8 inclusive, $10/day) whose last day spills 6h past the
// Sep 8 18:00 window start = $2.50. Total $72.50.
eq('this week spend prorated from monthly row + weekly row spill', m.this_week.ad_spend, 72.5);
eq('this week cost per lead', m.this_week.cost_per_lead, 18.13);
eq('this week cost per booking', m.this_week.cost_per_booking, 36.25);
// last week window Sep 1 18:00 → Sep 8 18:00: 7 days of phone-video ($70) + lsa row Sep 2–8 inclusive (7 days, $10/day), overlap Sep 2 00:00 → Sep 8 18:00 = 6.75 days → $67.50
eq('last week spend = monthly proration + weekly row overlap', m.last_week.ad_spend, 137.5);
const ad = Object.fromEntries(m.by_ad_30d.map(a => [a.ad, a]));
// 30-day window Aug 16 18:00 → Sep 15 18:00 overlaps Sep 1 → Sep 15 18:00 = 14.75 days × $10.
eq('by_ad: phone-video groups two leads, spend matched by campaign name', [ad['phone-video'].leads, ad['phone-video'].booked, ad['phone-video'].ad_spend], [2, 2, 147.5]);
eq('by_ad: lsa spend matched via utm.campaign tag', ad['lsa'].ad_spend, 70);
eq('by_ad: untagged facebook has no spend', ad['facebook (untagged)'].ad_spend, null);
const src = Object.fromEntries(m.by_source_30d.map(s => [s.source, s]));
eq('by_source: call bucket', [src.call.leads, src.call.booked], [1, 1]);
eq('open leads: uncontacted 15+ min', m.open_leads.uncontacted_over_15_min, 1);
eq('open leads: oldest uncontacted is the hot one', [m.open_leads.oldest_uncontacted[0].id, m.open_leads.oldest_uncontacted[0].hot], ['l3', true]);
eq('open leads: contacted-not-booked 48h+', m.open_leads.contacted_not_booked_over_48h, 1);
eq('open leads: hot open', m.open_leads.hot_open, 1);
eq('calls this week', m.calls.this_week, { total: 2, missed: 1, ai_answered: 1 });
eq('data quality: spend entered', m.data_quality.spend_entered, true);
ok('flag: hot open lead', m.flags.some(f => /flagged 🔥 hot/.test(f)));
ok('flag: uncontacted', m.flags.some(f => /not contacted after 15\+ minutes/.test(f)));
ok('flag: stalled 48h', m.flags.some(f => /unbooked for 48h\+/.test(f)));
ok('flag: median contact time', m.flags.some(f => /median time to first contact is 722 min/.test(f)));
ok('no spend-missing flag when spend exists', !m.flags.some(f => /no ad spend entered/.test(f)));
ok('no missed-call flag when AI answered a call', !m.flags.some(f => /missed call/.test(f)));

// Daily budgets: $20/day from Sep 5 (date-only = midnight), still running → this
// week = 7 days = $140; last week (Sep 1 18:00 → Sep 8 18:00) = 3.75 days = $75;
// a stopped budget ($5/day, Sep 2 → Sep 4 inclusive) adds 3 days = $15 to last week.
const dailyRows = [
  { id: 'd1', campaign: 'phone-video', daily: 20, period_start: dstr(10), period_end: null },
  { id: 'd2', campaign: 'phone-video', daily: 5, period_start: dstr(13), period_end: dstr(11) },
];
const md = adv.computeMetrics({ facts, spendRows: dailyRows, calls: [], now: NOW });
eq('daily budget: this week = 7 days × $20', md.this_week.ad_spend, 140);
eq('daily budget: last week = 3.75 days × $20 + stopped budget 3 days × $5', md.last_week.ad_spend, 90);
eq('daily budget: 30 days = 10.75 days × $20 + $15', md.last_30_days.ad_spend, 230);
eq('daily budget: cost per booking this week', md.this_week.cost_per_booking, 70);
eq('daily budget: future start date contributes nothing yet', adv.spendIn([{ campaign: 'x', daily: 99, period_start: dstr(-3) }], NOW - 7 * 86400000, NOW + 1), null);

// Empty shop → no crash, sane nulls.
const e = adv.computeMetrics({ facts: [], spendRows: [], calls: [], now: NOW });
eq('empty: contact rate null, spend flag present', [e.this_week.contact_rate_pct, e.flags.includes('no ad spend entered, so cost metrics are unavailable')], [null, true]);

// ── prompt + store + feedback loop (model stubbed) ───────────────────────────
const fakeResult = {
  headline: 'Contact the hot lead today.', health: 'urgent',
  actions: [
    { title: 'Call the 3-hour-old hot lead now', owner: 'sales', category: 'speed_to_lead', why: '1 open lead flagged hot; 1 uncontacted 15+ min.', do_this: 'Call, then text.', measure: 'uncontacted_over_15_min → 0', impact: 'high', effort: 'low' },
    { title: 'Chase the stalled Meta lead', owner: 'sales', category: 'follow_up', why: '1 contacted lead unbooked 48h+.', do_this: 'Send the day-3 follow-up.', measure: 'contacted_not_booked_over_48h → 0', impact: 'medium', effort: 'low' },
  ],
  wins: ['2 of 4 leads booked this week'], watch: ['no-show on the ceramic tint booking'], data_gaps: [],
};
let captured = null;
const model = async (msg) => { captured = msg; return { result: fakeResult, usage: { input_tokens: 10, output_tokens: 5 } }; };
const shop = master.get('shops').find({ id: shopId }).value();
(async () => {
  const report = await adv.runAdvisor({ db, shop, playbook: 'PLAYBOOK LINE', trigger: 'manual', now: NOW, model });
  ok('prompt carries playbook', captured.includes('PLAYBOOK LINE'));
  ok('prompt carries per-shop notes', captured.includes('Owner only works Tue–Sat.'));
  ok('prompt carries metrics JSON', captured.includes('"uncontacted_over_15_min": 1'));
  ok('prompt says no feedback yet on the first run', captured.includes('(none yet)'));
  eq('report stored on the shop db', adv.loadStore(db).reports.length, 1);
  eq('report shape', [report.trigger, report.result.health, report.model === adv.MODEL, !!report.metrics.flags], ['manual', 'urgent', true, true]);
  eq('manual run does not stamp lastAutoRunAt', adv.loadStore(db).lastAutoRunAt, undefined);

  const fb = adv.recordFeedback(db, report.id, 1, { rating: 'not_helpful', note: 'we already text day 3' });
  eq('feedback recorded', [fb.rating, fb.note, fb.done], ['not_helpful', 'we already text day 3', false]);
  const fb2 = adv.recordFeedback(db, report.id, 1, { done: true });
  eq('feedback merges (rating kept, done set)', [fb2.rating, fb2.done], ['not_helpful', true]);
  let threw = false; try { adv.recordFeedback(db, 'nope', 0, { rating: 'helpful' }); } catch (_) { threw = true; }
  ok('feedback on unknown report throws', threw);
  const recent = adv.recentFeedback(adv.loadStore(db));
  eq('recentFeedback returns only rated/done actions with titles', [recent.length, recent[0].title, recent[0].rating, recent[0].done], [1, 'Chase the stalled Meta lead', 'not_helpful', true]);

  // Second run: past feedback reaches the prompt; auto trigger stamps the clock.
  await adv.runAdvisor({ db, shop, playbook: '', trigger: 'auto', now: NOW + 1000, model });
  ok('second prompt carries past feedback', captured.includes('we already text day 3'));
  ok('empty playbook renders as (empty)', captured.includes('PLAYBOOK\n(empty)'));
  eq('two reports kept, auto run stamped', [adv.loadStore(db).reports.length, adv.loadStore(db).lastAutoRunAt], [2, new Date(NOW + 1000).toISOString()]);

  // ── weekly auto-run gate ───────────────────────────────────────────────────
  eq('autoRunDue: off without API key', adv.autoRunDue(db, shop, 1, NOW + 8 * 86400000), false);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  eq('autoRunDue: not Monday', adv.autoRunDue(db, shop, 2, NOW + 8 * 86400000), false);
  eq('autoRunDue: Monday but ran < 6 days ago', adv.autoRunDue(db, shop, 1, NOW + 2 * 86400000), false);
  eq('autoRunDue: Monday, 8 days since auto run, recent leads', adv.autoRunDue(db, shop, 1, NOW + 8 * 86400000), true);
  eq('autoRunDue: shop opted out', adv.autoRunDue(db, { ...shop, advisorAuto: false }, 1, NOW + 8 * 86400000), false);
  eq('autoRunDue: no leads in 30 days', adv.autoRunDue(db, shop, 1, NOW + 100 * 86400000), false);
  delete process.env.ANTHROPIC_API_KEY;

  // ── admin routes ──────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use(require('../server/routes/admin'));
  const srv = app.listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port;
  const H = { 'x-admin-key': process.env.ADMIN_KEY || 'shopflow-admin', 'Content-Type': 'application/json' };
  const call = (method, p, body) => fetch(base + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));

  let r = await fetch(base + `/api/admin/shop/${shopId}/advisor`).then(x => x.status);
  eq('route: admin key required', r, 401);
  r = await call('GET', `/api/admin/shop/${shopId}/advisor`);
  eq('route GET: payload', [r.status, r.body.configured, r.body.leadCount, r.body.latest.result.health, r.body.history.length, r.body.spend.length, r.body.shopNotes, r.body.autoRun], [200, false, 7, 'urgent', 1, 2, 'Owner only works Tue–Sat.', true]);
  ok('route GET: latest report omits raw metrics but keeps flags', !r.body.latest.metrics && Array.isArray(r.body.latest.flags));
  r = await call('GET', `/api/admin/shop/${shopId}/advisor/report/${report.id}`);
  eq('route GET report: full metrics + stored feedback', [r.status, !!r.body.report.metrics.this_week, r.body.report.feedback['1'].rating], [200, true, 'not_helpful']);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/run`);
  eq('route run: 400 without API key', r.status, 400);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/feedback`, { reportId: report.id, actionIndex: 0, rating: 'helpful' });
  eq('route feedback', [r.status, r.body.feedback.rating], [200, 'helpful']);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/feedback`, { reportId: report.id, actionIndex: 0, rating: 'meh' });
  eq('route feedback: bad rating', r.status, 400);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/spend`, { campaign: 'phone-video', daily: '12.5', period_start: dstr(3) });
  eq('route spend add: daily budget, still running', [r.status, r.body.row.daily, r.body.row.period_end, r.body.row.source], [201, 12.5, null, 'facebook']);
  const rowId = r.body.row.id;
  db.read();   // the route writes through its own lowdb handle; refresh this one from disk
  eq('spend row landed in ad_spend (shared with marketing analytics)', db.get('ad_spend').value().length, 3);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/spend`, { campaign: '', daily: 5, period_start: dstr(0) });
  eq('route spend: campaign required', r.status, 422);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/spend`, { campaign: 'x', daily: 5, period_start: dstr(0), period_end: dstr(2) });
  eq('route spend: end before start rejected', r.status, 422);
  r = await call('PATCH', `/api/admin/shop/${shopId}/advisor/spend/${rowId}`, { period_end: dstr(1) });
  eq('route spend stop: end date set', [r.status, r.body.row.period_end], [200, dstr(1)]);
  r = await call('PATCH', `/api/admin/shop/${shopId}/advisor/spend/${rowId}`, { period_end: dstr(9) });
  eq('route spend stop: end before start rejected', r.status, 422);
  r = await call('DELETE', `/api/admin/shop/${shopId}/advisor/spend/${rowId}`);
  db.read();
  eq('route spend delete', [r.status, db.get('ad_spend').value().length], [200, 2]);
  r = await call('GET', '/api/admin/advisor/playbook');
  eq('route playbook: default until saved', [r.status, r.body.isDefault, r.body.playbook === adv.DEFAULT_PLAYBOOK], [200, true, true]);
  r = await call('PATCH', '/api/admin/advisor/playbook', { playbook: '# mine' });
  r = await call('GET', '/api/admin/advisor/playbook');
  eq('route playbook: saved', [r.body.isDefault, r.body.playbook], [false, '# mine']);
  r = await call('PATCH', `/api/admin/shop/${shopId}`, { advisorNotes: 'new notes', advisorAuto: false });
  const s2 = master.get('shops').find({ id: shopId }).value();
  eq('shop PATCH: advisorNotes + advisorAuto persisted', [r.status, s2.advisorNotes, s2.advisorAuto], [200, 'new notes', false]);
  r = await call('GET', `/api/admin/shop/nope/advisor`);
  eq('route: unknown shop 404', r.status, 404);
  srv.close();

  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

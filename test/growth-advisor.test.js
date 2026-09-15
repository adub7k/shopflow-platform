// Growth Advisor (server/advisor/growthAdvisor.js + the admin routes).
// Run: node test/growth-advisor.test.js
//
// Covers: the adapter from ShopFlow's real lead records (nested utm, stageLog,
// firstResponseAt, appointment/estimate matching by phone, shop-local dates),
// timezone-exact window resolution (presets, custom dates, DST days), the
// funnel metrics, daily-budget + legacy-total spend accounting, flags, the
// report/feedback store, the weekly auto-run gate, and the admin endpoints —
// with the model call stubbed, so no API key or network is needed.
//
// Two layers of proof: hand-derived expectations for each rule, then a
// BRUTE-FORCE RECONCILIATION that recomputes every window from first
// principles (simple loops over the raw records) and requires the module to
// match, plus internal consistency (breakdowns sum to totals).
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
const near = (name, got, exp, tol = 0.011) => { const good = (got == null && exp == null) || (got != null && exp != null && Math.abs(got - exp) <= tol); if (!good) failures++; console.log(`${good ? 'PASS' : 'FAIL'}  ${name}${good ? '' : `  got=${got} exp=${exp}`}`); };

const TZ = 'America/Denver';
const DAY = 86400000;
const NOW = Date.parse('2026-09-15T18:00:00.000Z');       // Tue Sep 15, 12:00 Denver (MDT, UTC-6)
const iso = (daysAgo, h = 0) => new Date(NOW - daysAgo * DAY - h * 3600000).toISOString();
const dstr = (daysAgo) => adv.localDate(NOW - daysAgo * DAY, TZ);   // shop-local calendar date

// ── timezone helpers ─────────────────────────────────────────────────────────
eq('localMidnight: Denver Sep 1 = 06:00Z (MDT)', new Date(adv.localMidnight('2026-09-01', TZ)).toISOString(), '2026-09-01T06:00:00.000Z');
eq('localMidnight: Dec 1 = 07:00Z (MST)', new Date(adv.localMidnight('2026-12-01', TZ)).toISOString(), '2026-12-01T07:00:00.000Z');
eq('DST end: Nov 1 is a 25h day', (adv.localMidnight('2026-11-02', TZ) - adv.localMidnight('2026-11-01', TZ)) / 3600000, 25);
eq('DST start: Mar 8 is a 23h day', (adv.localMidnight('2026-03-09', TZ) - adv.localMidnight('2026-03-08', TZ)) / 3600000, 23);
eq('localDate: 11pm Denver is still that date (04:30Z next day)', adv.localDate(Date.parse('2026-09-16T04:30:00Z'), TZ), '2026-09-15');
eq('localDate: UTC shop', adv.localDate(Date.parse('2026-09-16T04:30:00Z'), 'UTC'), '2026-09-16');

// ── window resolution ────────────────────────────────────────────────────────
let w = adv.resolveWindow({ preset: '7d', tz: TZ, now: NOW });
eq('7d preset: today + 6 prior days, partial today, equal prior window', [w.from, w.to, w.days, w.partial, w.prior.from, w.prior.to], ['2026-09-09', '2026-09-15', 7, true, '2026-09-02', '2026-09-08']);
eq('7d preset: bounds are local midnights; to clipped to now', [new Date(w.fromMs).toISOString(), w.toMs], ['2026-09-09T06:00:00.000Z', NOW + 1]);
w = adv.resolveWindow({ preset: 'this_month', tz: TZ, now: NOW });
eq('this_month', [w.from, w.to, w.days], ['2026-09-01', '2026-09-15', 15]);
w = adv.resolveWindow({ preset: 'last_month', tz: TZ, now: NOW });
eq('last_month + its prior', [w.from, w.to, w.days, w.partial, w.prior.from, w.prior.to], ['2026-08-01', '2026-08-31', 31, false, '2026-07-01', '2026-07-31']);
eq('last_month: to bound is local midnight Sep 1', new Date(w.toMs).toISOString(), '2026-09-01T06:00:00.000Z');
w = adv.resolveWindow({ from: '2026-08-10', to: '2026-08-12', tz: TZ, now: NOW });
eq('custom 3 days + prior 3 days', [w.preset, w.days, w.label, w.prior.from, w.prior.to], ['custom', 3, 'Aug 10, 2026 – Aug 12, 2026 (3 days)', '2026-08-07', '2026-08-09']);
w = adv.resolveWindow({ from: '2026-09-10', to: '2026-09-30', tz: TZ, now: NOW });
eq('custom: future "to" clipped to today', [w.to, w.days, w.partial], ['2026-09-15', 6, true]);
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
ok('custom: to before from throws', throws(() => adv.resolveWindow({ from: '2026-09-10', to: '2026-09-01', tz: TZ, now: NOW })));
ok('custom: from in the future throws', throws(() => adv.resolveWindow({ from: '2026-10-01', to: '2026-10-05', tz: TZ, now: NOW })));
ok('custom: only one date throws', throws(() => adv.resolveWindow({ from: '2026-09-01', tz: TZ, now: NOW })));
ok('custom: > 366 days throws', throws(() => adv.resolveWindow({ from: '2024-01-01', to: '2026-09-01', tz: TZ, now: NOW })));
ok('custom: garbage date throws', throws(() => adv.resolveWindow({ from: '2026-02-31x', to: '2026-03-01', tz: TZ, now: NOW })));

// ── fixture shop ─────────────────────────────────────────────────────────────
const shopId = 'shoptest_adv';
master.get('shops').push({ id: shopId, accountId: 'acct_adv', shopName: 'Adv Test Tint', slug: 'adv-test', industry: 'detail', active: true, advisorNotes: 'Owner only works Tue–Sat.' }).write();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'Adv Test Tint', timezone: TZ, pipeline: { stages: [
  { key: 'new', label: 'New' }, { key: 'contacted', label: 'Contacted' }, { key: 'booked', label: 'Booked', won: true }, { key: 'closed', label: 'Closed', won: true, terminal: true }, { key: 'lost', label: 'Lost', terminal: true },
] } }).write();
db.set('customers', [{ id: 'cB', name: 'Booked Via Appt', phone: '+15055550002' }]).write();
db.set('leads', [
  // period (last 7d): form lead, tagged ad, responded in 3 min, booked via stageLog, quoted $450
  { id: 'l1', name: 'Fast', phone: '5055550001', createdAt: iso(1), firstResponseAt: iso(1, -0.05), status: 'booked', quotedAmount: 450, source: 'facebook',
    utm: { source: 'facebook', campaign: 'Tint Offer', content: 'phone-video' }, servicesInterested: ['Ceramic tint'],
    stageLog: [{ from: 'new', to: 'contacted', at: iso(1, -0.05) }, { from: 'contacted', to: 'booked', at: iso(0, 20) }] },
  // period: no response stamp, still 'new' — but an appointment exists for the phone (booked outside the pipeline)
  { id: 'l2', name: 'ApptMatch', phone: '(505) 555-0002', createdAt: iso(2), status: 'new', source: 'website', utm: { source: 'facebook', campaign: 'Tint Offer', content: 'phone-video' } },
  // period: untagged paid lead, uncontacted, hot
  { id: 'l3', name: 'Hot', phone: '5055550003', createdAt: iso(0, 3), status: 'new', source: 'facebook', hot: true },
  // period: native Meta lead-ad, contacted 2 days ago, not booked → stalled
  { id: 'l4', name: 'Stalled', phone: '5055550004', createdAt: iso(4), firstResponseAt: iso(3), status: 'contacted', source: 'facebook', utm: { source: 'facebook', medium: 'lead-ad', campaign: '120212345', content: 'form9' } },
  // prior period: lost
  { id: 'l5', name: 'Lost', phone: '5055550005', createdAt: iso(10), firstResponseAt: iso(10, -1), status: 'lost', lostAt: iso(8), lostReason: 'price', source: 'google', utm: { source: 'google', campaign: 'lsa' } },
  // prior period: call lead, AI quoted $300, booked (status only, no stageLog)
  { id: 'l6', name: 'Caller', phone: '5055550006', createdAt: iso(9), status: 'closed', stageChangedAt: iso(7), source: 'call', ai: { source: 'voice', quotedPrice: 300, serviceNeeded: 'Full detail' } },
  // 40 days ago: outside every trailing window
  { id: 'l7', name: 'Old', phone: '5055550007', createdAt: iso(40), status: 'new', source: 'website' },
  // BOUNDARY: created 11:30pm Denver on the last day of the prior period (Sep 8) = 05:30Z Sep 9.
  // UTC-date math would put this in the current period; shop-local math keeps it in the prior one.
  { id: 'l8', name: 'LateNight', phone: '5055550008', createdAt: '2026-09-09T05:30:00.000Z', status: 'new', source: 'website' },
]).write();
db.set('appointments', [
  { id: 'a1', customerId: 'cB', customerPhone: '+15055550002', status: 'done', price: 600, date: dstr(0), createdAt: iso(1), source: 'booking-page' },
  { id: 'a2', customerId: 'cX', customerPhone: '+15055550001', status: 'no-show', price: 450, date: dstr(0), createdAt: iso(0, 10), source: 'booking-page' },
  // appointment BEFORE the lead came in — must not count as this lead's booking
  { id: 'a0', customerId: 'cY', customerPhone: '+15055550003', status: 'done', price: 999, date: dstr(60), createdAt: iso(60) },
  // BOUNDARY: l8 was created 11:30pm Sep 8 local; this appointment is dated Sep 8 local — same day, so it counts.
  { id: 'a8', customerId: 'c8', customerPhone: '+15055550008', status: 'confirmed', price: 200, date: '2026-09-08', createdAt: '2026-09-09T05:45:00.000Z' },
]).write();
db.set('quotes', []).write();
db.set('calls', [
  { id: 'c1', startedAt: iso(1), missed: true, leadId: 'l6' },
  { id: 'c2', startedAt: iso(2), voiceAI: true },
]).write();
// Budgets: $20/day on phone-video from Sep 5, still running; $5/day stopped budget Sep 2–4;
// a legacy TOTAL row: $70 on lsa spread over Sep 2–8 (7 days = $10/day).
db.set('ad_spend', [
  { id: 'd1', campaign: 'phone-video', source: 'facebook', daily: 20, period_start: '2026-09-05', period_end: null },
  { id: 'd2', campaign: 'phone-video', source: 'facebook', daily: 5, period_start: '2026-09-02', period_end: '2026-09-04' },
  { id: 's2', campaign: 'lsa', source: 'google', amount: 70, period_start: '2026-09-02', period_end: '2026-09-08' },
]).write();

// ── adapter ──────────────────────────────────────────────────────────────────
const facts = adv.leadFacts(db);
const F = Object.fromEntries(facts.map(f => [f.id, f]));
eq('facts: every lead adapted', facts.length, 8);
eq('l1 responded from firstResponseAt', F.l1.respondedAt, iso(1, -0.05));
eq('l1 booked via stageLog at the booked transition', [F.l1.booked, F.l1.bookedAt], [true, iso(0, 20)]);
eq('l1 value = owner quotedAmount', F.l1.value, 450);
eq('l1 ad key = utm.content', F.l1.ad, 'phone-video');
eq('l1 no-show from matched appointment', F.l1.noShow, true);
eq('l2 booked via appointment matched by last-10 phone', [F.l2.booked, F.l2.completed, F.l2.revenue, F.l2.value], [true, true, 600, 600]);
eq('l2 not contacted (no response stamp)', F.l2.responded, null);
eq('l3 untagged paid source label', F.l3.ad, 'facebook (untagged)');
eq('l3 old appointment before lead does NOT count', [F.l3.booked, F.l3.completed], [false, false]);
eq('l4 native Meta lead-ad groups by ad id', F.l4.ad, 'meta ad 120212345');
eq('l5 lost', F.l5.lost, true);
eq('l6 booked via won status, value from AI quote, service from AI', [F.l6.booked, F.l6.bookedAt, F.l6.value, F.l6.service], [true, iso(7), 300, 'Full detail']);
eq('l6 source stays "call"', F.l6.source, 'call');
eq('l8 createdDate is the shop-local date (Sep 8), not the UTC date (Sep 9)', F.l8.createdDate, '2026-09-08');
eq('l8 same-local-day appointment counts as its booking', [F.l8.booked, F.l8.value], [true, 200]);

// ── metrics: default 7d window ───────────────────────────────────────────────
const spendRows = db.get('ad_spend').value(), calls = db.get('calls').value();
const W7 = adv.resolveWindow({ preset: '7d', tz: TZ, now: NOW });
const m = adv.computeMetrics({ facts, spendRows, calls, now: NOW, tz: TZ, window: W7 });
eq('window echoed in metrics', [m.window.period.from, m.window.period.to, m.window.prior_period.from, m.window.prior_period.to, m.window.timezone], ['2026-09-09', '2026-09-15', '2026-09-02', '2026-09-08', TZ]);
eq('period leads (l1–l4; l8 stays in prior)', m.period.leads, 4);
eq('period contacted', m.period.contacted, 2);
eq('period booked (stageLog + appointment)', m.period.booked, 2);
eq('period booked value', m.period.booked_value, 1050);
eq('period completed revenue', m.period.completed_revenue, 600);
eq('period no-shows', m.period.no_shows, 1);
eq('median minutes to contact (3m and 1440m → 722)', m.period.median_minutes_to_contact, 722);
eq('prior period leads / booked / lost (l5, l6, l8)', [m.prior_period.leads, m.prior_period.booked, m.prior_period.lost], [3, 2, 1]);
eq('30-day leads (excludes the 40-day-old one)', m.last_30_days.leads, 7);
// Spend, shop-local days. Period = Sep 9 00:00 → Sep 15 12:00 local: d1 6 full days + half of Sep 15 = 6.5 × $20 = $130.
eq('period spend: 6.5 local days × $20', m.period.ad_spend, 130);
eq('period cost per lead', m.period.cost_per_lead, 32.5);
eq('period cost per booking', m.period.cost_per_booking, 65);
// Prior = Sep 2–8 local: d1 Sep 5–8 = 4 × $20 = $80; d2 Sep 2–4 = 3 × $5 = $15; lsa total $70 over Sep 2–8 fully inside = $70. Total $165.
eq('prior spend: running budget + stopped budget + legacy total', m.prior_period.ad_spend, 165);
// 30 days = Aug 17 → Sep 15 12:00: d1 10.5 × 20 = 210; d2 15; lsa 70 → 295.
eq('30-day spend', m.last_30_days.ad_spend, 295);
const ad = Object.fromEntries(m.by_ad.map(a => [a.ad, a]));
eq('by_ad: phone-video groups two leads, spend matched by campaign name (period only)', [ad['phone-video'].leads, ad['phone-video'].booked, ad['phone-video'].ad_spend], [2, 2, 130]);
eq('by_ad: untagged facebook has no spend', ad['facebook (untagged)'].ad_spend, null);
eq('by_ad rows sum to period leads', m.by_ad.reduce((s, a) => s + a.leads, 0), m.period.leads);
eq('by_source rows sum to period leads', m.by_source.reduce((s, a) => s + a.leads, 0), m.period.leads);
eq('by_service rows sum to period leads', m.by_service.reduce((s, a) => s + a.leads, 0), m.period.leads);
eq('open leads: uncontacted 15+ min (l3; l8 is booked)', m.open_leads.uncontacted_over_15_min, 1);
eq('open leads: oldest uncontacted is the hot one', [m.open_leads.oldest_uncontacted[0].id, m.open_leads.oldest_uncontacted[0].hot], ['l3', true]);
eq('open leads: contacted-not-booked 48h+', m.open_leads.contacted_not_booked_over_48h, 1);
eq('calls this period', m.calls.period, { total: 2, missed: 1, ai_answered: 1 });
ok('flag: hot open lead', m.flags.some(f => /flagged 🔥 hot/.test(f)));
ok('flag: uncontacted', m.flags.some(f => /not contacted after 15\+ minutes/.test(f)));
ok('flag: stalled 48h', m.flags.some(f => /unbooked for 48h\+/.test(f)));
ok('flag: median contact time', m.flags.some(f => /median time to first contact is 722 min/.test(f)));
ok('no budget-missing flag when budgets exist', !m.flags.some(f => /no ad budget entered/.test(f)));

// ── metrics: custom historical period (cohort semantics) ────────────────────
const Wc = adv.resolveWindow({ from: '2026-09-05', to: '2026-09-08', tz: TZ, now: NOW });
const mc = adv.computeMetrics({ facts, spendRows, calls, now: NOW, tz: TZ, window: Wc });
eq('custom Sep 5–8: leads created in it (l5 Sep 5, l6 Sep 6, l8 Sep 8)', mc.period.leads, 3);
eq('custom: outcomes to date — l6 booked Sep 8, l8 booked; l5 lost', [mc.period.booked, mc.period.lost], [2, 1]);
eq('custom: prior = Sep 1–4 has no leads', mc.prior_period.leads, 0);
eq('custom: spend Sep 5–8 = 4 × $20 + lsa 4/7 × $70', mc.period.ad_spend, 120);
eq('custom: prior spend Sep 1–4 = d2 $15 + lsa 3/7 × $70', mc.prior_period.ad_spend, 45);
eq('custom: open-lead worklist unchanged (as of now)', mc.open_leads.uncontacted_over_15_min, 1);
eq('custom: by_ad only period leads', mc.by_ad.reduce((s, a) => s + a.leads, 0), 3);

// ── spend edge cases ─────────────────────────────────────────────────────────
const winFrom = adv.localMidnight('2026-09-09', TZ), winTo = NOW + 1;
eq('spend: future start contributes nothing', adv.spendIn([{ campaign: 'x', daily: 99, period_start: '2026-09-18' }], winFrom, winTo, TZ), null);
eq('spend: budget stopped before window contributes nothing', adv.spendIn([{ campaign: 'x', daily: 99, period_start: '2026-08-01', period_end: '2026-09-08' }], winFrom, winTo, TZ), null);
eq('spend: budget ending on the first window day counts that one day', adv.spendIn([{ campaign: 'x', daily: 40, period_start: '2026-08-01', period_end: '2026-09-09' }], winFrom, winTo, TZ), 40);
eq('spend: a full local day on a DST-end day is still one day', adv.spendIn([{ campaign: 'x', daily: 24, period_start: '2026-11-01', period_end: '2026-11-01' }], adv.localMidnight('2026-11-01', TZ), adv.localMidnight('2026-11-02', TZ), TZ), 24);
eq('spend: legacy total with end before start is treated as one day', adv.spendIn([{ campaign: 'x', amount: 50, period_start: '2026-09-10', period_end: '2026-09-01' }], winFrom, winTo, TZ), 50);
eq('spend: bad date ignored', adv.spendIn([{ campaign: 'x', daily: 50, period_start: 'soon' }], winFrom, winTo, TZ), null);
eq('spend: $0 budget counts as entered but adds nothing', adv.spendIn([{ campaign: 'x', daily: 0, period_start: '2026-09-01' }], winFrom, winTo, TZ), 0);

// ── BRUTE-FORCE RECONCILIATION ───────────────────────────────────────────────
// Recompute every window from the raw records with the dumbest possible loops
// and demand equality with the module. Runs over several windows including
// ones that cross the DST change and the year boundary.
function bruteWindow(win) {
  const leadsRaw = db.get('leads').value(), appts = db.get('appointments').value();
  const won = new Set(['booked', 'closed']);
  const inRange = (t) => t >= win.fromMs && t < win.toMs;
  const rows = leadsRaw.filter(l => inRange(Date.parse(l.createdAt)));
  const isBooked = (l) => {
    if ((l.stageLog || []).some(s => won.has(s.to)) || won.has(l.status)) return true;
    const ld = adv.localDate(Date.parse(l.createdAt), TZ), p10 = String(l.phone).replace(/\D/g, '').slice(-10);
    return appts.some(a => String(a.customerPhone).replace(/\D/g, '').slice(-10) === p10 && a.date >= ld && !['cancelled', 'canceled', 'declined'].includes(a.status));
  };
  const contacted = rows.filter(l => l.firstResponseAt).length;
  // spend: per row, per day, per overlap
  let spend = 0, any = false;
  spendRows.forEach(r => {
    const perDay = r.daily != null ? r.daily : r.amount / ((Date.parse(r.period_end) - Date.parse(r.period_start)) / DAY + 1);
    for (let d = r.period_start; (r.period_end == null || d <= r.period_end) && Date.parse(d) < win.toMs + 2 * DAY; d = adv.addDays(d, 1)) {
      const s = adv.localMidnight(d, TZ), e = adv.localMidnight(adv.addDays(d, 1), TZ);
      const ov = Math.min(e, win.toMs) - Math.max(s, win.fromMs);
      if (ov > 0) { any = true; spend += perDay * ov / (e - s); }
    }
  });
  return { leads: rows.length, contacted, booked: rows.filter(isBooked).length, lost: rows.filter(l => l.status === 'lost').length, spend: any ? Math.round(spend * 100) / 100 : null };
}
const windows = [
  ['7d', adv.resolveWindow({ preset: '7d', tz: TZ, now: NOW })],
  ['14d', adv.resolveWindow({ preset: '14d', tz: TZ, now: NOW })],
  ['this_month', adv.resolveWindow({ preset: 'this_month', tz: TZ, now: NOW })],
  ['custom Sep 8 only', adv.resolveWindow({ from: '2026-09-08', to: '2026-09-08', tz: TZ, now: NOW })],
  ['custom Sep 9 only', adv.resolveWindow({ from: '2026-09-09', to: '2026-09-09', tz: TZ, now: NOW })],
  ['custom Aug 10 – Sep 15', adv.resolveWindow({ from: '2026-08-10', to: '2026-09-15', tz: TZ, now: NOW })],
];
windows.forEach(([name, win]) => {
  const got = adv.computeMetrics({ facts, spendRows, calls, now: NOW, tz: TZ, window: win });
  const exp = bruteWindow(win), expPrior = bruteWindow(win.prior);
  eq(`reconcile ${name}: period leads/contacted/booked/lost`, [got.period.leads, got.period.contacted, got.period.booked, got.period.lost], [exp.leads, exp.contacted, exp.booked, exp.lost]);
  near(`reconcile ${name}: period spend`, got.period.ad_spend, exp.spend);
  eq(`reconcile ${name}: prior leads/booked`, [got.prior_period.leads, got.prior_period.booked], [expPrior.leads, expPrior.booked]);
  near(`reconcile ${name}: prior spend`, got.prior_period.ad_spend, expPrior.spend);
  eq(`reconcile ${name}: breakdowns sum to period leads`, [got.by_ad.reduce((s, a) => s + a.leads, 0), got.by_source.reduce((s, a) => s + a.leads, 0)], [got.period.leads, got.period.leads]);
  ok(`reconcile ${name}: period and prior are disjoint and adjacent`, win.prior.toMs === win.fromMs && win.prior.fromMs < win.prior.toMs);
});
// DST + year-boundary windows with a synthetic daily budget: a 31-day January
// in MST and a November window containing the 25-hour day must both count
// exactly one budget-day per calendar day.
const NOW2 = Date.parse('2026-11-20T20:00:00Z');
const wNov = adv.resolveWindow({ from: '2026-10-25', to: '2026-11-07', tz: TZ, now: NOW2 });
eq('DST window: 14 calendar days × $10 = $140 despite the 25h day', adv.spendIn([{ campaign: 'x', daily: 10, period_start: '2026-10-01' }], wNov.fromMs, wNov.toMs, TZ), 140);
const wJan = adv.resolveWindow({ from: '2026-01-01', to: '2026-01-31', tz: TZ, now: NOW2 });
eq('year-boundary window: prior is Dec 1–31 of the previous year', [wJan.prior.from, wJan.prior.to, wJan.days], ['2025-12-01', '2025-12-31', 31]);
eq('year-boundary spend: 31 × $3', adv.spendIn([{ campaign: 'x', daily: 3, period_start: '2025-12-15', period_end: '2026-02-01' }], wJan.fromMs, wJan.toMs, TZ), 93);

// Empty shop → no crash, sane nulls.
const e = adv.computeMetrics({ facts: [], spendRows: [], calls: [], now: NOW, tz: TZ });
eq('empty: contact rate null, budget flag present', [e.period.contact_rate_pct, e.flags.includes('no ad budget entered, so cost metrics are unavailable')], [null, true]);

// ── prompt + store + feedback loop (model stubbed) ───────────────────────────
const fakeResult = {
  headline: 'Contact the hot lead today.', health: 'urgent',
  actions: [
    { title: 'Call the 3-hour-old hot lead now', owner: 'sales', category: 'speed_to_lead', why: '1 open lead flagged hot; 1 uncontacted 15+ min.', do_this: 'Call, then text.', measure: 'uncontacted_over_15_min → 0', impact: 'high', effort: 'low' },
    { title: 'Chase the stalled Meta lead', owner: 'sales', category: 'follow_up', why: '1 contacted lead unbooked 48h+.', do_this: 'Send the day-3 follow-up.', measure: 'contacted_not_booked_over_48h → 0', impact: 'medium', effort: 'low' },
  ],
  wins: ['2 of 4 leads booked this period'], watch: ['no-show on the ceramic tint booking'], data_gaps: [],
};
let captured = null;
const model = async (msg) => { captured = msg; return { result: fakeResult, usage: { input_tokens: 10, output_tokens: 5 } }; };
const shop = master.get('shops').find({ id: shopId }).value();
(async () => {
  const report = await adv.runAdvisor({ db, shop, playbook: 'PLAYBOOK LINE', range: { from: '2026-09-01', to: '2026-09-14' }, trigger: 'manual', now: NOW, model });
  ok('prompt carries playbook', captured.includes('PLAYBOOK LINE'));
  ok('prompt carries per-shop notes', captured.includes('Owner only works Tue–Sat.'));
  ok('prompt names the period and timezone', captured.includes('Period: Sep 1, 2026 – Sep 14, 2026 (14 days)') && captured.includes('timezone America/Denver'));
  ok('prompt carries metrics JSON', captured.includes('"uncontacted_over_15_min": 1'));
  ok('prompt says no feedback yet on the first run', captured.includes('(none yet)'));
  eq('report stored on the shop db', adv.loadStore(db).reports.length, 1);
  eq('report shape', [report.trigger, report.result.health, report.model === adv.MODEL, !!report.metrics.flags, report.window.from, report.window.to, report.window.days], ['manual', 'urgent', true, true, '2026-09-01', '2026-09-14', 14]);
  eq('manual run does not stamp lastAutoRunAt', adv.loadStore(db).lastAutoRunAt, undefined);

  const fb = adv.recordFeedback(db, report.id, 1, { rating: 'not_helpful', note: 'we already text day 3' });
  eq('feedback recorded', [fb.rating, fb.note, fb.done], ['not_helpful', 'we already text day 3', false]);
  const fb2 = adv.recordFeedback(db, report.id, 1, { done: true });
  eq('feedback merges (rating kept, done set)', [fb2.rating, fb2.done], ['not_helpful', true]);
  ok('feedback on unknown report throws', throws(() => adv.recordFeedback(db, 'nope', 0, { rating: 'helpful' })));
  const recent = adv.recentFeedback(adv.loadStore(db));
  eq('recentFeedback returns only rated/done actions with titles + period', [recent.length, recent[0].title, recent[0].rating, recent[0].done, recent[0].period], [1, 'Chase the stalled Meta lead', 'not_helpful', true, 'Sep 1, 2026 – Sep 14, 2026 (14 days)']);

  // Second run (default 7d): past feedback reaches the prompt; auto trigger stamps the clock.
  await adv.runAdvisor({ db, shop, playbook: '', trigger: 'auto', now: NOW + 1000, model });
  ok('second prompt carries past feedback', captured.includes('we already text day 3'));
  ok('empty playbook renders as (empty)', captured.includes('PLAYBOOK\n(empty)'));
  eq('two reports kept, auto run stamped, default window is 7d', [adv.loadStore(db).reports.length, adv.loadStore(db).lastAutoRunAt, adv.loadStore(db).reports[1].window.preset], [2, new Date(NOW + 1000).toISOString(), '7d']);

  // ── weekly auto-run gate ───────────────────────────────────────────────────
  eq('autoRunDue: off without API key', adv.autoRunDue(db, shop, 1, NOW + 8 * DAY), false);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  eq('autoRunDue: not Monday', adv.autoRunDue(db, shop, 2, NOW + 8 * DAY), false);
  eq('autoRunDue: Monday but ran < 6 days ago', adv.autoRunDue(db, shop, 1, NOW + 2 * DAY), false);
  eq('autoRunDue: Monday, 8 days since auto run, recent leads', adv.autoRunDue(db, shop, 1, NOW + 8 * DAY), true);
  eq('autoRunDue: shop opted out', adv.autoRunDue(db, { ...shop, advisorAuto: false }, 1, NOW + 8 * DAY), false);
  eq('autoRunDue: no leads in 30 days', adv.autoRunDue(db, shop, 1, NOW + 100 * DAY), false);
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
  eq('route GET: payload (default 7d)', [r.status, r.body.configured, r.body.leadCount, r.body.window.preset, r.body.window.days, r.body.tz, r.body.latest.result.health, r.body.history.length, r.body.spend.length, r.body.shopNotes, r.body.autoRun], [200, false, 8, '7d', 7, TZ, 'urgent', 1, 3, 'Owner only works Tue–Sat.', true]);
  ok('route GET: latest report omits raw metrics but keeps flags + window', !r.body.latest.metrics && Array.isArray(r.body.latest.flags) && r.body.latest.window.preset === '7d');
  ok('route GET: history rows carry their window', r.body.history[0].window.from === '2026-09-01');
  r = await call('GET', `/api/admin/shop/${shopId}/advisor?preset=last_month`);
  eq('route GET ?preset=last_month', [r.body.window.preset, r.body.window.from, r.body.window.to, r.body.metrics.period.leads], ['last_month', '2026-08-01', '2026-08-31', 1]);
  r = await call('GET', `/api/admin/shop/${shopId}/advisor?from=2026-09-05&to=2026-09-08`);
  eq('route GET ?from&to', [r.body.window.preset, r.body.window.days, r.body.metrics.period.leads, r.body.metrics.period.ad_spend], ['custom', 4, 3, 120]);
  r = await call('GET', `/api/admin/shop/${shopId}/advisor?from=2026-09-08&to=2026-09-01`);
  eq('route GET: bad range → 422', r.status, 422);
  r = await call('GET', `/api/admin/shop/${shopId}/advisor/report/${report.id}`);
  eq('route GET report: full metrics + stored feedback + window', [r.status, !!r.body.report.metrics.period, r.body.report.feedback['1'].rating, r.body.report.window.days], [200, true, 'not_helpful', 14]);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/run`);
  eq('route run: 400 without API key', r.status, 400);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/run`, { from: '2026-09-09', to: '2026-09-01' });
  eq('route run: bad range → 422 before any model call', r.status, 422);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/feedback`, { reportId: report.id, actionIndex: 0, rating: 'helpful' });
  eq('route feedback', [r.status, r.body.feedback.rating], [200, 'helpful']);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/feedback`, { reportId: report.id, actionIndex: 0, rating: 'meh' });
  eq('route feedback: bad rating', r.status, 400);
  r = await call('POST', `/api/admin/shop/${shopId}/advisor/spend`, { campaign: 'phone-video', daily: '12.5', period_start: dstr(3) });
  eq('route spend add: daily budget, still running', [r.status, r.body.row.daily, r.body.row.period_end, r.body.row.source], [201, 12.5, null, 'facebook']);
  const rowId = r.body.row.id;
  db.read();   // the route writes through its own lowdb handle; refresh this one from disk
  eq('spend row landed in ad_spend (shared with marketing analytics)', db.get('ad_spend').value().length, 4);
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
  eq('route spend delete', [r.status, db.get('ad_spend').value().length], [200, 3]);
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

// Integration test for the weekly revenue tracker: GET /api/shop/revenue
// returns `weekly` — Monday–Sunday buckets of completed jobs by appointment
// date, this week's day-by-day split (done vs still booked), what's left on
// the books this week, the projection, and the goal (weekly setting, else the
// monthly goal spread over 52 weeks).
// Run: node test/revenue-weekly.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-weekly-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, JWT_SECRET, today } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shoptest_wk', ownerId = 'acct_owner_wk';
master.get('shops').push({ id: shopId, accountId: ownerId, shopName: 'Weekly Test', slug: 'weekly-test', industry: 'detail', active: true }).write();
master.get('accounts').push({ id: ownerId, shopId, email: 'owner@wk.test', name: 'Me', role: 'full', active: true }).write();

const td = today();
const toDate = d => new Date(d + 'T00:00:00Z');
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const mon = (() => { const d = toDate(td); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return ymd(d); })();
const sun = addDays(mon, 6), lastMon = addDays(mon, -7), tenWeeksAgo = addDays(mon, -70);

const db = getShopDb(shopId);
db.set('settings', { shopName: 'Weekly Test', loyalty: { enabled: false }, revenueGoal: 13000 }).write(); // → 3000/wk
db.set('services', []).write(); db.set('barbers', []).write(); db.set('expenses', []).write(); db.set('customers', []).write(); db.set('quotes', []).write(); db.set('leads', []).write();
db.set('appointments', [
  // This week: two done (Mon $400, today $250 w/ $50 cost), one booked later this week ($300), one cancelled (ignored)
  { id: 'a1', date: mon, time: '9:00 AM', status: 'done', price: 400, cost: 0 },
  { id: 'a2', date: td, time: '1:00 PM', status: 'done', price: 250, cost: 50 },
  { id: 'a3', date: sun, time: '10:00 AM', status: 'confirmed', price: 300 },
  { id: 'a4', date: sun, time: '11:00 AM', status: 'cancelled', price: 999 },
  // Last week: one done $500
  { id: 'a5', date: addDays(lastMon, 2), time: '9:00 AM', status: 'done', price: 500 },
  // Ten weeks ago: the best week, $900
  { id: 'a6', date: tenWeeksAgo, time: '9:00 AM', status: 'done', price: 900 },
  // Twenty weeks ago: outside the 12-week window
  { id: 'a7', date: addDays(mon, -140), time: '9:00 AM', status: 'done', price: 5000 },
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
    let w = (await get('/api/shop/revenue')).weekly;
    const tw = w.thisWeek;
    eq('12 weeks, oldest first, current last', [w.weeks.length, w.weeks[11].start, w.weeks[0].start], [12, mon, addDays(mon, -77)]);
    eq('week bounds Mon–Sun', [tw.start, tw.end], [mon, sun]);
    eq('this week revenue = done only', [tw.revenue, tw.jobs, tw.cost, tw.gross], [650, 2, 50, 600]);
    eq('on the books excludes cancelled', [tw.booked, tw.bookedJobs], [300, 1]);
    eq('projected = done + booked', tw.projected, 950);
    eq('by day has 7 entries from Monday', [tw.byDay.length, tw.byDay[0].date, tw.byDay[6].date], [7, mon, sun]);
    // a2 is dated today, so it lands on Monday when the test runs on a Monday.
    eq('Monday split', [tw.byDay[0].revenue, tw.byDay[0].jobs], [400 + (mon === td ? 250 : 0), mon === td ? 2 : 1]);
    eq('Sunday booked', [tw.byDay[6].booked, tw.byDay[6].bookedJobs], [300, 1]);
    eq('last week', [w.lastWeek.revenue, w.lastWeek.jobs], [500, 1]);
    eq('vs last week %', tw.vsLastWeekPct, 30);
    eq('goal from monthly ÷ 52 × 12', [tw.goal, w.goalSource, tw.goalPct], [3000, 'monthly', 22]);
    eq('best week in window (not the $5k outside it)', w.bestWeek, { start: tenWeeksAgo, revenue: 900 });
    eq('avg of past weeks with jobs', w.avgWeek, 700);
    eq('days left in week', tw.daysLeft, 6 - ((toDate(td).getUTCDay() + 6) % 7));

    await post('/api/shop/settings', { weeklyRevenueGoal: 1000 });
    w = (await get('/api/shop/revenue')).weekly;
    eq('explicit weekly goal wins', [w.thisWeek.goal, w.goalSource, w.thisWeek.goalPct], [1000, 'weekly', 65]);
  } catch (e) { failures++; console.error('ERROR', e); }
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
});

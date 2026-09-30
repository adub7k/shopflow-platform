// Unit test for the "What we booked" report math (server/team-booked.js):
// only appointments entered under Bryce's or Aidan's logins count; owner,
// public-page and AI bookings never do; dead statuses and back-entered past
// jobs drop out; completed /
// upcoming / this-month buckets, revenue share and fee multiple are right.
// Run: node test/team-booked.test.js
const assert = require('assert');
const { teamBooked } = require('../server/team-booked');

const now = new Date('2026-09-20T15:00:00Z');
const accounts = [
  { id: 'acc-bryce', name: 'Bryce Moen', email: 'bryce@shopflowtech.com' },
  { id: 'acc-aidan', name: 'Aidan Woods', email: 'adub7k@gmail.com' },
  { id: 'acc-owner', name: 'Angelo', email: 'angelo@evo.com' },
];
const appt = (o) => ({ status: 'confirmed', createdAt: '2026-09-05T10:00:00Z', ...o });
const appointments = [
  appt({ id: 'b1', createdBy: 'acc-bryce', price: 900, status: 'done', date: '2026-09-10' }),
  appt({ id: 'b2', createdBy: 'acc-bryce', price: 400, date: '2026-09-28' }),               // upcoming
  appt({ id: 'b3', createdBy: 'acc-bryce', price: 999, status: 'cancelled', date: '2026-09-12' }), // dead
  appt({ id: 'a1', createdBy: 'acc-aidan', price: 300, status: 'done', date: '2026-08-15', createdAt: '2026-08-01T10:00:00Z' }),
  appt({ id: 'tz', createdBy: 'acc-aidan', price: 50, status: 'done', date: '2026-09-04', createdAt: '2026-09-05T02:00:00Z' }), // same-day evening entry (UTC rolled over) — counts
  appt({ id: 'gone', createdBy: 'acc-deleted', createdByName: 'Aidan', price: 100, status: 'done', date: '2026-09-02', createdAt: '2026-09-01T10:00:00Z' }), // deleted login, snapshot name
  appt({ id: 'o1', createdBy: 'acc-owner', price: 700, status: 'done', date: '2026-09-11' }),  // owner — never counts
  appt({ id: 'old', createdBy: 'acc-bryce', price: 5000, status: 'done', date: '2026-07-02', createdAt: '2026-09-06T10:00:00Z' }), // back-entered past job — never counts
  appt({ id: 'p1', createdBy: null, source: 'ai-voice', price: 500, status: 'done', date: '2026-09-13' }), // AI — never counts
];

const r = teamBooked({ appointments, accounts, rate: 1000, now });

assert.deepStrictEqual(r.jobs.map(j => j.id).sort(), ['a1', 'b1', 'b2', 'gone', 'tz']);
assert.strictEqual(r.totals.bookedValue, 1750);
assert.strictEqual(r.totals.completedValue, 1350);
assert.strictEqual(r.totals.upcomingValue, 400);
assert.strictEqual(r.totals.monthBookedValue, 1450);       // b1 + b2 + gone + tz (a1 booked in Aug)
assert.strictEqual(r.totals.monthCompletedValue, 1050);    // b1 + gone + tz
const bryce = r.byPerson.find(p => p.key === 'bryce'), aidan = r.byPerson.find(p => p.key === 'aidan');
assert.strictEqual(bryce.bookedValue, 1300);
assert.strictEqual(aidan.bookedValue, 450);
assert.strictEqual(r.shopMonthRevenue, 2250);              // 900 + 100 + 50 + 700 + 500 (shop total still includes everything)
assert.strictEqual(r.shareOfMonthRevenue, 47);             // 1050 / 2250
assert.strictEqual(r.monthMultiple, 1.5);                  // 1450 / 1000
assert.strictEqual(r.monthCompletedMultiple, 1.1);         // 1050 / 1000
assert.deepStrictEqual(r.jobs.filter(j => j.completedThisMonth).map(j => j.id).sort(), ['b1', 'gone', 'tz']);
assert.deepStrictEqual(r.jobs.filter(j => j.bookedThisMonth).map(j => j.id).sort(), ['b1', 'b2', 'gone', 'tz']);
assert.strictEqual(r.months.length, 6);
assert.deepStrictEqual(r.months[5], { month: '2026-09', booked: 1450, completed: 1050, shopRevenue: 2250 });
assert.strictEqual(r.months[4].booked, 300);

// No team bookings → empty, no crash, no divide-by-zero.
const empty = teamBooked({ appointments: appointments.filter(a => a.id === 'o1'), accounts, rate: 0, now });
assert.strictEqual(empty.jobs.length, 0);
assert.strictEqual(empty.monthMultiple, null);
assert.strictEqual(empty.monthCompletedMultiple, null);

console.log('team-booked: all assertions passed');

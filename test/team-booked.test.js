// Unit test for the "What we booked" report math (server/team-booked.js):
// only appointments entered under Bryce's or Aidan's logins count; owner,
// public-page and AI bookings never do; dead statuses drop out; completed /
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
  appt({ id: 'gone', createdBy: 'acc-deleted', createdByName: 'Aidan', price: 100, status: 'done', date: '2026-09-02' }), // deleted login, snapshot name
  appt({ id: 'o1', createdBy: 'acc-owner', price: 700, status: 'done', date: '2026-09-11' }),  // owner — never counts
  appt({ id: 'p1', createdBy: null, source: 'ai-voice', price: 500, status: 'done', date: '2026-09-13' }), // AI — never counts
];

const r = teamBooked({ appointments, accounts, rate: 1000, now });

assert.deepStrictEqual(r.jobs.map(j => j.id).sort(), ['a1', 'b1', 'b2', 'gone']);
assert.strictEqual(r.totals.bookedValue, 1700);
assert.strictEqual(r.totals.completedValue, 1300);
assert.strictEqual(r.totals.upcomingValue, 400);
assert.strictEqual(r.totals.monthBookedValue, 1400);       // b1 + b2 + gone (a1 booked in Aug)
assert.strictEqual(r.totals.monthCompletedValue, 1000);    // b1 + gone
const bryce = r.byPerson.find(p => p.key === 'bryce'), aidan = r.byPerson.find(p => p.key === 'aidan');
assert.strictEqual(bryce.bookedValue, 1300);
assert.strictEqual(aidan.bookedValue, 400);
assert.strictEqual(r.shopMonthRevenue, 2200);              // 900 + 100 + 700 + 500
assert.strictEqual(r.shareOfMonthRevenue, 45);             // 1000 / 2200
assert.strictEqual(r.monthMultiple, 1.4);                  // 1400 / 1000
assert.strictEqual(r.months.length, 6);
assert.deepStrictEqual(r.months[5], { month: '2026-09', booked: 1400, completed: 1000, shopRevenue: 2200 });
assert.strictEqual(r.months[4].booked, 300);

// No team bookings → empty, no crash, no divide-by-zero.
const empty = teamBooked({ appointments: [appointments[5]], accounts, rate: 0, now });
assert.strictEqual(empty.jobs.length, 0);
assert.strictEqual(empty.monthMultiple, null);

console.log('team-booked: all assertions passed');

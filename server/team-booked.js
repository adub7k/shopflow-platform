// ── ShopFlow-team bookings ────────────────────────────────────────────────────
// What Bryce and Aidan personally put on a client shop's calendar. Built on the
// booked-by attribution: every staff-created appointment carries a server-
// stamped createdBy (accountId) + createdByName snapshot. An appointment counts
// as a ShopFlow-team booking when the login that entered it belongs to a team
// member (matched by account name/email, falling back to the snapshot name so
// a deleted login keeps its history). Public-page, AI-voice and owner/staff
// bookings never count — this is ONLY what the team booked. Past jobs entered
// after the fact never count either — only jobs booked ahead of their date.
//
// Pure function (no db access) so the numbers are unit-testable.

const TEAM = [
  { key: 'bryce', label: 'Bryce', match: /\bbryce\b|bryce[._-]|moen/i },
  { key: 'aidan', label: 'Aidan', match: /\baidan\b|aidan[._-]|adub7k/i },
];

const { bucketLeadSource } = require('./lead-source');

const DEAD = ['cancelled', 'canceled', 'declined', 'no-show'];

const dayBefore = (ymd) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

function teamMemberFor(appt, accountsById) {
  if (!appt || !appt.createdBy) return null;
  const acct = accountsById.get(appt.createdBy);
  const hay = [acct && acct.name, acct && acct.email, appt.createdByName].filter(Boolean).join(' ');
  return TEAM.find(t => t.match.test(hay)) || null;
}

function vehicleOf(a) {
  const v = a.vehicle || (a.customFields && (a.customFields.vehicle || a.customFields.Vehicle));
  if (!v) return '';
  if (typeof v === 'string') return v;
  return [v.year, v.make, v.model].filter(Boolean).join(' ');
}

// How cold the lead was: match the job to the EARLIEST lead from the same
// customer (by customerId, else last-10 phone) that came in on or before the
// booking, and measure lead-in → booked. Same earliest-lead rule the Revenue
// tab uses for "bookings by lead source".
function leadMatcher(leads, customers) {
  const last10 = p => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
  const leadAt = l => l.createdAt || l.created_at || l.firstContactAt || '';
  const byCust = new Map(), byPhone = new Map();
  [...leads].filter(l => leadAt(l)).sort((a, b) => String(leadAt(a)).localeCompare(String(leadAt(b)))).forEach(l => {
    if (l.customerId && !byCust.has(l.customerId)) byCust.set(l.customerId, l);
    const p = last10(l.phone); if (p && !byPhone.has(p)) byPhone.set(p, l);
  });
  const custById = new Map(customers.map(c => [c.id, c]));
  return (a) => {
    const cust = a.customerId ? custById.get(a.customerId) : null;
    const lead = (a.customerId && byCust.get(a.customerId)) || byPhone.get(last10(a.customerPhone || (cust && cust.phone))) || null;
    const booked = String(a.createdAt || '');
    if (!lead || !booked || String(leadAt(lead)) > booked) return null;
    const days = Math.max(0, Math.floor((Date.parse(booked) - Date.parse(leadAt(lead))) / 86400000));
    return { leadAt: String(leadAt(lead)).slice(0, 10), daysCold: isFinite(days) ? days : null, source: bucketLeadSource(lead.source || lead.channel || 'call').label };
  };
}

function teamBooked({ appointments = [], accounts = [], leads = [], customers = [], rate = 0, now = new Date() } = {}) {
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const leadFor = leadMatcher(leads, customers);
  const today = now.toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const money = a => Number(a.price) || 0;
  const r2 = n => Math.round(n * 100) / 100;

  const jobs = [];
  appointments.forEach(a => {
    const who = teamMemberFor(a, accountsById);
    if (!who || DEAD.includes(a.status)) return;
    // Only real bookings count: the job must have been booked AHEAD (job date
    // on or after the day it was entered). Old/past jobs logged after the fact
    // under a team login are skipped. One day of slack because createdAt is
    // UTC while the job date is shop-local (evening entries roll over in UTC).
    const entered = String(a.createdAt || '').slice(0, 10);
    if (!entered || !a.date || a.date < dayBefore(entered)) return;
    const done = a.status === 'done';
    jobs.push({
      id: a.id, who: who.key, whoLabel: who.label,
      bookedOn: String(a.createdAt || '').slice(0, 10), date: a.date || '', time: a.time || '',
      customer: a.customerName || '', vehicle: vehicleOf(a), service: a.service || '',
      price: r2(money(a)), status: a.status || '',
      state: done ? 'completed' : ((a.date || '') >= today ? 'upcoming' : 'open'),
      // The report is this-month only: completed = job done with a date this
      // month; booked = entered this month (any live status).
      completedThisMonth: done && String(a.date || '').startsWith(thisMonth),
      bookedThisMonth: String(a.createdAt || '').slice(0, 7) === thisMonth,
      // Lead it came from (null when the customer never came in as a lead).
      ...(leadFor(a) || { leadAt: null, daysCold: null, source: null }),
    });
  });
  jobs.sort((x, y) => (y.date + y.time).localeCompare(x.date + x.time));

  const sum = list => r2(list.reduce((s, j) => s + j.price, 0));
  const totalsFor = list => {
    const completed = list.filter(j => j.state === 'completed');
    const upcoming = list.filter(j => j.state === 'upcoming');
    const monthBooked = list.filter(j => j.bookedOn.startsWith(thisMonth));
    const monthCompleted = completed.filter(j => j.date.startsWith(thisMonth));
    return {
      bookedValue: sum(list), bookedJobs: list.length,
      completedValue: sum(completed), completedJobs: completed.length,
      upcomingValue: sum(upcoming), upcomingJobs: upcoming.length,
      monthBookedValue: sum(monthBooked), monthBookedJobs: monthBooked.length,
      monthCompletedValue: sum(monthCompleted), monthCompletedJobs: monthCompleted.length,
    };
  };

  const totals = totalsFor(jobs);
  const byPerson = TEAM.map(t => ({ key: t.key, label: t.label, ...totalsFor(jobs.filter(j => j.who === t.key)) }));

  // Shop's whole completed revenue, for "X% of your revenue came from us".
  const shopDone = appointments.filter(a => a.status === 'done');
  const shopMonthRevenue = r2(shopDone.filter(a => (a.date || '').startsWith(thisMonth)).reduce((s, a) => s + money(a), 0));
  const shopTotalRevenue = r2(shopDone.reduce((s, a) => s + money(a), 0));

  // Last 6 months: booked by entry month, completed by job date.
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    months.push({
      month: key,
      booked: sum(jobs.filter(j => j.bookedOn.startsWith(key))),
      completed: sum(jobs.filter(j => j.state === 'completed' && j.date.startsWith(key))),
      shopRevenue: r2(shopDone.filter(a => (a.date || '').startsWith(key)).reduce((s, a) => s + money(a), 0)),
    });
  }

  const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : null;
  const multiple = (v) => rate > 0 && v > 0 ? Math.round(v / rate * 10) / 10 : null;
  return {
    team: TEAM.map(t => t.label),
    rate: Number(rate) || 0,
    totals, byPerson, months, jobs,
    shopMonthRevenue, shopTotalRevenue,
    shareOfMonthRevenue: pct(totals.monthCompletedValue, shopMonthRevenue),
    shareOfTotalRevenue: pct(totals.completedValue, shopTotalRevenue),
    // Completed this month ÷ monthly fee — the headline "every $1 you pay us" line.
    monthCompletedMultiple: multiple(totals.monthCompletedValue),
    // Booked this month ÷ monthly fee — the secondary number.
    monthMultiple: multiple(totals.monthBookedValue),
  };
}

module.exports = { teamBooked, teamMemberFor, TEAM };

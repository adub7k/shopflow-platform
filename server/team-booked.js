// ── ShopFlow-team bookings ────────────────────────────────────────────────────
// What Bryce and Aidan personally put on a client shop's calendar. Built on the
// booked-by attribution: every staff-created appointment carries a server-
// stamped createdBy (accountId) + createdByName snapshot. An appointment counts
// as a ShopFlow-team booking when the login that entered it belongs to a team
// member (matched by account name/email, falling back to the snapshot name so
// a deleted login keeps its history). Public-page, AI-voice and owner/staff
// bookings never count — this is ONLY what the team booked.
//
// Pure function (no db access) so the numbers are unit-testable.

const TEAM = [
  { key: 'bryce', label: 'Bryce', match: /\bbryce\b|bryce[._-]|moen/i },
  { key: 'aidan', label: 'Aidan', match: /\baidan\b|aidan[._-]|adub7k/i },
];

const DEAD = ['cancelled', 'canceled', 'declined', 'no-show'];

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

function teamBooked({ appointments = [], accounts = [], rate = 0, now = new Date() } = {}) {
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const today = now.toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const money = a => Number(a.price) || 0;
  const r2 = n => Math.round(n * 100) / 100;

  const jobs = [];
  appointments.forEach(a => {
    const who = teamMemberFor(a, accountsById);
    if (!who || DEAD.includes(a.status)) return;
    const done = a.status === 'done';
    jobs.push({
      id: a.id, who: who.key, whoLabel: who.label,
      bookedOn: String(a.createdAt || '').slice(0, 10), date: a.date || '', time: a.time || '',
      customer: a.customerName || '', vehicle: vehicleOf(a), service: a.service || '',
      price: r2(money(a)), status: a.status || '',
      state: done ? 'completed' : ((a.date || '') >= today ? 'upcoming' : 'open'),
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
    // Booked this month ÷ monthly fee — "every $1 you pay us, we put $N on your calendar".
    monthMultiple: multiple(totals.monthBookedValue),
  };
}

module.exports = { teamBooked, teamMemberFor, TEAM };

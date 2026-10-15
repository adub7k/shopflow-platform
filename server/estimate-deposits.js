// Estimates & deposits by sender — who sends estimates out, how often those
// estimates come back with a deposit, and whether the jobs they lined up show.
//
// Why: a deposit is the cheapest no-show insurance a shop has. This rollup
// credits each estimate to the login that SENT it (server-stamped sentBy,
// falling back to createdBy for estimates saved but never sent through the app)
// so the owner can see each person's deposit rate, the jobs they let onto the
// calendar without one, and how those jobs turned out. The shop-wide
// "no-shows with vs. without a deposit" comparison is the proof the deposit ask
// is worth making.
//
// Pure function — no db access — so it's unit-testable.

const APPROVED = ['approved', 'scheduled', 'completed'];

const round2 = n => Math.round(n * 100) / 100;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

// Who gets credit for an estimate: the first person who sent it; else whoever
// created it. Legacy estimates (before attribution) have neither → null.
function senderOf(q) {
  if (q.sentBy) return { id: q.sentBy, name: q.sentByName };
  if (q.createdBy) return { id: q.createdBy, name: q.createdByName };
  return null;
}

// When the estimate went out — the window it counts in.
// firstSentAt is stamped on the first send; resends move sentAt but not this.
const sentDateOf = q => q.firstSentAt || q.emailSentAt || q.smsSentAt || q.sentAt || q.createdAt || '';

function isApproved(q) { return !!q.approvedAt || APPROVED.includes(q.status); }
function hasDeposit(q) { return !!q.depositPaid && Number(q.depositAmount) > 0; }

/**
 * @param {object}   p
 * @param {object[]} p.quotes
 * @param {object[]} p.appointments
 * @param {object[]} p.accounts   shop accounts (live names win over snapshots)
 * @param {(iso:string)=>boolean} p.inWindow  which estimates count, by sent date
 */
function computeEstimateDeposits({ quotes = [], appointments = [], accounts = [], inWindow = () => true }) {
  const apptById = new Map(appointments.map(a => [a.id, a]));
  const quoteByAppt = new Map();
  quotes.forEach(q => { if (q.appointmentId) quoteByAppt.set(q.appointmentId, q); });

  const blank = (id, name) => ({
    accountId: id, name,
    sent: 0, approved: 0, depositAsked: 0, deposits: 0, depositTotal: 0,
    approvedNoDeposit: 0, approvedNoDepositValue: 0,
    showed: 0, noShows: 0, noShowsNoDeposit: 0,
  });
  const rows = {};
  const team = blank(null, 'Team');

  const tally = (r, q) => {
    r.sent++;
    if (q.depositRequired) r.depositAsked++;
    if (hasDeposit(q)) { r.deposits++; r.depositTotal += Number(q.depositAmount); }
    if (isApproved(q)) {
      r.approved++;
      if (!hasDeposit(q)) { r.approvedNoDeposit++; r.approvedNoDepositValue += Number(q.total) || 0; }
    }
    const a = q.appointmentId && apptById.get(q.appointmentId);
    if (a) {
      if (a.status === 'done') r.showed++;
      else if (a.status === 'no-show') { r.noShows++; if (!hasDeposit(q) && !a.depositPaid) r.noShowsNoDeposit++; }
    }
  };

  let unattributedAll = 0;
  quotes.forEach(q => {
    if (q && q.status !== 'draft' && !senderOf(q)) unattributedAll++;
    if (!q || q.status === 'draft' || !inWindow(sentDateOf(q))) return;
    tally(team, q);
    const s = senderOf(q);
    if (!s) return;
    const live = accounts.find(x => x.id === s.id);
    const r = rows[s.id] || (rows[s.id] = blank(s.id, (live && (live.name || live.email)) || s.name || 'Former staff'));
    tally(r, q);
  });

  const finish = r => ({
    ...r,
    depositTotal: round2(r.depositTotal),
    approvedNoDepositValue: round2(r.approvedNoDepositValue),
    depositRate: pct(r.deposits, r.sent),
    noShowRate: pct(r.noShows, r.showed + r.noShows),
  });

  // Shop-wide, all time: of the jobs that reached an outcome (done or no-show),
  // how often did the customer flake when they'd put money down vs. when they
  // hadn't? A job counts as deposit-backed if the appointment itself took a
  // deposit (booking page) or the estimate it came from did.
  const cmp = { withDeposit: { jobs: 0, noShows: 0 }, withoutDeposit: { jobs: 0, noShows: 0 } };
  appointments.forEach(a => {
    if (a.status !== 'done' && a.status !== 'no-show') return;
    const q = quoteByAppt.get(a.id);
    const b = (a.depositPaid || (q && hasDeposit(q))) ? cmp.withDeposit : cmp.withoutDeposit;
    b.jobs++;
    if (a.status === 'no-show') b.noShows++;
  });
  cmp.withDeposit.rate = pct(cmp.withDeposit.noShows, cmp.withDeposit.jobs);
  cmp.withoutDeposit.rate = pct(cmp.withoutDeposit.noShows, cmp.withoutDeposit.jobs);

  return {
    bySender: Object.values(rows).map(finish).sort((a, b) => b.sent - a.sent || b.deposits - a.deposits),
    team: finish(team),
    unattributed: team.sent - Object.values(rows).reduce((s, r) => s + r.sent, 0),
    unattributedAll,   // any month — what the owner can still assign
    noShowByDeposit: cmp,
  };
}

module.exports = { computeEstimateDeposits, senderOf };

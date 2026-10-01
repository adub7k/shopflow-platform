// ── Sales activity ───────────────────────────────────────────────────────────
// What each person on the team actually DID with the leads, so the owner can
// coach: calls / texts / emails / notes logged per lead (noteLog entries carry
// a kind + outcome + server-stamped actor), stage moves (stageLog entries carry
// the actor too), and appointments they put on the calendar (createdBy).
//
// Per person, for a local-date window:
//   calls (answered / no answer / voicemail), texts, emails, notes
//   leadsWorked     distinct leads they touched or moved
//   leadsContacted  distinct leads they reached out to (call / text / email)
//   leadsConnected  distinct leads with an ANSWERED call
//   pickedUp        leads whose first-ever outreach (by anyone) was theirs
//   quoted / booked / lost   distinct leads they moved into those stages
//   bookedRate      booked ÷ leadsWorked
//   open            leads they've ever touched that are still chaseable (any
//                   window), with how long since anyone touched them
//   appts / apptValue   appointments they entered (createdBy), non-dead
//   medianFirstTouchMin  lead-in → their first outreach, for leads they picked up
//   avgTouchesPerBooked  how many of their touches a booked lead took
//
// Pure function (no db access) so every number is unit-testable. Legacy
// noteLog entries without an actor are matched by the client-sent `by` name
// when it uniquely names an account; otherwise they're invisible here (they
// still show on the lead).

const ACTIVITY_KINDS = ['call', 'text', 'email', 'note'];
const CALL_OUTCOMES = ['answered', 'no_answer', 'voicemail'];
const KIND_LABEL = { call: 'Call', text: 'Text', email: 'Email', note: 'Note' };
const OUTCOME_LABEL = { answered: 'Answered', no_answer: 'No answer', voicemail: 'Left voicemail' };
const OUTREACH = new Set(['call', 'text', 'email']);
const DEAD_APPT = ['cancelled', 'canceled', 'declined', 'no-show'];
const DEFAULT_TZ = () => process.env.DEFAULT_TZ || 'America/Denver';
const STALE_DAYS = 3;

const ms = (v) => { const t = v ? Date.parse(v) : NaN; return isNaN(t) ? null : t; };
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

// Local calendar date (YYYY-MM-DD) of a UTC instant in tz — DST-safe.
const _fmt = new Map();
function localDate(utcMs, tz) {
  let f = _fmt.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch (e) { f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
    _fmt.set(tz, f);
  }
  return f.format(new Date(utcMs));
}
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));

// Window presets resolved against the shop's local "today".
function resolveWindow({ preset, from, to, tz = DEFAULT_TZ(), now = Date.now() } = {}) {
  const today = localDate(now, tz);
  if (isDateStr(from) && isDateStr(to) && from <= to) return { from, to, preset: 'custom' };
  const p = preset || 'week';
  if (p === 'today') return { from: today, to: today, preset: p };
  if (p === 'month') return { from: today.slice(0, 7) + '-01', to: today, preset: p };
  if (p === '30d') return { from: addDays(today, -29), to: today, preset: p };
  if (p === '90d') return { from: addDays(today, -89), to: today, preset: p };
  // Mon–Sun week containing today.
  const dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0 = Sun
  const back = (dow + 6) % 7;
  return { from: addDays(today, -back), to: today, preset: 'week' };
}

// Website-intake leads carry the Response Center's status machine in `status`
// and the pipeline stage in `pipelineStatus`; everything else uses `status`.
const WEB_MAP = { NEW_LEAD: 'new', CONTACTED: 'contacted', APPOINTMENT_SET: 'booked', COMPLETED: 'closed', LOST: 'lost' };
function stageOf(lead) {
  const s = lead.pipelineStatus || lead.status || 'new';
  return WEB_MAP[s] || s;
}
function stageSets(settings) {
  const cfg = ((settings || {}).pipeline || {}).stages;
  const list = Array.isArray(cfg) && cfg.length ? cfg : null;
  const won = new Set(list ? list.filter(s => s && s.won).map(s => s.key) : ['booked', 'worked', 'closed']);
  const terminal = new Set(list ? list.filter(s => s && s.terminal).map(s => s.key) : ['lost']);
  if (!won.size) ['booked', 'worked', 'closed'].forEach(k => won.add(k));
  terminal.add('lost');
  return { won, terminal };
}

// Resolve who did something: the server-stamped actor id first, then a
// client-sent `by` name that uniquely names an account (pre-attribution notes).
function actorResolver(accounts) {
  const byId = new Map(), byName = new Map();
  (accounts || []).forEach(a => {
    if (!a || !a.id) return;
    byId.set(a.id, a);
    const n = String(a.name || '').trim().toLowerCase();
    if (n) byName.set(n, byName.has(n) ? null : a); // null = ambiguous
  });
  return (entry) => {
    if (!entry) return null;
    if (entry.byId) {
      const a = byId.get(entry.byId);
      return { id: entry.byId, name: (a && (a.name || a.email)) || entry.by || 'Former staff' };
    }
    const n = String(entry.by || '').trim().toLowerCase();
    if (!n) return null;
    const a = byName.get(n);
    if (a) return { id: a.id, name: a.name || a.email };
    return { id: 'name:' + n, name: entry.by };
  };
}

function computeSalesActivity({ leads = [], appointments = [], accounts = [], settings = {}, from, to, tz = DEFAULT_TZ(), now = Date.now() } = {}) {
  const { won, terminal } = stageSets(settings);
  const who = actorResolver(accounts);
  const inWin = (at) => { const t = ms(at); if (t == null) return false; const d = localDate(t, tz); return d >= from && d <= to; };
  const dayOf = (at) => localDate(ms(at), tz);

  const people = new Map();
  const person = (actor) => {
    let p = people.get(actor.id);
    if (!p) {
      p = { id: actor.id, name: actor.name,
        calls: 0, callsAnswered: 0, callsNoAnswer: 0, voicemails: 0, texts: 0, emails: 0, notes: 0, touches: 0, stageMoves: 0,
        _worked: new Set(), _contacted: new Set(), _connected: new Set(), _pickedUp: new Set(), _quoted: new Set(), _booked: new Set(), _lost: new Set(),
        _everTouched: new Set(), _firstTouchMins: [], _touchesByLead: new Map(),
        appts: 0, apptValue: 0, days: {} };
      people.set(actor.id, p);
    }
    return p;
  };
  const day = (p, at) => { const d = dayOf(at); return p.days[d] || (p.days[d] = { calls: 0, texts: 0, emails: 0, notes: 0, booked: 0 }); };

  const feed = [];
  const leadMeta = new Map(); // id → { lastTouchAt (anyone), touches (anyone) }
  const untouchedNew = [];

  leads.forEach(l => {
    const stage = stageOf(l);
    const createdAt = l.createdAt || l.created_at || l.firstContactAt || null;
    const name = l.name || l.phone || 'Unknown';
    const meta = { lastTouchAt: null, touches: 0 };
    leadMeta.set(l.id, meta);

    // Activity entries, oldest first so "first outreach" is right.
    const acts = (l.noteLog || []).filter(n => n && n.at).slice().sort((a, b) => ms(a.at) - ms(b.at));
    let firstOutreach = null;
    acts.forEach(n => {
      const kind = ACTIVITY_KINDS.includes(n.kind) ? n.kind : (n.kind === undefined && /^texted\b|follow-up text sent$/i.test(n.text || '') ? 'text' : 'note');
      const actor = who(n);
      if (OUTREACH.has(kind)) {
        meta.lastTouchAt = n.at; meta.touches++;
        if (!firstOutreach) firstOutreach = { at: n.at, actor };
      } else if (kind === 'note') { meta.lastTouchAt = n.at; }
      if (!actor) return;
      const p = person(actor);
      p._everTouched.add(l.id);
      p._touchesByLead.set(l.id, (p._touchesByLead.get(l.id) || 0) + (OUTREACH.has(kind) ? 1 : 0));
      if (!inWin(n.at)) return;
      const d = day(p, n.at);
      p.touches++; p._worked.add(l.id);
      if (kind === 'call') {
        p.calls++; d.calls++; p._contacted.add(l.id);
        if (n.outcome === 'answered') { p.callsAnswered++; p._connected.add(l.id); }
        else if (n.outcome === 'voicemail') { p.voicemails++; p.callsNoAnswer++; }
        else if (n.outcome === 'no_answer') p.callsNoAnswer++;
      } else if (kind === 'text') { p.texts++; d.texts++; p._contacted.add(l.id); }
      else if (kind === 'email') { p.emails++; d.emails++; p._contacted.add(l.id); }
      else { p.notes++; d.notes++; }
      feed.push({ at: n.at, byId: p.id, by: p.name, kind, outcome: n.outcome || null, text: n.text || '', leadId: l.id, leadName: name, leadPhone: l.phone || '' });
    });
    if (firstOutreach && firstOutreach.actor && inWin(firstOutreach.at)) {
      const p = person(firstOutreach.actor);
      p._pickedUp.add(l.id);
      const c = ms(createdAt), f = ms(firstOutreach.at);
      if (c != null && f != null && f >= c) p._firstTouchMins.push(Math.round((f - c) / 60000));
    }

    // Stage moves.
    (l.stageLog || []).forEach(s => {
      if (!s || !s.at) return;
      const actor = who(s);
      if (!actor) return;
      const p = person(actor);
      p._everTouched.add(l.id);
      if (!inWin(s.at)) return;
      p.stageMoves++; p._worked.add(l.id);
      if (won.has(s.to) && !won.has(s.from)) { p._booked.add(l.id); day(p, s.at).booked++; }
      if (s.to === 'quoted') p._quoted.add(l.id);
      if (terminal.has(s.to)) p._lost.add(l.id);
      feed.push({ at: s.at, byId: p.id, by: p.name, kind: 'stage', outcome: s.to, text: `${s.from || '—'} → ${s.to}`, leadId: l.id, leadName: name, leadPhone: l.phone || '' });
    });

    if (stage === 'new' && meta.touches === 0) untouchedNew.push({ id: l.id, name, phone: l.phone || '', createdAt, source: l.source || '' });
  });

  // Appointments they put on the calendar in the window.
  appointments.forEach(a => {
    if (!a || !a.createdBy || DEAD_APPT.includes(a.status) || !inWin(a.createdAt)) return;
    const p = person({ id: a.createdBy, name: (accounts.find(x => x.id === a.createdBy) || {}).name || a.createdByName || 'Former staff' });
    p.appts++; p.apptValue += Number(a.price || 0);
  });

  // Open leads = still chaseable, per person (ever touched).
  const leadById = new Map(leads.map(l => [l.id, l]));
  const chaseable = (l) => { const s = stageOf(l); return !won.has(s) && !terminal.has(s); };
  const daysSince = (at) => { const t = ms(at); return t == null ? null : Math.floor((now - t) / 86400000); };

  const allFirstTouch = [];
  const rows = Array.from(people.values()).map(p => {
    allFirstTouch.push(...p._firstTouchMins);
    const open = Array.from(p._everTouched).map(id => leadById.get(id)).filter(l => l && chaseable(l)).map(l => {
      const m = leadMeta.get(l.id) || {};
      const lastAt = m.lastTouchAt || l.createdAt || l.created_at || null;
      return { id: l.id, name: l.name || l.phone || 'Unknown', phone: l.phone || '', stage: stageOf(l), quotedAmount: l.quotedAmount != null ? l.quotedAmount : null,
        lastTouchAt: lastAt, daysSinceTouch: daysSince(lastAt), touches: m.touches || 0, hot: !!l.hot, source: l.source || '' };
    }).sort((a, b) => (b.daysSinceTouch || 0) - (a.daysSinceTouch || 0));
    const stale = open.filter(o => o.daysSinceTouch != null && o.daysSinceTouch >= STALE_DAYS);
    const bookedTouches = Array.from(p._booked).map(id => p._touchesByLead.get(id) || 0);
    const openTouches = open.map(o => p._touchesByLead.get(o.id) || 0);
    const row = {
      id: p.id, name: p.name,
      calls: p.calls, callsAnswered: p.callsAnswered, callsNoAnswer: p.callsNoAnswer, voicemails: p.voicemails,
      texts: p.texts, emails: p.emails, notes: p.notes, touches: p.touches, stageMoves: p.stageMoves,
      leadsWorked: p._worked.size, leadsContacted: p._contacted.size, leadsConnected: p._connected.size, pickedUp: p._pickedUp.size,
      quoted: p._quoted.size, booked: p._booked.size, lost: p._lost.size,
      bookedRate: pct(p._booked.size, p._worked.size),
      connectRate: pct(p.callsAnswered, p.calls),
      noAnswerRate: pct(p.callsNoAnswer, p.calls),
      open: open.length, openStale: stale.length, openList: open.slice(0, 50),
      appts: p.appts, apptValue: Math.round(p.apptValue * 100) / 100,
      medianFirstTouchMin: median(p._firstTouchMins),
      avgTouchesPerBooked: bookedTouches.length ? round1(bookedTouches.reduce((a, b) => a + b, 0) / bookedTouches.length) : null,
      avgTouchesPerOpen: openTouches.length ? round1(openTouches.reduce((a, b) => a + b, 0) / openTouches.length) : null,
      days: p.days,
      flags: [],
    };
    row.flags = coachingFlags(row);
    return row;
  }).filter(r => r.touches || r.stageMoves || r.appts || r.open)
    .sort((a, b) => (b.touches + b.stageMoves) - (a.touches + a.stageMoves) || b.booked - a.booked);

  const team = rows.reduce((t, r) => {
    ['calls', 'callsAnswered', 'callsNoAnswer', 'voicemails', 'texts', 'emails', 'notes', 'touches', 'stageMoves', 'leadsWorked', 'leadsContacted', 'leadsConnected', 'pickedUp', 'booked', 'quoted', 'lost', 'open', 'openStale', 'appts', 'apptValue'].forEach(k => { t[k] = (t[k] || 0) + (r[k] || 0); });
    return t;
  }, {});
  team.bookedRate = pct(team.booked || 0, team.leadsWorked || 0);
  team.connectRate = pct(team.callsAnswered || 0, team.calls || 0);
  team.medianFirstTouchMin = median(allFirstTouch);
  team.untouchedNew = untouchedNew.length;
  team.untouchedNewList = untouchedNew.sort((a, b) => (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0)).slice(0, 20);

  feed.sort((a, b) => ms(b.at) - ms(a.at));
  return { window: { from, to, tz }, people: rows, team, feed: feed.slice(0, 300), generatedAt: new Date(now).toISOString() };
}

// Plain-English coaching callouts from the numbers — rule-based, no AI.
function coachingFlags(r) {
  const f = [];
  if (r.openStale >= 3) f.push({ level: 'warn', text: `${r.openStale} open lead${r.openStale === 1 ? '' : 's'} haven’t been touched in ${STALE_DAYS}+ days — work the “Still open” list.` });
  if (r.calls >= 5 && r.noAnswerRate >= 60) f.push({ level: 'warn', text: `${r.noAnswerRate}% of calls go unanswered — text first, then call a few minutes later.` });
  if (r.medianFirstTouchMin != null && r.medianFirstTouchMin > 60) {
    const h = Math.round(r.medianFirstTouchMin / 60);
    f.push({ level: 'warn', text: `Median first touch on new leads is ${h}h — leads convert best inside the first 5 minutes.` });
  } else if (r.medianFirstTouchMin != null && r.medianFirstTouchMin <= 5 && r.pickedUp >= 3) f.push({ level: 'good', text: `Fast first touch — median ${r.medianFirstTouchMin} min on ${r.pickedUp} new leads.` });
  if (r.avgTouchesPerBooked != null && r.avgTouchesPerOpen != null && r.open >= 3 && r.avgTouchesPerOpen < Math.min(r.avgTouchesPerBooked, 3) - 0.5) {
    f.push({ level: 'info', text: `Booked leads took ${r.avgTouchesPerBooked} touches on average; open leads have had ${r.avgTouchesPerOpen}. Keep following up.` });
  }
  if (r.leadsWorked >= 5 && r.bookedRate != null && r.bookedRate >= 30) f.push({ level: 'good', text: `${r.bookedRate}% of worked leads booked.` });
  if (r.touches >= 5 && r.notes === r.touches) f.push({ level: 'info', text: 'Only notes logged — log calls and texts so outreach counts.' });
  return f;
}

module.exports = { computeSalesActivity, resolveWindow, localDate, stageOf, stageSets, actorResolver, coachingFlags,
  ACTIVITY_KINDS, CALL_OUTCOMES, KIND_LABEL, OUTCOME_LABEL, STALE_DAYS, DEFAULT_TZ };

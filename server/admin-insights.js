// ── Per-shop account insights ─────────────────────────────────────────────────
// One computation shared by the admin shop profile, the client-shop list and
// the HQ overview, so every admin screen reads the same numbers: lead funnel,
// revenue, forecast, AI-receptionist recovery, quota pace, bi-weekly window.
const { getShopDb } = require('./db');

// A shop's rate is ONLY its editable monthlyRate — no tier fallback. A shop
// with no rate set contributes $0 until one is entered in the admin UI.
const shopRate = (s) => Number(s.monthlyRate) || 0;

function shopInsights(shop, db = getShopDb(shop.id)) {
  const settings    = db.get('settings').value()    || {};
  const barbers     = db.get('barbers').value()      || [];
  const services    = db.get('services').value()     || [];
  const customers   = db.get('customers').value()    || [];
  const appointments = db.get('appointments').value() || [];
  const leads  = db.get('leads').value()  || [];
  const quotes = db.get('quotes').value() || [];
  const calls  = db.get('calls').value()  || [];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const thisMonth = now.toISOString().slice(0, 7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7);
  const apptThisMonth = appointments.filter(a => a.date && a.date.startsWith(thisMonth)).length;
  const recentAppts = [...appointments].sort((a, b) => new Date(b.date + 'T' + (b.time || '00:00')) - new Date(a.date + 'T' + (a.time || '00:00'))).slice(0, 10);

  // ── Account-management insights: how is this client's business doing, and is
  // ShopFlow visibly earning its keep? Everything the account-review needs.
  const leadCreated = l => l.createdAt || l.created_at || '';
  const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);
  // TEMP (2026-08-31, revert after September): "converted" = lead → appointment
  // SET, not lead → won paying job. A lead counts if it reached an
  // appointment-or-later stage, or if an appointment (matched by customer or
  // last-10 phone) exists dated on/after the day the lead came in.
  // To revert, replace leadWon (and drop the appt maps) with:
  //   const leadWon = l => ['booked', 'closed', 'APPOINTMENT_SET', 'COMPLETED'].includes(l.status);
  const apptByCust = new Map(), apptByPhone = new Map();
  appointments.forEach(a => {
    const d = String(a.date || '');
    if (a.customerId && d > (apptByCust.get(a.customerId) || '')) apptByCust.set(a.customerId, d);
    const ph = last10(a.customerPhone);
    if (ph.length === 10 && d > (apptByPhone.get(ph) || '')) apptByPhone.set(ph, d);
  });
  const leadWon = l => {
    if (['booked', 'worked', 'closed', 'APPOINTMENT_SET', 'COMPLETED'].includes(l.status)) return true;
    const created = String(leadCreated(l)).slice(0, 10);
    const d = (l.customerId && apptByCust.get(l.customerId)) || apptByPhone.get(last10(l.phone));
    return !!d && (!created || d >= created);
  };
  const leadsThisMonth = leads.filter(l => leadCreated(l).startsWith(thisMonth));
  const leadsLastMonth = leads.filter(l => leadCreated(l).startsWith(lastMonth));
  // Avg first-response time in minutes, across leads that have one recorded.
  const respTimes = leads.map(l => {
    if (l.response_time_seconds != null) return l.response_time_seconds / 60;
    if (l.firstResponseAt && leadCreated(l)) return Math.max(0, (new Date(l.firstResponseAt) - new Date(leadCreated(l))) / 60000);
    return null;
  }).filter(v => v != null && isFinite(v));

  const doneRevenue = (list) => list.filter(a => a.status === 'done').reduce((s, a) => s + (Number(a.price) || 0), 0);
  const revenueThisMonth = doneRevenue(appointments.filter(a => (a.date || '').startsWith(thisMonth)));
  const revenueLastMonth = doneRevenue(appointments.filter(a => (a.date || '').startsWith(lastMonth)));
  // Forecast: booked future work + approved-but-unscheduled estimates, plus the
  // open estimate pipeline weighted by this shop's real acceptance rate.
  const upcomingBooked = appointments
    .filter(a => (a.date || '') >= today && !['done', 'cancelled', 'no-show'].includes(a.status))
    .reduce((s, a) => s + (Number(a.price) || 0), 0);
  const approvedEstimates = quotes.filter(q => q.status === 'approved').reduce((s, q) => s + (Number(q.total) || 0), 0);
  const openEstimates     = quotes.filter(q => q.status === 'sent').reduce((s, q) => s + (Number(q.total) || 0), 0);
  // 'completed' = the shop closed the work out as won; 'lost' = they closed it
  // out as dead (the owner-side twin of a customer 'declined'). Both are decided.
  const decided = quotes.filter(q => ['approved', 'scheduled', 'completed', 'declined', 'lost'].includes(q.status));
  const wonQuotes = quotes.filter(q => ['approved', 'scheduled', 'completed'].includes(q.status));
  // Accept rate: the owner's manual override wins (they know their real-world
  // close rate); else this shop's computed estimate history; else 50%.
  const computedAccept = decided.length ? Math.round(wonQuotes.length / decided.length * 100) : null;
  const manualAccept = (shop.estAcceptRate != null && shop.estAcceptRate !== '') ? Math.min(100, Math.max(0, Number(shop.estAcceptRate) || 0)) : null;
  const acceptRate = manualAccept != null ? manualAccept : (computedAccept != null ? computedAccept : 50);
  // Open lead pipeline: quoted value sitting on non-terminal pipeline stages
  // (owner-entered quotedAmount, falling back to what the AI quoted on the call).
  const cfgStages = ((settings.pipeline || {}).stages) || [];
  const terminalKeys = new Set((Array.isArray(cfgStages) && cfgStages.length ? cfgStages.filter(st => st.terminal).map(st => st.key) : ['closed', 'lost']).concat(['closed', 'lost', 'COMPLETED', 'LOST']));
  const leadQuoted = l => l.quotedAmount != null ? (Number(l.quotedAmount) || 0) : (l.ai && l.ai.quotedPrice != null ? (Number(l.ai.quotedPrice) || 0) : 0);
  const openPipeLeads = leads.filter(l => !terminalKeys.has(l.pipelineStatus || l.status) && leadQuoted(l) > 0);
  const leadPipelineValue = openPipeLeads.reduce((s, l) => s + leadQuoted(l), 0);
  const forecast = Math.round(upcomingBooked + approvedEstimates + (openEstimates + leadPipelineValue) * acceptRate / 100);

  const quota = Number(shop.monthlyQuota) || 0;
  const sources = {};
  leads.forEach(l => { const src = l.channel || l.source || 'call'; sources[src] = (sources[src] || 0) + 1; });
  // AI receptionist value (compact version of the shop Revenue tab's attribution):
  // calls the AI answered, leads it captured, and completed work traced back to an
  // AI-captured lead (booked directly, or same customer/phone closing later).
  const aiLeads = leads.filter(l => l.ai && l.ai.source === 'voice');
  const aiCustCap = new Map(), aiPhoneCap = new Map();
  aiLeads.forEach(l => {
    const cap = String((l.ai && l.ai.generatedAt) || l.createdAt || '').slice(0, 10);
    if (l.customerId) aiCustCap.set(l.customerId, cap);
    const ph = last10(l.phone); if (ph.length === 10) aiPhoneCap.set(ph, cap);
  });
  const doneAppts = appointments.filter(a => a.status === 'done');
  const aiDone = doneAppts.filter(a => {
    if (a.source === 'ai-voice') return true;
    const cap = (a.customerId && aiCustCap.get(a.customerId)) || aiPhoneCap.get(last10(a.customerPhone));
    return !!cap && String(a.date || '') >= cap;
  });
  const aiRecovered = aiDone.reduce((s, a) => s + (Number(a.price) || 0), 0);
  const aiRecoveredThisMonth = aiDone.filter(a => (a.date || '').startsWith(thisMonth)).reduce((s, a) => s + (Number(a.price) || 0), 0);
  const aiCallCount = calls.filter(c => c && c.voiceAI).length;
  // Bi-weekly window (last 14 days, vs the 14 days before) for the client-facing
  // bi-weekly performance report. Inclusive YYYY-MM-DD string bounds, same UTC
  // date basis as `today`/`thisMonth` above.
  const dayStr = (back) => { const d = new Date(now); d.setDate(d.getDate() - back); return d.toISOString().slice(0, 10); };
  const bwStart = dayStr(13), bwPriorStart = dayStr(27), bwPriorEnd = dayStr(14);
  const inWin = (ds, from, to) => !!ds && ds >= from && ds <= to;
  const bwLeads = leads.filter(l => inWin(leadCreated(l).slice(0, 10), bwStart, today));
  const biweekly = {
    start: bwStart, end: today,
    revenue: doneRevenue(appointments.filter(a => inWin(String(a.date || '').slice(0, 10), bwStart, today))),
    revenuePrior: doneRevenue(appointments.filter(a => inWin(String(a.date || '').slice(0, 10), bwPriorStart, bwPriorEnd))),
    leads: bwLeads.length,
    leadsPrior: leads.filter(l => inWin(leadCreated(l).slice(0, 10), bwPriorStart, bwPriorEnd)).length,
    // Conversion + sources over THIS window's leads only, so the bi-weekly
    // report carries no all-time numbers.
    conversionRate: bwLeads.length ? Math.round(bwLeads.filter(leadWon).length / bwLeads.length * 100) : null,
    sources: bwLeads.reduce((m, l) => { const src = l.channel || l.source || 'call'; m[src] = (m[src] || 0) + 1; return m; }, {}),
    calls: calls.filter(c => inWin(String(c.startedAt || '').slice(0, 10), bwStart, today)).length,
    aiRecovered: Math.round(aiDone.filter(a => inWin(String(a.date || '').slice(0, 10), bwStart, today)).reduce((s, a) => s + (Number(a.price) || 0), 0)),
  };
  // Why leads die — tallied from the reasons picked when marking lost.
  const lostReasons = {};
  leads.forEach(l => { if (l.lostReason) lostReasons[l.lostReason] = (lostReasons[l.lostReason] || 0) + 1; });

  const insights = {
    leads: {
      total: leads.length, thisMonth: leadsThisMonth.length, lastMonth: leadsLastMonth.length,
      converted: leads.filter(leadWon).length,
      convertedThisMonth: leadsThisMonth.filter(leadWon).length,
      conversionRate: leads.length ? Math.round(leads.filter(leadWon).length / leads.length * 100) : null,
      avgResponseMins: respTimes.length ? Math.round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length) : null,
      sources, lostReasons,
      callsThisMonth: calls.filter(c => (c.startedAt || '').startsWith(thisMonth)).length,
    },
    revenue: { thisMonth: revenueThisMonth, lastMonth: revenueLastMonth },
    biweekly,
    ai: { calls: aiCallCount, leads: aiLeads.length, recovered: Math.round(aiRecovered), recoveredThisMonth: Math.round(aiRecoveredThisMonth) },
    forecast: { total: forecast, upcomingBooked, approvedEstimates, openEstimates,
                leadPipelineValue, leadPipelineCount: openPipeLeads.length,
                estAcceptRate: acceptRate, acceptSource: manualAccept != null ? 'manual' : (computedAccept != null ? 'computed' : 'default'),
                computedAcceptRate: computedAccept },
    estimates: { open: quotes.filter(q => q.status === 'sent').length, approved: wonQuotes.length, total: quotes.length },
    quota: { monthly: quota, pct: quota > 0 ? Math.round(revenueThisMonth / quota * 100) : null },
    billing: { rate: shopRate(shop) },
  };

  return {
    settings, services, customers, appointments, leads, quotes, calls, insights, apptThisMonth, recentAppts,
    // The tenant collection is still called "barbers" (internal field names never
    // change across verticals — see industries.js); everything admin-facing says staff.
    staff: barbers,
    stats: { totalCustomers: customers.length, totalAppointments: appointments.length, apptThisMonth, activeStaff: barbers.filter(b => b.active !== false).length },
  };
}

module.exports = { shopInsights, shopRate };

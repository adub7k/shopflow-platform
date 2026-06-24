// ── Automation engine ────────────────────────────────────────────────────────
// Generalizes the old hardcoded scheduler jobs into toggleable campaigns. The
// 24h reminder and the rebook nudge are lifted VERBATIM from the previous
// scheduler (same dedup lists, same templates, same pruning) so a shop that
// never touches the new config behaves byte-for-byte as before — config lives at
// settings.automations and is absent until the owner edits it, defaulting
// reminder+rebook ON and review OFF.
//
// ctx = { db, settings, twilioClient, fromNum, localDate, todayStr }
const { buildSms } = require('../db');

// Resolve whether a campaign runs: explicit per-shop override, else the default.
function campaignOn(settings, key, def) {
  const c = (settings.automations || {})[key];
  return (c && c.enabled !== undefined) ? !!c.enabled : def;
}

// ── 24-hour appointment reminders (verbatim from the old scheduler) ──
async function runReminders(ctx) {
  const { db, settings: s, twilioClient, fromNum, localDate, todayStr } = ctx;
  const tomorrow = localDate(24 * 3600000);
  const appts = db.get('appointments').value().filter(a => a.date === tomorrow && a.status === 'confirmed');
  const sentIds = s.remindersSent || [];
  const toRemind = appts.filter(a => !sentIds.includes(a.id) && a.customerPhone);
  for (const appt of toRemind) {
    const phone = (appt.customerPhone || '').replace(/[^0-9]/g, '');
    if (phone.length < 10) continue;
    const msg = buildSms('reminder', { name: (appt.customerName || '').split(' ')[0], shop: s.shopName, time: appt.time, barber: appt.barberName }, s);
    try { await twilioClient.messages.create({ from: fromNum, to: '+1' + phone, body: msg }); sentIds.push(appt.id); } catch (e) {}
  }
  const liveApptIds = new Set(db.get('appointments').value().filter(a => (a.date || '') >= todayStr).map(a => a.id));
  const prunedSent = sentIds.filter(id => liveApptIds.has(id));
  if (toRemind.length || prunedSent.length !== (s.remindersSent || []).length) db.get('settings').assign({ remindersSent: prunedSent }).write();
}

// ── Rebook nudges (verbatim from the old scheduler) ──
async function runRebook(ctx) {
  const { db, settings: s, twilioClient, fromNum, localDate } = ctx;
  const rebookDays = Math.min(90, Math.max(7, s.rebookInterval || 21));
  const nudgeSentIds = s.nudgesSent || [];
  const cutoffDate = localDate(-rebookDays * 24 * 3600000);
  const allAppts = db.get('appointments').value().filter(a => a.status === 'done');
  const lastVisit = {};
  allAppts.forEach(a => { if (!lastVisit[a.customerId] || a.date > lastVisit[a.customerId].date) lastVisit[a.customerId] = { date: a.date, name: a.customerName, phone: a.customerPhone }; });
  const toNudge = Object.values(lastVisit).filter(v => v.date <= cutoffDate && v.phone);
  for (const v of toNudge) {
    const nudgeKey = v.phone + ':' + v.date;
    if (nudgeSentIds.includes(nudgeKey)) continue;
    const phone = (v.phone || '').replace(/[^0-9]/g, '');
    if (phone.length < 10) continue;
    const firstName = (v.name || '').split(' ')[0] || 'there';
    const msg = buildSms('rebook', { name: firstName, shop: s.shopName }, s);
    try { await twilioClient.messages.create({ from: fromNum, to: '+1' + phone, body: msg }); nudgeSentIds.push(nudgeKey); } catch (e) {}
  }
  const nudgeFloor = localDate(-180 * 24 * 3600000);
  const prunedNudges = nudgeSentIds.filter(k => (k.split(':')[1] || '') >= nudgeFloor);
  if (toNudge.length || prunedNudges.length !== (s.nudgesSent || []).length) db.get('settings').assign({ nudgesSent: prunedNudges }).write();
}

// ── Post-visit review requests (new) ──
// Texts the shop's review link N days after a completed visit. Deduped by the
// appointment's reviewRequestedAt (shared with the manual "Text request" flow,
// so they never double-send). Bounded to a 30-day lookback so first-enable can't
// blast the whole back-catalog.
async function runReviews(ctx) {
  const { db, settings: s, twilioClient, fromNum, localDate } = ctx;
  const link = s.googleReviewLink;
  if (!link) return; // nothing to send without a review link
  const days = Math.max(0, Number((s.automations && s.automations.review && s.automations.review.days)) || 2);
  const sendBefore = localDate(-days * 24 * 3600000);      // visited on/before this date
  const lookbackFloor = localDate(-30 * 24 * 3600000);     // …but within 30 days
  const due = db.get('appointments').value().filter(a =>
    a.status === 'done' && a.customerPhone && !a.reviewRequestedAt && !a.reviewId &&
    (a.date || '') <= sendBefore && (a.date || '') >= lookbackFloor);
  for (const appt of due) {
    const phone = (appt.customerPhone || '').replace(/[^0-9]/g, '');
    if (phone.length < 10) continue;
    const msg = buildSms('review', { name: (appt.customerName || '').split(' ')[0], shop: s.shopName, link }, s);
    try {
      await twilioClient.messages.create({ from: fromNum, to: '+1' + phone, body: msg });
      db.get('appointments').find({ id: appt.id }).assign({ reviewRequestedAt: new Date().toISOString() }).write();
    } catch (e) {}
  }
}

// Run every enabled campaign for one shop. Order matches the old scheduler
// (reminder then rebook) so any same-tick behavior is unchanged.
async function runAutomations(ctx) {
  if (campaignOn(ctx.settings, 'reminder', true)) await runReminders(ctx);
  if (campaignOn(ctx.settings, 'rebook', true))   await runRebook(ctx);
  if (campaignOn(ctx.settings, 'review', false))  await runReviews(ctx);
}

module.exports = { runAutomations, campaignOn };

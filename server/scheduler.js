const { master, getShopDb, shopHelpers, shopFromNumber, twilioClient, TWILIO_DEFAULT_FROM } = require('./db');
const { generateDueRecurring } = require('./recurring');
const { runAutomations } = require('./automation/engine');
const { sendQuoteEmail, shopReplyTo } = require('./email');
const { resumeStalledCampaigns } = require('./newsletter');
const { sendPush } = require('./push-instance');

const _DAY = 24 * 60 * 60 * 1000;
function publicBase() {
  return (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.APP_URL || '').replace(/\/$/, '');
}

// ── Estimate follow-up reminders (email) ─────────────────────────────────────
// Unlike SMS campaigns (disabled — no A2P), email CAN be sent server-side, so
// estimates that were emailed and still sit unapproved get a gentle nudge. Only
// touches quotes that were actually emailed (emailSentAt) and are still 'sent';
// stops at maxReminders, once approved/declined, or after a 30-day staleness
// cutoff. Cadence is per-shop-configurable via settings.quoteReminders, default
// on: first nudge afterDays (3) after send, then everyDays (3), up to 2 total.
async function remindStaleQuotes(db, shop, s) {
  const qr = s.quoteReminders || {};
  if (qr.enabled === false) return;
  const base = publicBase();
  if (!base) return;                       // no base URL → can't build the estimate link
  const afterDays = Number(qr.afterDays ?? 3);
  const everyDays = Number(qr.everyDays ?? 3);
  const maxReminders = Number(qr.maxReminders ?? 2);
  const now = Date.now();
  const h = shopHelpers(db);
  const quotes = db.get('quotes').value() || [];
  const shopObj = { name: s.shopName, tagline: s.tagline, phone: s.phone, address: s.address, email: s.email, accentColor: s.accentColor };
  for (const q of quotes) {
    if (q.status !== 'sent') continue;                        // resolved quotes need no nudge
    const sentMs = Date.parse(q.emailSentAt || '');
    if (isNaN(sentMs)) continue;                              // only quotes actually emailed
    if (now - sentMs > 30 * _DAY) continue;                   // staleness cutoff — give up
    if ((q.reminderCount || 0) >= maxReminders) continue;
    const to = (q.customerEmail || (q.customerId ? (h.getById('customers', q.customerId) || {}).email : '') || '').trim();
    if (!to) continue;
    const lastMs = Date.parse(q.lastReminderAt || q.emailSentAt);
    const dueDays = (q.reminderCount || 0) === 0 ? afterDays : everyDays;
    if (now - lastMs < dueDays * _DAY) continue;              // not due yet
    const link = `${base}/quote/${shop.slug}/${q.id}`;
    const openPixel = `${base}/api/public/${shop.slug}/quote/${q.id}/opened.gif`;
    try {
      const r = await sendQuoteEmail({ to, shop: shopObj, quote: q, link, openPixel, reminder: true, replyTo: shopReplyTo(s, shop) });
      if (r && r.ok) {
        q.reminderCount = (q.reminderCount || 0) + 1;
        q.lastReminderAt = new Date().toISOString();
        h.upsert('quotes', q);
        console.log(`Estimate reminder sent (${q.number} #${q.reminderCount}) →`, to);
      }
    } catch (e) { /* best effort — retry next tick */ }
  }
}

// ── 24-hour appointment reminders (push to the shop's phones) ────────────────
// Fires one push per appointment as it crosses the reminder window (24h before
// by default). This is a STAFF reminder, not a customer text: customers have no
// PWA to push to, and server-side SMS stays off (no A2P) — the owner still texts
// tomorrow's clients from the Tasks tab. Deduped by stamping reminderPushAt on
// the appointment, so a restart or a slow tick never double-sends.
//
// Wall-clock times are stored per shop as date 'YYYY-MM-DD' + time '4:00 PM' in
// the shop's own timezone, so both are resolved through TZ rather than the
// server's clock (Railway runs UTC).
const TERMINAL_STATUSES = ['done', 'no-show', 'cancelled', 'canceled', 'declined', 'pending-deposit'];

// Minutes past midnight for a stored 12-hour time string ('4:00 PM' → 960).
function minutesFrom12h(t) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/.exec(t || '');
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

// How far the zone is from UTC at a given instant, in ms.
function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).reduce((o, p) => (o[p.type] = p.value, o), {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hour === '24' ? 0 : parts.hour, parts.minute, parts.second);
  return asUTC - ts;
}

// 'YYYY-MM-DD' + '4:00 PM' in `tz` → epoch ms. Offset is resolved twice so a
// reminder that straddles a DST change lands on the right instant.
function apptStartMs(date, time, tz) {
  const [y, mo, d] = String(date || '').split('-').map(Number);
  const mins = minutesFrom12h(time);
  if (!y || !mo || !d || mins === null) return null;
  const guess = Date.UTC(y, mo - 1, d, Math.floor(mins / 60), mins % 60);
  const ts = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(ts, tz);
}

async function remindUpcomingAppointments(db, shop, s, TZ, todayStr) {
  const cfg = s.appointmentReminders || {};
  if (cfg.push === false) return;                            // owner turned it off
  const hours = Math.min(72, Math.max(1, Number(cfg.hoursBefore ?? 24)));
  const windowMs = hours * 60 * 60 * 1000;
  const now = Date.now();
  const h = shopHelpers(db);
  const appts = db.get('appointments').value() || [];
  for (const a of appts) {
    if (a.reminderPushAt) continue;                          // already reminded
    if (TERMINAL_STATUSES.includes(a.status)) continue;
    if ((a.date || '') < todayStr) continue;                 // cheap skip of history
    const start = apptStartMs(a.date, a.time, TZ);
    if (!start) continue;
    const until = start - now;
    if (until <= 0 || until > windowMs) continue;            // not in the window yet
    // Booked INSIDE the window (e.g. a next-morning slot taken tonight)? The
    // reminder moment already passed — the booking itself was the notice.
    const created = Date.parse(a.createdAt || '');
    if (!isNaN(created) && created > start - windowMs) { a.reminderPushAt = 'skipped'; h.upsert('appointments', a); continue; }
    // A tick can land late (restart, downtime) and hoursBefore can be set past
    // 24, so say which day it actually is instead of assuming "tomorrow".
    const dayStr = (off) => new Date(now + off).toLocaleDateString('en-CA', { timeZone: TZ });
    const when = a.date === dayStr(0) ? 'Today'
      : a.date === dayStr(_DAY) ? 'Tomorrow'
      : new Date(start).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });
    try {
      const r = await sendPush(shop.id, {
        title: `📅 ${when} ${a.time || ''} — ${a.customerName || 'Appointment'}`.trim(),
        body: [a.service, a.barberName, a.customerPhone].filter(Boolean).join(' · ') || 'Tap to see the details.',
        url: '/appointments',
        tag: `appt-${a.id}`,
      });
      // Only burn the one-shot stamp on a real send (0 devices counts — there
      // was nothing to deliver). A server with no VAPID keys retries instead.
      if (!r || r.ok !== false) {
        a.reminderPushAt = new Date().toISOString();
        h.upsert('appointments', a);
      }
    } catch (e) { /* best effort — retry next tick */ }
  }
}

// ── Scheduler: 24hr reminders + 21-day rebook nudges ─────────────────────────
async function runScheduler() {
  try {
    const shops = master.get('shops').value().filter(s => s.active);
    for (const shop of shops) {
      try {
        const db = getShopDb(shop.id);
        const s = db.get('settings').value()||{};

        // Compute dates in the shop's local timezone (default Mountain — company
        // HQ) so "tomorrow" doesn't skew across the UTC date boundary for
        // evening-local appointments. 'en-CA' formats as YYYY-MM-DD.
        const TZ = s.timezone || process.env.DEFAULT_TZ || 'America/Denver';
        const localDate = (offsetMs) => new Date(Date.now()+offsetMs).toLocaleDateString('en-CA', { timeZone: TZ });
        const todayStr = localDate(0);

        // ── Recurring job generation (cleaning/recurring contracts; no SMS needed) ──
        // Runs before the Twilio guard so jobs are spawned even for shops that
        // haven't configured SMS. Generated rows are ordinary appointments.
        try { generateDueRecurring(db, todayStr); } catch(e){}

        // ── Estimate follow-up reminders (email, so no A2P/SMS needed) ──
        // Runs before the Twilio guard so every shop with email configured gets
        // estimate nudges regardless of SMS setup.
        try { await remindStaleQuotes(db, shop, s); } catch(e){}

        // ── 24-hour appointment reminders (push; no SMS/Twilio involved) ──
        try { await remindUpcomingAppointments(db, shop, s, TZ, todayStr); } catch(e){}

        // ── Newsletter crash recovery ──
        // A campaign left mid-send by a restart resumes here (the launch route
        // normally drives the whole send in-process).
        try { resumeStalledCampaigns(db, shop); } catch(e){}

        // ── SMS-gated automation campaigns ──
        // The campaign engine runs each enabled campaign (24h reminder + rebook
        // by default, plus optional review requests). Reminder/rebook behavior is
        // identical to the old inline jobs; config lives at settings.automations.
        const fromNum = shopFromNumber(shop.id);
        if (!twilioClient || !fromNum) continue;  // skip shops without SMS configured
        await runAutomations({ db, settings: s, twilioClient, fromNum, localDate, todayStr });

      } catch(e) {}
    }
  } catch(e) { console.error('Scheduler error:', e.message); }
}
setInterval(runScheduler, 5*60*1000);

module.exports = { runScheduler, remindStaleQuotes, remindUpcomingAppointments, apptStartMs };

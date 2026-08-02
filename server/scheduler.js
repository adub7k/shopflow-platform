const { master, getShopDb, shopHelpers, shopFromNumber, twilioClient, TWILIO_DEFAULT_FROM } = require('./db');
const { generateDueRecurring } = require('./recurring');
const { runAutomations } = require('./automation/engine');
const { sendQuoteEmail } = require('./email');
const { resumeStalledCampaigns } = require('./newsletter');

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
      const r = await sendQuoteEmail({ to, shop: shopObj, quote: q, link, openPixel, reminder: true });
      if (r && r.ok) {
        q.reminderCount = (q.reminderCount || 0) + 1;
        q.lastReminderAt = new Date().toISOString();
        h.upsert('quotes', q);
        console.log(`Estimate reminder sent (${q.number} #${q.reminderCount}) →`, to);
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

module.exports = { runScheduler, remindStaleQuotes };

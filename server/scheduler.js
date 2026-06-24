const { master, getShopDb, shopHelpers, shopFromNumber, twilioClient, TWILIO_DEFAULT_FROM } = require('./db');
const { generateDueRecurring } = require('./recurring');
const { runAutomations } = require('./automation/engine');

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

module.exports = { runScheduler };

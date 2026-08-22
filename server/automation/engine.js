// ── Automation engine ────────────────────────────────────────────────────────
// AUTOMATIC TEXTING IS DISABLED. ShopFlow's live shops have no Twilio A2P, so the
// platform never sends SMS server-side. The old unattended campaigns (24h
// reminder, rebook nudge, post-visit review request) can't open the iPhone
// Messages app (no owner device in a cron tick), so they've been replaced by
// owner-facing manual prompts that text via the sms: deep link (_cpSms):
//   • reminders → the Tasks tab "Text tomorrow's appointments" worklist
//   • rebook    → the Tasks tab win-back cadence (already overlapped this)
//   • review    → the Reviews page "Text request" buttons (one tap per visit)
//   • lead drip → the Pipeline "By day" view: per-day templates (settings.
//     pipeline.touchDays) become one-tap prefilled text buttons on each card —
//     deliberately NOT server-sent (owner said no texting from the tracking
//     number; everything goes through their own phone).
// This module is kept as a no-op so the scheduler's call site is unchanged; the
// per-campaign toggles in Settings still persist for when A2P is added back.
//
// ctx = { db, settings, twilioClient, fromNum, localDate, todayStr }

// Resolve whether a campaign runs: explicit per-shop override, else the default.
// Still exported for the Settings UI; no longer gates any server-side send.
function campaignOn(settings, key, def) {
  const c = (settings.automations || {})[key];
  return (c && c.enabled !== undefined) ? !!c.enabled : def;
}

// No automatic sends. Surfaced manually in the Tasks tab + Reviews page instead.
async function runAutomations(ctx) { /* intentionally a no-op — see header */ }

module.exports = { runAutomations, campaignOn };

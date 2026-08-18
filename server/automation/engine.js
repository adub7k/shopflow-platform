// ── Automation engine ────────────────────────────────────────────────────────
// GENERAL AUTOMATIC TEXTING IS DISABLED. ShopFlow's live shops have no Twilio
// A2P, so the old unattended campaigns (24h reminder, rebook nudge, post-visit
// review request) never send server-side — they were replaced by owner-facing
// manual prompts that text via the sms: deep link (_cpSms):
//   • reminders → the Tasks tab "Text tomorrow's appointments" worklist
//   • rebook    → the Tasks tab win-back cadence (already overlapped this)
//   • review    → the Reviews page "Text request" buttons (one tap per visit)
// The per-campaign toggles in Settings still persist for when A2P is added back.
//
// ONE exception, added 2026-08: the lead follow-up drip (Pipeline → By day →
// Edit days). It is opt-in per shop (settings.pipeline.dripEnabled, default
// OFF), writes the owner's own per-day messages, and sends from the shop's
// tracking number — the same number/path as the missed-call auto-text that
// already runs in production. Everything else stays manual.
//
// ctx = { db, settings, twilioClient, fromNum, localDate, todayStr }
const { toE164, genId } = require('../db');

// Resolve whether a campaign runs: explicit per-shop override, else the default.
// Still exported for the Settings UI; no longer gates any server-side send.
function campaignOn(settings, key, def) {
  const c = (settings.automations || {})[key];
  return (c && c.enabled !== undefined) ? !!c.enabled : def;
}

// ── Lead follow-up drip ───────────────────────────────────────────────────────
// settings.pipeline.touchDays = [{ day, sms }] (owner-defined, any count). A day
// with a non-empty sms texts the lead when its age crosses that day. Guards:
//   • master toggle off → nothing (default)
//   • only "chaseable" stages: non-terminal, non-won (booked/closed/lost never
//     get drip texts; neither do custom stages the owner marked as wins)
//   • one send per day-marker per lead, stamped in lead.dripLog
//   • 24h crossing window — turning the feature on never blasts the backlog;
//     a lead already past day N+1 is silently skipped for that marker
//   • shop-local quiet hours: sends only 9:00–19:00
//   • at most one marker per lead per tick, small per-tick batch cap
async function runDripTexts(ctx) {
  const { db, settings, twilioClient, fromNum } = ctx;
  const p = settings.pipeline || {};
  if (!p.dripEnabled || !twilioClient || !fromNum) return;
  const entries = (Array.isArray(p.touchDays) ? p.touchDays : [])
    .map(e => (typeof e === 'number' ? { day: e, sms: '' } : { day: Number(e && e.day) || 0, sms: String((e && e.sms) || '').trim() }))
    .filter(e => e.day > 0 && e.sms)
    .sort((a, b) => a.day - b.day);
  if (!entries.length) return;

  const TZ = settings.timezone || process.env.DEFAULT_TZ || 'America/Denver';
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  if (isNaN(hour) || hour < 9 || hour >= 19) return;

  // Chaseable = still being pursued on the pipeline.
  const stages = (Array.isArray(p.stages) && p.stages.length) ? p.stages : null;
  const chaseable = (status) => {
    if (stages) { const s = stages.find(x => x && x.key === status); return !!s && !s.terminal && !s.won; }
    return status === 'new' || status === 'contacted' || status === 'quoted';
  };

  const now = Date.now();
  let sent = 0;
  const leads = db.get('leads').value() || [];
  for (const lead of leads) {
    if (sent >= 20) break;                                   // per-tick batch cap
    if (!lead || !lead.phone) continue;
    const raw = lead.pipelineStatus || lead.status;
    const status = ({ NEW_LEAD: 'new', CONTACTED: 'contacted' })[raw] || raw;  // website shapes
    if (!chaseable(status)) continue;
    const created = Date.parse(lead.createdAt || lead.created_at || lead.firstContactAt || '');
    if (isNaN(created)) continue;
    const ageDays = (now - created) / 86400000;

    for (const e of entries) {
      if (ageDays < e.day || ageDays > e.day + 1) continue;  // inside the 24h crossing window only
      lead.dripLog = lead.dripLog || {};
      const key = 'd' + e.day;
      if (lead.dripLog[key]) continue;                       // already sent this marker
      const to = toE164(lead.phone);
      if (!to) break;
      const first = String(lead.name || '').trim().split(/\s+/)[0];
      const body = e.sms
        .replace(/\{first\}/gi, first || 'there')
        .replace(/\{name\}/gi, lead.name || 'there')
        .replace(/\{shop\}/gi, settings.shopName || '');
      try {
        await twilioClient.messages.create({ from: fromNum, to, body });
        lead.dripLog[key] = new Date().toISOString();
        lead.noteLog = lead.noteLog || [];
        lead.noteLog.unshift({ id: genId('note'), text: `Auto-text (day ${e.day}) sent: ${body}`, at: new Date().toISOString(), by: 'auto' });
        db.get('leads').find({ id: lead.id }).assign(lead).write();
        sent++;
        console.log(`[drip] day-${e.day} text → ${to} (lead ${lead.id})`);
      } catch (err) {
        console.error(`[drip] send failed (lead ${lead.id}):`, err.message);
      }
      break;                                                 // one marker per lead per tick
    }
  }
}

// Campaign sends stay off (see header); the opt-in lead drip is the exception.
async function runAutomations(ctx) {
  try { await runDripTexts(ctx); } catch (e) { console.error('[drip] tick failed:', e.message); }
}

module.exports = { runAutomations, campaignOn };

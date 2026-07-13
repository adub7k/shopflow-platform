/**
 * ShopFlow — Automation Engine (Part 3)
 * ---------------------------------------
 * Event-driven job scheduler that runs on the existing stack — no Redis,
 * no cron service, just lowdb + setInterval. Every lifecycle event enqueues
 * jobs; a tick loop executes whatever is due.
 *
 * Wire-up in server.js:
 *   const createAutomations = require('./automations');
 *   const automations = createAutomations({ getShopDb, getAllTenantIds, sendSms, sendEmail });
 *   automations.start();               // 60s tick
 *   // pass `automations` into the website-leads router so it emits events
 *
 * Events → default jobs:
 *   lead.created          → owner alert (immediate, handled by leads router)
 *                         → speed-to-lead nudge to OWNER if still uncontacted after 10 min
 *                         → customer follow-up email after 1 hour if uncontacted
 *   appointment.scheduled → customer reminder SMS 24h before appointment
 *   lead.completed        → review request SMS 3h after completion
 *                         → upsell offer 2 days after (tint → coating/PPF)
 *                         → maintenance reminder 180 days after (retention)
 *
 * Templates are per-tenant overridable in site_settings.automation_templates.
 * All rules are data (RULES below) — adding a campaign = adding an entry.
 */

const crypto = require('crypto');

// A2P 10DLC gate — same flag as the leads router. While off, owner jobs go
// push-only and customer jobs go email-only (or are skipped without email).
const SMS_ON = () => process.env.SMS_ENABLED === 'true';

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const DEFAULT_TEMPLATES = {
  speed_nudge_owner:
    '⚠️ {name} ({service_requested}, ~${estimated_value}) has waited {age_min} min with no contact. Leads answered in 5 min close 8x more.',
  follow_up_customer:
    "Hi {first_name}, it's {shop_name} — got your quote request for the {vehicle}. Want us to call, or is text easier? Reply here anytime.",
  appointment_reminder:
    'Reminder from {shop_name}: your {service} appointment is tomorrow at {appt_time}. Reply C to confirm or R to reschedule.',
  review_request:
    'Thanks for choosing {shop_name}, {first_name}! If the {vehicle} came out great, a quick Google review means the world: {review_link}',
  upsell_offer:
    "{first_name}, your new tint looks 👌 — most customers protect the paint next. Ceramic coating for the {vehicle} is ${coating_price} this month if you book by Friday. Interested?",
  maintenance_reminder:
    "Hi {first_name}, it's {shop_name}. It's been 6 months since we worked on your {vehicle} — time for a maintenance detail to keep it protected. Want a slot this week?",
};

// Rules are pure data: event in → jobs out.
const RULES = {
  'lead.created': (lead) => [
    { type: 'speed_nudge_owner', run_at: Date.now() + 10 * MIN, cancel_if: 'contacted' },
    { type: 'follow_up_customer', run_at: Date.now() + 1 * HOUR, cancel_if: 'contacted' },
  ],
  'appointment.scheduled': (lead) => {
    const when = new Date(`${lead.appointment?.date}T${lead.appointment?.time || '09:00'}`);
    const remindAt = when.getTime() - DAY;
    return remindAt > Date.now()
      ? [{ type: 'appointment_reminder', run_at: remindAt, cancel_if: 'appointment_gone' }]
      : [];
  },
  'lead.completed': (lead) => [
    { type: 'review_request', run_at: Date.now() + 3 * HOUR },
    ...(lead.tint_type
      ? [{ type: 'upsell_offer', run_at: Date.now() + 2 * DAY, cancel_if: 'upsell_accepted' }]
      : []),
    { type: 'maintenance_reminder', run_at: Date.now() + 180 * DAY },
  ],
};

module.exports = function createAutomations({ getShopDb, getAllTenantIds, sendSms, sendEmail, sendPush }) {
  let timer = null;

  /* ---------- emit: called by the leads router on lifecycle changes ---------- */
  async function emit(tenantId, event, lead) {
    const db = await getShopDb(tenantId);
    if (!db) return;
    const make = RULES[event];
    if (!make) return;

    db.data.automation_queue ||= [];
    for (const job of make(lead)) {
      db.data.automation_queue.push({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        lead_id: lead.id,
        type: job.type,
        cancel_if: job.cancel_if || null,
        run_at: new Date(job.run_at).toISOString(),
        status: 'pending', // pending | done | canceled | failed
        created_at: new Date().toISOString(),
      });
    }
    await db.write();
  }

  /* ---------- tick: execute due jobs across all tenants ---------- */
  async function tick() {
    const tenantIds = await getAllTenantIds();
    for (const tenantId of tenantIds) {
      try {
        await processTenant(tenantId);
      } catch (e) {
        console.error(`[automations] ${tenantId}:`, e.message);
      }
    }
  }

  async function processTenant(tenantId) {
    const db = await getShopDb(tenantId);
    if (!db?.data?.automation_queue?.length) return;

    const now = Date.now();
    let dirty = false;

    for (const job of db.data.automation_queue) {
      if (job.status !== 'pending' || new Date(job.run_at).getTime() > now) continue;
      const lead = (db.data.leads || []).find((l) => l.id === job.lead_id);
      if (!lead) { job.status = 'canceled'; dirty = true; continue; }

      // Cancellation conditions — the whole point of automations that don't annoy
      if (shouldCancel(job, lead)) { job.status = 'canceled'; dirty = true; continue; }

      try {
        await execute(tenantId, db, job, lead);
        job.status = 'done';
        job.executed_at = new Date().toISOString();
      } catch (e) {
        job.status = 'failed';
        job.error = e.message;
      }
      dirty = true;
    }

    // prune finished jobs older than 30 days
    const cutoff = now - 30 * DAY;
    const before = db.data.automation_queue.length;
    db.data.automation_queue = db.data.automation_queue.filter(
      (j) => j.status === 'pending' || new Date(j.created_at).getTime() > cutoff
    );
    if (dirty || db.data.automation_queue.length !== before) await db.write();
  }

  function shouldCancel(job, lead) {
    switch (job.cancel_if) {
      case 'contacted': return lead.first_response_at !== null || lead.status !== 'NEW_LEAD';
      case 'appointment_gone': return lead.appointment_status !== 'SCHEDULED';
      case 'upsell_accepted':
        return (lead.upsells || []).some((u) => u.status === 'accepted');
      default: return false;
    }
  }

  async function execute(tenantId, db, job, lead) {
    const settings = db.data.site_settings || {};
    const templates = { ...DEFAULT_TEMPLATES, ...(settings.automation_templates || {}) };
    const msg = fill(templates[job.type] || '', lead, settings);
    if (!msg) return;

    const toOwner = job.type === 'speed_nudge_owner';
    if (toOwner) {
      // Owner alerts: push first (free), SMS as backup channel
      if (typeof sendPush === 'function')
        await sendPush(tenantId, {
          title: '⚠️ Lead going cold',
          body: msg,
          url: `/response-center?lead=${lead.id}`,
          tag: `nudge-${lead.id}`,
        });
      if (SMS_ON() && typeof sendSms === 'function') await sendSms(tenantId, msg);
    } else {
      // Customer messages: SMS only once A2P 10DLC is approved (SMS_ENABLED=true),
      // otherwise fall back to email so the automation still runs.
      if (SMS_ON() && typeof sendSms === 'function') {
        await sendSms(tenantId, msg, lead.phone);
      } else if (typeof sendEmail === 'function' && lead.email) {
        await sendEmail(tenantId, `From ${brand(settings)}`, msg, lead.email);
      }
    }
  }

  function brand(settings) {
    return settings.brand?.name || 'the shop';
  }

  function fill(tpl, lead, settings) {
    const vehicle = `${lead.vehicle_year} ${lead.vehicle_make} ${lead.vehicle_model}`.trim();
    const vars = {
      name: lead.name,
      first_name: (lead.name || '').split(' ')[0],
      vehicle,
      service: lead.appointment?.service || lead.service_requested,
      service_requested: lead.service_requested,
      estimated_value: lead.estimated_value,
      appt_time: lead.appointment?.time || '',
      shop_name: brand(settings),
      review_link: settings.review_link || '',
      coating_price: settings.pricing?.['Ceramic Coating'] || 900,
      age_min: Math.round((Date.now() - new Date(lead.created_at).getTime()) / MIN),
    };
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  }

  function start(intervalMs = 60 * 1000) {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    console.log('[automations] engine started');
  }
  function stop() { clearInterval(timer); timer = null; }

  return { emit, tick, start, stop };
};

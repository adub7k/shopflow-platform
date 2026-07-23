/**
 * ShopFlow — Website Lead Intake + Response Center router
 * ---------------------------------------------------------
 * Drop-in Express router for the existing ShopFlow platform
 * (Node/Express/lowdb, per-tenant databases).
 *
 * Mount in server.js:
 *   const websiteLeads = require('./routes/website-leads');
 *   app.use('/api', websiteLeads({ getShopDb, sendSms, sendEmailAlert }));
 *
 * Dependencies you already have: express, your lowdb helper, Twilio send
 * function, nodemailer alert function. Pass them in — this file has zero
 * hard dependencies on your internals.
 *
 * Adds to each shop's db:
 *   db.data.leads[]            (extends your existing leads array)
 *   db.data.website_api_keys[] (per-tenant keys for landing sites)
 */

const express = require('express');
const crypto = require('crypto');

// A2P 10DLC gate: all Twilio SMS is disabled until SMS_ENABLED=true is set
// in env (flip it when the ShopFlow LLC brand/campaign is approved).
// Alerts still flow via push + email while this is off.
const SMS_ON = () => process.env.SMS_ENABLED === 'true';

module.exports = function websiteLeadsRouter({ getShopDb, sendSms, sendEmailAlert, sendPush, automations, onCompleted }) {
  const router = express.Router();
  router.use(express.json({ limit: '4mb' })); // room for optional photo

  /* ---------------- auth: per-tenant website API keys ---------------- */

  async function auth(req, res, next) {
    const key = req.headers['x-api-key'];
    const tenantId = req.body?.tenant_id || req.query.tenant_id;
    if (!key || !tenantId) return res.status(401).json({ error: 'Missing credentials' });

    const db = await getShopDb(tenantId);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });

    db.data.website_api_keys ||= [];
    const valid = db.data.website_api_keys.some(
      (k) => k.active && timingSafeEq(k.key, key)
    );
    if (!valid) return res.status(403).json({ error: 'Invalid API key' });

    req.shopDb = db;
    req.tenantId = tenantId;
    next();
  }

  function timingSafeEq(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }

  /* ---------------- POST /api/leads — website lead intake ---------------- */

  router.post('/leads', auth, async (req, res) => {
    const db = req.shopDb;
    const b = req.body;

    // Minimal server-side validation. Only name + phone are hard-required
    // (Meta Instant Forms may not collect a service question); any other
    // answers ride along in `message`/`notes` and are preserved below.
    if (!b.name || !b.phone) {
      return res.status(422).json({ error: 'Missing required fields: name and phone' });
    }

    const now = new Date().toISOString();
    const lead = {
      id: crypto.randomUUID(),

      // customer
      name: String(b.name).slice(0, 120),
      phone: String(b.phone).slice(0, 30),
      email: String(b.email || '').slice(0, 200),

      // vehicle
      vehicle_year: String(b.vehicle_year || ''),
      vehicle_make: String(b.vehicle_make || ''),
      vehicle_model: String(b.vehicle_model || ''),
      vehicle_type: String(b.vehicle_type || ''),
      vehicle_color: String(b.vehicle_color || ''),

      // request
      service_requested: String(b.service_requested || ''),
      tint_type: String(b.tint_type || ''),
      customer_goal: String(b.customer_goal || ''),
      timeline: String(b.timeline || ''),
      // free-text catch-all: accepts `message` or `notes`, so any extra
      // Meta form answers can be dumped here without being dropped.
      message: String(b.message || b.notes || '').slice(0, 2000),
      // Photos: lowdb is JSON on disk — a few base64 photos are fine,
      // but move to object storage (S3/Cloudinary) before this scales.
      photo: typeof b.photo === 'string' && b.photo.startsWith('data:image/') ? b.photo : '',

      // economics
      estimated_value: Number(b.estimated_value) || 0,
      lead_quality_score: Number(b.lead_quality_score) || 0,

      // attribution
      source: String(b.source || 'website'),
      medium: String(b.medium || ''),
      campaign: String(b.campaign || ''),
      ad_set: String(b.ad_set || ''),
      ad_name: String(b.ad_name || ''),
      landing_page: String(b.landing_page || ''),
      referrer: String(b.referrer || ''),
      utm_parameters: b.utm_parameters || {},
      fbclid: String(b.fbclid || ''),
      gclid: String(b.gclid || ''),

      // ---- Response Center state machine ----
      status: 'NEW_LEAD',           // NEW_LEAD → CONTACTED → APPOINTMENT_SET → COMPLETED → (LOST)
      contact_status: 'UNCONTACTED', // UNCONTACTED → ATTEMPTED → REACHED
      appointment_status: 'NONE',    // NONE → SCHEDULED → COMPLETED → NO_SHOW
      assigned_to: null,
      assigned_at: null,
      first_response_at: null,
      response_time_seconds: null,
      contact_attempts: [],
      appointment: null,
      upsells: [],                   // [{service, value, added_at}] — Part 3
      created_at: b.created_at || now,
      updated_at: now,
      channel: 'website',
    };

    db.data.leads ||= [];
    db.data.leads.push(lead);
    await db.write();

    // ---- alerts: fire-and-forget, never block the response ----
    fireAlerts(req.tenantId, lead, { sendSms, sendEmailAlert, sendPush }).catch((e) =>
      console.error('[website-leads] alert failed:', e.message)
    );
    if (automations) { try { await automations.emit(req.tenantId, 'lead.created', lead); } catch (e) { console.error('[automations]', e.message); } }

    res.status(201).json({ ok: true, lead_id: lead.id });
  });

  async function fireAlerts(tenantId, lead, { sendSms, sendEmailAlert, sendPush }) {
    const summary =
      `🔔 NEW LEAD (${lead.lead_quality_score}/100)\n` +
      `${lead.name} — ${lead.phone}\n` +
      `${lead.vehicle_year} ${lead.vehicle_make} ${lead.vehicle_model}\n` +
      `${lead.service_requested} · ${lead.timeline} · ~$${lead.estimated_value}\n` +
      `Source: ${lead.source}${lead.campaign ? ' / ' + lead.campaign : ''}`;

    // Push first (free, instant, deep-links into the lead) — SMS + email as backup
    if (typeof sendPush === 'function')
      await sendPush(tenantId, {
        title: `🔔 New lead — ${lead.service_requested} (~$${lead.estimated_value})`,
        body: `${lead.name} · ${lead.vehicle_year} ${lead.vehicle_make} ${lead.vehicle_model} · ${lead.timeline} · quality ${lead.lead_quality_score}/100`,
        url: `/response-center?lead=${lead.id}`,
        tag: `lead-${lead.id}`,
      });
    if (SMS_ON() && typeof sendSms === 'function') await sendSms(tenantId, summary);
    if (typeof sendEmailAlert === 'function')
      await sendEmailAlert(tenantId, `New website lead: ${lead.name}`, summary);
  }

  /* ---------------- Response Center endpoints ----------------
   * These power the Response Center view: lead age, response SLA,
   * assignment, contact + appointment tracking. Protect them with your
   * existing JWT auth middleware when you mount the router — e.g.
   *   app.use('/api/response-center', requireAuth, router)
   * or add your middleware inline below.
   * ------------------------------------------------------------ */

  // GET /api/response-center?tenant_id=x — live queue with computed ages
  router.get('/response-center', async (req, res) => {
    const db = await getShopDb(req.query.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });

    const now = Date.now();
    const open = (db.data.leads || [])
      .filter((l) => !['COMPLETED', 'LOST'].includes(l.status))
      .map((l) => ({
        ...l,
        photo: l.photo ? true : false, // don't ship base64 in list view
        age_seconds: Math.floor((now - new Date(l.created_at).getTime()) / 1000),
        awaiting_first_response: l.first_response_at === null,
      }))
      .sort((a, b) => {
        // Uncontacted first, then newest
        if (a.awaiting_first_response !== b.awaiting_first_response)
          return a.awaiting_first_response ? -1 : 1;
        return new Date(b.created_at) - new Date(a.created_at);
      });

    // SLA snapshot for the dashboard header
    const responded = (db.data.leads || []).filter((l) => l.response_time_seconds != null);
    const avgResponse = responded.length
      ? Math.round(responded.reduce((s, l) => s + l.response_time_seconds, 0) / responded.length)
      : null;

    res.json({ leads: open, stats: { open: open.length, avg_response_seconds: avgResponse } });
  });

  // POST /api/leads/:id/assign  { tenant_id, employee }
  router.post('/leads/:id/assign', async (req, res) => {
    const { db, lead, error } = await findLead(req);
    if (error) return res.status(error.code).json({ error: error.msg });
    lead.assigned_to = String(req.body.employee || '');
    lead.assigned_at = new Date().toISOString();
    lead.updated_at = lead.assigned_at;
    await db.write();
    res.json({ ok: true, lead: strip(lead) });
  });

  // POST /api/leads/:id/contact  { tenant_id, method: 'call'|'text'|'email', reached: bool, note }
  router.post('/leads/:id/contact', async (req, res) => {
    const { db, lead, error } = await findLead(req);
    if (error) return res.status(error.code).json({ error: error.msg });

    const now = new Date().toISOString();
    lead.contact_attempts.push({
      method: String(req.body.method || 'call'),
      reached: !!req.body.reached,
      note: String(req.body.note || '').slice(0, 500),
      by: String(req.body.employee || lead.assigned_to || ''),
      at: now,
    });

    // First response = the speed-to-lead metric that decides close rate
    if (lead.first_response_at === null) {
      lead.first_response_at = now;
      lead.response_time_seconds = Math.floor(
        (new Date(now) - new Date(lead.created_at)) / 1000
      );
    }

    lead.contact_status = req.body.reached ? 'REACHED' : 'ATTEMPTED';
    if (lead.status === 'NEW_LEAD') lead.status = 'CONTACTED';
    lead.updated_at = now;
    await db.write();
    res.json({ ok: true, lead: strip(lead) });
  });

  // POST /api/leads/:id/appointment  { tenant_id, date, time, service, notes }
  router.post('/leads/:id/appointment', async (req, res) => {
    const { db, lead, error } = await findLead(req);
    if (error) return res.status(error.code).json({ error: error.msg });

    lead.appointment = {
      date: String(req.body.date || ''),
      time: String(req.body.time || ''),
      service: String(req.body.service || lead.service_requested),
      notes: String(req.body.notes || '').slice(0, 500),
      booked_at: new Date().toISOString(),
    };
    lead.appointment_status = 'SCHEDULED';
    lead.status = 'APPOINTMENT_SET';
    lead.updated_at = lead.appointment.booked_at;
    await db.write();

    // Land it on the shop calendar too
    db.data.appointments ||= [];
    db.data.appointments.push({
      id: crypto.randomUUID(),
      lead_id: lead.id,
      customer: lead.name,
      phone: lead.phone,
      service: lead.appointment.service,
      date: lead.appointment.date,
      time: lead.appointment.time,
      source: 'website-lead',
      created_at: lead.appointment.booked_at,
    });
    await db.write();

    if (automations) { try { await automations.emit(req.body.tenant_id || req.query.tenant_id, 'appointment.scheduled', lead); } catch (e) { console.error('[automations]', e.message); } }
    res.json({ ok: true, lead: strip(lead) });
  });

  // POST /api/leads/:id/status  { tenant_id, status }  — COMPLETED, LOST, etc.
  router.post('/leads/:id/status', async (req, res) => {
    const { db, lead, error } = await findLead(req);
    if (error) return res.status(error.code).json({ error: error.msg });
    const allowed = ['NEW_LEAD', 'CONTACTED', 'APPOINTMENT_SET', 'COMPLETED', 'LOST'];
    if (!allowed.includes(req.body.status))
      return res.status(422).json({ error: 'Invalid status' });
    lead.status = req.body.status;
    if (req.body.status === 'COMPLETED') {
      lead.appointment_status = 'COMPLETED';
      // roll into customer record (LTV / service history)
      if (typeof onCompleted === 'function') onCompleted(db, lead);
      if (automations) { try { await automations.emit(req.body.tenant_id || req.query.tenant_id, 'lead.completed', lead); } catch (e) { console.error('[automations]', e.message); } }
    }
    lead.updated_at = new Date().toISOString();
    await db.write();
    res.json({ ok: true, lead: strip(lead) });
  });

  /* ---------------- helpers ---------------- */

  async function findLead(req) {
    const db = await getShopDb(req.body.tenant_id || req.query.tenant_id);
    if (!db) return { error: { code: 404, msg: 'Unknown tenant' } };
    const lead = (db.data.leads || []).find((l) => l.id === req.params.id);
    if (!lead) return { error: { code: 404, msg: 'Lead not found' } };
    return { db, lead };
  }

  function strip(lead) {
    const { photo, ...rest } = lead;
    return { ...rest, has_photo: !!photo };
  }

  return router;
};

/* ---------------- key generation (run once per client site) ----------------
 * node -e "console.log('sfw_' + require('crypto').randomBytes(24).toString('hex'))"
 * Then add to the shop's db:
 *   db.data.website_api_keys = [{ key: 'sfw_...', label: 'tint landing page', active: true, created_at: '...' }]
 * --------------------------------------------------------------------------- */

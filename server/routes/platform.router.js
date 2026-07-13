/**
 * ShopFlow — SaaS Platform router (Part 3)
 * ------------------------------------------
 * Admin site settings, marketing analytics + cost-per-lead,
 * upsell tracking, and customer records with lifetime value.
 *
 * Mount in server.js:
 *   const platform = require('./routes/platform');
 *   // requireOwner = your existing JWT middleware that verifies the
 *   // logged-in user owns req.query.tenant_id / req.body.tenant_id
 *   app.use('/api', platform({ getShopDb, requireOwner }));
 *
 * Public route:   GET /api/site-config        (feeds the landing sites)
 * Owner routes:   everything else
 */

const express = require('express');
const crypto = require('crypto');

// Fields safe to expose publicly to landing sites — never keys or leads.
const PUBLIC_SETTINGS_FIELDS = [
  'brand', 'stats', 'pricing', 'tint_services', 'secondary_services',
  'reviews', 'gallery', 'calendar_availability',
];

module.exports = function platformRouter({ getShopDb, requireOwner }) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  const guard = typeof requireOwner === 'function' ? requireOwner : (req, res, next) => next();

  /* ================= SITE SETTINGS ================= */

  // PUBLIC — landing sites pull their config here (live-settings mode)
  router.get('/site-config', async (req, res) => {
    const db = await getShopDb(req.query.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    const s = db.data.site_settings || {};
    const pub = {};
    for (const f of PUBLIC_SETTINGS_FIELDS) if (s[f] !== undefined) pub[f] = s[f];
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ tenant_id: req.query.tenant_id, ...pub });
  });

  // OWNER — the admin settings screen writes here
  router.put('/site-config', guard, async (req, res) => {
    const db = await getShopDb(req.body.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });

    db.data.site_settings ||= {};
    const s = db.data.site_settings;

    // Whitelist-only merge — a settings write can never touch leads/keys
    for (const f of PUBLIC_SETTINGS_FIELDS) {
      if (req.body[f] !== undefined) s[f] = req.body[f];
    }
    s.updated_at = new Date().toISOString();
    await db.write();
    res.json({ ok: true, site_settings: s });
  });

  // OWNER — manage website API keys (issue/revoke, never exposes full keys back)
  router.post('/website-keys', guard, async (req, res) => {
    const db = await getShopDb(req.body.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    db.data.website_api_keys ||= [];
    const key = 'sfw_' + crypto.randomBytes(24).toString('hex');
    db.data.website_api_keys.push({
      key,
      label: String(req.body.label || 'landing site').slice(0, 100),
      active: true,
      created_at: new Date().toISOString(),
    });
    await db.write();
    // Shown once at creation — after this only label + last4 are listed
    res.status(201).json({ ok: true, key, label: req.body.label });
  });

  router.get('/website-keys', guard, async (req, res) => {
    const db = await getShopDb(req.query.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    res.json({
      keys: (db.data.website_api_keys || []).map((k) => ({
        label: k.label,
        last4: k.key.slice(-4),
        active: k.active,
        created_at: k.created_at,
      })),
    });
  });

  router.delete('/website-keys/:last4', guard, async (req, res) => {
    const db = await getShopDb(req.query.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    let hit = false;
    for (const k of db.data.website_api_keys || []) {
      if (k.key.endsWith(req.params.last4)) { k.active = false; hit = true; }
    }
    await db.write();
    res.json({ ok: hit });
  });

  /* ================= MARKETING ANALYTICS ================= */

  // OWNER — record ad spend so cost-per-lead can be computed
  // { tenant_id, campaign, source, amount, period_start, period_end }
  router.post('/ad-spend', guard, async (req, res) => {
    const db = await getShopDb(req.body.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    const amount = Number(req.body.amount);
    if (!req.body.campaign || !Number.isFinite(amount) || amount < 0)
      return res.status(422).json({ error: 'campaign and amount required' });

    db.data.ad_spend ||= [];
    db.data.ad_spend.push({
      id: crypto.randomUUID(),
      campaign: String(req.body.campaign).slice(0, 200),
      source: String(req.body.source || 'facebook'),
      amount,
      period_start: String(req.body.period_start || ''),
      period_end: String(req.body.period_end || ''),
      created_at: new Date().toISOString(),
    });
    await db.write();
    res.status(201).json({ ok: true });
  });

  // OWNER — the marketing dashboard: leads by source/campaign, CPL, revenue
  router.get('/marketing-analytics', guard, async (req, res) => {
    const db = await getShopDb(req.query.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });

    const since = req.query.since ? new Date(req.query.since) : null;
    const leads = (db.data.leads || []).filter(
      (l) => !since || new Date(l.created_at) >= since
    );
    const spend = db.data.ad_spend || [];

    const roll = (keyFn) => {
      const m = new Map();
      for (const l of leads) {
        const k = keyFn(l) || '(none)';
        const r = m.get(k) || {
          leads: 0, contacted: 0, appointments: 0, completed: 0,
          pipeline_value: 0, won_value: 0, quality_sum: 0,
        };
        r.leads++;
        if (l.first_response_at) r.contacted++;
        if (['APPOINTMENT_SET', 'COMPLETED'].includes(l.status)) r.appointments++;
        if (l.status === 'COMPLETED') {
          r.completed++;
          r.won_value += l.estimated_value || 0;
          r.won_value += (l.upsells || [])
            .filter((u) => u.status === 'accepted')
            .reduce((s, u) => s + (u.value || 0), 0);
        }
        r.pipeline_value += l.estimated_value || 0;
        r.quality_sum += l.lead_quality_score || 0;
        m.set(k, r);
      }
      return Object.fromEntries(
        [...m.entries()].map(([k, r]) => [k, {
          ...r,
          avg_quality: r.leads ? Math.round(r.quality_sum / r.leads) : 0,
          close_rate: r.leads ? +(r.completed / r.leads).toFixed(3) : 0,
        }])
      );
    };

    const bySource = roll((l) => l.source);
    const byCampaign = roll((l) => l.campaign);

    // Cost per lead: spend on a campaign / leads attributed to it
    const cpl = {};
    const spendByCampaign = {};
    for (const s of spend)
      spendByCampaign[s.campaign] = (spendByCampaign[s.campaign] || 0) + s.amount;
    for (const [campaign, total] of Object.entries(spendByCampaign)) {
      const n = byCampaign[campaign]?.leads || 0;
      const won = byCampaign[campaign]?.won_value || 0;
      cpl[campaign] = {
        spend: total,
        leads: n,
        cost_per_lead: n ? +(total / n).toFixed(2) : null,
        cost_per_appointment: byCampaign[campaign]?.appointments
          ? +(total / byCampaign[campaign].appointments).toFixed(2) : null,
        revenue: won,
        roas: total ? +(won / total).toFixed(2) : null,
      };
    }

    // Speed-to-lead
    const responded = leads.filter((l) => l.response_time_seconds != null);
    res.json({
      totals: {
        leads: leads.length,
        avg_response_seconds: responded.length
          ? Math.round(responded.reduce((s, l) => s + l.response_time_seconds, 0) / responded.length)
          : null,
        pipeline_value: leads.reduce((s, l) => s + (l.estimated_value || 0), 0),
      },
      by_source: bySource,
      by_campaign: byCampaign,
      cost_per_lead: cpl,
    });
  });

  /* ================= UPSELLS + CUSTOMERS (LTV) ================= */

  // OWNER — attach an upsell to a lead: { tenant_id, service, value, status }
  // status: offered | accepted | declined
  router.post('/leads/:id/upsell', guard, async (req, res) => {
    const db = await getShopDb(req.body.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    const lead = (db.data.leads || []).find((l) => l.id === req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    lead.upsells ||= [];
    lead.upsells.push({
      id: crypto.randomUUID(),
      service: String(req.body.service || '').slice(0, 100),
      value: Number(req.body.value) || 0,
      status: ['offered', 'accepted', 'declined'].includes(req.body.status)
        ? req.body.status : 'offered',
      note: String(req.body.note || '').slice(0, 300),
      at: new Date().toISOString(),
    });
    lead.updated_at = new Date().toISOString();
    await db.write();

    // Keep the customer record in sync if this lead already converted
    if (lead.status === 'COMPLETED') upsertCustomer(db, lead);
    await db.write();
    res.status(201).json({ ok: true, upsells: lead.upsells });
  });

  // Suggested upsells for a lead — tint buyers get protection offers
  router.get('/leads/:id/upsell-suggestions', guard, async (req, res) => {
    const db = await getShopDb(req.query.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    const lead = (db.data.leads || []).find((l) => l.id === req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const pricing = (db.data.site_settings || {}).pricing || {};
    const isTint = !!lead.tint_type;
    const suggestions = isTint
      ? [
          { service: 'Ceramic Coating', pitch: 'Protect the paint like you just protected the glass', value: pricing['Ceramic Coating'] || 900 },
          { service: 'PPF', pitch: 'New-vehicle front-end protection while it\'s in the bay', value: pricing['PPF'] || 1500 },
          { service: 'Detail Package', pitch: 'Full interior/exterior detail same appointment', value: pricing['Detailing'] || 300 },
        ]
      : [
          { service: 'Ceramic Tint', pitch: 'Complete the protection with heat-rejecting glass', value: pricing['Ceramic Tint'] || 450 },
        ];
    res.json({ lead_id: lead.id, suggestions });
  });

  // Customer directory with LTV — GET /api/customers?tenant_id=x
  router.get('/customers', guard, async (req, res) => {
    const db = await getShopDb(req.query.tenant_id);
    if (!db) return res.status(404).json({ error: 'Unknown tenant' });
    const customers = Object.values(db.data.customers || {})
      .sort((a, b) => b.lifetime_value - a.lifetime_value);
    res.json({ customers, count: customers.length });
  });

  /**
   * Customer record upsert — call this when a lead hits COMPLETED
   * (the website-leads router's /status endpoint does this automatically
   * when you pass it { onCompleted: platform.recordCompletion }).
   * Keyed by normalized phone: repeat business rolls into one record.
   */
  function upsertCustomer(db, lead) {
    db.data.customers ||= {};
    const key = String(lead.phone || '').replace(/\D/g, '');
    if (!key) return;

    const c = db.data.customers[key] || {
      phone: lead.phone,
      name: lead.name,
      email: lead.email,
      first_service_at: lead.created_at,
      service_history: [],
      lifetime_value: 0,
    };
    c.name = lead.name || c.name;
    c.email = lead.email || c.email;

    // Avoid double-recording the same lead
    if (!c.service_history.some((h) => h.lead_id === lead.id)) {
      c.service_history.push({
        lead_id: lead.id,
        service: lead.service_requested,
        vehicle: `${lead.vehicle_year} ${lead.vehicle_make} ${lead.vehicle_model}`.trim(),
        value: lead.estimated_value || 0,
        completed_at: new Date().toISOString(),
      });
    }
    // Accepted upsells count toward LTV, recorded per-upsell id
    for (const u of lead.upsells || []) {
      if (u.status === 'accepted' && !c.service_history.some((h) => h.upsell_id === u.id)) {
        c.service_history.push({
          lead_id: lead.id,
          upsell_id: u.id,
          service: u.service,
          value: u.value,
          completed_at: u.at,
        });
      }
    }
    c.lifetime_value = c.service_history.reduce((s, h) => s + (h.value || 0), 0);
    c.last_service_at = new Date().toISOString();
    db.data.customers[key] = c;
  }

  router.recordCompletion = upsertCustomer; // exposed for the leads router hook
  return router;
};

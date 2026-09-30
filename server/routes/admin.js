const router = require('express').Router();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAdmin } = require('../middleware');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb } = require('../db');
const { upsertLead, getLeadPayloads, normalizeSource } = require('../leads-core');
const { shopInsights, shopRate } = require('../admin-insights');


// ── ADMIN: backfill lead sources ──────────────────────────────────────────────
// One-off repair for leads written before source normalisation existed, when
// utm_source reached the CRM raw: the same Meta channel could be stored as
// `facebook`, `fb` or `facebook_mobile_feed`, splitting reporting three ways.
//
// Two deliberate limits:
//   • DRY RUN BY DEFAULT. Pass { apply: true } to write. The dry run returns
//     exactly what would change so it can be read before anything is touched.
//   • It does NOT enrol anything in the 30-day follow-up sequence. Enrolment
//     is for leads arriving now; retroactively enrolling months of old leads
//     would dump a queue of stale people into Tasks and start Angelo texting
//     customers who enquired in March.
// The pre-normalisation value is kept on `sourceRaw`, so this is reversible.
router.post('/api/admin/backfill-lead-sources', requireAdmin, (req, res) => {
  try {
    const apply = req.body.apply === true;
    const onlyShop = String(req.body.shopId || '').trim();
    const shops = (master.get('shops').value() || [])
      .filter(s => !onlyShop || s.id === onlyShop);

    const changes = {};   // "fb → facebook" : count
    const perShop = [];
    let scanned = 0, changed = 0;

    shops.forEach(shop => {
      const db = getShopDb(shop.id);
      const leads = shopHelpers(db).getAll('leads');
      let shopChanged = 0;

      leads.forEach(lead => {
        scanned++;
        const before = String(lead.source || '').trim().toLowerCase();
        const after = normalizeSource(before);
        if (!before || before === after) return;

        const key = `${before} → ${after}`;
        changes[key] = (changes[key] || 0) + 1;
        changed++; shopChanged++;

        if (apply) {
          if (!lead.sourceRaw) lead.sourceRaw = before;   // never overwrite an earlier original
          lead.source = after;
        }
      });

      if (shopChanged) perShop.push({ shop: shop.name || shop.id, changed: shopChanged });
      if (apply && shopChanged) db.write();
    });

    res.json({ ok: true, dryRun: !apply, scanned, changed, changes, perShop });
  } catch (e) {
    console.error('Lead source backfill error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── ADMIN: overview stats ─────────────────────────────────────────────────────
router.get('/api/admin/stats', requireAdmin, (req, res) => {
  const shops = master.get('shops').value() || [];
  const MRR_GOAL = Number((master.get('platformSettings').value() || {}).mrrGoal) || 25000;

  const activeShops  = shops.filter(s => s.active);
  const churned      = shops.filter(s => !s.active);

  // Per-plan-label rollup from ACTUAL per-shop rates (active shops only).
  const planStats = {};
  activeShops.forEach(s => {
    const label = s.plan || 'custom';
    planStats[label] = planStats[label] || { count: 0, revenue: 0 };
    planStats[label].count++; planStats[label].revenue += shopRate(s);
  });
  const planCounts = {};
  Object.entries(planStats).forEach(([k, v]) => { planCounts[k] = v.count; });

  const mrr = activeShops.reduce((sum, s) => sum + shopRate(s), 0);

  // Month-over-month: shops created this month vs last month
  const now = new Date();
  const thisMonthStr = now.toISOString().slice(0, 7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = lastMonth.toISOString().slice(0, 7);

  const newThisMonth  = activeShops.filter(s => (s.createdAt||'').startsWith(thisMonthStr));
  const newLastMonth  = activeShops.filter(s => (s.createdAt||'').startsWith(lastMonthStr));
  const newMrrThisMonth = newThisMonth.reduce((sum, s) => sum + shopRate(s), 0);
  const newMrrLastMonth = newLastMonth.reduce((sum, s) => sum + shopRate(s), 0);

  // Last month's implied MRR (shops active before this month)
  const lastMonthShops = shops.filter(s => s.active && (s.createdAt||'') < thisMonthStr + '-01');
  const lastMrr = lastMonthShops.reduce((sum, s) => sum + shopRate(s), 0);
  const mrrGrowth = lastMrr > 0 ? Math.round(((mrr - lastMrr) / lastMrr) * 100) : null;

  // Churn rate (inactive / total ever)
  const churnRate = shops.length > 0 ? Math.round((churned.length / shops.length) * 100) : 0;

  // How many more shops to hit the goal — per existing plan label (at that
  // label's average real rate) so the "path" reflects what you actually charge.
  const mrrToGoal = Math.max(0, MRR_GOAL - mrr);
  const shopsNeeded = {};
  Object.entries(planStats).forEach(([label, v]) => {
    const avgRate = v.count ? v.revenue / v.count : 0;
    if (avgRate > 0) shopsNeeded[label] = { rate: Math.round(avgRate * 100) / 100, needed: Math.ceil(mrrToGoal / avgRate) };
  });

  // Avg revenue per shop
  const avgMrr = activeShops.length ? (mrr / activeShops.length) : 0;

  // LTV estimate (avg MRR / monthly churn rate, assuming avg 12mo if no churn)
  const monthlyChurnRate = shops.length > 0 ? (churned.length / Math.max(shops.length, 1)) / 12 : 0;
  const ltv = monthlyChurnRate > 0 ? Math.round(avgMrr / monthlyChurnRate) : avgMrr * 24;

  const oneDayAgo  = new Date(Date.now() - 24 * 3600000).toISOString();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();

  // What ShopFlow is actually producing for its clients, summed across active
  // shops: the lead funnel this month, the revenue their shops did, and what
  // the AI receptionist recovered. Same per-shop math as the shop profile.
  const clientResults = { leadsThisMonth: 0, leadsLastMonth: 0, bookedThisMonth: 0, revenueThisMonth: 0, revenueLastMonth: 0, aiRecoveredThisMonth: 0, aiRecoveredTotal: 0, callsThisMonth: 0, aiCalls: 0, leadsTotal: 0, convertedTotal: 0, shopsCounted: 0 };
  activeShops.forEach(s => {
    try {
      const { insights: ins } = shopInsights(s);
      clientResults.leadsThisMonth      += ins.leads.thisMonth || 0;
      clientResults.leadsLastMonth      += ins.leads.lastMonth || 0;
      clientResults.bookedThisMonth     += ins.leads.convertedThisMonth || 0;
      clientResults.leadsTotal          += ins.leads.total || 0;
      clientResults.convertedTotal      += ins.leads.converted || 0;
      clientResults.callsThisMonth      += ins.leads.callsThisMonth || 0;
      clientResults.revenueThisMonth    += ins.revenue.thisMonth || 0;
      clientResults.revenueLastMonth    += ins.revenue.lastMonth || 0;
      clientResults.aiRecoveredThisMonth += ins.ai.recoveredThisMonth || 0;
      clientResults.aiRecoveredTotal    += ins.ai.recovered || 0;
      clientResults.aiCalls             += ins.ai.calls || 0;
      clientResults.shopsCounted++;
    } catch(e) {}
  });
  clientResults.bookRateThisMonth = clientResults.leadsThisMonth ? Math.round(clientResults.bookedThisMonth / clientResults.leadsThisMonth * 100) : null;

  res.json({
    clientResults,
    totalShops: shops.length,
    activeShops: activeShops.length,
    churnedShops: churned.length,
    churnRate,
    activeToday: activeShops.filter(s => s.lastActivity && s.lastActivity > oneDayAgo).length,
    activeWeek:  activeShops.filter(s => s.lastActivity && s.lastActivity > oneWeekAgo).length,
    mrr, arr: mrr * 12, avgMrr, ltv,
    mrrGrowth,
    newMrrThisMonth,
    newMrrLastMonth,
    newShopsThisMonth: newThisMonth.length,
    mrrGoal: MRR_GOAL,
    mrrToGoal,
    mrrPct: Math.min(100, Math.round((mrr / MRR_GOAL) * 100)),
    shopsNeeded,
    planBreakdown: planCounts,
    planStats,
    recentShops: [...shops].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8).map(s => ({
      id: s.id, shopName: s.shopName, plan: s.plan, rate: shopRate(s), email: s.email, createdAt: s.createdAt, active: s.active,
    })),
  });
});

// ── ADMIN: all shops with per-shop stats ──────────────────────────────────────
router.get('/api/admin/shops', requireAdmin, (req, res) => {
  const shops = master.get('shops').value() || [];
  const result = shops.map(s => {
    let customers = 0, appointments = 0, staff = 0, services = 0, stripeConnected = false, twilioConfigured = false, bookingEnabled = true;
    let month = { leads: 0, booked: 0, revenue: 0, aiRecovered: 0 };
    try {
      const ins = shopInsights(s);
      customers    = ins.customers.length;
      appointments = ins.appointments.length;
      staff        = ins.staff.filter(b => b.active !== false).length;
      services     = ins.services.length;
      stripeConnected  = !!(ins.settings.stripe?.connectAccountId && ins.settings.stripe?.onboardingComplete);
      twilioConfigured = !!(twilioClient && shopFromNumber(s.id));
      bookingEnabled   = ins.settings.bookingEnabled !== false;
      month = { leads: ins.insights.leads.thisMonth, booked: ins.insights.leads.convertedThisMonth, revenue: ins.insights.revenue.thisMonth, aiRecovered: ins.insights.ai.recoveredThisMonth };
    } catch(e) {}
    return { id: s.id, shopName: s.shopName, slug: s.slug, email: s.email, phone: s.phone, plan: s.plan, monthlyRate: s.monthlyRate != null ? s.monthlyRate : null, rate: shopRate(s), notes: s.notes || '', features: s.features || {}, active: s.active, createdAt: s.createdAt, lastActivity: s.lastActivity, customers, appointments, staff, services, stripeConnected, twilioConfigured, bookingEnabled, month };
  });
  res.json(result);
});

// ── ADMIN: single shop profile ────────────────────────────────────────────────
router.get('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const { settings, staff, services, customers, appointments, apptThisMonth, recentAppts, insights } = shopInsights(shop);

  // metaPageToken is a long-lived Meta page access token — never ship it to the
  // browser. Same stance as settings.twilio.authToken / emailSmtp.pass in
  // routes/shop.js: the panel only needs to know whether one is configured.
  const shopSafe = { ...shop, metaPageToken: undefined, metaPageTokenSet: !!shop.metaPageToken };
  res.json({
    shop: shopSafe, settings: { shopName: settings.shopName, tagline: settings.tagline, phone: settings.phone, address: settings.address, bookingEnabled: settings.bookingEnabled, bookingMode: settings.bookingMode, accentColor: settings.accentColor, googleReviewLink: settings.googleReviewLink, loyalty: settings.loyalty, deposit: settings.deposit, stripeConnected: !!(settings.stripe?.connectAccountId && settings.stripe?.onboardingComplete), squareConnected: !!((settings.square && settings.square.accessToken) ), twilioConfigured: !!(twilioClient && shopFromNumber(shop.id)) },
    staff, services,
    stats: { totalCustomers: customers.length, totalAppointments: appointments.length, apptThisMonth, activeStaff: staff.filter(b => b.active !== false).length },
    recentAppointments: recentAppts,
    insights,
  });
});

// ── ADMIN: create shop ────────────────────────────────────────────────────────
router.post('/api/admin/shops/create', requireAdmin, async (req, res) => {
  try {
    const { shopName, email, password, phone, plan, monthlyRate, industry } = req.body;
    if (!shopName || !email || !password) return res.status(400).json({ ok: false, error: 'shopName, email, password required' });
    const existing = master.get('accounts').find({ email: email.toLowerCase() }).value();
    if (existing) return res.status(400).json({ ok: false, error: 'Email already exists' });
    const shopId = uuidv4();
    const shopSlug = slug(shopName) || genId('shop');
    const slugExists = master.get('shops').find({ slug: shopSlug }).value();
    const finalSlug = slugExists ? shopSlug + '-' + genId('') : shopSlug;
    const passwordHash = await bcrypt.hash(password, 10);
    const accountId = uuidv4();
    const rate = (monthlyRate != null && monthlyRate !== '') ? (Number(monthlyRate) || 0) : null;
    master.get('accounts').push({ id: accountId, shopId, email: email.toLowerCase(), passwordHash, createdAt: new Date().toISOString(), plan: plan || 'pro', active: true }).write();
    master.get('shops').push({ id: shopId, accountId, shopName, slug: finalSlug, email: email.toLowerCase(), phone: phone || '', plan: plan || 'pro', monthlyRate: rate, active: true, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() }).write();
    const shopDb = getShopDb(shopId);
    initShopDb(shopDb, { shopName, email, phone, industry });
    res.json({ ok: true, shopId, shopSlug: finalSlug, shopName, crmUrl: '/shop/' + finalSlug, bookUrl: '/book/' + finalSlug });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── ADMIN: update shop (plan, rate, active, name, contact, notes) ─────────────
router.patch('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
  // metaPageId routes inbound Meta lead-ad webhooks to this tenant; metaPageToken
  // is that page's long-lived access token (falls back to META_PAGE_ACCESS_TOKEN).
  const allowed = ['plan', 'monthlyRate', 'monthlyQuota', 'estAcceptRate', 'active', 'shopName', 'phone', 'email', 'twilioFromNumber', 'metaPageId', 'metaPageToken', 'features', 'notes', 'advisorNotes', 'advisorAuto'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  // Custom rate: number, or null/'' to clear.
  if (updates.monthlyRate !== undefined) updates.monthlyRate = (updates.monthlyRate === null || updates.monthlyRate === '') ? null : (Number(updates.monthlyRate) || 0);
  // Monthly revenue quota for the shop (drives %-to-quota on the profile).
  if (updates.monthlyQuota !== undefined) updates.monthlyQuota = (updates.monthlyQuota === null || updates.monthlyQuota === '') ? null : (Number(updates.monthlyQuota) || 0);
  // Manual estimate-accept-rate override (0–100); null/'' clears back to computed.
  if (updates.estAcceptRate !== undefined) updates.estAcceptRate = (updates.estAcceptRate === null || updates.estAcceptRate === '') ? null : Math.min(100, Math.max(0, Number(updates.estAcceptRate) || 0));
  if (updates.plan !== undefined) updates.plan = String(updates.plan).trim().slice(0, 40) || 'custom';
  // Growth Advisor: per-shop playbook notes (free text) + weekly auto-run opt-out.
  if (updates.advisorNotes !== undefined) updates.advisorNotes = String(updates.advisorNotes || '').slice(0, 4000);
  if (updates.advisorAuto !== undefined) updates.advisorAuto = updates.advisorAuto !== false && updates.advisorAuto !== 'false';
  // Trimmed so a value pasted from the Meta dashboard with stray whitespace
  // still matches the page_id on an inbound webhook. '' clears the mapping.
  if (updates.metaPageId !== undefined) updates.metaPageId = String(updates.metaPageId || '').trim().slice(0, 40);
  // The GET above returns the token blanked, so a client that echoes the profile
  // back would otherwise wipe it. '' means "leave as-is"; clearing is explicit
  // (send null). metaPageId has no such hazard — it's never redacted.
  if (updates.metaPageToken !== undefined) {
    if (updates.metaPageToken === null) updates.metaPageToken = '';
    else if (!String(updates.metaPageToken).trim()) delete updates.metaPageToken;
    else updates.metaPageToken = String(updates.metaPageToken).trim();
  }
  master.get('shops').find({ id: req.params.shopId }).assign(updates).write();
  master.get('accounts').find({ id: shop.accountId }).assign(updates.plan ? { plan: updates.plan } : {}).assign(updates.active !== undefined ? { active: updates.active } : {}).write();
  res.json({ ok: true });
});

// ── ADMIN: manually add a lead to a shop ──────────────────────────────────────
// A hand-entry fallback for when an upstream pipeline (e.g. Meta lead-ads via
// Make) breaks and leads land nowhere. Goes through the same leads-core.upsertLead
// as the public form, so a hand-entered lead dedupes by phone (safe to re-run a
// recovery batch), notifies the owner, and attributes identically. Accepts one
// lead per call; the admin UI loops for bulk paste.
router.post('/api/admin/shop/:shopId/lead', requireAdmin, (req, res) => {
  try {
    const shop = master.get('shops').find({ id: req.params.shopId }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });

    const name  = String(req.body.name  || '').trim().slice(0, 80);
    const phone = String(req.body.phone || '').trim().slice(0, 25);
    const email = String(req.body.email || '').trim().slice(0, 120);
    const notes = String(req.body.notes || '').trim().slice(0, 1000);
    const digits = phone.replace(/\D/g, '');
    // Admin is trusted, so requirements are loose — but a lead with neither a
    // name nor a usable phone is unusable noise, so reject that.
    if (!name && digits.length < 7) {
      return res.status(400).json({ ok: false, error: 'Enter at least a name or a phone number.' });
    }

    const v = req.body.vehicle || {};
    const vehicle = (v.year || v.make || v.model || v.color)
      ? { year: String(v.year||'').trim().slice(0,20), make: String(v.make||'').trim().slice(0,40),
          model: String(v.model||'').trim().slice(0,40), color: String(v.color||'').trim().slice(0,30) }
      : null;

    const services = Array.isArray(req.body.services)
      ? [...new Set(req.body.services.map(x => String(x||'').trim()).filter(Boolean))].slice(0, 20)
      : [];

    // Attribution: default to 'facebook' since this fallback exists mainly to
    // recover Meta leads, but honor an explicit source when the admin sets one.
    const source = String(req.body.source || 'facebook').trim().toLowerCase().slice(0, 40) || 'facebook';
    const utm = source ? { source } : {};

    const db = getShopDb(shop.id);
    const { lead, isNew } = upsertLead(db, shop, {
      name, phone, email, notes, vehicle, servicesInterested: services, utm, source, referrer: 'admin-manual',
    });
    res.json({ ok: true, isNew, leadId: lead.id, name: lead.name, phone: lead.phone });
  } catch (e) {
    console.error('Admin add-lead error:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong adding the lead.' });
  }
});

// ── ADMIN: recent integration (Meta/Make) lead payloads — diagnostics ─────────
// Shows exactly what an upstream POSTed to the public lead endpoint, so a blank
// "Test Lead" can be traced: empty {} from Make (mapping/fetch broken upstream)
// vs. real data under keys we didn't map. In-memory, cleared on restart.
router.get('/api/admin/lead-payloads', requireAdmin, (req, res) => {
  res.json(getLeadPayloads());
});

// ── ADMIN: seed the demo shop ─────────────────────────────────────────────────
// Rebuilds the generic detail-shop demo (seed-demo-detail.js): vehicle-size
// pricing, add-ons, estimates, a membership, before/after photos. It is the
// only demo tenant — login demo@detail.com / demo1234, CRM at /shop/demo-detail.
router.post('/api/admin/seed-demo', requireAdmin, (req, res) => {
  try {
    const shopId = require('../../seed-demo-detail')({ force: true });
    const shop = master.get('shops').find({ id: shopId }).value();
    const { customers, appointments } = shopInsights(shop);
    const done = appointments.filter(a => a.status === 'done');
    res.json({ ok: true, shopId, slug: shop.slug, shopName: shop.shopName, email: shop.email, password: 'demo1234',
      clients: customers.length, appointments: appointments.length, completed: done.length,
      revenue: done.reduce((t, a) => t + (Number(a.price) || 0), 0) });
  } catch (e) {
    console.error('Seed demo error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── ADMIN: platform settings (get) ───────────────────────────────────────────
router.get('/api/admin/platform-settings', requireAdmin, (req, res) => {
  const ps = master.get('platformSettings').value() || {};
  res.json({ requirePayment: ps.requirePayment !== false, mrrGoal: Number(ps.mrrGoal) || 25000 });
});

// ── ADMIN: platform settings (update) ────────────────────────────────────────
router.patch('/api/admin/platform-settings', requireAdmin, (req, res) => {
  const allowed = ['requirePayment', 'mrrGoal'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (updates.mrrGoal !== undefined) updates.mrrGoal = Math.max(1, Number(updates.mrrGoal) || 25000);
  master.get('platformSettings').assign(updates).write();
  res.json({ ok: true });
});

// ── ADMIN: SMS / Twilio status (shared account, all shops) ───────────────────
router.get('/api/admin/sms-status', requireAdmin, (req, res) => {
  const shops = master.get('shops').value() || [];
  let smsActiveShops = 0;
  shops.forEach(s => { if (twilioClient && shopFromNumber(s.id)) smsActiveShops++; });
  res.json({
    connected:      !!twilioClient,
    defaultFrom:    TWILIO_DEFAULT_FROM || null,
    totalShops:     shops.length,
    smsActiveShops,
  });
});

// ── ADMIN: send a test SMS through the shared Twilio account ──────────────────
router.post('/api/admin/sms-test', requireAdmin, async (req, res) => {
  if (!twilioClient)        return res.json({ ok: false, error: 'Twilio not connected — add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Railway, then redeploy.' });
  if (!TWILIO_DEFAULT_FROM) return res.json({ ok: false, error: 'No sending number — add TWILIO_FROM_NUMBER in Railway, then redeploy.' });
  let digits = String(req.body.to || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return res.json({ ok: false, error: 'Enter a valid 10-digit US phone number.' });
  try {
    const msg = await twilioClient.messages.create({
      from: TWILIO_DEFAULT_FROM,
      to:   '+1' + digits,
      body: 'ShopFlow test ✅ Your SMS is live and sending correctly.',
    });
    res.json({ ok: true, sid: msg.sid });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── ADMIN: demos ─────────────────────────────────────────────────────────────
router.get('/api/admin/demos', requireAdmin, (req, res) => {
  res.json(master.get('demos').value().sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time)));
});
router.patch('/api/admin/demos/:id', requireAdmin, (req, res) => {
  const demo = master.get('demos').find({ id: req.params.id }).value();
  if (!demo) return res.status(404).json({ ok: false });
  const { status, notes } = req.body;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (notes  !== undefined) updates.notes  = notes;
  master.get('demos').find({ id: req.params.id }).assign(updates).write();
  res.json({ ok: true });
});
router.delete('/api/admin/demos/:id', requireAdmin, (req, res) => {
  master.get('demos').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// ── ADMIN: delete shop ────────────────────────────────────────────────────────
router.delete('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
  try {
    const shopDir = path.join(SHOPS_DIR, req.params.shopId);
    if (fs.existsSync(shopDir)) fs.rmSync(shopDir, { recursive: true, force: true });
  } catch(e) { console.error('Delete shop dir error:', e.message); }
  master.get('shops').remove({ id: req.params.shopId }).write();
  master.get('accounts').remove({ shopId: req.params.shopId }).write();
  res.json({ ok: true });
});
// ── ADMIN: list accounts (recovery aid — find the exact login email) ──────────
// Read-only. Never returns password hashes. Used to identify which email a shop
// actually logs in with when an owner is locked out.
router.get('/api/admin/accounts', requireAdmin, (req, res) => {
  const shops = master.get('shops').value() || [];
  const shopById = {};
  shops.forEach(s => { shopById[s.id] = s; });
  const accounts = (master.get('accounts').value() || []).map(a => ({
    email: a.email,
    role: a.role || 'full',
    active: a.active !== false,
    shopId: a.shopId,
    shopName: shopById[a.shopId]?.shopName || null,
    shopSlug: shopById[a.shopId]?.slug || null,
    createdAt: a.createdAt,
  }));
  res.json({ ok: true, count: accounts.length, accounts });
});

// ── ADMIN: set an account password (recovery — no current password needed) ────
// The only reset path when an owner is locked out: there is no forgot-password
// flow, and every other password-write requires a valid session. Admin-gated.
router.post('/api/admin/accounts/set-password', requireAdmin, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    const account = master.get('accounts').find({ email: String(email).toLowerCase() }).value();
    if (!account) return res.status(404).json({ ok: false, error: 'No account with that email' });
    const passwordHash = await bcrypt.hash(password, 10);
    master.get('accounts').find({ id: account.id }).assign({ passwordHash, active: true }).write();
    res.json({ ok: true, email: account.email, shopId: account.shopId, reactivated: account.active === false });
  } catch(e) {
    console.error('Admin set-password error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to set password' });
  }
});

// ── ADMIN: create a client-portal login for a shop ────────────────────────────
// A client account is bound to exactly one shop and can ONLY use /api/client/*
// (see middleware.js). Meant for outside collaborators — e.g. a marketing
// vendor — so the owner hands over a credential we generate, no self-serve.
router.post('/api/admin/accounts/create-client', requireAdmin, async (req, res) => {
  try {
    const { shop: shopKey, email, password, name } = req.body || {};
    if (!shopKey || !email || !password) return res.status(400).json({ ok: false, error: 'shop, email, and password required' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    const shop = master.get('shops').find(s => s.slug === shopKey || s.id === shopKey).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'No shop matches ' + shopKey });
    const existing = master.get('accounts').find({ email: String(email).toLowerCase() }).value();
    if (existing) return res.status(400).json({ ok: false, error: 'An account with this email already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    master.get('accounts').push({
      id: uuidv4(),
      shopId: shop.id,
      email: String(email).toLowerCase(),
      passwordHash,
      name: String(name || 'Client').slice(0, 60),
      role: 'client',
      createdAt: new Date().toISOString(),
      active: true,
    }).write();
    res.json({ ok: true, email: String(email).toLowerCase(), shopSlug: shop.slug, portalUrl: '/portal' });
  } catch(e) {
    console.error('Admin create-client error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to create client account' });
  }
});

// ── ADMIN: proof sheet — the sales evidence for one shop ─────────────────────
// Rolls the shop's real call history + AI attribution into the numbers a sales
// conversation needs: calls handled, after-hours saves, the AI funnel, revenue
// recovered, and the best transcripts. Read-only. `:shopKey` accepts slug or id.
//
// The revenue/funnel math deliberately MIRRORS the owner dashboard
// (GET /api/shop/revenue in routes/shop.js) — the proof sheet must never quote
// a number the owner's own screen would contradict. If that block changes,
// change this one to match.
router.get('/api/admin/shop/:shopKey/proof', requireAdmin, (req, res) => {
  try {
    const key = req.params.shopKey;
    const shop = master.get('shops').find(s => s.slug === key || s.id === key).value();
    if (!shop) return res.status(404).json({ error: 'No shop matches ' + key });
    const db = getShopDb(shop.id);
    const settings = db.get('settings').value() || {};
    const calls = (db.get('calls').value() || []).filter(c => c && c.direction !== 'outbound');
    const leads = db.get('leads').value() || [];
    const appointments = db.get('appointments').value() || [];

    const onlyDigits = s => String(s || '').replace(/\D/g, '');
    const last10 = s => onlyDigits(s).slice(-10);
    const round2 = n => Math.round(n * 100) / 100;

    // After-hours: outside 8am–6pm or Sunday, in the shop's timezone. A blunt
    // definition on purpose — it's a sales stat, not payroll; the label in the
    // rendered sheet says exactly this.
    const TZ = shop.timezone || settings.timezone || process.env.DEFAULT_TZ || 'America/Denver';
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false, weekday: 'short' });
    const afterHours = iso => {
      if (!iso) return false;
      try {
        const parts = fmt.formatToParts(new Date(iso));
        const hour = Number(parts.find(p => p.type === 'hour')?.value);
        const wd = parts.find(p => p.type === 'weekday')?.value;
        return wd === 'Sun' || hour < 8 || hour >= 18;
      } catch { return false; }
    };

    const staffAnswered = calls.filter(c => c.accepted);
    const aiCalls = calls.filter(c => c.voiceAI);
    const voicemails = calls.filter(c => !c.accepted && !c.voiceAI && (c.transcript || c.recording));
    const missedUnhandled = calls.filter(c => c.missed && !c.voiceAI && !c.transcript && !c.recording);
    const afterHoursCalls = calls.filter(c => afterHours(c.startedAt));

    // ── AI funnel + Revenue Recovered — mirrored from /api/shop/revenue ──────
    const quoteOf = l => Number(
      l.quotedAmount != null ? l.quotedAmount
      : (l.ai && l.ai.quotedPrice != null) ? l.ai.quotedPrice
      : (l.ai && l.ai.budget));
    const aiLeads = leads.filter(l => l.ai && l.ai.source === 'voice');
    const aiCustCap = new Map(), aiPhoneCap = new Map();
    aiLeads.forEach(l => {
      const cap = String(l.ai.generatedAt || l.createdAt || '').slice(0, 10);
      if (l.customerId) aiCustCap.set(l.customerId, cap);
      const ph = last10(l.phone); if (ph.length === 10) aiPhoneCap.set(ph, cap);
    });
    const done = appointments.filter(a => a.status === 'done');
    const aiDone = done.filter(a => {
      if (a.source === 'ai-voice') return true;
      const cap = (a.customerId && aiCustCap.get(a.customerId)) || aiPhoneCap.get(last10(a.customerPhone));
      return !!cap && String(a.date || '') >= cap;
    });
    const realizedCust = new Set(aiDone.map(a => a.customerId).filter(Boolean));
    const realizedPhone = new Set(aiDone.map(a => last10(a.customerPhone)).filter(p => p.length === 10));
    const aiPipeline = aiLeads.filter(l => {
      if (!(quoteOf(l) > 0)) return false;
      const ph = last10(l.phone);
      return !((l.customerId && realizedCust.has(l.customerId)) || (ph.length === 10 && realizedPhone.has(ph)));
    });
    const outcomeType = c => (c.voiceAI.outcome && c.voiceAI.outcome.type) || null;
    const leadById = new Map(leads.map(l => [l.id, l]));
    const gaveQuote = c => {
      const o = c.voiceAI.outcome || {};
      return o.type === 'quoted' || o.quotedPrice != null || o.price != null;
    };
    const callQuoted = c => gaveQuote(c) || (c.leadId && leadById.has(c.leadId) && quoteOf(leadById.get(c.leadId)) > 0);

    // Response time (same sources the Response Center reads).
    const leadCreated = l => l.createdAt || l.created_at || '';
    const respTimes = leads.map(l => {
      if (l.response_time_seconds != null) return l.response_time_seconds / 60;
      if (l.firstResponseAt && leadCreated(l)) return Math.max(0, (new Date(l.firstResponseAt) - new Date(leadCreated(l))) / 60000);
      return null;
    }).filter(v => v != null && isFinite(v));

    // Best transcripts: engaged AI calls, booked > quoted > captured, then by
    // quoted price. Turns are joined and capped so the payload stays sane.
    const rank = { booked: 3, quoted: 2, captured: 1 };
    const topCalls = aiCalls
      .filter(c => (c.voiceAI.turns || []).some(t => t.role === 'user'))
      .map(c => {
        const o = c.voiceAI.outcome || {};
        return {
          at: c.startedAt || null,
          afterHours: afterHours(c.startedAt),
          outcome: o.type || (c.voiceAI.status || 'engaged'),
          quality: o.quality || null,
          service: o.serviceNeeded || o.service || null,
          quotedPrice: o.quotedPrice != null ? Number(o.quotedPrice) : (o.price != null ? Number(o.price) : null),
          summary: o.summary || null,
          transcript: (c.voiceAI.turns || [])
            .map(t => `${t.role === 'user' ? 'Caller' : 'ShopFlow'}: ${String(t.text || '').trim()}`)
            .join('\n').slice(0, 4000),
        };
      })
      .sort((a, b) => (rank[b.outcome] || 0) - (rank[a.outcome] || 0) || (b.quotedPrice || 0) - (a.quotedPrice || 0))
      .slice(0, Math.min(Number(req.query.transcripts) || 5, 10));

    const callDates = calls.map(c => c.startedAt).filter(Boolean).sort();
    res.json({
      shop: { id: shop.id, slug: shop.slug, shopName: shop.shopName, monthlyRate: shop.monthlyRate != null ? shop.monthlyRate : null },
      generatedAt: new Date().toISOString(),
      timezone: TZ,
      window: {
        firstCallAt: callDates[0] || null,
        lastCallAt: callDates[callDates.length - 1] || null,
        days: callDates.length ? Math.max(1, Math.round((new Date(callDates[callDates.length - 1]) - new Date(callDates[0])) / 86400000)) : 0,
      },
      calls: {
        total: calls.length,
        staffAnswered: staffAnswered.length,
        aiHandled: aiCalls.length,
        voicemail: voicemails.length,
        missedUnhandled: missedUnhandled.length,
        afterHours: afterHoursCalls.length,
        afterHoursAiHandled: afterHoursCalls.filter(c => c.voiceAI).length,
      },
      aiFunnel: {
        answered: aiCalls.length,
        engaged: aiCalls.filter(c => (c.voiceAI.turns || []).some(t => t.role === 'user')).length,
        quoted: aiCalls.filter(callQuoted).length,
        captured: aiCalls.filter(c => outcomeType(c) === 'captured').length,
        booked: aiCalls.filter(c => outcomeType(c) === 'booked').length,
        transfer: aiCalls.filter(c => outcomeType(c) === 'transfer').length,
        quotedTotal: round2(aiLeads.reduce((s, l) => s + (quoteOf(l) > 0 ? quoteOf(l) : 0), 0)),
      },
      revenue: {
        aiRecoveredTotal: round2(aiDone.reduce((s, a) => s + Number(a.price || 0), 0)),
        aiRecoveredJobs: aiDone.length,
        aiPipelineOpen: round2(aiPipeline.reduce((s, l) => s + (quoteOf(l) || 0), 0)),
        aiPipelineCount: aiPipeline.length,
      },
      responseTime: {
        avgMin: respTimes.length ? round2(respTimes.reduce((a, b) => a + b, 0) / respTimes.length) : null,
        pctUnder5: respTimes.length ? Math.round(respTimes.filter(v => v <= 5).length / respTimes.length * 100) : null,
        sampled: respTimes.length,
      },
      leads: {
        total: leads.length,
        fromCalls: leads.filter(l => l.ai && l.ai.source === 'voice').length,
      },
      topCalls,
    });
  } catch (e) {
    console.error('Admin proof-sheet error:', e.message);
    res.status(500).json({ error: 'Failed to build proof sheet' });
  }
});

// ── ADMIN: Growth Advisor ─────────────────────────────────────────────────────
// Weekly AI account-management review per shop (server/advisor/growthAdvisor.js).
// The code computes every number from the shop db; Claude only ranks the moves.
// Reports + feedback persist on the shop db (db.advisor); the shared playbook
// lives on master.platformSettings.advisorPlaybook; per-shop notes on the shop
// record (advisorNotes). Ad spend rows are the same `ad_spend` records the
// platform router's marketing analytics already read.
const advisor = require('../advisor/growthAdvisor');
const advisorRunning = new Set();   // one paid run per shop at a time

const advisorPlaybook = () => {
  const ps = master.get('platformSettings').value() || {};
  return typeof ps.advisorPlaybook === 'string' ? ps.advisorPlaybook : advisor.DEFAULT_PLAYBOOK;
};
const publicReport = (r) => r && ({ id: r.id, createdAt: r.createdAt, model: r.model, trigger: r.trigger, window: r.window || null, result: r.result, feedback: r.feedback || {}, flags: (r.metrics && r.metrics.flags) || [] });
// Period selection from query/body: ?preset=7d|14d|30d|60d|90d|this_month|last_month
// or ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, shop-local calendar dates).
const rangeOf = (src) => ({ preset: src.preset ? String(src.preset) : undefined, from: src.from ? String(src.from).slice(0, 10) : undefined, to: src.to ? String(src.to).slice(0, 10) : undefined });
const withShop = (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) { res.status(404).json({ error: 'Shop not found' }); return null; }
  return shop;
};

router.get('/api/admin/advisor/playbook', requireAdmin, (req, res) => {
  res.json({ playbook: advisorPlaybook(), isDefault: typeof (master.get('platformSettings').value() || {}).advisorPlaybook !== 'string', model: advisor.MODEL, configured: advisor.configured() });
});
router.patch('/api/admin/advisor/playbook', requireAdmin, (req, res) => {
  const text = String(req.body.playbook || '').slice(0, 20000);
  master.get('platformSettings').assign({ advisorPlaybook: text }).write();
  res.json({ ok: true });
});

// Card payload: fresh metrics + flags (no model call), latest report, history.
router.get('/api/admin/shop/:shopId/advisor', requireAdmin, (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  const db = getShopDb(shop.id);
  let snap;
  try { snap = advisor.snapshot(db, shop, { range: rangeOf(req.query) }); }
  catch (e) { return res.status(422).json({ error: e.message }); }
  const { metrics, window, spendRows, leadCount, tz } = snap;
  const store = advisor.loadStore(db);
  const reports = store.reports || [];
  res.json({
    configured: advisor.configured(), model: advisor.MODEL, running: advisorRunning.has(shop.id),
    leadCount, metrics, tz,
    window: { preset: window.preset, from: window.from, to: window.to, days: window.days, label: window.label, prior: window.prior.label, partial: window.partial },
    latest: publicReport(reports[reports.length - 1]) || null,
    history: reports.slice(0, -1).reverse().slice(0, 12).map(r => ({ id: r.id, createdAt: r.createdAt, health: r.result && r.result.health, headline: r.result && r.result.headline, trigger: r.trigger, window: r.window || null })),
    spend: spendRows.slice(-20).reverse(),
    questions: (store.questions || []).slice(-20).reverse(),
    shopNotes: shop.advisorNotes || '', autoRun: shop.advisorAuto !== false,
    lastAutoRunAt: store.lastAutoRunAt || null,
  });
});

router.get('/api/admin/shop/:shopId/advisor/report/:reportId', requireAdmin, (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  const r = (advisor.loadStore(getShopDb(shop.id)).reports || []).find(x => x.id === req.params.reportId);
  if (!r) return res.status(404).json({ error: 'Report not found' });
  res.json({ report: { ...publicReport(r), metrics: r.metrics } });
});

router.post('/api/admin/shop/:shopId/advisor/run', requireAdmin, async (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  const range = rangeOf(req.body || {});
  try { advisor.resolveWindow({ ...range, now: Date.now() }); } catch (e) { return res.status(422).json({ error: e.message }); }
  if (!advisor.configured()) return res.status(400).json({ error: 'AI is not configured. Set ANTHROPIC_API_KEY to enable the Growth Advisor.' });
  if (advisorRunning.has(shop.id)) return res.status(409).json({ error: 'A review is already running for this shop.' });
  advisorRunning.add(shop.id);
  try {
    const report = await advisor.runAdvisor({ db: getShopDb(shop.id), shop, playbook: advisorPlaybook(), range, trigger: 'manual' });
    res.json({ report: publicReport(report) });
  } catch (e) {
    console.error('[advisor]', shop.id, e.message);
    res.status(500).json({ error: 'Review failed: ' + e.message });
  } finally {
    advisorRunning.delete(shop.id);
  }
});

// Ask a direct question about this shop; answered from the same computed
// numbers (for the chosen period) plus a per-lead list. Saved per shop so
// follow-up questions have context.
router.post('/api/admin/shop/:shopId/advisor/ask', requireAdmin, async (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  const question = String((req.body || {}).question || '').trim();
  if (!question) return res.status(422).json({ error: 'Type a question first.' });
  const range = rangeOf(req.body || {});
  try { advisor.resolveWindow({ ...range, now: Date.now() }); } catch (e) { return res.status(422).json({ error: e.message }); }
  if (!advisor.configured()) return res.status(400).json({ error: 'AI is not configured. Set ANTHROPIC_API_KEY to enable the Growth Advisor.' });
  try {
    const entry = await advisor.askAdvisor({ db: getShopDb(shop.id), shop, playbook: advisorPlaybook(), question, range });
    res.json({ entry });
  } catch (e) {
    console.error('[advisor ask]', shop.id, e.message);
    res.status(500).json({ error: 'Could not answer: ' + e.message });
  }
});
router.delete('/api/admin/shop/:shopId/advisor/ask/:id', requireAdmin, (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  if (!advisor.deleteQuestion(getShopDb(shop.id), req.params.id)) return res.status(404).json({ error: 'Question not found' });
  res.json({ ok: true });
});

router.post('/api/admin/shop/:shopId/advisor/feedback', requireAdmin, (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  const { reportId, actionIndex, rating, note, done } = req.body || {};
  if (rating !== undefined && rating !== null && !['helpful', 'not_helpful'].includes(rating)) return res.status(400).json({ error: 'Bad rating' });
  try {
    const fb = advisor.recordFeedback(getShopDb(shop.id), String(reportId || ''), Number(actionIndex), {
      rating, note: typeof note === 'string' ? note.slice(0, 500) : undefined, done: typeof done === 'boolean' ? done : undefined,
    });
    res.json({ feedback: fb });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Ad spend entry — a DAILY budget per campaign/ad with a start date and an
// optional end date (blank = still running). Lands in the same `ad_spend`
// table the platform router's marketing analytics read; legacy total-amount
// rows from POST /api/ad-spend keep working (prorated by day).
router.post('/api/admin/shop/:shopId/advisor/spend', requireAdmin, (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  const daily = Number(req.body.daily);
  const campaign = String(req.body.campaign || '').trim().slice(0, 200);
  const start = String(req.body.period_start || '').slice(0, 10), end = String(req.body.period_end || '').slice(0, 10);
  if (!campaign || !Number.isFinite(daily) || daily < 0) return res.status(422).json({ error: 'campaign and daily amount required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(422).json({ error: 'start date must be YYYY-MM-DD' });
  if (end && (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start)) return res.status(422).json({ error: 'end date must be YYYY-MM-DD, on or after start (blank = still running)' });
  const db = getShopDb(shop.id);
  const rows = db.get('ad_spend').value() || [];
  const row = { id: uuidv4(), campaign, source: String(req.body.source || 'facebook').toLowerCase().slice(0, 40), daily, period_start: start, period_end: end || null, created_at: new Date().toISOString(), enteredBy: 'admin' };
  db.set('ad_spend', rows.concat(row)).write();
  res.status(201).json({ ok: true, row });
});
// Stop a running daily budget on a date (or edit its end date).
router.patch('/api/admin/shop/:shopId/advisor/spend/:rowId', requireAdmin, (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  const db = getShopDb(shop.id);
  const rows = db.get('ad_spend').value() || [];
  const row = rows.find(r => r.id === req.params.rowId);
  if (!row) return res.status(404).json({ error: 'Spend row not found' });
  const end = req.body.period_end == null || req.body.period_end === '' ? null : String(req.body.period_end).slice(0, 10);
  if (end && (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end < row.period_start)) return res.status(422).json({ error: 'end date must be YYYY-MM-DD, on or after start' });
  row.period_end = end;
  db.set('ad_spend', rows).write();
  res.json({ ok: true, row });
});
router.delete('/api/admin/shop/:shopId/advisor/spend/:rowId', requireAdmin, (req, res) => {
  const shop = withShop(req, res); if (!shop) return;
  const db = getShopDb(shop.id);
  const rows = db.get('ad_spend').value() || [];
  const next = rows.filter(r => r.id !== req.params.rowId);
  if (next.length === rows.length) return res.status(404).json({ error: 'Spend row not found' });
  db.set('ad_spend', next).write();
  res.json({ ok: true });
});

module.exports = router;

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAdmin } = require('../middleware');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb } = require('../db');
const { upsertLead, getLeadPayloads, normalizeSource } = require('../leads-core');

// A shop's rate is ONLY its editable monthlyRate — the old barbershop tier
// table (starter/pro/shop) is gone; a shop with no rate set contributes $0
// until one is entered in the admin UI.
const shopRate = (s) => Number(s.monthlyRate) || 0;

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

  res.json({
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
    let customers = 0, appointments = 0, barbers = 0, services = 0, stripeConnected = false, twilioConfigured = false, bookingEnabled = true;
    try {
      const db = getShopDb(s.id);
      customers    = (db.get('customers').value()    || []).length;
      appointments = (db.get('appointments').value() || []).length;
      barbers      = (db.get('barbers').value()      || []).filter(b => b.active !== false).length;
      services     = (db.get('services').value()     || []).length;
      const settings = db.get('settings').value() || {};
      stripeConnected  = !!(settings.stripe?.connectAccountId && settings.stripe?.onboardingComplete);
      twilioConfigured = !!(twilioClient && shopFromNumber(s.id));
      bookingEnabled   = settings.bookingEnabled !== false;
    } catch(e) {}
    return { id: s.id, shopName: s.shopName, slug: s.slug, email: s.email, phone: s.phone, plan: s.plan, monthlyRate: s.monthlyRate != null ? s.monthlyRate : null, rate: shopRate(s), notes: s.notes || '', features: s.features || {}, active: s.active, createdAt: s.createdAt, lastActivity: s.lastActivity, customers, appointments, barbers, services, stripeConnected, twilioConfigured, bookingEnabled };
  });
  res.json(result);
});

// ── ADMIN: single shop profile ────────────────────────────────────────────────
router.get('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const db = getShopDb(shop.id);
  const settings    = db.get('settings').value()    || {};
  const barbers     = db.get('barbers').value()      || [];
  const services    = db.get('services').value()     || [];
  const customers   = db.get('customers').value()    || [];
  const appointments = db.get('appointments').value() || [];
  const leads  = db.get('leads').value()  || [];
  const quotes = db.get('quotes').value() || [];
  const calls  = db.get('calls').value()  || [];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const thisMonth = now.toISOString().slice(0, 7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7);
  const apptThisMonth = appointments.filter(a => a.date && a.date.startsWith(thisMonth)).length;
  const recentAppts = [...appointments].sort((a, b) => new Date(b.date + 'T' + (b.time || '00:00')) - new Date(a.date + 'T' + (a.time || '00:00'))).slice(0, 10);

  // ── Account-management insights: how is this client's business doing, and is
  // ShopFlow visibly earning its keep? Everything the account-review needs.
  const leadCreated = l => l.createdAt || l.created_at || '';
  const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);
  // TEMP (2026-08-31, revert after September): "converted" = lead → appointment
  // SET, not lead → won paying job. A lead counts if it reached an
  // appointment-or-later stage, or if an appointment (matched by customer or
  // last-10 phone) exists dated on/after the day the lead came in.
  // To revert, replace leadWon (and drop the appt maps) with:
  //   const leadWon = l => ['booked', 'closed', 'APPOINTMENT_SET', 'COMPLETED'].includes(l.status);
  const apptByCust = new Map(), apptByPhone = new Map();
  appointments.forEach(a => {
    const d = String(a.date || '');
    if (a.customerId && d > (apptByCust.get(a.customerId) || '')) apptByCust.set(a.customerId, d);
    const ph = last10(a.customerPhone);
    if (ph.length === 10 && d > (apptByPhone.get(ph) || '')) apptByPhone.set(ph, d);
  });
  const leadWon = l => {
    if (['booked', 'worked', 'closed', 'APPOINTMENT_SET', 'COMPLETED'].includes(l.status)) return true;
    const created = String(leadCreated(l)).slice(0, 10);
    const d = (l.customerId && apptByCust.get(l.customerId)) || apptByPhone.get(last10(l.phone));
    return !!d && (!created || d >= created);
  };
  const leadsThisMonth = leads.filter(l => leadCreated(l).startsWith(thisMonth));
  const leadsLastMonth = leads.filter(l => leadCreated(l).startsWith(lastMonth));
  // Avg first-response time in minutes, across leads that have one recorded.
  const respTimes = leads.map(l => {
    if (l.response_time_seconds != null) return l.response_time_seconds / 60;
    if (l.firstResponseAt && leadCreated(l)) return Math.max(0, (new Date(l.firstResponseAt) - new Date(leadCreated(l))) / 60000);
    return null;
  }).filter(v => v != null && isFinite(v));

  const doneRevenue = (list) => list.filter(a => a.status === 'done').reduce((s, a) => s + (Number(a.price) || 0), 0);
  const revenueThisMonth = doneRevenue(appointments.filter(a => (a.date || '').startsWith(thisMonth)));
  const revenueLastMonth = doneRevenue(appointments.filter(a => (a.date || '').startsWith(lastMonth)));
  // Forecast: booked future work + approved-but-unscheduled estimates, plus the
  // open estimate pipeline weighted by this shop's real acceptance rate.
  const upcomingBooked = appointments
    .filter(a => (a.date || '') >= today && !['done', 'cancelled', 'no-show'].includes(a.status))
    .reduce((s, a) => s + (Number(a.price) || 0), 0);
  const approvedEstimates = quotes.filter(q => q.status === 'approved').reduce((s, q) => s + (Number(q.total) || 0), 0);
  const openEstimates     = quotes.filter(q => q.status === 'sent').reduce((s, q) => s + (Number(q.total) || 0), 0);
  // 'completed' = the shop closed the work out as won; 'lost' = they closed it
  // out as dead (the owner-side twin of a customer 'declined'). Both are decided.
  const decided = quotes.filter(q => ['approved', 'scheduled', 'completed', 'declined', 'lost'].includes(q.status));
  const wonQuotes = quotes.filter(q => ['approved', 'scheduled', 'completed'].includes(q.status));
  // Accept rate: the owner's manual override wins (they know their real-world
  // close rate); else this shop's computed estimate history; else 50%.
  const computedAccept = decided.length ? Math.round(wonQuotes.length / decided.length * 100) : null;
  const manualAccept = (shop.estAcceptRate != null && shop.estAcceptRate !== '') ? Math.min(100, Math.max(0, Number(shop.estAcceptRate) || 0)) : null;
  const acceptRate = manualAccept != null ? manualAccept : (computedAccept != null ? computedAccept : 50);
  // Open lead pipeline: quoted value sitting on non-terminal pipeline stages
  // (owner-entered quotedAmount, falling back to what the AI quoted on the call).
  const cfgStages = ((settings.pipeline || {}).stages) || [];
  const terminalKeys = new Set((Array.isArray(cfgStages) && cfgStages.length ? cfgStages.filter(st => st.terminal).map(st => st.key) : ['closed', 'lost']).concat(['closed', 'lost', 'COMPLETED', 'LOST']));
  const leadQuoted = l => l.quotedAmount != null ? (Number(l.quotedAmount) || 0) : (l.ai && l.ai.quotedPrice != null ? (Number(l.ai.quotedPrice) || 0) : 0);
  const openPipeLeads = leads.filter(l => !terminalKeys.has(l.pipelineStatus || l.status) && leadQuoted(l) > 0);
  const leadPipelineValue = openPipeLeads.reduce((s, l) => s + leadQuoted(l), 0);
  const forecast = Math.round(upcomingBooked + approvedEstimates + (openEstimates + leadPipelineValue) * acceptRate / 100);

  const quota = Number(shop.monthlyQuota) || 0;
  const sources = {};
  leads.forEach(l => { const src = l.channel || l.source || 'call'; sources[src] = (sources[src] || 0) + 1; });
  // AI receptionist value (compact version of the shop Revenue tab's attribution):
  // calls the AI answered, leads it captured, and completed work traced back to an
  // AI-captured lead (booked directly, or same customer/phone closing later).
  const aiLeads = leads.filter(l => l.ai && l.ai.source === 'voice');
  const aiCustCap = new Map(), aiPhoneCap = new Map();
  aiLeads.forEach(l => {
    const cap = String((l.ai && l.ai.generatedAt) || l.createdAt || '').slice(0, 10);
    if (l.customerId) aiCustCap.set(l.customerId, cap);
    const ph = last10(l.phone); if (ph.length === 10) aiPhoneCap.set(ph, cap);
  });
  const doneAppts = appointments.filter(a => a.status === 'done');
  const aiDone = doneAppts.filter(a => {
    if (a.source === 'ai-voice') return true;
    const cap = (a.customerId && aiCustCap.get(a.customerId)) || aiPhoneCap.get(last10(a.customerPhone));
    return !!cap && String(a.date || '') >= cap;
  });
  const aiRecovered = aiDone.reduce((s, a) => s + (Number(a.price) || 0), 0);
  const aiRecoveredThisMonth = aiDone.filter(a => (a.date || '').startsWith(thisMonth)).reduce((s, a) => s + (Number(a.price) || 0), 0);
  const aiCallCount = calls.filter(c => c && c.voiceAI).length;
  // Why leads die — tallied from the reasons picked when marking lost.
  const lostReasons = {};
  leads.forEach(l => { if (l.lostReason) lostReasons[l.lostReason] = (lostReasons[l.lostReason] || 0) + 1; });

  const insights = {
    leads: {
      total: leads.length, thisMonth: leadsThisMonth.length, lastMonth: leadsLastMonth.length,
      converted: leads.filter(leadWon).length,
      conversionRate: leads.length ? Math.round(leads.filter(leadWon).length / leads.length * 100) : null,
      avgResponseMins: respTimes.length ? Math.round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length) : null,
      sources, lostReasons,
      callsThisMonth: calls.filter(c => (c.startedAt || '').startsWith(thisMonth)).length,
    },
    revenue: { thisMonth: revenueThisMonth, lastMonth: revenueLastMonth },
    ai: { calls: aiCallCount, leads: aiLeads.length, recovered: Math.round(aiRecovered), recoveredThisMonth: Math.round(aiRecoveredThisMonth) },
    forecast: { total: forecast, upcomingBooked, approvedEstimates, openEstimates,
                leadPipelineValue, leadPipelineCount: openPipeLeads.length,
                estAcceptRate: acceptRate, acceptSource: manualAccept != null ? 'manual' : (computedAccept != null ? 'computed' : 'default'),
                computedAcceptRate: computedAccept },
    estimates: { open: quotes.filter(q => q.status === 'sent').length, approved: wonQuotes.length, total: quotes.length },
    quota: { monthly: quota, pct: quota > 0 ? Math.round(revenueThisMonth / quota * 100) : null },
    billing: { rate: shopRate(shop) },
  };

  // metaPageToken is a long-lived Meta page access token — never ship it to the
  // browser. Same stance as settings.twilio.authToken / emailSmtp.pass in
  // routes/shop.js: the panel only needs to know whether one is configured.
  const shopSafe = { ...shop, metaPageToken: undefined, metaPageTokenSet: !!shop.metaPageToken };
  res.json({
    shop: shopSafe, settings: { shopName: settings.shopName, tagline: settings.tagline, phone: settings.phone, address: settings.address, bookingEnabled: settings.bookingEnabled, accentColor: settings.accentColor, googleReviewLink: settings.googleReviewLink, loyalty: settings.loyalty, deposit: settings.deposit, stripeConnected: !!(settings.stripe?.connectAccountId && settings.stripe?.onboardingComplete), squareConnected: !!((settings.square && settings.square.accessToken) ), twilioConfigured: !!(twilioClient && shopFromNumber(shop.id)) },
    barbers, services,
    stats: { totalCustomers: customers.length, totalAppointments: appointments.length, apptThisMonth, activeBarbers: barbers.filter(b => b.active !== false).length },
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
  const allowed = ['plan', 'monthlyRate', 'monthlyQuota', 'estAcceptRate', 'active', 'shopName', 'phone', 'email', 'twilioFromNumber', 'metaPageId', 'metaPageToken', 'features', 'notes'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  // Custom rate: number, or null/'' to clear.
  if (updates.monthlyRate !== undefined) updates.monthlyRate = (updates.monthlyRate === null || updates.monthlyRate === '') ? null : (Number(updates.monthlyRate) || 0);
  // Monthly revenue quota for the shop (drives %-to-quota on the profile).
  if (updates.monthlyQuota !== undefined) updates.monthlyQuota = (updates.monthlyQuota === null || updates.monthlyQuota === '') ? null : (Number(updates.monthlyQuota) || 0);
  // Manual estimate-accept-rate override (0–100); null/'' clears back to computed.
  if (updates.estAcceptRate !== undefined) updates.estAcceptRate = (updates.estAcceptRate === null || updates.estAcceptRate === '') ? null : Math.min(100, Math.max(0, Number(updates.estAcceptRate) || 0));
  if (updates.plan !== undefined) updates.plan = String(updates.plan).trim().slice(0, 40) || 'custom';
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

// ── ADMIN: seed demo account ──────────────────────────────────────────────────
router.post('/api/admin/seed-demo', requireAdmin, async (req, res) => {
  try {
    const DEMO_EMAIL = 'demo@shopflow.com';
    const DEMO_PASS  = 'demo1234';
    const DEMO_SHOP  = "King's Cuts";

    // Remove existing demo account if present
    const existing = master.get('accounts').find({ email: DEMO_EMAIL }).value();
    if (existing) {
      const oldShopId = existing.shopId;
      master.get('accounts').remove({ email: DEMO_EMAIL }).write();
      master.get('shops').remove({ id: oldShopId }).write();
      try {
        const oldDir = path.join(SHOPS_DIR, oldShopId);
        if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true, force: true });
      } catch(e) {}
    }

    const shopId    = uuidv4();
    const accountId = uuidv4();
    const shopSlug  = 'kings-cuts';
    const passwordHash = await bcrypt.hash(DEMO_PASS, 10);

    master.get('shops').push({ id: shopId, accountId, shopName: DEMO_SHOP, slug: shopSlug, email: DEMO_EMAIL, phone: '(505) 555-0192', plan: 'pro', active: true, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() }).write();
    master.get('accounts').push({ id: accountId, shopId, email: DEMO_EMAIL, passwordHash, plan: 'pro', active: true, createdAt: new Date().toISOString() }).write();

    // Init shop DB
    const shopDb = getShopDb(shopId);
    shopDb.defaults({ settings:{}, barbers:[], services:[], customers:[], appointments:[], conversations:[], blockedDates:[] }).write();

    shopDb.set('settings', { shopName: DEMO_SHOP, tagline: 'Fresh Cuts. Clean Lines. Every Time.', phone: '(505) 555-0192', address: '4820 Central Ave SW, Albuquerque, NM 87105', email: DEMO_EMAIL, bookingEnabled: true, bookingMessage: 'Book your appointment below! Walk-ins also welcome.', accentColor: '#16a34a', pin: '1234', pinEnabled: false, rebookInterval: 21, loyalty: { enabled: true, visitsForReward: 10, rewardDescription: 'Free shape up or beard lineup' }, twilio: {}, googleReviewLink: '', emailSmtp: { host:'', port:587, user:'', pass:'' }, deposit: { enabled: false, amount: 10, message: '' }, stripe: { connectAccountId:'', onboardingComplete: false }, remindersSent: [], scheduledReminders: [], smsTemplates: {} }).write();

    const BARBERS = [
      { id:'b1', name:'Marcus', chair:1, phone:'(505) 555-0201', bio:'Master barber, 10+ years.', color:'#16a34a', active:true, joinedAt: daysAgo(180), schedule:{ workDays:[1,2,3,4,5,6], startTime:'9:00 AM',  endTime:'6:00 PM', slotMinutes:30 } },
      { id:'b2', name:'Dre',    chair:2, phone:'(505) 555-0202', bio:'Classic cuts and beard work.', color:'#2563eb', active:true, joinedAt: daysAgo(90),  schedule:{ workDays:[2,3,4,5,6],   startTime:'10:00 AM', endTime:'7:00 PM', slotMinutes:30 } },
      { id:'b3', name:'Tony',   chair:3, phone:'(505) 555-0203', bio:'Kids cuts specialist.', color:'#d97706', active:true, joinedAt: daysAgo(45),  schedule:{ workDays:[1,3,4,5,6],   startTime:'9:00 AM',  endTime:'5:00 PM', slotMinutes:30 } },
    ];
    const SERVICES = [
      { id:'s1', name:'Haircut',      category:'cut',   price:35, duration:45 },
      { id:'s2', name:'Skin Fade',    category:'cut',   price:40, duration:45 },
      { id:'s3', name:'Beard Lineup', category:'beard', price:15, duration:20 },
      { id:'s4', name:'Kids Cut',     category:'cut',   price:25, duration:30 },
      { id:'s5', name:'Cut + Beard',  category:'combo', price:50, duration:60 },
      { id:'s6', name:'Shape Up',     category:'cut',   price:20, duration:20 },
    ];
    // Each client has a realistic cadence, preferred barber, service, and tip habit
    const CLIENT_DATA = [
      { name:'Jordan Rivera',    phone:'(505) 555-1001', email:'jordan.r@email.com', notes:'Prefers Marcus. Skin fade every time, usually adds beard lineup.',   barber:'b1', svc:'s2', interval:[13,16], tipRange:[10,20], noShows:0, startDay:58 },
      { name:'Marcus Webb',      phone:'(505) 555-1002', email:'mwebb@gmail.com',    notes:'Bi-weekly. Cut + beard every visit. Great tipper.',                  barber:'b2', svc:'s5', interval:[12,15], tipRange:[10,20], noShows:0, startDay:55 },
      { name:'DeShawn Carter',   phone:'(505) 555-1003', email:'',                   notes:'Taper fade, leave length on top. Comes every 2-3 weeks.',            barber:'b2', svc:'s2', interval:[16,20], tipRange:[5,15],  noShows:1, startDay:60 },
      { name:'Tyler Brooks',     phone:'(505) 555-1004', email:'',                   notes:'Classic haircut every 3 weeks like clockwork.',                      barber:'b3', svc:'s1', interval:[19,23], tipRange:[5,10],  noShows:0, startDay:57 },
      { name:'Isaiah Flores',    phone:'(505) 555-1005', email:'',                   notes:'Kids cut. Dad is very specific — scissor finish, no clippers high.', barber:'b3', svc:'s4', interval:[28,35], tipRange:[0,10],  noShows:0, startDay:56 },
      { name:'Cameron Nash',     phone:'(505) 555-1006', email:'cnash@email.com',    notes:'Beard lineup only, every 2 weeks. Never gets a cut here.',            barber:'b1', svc:'s3', interval:[12,15], tipRange:[5,10],  noShows:0, startDay:54 },
      { name:'Elijah Monroe',    phone:'(505) 555-1007', email:'',                   notes:'Low fade, Edgar top. Comes in every 10-12 days.',                    barber:'b1', svc:'s2', interval:[10,13], tipRange:[10,15], noShows:0, startDay:60 },
      { name:'Aiden Torres',     phone:'(505) 555-1008', email:'',                   notes:'Comes with his son Dominic. Both get cuts same day.',                 barber:'b3', svc:'s1', interval:[26,32], tipRange:[5,15],  noShows:1, startDay:52 },
      { name:'Noah Castillo',    phone:'(505) 555-1009', email:'',                   notes:'Hates clippers past a 2. Classic taper, scissor on top.',            barber:'b2', svc:'s1', interval:[20,26], tipRange:[5,10],  noShows:0, startDay:58 },
      { name:'Liam Ortega',      phone:'(505) 555-1010', email:'liamo@email.com',    notes:'Curly top, tight sides. Monthly visit.',                             barber:'b1', svc:'s1', interval:[28,33], tipRange:[5,10],  noShows:0, startDay:55 },
      { name:'Xavier Price',     phone:'(505) 555-1011', email:'',                   notes:'High top fade. Most frequent client — comes every 10 days.',         barber:'b2', svc:'s2', interval:[9,12],  tipRange:[10,20], noShows:0, startDay:60 },
      { name:'Jaylen Scott',     phone:'(505) 555-1012', email:'jscott@gmail.com',   notes:'Waves — 360 brushwork after every cut. Takes extra time.',           barber:'b1', svc:'s1', interval:[14,18], tipRange:[5,15],  noShows:2, startDay:56 },
      { name:'Malik Thompson',   phone:'(505) 555-1013', email:'',                   notes:'Cut + beard every visit. Asks for hot towel finish.',                barber:'b2', svc:'s5', interval:[13,17], tipRange:[10,15], noShows:0, startDay:59 },
      { name:'Caleb Washington', phone:'(505) 555-1014', email:'cwash@email.com',    notes:'Cut + beard combo. Bi-weekly, very consistent.',                     barber:'b2', svc:'s5', interval:[13,16], tipRange:[10,20], noShows:0, startDay:57 },
      { name:'Ethan Powell',     phone:'(505) 555-1015', email:'',                   notes:'Referred by Jordan Rivera. New client, still figuring out his look.',barber:'b1', svc:'s1', interval:[22,30], tipRange:[0,10],  noShows:0, startDay:45 },
      { name:'Zion Hughes',      phone:'(505) 555-1016', email:'zhughes@gmail.com',  notes:'Taper + shape up every visit. Very clean look.',                    barber:'b1', svc:'s1', interval:[16,20], tipRange:[5,15],  noShows:0, startDay:60 },
      { name:'Andre Mitchell',   phone:'(505) 555-1017', email:'',                   notes:'Dre only — they go way back. Skin fade.',                            barber:'b2', svc:'s2', interval:[13,16], tipRange:[10,20], noShows:0, startDay:58 },
      { name:'Dominic Reed',     phone:'(505) 555-1018', email:'dreed@outlook.com',  notes:'Comes with his dad Aiden. Kids cut monthly.',                       barber:'b3', svc:'s4', interval:[26,32], tipRange:[0,5],   noShows:0, startDay:52 },
      { name:'Chris Lawson',     phone:'(505) 555-1019', email:'',                   notes:'Shape up only. In and out in 20 minutes.',                          barber:'b1', svc:'s6', interval:[22,28], tipRange:[0,5],   noShows:0, startDay:50 },
      { name:'Kevin James',      phone:'(505) 555-1020', email:'kj@email.com',       notes:'Most loyal client. Skin fade every 10-12 days without fail.',       barber:'b1', svc:'s2', interval:[10,13], tipRange:[15,20], noShows:0, startDay:60 },
    ];

    const CUT_NOTES_BY_SVC = {
      's1': [ // Haircut
        'Clean taper, scissor finish on top. Client happy with the length.',
        'Classic cut — #2 on sides, scissors on top. No product.',
        'Medium taper, left about 2 inches on top. Client wants to grow it out a bit.',
        'Tight taper, textured top. Used a little pomade to finish.',
        'Low skin taper, natural top. Went shorter than usual per client request.',
      ],
      's2': [ // Skin Fade
        'Skin fade, took it to a 0. Clean line up. Client was happy.',
        'Skin fade with hard part on the left. Took down the sides tight.',
        'Mid skin fade, left length on top for a textured look.',
        'High skin fade, connected the beard. Sharp lines.',
        'Skin fade, slightly higher this time per client request. Blended clean.',
      ],
      's3': [ // Beard Lineup
        'Full beard lineup. Defined the cheek line, trimmed to half inch.',
        'Beard cleaned up — neck line and cheek line. Left the length.',
        'Tight beard lineup, took the neckline up a bit. Clean finish.',
        'Shape up on the beard only. Client just wanted the edges cleaned.',
      ],
      's4': [ // Kids Cut
        'Kids cut — scissor finish on top, short taper. Sat perfectly still.',
        'Kids cut, went short on the sides. Dad approved.',
        'Kids cut — left it longer on top per moms instructions. Clean taper.',
        'First time in the chair — went easy, scissor cut. Kid did great.',
      ],
      's5': [ // Cut + Beard
        'Full cut and beard. Skin fade on the sides, beard trimmed and lined up tight.',
        'Skin fade + full beard lineup. Both looking sharp.',
        'Cut and beard combo — taper fade, beard shaped to a point.',
        'Fresh cut and beard trim. Client gets this every visit.',
        'Mid fade and beard lineup. Took the beard down shorter this time.',
      ],
      's6': [ // Shape Up
        'Shape up only — hairline, temples, and sideburns.',
        'Clean shape up. Straightened the hairline, touched up the edges.',
        'Quick shape up, client was between cuts. Cleaned everything up.',
      ],
    };

    const TIMES = ['9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM','12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM','3:30 PM','4:00 PM','4:30 PM','5:00 PM'];
    const FUTURE_TIMES = ['9:00 AM','10:00 AM','10:30 AM','11:00 AM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'];

    // Build customers
    const customers = CLIENT_DATA.map((c, i) => ({
      id: 'c'+(i+1).toString().padStart(3,'0'),
      name: c.name, phone: c.phone, email: c.email, notes: c.notes,
      loyaltyVisits: 0, noShows: c.noShows,
      createdAt: daysAgo(c.startDay + 5),
    }));

    // Generate appointments per client based on their realistic interval
    const appointments = [];
    const usedSlots = {}; // track date+time slots to avoid conflicts per barber

    CLIENT_DATA.forEach((cd, i) => {
      const cust = customers[i];
      const barb = BARBERS.find(b => b.id === cd.barber) || BARBERS[0];
      const svc  = SERVICES.find(s => s.id === cd.svc)   || SERVICES[0];
      const notes= CUT_NOTES_BY_SVC[cd.svc] || CUT_NOTES_BY_SVC['s1'];

      // Walk forward from startDay using the client interval
      let cursor = cd.startDay;
      while (cursor >= -7) {
        const isPast   = cursor > 0;
        const isFuture = cursor < 0;
        const date     = daysAgo(cursor);

        // Skip Sundays
        const dow = new Date(date + 'T12:00:00').getDay();
        if (dow === 0) { cursor -= randInt(cd.interval[0], cd.interval[1]); continue; }

        // Pick a time slot not already taken by this barber that day
        const slotKey = date + '_' + barb.id;
        if (!usedSlots[slotKey]) usedSlots[slotKey] = new Set();
        const pool = isFuture ? FUTURE_TIMES : TIMES;
        const available = pool.filter(t => !usedSlots[slotKey].has(t));
        if (!available.length) { cursor -= randInt(cd.interval[0], cd.interval[1]); continue; }
        const time = available[randInt(0, available.length-1)];
        usedSlots[slotKey].add(time);

        const noshow = isPast && cd.noShows > 0 && Math.random() < 0.08;
        const tip    = noshow ? 0 : randInt(cd.tipRange[0], cd.tipRange[1]);
        const status = isFuture ? 'confirmed' : noshow ? 'no-show' : 'done';
        const cutNote = (!noshow && isPast && Math.random() < 0.8) ? notes[randInt(0, notes.length-1)] : '';

        if (!noshow && status === 'done') cust.loyaltyVisits++;

        appointments.push({
          id: 'a' + Math.random().toString(36).slice(2,10),
          customerId: cust.id, customerName: cust.name, customerPhone: cust.phone,
          barberId: barb.id, barberName: barb.name,
          serviceId: svc.id, service: svc.name,
          date, time, duration: svc.duration, price: svc.price, tip,
          status, cutNotes: cutNote,
          bookedAt: new Date(Date.now() - cursor*864e5 - 2*864e5).toISOString(),
          source: Math.random() < 0.35 ? 'online' : 'walk-in',
        });

        cursor -= randInt(cd.interval[0], cd.interval[1]);
      }
    });

    // Update loyalty reward status
    customers.forEach(c => {
      if (c.loyaltyVisits >= 10) c.loyaltyRewardedAt = daysAgo(randInt(5,20));
    });

    appointments.sort((a,b) => a.date !== b.date ? a.date.localeCompare(b.date) : a.time.localeCompare(b.time));

    shopDb.set('barbers', BARBERS).write();
    shopDb.set('services', SERVICES).write();
    shopDb.set('customers', customers).write();
    shopDb.set('appointments', appointments).write();

    // Seed realistic SMS conversations
    const msgId = () => 'msg' + Math.random().toString(36).slice(2,10);
    const daysAgoISO = (n, h=12, m=0) => { const d=new Date(); d.setDate(d.getDate()-n); d.setHours(h,m,0,0); return d.toISOString(); };
    const conversations = [
      // Jordan Rivera — recent booking thread
      { id:msgId(), customerId:'c001', customerName:'Jordan Rivera', type:'sms', direction:'outbound', body:"Hi Jordan! Your appointment at King's Cuts is confirmed for tomorrow at 10:00 AM with Marcus. See you then! ✂️", sentAt:daysAgoISO(2,9,1), read:true },
      { id:msgId(), customerId:'c001', customerName:'Jordan Rivera', type:'sms', direction:'inbound',  body:'Perfect, thanks! Can I add a beard lineup too?', sentAt:daysAgoISO(2,9,15), read:true },
      { id:msgId(), customerId:'c001', customerName:'Jordan Rivera', type:'sms', direction:'outbound', body:"Absolutely! We'll take care of you. Marcus is great with beards.", sentAt:daysAgoISO(2,9,22), read:true },
      { id:msgId(), customerId:'c001', customerName:'Jordan Rivera', type:'sms', direction:'inbound',  body:'Bet, see you tomorrow 🤙', sentAt:daysAgoISO(2,9,30), read:true },
      // Marcus Webb — rebook nudge thread
      { id:msgId(), customerId:'c002', customerName:'Marcus Webb', type:'sms', direction:'outbound', body:"Hey Marcus! It's been a few weeks — we'd love to have you back at King's Cuts. Book your next cut anytime 💈", sentAt:daysAgoISO(5,11,0), read:true },
      { id:msgId(), customerId:'c002', customerName:'Marcus Webb', type:'sms', direction:'inbound',  body:'yeah been busy, can I come in Saturday?', sentAt:daysAgoISO(5,11,45), read:true },
      { id:msgId(), customerId:'c002', customerName:'Marcus Webb', type:'sms', direction:'outbound', body:'Saturday works! Book at shopflow.com/book/kings-cuts or just walk in. We open at 9.', sentAt:daysAgoISO(5,12,2), read:true },
      { id:msgId(), customerId:'c002', customerName:'Marcus Webb', type:'sms', direction:'inbound',  body:'cool ill be there around 11', sentAt:daysAgoISO(5,12,10), read:true },
      // Kevin James — loyalty reward notification
      { id:msgId(), customerId:'c020', customerName:'Kevin James', type:'sms', direction:'outbound', body:"Kevin! 🎉 You've hit 10 visits at King's Cuts — your next cut is on us! Come in anytime and show this message.", sentAt:daysAgoISO(3,10,0), read:true },
      { id:msgId(), customerId:'c020', customerName:'Kevin James', type:'sms', direction:'inbound',  body:'No way!! Thanks bro thats crazy', sentAt:daysAgoISO(3,10,18), read:true },
      { id:msgId(), customerId:'c020', customerName:'Kevin James', type:'sms', direction:'inbound',  body:'Coming in Thursday, gonna tell my boys about this place', sentAt:daysAgoISO(3,10,19), read:false },
      // Ethan Powell — new client inquiry (unread)
      { id:msgId(), customerId:'c015', customerName:'Ethan Powell', type:'sms', direction:'inbound',  body:'Hey I got your number from Jordan, do you guys do walk-ins?', sentAt:daysAgoISO(0,8,42), read:false },
      { id:msgId(), customerId:'c015', customerName:'Ethan Powell', type:'sms', direction:'inbound',  body:'Or should I book online?', sentAt:daysAgoISO(0,8,43), read:false },
      // DeShawn Carter — reminder thread
      { id:msgId(), customerId:'c003', customerName:'DeShawn Carter', type:'sms', direction:'outbound', body:"Hi DeShawn! Reminder: your appointment at King's Cuts is tomorrow at 2:00 PM with Dre. See you then! ✂️", sentAt:daysAgoISO(8,9,0), read:true },
      { id:msgId(), customerId:'c003', customerName:'DeShawn Carter', type:'sms', direction:'inbound',  body:'actually can we move it to 3?', sentAt:daysAgoISO(8,9,35), read:true },
      { id:msgId(), customerId:'c003', customerName:'DeShawn Carter', type:'sms', direction:'outbound', body:"3 PM works, I've updated your appointment. See you then!", sentAt:daysAgoISO(8,9,48), read:true },
    ];
    shopDb.set('conversations', conversations).write();

    // Enable all features for demo
    master.get('shops').find({ id: shopId }).assign({ features: { manualSms: true } }).write();

    const done = appointments.filter(a=>a.status==='done');
    res.json({ ok:true, shopId, slug: shopSlug, email: DEMO_EMAIL, password: DEMO_PASS, clients: customers.length, appointments: appointments.length, completed: done.length, revenue: done.reduce((s,a)=>s+a.price+a.tip,0) });
  } catch(e) {
    console.error('Seed demo error:', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// helpers used by seed
function daysAgo(n) { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().split('T')[0]; }
function randInt(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }

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

module.exports = router;

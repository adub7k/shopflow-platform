const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { master, getShopDb, shopHelpers, shopRoute, genId, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb, saveImageDataUrl } = require('../db');
const { resolveProfile } = require('../industries');
const { notifyNewLead } = require('../email');
const { sendPush } = require('../push-instance');
// Booking core (single source of truth): the menu, open-slot availability, and
// the create-appointment path (double-book guard + price resolution) live in
// ../booking so the public page and the AI voice receptionist share one
// implementation. inspoMode is re-exported from there. (The inline slot helpers
// that used to live here now live in ../booking — do not re-add them.)
const { computeAvailability, createAppointment, inspoMode } = require('../booking');

// ── Per-date availability overrides ───────────────────────────────────────────
// When settings.availabilityMode === 'perDate', the shop hand-picks the open
// times for individual dates (stored in the `dateSlots` collection as
// [{ date, times:[...] }]); a date with no override is closed, and the count of
// opened times is that day's client cap — for low-volume shops like a solo nail
// tech taking 1–2 a day. In the default 'schedule' mode these overrides are
// INERT (weekly schedule + blocked dates only), so switching back restores normal
// all-day booking with no leftover caps (the saved openings are preserved).
function availabilityMode(db){ return ((db.get('settings').value()||{}).availabilityMode === 'perDate') ? 'perDate' : 'schedule'; }
function dateOverride(db, date){ return (db.get('dateSlots').value() || []).find(d => d.date === date) || null; }
// The open start-times a staff member offers on a specific date.
function slotListForDate(db, b, date){
  if (availabilityMode(db) !== 'perDate') return barberSlotList(b);   // weekly schedule
  const ov = dateOverride(db, date);
  return ov && Array.isArray(ov.times) ? ov.times : [];              // opened date, else closed
}
// Whether a staff member is potentially working on a date.
function worksOnDate(db, b, date, dow){
  if (availabilityMode(db) !== 'perDate') return (b.schedule?.workDays || [1,2,3,4,5,6]).includes(dow);
  return !!dateOverride(db, date);   // perDate: only hand-opened dates are working days
}

// ── PUBLIC: Industry list (for the signup business-type picker) ──────────────
router.get('/api/industries', (req, res) => {
  const { INDUSTRIES } = require('../industries');
  res.json(Object.entries(INDUSTRIES).map(([key, p]) => ({ key, label: p.label })));
});

// ── PUBLIC: Check slug availability ──────────────────────────────────────────
router.get('/api/accounts/check-slug', (req, res) => {
  const { name } = req.query;
  const s = slug(name);
  const taken = !!master.get('shops').find({ slug: s }).value();
  res.json({ slug: s, available: !taken });
});

// ── PUBLIC: Demo slots & booking (must be BEFORE /:shopSlug routes) ───────────
router.get('/api/public/demo/slots', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const booked = master.get('demos').value()
    .filter(d => d.date === date && d.status !== 'cancelled')
    .map(d => d.time);
  const slots = [];
  for (let h = 18; h < 22; h++) {
    for (let m = 0; m < 60; m += 15) {
      const time = `${h === 12 ? 12 : h % 12 || 12}:${String(m).padStart(2,'0')} ${h < 12 ? 'AM' : 'PM'}`;
      if (!booked.includes(time)) slots.push(time);
    }
  }
  res.json(slots);
});

router.post('/api/public/demo/book', async (req, res) => {
  try {
    const { name, shopName, phone, currentTool, date, time } = req.body;
    if (!name || !phone || !date || !time) return res.status(400).json({ ok: false, error: 'Missing required fields' });
    const taken = master.get('demos').value().find(d => d.date === date && d.time === time && d.status !== 'cancelled');
    if (taken) return res.status(409).json({ ok: false, error: 'That time slot was just taken. Please choose another.' });
    const demo = { id: uuidv4(), name, shopName: shopName||'', phone, currentTool: currentTool||'', date, time, status: 'scheduled', notes: '', bookedAt: new Date().toISOString() };
    master.get('demos').push(demo).write();
    if (twilioClient && TWILIO_DEFAULT_FROM) {
      const msg = `Hey ${name}! Your ShopFlow demo is confirmed for ${date} at ${time}. We'll walk you through everything — see you then! 🚀`;
      try { await twilioClient.messages.create({ from: TWILIO_DEFAULT_FROM, to: '+1' + phone.replace(/\D/g,''), body: msg }); } catch(e) { console.error('Demo SMS error:', e.message); }
    }
    res.json({ ok: true, id: demo.id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PUBLIC: Get shop info by slug (for booking page) ─────────────────────────
router.get('/api/public/:shopSlug/info', (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const db = getShopDb(shop.id);
    const s = db.get('settings').value() || {};
    // Project only what the public booking page needs — never expose staff
    // personal phone numbers or other internal fields.
    const barbers = (db.get('barbers').value() || []).filter(b => b.active !== false)
      .map(b => ({ id: b.id, name: b.name, color: b.color, bio: b.bio || '', schedule: b.schedule }));
    // Project services to public-safe fields only — never expose the internal
    // `cost` (COGS/margin) field that lives on each service for owner reporting.
    const services = (db.get('services').value() || []).map(s => ({
      id: s.id, name: s.name, category: s.category, price: s.price,
      duration: s.duration, sizePricing: s.sizePricing, description: s.description,
      image: s.image,
    }));
    // Same for add-ons: expose id/name/price to the booking page, never `cost`.
    const publicAddons = (s.addons || []).map(a => ({ id: a.id, name: a.name, price: a.price }));
    const blockedDates = db.get('blockedDates').value().map(b => b.date);
    // Availability model. In perDate mode only the shop's hand-opened dates are
    // bookable (openDates); weekly-schedule mode ignores per-date openings.
    const availMode = s.availabilityMode === 'perDate' ? 'perDate' : 'schedule';
    const todayStr = new Date().toISOString().split('T')[0];
    const openDates = availMode === 'perDate'
      ? (db.get('dateSlots').value() || []).filter(o => Array.isArray(o.times) && o.times.length && o.date >= todayStr).map(o => o.date)
      : [];
    const stripeConnected = !!(s.stripe?.connectAccountId && s.stripe?.onboardingComplete);
    // Square is "connected" if the shop has its own token (OAuth) or the platform
    // env token is configured (sandbox/MVP fallback). Square takes precedence on
    // the booking page as we migrate deposits off Stripe.
    const squareConnected = !!(s.square?.accessToken && s.square?.locationId) || require('../payments/square').enabled();
    const paymentsConnected = stripeConnected || squareConnected;
    res.json({
      shopId: shop.id,
      shopSlug: shop.slug,
      shopName: s.shopName || shop.shopName,
      tagline: s.tagline || '',
      bookingEnabled: s.bookingEnabled !== false,
      bookingMessage: s.bookingMessage || 'Book your appointment below!',
      accentColor: s.accentColor || '#16a34a',
      // Custom booking-page background image (empty = accent gradient).
      heroImage: s.heroImage || '',
      availabilityMode: availMode, openDates,
      barbers, services, blockedDates,
      // Industry profile bits the booking page needs to render correctly.
      vocab: s.vocab || null,
      customFields: s.customFields || [],
      vehicleSizes: (s.vehicleSizes && s.vehicleSizes.length) ? s.vehicleSizes : (resolveProfile(db.get('industry').value()).vehicleSizes || []),
      addons: publicAddons,
      staffPicker: s.staffPicker !== undefined ? s.staffPicker : (resolveProfile(db.get('industry').value()).staffPicker !== false),
      statuses: s.statuses || [],
      deposit: { enabled: !!(s.deposit?.enabled && paymentsConnected), amount: s.deposit?.amount || 10, message: s.deposit?.message || '' },
      depositProvider: squareConnected ? 'square' : (stripeConnected ? 'stripe' : null),
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      stripeAccountId: stripeConnected ? s.stripe.connectAccountId : '',
      // Lead-form "services considering" options — plain labels, intentionally
      // independent of the services catalog (falls back to service names).
      leadFormOptions: (Array.isArray(s.leadFormOptions) && s.leadFormOptions.length)
        ? s.leadFormOptions
        : (db.get('services').value() || []).map(x => x.name),
      // Meta Pixel for ad-conversion tracking on the lead form (empty = off).
      metaPixelId: String(s.metaPixelId || ''),
      // Owner-chosen public phone for click-to-call on the landing page (empty =
      // hidden). Deliberately a separate field from settings.phone, which is the
      // private call-forwarding destination and must never be exposed here.
      publicPhone: String(s.publicPhone || ''),
      // Inspiration photo + work gallery
      inspo: inspoMode(s, db.get('industry').value()),
      gallery: s.gallery || [],
      // Owner overrides for the marketing site's fixed stock photos (hero +
      // service tiles), keyed by slot. Empty = the site keeps its defaults.
      siteImages: s.siteImages || {},
      // Public "Meet the Team" roster for the marketing site.
      siteTeam: (s.siteTeam || []).map(m => ({ id: m.id, name: m.name, title: m.title || '', bio: m.bio || '', photo: m.photo || '' })),
      // Featured reviews (social proof) + overall rating
      featuredReviews: (db.get('reviews').value() || []).filter(r => r.featured).slice(0, 8)
        .map(r => ({ rating: r.rating, comment: r.comment, name: r.name, service: r.service, createdAt: r.createdAt })),
      reviewStats: (() => { const rv = db.get('reviews').value() || []; return rv.length ? { avg: +(rv.reduce((a,r)=>a+r.rating,0)/rv.length).toFixed(1), count: rv.length } : null; })(),
    });
  } catch(e) {
    console.error('Public info error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUBLIC: Upload an inspiration photo (from the booking page) ───────────────
router.post('/api/public/:shopSlug/upload', (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id);
    const s = db.get('settings').value() || {};
    if (inspoMode(s, db.get('industry').value()) === 'off') return res.status(400).json({ ok: false, error: 'Photo uploads are off for this shop' });
    const url = saveImageDataUrl(shop.id, 'inspo', req.body.image);
    res.json({ ok: true, url });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message || 'Upload failed' });
  }
});

// ── PUBLIC: Quote view + approve / decline ────────────────────────────────────
function publicShopFromSlug(reqSlug) {
  const shop = master.get('shops').find({ slug: reqSlug, active: true }).value();
  if (!shop) return null;
  return { shop, db: getShopDb(shop.id) };
}
router.get('/api/public/:shopSlug/quote/:quoteId', (req, res) => {
  try {
    const ctx = publicShopFromSlug(req.params.shopSlug);
    if (!ctx) return res.status(404).json({ error: 'Shop not found' });
    const h = shopHelpers(ctx.db);
    const q = h.getById('quotes', req.params.quoteId);
    if (!q) return res.status(404).json({ error: 'Quote not found' });
    const s = ctx.db.get('settings').value() || {};
    res.json({
      shopName: s.shopName || ctx.shop.shopName,
      accentColor: s.accentColor || '#16a34a',
      stripeConnected: !!(s.stripe && s.stripe.connectAccountId && s.stripe.onboardingComplete),
      quote: {
        id: q.id, number: q.number, status: q.status,
        customerName: q.customerName || '',
        vehicle: q.vehicle || null, vehicleSize: q.vehicleSize || null,
        lineItems: q.lineItems || [], total: q.total || 0, notes: q.notes || '',
        subtotal: q.subtotal != null ? q.subtotal : (q.total || 0),
        taxRate: q.taxRate || 0, taxLabel: q.taxLabel || 'Sales Tax', taxAmount: q.taxAmount || 0,
        depositRequired: !!q.depositRequired, depositAmount: q.depositAmount || 0, depositPaid: !!q.depositPaid,
      },
    });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});
router.post('/api/public/:shopSlug/quote/:quoteId/approve', (req, res) => {
  try {
    const ctx = publicShopFromSlug(req.params.shopSlug);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const h = shopHelpers(ctx.db);
    const q = h.getById('quotes', req.params.quoteId);
    if (!q) return res.status(404).json({ ok: false, error: 'Quote not found' });
    if (q.status === 'declined') return res.status(400).json({ ok: false, error: 'This estimate was already declined.' });
    const depositOutstanding = !!q.depositRequired && !q.depositPaid;
    // Only finalize approval once any required deposit is actually paid. When a
    // deposit is still owed, leave the status as-is and signal the client to
    // collect it — the Stripe success callback flips the quote to 'approved'.
    if (!depositOutstanding && q.status !== 'approved' && q.status !== 'scheduled') {
      q.status = 'approved'; q.approvedAt = new Date().toISOString(); h.upsert('quotes', q);
    }
    res.json({ ok: true, depositRequired: depositOutstanding, depositAmount: q.depositAmount || 0 });
  } catch(e) { res.status(500).json({ ok: false, error: 'Server error' }); }
});
router.post('/api/public/:shopSlug/quote/:quoteId/decline', (req, res) => {
  try {
    const ctx = publicShopFromSlug(req.params.shopSlug);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const h = shopHelpers(ctx.db);
    const q = h.getById('quotes', req.params.quoteId);
    if (!q) return res.status(404).json({ ok: false, error: 'Quote not found' });
    if (q.status !== 'scheduled') { q.status = 'declined'; q.declinedAt = new Date().toISOString(); h.upsert('quotes', q); }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: 'Server error' }); }
});

// ── PUBLIC: Review page context (?a=<appointmentId> for prefill) ──────────────
router.get('/api/public/:shopSlug/review-info', (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const db = getShopDb(shop.id);
    const s = db.get('settings').value() || {};
    let customerName = '', service = '', alreadyReviewed = false;
    if (req.query.a) {
      const appt = (db.get('appointments').value() || []).find(x => x.id === req.query.a);
      if (appt) { customerName = appt.customerName || ''; service = appt.service || ''; alreadyReviewed = !!appt.reviewId; }
    }
    res.json({ shopName: s.shopName || shop.shopName, accentColor: s.accentColor || '#16a34a', vocab: s.vocab || null, customerName, service, alreadyReviewed, googleReviewLink: s.googleReviewLink || '' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── PUBLIC: Submit a review ───────────────────────────────────────────────────
router.post('/api/public/:shopSlug/review', (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id);
    const rating = Math.round(Number(req.body.rating));
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ ok: false, error: 'Please choose a star rating.' });
    const reviews = db.get('reviews').value() || [];
    let customerId = null, service = '', barberName = '', name = (req.body.name || '').trim().slice(0, 80);
    // A review must be tied to a real, not-yet-reviewed appointment — this is the
    // proof-of-visit that stops anonymous review-bombing / fake 5-star spam.
    const apptId = req.body.appointmentId || null;
    const appt = apptId ? (db.get('appointments').value() || []).find(x => x.id === apptId) : null;
    if (!appt) return res.status(400).json({ ok: false, error: 'A valid appointment is required to leave a review.' });
    if (appt.reviewId) return res.status(409).json({ ok: false, error: 'This visit has already been reviewed — thank you!' });
    customerId = appt.customerId || null; service = appt.service || ''; barberName = appt.barberName || '';
    if (!name) name = appt.customerName || '';
    const review = { id: genId('rev'), rating, comment: (req.body.comment || '').slice(0, 600).trim(), name: name || 'Anonymous', customerId, appointmentId: apptId, service, barberName, featured: false, source: 'link', createdAt: new Date().toISOString() };
    db.set('reviews', [review, ...reviews]).write();
    if (apptId) {
      const appts = db.get('appointments').value() || [];
      const i = appts.findIndex(x => x.id === apptId);
      if (i >= 0) { appts[i].reviewId = review.id; db.set('appointments', appts).write(); }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: 'Server error' }); }
});

// ── PUBLIC: Booking availability ──────────────────────────────────────────────
router.get('/api/public/:shopSlug/availability', (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const db = getShopDb(shop.id);
    const { date, barberId } = req.query;
    res.json(computeAvailability(db, date, { barberId }));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── PUBLIC: Lead capture (quote-first verticals) ──────────────────────────────
// The opt-in form on lead.html posts here. Creates/updates a lead (deduped by
// phone, same as inbound calls) carrying vehicle info, the services the visitor
// is considering, and ad attribution (utm_* + referrer) so every paid click can
// be traced to a booked job. First-touch wins: an existing lead keeps its
// original source, but the latest utm payload is stored for reference.
router.post('/api/public/:shopSlug/lead', async (req, res) => {
  try {
    const ctx = publicShopFromSlug(req.params.shopSlug);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Shop not found' });
    // Honeypot: a hidden "website" field real visitors never see. Bots fill it —
    // pretend success so they don't adapt, and log nothing.
    if (String(req.body.website || '').trim()) return res.json({ ok: true });

    let name  = String(req.body.name || '').trim().slice(0, 80);
    const phone = String(req.body.phone || '').trim().slice(0, 25);
    const email = String(req.body.email || '').trim().slice(0, 120);
    const notes = String(req.body.notes || '').trim().slice(0, 1000);
    const digits = phone.replace(/\D/g, '');
    // Integration/test leads (skipRequiredCustomFields:true, e.g. Meta via Make)
    // are never rejected for missing fields — a blank one still comes through,
    // labeled "Test Lead" so it's identifiable in the Leads list. The website
    // form doesn't send the flag, so it still requires a real name + phone.
    if (req.body.skipRequiredCustomFields) {
      if (!name) name = 'Test Lead';
    } else if (!name || digits.length < 10) {
      return res.status(400).json({ ok: false, error: 'Please enter your name and a valid phone number.' });
    }

    const { db, shop } = ctx;
    const h = shopHelpers(db);
    const s = db.get('settings').value() || {};

    // Enforce required custom fields (vehicle year/make/model/color for detail).
    // Server-to-server integrations (e.g. Meta lead-ad forms via Make/Zapier) can't
    // collect these, so they opt out with skipRequiredCustomFields:true and the lead
    // is still accepted — name + phone above remain mandatory. The website form never
    // sends this flag, so its required-field enforcement is unchanged.
    const cf = req.body.customFields || {};
    Object.keys(cf).forEach(k => { cf[k] = String(cf[k] || '').trim().slice(0, 80); });
    if (!req.body.skipRequiredCustomFields) {
      const missing = (s.customFields || []).filter(f => f.required && !String(cf[f.key] || '').trim());
      if (missing.length) return res.status(400).json({ ok: false, error: 'Missing required fields: ' + missing.map(f => f.label).join(', ') });
    }
    const vehicle = (cf.vehicleYear || cf.vehicleMake || cf.vehicleModel)
      ? { year: cf.vehicleYear || '', make: cf.vehicleMake || '', model: cf.vehicleModel || '', color: cf.vehicleColor || '' }
      : null;

    // Options the visitor checked — plain labels (not service ids; the list is
    // owner-curated copy, not the catalog). Validated against the shop's own
    // option list so a crafted request can't inject arbitrary text.
    const optList = (Array.isArray(s.leadFormOptions) && s.leadFormOptions.length)
      ? s.leadFormOptions
      : (db.get('services').value() || []).map(x => x.name);
    const allowed = new Set(optList);
    const picked = Array.isArray(req.body.services) ? req.body.services : [];
    const servicesInterested = [...new Set(picked.map(x => String(x || '').trim()).filter(x => allowed.has(x)))].slice(0, 20);

    // Attribution: source is derived from utm_source ('facebook', 'google', …),
    // falling back to 'website' for organic/direct visits.
    const rawUtm = req.body.utm || {};
    const utm = {};
    ['source','medium','campaign','term','content'].forEach(k => { const v = String(rawUtm[k] || '').trim().slice(0, 80); if (v) utm[k] = v; });
    const source = (utm.source || 'website').toLowerCase();
    const referrer = String(req.body.referrer || '').trim().slice(0, 300);

    const now = new Date().toISOString();
    const existing = h.getAll('leads').find(l => String(l.phone || '').replace(/\D/g, '') === digits);
    let lead;
    if (existing) {
      lead = existing;
      if (!lead.name) lead.name = name;
      if (email) lead.email = email;
      if (vehicle) lead.vehicle = vehicle;
      if (servicesInterested.length) lead.servicesInterested = servicesInterested;
      if (notes) lead.notes = [lead.notes, notes].filter(Boolean).join('\n');
      if (Object.keys(utm).length) lead.utm = utm;      // latest campaign, for reference
      lead.formSubmits = (lead.formSubmits || 0) + 1;
      lead.lastContactAt = now;
    } else {
      lead = {
        id: genId('lead'), name, phone, email,
        location: '', source, utm: Object.keys(utm).length ? utm : null, referrer,
        vehicle, servicesInterested, status: 'new',
        callCount: 0, missedCount: 0, formSubmits: 1, customerId: null, notes,
        firstContactAt: now, lastContactAt: now, createdAt: now,
      };
    }
    h.upsert('leads', lead);
    master.get('shops').find({ id: shop.id }).assign({ lastActivity: now }).write();

    // No automated SMS here — A2P isn't registered, and the product stance is
    // manual texting anyway: the owner sees the lead in ShopFlow → Leads and
    // texts back from there. Speed-to-lead is covered by an email ping to the
    // owner instead (fire-and-forget — a mail failure never breaks the submit).
    notifyNewLead({ shop, settings: s, lead, kind: existing ? 'form-repeat' : 'form' });

    // Mobile push to the owner's phone (free, instant) — mirrors the email above.
    // EVERY non-call lead source lands here (website form + Meta/Make via
    // skipRequiredCustomFields), so this is the one place that guarantees a push
    // for all of them. Phone-call leads are notified separately (routes/twilio.js).
    const veh = lead.vehicle && [lead.vehicle.year, lead.vehicle.make, lead.vehicle.model].filter(Boolean).join(' ');
    sendPush(shop.id, {
      title: `🔔 New lead — ${lead.name || lead.phone || 'website'}`,
      body: [lead.phone, veh, (lead.servicesInterested || []).join(', '), lead.source && `via ${lead.source}`]
        .filter(Boolean).join(' · '),
      url: '/leads',
      tag: `lead-${lead.id}`,
    }).catch(e => console.error('Lead push failed:', e.message));
    res.json({ ok: true });
  } catch(e) {
    console.error('Lead capture error:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// ── PUBLIC: Book appointment ──────────────────────────────────────────────────
router.post('/api/public/:shopSlug/book', async (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id);
    // All validation + the double-book guard + server-authoritative pricing live
    // in booking.createAppointment (shared with the AI voice receptionist).
    const result = createAppointment(db, shop, req.body);
    if (!result.ok) return res.status(result.code || 400).json({ ok: false, error: result.error });
    master.get('shops').find({ id: shop.id }).assign({ lastActivity: new Date().toISOString() }).write();
    // No confirmation SMS. The platform has no Twilio A2P and the booker isn't the
    // owner (so we can't open their Messages app), so the auto-text is dropped — the
    // new booking shows up immediately in Appointments and on the Dashboard.
    res.json({ ok: true, appointmentId: result.appointmentId, smsSent: false });
  } catch(e) {
    console.error('Booking error:', e.message);
    res.status(500).json({ ok: false, error: 'Booking failed' });
  }
});


module.exports = router;

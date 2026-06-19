const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb, saveImageDataUrl } = require('../db');
const { resolveProfile } = require('../industries');

// Resolve a shop's inspo-photo mode: explicit per-shop setting wins, else the
// industry default ('required' for nail studios, 'off' elsewhere).
function inspoMode(settings, industry) {
  return settings.inspoPhoto || resolveProfile(industry).inspoDefault || 'off';
}

// ── Slot helpers (shared by availability + the booking double-book guard) ─────
function parseClock(t){ const [tm,ap]=t.split(' '); let [h,m]=tm.split(':').map(Number); if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0; return h*60+m; }
function fmtClock(mins){ const h=Math.floor(mins/60),m=mins%60,ap=h>=12?'PM':'AM',h12=h%12||12; return `${h12}:${String(m).padStart(2,'0')} ${ap}`; }
// The exact times a staff member offers on a working day (explicit list or range).
function barberSlotList(b){
  const s = b.schedule || { startTime:'9:00 AM', endTime:'6:00 PM', slotMinutes:30 };
  if (Array.isArray(s.allowedTimes) && s.allowedTimes.length) return s.allowedTimes;
  const out = [];
  for (let t = parseClock(s.startTime||'9:00 AM'); t < parseClock(s.endTime||'6:00 PM'); t += (s.slotMinutes||30)) out.push(fmtClock(t));
  return out;
}
// Statuses that hold a slot (so a pending-deposit booking doesn't block others).
function occupyingStatusKeys(settings){
  const occ = (settings.statuses||[]).filter(s=>s.occupiesSlot).map(s=>s.key);
  return occ.length ? occ : ['confirmed','in-progress'];
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
    const barbers = db.get('barbers').value().filter(b => b.active !== false);
    const services = db.get('services').value();
    const blockedDates = db.get('blockedDates').value().map(b => b.date);
    const stripeConnected = !!(s.stripe?.connectAccountId && s.stripe?.onboardingComplete);
    res.json({
      shopId: shop.id,
      shopSlug: shop.slug,
      shopName: s.shopName || shop.shopName,
      tagline: s.tagline || '',
      bookingEnabled: s.bookingEnabled !== false,
      bookingMessage: s.bookingMessage || 'Book your appointment below!',
      accentColor: s.accentColor || '#16a34a',
      barbers, services, blockedDates,
      // Industry profile bits the booking page needs to render correctly.
      vocab: s.vocab || null,
      customFields: s.customFields || [],
      vehicleSizes: (s.vehicleSizes && s.vehicleSizes.length) ? s.vehicleSizes : (resolveProfile(db.get('industry').value()).vehicleSizes || []),
      addons: s.addons || [],
      staffPicker: s.staffPicker !== undefined ? s.staffPicker : (resolveProfile(db.get('industry').value()).staffPicker !== false),
      statuses: s.statuses || [],
      deposit: { enabled: s.deposit?.enabled && stripeConnected, amount: s.deposit?.amount || 10, message: s.deposit?.message || '' },
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      stripeAccountId: stripeConnected ? s.stripe.connectAccountId : '',
      // Inspiration photo + work gallery
      inspo: inspoMode(s, db.get('industry').value()),
      gallery: s.gallery || [],
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
    let customerId = null, service = '', barberName = '', name = (req.body.name || '').trim();
    const apptId = req.body.appointmentId || null;
    if (apptId) {
      const appt = (db.get('appointments').value() || []).find(x => x.id === apptId);
      if (appt) {
        if (appt.reviewId) return res.status(409).json({ ok: false, error: 'This visit has already been reviewed — thank you!' });
        customerId = appt.customerId || null; service = appt.service || ''; barberName = appt.barberName || '';
        if (!name) name = appt.customerName || '';
      }
    }
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
    if (!date) return res.json([]);

    const blocked = db.get('blockedDates').value().find(b => b.date === date);
    if (blocked) return res.json([]);

    const now = new Date(); now.setHours(0,0,0,0);
    if (new Date(date + 'T12:00:00') < now) return res.json([]);

    function generateSlots(start, end, step) {
      const parse = t => { const [time,ap]=t.split(' '); let [h,m]=time.split(':').map(Number); if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0; return h*60+m; };
      const format = mins => { const h=Math.floor(mins/60),m=mins%60,ap=h>=12?'PM':'AM',h12=h%12||12; return `${h12}:${String(m).padStart(2,'0')} ${ap}`; };
      const slots = [];
      for (let t = parse(start); t < parse(end); t += step) slots.push(format(t));
      return slots;
    }

    const barbers = db.get('barbers').value().filter(b => b.active !== false);
    const dow = new Date(date + 'T12:00:00').getDay();
    let working = barberId ? barbers.filter(b => b.id === barberId) : barbers;
    working = working.filter(b => (b.schedule?.workDays || [1,2,3,4,5,6]).includes(dow));
    if (!working.length) return res.json([]);

    const settings = db.get('settings').value() || {};
    const occupying = (settings.statuses || []).filter(s => s.occupiesSlot).map(s => s.key);
    const occupies = occupying.length ? occupying : ['confirmed', 'in-progress'];
    const appts = db.get('appointments').value().filter(a => a.date === date && occupies.includes(a.status));
    const allSlots = new Set();
    working.forEach(b => {
      const sched = b.schedule || { startTime:'9:00 AM', endTime:'6:00 PM', slotMinutes:30 };
      const booked = appts.filter(a => a.barberId === b.id).map(a => a.time);
      // If this staff member set explicit times, offer ONLY those; otherwise
      // generate the usual start→end slots at the chosen interval.
      const candidates = (Array.isArray(sched.allowedTimes) && sched.allowedTimes.length)
        ? sched.allowedTimes
        : generateSlots(sched.startTime, sched.endTime, sched.slotMinutes);
      candidates.filter(s => !booked.includes(s)).forEach(s => allSlots.add(s));
    });

    const sorted = [...allSlots].sort((a,b) => { const p=t=>{const [tm,ap]=t.split(' ');let[h,m]=tm.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+m;};return p(a)-p(b); });
    res.json(sorted);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── PUBLIC: Book appointment ──────────────────────────────────────────────────
router.post('/api/public/:shopSlug/book', async (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id);
    const { customerName, customerPhone, customerEmail, barberId, barberName, serviceId, date, time, notes, customFields, inspoPhoto, vehicleSize } = req.body;
    if (!customerName || !customerPhone || !date || !time) return res.status(400).json({ ok: false, error: 'Missing required fields' });

    // Enforce required custom fields for this vertical (e.g. detail-shop vehicle info).
    const s0 = db.get('settings').value() || {};
    const cf = customFields || {};
    const missing = (s0.customFields || []).filter(f => f.required && !String(cf[f.key] || '').trim());
    if (missing.length) return res.status(400).json({ ok: false, error: 'Missing required fields: ' + missing.map(f => f.label).join(', ') });

    // Enforce inspiration photo when the shop requires one.
    const inspo = String(inspoPhoto || '');
    if (inspoMode(s0, db.get('industry').value()) === 'required' && !inspo)
      return res.status(400).json({ ok: false, error: 'An inspiration photo is required to book.' });

    // ── Double-booking guard ──────────────────────────────────────────────────
    // The client only sees available slots, but never trust it: re-validate the
    // slot here so two people can't grab the same time (and crafted requests
    // can't book a closed/blocked/past slot). Mirrors the availability logic.
    if ((db.get('blockedDates').value() || []).some(b => b.date === date))
      return res.status(409).json({ ok: false, error: 'That date is no longer available for booking.' });
    const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
    if (new Date(date + 'T12:00:00') < todayMidnight)
      return res.status(400).json({ ok: false, error: 'That date has already passed.' });
    {
      const dow = new Date(date + 'T12:00:00').getDay();
      const occ = occupyingStatusKeys(s0);
      const dayAppts = (db.get('appointments').value() || []).filter(a => a.date === date && occ.includes(a.status));
      const workingBarbers = (db.get('barbers').value() || []).filter(b =>
        b.active !== false &&
        (b.schedule?.workDays || [1,2,3,4,5,6]).includes(dow) &&
        barberSlotList(b).includes(time));
      if (barberId) {
        const b = workingBarbers.find(x => x.id === barberId);
        if (!b) return res.status(409).json({ ok: false, error: 'That time is no longer available. Please pick another.' });
        if (dayAppts.some(a => a.barberId === barberId && a.time === time))
          return res.status(409).json({ ok: false, error: 'Sorry, that time was just booked. Please pick another.' });
      } else {
        // "Any" staff — make sure the shop still has an open chair at that time.
        const takenAtTime = dayAppts.filter(a => a.time === time).length;
        if (!workingBarbers.length || takenAtTime >= workingBarbers.length)
          return res.status(409).json({ ok: false, error: 'Sorry, that time was just booked. Please pick another.' });
      }
    }

    const { getAll, getById, upsert } = shopHelpers(db);
    const svcFromDb = serviceId ? getAll('services').find(s => s.id === serviceId) : null;
    // A booking must reference a real service — the price, name, and duration are
    // all taken from it server-side. Without this, the client could dictate the
    // price (or book a $0 slot with no service). The booking page always sends one.
    if (!svcFromDb) return res.status(400).json({ ok: false, error: 'Please choose a service. If you already did, refresh and try again.' });
    // Price is always resolved server-side (never trust the client's amount).
    // For detail shops the per-size table wins when the customer picked a size,
    // and any chosen add-ons are re-priced from the shop's own add-on list.
    const sizePrice = (svc, key) => (svc && svc.sizePricing && key && svc.sizePricing[key] != null && svc.sizePricing[key] !== '') ? Number(svc.sizePricing[key]) : Number(svc && svc.price) || 0;
    const selAddonIds = Array.isArray(req.body.addons) ? req.body.addons : [];
    const chosenAddons = (s0.addons || []).filter(a => selAddonIds.includes(a.id)).map(a => ({ id: a.id, name: a.name, price: Number(a.price) || 0 }));
    const addonsTotal = chosenAddons.reduce((t, a) => t + a.price, 0);
    const basePrice = sizePrice(svcFromDb, vehicleSize);
    const price = basePrice + addonsTotal;
    const duration = svcFromDb ? Number(svcFromDb.duration) || 45 : 45;

    // Build a vehicle record from custom fields (detail shops) for the customer's history.
    const vehicle = (cf.vehicleYear || cf.vehicleMake || cf.vehicleModel)
      ? { year: cf.vehicleYear || '', make: cf.vehicleMake || '', model: cf.vehicleModel || '', color: cf.vehicleColor || '' }
      : null;
    const _vn = s => String(s || '').trim().toLowerCase();
    const sameVehicle = (a, b) => a && b && _vn(a.year) === _vn(b.year) && _vn(a.make) === _vn(b.make) && _vn(a.model) === _vn(b.model);

    // Find or create customer
    const digits = (customerPhone || '').replace(/[^0-9]/g, '');
    let custId = null;
    if (digits.length >= 10) {
      const existing = getAll('customers').find(c => (c.phone || '').replace(/[^0-9]/g, '') === digits);
      if (existing) {
        custId = existing.id;
        if (vehicle && !(existing.vehicles || []).some(v => sameVehicle(v, vehicle))) {
          existing.vehicles = [...(existing.vehicles || []), vehicle];
          upsert('customers', existing);
        }
      } else {
        custId = genId('c');
        upsert('customers', { id: custId, name: customerName, phone: customerPhone, email: customerEmail || '', source: 'booking-page', notes: '', loyaltyPoints: 0, noShows: 0, preferredBarberId: barberId || null, isFleet: false, companyName: '', vehicles: vehicle ? [vehicle] : [], createdAt: today() });
      }
    }

    // Deposit status is decided server-side, never taken from the client. A shop
    // only holds a deposit when it has enabled one AND Stripe is connected.
    const stripeConnected = !!(s0.stripe?.connectAccountId && s0.stripe?.onboardingComplete);
    const needsDeposit = !!(s0.deposit?.enabled && stripeConnected);

    const apptId = genId('a');
    const appt = { id: apptId, customerId: custId, customerName, customerPhone, customerEmail: customerEmail || '', barberId: barberId || null, barberName: barberName || null, serviceId: serviceId || null, service: svcFromDb.name, price, duration, date, time, status: needsDeposit ? 'pending-deposit' : 'confirmed', notes: notes || '', customFields: cf, vehicleSize: vehicleSize || null, addons: chosenAddons, inspoPhoto: inspo, source: 'booking-page', createdAt: new Date().toISOString() };
    upsert('appointments', appt);

    // Send confirmation SMS via platform Twilio account
    const s = db.get('settings').value() || {};
    let smsSent = false;
    const fromNum = shopFromNumber(shop.id);
    if (twilioClient && fromNum && digits.length >= 10) {
      try {
        const msg = buildSms('confirmation', {
          name: customerName.split(' ')[0],
          shop: s.shopName,
          date, time,
          barber: barberName,
        }, s);
        await twilioClient.messages.create({ from: fromNum, to: '+1' + digits, body: msg });
        smsSent = true;
      } catch(e) { console.error('SMS failed:', e.message); }
    }

    master.get('shops').find({ id: shop.id }).assign({ lastActivity: new Date().toISOString() }).write();
    res.json({ ok: true, appointmentId: apptId, smsSent });
  } catch(e) {
    console.error('Booking error:', e.message);
    res.status(500).json({ ok: false, error: 'Booking failed' });
  }
});


module.exports = router;

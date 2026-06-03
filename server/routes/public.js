const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb } = require('../db');

// ── PUBLIC: Check slug availability ──────────────────────────────────────────
router.get('/api/accounts/check-slug', (req, res) => {
  const { name } = req.query;
  const s = slug(name);
  const taken = !!master.get('shops').find({ slug: s }).value();
  res.json({ slug: s, available: !taken });
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
      deposit: { enabled: s.deposit?.enabled && stripeConnected, amount: s.deposit?.amount || 10, message: s.deposit?.message || '' },
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      stripeAccountId: stripeConnected ? s.stripe.connectAccountId : '',
    });
  } catch(e) {
    console.error('Public info error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
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

    const appts = db.get('appointments').value().filter(a => a.date === date && (a.status === 'confirmed' || a.status === 'in-progress'));
    const allSlots = new Set();
    working.forEach(b => {
      const sched = b.schedule || { startTime:'9:00 AM', endTime:'6:00 PM', slotMinutes:30 };
      const booked = appts.filter(a => a.barberId === b.id).map(a => a.time);
      generateSlots(sched.startTime, sched.endTime, sched.slotMinutes).filter(s => !booked.includes(s)).forEach(s => allSlots.add(s));
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
    const { customerName, customerPhone, customerEmail, barberId, barberName, serviceId, serviceName, servicePrice, date, time, notes, status } = req.body;
    if (!customerName || !customerPhone || !date || !time) return res.status(400).json({ ok: false, error: 'Missing required fields' });

    const { getAll, getById, upsert } = shopHelpers(db);
    const svcFromDb = serviceId ? getAll('services').find(s => s.id === serviceId) : null;
    const price = svcFromDb ? Number(svcFromDb.price) : Number(servicePrice) || 35;
    const duration = svcFromDb ? Number(svcFromDb.duration) || 45 : 45;

    // Find or create customer
    const digits = (customerPhone || '').replace(/[^0-9]/g, '');
    let custId = null;
    if (digits.length >= 10) {
      const existing = getAll('customers').find(c => (c.phone || '').replace(/[^0-9]/g, '') === digits);
      if (existing) { custId = existing.id; }
      else {
        custId = genId('c');
        upsert('customers', { id: custId, name: customerName, phone: customerPhone, email: customerEmail || '', source: 'booking-page', notes: '', loyaltyPoints: 0, noShows: 0, preferredBarberId: barberId || null, createdAt: today() });
      }
    }

    const apptId = genId('a');
    const appt = { id: apptId, customerId: custId, customerName, customerPhone, customerEmail: customerEmail || '', barberId: barberId || null, barberName: barberName || null, serviceId: serviceId || null, service: serviceName || 'Appointment', price, duration, date, time, status: status === 'pending-deposit' ? 'pending-deposit' : 'confirmed', notes: notes || '', source: 'booking-page', createdAt: new Date().toISOString() };
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
      } catch(e) { console.log('SMS failed:', e.message); }
    }

    master.get('shops').find({ id: shop.id }).assign({ lastActivity: new Date().toISOString() }).write();
    res.json({ ok: true, appointmentId: apptId, smsSent });
  } catch(e) {
    console.error('Booking error:', e.message);
    res.status(500).json({ ok: false, error: 'Booking failed' });
  }
});


// ── PUBLIC: Demo booking ──────────────────────────────────────────────────────
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
    // Check slot not taken
    const taken = master.get('demos').value().find(d => d.date === date && d.time === time && d.status !== 'cancelled');
    if (taken) return res.status(409).json({ ok: false, error: 'That time slot was just taken. Please choose another.' });
    const demo = { id: uuidv4(), name, shopName: shopName||'', phone, currentTool: currentTool||'', date, time, status: 'scheduled', notes: '', bookedAt: new Date().toISOString() };
    master.get('demos').push(demo).write();
    // Send confirmation SMS
    if (twilioClient && TWILIO_DEFAULT_FROM) {
      const msg = `Hey ${name}! Your ShopFlow demo is confirmed for ${date} at ${time}. We'll walk you through everything — see you then! 🚀`;
      try { await twilioClient.messages.create({ from: TWILIO_DEFAULT_FROM, to: '+1' + phone.replace(/\D/g,''), body: msg }); } catch(e) { console.error('Demo SMS error:', e.message); }
    }
    res.json({ ok: true, id: demo.id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;

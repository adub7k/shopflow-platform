const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const low        = require('lowdb');
const FileSync   = require('lowdb/adapters/FileSync');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// ── Platform-level Twilio client (shared across all shops) ────────────────────
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_DEFAULT_FROM = process.env.TWILIO_FROM_NUMBER || null;

// Returns the fromNumber for a shop: shop-specific number > platform default
function shopFromNumber(shopId) {
  const shop = master.get('shops').find({ id: shopId }).value();
  return (shop && shop.twilioFromNumber) || TWILIO_DEFAULT_FROM;
}

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'shopflow-dev-secret-change-in-production';

// ── Path resolution ────────────────────────────────────────────────────────────
function findClientDir() {
  const candidates = [
    path.join(__dirname, '..', 'client'),
    path.join(__dirname, 'client'),
    path.join(process.cwd(), 'client'),
    path.join(process.cwd(), '..', 'client'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}
const CLIENT_DIR = findClientDir();
const ROOT = path.dirname(CLIENT_DIR);

// ── Master database (accounts, shops, billing) ────────────────────────────────
const MASTER_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(ROOT, 'data'));
if (!fs.existsSync(MASTER_DIR)) fs.mkdirSync(MASTER_DIR, { recursive: true });
const SHOPS_DIR = path.join(MASTER_DIR, 'shops');
if (!fs.existsSync(SHOPS_DIR)) fs.mkdirSync(SHOPS_DIR, { recursive: true });

const masterAdapter = new FileSync(path.join(MASTER_DIR, 'master.json'));
const master = low(masterAdapter);
master.defaults({
  shops: [],
  accounts: [],
  usedSessions: [],
  platformSettings: { requirePayment: true },
  demos: [],
}).write();

console.log('ShopFlow Platform running on port', PORT);
console.log('Master data:', MASTER_DIR);

// ── SMS template helpers ──────────────────────────────────────────────────────
const SMS_DEFAULTS = {
  confirmation: "Hi {name}! Your appointment at {shop} is confirmed for {date} at {time}{barber}. See you then! ✂️",
  reminder:     "Hi {name}! Reminder: your appointment at {shop} is tomorrow at {time}{barber}. See you then! ✂️",
  rebook:       "Hey {name}! It's been a few weeks — we'd love to have you back at {shop}. Book your next cut anytime 💈",
};

function buildSms(type, vars, settings) {
  const tpl = (settings.smsTemplates && settings.smsTemplates[type]) || SMS_DEFAULTS[type];
  return tpl
    .replace(/{name}/g,   vars.name   || 'there')
    .replace(/{shop}/g,   vars.shop   || 'the shop')
    .replace(/{date}/g,   vars.date   || '')
    .replace(/{time}/g,   vars.time   || '')
    .replace(/{barber}/g, vars.barber ? ` with ${vars.barber}` : '');
}

// ── Per-shop database ─────────────────────────────────────────────────────────
function getShopDb(shopId) {
  const shopDir = path.join(SHOPS_DIR, shopId);
  if (!fs.existsSync(shopDir)) fs.mkdirSync(shopDir, { recursive: true });
  const adapter = new FileSync(path.join(shopDir, 'shopflow.json'));
  const db = low(adapter);
  return db;
}

function initShopDb(db, shopData) {
  db.defaults({
    settings: {
      shopName: shopData.shopName || 'My Shop',
      tagline: 'Walk-ins Welcome.',
      phone: shopData.phone || '',
      address: '',
      email: shopData.email || '',
      bookingEnabled: true,
      bookingMessage: 'Book your appointment below!',
      accentColor: '#16a34a',
      pin: '1234',
      pinEnabled: true,
      loyalty: { enabled: true, visitsForReward: 10, rewardDescription: 'One free service' },
      twilio: { accountSid: '', authToken: '', fromNumber: '' },
      googleReviewLink: '',
      emailSmtp: { host: '', port: 587, user: '', pass: '' },
      deposit: { enabled: false, amount: 10, message: 'A deposit is required to secure your appointment.' },
      stripe: { connectAccountId: '', onboardingComplete: false },
      remindersSent: [],
      scheduledReminders: [],
    },
    barbers: [
      { id: 'b1', name: 'Barber 1', chair: 1, phone: '', bio: '', color: '#16a34a', active: true, joinedAt: new Date().toISOString().split('T')[0], schedule: { workDays: [1,2,3,4,5,6], startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 30 } },
    ],
    services: [
      { id: 's1', name: 'Haircut',      category: 'cut',   price: 35, duration: 45 },
      { id: 's2', name: 'Fade',         category: 'cut',   price: 35, duration: 45 },
      { id: 's3', name: 'Beard Lineup', category: 'beard', price: 15, duration: 20 },
      { id: 's4', name: 'Kids Cut',     category: 'cut',   price: 25, duration: 30 },
    ],
    customers: [],
    appointments: [],
    conversations: [],
    blockedDates: [],
  }).write();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const genId  = (p='x') => p + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
const today  = () => new Date().toISOString().split('T')[0];
const slug   = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32);

function shopHelpers(db) {
  return {
    getAll:  (col)     => db.get(col).value() || [],
    getById: (col, id) => db.get(col).find({id}).value(),
    upsert:  (col, item) => { if(db.get(col).find({id:item.id}).value()) db.get(col).find({id:item.id}).assign(item).write(); else db.get(col).push(item).write(); },
    remove:  (col, id) => db.get(col).remove({id}).write(),
  };
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Hard check: shop must still exist and be active
    const shop = master.get('shops').find({ id: payload.shopId }).value();
    if (!shop) return res.status(401).json({ error: 'Account not found' });
    if (!shop.active) return res.status(401).json({ error: 'Account suspended. Contact support.' });
    req.shopId = payload.shopId;
    req.accountId = payload.accountId;
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(CLIENT_DIR));
app.use('/api', rateLimit({ windowMs: 60000, max: 500 }));

// ── PUBLIC: Account signup ────────────────────────────────────────────────────
app.post('/api/accounts/signup', async (req, res) => {
  try {
    const { shopName, email, password, phone, plan, sessionId } = req.body;
    if (!shopName || !email || !password) return res.status(400).json({ ok: false, error: 'Shop name, email, and password are required' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });

    // ── Payment gate (toggled from admin → Settings) ───────────────────────────
    const platformSettings = master.get('platformSettings').value() || {};
    const requirePayment = platformSettings.requirePayment !== false; // default on
    if (requirePayment) {
      if (!sessionId) {
        return res.status(403).json({ ok: false, error: 'A paid subscription is required to create an account. Please visit our pricing page.' });
      }
      // Check session hasn't already been used to create an account
      const alreadyUsed = master.get('usedSessions').find({ sessionId }).value();
      if (alreadyUsed) {
        return res.status(403).json({ ok: false, error: 'This payment session has already been used. Please contact support if you need help.' });
      }
      // Verify with Stripe that the session is actually paid
      if (stripe) {
        try {
          const session = await stripe.checkout.sessions.retrieve(sessionId);
          const paid = session.payment_status === 'paid' || session.status === 'complete';
          if (!paid) {
            return res.status(403).json({ ok: false, error: 'Payment not confirmed. Please complete checkout before creating your account.' });
          }
        } catch (stripeErr) {
          console.error('Stripe session verify error:', stripeErr.message);
          return res.status(403).json({ ok: false, error: 'Could not verify payment. Please contact support.' });
        }
      }
    }

    // Check if email already exists
    const existing = master.get('accounts').find({ email: email.toLowerCase() }).value();
    if (existing) return res.status(400).json({ ok: false, error: 'An account with this email already exists' });

    // Generate shop ID and slug
    const shopId = uuidv4();
    const shopSlug = slug(shopName) || genId('shop');

    // Check slug is unique
    const slugExists = master.get('shops').find({ slug: shopSlug }).value();
    const finalSlug = slugExists ? shopSlug + '-' + genId('') : shopSlug;

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create account
    const accountId = uuidv4();
    master.get('accounts').push({
      id: accountId,
      shopId,
      email: email.toLowerCase(),
      passwordHash,
      createdAt: new Date().toISOString(),
      plan: plan || 'starter',
      active: true,
    }).write();

    // Create shop record
    master.get('shops').push({
      id: shopId,
      accountId,
      shopName,
      slug: finalSlug,
      email: email.toLowerCase(),
      phone: phone || '',
      plan: plan || 'starter',
      active: true,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    }).write();

    // Initialize shop database
    const shopDb = getShopDb(shopId);
    initShopDb(shopDb, { shopName, email, phone });

    // Mark session as consumed so it can't be reused
    if (sessionId) {
      master.get('usedSessions').push({ sessionId, shopId, usedAt: new Date().toISOString() }).write();
    }

    // Generate token
    const token = jwt.sign({ shopId, accountId, email, shopSlug: finalSlug }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      ok: true,
      token,
      shopId,
      shopSlug: finalSlug,
      shopName,
      crmUrl: '/shop/' + finalSlug,
      bookUrl: '/book/' + finalSlug,
    });
  } catch(e) {
    console.error('Signup error:', e.message);
    res.status(500).json({ ok: false, error: 'Signup failed. Please try again.' });
  }
});

// ── PUBLIC: Login ─────────────────────────────────────────────────────────────
app.post('/api/accounts/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });

    const account = master.get('accounts').find({ email: email.toLowerCase() }).value();
    if (!account) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    if (!account.active) return res.status(401).json({ ok: false, error: 'Account suspended. Contact support.' });

    const valid = await bcrypt.compare(password, account.passwordHash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email or password' });

    const shop = master.get('shops').find({ id: account.shopId }).value();
    const token = jwt.sign({ shopId: account.shopId, accountId: account.id, email, shopSlug: shop?.slug }, JWT_SECRET, { expiresIn: '30d' });

    // Update last activity
    master.get('shops').find({ id: account.shopId }).assign({ lastActivity: new Date().toISOString() }).write();

    res.json({
      ok: true,
      token,
      shopId: account.shopId,
      shopSlug: shop?.slug,
      shopName: shop?.shopName,
      crmUrl: '/shop/' + shop?.slug,
      bookUrl: '/book/' + shop?.slug,
    });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ ok: false, error: 'Login failed. Please try again.' });
  }
});

// ── PUBLIC: Check slug availability ──────────────────────────────────────────
app.get('/api/accounts/check-slug', (req, res) => {
  const { name } = req.query;
  const s = slug(name);
  const taken = !!master.get('shops').find({ slug: s }).value();
  res.json({ slug: s, available: !taken });
});

// ── PUBLIC: Get shop info by slug (for booking page) ─────────────────────────
app.get('/api/public/:shopSlug/info', (req, res) => {
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
app.get('/api/public/:shopSlug/availability', (req, res) => {
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
app.post('/api/public/:shopSlug/book', async (req, res) => {
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

// ── PROTECTED: Auth middleware helper ─────────────────────────────────────────
function shopRoute(fn) {
  return async (req, res) => {
    try {
      const db = getShopDb(req.shopId);
      const h = shopHelpers(db);
      await fn(req, res, db, h);
    } catch(e) {
      console.error('Shop route error:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  };
}

// ── PROTECTED: Settings ───────────────────────────────────────────────────────
app.get('/api/shop/settings', requireAuth, shopRoute(async (req, res, db) => {
  res.json(db.get('settings').value() || {});
}));
app.post('/api/shop/settings', requireAuth, shopRoute(async (req, res, db) => {
  db.get('settings').assign(req.body).write();
  // Update shop name in master if changed
  if (req.body.shopName) master.get('shops').find({ id: req.shopId }).assign({ shopName: req.body.shopName }).write();
  res.json({ ok: true });
}));

// ── PROTECTED: Barbers ────────────────────────────────────────────────────────
app.get('/api/shop/barbers', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('barbers').filter(b => b.active !== false));
}));
app.post('/api/shop/barbers', requireAuth, shopRoute(async (req, res, db, h) => {
  const b = req.body; if (!b.id) b.id = genId('b'); h.upsert('barbers', b); res.json({ id: b.id });
}));
app.delete('/api/shop/barbers/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  h.remove('barbers', req.params.id); res.json({ ok: true });
}));
app.post('/api/shop/barbers/:id/schedule', requireAuth, shopRoute(async (req, res, db, h) => {
  const b = h.getById('barbers', req.params.id); if (!b) return res.status(404).json({ error: 'Not found' });
  b.schedule = req.body; h.upsert('barbers', b); res.json({ ok: true });
}));

// ── PROTECTED: Services ───────────────────────────────────────────────────────
app.get('/api/shop/services', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('services').sort((a,b) => a.category.localeCompare(b.category)));
}));
app.post('/api/shop/services', requireAuth, shopRoute(async (req, res, db, h) => {
  const s = req.body; if (!s.id) s.id = genId('s'); h.upsert('services', s); res.json({ id: s.id });
}));
app.delete('/api/shop/services/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  h.remove('services', req.params.id); res.json({ ok: true });
}));

// ── PROTECTED: Customers ──────────────────────────────────────────────────────
app.get('/api/shop/customers', requireAuth, shopRoute(async (req, res, db, h) => {
  const customers = h.getAll('customers');
  const appointments = h.getAll('appointments');
  const visitCount = {}, lastVisit = {};
  appointments.forEach(a => { if (a.status==='done'&&a.customerId) { visitCount[a.customerId]=(visitCount[a.customerId]||0)+1; if(!lastVisit[a.customerId]||a.date>lastVisit[a.customerId])lastVisit[a.customerId]=a.date; } });
  res.json(customers.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(c=>({...c,totalVisits:visitCount[c.id]||0,lastVisit:lastVisit[c.id]||null})));
}));
app.get('/api/shop/customers/search', requireAuth, shopRoute(async (req, res, db, h) => {
  const q = (req.query.q || '').toLowerCase();
  res.json(h.getAll('customers').filter(c => c.name.toLowerCase().includes(q)||(c.phone||'').includes(q)).slice(0,10));
}));
app.get('/api/shop/customers/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  const barbers  = h.getAll('barbers');
  const services = h.getAll('services');
  const rawAppts = h.getAll('appointments').filter(a => a.customerId===c.id).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const appts = rawAppts.map(a => {
    const barber  = barbers.find(b => b.id === a.barberId);
    const service = a.serviceId ? services.find(s => s.id === a.serviceId) : null;
    return { ...a, barberName: a.barberName || barber?.name || null, service: a.service || service?.name || 'Haircut' };
  });
  const done = appts.filter(a => a.status==='done');
  const lastVisitDate = done.length ? done.sort((a,b)=>b.date.localeCompare(a.date))[0].date : null;
  const daysSinceLast = lastVisitDate ? Math.floor((Date.now()-new Date(lastVisitDate+'T12:00:00'))/(1000*60*60*24)) : null;
  const shopSettings = db.get('settings').value()||{};
  const loyalty = shopSettings.loyalty || { visitsForReward:10 };
  const rebookInterval = shopSettings.rebookInterval || 21;
  const loyaltyVisits = c.loyaltyVisits || c.loyaltyPoints || 0;
  res.json({ customer:{...c, lastVisit:lastVisitDate}, appointments:appts, totalVisits:done.length, totalRevenue:done.reduce((s,a)=>s+Number(a.price||0),0), loyaltyPoints:loyaltyVisits, rewardReady:loyaltyVisits>=(loyalty.visitsForReward||10), visitsForReward:loyalty.visitsForReward||10, daysSinceLast, rebookInterval });
}));
app.post('/api/shop/customers', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = req.body; if (!c.id) c.id = genId('c'); h.upsert('customers', c); res.json({ id: c.id });
}));
app.delete('/api/shop/customers/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  h.remove('customers', req.params.id); res.json({ ok: true });
}));
app.post('/api/shop/customers/:id/redeem', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id); if(c){c.loyaltyPoints=0;h.upsert('customers',c);} res.json({ ok: true });
}));

// ── PROTECTED: Appointments ───────────────────────────────────────────────────
app.get('/api/shop/appointments', requireAuth, shopRoute(async (req, res, db, h) => {
  const { date, month } = req.query;
  const barbers  = h.getAll('barbers');
  const customers = h.getAll('customers');
  const services  = h.getAll('services');
  let appts = h.getAll('appointments');
  if (date)  appts = appts.filter(a => a.date===date);
  if (month) appts = appts.filter(a => (a.date||'').startsWith(month));
  res.json(appts.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(a => {
    const barber   = barbers.find(b => b.id === a.barberId);
    const customer = a.customerId ? customers.find(c => c.id === a.customerId) : null;
    const service  = a.serviceId  ? services.find(s => s.id === a.serviceId)   : null;
    return {
      ...a,
      customerName:  a.customerName  || customer?.name  || 'Unknown Client',
      barberName:    a.barberName    || barber?.name     || null,
      barberColor:   barber?.color   || '#ccc',
      service:       a.service       || service?.name    || 'Haircut',
      customerPhone: a.customerPhone || customer?.phone  || '',
    };
  }));
}));
app.post('/api/shop/appointments', requireAuth, shopRoute(async (req, res, db, h) => {
  const a = req.body; if (!a.id) a.id = genId('a');
  // Ensure customer exists
  if (a.customerName) {
    const digits = (a.customerPhone||'').replace(/[^0-9]/g,'');
    let cust = a.customerId ? h.getById('customers',a.customerId) : null;
    if (!cust && digits.length>=10) cust = h.getAll('customers').find(c=>(c.phone||'').replace(/[^0-9]/g,'')===digits);
    if (cust) { a.customerId=cust.id; }
    else { const cid=genId('c'); h.upsert('customers',{id:cid,name:a.customerName,phone:a.customerPhone||'',email:'',source:a.source||'crm',notes:'',loyaltyPoints:0,noShows:0,preferredBarberId:a.barberId||null,createdAt:today()}); a.customerId=cid; }
  }
  h.upsert('appointments', a);
  res.json({ id: a.id });
}));
app.post('/api/shop/appointments/:id/complete', requireAuth, shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.status='done'; a.price=req.body.price||a.price||0; h.upsert('appointments',a);
  if (a.customerId) { const c=h.getById('customers',a.customerId); if(c){c.loyaltyVisits=(c.loyaltyVisits||c.loyaltyPoints||0)+1;c.loyaltyPoints=c.loyaltyVisits;c.lastJobDate=a.date;h.upsert('customers',c);} }
  res.json({ ok: true });
}));
app.post('/api/shop/appointments/:id/noshow', requireAuth, shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.status='no-show'; a.noShowAt=new Date().toISOString(); h.upsert('appointments',a);
  if (a.customerId) { const c=h.getById('customers',a.customerId); if(c){c.noShows=(c.noShows||0)+1;h.upsert('customers',c);} }
  res.json({ ok: true });
}));
app.post('/api/shop/appointments/:id/waive-deposit', requireAuth, shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.depositWaived=true; h.upsert('appointments',a); res.json({ ok: true });
}));
app.delete('/api/shop/appointments/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  h.remove('appointments', req.params.id); res.json({ ok: true });
}));

// ── PROTECTED: Revenue ────────────────────────────────────────────────────────
app.get('/api/shop/revenue', requireAuth, shopRoute(async (req, res, db, h) => {
  const barbers   = h.getAll('barbers');
  const customers = h.getAll('customers');
  const services  = h.getAll('services');

  // Resolve denormalized fields for any appointment
  function resolveAppt(a) {
    const barber   = barbers.find(b => b.id === a.barberId);
    const customer = a.customerId ? customers.find(c => c.id === a.customerId) : null;
    const service  = a.serviceId  ? services.find(s => s.id === a.serviceId)   : null;
    return {
      ...a,
      customerName: a.customerName || customer?.name || 'Unknown Client',
      barberName:   a.barberName   || barber?.name   || 'Unknown',
      barberColor:  barber?.color  || '#ccc',
      service:      a.service      || service?.name  || 'Haircut',
    };
  }

  const done = h.getAll('appointments').filter(a=>a.status==='done').map(resolveAppt);
  const ms = today().slice(0,7)+'-01';
  const thisMonth = done.filter(a=>a.date>=ms);
  const byBarber = {};
  done.forEach(a=>{if(!byBarber[a.barberId])byBarber[a.barberId]={name:a.barberName,color:a.barberColor,revenue:0,count:0};byBarber[a.barberId].revenue+=Number(a.price||0);byBarber[a.barberId].count++;});
  const byMonth = {};
  done.forEach(a=>{const m=(a.date||'').slice(0,7);if(!byMonth[m])byMonth[m]=0;byMonth[m]+=Number(a.price||0);});
  const loyalty = (db.get('settings').value()||{}).loyalty||{enabled:true,visitsForReward:10};
  res.json({
    totalRevenue: done.reduce((s,a)=>s+Number(a.price||0),0),
    monthRevenue: thisMonth.reduce((s,a)=>s+Number(a.price||0),0),
    monthJobs: thisMonth.length,
    avgTicket: thisMonth.length?Math.round(thisMonth.reduce((s,a)=>s+Number(a.price||0),0)/thisMonth.length):0,
    byBarber: Object.values(byBarber).sort((a,b)=>b.revenue-a.revenue),
    byMonth: Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0])).map(([month,revenue])=>({month,revenue})),
    recentDone: [...done].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5),
    loyaltyAlerts: loyalty.enabled?h.getAll('customers').filter(c=>(c.loyaltyVisits||c.loyaltyPoints||0)>=(loyalty.visitsForReward||10)):[],
  });
}));

// ── PROTECTED: Auth ───────────────────────────────────────────────────────────
app.post('/api/shop/auth/verify-pin', requireAuth, shopRoute(async (req, res, db) => {
  const { pin } = req.body;
  const s = db.get('settings').value()||{};
  if (s.pinEnabled===false) return res.json({ ok: true });
  res.json(String(pin)===String(s.pin||'1234') ? { ok:true } : { ok:false, error:'Incorrect PIN' });
}));
app.post('/api/shop/auth/change-pin', requireAuth, shopRoute(async (req, res, db) => {
  const { currentPin, newPin } = req.body;
  const s = db.get('settings').value()||{};
  if (String(currentPin)!==String(s.pin||'1234')) return res.status(401).json({ ok:false, error:'Current PIN incorrect' });
  if (!newPin||String(newPin).length<4) return res.status(400).json({ ok:false, error:'PIN must be 4+ digits' });
  db.get('settings').assign({ pin:String(newPin) }).write();
  res.json({ ok: true });
}));
app.post('/api/shop/auth/reset-pin', async (req, res) => {
  const { ownerKey, newPin, email } = req.body;
  const key = process.env.OWNER_KEY || 'shopflow2026';
  if (String(ownerKey)!==String(key)) return res.status(401).json({ ok:false, error:'Invalid owner key' });
  if (!email) return res.status(400).json({ ok:false, error:'Email required' });
  const account = master.get('accounts').find({ email: email.toLowerCase() }).value();
  if (!account) return res.status(404).json({ ok:false, error:'Account not found' });
  const db = getShopDb(account.shopId);
  db.get('settings').assign({ pin:String(newPin||'1234') }).write();
  res.json({ ok: true });
});

// ── PROTECTED: Conversations ──────────────────────────────────────────────────

// Global inbox — one thread summary per customer, sorted by latest message
app.get('/api/shop/conversations', requireAuth, shopRoute(async (req, res, db, h) => {
  const convos    = h.getAll('conversations');
  const customers = h.getAll('customers');
  const threads   = {};
  convos.forEach(c => {
    const cid = c.customerId || 'unknown';
    if (!threads[cid]) threads[cid] = { customerId:cid, customerName:c.customerName||'Unknown', customerPhone:'', lastMessage:null, unreadCount:0 };
    if (!threads[cid].lastMessage || new Date(c.sentAt) > new Date(threads[cid].lastMessage.sentAt)) threads[cid].lastMessage = c;
    if (c.direction === 'inbound' && !c.read) threads[cid].unreadCount++;
  });
  Object.values(threads).forEach(t => {
    const cust = customers.find(c => c.id === t.customerId);
    if (cust) { t.customerPhone = cust.phone||''; t.customerName = t.customerName||cust.name; }
  });
  res.json(Object.values(threads).sort((a,b) => new Date(b.lastMessage?.sentAt||0) - new Date(a.lastMessage?.sentAt||0)));
}));

// Per-customer thread
app.get('/api/shop/conversations/customer/:cid', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('conversations').filter(c=>c.customerId===req.params.cid).sort((a,b)=>new Date(a.sentAt)-new Date(b.sentAt)));
}));

// Mark all inbound messages from a customer as read
app.post('/api/shop/conversations/read/:customerId', requireAuth, shopRoute(async (req, res, db, h) => {
  h.getAll('conversations')
    .filter(c => c.customerId === req.params.customerId && c.direction === 'inbound' && !c.read)
    .forEach(c => { c.read = true; h.upsert('conversations', c); });
  res.json({ ok: true });
}));

app.post('/api/shop/conversations', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = req.body; if(!c.id)c.id=genId('msg'); h.upsert('conversations',c); res.json({ id:c.id });
}));

// ── PROTECTED: SMS ────────────────────────────────────────────────────────────
app.post('/api/shop/sms/send', requireAuth, shopRoute(async (req, res, db, h) => {
  const { to, body, customerId, customerName } = req.body;
  const fromNum = shopFromNumber(req.shopId);
  if (!twilioClient || !fromNum) return res.json({ ok:false, error:'SMS not available for this shop yet. Contact ShopFlow support.' });
  try {
    await twilioClient.messages.create({ from:fromNum, to:'+1'+to.replace(/\D/g,''), body });
    h.upsert('conversations',{id:genId('msg'),customerId,customerName,type:'sms',direction:'outbound',body,sentAt:new Date().toISOString(),read:true});
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
}));

// ── PROTECTED: Blocked dates ──────────────────────────────────────────────────
app.get('/api/shop/blocked-dates', requireAuth, shopRoute(async (req, res, db, h) => res.json(h.getAll('blockedDates'))));
app.post('/api/shop/blocked-dates', requireAuth, shopRoute(async (req, res, db, h) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ ok:false });
  if (!h.getAll('blockedDates').find(b=>b.date===date)) h.upsert('blockedDates',{id:genId('bd'),date,reason:reason||'',createdAt:new Date().toISOString()});
  res.json({ ok: true });
}));
app.delete('/api/shop/blocked-dates/:date', requireAuth, shopRoute(async (req, res, db) => {
  db.get('blockedDates').remove({ date:req.params.date }).write(); res.json({ ok: true });
}));

// ── PROTECTED: Deposit ────────────────────────────────────────────────────────
app.post('/api/shop/deposit/confirm', requireAuth, shopRoute(async (req, res, db, h) => {
  const { appointmentId, paymentIntentId, amount } = req.body;
  const a = h.getById('appointments', appointmentId); if(!a) return res.status(404).json({ ok:false });
  a.depositPaid=true; a.depositAmount=amount; a.depositPaymentId=paymentIntentId; a.status='confirmed';
  h.upsert('appointments',a); res.json({ ok: true });
}));

// ── PROTECTED: Feature flags for current shop ─────────────────────────────────
app.get('/api/shop/features', requireAuth, (req, res) => {
  const shop = master.get('shops').find({ id: req.shopId }).value();
  const features = (shop && shop.features) || {};
  res.json({ manualSms: features.manualSms !== false }); // default ON
});

// ── PUBLIC: Demo booking ──────────────────────────────────────────────────────
app.get('/api/public/demo/slots', (req, res) => {
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

app.post('/api/public/demo/book', async (req, res) => {
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

// ── ADMIN: auth middleware ────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'shopflow-admin')) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── ADMIN: overview stats ─────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const shops = master.get('shops').value() || [];
  const planPrices = { starter: 19.99, pro: 99, shop: 200 };
  const MRR_GOAL = 25000;

  const activeShops  = shops.filter(s => s.active);
  const churned      = shops.filter(s => !s.active);

  // Plan counts (active only for MRR)
  const planCounts = {}, allPlanCounts = {};
  activeShops.forEach(s => { planCounts[s.plan]    = (planCounts[s.plan]    || 0) + 1; });
  shops.forEach(s       => { allPlanCounts[s.plan] = (allPlanCounts[s.plan] || 0) + 1; });

  const mrr = Object.entries(planCounts).reduce((sum, [plan, count]) => sum + (planPrices[plan] || 0) * count, 0);

  // Month-over-month: shops created this month vs last month
  const now = new Date();
  const thisMonthStr = now.toISOString().slice(0, 7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = lastMonth.toISOString().slice(0, 7);

  const newThisMonth  = activeShops.filter(s => (s.createdAt||'').startsWith(thisMonthStr));
  const newLastMonth  = activeShops.filter(s => (s.createdAt||'').startsWith(lastMonthStr));
  const newMrrThisMonth = newThisMonth.reduce((s, shop) => s + (planPrices[shop.plan] || 0), 0);
  const newMrrLastMonth = newLastMonth.reduce((s, shop) => s + (planPrices[shop.plan] || 0), 0);

  // Last month's implied MRR (shops active before this month)
  const lastMonthShops = shops.filter(s => s.active && (s.createdAt||'') < thisMonthStr + '-01');
  const lastMrr = lastMonthShops.reduce((sum, s) => sum + (planPrices[s.plan] || 0), 0);
  const mrrGrowth = lastMrr > 0 ? Math.round(((mrr - lastMrr) / lastMrr) * 100) : null;

  // Churn rate (inactive / total ever)
  const churnRate = shops.length > 0 ? Math.round((churned.length / shops.length) * 100) : 0;

  // How many shops needed to hit $25k MRR
  const mrrToGoal = Math.max(0, MRR_GOAL - mrr);
  const shopsNeeded = {
    starter: Math.ceil(mrrToGoal / planPrices.starter),
    pro:     Math.ceil(mrrToGoal / planPrices.pro),
    shop:    Math.ceil(mrrToGoal / planPrices.shop),
  };

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
    recentShops: [...shops].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8).map(s => ({
      id: s.id, shopName: s.shopName, plan: s.plan, email: s.email, createdAt: s.createdAt, active: s.active,
    })),
  });
});

// ── ADMIN: all shops with per-shop stats ──────────────────────────────────────
app.get('/api/admin/shops', requireAdmin, (req, res) => {
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
    return { id: s.id, shopName: s.shopName, slug: s.slug, email: s.email, phone: s.phone, plan: s.plan, active: s.active, createdAt: s.createdAt, lastActivity: s.lastActivity, customers, appointments, barbers, services, stripeConnected, twilioConfigured, bookingEnabled };
  });
  res.json(result);
});

// ── ADMIN: single shop profile ────────────────────────────────────────────────
app.get('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const db = getShopDb(shop.id);
  const settings    = db.get('settings').value()    || {};
  const barbers     = db.get('barbers').value()      || [];
  const services    = db.get('services').value()     || [];
  const customers   = db.get('customers').value()    || [];
  const appointments = db.get('appointments').value() || [];
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const apptThisMonth = appointments.filter(a => a.date && a.date.startsWith(thisMonth)).length;
  const recentAppts = [...appointments].sort((a, b) => new Date(b.date + 'T' + (b.time || '00:00')) - new Date(a.date + 'T' + (a.time || '00:00'))).slice(0, 10);
  res.json({
    shop, settings: { shopName: settings.shopName, tagline: settings.tagline, phone: settings.phone, address: settings.address, bookingEnabled: settings.bookingEnabled, accentColor: settings.accentColor, googleReviewLink: settings.googleReviewLink, loyalty: settings.loyalty, deposit: settings.deposit, stripeConnected: !!(settings.stripe?.connectAccountId && settings.stripe?.onboardingComplete), twilioConfigured: !!(twilioClient && shopFromNumber(shop.id)) },
    barbers, services,
    stats: { totalCustomers: customers.length, totalAppointments: appointments.length, apptThisMonth, activeBarbers: barbers.filter(b => b.active !== false).length },
    recentAppointments: recentAppts,
  });
});

// ── ADMIN: create shop ────────────────────────────────────────────────────────
app.post('/api/admin/shops/create', requireAdmin, async (req, res) => {
  try {
    const { shopName, email, password, phone, plan } = req.body;
    if (!shopName || !email || !password) return res.status(400).json({ ok: false, error: 'shopName, email, password required' });
    const existing = master.get('accounts').find({ email: email.toLowerCase() }).value();
    if (existing) return res.status(400).json({ ok: false, error: 'Email already exists' });
    const shopId = uuidv4();
    const shopSlug = slug(shopName) || genId('shop');
    const slugExists = master.get('shops').find({ slug: shopSlug }).value();
    const finalSlug = slugExists ? shopSlug + '-' + genId('') : shopSlug;
    const passwordHash = await bcrypt.hash(password, 10);
    const accountId = uuidv4();
    master.get('accounts').push({ id: accountId, shopId, email: email.toLowerCase(), passwordHash, createdAt: new Date().toISOString(), plan: plan || 'pro', active: true }).write();
    master.get('shops').push({ id: shopId, accountId, shopName, slug: finalSlug, email: email.toLowerCase(), phone: phone || '', plan: plan || 'pro', active: true, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() }).write();
    const shopDb = getShopDb(shopId);
    initShopDb(shopDb, { shopName, email, phone });
    res.json({ ok: true, shopId, shopSlug: finalSlug, shopName, crmUrl: '/shop/' + finalSlug, bookUrl: '/book/' + finalSlug });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── ADMIN: update shop (plan, active, name) ───────────────────────────────────
app.patch('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
  const allowed = ['plan', 'active', 'shopName', 'phone', 'email', 'twilioFromNumber', 'features'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  master.get('shops').find({ id: req.params.shopId }).assign(updates).write();
  master.get('accounts').find({ id: shop.accountId }).assign(updates.plan ? { plan: updates.plan } : {}).assign(updates.active !== undefined ? { active: updates.active } : {}).write();
  res.json({ ok: true });
});

// ── ADMIN: seed demo account ──────────────────────────────────────────────────
app.post('/api/admin/seed-demo', requireAdmin, async (req, res) => {
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
    const CLIENT_DATA = [
      { name:'Jordan Rivera',    phone:'(505) 555-1001', email:'jordan.r@email.com', notes:'Prefers Marcus. Always asks for skin fade.', loyalty:9,  noShows:0 },
      { name:'Marcus Webb',      phone:'(505) 555-1002', email:'mwebb@gmail.com',    notes:'Bi-weekly regular. Good tipper.',            loyalty:7,  noShows:0 },
      { name:'DeShawn Carter',   phone:'(505) 555-1003', email:'',                   notes:'Taper fade, leave length on top.',           loyalty:5,  noShows:1 },
      { name:'Tyler Brooks',     phone:'(505) 555-1004', email:'',                   notes:'Comes in every 3 weeks.',                   loyalty:4,  noShows:0 },
      { name:'Isaiah Flores',    phone:'(505) 555-1005', email:'',                   notes:'Kids cut — very particular dad.',            loyalty:6,  noShows:0 },
      { name:'Cameron Nash',     phone:'(505) 555-1006', email:'cnash@email.com',    notes:'Beard only. Every 2 weeks.',                loyalty:3,  noShows:0 },
      { name:'Elijah Monroe',    phone:'(505) 555-1007', email:'',                   notes:'Low fade, Edgar top.',                      loyalty:8,  noShows:0 },
      { name:'Aiden Torres',     phone:'(505) 555-1008', email:'',                   notes:'Always brings his son too.',                loyalty:2,  noShows:1 },
      { name:'Noah Castillo',    phone:'(505) 555-1009', email:'',                   notes:"Hates clippers past a 2.",                  loyalty:5,  noShows:0 },
      { name:'Liam Ortega',      phone:'(505) 555-1010', email:'liamo@email.com',    notes:'Curly top, tight sides.',                   loyalty:3,  noShows:0 },
      { name:'Xavier Price',     phone:'(505) 555-1011', email:'',                   notes:'High top fade. Comes in every 10 days.',    loyalty:9,  noShows:0 },
      { name:'Jaylen Scott',     phone:'(505) 555-1012', email:'jscott@gmail.com',   notes:'Waves — 360 brushwork requested.',          loyalty:6,  noShows:2 },
      { name:'Malik Thompson',   phone:'(505) 555-1013', email:'',                   notes:'Hot towel shave every time.',               loyalty:4,  noShows:0 },
      { name:'Caleb Washington', phone:'(505) 555-1014', email:'cwash@email.com',    notes:'Cut + beard combo always.',                 loyalty:7,  noShows:0 },
      { name:'Ethan Powell',     phone:'(505) 555-1015', email:'',                   notes:'New client — referred by Jordan.',          loyalty:2,  noShows:0 },
      { name:'Zion Hughes',      phone:'(505) 555-1016', email:'zhughes@gmail.com',  notes:'Taper, line it up.',                        loyalty:5,  noShows:0 },
      { name:'Andre Mitchell',   phone:'(505) 555-1017', email:'',                   notes:'Prefers Dre. They go way back.',            loyalty:8,  noShows:0 },
      { name:'Dominic Reed',     phone:'(505) 555-1018', email:'dreed@outlook.com',  notes:'Kid — comes with dad every month.',         loyalty:3,  noShows:0 },
      { name:'Chris Lawson',     phone:'(505) 555-1019', email:'',                   notes:'Shape up only. Quick in-out.',              loyalty:1,  noShows:0 },
      { name:'Kevin James',      phone:'(505) 555-1020', email:'kj@email.com',       notes:'Skin fade every 2 weeks.',                  loyalty:10, noShows:0 },
    ];
    const customers = CLIENT_DATA.map((c, i) => ({ id:'c'+(i+1).toString().padStart(3,'0'), name:c.name, phone:c.phone, email:c.email, notes:c.notes, loyaltyVisits:c.loyalty, loyaltyRewardedAt: c.loyalty>=10 ? daysAgo(15) : null, noShows:c.noShows, createdAt: daysAgo(randInt(30,120)) }));

    const TIMES = ['9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM','12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM','3:30 PM','4:00 PM','4:30 PM','5:00 PM'];
    const CUT_NOTES = [
      'Clean skin fade, 0 on sides, ~2 inches on top.',
      'Low taper, disconnected — more length requested this time.',
      'Skin fade with hard part on left. Beard lined up tight.',
      'Kids cut — scissor on top, short taper. Sat still great.',
      'Waves — 1.5 sides, 3 on top. Brushwork done post-cut.',
      'Cut and full beard lineup. Trimmed to ~half inch.',
      'High top fade — 0 to 1 skin transition, length left on top.',
      'Shape up only — hairline and sideburns.',
      'Classic taper, scissor finish on top. No clipper-over-comb.',
      'Mid fade, curly top left natural. Curl cream applied.',
      'Beard lineup only — cheek line set higher per client request.',
      'First visit consultation — medium fade. Tighter next time.',
    ];

    const appointments = [];
    for (let day = -30; day <= 7; day++) {
      if (day === 0) continue;
      const isPast = day < 0;
      const count = isPast ? randInt(4,9) : randInt(2,6);
      const used = new Set();
      for (let a = 0; a < count; a++) {
        let time, tries=0;
        do { time = TIMES[randInt(0,TIMES.length-1)]; tries++; } while(used.has(time)&&tries<20);
        used.add(time);
        const cust = customers[randInt(0,customers.length-1)];
        const barb = BARBERS[randInt(0,BARBERS.length-1)];
        const svc  = SERVICES[randInt(0,SERVICES.length-1)];
        const noshow = isPast && Math.random()<0.05;
        const tip = noshow ? 0 : [0,0,0,5,5,10,10,10,15,20][randInt(0,9)];
        appointments.push({ id:'a'+Math.random().toString(36).slice(2,10), customerId:cust.id, customerName:cust.name, customerPhone:cust.phone, barberId:barb.id, barberName:barb.name, serviceId:svc.id, service:svc.name, date: daysAgo(-day), time, duration:svc.duration, price:svc.price, tip, status: isPast?(noshow?'no-show':'done'):'confirmed', cutNotes: (!noshow&&isPast&&Math.random()<0.7)?CUT_NOTES[randInt(0,CUT_NOTES.length-1)]:'', bookedAt: new Date(Date.now()+day*864e5-2*864e5).toISOString(), source: Math.random()<0.3?'online':'walk-in' });
      }
    }
    appointments.sort((a,b)=>a.date!==b.date?a.date.localeCompare(b.date):a.time.localeCompare(b.time));

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
      { id:msgId(), customerId:'c020', customerName:'Kevin James', type:'sms', direction:'inbound',  body:'No way!! Thanks bro that's crazy', sentAt:daysAgoISO(3,10,18), read:true },
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
app.get('/api/admin/platform-settings', requireAdmin, (req, res) => {
  const ps = master.get('platformSettings').value() || {};
  res.json({ requirePayment: ps.requirePayment !== false });
});

// ── ADMIN: platform settings (update) ────────────────────────────────────────
app.patch('/api/admin/platform-settings', requireAdmin, (req, res) => {
  const allowed = ['requirePayment'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  master.get('platformSettings').assign(updates).write();
  res.json({ ok: true });
});

// ── ADMIN: demos ─────────────────────────────────────────────────────────────
app.get('/api/admin/demos', requireAdmin, (req, res) => {
  res.json(master.get('demos').value().sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time)));
});
app.patch('/api/admin/demos/:id', requireAdmin, (req, res) => {
  const demo = master.get('demos').find({ id: req.params.id }).value();
  if (!demo) return res.status(404).json({ ok: false });
  const { status, notes } = req.body;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (notes  !== undefined) updates.notes  = notes;
  master.get('demos').find({ id: req.params.id }).assign(updates).write();
  res.json({ ok: true });
});
app.delete('/api/admin/demos/:id', requireAdmin, (req, res) => {
  master.get('demos').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// ── ADMIN: delete shop ────────────────────────────────────────────────────────
app.delete('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
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

// ── Stripe helpers ────────────────────────────────────────────────────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return require('stripe')(key);
}
const APP_URL = process.env.APP_URL || 'https://shopflowio.up.railway.app';

// ── Stripe Connect: status ────────────────────────────────────────────────────
app.get('/api/shop/stripe/connect/status', requireAuth, shopRoute(async (req, res, db) => {
  const s = db.get('settings').value()||{};
  const accountId = s.stripe?.connectAccountId;
  if (!accountId) return res.json({ connected: false });
  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(accountId);
    if (account.charges_enabled && !s.stripe?.onboardingComplete) {
      db.get('settings').assign({ stripe: { connectAccountId: accountId, onboardingComplete: true } }).write();
    }
    res.json({ connected: account.charges_enabled, email: account.email });
  } catch(e) { res.json({ connected: false }); }
}));

// ── Stripe Connect: start onboarding ─────────────────────────────────────────
app.post('/api/shop/stripe/connect/onboard', requireAuth, shopRoute(async (req, res, db) => {
  try {
    const stripe = getStripe();
    const shop = master.get('shops').find({ id: req.shopId }).value();
    const s = db.get('settings').value()||{};
    let accountId = s.stripe?.connectAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({ type: 'express', email: shop.email, metadata: { shopId: req.shopId } });
      accountId = account.id;
      db.get('settings').assign({ stripe: { connectAccountId: accountId, onboardingComplete: false } }).write();
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: APP_URL + '/api/stripe/connect/refresh?shopId=' + req.shopId,
      return_url:  APP_URL + '/api/stripe/connect/return?shopId='  + req.shopId,
      type: 'account_onboarding',
    });
    res.json({ ok: true, url: link.url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
}));

// ── Stripe Connect: return & refresh ─────────────────────────────────────────
app.get('/api/stripe/connect/return', async (req, res) => {
  const shop = master.get('shops').find({ id: req.query.shopId }).value();
  if (!shop) return res.redirect('/login');
  try {
    const stripe = getStripe();
    const db = getShopDb(req.query.shopId);
    const s = db.get('settings').value()||{};
    const accountId = s.stripe?.connectAccountId;
    if (accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      if (account.charges_enabled) db.get('settings').assign({ stripe: { connectAccountId: accountId, onboardingComplete: true } }).write();
    }
  } catch(e) {}
  res.redirect('/shop/' + shop.slug + '?stripe=connected');
});
app.get('/api/stripe/connect/refresh', (req, res) => {
  const shop = master.get('shops').find({ id: req.query.shopId }).value();
  res.redirect(shop ? '/shop/' + shop.slug : '/login');
});

// ── Stripe Connect: disconnect ────────────────────────────────────────────────
app.post('/api/shop/stripe/connect/disconnect', requireAuth, shopRoute(async (req, res, db) => {
  db.get('settings').assign({ stripe: { connectAccountId: '', onboardingComplete: false } }).write();
  res.json({ ok: true });
}));

// ── Checkout: cash ────────────────────────────────────────────────────────────
app.post('/api/shop/checkout/cash', requireAuth, shopRoute(async (req, res, db, h) => {
  const { appointmentId, amount, tip, cutNotes } = req.body;
  const total = Number(amount||0) + Number(tip||0);
  const appt = h.getById('appointments', appointmentId);
  if (!appt) return res.status(404).json({ ok: false });
  appt.status = 'done'; appt.price = total; appt.tip = Number(tip||0); appt.paymentMethod = 'cash'; appt.paidAt = new Date().toISOString();
  if (cutNotes) appt.cutNotes = cutNotes;
  h.upsert('appointments', appt);
  if (appt.customerId) { const c = h.getById('customers', appt.customerId); if(c){c.loyaltyPoints=(c.loyaltyPoints||0)+1;c.lastJobDate=appt.date;h.upsert('customers',c);} }
  res.json({ ok: true });
}));

// ── Checkout: create card payment session ─────────────────────────────────────
app.post('/api/shop/checkout/session', requireAuth, shopRoute(async (req, res, db, h) => {
  try {
    const { appointmentId, amount, tip } = req.body;
    const total = Math.round((Number(amount||0) + Number(tip||0)) * 100);
    const s = db.get('settings').value()||{};
    const accountId = s.stripe?.connectAccountId;
    if (!accountId || !s.stripe?.onboardingComplete) return res.status(400).json({ ok: false, error: 'Stripe not connected. Go to Settings → Deposits & Payments to connect.' });
    const appt = h.getById('appointments', appointmentId);
    if (!appt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: appt.service||'Haircut', description: `${s.shopName||'the shop'}${appt.barberName?' · with '+appt.barberName:''}` }, unit_amount: total }, quantity: 1 }],
      mode: 'payment',
      success_url: APP_URL + '/checkout-success?session={CHECKOUT_SESSION_ID}&appt=' + appointmentId,
      cancel_url:  APP_URL + '/checkout-cancel',
      metadata: { appointmentId, shopId: req.shopId },
      payment_intent_data: { transfer_data: { destination: accountId } },
    });
    res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
}));

// ── Checkout: verify card payment ─────────────────────────────────────────────
app.get('/api/shop/checkout/verify/:sessionId', requireAuth, shopRoute(async (req, res, db, h) => {
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    const paid = session.payment_status === 'paid';
    if (paid) {
      const apptId = req.query.apptId || session.metadata?.appointmentId;
      if (apptId) {
        const appt = h.getById('appointments', apptId);
        if (appt && appt.status !== 'done') {
          appt.status = 'done'; appt.paymentMethod = 'card'; appt.stripeSessionId = session.id; appt.paidAt = new Date().toISOString();
          h.upsert('appointments', appt);
          if (appt.customerId) { const c = h.getById('customers', appt.customerId); if(c){c.loyaltyPoints=(c.loyaltyPoints||0)+1;c.lastJobDate=appt.date;h.upsert('customers',c);} }
        }
      }
    }
    res.json({ paid });
  } catch(e) { res.status(500).json({ paid: false, error: e.message }); }
}));

// ── PUBLIC: Deposit session for booking page ──────────────────────────────────
app.post('/api/public/:shopSlug/deposit-session', async (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id);
    const s = db.get('settings').value() || {};
    const accountId = s.stripe?.connectAccountId;
    if (!accountId || !s.stripe?.onboardingComplete) return res.status(400).json({ ok: false, error: 'Stripe not connected' });
    const { appointmentId, amount } = req.body;
    const total = Math.round(Number(amount || 10) * 100);
    const h = shopHelpers(db);
    const appt = h.getById('appointments', appointmentId);
    if (!appt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Deposit — '+appt.service, description: s.shopName+' · '+appt.date+' at '+appt.time }, unit_amount: total }, quantity: 1 }],
      mode: 'payment',
      success_url: APP_URL + '/booking-deposit-success?session={CHECKOUT_SESSION_ID}&appt=' + appointmentId + '&shop=' + shop.id,
      cancel_url:  APP_URL + '/book/' + req.params.shopSlug + '?deposit=cancelled',
      metadata: { appointmentId, shopId: shop.id },
      payment_intent_data: { transfer_data: { destination: accountId } },
    });
    res.json({ ok: true, url: session.url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PUBLIC: Deposit success callback ─────────────────────────────────────────
app.get('/booking-deposit-success', async (req, res) => {
  try {
    const { session: sessionId, appt: apptId, shop: shopId } = req.query;
    if (sessionId && apptId && shopId) {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status === 'paid') {
        const db = getShopDb(shopId);
        const h = shopHelpers(db);
        const appt = h.getById('appointments', apptId);
        if (appt && appt.status === 'pending-deposit') {
          appt.status = 'confirmed'; appt.depositPaid = true; appt.depositAmount = session.amount_total / 100; appt.depositSessionId = sessionId;
          h.upsert('appointments', appt);
        }
      }
    }
  } catch(e) {}
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f7;"><div style="font-size:64px;margin-bottom:20px;">🎉</div><div style="font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px;">You're booked!</div><div style="font-size:15px;color:#6e6e73;line-height:1.6;margin-bottom:24px;">Your deposit was received and your appointment is confirmed.</div><div style="font-size:13px;color:#aeaeb2;">You can close this tab.</div></body></html>`);
});

// ── Checkout success/cancel pages (redirect back to app) ──────────────────────
app.get('/checkout-success', (req, res) => res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><div style="font-size:48px;margin-bottom:16px;">✅</div><div style="font-size:22px;font-weight:700;margin-bottom:8px;">Payment received!</div><div style="color:#6b7280;margin-bottom:24px;">You can close this tab.</div></body></html>`));
app.get('/checkout-cancel',  (req, res) => res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><div style="font-size:48px;margin-bottom:16px;">↩️</div><div style="font-size:22px;font-weight:700;margin-bottom:8px;">Payment cancelled.</div><div style="color:#6b7280;margin-bottom:24px;">You can close this tab.</div></body></html>`));

// ── Scheduler: 24hr reminders + 21-day rebook nudges ─────────────────────────
async function runScheduler() {
  try {
    const shops = master.get('shops').value().filter(s => s.active);
    for (const shop of shops) {
      try {
        const fromNum = shopFromNumber(shop.id);
        if (!twilioClient || !fromNum) continue;  // skip shops without SMS configured
        const db = getShopDb(shop.id);
        const s = db.get('settings').value()||{};

        // ── 24hr appointment reminders ──
        const tomorrow = new Date(Date.now()+24*3600000).toISOString().split('T')[0];
        const appts = db.get('appointments').value().filter(a=>a.date===tomorrow&&a.status==='confirmed');
        const sentIds = s.remindersSent||[];
        const toRemind = appts.filter(a=>!sentIds.includes(a.id)&&a.customerPhone);
        for (const appt of toRemind) {
          const phone = (appt.customerPhone||'').replace(/[^0-9]/g,'');
          if (phone.length<10) continue;
          const msg = buildSms('reminder', { name:(appt.customerName||'').split(' ')[0], shop:s.shopName, time:appt.time, barber:appt.barberName }, s);
          try { await twilioClient.messages.create({from:fromNum,to:'+1'+phone,body:msg}); sentIds.push(appt.id); } catch(e){}
        }
        if (toRemind.length) db.get('settings').assign({ remindersSent:sentIds.slice(-500) }).write();

        // ── Rebook nudges (interval set per shop, default 21 days) ──
        const rebookDays = Math.min(90, Math.max(7, s.rebookInterval || 21));
        const nudgeSentIds = s.nudgesSent||[];
        const cutoffDate = new Date(Date.now()-rebookDays*24*3600000).toISOString().split('T')[0];
        // Find each customer's most recent completed appointment
        const allAppts = db.get('appointments').value().filter(a=>a.status==='done');
        const lastVisit = {};
        allAppts.forEach(a=>{ if(!lastVisit[a.customerId]||a.date>lastVisit[a.customerId].date) lastVisit[a.customerId]={date:a.date,name:a.customerName,phone:a.customerPhone}; });
        // Anyone whose last visit was rebookDays+ ago and hasn't been nudged yet
        const toNudge = Object.values(lastVisit).filter(v=>v.date<=cutoffDate&&v.phone);
        for (const v of toNudge) {
          const nudgeKey = v.phone+':'+v.date;
          if (nudgeSentIds.includes(nudgeKey)) continue;
          const phone = (v.phone||'').replace(/[^0-9]/g,'');
          if (phone.length<10) continue;
          const firstName = (v.name||'').split(' ')[0]||'there';
          const msg = buildSms('rebook', { name:firstName, shop:s.shopName }, s);
          try { await twilioClient.messages.create({from:fromNum,to:'+1'+phone,body:msg}); nudgeSentIds.push(nudgeKey); } catch(e){}
        }
        db.get('settings').assign({ nudgesSent:nudgeSentIds.slice(-1000) }).write();

      } catch(e) {}
    }
  } catch(e) { console.error('Scheduler error:', e.message); }
}
setInterval(runScheduler, 5*60*1000);
setTimeout(runScheduler, 30000);

// ── Serve pages ───────────────────────────────────────────────────────────────
app.get('/shop/*', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'app.html')));
app.get('/book/*', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'book.html')));
app.get('/demo',    (req, res) => res.sendFile(path.join(CLIENT_DIR, 'demo.html')));
app.get('/signup',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'signup.html')));
app.get('/login',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'login.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'admin.html')));
app.get('*',        (req, res) => res.sendFile(path.join(CLIENT_DIR, 'landing.html')));

app.listen(PORT, () => console.log(`ShopFlow Platform on port ${PORT}`));

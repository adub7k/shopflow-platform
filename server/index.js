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
}).write();

console.log('ShopFlow Platform running on port', PORT);
console.log('Master data:', MASTER_DIR);

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
    const { shopName, email, password, phone, plan } = req.body;
    if (!shopName || !email || !password) return res.status(400).json({ ok: false, error: 'Shop name, email, and password are required' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });

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

    // Send confirmation SMS
    const s = db.get('settings').value() || {};
    const cfg = s.twilio || {};
    let smsSent = false;
    if (cfg.accountSid && cfg.authToken && cfg.fromNumber && digits.length >= 10) {
      try {
        const twilio = require('twilio')(cfg.accountSid, cfg.authToken);
        const msg = `Hi ${customerName.split(' ')[0]}! Your appointment at ${s.shopName || 'the shop'} is confirmed for ${date} at ${time}${barberName ? ' with ' + barberName : ''}. See you then! ✂️`;
        await twilio.messages.create({ from: cfg.fromNumber, to: '+1' + digits, body: msg });
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
  const appts = h.getAll('appointments').filter(a => a.customerId===c.id).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const done = appts.filter(a => a.status==='done');
  const loyalty = (db.get('settings').value()||{}).loyalty || { visitsForReward:10 };
  res.json({ customer:c, appointments:appts, totalVisits:done.length, totalRevenue:done.reduce((s,a)=>s+Number(a.price||0),0), loyaltyPoints:c.loyaltyPoints||0, rewardReady:(c.loyaltyPoints||0)>=(loyalty.visitsForReward||10), visitsForReward:loyalty.visitsForReward||10 });
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
  const barbers = h.getAll('barbers');
  const customers = h.getAll('customers');
  let appts = h.getAll('appointments');
  if (date) appts = appts.filter(a => a.date===date);
  if (month) appts = appts.filter(a => (a.date||'').startsWith(month));
  res.json(appts.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(a=>({...a, barberColor:barbers.find(b=>b.id===a.barberId)?.color||'#ccc', customerPhone:a.customerId?customers.find(c=>c.id===a.customerId)?.phone||'':a.customerPhone||''})));
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
  if (a.customerId) { const c=h.getById('customers',a.customerId); if(c){c.loyaltyPoints=(c.loyaltyPoints||0)+1;c.lastJobDate=a.date;h.upsert('customers',c);} }
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
  const done = h.getAll('appointments').filter(a=>a.status==='done');
  const ms = today().slice(0,7)+'-01';
  const thisMonth = done.filter(a=>a.date>=ms);
  const barbers = h.getAll('barbers');
  const byBarber = {};
  done.forEach(a=>{if(!byBarber[a.barberId])byBarber[a.barberId]={name:a.barberName||'Unknown',color:barbers.find(b=>b.id===a.barberId)?.color||'#ccc',revenue:0,count:0};byBarber[a.barberId].revenue+=Number(a.price||0);byBarber[a.barberId].count++;});
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
    recentDone: done.sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5),
    loyaltyAlerts: loyalty.enabled?h.getAll('customers').filter(c=>(c.loyaltyPoints||0)>=(loyalty.visitsForReward||10)):[],
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
app.get('/api/shop/conversations/customer/:cid', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('conversations').filter(c=>c.customerId===req.params.cid).sort((a,b)=>new Date(a.sentAt)-new Date(b.sentAt)));
}));
app.post('/api/shop/conversations', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = req.body; if(!c.id)c.id=genId('msg'); h.upsert('conversations',c); res.json({ id:c.id });
}));

// ── PROTECTED: SMS ────────────────────────────────────────────────────────────
app.post('/api/shop/sms/send', requireAuth, shopRoute(async (req, res, db, h) => {
  const { to, body, customerId, customerName } = req.body;
  const cfg = (db.get('settings').value()||{}).twilio||{};
  if (!cfg.accountSid||!cfg.authToken||!cfg.fromNumber) return res.json({ ok:false, error:'Twilio not configured' });
  try {
    const twilio = require('twilio')(cfg.accountSid, cfg.authToken);
    await twilio.messages.create({ from:cfg.fromNumber, to:'+1'+to.replace(/\D/g,''), body });
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

// ── ADMIN: ShopFlow dashboard ─────────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'shopflow-admin')) return res.status(401).json({ error: 'Unauthorized' });
  const shops = master.get('shops').value() || [];
  const accounts = master.get('accounts').value() || [];
  const planCounts = {};
  shops.forEach(s => { planCounts[s.plan]=(planCounts[s.plan]||0)+1; });
  res.json({
    totalShops: shops.length,
    activeShops: shops.filter(s=>s.active).length,
    planBreakdown: planCounts,
    recentShops: shops.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,10).map(s=>({shopName:s.shopName,plan:s.plan,createdAt:s.createdAt,lastActivity:s.lastActivity})),
  });
});

// ── 24hr Reminder Scheduler ───────────────────────────────────────────────────
async function runScheduler() {
  try {
    const shops = master.get('shops').value().filter(s => s.active);
    for (const shop of shops) {
      try {
        const db = getShopDb(shop.id);
        const s = db.get('settings').value()||{};
        const cfg = s.twilio||{};
        if (!cfg.accountSid||!cfg.authToken||!cfg.fromNumber) continue;
        const tomorrow = new Date(Date.now()+24*3600000).toISOString().split('T')[0];
        const appts = db.get('appointments').value().filter(a=>a.date===tomorrow&&a.status==='confirmed');
        const sentIds = s.remindersSent||[];
        const toSend = appts.filter(a=>!sentIds.includes(a.id)&&a.customerPhone);
        if (!toSend.length) continue;
        const twilio = require('twilio')(cfg.accountSid, cfg.authToken);
        for (const appt of toSend) {
          const phone = (appt.customerPhone||'').replace(/[^0-9]/g,'');
          if (phone.length<10) continue;
          const msg = `Hi ${(appt.customerName||'').split(' ')[0]||'there'}! Reminder: your appointment at ${s.shopName||'the shop'} is tomorrow at ${appt.time}${appt.barberName?' with '+appt.barberName:''}. See you then! ✂️`;
          try { await twilio.messages.create({from:cfg.fromNumber,to:'+1'+phone,body:msg}); sentIds.push(appt.id); } catch(e){}
        }
        db.get('settings').assign({ remindersSent:sentIds.slice(-500) }).write();
      } catch(e) {}
    }
  } catch(e) { console.error('Scheduler error:', e.message); }
}
setInterval(runScheduler, 5*60*1000);
setTimeout(runScheduler, 30000);

// ── Serve pages ───────────────────────────────────────────────────────────────
app.get('/shop/*', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'app.html')));
app.get('/book/*', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'book.html')));
app.get('/signup',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'signup.html')));
app.get('/login',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'login.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'admin.html')));
app.get('*',        (req, res) => res.sendFile(path.join(CLIENT_DIR, 'landing.html')));

app.listen(PORT, () => console.log(`ShopFlow Platform on port ${PORT}`));

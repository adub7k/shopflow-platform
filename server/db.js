// ── Shared database, config, and helpers ─────────────────────────────────────
const path    = require('path');
const fs      = require('fs');
const low     = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');

// ── Config ────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'shopflow-dev-secret-change-in-production';

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_DEFAULT_FROM = process.env.TWILIO_FROM_NUMBER || null;

// ── Path resolution ───────────────────────────────────────────────────────────
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
const ROOT       = path.dirname(CLIENT_DIR);

// ── Master DB ─────────────────────────────────────────────────────────────────
const MASTER_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(ROOT, 'data'));
if (!fs.existsSync(MASTER_DIR)) fs.mkdirSync(MASTER_DIR, { recursive: true });
const SHOPS_DIR = path.join(MASTER_DIR, 'shops');
if (!fs.existsSync(SHOPS_DIR)) fs.mkdirSync(SHOPS_DIR, { recursive: true });

const master = low(new FileSync(path.join(MASTER_DIR, 'master.json')));
master.defaults({ shops: [], accounts: [], usedSessions: [], platformSettings: { requirePayment: true }, demos: [] }).write();

// ── Per-shop DB ───────────────────────────────────────────────────────────────
function getShopDb(shopId) {
  const shopDir = path.join(SHOPS_DIR, shopId);
  if (!fs.existsSync(shopDir)) fs.mkdirSync(shopDir, { recursive: true });
  return low(new FileSync(path.join(shopDir, 'shopflow.json')));
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
      { id: 'b1', name: 'Barber 1', chair: 1, phone: '', bio: '', color: '#16a34a', active: true,
        joinedAt: new Date().toISOString().split('T')[0],
        schedule: { workDays: [1,2,3,4,5,6], startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 30 } },
    ],
    services: [
      { id: 's1', name: 'Haircut',      category: 'cut',   price: 35, duration: 45 },
      { id: 's2', name: 'Fade',         category: 'cut',   price: 35, duration: 45 },
      { id: 's3', name: 'Beard Lineup', category: 'beard', price: 15, duration: 20 },
      { id: 's4', name: 'Kids Cut',     category: 'cut',   price: 25, duration: 30 },
    ],
    customers: [], appointments: [], conversations: [], blockedDates: [],
  }).write();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const genId = (p='x') => p + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
const today = () => new Date().toISOString().split('T')[0];
const slug  = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32);

function shopHelpers(db) {
  return {
    getAll:  (col)      => db.get(col).value() || [],
    getById: (col, id)  => db.get(col).find({id}).value(),
    upsert:  (col, item) => {
      if (db.get(col).find({id: item.id}).value())
        db.get(col).find({id: item.id}).assign(item).write();
      else
        db.get(col).push(item).write();
    },
    remove: (col, id) => db.get(col).remove({id}).write(),
  };
}

// Wraps a route handler with shop DB lookup
function shopRoute(fn) {
  return async (req, res) => {
    try {
      const db = getShopDb(req.shopId);
      const h  = shopHelpers(db);
      await fn(req, res, db, h);
    } catch(e) {
      console.error('Shop route error:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  };
}

function shopFromNumber(shopId) {
  const shop = master.get('shops').find({ id: shopId }).value();
  return (shop && shop.twilioFromNumber) || TWILIO_DEFAULT_FROM;
}

// ── SMS helpers ───────────────────────────────────────────────────────────────
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

module.exports = {
  master, getShopDb, initShopDb, shopHelpers, shopRoute,
  shopFromNumber, buildSms, SMS_DEFAULTS,
  genId, today, slug,
  JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM,
  CLIENT_DIR, MASTER_DIR, SHOPS_DIR,
};

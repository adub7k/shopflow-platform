// ── Shared database, config, and helpers ─────────────────────────────────────
const path    = require('path');
const fs      = require('fs');
const low     = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');
const { resolveProfile, DEFAULT_INDUSTRY } = require('./industries');

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

// Uploaded images (inspo photos, work gallery) live in their own tree — kept
// OUT of the per-shop DB folder so static serving can never expose shopflow.json.
const UPLOADS_DIR = path.join(MASTER_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Decode a browser-produced data URL and write it to the shop's upload folder.
// Returns the public path (served at /uploads/...). Throws on bad input.
function saveImageDataUrl(shopId, prefix, dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('No image provided');
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) throw new Error('Unsupported image format');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('Empty image');
  if (buf.length > 5 * 1024 * 1024) throw new Error('Image too large (max 5MB)');
  const dir = path.join(UPLOADS_DIR, String(shopId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `/uploads/${shopId}/${file}`;
}

// Best-effort delete of a previously saved /uploads/<shop>/<file> path.
function deleteUpload(url) {
  try {
    const m = String(url || '').match(/^\/uploads\/([^/]+)\/([^/]+)$/);
    if (!m) return;
    const p = path.join(UPLOADS_DIR, m[1], path.basename(m[2]));
    if (p.startsWith(UPLOADS_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
  } catch(e) { /* ignore */ }
}

const master = low(new FileSync(path.join(MASTER_DIR, 'master.json')));
master.defaults({
  shops: [], accounts: [], usedSessions: [], platformSettings: { requirePayment: true }, demos: [],
  sales: {
    pinHash: null,                 // set on first init (default PIN 1234)
    repName: 'Bryce Moen',
    leads: [],
    goals: [],
    todos: [],                     // to-dos assigned by the owner from admin
    activity: { dms: 0, walkins: 0, demos: 0, weekStart: null },  // current week totals
    daily:    { date: null, dms: 0, walkins: 0, demos: 0 },       // today's totals (auto-reset)
    settings: {
      weeklyTargets: { dms: 50, walkins: 5, demos: 5 },
      dailyTargets:  { dms: 10, walkins: 1, demos: 1 },
      focusNote: '',               // owner-customizable banner on the rep's dashboard
    },
    history: [],                   // weekly activity snapshots on reset
  },
}).write();

// ── Per-shop DB ───────────────────────────────────────────────────────────────
function getShopDb(shopId) {
  const shopDir = path.join(SHOPS_DIR, shopId);
  if (!fs.existsSync(shopDir)) fs.mkdirSync(shopDir, { recursive: true });
  return low(new FileSync(path.join(shopDir, 'shopflow.json')));
}

function initShopDb(db, shopData) {
  const industry = shopData.industry || DEFAULT_INDUSTRY;
  const profile = resolveProfile(industry);
  db.defaults({
    industry,
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
      // UI vocabulary + appointment statuses + custom booking fields for this vertical.
      vocab: profile.vocab,
      statuses: profile.statuses,
      customFields: profile.customFields,
      vehicleSizes: profile.vehicleSizes || [],
      serviceCategories: profile.serviceCategories || ['cut','beard','combo','color','design','other'],
      staffPicker: profile.staffPicker !== false,
      supportsFleet: profile.supportsFleet,
      supportsQuotes: profile.supportsQuotes || false,
      // Auto-email a gentle follow-up on estimates left unapproved. Cadence:
      // first nudge afterDays after send, then everyDays, capped at maxReminders.
      quoteReminders: { enabled: true, afterDays: 3, everyDays: 3, maxReminders: 2 },
      loyalty: { enabled: true, visitsForReward: 10, rewardDescription: 'One free service' },
      // Sales tax applied to the service subtotal at checkout + on estimates.
      // Off by default; the owner enables it and sets the rate in Settings.
      tax: { enabled: false, rate: 0, label: 'Sales Tax' },
      twilio: { accountSid: '', authToken: '', fromNumber: '' },
      googleReviewLink: '',
      emailSmtp: { host: '', port: 587, user: '', pass: '' },
      deposit: { ...profile.deposit },
      stripe: { connectAccountId: '', onboardingComplete: false },
      remindersSent: [],
      scheduledReminders: [],
    },
    barbers: [
      { id: 'b1', name: profile.vocab.staff + ' 1', chair: 1, phone: '', bio: '', color: '#16a34a', active: true,
        joinedAt: new Date().toISOString().split('T')[0],
        schedule: { workDays: [1,2,3,4,5,6], startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 30 } },
    ],
    services: profile.services.map((s, i) => ({ id: 's' + (i + 1), ...s })),
    customers: [], appointments: [], conversations: [], blockedDates: [], quotes: [],
    leads: [], calls: [], expenses: [], campaigns: [],
  }).write();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const genId = (p='x') => p + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
const today = () => new Date().toISOString().split('T')[0];
const slug  = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32);

// Normalize a US/CA phone number to E.164 (+1XXXXXXXXXX). Returns null if it
// doesn't look like a dialable 10/11-digit number. Twilio dialing + SMS share this.
function toE164(num) {
  const d = String(num || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (String(num || '').trim().startsWith('+')) return '+' + d;  // already-international
  return null;
}

function shopHelpers(db) {
  return {
    getAll:  (col)      => db.get(col).value() || [],
    getById: (col, id)  => (db.get(col).value() ? db.get(col).find({id}).value() : undefined),
    upsert:  (col, item) => {
      // Self-heal: shops created before a collection existed have no such key,
      // and lowdb's .push() silently no-ops on an undefined collection.
      if (db.get(col).value() === undefined) db.set(col, []).write();
      if (db.get(col).find({id: item.id}).value())
        db.get(col).find({id: item.id}).assign(item).write();
      else
        db.get(col).push(item).write();
    },
    remove: (col, id) => { if (db.get(col).value()) db.get(col).remove({id}).write(); },
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

// A shop's OWN assigned tracking number — per-shop only, with NO global fallback.
// Use this for anything shown to or attributed to a shop (settings display, leads
// banner, call-tracking identity) so one tenant never sees or claims another's
// number. (Outbound SMS keeps using shopFromNumber, which may fall back to the
// platform default sender.) Checks the master shop record first, then the per-shop
// settings.twilio.fromNumber.
function shopOwnNumber(shopId) {
  const shop = master.get('shops').find({ id: shopId }).value();
  if (shop && shop.twilioFromNumber) return shop.twilioFromNumber;
  try {
    const s = getShopDb(shopId).get('settings').value() || {};
    if (s.twilio && s.twilio.fromNumber) return s.twilio.fromNumber;
  } catch (e) { /* shop db may not exist yet */ }
  return '';
}

// ── Money helpers: tax + job cost ─────────────────────────────────────────────
// Sales tax on a service subtotal (never on tips). Returns a zeroed result when
// the shop hasn't enabled tax, so callers can always read `.amount`. `rate` is a
// percent (e.g. 7.5). Amounts are rounded to whole cents.
function computeTax(settings, subtotal) {
  const t = (settings && settings.tax) || {};
  const rate = Number(t.rate) || 0;
  const label = t.label || 'Sales Tax';
  if (!t.enabled || rate <= 0) return { enabled: false, rate: 0, label, amount: 0 };
  const amount = Math.round((Number(subtotal) || 0) * rate) / 100; // subtotal * rate/100, to cents
  return { enabled: true, rate, label, amount };
}

// Material/product cost snapshot for an appointment — the service's cost plus any
// add-on costs. Stored on the appointment so margin reporting survives later edits
// to the service/add-on menu. Costs are optional; missing costs count as $0.
function computeApptCost(db, appt) {
  const services = db.get('services').value() || [];
  const addons   = (db.get('settings').value() || {}).addons || [];
  const svc = appt.serviceId ? services.find(s => s.id === appt.serviceId) : null;
  let cost = Number(svc && svc.cost) || 0;
  (appt.addons || []).forEach(a => {
    const def = addons.find(x => x.id === a.id);
    if (def) cost += Number(def.cost) || 0;
  });
  return Math.round(cost * 100) / 100;
}

// ── SMS helpers ───────────────────────────────────────────────────────────────
const SMS_DEFAULTS = {
  confirmation: "Hi {name}! Your appointment at {shop} is confirmed for {date} at {time}{barber}. See you then!",
  reminder:     "Hi {name}! Reminder: your appointment at {shop} is tomorrow at {time}{barber}. See you then!",
  rebook:       "Hey {name}! It's been a few weeks — we'd love to have you back at {shop}. Book your next visit anytime.",
  missedCall:   "Hi, this is {shop} — sorry we missed your call! How can we help? Reply here or book online anytime.",
  review:       "Hi {name}, thanks for visiting {shop}! We'd love your feedback — leave us a quick review: {link}",
};

function buildSms(type, vars, settings) {
  // smsTemplates is now a [{id,label,body}] list (owner-managed); tolerate both the
  // new list shape and the legacy keyed object, falling back to the built-in default.
  const raw = settings.smsTemplates;
  const fromList = Array.isArray(raw) ? ((raw.find(t => t && t.id === type) || {}).body || '') : '';
  const tpl = fromList || (raw && !Array.isArray(raw) && raw[type]) || SMS_DEFAULTS[type];
  return tpl
    .replace(/{name}/g,   vars.name   || 'there')
    .replace(/{shop}/g,   vars.shop   || 'the shop')
    .replace(/{date}/g,   vars.date   || '')
    .replace(/{time}/g,   vars.time   || '')
    .replace(/{barber}/g, vars.barber ? ` with ${vars.barber}` : '')
    .replace(/{link}/g,   vars.link   || '');
}

module.exports = {
  master, getShopDb, initShopDb, shopHelpers, shopRoute,
  shopFromNumber, shopOwnNumber, buildSms, SMS_DEFAULTS,
  genId, today, slug, toE164,
  computeTax, computeApptCost,
  JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM,
  CLIENT_DIR, MASTER_DIR, SHOPS_DIR, UPLOADS_DIR,
  saveImageDataUrl, deleteUpload,
};

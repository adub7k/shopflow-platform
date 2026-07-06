// ── ShopFlow Platform — entry point ──────────────────────────────────────────
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const { CLIENT_DIR, UPLOADS_DIR, master, getShopDb } = require('./db');
const { resolveProfile } = require('./industries');
const { runScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Crash guards ──────────────────────────────────────────────────────────────
// Express 4 does not catch async throws, and several fire-and-forget sends (SMS,
// email) can reject. A single unhandled rejection would kill the process, and
// Railway stops restarting after 10 crashes — so log loudly and stay up rather
// than let one bad request take down every tenant.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack || err);
});

// ── Production secret guard ───────────────────────────────────────────────────
// These have insecure in-repo defaults for local dev. In production they MUST be
// set, or anyone could forge owner/admin tokens. Fail fast rather than run open.
if (process.env.NODE_ENV === 'production') {
  const missing = ['JWT_SECRET', 'ADMIN_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('FATAL: required secrets not set in production:', missing.join(', '));
    process.exit(1);
  }
  // Not fatal (Stripe may be unused), but if it's unset the webhook silently ACKs
  // every event and drops payment confirmations — warn loudly so it's caught.
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('WARNING: STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not — Stripe webhooks will be dropped unverified. Set it in the Railway environment.');
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // trust exactly one proxy hop (Railway) — correct req.protocol for signature URLs without opening rate-limit IP spoofing
app.use(cors({ origin: '*' }));
// Stripe webhook needs the raw, unparsed body for signature verification, so it
// must be mounted BEFORE express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), require('./routes/stripe').stripeWebhook);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false })); // Twilio webhooks POST form-encoded
app.use(express.static(CLIENT_DIR));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d' }));
app.use('/api', rateLimit({ windowMs: 60000, max: 500 }));

// ── Targeted throttles on abuse-prone endpoints ───────────────────────────────
// The global limiter (500/min/IP) is too loose to stop credential stuffing or
// lead/booking spam. These tighter, per-IP limiters sit in front of the sensitive
// write endpoints. standardHeaders on; legacy headers off.
const strictLimiter = (max, windowMs = 15 * 60 * 1000) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' },
});
// Auth + PIN: 20 tries per 15 min per IP.
const authLimiter = strictLimiter(20);
// Public writes (lead capture, public booking): 15 per minute per IP.
const publicWriteLimiter = strictLimiter(15, 60 * 1000);
// Apply a limiter only to requests matching a predicate (path/method), so we can
// throttle the mutating public endpoints without slowing the booking page's reads.
const limitWhen = (limiter, match) => (req, res, next) => match(req) ? limiter(req, res, next) : next();

app.use('/api/accounts/login', authLimiter);
app.use('/api/accounts/signup', authLimiter);
app.use(limitWhen(authLimiter, req => req.method === 'POST' && req.path === '/api/shop/auth/verify-pin'));
app.use(limitWhen(authLimiter, req => req.method === 'POST' && req.path === '/api/sales/login'));
app.use(limitWhen(publicWriteLimiter, req => req.method === 'POST' && /^\/api\/public\/[^/]+\/(lead|book)$/.test(req.path)));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use(require('./routes/auth'));
app.use(require('./routes/public'));
app.use(require('./routes/twilio'));
app.use(require('./routes/shop'));
app.use(require('./routes/cleaning'));
app.use(require('./routes/receptionist'));
app.use(require('./routes/admin'));
app.use(require('./routes/sales'));
app.use(require('./routes/stripe'));
app.use(require('./routes/square'));

// ── HTML Pages ────────────────────────────────────────────────────────────────
app.get('/shop/*',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'app.html')));
// Quote-first verticals (detail shops) get the opt-in lead-capture page at the
// same /book/<slug> URL; scheduling verticals keep the calendar booking flow.
// Per-shop override: settings.bookingMode ('booking' | 'leads').
app.get('/book/*',  (req, res) => {
  let page = 'book.html';
  try {
    const shopSlug = req.path.replace(/^\/book\/?/, '').split('/')[0];
    const shop = shopSlug && master.get('shops').find({ slug: shopSlug, active: true }).value();
    if (shop) {
      const db = getShopDb(shop.id);
      const mode = (db.get('settings').value() || {}).bookingMode
        || (resolveProfile(db.get('industry').value()).leadCapture ? 'leads' : 'booking');
      if (mode === 'leads') page = 'lead.html';
    }
  } catch(e) { /* fall through to the booking page */ }
  res.sendFile(path.join(CLIENT_DIR, page));
});
app.get('/review/*',(req, res) => res.sendFile(path.join(CLIENT_DIR, 'review.html')));
app.get('/quote/*', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'quote.html')));
app.get('/demo',    (req, res) => res.sendFile(path.join(CLIENT_DIR, 'demo.html')));
app.get('/sales',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'sales.html')));
app.get('/signup',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'signup.html')));
app.get('/login',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'login.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'admin.html')));
app.get('*',        (req, res) => res.sendFile(path.join(CLIENT_DIR, 'landing.html')));

// ── Optional one-time demo seed ───────────────────────────────────────────────
// Set SEED_DEMO=true in the environment (e.g. on Railway) to seed the generic
// demo detail shop into the persistent volume on boot. Create-only: it won't
// wipe an existing demo shop on every restart. Unset it once seeded.
if (process.env.SEED_DEMO === 'true') {
  try { require('../seed-demo-detail')({ force: false }); }
  catch(e) { console.error('Demo seed failed:', e.message); }
}

// Set SEED_CLEANING=true to seed a self-contained cleaning-company demo
// (Summit Home Cleaning) into the volume on boot. Create-only; unset once seeded.
if (process.env.SEED_CLEANING === 'true') {
  try { require('../seed-cleaning-demo')({ force: false }); }
  catch(e) { console.error('Cleaning demo seed failed:', e.message); }
}

// ── One-time: claim the legacy global tracking number for one shop ─────────────
// Historically TWILIO_FROM_NUMBER was a single shared default, so every shop
// without its own number displayed it. Set TWILIO_FROM_SHOP to the owning shop's
// slug (or id) and on boot the number is written onto THAT shop's record; no other
// shop inherits it anymore. Idempotent (won't overwrite a number already set).
// Once migrated, remove TWILIO_FROM_SHOP (and TWILIO_FROM_NUMBER if you no longer
// want it as the outbound-SMS fallback for unassigned shops).
if (process.env.TWILIO_FROM_NUMBER && process.env.TWILIO_FROM_SHOP) {
  try {
    const { master } = require('./db');
    const key = process.env.TWILIO_FROM_SHOP;
    const shop = master.get('shops').find(s => s.slug === key || s.id === key).value();
    if (!shop) console.warn('TWILIO_FROM_SHOP: no shop matches', key);
    else if (shop.twilioFromNumber) console.log('• Tracking number already set for', shop.slug, '— skipping migration');
    else {
      master.get('shops').find({ id: shop.id }).assign({ twilioFromNumber: process.env.TWILIO_FROM_NUMBER }).write();
      console.log('• Assigned TWILIO_FROM_NUMBER to shop', shop.slug);
    }
  } catch (e) { console.error('Tracking-number migration failed:', e.message); }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`ShopFlow Platform on port ${PORT}`));
setTimeout(runScheduler, 30000);

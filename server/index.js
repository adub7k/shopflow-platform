// ── ShopFlow Platform — entry point ──────────────────────────────────────────
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const { CLIENT_DIR, UPLOADS_DIR } = require('./db');
const { runScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Production secret guard ───────────────────────────────────────────────────
// These have insecure in-repo defaults for local dev. In production they MUST be
// set, or anyone could forge owner/admin tokens. Fail fast rather than run open.
if (process.env.NODE_ENV === 'production') {
  const missing = ['JWT_SECRET', 'ADMIN_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('FATAL: required secrets not set in production:', missing.join(', '));
    process.exit(1);
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

// ── API Routes ────────────────────────────────────────────────────────────────
app.use(require('./routes/auth'));
app.use(require('./routes/public'));
app.use(require('./routes/twilio'));
app.use(require('./routes/shop'));
app.use(require('./routes/admin'));
app.use(require('./routes/sales'));
app.use(require('./routes/stripe'));

// ── HTML Pages ────────────────────────────────────────────────────────────────
app.get('/shop/*',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'app.html')));
app.get('/book/*',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'book.html')));
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`ShopFlow Platform on port ${PORT}`));
setTimeout(runScheduler, 30000);

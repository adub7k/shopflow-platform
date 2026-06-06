// ── ShopFlow Platform — entry point ──────────────────────────────────────────
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const { CLIENT_DIR } = require('./db');
const { runScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(CLIENT_DIR));
app.use('/api', rateLimit({ windowMs: 60000, max: 500 }));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use(require('./routes/auth'));
app.use(require('./routes/public'));
app.use(require('./routes/shop'));
app.use(require('./routes/admin'));
app.use(require('./routes/sales'));
app.use(require('./routes/stripe'));

// ── HTML Pages ────────────────────────────────────────────────────────────────
app.get('/shop/*',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'app.html')));
app.get('/book/*',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'book.html')));
app.get('/demo',    (req, res) => res.sendFile(path.join(CLIENT_DIR, 'demo.html')));
app.get('/sales',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'sales.html')));
app.get('/signup',  (req, res) => res.sendFile(path.join(CLIENT_DIR, 'signup.html')));
app.get('/login',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'login.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(CLIENT_DIR, 'admin.html')));
app.get('*',        (req, res) => res.sendFile(path.join(CLIENT_DIR, 'landing.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`ShopFlow Platform on port ${PORT}`));
setTimeout(runScheduler, 30000);

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb } = require('../db');

// ── PUBLIC: Account signup ────────────────────────────────────────────────────
router.post('/api/accounts/signup', async (req, res) => {
  try {
    const { shopName, email, password, phone, plan, sessionId, industry } = req.body;
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
      name: shopName,         // owner display name (editable later)
      role: 'full',           // owner = full access
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
      industry: industry || 'barbershop',
      active: true,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    }).write();

    // Initialize shop database
    const shopDb = getShopDb(shopId);
    initShopDb(shopDb, { shopName, email, phone, industry });

    // Mark session as consumed so it can't be reused
    if (sessionId) {
      master.get('usedSessions').push({ sessionId, shopId, usedAt: new Date().toISOString() }).write();
    }

    // Generate token
    const token = jwt.sign({ shopId, accountId, email, shopSlug: finalSlug, role: 'full' }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      ok: true,
      token,
      shopId,
      shopSlug: finalSlug,
      shopName,
      role: 'full',
      name: shopName,
      crmUrl: '/shop/' + finalSlug,
      bookUrl: '/book/' + finalSlug,
    });
  } catch(e) {
    console.error('Signup error:', e.message);
    res.status(500).json({ ok: false, error: 'Signup failed. Please try again.' });
  }
});

// ── PUBLIC: Login ─────────────────────────────────────────────────────────────
router.post('/api/accounts/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });

    const account = master.get('accounts').find({ email: email.toLowerCase() }).value();
    if (!account) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    if (!account.active) return res.status(401).json({ ok: false, error: 'Account suspended. Contact support.' });

    const valid = await bcrypt.compare(password, account.passwordHash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email or password' });

    const shop = master.get('shops').find({ id: account.shopId }).value();
    const role = account.role || 'full';
    const token = jwt.sign({ shopId: account.shopId, accountId: account.id, email, shopSlug: shop?.slug, role }, JWT_SECRET, { expiresIn: '30d' });

    // Update last activity
    master.get('shops').find({ id: account.shopId }).assign({ lastActivity: new Date().toISOString() }).write();

    // Client-portal sign-ins land in the shop's activity journal so the owner
    // can see when the outside login was used (Settings → Team → Activity).
    if (role === 'client') {
      try { require('./client').logClientActivity(getShopDb(account.shopId), account.id, 'login'); }
      catch (e) { console.error('client login activity failed:', e.message); }
    }

    res.json({
      ok: true,
      token,
      shopId: account.shopId,
      shopSlug: shop?.slug,
      shopName: shop?.shopName,
      role,
      name: account.name || '',
      // Client-portal logins land on /portal — their token is rejected by every
      // /api/shop route anyway (middleware.js), so the CRM would just error out.
      crmUrl: role === 'client' ? '/portal' : '/shop/' + shop?.slug,
      bookUrl: '/book/' + shop?.slug,
    });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ ok: false, error: 'Login failed. Please try again.' });
  }
});

// ── PUBLIC: Check slug availability ──────────────────────────────────────────
router.get('/api/accounts/check-slug', (req, res) => {
  const { name } = req.query;
  const s = slug(name);
  const taken = !!master.get('shops').find({ slug: s }).value();
  res.json({ slug: s, available: !taken });
});

module.exports = router;

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb, computeTax } = require('../db');

// ── Stripe helpers ────────────────────────────────────────────────────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return require('stripe')(key);
}
const APP_URL = process.env.APP_URL || 'https://shopflowio.up.railway.app';

// ── Fulfillment ───────────────────────────────────────────────────────────────
// Shared by the browser success-redirects AND the Stripe webhook. All ids come
// from the Stripe session's own metadata (never request query params), so a paid
// session can't be replayed against another tenant's records. Each is idempotent.
function fulfillBookingDeposit(shopId, apptId, session) {
  const db = getShopDb(shopId); const h = shopHelpers(db);
  const appt = h.getById('appointments', apptId);
  // Confirm a pending booking, OR just record the deposit on an already-confirmed
  // appointment (e.g. a deposit link sent from the client profile). Idempotent.
  if (appt && (appt.status === 'pending-deposit' || !appt.depositPaid)) {
    if (appt.status === 'pending-deposit') appt.status = 'confirmed';
    appt.depositPaid = true;
    appt.depositAmount = session.amount_total / 100; appt.depositSessionId = session.id;
    h.upsert('appointments', appt);
  }
}
function fulfillQuoteDeposit(shopId, quoteId, session) {
  const db = getShopDb(shopId); const h = shopHelpers(db);
  const q = h.getById('quotes', quoteId);
  if (q && !q.depositPaid) {
    q.depositPaid = true; q.depositSessionId = session.id; q.depositAmount = session.amount_total / 100;
    if (q.status !== 'scheduled') q.status = 'approved';
    q.approvedAt = q.approvedAt || new Date().toISOString();
    h.upsert('quotes', q);
  }
}
function fulfillMembership(shopId, custId, planId, session) {
  const db = getShopDb(shopId); const h = shopHelpers(db);
  const c = h.getById('customers', custId);
  const plan = ((db.get('settings').value() || {}).membershipPlans || []).find(p => p.id === planId);
  if (!c || !plan) return;
  // Idempotent: the redirect and the webhook may both fire for the same session.
  if (c.membership?.status === 'active' && c.membership?.stripeSubscriptionId === (session.subscription || '')) return;
  c.membership = { planId: plan.id, planName: plan.name, price: Number(plan.price) || 0, interval: plan.interval || 'month', status: 'active', source: 'stripe', stripeSubscriptionId: session.subscription || '', stripeCustomerId: session.customer || '', startedAt: new Date().toISOString() };
  h.upsert('customers', c);
}

// Stripe webhook — the authoritative payment confirmation. The browser redirect
// is best-effort (a customer can pay then close the tab); this guarantees the DB
// is updated. Mounted in index.js with a raw-body parser BEFORE express.json.
// No-op until STRIPE_WEBHOOK_SECRET is set (so it can't be spoofed).
function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(200).send('Stripe webhook not configured');
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (e) {
    return res.status(400).send('Webhook signature verification failed');
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const m = session.metadata || {};
      if (m.appointmentId && m.shopId)            fulfillBookingDeposit(m.shopId, m.appointmentId, session);
      else if (m.quoteId && m.shopId)             fulfillQuoteDeposit(m.shopId, m.quoteId, session);
      else if (m.customerId && m.planId && m.shopId) fulfillMembership(m.shopId, m.customerId, m.planId, session);
    }
  } catch (e) { console.error('Stripe webhook handler error:', e.message); }
  res.json({ received: true });
}

// ── Stripe Connect: status ────────────────────────────────────────────────────
router.get('/api/shop/stripe/connect/status', requireAuth, shopRoute(async (req, res, db) => {
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
router.post('/api/shop/stripe/connect/onboard', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
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
router.get('/api/stripe/connect/return', async (req, res) => {
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
router.get('/api/stripe/connect/refresh', (req, res) => {
  const shop = master.get('shops').find({ id: req.query.shopId }).value();
  res.redirect(shop ? '/shop/' + shop.slug : '/login');
});

// ── Stripe Connect: disconnect ────────────────────────────────────────────────
router.post('/api/shop/stripe/connect/disconnect', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  db.get('settings').assign({ stripe: { connectAccountId: '', onboardingComplete: false } }).write();
  res.json({ ok: true });
}));

// ── Checkout: cash ────────────────────────────────────────────────────────────
router.post('/api/shop/checkout/cash', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const { appointmentId, amount, tip, cutNotes } = req.body;
  const appt = h.getById('appointments', appointmentId);
  if (!appt) return res.status(404).json({ ok: false });
  // Tax applies to the service amount only (never the tip). `price` stays the
  // revenue figure (service + tip); tax is tracked separately as collected tax.
  const subtotal = Number(amount||0);
  const tax = computeTax(db.get('settings').value() || {}, subtotal);
  appt.status = 'done'; appt.subtotal = subtotal; appt.price = subtotal + Number(tip||0); appt.tip = Number(tip||0);
  appt.taxRate = tax.amount ? tax.rate : 0; appt.taxAmount = tax.amount;
  appt.paymentMethod = 'cash'; appt.paidAt = new Date().toISOString();
  if (cutNotes) appt.cutNotes = cutNotes;
  h.upsert('appointments', appt);
  if (appt.customerId) { const c = h.getById('customers', appt.customerId); if(c){c.loyaltyPoints=(c.loyaltyPoints||0)+1;c.lastJobDate=appt.date;h.upsert('customers',c);} }
  res.json({ ok: true });
}));

// ── Checkout: create card payment session ─────────────────────────────────────
router.post('/api/shop/checkout/session', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  try {
    const { appointmentId, amount, tip } = req.body;
    const s = db.get('settings').value()||{};
    // Tax applies to the service amount only; the customer is charged service + tax + tip.
    const subtotal = Number(amount||0);
    const tax = computeTax(s, subtotal);
    const total = Math.round((subtotal + tax.amount + Number(tip||0)) * 100);
    const accountId = s.stripe?.connectAccountId;
    if (!accountId || !s.stripe?.onboardingComplete) return res.status(400).json({ ok: false, error: 'Stripe not connected. Go to Settings → Deposits & Payments to connect.' });
    const appt = h.getById('appointments', appointmentId);
    if (!appt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
    // Snapshot the amounts now so the record is correct regardless of when the
    // customer completes payment; status flips to 'done' on verify/webhook.
    appt.subtotal = subtotal; appt.price = subtotal + Number(tip||0); appt.tip = Number(tip||0);
    appt.taxRate = tax.amount ? tax.rate : 0; appt.taxAmount = tax.amount;
    h.upsert('appointments', appt);
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
router.get('/api/shop/checkout/verify/:sessionId', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
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
router.post('/api/public/:shopSlug/deposit-session', async (req, res) => {
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
router.get('/booking-deposit-success', async (req, res) => {
  try {
    const session = await getStripe().checkout.sessions.retrieve(req.query.session);
    const m = session?.metadata || {};
    if (session?.payment_status === 'paid' && m.shopId && m.appointmentId) {
      fulfillBookingDeposit(m.shopId, m.appointmentId, session);
    }
  } catch(e) {}
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f7;"><div style="font-size:64px;margin-bottom:20px;">🎉</div><div style="font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px;">You're booked!</div><div style="font-size:15px;color:#6e6e73;line-height:1.6;margin-bottom:24px;">Your deposit was received and your appointment is confirmed.</div><div style="font-size:13px;color:#aeaeb2;">You can close this tab.</div></body></html>`);
});

// ── PUBLIC: Quote deposit session (from the public quote page) ────────────────
router.post('/api/public/:shopSlug/quote-deposit-session', async (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id);
    const s = db.get('settings').value() || {};
    const accountId = s.stripe?.connectAccountId;
    if (!accountId || !s.stripe?.onboardingComplete) return res.status(400).json({ ok: false, error: 'Stripe not connected' });
    const h = shopHelpers(db);
    const q = h.getById('quotes', req.body.quoteId);
    if (!q) return res.status(404).json({ ok: false, error: 'Quote not found' });
    const total = Math.round(Number(q.depositAmount || 0) * 100);
    if (total < 50) return res.status(400).json({ ok: false, error: 'No deposit configured for this estimate' });
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Deposit — ' + (q.number || 'Estimate'), description: s.shopName + ' · approved estimate' }, unit_amount: total }, quantity: 1 }],
      mode: 'payment',
      success_url: APP_URL + '/quote-deposit-success?session={CHECKOUT_SESSION_ID}&quote=' + q.id + '&shop=' + shop.id,
      cancel_url:  APP_URL + '/quote/' + req.params.shopSlug + '/' + q.id + '?deposit=cancelled',
      metadata: { quoteId: q.id, shopId: shop.id },
      payment_intent_data: { transfer_data: { destination: accountId } },
    });
    res.json({ ok: true, url: session.url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/quote-deposit-success', async (req, res) => {
  try {
    const session = await getStripe().checkout.sessions.retrieve(req.query.session);
    const m = session?.metadata || {};
    if (session?.payment_status === 'paid' && m.shopId && m.quoteId) {
      fulfillQuoteDeposit(m.shopId, m.quoteId, session);
    }
  } catch(e) {}
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f7;"><div style="font-size:64px;margin-bottom:20px;">🎉</div><div style="font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px;">Estimate approved!</div><div style="font-size:15px;color:#6e6e73;line-height:1.6;margin-bottom:24px;">Your deposit was received. We'll be in touch to schedule your appointment.</div><div style="font-size:13px;color:#aeaeb2;">You can close this tab.</div></body></html>`);
});

// ── Memberships: subscription checkout (owner enrolls a customer) ─────────────
router.post('/api/shop/customers/:id/membership/checkout', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  try {
    const s = db.get('settings').value() || {};
    const accountId = s.stripe?.connectAccountId;
    if (!accountId || !s.stripe?.onboardingComplete) return res.status(400).json({ ok: false, error: 'Stripe not connected. Connect in Settings → Deposits & Payments.' });
    const c = h.getById('customers', req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Customer not found' });
    const plan = (s.membershipPlans || []).find(p => p.id === req.body.planId);
    if (!plan) return res.status(400).json({ ok: false, error: 'Plan not found' });
    const stripe = getStripe();
    const shopRow = master.get('shops').find({ id: req.shopId }).value();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price_data: { currency: 'usd', product_data: { name: plan.name + ' — ' + (s.shopName || 'Membership') }, unit_amount: Math.round(Number(plan.price) * 100), recurring: { interval: plan.interval === 'year' ? 'year' : 'month' } }, quantity: 1 }],
      subscription_data: { transfer_data: { destination: accountId } },
      success_url: APP_URL + '/membership-success?session={CHECKOUT_SESSION_ID}&cust=' + c.id + '&plan=' + plan.id + '&shop=' + req.shopId,
      cancel_url:  APP_URL + '/shop/' + (shopRow ? shopRow.slug : ''),
      metadata: { customerId: c.id, planId: plan.id, shopId: req.shopId },
    });
    res.json({ ok: true, url: session.url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
}));

router.get('/membership-success', async (req, res) => {
  try {
    const session = await getStripe().checkout.sessions.retrieve(req.query.session);
    const m = session?.metadata || {};
    if ((session?.payment_status === 'paid' || session?.status === 'complete') && m.shopId && m.customerId && m.planId) {
      fulfillMembership(m.shopId, m.customerId, m.planId, session);
    }
  } catch(e) {}
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f7;"><div style="font-size:64px;margin-bottom:20px;">🎉</div><div style="font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px;">Membership active!</div><div style="font-size:15px;color:#6e6e73;line-height:1.6;margin-bottom:24px;">Your plan is set up. Thanks for joining!</div><div style="font-size:13px;color:#aeaeb2;">You can close this tab.</div></body></html>`);
});

// ── Checkout success/cancel pages (redirect back to app) ──────────────────────
router.get('/checkout-success', (req, res) => res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><div style="font-size:48px;margin-bottom:16px;">✅</div><div style="font-size:22px;font-weight:700;margin-bottom:8px;">Payment received!</div><div style="color:#6b7280;margin-bottom:24px;">You can close this tab.</div></body></html>`));
router.get('/checkout-cancel',  (req, res) => res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><div style="font-size:48px;margin-bottom:16px;">↩️</div><div style="font-size:22px;font-weight:700;margin-bottom:8px;">Payment cancelled.</div><div style="color:#6b7280;margin-bottom:24px;">You can close this tab.</div></body></html>`));
module.exports = router;
module.exports.stripeWebhook = stripeWebhook;

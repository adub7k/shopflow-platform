// ── Square public payment + OAuth routes ─────────────────────────────────────
// Booking-deposit flow on Square (hosted Quick Pay checkout) + per-shop OAuth
// "connect your Square account" (the Stripe Connect equivalent). Distinct paths
// so the live Stripe routes are untouched.
//
// Money routing: a shop charges through its OWN Square account once connected via
// OAuth (settings.square.accessToken/locationId). Until then it falls back to the
// platform env token (sandbox/MVP only — NOT correct for real per-shop payouts).
const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { master, getShopDb, shopHelpers, genId, JWT_SECRET } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const sq = require('../payments/square');
const { ensureQuoteCustomer } = require('../quotes-core');

const APP_URL      = process.env.APP_URL || 'https://shopflowio.up.railway.app';
const REDIRECT_URI = APP_URL + '/api/square/oauth/callback';
const APP_ID       = process.env.SQUARE_APPLICATION_ID || '';
const APP_SECRET   = process.env.SQUARE_APPLICATION_SECRET || '';
// OAuth lives on the same host as the API (sandbox vs production), reused from the module.
const OAUTH_BASE   = sq.BASE;
const SCOPES = ['MERCHANT_PROFILE_READ', 'ORDERS_WRITE', 'ORDERS_READ', 'PAYMENTS_WRITE', 'PAYMENTS_READ'];

// ── OAuth helpers ─────────────────────────────────────────────────────────────
// `state` is a short-lived signed token carrying the shopId — survives the round
// trip to Square (the callback is unauthenticated) and is CSRF/tamper-proof.
const signState   = (shopId) => jwt.sign({ shopId, t: 'square-oauth' }, JWT_SECRET, { expiresIn: '15m' });
const verifyState = (token)  => { try { const p = jwt.verify(token, JWT_SECRET); return p.t === 'square-oauth' ? p.shopId : null; } catch (e) { return null; } };

async function tokenRequest(body) {
  const res = await fetch(OAUTH_BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Square-Version': sq.VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: APP_ID, client_secret: APP_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.errors && data.errors[0] && data.errors[0].detail) || 'Square OAuth error ' + res.status); e.squareErrors = data.errors; throw e; }
  return data; // { access_token, refresh_token, merchant_id, expires_at }
}
const exchangeCode    = (code)         => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
const refreshToken    = (refresh_token) => tokenRequest({ grant_type: 'refresh_token', refresh_token });

async function primaryLocation(accessToken) {
  const locs = await sq.listLocations({ accessToken });
  const active = locs.find(l => l.status === 'ACTIVE') || locs[0];
  return active ? { id: active.id, name: active.name } : null;
}

// Resolve a usable Square account for a shop: its own (refreshed if near expiry)
// or the platform env fallback. Returns { accessToken, locationId } or null.
async function resolveSquare(db, s) {
  const c = s.square;
  if (c && c.accessToken && c.locationId) {
    try {
      const soon = c.expiresAt && (Date.parse(c.expiresAt) - Date.now() < 7 * 24 * 3600 * 1000);
      if (c.refreshToken && soon) {
        const r = await refreshToken(c.refreshToken);
        if (r && r.access_token) {
          c.accessToken = r.access_token;
          if (r.refresh_token) c.refreshToken = r.refresh_token;
          if (r.expires_at)    c.expiresAt = r.expires_at;
          db.get('settings').assign({ square: c }).write();
        }
      }
    } catch (e) { /* keep existing token; a real expiry will surface as a payment error */ }
    return { accessToken: c.accessToken, locationId: c.locationId };
  }
  if (sq.enabled()) return { accessToken: undefined, locationId: undefined }; // platform env defaults
  return null;
}
// Sync "is a Square account available for this shop?" — for the public booking gate.
function squareConnected(s) { return !!((s.square && s.square.accessToken && s.square.locationId) || sq.enabled()); }

// pending-deposit → confirmed once the deposit order is verified paid. Idempotent.
function fulfillSquareDeposit(shopId, apptId, amountCents) {
  const db = getShopDb(shopId); const h = shopHelpers(db);
  const appt = h.getById('appointments', apptId);
  // Confirm a pending booking, OR just record the deposit on an already-confirmed
  // appointment (e.g. a deposit link sent from the client profile). Idempotent.
  if (appt && (appt.status === 'pending-deposit' || !appt.depositPaid)) {
    if (appt.status === 'pending-deposit') appt.status = 'confirmed';
    appt.depositPaid = true;
    if (amountCents != null) appt.depositAmount = amountCents / 100;
    h.upsert('appointments', appt);
    return true;
  }
  return false;
}

// ── PER-SHOP OAUTH: connect / status / disconnect ─────────────────────────────
router.get('/api/shop/square/connect/status', requireAuth, async (req, res) => {
  const db = getShopDb(req.shopId); const c = (db.get('settings').value() || {}).square || {};
  res.json({
    connected: !!(c.accessToken && c.locationId),
    merchantId: c.merchantId || null,
    locationName: c.locationName || null,
    platformFallback: !((c.accessToken && c.locationId)) && sq.enabled(), // deposits work, but pay the platform account
  });
});

// Owner clicks "Connect Square" → returns the Square authorize URL to redirect to.
router.post('/api/shop/square/connect/onboard', requireAuth, requireRole('full'), async (req, res) => {
  if (!APP_ID)     return res.status(400).json({ ok: false, error: 'Square Application ID not configured' });
  if (!APP_SECRET) return res.status(400).json({ ok: false, error: 'Square Application Secret not configured (set SQUARE_APPLICATION_SECRET)' });
  // NOTE: omit `session` → defaults to true. Square Sandbox ONLY supports
  // session=true; passing session=false there yields a blank authorize page.
  // In production, true is also the better UX (one-click connect when the seller
  // is already signed into Square, instead of forcing a fresh login).
  const url = OAUTH_BASE + '/oauth2/authorize'
    + '?client_id=' + encodeURIComponent(APP_ID)
    + '&scope=' + encodeURIComponent(SCOPES.join(' '))
    + '&state=' + encodeURIComponent(signState(req.shopId))
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI);
  res.json({ ok: true, url });
});

// Square redirects the owner's browser back here after they approve.
router.get('/api/square/oauth/callback', async (req, res) => {
  const fail = (msg) => res.status(400).send('<html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;"><div style="font-size:48px;">⚠️</div><div style="font-size:18px;font-weight:700;margin:12px 0;">Could not connect Square</div><div style="color:#6b7280;">' + msg + '</div></body></html>');
  try {
    if (req.query.error) return fail('Authorization was declined.');
    const shopId = verifyState(req.query.state);
    if (!shopId || !req.query.code) return fail('Invalid or expired connection link. Please try again.');
    const shop = master.get('shops').find({ id: shopId }).value();
    if (!shop) return fail('Shop not found.');

    const tok = await exchangeCode(req.query.code);
    const loc = await primaryLocation(tok.access_token);
    if (!loc) return fail('No active Square location found on that account.');

    const db = getShopDb(shopId);
    db.get('settings').assign({ square: {
      accessToken: tok.access_token, refreshToken: tok.refresh_token || null,
      merchantId: tok.merchant_id || null, expiresAt: tok.expires_at || null,
      locationId: loc.id, locationName: loc.name, connectedAt: new Date().toISOString(),
    } }).write();

    // Back into the shop's app.
    res.redirect('/shop/' + shop.slug + '?square=connected');
  } catch (e) {
    console.error('Square OAuth callback error:', e.message);
    fail('Something went wrong connecting your account. Please try again.');
  }
});

router.post('/api/shop/square/connect/disconnect', requireAuth, requireRole('full'), async (req, res) => {
  const db = getShopDb(req.shopId);
  db.get('settings').unset('square').write();
  res.json({ ok: true });
});

// ── PUBLIC: create a Square hosted-checkout deposit for a pending booking ──────
router.post('/api/public/:shopSlug/square-deposit-session', async (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id); const s = db.get('settings').value() || {}; const h = shopHelpers(db);
    const creds = await resolveSquare(db, s);
    if (!creds) return res.status(400).json({ ok: false, error: 'Square not connected' });
    const { appointmentId, amount } = req.body;
    const appt = h.getById('appointments', appointmentId);
    if (!appt) return res.status(404).json({ ok: false, error: 'Appointment not found' });

    const amountCents = Math.round(Number(amount || s.deposit?.amount || 10) * 100);
    const link = await sq.createPaymentLink({
      name: 'Deposit — ' + (appt.service || 'Appointment'),
      description: (s.shopName || '') + ' · ' + appt.date + ' at ' + appt.time,
      amountCents,
      redirectUrl: APP_URL + '/sq/booking-deposit-success?appt=' + appointmentId + '&shop=' + shop.id,
      // Key by appointment + amount so re-sending the same amount is idempotent,
      // but a different amount (owner-chosen from the profile) creates a fresh link.
      idempotencyKey: 'dep-' + appointmentId + '-' + amountCents,
      accessToken: creds.accessToken, locationId: creds.locationId,
    });
    appt.squareOrderId = link.orderId; appt.squarePaymentLinkId = link.id; appt.depositAmount = amountCents / 100;
    h.upsert('appointments', appt);
    res.json({ ok: true, url: link.url });
  } catch (e) {
    console.error('Square deposit-session error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUBLIC: deposit success — verify the Square order is paid, then confirm ────
router.get('/sq/booking-deposit-success', async (req, res) => {
  try {
    const shopId = req.query.shop, apptId = req.query.appt;
    if (shopId && apptId) {
      const db = getShopDb(shopId); const h = shopHelpers(db); const s = db.get('settings').value() || {};
      const appt = h.getById('appointments', apptId);
      const creds = (await resolveSquare(db, s)) || {};
      if (appt && appt.squareOrderId && await sq.isOrderPaid(appt.squareOrderId, { accessToken: creds.accessToken })) {
        fulfillSquareDeposit(shopId, apptId, Math.round(Number(appt.depositAmount || 0) * 100));
      }
    }
  } catch (e) { /* best-effort; a webhook will be the authoritative path later */ }
  res.send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f7;"><div style="font-size:64px;margin-bottom:20px;">🎉</div><div style="font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px;">You\'re booked!</div><div style="font-size:15px;color:#6e6e73;line-height:1.6;margin-bottom:24px;">Your deposit was received and your appointment is confirmed.</div><div style="font-size:13px;color:#aeaeb2;">You can close this tab.</div></body></html>');
});

// ── PUBLIC: customer deposit (NOT tied to an appointment) ──────────────────────
// Builds a Square checkout link for an owner-chosen amount and records it on the
// client (deposits[] + a notes-log entry). The paid status is logged on the
// client when they return from the success redirect.
router.post('/api/shop/square/customer-deposit', requireAuth, requireRole('full','technician'), async (req, res) => {
  try {
    // Owner/tech-only: derive the shop from the auth token, never from a URL slug,
    // so nobody can spam deposit links / note entries onto another shop's clients.
    const shop = master.get('shops').find({ id: req.shopId, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id); const s = db.get('settings').value() || {}; const h = shopHelpers(db);
    const creds = await resolveSquare(db, s);
    if (!creds) return res.status(400).json({ ok: false, error: 'Square not connected' });
    const cust = h.getById('customers', req.body.customerId);
    if (!cust) return res.status(404).json({ ok: false, error: 'Client not found' });
    const amountCents = Math.round(Number(req.body.amount || s.deposit?.amount || 10) * 100);
    if (amountCents < 100) return res.status(400).json({ ok: false, error: 'Deposit must be at least $1' });
    const depId = genId('dep');
    const link = await sq.createPaymentLink({
      name: 'Deposit — ' + (s.shopName || 'Detail'),
      description: (s.shopName || '') + ' deposit',
      amountCents,
      redirectUrl: APP_URL + '/sq/customer-deposit-success?cust=' + req.body.customerId + '&shop=' + shop.id + '&dep=' + depId,
      idempotencyKey: 'cdep-' + depId,
      accessToken: creds.accessToken, locationId: creds.locationId,
    });
    const amt = amountCents / 100, now = new Date().toISOString();
    cust.deposits = cust.deposits || [];
    cust.deposits.push({ id: depId, amount: amt, orderId: link.orderId, paymentLinkId: link.id, status: 'sent', sentAt: now });
    cust.noteLog = cust.noteLog || [];
    cust.noteLog.unshift({ id: genId('note'), scope: 'customer', text: '💳 Sent a $' + amt + ' deposit link', at: now, by: 'Deposit' });
    h.upsert('customers', cust);
    res.json({ ok: true, url: link.url, depositId: depId });
  } catch (e) {
    console.error('Square customer-deposit error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUBLIC: customer-deposit success — verify paid, then note it on the client ──
router.get('/sq/customer-deposit-success', async (req, res) => {
  try {
    const shopId = req.query.shop, custId = req.query.cust, depId = req.query.dep;
    if (shopId && custId && depId) {
      const db = getShopDb(shopId); const h = shopHelpers(db); const s = db.get('settings').value() || {};
      const cust = h.getById('customers', custId);
      const dep = cust && (cust.deposits || []).find(d => d.id === depId);
      const creds = (await resolveSquare(db, s)) || {};
      if (dep && dep.status !== 'paid' && dep.orderId && await sq.isOrderPaid(dep.orderId, { accessToken: creds.accessToken })) {
        dep.status = 'paid'; dep.paidAt = new Date().toISOString();
        cust.noteLog = cust.noteLog || [];
        cust.noteLog.unshift({ id: genId('note'), scope: 'customer', text: '💳 $' + dep.amount + ' deposit paid', at: dep.paidAt, by: 'Deposit' });
        h.upsert('customers', cust);
      }
    }
  } catch (e) { /* best-effort; redirect-based until a webhook lands */ }
  res.send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f7;"><div style="font-size:64px;margin-bottom:20px;">✅</div><div style="font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px;">Deposit received!</div><div style="font-size:15px;color:#6e6e73;line-height:1.6;margin-bottom:24px;">Thanks — your deposit was received. We\'ll see you soon.</div><div style="font-size:13px;color:#aeaeb2;">You can close this tab.</div></body></html>');
});

// ── PUBLIC: quote/estimate deposit via Square (Approve & pay on /quote page) ──
// Same hosted-checkout pattern as booking deposits: create a Quick Pay link,
// remember the order id on the quote, verify paid on the redirect return.
function fulfillSquareQuoteDeposit(h, q) {
  if (q.depositPaid) return false; // idempotent — redirect + reconcile may both fire
  q.depositPaid = true; q.depositPaidAt = new Date().toISOString();
  if (q.status !== 'approved' && q.status !== 'scheduled') { q.status = 'approved'; q.approvedAt = q.depositPaidAt; }
  h.upsert('quotes', q);
  try { ensureQuoteCustomer(h, q); } catch (e) {} // approved = real client in the CRM
  return true;
}
// Called from the public quote GET too, so a missed redirect (closed tab)
// self-heals the next time anyone opens the estimate. Best-effort by design.
async function reconcileSquareQuoteDeposit(db, s, h, q) {
  if (!q || q.depositPaid || !q.squareOrderId) return false;
  const creds = (await resolveSquare(db, s)) || {};
  if (await sq.isOrderPaid(q.squareOrderId, { accessToken: creds.accessToken })) return fulfillSquareQuoteDeposit(h, q);
  return false;
}

router.post('/api/public/:shopSlug/square-quote-deposit-session', async (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id); const s = db.get('settings').value() || {}; const h = shopHelpers(db);
    const creds = await resolveSquare(db, s);
    if (!creds) return res.status(400).json({ ok: false, error: 'Square not connected' });
    const q = h.getById('quotes', req.body.quoteId);
    if (!q) return res.status(404).json({ ok: false, error: 'Quote not found' });
    if (q.status === 'declined') return res.status(400).json({ ok: false, error: 'This estimate was declined.' });
    const amountCents = Math.round(Number(q.depositAmount || 0) * 100);
    if (amountCents < 100) return res.status(400).json({ ok: false, error: 'No deposit configured for this estimate' });
    const link = await sq.createPaymentLink({
      name: 'Deposit — ' + (q.number || 'Estimate'),
      description: (s.shopName || '') + ' · approved estimate',
      amountCents,
      redirectUrl: APP_URL + '/sq/quote-deposit-success?quote=' + q.id + '&shop=' + shop.id,
      idempotencyKey: 'qdep-' + q.id + '-' + amountCents,
      accessToken: creds.accessToken, locationId: creds.locationId,
    });
    q.squareOrderId = link.orderId; q.squarePaymentLinkId = link.id;
    h.upsert('quotes', q);
    res.json({ ok: true, url: link.url });
  } catch (e) {
    console.error('Square quote-deposit-session error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Verify paid, flip the quote, then land the customer back on the estimate
// itself — it renders the APPROVED stamp + "deposit received" note in the
// stationery design (nicer than a generic success page).
router.get('/sq/quote-deposit-success', async (req, res) => {
  let slug = '', quoteId = String(req.query.quote || '');
  try {
    const shopId = req.query.shop;
    const shop = master.get('shops').find({ id: shopId }).value();
    slug = shop ? shop.slug : '';
    if (shop && quoteId) {
      const db = getShopDb(shopId); const h = shopHelpers(db); const s = db.get('settings').value() || {};
      await reconcileSquareQuoteDeposit(db, s, h, h.getById('quotes', quoteId));
    }
  } catch (e) { /* best-effort; the public quote GET reconciles as a backstop */ }
  if (slug && quoteId) return res.redirect('/quote/' + slug + '/' + quoteId);
  res.send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f7;"><div style="font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px;">Deposit received</div><div style="font-size:15px;color:#6e6e73;line-height:1.6;">Thanks — your estimate is approved. You can close this tab.</div></body></html>');
});

// ── AUTHED: reconcile a client's pending deposits against Square ───────────────
// The success redirect can be missed (closed tab / PUBLIC_URL mismatch), so the
// owner app calls this when opening a profile: ask Square whether each "sent"
// deposit is actually paid, and if so flip it + drop the "paid" note. No webhook
// needed; this is the authoritative catch-up.
router.post('/api/shop/square/reconcile-deposits', requireAuth, async (req, res) => {
  try {
    const db = getShopDb(req.shopId); const s = db.get('settings').value() || {}; const h = shopHelpers(db);
    const cust = h.getById('customers', req.body.customerId);
    if (!cust) return res.status(404).json({ ok: false, error: 'Client not found' });
    const pending = (cust.deposits || []).filter(d => d.status === 'sent' && d.orderId);
    if (!pending.length) return res.json({ ok: true, updated: 0, customer: cust });
    const creds = (await resolveSquare(db, s)) || {};
    let updated = 0;
    for (const dep of pending) {
      if (await sq.isOrderPaid(dep.orderId, { accessToken: creds.accessToken })) {
        dep.status = 'paid'; dep.paidAt = new Date().toISOString();
        cust.noteLog = cust.noteLog || [];
        cust.noteLog.unshift({ id: genId('note'), scope: 'customer', text: '💳 $' + dep.amount + ' deposit paid', at: dep.paidAt, by: 'Deposit' });
        updated++;
      }
    }
    if (updated) h.upsert('customers', cust);
    res.json({ ok: true, updated, customer: cust });
  } catch (e) {
    console.error('reconcile-deposits error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.squareConnected = squareConnected;
module.exports.reconcileSquareQuoteDeposit = reconcileSquareQuoteDeposit;

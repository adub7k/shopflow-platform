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
const { master, getShopDb, shopHelpers, JWT_SECRET } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const sq = require('../payments/square');

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
  if (appt && appt.status === 'pending-deposit') {
    appt.status = 'confirmed'; appt.depositPaid = true;
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
      idempotencyKey: 'dep-' + appointmentId,
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

module.exports = router;
module.exports.squareConnected = squareConnected;

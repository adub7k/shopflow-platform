// ── Square public payment routes ─────────────────────────────────────────────
// Booking-deposit flow on Square (hosted Quick Pay checkout) — the equivalent of
// the Stripe deposit-session, on distinct paths so the live Stripe routes are
// untouched. The booking page (book.html) calls the endpoint that matches the
// shop's payment provider (public.js /info returns `depositProvider`).
//
// Money routing: today this uses the shop's own Square account when present
// (s.square.accessToken/locationId — set later by Square OAuth) and otherwise
// falls back to the platform env token (good for sandbox/MVP, NOT for real
// per-shop payouts — OAuth is required before production multi-tenant use).
const router = require('express').Router();
const { master, getShopDb, shopHelpers } = require('../db');
const sq = require('../payments/square');

const APP_URL = process.env.APP_URL || 'https://shopflowio.up.railway.app';

// Resolve which Square account a shop charges through. null = not configured.
function shopSquare(s) {
  if (s && s.square && s.square.accessToken && s.square.locationId)
    return { accessToken: s.square.accessToken, locationId: s.square.locationId };
  if (sq.enabled()) return { accessToken: undefined, locationId: undefined }; // module uses env defaults
  return null;
}
// Exposed so public.js can gate the deposit UI on "Square available for this shop".
function squareConnected(s) { return !!shopSquare(s); }

// pending-deposit → confirmed once the deposit order is verified paid. Idempotent.
function fulfillSquareDeposit(shopId, apptId, amountCents) {
  const db = getShopDb(shopId); const h = shopHelpers(db);
  const appt = h.getById('appointments', apptId);
  if (appt && appt.status === 'pending-deposit') {
    appt.status = 'confirmed';
    appt.depositPaid = true;
    if (amountCents != null) appt.depositAmount = amountCents / 100;
    h.upsert('appointments', appt);
    return true;
  }
  return false;
}

// ── PUBLIC: create a Square hosted-checkout deposit for a pending booking ──────
router.post('/api/public/:shopSlug/square-deposit-session', async (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
    const db = getShopDb(shop.id); const s = db.get('settings').value() || {}; const h = shopHelpers(db);
    const creds = shopSquare(s);
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
    // Store the order id on the appointment — the success route verifies payment
    // against THIS order (not a forgeable query param), so it can't be replayed.
    appt.squareOrderId = link.orderId;
    appt.squarePaymentLinkId = link.id;
    appt.depositAmount = amountCents / 100;
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
      const creds = shopSquare(s) || {};
      if (appt && appt.squareOrderId && await sq.isOrderPaid(appt.squareOrderId, { accessToken: creds.accessToken })) {
        fulfillSquareDeposit(shopId, apptId, Math.round(Number(appt.depositAmount || 0) * 100));
      }
    }
  } catch (e) { /* best-effort; a webhook will be the authoritative path later */ }
  res.send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f7;"><div style="font-size:64px;margin-bottom:20px;">🎉</div><div style="font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px;">You\'re booked!</div><div style="font-size:15px;color:#6e6e73;line-height:1.6;margin-bottom:24px;">Your deposit was received and your appointment is confirmed.</div><div style="font-size:13px;color:#aeaeb2;">You can close this tab.</div></body></html>');
});

module.exports = router;
module.exports.squareConnected = squareConnected;
module.exports.shopSquare = shopSquare;

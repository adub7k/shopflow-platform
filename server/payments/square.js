// ── Square payments ──────────────────────────────────────────────────────────
// Thin REST wrapper over the Square API (no SDK dependency — Node's global fetch
// is enough and avoids SDK version churn). Drives hosted checkout (Quick Pay
// payment links), the 1:1 replacement for the Stripe Checkout redirect flow used
// by booking/quote deposits and in-shop card payments.
//
// Config comes entirely from env so nothing secret lives in the repo:
//   SQUARE_ACCESS_TOKEN     — sandbox or production access token
//   SQUARE_LOCATION_ID      — which location takes the payment
//   SQUARE_APPLICATION_ID   — used client-side (Web Payments SDK), if/when needed
//   SQUARE_ENVIRONMENT      — 'sandbox' (default) | 'production'
//   SQUARE_VERSION          — Square-Version header (pinned API version)
//
// Multi-tenant note: today this uses ONE account (the platform/sandbox token).
// The per-shop "connect your own Square account" model (Stripe Connect's
// equivalent) is Square OAuth — added next, once the OAuth Application Secret is
// available. createPaymentLink() already accepts a per-shop {accessToken,
// locationId} override so the OAuth layer can slot in without changing callers.

const ENV     = process.env.SQUARE_ENVIRONMENT || 'sandbox';
const BASE    = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
const VERSION = process.env.SQUARE_VERSION || '2025-01-23';
const TOKEN   = process.env.SQUARE_ACCESS_TOKEN || '';
const LOCATION_ID    = process.env.SQUARE_LOCATION_ID || '';
const APPLICATION_ID = process.env.SQUARE_APPLICATION_ID || '';

// Square is "configured" when we at least have a token + location to charge.
function enabled() { return !!TOKEN && !!LOCATION_ID; }

// Low-level call. Throws an Error carrying Square's error detail + http status.
async function sq(path, { method = 'GET', body, accessToken } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Square-Version': VERSION,
      'Authorization': 'Bearer ' + (accessToken || TOKEN),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].code);
    const err = new Error(detail || ('Square API error ' + res.status));
    err.status = res.status; err.squareErrors = data.errors;
    throw err;
  }
  return data;
}

const genIdem = () => 'sf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

// Create a hosted checkout (Quick Pay). Returns { id, url, orderId, longUrl }.
// Store orderId on the appointment/quote — that's how we verify payment on return
// (the same role the Stripe checkout-session id played).
async function createPaymentLink({ name, amountCents, redirectUrl, idempotencyKey, accessToken, locationId, description }) {
  const body = {
    idempotency_key: idempotencyKey || genIdem(),
    quick_pay: {
      name: String(name || 'Payment').slice(0, 255),
      price_money: { amount: Math.round(Number(amountCents) || 0), currency: 'USD' },
      location_id: locationId || LOCATION_ID,
    },
  };
  if (redirectUrl)  body.checkout_options = { redirect_url: redirectUrl };
  if (description)  body.description = String(description).slice(0, 250);
  const data = await sq('/v2/online-checkout/payment-links', { method: 'POST', body, accessToken });
  const pl = data.payment_link || {};
  return { id: pl.id, url: pl.url, orderId: pl.order_id, longUrl: pl.long_url };
}

async function retrieveOrder(orderId, { accessToken } = {}) {
  const data = await sq('/v2/orders/' + orderId, { accessToken });
  return data.order;
}

// Has this order been paid? Square marks the order COMPLETED once fully paid; a
// present tender is the belt-and-suspenders signal for the redirect-return check.
async function isOrderPaid(orderId, opts = {}) {
  try {
    const o = await retrieveOrder(orderId, opts);
    return !!o && (o.state === 'COMPLETED' || (Array.isArray(o.tenders) && o.tenders.length > 0));
  } catch (e) { return false; }
}

async function listLocations({ accessToken } = {}) {
  const data = await sq('/v2/locations', { accessToken });
  return data.locations || [];
}

module.exports = {
  enabled, ENV, BASE, VERSION, LOCATION_ID, APPLICATION_ID,
  createPaymentLink, retrieveOrder, isOrderPaid, listLocations, _request: sq,
};

# Stripe → Square migration

**Branch:** `feature/square-payments` · **Status:** foundation built + sandbox-verified.
**Why now:** no real payments are flowing through Stripe yet, so this is a clean cutover
(no in-flight transactions, no live subscriptions to migrate, no dual-running).

## ✅ Done + tested (this session)
- **`server/payments/square.js`** — REST wrapper (no SDK dep; uses global `fetch`). Env-driven config.
  - `createPaymentLink()` — hosted Quick Pay checkout → `{ id, url, orderId }`. The 1:1 replacement
    for Stripe Checkout-session redirects (deposits + in-shop card).
  - `retrieveOrder()` / `isOrderPaid()` — verify payment on redirect return (replaces Stripe verify).
  - Per-shop `accessToken`/`locationId` overrides already plumbed for the OAuth (multi-tenant) phase.
- **Sandbox verified:** token valid; location `L127NE4KPAR8F` (Default Test Account, USD); created live
  sandbox payment links through both curl and the module; order retrieval + paid-state checks work.

## Env vars (gitignored — never committed)
```
SQUARE_ENVIRONMENT=sandbox        # → production at cutover
SQUARE_ACCESS_TOKEN=...           # sandbox token now; production token at the end
SQUARE_LOCATION_ID=L127NE4KPAR8F
SQUARE_APPLICATION_ID=sandbox-sq0idb-...   # client-side (Web Payments SDK / OAuth)
SQUARE_VERSION=2025-01-23
# Added in later phases:
SQUARE_APPLICATION_SECRET=...     # OAuth (per-shop connect)
SQUARE_WEBHOOK_SIGNATURE_KEY=...  # webhook verification
SQUARE_OAUTH_REDIRECT_URL=https://<domain>/api/square/oauth/callback
```

## Cutover map (Stripe flow → Square)
| Stripe flow (in `routes/stripe.js`) | Square approach | Status |
|---|---|---|
| Booking deposit (`/public/:slug/deposit-session`) | `createPaymentLink` + return-url verify | module ready · route TODO |
| Quote deposit (`/public/:slug/quote-deposit-session`) | same | module ready · route TODO |
| In-shop card (`/shop/checkout/session` + `/verify`) | same (hosted) or Web Payments SDK | module ready · route TODO |
| Cash checkout | unchanged | ✅ no change |
| Memberships (Stripe Subscriptions) | Square **Subscriptions** (Catalog plan + customer + card-on-file) | TODO (needs design) |
| Merchant onboarding (Stripe **Connect**) | Square **OAuth** (per-shop token) | TODO · needs App Secret |
| Webhook (`stripeWebhook`) | Square webhook (HMAC-SHA256) | TODO · needs Signature Key |
| Signup billing gate (`auth.js` verifies Stripe session) | verify a Square payment | TODO |
| Frontend (`book.html`, `appointments.js`, `client-profile.js`, `settings.js`) | point at Square endpoints | TODO |
| Remove Stripe (dep, env, `stripe.js`) | delete after all flows cut over | TODO (last) |

## Recommended next-session order
1. **Wire deposits + in-shop checkout** to `square.js` (keep the `{url}` response shape so the frontend
   barely changes); handle Square's redirect-return params; test the full pay cycle with a sandbox test card.
2. **Square OAuth** for per-shop connect (needs `SQUARE_APPLICATION_SECRET` + redirect URL).
3. **Webhooks** (needs `SQUARE_WEBHOOK_SIGNATURE_KEY`).
4. **Memberships** → Square Subscriptions.
5. **Signup billing gate** → Square.
6. **Remove Stripe** entirely; swap env in Railway; flip `SQUARE_ENVIRONMENT=production`.

## Still needed from you (Square Developer dashboard)
- **OAuth → Application Secret** (+ set the Redirect URL) — for per-shop "connect your Square account".
- **Webhooks → Signature Key** (after adding the prod/sandbox endpoint).
- **Production access token** — only at the very end, after sandbox sign-off.

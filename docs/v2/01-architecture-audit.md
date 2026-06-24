# 01 — Current Architecture Audit & Scalability Bottlenecks

Source: full read of `shopflow-platform` `server/**` and `client/**` (2026-06-23).

## A. Stack

- **Backend:** Node + Express. Data = **lowdb 1.0 (`FileSync`)**, one JSON file per tenant.
- **Frontend:** vanilla JS SPA, **no build step**, CDN-free. Script tags loaded in order; per-page modules.
- **Integrations:** Stripe (Connect, deposits, memberships, webhooks), Twilio (inbound call tracking,
  missed-call SMS, voicemail), Nodemailer (SMTP). JWT auth (`jsonwebtoken`), bcrypt.
- **Deploy:** Railway, `Procfile`/`railway.json`, persistent volume mounted at `/data`.

## B. Multi-tenancy model

- **Master DB:** `/data/master.json` — collections: `shops[]`, `accounts[]`, `usedSessions[]`,
  `platformSettings`, `demos[]`, `sales`.
- **Per-shop DB:** `/data/shops/{shopId}/shopflow.json`, lazily loaded per request via `getShopDb(shopId)`.
- **Uploads:** `/data/uploads/{shopId}/...` (kept out of the DB folder so static serving can't leak `shopflow.json`).
- **Isolation:** `shopRoute(fn)` loads the DB for `req.shopId` (set from the JWT by `requireAuth`); handlers
  only ever see one tenant. Cross-tenant reads exist solely in admin routes (`requireAdmin`, separate key).

### Per-shop collections (the core data model)
`settings` (one object), `barbers[]` (staff), `services[]`, `customers[]`, `appointments[]`,
`conversations[]` (SMS), `reviews[]`, `leads[]` (call-tracking), `calls[]`, `quotes[]` (estimates),
`expenses[]`, `blockedDates[]`.

Notable embedded data already present for verticals:
- `customers[].vehicles[]` `{year, make, model, color}`, `customers[].isFleet`, `customers[].companyName`
- `appointments[].customFields` (per-industry, e.g. vehicle fields), `.vehicleSize`, `.beforePhotos[]`, `.afterPhotos[]`
- `services[].sizePricing` `{sedan,suv,truck}` for size-based pricing

## C. Industry profile system (the keystone for V2)

`server/industries.js` → `INDUSTRIES` map, `resolveProfile(industry)` with `DEFAULT_INDUSTRY='barbershop'`.
A profile controls: `label`, `vocab`, default `services`, `statuses` (with semantic flags
`confirmed`/`terminal`/`noShow`/`occupiesSlot`), `customFields`, `vehicleSizes`, `supportsFleet`,
`supportsQuotes`, `deposit`, `staffPicker`, `inspoDefault`, `serviceCategories`.

**Currently defined:** `barbershop`, `detail`, `nails`.

**How it's consumed:**
- **Signup** (`auth.js` `initShopDb`) copies profile defaults into the new shop's `settings`.
- **Status semantics** are read by name flags (`terminalStatusKey()`, `confirmedStatusKey()`,
  `noShowStatusKey()`), so revenue/loyalty/reminder logic is vertical-agnostic.
- **Frontend** loads `settings` at boot into a global `Shop` object; `V(key, fallback)` relabels UI text;
  custom fields/sizes/statuses render dynamically.

**Implication:** new verticals = new profile blocks. The plumbing already exists.

## D. Auth

JWT payload: `{ shopId, accountId, email, shopSlug, role }`, 30-day expiry, `JWT_SECRET`.
Roles: `full` (owner), `technician`, `viewonly`. `requireAuth` → `requireRole(...)` → `shopRoute`.
Admin via `x-admin-key` (`ADMIN_KEY`). Frontend `ROLE_PAGES` (`app.js`) gates nav by role.

## E. Comms / AI-receptionist foundation (`server/routes/twilio.js`)

Full inbound flow already built: `voice/:shopId` (log lead + call, dial shop with caller-id rewrite,
whisper) → `whisper` (staff presses key to accept) → `screen` (bridge, set `accepted:true`) →
`complete` (detect missed, fire **idempotent** missed-call auto-SMS, offer voicemail) → `voicemail`
(record, attach `{recordingSid,durationSec,recordedAt}` to call + lead). `upsertLeadFromCall()` dedupes
by phone digits. Voicemail streamed back via `/api/shop/voicemail/:callId` (creds stay server-side).

**Already there:** lead auto-creation, missed-call text-back, voicemail, lead→customer convert, call log.
**Not there (V2 scope):** call recording capture of live calls, transcription, **AI summary / lead-quality
scoring / structured intake** (service needed, budget, desired date), AI-spoken answering.

## F. Scheduler / automations (`server/scheduler.js`)

`setInterval` every 5 min (first run +30s), loops active shops. Two jobs, both with dedup + pruning:
**24h appointment reminders** (`remindersSent[]`) and **21-day rebook nudges** (`nudgesSent[]`,
`rebookInterval` configurable). Timezone-aware via `settings.timezone`. SMS templated via `buildSms()`
with `SMS_DEFAULTS`. **Hardcoded** to two campaigns — no general campaign/retention engine yet (V2 scope).

## G. Billing (`server/routes/stripe.js`)

Stripe Connect (Express), booking + quote deposits, in-shop cash/card checkout, **recurring memberships**
(subscriptions synced via webhook), idempotent webhook fulfillment. `GET /api/shop/revenue` computes a full
**P&L**: revenue, COGS (from `appointment.cost` snapshots), gross margin, operating expenses (one-off +
recurring), net profit, plus by-service / by-staff / by-month breakdowns and membership MRR. Estimates &
invoices live in-app (not pushed to Stripe as Stripe Invoices).

## H. Frontend shape

`app.html` = thin shell + static sidebar (`nav-item[data-page]`) → `App.nav(page)` SPA router (no URL state).
Pages in `client/js/pages/*` (dashboard, messages, appointments, leads, clients, quotes, revenue, reviews,
automations, settings). Global `Shop` object + `V()` vocab. CSS = one `app.css` with design tokens
(`:root` variables) + BEM-ish classes; 640px mobile breakpoint, drawer sidebar + bottom nav.

## I. Scalability bottlenecks (ranked)

**Critical**
1. **lowdb `FileSync` synchronous writes** — every mutation rewrites the whole tenant file synchronously.
   Fine per-shop; the scheduler's O(shops) sequential loop + whole-file writes is the first wall (~hundreds–1k shops).
2. **Whole-collection scans in memory** — `getAll(col)` loads the entire array then filters; revenue/calendar
   recompute over all rows. No indexes, no pagination.
3. **Master DB is one file** — every signup/shop update rewrites all of `master.json`.

**Medium**
4. **No pagination** on `customers`/`appointments`/`conversations` list endpoints.
5. **Voicemail re-fetched from Twilio** on every play (no cache/CDN).
6. **Uploads served off the app server** (no CDN), full-size images.
7. **No structured logging / metrics / request tracing.**

**Low**
8. **Lazy backfills** re-run per request (cheap but repeated); a one-time startup migration is cleaner.
9. **Monolithic HTML** (`admin.html` ~114 KB, `sales.html` ~93 KB) with duplicated inline CSS/auth.
10. **No code-splitting/lazy-loading** of page modules (all parsed at boot).

### V2 stance on bottlenecks
V2 keeps lowdb for now (changing the datastore is **out of scope** for the deploy-to-same-Railway,
no-data-loss constraint and would be the highest-risk change). V2 instead: (a) adds a **storage
abstraction seam** (`server/store/`) so a future Postgres swap is mechanical, (b) introduces
**pagination + indexed lookups by id** where cheap, (c) replaces hardcoded scheduler jobs with a
**campaign engine**, and (d) addresses the monolith/UX issues via the navigation redesign. Datastore
migration is documented as a **Phase 5+ / post-V2** track, gated behind a dual-write/backfill plan.

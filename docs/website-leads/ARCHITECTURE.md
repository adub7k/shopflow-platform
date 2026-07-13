# ShopFlow — Customer Acquisition Platform Architecture

## The system

```
Meta / Google Ads (UTMs on ad URLs)
        │
        ▼
┌─────────────────────────┐     one Next.js template, one deploy per client
│  Landing Site (Next.js) │     branding/pricing/reviews from config/tenant.json
│  · multi-step form      │     or live from ShopFlow site-config API
│  · attribution capture  │
│  · /api/leads proxy     │──── env: SHOPFLOW_API_URL / API_KEY / TENANT_ID
└───────────┬─────────────┘     (key never reaches the browser)
            │ POST lead + attribution + score
            ▼
┌───────────────────────────────────────────────────────┐
│  ShopFlow (Express + lowdb, per-tenant DBs)            │
│                                                        │
│  website-leads.router.js                               │
│  · per-tenant API key auth (timing-safe)               │
│  · lead intake → NEW_LEAD → SMS/email owner alert      │
│  · Response Center: queue, age timers, assignment,     │
│    contact log, response_time_seconds, appointments    │
│                                                        │
│  platform.router.js                                    │
│  · site-config: public GET (feeds sites),              │
│    owner PUT (admin settings screen)                   │
│  · website API key issue/list/revoke                   │
│  · ad-spend + marketing-analytics (CPL, ROAS,          │
│    close rate by source/campaign)                      │
│  · upsells, customers, LTV, service history            │
│                                                        │
│  automations.js                                        │
│  · event queue in lowdb, 60s tick, per-tenant          │
│  · speed-to-lead nudge · follow-up · appt reminder     │
│  · review request · upsell offer · maintenance/retain  │
│  · cancel conditions so automations never annoy        │
└───────────────────────────────────────────────────────┘
```

## Multi-tenant model

Everything is keyed by `tenant_id` and lives in that shop's lowdb file — leads,
settings, keys, spend, customers, automation queue. Adding a client:

1. Create shop in ShopFlow (existing flow) → per-tenant db exists
2. `POST /api/website-keys` → get `sfw_…` key
3. Copy the site template, edit `config/tenant.json` (or point
   `SHOPFLOW_SETTINGS_URL` at ShopFlow for live settings), set 3 env vars, deploy
4. Set the Meta ad URL params — attribution and CPL start flowing on day one

Separate branding ✓ leads ✓ analytics ✓ CRM connection ✓ settings ✓ keys ✓

## Admin settings

`PUT /api/site-config` accepts only whitelisted fields (brand, stats, pricing,
services, reviews, gallery, calendar_availability) — a settings write can never
touch leads or keys. The public `GET /api/site-config` returns the same
whitelist, cached 5 min. In live-settings mode the shop owner edits their site
from inside ShopFlow with zero redeploys.

## Marketing tracking

Source inference: utm_source → fbclid=facebook → gclid=google → referrer
(meta-organic / google-organic / referral) → direct. Campaign/ad set/ad name
from utm_campaign/term/content. `POST /api/ad-spend` + lead attribution →
`GET /api/marketing-analytics` returns per-campaign CPL, cost-per-appointment,
revenue (jobs + accepted upsells), and ROAS. That's the number that keeps a
client paying: "your $300 of ads made $1,468."

## Upsells + LTV

Every lead carries `upsells[]`. `GET /leads/:id/upsell-suggestions` proposes
coating/PPF/detail for tint buyers at the tenant's own pricing. On COMPLETED,
the lead rolls into `customers` keyed by phone — repeat business accumulates in
`service_history[]` and `lifetime_value`. Accepted upsells count toward LTV and
campaign revenue.

## Automation engine

Rules are data (`RULES` in automations.js): event → jobs with run times and
cancel conditions. Adding a retention campaign = adding one entry. Templates
are per-tenant overridable via `site_settings.automation_templates`. Jobs
persist in lowdb, so restarts lose nothing; the tick is idempotent per job.

Customer-facing SMS rides the same A2P 10DLC registration as the rest of
ShopFlow messaging — until the LLC brand/campaign is approved, only owner
alerts should fire (pass `sendSms` for owner, omit customer sends).

## Security

- API keys: server-side env only, timing-safe compare, issue/revoke via admin
  API, listed as label+last4 only
- Admin routes behind existing ShopFlow JWT (`requireOwner`)
- Whitelist validation on every write; honeypot + rate limit on the site proxy
- Public site-config endpoint exposes only display fields

## Scaling path (in order of when it actually matters)

1. **Now (1–20 shops):** everything above works as-is on Railway.
2. **Photos:** move base64 → object storage (Cloudinary/S3) first — it's the
   thing that bloats lowdb soonest.
3. **lowdb → SQLite/Postgres:** when any single shop passes ~5k leads or you
   need concurrent writes. The routers only touch `db.data.*` through simple
   reads/pushes — swapping the storage layer doesn't change endpoints.
4. **Automation tick → real queue (BullMQ/Redis):** when tick volume or
   multi-instance deploys demand it. The `emit`/`RULES` interface stays.
5. **Site deploys:** template repo + per-client env vars scales to dozens;
   past that, one multi-tenant site resolving tenant by domain
   (`SHOPFLOW_SETTINGS_URL` mode already supports the data side).

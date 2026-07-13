# ShopFlow Integration — Parts 2 & 3

## Flow
Visitor → Estimate form → site `/api/leads` (Next.js, server-side) → ShopFlow `POST /api/leads` → shop's lowdb → SMS + email alert → Response Center endpoints → appointment → completed.

The landing site is stateless. ShopFlow is the system of record — no lead is ever stored only on the website.

## Wire it up (ShopFlow side, ~15 min)

1. Copy `website-leads.router.js` into `routes/` in shopflow-platform.
2. Mount everything in server.js:
   ```js
   const websiteLeads = require('./routes/website-leads');
   const platform = require('./routes/platform');
   const createAutomations = require('./routes/automations');

   const platformR = platform({ getShopDb, requireOwner /* your JWT middleware */ });
   const automations = createAutomations({ getShopDb, getAllTenantIds, sendSms, sendEmail });
   automations.start(); // 60s tick

   app.use('/api', platformR);
   app.use('/api', websiteLeads({
     getShopDb,        // your per-tenant lowdb loader
     sendSms,          // Twilio: (tenantId, message, toPhone?) — omit toPhone = owner alert
     sendEmailAlert,   // nodemailer: (tenantId, subject, body)
     automations,      // enables follow-ups/reminders/retention
     onCompleted: platformR.recordCompletion, // customer records + LTV
   }));
   ```
   Adapter shims are fine if your function signatures differ — keep the router untouched so it stays drop-in for every client site.
3. Generate a website API key for the tenant:
   ```
   node -e "console.log('sfw_' + require('crypto').randomBytes(24).toString('hex'))"
   ```
   Add to the shop's db JSON:
   ```json
   "website_api_keys": [{ "key": "sfw_...", "label": "tint landing page", "active": true }]
   ```
4. Protect the Response Center routes (`/response-center`, `/leads/:id/*`) with your existing JWT middleware when mounting — they're for staff, not the public site.

## Wire it up (site side)

Set in Railway/Vercel env: `SHOPFLOW_API_URL`, `SHOPFLOW_API_KEY`, `SHOPFLOW_TENANT_ID` (see `.env.example`). One deploy per client, three env vars each — that's the whole multi-tenant story.

## Response Center data model (per lead)

| Field | Meaning |
|---|---|
| `status` | NEW_LEAD → CONTACTED → APPOINTMENT_SET → COMPLETED / LOST |
| `contact_status` | UNCONTACTED → ATTEMPTED → REACHED |
| `appointment_status` | NONE → SCHEDULED → COMPLETED / NO_SHOW |
| `assigned_to` / `assigned_at` | employee ownership |
| `first_response_at` / `response_time_seconds` | speed-to-lead metric, set automatically on first logged contact |
| `contact_attempts[]` | every call/text/email logged with who + when |
| `lead_quality_score` | 0–100, timeline-weighted |
| `estimated_value` | service + vehicle-type based |
| `upsells[]` | reserved for Part 3 |

`GET /api/response-center?tenant_id=x` returns open leads sorted uncontacted-first with live `age_seconds`, plus avg response time — everything needed to render the queue UI on top of your existing kanban.

## Meta ads attribution

Set ad URL parameters to:
```
utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}
```
The site captures these (plus fbclid/gclid) on first touch, persists through the session, and sends them with the lead. Cost-per-lead then falls out of campaign name + your ad spend.

## Push notifications (app notifications)
Real phone notifications through the ShopFlow PWA — free, instant, no A2P 10DLC involved.

1. `npm install web-push`, then `npx web-push generate-vapid-keys` → set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in Railway env.
2. Copy `push.js` into `routes/`, mount behind your JWT auth:
   ```js
   const push = require('./routes/push')({ getShopDb });
   app.use('/api/push', requireAuth, push.router);
   ```
3. Pass `sendPush: push.sendPush` into the leads router and automations — new-lead alerts and speed-to-lead nudges now push first (deep-linking to the lead), with SMS as backup.
4. PWA side: merge `sw-push.js` into the existing service worker, add an "Enable notifications" button that calls `enablePushNotifications(tenantId, userName)` from `pwa-push-client.js` (must be a button tap — browsers block un-prompted permission requests). Add a small monochrome `badge-72.png` icon for Android.
5. iPhone: works on iOS 16.4+ **only when the PWA is installed to the home screen** — your onboarding already does this, but it's the support question you'll get.

The `/api/push/test` endpoint powers a "Test my notifications" button in settings. Dead subscriptions (cleared browser data, revoked permission) are pruned automatically on send.

## Part 3 additions
- `platform.router.js` — admin site settings (+ public site-config feed), website key issue/revoke, ad spend + marketing analytics (CPL/ROAS), upsells, customers/LTV
- `automations.js` — event-driven follow-ups, reminders, review requests, retention (see ARCHITECTURE.md)
- Appointments now write to `db.data.appointments` (shop calendar) automatically
- Live-settings mode: set `SHOPFLOW_SETTINGS_URL` on the site → config pulls from ShopFlow, no redeploys

## Known limits
- Photos ride along as base64 into lowdb — move to object storage before volume grows.
- Rate limiting on the site proxy is in-memory per instance.
- Customer-facing automation SMS waits on your A2P 10DLC brand approval — owner alerts work now.

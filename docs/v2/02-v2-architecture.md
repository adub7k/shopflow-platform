# 02 — ShopFlow V2 System Architecture

## 1. Guiding principle: Core + Profile + Extensions

```
                         ┌─────────────────────────────────────────┐
                         │              SHOPFLOW CORE               │
                         │  (identical for every business type)     │
                         │                                          │
                         │  Dashboard · CRM · Communications ·      │
                         │  Scheduling · Billing · Automations      │
                         └───────────────┬──────────────────────────┘
                                         │ reads
                         ┌───────────────▼──────────────────────────┐
                         │           INDUSTRY PROFILE                │
                         │   industries.js block selected by         │
                         │   shop.settings.industry                  │
                         │                                           │
                         │  vocab · services · statuses ·            │
                         │  customFields · modules[] · widgets[] ·   │
                         │  automations[] · extensions[]             │
                         └───────────────┬──────────────────────────┘
                                         │ activates
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                 ▼                                 ▼
┌───────────────┐               ┌───────────────┐                ┌───────────────┐
│ CLEANING MOD  │               │  DETAIL MOD   │                │  (future mod) │
│ Properties    │               │  Vehicles     │                │  ...          │
│ Crews         │               │  VehicleMedia │                │               │
│ RecurringSvc  │               │  Retention    │                │               │
└───────┬───────┘               └───────┬───────┘                └───────────────┘
        │ reference customerId by id     │
        └────────────────┬───────────────┘
                         ▼
                ┌──────────────────┐
                │  customers[]     │  ← ONE shared customer table. Never duplicated.
                └──────────────────┘
```

**Three layers, three change-rates:**
- **Core** changes rarely and benefits every vertical at once.
- **Profile** is data, not code — adding a vertical is a config block.
- **Extensions** are small, optional, additive collections that *reference* core (mainly `customers`).

## 2. The single most important architectural decision

**The `appointments` collection is the universal "job / visit / booking" entity for every vertical.**

- Barber → a haircut visit. Detail → a vehicle job. Cleaning → a cleaning job. Tint → a tint job.
- This already works today (barber/detail/nails share it) and keeps **all** existing logic — revenue,
  loyalty, reminders, deposits, checkout, no-show — working unchanged for new verticals.
- Vertical-specific data hangs off the appointment via **reference ids** (`propertyId`, `vehicleId`) and the
  existing `customFields`, **not** via parallel job tables that would re-store customer/job data.

> The brief lists `CleaningJobs` and `VehicleServices` as tables. In V2 these are realized as the unified
> `appointments` collection *scoped by industry* + a reference id, surfaced through industry-specific **views**
> (e.g. "Jobs", "Vehicle service history"). This honors "do NOT duplicate customer data across industries"
> and reuses the revenue/loyalty/reminder engine. (Alternative — literal separate tables — is described in
> `03-database-schema.md §6` with its trade-offs, if you prefer it.)

## 3. Profile schema — extended for V2

V2 adds four optional keys to each `industries.js` block (all backward-compatible; absent ⇒ sensible default):

```js
detail: {
  label: 'Detail Shop',
  vocab: { … },            // existing
  services: [ … ],         // existing
  statuses: [ … ],         // existing
  customFields: [ … ],     // existing
  // ── NEW in V2 ──────────────────────────────────────────────
  modules:    ['vehicles','media','retention'],   // which industry modules to mount
  navExtras:  [ {page:'vehicles', label:'Vehicles', icon:'car',  roles:['full','technician']} ],
  widgets:    ['avgTicket','revPerVehicle','repeatRate','upsellRev','monthlyRevenue'],
  extensions: ['vehicles','vehicleMedia','retentionCampaigns'], // collections to ensure exist
  automations:['serviceReminder','retentionCampaign'],          // campaign templates to seed
}
```

- `modules` → which industry UI bundles load. `navExtras` → industry-specific nav items appended to Core nav.
- `widgets` → dashboard widget ids the vertical shows. `extensions` → extension collections to lazily ensure.
- `automations` → campaign templates seeded into the new general automation engine.
- **Default profile** (`other`) sets all of these to empty/baseline → pure Core CRM, nothing breaks.

## 4. Backend module layout (V2)

```
server/
  industries.js          ← + cleaning, tint, pressure, other; + modules/widgets/extensions keys
  db.js                  ← unchanged core; + ensureExtensions(db, profile)
  store/                 ← NEW seam: thin repo wrappers over lowdb (id-indexed get, paginated list)
    index.js
  modules/               ← NEW: industry extension logic, mounted by profile.modules
    cleaning/
      properties.js      ← CRUD for properties[]  (address, gate codes, alarm, pets, access notes)
      crews.js           ← CRUD for crews[] (+ membership of barbers[]), assignment, time tracking
      recurring.js       ← recurringServices[] → generates appointments on cadence
    detail/
      vehicles.js        ← vehicles[] (VIN/make/model/year/mileage/color) ← migrated from customer.vehicles
      media.js           ← per-vehicle gallery view over appointment before/after photos + videos
      retention.js       ← last-service, follow-up schedule (delegates to automation engine)
  routes/                ← existing routes; + /api/shop/properties, /crews, /recurring, /vehicles, /media
  automation/            ← NEW: general campaign engine (replaces hardcoded scheduler jobs)
    engine.js            ← evaluate campaign definitions per shop on each scheduler tick
    templates.js         ← reminder, review-request, follow-up, retention, re-engagement
  receptionist/          ← NEW: AI receptionist (see 05); builds on routes/twilio.js
    intake.js  summary.js  scoring.js
  scheduler.js           ← calls automation/engine.js instead of inline reminder/nudge code
```

**Mounting is profile-driven:** on each request `shopRoute` already loads the shop DB; a small
`mountModules(profile)` decides which `/api/shop/*` extension routers respond (others 404 for that vertical).
Adding a vertical never edits Core route files.

## 5. Frontend module layout (V2)

```
client/js/
  core/            ← api.js, utils.js, app.js (router), client-profile.js  (unchanged behavior)
  components/      ← NEW shared library: Card, List, Form, Modal, Table, Widget, EmptyState
                     (extracted from today's duplicated inline patterns — see 04 §5)
  pages/           ← existing core pages (dashboard, clients, appointments, …)
  modules/         ← NEW industry pages, lazy-loaded when profile.modules includes them
    cleaning/  properties.js  crews.js  recurring.js  jobs.js
    detail/    vehicles.js    media.js   retention.js
  registry.js      ← NEW: maps profile.modules/navExtras/widgets → loaded JS + nav + dashboard
```

- `registry.js` reads the profile (already on `Shop`) and **lazy-imports** only the active vertical's modules,
  fixing the "all pages parsed at boot" issue for new code.
- Core pages keep working exactly as today; industry pages are purely additive.

## 6. How a brand-new vertical is added end-to-end (V2 target)

1. Add a block to `industries.js` (vocab, services, statuses, `modules`, `navExtras`, `widgets`, `extensions`).
2. If it needs storage Core lacks, add an extension collection + a `server/modules/<x>/` router and a
   `client/js/modules/<x>/` page. (Most verticals reuse Cleaning/Detail modules and add **zero** code.)
3. Done. Signup picker, nav, dashboard widgets, automations, and the AI receptionist all read the profile.

**Verticals that need no new module** (reuse existing): **Tint** and **Pressure Washing** reuse the Detail
module (vehicles / surfaces, before-after media, retention). **Nail/Barber** are pure Core + profile.
**Cleaning** is the one genuinely new module (Properties/Crews/Recurring). So V2's new *code* is essentially:
the Cleaning module, the generalized automation engine, the AI receptionist, and the UI component library.

## 7. Multi-tenancy & isolation unchanged

Per-shop file isolation, JWT scoping, admin key, uploads tree — all preserved. Extensions live inside each
shop's `shopflow.json`, so tenant isolation is automatic and free.

# 04 — Navigation & Dashboard Redesign

## 1. Problems with today's nav

- Static sidebar in `app.html`; every vertical sees the **same 10 items** regardless of industry.
- No grouping → flat list grows unwieldy as verticals add pages.
- Dashboard widgets are barber/detail-flavored, not driven by the profile.
- Monolithic admin/sales HTML, duplicated CSS, no shared component primitives.

## 2. V2 nav model: Core groups + profile-injected items

Nav is **rendered from a registry**, not hardcoded. `registry.js` builds the sidebar from:
`CORE_NAV` (always) + `profile.navExtras` (industry) + role filter (existing `ROLE_PAGES`).

```
CORE_NAV (every vertical, grouped):
  ▸ OVERVIEW
      Dashboard
  ▸ CRM
      Leads            (pipeline)
      Customers
      Conversations    (SMS/Email inbox)
  ▸ OPERATIONS
      Appointments     (calendar)        ← relabeled per vocab: "Jobs" / "Visits"
      [industry items inject here]
  ▸ MONEY
      Estimates        (if supportsQuotes)
      Revenue / P&L
  ▸ GROWTH
      Reviews
      Automations
  ▸ SETTINGS
      Settings
```

```
profile.navExtras injected into OPERATIONS:
  cleaning → Properties · Crews · Recurring
  detail   → Vehicles · Media
  tint     → Vehicles (relabeled "Jobs/Glass") · Media
  pressure → Assets (relabeled) · Media
  barber/nails/other → (none)
```

Labels flow through `V()` vocab so "Appointments" reads "Jobs" (cleaning), "Visits" (barber), etc., with no
code branches.

## 3. Sidebar wireframe (desktop)

```
┌────────────────────┬──────────────────────────────────────────────┐
│  ShopFlow          │  Topbar:  ☰   Sparkle Detailing      ◔ adub  │
│  ● Sparkle Detail  ├──────────────────────────────────────────────┤
│                    │                                              │
│  OVERVIEW          │   [ page content renders here ]              │
│   � Dashboard       │                                              │
│  CRM               │                                              │
│   ◦ Leads      (3) │                                              │
│   ◦ Customers      │                                              │
│   ◦ Messages   (2) │                                              │
│  OPERATIONS        │                                              │
│   ◦ Jobs           │                                              │
│   ◦ Vehicles  ←inj │                                              │
│   ◦ Media     ←inj │                                              │
│  MONEY             │                                              │
│   ◦ Estimates      │                                              │
│   ◦ Revenue        │                                              │
│  GROWTH            │                                              │
│   ◦ Reviews        │                                              │
│   ◦ Automations    │                                              │
│  ─────────────     │                                              │
│   ◦ Settings       │                                              │
└────────────────────┴──────────────────────────────────────────────┘
```

Mobile keeps the existing drawer + 5-item bottom nav (Dashboard · Jobs · Messages · Revenue · More),
where **More** opens the grouped sheet above. Group headers collapse on mobile.

## 4. Dashboard: profile-driven widget grid

Dashboard renders `profile.widgets` (ids) through a `Widget` component. Core widgets exist for all; verticals
opt into extras. The brief's Core dashboard set maps to widget ids:

`revenue` · `appointments` (today) · `newLeads` · `missedCalls` · `followUpsDue` · `conversionRate` ·
`customerCount`.

```
CORE dashboard (every vertical):
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Revenue MTD  │ Appts Today  │ New Leads    │ Missed Calls │
│   $4,820     │     7        │     5        │     2        │
├──────────────┼──────────────┼──────────────┼──────────────┤
│ Follow-ups   │ Conversion   │ Customers    │ MRR          │
│ Due   3      │   42%        │   318        │  $1,240      │
└──────────────┴──────────────┴──────────────┴──────────────┘
[ Today's schedule list ]      [ Needs attention: missed calls, review-ready, retention-due ]
```

**Cleaning extra widgets** (`activeRecurring`, `jobsToday`, `revPerCleaner`, `crewUtilization`, `mrr`):
```
┌───────────────┬───────────────┬───────────────┬───────────────┐
│ Active        │ Jobs          │ Revenue /     │ Crew          │
│ Recurring 24  │ Today  9      │ Cleaner $310  │ Utilization 78%│
└───────────────┴───────────────┴───────────────┴───────────────┘
```

**Detail extra widgets** (`avgTicket`, `revPerVehicle`, `repeatRate`, `upsellRev`, `monthlyRevenue`):
```
┌───────────────┬───────────────┬───────────────┬───────────────┐
│ Avg Ticket    │ Revenue /     │ Repeat        │ Upsell        │
│   $214        │ Vehicle $189  │ Customers 36% │ Revenue $980  │
└───────────────┴───────────────┴───────────────┴───────────────┘
```

All widget values come from existing data: `appointments` (revenue, avg ticket, today), `leads`/`calls`
(new leads, missed calls, conversion), `automations`/scheduler (follow-ups due), `customers` (count, MRR,
repeat rate). No new computation engine — widgets are thin selectors.

## 5. Component library (fixes duplication + speeds the UI)

Extract the patterns already copy-pasted across pages into `client/js/components/`:
`Card`, `MetricCard/Widget`, `List/ListRow`, `Form` (schema-driven inputs), `Modal` (exists ad-hoc),
`Table`, `EmptyState`, `Badge`, `Tabs`. Industry pages compose these → less code per vertical, consistent UX,
and the only place to touch for a global restyle. CSS tokens already exist in `app.css` (`:root` vars) — V2
consolidates the duplicated inline CSS from `admin.html`/`sales.html` into shared stylesheet + components.

## 6. Business-type selector (signup)

`/api/industries` already lists verticals for the picker. V2 expands it to the full set and adds the question
copy: **"What type of business do you operate?"** → Barber Shop · Cleaning Company · Detail Shop · Tint Shop ·
Nail Salon · Pressure Washing · Other. Selection writes `settings.industry`, which (via the profile) sets
nav, widgets, fields, modules, and automations. `Other` = pure Core CRM. Industry is changeable later in
Settings (re-runs `ensureExtensions`, never deletes data).

## 7. Speed wins

- Lazy-load industry page modules via `registry.js` (only the active vertical's JS parses).
- Paginated list views (Customers/Jobs) using the new `store` pagination.
- Shared components shrink per-page JS; consolidated CSS shrinks payload.

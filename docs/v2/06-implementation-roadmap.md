# 06 — Implementation Roadmap

Each phase is **independently shippable**, ends with a **test gate**, and is **additive** (Core + existing
verticals keep working at every step). Order is chosen so the highest-value, lowest-risk work lands first.

Legend: 🟢 low risk (additive only) · 🟡 medium (touches a Core file behind a flag) · 🔴 higher (datastore).

---

### Phase 0 — Foundation & safety (🟢)
- Confirm worktree/branch `v2` (done), seed data present, app boots locally.
- Add `store/` seam (no behavior change yet), `ensureExtensions(db, profile)` helper.
- Extend `industries.js` block schema with `modules/navExtras/widgets/extensions/automations` keys
  (existing verticals get sensible values; nothing else reads them yet).
- **Test gate:** existing app runs unchanged (login, dashboard, book, checkout) against seed data;
  `industries.js` still resolves barber/detail/nails identically.

### Phase 1 — New vertical profiles + business-type selector (🟢)
- Add `cleaning`, `tint`, `pressure`, `other` profile blocks (vocab/services/statuses/customFields).
- Expand `/api/industries` + signup picker to the full 7-option question.
- Industry switch in Settings (re-runs `ensureExtensions`; never deletes).
- **Test gate:** create a shop of each new type; signup seeds correct services/vocab/statuses; existing shops
  unaffected; booking page renders with the right labels.

### Phase 2 — Navigation + dashboard registry + component library (🟡, flagged)
- `client/js/components/` primitives; consolidate duplicated CSS.
- `registry.js` renders sidebar from `CORE_NAV + profile.navExtras` and dashboard from `profile.widgets`,
  with role filtering (reuse `ROLE_PAGES`).
- Behind a `v2nav` feature flag (per `db.features`) so it can be toggled per shop during rollout.
- **Test gate:** with flag off → identical to today; with flag on → grouped nav + profile widgets render for
  barber/detail/nails/cleaning; mobile drawer + bottom nav intact; Lighthouse/byte-size not worse.

### Phase 3 — Cleaning module (🟢, the main new code)
- Extensions: `properties[]`, `crews[]`, `recurringServices[]`; routers under `/api/shop/{properties,crews,recurring}`.
- Pages: Properties, Crews, Recurring, Jobs (Jobs = appointments view scoped to cleaning + property/crew).
- Recurring generator hook in the scheduler (spawns the next appointment from `nextRunDate`).
- Cleaning dashboard widgets (active recurring, jobs today, rev/cleaner, crew utilization, MRR).
- **Test gate:** create properties/crews, set a weekly recurring service, advance the clock → appointment is
  generated, crew utilization + rev/cleaner compute correctly, revenue/loyalty/reminders still fire via Core.

### Phase 4 — Detail/Tint/Pressure deepening + AI receptionist (🟢/🟡)
- Promote `vehicles[]` (+ lazy back-compat backfill from `customers[].vehicles[]`), Vehicles page, per-vehicle
  service history + media gallery, retention view.
- Tint & Pressure reuse the Detail module (label-only differences via vocab) — verify zero new code needed.
- AI receptionist: recording capture + transcription + summary + structured intake + quality score + follow-up
  (see `05`). Gated by `settings.aiReceptionist.enabled`, degrades gracefully without `ANTHROPIC_API_KEY`.
- **Test gate:** detail shop shows vehicles & history with no data loss; tint/pressure shops work off the same
  module; a simulated inbound call produces transcript + AI summary + intake fields on the lead (and still
  works with AI disabled).

### Phase 5 — General automation/retention engine (🟡)
- `automation/engine.js` + `automations[]` definitions; scheduler calls the engine.
- Seed two default automations that **reproduce today's exact** 24h-reminder + 21-day-rebook behavior using
  the existing `remindersSent[]`/`nudgesSent[]` dedup lists (migration = no-op).
- Add review-request, follow-up, retention, re-engagement templates; per-vertical defaults via `profile.automations`.
- **Test gate:** byte-for-byte same reminder/rebook sends as the old scheduler for an unchanged shop; new
  campaigns send correctly; no double-sends across a scheduler restart.

### Phase 6 — Performance & polish (🟡; datastore swap 🔴 = separate track)
- Pagination + indexed lookups via `store/`; lazy-load page modules; image/voicemail caching.
- **Datastore migration (Postgres) is a separate, post-V2 track** behind a dual-write/backfill plan — only if
  scale demands it (see `01 §I`). Not required to ship V2.
- **Test gate:** large-shop load test (10k appointments) stays responsive; no functional regressions.

---

## Sequencing rationale
- Profiles + selector (P1) deliver visible multi-industry value with near-zero risk.
- Nav/dashboard (P2) is flagged so it can roll out gradually and roll back instantly.
- Cleaning (P3) is the one substantial new module; it's fully additive.
- AI receptionist (P4) layers onto an already-working call pipeline.
- Automation engine (P5) is deferred until after it can prove parity with the current scheduler.
- Each phase merges to `main` (→ Railway) only after its test gate passes, or stays on `v2` until a batch is ready.

## Per-phase definition of done
1. Test gate passes locally against seed data. 2. No change to existing vertical behavior (regression check).
3. `ensureExtensions` idempotent. 4. Docs updated. 5. Commit on `v2` with a clear message + rollback note.

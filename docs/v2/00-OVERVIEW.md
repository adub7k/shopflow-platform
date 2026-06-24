# ShopFlow V2 — Planning Overview & Index

**Status:** Planning (awaiting approval before application code is written)
**Base:** duplicate of `shopflow-platform` (the real multi-tenant product), branch `v2`, worktree `~/shopflow-v2`
**Author:** architecture pass, 2026-06-23

---

## 1. Goal

Evolve ShopFlow from a barber-centric (now barber + detail + nails) booking/CRM into a
**multi-industry operating system for service businesses** on a **single unified codebase**:

Barbershops · Cleaning Companies · Auto Detail · Tint Shops · Nail Salons · Pressure Washing · future verticals.

**Crucial finding from the audit:** ShopFlow already *is* a multi-vertical, multi-tenant platform.
`server/industries.js` already drives per-vertical vocab, services, statuses, custom fields, deposits,
fleet support and vehicle sizes, with the design note *"Adding a new vertical = a new block below.
No other code changes required."* V2 is therefore **mostly additive**: new vertical profiles, a small
set of new extension collections, an industry-aware navigation layer, a generalized retention/automation
engine, and a deeper AI receptionist — **not** a rewrite.

## 2. Hard constraints (from the user)

1. **Deploy target = the same Railway service.** No new app, no data export/import.
2. **Zero client-data loss.** Production data lives on the Railway **`/data` persistent volume**
   (`db.js`: `DATA_DIR || /data`), *not* in the committed `data/` folder. Deploying V2 code therefore
   **cannot** touch client data as long as schema changes are additive.
3. **Original preserved.** All work happens on branch `v2` in worktree `~/shopflow-v2`; `main` is untouched.

## 3. Non-negotiable engineering rules (derived from constraint #2)

- **Additive only.** New collections default to `[]`. `db.js` already self-heals missing collections
  (`upsert()` creates the array on first write), so old shop DBs keep working with zero migration.
- **No renames of internal fields.** Profiles relabel in the UI (`vocab`); the data model keeps
  `barberId`/`cutNotes`/`chair` etc. This invariant is already documented in `industries.js` and V2 honors it.
- **No destructive migration.** Backfills are lazy/idempotent (the existing pattern), runnable repeatedly.
- **Rollback = redeploy previous commit.** Because data is untouched, reverting code never loses data.

## 4. Decisions locked

| Decision | Choice | Rationale |
|---|---|---|
| V2 base | duplicate `shopflow-platform` | already multi-tenant + vertical-aware; preserves all features |
| Isolation | git worktree `~/shopflow-v2`, branch `v2` | separate folder, `main` safe, same repo → same Railway deploy |
| Deploy | merge `v2 → main`, Railway redeploys; `/data` volume persists | satisfies "same server, no data loss" |
| Job model | reuse the unified `appointments` collection for every vertical's "job/visit" | avoids duplicating customer/job data (explicit user requirement) |
| New per-vertical data | thin **extension collections** that reference `customers` by id | one customer table, many verticals |

## 5. Deliverables in this folder

| File | Deliverable |
|---|---|
| `00-OVERVIEW.md` | this index |
| `01-architecture-audit.md` | current architecture map + scalability bottlenecks |
| `02-v2-architecture.md` | V2 modular architecture (Core + industry modules), how a vertical plugs in |
| `03-database-schema.md` | core tables + industry extension collections; additive migration rules |
| `04-navigation-redesign.md` | industry-aware nav + dashboard widgets + wireframes |
| `05-ai-receptionist.md` | AI receptionist design built on the existing Twilio flow |
| `06-implementation-roadmap.md` | phased build plan with a test gate per phase |
| `07-migration-plan.md` | zero-data-loss migration + Railway deploy + rollback |

## 6. Approval gate

Per the original brief: **planning is produced first, implementation follows only after approval.**
Nothing in the application code (`server/`, `client/`) has been changed on branch `v2` yet — only this
`docs/v2/` folder and the worktree exist. Phase 0 (below) begins on your go-ahead.

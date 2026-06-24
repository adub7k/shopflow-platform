# 07 — Migration & Deployment Plan (zero client-data loss)

## 1. The core safety fact

Production data lives on the **Railway persistent volume mounted at `/data`**
(`db.js`: `MASTER_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : <repo>/data)`).
The committed `data/` folder in the repo is only **local seed/dev data**. Therefore:

> **Deploying new code does not move, rewrite, or delete the `/data` volume.** A V2 deploy is a code swap.
> Client info is preserved by definition, as long as schema changes are additive (they are — see `03`).

## 2. Why no data migration is needed

- Every V2 collection is **new and optional** (`properties`, `crews`, `recurringServices`, `vehicles`,
  `vehicleMedia`, `automations`). Old shop DBs simply don't have them yet; `db.js` self-heals on first write.
- **No field is renamed or removed.** Internal names (`barberId`, `cutNotes`, `chair`, `customers[].vehicles`)
  stay; profiles only relabel in the UI.
- The **one** data-touch (vehicles promotion) is a **lazy, idempotent, non-destructive backfill** that leaves
  the original inline `customers[].vehicles[]` intact (`03 §5`). Skipping it breaks nothing.

## 3. Deployment path (same Railway service)

```
   ~/shopflow-v2 (branch v2)  ──tested per phase──►  PR v2 → main  ──►  Railway redeploys main
                                                                         │
                                                          same service, same /data volume
```

**Recommended rollout per phase:**
1. Merge the phase branch into `main` (or first point a **Railway staging service** at branch `v2`, sharing a
   *copy* of the volume, if you want a pre-prod check — optional).
2. Railway builds & deploys `main`. The `/data` volume re-attaches untouched.
3. New optional collections initialize lazily as features are used. Feature-flag risky UI (`v2nav`) per shop.

**Env vars to confirm in Railway before P4** (already partially set per project memory): `JWT_SECRET`,
`ADMIN_KEY`, `STRIPE_WEBHOOK_SECRET`, Twilio creds, and (new) `ANTHROPIC_API_KEY` for the AI receptionist
(absent ⇒ receptionist degrades gracefully).

## 4. Backup & rollback (rollback points)

**Before the first production deploy of V2 code:**
- **Tag the current prod commit:** `git tag pre-v2-prod <current-main-sha>` → instant code rollback target.
- **Snapshot the volume:** take a Railway volume backup/snapshot (or `cp -R /data /data-backup-YYYYMMDD` via a
  one-off shell) so there is a point-in-time copy independent of code.

**Rollback procedure (if a deploy misbehaves):**
1. `git revert`/redeploy `pre-v2-prod` (or Railway "redeploy previous"). Code reverts in minutes.
2. Because data was never rewritten destructively, **no data restore is needed**. The volume snapshot exists
   only as belt-and-suspenders.
3. Feature flags (`v2nav`, `aiReceptionist.enabled`) let you disable a feature **without** a redeploy.

## 5. Pre-deploy verification checklist (run each phase)

- [ ] App boots locally on `v2` against seed `/data` (login, dashboard, booking, checkout, SMS path).
- [ ] Existing verticals (barber/detail/nails) behave identically (regression pass).
- [ ] `ensureExtensions` runs idempotently; re-running causes no change.
- [ ] No renamed/removed fields in the diff (`git diff` review of `db.js`, route handlers, `industries.js`).
- [ ] Scheduler parity (Phase 5): same reminder/rebook output for an unchanged shop.
- [ ] Volume snapshot + `pre-v2-prod` tag exist before the first prod merge.

## 6. Data-loss risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Deploy rewrites volume | very low | code never writes `/data` on boot; collections lazy-init only on use |
| Vehicle backfill duplicates/loses entries | low | idempotent, keyed; originals left intact; reversible |
| Field rename slips into a diff | low | checklist diff-review gate; rule documented in `00`/`03` |
| Industry switch wipes module data | low | switch only *adds* collections via `ensureExtensions`; never deletes |
| Scheduler double-sends after engine swap | low | reuse existing dedup lists; parity test gate (P5) |

## 7. One-time scripts (kept out of the request path)

If you ever want **eager** (non-lazy) backfills before a release, provide standalone idempotent scripts
(mirroring the existing `seed-*.js` style) run once against the volume: `migrate-vehicles.js`,
`seed-default-automations.js`. They are optional — the lazy path already guarantees correctness.

# 03 — Database Schema Recommendations (V2)

**Golden rule:** every change is **additive**. New collections default to `[]`; `db.js` already self-heals a
missing collection on first `upsert`. No field renames, no destructive migration, no change to how production
`/data` is read. Old shop DBs keep working untouched.

## 1. Core tables (unchanged shape; mapped to the brief's logical model)

| Brief's logical table | Physical location today | Notes |
|---|---|---|
| Accounts | `master.json → accounts[]` (+ `shops[]`) | tenant + login records |
| Users | `accounts[]` (role: full/technician/viewonly) + `barbers[]` (staff/resources) | |
| Customers | per-shop `customers[]` | **the one shared customer table** |
| Leads | per-shop `leads[]` | call-tracking + manual |
| Appointments | per-shop `appointments[]` | **universal job/visit entity** |
| Invoices/Estimates | per-shop `quotes[]` | estimate→invoice lifecycle |
| Payments | `appointments[].paid*` / `quotes[].deposit*` / Stripe webhooks | |
| Messages | per-shop `conversations[]` | SMS threads |
| Calls | per-shop `calls[]` | inbound call logs + voicemail |
| Automations | (today hardcoded) → per-shop `automations[]` (NEW, §4) | campaign definitions |

No core table is dropped or renamed. V2 adds `automations[]` as a new core collection (empty default).

## 2. Industry extension collections (NEW — all per-shop, all default `[]`)

### Cleaning module
```jsonc
// properties[]  — a service location; references the shared customer
{
  "id": "uuid",
  "customerId": "uuid",          // → customers[].id  (NO customer data duplicated)
  "label": "Main house",
  "address": "123 Oak St, …",
  "squareFootage": 2400,
  "bedrooms": 3, "bathrooms": 2,
  "gateCode": "1234",
  "alarmInstructions": "Disarm code 9988, panel by garage",
  "petInfo": "Friendly dog 'Bo' in back yard",
  "accessNotes": "Key under planter; park in driveway",
  "createdAt": "iso"
}

// crews[]  — a team; members reference existing staff (barbers[])
{
  "id": "uuid",
  "name": "Crew A",
  "memberIds": ["barberId1","barberId2"],   // → barbers[].id (staff table, relabeled 'Cleaners')
  "color": "#2563eb",
  "active": true,
  "createdAt": "iso"
}

// recurringServices[]  — a recurring contract that generates appointments
{
  "id": "uuid",
  "customerId": "uuid",
  "propertyId": "uuid",
  "serviceId": "uuid",
  "crewId": "uuid",
  "cadence": "weekly|biweekly|monthly|custom",
  "customRule": null,            // e.g. {everyDays:10} when cadence='custom'
  "dayOfWeek": 2,                // 0..6 for weekly/biweekly
  "time": "09:00",
  "price": 150,
  "active": true,
  "nextRunDate": "iso",          // scheduler reads this to spawn the next appointment
  "lastGeneratedAppointmentId": "uuid|null",
  "createdAt": "iso"
}
```
A **cleaning job** = an `appointments[]` row with `propertyId`, `crewId`, and (optionally)
`recurringServiceId` set. Job status uses the cleaning profile's statuses (`scheduled`, `en-route`,
`in-progress`, `done`, `no-show`). Time tracking: `appointments[].startedAt/endedAt` (already exist) → drives
crew utilization + revenue-per-cleaner.

### Detail / Tint / Pressure-washing module
```jsonc
// vehicles[]  — promoted from the embedded customers[].vehicles[] (back-compat kept, §5)
{
  "id": "uuid",
  "customerId": "uuid",          // → customers[].id
  "vin": "1HGCM82633A004352",
  "make": "Honda", "model": "Accord", "year": 2019,
  "mileage": 48000,
  "color": "Silver",
  "size": "sedan",               // matches profile.vehicleSizes for size pricing
  "plate": "ABC123",
  "lastServiceDate": "iso|null", // denormalized for the retention dashboard
  "createdAt": "iso"
}

// vehicleMedia[]  — optional first-class media (else reuse appointment before/after photos)
{
  "id": "uuid",
  "vehicleId": "uuid",
  "appointmentId": "uuid|null",
  "kind": "before|after|video",
  "url": "/uploads/{shopId}/…",
  "createdAt": "iso"
}
```
A **vehicle service** = an `appointments[]` row with `vehicleId` set; the "service history" view is
`appointments.filter(a => a.vehicleId === id)`. For pressure washing, the same shape models a *surface/asset*
instead of a vehicle (label-only difference via `vocab`), so no new collection is needed.

### Retention / automation (shared by all verticals)
```jsonc
// automations[]  — campaign definitions (replaces hardcoded scheduler jobs)
{
  "id": "uuid",
  "type": "reminder|review|followup|retention|reengagement",
  "name": "21-day rebook",
  "enabled": true,
  "trigger": { "kind": "daysSinceLastDone", "days": 21 },   // or {kind:'beforeAppointment',hours:24}
  "audience": { "status": "done", "industryAny": true },
  "channel": "sms",
  "templateKey": "rebook",       // → automation/templates.js, overridable per shop
  "lastRunAt": "iso",
  "stats": { "sent": 0 }
}
```
The existing dedup lists (`remindersSent[]`, `nudgesSent[]`) are reused so **migration is a no-op** —
the engine seeds two default `automations[]` rows (24h reminder + 21-day rebook) that reproduce today's
exact behavior, then verticals add their own.

## 3. Relationship map (referential, not duplicated)

```
customers[] 1───* properties[]            (cleaning)
customers[] 1───* vehicles[]              (detail/tint/pressure)
customers[] 1───* appointments[]          (all verticals)
properties[] 1──* appointments[]          via appointments.propertyId
vehicles[]  1───* appointments[]          via appointments.vehicleId
vehicles[]  1───* vehicleMedia[]
crews[]     *───* barbers[] (staff)       via crews.memberIds
recurringServices[] 1──* appointments[]   generated on cadence
automations[] act on customers[]/appointments[]
```
Every arrow is an **id reference**. Customer identity, contact info, loyalty, and membership stay in
`customers[]` only — satisfying "all industry modules reference the same customer table."

## 4. `ensureExtensions(db, profile)` (additive migration helper)

A single idempotent function, called lazily (the existing backfill pattern) when a module route is first hit:
```js
function ensureExtensions(db, profile) {
  for (const col of profile.extensions || []) {
    if (db.get(col).value() === undefined) db.set(col, []).write();   // self-heal, additive
  }
}
```
Safe to run repeatedly; never deletes; never touches existing collections.

## 5. Vehicle back-compat (the only "migration" with existing data)

Detail shops today store vehicles inline on `customers[].vehicles[]`. V2 promotes these to `vehicles[]`:
- **Lazy, idempotent backfill:** first time the Vehicles page loads for a shop, copy any
  `customers[].vehicles[]` entries that lack a matching `vehicles[]` row (`id` minted, `customerId` set).
- **Keep writing both for one release** (dual-read): the customer-profile UI still shows inline vehicles;
  new vehicle CRUD writes `vehicles[]`. After a release of stability, inline becomes read-through only.
- **No data loss path:** if backfill is skipped, nothing breaks — inline vehicles still render as before.

## 6. Alternative considered: literal separate `CleaningJobs` / `VehicleServices` tables

Rejected as the default because it would (a) re-store customer/scheduling/payment fields already on
`appointments[]`, (b) fork revenue/loyalty/reminder/checkout logic per vertical, and (c) violate the
"don't duplicate customer data" rule. The unified-appointments approach gives the same *views* the brief
asks for ("Jobs", "Vehicle services") with one engine. If you specifically want physical separate tables,
we can add them as **derived projections** kept in sync from `appointments[]` — say the word and it's a
small addition, not a re-architecture.

## 7. Indexing / performance (additive, no datastore change)

- Add `store/index.js` helpers: `getById` (already exists) and per-collection `byField(col, field, val)` that
  builds a transient `Map` for hot lookups (customer-by-phone, appointments-by-date) instead of repeated scans.
- Add pagination params (`?limit&cursor`) to list endpoints; default unchanged for back-compat.
- These are optimizations layered over lowdb; the Postgres path stays open behind `store/`.

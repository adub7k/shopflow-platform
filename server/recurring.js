// ── Recurring service generation ─────────────────────────────────────────────
// A recurringServices[] row is a contract (customer + property + service + crew +
// cadence) that spawns a normal appointment on each due date. Generated jobs are
// ordinary appointments[] rows (status 'confirmed', source 'recurring') so all the
// existing revenue/loyalty/reminder/checkout logic applies unchanged. Shared by the
// scheduler (automatic) and the cleaning route (manual "generate now").
const { genId } = require('./db');

// Advance a YYYY-MM-DD date by one cadence step. Noon avoids DST/UTC edge cases.
function advanceDate(dateStr, cadence, customRule) {
  const d = new Date(dateStr + 'T12:00:00');
  const addDays = (n) => d.setDate(d.getDate() + n);
  switch (cadence) {
    case 'weekly':   addDays(7);  break;
    case 'biweekly': addDays(14); break;
    case 'monthly':  d.setMonth(d.getMonth() + 1); break;
    case 'custom':   addDays((customRule && customRule.everyDays) || 7); break;
    default:         addDays(7);
  }
  return d.toISOString().slice(0, 10);
}

// Build (but don't persist) an appointment object from a recurring contract.
function buildAppt(db, r) {
  const services   = db.get('services').value()   || [];
  const customers  = db.get('customers').value()  || [];
  const properties = db.get('properties').value() || [];
  const svc  = services.find(s => s.id === r.serviceId)   || null;
  const cust = customers.find(c => c.id === r.customerId) || null;
  const prop = properties.find(p => p.id === r.propertyId) || null;
  return {
    id: genId('a'),
    customerId:   r.customerId || null,
    customerName: cust ? cust.name : '',
    customerPhone: cust ? (cust.phone || '') : '',
    serviceId:    r.serviceId || null,
    service:      svc ? svc.name : 'Recurring Service',
    price:        r.price != null ? r.price : (svc ? svc.price : 0),
    duration:     svc ? svc.duration : 120,
    crewId:       r.crewId || null,
    propertyId:   r.propertyId || null,
    recurringServiceId: r.id,
    date:   r.nextRunDate,
    time:   r.time || '09:00',
    status: 'confirmed',
    source: 'recurring',
    customFields: prop ? { serviceAddress: prop.address || '' } : {},
    createdAt: new Date().toISOString(),
  };
}

// Generate ONE appointment for a due contract and advance its nextRunDate.
function generateOne(db, r) {
  const appt = buildAppt(db, r);
  db.get('appointments').push(appt).write();
  db.get('recurringServices').find({ id: r.id })
    .assign({ nextRunDate: advanceDate(r.nextRunDate, r.cadence, r.customRule), lastGeneratedAppointmentId: appt.id })
    .write();
  return appt;
}

// Generate all contracts due on/before `todayStr` (shop-local). One job per
// contract per call (next tick catches up further-behind contracts), which keeps
// a long-dormant contract from flooding the calendar in a single pass.
function generateDueRecurring(db, todayStr) {
  const recurring = db.get('recurringServices').value();
  if (!Array.isArray(recurring) || !recurring.length) return 0;
  let count = 0;
  for (const r of recurring) {
    if (!r.active) continue;
    if (!r.nextRunDate || r.nextRunDate > todayStr) continue;
    try { generateOne(db, r); count++; } catch (e) { /* skip bad contract */ }
  }
  return count;
}

module.exports = { advanceDate, buildAppt, generateOne, generateDueRecurring };

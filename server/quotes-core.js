// ── Quote/estimate shared logic ───────────────────────────────────────────────
// An approved estimate means a real client — make sure they exist in the CRM and
// the quote is linked to them. Called from EVERY path that lands a quote on
// 'approved': the public approve endpoint, the Square + Stripe deposit
// fulfillments, and the owner's "Mark approved" in the app. Idempotent: once the
// quote carries a customerId that resolves, repeat calls are a cheap no-op.
const { genId, today } = require('./db');

const _vn = s => String(s || '').trim().toLowerCase();
const sameVehicle = (x, y) => x && y && _vn(x.year) === _vn(y.year) && _vn(x.make) === _vn(y.make) && _vn(x.model) === _vn(y.model);

// Match: the quote's own link → phone digits → email. Creates the client with
// the quote's name/phone/email/vehicle when nobody matches; backfills missing
// phone/email and appends an unseen vehicle when someone does.
function ensureQuoteCustomer(h, q) {
  if (!q || !(q.customerName || q.customerPhone || q.customerEmail)) return null;
  const digits = String(q.customerPhone || '').replace(/\D/g, '');
  const email = String(q.customerEmail || '').trim().toLowerCase();
  let cust = q.customerId ? h.getById('customers', q.customerId) : null;
  if (!cust && digits.length >= 10) cust = h.getAll('customers').find(c => String(c.phone || '').replace(/\D/g, '') === digits);
  if (!cust && email) cust = h.getAll('customers').find(c => String(c.email || '').trim().toLowerCase() === email);
  const veh = q.vehicle && (q.vehicle.year || q.vehicle.make || q.vehicle.model) ? q.vehicle : null;
  if (!cust) {
    cust = {
      id: genId('c'), name: q.customerName || q.customerPhone || 'Estimate customer',
      phone: q.customerPhone || '', email: q.customerEmail || '', source: 'estimate',
      notes: '', noteLog: [{ id: genId('note'), text: 'Created from approved estimate ' + (q.number || ''), at: new Date().toISOString(), by: 'Estimate' }],
      loyaltyPoints: 0, noShows: 0, preferredBarberId: null, isFleet: false, companyName: '',
      vehicles: veh ? [veh] : [], createdAt: today(),
    };
    h.upsert('customers', cust);
  } else {
    let changed = false;
    if (!cust.phone && q.customerPhone) { cust.phone = q.customerPhone; changed = true; }
    if (!cust.email && q.customerEmail) { cust.email = q.customerEmail; changed = true; }
    if (veh && !(cust.vehicles || []).some(v => sameVehicle(v, veh))) { cust.vehicles = [...(cust.vehicles || []), veh]; changed = true; }
    if (changed) h.upsert('customers', cust);
  }
  if (q.customerId !== cust.id) { q.customerId = cust.id; h.upsert('quotes', q); }
  return cust;
}

module.exports = { ensureQuoteCustomer };

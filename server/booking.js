// ── Booking core (single source of truth) ────────────────────────────────────
// The menu, open-slot availability, and the create-appointment path (double-book
// guard + customer upsert + price resolution) all live here so there is exactly
// ONE implementation. Both the public booking page (routes/public.js) and the AI
// voice receptionist (receptionist/voice.js) call these — the double-booking
// guard must never diverge between the two.
//
// Everything is server-authoritative: price, duration, and deposit status are
// taken from the shop's own data, never from the caller/client.
const { shopHelpers, genId, today } = require('./db');
const { resolveProfile } = require('./industries');

// ── Clock helpers ─────────────────────────────────────────────────────────────
function parseClock(t) { const [tm, ap] = String(t).split(' '); let [h, m] = tm.split(':').map(Number); if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return h * 60 + m; }
function fmtClock(mins) { const h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12; return `${h12}:${String(m).padStart(2, '0')} ${ap}`; }

// The exact times a staff member offers on a working day (explicit list or range).
function barberSlotList(b) {
  const s = b.schedule || { startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 30 };
  if (Array.isArray(s.allowedTimes) && s.allowedTimes.length) return s.allowedTimes;
  const out = [];
  for (let t = parseClock(s.startTime || '9:00 AM'); t < parseClock(s.endTime || '6:00 PM'); t += (s.slotMinutes || 30)) out.push(fmtClock(t));
  return out;
}

// Statuses that hold a slot (so a pending-deposit booking doesn't block others).
function occupyingStatusKeys(settings) {
  const occ = (settings.statuses || []).filter(s => s.occupiesSlot).map(s => s.key);
  return occ.length ? occ : ['confirmed', 'in-progress'];
}

// Resolve a shop's inspo-photo mode: explicit per-shop setting wins, else the
// industry default ('required' for nail studios, 'off' elsewhere).
function inspoMode(settings, industry) {
  return settings.inspoPhoto || resolveProfile(industry).inspoDefault || 'off';
}

// ── Menu ──────────────────────────────────────────────────────────────────────
// The shop's bookable services (public-safe: never the internal `cost`), add-ons,
// and vehicle-size classes. Used to render the booking page and to ground the AI
// receptionist so it only ever quotes real prices from the shop's own catalog.
function getMenu(db) {
  const s = db.get('settings').value() || {};
  const industry = db.get('industry').value();
  const services = (db.get('services').value() || []).map(x => ({
    id: x.id, name: x.name, category: x.category, price: x.price,
    duration: x.duration, sizePricing: x.sizePricing || null, description: x.description || '',
  }));
  const addons = (s.addons || []).map(a => ({ id: a.id, name: a.name, price: a.price }));
  const vehicleSizes = (s.vehicleSizes && s.vehicleSizes.length)
    ? s.vehicleSizes
    : (resolveProfile(industry).vehicleSizes || []);
  return { services, addons, vehicleSizes };
}

// Resolve the price of a service for an optional vehicle size (per-size table
// wins when the size is set and priced, else the flat price).
function servicePrice(svc, sizeKey) {
  return (svc && svc.sizePricing && sizeKey && svc.sizePricing[sizeKey] != null && svc.sizePricing[sizeKey] !== '')
    ? Number(svc.sizePricing[sizeKey])
    : Number(svc && svc.price) || 0;
}

// ── Availability ──────────────────────────────────────────────────────────────
// Open start-times for a date across the shop's working staff. A booked job
// blocks its whole [start, start+duration) span (not just its start slot) so a
// long detail job can't leave every following slot bookable. Returns [] for
// blocked/past/closed days. `barberId` optionally narrows to one staff member.
function computeAvailability(db, date, { barberId } = {}) {
  if (!date) return [];
  const blocked = (db.get('blockedDates').value() || []).find(b => b.date === date);
  if (blocked) return [];
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  if (new Date(date + 'T12:00:00') < midnight) return [];

  const barbers = (db.get('barbers').value() || []).filter(b => b.active !== false);
  const dow = new Date(date + 'T12:00:00').getDay();
  let working = barberId ? barbers.filter(b => b.id === barberId) : barbers;
  working = working.filter(b => (b.schedule?.workDays || [1, 2, 3, 4, 5, 6]).includes(dow));
  if (!working.length) return [];

  const settings = db.get('settings').value() || {};
  const occupies = occupyingStatusKeys(settings);
  const appts = (db.get('appointments').value() || []).filter(a => a.date === date && occupies.includes(a.status));
  const allSlots = new Set();
  working.forEach(b => {
    const sched = b.schedule || { startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 30 };
    const intervals = appts.filter(a => a.barberId === b.id).map(a => {
      const start = parseClock(a.time);
      return { start, end: start + (Number(a.duration) || sched.slotMinutes || 30) };
    });
    barberSlotList(b)
      .filter(slot => { const m = parseClock(slot); return !intervals.some(iv => m >= iv.start && m < iv.end); })
      .forEach(slot => allSlots.add(slot));
  });
  return [...allSlots].sort((a, b) => parseClock(a) - parseClock(b));
}

// ── Create appointment ────────────────────────────────────────────────────────
// Validates the slot (double-book guard mirroring computeAvailability), resolves
// price/duration/deposit server-side, upserts the customer, and writes the
// appointment. Returns { ok, appointmentId, appt } or { ok:false, code, error }
// where `code` is an HTTP status the caller can surface.
//
// `payload` is the public-booking body shape plus an optional `source`
// (default 'booking-page'; the voice AI passes 'ai-voice').
function createAppointment(db, shop, payload = {}) {
  const {
    customerName, customerPhone, customerEmail, barberId, barberName,
    serviceId, date, time, notes, customFields, inspoPhoto, vehicleSize,
    addons, source,
  } = payload;

  if (!customerName || !customerPhone || !date || !time) {
    return { ok: false, code: 400, error: 'Missing required fields' };
  }

  const s0 = db.get('settings').value() || {};
  const industry = db.get('industry').value();
  const cf = customFields || {};
  const missing = (s0.customFields || []).filter(f => f.required && !String(cf[f.key] || '').trim());
  if (missing.length) return { ok: false, code: 400, error: 'Missing required fields: ' + missing.map(f => f.label).join(', ') };

  const inspo = String(inspoPhoto || '');
  if (inspoMode(s0, industry) === 'required' && !inspo) {
    return { ok: false, code: 400, error: 'An inspiration photo is required to book.' };
  }

  // ── Double-booking guard (re-validate the slot server-side) ─────────────────
  if ((db.get('blockedDates').value() || []).some(b => b.date === date)) {
    return { ok: false, code: 409, error: 'That date is no longer available for booking.' };
  }
  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  if (new Date(date + 'T12:00:00') < todayMidnight) {
    return { ok: false, code: 400, error: 'That date has already passed.' };
  }
  {
    const dow = new Date(date + 'T12:00:00').getDay();
    const occ = occupyingStatusKeys(s0);
    const dayAppts = (db.get('appointments').value() || []).filter(a => a.date === date && occ.includes(a.status));
    const workingBarbers = (db.get('barbers').value() || []).filter(b =>
      b.active !== false &&
      (b.schedule?.workDays || [1, 2, 3, 4, 5, 6]).includes(dow) &&
      barberSlotList(b).includes(time));
    const reqSvc = serviceId ? (db.get('services').value() || []).find(x => x.id === serviceId) : null;
    const reqStart = parseClock(time);
    const reqEnd = reqStart + ((reqSvc && Number(reqSvc.duration)) || 30);
    const overlaps = a => { const aStart = parseClock(a.time); const aEnd = aStart + (Number(a.duration) || 30); return reqStart < aEnd && aStart < reqEnd; };
    if (barberId) {
      const b = workingBarbers.find(x => x.id === barberId);
      if (!b) return { ok: false, code: 409, error: 'That time is no longer available. Please pick another.' };
      if (dayAppts.some(a => a.barberId === barberId && overlaps(a))) {
        return { ok: false, code: 409, error: 'Sorry, that time was just booked. Please pick another.' };
      }
    } else {
      const takenAtTime = dayAppts.filter(overlaps).length;
      if (!workingBarbers.length || takenAtTime >= workingBarbers.length) {
        return { ok: false, code: 409, error: 'Sorry, that time was just booked. Please pick another.' };
      }
    }
  }

  const { getAll, upsert } = shopHelpers(db);
  const svcFromDb = serviceId ? getAll('services').find(x => x.id === serviceId) : null;
  if (!svcFromDb) return { ok: false, code: 400, error: 'Please choose a service. If you already did, refresh and try again.' };

  const selAddonIds = Array.isArray(addons) ? addons : [];
  const chosenAddons = (s0.addons || []).filter(a => selAddonIds.includes(a.id)).map(a => ({ id: a.id, name: a.name, price: Number(a.price) || 0 }));
  const addonsTotal = chosenAddons.reduce((t, a) => t + a.price, 0);
  const basePrice = servicePrice(svcFromDb, vehicleSize);
  const price = basePrice + addonsTotal;
  const duration = Number(svcFromDb.duration) || 45;
  const addonsCost = (s0.addons || []).filter(a => selAddonIds.includes(a.id)).reduce((t, a) => t + (Number(a.cost) || 0), 0);
  const cost = Math.round(((Number(svcFromDb.cost) || 0) + addonsCost) * 100) / 100;

  const vehicle = (cf.vehicleYear || cf.vehicleMake || cf.vehicleModel)
    ? { year: cf.vehicleYear || '', make: cf.vehicleMake || '', model: cf.vehicleModel || '', color: cf.vehicleColor || '' }
    : null;
  const _vn = x => String(x || '').trim().toLowerCase();
  const sameVehicle = (a, b) => a && b && _vn(a.year) === _vn(b.year) && _vn(a.make) === _vn(b.make) && _vn(a.model) === _vn(b.model);

  const digits = (customerPhone || '').replace(/[^0-9]/g, '');
  let custId = null;
  if (digits.length >= 10) {
    const existing = getAll('customers').find(c => (c.phone || '').replace(/[^0-9]/g, '') === digits);
    if (existing) {
      custId = existing.id;
      if (vehicle && !(existing.vehicles || []).some(v => sameVehicle(v, vehicle))) {
        existing.vehicles = [...(existing.vehicles || []), vehicle];
        upsert('customers', existing);
      }
    } else {
      custId = genId('c');
      upsert('customers', { id: custId, name: customerName, phone: customerPhone, email: customerEmail || '', source: source || 'booking-page', notes: '', loyaltyPoints: 0, noShows: 0, preferredBarberId: barberId || null, isFleet: false, companyName: '', vehicles: vehicle ? [vehicle] : [], createdAt: today() });
    }
  }

  const stripeConnected = !!(s0.stripe?.connectAccountId && s0.stripe?.onboardingComplete);
  const squareConnected = !!(s0.square?.accessToken && s0.square?.locationId) || require('./payments/square').enabled();
  const needsDeposit = !!(s0.deposit?.enabled && (stripeConnected || squareConnected));

  const apptId = genId('a');
  const appt = {
    id: apptId, customerId: custId, customerName, customerPhone, customerEmail: customerEmail || '',
    barberId: barberId || null, barberName: barberName || null, serviceId: serviceId || null,
    service: svcFromDb.name, price, cost, duration, date, time,
    status: needsDeposit ? 'pending-deposit' : 'confirmed', notes: notes || '',
    customFields: cf, vehicleSize: vehicleSize || null, addons: chosenAddons, inspoPhoto: inspo,
    source: source || 'booking-page', createdAt: new Date().toISOString(),
  };
  upsert('appointments', appt);

  // Attribution back-fill: if this booking traces to an AI-handled call the shop
  // didn't pick up, stamp the booking id onto that call so "revenue recovered" can
  // join closed jobs to the calls the AI saved. Best-effort, matched by caller
  // number; the most recent unlinked AI call wins. Runs for owner/public bookings
  // of AI-captured leads (the AI's own bookings already carry the id).
  try {
    const want = (customerPhone || '').replace(/\D/g, '').slice(-10);
    if (want.length === 10) {
      const match = getAll('calls')
        .filter(c => c && c.voiceAI && !c.staff_answered && !c.booking_id &&
          String(c.from || '').replace(/\D/g, '').slice(-10) === want)
        .sort((a, b) => new Date(b.call_started_at || b.startedAt || 0) - new Date(a.call_started_at || a.startedAt || 0))[0];
      if (match) { match.booking_id = apptId; match.outcome = 'booked'; upsert('calls', match); }
    }
  } catch (e) { /* attribution is best-effort — never block a booking */ }

  return { ok: true, appointmentId: apptId, appt };
}

module.exports = {
  parseClock, fmtClock, barberSlotList, occupyingStatusKeys, inspoMode,
  getMenu, servicePrice, computeAvailability, createAppointment,
};

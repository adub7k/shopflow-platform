// ── Lead upsert core ─────────────────────────────────────────────────────────
// Single source of truth for turning a set of parsed lead fields into a stored
// lead + the owner notifications. Shared by:
//   • the public opt-in form / Meta-via-Make intake (routes/public.js)
//   • the admin manual-add fallback (routes/admin.js) — used when the Make
//     pipeline breaks and leads have to be re-entered by hand.
// Keeping both on one implementation means a hand-entered lead behaves exactly
// like one from Meta: same phone-based dedupe (first touch wins), same owner
// email + mobile push, same attribution shape. Callers do their own input
// parsing/validation and pass already-clean fields in.
const { master, shopHelpers, genId } = require('./db');
const { notifyNewLead } = require('./email');
const { sendPush } = require('./push-instance');

// db/shop: the target shop's lowdb handle + master shop record.
// f: { name, phone, email, notes, vehicle, servicesInterested, utm, source, referrer }
// Returns { lead, isNew }.
function upsertLead(db, shop, f = {}) {
  const h = shopHelpers(db);
  const s = db.get('settings').value() || {};
  const now = new Date().toISOString();

  const name = f.name || '';
  const phone = f.phone || '';
  const email = f.email || '';
  const notes = f.notes || '';
  const vehicle = f.vehicle || null;
  const servicesInterested = Array.isArray(f.servicesInterested) ? f.servicesInterested : [];
  const utm = (f.utm && Object.keys(f.utm).length) ? f.utm : null;
  const referrer = f.referrer || '';
  const source = (f.source || 'website');

  // Dedupe by phone digits — an existing lead is enriched, not duplicated, so
  // re-running a recovery batch that overlaps leads already in the system is
  // safe. A lead with no phone (rare, admin-entered) always creates fresh.
  const digits = String(phone).replace(/\D/g, '');
  const existing = digits
    ? h.getAll('leads').find(l => String(l.phone || '').replace(/\D/g, '') === digits)
    : null;

  let lead;
  if (existing) {
    lead = existing;
    if (!lead.name && name) lead.name = name;
    if (email) lead.email = email;
    if (vehicle) lead.vehicle = vehicle;
    if (servicesInterested.length) lead.servicesInterested = servicesInterested;
    if (notes) lead.notes = [lead.notes, notes].filter(Boolean).join('\n');
    if (utm) lead.utm = utm;                 // latest campaign, for reference
    lead.formSubmits = (lead.formSubmits || 0) + 1;
    lead.lastContactAt = now;
  } else {
    lead = {
      id: genId('lead'), name, phone, email,
      location: '', source, utm, referrer,
      vehicle, servicesInterested, status: 'new',
      callCount: 0, missedCount: 0, formSubmits: 1, customerId: null, notes,
      firstContactAt: now, lastContactAt: now, createdAt: now,
    };
  }
  h.upsert('leads', lead);
  master.get('shops').find({ id: shop.id }).assign({ lastActivity: now }).write();

  // Owner email ping (fire-and-forget — a mail failure never breaks the write).
  notifyNewLead({ shop, settings: s, lead, kind: existing ? 'form-repeat' : 'form' });

  // Mobile push to the owner's phone (free, instant) — mirrors the email.
  const veh = lead.vehicle && [lead.vehicle.year, lead.vehicle.make, lead.vehicle.model].filter(Boolean).join(' ');
  sendPush(shop.id, {
    title: `🔔 New lead — ${lead.name || lead.phone || 'website'}`,
    body: [lead.phone, veh, (lead.servicesInterested || []).join(', '), lead.source && `via ${lead.source}`]
      .filter(Boolean).join(' · '),
    url: '/leads',
    tag: `lead-${lead.id}`,
  }).catch(e => console.error('Lead push failed:', e.message));

  return { lead, isNew: !existing };
}

module.exports = { upsertLead };

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

// How long after alerting on a lead a re-submit of the same lead stays quiet.
// Covers the site's two-stage post (partial + final) and integration retries;
// long enough to swallow a visitor who resubmits after a typo, short enough
// that someone inquiring again later still gets through. Minutes, tunable in
// prod without a deploy.
const NOTIFY_COOLDOWN_MS = (Number(process.env.LEAD_NOTIFY_COOLDOWN_MIN) || 15) * 60 * 1000;

// A re-submit of the same inquiry repeats most of its note lines (service,
// vehicle, timeline) and adds a few (requested appointment, photos). Merge
// line-wise so the lead reads as one note instead of the same block twice.
function mergeNotes(prev, next) {
  const seen = new Set(String(prev || '').split('\n').map(l => l.trim()).filter(Boolean));
  const add = String(next || '').split('\n').map(l => l.trim()).filter(l => l && !seen.has(l));
  return [prev, ...add].filter(Boolean).join('\n');
}

// db/shop: the target shop's lowdb handle + master shop record.
// f: { name, phone, email, notes, vehicle, servicesInterested, utm, source, referrer,
//      metaLeadgenId?, metaCustomFields? }
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
  // Native Meta lead-ads (routes/meta-webhook.js) pass the Graph leadgen_id so a
  // re-delivery of the same lead can be recognised and skipped, plus whatever
  // extra Instant Form answers the shop asked for. Both are optional — every
  // other caller omits them and is unaffected.
  const metaLeadgenId = f.metaLeadgenId || null;
  const metaCustomFields = (f.metaCustomFields && Object.keys(f.metaCustomFields).length) ? f.metaCustomFields : null;

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
    if (notes) lead.notes = mergeNotes(lead.notes, notes);
    if (utm) lead.utm = utm;                 // latest campaign, for reference
    // First leadgen_id wins: if this caller already exists as a website lead and
    // then fills out a Meta form, the lead is stamped so the Meta side is
    // idempotent from then on; a later, different Meta lead for the same phone
    // doesn't overwrite the stamp (it's already deduped as one person).
    if (metaLeadgenId && !lead.metaLeadgenId) lead.metaLeadgenId = metaLeadgenId;
    if (metaCustomFields) lead.metaCustomFields = { ...(lead.metaCustomFields || {}), ...metaCustomFields };
    lead.formSubmits = (lead.formSubmits || 0) + 1;
    lead.lastContactAt = now;
  } else {
    lead = {
      id: genId('lead'), name, phone, email,
      location: '', source, utm, referrer,
      vehicle, servicesInterested, status: 'new',
      callCount: 0, missedCount: 0, formSubmits: 1, customerId: null, notes,
      firstContactAt: now, lastContactAt: now, createdAt: now,
      stageChangedAt: now,   // pipeline time-in-stage baseline
    };
    if (metaLeadgenId) lead.metaLeadgenId = metaLeadgenId;
    if (metaCustomFields) lead.metaCustomFields = metaCustomFields;
  }
  // One inquiry, one alert. A single website inquiry legitimately posts more
  // than once — the site captures the lead as soon as contact details are valid
  // (speed-to-lead) and posts again with the appointment request at the end —
  // and Make/Zapier retries and double-tapped submit buttons do the same. The
  // lead is already deduped by phone above; without this the owner's phone
  // buzzed once per POST. Re-submits inside the window are recorded silently
  // (formSubmits, merged notes) and the owner sees the full picture in the CRM;
  // a genuine second inquiry hours later still alerts, as "submitted again".
  const lastNotified = lead.notifiedAt ? Date.parse(lead.notifiedAt) : 0;
  const quiet = lastNotified && (Date.now() - lastNotified) < NOTIFY_COOLDOWN_MS;
  if (!quiet) lead.notifiedAt = now;

  h.upsert('leads', lead);
  master.get('shops').find({ id: shop.id }).assign({ lastActivity: now }).write();

  if (!quiet) {
    // Owner email ping (fire-and-forget — a mail failure never breaks the write).
    notifyNewLead({ shop, settings: s, lead, kind: existing ? 'form-repeat' : 'form' });

    // Mobile push to the owner's phone (free, instant) — mirrors the email.
    const veh = lead.vehicle && [lead.vehicle.year, lead.vehicle.make, lead.vehicle.model].filter(Boolean).join(' ');
    sendPush(shop.id, {
      title: `🔔 New lead — ${lead.name || lead.phone || 'website'}`,
      body: [lead.phone, veh, (lead.servicesInterested || []).join(', '), lead.source && `via ${lead.source}`]
        .filter(Boolean).join(' · '),
      url: '/pipeline',
      tag: `lead-${lead.id}`,
    }).catch(e => console.error('Lead push failed:', e.message));
  }

  return { lead, isNew: !existing, notified: !quiet };
}

// ── Contact-field resolution (Meta/Make robustness) ───────────────────────────
// Meta lead-ad payloads forwarded by Make don't always use our name/phone/email
// keys. A mis-mapped scenario commonly forwards Meta's native field names
// (full_name, first_name/last_name, phone_number) or the raw field_data array.
// Resolve from every common shape so a lead is captured even when the mapping
// isn't exactly name/phone/email. The website form sends name/phone/email
// directly, so those still win (checked first) — behavior there is unchanged.
function pick(body, keys) {
  const lower = {};
  Object.keys(body || {}).forEach(k => { lower[k.toLowerCase()] = body[k]; });
  for (const k of keys) {
    const v = lower[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}
// Meta raw lead: field_data: [{ name:'phone_number', values:['+1…'] }, …]
function fromFieldData(body, keys) {
  const fd = body && (body.field_data || body.fieldData);
  if (!Array.isArray(fd)) return '';
  for (const f of fd) {
    const nm = String((f && f.name) || '').toLowerCase();
    if (keys.includes(nm)) {
      const v = Array.isArray(f && f.values) ? f.values[0] : (f && f.value);
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return '';
}
function resolveContact(body = {}) {
  let name = pick(body, ['name', 'full_name', 'fullname', 'fullname ']) || fromFieldData(body, ['full_name', 'name']);
  if (!name) {
    const first = pick(body, ['first_name', 'firstname']) || fromFieldData(body, ['first_name']);
    const last  = pick(body, ['last_name', 'lastname'])  || fromFieldData(body, ['last_name']);
    name = [first, last].filter(Boolean).join(' ').trim();
  }
  const phone = pick(body, ['phone', 'phone_number', 'phonenumber', 'mobile', 'mobile_number', 'mobilenumber'])
    || fromFieldData(body, ['phone_number', 'phone']);
  const email = pick(body, ['email', 'email_address', 'emailaddress'])
    || fromFieldData(body, ['email']);
  return { name, phone, email };
}

// ── Integration payload capture (diagnostics) ─────────────────────────────────
// A tiny in-memory ring of the most recent integration (Meta/Make) lead POSTs,
// so the admin panel can show exactly what an upstream sent — the fast way to
// tell a blank "Test Lead" apart (empty {} from Make vs. real data under keys we
// didn't map). In-memory only (no DB, cleared on restart): it's a live debugging
// aid, not a record. Values are truncated so a payload can't bloat memory.
const _payloads = [];
function recordLeadPayload(shopSlug, body) {
  try {
    const snapshot = {};
    Object.keys(body || {}).slice(0, 40).forEach(k => {
      let v = body[k];
      if (v && typeof v === 'object') { try { v = JSON.stringify(v).slice(0, 300); } catch { v = '[object]'; } }
      else v = String(v).slice(0, 200);
      snapshot[k] = v;
    });
    _payloads.unshift({ at: new Date().toISOString(), shopSlug, keyCount: Object.keys(body || {}).length, snapshot });
    while (_payloads.length > 8) _payloads.pop();
  } catch (e) { /* diagnostics must never break intake */ }
}
function getLeadPayloads() { return _payloads; }

module.exports = { upsertLead, resolveContact, recordLeadPayload, getLeadPayloads };

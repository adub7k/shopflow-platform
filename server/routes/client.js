// ── Client portal: scoped-down lead view ─────────────────────────────────────
// A read-mostly lead list for a shop's outside collaborators (e.g. a marketing
// vendor). THREAT MODEL: assume everything returned here is read by a competing
// vendor — so this is enforced server-side, not by hiding UI:
//   • client tokens work ONLY here (requireAuth rejects them everywhere else)
//   • responses are built from an explicit whitelist (toClientLead) — never a
//     spread of the stored lead — so ad spend, campaign/ad attribution, UTM,
//     revenue, quality scores, response times, and notes can never leak
//   • source is coarsened to channel level, status to new|contacted
//   • no export endpoint, no aggregates beyond the result count
// Storage is untouched: internal leads keep every field; this is a projection.
const router = require('express').Router();
const { master, shopRoute, genId } = require('../db');
const { requireClient } = require('../middleware');
const { upsertLead } = require('../leads-core');

// ── Activity journal ──────────────────────────────────────────────────────────
// Every client action is recorded server-side in the shop's own DB, so the
// owner can see exactly what an outside login did (Settings → Team → Activity).
// Append-only, newest first, capped so it can't bloat the shop file.
const ACTIVITY_CAP = 400;
function clientWho(accountId) {
  const a = master.get('accounts').find({ id: accountId }).value() || {};
  return { email: a.email || '', name: a.name || a.email || 'Client' };
}
function logClientActivity(db, accountId, action, lead) {
  try {
    if (db.get('clientActivity').value() === undefined) db.set('clientActivity', []).write();
    const { email, name } = clientWho(accountId);
    db.get('clientActivity').unshift({
      id: genId('act'), at: new Date().toISOString(),
      accountId, email, name, action,
      leadId: lead ? lead.id : null,
      leadName: lead ? (lead.name || lead.phone || '') : '',
    }).write();
    const excess = db.get('clientActivity').size().value() - ACTIVITY_CAP;
    if (excess > 0) db.set('clientActivity', db.get('clientActivity').take(ACTIVITY_CAP).value()).write();
  } catch (e) { console.error('client activity log failed:', e.message); }
}
// List views are throttled to one entry per account per 30 min, so the feed
// reads like sessions ("viewed the lead list") instead of one row per refresh.
function logClientView(db, accountId) {
  const recent = (db.get('clientActivity').value() || [])
    .find(a => a.accountId === accountId);
  if (recent && Date.now() - new Date(recent.at).getTime() < 30 * 60000) return;
  logClientActivity(db, accountId, 'view');
}

// ── Response mapper ───────────────────────────────────────────────────────────
// Leads come in two shapes: call-tracking/public-form leads (camelCase, status
// new|contacted|booked|closed — leads-core.js) and website-intake leads
// (snake_case, NEW_LEAD state machine — website-leads.router.js). Both funnel
// through here into one flat, whitelisted shape.

const CLIENT_SOURCES = ['Web Form', 'Call', 'Meta', 'Google', 'Other'];

function coarsenSource(l) {
  const rank = (s) => {
    s = String(s || '').toLowerCase();
    if (/\b(meta|facebook|fb|instagram|ig)\b/.test(s))                    return 'Meta';
    if (/\b(google|gmb|lsa|maps)\b/.test(s))                              return 'Google';
    if (/\b(call|phone|missed|voicemail|receptionist|ai-voice)\b/.test(s)) return 'Call';
    if (/\b(website|web|form|landing|booking)\b/.test(s))                 return 'Web Form';
    return null;
  };
  // Primary source field wins (a phone-call lead stays "Call" even when it
  // carries Facebook UTM data); weaker signals only break ties when the
  // primary is missing or unrecognized.
  return rank(l.source)
    || rank([l.medium, l.channel, l.utm && (l.utm.utm_source || l.utm.source)].filter(Boolean).join(' '))
    || (l.fbclid ? 'Meta' : (l.gclid ? 'Google' : 'Other'));
}

const isNewStatus = (l) => l.status === 'new' || l.status === 'NEW_LEAD';

// Built from scratch on purpose — NEVER spread the stored lead here. Any new
// internal field stays internal unless it is explicitly added below.
function toClientLead(l) {
  const veh = l.vehicle || {};
  return {
    id: l.id,
    createdAt: l.createdAt || l.created_at || l.firstContactAt || null,
    name: l.name || '',
    phone: l.phone || '',
    email: l.email || '',
    serviceRequested: l.service_requested
      || (Array.isArray(l.servicesInterested) ? l.servicesInterested.filter(Boolean).join(', ') : ''),
    vehicle: [veh.year || l.vehicle_year, veh.make || l.vehicle_make,
              veh.model || l.vehicle_model].filter(Boolean).join(' ').trim() || null,
    source: coarsenSource(l),
    status: isNewStatus(l) ? 'new' : 'contacted',
  };
}

// ── GET /api/client/leads — list, newest first ────────────────────────────────
// ?status=new|contacted  ?from=YYYY-MM-DD  ?to=YYYY-MM-DD  ?page=1  ?limit=50
// Defaults to the last 90 days. Shop comes from the token (shopRoute/req.shopId).
router.get('/api/client/leads', requireClient, shopRoute(async (req, res, db, h) => {
  const parseDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
  const fromQ = parseDay(req.query.from), toQ = parseDay(req.query.to);
  const from = fromQ ? new Date(fromQ + 'T00:00:00').getTime()
                     : Date.now() - 90 * 86400000;
  const to = toQ ? new Date(toQ + 'T23:59:59.999').getTime() : Infinity;
  const statusQ = ['new', 'contacted'].includes(req.query.status) ? req.query.status : null;

  const createdOf = (l) => new Date(l.createdAt || l.created_at || l.firstContactAt || 0).getTime();
  const all = h.getAll('leads')
    .filter(l => { const t = createdOf(l); return t >= from && t <= to; })
    .map(toClientLead)
    .filter(l => !statusQ || l.status === statusQ)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  logClientView(db, req.accountId);

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
  res.json({
    ok: true,
    leads: all.slice((page - 1) * limit, page * limit),
    total: all.length,   // simple result count — the only aggregate this API exposes
    page, limit,
  });
}));

// ── POST /api/client/leads — manually log a walk-in / phone-in ────────────────
// Accepts only whitelisted fields; source must be Call or Web Form; status is
// forced to new; shop is stamped from the token. Goes through upsertLead so a
// hand-logged lead gets the same phone dedupe + owner notification as any other.
router.post('/api/client/leads', requireClient, shopRoute(async (req, res, db) => {
  const b = req.body || {};
  const name  = String(b.name || '').trim().slice(0, 120);
  const phone = String(b.phone || '').trim().slice(0, 30);
  const email = String(b.email || '').trim().slice(0, 200);
  const serviceRequested = String(b.serviceRequested || '').trim().slice(0, 200);
  const vehicleStr = String(b.vehicle || '').trim().slice(0, 120);
  const source = b.source;

  if (!name || !phone) return res.status(400).json({ ok: false, error: 'Name and phone are required' });
  if (String(phone).replace(/\D/g, '').length < 7)
    return res.status(400).json({ ok: false, error: 'Enter a valid phone number' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ ok: false, error: 'Enter a valid email address' });
  if (!['Call', 'Web Form'].includes(source))
    return res.status(400).json({ ok: false, error: 'Source must be "Call" or "Web Form"' });

  // "2019 Ford F-150" → {year, make, model}; a leading 4-digit token is the year.
  let vehicle = null;
  if (vehicleStr) {
    const parts = vehicleStr.split(/\s+/);
    const year = /^(19|20)\d{2}$/.test(parts[0]) ? parts.shift() : '';
    vehicle = { year, make: parts.shift() || '', model: parts.join(' ') };
  }

  const shop = master.get('shops').find({ id: req.shopId }).value();
  const { lead, isNew } = upsertLead(db, shop, {
    name, phone, email, vehicle,
    servicesInterested: serviceRequested ? [serviceRequested] : [],
    source: source === 'Call' ? 'call' : 'website',
  });
  // Internal attribution only — toClientLead never exposes these fields.
  if (isNew) {
    lead.createdBy = clientWho(req.accountId).email;
    db.get('leads').find({ id: lead.id }).assign({ createdBy: lead.createdBy }).write();
  }
  logClientActivity(db, req.accountId, 'lead.created', lead);
  res.status(201).json({ ok: true, lead: toClientLead(lead) });
}));

// ── PATCH /api/client/leads/:id/status — new → contacted, nothing else ────────
router.patch('/api/client/leads/:id/status', requireClient, shopRoute(async (req, res, db, h) => {
  // The lead is looked up in the token shop's own DB file, so a foreign id can
  // only ever 404 — cross-tenant reads are structurally impossible here.
  const lead = h.getById('leads', req.params.id);
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });
  if ((req.body || {}).status !== 'contacted')
    return res.status(422).json({ ok: false, error: 'Only "contacted" is allowed' });
  if (!isNewStatus(lead))
    return res.status(409).json({ ok: false, error: 'This lead has already been contacted' });

  // Advance whichever status machine this lead runs, stamping the same
  // first-response fields routes/shop.js stamps so speed-to-lead metrics stay
  // coherent no matter which surface marks the contact.
  const now = new Date().toISOString();
  if (lead.channel === 'website') {
    lead.status = 'CONTACTED';
    if (!lead.first_response_at) {
      lead.first_response_at = now;
      lead.response_time_seconds = Math.max(0, Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 1000));
    }
    if (lead.contact_status === 'UNCONTACTED') lead.contact_status = 'ATTEMPTED';
    lead.updated_at = now;
  } else {
    lead.status = 'contacted';
    if (!lead.firstResponseAt) lead.firstResponseAt = now;
  }
  // Internal attribution only — toClientLead never exposes these fields.
  lead.contactedBy = clientWho(req.accountId).email;
  lead.contactedAt = now;
  h.upsert('leads', lead);
  logClientActivity(db, req.accountId, 'lead.contacted', lead);
  res.json({ ok: true, lead: toClientLead(lead) });
}));

module.exports = router;
// Login events are written by routes/auth.js on successful client sign-in.
module.exports.logClientActivity = logClientActivity;
// Exposed for tests: the whitelist mapper is the security boundary here.
module.exports._internal = { toClientLead, coarsenSource, CLIENT_SOURCES };

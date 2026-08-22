// ── Native Meta (Facebook) Lead Ads ingestion ────────────────────────────────
// Replaces the Make.com hop: Meta posts leadgen notifications straight here, we
// pull the answers from the Graph API and hand them to leads-core.upsertLead —
// the same function the website opt-in form and the admin manual-add use. A
// lead-ad lead therefore behaves byte-identically to a website lead: same phone
// dedupe (first touch wins), same owner email + mobile push, same Pipeline row.
//
// Notes on the two hard requirements Meta imposes:
//   • Signature: X-Hub-Signature-256 is HMAC-SHA256 over the RAW request body.
//     Re-serializing req.body would change byte-for-byte (key order, unicode
//     escaping) and every signature would fail — index.js stashes the raw buffer
//     on req.rawBody via express.json's verify hook, for this path only.
//   • Latency: Meta retries on a slow or non-200 response and disables the
//     subscription after repeated failures. So we ACK first, work after. Nothing
//     downstream of the ACK is allowed to throw.
const express = require('express');
const crypto  = require('crypto');

const { master, getShopDb } = require('../db');
const { upsertLead, resolveContact } = require('../leads-core');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
const GRAPH_TIMEOUT_MS = 10000;

const log  = (...a) => console.log('[meta-webhook]', ...a);
const warn = (...a) => console.warn('[meta-webhook]', ...a);
const err  = (...a) => console.error('[meta-webhook]', ...a);

// Constant-time string compare. timingSafeEqual throws on length mismatch, so
// that case is answered before it's reached — the length of a signature digest
// is fixed and public, so leaking it tells an attacker nothing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Idempotency ───────────────────────────────────────────────────────────────
// Meta re-delivers: the same leadgen_id arrives again after any hiccup, and
// sometimes twice within milliseconds. The durable check is metaLeadgenId on the
// stored lead; this in-memory ring catches the burst case where the second
// delivery lands before the first one has written. Bounded so a long-running
// process can't grow it without limit.
const inFlight = new Set();
const INFLIGHT_MAX = 500;
function claim(leadgenId) {
  if (inFlight.has(leadgenId)) return false;
  inFlight.add(leadgenId);
  if (inFlight.size > INFLIGHT_MAX) inFlight.delete(inFlight.values().next().value);
  return true;
}

// ── Tenant routing ────────────────────────────────────────────────────────────
// page_id → shop, via metaPageId on the master shop record. Same shape as
// twilioFromNumber: one file, one scan, editable from the admin panel. Page ids
// are numeric strings in Meta's payloads but may arrive as numbers — compare as
// strings so a JSON number never silently misses.
function shopForPage(pageId) {
  const want = String(pageId || '').trim();
  if (!want) return null;
  return (master.get('shops').value() || [])
    .find(s => s && s.active && String(s.metaPageId || '').trim() === want) || null;
}

// The shop's own long-lived page token wins; META_PAGE_ACCESS_TOKEN is the
// single-shop fallback, mirroring how TWILIO_DEFAULT_FROM backs shopFromNumber.
function tokenForShop(shop) {
  return String((shop && shop.metaPageToken) || process.env.META_PAGE_ACCESS_TOKEN || '').trim();
}

// ── Graph lead retrieval ──────────────────────────────────────────────────────
// The webhook carries only ids — the answers have to be fetched. Node 18+ has
// global fetch; the timeout matters because this runs after the ACK and a hung
// socket would otherwise pin the handler open indefinitely.
async function fetchLead(leadgenId, token) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(leadgenId)}`
    + `?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
  const body = await res.text();
  if (!res.ok) {
    // Log the Graph error verbatim — an expired token and a lead the app can't
    // read look identical from the outside, and the message names which it is.
    throw new Error(`Graph ${res.status}: ${body.slice(0, 400)}`);
  }
  try { return JSON.parse(body); }
  catch { throw new Error(`Graph returned non-JSON: ${body.slice(0, 200)}`); }
}

// ── field_data mapping ────────────────────────────────────────────────────────
// Map by field NAME, never by index. Form field order changes whenever the shop
// edits the Instant Form, and an index-based map would silently write a phone
// number into the email column with no error anywhere.
const KNOWN_FIELDS = new Set([
  'full_name', 'name', 'first_name', 'last_name',
  'phone_number', 'phone', 'mobile_number',
  'email', 'email_address',
]);

// Anything that isn't a contact field is a real answer the shop asked for
// ("Which service?", "What's your vehicle?") — preserved as a { name: value }
// object AND folded into the lead's notes, so the owner reads the answers in the
// CRM instead of only in Ads Manager.
function splitFields(fieldData) {
  const custom = {};
  (Array.isArray(fieldData) ? fieldData : []).forEach(f => {
    const name = String((f && f.name) || '').trim();
    if (!name || KNOWN_FIELDS.has(name.toLowerCase())) return;
    const value = Array.isArray(f && f.values) ? f.values.filter(v => v != null).join(', ')
                : (f && f.value != null) ? String(f.value) : '';
    if (String(value).trim()) custom[name] = String(value).trim();
  });
  return custom;
}

// Turn the custom answers into readable note lines. leads-core merges notes
// line-wise on re-submit, so this format survives a lead being enriched later.
function notesFrom(custom, ids) {
  const lines = Object.entries(custom).map(([k, v]) => {
    const label = k.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `${label}: ${v}`;
  });
  lines.push(`Meta lead ad — form ${ids.formId || '?'} · ad ${ids.adId || '?'}`);
  return lines.join('\n').slice(0, 1000);
}

// ── Process one leadgen change ────────────────────────────────────────────────
// Everything here runs AFTER the 200 has gone back to Meta. It must never throw
// and never reject — a bad page id or a dead token is a logged no-op, not a
// crash that takes the other tenants' webhooks down with it.
async function processLeadgen(value = {}) {
  const leadgenId = String(value.leadgen_id || '').trim();
  const pageId    = String(value.page_id || '').trim();
  const formId    = String(value.form_id || '').trim();
  const adId      = String(value.ad_id || '').trim();

  if (!leadgenId) return warn('change with no leadgen_id, ignoring:', JSON.stringify(value).slice(0, 200));

  const shop = shopForPage(pageId);
  if (!shop) {
    // Loud, and deliberately not an error: an unmapped page means a shop was
    // connected in Meta before metaPageId was set on their record here. The fix
    // is a one-field admin edit, and the log line says exactly what to enter.
    return warn(
      `UNMATCHED PAGE — no active shop has metaPageId="${pageId}" (leadgen_id=${leadgenId}, form_id=${formId}). ` +
      `Lead was NOT saved. Set metaPageId="${pageId}" on the right shop via PATCH /api/admin/shop/:shopId.`
    );
  }
  log(`matched tenant shop=${shop.id} (${shop.shopName}) page=${pageId} leadgen_id=${leadgenId}`);

  if (!claim(leadgenId)) return log(`duplicate in-flight, skipping leadgen_id=${leadgenId}`);

  const db = getShopDb(shop.id);

  // Durable idempotency check, before the Graph call — a re-delivery shouldn't
  // spend an API call to rediscover a lead we already have.
  const already = (db.get('leads').value() || []).find(l => l && l.metaLeadgenId === leadgenId);
  if (already) return log(`already ingested leadgen_id=${leadgenId} as lead=${already.id}, skipping`);

  const token = tokenForShop(shop);
  if (!token) {
    return err(
      `NO PAGE TOKEN for shop=${shop.id} (${shop.shopName}) page=${pageId} leadgen_id=${leadgenId}. ` +
      `Lead was NOT saved. Set metaPageToken on the shop record, or META_PAGE_ACCESS_TOKEN in the environment.`
    );
  }

  let raw;
  try {
    raw = await fetchLead(leadgenId, token);
  } catch (e) {
    return err(`GRAPH FETCH FAILED leadgen_id=${leadgenId} shop=${shop.id} — ${e.message}`);
  }
  const fieldNames = (raw.field_data || []).map(f => f && f.name).filter(Boolean);
  log(`fetched leadgen_id=${leadgenId} fields=[${fieldNames.join(', ')}]`);

  // Contact resolution is leads-core's — it already reads Meta's field_data
  // shape and its native key names, and it's the same code the Make path used,
  // so a native lead and a forwarded one resolve identically.
  const contact = resolveContact(raw);
  const name  = contact.name.slice(0, 80);
  const phone = contact.phone.slice(0, 25);
  const email = contact.email.slice(0, 120);

  const custom = splitFields(raw.field_data);

  // A Meta lead with no phone is possible (a form that only asks for email), and
  // it's still a real lead — leads-core creates it fresh rather than deduping.
  // Name it so it's identifiable in the list rather than a blank row.
  if (!name && !phone && !email) {
    warn(`leadgen_id=${leadgenId} returned no contact fields — saving anyway so it isn't lost silently`);
  }

  let saved;
  try {
    saved = upsertLead(db, shop, {
      name: name || 'Facebook Lead',
      phone, email,
      notes: notesFrom(custom, { formId, adId }),
      source: 'facebook',
      utm: { source: 'facebook', medium: 'lead-ad', campaign: adId || '', content: formId || '' },
      metaLeadgenId: leadgenId,
      metaCustomFields: custom,
    });
  } catch (e) {
    return err(`SAVE FAILED leadgen_id=${leadgenId} shop=${shop.id} — ${e.stack || e.message}`);
  }

  log(
    `saved lead=${saved.lead.id} shop=${shop.id} leadgen_id=${leadgenId} ` +
    `${saved.isNew ? 'NEW' : 'merged into existing lead (phone match)'} ` +
    `notified=${saved.notified} name="${saved.lead.name}" phone="${saved.lead.phone}"`
  );
}

// Walk the batch. Meta can pack several pages and several leads into one POST,
// and one bad entry must not stop the rest.
async function processPayload(body = {}) {
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const changes = entries.flatMap(e => Array.isArray(e && e.changes) ? e.changes : []);
  const leadgen = changes.filter(c => c && c.field === 'leadgen' && c.value);
  const skipped = changes.length - leadgen.length;
  log(`payload: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${leadgen.length} leadgen change(s)` +
      (skipped > 0 ? `, ${skipped} non-leadgen change(s) ignored` : ''));

  for (const c of leadgen) {
    try { await processLeadgen(c.value); }
    catch (e) { err('unexpected processing error:', e.stack || e.message); }
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = express.Router();

// GET /webhooks/meta — subscription verification handshake.
// Meta calls this once when the webhook URL is saved. The challenge must come
// back as the raw body with no JSON wrapper, or the subscription won't verify.
router.get('/webhooks/meta', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected  = process.env.META_VERIFY_TOKEN;

  if (!expected) {
    err('verification attempted but META_VERIFY_TOKEN is not set — refusing');
    return res.sendStatus(403);
  }
  if (token && safeEqual(token, expected)) {
    log(`verification OK (mode=${mode || 'none'}) — echoing challenge`);
    return res.status(200).type('text/plain').send(String(challenge == null ? '' : challenge));
  }
  warn(`verification REJECTED — hub.verify_token did not match META_VERIFY_TOKEN (mode=${mode || 'none'})`);
  return res.sendStatus(403);
});

// POST /webhooks/meta — leadgen notifications.
router.post('/webhooks/meta', (req, res) => {
  const secret = process.env.META_APP_SECRET;
  const sig    = req.get('X-Hub-Signature-256') || '';

  log(`inbound POST — ${req.rawBody ? req.rawBody.length : 0} bytes, signature ${sig ? 'present' : 'MISSING'}`);

  if (!secret) {
    err('META_APP_SECRET is not set — rejecting. Set it in the Railway environment.');
    return res.sendStatus(403);
  }
  if (!req.rawBody) {
    // Means the express.json verify hook in index.js didn't capture this path —
    // a wiring bug, not a caller error. Loud, because every lead is dropped.
    err('no raw body captured — the express.json verify hook is not covering /webhooks/meta. Rejecting.');
    return res.sendStatus(400);
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  if (!safeEqual(sig, expected)) {
    warn('SIGNATURE MISMATCH — rejecting. (Wrong META_APP_SECRET, or a forged request.)');
    return res.sendStatus(403);
  }

  // ACK first. Everything below runs detached — Meta is already satisfied, and a
  // slow Graph call or a mail hiccup can no longer cost us the subscription.
  res.sendStatus(200);

  const body = req.body;
  setImmediate(() => {
    processPayload(body).catch(e => err('processPayload rejected:', e.stack || e.message));
  });
});

module.exports = router;
module.exports.processPayload = processPayload; // exported for local testing

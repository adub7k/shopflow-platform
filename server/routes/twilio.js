// ── Inbound Twilio webhooks: call screening → leads + missed-call auto-SMS ──────
// These endpoints are PUBLIC (no JWT) — Twilio calls them directly. Each shop's
// tracking number is configured in the Twilio console to POST to
//   /api/twilio/voice/<shopId>
// so the shop is resolved from the URL path (no number→shop reverse lookup).
//
// Flow:
//   1. voice/:shopId      — call arrives → log it, upsert a lead, return <Dial> TwiML
//                           that rings the shop's real phone with a whisper.
//   2. whisper/:shopId    — played to the SHOP when they pick up ("press any key").
//   3. screen/:shopId     — keypress handler → empty TwiML bridges the two legs.
//   4. complete/:shopId   — <Dial> action callback → if the shop didn't answer,
//                           mark the call missed and fire the auto-SMS to the caller.
const router = require('express').Router();
const twilio = require('twilio');
const {
  master, getShopDb, shopHelpers, shopFromNumber, buildSms,
  twilioClient, genId, toE164,
} = require('../db');
const { runIntake } = require('../receptionist/intake');

const VoiceResponse = twilio.twiml.VoiceResponse;

// Fail closed. These webhooks are public and would otherwise let anyone forge
// inbound calls — creating spam leads and, worse, triggering missed-call SMS
// FROM the shop's number TO an attacker-chosen number (SMS pumping / toll fraud).
// So whenever a Twilio auth token is configured (i.e. production), a valid Twilio
// signature is REQUIRED. Set TWILIO_VALIDATE_SIGNATURE=false only as an escape
// hatch when a proxy rewrites the public URL and you must use PUBLIC_URL to fix
// it. With no token (local dev) there is nothing to validate against, so we skip.
// Build every plausible URL Twilio could have signed, so a mismatched PUBLIC_URL
// can't 403 the line. Twilio signs the EXACT public URL it requested; behind
// Railway's proxy the forwarded host is authoritative, but an explicit PUBLIC_URL
// may also be configured. We collect both (plus the X-Forwarded-* reconstruction)
// and accept if ANY validates — strictly more permissive than matching one base,
// so this can never reject a request the old single-base check would have allowed.
// (The 6/25 outage was exactly this: PUBLIC_URL not matching the real webhook host
//  → every signed request failed → <Reject/> → callers hung up.)
function twilioSignedUrlCandidates(req) {
  const seen = new Set();
  const add = (base) => { if (base) { const u = base.replace(/\/+$/, '') + req.originalUrl; if (!seen.has(u)) seen.add(u); } };
  if (process.env.PUBLIC_URL) add(process.env.PUBLIC_URL);
  add(`${req.protocol}://${req.get('host')}`);
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const xfHost  = String(req.headers['x-forwarded-host']  || '').split(',')[0].trim();
  if (xfProto && xfHost) add(`${xfProto}://${xfHost}`);
  return [...seen];
}

function verifyTwilio(req, res, next) {
  if (!process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_VALIDATE_SIGNATURE === 'false') return next();
  const sig = req.headers['x-twilio-signature'];
  const params = req.body || {};
  const urls = twilioSignedUrlCandidates(req);
  const ok = !!sig && urls.some(url => {
    try { return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, sig, url, params); }
    catch (e) { return false; }
  });
  if (ok) return next();
  console.warn('Twilio signature validation failed for', urls.join(' | '));
  return res.status(403).type('text/xml').send('<Response><Reject/></Response>');
}

// Resolve shop context or null. Returns { shopId, db, h, settings, shopName, realPhone }.
// Accepts either the shop's UUID id or its slug in the URL — the slug is the
// human-friendly identifier (same as /shop/<slug>) and far less error-prone to
// paste into the Twilio console. ctx.shopId is always the resolved UUID, so the
// dial/whisper/complete callbacks we generate downstream are id-based regardless.
function shopCtx(idOrSlug) {
  const shops = master.get('shops');
  const shop = shops.find({ id: idOrSlug }).value() || shops.find({ slug: idOrSlug }).value();
  if (!shop || shop.active === false) return null;
  const db = getShopDb(shop.id);
  const h = shopHelpers(db);
  const settings = db.get('settings').value() || {};
  return { shopId: shop.id, db, h, settings, shop, shopName: settings.shopName || shop.shopName || 'the shop', realPhone: settings.phone || '' };
}

const callTrackingOn = (settings) => settings.callTracking?.enabled !== false; // default on

// ── 1. Incoming call ────────────────────────────────────────────────────────────
router.post('/api/twilio/voice/:shopId', verifyTwilio, (req, res) => {
  const vr = new VoiceResponse();
  const ctx = shopCtx(req.params.shopId);
  const fromRaw = req.body.From || '';
  const callSid = req.body.CallSid || genId('call');

  // Unknown shop, or no forwarding number on file → take a message gracefully.
  const realE164 = ctx ? toE164(ctx.realPhone) : null;
  if (!ctx || !realE164) {
    vr.say('Thanks for calling. Please leave us a message after the tone, or text this number and we will get right back to you.');
    return res.type('text/xml').send(vr.toString());
  }

  // Log the call as ringing + upsert the lead (deduped by caller number).
  const lead = upsertLeadFromCall(ctx, fromRaw, req.body.FromCity, req.body.FromState);
  ctx.h.upsert('calls', {
    id: callSid, leadId: lead.id, callSid,
    from: fromRaw, to: req.body.To || '',
    direction: 'inbound', status: 'ringing', missed: false, autoSmsSent: false,
    startedAt: new Date().toISOString(),
  });
  master.get('shops').find({ id: ctx.shopId }).assign({ lastActivity: new Date().toISOString() }).write();

  // Ring the real phone. answerOnBridge → caller hears ringing, not silence.
  // The <Number url> whisper plays to the shop before the legs bridge.
  const dial = vr.dial({
    answerOnBridge: true,
    callerId: req.body.To || undefined,     // show the tracking number as caller ID
    timeout: 20,
    action: `/api/twilio/voice/complete/${ctx.shopId}`,
    method: 'POST',
  });
  // Thread the parent (inbound) CallSid through the whisper/screen legs so the
  // screen handler can mark THIS call as genuinely accepted (the whisper/screen
  // run on the child leg, whose own CallSid differs from the parent's).
  dial.number({ url: `/api/twilio/voice/whisper/${ctx.shopId}?callSid=${encodeURIComponent(callSid)}`, method: 'POST' }, realE164);
  res.type('text/xml').send(vr.toString());
});

// ── 2. Whisper (played to the shop staff who answers) ───────────────────────────
router.post('/api/twilio/voice/whisper/:shopId', verifyTwilio, (req, res) => {
  const vr = new VoiceResponse();
  const callSid = encodeURIComponent(req.query.callSid || '');
  const gather = vr.gather({ numDigits: 1, timeout: 8, action: `/api/twilio/voice/screen/${req.params.shopId}?callSid=${callSid}`, method: 'POST' });
  gather.say('You have a new lead from Shop Flow. Press any key to take the call.');
  // No keypress → drop this leg so the call rings out to missed (auto-SMS + voicemail).
  vr.hangup();
  res.type('text/xml').send(vr.toString());
});

// ── 3. Screen keypress → bridge ─────────────────────────────────────────────────
// An empty <Response> tells Twilio to connect the two legs. The keypress is the
// ONLY reliable signal the shop actually took the call — DialCallStatus=completed
// is also reported when the whisper is screened out or a carrier voicemail
// answers the forward leg, so we record acceptance here, keyed by parent CallSid.
router.post('/api/twilio/voice/screen/:shopId', verifyTwilio, (req, res) => {
  const ctx = shopCtx(req.params.shopId);
  const callSid = req.query.callSid;
  if (ctx && callSid) {
    const call = ctx.h.getById('calls', callSid);
    if (call) { call.accepted = true; ctx.h.upsert('calls', call); }
  }
  res.type('text/xml').send(new VoiceResponse().toString());
});

// ── 4. Dial finished → detect missed + auto-SMS + offer voicemail ───────────────
router.post('/api/twilio/voice/complete/:shopId', verifyTwilio, (req, res) => {
  const vr = new VoiceResponse();
  const ctx = shopCtx(req.params.shopId);
  const dialStatus = req.body.DialCallStatus || '';      // completed|no-answer|busy|failed|canceled
  const callSid = req.body.CallSid;

  if (!ctx || !callSid) { vr.hangup(); return res.type('text/xml').send(vr.toString()); }

  const call = ctx.h.getById('calls', callSid) || { id: callSid };
  // A call only counts as TAKEN if the shop pressed a key to accept (set by the
  // screen handler). DialCallStatus='completed' is NOT sufficient on its own —
  // a screen-out or a carrier voicemail answering the forward leg both report it,
  // which is why every call was wrongly showing up as "contacted".
  const accepted = !!call.accepted;
  call.status = dialStatus || call.status;
  call.missed = !accepted;
  call.durationSec = parseInt(req.body.DialCallDuration || '0', 10) || 0;
  call.endedAt = new Date().toISOString();

  const lead = call.leadId ? ctx.h.getById('leads', call.leadId) : null;
  if (lead) {
    lead.lastContactAt = call.endedAt;
    if (accepted) { lead.status = lead.status === 'new' ? 'contacted' : lead.status; }
    else          { lead.missedCount = (lead.missedCount || 0) + 1; }
  }

  // Took the call → nothing more to do.
  if (accepted) {
    ctx.h.upsert('calls', call);
    if (lead) ctx.h.upsert('leads', lead);
    vr.hangup();
    return res.type('text/xml').send(vr.toString());
  }

  // Not taken (ring-out, screen-out, busy, or carrier-VM). Auto-SMS the caller
  // if A2P + the toggle are on — but NOT when they abandoned the call before we
  // connected ('canceled'/'failed'), and at-most-once across Twilio's retries.
  const smsWorthy = ['no-answer', 'busy', 'completed'].includes(dialStatus);
  if (smsWorthy && callTrackingOn(ctx.settings) && !call.autoSmsSent) {
    const fromNum = shopFromNumber(ctx.shopId);
    const toNum = toE164(call.from);
    if (twilioClient && fromNum && toNum) {
      call.autoSmsSent = true;   // persisted below, before the async send resolves
      const body = buildSms('missedCall', { name: lead?.name, shop: ctx.shopName }, ctx.settings);
      // Fire-and-forget so the caller isn't left in silence before the voicemail prompt.
      twilioClient.messages.create({ from: fromNum, to: toNum, body })
        .then(() => ctx.h.upsert('conversations', {
          id: genId('msg'), customerId: lead?.customerId || null, leadId: lead?.id || null,
          customerName: lead?.name || call.from, type: 'sms', direction: 'outbound',
          body, sentAt: new Date().toISOString(), read: true, auto: true,
        }))
        .catch(e => console.error('Missed-call SMS failed:', e.message));
    }
  }

  ctx.h.upsert('calls', call);
  if (lead) ctx.h.upsert('leads', lead);

  // Let the caller leave a voicemail instead of dead-ending the call.
  vr.say('Sorry, we could not take your call right now. Please leave a message after the tone, and we will call you right back.');
  vr.record({
    action: `/api/twilio/voice/voicemail/${ctx.shopId}?callSid=${encodeURIComponent(callSid)}`,
    method: 'POST',
    maxLength: 120,
    playBeep: true,
    timeout: 5,
    finishOnKey: '#',
    // Ask Twilio to transcribe the voicemail; the callback feeds the AI receptionist.
    transcribe: true,
    transcribeCallback: `/api/twilio/voice/transcription/${ctx.shopId}?callSid=${encodeURIComponent(callSid)}`,
  });
  // Reached only if the caller left no message (Record falls through on no input).
  vr.say('We did not get a message. Goodbye.');
  vr.hangup();
  res.type('text/xml').send(vr.toString());
});

// ── 5. Voicemail recorded → attach it to the call + flag the lead ───────────────
router.post('/api/twilio/voice/voicemail/:shopId', verifyTwilio, (req, res) => {
  const vr = new VoiceResponse();
  const ctx = shopCtx(req.params.shopId);
  const callSid = req.query.callSid;
  const recordingSid = req.body.RecordingSid;
  const durationSec = parseInt(req.body.RecordingDuration || '0', 10) || 0;
  if (ctx && callSid && recordingSid && durationSec > 0) {
    const call = ctx.h.getById('calls', callSid);
    if (call) {
      call.voicemail = { recordingSid, durationSec, recordedAt: new Date().toISOString() };
      ctx.h.upsert('calls', call);
      const lead = call.leadId ? ctx.h.getById('leads', call.leadId) : null;
      if (lead) { lead.lastContactAt = new Date().toISOString(); ctx.h.upsert('leads', lead); }
    }
  }
  vr.say('Thanks. We will call you right back. Goodbye.');
  vr.hangup();
  res.type('text/xml').send(vr.toString());
});

// ── 5b. Answered-call recording finished → attach it to the call ─────────────────
// Fired by the <Dial recordingStatusCallback> once the bridged conversation's
// recording is ready. Stored alongside the voicemail (call.recording, distinct
// from call.voicemail) and played back through the same authed media proxy. We
// attach it whenever a sid is present; the Leads UI only surfaces it for answered
// calls, so a stray recording from a screened/carrier-VM leg stays hidden.
router.post('/api/twilio/voice/recording/:shopId', verifyTwilio, (req, res) => {
  const ctx = shopCtx(req.params.shopId);
  const callSid = req.query.callSid;
  const recordingSid = req.body.RecordingSid;
  const durationSec = parseInt(req.body.RecordingDuration || '0', 10) || 0;
  if (ctx && callSid && recordingSid) {
    const call = ctx.h.getById('calls', callSid);
    if (call) {
      call.recording = { recordingSid, durationSec, recordedAt: new Date().toISOString() };
      ctx.h.upsert('calls', call);
    }
  }
  res.type('text/xml').send('<Response></Response>'); // ACK (status callback ignores TwiML)
});

// ── 6. Voicemail transcription ready → AI receptionist intake ───────────────────
// Twilio posts the transcript here asynchronously once the voicemail recording is
// transcribed. We always store the transcript on the call; AI enrichment runs only
// if the shop enabled the receptionist and a key is configured (runIntake guards
// both). Fire-and-forget so we ACK Twilio immediately.
router.post('/api/twilio/voice/transcription/:shopId', verifyTwilio, (req, res) => {
  res.type('text/xml').send('<Response></Response>'); // ACK first; processing is async
  const ctx = shopCtx(req.params.shopId);
  const callSid = req.query.callSid;
  const transcript = req.body.TranscriptionText || '';
  if (!ctx || !callSid || !transcript || req.body.TranscriptionStatus === 'failed') return;
  // runIntake stores the transcript and (if enabled) writes lead.ai.
  Promise.resolve(runIntake(ctx, callSid, { transcript }))
    .catch(e => console.error('Receptionist intake error:', e.message));
});

// ── Lead upsert (deduped by caller phone) ───────────────────────────────────────
function upsertLeadFromCall(ctx, fromRaw, city, state) {
  const phone = String(fromRaw || '').replace(/\D/g, '');
  const now = new Date().toISOString();
  const existing = ctx.h.getAll('leads').find(l => String(l.phone || '').replace(/\D/g, '') === phone && phone);
  if (existing) {
    existing.lastContactAt = now;
    existing.callCount = (existing.callCount || 0) + 1;
    ctx.h.upsert('leads', existing);
    return existing;
  }
  const lead = {
    id: genId('lead'), name: '', phone: fromRaw,
    location: [city, state].filter(Boolean).join(', '),
    source: 'call', status: 'new',
    callCount: 1, missedCount: 0, customerId: null, notes: '',
    firstContactAt: now, lastContactAt: now, createdAt: now,
  };
  ctx.h.upsert('leads', lead);
  return lead;
}

module.exports = router;
// Exported for unit testing the signature hardening (see test/verify-twilio.test.js).
module.exports.verifyTwilio = verifyTwilio;
module.exports.twilioSignedUrlCandidates = twilioSignedUrlCandidates;

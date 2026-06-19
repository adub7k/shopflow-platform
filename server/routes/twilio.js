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

const VoiceResponse = twilio.twiml.VoiceResponse;

// Fail closed. These webhooks are public and would otherwise let anyone forge
// inbound calls — creating spam leads and, worse, triggering missed-call SMS
// FROM the shop's number TO an attacker-chosen number (SMS pumping / toll fraud).
// So whenever a Twilio auth token is configured (i.e. production), a valid Twilio
// signature is REQUIRED. Set TWILIO_VALIDATE_SIGNATURE=false only as an escape
// hatch when a proxy rewrites the public URL and you must use PUBLIC_URL to fix
// it. With no token (local dev) there is nothing to validate against, so we skip.
function verifyTwilio(req, res, next) {
  if (!process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_VALIDATE_SIGNATURE === 'false') return next();
  const sig = req.headers['x-twilio-signature'];
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const url = base + req.originalUrl;
  if (sig && twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, sig, url, req.body || {})) return next();
  console.warn('Twilio signature validation failed for', url);
  return res.status(403).type('text/xml').send('<Response><Reject/></Response>');
}

// Resolve shop context or null. Returns { shopId, db, h, settings, shopName, realPhone }.
function shopCtx(shopId) {
  const shop = master.get('shops').find({ id: shopId }).value();
  if (!shop || shop.active === false) return null;
  const db = getShopDb(shopId);
  const h = shopHelpers(db);
  const settings = db.get('settings').value() || {};
  return { shopId, db, h, settings, shop, shopName: settings.shopName || shop.shopName || 'the shop', realPhone: settings.phone || '' };
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
  dial.number({ url: `/api/twilio/voice/whisper/${ctx.shopId}`, method: 'POST' }, realE164);
  res.type('text/xml').send(vr.toString());
});

// ── 2. Whisper (played to the shop staff who answers) ───────────────────────────
router.post('/api/twilio/voice/whisper/:shopId', verifyTwilio, (req, res) => {
  const vr = new VoiceResponse();
  const gather = vr.gather({ numDigits: 1, timeout: 8, action: `/api/twilio/voice/screen/${req.params.shopId}`, method: 'POST' });
  gather.say('You have a new lead from Shop Flow. Press any key to take the call.');
  // No keypress → drop this leg so the call rings out to missed (auto-SMS fires).
  vr.hangup();
  res.type('text/xml').send(vr.toString());
});

// ── 3. Screen keypress → bridge ─────────────────────────────────────────────────
// An empty <Response> tells Twilio to connect the two legs.
router.post('/api/twilio/voice/screen/:shopId', verifyTwilio, (req, res) => {
  res.type('text/xml').send(new VoiceResponse().toString());
});

// ── 4. Dial finished → detect missed + auto-SMS ─────────────────────────────────
router.post('/api/twilio/voice/complete/:shopId', verifyTwilio, async (req, res) => {
  const vr = new VoiceResponse();
  const ctx = shopCtx(req.params.shopId);
  const dialStatus = req.body.DialCallStatus || '';      // completed|no-answer|busy|failed|canceled
  const callSid = req.body.CallSid;
  const answered = dialStatus === 'completed';

  if (ctx && callSid) {
    const call = ctx.h.getById('calls', callSid) || { id: callSid };
    call.status = dialStatus || call.status;
    call.missed = !answered;
    call.durationSec = parseInt(req.body.DialCallDuration || '0', 10) || 0;
    call.endedAt = new Date().toISOString();

    const lead = call.leadId ? ctx.h.getById('leads', call.leadId) : null;
    if (lead) {
      lead.lastContactAt = call.endedAt;
      if (answered) { lead.status = lead.status === 'new' ? 'contacted' : lead.status; }
      else          { lead.missedCount = (lead.missedCount || 0) + 1; }
    }

    // Auto-SMS only on a genuine ring-out (shop didn't pick up). Exclude 'failed'
    // and 'canceled' — those are errors or the caller hanging up before we
    // connected, and we shouldn't text someone who abandoned the call.
    const MISSED_SMS_STATUSES = ['no-answer', 'busy'];
    if (MISSED_SMS_STATUSES.includes(dialStatus) && callTrackingOn(ctx.settings) && !call.autoSmsSent) {
      const fromNum = shopFromNumber(ctx.shopId);
      const toNum = toE164(call.from);
      if (twilioClient && fromNum && toNum) {
        // Mark + persist sent BEFORE awaiting the send, so a retried Twilio
        // callback (they retry) can't fire a second text (at-most-once).
        call.autoSmsSent = true;
        ctx.h.upsert('calls', call);
        const body = buildSms('missedCall', { name: lead?.name, shop: ctx.shopName }, ctx.settings);
        try {
          await twilioClient.messages.create({ from: fromNum, to: toNum, body });
          ctx.h.upsert('conversations', {
            id: genId('msg'), customerId: lead?.customerId || null, leadId: lead?.id || null,
            customerName: lead?.name || call.from, type: 'sms', direction: 'outbound',
            body, sentAt: new Date().toISOString(), read: true, auto: true,
          });
        } catch (e) { console.error('Missed-call SMS failed:', e.message); }
      }
    }

    ctx.h.upsert('calls', call);
    if (lead) ctx.h.upsert('leads', lead);
  }

  vr.hangup();
  res.type('text/xml').send(vr.toString());
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

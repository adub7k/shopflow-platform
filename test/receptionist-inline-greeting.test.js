// Regression test for the "greet inline, no <Redirect> dead air" fix
// (server/routes/twilio.js answerWithAi). The AI-answer paths must hand Twilio
// the greeting TwiML on the FIRST response — a <Redirect> to /ai added a full
// HTTP round-trip of silence before the greeting, and callers hung up in it.
//
// Drives the real router with in-memory shops in a temp DATA_DIR. verifyTwilio
// skips when TWILIO_AUTH_TOKEN is unset (local dev), so no signing is needed.
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-inline-' + process.pid);
process.env.ANTHROPIC_API_KEY = 'test-key';       // makes voiceAvailable() true
process.env.PUBLIC_URL = 'https://staging.example.com'; // makes relay.available() true (wsBase)
delete process.env.TWILIO_AUTH_TOKEN;              // verifyTwilio → skip

const express = require('express');
const { master, getShopDb } = require('../server/db');

let failures = 0;
const ok = (name, cond, detail) => { if (!cond) { failures++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); } else console.log(`PASS  ${name}`); };

function makeShop(id, voiceAI) {
  master.get('shops').push({ id, accountId: 'acct_' + id, shopName: id, slug: id, industry: 'detail', active: true }).write();
  const db = getShopDb(id);
  db.set('settings', { shopName: id, phone: '+15055551234', voiceAI }).write();
  db.set('services', [{ id: 's1', name: 'Full Detail', category: 'detail', price: 250, duration: 180, cost: 40 }]).write();
  db.set('barbers', [{ id: 'b1', name: 'Bay 1', active: true, schedule: { workDays: [0,1,2,3,4,5,6], startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 30 } }]).write();
  return db;
}

// always + relay, always + gather, fallback + relay (tested via /complete)
makeShop('inlineRelay',  { mode: 'always',   engine: 'relay', relayVoice: 'testVoice' });
makeShop('inlineGather', { mode: 'always',   engine: 'gather' });
const fbDb = makeShop('inlineFallback', { mode: 'fallback', engine: 'relay', relayVoice: 'testVoice' });
// Pre-write a ringing, not-yet-accepted call for the /complete (ring-out) path.
fbDb.set('calls', [{ id: 'CAfb', leadId: 'leadFb', callSid: 'CAfb', from: '+15551110000', status: 'ringing', accepted: false, missed: false }]).write();
fbDb.set('leads', [{ id: 'leadFb', name: '', phone: '+15551110000', source: 'call', status: 'new' }]).write();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(require('../server/routes/twilio'));

const form = obj => new URLSearchParams(obj).toString();
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => {
    const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
    return { status: r.status, xml: await r.text() };
  };
  try {
    // 1. always + relay: entry webhook returns ConversationRelay INLINE, no redirect
    const relayRes = await post('/api/twilio/voice/inlineRelay', { CallSid: 'CArelay', From: '+15551230000', To: '+15059990000' });
    ok('relay: 200', relayRes.status === 200, relayRes.status);
    ok('relay: greets inline with <ConversationRelay>', /<Connect>\s*<ConversationRelay/.test(relayRes.xml), relayRes.xml.slice(0, 120));
    ok('relay: NO <Redirect> dead-air hop', !/<Redirect/i.test(relayRes.xml));

    // 2. always + gather: entry webhook returns <Gather> greeting INLINE, no redirect
    const gatherRes = await post('/api/twilio/voice/inlineGather', { CallSid: 'CAgather', From: '+15551230001', To: '+15059990001' });
    ok('gather: 200', gatherRes.status === 200, gatherRes.status);
    ok('gather: greets inline with <Gather>', /<Gather/.test(gatherRes.xml));
    ok('gather: NO <Redirect> dead-air hop', !/<Redirect/i.test(gatherRes.xml));

    // 3. fallback + relay: after the shop's phone rings out, /complete hands the
    //    still-present caller to the AI INLINE (not a redirect to /ai).
    const compRes = await post('/api/twilio/voice/complete/inlineFallback', { CallSid: 'CAfb', DialCallStatus: 'no-answer' });
    ok('fallback: 200', compRes.status === 200, compRes.status);
    ok('fallback: greets inline with <ConversationRelay>', /<Connect>\s*<ConversationRelay/.test(compRes.xml), compRes.xml.slice(0, 120));
    ok('fallback: NO <Redirect> dead-air hop', !/<Redirect/i.test(compRes.xml));

    console.log(failures ? `\n✗ ${failures} FAILED` : '\n✓ ALL PASSED');
    server.close(() => process.exit(failures ? 1 : 0));
  } catch (e) {
    console.error('test error', e);
    server.close(() => process.exit(1));
  }
});

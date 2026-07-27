// Smoke test for the ConversationRelay engine (receptionist/relay.js).
// Run: node test/relay-smoke.test.js   (exits non-zero on any failure)
//
// No Twilio, no real websocket, no API key: a stubbed streaming Anthropic client
// drives one relay turn against an in-memory shop, so we can verify the plumbing —
// text tokens streamed out, server-authoritative capture executed, {type:'end'}
// sent — plus the <Connect><ConversationRelay> TwiML shape.
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.PUBLIC_URL = 'https://staging.example.com';

const low = require('lowdb');
const Memory = require('lowdb/adapters/Memory');
const { shopHelpers } = require('../server/db');
const voice = require('../server/receptionist/voice');
const relay = require('../server/receptionist/relay');

let failures = 0, passed = 0;
function check(name, cond, detail) { if (!cond) { failures++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); } else { passed++; console.log(`PASS  ${name}`); } }
function eq(name, a, b) { check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

function detailShop() {
  const db = low(new Memory());
  db.defaults({
    industry: 'detail',
    settings: {
      shopName: 'Demo Auto Studio',
      customFields: [{ key: 'vehicleYear', label: 'Year', type: 'text', required: true }, { key: 'vehicleMake', label: 'Make', type: 'text', required: true }, { key: 'vehicleModel', label: 'Model', type: 'text', required: true }],
      deposit: { enabled: false },
      voiceAI: { mode: 'always', engine: 'relay', voice: '', relayTtsProvider: 'ElevenLabs', relayVoice: 's3TPKV1kjDlVtZbl4Ksh' },
    },
    services: [
      { id: 's1', name: 'Ceramic Window Tint — Full Vehicle', category: 'tint', price: 450, duration: 210, cost: 0, sizePricing: { sedan: 450, suv: 550, truck: 600 } },
    ],
    barbers: [{ id: 'b1', name: 'Bay 1', active: true, schedule: { workDays: [0, 1, 2, 3, 4, 5, 6], startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 30 } }],
    appointments: [], customers: [], leads: [{ id: 'lead1', name: '', phone: '+15551234567', source: 'call', status: 'new' }],
    blockedDates: [],
  }).write();
  return db;
}

// Stub Anthropic streaming client: one .messages.stream() call per script step.
// Each step emits text deltas (via the 'text' listener) then resolves finalMessage
// with content blocks — mirroring the real SDK's MessageStream surface.
function streamStub(script) {
  let i = 0;
  return { messages: { stream() {
    const step = script[i++] || { text: [], content: [{ type: 'text', text: '' }] };
    const listeners = {};
    const s = {
      on(ev, cb) { listeners[ev] = cb; return s; },
      async finalMessage() {
        for (const d of (step.text || [])) if (listeners.text) listeners.text(d);
        if (step.error) throw step.error;   // simulate an API failure (after any text it emitted)
        return { content: step.content };
      },
      abort() {},
    };
    return s;
  } } };
}

function fakeWs() {
  const sent = [];
  return { readyState: 1, sent, send(s) { sent.push(JSON.parse(s)); }, on() {}, close() {} };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('— relay TwiML —');
(() => {
  const db = detailShop();
  const ctx = { shopId: 'shop1', db, h: shopHelpers(db), settings: db.get('settings').value(), shop: { id: 'shop1', slug: 'demo-detail', shopName: 'Demo Auto Studio' }, shopName: 'Demo Auto Studio', industry: 'detail', today: '2026-07-14' };
  const xml = relay.connectTwiml(ctx, 'CA123');
  check('TwiML: <ConversationRelay> with wss url', /<ConversationRelay url="wss:\/\/staging\.example\.com\/api\/twilio\/voice\/relay/.test(xml), xml);
  check('TwiML: signed token in url', xml.includes(`t=${relay.relayToken('CA123')}`));
  check('TwiML: welcomeGreeting + ttsProvider + interruptible', /welcomeGreeting="Thanks for calling Demo Auto Studio/.test(xml) && /ttsProvider="ElevenLabs"/.test(xml) && /interruptible="speech"/.test(xml), xml);
  check('TwiML: noise controls (interruptSensitivity=low + ignoreBackchannel=true)', /interruptSensitivity="low"/.test(xml) && /ignoreBackchannel="true"/.test(xml), xml);
  check('TwiML: & in url is XML-escaped', xml.includes('&amp;callSid='));
  check('TwiML: ElevenLabs voice id in voice attr', xml.includes('voice="s3TPKV1kjDlVtZbl4Ksh"'), xml);
  check('TwiML: elevenlabsTextNormalization on for ElevenLabs', /elevenlabsTextNormalization="on"/.test(xml), xml);
  check('TwiML: STT hints include shop vocabulary (fixes garbled words)', /hints="[^"]*(ceramic|tint)[^"]*"/i.test(xml), xml);
  check('TwiML: transcriptionLanguage set', /transcriptionLanguage="en-US"/.test(xml), xml);
  check('TwiML: speechModel = nova-3 (accuracy)', /speechModel="nova-3-general"/.test(xml), xml);
  eq('relayToken is deterministic', relay.relayToken('CA123'), relay.relayToken('CA123'));
  check('relayToken differs per callSid', relay.relayToken('CA123') !== relay.relayToken('CA999'));
  // Availability gate: relay needs BOTH an API key and PUBLIC_URL (the wss base).
  check('available() true with key + PUBLIC_URL', relay.available() === true);
  const _pub = process.env.PUBLIC_URL; delete process.env.PUBLIC_URL;
  check('available() false without PUBLIC_URL → AI handler falls back to gather', relay.available() === false);
  process.env.PUBLIC_URL = _pub;
})();

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— wsBase hardening (PUBLIC_URL misconfig → valid wss origin) —');
(() => {
  const db = detailShop();
  const ctx = { shopId: 'shop1', db, h: shopHelpers(db), settings: db.get('settings').value(), shop: { id: 'shop1' }, shopName: 'Demo', industry: 'detail', today: 'x' };
  const _pub = process.env.PUBLIC_URL;
  const originOf = () => { const m = relay.connectTwiml(ctx, 'CA1').match(/ConversationRelay url="(wss?:\/\/[^?"]*)/); return m && m[1]; };
  process.env.PUBLIC_URL = 'https://shopflowtech.com/api/twilio/voice/mad-detailing'; // whole webhook path pasted in (the real bug)
  eq('strips a pasted webhook path → clean wss origin', originOf(), 'wss://shopflowtech.com/api/twilio/voice/relay');
  process.env.PUBLIC_URL = 'shopflowtech.com'; // bare host, no scheme
  eq('bare host → https-assumed wss origin', originOf(), 'wss://shopflowtech.com/api/twilio/voice/relay');
  process.env.PUBLIC_URL = 'https://shopflowtech.com/'; // trailing slash
  eq('trailing slash → clean origin', originOf(), 'wss://shopflowtech.com/api/twilio/voice/relay');
  process.env.PUBLIC_URL = 'http://localhost:3000'; // http → ws
  eq('http → ws', originOf(), 'ws://localhost:3000/api/twilio/voice/relay');
  process.env.PUBLIC_URL = _pub;
})();

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n— relay turn: stream tokens → capture → end —');
(async () => {
  const db = detailShop();
  const ctx = { shopId: 'shop1', db, h: shopHelpers(db), settings: db.get('settings').value(), shop: { id: 'shop1', slug: 'demo-detail', shopName: 'Demo Auto Studio' }, shopName: 'Demo Auto Studio', industry: 'detail', today: '2026-07-14' };
  const ws = fakeWs();
  const call = { id: 'CA123', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('relay') };
  call.voiceAI.turns.push({ role: 'assistant', text: voice.greeting(ctx), at: 't0' });
  const session = { ws, ctx, call, cfg: voice.voiceConfig(ctx.settings), messages: [], busy: false, ended: false, gen: 0, stream: null };

  voice.__setTestClient(streamStub([{
    text: ['So that\'s a ceramic tint on the 2021 Highlander — ', 'I\'ll text you shortly. '],
    content: [
      { type: 'text', text: 'So that\'s a ceramic tint on the 2021 Highlander — I\'ll text you shortly. ' },
      { type: 'tool_use', id: 'tu1', name: 'capture_lead', input: { customerName: 'John', callbackNumber: null, serviceNeeded: 'Ceramic Window Tint', vehicle: '2021 Toyota Highlander', vehicleSize: 'suv', quotedPrice: 550, budget: null, preferredTime: 'Saturday', quality: 'hot', summary: 'Ceramic tint on a 2021 Highlander, Saturday.', followUp: 'Text a Saturday slot + $550 quote.', closingLine: "You're all set, John — thanks for calling!" } },
    ],
  }]));

  await relay.__test.handlePrompt(session, 'Yes that is right');

  const textMsgs = ws.sent.filter(m => m.type === 'text');
  check('streamed text tokens out (last:false)', textMsgs.some(m => m.last === false && /ceramic tint/.test(m.token)), JSON.stringify(textMsgs.map(m => m.token)));
  check('spoke the closing line', textMsgs.some(m => /all set, John/.test(m.token)));
  check('finalized the TTS turn (empty token, last:true)', textMsgs.some(m => m.token === '' && m.last === true));
  check('sent {type:"end"} to hang up', ws.sent.some(m => m.type === 'end'), JSON.stringify(ws.sent.map(m => m.type)));

  const lead = db.get('leads').find({ id: 'lead1' }).value();
  check('capture wrote lead.ai (server-authoritative, reused from voice.js)', lead.ai && lead.ai.quality === 'hot' && lead.ai.source === 'voice', JSON.stringify(lead.ai));
  eq('outcome recorded on the call', call.voiceAI.outcome.type, 'captured');
  check('no appointment created (quote-first)', db.get('appointments').value().length === 0);
})();

// ─────────────────────────────────────────────────────────────────────────────
// The H7 fix: a transient API blip on the INITIAL request (the usual cause of a
// dropped call) is retried invisibly, since no audio has gone out yet.
console.log('\n— relay retry: transient blip before any audio recovers (call does NOT drop) —');
(async () => {
  const db = detailShop();
  const ctx = { shopId: 'shop1', db, h: shopHelpers(db), settings: db.get('settings').value(), shop: { id: 'shop1', slug: 'demo-detail', shopName: 'Demo Auto Studio' }, shopName: 'Demo Auto Studio', industry: 'detail', today: '2026-07-14' };
  const ws = fakeWs();
  const call = { id: 'CA200', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('relay') };
  call.voiceAI.turns.push({ role: 'assistant', text: voice.greeting(ctx), at: 't0' });
  const session = { ws, ctx, call, cfg: voice.voiceConfig(ctx.settings), messages: [], busy: false, ended: false, gen: 0, stream: null };

  voice.__setTestClient(streamStub([
    { error: Object.assign(new Error('overloaded'), { status: 529 }) },   // attempt 1: blip, nothing spoken
    { text: ["You're all set, John — "], content: [                        // attempt 2: succeeds
      { type: 'text', text: "You're all set, John — thanks for calling!" },
      { type: 'tool_use', id: 'tu1', name: 'capture_lead', input: { customerName: 'John', callbackNumber: null, serviceNeeded: 'Ceramic Window Tint', vehicle: '2021 Toyota Highlander', vehicleSize: 'suv', quotedPrice: 550, budget: null, preferredTime: 'Saturday', quality: 'hot', summary: 'Ceramic tint, Saturday.', followUp: 'Text a slot.', closingLine: "You're all set, John — thanks for calling!" } },
    ] },
  ]));

  await relay.__test.handlePrompt(session, 'Yes that is right');

  const textMsgs = ws.sent.filter(m => m.type === 'text');
  check('retry: call did NOT drop (no "something went wrong")', !textMsgs.some(m => /something went wrong/i.test(m.token)), JSON.stringify(textMsgs.map(m => m.token)));
  check('retry: recovered and spoke the real reply', textMsgs.some(m => /all set, John/.test(m.token)), JSON.stringify(textMsgs.map(m => m.token)));
  const lead = db.get('leads').find({ id: 'lead1' }).value();
  check('retry: capture still executed after recovery', lead.ai && lead.ai.quality === 'hot', JSON.stringify(lead.ai));
  eq('retry: outcome recorded', call.voiceAI.outcome.type, 'captured');
})();

// The safety half of H7: a blip AFTER tokens were already spoken must NOT retry
// (a retry would re-speak a half-finished sentence) — it degrades gracefully.
console.log('\n— relay retry: blip AFTER audio streamed does NOT retry (no double-speech) —');
(async () => {
  const db = detailShop();
  const ctx = { shopId: 'shop1', db, h: shopHelpers(db), settings: db.get('settings').value(), shop: { id: 'shop1', slug: 'demo-detail', shopName: 'Demo Auto Studio' }, shopName: 'Demo Auto Studio', industry: 'detail', today: '2026-07-14' };
  const ws = fakeWs();
  const call = { id: 'CA201', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('relay') };
  call.voiceAI.turns.push({ role: 'assistant', text: voice.greeting(ctx), at: 't0' });
  const session = { ws, ctx, call, cfg: voice.voiceConfig(ctx.settings), messages: [], busy: false, ended: false, gen: 0, stream: null };

  voice.__setTestClient(streamStub([
    { text: ['Let me check that for '], error: Object.assign(new Error('overloaded'), { status: 529 }) }, // spoke, THEN blip
    { text: ['a totally different reply '], content: [                       // must never run (would prove a bad retry)
      { type: 'text', text: 'a totally different reply ' },
      { type: 'tool_use', id: 'tu9', name: 'capture_lead', input: { customerName: 'Ghost', callbackNumber: null, serviceNeeded: 'x', vehicle: null, vehicleSize: null, quotedPrice: null, budget: null, preferredTime: null, quality: 'hot', summary: 'x', followUp: 'x', closingLine: 'x' } },
    ] },
  ]));

  await relay.__test.handlePrompt(session, 'Yes');

  const textMsgs = ws.sent.filter(m => m.type === 'text');
  check('post-audio blip: did NOT retry (second reply never spoken)', !textMsgs.some(m => /different reply/.test(m.token)), JSON.stringify(textMsgs.map(m => m.token)));
  check('post-audio blip: degrades to a graceful callback line', textMsgs.some(m => /call you right back/i.test(m.token)), JSON.stringify(textMsgs.map(m => m.token)));
  const lead = db.get('leads').find({ id: 'lead1' }).value();
  check('post-audio blip: no wrongful capture from a retry', !lead.ai, JSON.stringify(lead.ai));
})();

// Long enough to outlast the retry backoff in the recovery test (200ms + 400ms
// worst case) — a shorter budget would let process.exit fire mid-retry and mask
// those assertions. Also assert the expected number of checks actually ran, so a
// swallowed async rejection can never masquerade as a green run.
const EXPECTED_CHECKS = 21;
setTimeout(() => {
  const ran = passed + failures;
  if (ran !== EXPECTED_CHECKS) { console.log(`\n✗ expected ${EXPECTED_CHECKS} checks, ${ran} ran — a test block did not finish`); process.exit(1); }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}, 2000);

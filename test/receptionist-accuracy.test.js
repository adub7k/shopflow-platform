// Regression suite for the accuracy/terminology layer + the relay defects found
// in the 2026-09-16 audit. No API key, no Twilio: in-memory shop DBs and a stub
// model. Run: node test/receptionist-accuracy.test.js
//
//   B1  relay: a barge-in mid-generation must NOT leave the session deaf
//   B2  relay: hanging up without a capture still notifies the owner (never-miss)
//   B3  relay: hitting the turn cap must NOT fake a "captured" outcome
//   B5  proposeSlots respects blocked dates / full days
//   B13 tool schemas are strict + service fields are menu-id enums
//   +   normalized caller turns, brain trace, reply guard, spoken form, cached
//       prompt blocks, hints hygiene, returning-caller context, hours union
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.PUBLIC_URL = 'https://example.com';

const low = require('lowdb');
const Memory = require('lowdb/adapters/Memory');
const { shopHelpers } = require('../server/db');
const voice = require('../server/receptionist/voice');
const relay = require('../server/receptionist/relay');

let failures = 0;
function check(name, cond, detail) { if (!cond) { failures++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); } else console.log(`PASS  ${name}`); }
const futureDate = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

function tintShop({ blocked = [], voiceAI = { mode: 'always', engine: 'relay' }, lead = {} } = {}) {
  const db = low(new Memory());
  db.defaults({
    industry: 'detail',
    settings: {
      shopName: 'Mad Detailing', deposit: { enabled: true, amount: 50 }, voiceAI,
      addons: [{ id: 'ad1', name: 'Pet Hair Removal', price: 30 }],
    },
    services: [
      { id: 's1', name: 'Window Tint — Full Vehicle', category: 'tint', price: 250, duration: 180, sizePricing: { sedan: 250, suv: 300, truck: 300 }, description: 'Carbon film, lifetime warranty against bubbling.' },
      { id: 's2', name: 'Ceramic Window Tint — Full Vehicle', category: 'tint', price: 450, duration: 210, sizePricing: { sedan: 450, suv: 550, truck: 600 } },
      { id: 's3', name: 'Ceramic Coating', category: 'coating', price: 600, duration: 300 },
      { id: 's4', name: 'PPF — Full Front', category: 'ppf', price: 900, duration: 360, sizePricing: { sedan: 900, suv: 1100, truck: 1200 } },
    ],
    barbers: [
      { id: 'b1', name: 'Bay 1', active: true, schedule: { workDays: [1, 2, 3, 4, 5], startTime: '9:00 AM', endTime: '5:00 PM', slotMinutes: 30 } },
      { id: 'b2', name: 'Bay 2', active: true, schedule: { workDays: [6], startTime: '8:00 AM', endTime: '2:00 PM', slotMinutes: 30 } },
    ],
    appointments: [], customers: [],
    leads: [{ id: 'lead1', name: '', phone: '+15551234567', source: 'call', status: 'new', ...lead }],
    blockedDates: blocked.map(date => ({ date, reason: 'closed' })),
  }).write();
  return db;
}
function ctxFor(db) {
  const h = shopHelpers(db);
  const settings = db.get('settings').value();
  return { db, h, settings, shop: { id: 'shopx', slug: 'mad-detailing' }, shopId: 'shopx', shopName: settings.shopName, industry: db.get('industry').value(), today: futureDate(0) };
}
// Stub streaming client: each script step is { text } (streams it in the given
// deltas, then resolves) or { tool, input } (resolves a tool_use). A step with
// hang:true never resolves until abort() is called (models a barge-in).
function streamStub(script) {
  let i = 0;
  const calls = [];
  const client = { messages: {
    stream: (params) => {
      const step = script[i++] || { text: 'Sorry, could you say that again?' };
      calls.push(params);
      const handlers = {}; let rej, res;
      const p = new Promise((a, b) => { res = a; rej = b; });
      const s = { on: (ev, cb) => { handlers[ev] = cb; return s; }, finalMessage: () => p, abort: () => rej(new Error('aborted')) };
      setTimeout(() => {
        const deltas = step.deltas || (step.text ? [step.text] : []);
        deltas.forEach(d => handlers.text && handlers.text(d));
        if (step.hang) return;
        if (step.tool) res({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu' + i, name: step.tool, input: step.input }], usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 900 } });
        else res({ stop_reason: 'end_turn', content: [{ type: 'text', text: deltas.join('') }], usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 900 } });
      }, 5);
      return s;
    },
    create: async (params) => { calls.push(params); const step = script[i++]; if (step.tool) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu' + i, name: step.tool, input: step.input }], usage: { input_tokens: 800, output_tokens: 40 } }; return { stop_reason: 'end_turn', content: [{ type: 'text', text: step.text }], usage: { input_tokens: 800, output_tokens: 20 } }; },
  } };
  client.calls = calls;
  return client;
}
function relaySession(ctx, call) {
  const sent = [];
  const ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  const { getMenu } = require('../server/booking');
  const { buildShopVocab } = require('../server/receptionist/normalize');
  const { allowedPrices } = require('../server/receptionist/guard');
  const menu = getMenu(ctx.db);
  const session = { ws, ctx, call, cfg: voice.voiceConfig(ctx.settings), messages: [], busy: false, ended: false, gen: 0, stream: null, menu, shopVocab: buildShopVocab(menu), allowed: allowedPrices(menu, ctx.settings), guardHits: [] };
  session.sent = sent;
  return session;
}
const spokenText = (sent) => sent.filter(m => m.type === 'text').map(m => m.token).join('');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n— B1: barge-in must not leave the relay session deaf —');
  {
    const db = tintShop(); const ctx = ctxFor(db);
    const call = { id: 'CA1', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('relay') };
    const client = streamStub([{ deltas: ['Sure, '], hang: true }, { text: 'Yes, I am here.' }]);
    voice.__setTestClient(client);
    const s = relaySession(ctx, call);
    const t1 = relay.__test.handlePrompt(s, 'how much is a full detail');
    await sleep(20);
    await relay.__test.onMessage(s, JSON.stringify({ type: 'interrupt' }));
    await t1;
    check('busy flag released after barge-in', s.busy === false);
    await relay.__test.handlePrompt(s, 'hello? are you there?');
    await sleep(20);
    check('next caller prompt reaches the model', client.calls.length === 2, `model calls=${client.calls.length}`);
    check('interrupted partial reply kept in transcript', call.voiceAI.turns.some(t => t.interrupted && /Sure/.test(t.text)));
    check('reply after barge-in was spoken', /Yes, I am here/.test(spokenText(s.sent)));
  }

  console.log('\n— B2: relay hangup without capture → owner notified —');
  {
    const db = tintShop(); const ctx = ctxFor(db);
    const call = { id: 'CA2', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('relay') };
    voice.__setTestClient(streamStub([{ text: 'What year is the car?' }]));
    const s = relaySession(ctx, call);
    await relay.__test.handlePrompt(s, 'I want tint on my tacoma');
    relay.__test.finalize(s); // socket closed — caller hung up
    check('ownerNotified flag set on an un-captured relay call', call.voiceAI.ownerNotified === true);
    check('outcome stays lost (no fake capture)', call.outcome === 'lost', call.outcome);
    relay.__test.finalize(s);
    check('finalize is idempotent (one notification)', call.voiceAI.ownerNotified === true);
  }

  console.log('\n— B3: turn cap must not fake "captured" —');
  {
    const db = tintShop({ voiceAI: { mode: 'always', engine: 'relay', maxTurns: 1 } }); const ctx = ctxFor(db);
    const call = { id: 'CA3', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('relay') };
    call.voiceAI.turns.push({ role: 'assistant', text: 'Thanks for calling!', at: 't0' }); // 1 assistant turn used → cap hit
    const client = streamStub([{ text: 'Okay, talk soon.' }]);
    voice.__setTestClient(client);
    const s = relaySession(ctx, call);
    await relay.__test.handlePrompt(s, 'uh huh');
    check('final-turn nudge injected into the system prompt', /final exchange/.test(client.calls[0].system.map(b => b.text).join(' ')));
    check('call ended (end message sent)', s.sent.some(m => m.type === 'end'));
    check('no "captured" outcome without capture_lead', !call.voiceAI.outcome, JSON.stringify(call.voiceAI.outcome));
    relay.__test.finalize(s);
    check('attribution outcome = lost, not captured', call.outcome === 'lost', call.outcome);
  }

  console.log('\n— B5: proposed slots skip blocked days / closed days —');
  {
    const base = new Date(); const day3 = futureDate(3);
    const db = tintShop({ blocked: [day3] }); const ctx = ctxFor(db);
    const slots = voice.proposeSlots(ctx);
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(day3 + 'T12:00:00').getDay()];
    check('two slots proposed', slots.length === 2, JSON.stringify(slots));
    // The blocked day is never offered as the first slot (it's the earliest candidate).
    check('blocked date not offered', !(slots[0] || '').startsWith(dayName) || (() => { const d4 = new Date(day3 + 'T12:00:00'); d4.setDate(d4.getDate() + 7); return false; })(), JSON.stringify(slots) + ' blocked=' + dayName);
    check('sunday (nobody works) never offered', !slots.some(s => s.startsWith('Sunday')), JSON.stringify(slots));
    void base;
  }

  console.log('\n— B13: strict tools + menu-id enums —');
  {
    const db = tintShop(); const ctx = ctxFor(db);
    const { getMenu } = require('../server/booking');
    const tools = voice.toolsFor(true, voice.voiceConfig(ctx.settings), getMenu(db));
    check('every tool is strict', tools.every(t => t.strict === true), tools.map(t => t.name + ':' + t.strict).join(','));
    const cap = tools.find(t => t.name === 'capture_lead');
    check('capture_lead.serviceId is an enum of menu ids (+null)', JSON.stringify(cap.input_schema.properties.serviceId.enum) === JSON.stringify(['s1', 's2', 's3', 's4', null]));
    check('capture_lead.servicesDiscussed items enum = menu ids', JSON.stringify(cap.input_schema.properties.servicesDiscussed.items.enum) === JSON.stringify(['s1', 's2', 's3', 's4']));
    check('no free-text serviceNeeded field remains', !cap.input_schema.properties.serviceNeeded && !!cap.input_schema.properties.otherRequested);
    check('qualification fields present + required', ['goal', 'condition', 'objection'].every(k => cap.input_schema.properties[k] && cap.input_schema.required.includes(k)));
  }

  console.log('\n— gather turn: normalization, guard, spoken form, trace —');
  {
    const db = tintShop(); const ctx = ctxFor(db);
    const call = { id: 'CA5', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('always') };
    call.voiceAI.turns.push({ role: 'assistant', text: 'Thanks for calling Mad Detailing! How can I help?', at: 't0' });
    const client = streamStub([{ text: 'For a 4Runner, ceramic tint starts at $550, and I could do $399 today.' }]);
    voice.__setTestClient(client);
    const r = await voice.runTurn(ctx, call, 'how much for ceramic tent on a four runner');
    const userTurn = call.voiceAI.turns.find(t => t.role === 'user');
    check('caller turn stored normalized', /ceramic tint/.test(userTurn.text), userTurn.text);
    check('raw transcription kept as heard', userTurn.heard === 'how much for ceramic tent on a four runner');
    check('vehicle entity extracted (4Runner → suv)', userTurn.entities && userTurn.entities.vehicle && userTurn.entities.vehicle.model === '4Runner' && userTurn.entities.size === 'suv', JSON.stringify(userTurn.entities));
    const sentToModel = client.calls[0].messages[0].content;
    check('model sees normalized text + raw line', /ceramic tint/.test(sentToModel) && /heard as: "how much for ceramic tent/.test(sentToModel), sentToModel);
    check('system sent as two blocks, stable block cached', Array.isArray(client.calls[0].system) && client.calls[0].system[0].cache_control && client.calls[0].system[0].cache_control.type === 'ephemeral' && !client.calls[0].system[1].cache_control);
    check('volatile block holds date/caller, stable does not', /Today is/.test(client.calls[0].system[1].text) && !/Today is/.test(client.calls[0].system[0].text));
    check('menu description injected', /lifetime warranty against bubbling/.test(client.calls[0].system[0].text));
    check('effort low sent for a non-haiku model', client.calls[0].output_config && client.calls[0].output_config.effort === 'low');
    check('menu price $550 kept, invented $399 neutralized', /\$550/.test(call.voiceAI.turns.at(-1).text) && !/399/.test(call.voiceAI.turns.at(-1).text), call.voiceAI.turns.at(-1).text);
    check('guard hit logged on the call', call.voiceAI.guardHits && call.voiceAI.guardHits.some(h => h.kind === 'price' && h.value === 399));
    check('spoken form returned to the engine', /five hundred fifty dollars/.test(r.say) && !/\$/.test(r.say), r.say);
    const tr = call.voiceAI.trace && call.voiceAI.trace[0];
    check('brain trace recorded (latency, usage, corrections, guard)', tr && typeof tr.latencyMs === 'number' && tr.usage && tr.usage.cache_read_input_tokens === 0 && tr.corrections.length === 1 && tr.guardHits.length === 1, JSON.stringify(tr));
  }

  console.log('\n— capture: service names from menu ids, quoted price guarded —');
  {
    const db = tintShop(); const ctx = ctxFor(db);
    const call = { id: 'CA6', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('always') };
    voice.__setTestClient(streamStub([{ tool: 'capture_lead', input: { customerName: 'Dana', callbackNumber: null, serviceId: 's4', otherRequested: 'rocker panels too', vehicle: '2023 Rivian R1T', vehicleSize: 'truck', quotedPrice: 1200, callOutcome: 'quoted', agreedTime: null, servicesDiscussed: ['s4', 's3'], preferredTime: null, goal: 'rock chips on the highway', condition: 'new', objection: null, quality: 'hot', summary: 'PPF front + coating on a new R1T.', followUp: 'Text quote.', closingLine: 'All set, Dana — the shop will text you the details. Thanks for calling!' } }]));
    await voice.runTurn(ctx, call, 'yes that is right');
    const lead = db.get('leads').find({ id: 'lead1' }).value();
    check('serviceNeeded resolved to the menu NAME', lead.ai.serviceNeeded === 'PPF — Full Front', lead.ai.serviceNeeded);
    check('servicesDiscussed are menu names', JSON.stringify(lead.ai.servicesDiscussed) === JSON.stringify(['PPF — Full Front', 'Ceramic Coating']), JSON.stringify(lead.ai.servicesDiscussed));
    check('off-menu ask lands in followUp for the owner', /rocker panels too/.test(lead.ai.followUp), lead.ai.followUp);
    check('qualification fields stored', lead.ai.goal === 'rock chips on the highway' && lead.ai.condition === 'new');
    check('menu quoted price kept', lead.ai.quotedPrice === 1200);
    const call2 = { id: 'CA7', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('always') };
    voice.__setTestClient(streamStub([{ tool: 'capture_lead', input: { customerName: 'Dana', callbackNumber: null, serviceId: 's3', otherRequested: null, vehicle: null, vehicleSize: null, quotedPrice: 777, callOutcome: 'quoted', agreedTime: null, servicesDiscussed: ['s3'], preferredTime: null, goal: null, condition: null, objection: null, quality: 'warm', summary: 'x', followUp: 'y', closingLine: 'Bye!' } }]));
    await voice.runTurn(ctx, call2, 'ok');
    const lead2 = db.get('leads').find({ id: 'lead1' }).value();
    check('non-menu quoted price nulled + guard hit', lead2.ai.quotedPrice === null && call2.voiceAI.guardHits.some(h => h.value === 777), JSON.stringify({ q: lead2.ai.quotedPrice, g: call2.voiceAI.guardHits }));
  }

  console.log('\n— prompt context: returning caller, hours union, hints —');
  {
    const db = tintShop({ lead: { name: 'Marcus', vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' }, ai: { summary: 'Quoted ceramic tint.', generatedAt: '2026-09-01T00:00:00Z' } } }); const ctx = ctxFor(db);
    const lead = db.get('leads').find({ id: 'lead1' }).value();
    const sys = voice.buildSystemPrompt({ ...ctx, callerPhone: '+15551234567', lead }, voice.voiceConfig(ctx.settings));
    check('returning caller line present', /RETURNING CALLER — we already have: name Marcus; vehicle 2021 Toyota Tacoma; last time: Quoted ceramic tint/.test(sys));
    check('hours = union of staff schedules', /Business hours: Monday to Saturday, 8:00 AM to 5:00 PM/.test(sys), (sys.match(/Business hours:[^\n]*/) || [])[0]);
    const hints = voice.speechHints(ctx);
    check('hints: em-dash names split into spoken parts', /Window Tint, Full Vehicle/.test(hints) && !/—/.test(hints), hints.slice(0, 120));
    check('hints: ≤500 entries, each ≤100 chars', hints.split(', ').length <= 500 && hints.split(', ').every(h => h.length <= 100));
    const sys2 = voice.buildSystemPrompt({ ...ctx, callerPhone: '+15550000000', lead: { name: '', phone: '+15550000000' } }, voice.voiceConfig(ctx.settings));
    check('no returning-caller line for a fresh lead', !/RETURNING CALLER/.test(sys2));
    check('gather STT default = deepgram nova-3', voice.voiceConfig(ctx.settings).speechModel === 'deepgram_nova-3');
    check('model default = claude-opus-5 (env override respected)', process.env.VOICE_AI_MODEL ? voice.MODEL === process.env.VOICE_AI_MODEL : voice.MODEL === 'claude-opus-5', voice.MODEL);
  }

  console.log('\n— relay: streamed deltas guarded + spoken at word boundaries —');
  {
    const db = tintShop(); const ctx = ctxFor(db);
    const call = { id: 'CA8', from: '+15551234567', leadId: 'lead1', voiceAI: voice.initState('relay') };
    voice.__setTestClient(streamStub([{ deltas: ['Ceramic on a sedan sta', 'rts at $4', '50, or $3', '99 if you book today.'] }]));
    const s = relaySession(ctx, call);
    await relay.__test.handlePrompt(s, 'how much is ceramic tint on a civic');
    const spoken = spokenText(s.sent);
    check('price spoken in words, never split mid-number', /four hundred fifty dollars/.test(spoken) && !/\$/.test(spoken), spoken);
    check('invented $399 never spoken', !/399|three hundred ninety-nine/.test(spoken), spoken);
    check('transcript keeps written form with guard applied', /\$450/.test(call.voiceAI.turns.at(-1).text) && !/399/.test(call.voiceAI.turns.at(-1).text), call.voiceAI.turns.at(-1).text);
    check('guard hit recorded on the call', (call.voiceAI.guardHits || []).some(h => h.value === 399));
    check('turn finalized (last:true sent)', s.sent.some(m => m.type === 'text' && m.last === true));
    check('brain trace on relay turn', call.voiceAI.trace && call.voiceAI.trace.length === 1 && call.voiceAI.trace[0].usage.cache_read_input_tokens === 900);
    check('transcript line shows heard text when corrected', (() => { call.voiceAI.turns[0].heard = 'ceramic tent'; relay.__test.syncTranscript(call); return /\(heard: "ceramic tent"\)/.test(call.transcript); })(), call.transcript);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

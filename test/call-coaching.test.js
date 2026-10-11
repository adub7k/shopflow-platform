// Answered-call sales coaching (server/receptionist/intake.js): a call a person
// answered gets intake + a sales scorecard saved on the CALL; voicemails keep the
// plain intake schema; an earlier voicemail intake doesn't block a call's scorecard.
// The Anthropic SDK is stubbed — no network.
process.env.ANTHROPIC_API_KEY = 'test-key';

let lastReq = null;
const reply = { callerName: 'Dana', summary: 'Wants ceramic tint on a sedan.', serviceNeeded: 'Ceramic tint', budget: null, desiredDate: 'Friday', quality: 'hot', followUp: 'Text Friday slots.' };
const coaching = {
  score: 6, verdict: 'Friendly and quick, but quoted before asking about the car.',
  skills: [
    { skill: 'rapport', rating: 'strong', note: 'Used her name twice.' },
    { skill: 'discovery', rating: 'missed', note: 'Never asked which windows.' },
    { skill: 'value', rating: 'ok', note: 'Mentioned heat rejection once.' },
    { skill: 'objections', rating: 'n/a', note: 'No pushback.' },
    { skill: 'close', rating: 'missed', note: 'Ended with "call us back".' },
  ],
  didWell: 'Warm greeting.', improve: 'Ask for the booking.', tryThis: 'I have Friday at 10 — want me to lock that in?', booked: false,
};
const sdkPath = require.resolve('@anthropic-ai/sdk');
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: class {
  constructor() { this.messages = { create: async (req) => {
    lastReq = req;
    const isCall = !!req.output_config.format.schema.properties.coaching;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(isCall ? { ...reply, coaching } : reply) }] };
  } }; }
} };

const { runIntake } = require('../server/receptionist/intake');

let failures = 0;
const ok = (name, cond, detail) => { if (!cond) { failures++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); } else console.log(`PASS  ${name}`); };

function fakeCtx(lead) {
  const store = { calls: { CA1: { id: 'CA1', leadId: 'L1', recording: { recordingSid: 'RE1' } } }, leads: { L1: lead } };
  return { store, shopId: 's1', shopName: 'Evo', settings: { aiReceptionist: { enabled: true } },
    db: { get: () => ({ value: () => 'detail' }) },
    h: { getById: (col, id) => store[col][id] ? JSON.parse(JSON.stringify(store[col][id])) : null,
         upsert: (col, item) => { store[col][item.id] = JSON.parse(JSON.stringify(item)); } } };
}

(async () => {
  // Lead already has intake from an earlier voicemail — the call still gets coached.
  const ctx = fakeCtx({ id: 'L1', phone: '+15055550100', ai: { summary: 'old voicemail' } });
  const r = await runIntake(ctx, 'CA1', { transcript: 'Speaker 1: Evo, this is Sam.\nSpeaker 2: Hi, ceramic tint price?', kind: 'call' });
  ok('call intake runs despite earlier voicemail intake', r.ok && r.reason === 'done', JSON.stringify(r));
  ok('call request uses the coaching schema', !!lastReq.output_config.format.schema.properties.coaching);
  ok('call request asks for coaching in the prompt', /sales coach/.test(lastReq.system));
  const call = ctx.store.calls.CA1;
  ok('scorecard saved on the call', call.coaching && call.coaching.score === 6 && call.coaching.skills.length === 5);
  ok('scorecard stamped with model + time', call.coaching.model && call.coaching.generatedAt);
  ok('transcript kept on the call', /ceramic tint/.test(call.transcript || ''));
  ok('lead intake updated without the scorecard', ctx.store.leads.L1.ai.summary === reply.summary && !ctx.store.leads.L1.ai.coaching);

  // Automatic re-run of the same call is a no-op (no double billing).
  lastReq = null;
  const again = await runIntake(ctx, 'CA1', { kind: 'call' });
  ok('already-coached call is not re-analyzed', again.reason === 'exists' && lastReq === null, JSON.stringify(again));

  // Voicemail keeps the plain intake schema.
  const vm = fakeCtx({ id: 'L1', phone: '+15055550100' });
  await runIntake(vm, 'CA1', { transcript: 'Hi, call me back about tint.' });
  ok('voicemail uses plain intake schema', !lastReq.output_config.format.schema.properties.coaching);
  ok('voicemail gets no scorecard', !vm.store.calls.CA1.coaching);

  // "Analyze with AI" picks the newest conversation, not just any transcribed call.
  const { pickIntakeCall } = require('../server/routes/receptionist');
  const answeredNoTx = { id: 'new', recording: { recordingSid: 'RE2' } };
  const aiCall = { id: 'ai', transcript: 'AI: hi', voiceAI: { turns: [] }, recording: { recordingSid: 'RE0' } };
  const vmCall = { id: 'vm', transcript: 'call me back' };
  ok('picks the newer untranscribed answered call over an older AI call', pickIntakeCall([answeredNoTx, aiCall, vmCall]).id === 'new');
  ok('picks a newer transcribed voicemail over an older answered call', pickIntakeCall([vmCall, answeredNoTx]).id === 'vm');
  ok('skips a plain missed call with nothing to read', pickIntakeCall([{ id: 'miss' }, vmCall]).id === 'vm');
  ok('falls back to the newest call', pickIntakeCall([{ id: 'miss' }]).id === 'miss');
  ok('no calls → null', pickIntakeCall([]) === null);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

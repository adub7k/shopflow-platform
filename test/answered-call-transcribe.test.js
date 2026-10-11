// Answered-call transcription (server/receptionist/transcribe.js) must never fail
// silently: a failed Twilio fetch or ElevenLabs call leaves the call marked
// transcriptStatus 'failed' with the reason, a success stores the dialogue, and
// the Twilio download asks for both channels. fetch is stubbed — no network.
process.env.ELEVENLABS_API_KEY = 'el-test';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tok';

const { transcribeCall } = require('../server/receptionist/transcribe');

let failures = 0;
const ok = (name, cond, detail) => { if (!cond) { failures++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); } else console.log(`PASS  ${name}`); };

function fakeCtx() {
  const calls = { CA1: { id: 'CA1', transcriptStatus: 'processing', recording: { recordingSid: 'RE1' } } };
  return { shopId: 'shop1', calls, h: {
    getById: (col, id) => calls[id] ? { ...calls[id] } : null,
    upsert: (col, item) => { calls[item.id] = { ...item }; },
  } };
}
const mp3 = () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

(async () => {
  const realErr = console.error; console.error = () => {};

  // 1. ElevenLabs rejects the request → failed + reason recorded.
  let urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('api.twilio.com')) return mp3();
    return { ok: false, status: 401, text: async () => '{"detail":{"status":"missing_permissions"}}' };
  };
  let ctx = fakeCtx();
  let r = await transcribeCall(ctx, 'CA1', 'RE1', { retries: 1, delayMs: 0 });
  ok('ElevenLabs error → no text', !r.text);
  ok('ElevenLabs error → status failed', ctx.calls.CA1.transcriptStatus === 'failed', ctx.calls.CA1.transcriptStatus);
  ok('ElevenLabs error → reason kept', /ElevenLabs 401.*missing_permissions/.test(ctx.calls.CA1.transcriptError || ''), ctx.calls.CA1.transcriptError);
  ok('Twilio download requests both channels', urls[0].includes('RE1.mp3?RequestedChannels=2'), urls[0]);

  // 2. Twilio auth failure → failed, ElevenLabs never called.
  urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return { ok: false, status: 401 }; };
  ctx = fakeCtx();
  r = await transcribeCall(ctx, 'CA1', 'RE1', { retries: 3, delayMs: 0 });
  ok('Twilio 401 → failed with reason', ctx.calls.CA1.transcriptError === 'Twilio recording fetch 401', ctx.calls.CA1.transcriptError);
  ok('Twilio 401 → no retries, no ElevenLabs call', urls.length === 1, urls.length);

  // 3. Success → dual-channel dialogue stitched and handed to intake.
  global.fetch = async (url) => {
    if (String(url).includes('api.twilio.com')) return mp3();
    return { ok: true, status: 200, json: async () => ({ transcripts: [
      { words: [{ type: 'word', text: 'Hi,', start: 0 }, { type: 'word', text: 'tint?', start: 2 }] },
      { words: [{ type: 'word', text: 'Sure.', start: 1 }] },
    ] }) };
  };
  ctx = fakeCtx();
  ctx.calls.CA1.transcriptError = 'old error';
  let intakeArgs = null;
  r = await transcribeCall(ctx, 'CA1', 'RE1', { retries: 1, delayMs: 0, runIntake: async (c, id, opts) => { intakeArgs = opts; } });
  ok('success → stitched dialogue', r.text === 'Speaker 1: Hi,\nSpeaker 2: Sure.\nSpeaker 1: tint?', JSON.stringify(r.text));
  ok('success → intake gets transcript as a call', intakeArgs && intakeArgs.kind === 'call' && intakeArgs.transcript === r.text);
  ok('success → stale error cleared', !ctx.calls.CA1.transcriptError);

  console.error = realErr;
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

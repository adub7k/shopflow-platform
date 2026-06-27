// Unit test for the AI receptionist greeting helpers + the shared buildDial.
// Run: node test/receptionist-greeter.test.js   (exits non-zero on any failure)
//
// Covers the pure/offline behavior — no API key needed: classifyIntent falls back
// to keyword matching when ANTHROPIC_API_KEY is absent, so these are deterministic.
const twilio = require('twilio');
const { greeterOptions, buildGreeting, greeterOn, classifyIntent } = require('../server/receptionist/intake');
const { buildDial } = require('../server/routes/twilio');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
}
function checkT(name, cond) { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); }

// greeterOptions: dedup (case-insensitive), trim, cap.
check('greeterOptions dedup + trim',
  greeterOptions([{ name: 'Ceramic Coating' }, { name: ' ceramic coating ' }, { name: 'Interior Detail' }, { name: '' }, {}]),
  ['Ceramic Coating', 'Interior Detail']);
check('greeterOptions cap',
  greeterOptions([1, 2, 3, 4, 5, 6, 7].map(n => ({ name: 'S' + n })), 3),
  ['S1', 'S2', 'S3']);

// buildGreeting: auto-built list grammar + custom override.
check('buildGreeting auto (multi)',
  buildGreeting('ABC Detailing', ['Window Tint', 'Ceramic Coating', 'PPF']),
  'Thanks for calling ABC Detailing! Are you calling about Window Tint, Ceramic Coating, or PPF, or something else?');
check('buildGreeting auto (single)',
  buildGreeting('ABC', ['Detailing']),
  'Thanks for calling ABC! Are you calling about Detailing, or something else?');
check('buildGreeting custom override',
  buildGreeting('ABC', ['X'], '  Hi there!  '),
  'Hi there!');

// greeterOn toggle.
checkT('greeterOn default off', greeterOn({}) === false && greeterOn(undefined) === false);
checkT('greeterOn true', greeterOn({ aiReceptionist: { greeter: { enabled: true } } }) === true);
checkT('greeterOn explicit false', greeterOn({ aiReceptionist: { greeter: { enabled: false } } }) === false);

// classifyIntent keyword fallback (force no-key so it's deterministic).
const savedKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const OPTS = ['Window Tint', 'Ceramic Coating', 'Interior Detail'];
(async () => {
  check('classify tint', (await classifyIntent({ speech: 'I want my windows tinted', options: OPTS })), { label: 'Window Tint', matched: 'keyword' });
  check('classify ceramic', (await classifyIntent({ speech: 'do you do ceramic?', options: OPTS })), { label: 'Ceramic Coating', matched: 'keyword' });
  check('classify unknown → Something else', (await classifyIntent({ speech: 'is this a pizza place', options: OPTS })), { label: 'Something else', matched: 'keyword' });
  check('classify empty → null', (await classifyIntent({ speech: '', options: OPTS })), null);
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;

  // buildDial: whisper URL threads ?callSid only when no intent; adds &intent= when present.
  const vr1 = new twilio.twiml.VoiceResponse();
  buildDial(vr1, { shopId: 'demo-detail' }, 'CA1', '+15551234567', '+15557654321');
  const x1 = vr1.toString();
  checkT('buildDial no-intent whisper url', x1.includes('whisper/demo-detail?callSid=CA1') && !x1.includes('intent='));
  checkT('buildDial dials the real number with callerId', x1.includes('+15551234567') && x1.includes('callerId="+15557654321"') && x1.includes('action="/api/twilio/voice/complete/demo-detail"'));

  const vr2 = new twilio.twiml.VoiceResponse();
  buildDial(vr2, { shopId: 'demo-detail' }, 'CA2', '+15551234567', '+15557654321', 'Ceramic Coating');
  checkT('buildDial intent threaded + encoded', vr2.toString().includes('intent=Ceramic%20Coating'));

  console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll receptionist tests passed');
  process.exit(failures ? 1 : 0);
})();

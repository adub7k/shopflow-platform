// Unit test for the hardened verifyTwilio signature check (server/routes/twilio.js).
// Run: node test/verify-twilio.test.js   (exits non-zero on any failure)
//
// Goal: prove the hardening accepts a valid Twilio signature whether it was signed
// against PUBLIC_URL, the real request host, OR the X-Forwarded-* host — so a
// mismatched PUBLIC_URL can never 403 the line (the 6/25 outage) — while still
// rejecting a genuinely bad signature and honoring the skip conditions.
const crypto = require('crypto');
const { verifyTwilio } = require('../server/routes/twilio');

// Twilio's signing algorithm: HMAC-SHA1 over (url + each sorted POST key+value),
// keyed by the auth token, base64-encoded. Matches twilio.validateRequest.
function sign(authToken, url, params) {
  let data = url;
  Object.keys(params).sort().forEach(k => { data += k + params[k]; });
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

const TOKEN = 'AC_test_auth_token_0123456789';
const PARAMS = { CallSid: 'CA0001', From: '+15551112222', To: '+15553334444' };
const PATH = '/api/twilio/voice/demo-detail';
const REAL_HOST = 'staging-shopflow.up.railway.app';

// Minimal Express-like req/res; runVerify returns 'next' | 403 | <other status>.
function runVerify({ env = {}, headers = {}, protocol = 'https', host = REAL_HOST, body = PARAMS }) {
  const saved = {};
  ['TWILIO_AUTH_TOKEN', 'PUBLIC_URL', 'TWILIO_VALIDATE_SIGNATURE'].forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.entries(env).forEach(([k, v]) => { process.env[k] = v; });
  try {
    const req = { headers, body, originalUrl: PATH, protocol, get: (h) => (h.toLowerCase() === 'host' ? host : undefined) };
    let result = null;
    const res = { status(c) { result = c; return this; }, type() { return this; }, send() { return this; } };
    verifyTwilio(req, res, () => { result = 'next'; });
    return result;
  } finally {
    Object.keys(env).forEach(k => delete process.env[k]);
    Object.entries(saved).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; });
  }
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${actual}, expected ${expected})`);
}

// 1. PUBLIC_URL mismatched, but signature was signed against the REAL request host → accept (this is the 6/25 scenario).
const sigReal = sign(TOKEN, `https://${REAL_HOST}${PATH}`, PARAMS);
check('mismatched PUBLIC_URL, real-host signature accepted',
  runVerify({ env: { TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_URL: 'https://wrong-host.example.com' }, headers: { 'x-twilio-signature': sigReal } }),
  'next');

// 2. Signature signed against PUBLIC_URL, request host differs (proxy) → accept.
const CONFIGURED = 'https://configured.example.com';
const sigConfigured = sign(TOKEN, CONFIGURED + PATH, PARAMS);
check('PUBLIC_URL-host signature accepted when request host differs',
  runVerify({ env: { TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_URL: CONFIGURED }, headers: { 'x-twilio-signature': sigConfigured }, host: 'internal-proxy.railway.internal' }),
  'next');

// 3. X-Forwarded-* reconstruction (PUBLIC_URL unset, req.protocol/host wrong) → accept.
check('X-Forwarded host signature accepted',
  runVerify({ env: { TWILIO_AUTH_TOKEN: TOKEN }, protocol: 'http', host: 'internal:8080',
    headers: { 'x-twilio-signature': sigReal, 'x-forwarded-proto': 'https', 'x-forwarded-host': REAL_HOST } }),
  'next');

// 4. Genuinely bad signature → 403 (still rejects forged requests).
check('bad signature rejected with 403',
  runVerify({ env: { TWILIO_AUTH_TOKEN: TOKEN }, headers: { 'x-twilio-signature': 'totally-bogus' } }),
  403);

// 5. Missing signature header → 403.
check('missing signature rejected with 403',
  runVerify({ env: { TWILIO_AUTH_TOKEN: TOKEN }, headers: {} }),
  403);

// 6. No auth token configured (local dev) → skip validation entirely.
check('no token → skip (next)',
  runVerify({ env: {}, headers: { 'x-twilio-signature': 'irrelevant' } }),
  'next');

// 7. Escape hatch TWILIO_VALIDATE_SIGNATURE=false → skip even with a token + bad sig.
check('validate=false escape hatch → skip (next)',
  runVerify({ env: { TWILIO_AUTH_TOKEN: TOKEN, TWILIO_VALIDATE_SIGNATURE: 'false' }, headers: { 'x-twilio-signature': 'bogus' } }),
  'next');

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll verifyTwilio tests passed');
process.exit(failures ? 1 : 0);

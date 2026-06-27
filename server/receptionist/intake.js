// ── AI Receptionist: call intake ─────────────────────────────────────────────
// Turns a raw call/voicemail transcript into structured CRM intake using Claude:
// a short summary, the service needed, budget, desired date, a lead-quality
// score, and a recommended follow-up. Writes the transcript onto the call and
// the structured fields onto the lead (lead.ai). Idempotent per call.
//
// Degrades gracefully: with no ANTHROPIC_API_KEY the telephony flow is untouched
// — we still store the transcript, we just skip the AI enrichment.
const { resolveProfile } = require('../industries');

// House rule (claude-api skill): default to claude-opus-4-8. For high-volume
// voicemail summarization the owner may prefer the cheaper/faster claude-haiku-4-5
// — overridable without a code change via RECEPTIONIST_MODEL.
const MODEL = process.env.RECEPTIONIST_MODEL || 'claude-opus-4-8';

// Lazily construct the SDK client once, only if a key is configured.
let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

// Structured-output schema. All fields required; "not stated" is expressed as
// null (not omission) so the model can't drift the shape. No min/max constraints
// — those aren't supported by structured outputs.
const INTAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    callerName:    { type: ['string', 'null'], description: "The caller's name if they state it, else null." },
    summary:       { type: 'string', description: 'A 1-3 sentence plain-English summary of what the caller wants.' },
    serviceNeeded: { type: ['string', 'null'], description: 'The specific service requested, in the shop\'s terms, else null.' },
    budget:        { type: ['number', 'null'], description: 'Stated budget in dollars as a number, else null.' },
    desiredDate:   { type: ['string', 'null'], description: 'Desired date/timeframe as the caller said it (free text), else null.' },
    quality:       { type: 'string', enum: ['hot', 'warm', 'cold'], description: 'hot = clear service + strong intent to book; warm = interested, needs follow-up; cold = vague, spam, or wrong number.' },
    followUp:      { type: 'string', description: 'One concrete next action for the shop (e.g. a text to send).' },
  },
  required: ['callerName', 'summary', 'serviceNeeded', 'budget', 'desiredDate', 'quality', 'followUp'],
};

// Call Claude on a transcript. Returns the validated intake object, or null on
// any failure (no key, API error, bad JSON) — callers treat null as "no AI".
async function analyzeTranscript(transcript, { shopName, industryLabel, callerPhone, location } = {}) {
  const client = getClient();
  if (!client) return null;
  const text = String(transcript || '').trim();
  if (!text) return null;

  const system = [
    `You are the intake assistant for ${shopName || 'a service business'}` + (industryLabel ? ` (a ${industryLabel.toLowerCase()})` : '') + '.',
    'A prospective customer called and left a message (transcribed below).',
    'Extract structured lead-intake details for the CRM. Be conservative: if a',
    'detail is not actually stated, use null — do not guess. Keep the summary to',
    'at most three sentences. Judge quality honestly (a wrong number or spam is "cold").',
  ].join(' ');

  const user = [
    callerPhone ? `Caller phone: ${callerPhone}` : null,
    location ? `Caller location: ${location}` : null,
    '',
    'Transcript:',
    '"""',
    text.slice(0, 6000), // cap input — voicemails are short; bound cost/abuse
    '"""',
  ].filter(v => v !== null).join('\n');

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      // effort low + structured JSON: fast, cheap, shape-guaranteed extraction.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: INTAKE_SCHEMA } },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal') return null;
    const block = (res.content || []).find(b => b.type === 'text');
    if (!block) return null;
    const data = JSON.parse(block.text);
    data.model = MODEL;
    data.generatedAt = new Date().toISOString();
    return data;
  } catch (e) {
    console.error('AI intake failed:', e.message);
    return null;
  }
}

const aiEnabled = (settings) => !!(settings && settings.aiReceptionist && settings.aiReceptionist.enabled);

// Orchestrate intake for one call: store the transcript, run AI if allowed, and
// write results onto the call + lead. Idempotent — re-runs only with force.
// Returns { ok, reason, ai }. reason ∈ disabled|no-key|no-transcript|done|exists|error.
async function runIntake(ctx, callId, opts = {}) {
  const force = !!opts.force;
  const call = ctx.h.getById('calls', callId);
  if (!call) return { ok: false, reason: 'error', message: 'Call not found' };

  // Persist the transcript (from Twilio callback or a manual paste) immediately.
  const transcript = (opts.transcript != null ? String(opts.transcript) : call.transcript) || '';
  if (transcript && transcript !== call.transcript) {
    call.transcript = transcript;
    call.transcriptStatus = 'done';
    ctx.h.upsert('calls', call);
  }

  const lead = call.leadId ? ctx.h.getById('leads', call.leadId) : null;
  // Manual runs (force) are owner-initiated, so they bypass the per-shop toggle;
  // automatic (callback) runs require the shop to have opted in.
  if (!force && !aiEnabled(ctx.settings)) return { ok: false, reason: 'disabled' };
  if (!process.env.ANTHROPIC_API_KEY)     return { ok: false, reason: 'no-key' };
  if (!transcript.trim())                 return { ok: false, reason: 'no-transcript' };
  if (lead && lead.ai && !force)          return { ok: true,  reason: 'exists', ai: lead.ai };

  const industry = ctx.db.get('industry').value();
  const ai = await analyzeTranscript(transcript, {
    shopName: ctx.shopName,
    industryLabel: resolveProfile(industry).label,
    callerPhone: lead ? lead.phone : call.from,
    location: lead ? lead.location : '',
  });
  if (!ai) return { ok: false, reason: 'error', message: 'AI analysis unavailable' };

  if (lead) {
    lead.ai = ai;
    // Enrich the lead name if the caller gave one and we don't have it yet.
    if (!lead.name && ai.callerName) lead.name = ai.callerName;
    ctx.h.upsert('leads', lead);
  }
  return { ok: true, reason: 'done', ai };
}

// ── Live AI receptionist greeting (caller speaks → we classify the interest) ──
// Distinct, caller-friendly menu options auto-built from the shop's own services.
function greeterOptions(services, cap = 5) {
  const seen = new Set(), out = [];
  (services || []).forEach(s => {
    const name = String((s && s.name) || '').trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) { seen.add(key); out.push(name); }
  });
  return out.slice(0, cap);
}

// Spoken greeting. Owner can override with a custom line; otherwise auto-built.
function buildGreeting(shopName, options, custom) {
  if (custom && custom.trim()) return custom.trim();
  const list = (options && options.length)
    ? (options.length === 1 ? options[0] : options.slice(0, -1).join(', ') + ', or ' + options[options.length - 1])
    : 'our services';
  return `Thanks for calling ${shopName || 'us'}! Are you calling about ${list}, or something else?`;
}

const greeterOn = (settings) => !!(settings && settings.aiReceptionist && settings.aiReceptionist.greeter && settings.aiReceptionist.greeter.enabled);

// Classify what the caller said into one of the menu options (or "Something else").
// Reuses the same Claude client/MODEL as the voicemail intake. Degrades to a
// keyword match when there's no key or the call fails — so the telephony flow
// always gets an answer and a caller is never stranded.
async function classifyIntent({ speech, options, shopName } = {}) {
  const text = String(speech || '').trim();
  const labels = (options || []).filter(Boolean);
  if (!text || !labels.length) return null;

  const keyword = () => {
    const t = text.toLowerCase();
    const hit = labels.find(l => {
      const ll = l.toLowerCase();
      return t.includes(ll) || ll.split(/\s+/).some(w => w.length > 3 && t.includes(w));
    });
    return { label: hit || 'Something else', matched: 'keyword' };
  };

  const client = getClient();
  if (!client) return keyword();

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      service: { type: 'string', enum: [...labels, 'Something else'], description: 'The single menu option the caller is asking about; "Something else" if none clearly fit.' },
    },
    required: ['service'],
  };
  try {
    const res = await client.messages.create({
      model: MODEL, max_tokens: 80,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: `You route inbound callers for ${shopName || 'a service business'}. Map what the caller said to exactly ONE menu option; if none clearly fit, choose "Something else". Be decisive.`,
      messages: [{ role: 'user', content: `Menu options: ${labels.join(', ')}.\nCaller said: "${text.slice(0, 500)}"` }],
    });
    if (res.stop_reason === 'refusal') return keyword();
    const block = (res.content || []).find(b => b.type === 'text');
    if (!block) return keyword();
    return { label: JSON.parse(block.text).service, matched: 'ai' };
  } catch (e) {
    console.error('classifyIntent failed:', e.message);
    return keyword();
  }
}

module.exports = { analyzeTranscript, runIntake, aiEnabled, MODEL, greeterOptions, buildGreeting, greeterOn, classifyIntent };

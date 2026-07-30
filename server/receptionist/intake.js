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
async function analyzeTranscript(transcript, { shopName, industryLabel, callerPhone, location, kind } = {}) {
  const client = getClient();
  if (!client) return null;
  const text = String(transcript || '').trim();
  if (!text) return null;

  // 'call' = a two-way answered conversation (speaker-labelled); 'voicemail' (the
  // default) = a one-way message. The framing changes how the model reads the text.
  const isCall = kind === 'call';
  const system = [
    `You are the intake assistant for ${shopName || 'a service business'}` + (industryLabel ? ` (a ${industryLabel.toLowerCase()})` : '') + '.',
    isCall
      ? 'A prospective customer spoke with the shop on a recorded phone call, transcribed below with each speaker on a separate line. The speaker labels may be swapped, so infer from context which side is the customer and which is the shop, and base the intake on what the customer wants.'
      : 'A prospective customer called and left a message (transcribed below).',
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
    // Cap input to bound cost/abuse. A two-way call runs longer than a voicemail.
    text.slice(0, isCall ? 16000 : 6000),
    '"""',
  ].filter(v => v !== null).join('\n');

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      // Structured JSON output — shape-guaranteed extraction. No effort param:
      // it's Opus/Sonnet-tier only and 400s on claude-haiku-4-5 (a common
      // RECEPTIONIST_MODEL for cost), while json_schema works on both tiers.
      output_config: { format: { type: 'json_schema', schema: INTAKE_SCHEMA } },
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
    kind: opts.kind,   // 'call' for answered-call transcripts; undefined ⇒ voicemail
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

module.exports = { analyzeTranscript, runIntake, aiEnabled, MODEL };

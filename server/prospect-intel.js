// ── Prospect intel: AI sales analysis for shops we're selling ShopFlow to ────
// Two features, both for the admin territory map / prospect profiles:
//
//   analyzeProspect(lead)  → a per-shop sales brief. Step 1 researches the shop
//     on the web (Claude's web search + web fetch of their own site); step 2
//     turns those notes + everything we know (stage, notes, touch log, Google
//     rating) into a structured brief: fit, which offer, how to approach, the
//     opener, objections. Split in two so the brief is schema-constrained JSON
//     and the research step is free to browse.
//
//   buildGamePlan(leads)   → one pass over the whole book: segments, the top
//     targets to hit first, a plan per territory and a week of work.
//
// Both are slow (a minute or more), so routes run them in the background and
// store the result on the lead (`intel`) / the sales blob (`plan`).
const MODEL = process.env.PROSPECT_AI_MODEL || process.env.ADVISOR_MODEL || 'claude-opus-5';

let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) { const Anthropic = require('@anthropic-ai/sdk'); _client = new Anthropic(); }
  return _client;
}
const configured = () => !!process.env.ANTHROPIC_API_KEY;

// What we sell and to whom — shared by both prompts. Kept stable so it caches.
const SHOPFLOW_CONTEXT = `You are the sales strategist for ShopFlow Technologies, an Albuquerque, NM company selling to auto detailing, window tint, vinyl wrap and paint-protection-film (PPF) shops in the Albuquerque metro (Albuquerque, Rio Rancho, Corrales, Los Lunas, Valencia County).

What ShopFlow sells (the pricing ladder):
- AI Receptionist — $349/mo: an AI that answers every call the shop misses (and texts back missed callers), quotes from the shop's own price list, captures the lead, and books or hands off. Pitched on "you're under a car with gloves on when the phone rings — every missed call is a job that goes to the next shop on Google."
- Receptionist + Ads — about $1,599/mo: the receptionist plus us running their Meta (Facebook/Instagram) lead ads and landing pages, with the leads flowing straight into the ShopFlow CRM.
- Growth Engine — $3,000/mo (example price; quoted per shop): the full done-for-you system — ads, landing pages, AI receptionist, CRM with follow-up sequences, estimates with deposits, and monthly reporting. For established shops that want to scale.
Every plan includes the ShopFlow CRM (leads pipeline, estimates, text follow-ups, booking).

Reality of this market: most of these shops are owner-operators who are hands-on in the bay, answer the phone themselves, live on Instagram and Google reviews, and are skeptical of "marketing guys". A few are bigger multi-bay shops with staff. Sales happen through cold calls, Instagram DMs and walk-ins by our rep, then a short demo.

Rules: be concrete and specific to the shop in front of you. Use only facts you were given or found; when something is unknown, say it is unknown instead of guessing. Never invent revenue, prices, review quotes or names.`;

// ── Step 1: web research ────────────────────────────────────────────────────
const RESEARCH_PROMPT = `Research this business so our rep can sell to it. Use web search, and fetch their website if they have one.

Find what you can about:
- the services they offer and any prices they publish
- how customers reach and book them (online booking tool? a quote form? phone/DM only?) and whether they answer after hours
- their Google review count, rating and recurring themes in reviews (especially anything about response times, not answering, scheduling)
- social media: Instagram/Facebook/TikTok handles, follower counts, how active
- signs they run ads, have a team (multiple bays/employees) or are a solo/mobile operator
- how long they have been in business, and anything else a salesperson would want to know

Write compact research notes: short bullet points grouped by topic, each fact with its source URL. Mark anything you could not find as "unknown". Do not make recommendations yet.`;

async function research(lead) {
  const client = getClient();
  const facts = [
    `Business: ${lead.name}`,
    lead.address && `Address: ${lead.address}`,
    lead.city && `City: ${lead.city}`,
    lead.contact && `Phone/handle: ${lead.contact}`,
    lead.website && `Website: ${lead.website}`,
    lead.category && `Category: ${lead.category}`,
    lead.rating != null && `Google rating: ${lead.rating} from ${lead.reviews || 0} reviews`,
  ].filter(Boolean).join('\n');
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', city: 'Albuquerque', region: 'New Mexico', country: 'US', timezone: 'America/Denver' } },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 },
  ];
  let messages = [{ role: 'user', content: `${RESEARCH_PROMPT}\n\n${facts}` }];
  const sources = new Set();
  let res;
  // Server tools can pause a long turn; resume by sending the paused turn back.
  for (let i = 0; i < 4; i++) {
    res = await client.messages.create({ model: MODEL, max_tokens: 16000, tools, messages });
    (res.content || []).forEach(b => {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach(r => r.url && sources.add(r.url));
      if (b.type === 'web_fetch_tool_result' && b.content && b.content.url) sources.add(b.content.url);
    });
    if (res.stop_reason !== 'pause_turn') break;
    messages = [messages[0], { role: 'assistant', content: res.content }];
  }
  if (res.stop_reason === 'refusal') throw new Error('The model declined to research this shop');
  const notes = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { notes: notes || 'No research notes were produced.', sources: [...sources].slice(0, 15) };
}

// ── Step 2: the brief ───────────────────────────────────────────────────────
const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'fitScore', 'fitReason', 'priority', 'recommendedOffer', 'offerReason', 'signals', 'painPoints',
    'approach', 'opener', 'talkingPoints', 'objections', 'questionsToAsk', 'nextStep'],
  properties: {
    summary:          { type: 'string', description: '2–3 sentences: who this shop is, what they do, how big they seem.' },
    fitScore:         { type: 'integer', description: '1–10: how good a ShopFlow customer they would be.' },
    fitReason:        { type: 'string' },
    priority:         { type: 'string', enum: ['hot', 'warm', 'cold'] },
    recommendedOffer: { type: 'string', enum: ['AI Receptionist — $349', 'Receptionist + Ads — $1,599', 'Growth Engine — $3,000', 'Not a fit right now'] },
    offerReason:      { type: 'string' },
    signals: {
      type: 'array', description: 'What we observed about the shop, each tagged as a strength, a gap we can fill, or a risk to the deal.',
      items: { type: 'object', additionalProperties: false, required: ['kind', 'label', 'detail'],
        properties: { kind: { type: 'string', enum: ['strength', 'gap', 'risk'] }, label: { type: 'string' }, detail: { type: 'string' } } },
    },
    painPoints:    { type: 'array', items: { type: 'string' }, description: 'Problems this shop likely has that ShopFlow solves, grounded in the evidence.' },
    approach: {
      type: 'object', additionalProperties: false, required: ['channel', 'bestTime', 'why'],
      properties: {
        channel:  { type: 'string', enum: ['Phone call', 'Walk-in', 'Instagram DM', 'Facebook message', 'Email'] },
        bestTime: { type: 'string' },
        why:      { type: 'string' },
      },
    },
    opener:        { type: 'string', description: 'The exact first 2–4 sentences the rep says or sends, written in a natural, local, non-salesy voice.' },
    talkingPoints: { type: 'array', items: { type: 'string' } },
    objections: {
      type: 'array', description: 'The objections this shop is most likely to raise, with how to answer each.',
      items: { type: 'object', additionalProperties: false, required: ['objection', 'response'],
        properties: { objection: { type: 'string' }, response: { type: 'string' } } },
    },
    questionsToAsk: { type: 'array', items: { type: 'string' }, description: 'Discovery questions for the first conversation.' },
    nextStep:       { type: 'string', description: 'The single next action for the rep.' },
  },
};

function historyText(lead) {
  const log = (lead.log || []).slice(0, 15).map(e => `- ${String(e.at || '').slice(0, 10)} ${e.type}: ${e.text}`).join('\n');
  return [
    `Our pipeline stage: ${lead.status}`,
    lead.tool && lead.tool !== 'Unknown' && `They currently use: ${lead.tool}`,
    lead.plan && lead.plan !== 'Unknown' && `Plan they showed interest in: ${lead.plan}`,
    lead.followup && `Follow-up date set: ${lead.followup}`,
    lead.notes && `Rep notes:\n${lead.notes}`,
    log && `Touch log (newest first):\n${log}`,
  ].filter(Boolean).join('\n');
}

async function writeBrief(lead, notes, territory) {
  const client = getClient();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: 'text', text: SHOPFLOW_CONTEXT, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: BRIEF_SCHEMA } },
    messages: [{ role: 'user', content:
      `Write the sales brief for this shop.\n\n` +
      `SHOP\nName: ${lead.name}\nAddress: ${lead.address || lead.city || 'unknown'}\nTerritory: ${territory || 'unknown'}\n` +
      `Category: ${lead.category || 'unknown'}\nPhone: ${lead.contact || 'unknown'}\nWebsite: ${lead.website || 'none found'}\n` +
      `Google: ${lead.rating != null ? `${lead.rating}★ from ${lead.reviews || 0} reviews` : 'unknown'}\n\n` +
      `OUR HISTORY WITH THEM\n${historyText(lead)}\n\nWEB RESEARCH NOTES\n${notes}` }],
  });
  if (res.stop_reason === 'refusal') throw new Error('The model declined to write this brief');
  const block = (res.content || []).find(b => b.type === 'text');
  if (!block) throw new Error(`No brief returned (stop_reason ${res.stop_reason})`);
  return JSON.parse(block.text);
}

async function analyzeProspect(lead, { territory } = {}) {
  if (!configured()) throw new Error('ANTHROPIC_API_KEY is not set');
  let found;
  try { found = await research(lead); }
  catch (e) {
    // Web tools can be disabled for the org — still write a brief from what we have.
    found = { notes: `Web research unavailable (${e.message}). Work only from the shop data above.`, sources: [] };
  }
  const brief = await writeBrief(lead, found.notes, territory);
  return { brief, research: found.notes, sources: found.sources, model: MODEL };
}

// ── The whole-book game plan ────────────────────────────────────────────────
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'marketRead', 'segments', 'topTargets', 'territoryPlan', 'weekPlan', 'pitchAngles', 'watchOuts'],
  properties: {
    headline:   { type: 'string', description: 'One sentence: the strategy in a nutshell.' },
    marketRead: { type: 'string', description: 'A short paragraph on what this book of shops looks like and where the money is.' },
    segments: {
      type: 'array', description: '3–6 groups of shops that should be sold the same way.',
      items: { type: 'object', additionalProperties: false, required: ['name', 'who', 'offer', 'approach', 'shopRefs'],
        properties: {
          name: { type: 'string' }, who: { type: 'string', description: 'What defines this group.' },
          offer: { type: 'string' }, approach: { type: 'string' },
          shopRefs: { type: 'array', items: { type: 'string' }, description: 'The #refs of shops in this segment.' },
        } },
    },
    topTargets: {
      type: 'array', description: 'The 10–15 shops to go after first, best first.',
      items: { type: 'object', additionalProperties: false, required: ['ref', 'why', 'offer', 'opener'],
        properties: { ref: { type: 'string' }, why: { type: 'string' }, offer: { type: 'string' }, opener: { type: 'string' } } },
    },
    territoryPlan: {
      type: 'array', description: 'One entry per territory worth working, in the order to work them.',
      items: { type: 'object', additionalProperties: false, required: ['territory', 'plan'],
        properties: { territory: { type: 'string' }, plan: { type: 'string' } } },
    },
    weekPlan: {
      type: 'array', description: 'Monday–Friday for the rep this week.',
      items: { type: 'object', additionalProperties: false, required: ['day', 'focus', 'tasks'],
        properties: { day: { type: 'string' }, focus: { type: 'string' }, tasks: { type: 'array', items: { type: 'string' } } } },
    },
    pitchAngles: { type: 'array', items: { type: 'string' }, description: 'Angles that will land with this market.' },
    watchOuts:   { type: 'array', items: { type: 'string' } },
  },
};

// leads: [{ lead, territory }]. Shops are referenced as #1, #2… so the model
// never has to echo ids; refs map back to lead ids after.
async function buildGamePlan(rows) {
  if (!configured()) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = getClient();
  const refs = {};
  const lines = rows.map(({ lead: l, territory }, i) => {
    const ref = '#' + (i + 1); refs[ref] = l.id;
    const b = l.intel && l.intel.brief;
    return [ref, l.name, territory || '?', l.status, l.category || '', l.rating != null ? `${l.rating}★/${l.reviews || 0}` : 'no rating',
      l.website ? 'site' : 'no site', l.contact ? 'phone' : 'no phone',
      l.lastContact ? 'last touch ' + String(l.lastContact).slice(0, 10) : '',
      b ? `analyzed: fit ${b.fitScore}/10, ${b.priority}, ${b.recommendedOffer}` : '',
      l.notes ? 'notes: ' + String(l.notes).replace(/\s+/g, ' ').slice(0, 140) : ''].filter(Boolean).join(' | ');
  });
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: [{ type: 'text', text: SHOPFLOW_CONTEXT, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    messages: [{ role: 'user', content:
      `Here is our whole book of shops in the metro (ref | name | territory | our stage | category | Google rating/reviews | website | phone | last touch | AI analysis | notes).\n` +
      `Stages: not-contacted = never reached out; contacted/responded/demo = in conversation; closed = signed client; not-interested = lost.\n` +
      `Review counts are a proxy for size and call volume. Build the sales game plan for our one rep. Reference shops by their #ref.\n\n` +
      lines.join('\n') }],
  });
  const res = await stream.finalMessage();
  if (res.stop_reason === 'refusal') throw new Error('The model declined to build a plan');
  const block = (res.content || []).find(b => b.type === 'text');
  if (!block) throw new Error(`No plan returned (stop_reason ${res.stop_reason})`);
  const plan = JSON.parse(block.text);
  // #refs → lead ids (unknown refs dropped).
  const toId = r => refs[String(r).trim().startsWith('#') ? String(r).trim() : '#' + String(r).trim()];
  plan.segments.forEach(s => { s.leadIds = s.shopRefs.map(toId).filter(Boolean); delete s.shopRefs; });
  plan.topTargets = plan.topTargets.map(t => ({ ...t, leadId: toId(t.ref) || null })).filter(t => t.leadId);
  return { plan, model: MODEL, shopCount: rows.length };
}

module.exports = { MODEL, configured, analyzeProspect, buildGamePlan, BRIEF_SCHEMA, PLAN_SCHEMA, SHOPFLOW_CONTEXT };

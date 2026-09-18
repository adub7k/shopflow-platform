// ── Objection follow-ups ─────────────────────────────────────────────────────
// When a lead pushes back (on the phone with the AI receptionist, or the owner
// records it on the lead), the lead switches from the generic 30-day sequence
// to a SHORT objection-specific follow-up in the Tasks queue. The sequences'
// texts live client-side next to the 30-day one (client/js/pages/leads.js
// DEFAULT_OBJECTION_SEQS, owner-editable under Tasks → Cadences); this module
// owns the type list, the text classifier, and the follow-up state shape so the
// server (AI capture, lead PATCH) and the client agree.
const DAY = 86400000;

// firstDay must match the day of step 0 in the client defaults (tested).
const TYPES = [
  { key: 'price',      label: 'Price / shopping around', firstDay: 1 },
  { key: 'think',      label: 'Needs to think / partner', firstDay: 1 },
  { key: 'timing',     label: 'Not right now',            firstDay: 3 },
  { key: 'competitor', label: 'Got a lower quote',        firstDay: 1 },
  { key: 'human',      label: 'Wants a person',           firstDay: 0 },
  { key: 'other',      label: 'Other',                    firstDay: 1 },
];
const KEYS = TYPES.map(t => t.key);
const byKey = (k) => TYPES.find(t => t.key === k) || null;

// Free text → type. Order matters: a lower quote elsewhere is more specific
// than "price"; "wants a person" beats everything (it needs a call today).
const RULES = [
  ['human',      /\b(real person|a person|human|someone|somebody|talk to (the )?(owner|manager|shop)|call me|speak (to|with))\b/i],
  ['competitor', /\b(other (shop|place|quote|guy|company)|somewhere else|another (shop|quote|place|company)|competitor|cheaper (quote|place|shop|guy|elsewhere|down the)|went with|quoted (me )?(less|lower|cheaper)|got a quote|lower quote|better (price|quote|deal) (at|from|somewhere))\b/i],
  ['think',      /\b(think about|think it over|talk it over|sleep on|(talk|check|discuss|run it|go over)( it)? (to|with|by) (my |his |her |the |our )?(wife|husband|partner|spouse|girlfriend|boyfriend|dad|mom|parents|family|boss)|(wife|husband|partner|spouse) (first|about)|run it by|get back to you|not sure yet|decide|undecided)\b/i],
  ['think',      /\b(wife|husband|partner|spouse|girlfriend|boyfriend|significant other|my (dad|mom|parents|family))\b/i],
  ['timing',     /\b(not (right )?now|later|next (week|month|year|payday|paycheck)|after (the|my)|busy|bad time|down the road|when i get|out of town|in a few (weeks|months))\b/i],
  ['price',      /\b(price|pricey|expensive|too much|budget|afford|cost|cheaper|discount|deal|money|shopping around|compare)\b/i],
];
function classifyObjection(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  for (const [key, re] of RULES) if (re.test(t)) return key;
  return 'other';
}

// The lead's followUp state for an objection sequence. Keeps the previous
// sequence's log (the texts already sent are history worth seeing) and notes
// the switch as a grey (skipped) entry so the card reads like a timeline.
function objectionFollowUp(type, now = Date.now(), prev = null) {
  const t = byKey(type) || byKey('other');
  const at = new Date(now).toISOString();
  const log = ((prev && prev.log) || []).slice(-100);
  return {
    seq: 'obj_' + t.key, idx: 0, status: 'active',
    nextAt: new Date(now + t.firstDay * DAY).toISOString(), startedAt: at, pausedReason: null,
    log: log.concat({ step: `→ ${t.label} follow-up`, day: 0, at, by: 'system', skipped: true }),
  };
}

// Bounded lead.objection shape for the PATCH route and the AI capture.
function cleanObjection(v, source = 'owner') {
  if (v == null || v === '') return null;
  const o = typeof v === 'string' ? { type: v } : v;
  const type = KEYS.includes(o.type) ? o.type : classifyObjection(o.note || o.text);
  if (!type) return null;
  const iso = (x) => (x && !isNaN(Date.parse(x))) ? new Date(x).toISOString() : new Date().toISOString();
  return { type, note: o.note ? String(o.note).slice(0, 200) : null, at: iso(o.at), source: ['owner', 'ai'].includes(o.source) ? o.source : source };
}

module.exports = { TYPES, KEYS, byKey, classifyObjection, objectionFollowUp, cleanObjection };

// ── Transcript normalization (STT post-processing) ───────────────────────────
// Phone speech-to-text garbles automotive words ("ceramic tent", "pain
// correction", "puff on the front"). This layer sits between the recognizer and
// the model and fixes what it can PROVE, tags what it can't, and leaves the rest
// alone — it never blindly autocorrects. Deterministic, no API call, fully unit
// tested (test/terminology.test.js).
//
// Correction hierarchy (safest first):
//   1. garble table   — known STT mistakes from vocab.js → canonical term      (auto)
//   2. context        — a bare ambiguous word ("ceramic") resolved by what the
//                       assistant just asked about                              (auto, logged)
//   3. fuzzy          — an unknown token within edit-distance 0.85 of ONE vocab
//                       word ("ceramik" → "ceramic"); never across a PROTECTED
//                       pair, never on short/common words                       (auto, logged)
//   4. tag            — still ambiguous → "ceramic [coating or tint?]" so the
//                       model confirms instead of guessing                      (no rewrite)
// Valid words are never rewritten: "clear bra" stays "clear bra" (the model
// understands it); aliases only feed entity detection and protect spans.
//
// Output: { text, corrections[], tags[], entities, changed }
//   entities = { services[], coverage[], features[], defects[], levels[],
//                vlt: number|null, vehicle: {year,make,model,size,flag}|null, size }
const vocab = require('./vocab');

// ── Tables (built once) ───────────────────────────────────────────────────────
const DISPLAY = { ppf: 'PPF', vlt: 'VLT', 'uv protection': 'UV protection' };
const display = (canon) => DISPLAY[canon] || canon;

const PHRASES = new Map();   // "phrase" → { canonical, kind, method: 'identity'|'alias'|'garble' }
const VOCAB_WORDS = new Set(); // every single word that is part of a valid term (fuzzy targets)
let MAX_N = 1;
for (const t of vocab.TERMS) {
  const put = (p, method) => {
    const k = clean(p);
    if (!k) return;
    // Identity/alias beats garble if the same string appears in both roles.
    const prev = PHRASES.get(k);
    if (prev && prev.method !== 'garble') return;
    if (method === 'garble' && (k === clean(t.canonical) || (t.aliases || []).some(a => clean(a) === k))) return;
    PHRASES.set(k, { canonical: t.canonical, kind: t.kind, method });
    MAX_N = Math.max(MAX_N, k.split(' ').length);
  };
  put(t.canonical, 'identity');
  (t.aliases || []).forEach(a => put(a, 'alias'));
  (t.garbles || []).forEach(g => put(g, 'garble'));
  [t.canonical, ...(t.aliases || [])].forEach(p => clean(p).split(' ').forEach(w => { if (w.length >= 4) VOCAB_WORDS.add(w); }));
}
const PROTECTED_SET = new Set(vocab.PROTECTED.map(([a, b]) => `${a}|${b}`).concat(vocab.PROTECTED.map(([a, b]) => `${b}|${a}`)));
const VEHICLE_PHRASES = [];
for (const v of vocab.VEHICLES) for (const p of v.phrases) VEHICLE_PHRASES.push({ phrase: clean(p), v });
VEHICLE_PHRASES.sort((a, b) => b.phrase.length - a.phrase.length);
const BODY_PHRASES = [];
for (const b of vocab.BODY_STYLES) for (const p of b.phrases) BODY_PHRASES.push({ phrase: clean(p), size: b.size });
BODY_PHRASES.sort((a, b) => b.phrase.length - a.phrase.length);
const VLT_PHRASES = [];
for (const v of vocab.VLT) for (const p of v.phrases) VLT_PHRASES.push({ phrase: clean(p), pct: v.pct });
VLT_PHRASES.sort((a, b) => b.phrase.length - a.phrase.length);

// Words we never fuzzy-correct even though they sit near vocab words (false-positive traps).
const FUZZY_STOP = new Set(['painting', 'paints', 'painted', 'pointing', 'points', 'detailed', 'details', 'heater', 'heating', 'front', 'fronts', 'coat', 'coats', 'tinted', 'window', 'windows', 'glass', 'clean', 'cleaning', 'seat', 'seats', 'shine', 'polish', 'polished', 'trucks', 'thanks', 'think', 'thing', 'things', 'there', 'their', 'where', 'while', 'would', 'could', 'should', 'about', 'right', 'night', 'light', 'might', 'price', 'prices', 'priced', 'place', 'plate', 'plates', 'water', 'later', 'after', 'other', 'another', 'model', 'models', 'total', 'quote', 'quoted', 'quotes', 'sound', 'sounds', 'around', 'ground', 'still', 'small', 'smell', 'smells', 'spell', 'sell', 'cover', 'covered', 'covers']);

// ── Helpers ───────────────────────────────────────────────────────────────────
function clean(s) { return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9%$.\- ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function stripTok(s) { return clean(s).replace(/[.\-]+$/g, '').replace(/^[.\-]+/g, ''); }

// Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps).
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
const similarity = (a, b) => 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);

function isProtected(a, b) { return PROTECTED_SET.has(`${a}|${b}`); }

// Slide over a word list and note every valid industry phrase (longest first).
function noteIndustryTerms(words, note) {
  const done = new Array(words.length).fill(false);
  for (let n = Math.min(MAX_N, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      if (done.slice(i, i + n).some(Boolean)) continue;
      const e = PHRASES.get(words.slice(i, i + n).join(' '));
      if (!e || e.method === 'garble') continue;
      note(e);
      for (let j = i; j < i + n; j++) done[j] = true;
    }
  }
}

// Shop-level vocabulary: menu/add-on names become valid identity phrases (their
// words become fuzzy targets) so a shop's own naming is never "corrected" away.
function buildShopVocab(menu) {
  const phrases = new Map();
  const words = new Set();
  const names = [...((menu && menu.services) || []).map(s => s.name), ...((menu && menu.addons) || []).map(a => a.name)];
  for (const raw of names) {
    for (const part of splitName(raw)) {
      const k = clean(part);
      if (!k) continue;
      phrases.set(k, { canonical: k, kind: 'shop', method: 'identity' });
      k.split(' ').forEach(w => { if (w.length >= 4) words.add(w); });
    }
  }
  return { phrases, words, maxN: Math.max(1, ...[...phrases.keys()].map(k => k.split(' ').length)) };
}

// "Window Tint — Full Vehicle (ceramic)" → ["window tint full vehicle", "window tint", "full vehicle"]
function splitName(raw) {
  const s = String(raw || '').replace(/\([^)]*\)/g, ' ');
  const parts = s.split(/\s*[—–\-\/,:|]\s*|\s+w\/\s+/i).map(p => p.trim()).filter(Boolean);
  const whole = parts.join(' ');
  return [whole, ...parts].map(p => p.replace(/\s+/g, ' ').trim()).filter(p => p.length >= 3 && p.length <= 100);
}

// Clean hint phrases for the speech recognizer: shop names split into spoken
// parts + the industry list. No punctuation, ≤100 chars each, ≤500 entries.
//
// HARD BUDGET: Deepgram (both engines' recognizer) caps keyterms at 500 tokens
// per request and REJECTS the stream above that — which drops the whole call
// before the greeting (2026-09-16 staging: busy tone, TwiML fine). So hints are
// added in priority order — the shop's own menu names first, then core industry
// terms, vehicle names last — and stop at a conservative token estimate.
const HINT_TOKEN_BUDGET = 200;               // well under Deepgram's 500 (our estimate undercounts subword tokens)
const estTokens = (s) => s.split(' ').reduce((n, w) => n + (w.length > 7 ? 2 : 1), 0) + 1; // words + separator
function hintPhrases(menu, { budget = HINT_TOKEN_BUDGET } = {}) {
  const out = [];
  const seen = new Set();
  let used = 0;
  const push = (p) => {
    const s = String(p || '').replace(/[^A-Za-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 100) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    const t = estTokens(s);
    if (used + t > budget || out.length >= 500) return;
    seen.add(k); out.push(s); used += t;
  };
  const names = [...((menu && menu.services) || []).map(s => s.name), ...((menu && menu.addons) || []).map(a => a.name)];
  names.forEach(n => splitName(n).forEach(push));
  vocab.HINTS.forEach(push);
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function normalizeUtterance(raw, opts = {}) {
  const shop = opts.shopVocab || { phrases: new Map(), words: new Set(), maxN: 1 };
  const lastAi = clean(opts.lastAssistantText || '');
  const original = String(raw == null ? '' : raw);
  const corrections = [], tags = [];
  const found = { services: [], coverage: [], features: [], defects: [], levels: [], shop: [] };
  const seenTerm = new Set();
  const note = (entry) => {
    const bucket = entry.kind === 'service' ? 'services' : entry.kind === 'coverage' ? 'coverage' : entry.kind === 'feature' ? 'features' : entry.kind === 'defect' ? 'defects' : entry.kind === 'level' ? 'levels' : entry.kind === 'shop' ? 'shop' : null;
    if (bucket && !seenTerm.has(entry.canonical)) { seenTerm.add(entry.canonical); found[bucket].push(entry.canonical); }
  };

  // Tokenize, keeping the original spelling for spans we don't touch.
  const toks = original.split(/\s+/).filter(Boolean).map(t => ({ orig: t, key: stripTok(t), done: false }));
  const maxN = Math.max(MAX_N, shop.maxN || 1);
  const lookup = (k) => shop.phrases.get(k) || PHRASES.get(k);

  // 1. Phrase pass — longest match first; garbles rewritten, valid terms just noted.
  for (let n = maxN; n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const span = toks.slice(i, i + n);
      if (span.some(t => t.done) || span.some(t => !t.key)) continue;
      const key = span.map(t => t.key).join(' ');
      const entry = lookup(key);
      if (!entry) continue;
      // Tail punctuation of the original last token survives the rewrite.
      const trail = (span[n - 1].orig.match(/[.,!?;:]+$/) || [''])[0];
      if (entry.method === 'garble') {
        const to = display(entry.canonical);
        corrections.push({ from: key, to, method: 'garble', score: 1 });
        // Fold the span: first token carries the rewrite (+ trailing punctuation), rest vanish.
        span.forEach((t, j) => { t.done = true; t.out = j === 0 ? to + trail : ''; });
      } else {
        span.forEach(t => { t.done = true; t.out = t.orig; });
      }
      note(entry);
      // A shop menu phrase ("ceramic window tint full vehicle") still carries
      // industry terms — note them so entities reflect what was actually asked.
      if (entry.kind === 'shop') noteIndustryTerms(key.split(' '), note);
    }
  }

  // 2. Ambiguous bare words ("ceramic", "paint protection", "film") → context or tag.
  //    These are 1–2 token keys; a longer valid phrase would already have consumed them.
  for (let i = 0; i < toks.length; i++) {
    for (let n = 2; n >= 1; n--) {
      if (i + n > toks.length) continue;
      const span = toks.slice(i, i + n);
      const key = span.map(t => t.key).join(' ');
      const amb = vocab.AMBIGUOUS[key];
      if (!amb) continue;
      // Already consumed by a longer phrase (e.g. "ceramic tint" or a shop menu name)?
      if (span.every(t => t.done)) break;
      // If the surrounding phrase pass already noted a specific option, it's not ambiguous.
      const alreadySpecific = amb.options.some(o => seenTerm.has(o));
      if (alreadySpecific) { span.forEach(t => { t.done = true; if (t.out === undefined) t.out = t.orig; }); break; }
      if (amb.options.length === 1) { note({ canonical: amb.options[0], kind: 'service' }); span.forEach(t => { t.done = true; if (t.out === undefined) t.out = t.orig; }); break; }
      // Context: which option does the assistant's last line point to?
      const hits = amb.options.filter(o => (amb.cues[o] || []).some(c => lastAi.includes(c)));
      const trail = (span[n - 1].orig.match(/[.,!?;:]+$/) || [''])[0];
      if (hits.length === 1) {
        const to = display(hits[0]);
        corrections.push({ from: key, to, method: 'context', score: 0.8 });
        span.forEach((t, j) => { t.done = true; t.out = j === 0 ? to + trail : ''; });
        note({ canonical: hits[0], kind: 'service' });
      } else {
        const label = `${span.map(t => t.orig).join(' ').replace(/[.,!?;:]+$/, '')} [${amb.options.map(display).join(' or ')}?]${trail}`;
        tags.push({ term: key, options: amb.options.map(display) });
        span.forEach((t, j) => { t.done = true; t.out = j === 0 ? label : ''; });
      }
      break;
    }
  }

  // 3. Fuzzy pass on leftover tokens — single unknown word → single vocab word.
  const targets = [...VOCAB_WORDS, ...shop.words];
  for (const t of toks) {
    if (t.done || !t.key || t.key.length < 5 || !/^[a-z]+$/.test(t.key)) continue;
    if (VOCAB_WORDS.has(t.key) || shop.words.has(t.key) || FUZZY_STOP.has(t.key)) continue;
    let best = null, second = 0;
    for (const w of targets) {
      if (Math.abs(w.length - t.key.length) > 2) continue;
      const s = similarity(t.key, w);
      if (!best || s > best.s) { second = best ? best.s : 0; best = { w, s }; }
      else if (s > second) second = s;
    }
    if (best && best.s >= 0.85 && best.s > second) {
      const trail = (t.orig.match(/[.,!?;:]+$/) || [''])[0];
      corrections.push({ from: t.key, to: best.w, method: 'fuzzy', score: Math.round(best.s * 100) / 100 });
      t.out = best.w + trail; t.done = true;
    }
  }

  // Assemble text.
  const text = toks.map(t => (t.out !== undefined ? t.out : t.orig)).filter(s => s !== '').join(' ').replace(/\s+([.,!?;:])/g, '$1').trim();
  const lowered = clean(text);

  // 4. Entities from the normalized text.
  // VLT numbers only mean something when the conversation is about glass — or
  // when the caller says "percent"/"%"/"legal", which on a shop line is tint.
  const tintContext = /\b(tint|window|windows|windshield|shade|dark|darker|film|limo|vlt|fronts?|rears?|legal|legally|percent)\b|%/.test(lowered) || /\b(tint|window|windshield|vlt|shade|percent)\b/.test(lastAi);
  let vlt = null;
  if (tintContext) {
    for (const p of VLT_PHRASES) {
      const bare = !/percent|%|limo|clear/.test(p.phrase);
      const re = new RegExp(`(^|\\s)${p.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
      if (re.test(lowered) && (!bare || /\bpercent\b|%/.test(lowered) || /\b(tint|shade|dark|vlt)\b/.test(lowered))) { vlt = p.pct; break; }
    }
  }
  let vehicle = null;
  for (const { phrase, v } of VEHICLE_PHRASES) {
    const re = new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (re.test(lowered)) { vehicle = { make: v.make, model: v.model, size: v.size, flag: v.flag || null }; break; }
  }
  let size = vehicle ? vehicle.size : null;
  if (!size) {
    for (const { phrase, size: s } of BODY_PHRASES) {
      const re = new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(lowered)) { size = s; break; }
    }
  }
  const year = (lowered.match(/\b(19[89]\d|20[0-4]\d)\b/) || [])[1] || null;
  if (vehicle && year) vehicle.year = year;
  if (!vehicle && year) vehicle = { year, make: '', model: '', size: size || null, flag: null };

  return {
    text, corrections, tags, changed: corrections.length > 0 || tags.length > 0,
    entities: { ...found, vlt, vehicle, size },
  };
}

// Multi-line transcripts (voicemail / answered call): normalize each spoken line,
// keeping any "Speaker N:" / "Caller:" prefix intact.
function normalizeTranscript(text, opts = {}) {
  const lines = String(text || '').split('\n');
  const corrections = [];
  const out = lines.map(line => {
    const m = line.match(/^(\s*[A-Za-z0-9 ]{1,20}:\s*)(.*)$/);
    const prefix = m ? m[1] : '';
    const body = m ? m[2] : line;
    if (!body.trim()) return line;
    const r = normalizeUtterance(body, opts);
    corrections.push(...r.corrections);
    return prefix + r.text;
  });
  return { text: out.join('\n'), corrections };
}

// One-line summary for logs: `ceramic tent→ceramic tint(garble), ceramik→ceramic(fuzzy 0.86)`
function describeCorrections(corrections) {
  return (corrections || []).map(c => `${c.from}→${c.to}(${c.method}${c.method === 'fuzzy' ? ' ' + c.score : ''})`).join(', ');
}

module.exports = { normalizeUtterance, normalizeTranscript, buildShopVocab, hintPhrases, describeCorrections, editDistance, splitName, estTokens, HINT_TOKEN_BUDGET, __tables: { PHRASES, VOCAB_WORDS } };

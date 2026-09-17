// ── Spoken-form rewriting (text → what the TTS voice should actually say) ─────
// The model writes "$450", "35%", "PPF", "F-150" because that is what the guard
// and the CRM need. A voice reads those inconsistently ("dollar four five zero",
// "puff", "eff dash one fifty"), so every reply passes through here before TTS:
//   • prices  → words ("four hundred fifty dollars")
//   • percent → words ("thirty-five percent")
//   • acronyms / model names → vocab.SPOKEN ("P P F", "F one fifty")
//   • "$450 to $600" ranges keep "to"; "/" between words → "or"
// Pure function, no side effects. Also exports SpeakBuffer: a word-boundary
// buffer for the streaming engine so a token like "$4" + "50" is never spoken
// half-formed (the model's deltas can split anywhere).
const { SPOKEN } = require('./vocab');

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberToWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'zero';
  if (n >= 1000000) return String(n); // out of scope for a phone quote — leave digits
  const parts = [];
  if (n >= 1000) { parts.push(numberToWords(Math.floor(n / 1000)) + ' thousand'); n %= 1000; }
  if (n >= 100) { parts.push(ONES[Math.floor(n / 100)] + ' hundred'); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '')); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}

// "$1,250" → "one thousand two hundred fifty dollars"; "$49.99" → "forty-nine ninety-nine".
function moneyToWords(raw) {
  const clean = String(raw).replace(/[$,\s]/g, '');
  const [whole, cents] = clean.split('.');
  const w = Number(whole) || 0;
  const c = cents ? Number(cents.padEnd(2, '0').slice(0, 2)) : 0;
  if (c) return `${numberToWords(w)} ${numberToWords(c)}`;
  return `${numberToWords(w)} dollar${w === 1 ? '' : 's'}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest keys first so "F-150" wins over "F". Word-boundary aware for alnum keys.
const SPOKEN_KEYS = Object.keys(SPOKEN).sort((a, b) => b.length - a.length);
const SPOKEN_RE = new RegExp(SPOKEN_KEYS.map(k => /^[\w.-]+$/.test(k) ? `(?<![\\w])${escapeRe(k)}(?![\\w])` : escapeRe(k)).join('|'), 'g');

function toSpokenForm(text) {
  let t = String(text == null ? '' : text);
  if (!t) return t;
  // Price ranges written with a dash: "$450–$600" / "$450-$600" → "$450 to $600".
  t = t.replace(/(\$\s?[\d,]+(?:\.\d+)?)\s?[–—-]\s?(\$?\s?[\d,]+(?:\.\d+)?)/g, (m, a, b) => `${a} to ${b.trim().startsWith('$') ? b.trim() : '$' + b.trim()}`);
  // Money.
  t = t.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, (m, num) => moneyToWords(num));
  // Percentages: "35%" / "35 %" → "thirty-five percent".
  t = t.replace(/(\d+(?:\.\d+)?)\s?%/g, (m, num) => `${numberToWords(num)} percent`);
  // "X to Y percent" already handled per-number. Acronyms and model names.
  t = t.replace(SPOKEN_RE, (m) => SPOKEN[m] != null ? SPOKEN[m] : m);
  // " / " between words → " or " (never touches dates like 9/16 — those have no spaces).
  t = t.replace(/(\w)\s\/\s(\w)/g, '$1 or $2');
  // Collapse whitespace the substitutions may have introduced.
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}

// Streaming helper: accumulate deltas, release complete words only. The tail
// (an unfinished word/number) is held until whitespace or punctuation closes it.
class SpeakBuffer {
  // { raw: true } releases whole-word chunks WITHOUT spoken-form conversion, for
  // a caller that wants to guard the text first and convert it afterwards.
  constructor(opts) { this.pending = ''; this.raw = !!(opts && opts.raw); }
  // Returns the text that is safe to speak now, or ''.
  push(delta) {
    this.pending += String(delta || '');
    // Release up to the last whitespace; keep the trailing partial token.
    const cut = this.pending.search(/\s[^\s]*$/);
    if (cut < 0) return '';
    // Don't split a money/percent token that's still being written ("$4" | "50").
    const out = this.pending.slice(0, cut + 1);
    this.pending = this.pending.slice(cut + 1);
    if (this.raw) return out;
    return toSpokenForm(out) + (out.endsWith(' ') ? ' ' : '');
  }
  flush() { const out = this.pending; this.pending = ''; if (!out) return ''; return this.raw ? out : toSpokenForm(out); }
}

module.exports = { toSpokenForm, numberToWords, moneyToWords, SpeakBuffer };

// ── Reply guard (hallucination backstop, server-side) ─────────────────────────
// The prompt says "prices come only from the menu". This makes it true even if
// the model slips: every spoken reply (and every tool argument that carries a
// price) is checked against the set of numbers the shop actually publishes.
//   • A dollar amount that is not on the menu is replaced with a neutral phrase
//     and logged as a guard hit — the caller hears "a number the shop will
//     confirm" instead of an invented price.
//   • Discount / promo language is logged (not rewritten — it can't be excised
//     cleanly mid-sentence) so the owner can see it in the brain trace.
// allowedPrices(menu, settings) builds the whitelist once per call.
const PRICE_PLACEHOLDER = 'a number the shop will confirm';

function allowedPrices(menu, settings) {
  const set = new Set();
  const add = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); if (Number.isFinite(n) && n > 0) set.add(n); };
  (menu && menu.services || []).forEach(s => {
    add(s.price);
    if (s.sizePricing) Object.values(s.sizePricing).forEach(add);
  });
  (menu && menu.addons || []).forEach(a => add(a.price));
  if (settings && settings.deposit && settings.deposit.amount) add(settings.deposit.amount);
  // Any dollar figure the owner wrote into the receptionist notes is fair game
  // (e.g. "$50 deposit", "$25 mobile fee").
  const notes = settings && settings.voiceAI && settings.voiceAI.notes;
  if (notes) String(notes).replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, (m, n) => { add(n); return m; });
  return set;
}

const DISCOUNT_RE = /\b(\d+\s?%\s?off|percent off|discount|coupon|promo(?:tion)?|special offer|price match|knock (?:a bit|some|\$?\d+) off|throw in)\b/i;

// Check one piece of spoken text. Returns { text, hits: [{ kind, value, at }] }.
function guardReply(text, allowed) {
  let out = String(text == null ? '' : text);
  const hits = [];
  if (!out) return { text: out, hits };
  out = out.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, (m, num) => {
    const n = Number(num.replace(/,/g, ''));
    if (allowed && allowed.has(n)) return m;
    hits.push({ kind: 'price', value: n });
    return PRICE_PLACEHOLDER;
  });
  // "450 dollars" written out: same rule.
  out = out.replace(/\b(\d[\d,]*)\s+(?:dollars|bucks)\b/gi, (m, num) => {
    const n = Number(num.replace(/,/g, ''));
    if (allowed && allowed.has(n)) return m;
    hits.push({ kind: 'price', value: n });
    return PRICE_PLACEHOLDER;
  });
  const d = out.match(DISCOUNT_RE);
  if (d) hits.push({ kind: 'discount', value: d[0] });
  return { text: out, hits };
}

// A quoted price the model puts in a tool call must also be a real menu number.
function guardPrice(value, allowed) {
  const n = value == null ? null : Number(value);
  if (n == null || !Number.isFinite(n)) return { value: null, hit: null };
  if (allowed && allowed.has(n)) return { value: n, hit: null };
  return { value: null, hit: { kind: 'price', value: n, where: 'tool' } };
}

module.exports = { allowedPrices, guardReply, guardPrice, PRICE_PLACEHOLDER };

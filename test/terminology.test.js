// Terminology accuracy suite — deterministic, no API key, runs in well under a
// second. Every row is a phrase phone STT has produced (or plausibly will) and
// what the normalizer must do with it: rewrite a known garble, tag an ambiguous
// word, recognize a vehicle/size/VLT, and — just as important — leave valid
// wording alone. Run: node test/terminology.test.js
const { normalizeUtterance, normalizeTranscript, buildShopVocab, hintPhrases } = require('../server/receptionist/normalize');
const { toSpokenForm, SpeakBuffer } = require('../server/receptionist/speak');
const { guardReply, guardPrice, allowedPrices } = require('../server/receptionist/guard');

let failures = 0;
function check(name, cond, detail) { if (!cond) { failures++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); } else console.log(`PASS  ${name}`); }

const N = (s, o) => normalizeUtterance(s, o);
const has = (r, sub) => r.text.toLowerCase().includes(sub.toLowerCase());

console.log('\n— garble rewrites (auto) —');
[
  ['how much for ceramic tent', 'ceramic tint'],
  ['how much for ceramic ten on my car', 'ceramic tint'],
  ['can I get sir amic tint', 'ceramic tint'],
  ['syringe tint for the whole car', 'ceramic tint'],
  ['carbon tent please', 'carbon tint'],
  ['died tint is fine', 'dyed tint'],
  ['I need windowton', 'window tint'],
  ['a window ton on the fronts', 'window tint'],
  ['do you do pain correction', 'paint correction'],
  ['paint connection on a black car', 'paint correction'],
  ['I want puff on the front end', 'PPF'],
  ['pff for the hood', 'PPF'],
  ['do you do ppf coating', 'PPF'],
  ['clear brow for my truck', 'PPF'],
  ['ceramic coding for a new car', 'ceramic coating'],
  ['paint coding', 'ceramic coating'],
  ['hydro phobic', 'hydrophobic'],
  ['self ceiling film', 'self healing'],
  ['door cusps and rockers', 'door cups'],
  ['odor remove all', 'odor removal'],
  ['pet air removal', 'pet hair'],
  ['head liner is stained', 'headliner'],
  ['swirl mark removal', 'swirl marks'],
  ['to step correction', 'two step correction'],
  ['one stop correction', 'one step correction'],
  ['windshield trip', 'windshield strip'],
  ['old vehicle tint', 'full vehicle'],
  ['the villa tea', 'VLT'],
].forEach(([inp, want]) => { const r = N(inp); check(`garble: "${inp}" → contains "${want}"`, has(r, want) && r.corrections.length >= 1, r.text); });

console.log('\n— valid wording is left alone —');
[
  'clear bra on the front', 'ceramic coating on my Tesla', 'ceramic tint for a Camry', 'paint correction and a coating',
  'PPF on the hood and bumper', 'full detail inside and out', 'window tint front two', 'I want the windshield strip too',
  'how much is paint protection film', 'interior detail with pet hair',
].forEach(inp => { const r = N(inp); check(`no rewrite: "${inp}"`, r.corrections.length === 0 && r.tags.length === 0, JSON.stringify(r.corrections.concat(r.tags))); });

console.log('\n— protected pairs never cross-map —');
{
  const r = N('I already have ceramic coating, do I still need tint?');
  check('coating + tint in one line: both noted, neither rewritten', r.entities.services.includes('ceramic coating') && r.entities.services.includes('window tint') && r.corrections.length === 0, JSON.stringify(r));
  const r2 = N('paint correction not paint protection');
  check('correction vs protection both survive', has(r2, 'paint correction') && has(r2, 'paint protection') && r2.corrections.length === 0, r2.text);
  const r3 = N('window treatment for the car');
  check('"window treatment" is NOT silently rewritten to window tint', !has(r3, 'window tint'), r3.text);
}

console.log('\n— ambiguity: tag, or resolve by context —');
{
  const r = N('how much for ceramic');
  check('bare "ceramic" is tagged', r.tags.length === 1 && /ceramic \[ceramic coating or ceramic tint\?\]/.test(r.text), r.text);
  const r2 = N('how much for ceramic', { lastAssistantText: 'Are you thinking window tint for the sides and back?' });
  check('bare "ceramic" resolves to tint when the AI was asking about tint', has(r2, 'ceramic tint') && r2.corrections[0].method === 'context', r2.text);
  const r3 = N('yeah the ceramic one', { lastAssistantText: 'For the paint, we do a ceramic coating with a one step correction.' });
  check('bare "ceramic" resolves to coating in a coating context', has(r3, 'ceramic coating'), r3.text);
  const r4 = N('do you do paint protection');
  check('bare "paint protection" is tagged PPF-or-coating', r4.tags.length === 1 && /\[PPF or ceramic coating\?\]/.test(r4.text), r4.text);
  const r5 = N('I want the ceramic tint');
  check('"ceramic tint" (full phrase) is never tagged', r5.tags.length === 0, r5.text);
}

console.log('\n— fuzzy: unknown near-miss → one vocab word, bounded —');
{
  const r = N('ceramik coating');
  check('ceramik → ceramic (fuzzy)', has(r, 'ceramic coating') && r.corrections[0].method === 'fuzzy', JSON.stringify(r.corrections));
  const r2 = N('the correctoin on the hood');
  check('correctoin → correction', has(r2, 'correction'), r2.text);
  const r3 = N('I was painting my fence and thinking about tint');
  check('"painting" is NOT corrected to paint', has(r3, 'painting') && r3.corrections.length === 0, JSON.stringify(r3.corrections));
  const r4 = N('what about the price');
  check('common English words untouched', r4.corrections.length === 0, JSON.stringify(r4.corrections));
}

console.log('\n— vehicles → size class —');
[
  ['ceramic tint on a four runner', 'Toyota', '4Runner', 'suv'],
  ['tint my model why', 'Tesla', 'Model Y', 'suv'],
  ['I have a model 3', 'Tesla', 'Model 3', 'sedan'],
  ['f one fifty crew cab', 'Ford', 'F-150', 'truck'],
  ['2021 tacoma', 'Toyota', 'Tacoma', 'truck'],
  ['its a civic', 'Honda', 'Civic', 'sedan'],
  ['a tahoe', 'Chevrolet', 'Tahoe', 'truck'],
  ['silver auto', 'Chevrolet', 'Silverado', 'truck'],
].forEach(([inp, make, model, size]) => { const r = N(inp); check(`vehicle: "${inp}" → ${make} ${model} (${size})`, r.entities.vehicle && r.entities.vehicle.make === make && r.entities.vehicle.model === model && r.entities.size === size, JSON.stringify(r.entities.vehicle)); });
{
  const r = N('its a 2021 tacoma');
  check('year captured', r.entities.vehicle && r.entities.vehicle.year === '2021', JSON.stringify(r.entities.vehicle));
  const r2 = N('just a small suv');
  check('body style fallback → suv', r2.entities.size === 'suv' && !r2.entities.vehicle, JSON.stringify(r2.entities));
  const r3 = N('cybertruck');
  check('Cybertruck flagged special-film', r3.entities.vehicle && r3.entities.vehicle.flag === 'special-film', JSON.stringify(r3.entities.vehicle));
}

console.log('\n— VLT —');
[
  ['five percent tint all around', 5], ['I want limo tint', 5], ['thirty five percent on the fronts', 35], ['twenty percent', 20], ['can I do 5% legally', 5],
].forEach(([inp, pct]) => { const r = N(inp); check(`vlt: "${inp}" → ${pct}`, r.entities.vlt === pct, String(r.entities.vlt)); });
{
  const r = N('I have five kids and a dog');
  check('bare "five" outside tint context is NOT a VLT', r.entities.vlt === null, String(r.entities.vlt));
}

console.log('\n— entities / shop vocabulary / hints —');
{
  const menu = { services: [{ name: 'Window Tint — Full Vehicle' }, { name: 'PPF — Full Front' }, { name: 'Ceramic Window Tint — Full Vehicle' }, { name: 'Bug & Tar Removal (exterior)' }], addons: [{ name: 'Pet Hair Removal' }] };
  const sv = buildShopVocab(menu);
  const r = N('I want the ceramic window tint full vehicle', { shopVocab: sv });
  check('shop phrase recognized as identity (no rewrite)', r.corrections.length === 0 && r.entities.services.includes('ceramic tint'), JSON.stringify(r));
  const hints = hintPhrases(menu);
  check('hints: no em-dash / parentheses', hints.every(h => !/[—–()&]/.test(h)), hints.filter(h => /[—–()&]/.test(h)).join('|'));
  check('hints: shop names split into spoken parts', hints.includes('Window Tint') && hints.includes('Full Vehicle') && hints.includes('PPF Full Front'), hints.slice(0, 8).join('|'));
  check('hints: ≤100 chars, ≤500 entries, deduped', hints.length <= 500 && hints.every(h => h.length <= 100) && new Set(hints.map(h => h.toLowerCase())).size === hints.length);
  // Deepgram rejects >500 keyterm tokens and the call drops — keep well under.
  const { estTokens, HINT_TOKEN_BUDGET } = require('../server/receptionist/normalize');
  const tok = hints.reduce((n, h) => n + estTokens(h), 0);
  check(`hints: token estimate ${tok} ≤ budget ${HINT_TOKEN_BUDGET} (Deepgram hard limit 500)`, tok <= HINT_TOKEN_BUDGET && HINT_TOKEN_BUDGET <= 300);
  const bigMenu = { services: Array.from({ length: 40 }, (_, i) => ({ name: `Premium Service Package Number ${i} — Full Vehicle` })), addons: [] };
  const bigHints = hintPhrases(bigMenu);
  check('hints: a huge menu still stays under budget (shop names take priority)', bigHints.reduce((n, h) => n + estTokens(h), 0) <= HINT_TOKEN_BUDGET && bigHints[0] === 'Premium Service Package Number 0 Full Vehicle');
  check('hints: core terms survive, vehicle brands are what gets cut', hints.includes('ceramic tint') && hints.includes('PPF') && hints.includes('paint correction') && hints.includes('windshield strip'));
  const t = normalizeTranscript('Speaker 1: hi I want pain correction\nSpeaker 2: sure what car');
  check('transcript normalization keeps speaker prefixes', /^Speaker 1: hi I want paint correction\nSpeaker 2: sure what car$/.test(t.text), t.text);
}

console.log('\n— spoken form (TTS) —');
[
  ['carbon starts at $450 and ceramic at $600', 'carbon starts at four hundred fifty dollars and ceramic at six hundred dollars'],
  ['PPF on the full front is $1,100', 'P P F on the full front is one thousand one hundred dollars'],
  ['it blocks 99% of UV and 35% is the legal limit', 'it blocks ninety-nine percent of U V and thirty-five percent is the legal limit'],
  ['for your F-150 and the 4Runner', 'for your F one fifty and the four runner'],
  ['sedan / coupe pricing', 'sedan or coupe pricing'],
  ['it runs $450–$600 depending on size', 'it runs four hundred fifty dollars to six hundred dollars depending on size'],
  ['a $50 deposit', 'a fifty dollars deposit'],
].forEach(([inp, want]) => { const got = toSpokenForm(inp); check(`spoken: "${inp}"`, got === want, `got "${got}"`); });
{
  const b = new SpeakBuffer();
  const out = b.push('ceramic runs $4') + b.push('50 for') + b.push(' a sedan') + b.flush();
  check('stream buffer never splits "$450" across deltas', out.replace(/\s+/g, ' ').trim() === 'ceramic runs four hundred fifty dollars for a sedan', out);
  const b2 = new SpeakBuffer();
  const first = b2.push('PP');
  check('stream buffer holds a partial acronym', first === '' && (b2.push('F is ') + b2.flush()).startsWith('P P F'), first);
}

console.log('\n— reply guard —');
{
  const menu = { services: [{ price: 250, sizePricing: { sedan: 450, suv: 550 } }, { price: 600 }], addons: [{ price: 30 }] };
  const allowed = allowedPrices(menu, { deposit: { amount: 50 }, voiceAI: { notes: 'Mobile fee $25.' } });
  check('allowed set includes menu, sizes, addons, deposit, notes', [250, 450, 550, 600, 30, 50, 25].every(n => allowed.has(n)));
  const ok = guardReply('Ceramic starts at $450 for a sedan, with a $50 deposit.', allowed);
  check('menu prices pass through', ok.hits.length === 0 && ok.text.includes('$450'), JSON.stringify(ok));
  const bad = guardReply('I can do it for $399 today, that is 20% off.', allowed);
  check('invented price replaced + discount logged', bad.hits.some(h => h.kind === 'price' && h.value === 399) && bad.hits.some(h => h.kind === 'discount') && !bad.text.includes('$399'), JSON.stringify(bad));
  const words = guardReply('around 700 dollars', allowed);
  check('"700 dollars" written out is also caught', words.hits.length === 1 && !/700/.test(words.text), JSON.stringify(words));
  check('guardPrice rejects a tool-call price not on the menu', guardPrice(399, allowed).value === null && guardPrice(450, allowed).value === 450);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);

// ── Automotive vocabulary (industry-level, shared by every shop) ──────────────
// The single source of truth for what the receptionist may hear, say, and store.
// Three jobs:
//   1. TERMS  — canonical phrases + the aliases callers use + the garbles phone
//              STT produces ("ceramic tent"). normalize.js maps text onto these.
//   2. PROTECTED / AMBIGUOUS — pairs that must NEVER be swapped by fuzzy matching
//              (ceramic coating vs ceramic tint) and bare words that need a
//              clarifying question, not a guess.
//   3. VEHICLES / SPOKEN / HINTS — model→size lookup, how TTS should pronounce
//              acronyms, and clean phrases for the speech recognizer.
// Shop-specific terms (menu names) are layered on top at runtime; see
// normalize.buildShopVocab(). Keep everything lowercase except SPOKEN keys.

// kind: service | coverage | feature | defect | level | vlt | misc
const TERMS = [
  // ── Window tint ─────────────────────────────────────────────────────────────
  { canonical: 'window tint', kind: 'service', aliases: ['tint', 'tinting', 'window tinting', 'window film', 'tint film', 'tinted windows', 'tint job'],
    garbles: ['windowton', 'window ton', 'window tent', 'tent', 'tint filmed', 'when do tint', 'wind o tint', 'window tin'] },
  { canonical: 'ceramic tint', kind: 'service', aliases: ['ceramic window tint', 'ceramic film', 'ceramic window film', 'ir tint', 'infrared tint', 'nano ceramic tint'],
    garbles: ['ceramic tent', 'ceramic ten', 'ceramic tin', 'sir amic tint', 'syringe tint', 'seramic tint', 'ceramic tint', 'ceramic tents', 'cerami tint', 'ceramic tinting'] },
  { canonical: 'carbon tint', kind: 'service', aliases: ['carbon film', 'carbon window tint'], garbles: ['carbon tent', 'carbon ten', 'carbin tint', 'carbon tin'] },
  { canonical: 'dyed tint', kind: 'service', aliases: ['dyed film', 'basic tint', 'standard tint', 'regular tint'], garbles: ['died tint', 'dye tint', 'dyed tent', 'died tent'] },
  { canonical: 'windshield strip', kind: 'coverage', aliases: ['visor strip', 'sun strip', 'sun visor strip', 'eyebrow', 'brow strip', 'windshield visor', 'strip on the windshield', 'top strip'], garbles: ['windshield trip', 'wind shield strip', 'visor trip'] },
  { canonical: 'windshield', kind: 'coverage', aliases: ['front windshield', 'front glass', 'full windshield', 'whole windshield'], garbles: ['wind shield', 'windshields', 'wind sheild'] },
  { canonical: 'front two windows', kind: 'coverage', aliases: ['front windows', 'two front windows', 'the two fronts', 'fronts', 'front two', 'front doors', 'front door windows', 'driver and passenger windows', 'front side windows', 'front sides'], garbles: ['front to windows', 'front too windows', 'two fronts', 'front to'] },
  { canonical: 'rear windows', kind: 'coverage', aliases: ['back windows', 'rear side windows', 'back side windows', 'rear doors', 'back doors', 'rears', 'the backs'], garbles: [] },
  { canonical: 'rear windshield', kind: 'coverage', aliases: ['back glass', 'rear glass', 'back window', 'rear window', 'back windshield'], garbles: ['back class', 'rear class'] },
  { canonical: 'sunroof', kind: 'coverage', aliases: ['moonroof', 'moon roof', 'sun roof'], garbles: ['sunruf', 'sun ruff'] },
  { canonical: 'panoramic roof', kind: 'coverage', aliases: ['pano roof', 'glass roof', 'panoramic sunroof', 'panoramic glass', 'the glass on top', 'panoramic'], garbles: ['pana roof', 'panorama roof', 'pan a roof', 'panoramic roof'] },
  { canonical: 'full vehicle', kind: 'coverage', aliases: ['whole car', 'full car', 'all the windows', 'all windows', 'every window', 'all around', 'the whole thing', 'entire car', 'full tint', 'all sides'], garbles: ['old vehicle', 'full vehicle', 'full a vehicle', 'fool vehicle', 'whole car'] },
  { canonical: 'uv protection', kind: 'feature', aliases: ['uv', 'uv rays', 'ultraviolet', 'uv blocking', 'sun protection'], garbles: ['you v protection', 'u v protection', 'you v rays'] },
  { canonical: 'heat rejection', kind: 'feature', aliases: ['heat blocking', 'blocks heat', 'keep it cool', 'keeps the car cool', 'heat', 'infrared rejection', 'ir rejection'], garbles: ['heat rejections', 'heat rejecting', 'heat reject'] },
  { canonical: 'glare', kind: 'feature', aliases: ['glare reduction', 'anti glare'], garbles: ['glair', 'glare reduction'] },
  { canonical: 'privacy', kind: 'feature', aliases: ['privacy tint', 'blackout', 'black out', 'limo tint', 'limo', 'dark tint', 'darkest'], garbles: ['privacy'] },
  { canonical: 'legal tint', kind: 'feature', aliases: ['legal', 'legal limit', 'street legal', 'what is legal', 'legal shade', 'legally'], garbles: ['legal tent', 'legal ten'] },
  { canonical: 'vlt', kind: 'vlt', aliases: ['v l t', 'visible light transmission', 'light transmission', 'shade', 'darkness', 'how dark', 'percent'], garbles: ['villa tea', 'v l tea', 'vault', 'vlt'] },
  { canonical: 'tint removal', kind: 'service', aliases: ['remove the tint', 'old tint off', 'take the tint off', 'strip the tint', 'tint strip off', 'removal', 'peel the tint', 'bubbling tint', 'purple tint'], garbles: ['tent removal', 'tint remover'] },

  // ── Ceramic coating ─────────────────────────────────────────────────────────
  { canonical: 'ceramic coating', kind: 'service', aliases: ['paint coating', 'coating', 'nano coating', 'glass coating', 'ceramic paint coating', 'ceramic paint protection', 'ceramic sealant', 'ceramic pro', 'coat the car', 'get it coated', 'ceramic coat', 'ceramic coated', 'ceramic protection'],
    garbles: ['ceramic coding', 'ceramic coping', 'ceramic cooling', 'ceramic goading', 'ceramic co ding', 'seramic coating', 'sir amic coating', 'syringe coating', 'ceramic coatings', 'paint coding', 'ceramic quoting', 'ceramic boating'] },
  { canonical: 'hydrophobic', kind: 'feature', aliases: ['water beading', 'beads water', 'water beads', 'sheets water', 'water repellent', 'water repelling', 'slick'], garbles: ['hydro phobic', 'hydrophobia', 'hydro fobic', 'hydrophobic'] },
  { canonical: 'gloss', kind: 'feature', aliases: ['shine', 'shiny', 'glossy', 'make it shine', 'bring back the shine', 'deep gloss', 'wet look'], garbles: ['glass look'] },
  { canonical: 'decontamination', kind: 'feature', aliases: ['decon', 'clay bar', 'iron remover', 'iron decon', 'clay', 'chemical decon'], garbles: ['decontaminate', 'de con', 'clay bar'] },
  { canonical: 'prep', kind: 'feature', aliases: ['prep work', 'preparation', 'paint prep', 'surface prep'], garbles: [] },
  { canonical: 'maintenance', kind: 'feature', aliases: ['maintenance wash', 'upkeep', 'aftercare', 'how do i take care of it', 'maintain it'], garbles: [] },
  { canonical: 'longevity', kind: 'feature', aliases: ['how long does it last', 'how long it lasts', 'lasts', 'durability', 'years'], garbles: [] },

  // ── PPF ─────────────────────────────────────────────────────────────────────
  { canonical: 'ppf', kind: 'service', aliases: ['paint protection film', 'clear bra', 'clear film', 'protection film', 'rock chip film', 'rock chip protection', 'chip protection', 'clear wrap', 'p p f', 'xpel', 'suntek', 'stek', 'the film on the paint', 'film on the front'],
    garbles: ['puff', 'pff', 'pbf', 'p f f', 'pdf', 'p p s', 'ppf coating', 'ppf film', 'pain protection film', 'paint protection filmed', 'clear brow', 'clear bar', 'clear bras', 'clear bro', 'clear bra', 'clear braw', 'clear bras'] },
  { canonical: 'full front', kind: 'coverage', aliases: ['full front end', 'front end', 'whole front', 'entire front', 'front of the car', 'the nose', 'front clip', 'front package'], garbles: ['full fronts', 'fool front', 'full front and'] },
  { canonical: 'partial front', kind: 'coverage', aliases: ['partial hood', 'partial front end', 'bumper and partial hood', 'standard front', 'basic front', 'leading edge'], garbles: ['partial fronts'] },
  { canonical: 'full body', kind: 'coverage', aliases: ['whole car ppf', 'full car ppf', 'full wrap', 'entire car', 'full vehicle ppf', 'every panel', 'the entire thing'], garbles: ['full buddy', 'full bodies'] },
  { canonical: 'bumper', kind: 'coverage', aliases: ['front bumper', 'rear bumper', 'bumpers'], garbles: ['bumber', 'bump her'] },
  { canonical: 'hood', kind: 'coverage', aliases: ['full hood', 'the hood', 'bonnet'], garbles: ['hoodie', 'who d'] },
  { canonical: 'fenders', kind: 'coverage', aliases: ['fender', 'front fenders', 'quarter panels'], garbles: ['fender is', 'senders'] },
  { canonical: 'mirrors', kind: 'coverage', aliases: ['side mirrors', 'mirror caps', 'mirror'], garbles: ['mirrors'] },
  { canonical: 'rocker panels', kind: 'coverage', aliases: ['rockers', 'rocker', 'side skirts', 'sills', 'lower doors'], garbles: ['rock or panels', 'rocket panels', 'rocker panels'] },
  { canonical: 'door cups', kind: 'coverage', aliases: ['door handle cups', 'handle cups', 'door handles', 'door edges', 'door edge guards'], garbles: ['door cusps', 'door cops', 'door cuts'] },
  { canonical: 'high impact areas', kind: 'coverage', aliases: ['high impact', 'impact areas', 'where the rocks hit', 'the chip areas', 'track package', 'track pack'], garbles: ['high impact area'] },
  { canonical: 'self healing', kind: 'feature', aliases: ['self heals', 'heals itself', 'self-healing', 'healing film'], garbles: ['self ceiling', 'self sealing', 'self feeling', 'self heeling'] },
  { canonical: 'rock chips', kind: 'defect', aliases: ['rock chip', 'chips', 'stone chips', 'chipping', 'road debris', 'gravel', 'sand blasting', 'sandblasted'], garbles: ['rock ships', 'rock chip', 'rock chips'] },

  // ── Detailing ───────────────────────────────────────────────────────────────
  { canonical: 'interior detail', kind: 'service', aliases: ['interior', 'inside detail', 'the inside', 'inside cleaned', 'interior cleaning', 'interior clean', 'cabin detail', 'inside only'], garbles: ['interior details', 'in tear your detail', 'interior de tail'] },
  { canonical: 'exterior detail', kind: 'service', aliases: ['exterior', 'outside detail', 'the outside', 'outside only', 'exterior clean', 'wash and wax', 'wash and seal'], garbles: ['exterior details', 'ex tear your detail'] },
  { canonical: 'full detail', kind: 'service', aliases: ['complete detail', 'the works', 'full service detail', 'inside and out', 'inside and outside', 'whole car detailed', 'full clean', 'everything', 'full detailing', 'a detail', 'detail', 'detailed', 'detailing'], garbles: ['fool detail', 'full details', 'full de tail', 'full tail', 'full retail'] },
  { canonical: 'maintenance detail', kind: 'service', aliases: ['maintenance clean', 'quick detail', 'light detail', 'mini detail', 'basic detail', 'regular detail', 'monthly detail', 'express detail', 'touch up detail'], garbles: ['maintenance details'] },
  { canonical: 'deep clean', kind: 'service', aliases: ['deep cleaning', 'heavy clean', 'thorough clean', 'restore the interior', 'neglected', 'really dirty', 'trashed', 'destroyed', 'filthy'], garbles: ['deep queen', 'deep clean'] },
  { canonical: 'shampoo', kind: 'feature', aliases: ['carpet shampoo', 'seat shampoo', 'shampooed', 'steam clean', 'steam cleaned', 'hot water extraction'], garbles: ['sham poo', 'shampoo'] },
  { canonical: 'extraction', kind: 'feature', aliases: ['extracted', 'extractor', 'carpet extraction', 'wet vac'], garbles: ['extract shun', 'extractions', 'a traction'] },
  { canonical: 'stain removal', kind: 'feature', aliases: ['stains', 'stain', 'coffee stain', 'spill', 'spills', 'stained seats', 'stained carpet'], garbles: ['stain remove all', 'stain removal'] },
  { canonical: 'odor removal', kind: 'feature', aliases: ['odor', 'smell', 'smells', 'stink', 'stinks', 'smoke smell', 'cigarette smell', 'mildew', 'musty', 'ozone', 'ozone treatment', 'odor treatment', 'deodorize', 'get the smell out'], garbles: ['odor remove all', 'oder removal', 'order removal', 'odor removals'] },
  { canonical: 'pet hair', kind: 'feature', aliases: ['dog hair', 'cat hair', 'animal hair', 'fur', 'dog fur', 'hair everywhere', 'pet hair removal'], garbles: ['pet air', 'pet hare', 'pat hair'] },
  { canonical: 'leather', kind: 'feature', aliases: ['leather seats', 'leather clean', 'leather conditioning', 'condition the leather', 'leather condition'], garbles: ['lether', 'leather seats'] },
  { canonical: 'seats', kind: 'feature', aliases: ['cloth seats', 'fabric seats', 'the seats', 'seat cleaning', 'car seats'], garbles: ['seeds', 'sheets', 'seat'] },
  { canonical: 'carpets', kind: 'feature', aliases: ['carpet', 'floor mats', 'mats', 'floors', 'the floor'], garbles: ['car pets', 'carpits', 'carpet'] },
  { canonical: 'headliner', kind: 'feature', aliases: ['the ceiling', 'roof liner', 'roof inside'], garbles: ['head liner', 'head line', 'headline', 'head lining'] },
  { canonical: 'engine bay', kind: 'feature', aliases: ['engine', 'under the hood', 'engine cleaning', 'engine clean', 'engine bay detail', 'engine compartment'], garbles: ['engine day', 'engine bae', 'engine bay'] },

  // ── Paint correction ────────────────────────────────────────────────────────
  { canonical: 'paint correction', kind: 'service', aliases: ['correction', 'polish the paint', 'polishing', 'buff', 'buffing', 'buff it out', 'buffed', 'machine polish', 'cut and polish', 'cut and buff', 'swirl removal', 'remove swirls', 'get the swirls out', 'fix the paint', 'restore the paint'],
    garbles: ['pain correction', 'paint connection', 'paint correction', 'paint corrections', 'paint direction', 'paint collection', 'pain corrections', 'paint corruption'] },
  { canonical: 'one step correction', kind: 'level', aliases: ['one step', '1 step', 'single stage', 'single step', 'one stage', 'light correction', 'enhancement polish', 'gloss enhancement', 'one step polish'], garbles: ['one stop correction', 'won step', 'one set correction'] },
  { canonical: 'two step correction', kind: 'level', aliases: ['two step', '2 step', 'two stage', 'multi step', 'multi stage', 'full correction', 'heavy correction', 'compound and polish', 'two step polish'], garbles: ['to step correction', 'too step', 'two set correction', 'two stop correction'] },
  { canonical: 'polish', kind: 'feature', aliases: ['polished', 'polishing pad', 'finishing polish'], garbles: ['polish', 'pole ish', 'polished'] },
  { canonical: 'compound', kind: 'feature', aliases: ['compounding', 'cutting compound', 'cut', 'heavy cut'], garbles: ['compound', 'com pound'] },
  { canonical: 'oxidation', kind: 'defect', aliases: ['oxidized', 'oxidised', 'faded', 'fading', 'chalky', 'dull', 'dull paint', 'hazy', 'sun damage', 'sun damaged'], garbles: ['oxide ation', 'ox a dation', 'oxidations'] },
  { canonical: 'swirl marks', kind: 'defect', aliases: ['swirls', 'swirl', 'spider webs', 'spiderwebs', 'spider webbing', 'micro scratches', 'wash marks', 'buffer trails', 'holograms'], garbles: ['swirl mark', 'swirled marks', 'squirrel marks', 'swill marks'] },
  { canonical: 'scratches', kind: 'defect', aliases: ['scratch', 'scratched', 'key scratch', 'keyed', 'deep scratch', 'scuff', 'scuffs', 'scuffed', 'scrape'], garbles: ['scratch is', 'scratched is', 'scratches'] },
  { canonical: 'water spots', kind: 'defect', aliases: ['water spot', 'hard water', 'hard water spots', 'water stains', 'sprinkler spots', 'mineral spots', 'etching', 'etched'], garbles: ['water spot', 'water sports', 'waters pots'] },
  { canonical: 'clarity', kind: 'feature', aliases: ['clear', 'clearer', 'depth', 'reflection', 'reflections', 'mirror finish'], garbles: [] },
];

// Pairs that fuzzy matching must NEVER cross-map. When both sides are plausible
// the normalizer tags the text for a clarifying question instead of guessing.
const PROTECTED = [
  ['ceramic coating', 'ceramic tint'],
  ['paint correction', 'paint protection'],
  ['paint correction', 'ppf'],
  ['ppf', 'ceramic coating'],
  ['window tint', 'window treatment'],
  ['full front', 'full body'],
  ['one step correction', 'two step correction'],
  ['interior detail', 'exterior detail'],
];

// Bare words that mean two different products. `options` are canonical terms;
// `cues` are words in the previous assistant line that resolve it by context.
const AMBIGUOUS = {
  'ceramic': { options: ['ceramic coating', 'ceramic tint'], cues: { 'ceramic coating': ['coating', 'paint', 'gloss', 'correction'], 'ceramic tint': ['tint', 'window', 'film', 'windshield', 'glass'] } },
  'paint protection': { options: ['ppf', 'ceramic coating'], cues: { 'ppf': ['ppf', 'film', 'chip', 'clear bra', 'front'], 'ceramic coating': ['coating', 'gloss', 'hydrophobic'] } },
  'protection': { options: ['ppf', 'ceramic coating'], cues: { 'ppf': ['ppf', 'film', 'chip', 'front'], 'ceramic coating': ['coating', 'ceramic'] } },
  'film': { options: ['window tint', 'ppf'], cues: { 'window tint': ['tint', 'window', 'shade', 'dark'], 'ppf': ['ppf', 'paint', 'chip', 'front', 'hood'] } },
  'coating': { options: ['ceramic coating'], cues: {} }, // one product — resolves immediately
};

// VLT phrases → percent. Only applied in a tint context (see normalize.js).
const VLT = [
  { pct: 5, phrases: ['five percent', '5 percent', '5%', 'limo', 'limo tint', 'five'] },
  { pct: 15, phrases: ['fifteen percent', '15 percent', '15%', 'fifteen'] },
  { pct: 20, phrases: ['twenty percent', '20 percent', '20%', 'twenty'] },
  { pct: 25, phrases: ['twenty five percent', '25 percent', '25%', 'twenty five', 'twenty-five'] },
  { pct: 30, phrases: ['thirty percent', '30 percent', '30%', 'thirty'] },
  { pct: 35, phrases: ['thirty five percent', '35 percent', '35%', 'thirty five', 'thirty-five'] },
  { pct: 50, phrases: ['fifty percent', '50 percent', '50%', 'fifty'] },
  { pct: 70, phrases: ['seventy percent', '70 percent', '70%', 'seventy', 'clear ceramic', 'clear tint'] },
];

// Common vehicles → make/model/size class (sedan | suv | truck). Spoken/garbled
// forms are listed so "four runner" and "model why" resolve. Matching is on
// whole words, longest phrase first; size drives per-size menu pricing.
const VEHICLES = [
  // Tesla
  { make: 'Tesla', model: 'Model 3', size: 'sedan', phrases: ['model 3', 'model three', 'tesla 3', 'tesla three'] },
  { make: 'Tesla', model: 'Model Y', size: 'suv', phrases: ['model y', 'model why', 'tesla y', 'tesla why'] },
  { make: 'Tesla', model: 'Model S', size: 'sedan', phrases: ['model s', 'model ess', 'tesla s'] },
  { make: 'Tesla', model: 'Model X', size: 'suv', phrases: ['model x', 'model ex', 'tesla x'] },
  { make: 'Tesla', model: 'Cybertruck', size: 'truck', phrases: ['cybertruck', 'cyber truck'], flag: 'special-film' },
  // Toyota
  { make: 'Toyota', model: '4Runner', size: 'suv', phrases: ['4runner', 'four runner', '4 runner', 'forerunner', 'for runner'] },
  { make: 'Toyota', model: 'Tacoma', size: 'truck', phrases: ['tacoma', 'taco ma'] },
  { make: 'Toyota', model: 'Tundra', size: 'truck', phrases: ['tundra'] },
  { make: 'Toyota', model: 'Camry', size: 'sedan', phrases: ['camry', 'cam ry'] },
  { make: 'Toyota', model: 'Corolla', size: 'sedan', phrases: ['corolla', 'corona'] },
  { make: 'Toyota', model: 'RAV4', size: 'suv', phrases: ['rav4', 'rav 4', 'rav four', 'rough four'] },
  { make: 'Toyota', model: 'Highlander', size: 'suv', phrases: ['highlander'] },
  { make: 'Toyota', model: 'Sequoia', size: 'truck', phrases: ['sequoia'] },
  { make: 'Toyota', model: 'Sienna', size: 'suv', phrases: ['sienna'] },
  { make: 'Toyota', model: 'Prius', size: 'sedan', phrases: ['prius'] },
  { make: 'Toyota', model: 'Supra', size: 'sedan', phrases: ['supra'] },
  { make: 'Toyota', model: 'GR86', size: 'sedan', phrases: ['gr86', 'gr 86', 'eighty six', '86'] },
  // Honda / Acura
  { make: 'Honda', model: 'Civic', size: 'sedan', phrases: ['civic'] },
  { make: 'Honda', model: 'Accord', size: 'sedan', phrases: ['accord', 'a cord'] },
  { make: 'Honda', model: 'CR-V', size: 'suv', phrases: ['cr-v', 'crv', 'c r v'] },
  { make: 'Honda', model: 'Pilot', size: 'suv', phrases: ['pilot'] },
  { make: 'Honda', model: 'Odyssey', size: 'suv', phrases: ['odyssey'] },
  { make: 'Honda', model: 'Ridgeline', size: 'truck', phrases: ['ridgeline'] },
  { make: 'Acura', model: 'TLX', size: 'sedan', phrases: ['tlx', 't l x'] },
  { make: 'Acura', model: 'MDX', size: 'suv', phrases: ['mdx', 'm d x'] },
  { make: 'Acura', model: 'RDX', size: 'suv', phrases: ['rdx', 'r d x'] },
  // Ford
  { make: 'Ford', model: 'F-150', size: 'truck', phrases: ['f-150', 'f150', 'f 150', 'f one fifty', 'f one 50', 'f1 50', 'f150 lightning', 'lightning'] },
  { make: 'Ford', model: 'F-250', size: 'truck', phrases: ['f-250', 'f250', 'f 250', 'f two fifty', 'super duty', 'f-350', 'f350', 'f three fifty'] },
  { make: 'Ford', model: 'Mustang', size: 'sedan', phrases: ['mustang', 'must tang'] },
  { make: 'Ford', model: 'Explorer', size: 'suv', phrases: ['explorer'] },
  { make: 'Ford', model: 'Expedition', size: 'truck', phrases: ['expedition'] },
  { make: 'Ford', model: 'Bronco', size: 'suv', phrases: ['bronco', 'bronco sport'] },
  { make: 'Ford', model: 'Escape', size: 'suv', phrases: ['escape'] },
  { make: 'Ford', model: 'Ranger', size: 'truck', phrases: ['ranger'] },
  { make: 'Ford', model: 'Maverick', size: 'truck', phrases: ['maverick'] },
  // Chevy / GMC / Cadillac
  { make: 'Chevrolet', model: 'Silverado', size: 'truck', phrases: ['silverado', 'silver auto', 'silver rado'] },
  { make: 'Chevrolet', model: 'Tahoe', size: 'truck', phrases: ['tahoe', 'ta ho'] },
  { make: 'Chevrolet', model: 'Suburban', size: 'truck', phrases: ['suburban'] },
  { make: 'Chevrolet', model: 'Corvette', size: 'sedan', phrases: ['corvette', 'vette'] },
  { make: 'Chevrolet', model: 'Camaro', size: 'sedan', phrases: ['camaro'] },
  { make: 'Chevrolet', model: 'Equinox', size: 'suv', phrases: ['equinox'] },
  { make: 'Chevrolet', model: 'Traverse', size: 'suv', phrases: ['traverse'] },
  { make: 'Chevrolet', model: 'Colorado', size: 'truck', phrases: ['colorado'] },
  { make: 'Chevrolet', model: 'Malibu', size: 'sedan', phrases: ['malibu'] },
  { make: 'GMC', model: 'Sierra', size: 'truck', phrases: ['sierra', 'gmc sierra'] },
  { make: 'GMC', model: 'Yukon', size: 'truck', phrases: ['yukon', 'yukon denali'] },
  { make: 'GMC', model: 'Acadia', size: 'suv', phrases: ['acadia'] },
  { make: 'Cadillac', model: 'Escalade', size: 'truck', phrases: ['escalade'] },
  // Ram / Jeep / Dodge
  { make: 'Ram', model: '1500', size: 'truck', phrases: ['ram 1500', 'ram fifteen hundred', 'ram', 'ram 2500', 'ram twenty five hundred', 'dodge ram'] },
  { make: 'Jeep', model: 'Wrangler', size: 'suv', phrases: ['wrangler', 'jeep wrangler', 'jeep'] },
  { make: 'Jeep', model: 'Grand Cherokee', size: 'suv', phrases: ['grand cherokee', 'cherokee'] },
  { make: 'Jeep', model: 'Gladiator', size: 'truck', phrases: ['gladiator'] },
  { make: 'Dodge', model: 'Charger', size: 'sedan', phrases: ['charger'] },
  { make: 'Dodge', model: 'Challenger', size: 'sedan', phrases: ['challenger'] },
  { make: 'Dodge', model: 'Durango', size: 'suv', phrases: ['durango'] },
  // Nissan / Infiniti
  { make: 'Nissan', model: 'Altima', size: 'sedan', phrases: ['altima'] },
  { make: 'Nissan', model: 'Sentra', size: 'sedan', phrases: ['sentra'] },
  { make: 'Nissan', model: 'Rogue', size: 'suv', phrases: ['rogue'] },
  { make: 'Nissan', model: 'Titan', size: 'truck', phrases: ['titan'] },
  { make: 'Nissan', model: 'Frontier', size: 'truck', phrases: ['frontier'] },
  { make: 'Nissan', model: 'Pathfinder', size: 'suv', phrases: ['pathfinder'] },
  { make: 'Nissan', model: 'Armada', size: 'truck', phrases: ['armada'] },
  { make: 'Nissan', model: '370Z', size: 'sedan', phrases: ['370z', 'three seventy z', '350z', 'z'] },
  { make: 'Infiniti', model: 'Q50', size: 'sedan', phrases: ['q50', 'q fifty'] },
  { make: 'Infiniti', model: 'QX60', size: 'suv', phrases: ['qx60', 'qx sixty', 'qx80', 'qx eighty'] },
  // Subaru / Mazda / Hyundai / Kia
  { make: 'Subaru', model: 'Outback', size: 'suv', phrases: ['outback'] },
  { make: 'Subaru', model: 'Forester', size: 'suv', phrases: ['forester'] },
  { make: 'Subaru', model: 'WRX', size: 'sedan', phrases: ['wrx', 'w r x', 'sti'] },
  { make: 'Subaru', model: 'Crosstrek', size: 'suv', phrases: ['crosstrek', 'cross trek'] },
  { make: 'Mazda', model: 'CX-5', size: 'suv', phrases: ['cx-5', 'cx5', 'c x five', 'cx 5', 'cx-50', 'cx-90', 'cx ninety'] },
  { make: 'Mazda', model: 'Mazda3', size: 'sedan', phrases: ['mazda 3', 'mazda three', 'mazda3'] },
  { make: 'Mazda', model: 'Miata', size: 'sedan', phrases: ['miata', 'mx-5', 'mx5'] },
  { make: 'Hyundai', model: 'Elantra', size: 'sedan', phrases: ['elantra'] },
  { make: 'Hyundai', model: 'Sonata', size: 'sedan', phrases: ['sonata'] },
  { make: 'Hyundai', model: 'Tucson', size: 'suv', phrases: ['tucson'] },
  { make: 'Hyundai', model: 'Santa Fe', size: 'suv', phrases: ['santa fe'] },
  { make: 'Hyundai', model: 'Palisade', size: 'suv', phrases: ['palisade'] },
  { make: 'Hyundai', model: 'Ioniq 5', size: 'suv', phrases: ['ioniq', 'ioniq 5', 'ioniq five', 'ionic'] },
  { make: 'Kia', model: 'Telluride', size: 'suv', phrases: ['telluride'] },
  { make: 'Kia', model: 'Sorento', size: 'suv', phrases: ['sorento'] },
  { make: 'Kia', model: 'K5', size: 'sedan', phrases: ['k5', 'k five', 'optima', 'stinger'] },
  { make: 'Kia', model: 'EV6', size: 'suv', phrases: ['ev6', 'ev six'] },
  // German
  { make: 'BMW', model: '3 Series', size: 'sedan', phrases: ['3 series', 'three series', '330i', '340i', 'm3', 'm three'] },
  { make: 'BMW', model: '5 Series', size: 'sedan', phrases: ['5 series', 'five series', '530i', '540i', 'm5'] },
  { make: 'BMW', model: 'X3', size: 'suv', phrases: ['x3', 'x three', 'x1', 'x one'] },
  { make: 'BMW', model: 'X5', size: 'suv', phrases: ['x5', 'x five', 'x7', 'x seven', 'x6', 'x six'] },
  { make: 'BMW', model: 'M4', size: 'sedan', phrases: ['m4', 'm four', '4 series', 'four series', 'm2', 'm two'] },
  { make: 'Mercedes-Benz', model: 'C-Class', size: 'sedan', phrases: ['c-class', 'c class', 'c300', 'c three hundred', 'c43', 'c63'] },
  { make: 'Mercedes-Benz', model: 'E-Class', size: 'sedan', phrases: ['e-class', 'e class', 'e350', 'e450'] },
  { make: 'Mercedes-Benz', model: 'S-Class', size: 'sedan', phrases: ['s-class', 's class', 's500', 's550', 's580'] },
  { make: 'Mercedes-Benz', model: 'GLE', size: 'suv', phrases: ['gle', 'g l e', 'glc', 'g l c', 'gla'] },
  { make: 'Mercedes-Benz', model: 'G-Wagon', size: 'suv', phrases: ['g-wagon', 'g wagon', 'g class', 'g-class', 'g63', 'g550'] },
  { make: 'Mercedes-Benz', model: 'GLS', size: 'truck', phrases: ['gls', 'g l s'] },
  { make: 'Audi', model: 'A4', size: 'sedan', phrases: ['a4', 'a four', 'a5', 'a five', 's4', 's5'] },
  { make: 'Audi', model: 'A6', size: 'sedan', phrases: ['a6', 'a six', 'a7', 'a seven', 'a8', 'rs7'] },
  { make: 'Audi', model: 'Q5', size: 'suv', phrases: ['q5', 'q five', 'q3', 'q three', 'sq5'] },
  { make: 'Audi', model: 'Q7', size: 'suv', phrases: ['q7', 'q seven', 'q8', 'q eight'] },
  { make: 'Audi', model: 'e-tron', size: 'suv', phrases: ['e-tron', 'etron', 'e tron'] },
  { make: 'Porsche', model: '911', size: 'sedan', phrases: ['911', 'nine eleven', 'carrera', 'gt3', 'turbo s'] },
  { make: 'Porsche', model: 'Cayenne', size: 'suv', phrases: ['cayenne'] },
  { make: 'Porsche', model: 'Macan', size: 'suv', phrases: ['macan'] },
  { make: 'Porsche', model: 'Taycan', size: 'sedan', phrases: ['taycan', 'tie can'] },
  { make: 'Volkswagen', model: 'Jetta', size: 'sedan', phrases: ['jetta'] },
  { make: 'Volkswagen', model: 'Golf', size: 'sedan', phrases: ['golf', 'gti', 'golf r'] },
  { make: 'Volkswagen', model: 'Tiguan', size: 'suv', phrases: ['tiguan'] },
  { make: 'Volkswagen', model: 'Atlas', size: 'suv', phrases: ['atlas'] },
  // Lexus / others
  { make: 'Lexus', model: 'RX', size: 'suv', phrases: ['rx', 'rx350', 'rx 350', 'r x'] },
  { make: 'Lexus', model: 'ES', size: 'sedan', phrases: ['es350', 'es 350', 'lexus es', 'is350', 'is 350', 'lexus is'] },
  { make: 'Lexus', model: 'GX', size: 'suv', phrases: ['gx', 'gx460', 'gx 460', 'gx550', 'lx', 'lx600'] },
  { make: 'Lexus', model: 'NX', size: 'suv', phrases: ['nx', 'nx350', 'n x'] },
  { make: 'Rivian', model: 'R1T', size: 'truck', phrases: ['r1t', 'r one t', 'rivian truck'] },
  { make: 'Rivian', model: 'R1S', size: 'suv', phrases: ['r1s', 'r one s', 'rivian'] },
  { make: 'Land Rover', model: 'Range Rover', size: 'suv', phrases: ['range rover', 'defender', 'discovery', 'land rover'] },
  { make: 'Genesis', model: 'G70', size: 'sedan', phrases: ['g70', 'g seventy', 'g80', 'g eighty', 'genesis'] },
  { make: 'Genesis', model: 'GV70', size: 'suv', phrases: ['gv70', 'gv seventy', 'gv80', 'gv eighty'] },
  { make: 'Volvo', model: 'XC90', size: 'suv', phrases: ['xc90', 'xc ninety', 'xc60', 'xc sixty', 'xc40'] },
  { make: 'Chrysler', model: 'Pacifica', size: 'suv', phrases: ['pacifica', 'minivan', 'mini van'] },
];

// Body-style words → size class (used when no model is recognized).
const BODY_STYLES = [
  { size: 'truck', phrases: ['truck', 'pickup', 'pick up', 'crew cab', 'dually', 'full size suv', 'full-size suv', 'big suv', 'three row', 'three-row', 'van', 'work van', 'sprinter'] },
  { size: 'suv', phrases: ['suv', 's u v', 'crossover', 'cross over', 'small suv', 'mid size suv', 'midsize suv', 'wagon', 'hatchback', 'hatch', 'jeep'] },
  { size: 'sedan', phrases: ['sedan', 'coupe', 'coop', 'sports car', 'convertible', 'four door', 'two door', 'compact', 'small car', 'car'] },
];

// How the TTS voice should say things the model writes. Applied by speak.js on
// whole words only (case-sensitive so "uv" inside a word is untouched).
const SPOKEN = {
  'PPF': 'P P F', 'VLT': 'V L T', 'UV': 'U V', 'IR': 'I R', 'ppf': 'P P F', 'vlt': 'V L T',
  'F-150': 'F one fifty', 'F150': 'F one fifty', 'F-250': 'F two fifty', 'F250': 'F two fifty', 'F-350': 'F three fifty', 'F350': 'F three fifty',
  '4Runner': 'four runner', '4runner': 'four runner', 'RAV4': 'rav four', 'CX-5': 'C X five', 'CX5': 'C X five', 'CR-V': 'C R V', 'CRV': 'C R V',
  'Q50': 'Q fifty', 'QX60': 'Q X sixty', 'X5': 'X five', 'X3': 'X three', 'Q5': 'Q five', 'Q7': 'Q seven', 'A4': 'A four', 'A6': 'A six',
  'GT3': 'G T three', 'M3': 'M three', 'M4': 'M four', 'M5': 'M five', 'C300': 'C three hundred', 'E350': 'E three fifty', 'GLE': 'G L E', 'GLC': 'G L C', 'GLS': 'G L S',
  'RX350': 'R X three fifty', 'ES350': 'E S three fifty', 'IS350': 'I S three fifty', 'GX460': 'G X four sixty', 'NX': 'N X', 'RX': 'R X',
  'R1T': 'R one T', 'R1S': 'R one S', 'EV6': 'E V six', 'XC90': 'X C ninety', 'XC60': 'X C sixty', 'GV70': 'G V seventy', 'G70': 'G seventy', 'G80': 'G eighty',
  'WRX': 'W R X', 'STI': 'S T I', 'GTI': 'G T I', 'TLX': 'T L X', 'MDX': 'M D X', 'RDX': 'R D X', '370Z': 'three seventy Z', 'GR86': 'G R eighty six',
  'e.g.': 'for example', 'i.e.': 'that is', 'etc.': 'and so on', 'w/': 'with', '&': 'and', 'hrs': 'hours', 'min': 'minutes', 'mins': 'minutes',
};

// Clean spoken phrases for the speech recognizer (both engines). Every entry is
// something a caller would actually SAY — no punctuation, no menu formatting.
const HINTS = [
  'window tint', 'ceramic tint', 'carbon tint', 'dyed tint', 'ceramic window tint', 'tint', 'tinting', 'tint removal',
  'ceramic coating', 'ceramic', 'coating', 'paint coating', 'paint correction', 'correction', 'polish', 'compound', 'swirl marks', 'swirls',
  'paint protection film', 'PPF', 'clear bra', 'full front', 'partial front', 'full body', 'rock chips', 'self healing',
  'full detail', 'interior detail', 'exterior detail', 'maintenance detail', 'deep clean', 'detail', 'shampoo', 'extraction', 'pet hair', 'odor removal', 'leather', 'headliner', 'engine bay',
  'windshield', 'windshield strip', 'visor strip', 'front two windows', 'two front windows', 'front windows', 'rear windows', 'back glass', 'rear windshield', 'sunroof', 'panoramic roof', 'full vehicle', 'whole car',
  'heat rejection', 'UV protection', 'VLT', 'five percent', 'fifteen percent', 'twenty percent', 'thirty five percent', 'fifty percent', 'legal tint', 'limo tint',
  'sedan', 'coupe', 'SUV', 'crossover', 'truck', 'pickup', 'van', 'hatchback',
  'Tesla', 'Model 3', 'Model Y', 'Toyota', '4Runner', 'Tacoma', 'Tundra', 'Camry', 'RAV4', 'Honda', 'Civic', 'Accord', 'CR-V', 'Ford', 'F-150', 'Mustang', 'Bronco', 'Explorer',
  'Chevy', 'Silverado', 'Tahoe', 'Suburban', 'Corvette', 'Camaro', 'GMC', 'Sierra', 'Yukon', 'Ram', 'Jeep', 'Wrangler', 'Grand Cherokee', 'Dodge', 'Charger', 'Challenger', 'Durango',
  'Nissan', 'Altima', 'Subaru', 'Outback', 'WRX', 'Mazda', 'Hyundai', 'Kia', 'Telluride', 'BMW', 'Mercedes', 'Audi', 'Porsche', 'Lexus', 'Rivian', 'Cybertruck', 'Range Rover',
];

module.exports = { TERMS, PROTECTED, AMBIGUOUS, VLT, VEHICLES, BODY_STYLES, SPOKEN, HINTS };

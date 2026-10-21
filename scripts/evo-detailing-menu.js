#!/usr/bin/env node
// ── Evo Solutions detailing menu → ShopFlow ──────────────────────────────────
// Writes the Silver / Gold / Platinum packages, the vehicle-size labels and the
// detailing add-ons into a shop's ShopFlow settings through the same API the
// Settings screen uses, so the evosolution.org /detail page (which reads them
// live) lights up without anyone typing 60 fields into the CRM.
//
// Run from your own terminal with the owner's login — the password goes
// straight to the API, nowhere else:
//
//   SHOPFLOW_EMAIL=you@example.com SHOPFLOW_PASSWORD='…' node scripts/evo-detailing-menu.js
//
// Options (env):
//   SHOPFLOW_URL   API origin (default https://shopflowio.up.railway.app;
//                  http://localhost:3111 to rehearse against a local server)
//   DRY_RUN=1      print what would change, write nothing
//
// Idempotent: services and add-ons are matched by name, so re-running updates
// in place. The two pre-package detail services ("Interior Detail", "Full
// Detail") and the old $50 "Pet Hair Removal" add-on are retired — they'd
// otherwise show on the page as extra packages. Tint add-ons are left alone.
// Prices, minutes and included-items text as agreed with the owner 2026-10-20.

const BASE = (process.env.SHOPFLOW_URL || 'https://shopflowio.up.railway.app').replace(/\/$/, '');
const DRY = !!process.env.DRY_RUN;

const SIZES = [
  { key: 'sedan', label: 'Sedan' },
  { key: 'suv',   label: 'Mid-size SUV' },
  { key: 'truck', label: 'Large SUV / Truck' },
];

// Minutes are the midpoints of the owner's ranges (sedan / SUV / truck):
// Silver 2–3 / 3–4 / 4–5 h, Gold 3–5 / 5–6 / 5–6 h, Platinum 5–7 / 6–7 / 7–9 h.
const PACKAGES = [
  {
    name: 'Silver Detail', category: 'detail',
    sizePricing:  { sedan: 229, suv: 269, truck: 329 },
    sizeDuration: { sedan: 150, suv: 210, truck: 270 },
    description: 'Exterior hand wash · Wheel wells · 1-week paint sealant · Interior wipe-down · Vents & seat rails · Full vacuum',
  },
  {
    name: 'Gold Detail', category: 'detail',
    sizePricing:  { sedan: 295, suv: 339, truck: 395 },
    sizeDuration: { sedan: 240, suv: 330, truck: 330 },
    description: 'Everything in Silver · Clay bar & iron removal · Wheel barrels, faces & wells deep-cleaned · Windows in & out · 1-month paint sealant · Interior steam clean · Carpets vacuumed & disinfected',
  },
  {
    name: 'Platinum Detail', category: 'detail',
    sizePricing:  { sedan: 649, suv: 705, truck: 779 },
    sizeDuration: { sedan: 360, suv: 390, truck: 480 },
    description: 'Everything in Gold · 1–3 year ceramic coating on the paint · Clay bar & iron decontamination before coating · Interior steam clean & disinfect',
  },
];
const RETIRE_SERVICES = ['Interior Detail', 'Full Detail'];

// [name, price, group] — the group is the heading the Settings screen, the
// booking page and the website list it under.
const ADDONS = [
  ['Pet hair removal', 60, 'Interior'],
  ['Odor / smoke treatment (ozone)', 85, 'Interior'],
  ['Leather clean & condition', 60, 'Interior'],
  ['Fabric & carpet protectant', 60, 'Interior'],
  ['Child seat cleaning (each)', 35, 'Interior'],
  ['Heavy soil / biohazard surcharge', 110, 'Interior'],
  ['Engine bay detail', 75, 'Exterior'],
  ['Headlight restoration (pair)', 80, 'Exterior'],
  // Not "windshield" — the site would file that under tint.
  ['Glass coating (rain-repellent)', 50, 'Exterior'],
  ['One-step polish (swirl removal)', 210, 'Exterior'],
  ['Tar & overspray removal', 50, 'Exterior'],
];
// The live tenant's old "Pet Hair Removal" ($50) is the same name as the new
// $60 entry (names match case-insensitively), so it's updated in place rather
// than duplicated — no separate retire list needed for add-ons.

const norm = (s) => String(s || '').trim().toLowerCase();

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`${method} ${path} → ${res.status} ${data.error || ''}`.trim());
  return data;
}

(async () => {
  const email = process.env.SHOPFLOW_EMAIL, password = process.env.SHOPFLOW_PASSWORD;
  if (!email || !password) {
    console.error('Set SHOPFLOW_EMAIL and SHOPFLOW_PASSWORD (the owner login for the shop).');
    process.exit(1);
  }
  const login = await api('/api/accounts/login', { method: 'POST', body: { email, password } });
  const token = login.token;
  console.log(`Signed in to ${login.shopName} (${login.shopSlug}) at ${BASE}${DRY ? '  [DRY RUN]' : ''}`);
  if (login.role !== 'full') throw new Error(`This login is "${login.role}" — a Full Access owner login is needed to edit services.`);

  // ── Services ────────────────────────────────────────────────────────────────
  const existing = await api('/api/shop/services', { token });
  for (const p of PACKAGES) {
    const hit = existing.find((s) => norm(s.name) === norm(p.name));
    const svc = {
      ...(hit || {}),
      id: hit ? hit.id : undefined,
      name: p.name, category: p.category,
      price: p.sizePricing.sedan,                   // base = first size tier, as Settings does
      cost: hit && hit.cost != null ? hit.cost : 0,
      duration: p.sizeDuration.suv,                 // flat fallback = the SUV middle
      sizePricing: p.sizePricing, sizeDuration: p.sizeDuration,
      description: p.description,
    };
    console.log(`${hit ? 'update' : 'create'}  ${p.name}  $${p.sizePricing.sedan}/${p.sizePricing.suv}/${p.sizePricing.truck}  ${p.sizeDuration.sedan}/${p.sizeDuration.suv}/${p.sizeDuration.truck} min`);
    if (!DRY) await api('/api/shop/services', { method: 'POST', token, body: svc });
  }
  for (const s of existing) {
    if (RETIRE_SERVICES.some((n) => norm(n) === norm(s.name))) {
      console.log(`retire  ${s.name} (${s.id}) — replaced by the packages`);
      if (!DRY) await api('/api/shop/services/' + encodeURIComponent(s.id), { method: 'DELETE', token });
    }
  }

  // ── Sizes + add-ons (settings) ──────────────────────────────────────────────
  const settings = await api('/api/shop/settings', { token });
  const keep = (settings.addons || []).filter((a) => !ADDONS.some(([n]) => norm(n) === norm(a.name)));
  const byName = new Map((settings.addons || []).map((a) => [norm(a.name), a]));
  const addons = [
    ...keep,
    ...ADDONS.map(([name, price, group]) => {
      const prev = byName.get(norm(name));
      return { id: prev ? prev.id : 'ad' + Math.random().toString(36).slice(2, 8), name, price, group, cost: prev && prev.cost != null ? prev.cost : 0 };
    }),
  ];
  const sizes = SIZES.map((sz) => {
    const prev = (settings.vehicleSizes || []).find((v) => v.key === sz.key);
    return { ...(prev || {}), ...sz };
  });
  console.log(`sizes   ${sizes.map((s) => s.label).join(' · ')}`);
  const updated = ADDONS.filter(([n]) => byName.has(norm(n))).map(([n]) => n);
  console.log(`add-ons ${ADDONS.length} detailing (${updated.length} updated in place, +${keep.length} kept: ${keep.map((a) => a.name).join(', ') || 'none'})`);
  if (!DRY) await api('/api/shop/settings', { method: 'POST', token, body: { vehicleSizes: sizes, addons } });

  // ── Show what the public page will now read ─────────────────────────────────
  const info = await api(`/api/public/${login.shopSlug}/info`);
  console.log('\nPublic /info now serves:');
  for (const s of info.services.filter((x) => x.category === 'detail')) {
    const sp = s.sizePricing || {}, sd = s.sizeDuration || {};
    console.log(`  ${s.name.padEnd(16)} $${sp.sedan}/${sp.suv}/${sp.truck}   ${sd.sedan || s.duration}/${sd.suv || s.duration}/${sd.truck || s.duration} min`);
  }
  console.log(`  add-ons: ${info.addons.map((a) => `${a.name} $${a.price}${a.group ? ' [' + a.group + ']' : ''}`).join(' · ')}`);
  console.log(`  sizes:   ${info.vehicleSizes.map((v) => v.label).join(' · ')}`);
  console.log(DRY ? '\nDry run — nothing written.' : '\nDone. evosolution.org/detail reads these live.');
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });

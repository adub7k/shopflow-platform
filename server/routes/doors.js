// ── Door-to-door (D2D) canvassing ────────────────────────────────────────────
// A field-service crew knocks doors and logs each one from their phone. One
// record per address (doors[]), with every knock kept in door.visits[] so a
// house knocked twice is one door with two visits, not two doors. Each visit
// is credited to the logged-in account (never a name from the request body).
//
// Outcomes:
//   not_home · not_interested · come_back (+ followUpAt) · quoted · sold ·
//   no_soliciting
// A quoted or sold door becomes a CRM lead (source 'door') carrying the
// address as its service address, so it flows into follow-ups, estimates and
// jobs like a website lead. Sold moves the lead to Booked, which also ends its
// 30-day follow-up texts.
//
//   GET    /api/shop/doors?since=ISO&until=ISO&today=YYYY-MM-DD
//            → { doors (visited in the window), followUps (come-backs due by
//                today), stats { all, byRep[] }, goal }
//   POST   /api/shop/doors        log a knock (upserts the door by address)
//   DELETE /api/shop/doors/:id    undo a mistaken door — owners any door, crew
//                                 only doors where every visit is theirs
//   GET    /api/shop/doors/where?lat&lng → nearest street address (city /
//            county address points in Bernalillo County, else OpenStreetMap)
const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware');
const { master, shopRoute, genId } = require('../db');
const { upsertLead } = require('../leads-core');
const { applyLeadStatus, actorOf } = require('./shop');

const rw = requireRole('full', 'technician');

const OUTCOMES = ['not_home', 'not_interested', 'come_back', 'quoted', 'sold', 'no_soliciting'];
// A visit where someone actually answered and talked.
const TALKED = ['not_interested', 'come_back', 'quoted', 'sold'];
const DEFAULT_GOAL = 40; // doors per person per day

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
// "123 Oak St., Albuquerque" and "123 oak st albuquerque" are the same door.
const addressKey = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function statsFor(visits) {
  const s = { doors: 0, talked: 0, quotes: 0, sales: 0, quoteValue: 0, soldValue: 0 };
  for (const v of visits) {
    s.doors++;
    if (TALKED.includes(v.outcome)) s.talked++;
    if (v.outcome === 'quoted') { s.quotes++; s.quoteValue += Number(v.amount) || 0; }
    if (v.outcome === 'sold') { s.sales++; s.soldValue += Number(v.amount) || 0; }
  }
  return s;
}

// ── List + stats ──────────────────────────────────────────────────────────────
router.get('/api/shop/doors', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  const since = Date.parse(req.query.since) || (Date.now() - 24 * 3600 * 1000);
  const until = Date.parse(req.query.until) || Date.now() + 60 * 1000;
  const today = isDate(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
  const all = h.getAll('doors');

  const inWindow = (v) => { const t = Date.parse(v.at); return t >= since && t < until; };
  const visits = [];
  const doors = [];
  for (const d of all) {
    const vs = (d.visits || []).filter(inWindow);
    if (vs.length) doors.push(d);
    vs.forEach(v => visits.push(v));
  }
  doors.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const reps = new Map();
  for (const v of visits) {
    const k = v.repId || 'unknown';
    if (!reps.has(k)) reps.set(k, { repId: v.repId || null, repName: v.repName || 'Unknown', visits: [] });
    reps.get(k).visits.push(v);
  }
  const byRep = [...reps.values()]
    .map(r => ({ repId: r.repId, repName: r.repName, ...statsFor(r.visits) }))
    .sort((a, b) => b.doors - a.doors);

  const followUps = all
    .filter(d => d.outcome === 'come_back' && d.followUpAt && d.followUpAt <= today)
    .sort((a, b) => String(a.followUpAt).localeCompare(String(b.followUpAt)));

  const s = db.get('settings').value() || {};
  res.json({
    doors, followUps,
    stats: { all: statsFor(visits), byRep },
    goal: Number(s.doorGoal) > 0 ? Number(s.doorGoal) : DEFAULT_GOAL,
    me: req.accountId || null,
  });
}));

// ── Log a knock ───────────────────────────────────────────────────────────────
router.post('/api/shop/doors', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  const b = req.body || {};
  const outcome = str(b.outcome, 20);
  if (!OUTCOMES.includes(outcome)) return res.status(400).json({ ok: false, error: 'Pick what happened at the door' });
  const address = str(b.address, 160);
  if (address.length < 3) return res.status(400).json({ ok: false, error: 'Address is required' });
  const name = str(b.name, 80), phone = str(b.phone, 25), email = str(b.email, 120);
  const notes = str(b.notes, 600), service = str(b.service, 80);
  const propertyType = str(b.propertyType, 40), stories = str(b.stories, 20);
  const amount = Number(b.quoteAmount) > 0 ? Math.round(Number(b.quoteAmount) * 100) / 100 : null;
  const followUpAt = outcome === 'come_back' && isDate(b.followUpAt) ? b.followUpAt : null;
  if (outcome === 'come_back' && !followUpAt) return res.status(400).json({ ok: false, error: 'When should we come back?' });
  const leadOutcome = outcome === 'quoted' || outcome === 'sold';
  if (leadOutcome && String(phone).replace(/\D/g, '').length < 10)
    return res.status(400).json({ ok: false, error: 'Add their phone number so the quote can be followed up' });
  const lat = Number.isFinite(Number(b.lat)) && b.lat !== '' && b.lat != null ? Number(b.lat) : null;
  const lng = Number.isFinite(Number(b.lng)) && b.lng !== '' && b.lng != null ? Number(b.lng) : null;

  const actor = actorOf(req);
  const now = new Date().toISOString();
  const key = addressKey(address);
  let door = (b.id && h.getById('doors', b.id)) || h.getAll('doors').find(d => d.addressKey === key) || null;
  if (!door) door = { id: genId('door'), address, addressKey: key, visits: [], createdAt: now };

  // Latest knock wins for the door's state; blank fields never erase what an
  // earlier visit learned (the name from Tuesday survives Saturday's "not home").
  door.address = address; door.addressKey = key;
  if (lat != null && lng != null) { door.lat = lat; door.lng = lng; }
  door.outcome = outcome;
  door.followUpAt = followUpAt;
  for (const [k, v] of Object.entries({ name, phone, email, service, propertyType, stories })) if (v) door[k] = v;
  if (amount != null) door.quoteAmount = amount;
  if (notes) door.notes = notes;
  door.repId = actor.byId; door.repName = actor.by;
  door.updatedAt = now;
  door.visits = (door.visits || []).concat({
    id: genId('v'), at: now, outcome, repId: actor.byId, repName: actor.by,
    ...(amount != null && leadOutcome ? { amount } : {}),
    ...(notes ? { notes } : {}),
  });

  // Quoted / sold → a real CRM lead (deduped by phone like every other source).
  if (leadOutcome) {
    const shop = master.get('shops').find({ id: req.shopId }).value() || { id: req.shopId };
    const noteLines = [
      `Door-to-door: ${outcome === 'sold' ? 'SOLD' : 'quoted'} at the door by ${actor.by || 'the crew'}`,
      service && `Service: ${service}`,
      amount != null && `${outcome === 'sold' ? 'Sold' : 'Quoted'} at $${amount}`,
      notes && `Note: ${notes}`,
    ].filter(Boolean).join('\n');
    const details = { serviceAddress: address };
    if (propertyType) details.propertyType = propertyType;
    if (stories) details.stories = stories;
    const { lead } = upsertLead(db, shop, {
      name: name || door.name || '', phone, email, notes: noteLines, details,
      servicesInterested: service ? [service] : [], source: 'door',
    });
    // Forward only: a lead already further along (booked, worked…) stays put.
    const order = ['new', 'contacted', 'quoted', 'booked', 'worked', 'closed'];
    const want = outcome === 'sold' ? 'booked' : 'quoted';
    const cur = order.indexOf(lead.status);
    if (lead.status !== 'lost' && (cur === -1 || cur < order.indexOf(want))) applyLeadStatus(lead, want, 'door', actor);
    if (amount != null) lead.quotedAmount = amount;
    h.upsert('leads', lead);
    door.leadId = lead.id;
  }

  h.upsert('doors', door);
  res.json({ ok: true, door, leadId: door.leadId || null });
}));

router.delete('/api/shop/doors/:id', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  const door = h.getById('doors', req.params.id);
  if (!door) return res.status(404).json({ ok: false, error: 'Door not found' });
  // A crew member can clean up their own mistakes (their own house logged by
  // accident) but not erase a door someone else knocked.
  const own = (door.visits || []).length && door.visits.every(v => v.repId && v.repId === req.accountId);
  if (req.role !== 'full' && !own) return res.status(403).json({ ok: false, error: 'Only the owner can delete a door someone else logged' });
  h.remove('doors', door.id);
  res.json({ ok: true });
}));

// ── "Where am I?" — GPS → street address ─────────────────────────────────────
// Sources, best first:
//   1. City of Albuquerque address points (AGIS locator) — the city-assigned
//      addresses, same data as 911. Inside city limits.
//   2. Bernalillo County address points — unincorporated parts of the county.
//   3. OpenStreetMap Nominatim — everywhere else. Its house numbers in parts
//      of Albuquerque are shifted by 25+ houses against the city's points, so
//      it's the fallback, and a house it found more than 30 m away is not
//      presented as exact.
// Results are cached by ~1 m grid cell (an ~11 m cell was coarser than a lot
// — next-door houses shared a cell and got each other's address).
const CITY_LOCATOR = 'https://coageo.cabq.gov/cabqgeo/rest/services/locators/AGIS_AddressPointsLocator/GeocodeServer/reverseGeocode';
const COUNTY_POINTS = 'https://pdsgismaps.bernco.gov/server/rest/services/BERNCOBASEMAP/County_Address_Points/MapServer/299/query';
const UA = { 'User-Agent': 'ShopFlow/1.0 (support@shopflowtech.com)', 'Accept-Language': 'en' };
// Bernalillo County, generously boxed.
const inBernalillo = (lat, lng) => lat > 34.86 && lat < 35.22 && lng > -107.21 && lng < -106.14;

const metersBetween = (a, b, c, d) => {
  const r = (x) => x * Math.PI / 180, dLat = r(c - a), dLng = r(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
// "9917 SALEM RD NE" → "9917 Salem Rd NE"; quadrants stay upper, "4TH" → "4th".
const QUADS = new Set(['NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W']);
const titleAddress = (s) => String(s || '').trim().split(/\s+/).map(w => {
  const u = w.toUpperCase();
  if (QUADS.has(u)) return u;
  if (/^\d+(ST|ND|RD|TH)$/.test(u)) return u.toLowerCase();
  return /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}).join(' ');

async function cityAddress(lat, lng) {
  const url = CITY_LOCATOR + '?f=json&outSR=4326&distance=50&location='
    + encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const j = await r.json();
  const a = j && j.address;
  if (!a || !a.Address || !/^(PointAddress|Subaddress)$/.test(a.Addr_type || '')) return null;
  const street = titleAddress(a.Address);
  return { address: street + ', Albuquerque', street, city: 'Albuquerque', zip: a.Postal || '', exact: true, source: 'city' };
}

async function countyAddress(lat, lng) {
  const qs = new URLSearchParams({
    f: 'json', geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    // County points sit at parcel centroids — on big unincorporated lots that
    // can be 75 m+ from the front door, so search wider and take the nearest.
    geometryType: 'esriGeometryPoint', inSR: '4326', outSR: '4326', distance: '100', units: 'esriSRUnit_Meter',
    spatialRel: 'esriSpatialRelIntersects', outFields: 'ADDRESS', returnGeometry: 'true',
  });
  const r = await fetch(COUNTY_POINTS + '?' + qs, { headers: UA, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const j = await r.json();
  const best = ((j && j.features) || [])
    .filter(f => f.attributes && f.attributes.ADDRESS && f.geometry)
    .map(f => ({ f, d: metersBetween(lat, lng, f.geometry.y, f.geometry.x) }))
    .sort((a, b) => a.d - b.d)[0];
  if (!best) return null;
  const street = titleAddress(best.f.attributes.ADDRESS);
  return { address: street, street, city: '', zip: '', exact: true, source: 'county' };
}

let revLast = 0;
async function osmAddress(lat, lng) {
  // Nominatim allows 1 request/second — space ours out.
  const wait = revLast + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  revLast = Date.now();
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18'
    + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = await r.json();
  const a = (j && j.address) || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.hamlet || a.suburb || '';
  // The house it matched, if far from where they're standing, is a guess.
  const near = Number.isFinite(+j.lat) && metersBetween(lat, lng, +j.lat, +j.lon) <= 30;
  return {
    address: [street || (j && j.name) || '', city, a.postcode].filter(Boolean).join(', '),
    street, city, zip: a.postcode || '', exact: !!a.house_number && near, source: 'osm',
  };
}

const revCache = new Map();
router.get('/api/shop/doors/where', requireAuth, rw, async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return res.status(400).json({ ok: false, error: 'Location unavailable' });
  const key = lat.toFixed(5) + ',' + lng.toFixed(5);
  if (revCache.has(key)) return res.json({ ok: true, ...revCache.get(key) });
  // Each source is best-effort: a slow or down service falls through to the next.
  const tryIt = async (fn) => { try { return await fn(lat, lng); } catch (e) { return null; } };
  let out = null;
  if (inBernalillo(lat, lng)) out = (await tryIt(cityAddress)) || (await tryIt(countyAddress));
  if (!out) out = await tryIt(osmAddress);
  if (!out || !out.address) return res.status(502).json({ ok: false, error: 'Address lookup unavailable — type it in' });
  if (revCache.size > 2000) revCache.clear();
  revCache.set(key, out);
  res.json({ ok: true, ...out });
});

module.exports = router;

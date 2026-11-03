// Door-to-door canvassing (routes/doors.js).
//  - One door per address: a second knock at "123 Oak St." / "123 oak st"
//    adds a visit instead of a new door, and keeps what earlier visits learned.
//  - Visits are credited to the signed-in account, never a body-supplied name.
//  - come_back needs a date and shows up in followUps once it's due.
//  - quoted / sold need a phone and become a CRM lead (source door) with the
//    address as its service address; sold moves the lead to booked and ends
//    its follow-up texts.
//  - Stats per rep; technicians can log, view-only can't; owners delete any
//    door, technicians only doors where every visit is theirs.
//  - /where: City of Albuquerque points first, then Bernalillo County points,
//    then OpenStreetMap (a far-away OSM house is not 'exact'); outside the
//    county the city/county services aren't called. External calls stubbed.
// Run: node test/doors.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-doors-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, initShopDb, JWT_SECRET } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shoptest_d2d';
master.get('shops').push({ id: shopId, shopName: 'D2D Test', slug: 'd2d-test', industry: 'pressure', active: true }).write();
initShopDb(getShopDb(shopId), { shopName: 'D2D Test', email: 'o@d2d.test', industry: 'pressure' });
master.get('accounts').push({ id: 'acct_owner', shopId, email: 'o@d2d.test', name: 'Aidan', role: 'full', active: true }).write();
master.get('accounts').push({ id: 'acct_tech', shopId, email: 't@d2d.test', name: 'Marco', role: 'technician', active: true }).write();
master.get('accounts').push({ id: 'acct_view', shopId, email: 'v@d2d.test', name: 'Desk', role: 'viewonly', active: true }).write();
const tok = (id, role) => jwt.sign({ shopId, accountId: id, role }, JWT_SECRET);
const OWNER = tok('acct_owner', 'full'), TECH = tok('acct_tech', 'technician'), VIEW = tok('acct_view', 'viewonly');

const app = express();
app.use(express.json());
app.use(require('../server/routes/doors'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, p, t, body) => fetch(base + p, {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json() }));
  const fresh = () => getShopDb(shopId);
  const doors = () => fresh().get('doors').value() || [];
  const today = new Date().toISOString().slice(0, 10);
  const listQ = `?since=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}&until=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}&today=${today}`;

  try {
    // ── One door per address ────────────────────────────────────────────────
    let r = await req('POST', '/api/shop/doors', TECH, { address: '123 Oak St.', outcome: 'not_home', lat: 35.1, lng: -106.6, repName: 'Spoofed' });
    eq('not home logged', r.status, 200);
    eq('credited to the signed-in rep, not the body', [r.body.door.repName, r.body.door.visits[0].repName], ['Marco', 'Marco']);
    r = await req('POST', '/api/shop/doors', TECH, { address: '123 oak st', outcome: 'come_back', name: 'Pat', followUpAt: today });
    eq('second knock → same door, two visits', [doors().length, doors()[0].visits.length, doors()[0].outcome], [1, 2, 'come_back']);
    await req('POST', '/api/shop/doors', TECH, { address: '123 Oak St', outcome: 'not_home' });
    eq('a later "not home" keeps the name and coords', [doors()[0].name, doors()[0].lat], ['Pat', 35.1]);
    eq('…and clears the come-back date', doors()[0].followUpAt, null);

    // ── Validation ──────────────────────────────────────────────────────────
    eq('bad outcome → 400', (await req('POST', '/api/shop/doors', TECH, { address: '1 A St', outcome: 'maybe' })).status, 400);
    eq('no address → 400', (await req('POST', '/api/shop/doors', TECH, { address: '', outcome: 'not_home' })).status, 400);
    eq('come back without a date → 400', (await req('POST', '/api/shop/doors', TECH, { address: '9 Elm St', outcome: 'come_back' })).status, 400);
    eq('quoted without a phone → 400', (await req('POST', '/api/shop/doors', TECH, { address: '9 Elm St', outcome: 'quoted' })).status, 400);

    // ── Come-backs ──────────────────────────────────────────────────────────
    const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
    await req('POST', '/api/shop/doors', TECH, { address: '5 Pine St', outcome: 'come_back', followUpAt: tomorrow });
    await req('POST', '/api/shop/doors', OWNER, { address: '6 Pine St', outcome: 'come_back', followUpAt: today, notes: 'After 5' });
    let list = (await req('GET', '/api/shop/doors' + listQ, TECH)).body;
    eq('follow-ups: due today in, tomorrow not yet', list.followUps.map(x => x.address), ['6 Pine St']);

    // ── Quoted → lead ───────────────────────────────────────────────────────
    r = await req('POST', '/api/shop/doors', TECH, { address: '77 Birch Rd, 87110', outcome: 'quoted', name: 'Sam Lee', phone: '(505) 555-0177', service: 'House Washing', quoteAmount: 325, propertyType: 'House', stories: '2 stories' });
    const leadId = r.body.leadId;
    let lead = (fresh().get('leads').value() || []).find(l => l.id === leadId);
    eq('quoted → lead created', !!lead, true);
    eq('lead: door source, quoted stage, amount', [lead.source, lead.status, lead.quotedAmount], ['door', 'quoted', 325]);
    eq('lead: address + property on customFields', lead.customFields, { serviceAddress: '77 Birch Rd, 87110', propertyType: 'House', stories: '2 stories' });
    eq('lead: service tagged', lead.servicesInterested, ['House Washing']);
    eq('lead: stage move credited to the rep', lead.stageLog.slice(-1)[0].by, 'Marco');

    // ── Sold → booked ───────────────────────────────────────────────────────
    r = await req('POST', '/api/shop/doors', OWNER, { address: '77 Birch Rd, 87110', outcome: 'sold', phone: '(505) 555-0177', quoteAmount: 300 });
    lead = (fresh().get('leads').value() || []).find(l => l.id === leadId);
    eq('sold → same lead, booked, follow-up texts ended', [r.body.leadId, lead.status, lead.followUp.status, lead.quotedAmount], [leadId, 'booked', 'completed', 300]);
    eq('only one lead for that phone', (fresh().get('leads').value() || []).filter(l => l.phone === '(505) 555-0177').length, 1);

    // ── Stats ───────────────────────────────────────────────────────────────
    list = (await req('GET', '/api/shop/doors' + listQ, OWNER)).body;
    eq('team totals', [list.stats.all.doors, list.stats.all.talked, list.stats.all.quotes, list.stats.all.sales, list.stats.all.soldValue], [7, 5, 1, 1, 300]);
    const by = Object.fromEntries(list.stats.byRep.map(x => [x.repName, [x.doors, x.talked, x.quotes, x.sales]]));
    eq('per rep', by, { Marco: [5, 3, 1, 0], Aidan: [2, 2, 0, 1] });
    eq('default goal', list.goal, 40);
    eq('me = the caller', list.me, 'acct_owner');

    // ── Permissions ─────────────────────────────────────────────────────────
    eq('view-only cannot log', (await req('POST', '/api/shop/doors', VIEW, { address: '1 A St', outcome: 'not_home' })).status, 403);
    const anyId = doors()[0].id;
    const mixed = doors().find(d => d.visits.some(v => v.repId === 'acct_owner') && d.visits.some(v => v.repId === 'acct_tech'));
    const techOnly = doors().find(d => d.visits.every(v => v.repId === 'acct_tech'));
    if (mixed) eq('technician cannot delete a door someone else also knocked', (await req('DELETE', '/api/shop/doors/' + mixed.id, TECH)).status, 403);
    eq('technician can delete a door only they knocked', (await req('DELETE', '/api/shop/doors/' + techOnly.id, TECH)).status, 200);
    eq('…gone', doors().some(d => d.id === techOnly.id), false);
    eq('missing door → 404', (await req('DELETE', '/api/shop/doors/door_nope', OWNER)).status, 404);
    eq('view-only cannot delete', (await req('DELETE', '/api/shop/doors/' + anyId, VIEW)).status, 403);
    const ownerTarget = (mixed || doors()[0]).id;
    eq('owner can delete any door', (await req('DELETE', '/api/shop/doors/' + ownerTarget, OWNER)).status, 200);
    eq('…and it is gone', doors().some(d => d.id === ownerTarget), false);

    // ── Address lookup chain (external services stubbed) ────────────────────
    const realFetch = global.fetch, calls = [];
    let city, county, osm;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
      const json = (o, ok = true) => ({ ok, json: async () => o });
      if (u.includes('coageo.cabq.gov')) { calls.push('city'); return city(); }
      if (u.includes('bernco.gov')) { calls.push('county'); return county(); }
      if (u.includes('nominatim')) { calls.push('osm'); return osm(); }
      return json({}, false);
    };
    const J = (o, ok = true) => ({ ok, json: async () => o });
    const where = (lat, lng) => req('GET', `/api/shop/doors/where?lat=${lat}&lng=${lng}`, TECH).then(r => r.body);

    city = () => J({ address: { Address: '9917 SALEM RD NE', Addr_type: 'PointAddress' } });
    let w = await where(35.11070, -106.52960);
    eq('city points win inside Albuquerque', [w.address, w.source, w.exact, calls], ['9917 Salem Rd NE, Albuquerque', 'city', true, ['city']]);

    calls.length = 0;
    city = () => J({ error: { code: 400, message: 'Unable to find address' } });
    county = () => J({ features: [
      { attributes: { ADDRESS: '200 FAR AWAY RD SW' }, geometry: { x: -106.70000, y: 35.00030 } },
      { attributes: { ADDRESS: '1204 4TH ST SW' }, geometry: { x: -106.70001, y: 35.00001 } },
    ] });
    w = await where(35.00000, -106.70000);
    eq('no city point → nearest county point', [w.address, w.source, calls], ['1204 4th St SW', 'county', ['city', 'county']]);

    calls.length = 0;
    city = () => { throw new Error('down'); };
    county = () => J({}, false);
    osm = () => J({ lat: '35.0010', lon: '-106.7001', address: { house_number: '9773', road: 'Salem Road Northeast', city: 'Albuquerque', postcode: '87112' } });
    w = await where(35.00010, -106.70010);
    eq('both down → OSM, far house not exact', [w.source, w.exact, w.address, calls], ['osm', false, '9773 Salem Road Northeast, Albuquerque, 87112', ['city', 'county', 'osm']]);

    calls.length = 0;
    osm = () => J({ lat: '35.68700', lon: '-105.93800', address: { house_number: '12', road: 'Canyon Road', city: 'Santa Fe' } });
    w = await where(35.68700, -105.93800);
    eq('outside Bernalillo → OSM only, near house exact', [w.source, w.exact, calls], ['osm', true, ['osm']]);

    calls.length = 0;
    await where(35.68700, -105.93800);
    eq('same spot again is cached', calls, []);
    global.fetch = realFetch;
  } catch (e) {
    failures++;
    console.log('FAIL  threw', e);
  } finally {
    server.close();
    console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
});

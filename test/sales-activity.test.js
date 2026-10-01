// Sales activity: (1) the lead activity log + stage moves are stamped with WHO
// did them from the auth token (never the body), (2) the pure rollup counts
// calls / texts / worked / booked / rate / open per person over a local-date
// window, (3) GET /api/admin/shop/:id/sales-activity (admin key) and returns it.
// Run: node test/sales-activity.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-salesact-' + process.pid);

const express = require('express');
const jwt = require('jsonwebtoken');
const { master, getShopDb, JWT_SECRET } = require('../server/db');
const SA = require('../server/sales-activity');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

// ── Pure rollup ───────────────────────────────────────────────────────────────
(function pure() {
  const tz = 'UTC';
  const accounts = [{ id: 'o', name: 'Owner' }, { id: 'b', name: 'Bryce' }];
  const T = (d, h) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
  const leads = [
    // Bryce: called (no answer), texted, called (answered), moved to quoted then booked.
    { id: 'l1', name: 'Ana', phone: '5550000001', status: 'booked', createdAt: T(10, 9),
      noteLog: [
        { kind: 'call', outcome: 'answered', text: 'wants tint', at: T(11, 10), byId: 'b', by: 'Bryce' },
        { kind: 'text', text: 'hey', at: T(10, 10), byId: 'b', by: 'Bryce' },
        { kind: 'call', outcome: 'no_answer', text: '', at: T(10, 9, 30), byId: 'b', by: 'Bryce' },
      ].sort((a, b) => b.at.localeCompare(a.at)),
      stageLog: [
        { from: 'new', to: 'contacted', at: T(10, 10), via: 'manual', byId: 'b', by: 'Bryce' },
        { from: 'contacted', to: 'quoted', at: T(11, 10), via: 'manual', byId: 'b', by: 'Bryce' },
        { from: 'quoted', to: 'booked', at: T(12, 10), via: 'manual', byId: 'b', by: 'Bryce' },
      ] },
    // Bryce: one voicemail, still open in contacted, last touched 10 days before "now".
    { id: 'l2', name: 'Ben', phone: '5550000002', status: 'contacted', createdAt: T(5, 9),
      noteLog: [{ kind: 'call', outcome: 'voicemail', text: '', at: T(5, 12), byId: 'b', by: 'Bryce' }],
      stageLog: [{ from: 'new', to: 'contacted', at: T(5, 12), via: 'manual', byId: 'b', by: 'Bryce' }] },
    // Owner: legacy note with only a client-sent name → matched to the Owner account.
    { id: 'l3', name: 'Cy', phone: '5550000003', status: 'contacted', createdAt: T(11, 9),
      noteLog: [{ text: 'Texted', at: T(11, 11), by: 'Owner' }], stageLog: [] },
    // Nobody touched this one.
    { id: 'l4', name: 'Dee', phone: '5550000004', status: 'new', createdAt: T(12, 9), noteLog: [], stageLog: [] },
    // Website-channel lead: pipelineStatus carries the stage, status is the RC machine.
    { id: 'l5', name: 'Eve', phone: '5550000005', channel: 'website', status: 'LOST', pipelineStatus: 'lost', createdAt: T(9, 9),
      noteLog: [{ kind: 'email', text: 'sent info', at: T(9, 10), byId: 'b', by: 'Bryce' }],
      stageLog: [{ from: 'new', to: 'lost', at: T(9, 11), via: 'manual', byId: 'b', by: 'Bryce' }] },
    // Outside the window entirely (August) — invisible except as "ever touched".
    { id: 'l6', name: 'Old', phone: '5550000006', status: 'quoted', createdAt: '2026-08-01T09:00:00.000Z',
      noteLog: [{ kind: 'call', outcome: 'answered', text: '', at: '2026-08-02T09:00:00.000Z', byId: 'b', by: 'Bryce' }], stageLog: [] },
  ];
  const appointments = [
    { id: 'a1', createdBy: 'b', createdByName: 'Bryce', createdAt: T(12, 11), price: 450, status: 'confirmed' },
    { id: 'a2', createdBy: 'b', createdByName: 'Bryce', createdAt: T(12, 12), price: 999, status: 'cancelled' },
    { id: 'a3', createdBy: 'o', createdByName: 'Owner', createdAt: '2026-08-12T11:00:00.000Z', price: 100, status: 'confirmed' },
  ];
  const now = Date.parse('2026-09-15T12:00:00.000Z');
  const r = SA.computeSalesActivity({ leads, appointments, accounts, from: '2026-09-08', to: '2026-09-14', tz, now });
  const b = r.people.find(p => p.id === 'b'), o = r.people.find(p => p.id === 'o');
  eq('two people', r.people.map(p => p.id).sort(), ['b', 'o']);
  eq('bryce calls = 2 in window (l2 voicemail was 9/5)', b.calls, 2);
  eq('bryce answered = 1', b.callsAnswered, 1);
  eq('bryce no-answer = 1, voicemails = 0', [b.callsNoAnswer, b.voicemails], [1, 0]);
  eq('bryce texts = 1, emails = 1', [b.texts, b.emails], [1, 1]);
  eq('bryce leads worked = 2 (l1, l5)', b.leadsWorked, 2);
  eq('bryce leads contacted = 2', b.leadsContacted, 2);
  eq('bryce connected = 1', b.leadsConnected, 1);
  eq('bryce picked up new = 2 (l1, l5)', b.pickedUp, 2);
  eq('bryce quoted = 1, booked = 1, lost = 1', [b.quoted, b.booked, b.lost], [1, 1, 1]);
  eq('bryce booked rate = 50%', b.bookedRate, 50);
  eq('bryce open = 2 (l2 + l6 from August, still chaseable)', b.open, 2);
  eq('bryce stale = 2 (both quiet 3+ days)', b.openStale, 2);
  eq('open list quietest first', b.openList.map(x => x.id), ['l6', 'l2']);
  eq('bryce appts = 1 live, $450 (cancelled excluded)', [b.appts, b.apptValue], [1, 450]);
  eq('bryce median first touch = 30 min (l1 0, l5 60)', b.medianFirstTouchMin, 30);
  eq('bryce touches per booked lead = 3', b.avgTouchesPerBooked, 3);
  eq('bryce day series has 9/10 calls=1 texts=1', b.days['2026-09-10'], { calls: 1, texts: 1, emails: 0, notes: 0, booked: 0 });
  eq('bryce day series 9/12 booked=1', b.days['2026-09-12'].booked, 1);
  eq('owner legacy "Texted" by name → 1 text', [o.texts, o.leadsContacted], [1, 1]);
  eq('owner August appt not in window', o.appts, 0);
  eq('team untouched new = 1 (Dee)', [r.team.untouchedNew, r.team.untouchedNewList[0].id], [1, 'l4']);
  eq('team booked rate = 1/3 worked = 33%', r.team.bookedRate, 33);
  eq('feed newest first + stage rows included', [r.feed[0].leadId, r.feed[0].kind, r.feed.length], ['l1', 'stage', 9]);
  eq('no flags at 2 stale', b.flags, []);
  eq('stale-open flag fires at 3', SA.coachingFlags(Object.assign({}, b, { openStale: 3 })).some(f => /3 open leads/.test(f.text)), true);
  eq('no-answer flag fires', SA.coachingFlags(Object.assign({}, b, { calls: 10, noAnswerRate: 70 })).some(f => /70% of calls/.test(f.text)), true);

  // Window presets resolve in the shop's local day.
  const w = SA.resolveWindow({ preset: 'week', tz: 'UTC', now: Date.parse('2026-09-30T12:00:00Z') }); // a Wednesday
  eq('week preset = Mon..today', [w.from, w.to], ['2026-09-28', '2026-09-30']);
  eq('custom from/to wins', SA.resolveWindow({ preset: 'week', from: '2026-09-01', to: '2026-09-03', tz: 'UTC' }).preset, 'custom');
  eq('late-night Denver lead is still that local day', SA.localDate(Date.parse('2026-09-11T04:30:00Z'), 'America/Denver'), '2026-09-10');
})();

// ── Routes: actor stamping + owner-only rollup ────────────────────────────────
const shopId = 'shoptest_sa', ownerId = 'acct_owner_sa', techId = 'acct_tech_sa';
master.get('shops').push({ id: shopId, accountId: ownerId, shopName: 'SA Test', slug: 'sa-test', industry: 'detail', active: true }).write();
master.get('accounts').push(
  { id: ownerId, shopId, email: 'owner@sa.test', name: 'Me', role: 'full', active: true },
  { id: techId,  shopId, email: 'bryce@sa.test', name: 'Bryce', role: 'technician', active: true },
).write();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'SA Test', timezone: 'UTC' }).write();
db.set('leads', [
  { id: 'L1', name: 'Ana', phone: '5551110001', status: 'new', source: 'call', createdAt: new Date().toISOString(), noteLog: [], stageLog: [] },
  { id: 'L2', name: 'Ben', phone: '5551110002', status: 'new', source: 'call', createdAt: new Date().toISOString(), noteLog: [], stageLog: [] },
]).write();
db.set('appointments', []).write(); db.set('customers', []).write(); db.set('calls', []).write();

const app = express();
app.use(express.json());
app.use(require('../server/routes/shop'));
app.use(require('../server/routes/admin'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokOwner = jwt.sign({ shopId, accountId: ownerId, role: 'full' }, JWT_SECRET);
  const tokTech  = jwt.sign({ shopId, accountId: techId,  role: 'technician' }, JWT_SECRET);
  const post = (p, body, tok) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
  const get  = (p, tok) => fetch(base + p, { headers: { authorization: 'Bearer ' + tok } }).then(async r => ({ status: r.status, json: await r.json() }));
  try {
    // Tech logs a no-answer call, claiming to be the owner in the body — token wins.
    let r = await post('/api/shop/leads/L1/note', { kind: 'call', outcome: 'no_answer', text: '', by: 'Me', byId: ownerId }, tokTech);
    eq('call with no text accepted', r.status, 200);
    eq('entry kind/outcome kept', [r.json.entry.kind, r.json.entry.outcome], ['call', 'no_answer']);
    eq('byId from token, name from master', [r.json.entry.byId, r.json.entry.by], [techId, 'Bryce']);
    // Bare note with no words is rejected; bad kind falls back to note.
    r = await post('/api/shop/leads/L1/note', { kind: 'note', text: '' }, tokTech);
    eq('empty note rejected', r.status, 400);
    r = await post('/api/shop/leads/L1/note', { kind: 'bogus', outcome: 'bogus', text: 'hello' }, tokTech);
    eq('unknown kind → note, no outcome', [r.json.entry.kind, r.json.entry.outcome], ['note', undefined]);
    // Text + answered call by the tech, then stage moves.
    await post('/api/shop/leads/L1/note', { kind: 'text', text: 'hey Ana' }, tokTech);
    await post('/api/shop/leads/L1/note', { kind: 'call', outcome: 'answered', text: 'booked for Friday' }, tokTech);
    await post('/api/shop/leads/L1', { status: 'contacted' }, tokTech);
    await post('/api/shop/leads/L1', { status: 'booked' }, tokTech);
    // Owner bulk-moves L2 to lost.
    await post('/api/shop/leads/bulk-status', { ids: ['L2'], status: 'lost', lostReason: 'price' }, tokOwner);

    const L1 = getShopDb(shopId).get('leads').find({ id: 'L1' }).value();
    eq('stageLog stamped with actor', L1.stageLog.map(s => [s.to, s.byId, s.by]), [['contacted', techId, 'Bryce'], ['booked', techId, 'Bryce']]);
    eq('followTouchAt set by logging', typeof L1.followTouchAt, 'string');
    const L2 = getShopDb(shopId).get('leads').find({ id: 'L2' }).value();
    eq('bulk move stamped with owner', [L2.stageLog[0].via, L2.stageLog[0].byId], ['bulk', ownerId]);

    const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'shopflow-admin' };
    r = await fetch(base + '/api/admin/shop/' + shopId + '/sales-activity?preset=today').then(async x => ({ status: x.status }));
    eq('rollup needs the admin key', r.status, 401);
    r = await fetch(base + '/api/admin/shop/' + shopId + '/sales-activity?preset=today', { headers: ADMIN }).then(async x => ({ status: x.status, json: await x.json() }));
    eq('rollup 200', r.status, 200);
    eq('rollup names the shop', r.json.shop && r.json.shop.slug, 'sa-test');
    const bryce = (r.json.people || []).find(p => p.id === techId) || {};
    eq('bryce calls 2 / answered 1 / texts 1 / notes 1', [bryce.calls, bryce.callsAnswered, bryce.texts, bryce.notes], [2, 1, 1, 1]);
    eq('bryce worked 1, booked 1, rate 100%', [bryce.leadsWorked, bryce.booked, bryce.bookedRate], [1, 1, 100]);
    eq('bryce open 0 (L1 booked)', bryce.open, 0);
    const me = (r.json.people || []).find(p => p.id === ownerId) || {};
    eq('owner lost 1 via bulk', me.lost, 1);
    eq('accounts listed for the person picker', (r.json.accounts || []).map(a => a.name).sort(), ['Bryce', 'Me']);
    eq('window echoes preset', r.json.window.preset, 'today');
  } catch (e) { failures++; console.log('FAIL  threw', e.stack || e.message); }
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${failures === 0 ? '✓ ALL PASSED' : `✗ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
});

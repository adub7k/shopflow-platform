// What a client site's ad landing page (evosolution.org/detailing) leans on
// from the public API:
//  - GET /availability?serviceId&vehicleSize uses the service's per-size
//    duration (a truck detail runs hours longer than a sedan's), and POST /book
//    holds the appointment for that same length.
//  - POST /book stores ad attribution (utm/gclid/referrer) on the appointment
//    and normalises the page's source the same way a lead's is ('gads' → 'google').
//  - POST /square-deposit-session accepts a same-site path as returnUrl but
//    never a protocol-relative one; the success route redirects back to that
//    path with ?booking=&status=.
//  - POST /lead keeps the gclid with the utm payload.
//  - A no-deposit booking confirms on the spot and alerts the owner (push).
// Run: node test/detail-landing.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-detail-landing-' + process.pid);
process.env.SQUARE_ACCESS_TOKEN = 'test-token';
process.env.SQUARE_LOCATION_ID = 'L_TEST';

const sq = require('../server/payments/square');
let lastLink = null, orderPaid = false;
sq.createPaymentLink = async (args) => { lastLink = args; return { id: 'pl_1', orderId: 'ord_1', url: 'https://square.link/u/test' }; };
sq.isOrderPaid = async () => orderPaid;
// Owner push: capture instead of sending.
const pushInst = require('../server/push-instance');
const pushes = [];
pushInst.sendPush = async (shopId, payload) => { pushes.push({ shopId, payload }); };

const express = require('express');
const { master, getShopDb } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shoptest_dl', slug = 'detail-landing-test';
master.get('shops').push({ id: shopId, shopName: 'Detail Landing Test', slug, industry: 'detail', active: true }).write();
const db = getShopDb(shopId);
const sched = { workDays: [0, 1, 2, 3, 4, 5, 6], startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 60 };
db.set('settings', {
  shopName: 'Detail Landing Test', address: '3500 Vista Alameda NE, Suite A, Albuquerque, NM 87113',
  deposit: { enabled: true, amount: 50 },
  vehicleSizes: [{ key: 'sedan', label: 'Sedan' }, { key: 'suv', label: 'Mid-size SUV' }, { key: 'truck', label: 'Large SUV / Truck' }],
  customFields: [{ key: 'vehicleYear', label: 'Year', required: true }, { key: 'vehicleMake', label: 'Make', required: true }],
}).write();
db.set('barbers', [{ id: 'b1', name: 'A', active: true, schedule: sched }]).write();
db.set('services', [
  // Gold: 4 h on a sedan, 5.5 h on a truck. Flat duration is the SUV middle.
  { id: 'gold', name: 'Gold Detail', category: 'detail', price: 295, duration: 330, sizePricing: { sedan: 295, suv: 339, truck: 395 }, sizeDuration: { sedan: 240, suv: 330, truck: 330 } },
  { id: 'tint2', name: 'Front 2 Windows', category: 'tint', price: 170, duration: 60 },
]).write();
db.set('blockedDates', []).write(); db.set('customers', []).write(); db.set('calls', []).write(); db.set('leads', []).write(); db.set('appointments', []).write();

const d = new Date(); d.setDate(d.getDate() + 3);
const date = d.toISOString().slice(0, 10);

const app = express();
app.use(express.json());
app.use(require('../server/routes/public'));
app.use(require('../server/routes/square'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = p => fetch(base + p).then(r => r.json());
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const appt = id => getShopDb(shopId).get('appointments').find({ id }).value();
  try {
    // ── /info ────────────────────────────────────────────────────────────────
    const info = await get(`/api/public/${slug}/info`);
    eq('info: per-size durations + address exposed',
      [info.services.find(s => s.id === 'gold').sizeDuration, info.address],
      [{ sedan: 240, suv: 330, truck: 330 }, '3500 Vista Alameda NE, Suite A, Albuquerque, NM 87113']);

    // ── per-size duration drives availability ────────────────────────────────
    const sedan = await get(`/api/public/${slug}/availability?date=${date}&serviceId=gold&vehicleSize=sedan`);
    const truck = await get(`/api/public/${slug}/availability?date=${date}&serviceId=gold&vehicleSize=truck`);
    const flat = await get(`/api/public/${slug}/availability?date=${date}&serviceId=gold`);
    eq('availability: 4 h sedan job → last start 2:00 PM', sedan[sedan.length - 1], '2:00 PM');
    eq('availability: 5.5 h truck job → last start 12:00 PM', truck[truck.length - 1], '12:00 PM');
    eq('availability: no size → flat duration (5.5 h) as before', flat[flat.length - 1], '12:00 PM');
    const combo = await get(`/api/public/${slug}/availability?date=${date}&serviceId=gold,tint2&vehicleSize=sedan`);
    eq('availability: multi-service sums per-size + flat (5 h) → 1:00 PM', combo[combo.length - 1], '1:00 PM');

    // ── /book with attribution, held for the per-size length ─────────────────
    const b = await post(`/api/public/${slug}/book`, {
      customerName: 'Pat', customerPhone: '5055550101', serviceId: 'gold', vehicleSize: 'truck', date, time: '10:00 AM',
      customFields: { vehicleYear: '2021', vehicleMake: 'Ram' },
      source: 'gads', utm: { source: 'gads', campaign: 'abq-detail', junk: 'x' }, gclid: 'Cj0KCQ', referrer: 'https://www.google.com/',
    });
    const a1 = appt(b.appointmentId);
    eq('book: truck price + truck duration', [a1.price, a1.duration], [395, 330]);
    eq('book: attribution stored, utm whitelisted', [a1.utm, a1.gclid, a1.referrer], [{ source: 'gads', campaign: 'abq-detail' }, 'Cj0KCQ', 'https://www.google.com/']);
    eq('book: source normalised like a lead (gads → google), on appt + new customer',
      [a1.source, getShopDb(shopId).get('customers').find({ id: a1.customerId }).value().source], ['google', 'google']);
    eq('book: held pending deposit, no owner alert yet', [a1.status, pushes.length], ['pending-deposit', 0]);

    const plain = await post(`/api/public/${slug}/book`, { customerName: 'Lee', customerPhone: '5055550102', serviceId: 'gold', vehicleSize: 'sedan', date, time: '2:00 PM', customFields: { vehicleYear: '2020', vehicleMake: 'Ford' } });
    const a2 = appt(plain.appointmentId);
    eq('book: classic page keeps its default source + no attribution keys; sedan length', [a2.source, 'utm' in a2, a2.duration], ['booking-page', false, 240]);

    // ── same-site returnUrl ──────────────────────────────────────────────────
    await post(`/api/public/${slug}/square-deposit-session`, { appointmentId: b.appointmentId, returnUrl: '//evil.test/x' });
    eq('deposit: protocol-relative returnUrl dropped', appt(b.appointmentId).depositReturnUrl, undefined);
    await post(`/api/public/${slug}/square-deposit-session`, { appointmentId: b.appointmentId, returnUrl: `/book/${slug}` });
    eq('deposit: same-site path accepted, amount from settings', [appt(b.appointmentId).depositReturnUrl, lastLink.amountCents], [`/book/${slug}`, 5000]);

    const r1 = await fetch(`${base}/sq/booking-deposit-success?appt=${b.appointmentId}&shop=${shopId}`, { redirect: 'manual' });
    eq('unpaid → back to the page with status=unpaid', [r1.status, r1.headers.get('location')], [303, `/book/${slug}?booking=${b.appointmentId}&status=unpaid`]);
    orderPaid = true;
    const r2 = await fetch(`${base}/sq/booking-deposit-success?appt=${b.appointmentId}&shop=${shopId}`, { redirect: 'manual' });
    eq('paid → back with status=confirmed; appt confirmed', [r2.headers.get('location'), appt(b.appointmentId).status, appt(b.appointmentId).depositPaid], [`/book/${slug}?booking=${b.appointmentId}&status=confirmed`, 'confirmed', true]);
    eq('paid → owner push says deposit paid', [pushes.length, /\$50 deposit paid/.test(pushes[0].payload.title)], [1, true]);

    // ── no-deposit shop: confirms on the spot + owner alert ──────────────────
    db.get('settings').assign({ deposit: { enabled: false, amount: 0 } }).write();
    const c = await post(`/api/public/${slug}/book`, { customerName: 'Sam', customerPhone: '5055550103', serviceId: 'gold', vehicleSize: 'sedan', date, time: '9:00 AM', customFields: { vehicleYear: '2019', vehicleMake: 'Honda' }, source: 'google' });
    eq('no deposit → confirmed immediately', appt(c.appointmentId).status, 'confirmed');
    eq('no deposit → owner push, no "paid" wording', [pushes.length, /📅 New booking — Sam$/.test(pushes[1].payload.title)], [2, true]);

    // ── lead keeps the click id ──────────────────────────────────────────────
    const l1 = await post(`/api/public/${slug}/lead`, { name: 'Ask Er', phone: '5055550199', skipRequiredCustomFields: true, customFields: {}, notes: 'Dog hair?', utm: { source: 'google', campaign: 'abq-detail' }, gclid: 'Gc1', referrer: '' });
    const lead = getShopDb(shopId).get('leads').find({ phone: '5055550199' }).value();
    eq('lead: gclid kept with utm, source google', [l1.ok, lead.source, lead.utm], [true, 'google', { source: 'google', campaign: 'abq-detail', gclid: 'Gc1' }]);
  } catch (e) { failures++; console.error('FAIL  threw', e); }
  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nAll passed');
  process.exit(failures ? 1 : 0);
});

// Website self-booking: a shop's marketing site books + takes the deposit through
// the public API.
//  - GET /availability?serviceId only offers start times where the WHOLE job fits
//    (before the staff end time, and with a free pair of hands for the full span,
//    counted the same way createAppointment's double-book guard counts).
//  - POST /square-deposit-session charges the shop's deposit setting, never the
//    request body, and only honours a returnUrl on BOOKING_RETURN_ORIGINS.
//  - /sq/booking-deposit-success sends the customer back to that site with
//    ?status=confirmed|unpaid, and confirms the appointment only when paid.
// Run: node test/website-booking.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-webbook-' + process.pid);
process.env.BOOKING_RETURN_ORIGINS = 'https://www.example-shop.test';
process.env.SQUARE_ACCESS_TOKEN = 'test-token';
process.env.SQUARE_LOCATION_ID = 'L_TEST';

// Stub the Square REST module before the routes load it.
const sq = require('../server/payments/square');
let lastLink = null, orderPaid = false;
sq.createPaymentLink = async (args) => { lastLink = args; return { id: 'pl_1', orderId: 'ord_1', url: 'https://square.link/u/test' }; };
sq.isOrderPaid = async () => orderPaid;

const express = require('express');
const { master, getShopDb } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const shopId = 'shoptest_wb', slug = 'web-book-test';
master.get('shops').push({ id: shopId, shopName: 'Web Book Test', slug, industry: 'detail', active: true }).write();
const db = getShopDb(shopId);
const sched = { workDays: [0, 1, 2, 3, 4, 5, 6], startTime: '9:00 AM', endTime: '6:00 PM', slotMinutes: 30 };
db.set('settings', { shopName: 'Web Book Test', deposit: { enabled: true, amount: 50 }, customFields: [] }).write();
db.set('barbers', [{ id: 'b1', name: 'A', active: true, schedule: sched }, { id: 'b2', name: 'B', active: true, schedule: sched }]).write();
db.set('services', [{ id: 'tint', name: 'Ceramic Tint', price: 560, duration: 240 }, { id: 'quick', name: 'Front 2', price: 170, duration: 60 }]).write();
db.set('blockedDates', []).write(); db.set('customers', []).write(); db.set('calls', []).write();

const d = new Date(); d.setDate(d.getDate() + 3);
const date = d.toISOString().slice(0, 10);
// Two unassigned jobs (website bookings carry no staff) overlapping 10:00–12:00.
db.set('appointments', [
  { id: 'x1', date, time: '10:00 AM', duration: 120, status: 'confirmed', barberId: null },
  { id: 'x2', date, time: '11:00 AM', duration: 60, status: 'confirmed', barberId: null },
]).write();

const app = express();
app.use(express.json());
app.use(require('../server/routes/public'));
app.use(require('../server/routes/square'));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = p => fetch(base + p).then(r => r.json());
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    const tint = await get(`/api/public/${slug}/availability?date=${date}&serviceId=tint`);
    eq('4h job: last start is 2:00 PM (fits before 6)', tint[tint.length - 1], '2:00 PM');
    eq('4h job: 9:00 overlaps both 10–12 jobs with 2 staff → not offered', tint.includes('9:00 AM'), false);
    eq('4h job: 12:00 PM is free again', tint.includes('12:00 PM'), true);
    const quick = await get(`/api/public/${slug}/availability?date=${date}&serviceId=quick`);
    eq('1h job: 9:00 AM fits before the 10:00 jobs', quick.includes('9:00 AM'), true);
    eq('1h job: 11:00 AM is full (two overlapping jobs, two staff)', quick.includes('11:00 AM'), false);
    eq('1h job: 5:00 PM is the last start', quick[quick.length - 1], '5:00 PM');
    const legacy = await get(`/api/public/${slug}/availability?date=${date}`);
    eq('no serviceId → legacy list unchanged (incl 5:30 PM)', legacy.includes('5:30 PM'), true);

    // Every slot the API offers must actually book.
    const b = await post(`/api/public/${slug}/book`, { customerName: 'Pat', customerPhone: '5055550101', serviceId: 'tint', date, time: '12:00 PM', source: 'website' });
    eq('offered slot books, held pending deposit', [b.ok, getShopDb(shopId).get('appointments').find({ id: b.appointmentId }).value().status], [true, 'pending-deposit']);

    const s1 = await post(`/api/public/${slug}/square-deposit-session`, { appointmentId: b.appointmentId, amount: 0.01, returnUrl: 'https://evil.test/x' });
    eq('deposit uses shop setting, ignores body amount', [s1.ok, lastLink.amountCents], [true, 5000]);
    eq('unlisted returnUrl is dropped', getShopDb(shopId).get('appointments').find({ id: b.appointmentId }).value().depositReturnUrl, undefined);

    await post(`/api/public/${slug}/square-deposit-session`, { appointmentId: b.appointmentId, returnUrl: 'https://www.example-shop.test/book/confirmed' });
    const r1 = await fetch(`${base}/sq/booking-deposit-success?appt=${b.appointmentId}&shop=${shopId}`, { redirect: 'manual' });
    eq('unpaid return → back to site with status=unpaid', [r1.status, new URL(r1.headers.get('location')).searchParams.get('status')], [303, 'unpaid']);
    eq('unpaid → still pending', getShopDb(shopId).get('appointments').find({ id: b.appointmentId }).value().status, 'pending-deposit');

    orderPaid = true;
    const r2 = await fetch(`${base}/sq/booking-deposit-success?appt=${b.appointmentId}&shop=${shopId}`, { redirect: 'manual' });
    const loc = new URL(r2.headers.get('location'));
    eq('paid return → site, status=confirmed, booking id', [loc.origin + loc.pathname, loc.searchParams.get('status'), loc.searchParams.get('booking')], ['https://www.example-shop.test/book/confirmed', 'confirmed', b.appointmentId]);
    const appt = getShopDb(shopId).get('appointments').find({ id: b.appointmentId }).value();
    eq('paid → confirmed with $50 deposit', [appt.status, appt.depositPaid, appt.depositAmount], ['confirmed', true, 50]);

    // Several services in one visit: one appointment, summed price/duration.
    const multi = await get(`/api/public/${slug}/availability?date=${date}&serviceId=tint,quick`);
    eq('4h+1h visit: last start is 1:00 PM', multi[multi.length - 1], '1:00 PM');
    const m = await post(`/api/public/${slug}/book`, { customerName: 'Sam', customerPhone: '5055550102', serviceIds: ['tint', 'quick', 'tint'], date, time: '1:00 PM', source: 'website' });
    const ma = getShopDb(shopId).get('appointments').find({ id: m.appointmentId }).value();
    eq('multi-service → one appt, summed, deduped', [m.ok, ma.service, ma.price, ma.duration, ma.serviceId, ma.services.length], [true, 'Ceramic Tint + Front 2', 730, 300, 'tint', 2]);
    const bad = await post(`/api/public/${slug}/book`, { customerName: 'Sam', customerPhone: '5055550102', serviceIds: ['tint', 'nope'], date, time: '9:00 AM' });
    eq('unknown service in the list is rejected', bad.ok, false);
    const single = await post(`/api/public/${slug}/book`, { customerName: 'Lee', customerPhone: '5055550103', serviceId: 'quick', date, time: '9:00 AM' });
    const sa = getShopDb(shopId).get('appointments').find({ id: single.appointmentId }).value();
    eq('single serviceId keeps the original shape', [sa.service, sa.price, sa.duration, sa.services], ['Front 2', 170, 60, undefined]);
  } catch (e) { failures++; console.error(e); }
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
});

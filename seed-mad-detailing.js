// ── Demo seed: "Mad Detailing" (detail-shop vertical) ─────────────────────────
// Creates a log, in-able tenant with dummy data so you can click through the
// detail-shop experience end to end.
//
//   node seed-mad-detailing.js
//
//   Login:  demo@maddetailing.com  /  demo1234        (CRM at /shop/mad-detailing)
//   Booking page:  /book/mad-detailing
//
// Re-running wipes and recreates the demo shop only — other tenants untouched.

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { master, getShopDb, initShopDb, shopHelpers, genId, today, SHOPS_DIR } = require('./server/db');

const SLUG  = 'mad-detailing';
const EMAIL = 'demo@maddetailing.com';
const PASS  = 'demo1234';

// ── Wipe any previous demo shop so re-runs are clean ──────────────────────────
const prev = master.get('shops').find({ slug: SLUG }).value();
if (prev) {
  master.get('accounts').remove({ shopId: prev.id }).write();
  master.get('shops').remove({ id: prev.id }).write();
  const dir = path.join(SHOPS_DIR, prev.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  console.log('• Removed previous demo shop');
}

// ── Register the tenant (account + shop record) ───────────────────────────────
const shopId    = uuidv4();
const accountId = uuidv4();
const passwordHash = bcrypt.hashSync(PASS, 10);

master.get('accounts').push({
  id: accountId, shopId, email: EMAIL, passwordHash,
  name: 'Mad Detailing Owner', role: 'full',
  createdAt: new Date().toISOString(), plan: 'shop', active: true,
}).write();

// Staff with roles — each logs in with their own email + password (demo1234)
[
  { name: 'Marcus Reyes', email: 'marcus@maddetailing.com', role: 'technician' },
  { name: 'Front Desk',   email: 'desk@maddetailing.com',   role: 'viewonly' },
].forEach(u => {
  master.get('accounts').push({
    id: uuidv4(), shopId, email: u.email, passwordHash: bcrypt.hashSync(PASS, 10),
    name: u.name, role: u.role, active: true, createdAt: new Date().toISOString(),
  }).write();
});

master.get('shops').push({
  id: shopId, accountId, shopName: 'Mad Detailing', slug: SLUG, email: EMAIL,
  phone: '(505) 555-0142', plan: 'shop', industry: 'detail', active: true,
  createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
}).write();

// ── Initialize the per-shop DB from the detail profile ────────────────────────
const db = getShopDb(shopId);
initShopDb(db, { shopName: 'Mad Detailing', email: EMAIL, phone: '(505) 555-0142', industry: 'detail' });
const h = shopHelpers(db);

// Tweak shop settings: tagline + deposit copy
db.get('settings').assign({
  tagline: 'Showroom shine, every time.',
  bookingMessage: 'Book your detail below — we’ll take it from here.',
  address: '4120 Menaul Blvd NE, Albuquerque, NM',
}).write();

// ── Technicians (internally "barbers", labelled "Technicians" / "Bay") ────────
const techs = [
  { id: 'b1', name: 'Marcus Reyes',  chair: 1, color: '#16a34a', bio: 'Lead detailer · ceramic specialist' },
  { id: 'b2', name: 'Tina Alvarez',  chair: 2, color: '#2563eb', bio: 'Interiors & odor removal' },
  { id: 'b3', name: 'Devon Clark',   chair: 3, color: '#d97706', bio: 'Wash & paint correction' },
].map(t => ({ ...t, phone: '', active: true, joinedAt: today(),
  schedule: { workDays: [1,2,3,4,5,6], startTime: '8:00 AM', endTime: '6:00 PM', slotMinutes: 60 } }));
db.set('barbers', techs).write();

// Services come from the detail profile already; grab them for appointments.
const services = h.getAll('services');
const svc = name => services.find(s => s.name === name) || services[0];

// ── Helpers ───────────────────────────────────────────────────────────────────
const dShift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };
const pick   = (arr) => arr[Math.floor(Math.random() * arr.length)];
const times  = ['8:00 AM','9:00 AM','10:00 AM','11:00 AM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'];

// ── Customers (with vehicle history) + one fleet account ──────────────────────
const customers = [
  { name:'Jordan Pierce',  phone:'(505) 555-1001', email:'jpierce@email.com',
    vehicles:[{year:'2021',make:'Tesla',model:'Model 3',color:'Pearl White'}] },
  { name:'Renee Castillo', phone:'(505) 555-1002', email:'renee.c@email.com',
    vehicles:[{year:'2018',make:'Jeep',model:'Wrangler',color:'Black'}] },
  { name:'Andre Whitfield',phone:'(505) 555-1003', email:'',
    vehicles:[{year:'2022',make:'Ford',model:'F-150',color:'Silver'}] },
  { name:'Mia Tran',       phone:'(505) 555-1004', email:'mia.tran@email.com',
    vehicles:[{year:'2020',make:'Honda',model:'Civic',color:'Blue'},{year:'2015',make:'Toyota',model:'Camry',color:'Gray'}] },
  { name:'Carlos Benitez', phone:'(505) 555-1005', email:'',
    vehicles:[{year:'2023',make:'Chevrolet',model:'Corvette',color:'Red'}] },
  // Fleet account — business with multiple vehicles
  { name:'Sandia Auto Group', phone:'(505) 555-2000', email:'ops@sandiaauto.com',
    isFleet:true, companyName:'Sandia Auto Group',
    vehicles:[
      {year:'2022',make:'Ram',model:'1500',color:'White'},
      {year:'2021',make:'Ram',model:'2500',color:'White'},
      {year:'2023',make:'Ford',model:'Transit',color:'White'},
      {year:'2020',make:'Chevrolet',model:'Silverado',color:'Black'},
    ] },
];

customers.forEach((c, i) => {
  h.upsert('customers', {
    id: 'c' + (i + 1), name: c.name, phone: c.phone, email: c.email || '',
    source: 'seed', notes: '', loyaltyPoints: 0, loyaltyVisits: 0, noShows: 0,
    preferredBarberId: pick(techs).id,
    isFleet: !!c.isFleet, companyName: c.companyName || '', vehicles: c.vehicles || [],
    createdAt: dShift(-90 + i * 5),
  });
});

// ── Appointments ──────────────────────────────────────────────────────────────
let n = 0;
function appt({ cId, date, time, service, status, tech, notes, cutNotes }) {
  const cust = h.getById('customers', cId);
  const s = svc(service);
  const v = (cust.vehicles && cust.vehicles[0]) || {};
  h.upsert('appointments', {
    id: 'a' + (++n),
    customerId: cId, customerName: cust.name, customerPhone: cust.phone, customerEmail: cust.email,
    barberId: tech.id, barberName: tech.name,
    serviceId: s.id, service: s.name, price: s.price, duration: s.duration,
    date, time, status,
    notes: notes || '',
    cutNotes: cutNotes || '',
    customFields: { vehicleYear: v.year||'', vehicleMake: v.make||'', vehicleModel: v.model||'', vehicleColor: v.color||'' },
    depositPaid: status !== 'no-show', depositAmount: 50,
    source: 'seed', createdAt: new Date().toISOString(),
  });
}

// Past completed jobs (build revenue + visit history) over the last ~10 weeks
const pastSpecs = [
  ['c1','Full Detail','Heavy swirl marks corrected, applied 6-month sealant.'],
  ['c2','Interior Detail','Pet hair extraction, leather conditioned.'],
  ['c3','Express Wash',''],
  ['c4','Ceramic Coating','2-year ceramic, full prep + paint correction.'],
  ['c1','Express Wash',''],
  ['c5','Full Detail','Engine bay cleaned on request.'],
  ['c2','Express Wash',''],
  ['c4','Interior Detail','Coffee stain on console removed.'],
  ['c6','Full Detail','Fleet truck #1 — monthly contract.'],
  ['c6','Full Detail','Fleet truck #2 — monthly contract.'],
];
pastSpecs.forEach(([cId, service, cutNotes], i) => {
  appt({ cId, date: dShift(-(60 - i * 6)), time: pick(times), service,
    status: 'done', tech: pick(techs), cutNotes });
});

// Today — one in each operational status so the board shows the full pipeline
appt({ cId:'c1', date: today(), time:'8:00 AM',  service:'Ceramic Coating', status:'curing',      tech: techs[0], cutNotes:'Coating applied 9am, curing until 3pm — do not move.' });
appt({ cId:'c2', date: today(), time:'9:00 AM',  service:'Interior Detail', status:'in-progress', tech: techs[1] });
appt({ cId:'c3', date: today(), time:'10:00 AM', service:'Express Wash',    status:'dropped-off', tech: techs[2], notes:'Keys in lockbox 4.' });
appt({ cId:'c5', date: today(), time:'1:00 PM',  service:'Full Detail',     status:'ready',       tech: techs[0], cutNotes:'Done — customer texted for pickup.' });
appt({ cId:'c4', date: today(), time:'3:00 PM',  service:'Express Wash',    status:'confirmed',   tech: techs[2] });

// Upcoming
appt({ cId:'c6', date: dShift(2), time:'8:00 AM',  service:'Full Detail',     status:'confirmed', tech: techs[0], notes:'Fleet Transit van.' });
appt({ cId:'c2', date: dShift(3), time:'11:00 AM', service:'Ceramic Coating', status:'confirmed', tech: techs[0] });
appt({ cId:'c5', date: dShift(5), time:'2:00 PM',  service:'Interior Detail', status:'confirmed', tech: techs[1] });

// A no-show on record
appt({ cId:'c3', date: dShift(-7), time:'4:00 PM', service:'Express Wash', status:'no-show', tech: techs[2] });

// Recompute loyalty from completed jobs
const allAppts = h.getAll('appointments');
h.getAll('customers').forEach(c => {
  const done = allAppts.filter(a => a.customerId === c.id && a.status === 'done').length;
  const ns   = allAppts.filter(a => a.customerId === c.id && a.status === 'no-show').length;
  c.loyaltyVisits = done; c.loyaltyPoints = done; c.noShows = ns;
  h.upsert('customers', c);
});

console.log('\n✓ Mad Detailing demo seeded');
console.log('  CRM:     /shop/' + SLUG + '   login ' + EMAIL + ' / ' + PASS);
console.log('  Booking: /book/' + SLUG);
console.log('  ' + customers.length + ' customers (1 fleet), ' + n + ' appointments, ' + techs.length + ' technicians');
console.log('  Staff logins (all password ' + PASS + '):');
console.log('    Full Access : ' + EMAIL);
console.log('    Technician  : marcus@maddetailing.com');
console.log('    View Only   : desk@maddetailing.com\n');

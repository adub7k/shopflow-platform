// ── Demo seed: a generic detail shop (no branding / specific names) ───────────
// Spins up a clean detail-shop tenant that shows off the detailer features:
// vehicle-size pricing, add-ons, before/after photos, estimates, and a
// membership (so MRR shows on the dashboard).
//
//   node seed-demo-detail.js          → wipe + recreate the demo (reset to clean)
//
//   Login:  demo@detail.com  /  demo1234     (CRM at /shop/demo-detail)
//   Booking page:  /book/demo-detail
//
// Also runnable on boot: the server calls this with { force:false } when the
// SEED_DEMO=true env var is set, so a Railway deploy can seed its volume once
// (without shell access). force:false only seeds when the shop doesn't exist yet.

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { master, getShopDb, initShopDb, shopHelpers, genId, today, SHOPS_DIR } = require('./server/db');

const SLUG  = 'demo-detail';
const EMAIL = 'demo@detail.com';
const PASS  = 'demo1234';

function seedDemoDetail({ force = true } = {}) {
  const existing = master.get('shops').find({ slug: SLUG }).value();
  if (existing && !force) {
    console.log('• Demo detail shop already present — skipping seed');
    return existing.id;
  }

  // ── Wipe any previous demo shop so re-runs are clean ────────────────────────
  if (existing) {
    master.get('accounts').remove({ shopId: existing.id }).write();
    master.get('shops').remove({ id: existing.id }).write();
    const dir = path.join(SHOPS_DIR, existing.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    console.log('• Removed previous demo shop');
  }

  // ── Register the tenant (account + shop record) ─────────────────────────────
  const shopId    = uuidv4();
  const accountId = uuidv4();
  master.get('accounts').push({
    id: accountId, shopId, email: EMAIL, passwordHash: bcrypt.hashSync(PASS, 10),
    name: 'Owner', role: 'full', createdAt: new Date().toISOString(), plan: 'shop', active: true,
  }).write();
  master.get('shops').push({
    id: shopId, accountId, shopName: 'Demo Detail Shop', slug: SLUG, email: EMAIL,
    phone: '(555) 010-0000', plan: 'shop', industry: 'detail', active: true,
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
  }).write();

  // ── Initialize from the detail profile, then layer on demo config ───────────
  const db = getShopDb(shopId);
  initShopDb(db, { shopName: 'Demo Detail Shop', email: EMAIL, phone: '(555) 010-0000', industry: 'detail' });
  const h = shopHelpers(db);

  db.get('settings').assign({
    tagline: 'Professional auto detailing.',
    bookingMessage: 'Book your detail below — we’ll take it from here.',
    addons: [
      { id: 'ad1', name: 'Pet Hair Removal',       price: 40 },
      { id: 'ad2', name: 'Odor / Ozone Treatment', price: 50 },
      { id: 'ad3', name: 'Engine Bay Cleaning',    price: 30 },
      { id: 'ad4', name: 'Headliner Cleaning',     price: 35 },
    ],
    membershipPlans: [
      { id: 'plan1', name: 'Monthly Wash Club',  price: 49,  interval: 'month', perks: '2 washes/mo + 10% off details' },
      { id: 'plan2', name: 'Annual Maintenance', price: 600, interval: 'year',  perks: 'Quarterly full detail' },
    ],
    quoteCounter: 1002,
  }).write();

  // Vehicle-size pricing on the bigger services (Tier A showcase)
  const services = h.getAll('services');
  const setSize = (name, sp) => { const s = services.find(x => x.name === name); if (s) { s.sizePricing = sp; s.price = sp.sedan; h.upsert('services', s); } };
  setSize('Full Detail',     { sedan: 250, suv: 300, truck: 350 });
  setSize('Ceramic Coating', { sedan: 600, suv: 750, truck: 900 });

  // ── Technicians (generic) ───────────────────────────────────────────────────
  const techs = [
    { id: 'b1', name: 'Technician 1', chair: 1, color: '#16a34a', bio: 'Wash & exterior' },
    { id: 'b2', name: 'Technician 2', chair: 2, color: '#2563eb', bio: 'Interiors & coatings' },
  ].map(t => ({ ...t, phone: '', active: true, joinedAt: today(),
    schedule: { workDays: [1,2,3,4,5,6], startTime: '8:00 AM', endTime: '6:00 PM', slotMinutes: 60 } }));
  db.set('barbers', techs).write();

  // ── Customers (generic names) + a fleet account ─────────────────────────────
  const customers = [
    { name: 'Customer One',   phone: '(555) 010-0001', vehicles: [{ year:'2021', make:'Tesla',     model:'Model 3',  color:'White' }] },
    { name: 'Customer Two',   phone: '(555) 010-0002', vehicles: [{ year:'2018', make:'Jeep',      model:'Wrangler', color:'Black' }] },
    { name: 'Customer Three', phone: '(555) 010-0003', vehicles: [{ year:'2022', make:'Ford',      model:'F-150',    color:'Silver' }] },
    { name: 'Customer Four',  phone: '(555) 010-0004', vehicles: [{ year:'2020', make:'Honda',     model:'Civic',    color:'Blue' }] },
    { name: 'Customer Five',  phone: '(555) 010-0005', vehicles: [{ year:'2023', make:'Chevrolet', model:'Corvette', color:'Red' }] },
    { name: 'Fleet Account',  phone: '(555) 010-2000', isFleet: true, companyName: 'Fleet Account',
      vehicles: [{ year:'2022', make:'Ram', model:'1500', color:'White' }, { year:'2021', make:'Ram', model:'2500', color:'White' }] },
  ];
  customers.forEach((c, i) => {
    h.upsert('customers', {
      id: 'c' + (i + 1), name: c.name, phone: c.phone, email: '',
      source: 'seed', notes: '', loyaltyPoints: 0, loyaltyVisits: 0, noShows: 0,
      preferredBarberId: techs[i % techs.length].id,
      isFleet: !!c.isFleet, companyName: c.companyName || '', vehicles: c.vehicles || [],
      createdAt: today(),
    });
  });

  // One active member so the dashboard shows MRR
  const c1 = h.getById('customers', 'c1');
  c1.membership = { planId: 'plan1', planName: 'Monthly Wash Club', price: 49, interval: 'month', status: 'active', source: 'manual', startedAt: new Date().toISOString() };
  h.upsert('customers', c1);

  // ── Appointments across the detail pipeline (with size + add-ons) ───────────
  const dShift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };
  const svc = name => services.find(s => s.name === name) || services[0];
  const settings = db.get('settings').value();
  let n = 0;
  function appt({ cId, date, time, service, status, tech, vehicleSize, addonIds, notes }) {
    const cust = h.getById('customers', cId);
    const s = svc(service);
    const v = (cust.vehicles && cust.vehicles[0]) || {};
    const base = (s.sizePricing && vehicleSize && s.sizePricing[vehicleSize] != null) ? s.sizePricing[vehicleSize] : s.price;
    const adds = (addonIds || []).map(id => (settings.addons || []).find(a => a.id === id)).filter(Boolean).map(a => ({ id: a.id, name: a.name, price: a.price }));
    const price = base + adds.reduce((t, a) => t + a.price, 0);
    h.upsert('appointments', {
      id: 'a' + (++n), customerId: cId, customerName: cust.name, customerPhone: cust.phone, customerEmail: '',
      barberId: tech.id, barberName: tech.name, serviceId: s.id, service: s.name, price, duration: s.duration,
      date, time, status, notes: notes || '',
      customFields: { vehicleYear: v.year||'', vehicleMake: v.make||'', vehicleModel: v.model||'', vehicleColor: v.color||'' },
      vehicleSize: vehicleSize || null, addons: adds,
      source: 'seed', createdAt: new Date().toISOString(),
    });
  }

  // ~2 months of completed jobs — builds revenue history + customer visit counts
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const times = ['8:00 AM','9:00 AM','10:00 AM','11:00 AM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'];
  const histServices  = ['Express Wash','Express Wash','Interior Detail','Full Detail','Full Detail','Ceramic Coating'];
  const histSizes     = [null,'sedan','sedan','suv','truck'];
  const histAddons    = [[],[],['ad1'],['ad2'],['ad3'],['ad1','ad3']];
  const histCustomers = ['c1','c2','c3','c4','c5','c6'];
  for (let d = 60; d >= 1; d--) {
    const date = dShift(-d);
    if (new Date(date + 'T12:00:00').getDay() === 0) continue; // closed Sundays
    const slots = [...times];
    const count = 1 + Math.floor(Math.random() * 3);           // 1–3 jobs/day
    for (let j = 0; j < count && slots.length; j++) {
      appt({ cId: pick(histCustomers), date, time: slots.splice(Math.floor(Math.random()*slots.length),1)[0],
        service: pick(histServices), status: 'done', tech: pick(techs),
        vehicleSize: pick(histSizes), addonIds: pick(histAddons) });
    }
  }

  // Today — full operational pipeline
  appt({ cId:'c1', date: today(), time:'8:00 AM',  service:'Ceramic Coating', status:'curing',      tech: techs[0], vehicleSize:'suv', notes:'Curing until 3pm — do not move.' });
  appt({ cId:'c2', date: today(), time:'9:00 AM',  service:'Interior Detail', status:'in-progress', tech: techs[1] });
  appt({ cId:'c3', date: today(), time:'10:00 AM', service:'Express Wash',    status:'dropped-off', tech: techs[0] });
  appt({ cId:'c4', date: today(), time:'1:00 PM',  service:'Full Detail',     status:'ready',       tech: techs[1], vehicleSize:'sedan' });

  // Upcoming
  appt({ cId:'c5', date: dShift(2), time:'8:00 AM',  service:'Full Detail',     status:'confirmed', tech: techs[0], vehicleSize:'sedan' });
  appt({ cId:'c6', date: dShift(3), time:'9:00 AM',  service:'Express Wash',    status:'confirmed', tech: techs[1] });

  // Recompute loyalty counts from completed work
  const allAppts = h.getAll('appointments');
  h.getAll('customers').forEach(c => {
    c.loyaltyVisits = allAppts.filter(a => a.customerId === c.id && a.status === 'done').length;
    c.loyaltyPoints = c.loyaltyVisits;
    h.upsert('customers', c);
  });

  // ── Estimates (one sent w/ deposit, one approved) ───────────────────────────
  db.set('quotes', [
    { id: genId('q'), number: 'Q-1001', customerId: 'c5', customerName: 'Customer Five', customerPhone: '(555) 010-0005',
      vehicle: { year:'2023', make:'Chevrolet', model:'Corvette', color:'Red' },
      lineItems: [{ name:'Ceramic Coating', price:900 }, { name:'Paint Correction', price:500 }], total: 1400,
      notes: '2-stage paint correction + 5-year ceramic.', status: 'sent',
      depositRequired: true, depositAmount: 100, createdAt: new Date().toISOString() },
    { id: genId('q'), number: 'Q-1002', customerId: 'c2', customerName: 'Customer Two', customerPhone: '(555) 010-0002',
      vehicle: { year:'2018', make:'Jeep', model:'Wrangler', color:'Black' },
      lineItems: [{ name:'Full Detail', price:300 }, { name:'Pet Hair Removal', price:40 }], total: 340,
      notes: '', status: 'approved', approvedAt: new Date().toISOString(),
      depositRequired: false, depositAmount: 0, createdAt: new Date().toISOString() },
  ]).write();

  console.log('\n✓ Demo detail shop seeded');
  console.log('  CRM:     /shop/' + SLUG + '   login ' + EMAIL + ' / ' + PASS);
  console.log('  Booking: /book/' + SLUG);
  console.log('  ' + customers.length + ' customers (1 fleet, 1 member), ' + n + ' appointments, 2 estimates, ' + techs.length + ' technicians\n');
  return shopId;
}

module.exports = seedDemoDetail;

// Run directly (`node seed-demo-detail.js`) → force a clean reset.
if (require.main === module) seedDemoDetail({ force: true });

// ── Demo seed: populate an EXISTING cleaning-company tenant ───────────────────
// Fills the cleaning vertical's collections (crews, properties, recurring
// services, jobs, expenses) so the dashboard/jobs board/revenue tabs show a
// realistic small cleaning business: 1 crew, 5 recurring contracts, ~$15k/mo of
// completed work, ~$7.5–8k/mo net profit.
//
//   node seed-cleaning-demo.js [slug]      (default slug: test234)
//
// It does NOT create or delete the shop/account — it only repopulates the
// per-shop data collections, so it's safe to re-run and won't disturb login.

const { master, getShopDb, shopHelpers, today } = require('./server/db');

const SLUG = process.argv[2] || 'test234';
const TARGET_MONTHLY = 15000;          // ~$15k/mo completed revenue

// ── Locate the tenant (no create/delete) ────────────────────────────────────
const shop = master.get('shops').find({ slug: SLUG }).value();
if (!shop) { console.error(`✗ No shop with slug "${SLUG}". Aborting (not creating one).`); process.exit(1); }
const db = getShopDb(shop.id);
const h  = shopHelpers(db);

// ── Date helpers ────────────────────────────────────────────────────────────
const TODAY = today();                              // 'YYYY-MM-DD'
const noon  = (s) => new Date(s + 'T12:00:00');
const fmt   = (d) => d.toISOString().slice(0, 10);
const ym    = (s) => s.slice(0, 7);
const addDays = (s, n) => { const d = noon(s); d.setDate(d.getDate() + n); return fmt(d); };
const isSunday = (s) => noon(s).getDay() === 0;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Window = first day of the month two months ago → today.
const startD = noon(TODAY); startD.setDate(1); startD.setMonth(startD.getMonth() - 2);
const WINDOW_START = fmt(startD);
const MONTHS = (() => { const out = []; let d = noon(WINDOW_START); const end = noon(TODAY);
  while (d <= end) { out.push(d.toISOString().slice(0, 7)); d.setMonth(d.getMonth() + 1); } return out; })();

const TIMES = ['8:00 AM', '9:00 AM', '10:30 AM', '12:00 PM', '1:30 PM', '3:00 PM'];

// ── Staff (cleaners) + the single crew ──────────────────────────────────────
const barbers = [
  { id: 'b1', name: 'Maria Lopez',   chair: 1, phone: '(720) 555-0111', bio: 'Lead cleaner', color: '#16a34a', active: true, joinedAt: WINDOW_START,
    schedule: { workDays: [1,2,3,4,5,6], startTime: '8:00 AM', endTime: '5:00 PM', slotMinutes: 30 } },
  { id: 'b2', name: 'Diego Ramirez', chair: 2, phone: '(720) 555-0112', bio: 'Cleaner',      color: '#2563eb', active: true, joinedAt: WINDOW_START,
    schedule: { workDays: [1,2,3,4,5,6], startTime: '8:00 AM', endTime: '5:00 PM', slotMinutes: 30 } },
];
const crews = [
  { id: 'crew1', name: 'Crew A', memberIds: ['b1', 'b2'], color: '#16a34a', active: true, createdAt: WINDOW_START + 'T08:00:00Z' },
];

// ── Service menu ────────────────────────────────────────────────────────────
const services = [
  { id: 's1', name: 'Standard Clean',          category: 'standard',   price: 150, duration: 120 },
  { id: 's2', name: 'Deep Clean',              category: 'deep',       price: 275, duration: 240 },
  { id: 's3', name: 'Move-Out Clean',          category: 'move',       price: 350, duration: 300 },
  { id: 's4', name: 'Office / Commercial',     category: 'commercial', price: 325, duration: 150 },
  { id: 's5', name: 'Post-Construction Clean', category: 'other',      price: 550, duration: 360 },
  { id: 's6', name: 'Recurring Maintenance',   category: 'recurring',  price: 140, duration: 120 },
];
const svc = (id) => services.find(s => s.id === id);

// ── Customers (5 recurring + occasional/one-off) + a property each ───────────
const recurringCustomers = [
  { id: 'c1', name: 'The Hendersons',      phone: '(720) 555-0101', addr: '482 Maple Ave, Denver, CO 80218',     beds: '4', baths: '3',   pet: 'Friendly golden retriever',  access: 'Gate code 4821; key in lockbox by side door' },
  { id: 'c2', name: 'Maple Street Office', phone: '(720) 555-0102', addr: '1200 Maple St, Suite 210, Denver, CO', beds: '',  baths: '2',   pet: '',                            access: 'Front desk has a badge; clean after 6pm', company: 'Maple Street Office LLC' },
  { id: 'c3', name: 'Rivera Home',         phone: '(720) 555-0103', addr: '77 Birchwood Ln, Aurora, CO 80012',    beds: '3', baths: '2',   pet: 'Cat (indoor)',                access: 'Garage code 0099' },
  { id: 'c4', name: 'Sunrise Dental',      phone: '(720) 555-0104', addr: '910 Sunrise Blvd, Denver, CO 80205',   beds: '',  baths: '3',   pet: '',                            access: 'Alarm: disarm 5-5-2-7 at keypad; re-arm on exit', company: 'Sunrise Dental PC' },
  { id: 'c5', name: 'The Carters',         phone: '(720) 555-0105', addr: '15 Oakridge Ct, Littleton, CO 80120',  beds: '5', baths: '4',   pet: '',                            access: 'Key under the back planter' },
];
const oneOffCustomers = [
  { id: 'c6',  name: 'Jessica Tran',     phone: '(720) 555-0106', addr: '330 Elm St, Apt 4B, Denver, CO 80203',  beds: '2', baths: '1' },
  { id: 'c7',  name: 'Mark Sullivan',    phone: '(720) 555-0107', addr: '58 Pinecrest Dr, Denver, CO 80224',     beds: '3', baths: '2', pet: 'Two dogs' },
  { id: 'c8',  name: 'Priya Patel',      phone: '(720) 555-0108', addr: '204 Willow Way, Aurora, CO 80013',      beds: '4', baths: '3' },
  { id: 'c9',  name: 'Greenfield Realty', phone:'(720) 555-0109', addr: '12 Cedar Park Rd, Denver, CO 80211',    beds: '3', baths: '2', company: 'Greenfield Realty', access: 'Turnover cleans — lockbox code texted per unit' },
  { id: 'c10', name: 'Tom & Linda Becker', phone:'(720) 555-0110', addr: '661 Sycamore St, Denver, CO 80210',    beds: '4', baths: '2' },
  { id: 'c11', name: 'Aisha Mohammed',   phone: '(720) 555-0113', addr: '89 Aspen Grove, Lakewood, CO 80226',    beds: '2', baths: '2' },
  { id: 'c12', name: 'Brandon Lee',      phone: '(720) 555-0114', addr: '417 Magnolia Ave, Denver, CO 80222',    beds: '3', baths: '2' },
  { id: 'c13', name: 'Nguyen Family',    phone: '(720) 555-0115', addr: '23 Redwood Ct, Centennial, CO 80112',   beds: '5', baths: '4', pet: 'Small dog' },
];
const allCustomers = [...recurringCustomers, ...oneOffCustomers];

// Build customer + property records.
const customers = allCustomers.map(c => ({
  id: c.id, name: c.name, phone: c.phone, email: '',
  source: 'crm', notes: '', loyaltyPoints: 0, loyaltyVisits: 0, noShows: 0,
  preferredBarberId: null, isFleet: false, companyName: c.company || '', vehicles: [],
  createdAt: WINDOW_START + 'T09:00:00Z',
}));
const properties = allCustomers.map((c, i) => ({
  id: 'prop' + (i + 1), customerId: c.id,
  label: c.company ? 'Main location' : 'Home',
  address: c.addr, bedrooms: c.beds || '', bathrooms: c.baths || '', squareFootage: '',
  gateCode: '', alarmInstructions: '', petInfo: c.pet || '', accessNotes: c.access || '',
  createdAt: WINDOW_START + 'T09:05:00Z',
}));
const propOf = (cid) => properties.find(p => p.customerId === cid);

// ── Recurring contracts (the "5 recurring cleanings") ───────────────────────
//   cadence drives both backfilled history and the dashboard "Recurring Revenue".
const contracts = [
  { id: 'rec1', customerId: 'c1', serviceId: 's1', price: 185, cadence: 'weekly',   dow: 1, time: '8:00 AM'  },  // Hendersons – Mondays
  { id: 'rec2', customerId: 'c2', serviceId: 's4', price: 475, cadence: 'weekly',   dow: 5, time: '6:30 PM'  },  // Maple St Office – Fridays
  { id: 'rec3', customerId: 'c3', serviceId: 's1', price: 210, cadence: 'biweekly', dow: 3, time: '9:00 AM'  },  // Rivera – every other Wed
  { id: 'rec4', customerId: 'c4', serviceId: 's4', price: 325, cadence: 'weekly',   dow: 2, time: '6:00 PM'  },  // Sunrise Dental – Tuesdays
  { id: 'rec5', customerId: 'c5', serviceId: 's2', price: 300, cadence: 'biweekly', dow: 4, time: '10:30 AM' },  // Carters – every other Thu
];
const stepDays = (c) => c.cadence === 'weekly' ? 7 : c.cadence === 'biweekly' ? 14 : 7;

// ── Job (appointment) builder ───────────────────────────────────────────────
const appts = [];
let seq = 0;
const monthTotals = {};
function addJob({ customerId, serviceId, price, date, time, status, source, recurringServiceId }) {
  const cust = customers.find(c => c.id === customerId);
  const s = svc(serviceId);
  const prop = propOf(customerId);
  const p = price != null ? price : s.price;
  appts.push({
    id: 'a' + (++seq), customerId, customerName: cust.name, customerPhone: cust.phone,
    serviceId, service: s.name, price: p, duration: s.duration,
    crewId: 'crew1', propertyId: prop ? prop.id : null,
    date, time, status, source: source || 'crm',
    customFields: { serviceAddress: prop ? prop.address : '', bedrooms: prop ? prop.bedrooms : '', bathrooms: prop ? prop.bathrooms : '' },
    ...(recurringServiceId ? { recurringServiceId } : {}),
    createdAt: noon(date).toISOString(),
  });
  if (status === 'done') monthTotals[ym(date)] = (monthTotals[ym(date)] || 0) + p;
  return appts[appts.length - 1];
}

// 1) Backfill recurring history (done jobs) + set each contract's nextRunDate.
contracts.forEach(c => {
  // First occurrence: first matching weekday on/after window start.
  let d = WINDOW_START;
  while (noon(d).getDay() !== c.dow) d = addDays(d, 1);
  const step = stepDays(c);
  while (d <= TODAY) {
    if (d < TODAY && !isSunday(d)) addJob({ customerId: c.customerId, serviceId: c.serviceId, price: c.price, date: d, time: c.time, status: 'done', source: 'recurring', recurringServiceId: c.id });
    d = addDays(d, step);
  }
  c.nextRunDate = d;  // first occurrence strictly after today
});

// 2) Today's board — mixed statuses so utilization + jobs-today populate.
addJob({ customerId: 'c1', serviceId: 's1', price: 185, date: TODAY, time: '8:00 AM',  status: 'done',        source: 'recurring', recurringServiceId: 'rec1' });
addJob({ customerId: 'c4', serviceId: 's4', price: 325, date: TODAY, time: '10:00 AM', status: 'in-progress' });
addJob({ customerId: 'c7', serviceId: 's2', price: 275, date: TODAY, time: '12:30 PM', status: 'en-route' });
addJob({ customerId: 'c5', serviceId: 's2', price: 300, date: TODAY, time: '2:30 PM',  status: 'confirmed' });

// 3) Fill each month with one-off completed jobs up to the monthly target.
const fillPool = [svc('s2'), svc('s3'), svc('s4'), svc('s5'), svc('s1')];  // deep, move-out, office, post-const, standard
function workdaysOfMonth(mk) {
  const out = []; let d = mk + '-01';
  const lastDay = (mk === ym(TODAY)) ? TODAY : fmt(new Date(noon(d).getFullYear(), noon(d).getMonth() + 1, 0));
  while (d <= lastDay) { if (!isSunday(d)) out.push(d); d = addDays(d, 1); }
  return out;
}
MONTHS.forEach(mk => {
  const days = workdaysOfMonth(mk);
  if (!days.length) return;
  let guard = 0;
  while ((monthTotals[mk] || 0) < TARGET_MONTHLY - 140 && guard++ < 200) {
    const remaining = TARGET_MONTHLY - (monthTotals[mk] || 0);
    const affordable = fillPool.filter(s => s.price <= remaining);
    if (!affordable.length) break;
    const s = pick(affordable);
    addJob({ customerId: pick(oneOffCustomers).id, serviceId: s.id, price: s.price, date: pick(days), time: pick(TIMES), status: 'done' });
  }
});

// 4) Upcoming scheduled jobs (next ~10 days) from recurring contracts + a couple bookings.
contracts.forEach(c => {
  let d = c.nextRunDate, n = 0;
  while (d <= addDays(TODAY, 10) && n < 2) { if (!isSunday(d)) { addJob({ customerId: c.customerId, serviceId: c.serviceId, price: c.price, date: d, time: c.time, status: 'confirmed', source: 'recurring', recurringServiceId: c.id }); n++; } d = addDays(d, stepDays(c)); }
});
addJob({ customerId: 'c8',  serviceId: 's3', price: 350, date: addDays(TODAY, 2), time: '9:00 AM',  status: 'confirmed' });
addJob({ customerId: 'c9',  serviceId: 's3', price: 350, date: addDays(TODAY, 4), time: '11:00 AM', status: 'confirmed' });
addJob({ customerId: 'c10', serviceId: 's2', price: 275, date: addDays(TODAY, 6), time: '1:00 PM',  status: 'confirmed' });

// ── Recurring service rows (what the Recurring tab + dashboard read) ─────────
const recurringServices = contracts.map(c => ({
  id: c.id, customerId: c.customerId, propertyId: (propOf(c.customerId) || {}).id || null,
  serviceId: c.serviceId, crewId: 'crew1', price: c.price,
  cadence: c.cadence, nextRunDate: c.nextRunDate, time: c.time, active: true,
  createdAt: WINDOW_START + 'T10:00:00Z',
}));

// ── Operating expenses (recurring monthly; net ≈ $15k − $7.2k ≈ $7.8k/mo) ────
const expenses = [
  { id: 'exp1', date: WINDOW_START, category: 'Payroll',   recurring: 'monthly', amount: 5400, description: 'Crew wages',                    createdAt: WINDOW_START + 'T09:00:00Z' },
  { id: 'exp2', date: WINDOW_START, category: 'Supplies',  recurring: 'monthly', amount: 600,  description: 'Cleaning products & consumables', createdAt: WINDOW_START + 'T09:00:00Z' },
  { id: 'exp3', date: WINDOW_START, category: 'Fuel',      recurring: 'monthly', amount: 450,  description: 'Vehicle fuel & mileage',        createdAt: WINDOW_START + 'T09:00:00Z' },
  { id: 'exp4', date: WINDOW_START, category: 'Insurance', recurring: 'monthly', amount: 300,  description: 'Liability + bonding',           createdAt: WINDOW_START + 'T09:00:00Z' },
  { id: 'exp5', date: WINDOW_START, category: 'Software',  recurring: 'monthly', amount: 150,  description: 'ShopFlow + accounting',         createdAt: WINDOW_START + 'T09:00:00Z' },
  { id: 'exp6', date: WINDOW_START, category: 'Marketing', recurring: 'monthly', amount: 300,  description: 'Google Local + flyers',         createdAt: WINDOW_START + 'T09:00:00Z' },
  // one realistic one-off in the middle month (new vacuum)
  { id: 'exp7', date: MONTHS[1] + '-12', category: 'Equipment', recurring: 'none', amount: 780, description: 'Commercial backpack vacuum', createdAt: MONTHS[1] + '-12T09:00:00Z' },
];

// ── Loyalty / lastJob recompute from completed jobs ─────────────────────────
customers.forEach(c => {
  const done = appts.filter(a => a.customerId === c.id && a.status === 'done');
  c.loyaltyVisits = done.length; c.loyaltyPoints = done.length;
  const last = done.map(a => a.date).sort().pop();
  if (last) c.lastJobDate = last;
});

// ── Write everything (collections only; shop/account untouched) ─────────────
db.set('barbers', barbers).write();
db.set('services', services).write();
db.set('customers', customers).write();
db.set('properties', properties).write();
db.set('crews', crews).write();
db.set('recurringServices', recurringServices).write();
db.set('appointments', appts).write();
db.set('expenses', expenses).write();
db.get('settings').assign({
  tagline: 'Reliable home & office cleaning.',
  phone: '(720) 555-0142',
  address: 'Denver, CO',
  bookingMessage: 'Request a cleaning below — we’ll confirm your time and crew.',
}).write();

// ── Summary ─────────────────────────────────────────────────────────────────
const doneAppts = appts.filter(a => a.status === 'done');
const opExMonthly = expenses.filter(e => e.recurring === 'monthly').reduce((s, e) => s + e.amount, 0);
console.log(`\n✓ Seeded cleaning demo into "${shop.shopName}" (slug ${SLUG}, id ${shop.id})`);
console.log(`  Window: ${MONTHS.join(', ')}  (today ${TODAY})`);
console.log(`  ${customers.length} customers · ${properties.length} properties · ${crews.length} crew · ${barbers.length} cleaners · ${recurringServices.length} recurring contracts`);
console.log(`  ${appts.length} jobs total (${doneAppts.length} completed)`);
console.log('  Completed revenue by month:');
MONTHS.forEach(mk => console.log(`    ${mk}: $${(monthTotals[mk] || 0).toLocaleString()}   net ≈ $${((monthTotals[mk] || 0) - opExMonthly).toLocaleString()}`));
const recurMrr = Math.round(recurringServices.reduce((s, r) => { const pm = r.cadence === 'weekly' ? 52/12 : r.cadence === 'biweekly' ? 26/12 : r.cadence === 'monthly' ? 1 : 52/12; return s + r.price * pm; }, 0));
console.log(`  Recurring revenue (contracts): ~$${recurMrr.toLocaleString()}/mo · monthly opEx $${opExMonthly.toLocaleString()}`);
console.log('');

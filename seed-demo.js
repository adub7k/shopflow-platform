/**
 * ShopFlow Demo Seed
 * Fills the test shop with realistic clients, appointments (30 days back / 7 days forward),
 * barbers, and revenue data for demo purposes.
 *
 * Run: node seed-demo.js
 */

const fs   = require('fs');
const path = require('path');
const low  = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ── Config ────────────────────────────────────────────────────────────────────
const SHOP_ID   = '63c73352-6448-45d3-b90d-9f746ea5cec0';
const ROOT      = path.join(__dirname, 'data');
const SHOPS_DIR = path.join(ROOT, 'shops');
const SHOP_DIR  = path.join(SHOPS_DIR, SHOP_ID);

// ── Master DB ─────────────────────────────────────────────────────────────────
const master = low(new FileSync(path.join(ROOT, 'master.json')));
master.defaults({ shops: [], accounts: [], usedSessions: [] }).write();

// Clear and re-seed master
master.set('shops', []).write();
master.set('accounts', []).write();

const passwordHash = bcrypt.hashSync('demo1234', 10);

master.get('shops').push({
  id:        SHOP_ID,
  shopName:  "King's Cuts",
  slug:      'kings-cuts',
  email:     'demo@shopflow.com',
  phone:     '(505) 555-0192',
  plan:      'pro',
  active:    true,
  createdAt: new Date(Date.now() - 60*24*3600000).toISOString(),
}).write();

master.get('accounts').push({
  id:        uuidv4(),
  shopId:    SHOP_ID,
  email:     'demo@shopflow.com',
  passwordHash,
  plan:      'pro',
  createdAt: new Date(Date.now() - 60*24*3600000).toISOString(),
}).write();

console.log('✅ Master DB seeded — login: demo@shopflow.com / demo1234');

// ── Shop DB ───────────────────────────────────────────────────────────────────
if (!fs.existsSync(SHOP_DIR)) fs.mkdirSync(SHOP_DIR, { recursive: true });
const db = low(new FileSync(path.join(SHOP_DIR, 'shopflow.json')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function dateStr(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().split('T')[0];
}
function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
const uid = (p='x') => p + Date.now().toString(36) + Math.random().toString(36).slice(2,6);

// ── Static data ───────────────────────────────────────────────────────────────
const BARBERS = [
  { id: 'b1', name: 'Marcus', chair: 1, phone: '(505) 555-0201', bio: 'Master barber, 10+ years. Specializes in fades and designs.', color: '#16a34a', active: true, joinedAt: dateStr(-180), schedule: { workDays:[1,2,3,4,5,6], startTime:'9:00 AM', endTime:'6:00 PM', slotMinutes:30 } },
  { id: 'b2', name: 'Dre',    chair: 2, phone: '(505) 555-0202', bio: 'Classic cuts and beard work. Known for clean lineups.', color: '#2563eb', active: true, joinedAt: dateStr(-90),  schedule: { workDays:[2,3,4,5,6],   startTime:'10:00 AM', endTime:'7:00 PM', slotMinutes:30 } },
  { id: 'b3', name: 'Tony',   chair: 3, phone: '(505) 555-0203', bio: 'Fresh off the chair every time. Kids cuts specialist.', color: '#d97706', active: true, joinedAt: dateStr(-45),  schedule: { workDays:[1,3,4,5,6],   startTime:'9:00 AM',  endTime:'5:00 PM', slotMinutes:30 } },
];

const SERVICES = [
  { id: 's1', name: 'Haircut',         category: 'cut',   price: 35, duration: 45 },
  { id: 's2', name: 'Skin Fade',       category: 'cut',   price: 40, duration: 45 },
  { id: 's3', name: 'Beard Lineup',    category: 'beard', price: 15, duration: 20 },
  { id: 's4', name: 'Kids Cut',        category: 'cut',   price: 25, duration: 30 },
  { id: 's5', name: 'Cut + Beard',     category: 'combo', price: 50, duration: 60 },
  { id: 's6', name: 'Shape Up',        category: 'cut',   price: 20, duration: 20 },
];

// ── Clients ───────────────────────────────────────────────────────────────────
const CLIENT_DATA = [
  { name: 'Jordan Rivera',   phone: '(505) 555-1001', email: 'jordan.r@email.com',  notes: 'Prefers Marcus. Always asks for skin fade.', loyalty: 9,  noShows: 0 },
  { name: 'Marcus Webb',     phone: '(505) 555-1002', email: 'mwebb@gmail.com',      notes: 'Bi-weekly regular. Good tipper.', loyalty: 7,  noShows: 0 },
  { name: 'DeShawn Carter',  phone: '(505) 555-1003', email: '',                     notes: 'Taper fade, leave length on top.', loyalty: 5,  noShows: 1 },
  { name: 'Tyler Brooks',    phone: '(505) 555-1004', email: 'tbrooks@outlook.com',  notes: 'Comes in every 3 weeks.', loyalty: 4,  noShows: 0 },
  { name: 'Isaiah Flores',   phone: '(505) 555-1005', email: '',                     notes: 'Kids cut — very particular dad.', loyalty: 6,  noShows: 0 },
  { name: 'Cameron Nash',    phone: '(505) 555-1006', email: 'cnash@email.com',      notes: 'Beard only. Every 2 weeks.', loyalty: 3,  noShows: 0 },
  { name: 'Elijah Monroe',   phone: '(505) 555-1007', email: '',                     notes: 'Low fade, Edgar top.', loyalty: 8,  noShows: 0 },
  { name: 'Aiden Torres',    phone: '(505) 555-1008', email: 'aiden.t@gmail.com',    notes: 'Always brings his son too.', loyalty: 2,  noShows: 1 },
  { name: 'Noah Castillo',   phone: '(505) 555-1009', email: '',                     notes: 'Classic cut. Hates clippers past a 2.', loyalty: 5,  noShows: 0 },
  { name: 'Liam Ortega',     phone: '(505) 555-1010', email: 'liamo@email.com',      notes: 'Monthly visit. Curly top, tight sides.', loyalty: 3,  noShows: 0 },
  { name: 'Xavier Price',    phone: '(505) 555-1011', email: '',                     notes: 'High top fade. Comes in every 10 days.', loyalty: 9,  noShows: 0 },
  { name: 'Jaylen Scott',    phone: '(505) 555-1012', email: 'jscott@gmail.com',     notes: 'Waves — 360 brushwork requested.', loyalty: 6,  noShows: 2 },
  { name: 'Malik Thompson',  phone: '(505) 555-1013', email: '',                     notes: 'Hot towel shave every time.', loyalty: 4,  noShows: 0 },
  { name: 'Caleb Washington',phone: '(505) 555-1014', email: 'cwash@email.com',      notes: 'Cut + beard combo always.', loyalty: 7,  noShows: 0 },
  { name: 'Ethan Powell',    phone: '(505) 555-1015', email: '',                     notes: 'New client — referred by Jordan.', loyalty: 2,  noShows: 0 },
  { name: 'Zion Hughes',     phone: '(505) 555-1016', email: 'zhughes@gmail.com',    notes: 'Taper, line it up. Shape up every visit.', loyalty: 5,  noShows: 0 },
  { name: 'Andre Mitchell',  phone: '(505) 555-1017', email: '',                     notes: 'Prefers Dre. They go way back.', loyalty: 8,  noShows: 0 },
  { name: 'Dominic Reed',    phone: '(505) 555-1018', email: 'dreed@outlook.com',    notes: 'Kid — comes with dad every month.', loyalty: 3,  noShows: 0 },
  { name: 'Chris Lawson',    phone: '(505) 555-1019', email: '',                     notes: 'Shape up only. Quick in-out.', loyalty: 1,  noShows: 0 },
  { name: 'Kevin James',     phone: '(505) 555-1020', email: 'kj@email.com',         notes: 'Wants a skin fade every time. Comes every 2 weeks.', loyalty: 10, noShows: 0 },
];

const customers = CLIENT_DATA.map((c, i) => ({
  id:        'c' + (i+1).toString().padStart(3,'0'),
  name:      c.name,
  phone:     c.phone,
  email:     c.email,
  notes:     c.notes,
  loyaltyVisits:    c.loyalty,
  loyaltyRewardedAt: c.loyalty >= 10 ? dateStr(-15) : null,
  noShows:   c.noShows,
  createdAt: dateStr(-randInt(30, 120)),
}));

// ── Appointments ──────────────────────────────────────────────────────────────
const TIMES = ['9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM','12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM','3:30 PM','4:00 PM','4:30 PM','5:00 PM'];

const CUT_NOTES = [
  'Clean skin fade, took it down to a 0 on the sides. Left about 2 inches on top. Client was happy.',
  'Low taper, disconnected — asked for more length this time. Shape up included.',
  'Skin fade with a hard part on the left. Lined up the beard tight.',
  'Kids cut — scissor on top, short taper. Mom was happy, kid sat still.',
  'Waves pattern — went with 1.5 on sides, 3 on top. Brushwork done post-cut.',
  'Cut and full beard lineup. Trimmed to about a half inch. Clean finish.',
  'High top fade — 0 to 1 skin transition, left plenty on top for the style.',
  'Shape up only — hairline and sideburns. Quick 15-minute visit.',
  'Classic taper, scissor finish on top. Client requested no clipper-over-comb.',
  'Mid fade, curly top left natural. Used curl cream after to set the style.',
  'Beard lineup only — defined the cheek line higher than usual per client request.',
  'First visit — did a consultation, went with a medium fade. Will do tighter next time.',
];

const appointments = [];

// Past appointments: 30 days back
for (let day = -30; day <= -1; day++) {
  // Skip some days (shop closed some days, or just slower)
  if (day % 7 === 0 && Math.random() < 0.3) continue; // some Sundays closed

  const apptCount = randInt(4, 9); // 4-9 appointments per day
  const usedTimes = new Set();

  for (let a = 0; a < apptCount; a++) {
    let time;
    let attempts = 0;
    do { time = randFrom(TIMES); attempts++; } while (usedTimes.has(time) && attempts < 20);
    usedTimes.add(time);

    const customer  = randFrom(customers);
    const barber    = randFrom(BARBERS);
    const service   = randFrom(SERVICES);
    const isNoShow  = Math.random() < 0.05;
    const tip       = isNoShow ? 0 : [0,0,0,5,5,10,10,10,15,20][randInt(0,9)];

    appointments.push({
      id:         uid('a'),
      customerId: customer.id,
      barberId:   barber.id,
      serviceId:  service.id,
      date:       dateStr(day),
      time,
      duration:   service.duration,
      price:      service.price,
      tip:        isNoShow ? 0 : tip,
      status:     isNoShow ? 'noshow' : 'done',
      cutNotes:   (!isNoShow && Math.random() < 0.7) ? randFrom(CUT_NOTES) : '',
      bookedAt:   new Date(Date.now() + day*24*3600000 - 2*24*3600000).toISOString(),
      source:     Math.random() < 0.3 ? 'online' : 'walk-in',
    });
  }
}

// Future appointments: today + 7 days forward
const UPCOMING_TIMES = ['9:00 AM','10:00 AM','10:30 AM','11:00 AM','1:00 PM','2:00 PM','3:00 PM','3:30 PM','4:00 PM'];
for (let day = 0; day <= 7; day++) {
  if (day === 0) continue; // skip today for simplicity (already building past)
  const apptCount = randInt(3, 7);
  const usedTimes = new Set();

  for (let a = 0; a < apptCount; a++) {
    let time;
    let attempts = 0;
    do { time = randFrom(UPCOMING_TIMES); attempts++; } while (usedTimes.has(time) && attempts < 20);
    usedTimes.add(time);

    const customer = randFrom(customers);
    const barber   = randFrom(BARBERS);
    const service  = randFrom(SERVICES);

    appointments.push({
      id:         uid('a'),
      customerId: customer.id,
      barberId:   barber.id,
      serviceId:  service.id,
      date:       dateStr(day),
      time,
      duration:   service.duration,
      price:      service.price,
      tip:        0,
      status:     'upcoming',
      cutNotes:   '',
      bookedAt:   new Date(Date.now() - randInt(1,5)*24*3600000).toISOString(),
      source:     Math.random() < 0.4 ? 'online' : 'walk-in',
    });
  }
}

// Sort by date + time
appointments.sort((a,b) => {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return a.time.localeCompare(b.time);
});

// ── Write shop DB ─────────────────────────────────────────────────────────────
db.defaults({
  settings: {},
  barbers: [],
  services: [],
  customers: [],
  appointments: [],
  conversations: [],
  blockedDates: [],
}).write();

db.set('settings', {
  shopName:       "King's Cuts",
  tagline:        'Fresh Cuts. Clean Lines. Every Time.',
  phone:          '(505) 555-0192',
  address:        '4820 Central Ave SW, Albuquerque, NM 87105',
  email:          'demo@shopflow.com',
  bookingEnabled: true,
  bookingMessage: 'Book your appointment below! Walk-ins also welcome.',
  accentColor:    '#16a34a',
  pin:            '1234',
  pinEnabled:     false,
  rebookInterval: 21,
  loyalty: { enabled: true, visitsForReward: 10, rewardDescription: 'Free shape up or beard lineup' },
  twilio: { accountSid: '', authToken: '', fromNumber: '' },
  googleReviewLink: 'https://g.page/r/demo-review',
  emailSmtp: { host: '', port: 587, user: '', pass: '' },
  deposit: { enabled: false, amount: 10, message: '' },
  stripe: { connectAccountId: '', onboardingComplete: false },
  remindersSent: [],
  scheduledReminders: [],
  smsTemplates: {},
}).write();

db.set('barbers',      BARBERS).write();
db.set('services',     SERVICES).write();
db.set('customers',    customers).write();
db.set('appointments', appointments).write();
db.set('conversations', []).write();
db.set('blockedDates', []).write();

// ── Summary ───────────────────────────────────────────────────────────────────
const done     = appointments.filter(a => a.status === 'done');
const upcoming = appointments.filter(a => a.status === 'upcoming');
const noshow   = appointments.filter(a => a.status === 'noshow');
const revenue  = done.reduce((s,a) => s + a.price + a.tip, 0);

console.log('');
console.log('✅ Shop DB seeded for King\'s Cuts');
console.log(`   Barbers:      ${BARBERS.length}`);
console.log(`   Services:     ${SERVICES.length}`);
console.log(`   Clients:      ${customers.length}`);
console.log(`   Appointments: ${appointments.length} total`);
console.log(`     ✓ Completed: ${done.length}`);
console.log(`     ↑ Upcoming:  ${upcoming.length}`);
console.log(`     ✗ No-shows:  ${noshow.length}`);
console.log(`   Revenue:      $${revenue.toLocaleString()}`);
console.log('');
console.log('   Login → demo@shopflow.com / demo1234');
console.log('');

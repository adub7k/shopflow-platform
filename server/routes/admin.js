const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { requireAdmin } = require('../middleware');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb } = require('../db');

// ── ADMIN: overview stats ─────────────────────────────────────────────────────
router.get('/api/admin/stats', requireAdmin, (req, res) => {
  const shops = master.get('shops').value() || [];
  const planPrices = { starter: 19.99, pro: 99, shop: 200 };
  const MRR_GOAL = 25000;

  const activeShops  = shops.filter(s => s.active);
  const churned      = shops.filter(s => !s.active);

  // Plan counts (active only for MRR)
  const planCounts = {}, allPlanCounts = {};
  activeShops.forEach(s => { planCounts[s.plan]    = (planCounts[s.plan]    || 0) + 1; });
  shops.forEach(s       => { allPlanCounts[s.plan] = (allPlanCounts[s.plan] || 0) + 1; });

  const mrr = Object.entries(planCounts).reduce((sum, [plan, count]) => sum + (planPrices[plan] || 0) * count, 0);

  // Month-over-month: shops created this month vs last month
  const now = new Date();
  const thisMonthStr = now.toISOString().slice(0, 7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = lastMonth.toISOString().slice(0, 7);

  const newThisMonth  = activeShops.filter(s => (s.createdAt||'').startsWith(thisMonthStr));
  const newLastMonth  = activeShops.filter(s => (s.createdAt||'').startsWith(lastMonthStr));
  const newMrrThisMonth = newThisMonth.reduce((s, shop) => s + (planPrices[shop.plan] || 0), 0);
  const newMrrLastMonth = newLastMonth.reduce((s, shop) => s + (planPrices[shop.plan] || 0), 0);

  // Last month's implied MRR (shops active before this month)
  const lastMonthShops = shops.filter(s => s.active && (s.createdAt||'') < thisMonthStr + '-01');
  const lastMrr = lastMonthShops.reduce((sum, s) => sum + (planPrices[s.plan] || 0), 0);
  const mrrGrowth = lastMrr > 0 ? Math.round(((mrr - lastMrr) / lastMrr) * 100) : null;

  // Churn rate (inactive / total ever)
  const churnRate = shops.length > 0 ? Math.round((churned.length / shops.length) * 100) : 0;

  // How many shops needed to hit $25k MRR
  const mrrToGoal = Math.max(0, MRR_GOAL - mrr);
  const shopsNeeded = {
    starter: Math.ceil(mrrToGoal / planPrices.starter),
    pro:     Math.ceil(mrrToGoal / planPrices.pro),
    shop:    Math.ceil(mrrToGoal / planPrices.shop),
  };

  // Avg revenue per shop
  const avgMrr = activeShops.length ? (mrr / activeShops.length) : 0;

  // LTV estimate (avg MRR / monthly churn rate, assuming avg 12mo if no churn)
  const monthlyChurnRate = shops.length > 0 ? (churned.length / Math.max(shops.length, 1)) / 12 : 0;
  const ltv = monthlyChurnRate > 0 ? Math.round(avgMrr / monthlyChurnRate) : avgMrr * 24;

  const oneDayAgo  = new Date(Date.now() - 24 * 3600000).toISOString();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();

  res.json({
    totalShops: shops.length,
    activeShops: activeShops.length,
    churnedShops: churned.length,
    churnRate,
    activeToday: activeShops.filter(s => s.lastActivity && s.lastActivity > oneDayAgo).length,
    activeWeek:  activeShops.filter(s => s.lastActivity && s.lastActivity > oneWeekAgo).length,
    mrr, arr: mrr * 12, avgMrr, ltv,
    mrrGrowth,
    newMrrThisMonth,
    newMrrLastMonth,
    newShopsThisMonth: newThisMonth.length,
    mrrGoal: MRR_GOAL,
    mrrToGoal,
    mrrPct: Math.min(100, Math.round((mrr / MRR_GOAL) * 100)),
    shopsNeeded,
    planBreakdown: planCounts,
    recentShops: [...shops].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8).map(s => ({
      id: s.id, shopName: s.shopName, plan: s.plan, email: s.email, createdAt: s.createdAt, active: s.active,
    })),
  });
});

// ── ADMIN: all shops with per-shop stats ──────────────────────────────────────
router.get('/api/admin/shops', requireAdmin, (req, res) => {
  const shops = master.get('shops').value() || [];
  const result = shops.map(s => {
    let customers = 0, appointments = 0, barbers = 0, services = 0, stripeConnected = false, twilioConfigured = false, bookingEnabled = true;
    try {
      const db = getShopDb(s.id);
      customers    = (db.get('customers').value()    || []).length;
      appointments = (db.get('appointments').value() || []).length;
      barbers      = (db.get('barbers').value()      || []).filter(b => b.active !== false).length;
      services     = (db.get('services').value()     || []).length;
      const settings = db.get('settings').value() || {};
      stripeConnected  = !!(settings.stripe?.connectAccountId && settings.stripe?.onboardingComplete);
      twilioConfigured = !!(twilioClient && shopFromNumber(s.id));
      bookingEnabled   = settings.bookingEnabled !== false;
    } catch(e) {}
    return { id: s.id, shopName: s.shopName, slug: s.slug, email: s.email, phone: s.phone, plan: s.plan, active: s.active, createdAt: s.createdAt, lastActivity: s.lastActivity, customers, appointments, barbers, services, stripeConnected, twilioConfigured, bookingEnabled };
  });
  res.json(result);
});

// ── ADMIN: single shop profile ────────────────────────────────────────────────
router.get('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const db = getShopDb(shop.id);
  const settings    = db.get('settings').value()    || {};
  const barbers     = db.get('barbers').value()      || [];
  const services    = db.get('services').value()     || [];
  const customers   = db.get('customers').value()    || [];
  const appointments = db.get('appointments').value() || [];
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const apptThisMonth = appointments.filter(a => a.date && a.date.startsWith(thisMonth)).length;
  const recentAppts = [...appointments].sort((a, b) => new Date(b.date + 'T' + (b.time || '00:00')) - new Date(a.date + 'T' + (a.time || '00:00'))).slice(0, 10);
  res.json({
    shop, settings: { shopName: settings.shopName, tagline: settings.tagline, phone: settings.phone, address: settings.address, bookingEnabled: settings.bookingEnabled, accentColor: settings.accentColor, googleReviewLink: settings.googleReviewLink, loyalty: settings.loyalty, deposit: settings.deposit, stripeConnected: !!(settings.stripe?.connectAccountId && settings.stripe?.onboardingComplete), twilioConfigured: !!(twilioClient && shopFromNumber(shop.id)) },
    barbers, services,
    stats: { totalCustomers: customers.length, totalAppointments: appointments.length, apptThisMonth, activeBarbers: barbers.filter(b => b.active !== false).length },
    recentAppointments: recentAppts,
  });
});

// ── ADMIN: create shop ────────────────────────────────────────────────────────
router.post('/api/admin/shops/create', requireAdmin, async (req, res) => {
  try {
    const { shopName, email, password, phone, plan } = req.body;
    if (!shopName || !email || !password) return res.status(400).json({ ok: false, error: 'shopName, email, password required' });
    const existing = master.get('accounts').find({ email: email.toLowerCase() }).value();
    if (existing) return res.status(400).json({ ok: false, error: 'Email already exists' });
    const shopId = uuidv4();
    const shopSlug = slug(shopName) || genId('shop');
    const slugExists = master.get('shops').find({ slug: shopSlug }).value();
    const finalSlug = slugExists ? shopSlug + '-' + genId('') : shopSlug;
    const passwordHash = await bcrypt.hash(password, 10);
    const accountId = uuidv4();
    master.get('accounts').push({ id: accountId, shopId, email: email.toLowerCase(), passwordHash, createdAt: new Date().toISOString(), plan: plan || 'pro', active: true }).write();
    master.get('shops').push({ id: shopId, accountId, shopName, slug: finalSlug, email: email.toLowerCase(), phone: phone || '', plan: plan || 'pro', active: true, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() }).write();
    const shopDb = getShopDb(shopId);
    initShopDb(shopDb, { shopName, email, phone });
    res.json({ ok: true, shopId, shopSlug: finalSlug, shopName, crmUrl: '/shop/' + finalSlug, bookUrl: '/book/' + finalSlug });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── ADMIN: update shop (plan, active, name) ───────────────────────────────────
router.patch('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
  const allowed = ['plan', 'active', 'shopName', 'phone', 'email', 'twilioFromNumber', 'features'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  master.get('shops').find({ id: req.params.shopId }).assign(updates).write();
  master.get('accounts').find({ id: shop.accountId }).assign(updates.plan ? { plan: updates.plan } : {}).assign(updates.active !== undefined ? { active: updates.active } : {}).write();
  res.json({ ok: true });
});

// ── ADMIN: seed demo account ──────────────────────────────────────────────────
router.post('/api/admin/seed-demo', requireAdmin, async (req, res) => {
  try {
    const DEMO_EMAIL = 'demo@shopflow.com';
    const DEMO_PASS  = 'demo1234';
    const DEMO_SHOP  = "King's Cuts";

    // Remove existing demo account if present
    const existing = master.get('accounts').find({ email: DEMO_EMAIL }).value();
    if (existing) {
      const oldShopId = existing.shopId;
      master.get('accounts').remove({ email: DEMO_EMAIL }).write();
      master.get('shops').remove({ id: oldShopId }).write();
      try {
        const oldDir = path.join(SHOPS_DIR, oldShopId);
        if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true, force: true });
      } catch(e) {}
    }

    const shopId    = uuidv4();
    const accountId = uuidv4();
    const shopSlug  = 'kings-cuts';
    const passwordHash = await bcrypt.hash(DEMO_PASS, 10);

    master.get('shops').push({ id: shopId, accountId, shopName: DEMO_SHOP, slug: shopSlug, email: DEMO_EMAIL, phone: '(505) 555-0192', plan: 'pro', active: true, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() }).write();
    master.get('accounts').push({ id: accountId, shopId, email: DEMO_EMAIL, passwordHash, plan: 'pro', active: true, createdAt: new Date().toISOString() }).write();

    // Init shop DB
    const shopDb = getShopDb(shopId);
    shopDb.defaults({ settings:{}, barbers:[], services:[], customers:[], appointments:[], conversations:[], blockedDates:[] }).write();

    shopDb.set('settings', { shopName: DEMO_SHOP, tagline: 'Fresh Cuts. Clean Lines. Every Time.', phone: '(505) 555-0192', address: '4820 Central Ave SW, Albuquerque, NM 87105', email: DEMO_EMAIL, bookingEnabled: true, bookingMessage: 'Book your appointment below! Walk-ins also welcome.', accentColor: '#16a34a', pin: '1234', pinEnabled: false, rebookInterval: 21, loyalty: { enabled: true, visitsForReward: 10, rewardDescription: 'Free shape up or beard lineup' }, twilio: {}, googleReviewLink: '', emailSmtp: { host:'', port:587, user:'', pass:'' }, deposit: { enabled: false, amount: 10, message: '' }, stripe: { connectAccountId:'', onboardingComplete: false }, remindersSent: [], scheduledReminders: [], smsTemplates: {} }).write();

    const BARBERS = [
      { id:'b1', name:'Marcus', chair:1, phone:'(505) 555-0201', bio:'Master barber, 10+ years.', color:'#16a34a', active:true, joinedAt: daysAgo(180), schedule:{ workDays:[1,2,3,4,5,6], startTime:'9:00 AM',  endTime:'6:00 PM', slotMinutes:30 } },
      { id:'b2', name:'Dre',    chair:2, phone:'(505) 555-0202', bio:'Classic cuts and beard work.', color:'#2563eb', active:true, joinedAt: daysAgo(90),  schedule:{ workDays:[2,3,4,5,6],   startTime:'10:00 AM', endTime:'7:00 PM', slotMinutes:30 } },
      { id:'b3', name:'Tony',   chair:3, phone:'(505) 555-0203', bio:'Kids cuts specialist.', color:'#d97706', active:true, joinedAt: daysAgo(45),  schedule:{ workDays:[1,3,4,5,6],   startTime:'9:00 AM',  endTime:'5:00 PM', slotMinutes:30 } },
    ];
    const SERVICES = [
      { id:'s1', name:'Haircut',      category:'cut',   price:35, duration:45 },
      { id:'s2', name:'Skin Fade',    category:'cut',   price:40, duration:45 },
      { id:'s3', name:'Beard Lineup', category:'beard', price:15, duration:20 },
      { id:'s4', name:'Kids Cut',     category:'cut',   price:25, duration:30 },
      { id:'s5', name:'Cut + Beard',  category:'combo', price:50, duration:60 },
      { id:'s6', name:'Shape Up',     category:'cut',   price:20, duration:20 },
    ];
    const CLIENT_DATA = [
      { name:'Jordan Rivera',    phone:'(505) 555-1001', email:'jordan.r@email.com', notes:'Prefers Marcus. Always asks for skin fade.', loyalty:9,  noShows:0 },
      { name:'Marcus Webb',      phone:'(505) 555-1002', email:'mwebb@gmail.com',    notes:'Bi-weekly regular. Good tipper.',            loyalty:7,  noShows:0 },
      { name:'DeShawn Carter',   phone:'(505) 555-1003', email:'',                   notes:'Taper fade, leave length on top.',           loyalty:5,  noShows:1 },
      { name:'Tyler Brooks',     phone:'(505) 555-1004', email:'',                   notes:'Comes in every 3 weeks.',                   loyalty:4,  noShows:0 },
      { name:'Isaiah Flores',    phone:'(505) 555-1005', email:'',                   notes:'Kids cut — very particular dad.',            loyalty:6,  noShows:0 },
      { name:'Cameron Nash',     phone:'(505) 555-1006', email:'cnash@email.com',    notes:'Beard only. Every 2 weeks.',                loyalty:3,  noShows:0 },
      { name:'Elijah Monroe',    phone:'(505) 555-1007', email:'',                   notes:'Low fade, Edgar top.',                      loyalty:8,  noShows:0 },
      { name:'Aiden Torres',     phone:'(505) 555-1008', email:'',                   notes:'Always brings his son too.',                loyalty:2,  noShows:1 },
      { name:'Noah Castillo',    phone:'(505) 555-1009', email:'',                   notes:"Hates clippers past a 2.",                  loyalty:5,  noShows:0 },
      { name:'Liam Ortega',      phone:'(505) 555-1010', email:'liamo@email.com',    notes:'Curly top, tight sides.',                   loyalty:3,  noShows:0 },
      { name:'Xavier Price',     phone:'(505) 555-1011', email:'',                   notes:'High top fade. Comes in every 10 days.',    loyalty:9,  noShows:0 },
      { name:'Jaylen Scott',     phone:'(505) 555-1012', email:'jscott@gmail.com',   notes:'Waves — 360 brushwork requested.',          loyalty:6,  noShows:2 },
      { name:'Malik Thompson',   phone:'(505) 555-1013', email:'',                   notes:'Hot towel shave every time.',               loyalty:4,  noShows:0 },
      { name:'Caleb Washington', phone:'(505) 555-1014', email:'cwash@email.com',    notes:'Cut + beard combo always.',                 loyalty:7,  noShows:0 },
      { name:'Ethan Powell',     phone:'(505) 555-1015', email:'',                   notes:'New client — referred by Jordan.',          loyalty:2,  noShows:0 },
      { name:'Zion Hughes',      phone:'(505) 555-1016', email:'zhughes@gmail.com',  notes:'Taper, line it up.',                        loyalty:5,  noShows:0 },
      { name:'Andre Mitchell',   phone:'(505) 555-1017', email:'',                   notes:'Prefers Dre. They go way back.',            loyalty:8,  noShows:0 },
      { name:'Dominic Reed',     phone:'(505) 555-1018', email:'dreed@outlook.com',  notes:'Kid — comes with dad every month.',         loyalty:3,  noShows:0 },
      { name:'Chris Lawson',     phone:'(505) 555-1019', email:'',                   notes:'Shape up only. Quick in-out.',              loyalty:1,  noShows:0 },
      { name:'Kevin James',      phone:'(505) 555-1020', email:'kj@email.com',       notes:'Skin fade every 2 weeks.',                  loyalty:10, noShows:0 },
    ];
    const customers = CLIENT_DATA.map((c, i) => ({ id:'c'+(i+1).toString().padStart(3,'0'), name:c.name, phone:c.phone, email:c.email, notes:c.notes, loyaltyVisits:c.loyalty, loyaltyRewardedAt: c.loyalty>=10 ? daysAgo(15) : null, noShows:c.noShows, createdAt: daysAgo(randInt(30,120)) }));

    const TIMES = ['9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM','12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM','3:30 PM','4:00 PM','4:30 PM','5:00 PM'];
    const CUT_NOTES = [
      'Clean skin fade, 0 on sides, ~2 inches on top.',
      'Low taper, disconnected — more length requested this time.',
      'Skin fade with hard part on left. Beard lined up tight.',
      'Kids cut — scissor on top, short taper. Sat still great.',
      'Waves — 1.5 sides, 3 on top. Brushwork done post-cut.',
      'Cut and full beard lineup. Trimmed to ~half inch.',
      'High top fade — 0 to 1 skin transition, length left on top.',
      'Shape up only — hairline and sideburns.',
      'Classic taper, scissor finish on top. No clipper-over-comb.',
      'Mid fade, curly top left natural. Curl cream applied.',
      'Beard lineup only — cheek line set higher per client request.',
      'First visit consultation — medium fade. Tighter next time.',
    ];

    const appointments = [];
    for (let day = -30; day <= 7; day++) {
      const isPast = day < 0;
      const count = isPast ? randInt(4,9) : randInt(2,6);
      const used = new Set();
      for (let a = 0; a < count; a++) {
        let time, tries=0;
        do { time = TIMES[randInt(0,TIMES.length-1)]; tries++; } while(used.has(time)&&tries<20);
        used.add(time);
        const cust = customers[randInt(0,customers.length-1)];
        const barb = BARBERS[randInt(0,BARBERS.length-1)];
        const svc  = SERVICES[randInt(0,SERVICES.length-1)];
        const noshow = isPast && Math.random()<0.05;
        const tip = noshow ? 0 : [0,0,0,5,5,10,10,10,15,20][randInt(0,9)];
        appointments.push({ id:'a'+Math.random().toString(36).slice(2,10), customerId:cust.id, customerName:cust.name, customerPhone:cust.phone, barberId:barb.id, barberName:barb.name, serviceId:svc.id, service:svc.name, date: daysAgo(-day), time, duration:svc.duration, price:svc.price, tip, status: isPast?(noshow?'no-show':'done'):'confirmed', cutNotes: (!noshow&&isPast&&Math.random()<0.7)?CUT_NOTES[randInt(0,CUT_NOTES.length-1)]:'', bookedAt: new Date(Date.now()+day*864e5-2*864e5).toISOString(), source: Math.random()<0.3?'online':'walk-in' });
      }
    }
    appointments.sort((a,b)=>a.date!==b.date?a.date.localeCompare(b.date):a.time.localeCompare(b.time));

    shopDb.set('barbers', BARBERS).write();
    shopDb.set('services', SERVICES).write();
    shopDb.set('customers', customers).write();
    shopDb.set('appointments', appointments).write();

    // Seed realistic SMS conversations
    const msgId = () => 'msg' + Math.random().toString(36).slice(2,10);
    const daysAgoISO = (n, h=12, m=0) => { const d=new Date(); d.setDate(d.getDate()-n); d.setHours(h,m,0,0); return d.toISOString(); };
    const conversations = [
      // Jordan Rivera — recent booking thread
      { id:msgId(), customerId:'c001', customerName:'Jordan Rivera', type:'sms', direction:'outbound', body:"Hi Jordan! Your appointment at King's Cuts is confirmed for tomorrow at 10:00 AM with Marcus. See you then! ✂️", sentAt:daysAgoISO(2,9,1), read:true },
      { id:msgId(), customerId:'c001', customerName:'Jordan Rivera', type:'sms', direction:'inbound',  body:'Perfect, thanks! Can I add a beard lineup too?', sentAt:daysAgoISO(2,9,15), read:true },
      { id:msgId(), customerId:'c001', customerName:'Jordan Rivera', type:'sms', direction:'outbound', body:"Absolutely! We'll take care of you. Marcus is great with beards.", sentAt:daysAgoISO(2,9,22), read:true },
      { id:msgId(), customerId:'c001', customerName:'Jordan Rivera', type:'sms', direction:'inbound',  body:'Bet, see you tomorrow 🤙', sentAt:daysAgoISO(2,9,30), read:true },
      // Marcus Webb — rebook nudge thread
      { id:msgId(), customerId:'c002', customerName:'Marcus Webb', type:'sms', direction:'outbound', body:"Hey Marcus! It's been a few weeks — we'd love to have you back at King's Cuts. Book your next cut anytime 💈", sentAt:daysAgoISO(5,11,0), read:true },
      { id:msgId(), customerId:'c002', customerName:'Marcus Webb', type:'sms', direction:'inbound',  body:'yeah been busy, can I come in Saturday?', sentAt:daysAgoISO(5,11,45), read:true },
      { id:msgId(), customerId:'c002', customerName:'Marcus Webb', type:'sms', direction:'outbound', body:'Saturday works! Book at shopflow.com/book/kings-cuts or just walk in. We open at 9.', sentAt:daysAgoISO(5,12,2), read:true },
      { id:msgId(), customerId:'c002', customerName:'Marcus Webb', type:'sms', direction:'inbound',  body:'cool ill be there around 11', sentAt:daysAgoISO(5,12,10), read:true },
      // Kevin James — loyalty reward notification
      { id:msgId(), customerId:'c020', customerName:'Kevin James', type:'sms', direction:'outbound', body:"Kevin! 🎉 You've hit 10 visits at King's Cuts — your next cut is on us! Come in anytime and show this message.", sentAt:daysAgoISO(3,10,0), read:true },
      { id:msgId(), customerId:'c020', customerName:'Kevin James', type:'sms', direction:'inbound',  body:'No way!! Thanks bro thats crazy', sentAt:daysAgoISO(3,10,18), read:true },
      { id:msgId(), customerId:'c020', customerName:'Kevin James', type:'sms', direction:'inbound',  body:'Coming in Thursday, gonna tell my boys about this place', sentAt:daysAgoISO(3,10,19), read:false },
      // Ethan Powell — new client inquiry (unread)
      { id:msgId(), customerId:'c015', customerName:'Ethan Powell', type:'sms', direction:'inbound',  body:'Hey I got your number from Jordan, do you guys do walk-ins?', sentAt:daysAgoISO(0,8,42), read:false },
      { id:msgId(), customerId:'c015', customerName:'Ethan Powell', type:'sms', direction:'inbound',  body:'Or should I book online?', sentAt:daysAgoISO(0,8,43), read:false },
      // DeShawn Carter — reminder thread
      { id:msgId(), customerId:'c003', customerName:'DeShawn Carter', type:'sms', direction:'outbound', body:"Hi DeShawn! Reminder: your appointment at King's Cuts is tomorrow at 2:00 PM with Dre. See you then! ✂️", sentAt:daysAgoISO(8,9,0), read:true },
      { id:msgId(), customerId:'c003', customerName:'DeShawn Carter', type:'sms', direction:'inbound',  body:'actually can we move it to 3?', sentAt:daysAgoISO(8,9,35), read:true },
      { id:msgId(), customerId:'c003', customerName:'DeShawn Carter', type:'sms', direction:'outbound', body:"3 PM works, I've updated your appointment. See you then!", sentAt:daysAgoISO(8,9,48), read:true },
    ];
    shopDb.set('conversations', conversations).write();

    // Enable all features for demo
    master.get('shops').find({ id: shopId }).assign({ features: { manualSms: true } }).write();

    const done = appointments.filter(a=>a.status==='done');
    res.json({ ok:true, shopId, slug: shopSlug, email: DEMO_EMAIL, password: DEMO_PASS, clients: customers.length, appointments: appointments.length, completed: done.length, revenue: done.reduce((s,a)=>s+a.price+a.tip,0) });
  } catch(e) {
    console.error('Seed demo error:', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// helpers used by seed
function daysAgo(n) { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().split('T')[0]; }
function randInt(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }

// ── ADMIN: platform settings (get) ───────────────────────────────────────────
router.get('/api/admin/platform-settings', requireAdmin, (req, res) => {
  const ps = master.get('platformSettings').value() || {};
  res.json({ requirePayment: ps.requirePayment !== false });
});

// ── ADMIN: platform settings (update) ────────────────────────────────────────
router.patch('/api/admin/platform-settings', requireAdmin, (req, res) => {
  const allowed = ['requirePayment'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  master.get('platformSettings').assign(updates).write();
  res.json({ ok: true });
});

// ── ADMIN: demos ─────────────────────────────────────────────────────────────
router.get('/api/admin/demos', requireAdmin, (req, res) => {
  res.json(master.get('demos').value().sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time)));
});
router.patch('/api/admin/demos/:id', requireAdmin, (req, res) => {
  const demo = master.get('demos').find({ id: req.params.id }).value();
  if (!demo) return res.status(404).json({ ok: false });
  const { status, notes } = req.body;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (notes  !== undefined) updates.notes  = notes;
  master.get('demos').find({ id: req.params.id }).assign(updates).write();
  res.json({ ok: true });
});
router.delete('/api/admin/demos/:id', requireAdmin, (req, res) => {
  master.get('demos').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// ── ADMIN: delete shop ────────────────────────────────────────────────────────
router.delete('/api/admin/shop/:shopId', requireAdmin, (req, res) => {
  const shop = master.get('shops').find({ id: req.params.shopId }).value();
  if (!shop) return res.status(404).json({ ok: false, error: 'Shop not found' });
  try {
    const shopDir = path.join(SHOPS_DIR, req.params.shopId);
    if (fs.existsSync(shopDir)) fs.rmSync(shopDir, { recursive: true, force: true });
  } catch(e) { console.error('Delete shop dir error:', e.message); }
  master.get('shops').remove({ id: req.params.shopId }).write();
  master.get('accounts').remove({ shopId: req.params.shopId }).write();
  res.json({ ok: true });
});
module.exports = router;

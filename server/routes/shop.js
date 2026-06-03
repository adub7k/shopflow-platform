const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb } = require('../db');

// ── PROTECTED: Settings ───────────────────────────────────────────────────────
router.get('/api/shop/settings', requireAuth, shopRoute(async (req, res, db) => {
  res.json(db.get('settings').value() || {});
}));
router.post('/api/shop/settings', requireAuth, shopRoute(async (req, res, db) => {
  db.get('settings').assign(req.body).write();
  // Update shop name in master if changed
  if (req.body.shopName) master.get('shops').find({ id: req.shopId }).assign({ shopName: req.body.shopName }).write();
  res.json({ ok: true });
}));

// ── PROTECTED: Barbers ────────────────────────────────────────────────────────
router.get('/api/shop/barbers', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('barbers').filter(b => b.active !== false));
}));
router.post('/api/shop/barbers', requireAuth, shopRoute(async (req, res, db, h) => {
  const b = req.body; if (!b.id) b.id = genId('b'); h.upsert('barbers', b); res.json({ id: b.id });
}));
router.delete('/api/shop/barbers/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  h.remove('barbers', req.params.id); res.json({ ok: true });
}));
router.post('/api/shop/barbers/:id/schedule', requireAuth, shopRoute(async (req, res, db, h) => {
  const b = h.getById('barbers', req.params.id); if (!b) return res.status(404).json({ error: 'Not found' });
  b.schedule = req.body; h.upsert('barbers', b); res.json({ ok: true });
}));

// ── PROTECTED: Services ───────────────────────────────────────────────────────
router.get('/api/shop/services', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('services').sort((a,b) => a.category.localeCompare(b.category)));
}));
router.post('/api/shop/services', requireAuth, shopRoute(async (req, res, db, h) => {
  const s = req.body; if (!s.id) s.id = genId('s'); h.upsert('services', s); res.json({ id: s.id });
}));
router.delete('/api/shop/services/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  h.remove('services', req.params.id); res.json({ ok: true });
}));

// ── PROTECTED: Customers ──────────────────────────────────────────────────────
router.get('/api/shop/customers', requireAuth, shopRoute(async (req, res, db, h) => {
  const customers = h.getAll('customers');
  const appointments = h.getAll('appointments');
  const visitCount = {}, lastVisit = {};
  appointments.forEach(a => { if (a.status==='done'&&a.customerId) { visitCount[a.customerId]=(visitCount[a.customerId]||0)+1; if(!lastVisit[a.customerId]||a.date>lastVisit[a.customerId])lastVisit[a.customerId]=a.date; } });
  res.json(customers.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(c=>({...c,totalVisits:visitCount[c.id]||0,lastVisit:lastVisit[c.id]||null})));
}));
router.get('/api/shop/customers/search', requireAuth, shopRoute(async (req, res, db, h) => {
  const q = (req.query.q || '').toLowerCase();
  res.json(h.getAll('customers').filter(c => c.name.toLowerCase().includes(q)||(c.phone||'').includes(q)).slice(0,10));
}));
router.get('/api/shop/customers/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  const barbers  = h.getAll('barbers');
  const services = h.getAll('services');
  const rawAppts = h.getAll('appointments').filter(a => a.customerId===c.id).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const appts = rawAppts.map(a => {
    const barber  = barbers.find(b => b.id === a.barberId);
    const service = a.serviceId ? services.find(s => s.id === a.serviceId) : null;
    return { ...a, barberName: a.barberName || barber?.name || null, service: a.service || service?.name || 'Haircut' };
  });
  const done = appts.filter(a => a.status==='done');
  const lastVisitDate = done.length ? done.sort((a,b)=>b.date.localeCompare(a.date))[0].date : null;
  const daysSinceLast = lastVisitDate ? Math.floor((Date.now()-new Date(lastVisitDate+'T12:00:00'))/(1000*60*60*24)) : null;
  const shopSettings = db.get('settings').value()||{};
  const loyalty = shopSettings.loyalty || { visitsForReward:10 };
  const rebookInterval = shopSettings.rebookInterval || 21;
  const loyaltyVisits = c.loyaltyVisits || c.loyaltyPoints || 0;
  res.json({ customer:{...c, lastVisit:lastVisitDate}, appointments:appts, totalVisits:done.length, totalRevenue:done.reduce((s,a)=>s+Number(a.price||0),0), loyaltyPoints:loyaltyVisits, rewardReady:loyaltyVisits>=(loyalty.visitsForReward||10), visitsForReward:loyalty.visitsForReward||10, daysSinceLast, rebookInterval });
}));
router.post('/api/shop/customers', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = req.body; if (!c.id) c.id = genId('c'); h.upsert('customers', c); res.json({ id: c.id });
}));
router.delete('/api/shop/customers/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  h.remove('customers', req.params.id); res.json({ ok: true });
}));
router.post('/api/shop/customers/:id/redeem', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id); if(c){c.loyaltyPoints=0;h.upsert('customers',c);} res.json({ ok: true });
}));

// ── PROTECTED: Appointments ───────────────────────────────────────────────────
router.get('/api/shop/appointments', requireAuth, shopRoute(async (req, res, db, h) => {
  const { date, month } = req.query;
  const barbers  = h.getAll('barbers');
  const customers = h.getAll('customers');
  const services  = h.getAll('services');
  let appts = h.getAll('appointments');
  if (date)  appts = appts.filter(a => a.date===date);
  if (month) appts = appts.filter(a => (a.date||'').startsWith(month));
  res.json(appts.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(a => {
    const barber   = barbers.find(b => b.id === a.barberId);
    const customer = a.customerId ? customers.find(c => c.id === a.customerId) : null;
    const service  = a.serviceId  ? services.find(s => s.id === a.serviceId)   : null;
    return {
      ...a,
      customerName:  a.customerName  || customer?.name  || 'Unknown Client',
      barberName:    a.barberName    || barber?.name     || null,
      barberColor:   barber?.color   || '#ccc',
      service:       a.service       || service?.name    || 'Haircut',
      customerPhone: a.customerPhone || customer?.phone  || '',
    };
  }));
}));
router.post('/api/shop/appointments', requireAuth, shopRoute(async (req, res, db, h) => {
  const a = req.body; if (!a.id) a.id = genId('a');
  // Ensure customer exists
  if (a.customerName) {
    const digits = (a.customerPhone||'').replace(/[^0-9]/g,'');
    let cust = a.customerId ? h.getById('customers',a.customerId) : null;
    if (!cust && digits.length>=10) cust = h.getAll('customers').find(c=>(c.phone||'').replace(/[^0-9]/g,'')===digits);
    if (cust) { a.customerId=cust.id; }
    else { const cid=genId('c'); h.upsert('customers',{id:cid,name:a.customerName,phone:a.customerPhone||'',email:'',source:a.source||'crm',notes:'',loyaltyPoints:0,noShows:0,preferredBarberId:a.barberId||null,createdAt:today()}); a.customerId=cid; }
  }
  h.upsert('appointments', a);
  res.json({ id: a.id });
}));
router.post('/api/shop/appointments/:id/complete', requireAuth, shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.status='done'; a.price=req.body.price||a.price||0; h.upsert('appointments',a);
  if (a.customerId) { const c=h.getById('customers',a.customerId); if(c){c.loyaltyVisits=(c.loyaltyVisits||c.loyaltyPoints||0)+1;c.loyaltyPoints=c.loyaltyVisits;c.lastJobDate=a.date;h.upsert('customers',c);} }
  res.json({ ok: true });
}));
router.post('/api/shop/appointments/:id/noshow', requireAuth, shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.status='no-show'; a.noShowAt=new Date().toISOString(); h.upsert('appointments',a);
  if (a.customerId) { const c=h.getById('customers',a.customerId); if(c){c.noShows=(c.noShows||0)+1;h.upsert('customers',c);} }
  res.json({ ok: true });
}));
router.post('/api/shop/appointments/:id/waive-deposit', requireAuth, shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.depositWaived=true; h.upsert('appointments',a); res.json({ ok: true });
}));
router.delete('/api/shop/appointments/:id', requireAuth, shopRoute(async (req, res, db, h) => {
  h.remove('appointments', req.params.id); res.json({ ok: true });
}));

// ── PROTECTED: Revenue ────────────────────────────────────────────────────────
router.get('/api/shop/revenue', requireAuth, shopRoute(async (req, res, db, h) => {
  const barbers   = h.getAll('barbers');
  const customers = h.getAll('customers');
  const services  = h.getAll('services');

  // Resolve denormalized fields for any appointment
  function resolveAppt(a) {
    const barber   = barbers.find(b => b.id === a.barberId);
    const customer = a.customerId ? customers.find(c => c.id === a.customerId) : null;
    const service  = a.serviceId  ? services.find(s => s.id === a.serviceId)   : null;
    return {
      ...a,
      customerName: a.customerName || customer?.name || 'Unknown Client',
      barberName:   a.barberName   || barber?.name   || 'Unknown',
      barberColor:  barber?.color  || '#ccc',
      service:      a.service      || service?.name  || 'Haircut',
    };
  }

  const done = h.getAll('appointments').filter(a=>a.status==='done').map(resolveAppt);
  const ms = today().slice(0,7)+'-01';
  const thisMonth = done.filter(a=>a.date>=ms);
  const byBarber = {};
  done.forEach(a=>{if(!byBarber[a.barberId])byBarber[a.barberId]={name:a.barberName,color:a.barberColor,revenue:0,count:0};byBarber[a.barberId].revenue+=Number(a.price||0);byBarber[a.barberId].count++;});
  const byMonth = {};
  done.forEach(a=>{const m=(a.date||'').slice(0,7);if(!byMonth[m])byMonth[m]=0;byMonth[m]+=Number(a.price||0);});
  const loyalty = (db.get('settings').value()||{}).loyalty||{enabled:true,visitsForReward:10};
  res.json({
    totalRevenue: done.reduce((s,a)=>s+Number(a.price||0),0),
    monthRevenue: thisMonth.reduce((s,a)=>s+Number(a.price||0),0),
    monthJobs: thisMonth.length,
    avgTicket: thisMonth.length?Math.round(thisMonth.reduce((s,a)=>s+Number(a.price||0),0)/thisMonth.length):0,
    byBarber: Object.values(byBarber).sort((a,b)=>b.revenue-a.revenue),
    byMonth: Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0])).map(([month,revenue])=>({month,revenue})),
    recentDone: [...done].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5),
    loyaltyAlerts: loyalty.enabled?h.getAll('customers').filter(c=>(c.loyaltyVisits||c.loyaltyPoints||0)>=(loyalty.visitsForReward||10)):[],
  });
}));

// ── PROTECTED: Auth ───────────────────────────────────────────────────────────
router.post('/api/shop/auth/verify-pin', requireAuth, shopRoute(async (req, res, db) => {
  const { pin } = req.body;
  const s = db.get('settings').value()||{};
  if (s.pinEnabled===false) return res.json({ ok: true });
  res.json(String(pin)===String(s.pin||'1234') ? { ok:true } : { ok:false, error:'Incorrect PIN' });
}));
router.post('/api/shop/auth/change-pin', requireAuth, shopRoute(async (req, res, db) => {
  const { currentPin, newPin } = req.body;
  const s = db.get('settings').value()||{};
  if (String(currentPin)!==String(s.pin||'1234')) return res.status(401).json({ ok:false, error:'Current PIN incorrect' });
  if (!newPin||String(newPin).length<4) return res.status(400).json({ ok:false, error:'PIN must be 4+ digits' });
  db.get('settings').assign({ pin:String(newPin) }).write();
  res.json({ ok: true });
}));
router.post('/api/shop/auth/reset-pin', async (req, res) => {
  const { ownerKey, newPin, email } = req.body;
  const key = process.env.OWNER_KEY || 'shopflow2026';
  if (String(ownerKey)!==String(key)) return res.status(401).json({ ok:false, error:'Invalid owner key' });
  if (!email) return res.status(400).json({ ok:false, error:'Email required' });
  const account = master.get('accounts').find({ email: email.toLowerCase() }).value();
  if (!account) return res.status(404).json({ ok:false, error:'Account not found' });
  const db = getShopDb(account.shopId);
  db.get('settings').assign({ pin:String(newPin||'1234') }).write();
  res.json({ ok: true });
});

// ── PROTECTED: Conversations ──────────────────────────────────────────────────

// Global inbox — one thread summary per customer, sorted by latest message
router.get('/api/shop/conversations', requireAuth, shopRoute(async (req, res, db, h) => {
  const convos    = h.getAll('conversations');
  const customers = h.getAll('customers');
  const threads   = {};
  convos.forEach(c => {
    const cid = c.customerId || 'unknown';
    if (!threads[cid]) threads[cid] = { customerId:cid, customerName:c.customerName||'Unknown', customerPhone:'', lastMessage:null, unreadCount:0 };
    if (!threads[cid].lastMessage || new Date(c.sentAt) > new Date(threads[cid].lastMessage.sentAt)) threads[cid].lastMessage = c;
    if (c.direction === 'inbound' && !c.read) threads[cid].unreadCount++;
  });
  Object.values(threads).forEach(t => {
    const cust = customers.find(c => c.id === t.customerId);
    if (cust) { t.customerPhone = cust.phone||''; t.customerName = t.customerName||cust.name; }
  });
  res.json(Object.values(threads).sort((a,b) => new Date(b.lastMessage?.sentAt||0) - new Date(a.lastMessage?.sentAt||0)));
}));

// Per-customer thread
router.get('/api/shop/conversations/customer/:cid', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('conversations').filter(c=>c.customerId===req.params.cid).sort((a,b)=>new Date(a.sentAt)-new Date(b.sentAt)));
}));

// Mark all inbound messages from a customer as read
router.post('/api/shop/conversations/read/:customerId', requireAuth, shopRoute(async (req, res, db, h) => {
  h.getAll('conversations')
    .filter(c => c.customerId === req.params.customerId && c.direction === 'inbound' && !c.read)
    .forEach(c => { c.read = true; h.upsert('conversations', c); });
  res.json({ ok: true });
}));

router.post('/api/shop/conversations', requireAuth, shopRoute(async (req, res, db, h) => {
  const c = req.body; if(!c.id)c.id=genId('msg'); h.upsert('conversations',c); res.json({ id:c.id });
}));

// ── PROTECTED: SMS ────────────────────────────────────────────────────────────
router.post('/api/shop/sms/send', requireAuth, shopRoute(async (req, res, db, h) => {
  const { to, body, customerId, customerName } = req.body;
  const fromNum = shopFromNumber(req.shopId);
  if (!twilioClient || !fromNum) return res.json({ ok:false, error:'SMS not available for this shop yet. Contact ShopFlow support.' });
  try {
    await twilioClient.messages.create({ from:fromNum, to:'+1'+to.replace(/\D/g,''), body });
    h.upsert('conversations',{id:genId('msg'),customerId,customerName,type:'sms',direction:'outbound',body,sentAt:new Date().toISOString(),read:true});
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
}));

// ── PROTECTED: Blocked dates ──────────────────────────────────────────────────
router.get('/api/shop/blocked-dates', requireAuth, shopRoute(async (req, res, db, h) => res.json(h.getAll('blockedDates'))));
router.post('/api/shop/blocked-dates', requireAuth, shopRoute(async (req, res, db, h) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ ok:false });
  if (!h.getAll('blockedDates').find(b=>b.date===date)) h.upsert('blockedDates',{id:genId('bd'),date,reason:reason||'',createdAt:new Date().toISOString()});
  res.json({ ok: true });
}));
router.delete('/api/shop/blocked-dates/:date', requireAuth, shopRoute(async (req, res, db) => {
  db.get('blockedDates').remove({ date:req.params.date }).write(); res.json({ ok: true });
}));

// ── PROTECTED: Deposit ────────────────────────────────────────────────────────
router.post('/api/shop/deposit/confirm', requireAuth, shopRoute(async (req, res, db, h) => {
  const { appointmentId, paymentIntentId, amount } = req.body;
  const a = h.getById('appointments', appointmentId); if(!a) return res.status(404).json({ ok:false });
  a.depositPaid=true; a.depositAmount=amount; a.depositPaymentId=paymentIntentId; a.status='confirmed';
  h.upsert('appointments',a); res.json({ ok: true });
}));

// ── PROTECTED: Feature flags for current shop ─────────────────────────────────
router.get('/api/shop/features', requireAuth, (req, res) => {
  const shop = master.get('shops').find({ id: req.shopId }).value();
  const features = (shop && shop.features) || {};
  res.json({ manualSms: features.manualSms !== false }); // default ON
});

module.exports = router;

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware');
const { resolveProfile } = require('../industries');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, buildSms, genId, today, slug, toE164, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb, saveImageDataUrl, deleteUpload } = require('../db');

// ── PROTECTED: Settings ───────────────────────────────────────────────────────
// Readable by any signed-in staff (needed for vocabulary/statuses), but sensitive
// credentials are stripped for non-owner roles, and writes are owner-only.
router.get('/api/shop/settings', requireAuth, shopRoute(async (req, res, db) => {
  const s = JSON.parse(JSON.stringify(db.get('settings').value() || {}));
  // Surface resolved inspo mode + gallery so the settings UI shows the real state.
  if (s.inspoPhoto === undefined) s.inspoPhoto = resolveProfile(db.get('industry').value()).inspoDefault || 'off';
  if (!Array.isArray(s.gallery)) s.gallery = [];
  // Backfill vehicle size classes for shops seeded before per-size pricing existed.
  if (!Array.isArray(s.vehicleSizes)) s.vehicleSizes = resolveProfile(db.get('industry').value()).vehicleSizes || [];
  if (!Array.isArray(s.addons)) s.addons = [];
  if (!Array.isArray(s.membershipPlans)) s.membershipPlans = [];
  const _prof = resolveProfile(db.get('industry').value());
  if (!Array.isArray(s.serviceCategories)) s.serviceCategories = _prof.serviceCategories || ['cut','beard','combo','color','design','other'];
  if (s.staffPicker === undefined) s.staffPicker = _prof.staffPicker !== false;
  if (s.supportsQuotes === undefined) s.supportsQuotes = !!_prof.supportsQuotes;
  // Call tracking: surface the resolved tracking number (read-only) + defaults.
  s.trackingNumber = shopFromNumber(req.shopId) || '';
  if (!s.callTracking) s.callTracking = { enabled: true };
  if ((req.role || 'full') !== 'full') {
    if (s.twilio)    s.twilio    = { ...s.twilio, authToken: '' };
    if (s.emailSmtp) s.emailSmtp = { ...s.emailSmtp, pass: '' };
    delete s.pin;
  }
  res.json(s);
}));
router.post('/api/shop/settings', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  db.get('settings').assign(req.body).write();
  // Update shop name in master if changed
  if (req.body.shopName) master.get('shops').find({ id: req.shopId }).assign({ shopName: req.body.shopName }).write();
  res.json({ ok: true });
}));

// ── PROTECTED: Work gallery (owner only) ──────────────────────────────────────
// Photos are stored on disk; settings.gallery holds [{id,url,caption,createdAt}].
router.post('/api/shop/gallery', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  try {
    const url = saveImageDataUrl(req.shopId, 'gallery', req.body.image);
    const item = { id: genId('g'), url, caption: (req.body.caption || '').slice(0, 120), createdAt: new Date().toISOString() };
    const gallery = db.get('settings.gallery').value() || [];
    db.get('settings').assign({ gallery: [item, ...gallery] }).write();
    res.json({ ok: true, item });
  } catch(e) { res.status(400).json({ ok: false, error: e.message || 'Upload failed' }); }
}));
router.delete('/api/shop/gallery/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  const gallery = db.get('settings.gallery').value() || [];
  const item = gallery.find(g => g.id === req.params.id);
  if (item) deleteUpload(item.url);
  db.get('settings').assign({ gallery: gallery.filter(g => g.id !== req.params.id) }).write();
  res.json({ ok: true });
}));

// ── PROTECTED: Reviews ────────────────────────────────────────────────────────
router.get('/api/shop/reviews', requireAuth, shopRoute(async (req, res, db) => {
  const reviews = db.get('reviews').value() || [];
  const count = reviews.length;
  const avg = count ? +(reviews.reduce((a,r)=>a+r.rating,0)/count).toFixed(1) : 0;
  const dist = [0,0,0,0,0];
  reviews.forEach(r => { if (r.rating>=1 && r.rating<=5) dist[r.rating-1]++; });
  res.json({ reviews, stats: { count, avg, dist } });
}));
router.post('/api/shop/reviews/:id/feature', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  const reviews = db.get('reviews').value() || [];
  const r = reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'Review not found' });
  r.featured = !r.featured; db.set('reviews', reviews).write();
  res.json({ ok: true, featured: r.featured });
}));
router.delete('/api/shop/reviews/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  const reviews = db.get('reviews').value() || [];
  db.set('reviews', reviews.filter(x => x.id !== req.params.id)).write();
  res.json({ ok: true });
}));
// Text a client a link to leave a review (uses the shop's SMS line).
router.post('/api/shop/reviews/request', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.body.appointmentId);
  if (!a) return res.status(404).json({ ok: false, error: 'Appointment not found' });
  const phone = (a.customerPhone || '').replace(/\D/g, '');
  if (phone.length < 10) return res.status(400).json({ ok: false, error: 'No phone number on file for this client' });
  const from = shopFromNumber(req.shopId);
  if (!twilioClient || !from) return res.status(400).json({ ok: false, error: 'SMS is not active for this shop yet' });
  const s = db.get('settings').value() || {};
  const shopRow = master.get('shops').find({ id: req.shopId }).value();
  const base = process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
  const link = `${base}/review/${shopRow.slug}?a=${a.id}`;
  const body = `Hi ${(a.customerName||'there').split(' ')[0]}! Thanks for visiting ${s.shopName||'us'}. How did we do? Leave a quick review: ${link}`;
  try {
    await twilioClient.messages.create({ from, to: '+1' + phone, body });
    a.reviewRequestedAt = new Date().toISOString(); h.upsert('appointments', a);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: 'Could not send the text' }); }
}));

// ── PROTECTED: Staff / users (owner only) ─────────────────────────────────────
router.get('/api/shop/staff', requireAuth, requireRole('full'), (req, res) => {
  const shop = master.get('shops').find({ id: req.shopId }).value();
  const users = master.get('accounts').filter({ shopId: req.shopId }).value()
    .map(a => ({ id: a.id, name: a.name || '', email: a.email, role: a.role || 'full', isOwner: a.id === shop.accountId, active: a.active !== false }));
  res.json(users);
});
router.post('/api/shop/staff', requireAuth, requireRole('full'), async (req, res) => {
  const { id, name, email, password, role } = req.body;
  const shop = master.get('shops').find({ id: req.shopId }).value();
  const validRoles = ['full', 'technician', 'viewonly'];
  const r = validRoles.includes(role) ? role : 'technician';
  if (id) {
    const acct = master.get('accounts').find({ id }).value();
    if (!acct || acct.shopId !== req.shopId) return res.status(404).json({ ok: false, error: 'Staff member not found' });
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (acct.id === shop.accountId) updates.role = 'full';       // owner stays full
    else if (role) updates.role = r;
    if (email && email.toLowerCase() !== acct.email) {
      if (master.get('accounts').find({ email: email.toLowerCase() }).value()) return res.status(400).json({ ok: false, error: 'That email is already in use' });
      updates.email = email.toLowerCase();
    }
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
      updates.passwordHash = await bcrypt.hash(password, 10);
    }
    master.get('accounts').find({ id }).assign(updates).write();
    return res.json({ ok: true, id });
  }
  if (!name || !email || !password) return res.status(400).json({ ok: false, error: 'Name, email, and password are required' });
  if (String(password).length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  if (master.get('accounts').find({ email: email.toLowerCase() }).value()) return res.status(400).json({ ok: false, error: 'That email is already in use' });
  const acctId = genId('u');
  master.get('accounts').push({ id: acctId, shopId: req.shopId, email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 10), name, role: r, active: true, createdAt: new Date().toISOString() }).write();
  res.json({ ok: true, id: acctId });
});
router.delete('/api/shop/staff/:id', requireAuth, requireRole('full'), (req, res) => {
  const shop = master.get('shops').find({ id: req.shopId }).value();
  const acct = master.get('accounts').find({ id: req.params.id }).value();
  if (!acct || acct.shopId !== req.shopId) return res.status(404).json({ ok: false, error: 'Staff member not found' });
  if (acct.id === shop.accountId) return res.status(400).json({ ok: false, error: 'Cannot remove the owner account' });
  if (acct.id === req.accountId)  return res.status(400).json({ ok: false, error: 'You cannot remove yourself' });
  master.get('accounts').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// ── PROTECTED: Barbers ────────────────────────────────────────────────────────
router.get('/api/shop/barbers', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('barbers').filter(b => b.active !== false));
}));
router.post('/api/shop/barbers', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const b = req.body; if (!b.id) b.id = genId('b'); h.upsert('barbers', b); res.json({ id: b.id });
}));
router.delete('/api/shop/barbers/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  h.remove('barbers', req.params.id); res.json({ ok: true });
}));
router.post('/api/shop/barbers/:id/schedule', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const b = h.getById('barbers', req.params.id); if (!b) return res.status(404).json({ error: 'Not found' });
  b.schedule = req.body; h.upsert('barbers', b); res.json({ ok: true });
}));

// ── PROTECTED: Services ───────────────────────────────────────────────────────
router.get('/api/shop/services', requireAuth, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('services').sort((a,b) => (a.category||'').localeCompare(b.category||'')));
}));
router.post('/api/shop/services', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const s = req.body; if (!s.id) s.id = genId('s'); h.upsert('services', s); res.json({ id: s.id });
}));
router.delete('/api/shop/services/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  h.remove('services', req.params.id); res.json({ ok: true });
}));

// ── PROTECTED: Customers ──────────────────────────────────────────────────────
router.get('/api/shop/customers', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const customers = h.getAll('customers');
  const appointments = h.getAll('appointments');
  const visitCount = {}, lastVisit = {};
  appointments.forEach(a => { if (a.status==='done'&&a.customerId) { visitCount[a.customerId]=(visitCount[a.customerId]||0)+1; if(!lastVisit[a.customerId]||a.date>lastVisit[a.customerId])lastVisit[a.customerId]=a.date; } });
  res.json(customers.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(c=>({...c,totalVisits:visitCount[c.id]||0,lastVisit:lastVisit[c.id]||null})));
}));
router.get('/api/shop/customers/search', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const q = (req.query.q || '').toLowerCase();
  res.json(h.getAll('customers').filter(c => (c.name||'').toLowerCase().includes(q)||(c.phone||'').includes(q)).slice(0,10));
}));
router.get('/api/shop/customers/:id', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
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
router.post('/api/shop/customers', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const c = req.body; if (!c.id) c.id = genId('c'); h.upsert('customers', c); res.json({ id: c.id });
}));
router.delete('/api/shop/customers/:id', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  h.remove('customers', req.params.id); res.json({ ok: true });
}));
router.post('/api/shop/customers/:id/redeem', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id); if(c){c.loyaltyPoints=0;h.upsert('customers',c);} res.json({ ok: true });
}));

// ── Memberships — recurring wash-club / maintenance plans ─────────────────────
// Plans live in settings.membershipPlans; a customer's membership is stored on
// the customer record. Stripe-backed memberships keep a subscription id so status
// can be refreshed on demand (no webhooks). Manual memberships are tracked locally.
router.post('/api/shop/customers/:id/membership', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id); if (!c) return res.status(404).json({ ok:false, error:'Customer not found' });
  const plan = ((db.get('settings').value()||{}).membershipPlans||[]).find(p=>p.id===req.body.planId);
  if (!plan) return res.status(400).json({ ok:false, error:'Plan not found' });
  c.membership = { planId:plan.id, planName:plan.name, price:Number(plan.price)||0, interval:plan.interval||'month', status:'active', source:'manual', startedAt:new Date().toISOString() };
  h.upsert('customers', c);
  res.json({ ok:true, membership:c.membership });
}));
router.post('/api/shop/customers/:id/membership/cancel', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id); if (!c || !c.membership) return res.status(404).json({ ok:false, error:'No membership on file' });
  if (c.membership.stripeSubscriptionId && stripe) { try { await stripe.subscriptions.cancel(c.membership.stripeSubscriptionId); } catch(e) {} }
  c.membership.status = 'canceled'; c.membership.canceledAt = new Date().toISOString();
  h.upsert('customers', c);
  res.json({ ok:true });
}));
router.post('/api/shop/customers/:id/membership/refresh', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id); if (!c || !c.membership) return res.status(404).json({ ok:false, error:'No membership' });
  if (c.membership.stripeSubscriptionId && stripe) {
    try {
      const sub = await stripe.subscriptions.retrieve(c.membership.stripeSubscriptionId);
      c.membership.status = (sub.status==='active'||sub.status==='trialing') ? 'active' : (sub.status==='past_due' ? 'past_due' : 'canceled');
      if (sub.current_period_end) c.membership.currentPeriodEnd = new Date(sub.current_period_end*1000).toISOString();
      h.upsert('customers', c);
    } catch(e) {}
  }
  res.json({ ok:true, membership:c.membership });
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
router.post('/api/shop/appointments', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = req.body; if (!a.id) a.id = genId('a');
  // Build a vehicle record from custom fields (detail shops) for the customer's history.
  const cf = a.customFields || {};
  const vehicle = (cf.vehicleYear || cf.vehicleMake || cf.vehicleModel)
    ? { year: cf.vehicleYear||'', make: cf.vehicleMake||'', model: cf.vehicleModel||'', color: cf.vehicleColor||'' }
    : null;
  const _vn = s => String(s||'').trim().toLowerCase();
  const sameVehicle = (x,y) => x && y && _vn(x.year)===_vn(y.year) && _vn(x.make)===_vn(y.make) && _vn(x.model)===_vn(y.model);
  // Ensure customer exists
  if (a.customerName) {
    const digits = (a.customerPhone||'').replace(/[^0-9]/g,'');
    let cust = a.customerId ? h.getById('customers',a.customerId) : null;
    if (!cust && digits.length>=10) cust = h.getAll('customers').find(c=>(c.phone||'').replace(/[^0-9]/g,'')===digits);
    if (cust) {
      a.customerId=cust.id;
      if (vehicle && !(cust.vehicles||[]).some(v=>sameVehicle(v,vehicle))) { cust.vehicles=[...(cust.vehicles||[]),vehicle]; h.upsert('customers',cust); }
    }
    else { const cid=genId('c'); h.upsert('customers',{id:cid,name:a.customerName,phone:a.customerPhone||'',email:'',source:a.source||'crm',notes:'',loyaltyPoints:0,noShows:0,preferredBarberId:a.barberId||null,isFleet:false,companyName:'',vehicles:vehicle?[vehicle]:[],createdAt:today()}); a.customerId=cid; }
  }
  h.upsert('appointments', a);
  res.json({ id: a.id });
}));
router.post('/api/shop/appointments/:id/complete', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.status='done'; a.price=req.body.price||a.price||0; h.upsert('appointments',a);
  if (a.customerId) { const c=h.getById('customers',a.customerId); if(c){c.loyaltyVisits=(c.loyaltyVisits||c.loyaltyPoints||0)+1;c.loyaltyPoints=c.loyaltyVisits;c.lastJobDate=a.date;h.upsert('customers',c);} }
  res.json({ ok: true });
}));
router.post('/api/shop/appointments/:id/noshow', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.status='no-show'; a.noShowAt=new Date().toISOString(); h.upsert('appointments',a);
  if (a.customerId) { const c=h.getById('customers',a.customerId); if(c){c.noShows=(c.noShows||0)+1;h.upsert('customers',c);} }
  res.json({ ok: true });
}));
router.post('/api/shop/appointments/:id/waive-deposit', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  a.depositWaived=true; h.upsert('appointments',a); res.json({ ok: true });
}));
router.delete('/api/shop/appointments/:id', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  h.remove('appointments', req.params.id); res.json({ ok: true });
}));

// Before/after job photos — detail shops document vehicle condition at drop-off
// and the finished result (proof of work, marketing, damage/liability record).
// Images live on disk via saveImageDataUrl; the appointment stores [{id,url,createdAt}].
router.post('/api/shop/appointments/:id/photos', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if (!a) return res.status(404).json({ ok:false, error:'Not found' });
  const phase = req.body.phase === 'after' ? 'after' : 'before';
  const key = phase === 'after' ? 'afterPhotos' : 'beforePhotos';
  try {
    const url = saveImageDataUrl(req.shopId, 'job-' + phase, req.body.image);
    const item = { id: genId('ph'), url, createdAt: new Date().toISOString() };
    a[key] = [...(a[key] || []), item];
    h.upsert('appointments', a);
    res.json({ ok:true, phase, item });
  } catch(e) { res.status(400).json({ ok:false, error: e.message || 'Upload failed' }); }
}));
router.delete('/api/shop/appointments/:id/photos/:photoId', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if (!a) return res.status(404).json({ ok:false, error:'Not found' });
  ['beforePhotos','afterPhotos'].forEach(key => {
    const arr = a[key] || [];
    const item = arr.find(p => p.id === req.params.photoId);
    if (item) { deleteUpload(item.url); a[key] = arr.filter(p => p.id !== req.params.photoId); }
  });
  h.upsert('appointments', a);
  res.json({ ok:true });
}));

// ── PROTECTED: Quotes / estimates ─────────────────────────────────────────────
// High-ticket detail work (ceramic, PPF, correction) gets quoted before booking.
// A quote is sent to the customer, who approves it (optionally paying a deposit)
// on a public page; the shop then schedules it into an appointment.
function ensureQuotes(db) { if (!Array.isArray(db.get('quotes').value())) db.set('quotes', []).write(); }

router.get('/api/shop/quotes', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  ensureQuotes(db);
  res.json(h.getAll('quotes').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)));
}));
router.get('/api/shop/quotes/:id', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  ensureQuotes(db);
  const q = h.getById('quotes', req.params.id); if (!q) return res.status(404).json({ error:'Not found' });
  res.json(q);
}));
router.post('/api/shop/quotes', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  ensureQuotes(db);
  const q = req.body;
  // Only (re)compute line items + total when the caller actually sends them —
  // otherwise a partial update (e.g. status change) would wipe the items via merge.
  if (Array.isArray(q.lineItems)) {
    q.lineItems = q.lineItems.map(l=>({ name:String(l.name||'').slice(0,80), price:Number(l.price)||0 }));
    q.total = q.lineItems.reduce((t,l)=>t+l.price, 0);
  }
  if (!q.id) {
    q.id = genId('q');
    const next = ((db.get('settings').value()||{}).quoteCounter || 1000) + 1;
    db.get('settings').assign({ quoteCounter: next }).write();
    q.number = 'Q-' + next;
    q.status = 'sent';
    q.createdAt = new Date().toISOString();
  }
  h.upsert('quotes', q);
  res.json({ id: q.id, number: q.number });
}));
router.delete('/api/shop/quotes/:id', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  ensureQuotes(db); h.remove('quotes', req.params.id); res.json({ ok:true });
}));
// Text the customer a link to view + approve the quote.
router.post('/api/shop/quotes/:id/send', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  ensureQuotes(db);
  const q = h.getById('quotes', req.params.id); if (!q) return res.status(404).json({ ok:false, error:'Quote not found' });
  const phone = (q.customerPhone||'').replace(/\D/g,'');
  if (phone.length < 10) return res.status(400).json({ ok:false, error:'No phone number on file for this customer' });
  const from = shopFromNumber(req.shopId);
  if (!twilioClient || !from) return res.status(400).json({ ok:false, error:'SMS is not active for this shop yet' });
  const s = db.get('settings').value() || {};
  const shopRow = master.get('shops').find({ id: req.shopId }).value();
  const base = process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
  const link = `${base}/quote/${shopRow.slug}/${q.id}`;
  const body = `Hi ${(q.customerName||'there').split(' ')[0]}! Here's your estimate from ${s.shopName||'us'} (${q.number}) — $${q.total}. View & approve: ${link}`;
  try {
    await twilioClient.messages.create({ from, to:'+1'+phone, body });
    q.sentAt = new Date().toISOString(); h.upsert('quotes', q);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:'Could not send the text' }); }
}));

// ── PROTECTED: Revenue ────────────────────────────────────────────────────────
router.get('/api/shop/revenue', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
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
  const activeMembers = customers.filter(c=>c.membership && c.membership.status==='active');
  const mrr = Math.round(activeMembers.reduce((t,c)=>t + (c.membership.interval==='year' ? (Number(c.membership.price)||0)/12 : (Number(c.membership.price)||0)), 0));
  res.json({
    mrr, activeMembers: activeMembers.length,
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
router.get('/api/shop/conversations', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
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
router.get('/api/shop/conversations/customer/:cid', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('conversations').filter(c=>c.customerId===req.params.cid).sort((a,b)=>new Date(a.sentAt)-new Date(b.sentAt)));
}));

// Mark all inbound messages from a customer as read
router.post('/api/shop/conversations/read/:customerId', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  h.getAll('conversations')
    .filter(c => c.customerId === req.params.customerId && c.direction === 'inbound' && !c.read)
    .forEach(c => { c.read = true; h.upsert('conversations', c); });
  res.json({ ok: true });
}));

router.post('/api/shop/conversations', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const c = req.body; if(!c.id)c.id=genId('msg'); h.upsert('conversations',c); res.json({ id:c.id });
}));

// ── PROTECTED: SMS ────────────────────────────────────────────────────────────
router.post('/api/shop/sms/send', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const { to, body, customerId, customerName } = req.body;
  const fromNum = shopFromNumber(req.shopId);
  if (!twilioClient || !fromNum) return res.json({ ok:false, error:'SMS not available for this shop yet. Contact ShopFlow support.' });
  try {
    await twilioClient.messages.create({ from:fromNum, to:'+1'+to.replace(/\D/g,''), body });
    h.upsert('conversations',{id:genId('msg'),customerId,customerName,type:'sms',direction:'outbound',body,sentAt:new Date().toISOString(),read:true});
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
}));

// ── PROTECTED: Leads / call tracking ──────────────────────────────────────────
// Leads are created by the inbound-call webhooks (routes/twilio.js). Each lead
// carries its call history; the Leads page reads this and lets staff text back,
// rename, re-status, or convert a lead into a real client.

// List leads, newest contact first, each with its call log attached.
router.get('/api/shop/leads', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const calls = h.getAll('calls');
  const leads = h.getAll('leads').map(l => ({
    ...l,
    calls: calls.filter(c => c.leadId === l.id).sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt)),
  }));
  leads.sort((a,b) => new Date(b.lastContactAt||0) - new Date(a.lastContactAt||0));
  res.json(leads);
}));

// Update editable lead fields (name, status, notes).
router.post('/api/shop/leads/:id', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const lead = h.getById('leads', req.params.id);
  if (!lead) return res.status(404).json({ ok:false, error:'Lead not found' });
  const { name, status, notes } = req.body;
  if (name   !== undefined) lead.name = String(name).slice(0,80);
  if (notes  !== undefined) lead.notes = String(notes).slice(0,2000);
  if (status !== undefined && ['new','contacted','booked','closed'].includes(status)) lead.status = status;
  h.upsert('leads', lead);
  res.json({ ok:true, lead });
}));

router.delete('/api/shop/leads/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  db.get('calls').remove({ leadId: req.params.id }).write();
  h.remove('leads', req.params.id);
  res.json({ ok:true });
}));

// Convert a lead into a client (CRM record). Idempotent: re-links if already converted.
router.post('/api/shop/leads/:id/convert', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const lead = h.getById('leads', req.params.id);
  if (!lead) return res.status(404).json({ ok:false, error:'Lead not found' });
  let cust = lead.customerId ? h.getById('customers', lead.customerId) : null;
  if (!cust) {
    const digits = String(lead.phone||'').replace(/\D/g,'');
    cust = h.getAll('customers').find(c => String(c.phone||'').replace(/\D/g,'') === digits && digits);
  }
  if (!cust) {
    cust = { id: genId('c'), name: lead.name || lead.phone, phone: lead.phone, email: '', source: 'call',
             notes: lead.notes || '', loyaltyPoints: 0, noShows: 0, preferredBarberId: null,
             isFleet: false, companyName: '', vehicles: [], createdAt: today() };
    h.upsert('customers', cust);
  }
  lead.customerId = cust.id;
  lead.status = lead.status === 'new' || lead.status === 'contacted' ? 'booked' : lead.status;
  h.upsert('leads', lead);
  res.json({ ok:true, customerId: cust.id });
}));

// Text a lead back manually; logs to the lead's call/SMS history + the inbox.
router.post('/api/shop/leads/:id/sms', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const lead = h.getById('leads', req.params.id);
  if (!lead) return res.status(404).json({ ok:false, error:'Lead not found' });
  const fromNum = shopFromNumber(req.shopId);
  const toNum = toE164(lead.phone);
  if (!twilioClient || !fromNum) return res.json({ ok:false, error:'SMS not available for this shop yet. Contact ShopFlow support.' });
  if (!toNum) return res.json({ ok:false, error:'This lead has no textable phone number.' });
  const body = String(req.body.body || '').slice(0,1000);
  if (!body) return res.json({ ok:false, error:'Message is empty.' });
  try {
    await twilioClient.messages.create({ from: fromNum, to: toNum, body });
    h.upsert('conversations', { id: genId('msg'), customerId: lead.customerId || null, leadId: lead.id,
      customerName: lead.name || lead.phone, type:'sms', direction:'outbound', body, sentAt:new Date().toISOString(), read:true });
    if (lead.status === 'new') { lead.status = 'contacted'; }
    lead.lastContactAt = new Date().toISOString();
    h.upsert('leads', lead);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
}));

// ── PROTECTED: Blocked dates ──────────────────────────────────────────────────
router.get('/api/shop/blocked-dates', requireAuth, shopRoute(async (req, res, db, h) => res.json(h.getAll('blockedDates'))));
router.post('/api/shop/blocked-dates', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ ok:false });
  if (!h.getAll('blockedDates').find(b=>b.date===date)) h.upsert('blockedDates',{id:genId('bd'),date,reason:reason||'',createdAt:new Date().toISOString()});
  res.json({ ok: true });
}));
router.delete('/api/shop/blocked-dates/:date', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
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

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware');
const { sendTest, sendQuoteEmail, shopReplyTo } = require('../email');
const { resolveProfile } = require('../industries');
const { master, getShopDb, shopHelpers, shopRoute, shopFromNumber, shopOwnNumber, buildSms, genId, today, slug, toE164, JWT_SECRET, stripe, twilioClient, TWILIO_DEFAULT_FROM, MASTER_DIR, SHOPS_DIR, CLIENT_DIR, initShopDb, saveImageDataUrl, deleteUpload, computeTax, computeApptCost } = require('../db');
const { ensureQuoteCustomer } = require('../quotes-core');

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
  // Backfill the 'Unconfirmed' pre-confirmation status for shops seeded before
  // it existed (statuses are copied from the industry profile at shop init).
  if (Array.isArray(s.statuses) && s.statuses.length && !s.statuses.some(st => st && st.key === 'unconfirmed'))
    s.statuses = [{ key: 'unconfirmed', label: 'Unconfirmed', occupiesSlot: true }, ...s.statuses];
  if (!Array.isArray(s.membershipPlans)) s.membershipPlans = [];
  // Backfill sales-tax config for shops created before tax existed.
  if (!s.tax || typeof s.tax !== 'object') s.tax = { enabled: false, rate: 0, label: 'Sales Tax' };
  const _prof = resolveProfile(db.get('industry').value());
  if (!Array.isArray(s.serviceCategories)) s.serviceCategories = _prof.serviceCategories || ['cut','beard','combo','color','design','other'];
  if (s.staffPicker === undefined) s.staffPicker = _prof.staffPicker !== false;
  if (s.supportsQuotes === undefined) s.supportsQuotes = !!_prof.supportsQuotes;
  // Call tracking: surface the shop's OWN tracking number (read-only). No global
  // fallback — a shop only ever shows a number explicitly assigned to it, so one
  // tenant never sees another tenant's (e.g. the platform default) number.
  s.trackingNumber = shopOwnNumber(req.shopId);
  // Public slug (read-only) so the UI can show shareable /book/<slug> links.
  s.shopSlug = (master.get('shops').find({ id: req.shopId }).value() || {}).slug || '';
  if (!s.callTracking) s.callTracking = { enabled: true };
  // Surface the resolved industry so the frontend can mount industry-specific
  // navigation/modules (the profile lives outside `settings`, on the shop DB root).
  s.industry = db.get('industry').value() || 'barbershop';
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

// ── PROTECTED: Send a test new-lead alert email (owner only) ───────────────────
// Lets the owner confirm from Settings that lead alerts reach their inbox. If a
// valid address is passed it's saved as settings.notificationEmail (the alert
// recipient the code actually reads) first, then a test is sent to whatever the
// recipient resolves to (that override → the shop's signup email). Awaits the
// send and returns the outcome so the exact failure reason shows in the browser.
router.post('/api/shop/test-lead-email', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  const email = String(req.body.email || '').trim().slice(0, 120);
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    db.get('settings').assign({ notificationEmail: email }).write();
  }
  const s = db.get('settings').value() || {};
  const shop = master.get('shops').find({ id: req.shopId }).value() || {};
  const to = String(s.notificationEmail || shop.email || '').trim();
  const result = await sendTest({ to });
  res.json(result);
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

// ── PROTECTED: Website photos (single named slots, owner only) ────────────────
// settings.siteImages is a map { [slot]: url } that lets the owner override the
// marketing website's fixed stock photos (hero + per-service tiles) one at a
// time. Distinct from settings.gallery (a list) and settings.heroImage (this
// platform's own booking-page background). Unknown slots are rejected so the map
// can't be polluted with arbitrary keys.
const SITE_IMAGE_SLOTS = ['logo', 'hero', 'service_tint', 'service_ceramic', 'service_ppf', 'service_detail', 'service_commercial'];
router.post('/api/shop/site-image', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  try {
    const key = String(req.body.key || '');
    if (!SITE_IMAGE_SLOTS.includes(key)) return res.status(400).json({ ok: false, error: 'Unknown image slot' });
    const url = saveImageDataUrl(req.shopId, 'site-' + key, req.body.image);
    const siteImages = { ...(db.get('settings.siteImages').value() || {}) };
    if (siteImages[key]) deleteUpload(siteImages[key]); // replace the previous file, don't orphan it
    siteImages[key] = url;
    db.get('settings').assign({ siteImages }).write();
    res.json({ ok: true, key, url });
  } catch(e) { res.status(400).json({ ok: false, error: e.message || 'Upload failed' }); }
}));
router.delete('/api/shop/site-image/:key', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  const key = String(req.params.key || '');
  const siteImages = { ...(db.get('settings.siteImages').value() || {}) };
  if (siteImages[key]) { deleteUpload(siteImages[key]); delete siteImages[key]; db.get('settings').assign({ siteImages }).write(); }
  res.json({ ok: true });
}));

// ── PROTECTED: Website team roster (owner only) ──────────────────────────────
// settings.siteTeam is a list [{id,name,title,bio,photo}] rendered as the
// marketing site's "Meet the Team". One POST handles create + edit (a new photo
// replaces and cleans up the old file); DELETE removes the member and its photo.
router.post('/api/shop/site-team', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ ok: false, error: 'Name is required' });
    const title = String(req.body.title || '').trim().slice(0, 80);
    const bio = String(req.body.bio || '').trim().slice(0, 400);
    const list = [...(db.get('settings.siteTeam').value() || [])];
    const id = String(req.body.id || '');
    const idx = id ? list.findIndex(m => m.id === id) : -1;
    let photo = idx >= 0 ? (list[idx].photo || '') : '';
    if (req.body.image) {                          // a new photo was picked
      const url = saveImageDataUrl(req.shopId, 'team', req.body.image);
      if (photo) deleteUpload(photo);              // don't orphan the previous one
      photo = url;
    }
    const member = { id: idx >= 0 ? list[idx].id : genId('tm'), name, title, bio, photo };
    if (idx >= 0) list[idx] = member; else list.push(member);
    db.get('settings').assign({ siteTeam: list }).write();
    res.json({ ok: true, member, team: list });
  } catch(e) { res.status(400).json({ ok: false, error: e.message || 'Save failed' }); }
}));
router.delete('/api/shop/site-team/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  const list = db.get('settings.siteTeam').value() || [];
  const member = list.find(m => m.id === req.params.id);
  if (member && member.photo) deleteUpload(member.photo);
  db.get('settings').assign({ siteTeam: list.filter(m => m.id !== req.params.id) }).write();
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
// Mark-only: the owner sends the review text manually from their own phone (iPhone
// sms: deep link, no Twilio/A2P). This endpoint just records that the request went
// out so the UI can show "Sent ✓" and the review automation won't double-prompt.
router.post('/api/shop/reviews/request', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.body.appointmentId);
  if (!a) return res.status(404).json({ ok: false, error: 'Appointment not found' });
  a.reviewRequestedAt = new Date().toISOString(); h.upsert('appointments', a);
  res.json({ ok: true });
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
  // 'client' = outside-collaborator portal login (leads only, /portal) — its
  // token is rejected on every /api/shop route by requireAuth (middleware.js).
  const validRoles = ['full', 'technician', 'viewonly', 'client'];
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

// ── PROTECTED: Client-portal activity (owner only) ────────────────────────────
// Everything a role:client login did — sign-ins, list views (session-throttled),
// leads logged, leads marked contacted. Written by routes/client.js + auth.js;
// read here for Settings → Team → Activity. Per-client summary rides along.
router.get('/api/shop/client-activity', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  const activity = (db.get('clientActivity').value() || []).slice(0, 200);
  const clients = {};
  (db.get('clientActivity').value() || []).forEach(a => {
    const c = clients[a.email] || (clients[a.email] = { email: a.email, name: a.name, lastSeen: a.at, logins: 0, views: 0, created: 0, contacted: 0 });
    if (a.at > c.lastSeen) c.lastSeen = a.at;
    if (a.action === 'login') c.logins++;
    else if (a.action === 'view') c.views++;
    else if (a.action === 'lead.created') c.created++;
    else if (a.action === 'lead.contacted') c.contacted++;
  });
  res.json({ ok: true, activity, clients: Object.values(clients) });
}));

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
// Activity log: append an entry (added / texted / called / …) to a client's notes.
router.post('/api/shop/customers/:id/log', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const c = h.getById('customers', req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'Client not found' });
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (text) {
    c.noteLog = c.noteLog || [];
    c.noteLog.unshift({ id: genId('note'), scope: 'activity', text, at: new Date().toISOString(), by: String(req.body.by || '').slice(0, 60) });
    h.upsert('customers', c);
  }
  res.json({ ok: true });
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
  // Only mark canceled locally if Stripe actually cancelled the subscription —
  // otherwise the customer keeps getting billed while the UI says "canceled".
  if (c.membership.stripeSubscriptionId && stripe) {
    try { await stripe.subscriptions.cancel(c.membership.stripeSubscriptionId); }
    catch(e) { return res.status(502).json({ ok:false, error:'Could not cancel the Stripe subscription — it is still active. Please try again. ('+e.message+')' }); }
  }
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
  // Booked-by attribution: stamp WHO entered this appointment from the auth
  // token, never from the client body (a crafted request could credit someone
  // else). Stamped on create only — edits keep the original booker (upsert
  // merges, so deleting the keys here leaves the stored values untouched).
  // Name is snapshotted so attribution survives a deleted staff login.
  delete a.createdBy; delete a.createdByName;
  if (!h.getById('appointments', a.id)) {
    a.createdBy = req.accountId || null;
    const acct = master.get('accounts').find({ id: req.accountId }).value();
    a.createdByName = acct ? (acct.name || acct.email) : null;
    if (!a.createdAt) a.createdAt = new Date().toISOString();
  }
  // Prevent double-booking the same staff member at the same date+time. The
  // public booking path validates this; the in-app create previously did not,
  // so staff (or a crafted request) could silently overbook a chair. Terminal
  // states (done/no-show/cancelled) free the slot.
  if (a.barberId && a.date && a.time) {
    const TERMINAL = ['done', 'no-show', 'cancelled', 'canceled', 'declined'];
    const clash = h.getAll('appointments').find(x => x.id !== a.id && x.barberId === a.barberId && x.date === a.date && x.time === a.time && !TERMINAL.includes(x.status));
    if (clash) return res.status(409).json({ error: 'That time is already booked for this staff member. Pick another slot.' });
  }
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
  // Snapshot material/product cost (service + add-ons) for margin reporting.
  // Only when the save carries service/add-on info, so a partial status-only
  // save (e.g. setStatus) doesn't zero out a previously-computed cost.
  if (a.serviceId !== undefined || a.addons !== undefined) a.cost = computeApptCost(db, a);
  h.upsert('appointments', a);
  res.json({ id: a.id });
}));
router.post('/api/shop/appointments/:id/complete', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  const prev = a.status;
  a.status='done'; a.price=req.body.price||a.price||0; h.upsert('appointments',a);
  // Award loyalty only on the transition INTO done — re-completing must not double-count.
  if (prev !== 'done' && a.customerId) {
    const c=h.getById('customers',a.customerId);
    if(c){
      c.loyaltyVisits=(c.loyaltyVisits||c.loyaltyPoints||0)+1; c.loyaltyPoints=c.loyaltyVisits; c.lastJobDate=a.date;
      if (prev==='no-show' && (c.noShows||0)>0) c.noShows=c.noShows-1; // it wasn't a no-show after all
      h.upsert('customers',c);
    }
  }
  res.json({ ok: true });
}));
router.post('/api/shop/appointments/:id/noshow', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const a = h.getById('appointments', req.params.id); if(!a) return res.status(404).json({ error:'Not found' });
  const prev = a.status;
  a.status='no-show'; a.noShowAt=new Date().toISOString(); h.upsert('appointments',a);
  // Count the no-show only on the transition INTO no-show — and reverse a loyalty
  // visit if this appointment had previously been marked done.
  if (prev !== 'no-show' && a.customerId) {
    const c=h.getById('customers',a.customerId);
    if(c){
      c.noShows=(c.noShows||0)+1;
      if (prev==='done' && (c.loyaltyVisits||0)>0) { c.loyaltyVisits=c.loyaltyVisits-1; c.loyaltyPoints=c.loyaltyVisits; }
      h.upsert('customers',c);
    }
  }
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
const _qty = (v) => Math.max(1, Math.min(999, Math.round(Number(v) || 1)));

// ── Fleet contract math ───────────────────────────────────────────────────────
// A fleet estimate prices ONE visit (line items × vehicle counts), so quote.total
// stays the per-visit number every downstream feature already reads — deposits,
// "Schedule appointment", revenue reporting. The recurring figures are derived
// beside it: an every-2-weeks contract is 26 visits a year, not 24, so monthly is
// annualised rather than multiplied by a nominal 2 visits/month.
const VISITS_PER_YEAR = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4 };
function contractTotals(q) {
  const c = q.contract;
  const freq = c && VISITS_PER_YEAR[c.frequency];
  if (!freq) return { contract: null, monthlyTotal: 0, contractValue: 0 };
  const termMonths = Math.max(1, Math.min(120, Math.round(Number(c.termMonths) || 12)));
  const monthlyTotal = Math.round((Number(q.total) || 0) * (freq / 12) * 100) / 100;
  return {
    contract: { frequency: c.frequency, termMonths },
    monthlyTotal,
    contractValue: Math.round(monthlyTotal * termMonths * 100) / 100,
  };
}

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
    // qty carries fleet quantities ("Full Detail × 12 trucks"); 1 for ordinary
    // one-vehicle estimates, which keeps every pre-fleet quote's math identical.
    q.lineItems = q.lineItems.map(l=>({ name:String(l.name||'').slice(0,80), price:Number(l.price)||0, qty:_qty(l.qty) }));
    const subtotal = Math.round(q.lineItems.reduce((t,l)=>t+l.price*l.qty, 0) * 100) / 100;
    // Percentage discount off the subtotal; tax is charged on what the customer
    // actually pays. An edit that omits the field keeps the stored discount
    // (partial saves must not silently un-discount an estimate).
    const prior = q.id ? h.getById('quotes', q.id) : null;
    const rawPct = q.discountPercent !== undefined ? q.discountPercent : (prior && prior.discountPercent);
    const pct = Math.max(0, Math.min(100, Number(rawPct) || 0));
    q.discountPercent = pct;
    q.discountAmount  = pct ? Math.round(subtotal * pct) / 100 : 0;
    const discounted = Math.round((subtotal - q.discountAmount) * 100) / 100;
    const tax = computeTax(db.get('settings').value() || {}, discounted);
    q.subtotal  = subtotal;
    q.taxRate   = tax.amount ? tax.rate : 0;
    q.taxLabel  = tax.label;
    q.taxAmount = tax.amount;
    q.total     = Math.round((discounted + tax.amount) * 100) / 100;
  }
  // Option estimates: a "choose one" estimate (e.g. carbon vs ceramic tint).
  // Each option = name + price + benefit bullets; the customer picks on the
  // public page and approval materializes the choice into lineItems/totals.
  // Until then the quote's total is the STARTING-AT price (lowest option).
  if (Array.isArray(q.options)) {
    q.options = q.options
      .filter(o => o && String(o.name || '').trim() && Number(o.price) > 0)
      .slice(0, 4)
      .map((o, i) => ({
        id: String(o.id || 'opt' + (i + 1)).slice(0, 20),
        name: String(o.name).trim().slice(0, 60),
        price: Math.round((Number(o.price) || 0) * 100) / 100,
        benefits: (Array.isArray(o.benefits) ? o.benefits : String(o.benefits || '').split('\n'))
          .map(b => String(b || '').trim().slice(0, 90)).filter(Boolean).slice(0, 8),
        recommended: !!o.recommended,
      }));
    if (q.options.length < 2) { q.options = null; }
    else if (!q.chosenOptionId) {
      const min = Math.min(...q.options.map(o => o.price));
      q.lineItems = []; q.subtotal = min; q.discountPercent = 0; q.discountAmount = 0;
      q.taxRate = 0; q.taxAmount = 0; q.total = min;
    }
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
  let merged = h.getById('quotes', q.id);
  // Recurring totals ride on the merged record so they're right whether this
  // save changed the items, the terms, or both. Only recomputed when the caller
  // actually touched one of them — a bare status change leaves them alone.
  if (merged && (Array.isArray(q.lineItems) || q.contract !== undefined)) {
    h.upsert('quotes', { id: merged.id, ...contractTotals(merged) });
    merged = h.getById('quotes', q.id);
  }
  // Owner marked it approved (or edited an approved one): make sure the client
  // profile exists + is linked. Idempotent — no-op once customerId resolves.
  if (merged && merged.status === 'approved') { try { ensureQuoteCustomer(h, merged); } catch (e) {} }
  // Owner closed the estimate out ('completed' = work won, 'lost' = it died) or
  // reopened it. Stamp the transition server-side so reporting can tell won work
  // from dead work, and clear the stamps on a reopen.
  if (merged && typeof q.status === 'string') {
    const now = new Date().toISOString();
    const stamp = {};
    if (q.status === 'completed') { if (!merged.completedAt) stamp.completedAt = now; }
    else if (q.status === 'lost') { if (!merged.lostAt)      stamp.lostAt      = now; }
    else if (q.status === 'scheduled' && !merged.scheduledAt) { stamp.scheduledAt = now; }
    if (!['completed','lost','declined'].includes(q.status)) {
      if (merged.completedAt) stamp.completedAt = null;
      if (merged.lostAt)      stamp.lostAt      = null;
      if (merged.declinedAt)  stamp.declinedAt  = null;
    }
    if (Object.keys(stamp).length) h.upsert('quotes', { id: merged.id, ...stamp });
  }
  res.json({ id: q.id, number: q.number });
}));
router.delete('/api/shop/quotes/:id', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  ensureQuotes(db); h.remove('quotes', req.params.id); res.json({ ok:true });
}));
// Text the customer a link to view + approve the quote.
// Recipient: the quote's own phone, falling back to the linked customer record.
router.post('/api/shop/quotes/:id/send', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  ensureQuotes(db);
  const q = h.getById('quotes', req.params.id); if (!q) return res.status(404).json({ ok:false, error:'Quote not found' });
  const rawPhone = q.customerPhone || (q.customerId ? (h.getById('customers', q.customerId)||{}).phone : '') || '';
  const toNum = toE164(rawPhone);
  if (!toNum) return res.status(400).json({ ok:false, error:'No phone number on file for this customer' });
  const from = shopFromNumber(req.shopId);
  if (!twilioClient || !from) return res.status(400).json({ ok:false, error:'SMS is not active for this shop yet' });
  const s = db.get('settings').value() || {};
  const shopRow = master.get('shops').find({ id: req.shopId }).value();
  const base = process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
  const link = `${base}/quote/${shopRow.slug}/${q.id}`;
  const body = `Hi ${(q.customerName||'there').split(' ')[0]}! Here's your estimate from ${s.shopName||'us'} (${q.number}) — $${q.total}. View & approve: ${link}`;
  try {
    await twilioClient.messages.create({ from, to: toNum, body });
    // Log to the customer's text thread so the estimate shows in their history.
    h.upsert('conversations', { id: genId('msg'), customerId: q.customerId || null,
      customerName: q.customerName || rawPhone, type:'sms', direction:'outbound', body,
      sentAt: new Date().toISOString(), read:true });
    q.sentAt = new Date().toISOString(); q.smsSentAt = q.sentAt;
    if (!q.customerPhone) q.customerPhone = rawPhone; // persist for future sends
    h.upsert('quotes', q);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:'Could not send the text' }); }
}));
// Email the customer a link to view + approve the quote. Works without SMS/A2P.
// Recipient: the quote's own email, falling back to the linked customer record.
router.post('/api/shop/quotes/:id/send-email', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  ensureQuotes(db);
  const q = h.getById('quotes', req.params.id); if (!q) return res.status(404).json({ ok:false, error:'Quote not found' });
  const to = (q.customerEmail || (q.customerId ? (h.getById('customers', q.customerId)||{}).email : '') || '').trim();
  if (!to) return res.status(400).json({ ok:false, error:'No email address on file for this customer' });
  const s = db.get('settings').value() || {};
  const shopRow = master.get('shops').find({ id: req.shopId }).value();
  const base = process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
  const link = `${base}/quote/${shopRow.slug}/${q.id}`;
  const openPixel = `${base}/api/public/${shopRow.slug}/quote/${q.id}/opened.gif`;
  const shop = { name: s.shopName, tagline: s.tagline, phone: s.phone, address: s.address, email: s.email, accentColor: s.accentColor };
  const r = await sendQuoteEmail({ to, shop, quote: q, link, openPixel, replyTo: shopReplyTo(s, shopRow) });
  if (!r.ok) return res.status(502).json({ ok:false, error: r.reason || 'Could not send the email' });
  // Persist so future sends default to this address and the timeline reflects it.
  q.sentAt = new Date().toISOString(); q.emailSentAt = q.sentAt; if (!q.customerEmail) q.customerEmail = to;
  h.upsert('quotes', q);
  res.json({ ok:true, to });
}));

// ── PROTECTED: Expenses (operating costs for true net-profit reporting) ───────
const EXPENSE_CATEGORIES = ['Rent','Supplies','Equipment','Marketing','Software','Insurance','Payroll','Fuel','Utilities','Other'];

router.get('/api/shop/expenses', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('expenses').sort((a,b)=>String(b.date).localeCompare(String(a.date))));
}));

router.post('/api/shop/expenses', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const b = req.body || {};
  const amount = Math.round((Number(b.amount)||0)*100)/100;
  if (!(amount > 0)) return res.status(400).json({ ok:false, error:'Enter an amount greater than 0.' });
  const exp = {
    id: b.id || genId('exp'),
    date:        /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : today(),
    category:    EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'Other',
    recurring:   (b.recurring === true || b.recurring === 'monthly') ? 'monthly' : 'none',
    amount,
    description: String(b.description||'').slice(0,120),
    createdAt:   new Date().toISOString(),
  };
  if (b.id) { const ex = h.getById('expenses', b.id); if (ex) exp.createdAt = ex.createdAt; } // preserve on edit
  h.upsert('expenses', exp);
  res.json({ ok:true, expense: exp });
}));

router.delete('/api/shop/expenses/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  h.remove('expenses', req.params.id);
  res.json({ ok:true });
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
  // ── Profit (P&L) ──────────────────────────────────────────────────────────
  // Gross = revenue − material/COGS snapshotted per job (older jobs with no cost
  // on file count as $0). Net = gross − operating expenses for the period.
  const round2 = n => Math.round(n*100)/100;
  const monthOf = d => String(d||'').slice(0,7);
  const curMonth = ms.slice(0,7);

  const totalRevenue = done.reduce((s,a)=>s+Number(a.price||0),0);
  const totalCost    = done.reduce((s,a)=>s+Number(a.cost||0),0);
  const monthRevenue = thisMonth.reduce((s,a)=>s+Number(a.price||0),0);
  const monthCost    = thisMonth.reduce((s,a)=>s+Number(a.cost||0),0);

  // Operating expenses: a monthly-recurring expense counts in every month from
  // its start month onward; a one-off counts only in the month it's dated.
  const expenses = h.getAll('expenses');
  const opExForMonth = (mk) => round2(expenses.reduce((s,e)=>{
    const inMonth = e.recurring === 'monthly' ? (monthOf(e.date) <= mk) : (monthOf(e.date) === mk);
    return inMonth ? s + (Number(e.amount)||0) : s;
  }, 0));
  const monthsActive = (startM, endM) => {
    const [sy,sm]=String(startM).split('-').map(Number), [ey,em]=String(endM).split('-').map(Number);
    if(!sy||!ey) return 1;
    return Math.max(1, (ey-sy)*12 + (em-sm) + 1);
  };
  const monthOpEx = opExForMonth(curMonth);
  const totalOpEx = round2(expenses.reduce((s,e)=>
    s + (e.recurring === 'monthly' ? (Number(e.amount)||0)*monthsActive(monthOf(e.date), curMonth) : (Number(e.amount)||0)), 0));

  // Expense breakdown by category (this month, incl. active recurring).
  const catMap = {};
  expenses.forEach(e=>{
    const inMonth = e.recurring === 'monthly' ? (monthOf(e.date) <= curMonth) : (monthOf(e.date) === curMonth);
    if (inMonth) catMap[e.category] = (catMap[e.category]||0) + (Number(e.amount)||0);
  });
  const byCategory = Object.entries(catMap).map(([category,amount])=>({category,amount:round2(amount)})).sort((a,b)=>b.amount-a.amount);

  // Profitability by service (all-time): revenue, COGS, margin.
  const svcMap = {};
  done.forEach(a=>{ const k=a.service||'Other'; (svcMap[k]||(svcMap[k]={service:k,revenue:0,cost:0,count:0}));
    svcMap[k].revenue+=Number(a.price||0); svcMap[k].cost+=Number(a.cost||0); svcMap[k].count++; });
  const byService = Object.values(svcMap).map(s=>({service:s.service,count:s.count,revenue:round2(s.revenue),cost:round2(s.cost),margin:round2(s.revenue-s.cost)})).sort((a,b)=>b.margin-a.margin);

  // Net-profit trend: per business month, revenue − COGS − operating expenses.
  const monMap = {};
  done.forEach(a=>{ const m=monthOf(a.date); if(!m) return; (monMap[m]||(monMap[m]={revenue:0,cost:0})); monMap[m].revenue+=Number(a.price||0); monMap[m].cost+=Number(a.cost||0); });
  const netByMonth = Object.keys(monMap).sort().map(m=>{ const opEx=opExForMonth(m);
    return { month:m, revenue:round2(monMap[m].revenue), cost:round2(monMap[m].cost), opEx, net:round2(monMap[m].revenue-monMap[m].cost-opEx) }; });

  const monthGross = round2(monthRevenue - monthCost);
  const totalGross = round2(totalRevenue - totalCost);
  const monthNet   = round2(monthGross - monthOpEx);
  const totalNet   = round2(totalGross - totalOpEx);

  // Deposits collected (standalone, profile-requested). Tracked as their own
  // stream so the P&L stays service-based; bucketed by when they were paid.
  const paidDeposits = customers.flatMap(c => (c.deposits || []).filter(d => d.status === 'paid'));
  const totalDeposits = round2(paidDeposits.reduce((s, d) => s + Number(d.amount || 0), 0));
  const monthDeposits = round2(paidDeposits.filter(d => monthOf(d.paidAt) === curMonth).reduce((s, d) => s + Number(d.amount || 0), 0));

  // ── Booked by (who ENTERED the appointment) ────────────────────────────────
  // Per-account sales attribution: every staff-created appointment carries a
  // server-stamped createdBy (accountId). "Booked" = jobs that person entered
  // this month (by entry timestamp, excluding dead statuses) at booked price —
  // the money they put on the calendar. "Closed" = their jobs marked done,
  // bucketed by appointment date like the rest of the revenue math. Names join
  // live from master accounts (renames stick) and fall back to the snapshot
  // taken at booking time, so deleted logins keep their history.
  const shopAccounts = master.get('accounts').filter({ shopId: req.shopId }).value() || [];
  const DEAD_STATUSES = ['cancelled', 'canceled', 'declined', 'no-show'];
  const byCreatorMap = {};
  h.getAll('appointments').forEach(a => {
    if (!a.createdBy) return;
    const live = shopAccounts.find(x => x.id === a.createdBy);
    const row = byCreatorMap[a.createdBy] || (byCreatorMap[a.createdBy] = {
      accountId: a.createdBy,
      name: (live && (live.name || live.email)) || a.createdByName || 'Former staff',
      bookedMonth: 0, bookedMonthJobs: 0,
      closedMonth: 0, closedMonthJobs: 0,
      closedTotal: 0, closedTotalJobs: 0,
    });
    const price = Number(a.price || 0);
    if (monthOf(a.createdAt) === curMonth && !DEAD_STATUSES.includes(a.status)) { row.bookedMonth += price; row.bookedMonthJobs++; }
    if (a.status === 'done') {
      row.closedTotal += price; row.closedTotalJobs++;
      if ((a.date || '') >= ms) { row.closedMonth += price; row.closedMonthJobs++; }
    }
  });
  const byCreator = Object.values(byCreatorMap)
    .map(r => ({ ...r, bookedMonth: round2(r.bookedMonth), closedMonth: round2(r.closedMonth), closedTotal: round2(r.closedTotal) }))
    .sort((a, b) => b.bookedMonth - a.bookedMonth || b.closedTotal - a.closedTotal);

  // ── Revenue Recovered (AI receptionist) ────────────────────────────────────
  // Money the AI voice receptionist brought in on calls the shop would otherwise
  // have missed. Two sources, deduped by appointment id:
  //   • AI booked the job live (calendar shops)  → appt.source === 'ai-voice'.
  //   • AI captured a quoted lead (quote-first)   → the owner later closed it into
  //     a completed job for that caller. We attribute a done appointment to the AI
  //     when it belongs to an AI-captured lead (matched by customerId or phone)
  //     and is dated on/after the AI captured them.
  // Realized = price of those done appointments. Pipeline = quoted price on
  // AI-captured leads still open (not yet realized) — potential, shown separately.
  const onlyDigits = s => String(s || '').replace(/\D/g, '');
  const last10 = s => onlyDigits(s).slice(-10);
  // Effective quote for a lead: the owner's manual "Quoted amount" (entered on the
  // lead in the Leads UI) is authoritative — it's a correction/backfill for quotes
  // the AI gave but didn't record — so it wins; else the AI-captured price; else the
  // caller's stated budget.
  const quoteOf = l => Number(
    l.quotedAmount != null ? l.quotedAmount
    : (l.ai && l.ai.quotedPrice != null) ? l.ai.quotedPrice
    : (l.ai && l.ai.budget));
  const aiLeads = h.getAll('leads').filter(l => l.ai && l.ai.source === 'voice');
  const aiCustCap = new Map();   // customerId → capture date (YYYY-MM-DD)
  const aiPhoneCap = new Map();  // last-10 phone → capture date
  aiLeads.forEach(l => {
    const cap = String(l.ai.generatedAt || l.createdAt || '').slice(0, 10);
    if (l.customerId) aiCustCap.set(l.customerId, cap);
    const ph = last10(l.phone); if (ph.length === 10) aiPhoneCap.set(ph, cap);
  });
  const aiDone = done.filter(a => {
    if (a.source === 'ai-voice') return true;             // AI booked it directly
    const cap = (a.customerId && aiCustCap.get(a.customerId)) || aiPhoneCap.get(last10(a.customerPhone));
    return !!cap && String(a.date || '') >= cap;          // AI-captured lead, later closed
  });
  const aiDoneMonth = aiDone.filter(a => a.date >= ms);
  const realizedCust = new Set(aiDone.map(a => a.customerId).filter(Boolean));
  const realizedPhone = new Set(aiDone.map(a => last10(a.customerPhone)).filter(p => p.length === 10));
  const aiPipeline = aiLeads.filter(l => {
    if (!(quoteOf(l) > 0)) return false;
    const ph = last10(l.phone);
    return !((l.customerId && realizedCust.has(l.customerId)) || (ph.length === 10 && realizedPhone.has(ph)));
  });

  // AI receptionist funnel (scorecard): answered → engaged → captured/booked, from
  // the call log. A call has voiceAI state once the AI answered it; "engaged" means
  // the caller actually spoke (≥1 user turn, i.e. didn't hang up on the greeting);
  // outcome.type records how the AI ended it.
  const aiCalls = h.getAll('calls').filter(c => c && c.voiceAI);
  const outcomeType = c => (c.voiceAI.outcome && c.voiceAI.outcome.type) || null;
  // A quote was "given" on a call when the AI attached a price to its outcome —
  // either it ended in the 'quoted' state, or it captured/booked with a price
  // (quotedPrice from capture_lead, price from book_appointment). So quoted ⊇
  // booked-with-a-price, keeping the funnel monotonic (answered → engaged →
  // quoted → booked).
  const gaveQuote = c => {
    const o = c.voiceAI.outcome || {};
    return o.type === 'quoted' || o.quotedPrice != null || o.price != null;
  };
  // A call also counts as "quoted" when its linked lead carries a quote — the AI's
  // captured price OR the owner's manually-entered "Quoted amount" — so quotes the
  // receptionist gave but didn't log (owner backfills them on the lead) show here.
  const leadById = new Map(h.getAll('leads').map(l => [l.id, l]));
  const callQuoted = c => gaveQuote(c) || (c.leadId && leadById.has(c.leadId) && quoteOf(leadById.get(c.leadId)) > 0);
  const aiReceptionist = {
    answered: aiCalls.length,
    engaged:  aiCalls.filter(c => (c.voiceAI.turns || []).some(t => t.role === 'user')).length,
    quoted:   aiCalls.filter(callQuoted).length,
    captured: aiCalls.filter(c => outcomeType(c) === 'captured').length,
    booked:   aiCalls.filter(c => outcomeType(c) === 'booked').length,
    quotedTotal: round2(aiLeads.reduce((s, l) => s + (quoteOf(l) > 0 ? quoteOf(l) : 0), 0)),
  };

  res.json({
    aiReceptionist,
    mrr, activeMembers: activeMembers.length,
    aiRecoveredTotal: round2(aiDone.reduce((s, a) => s + Number(a.price || 0), 0)),
    aiRecoveredMonth: round2(aiDoneMonth.reduce((s, a) => s + Number(a.price || 0), 0)),
    aiRecoveredJobs: aiDone.length,
    aiRecoveredJobsMonth: aiDoneMonth.length,
    aiPipelineOpen: round2(aiPipeline.reduce((s, l) => s + (quoteOf(l) || 0), 0)),
    aiPipelineCount: aiPipeline.length,
    totalRevenue, monthRevenue,
    totalCost: round2(totalCost), monthCost: round2(monthCost),
    monthGrossProfit: monthGross, totalGrossProfit: totalGross,
    monthGrossMarginPct: monthRevenue ? Math.round(monthGross/monthRevenue*100) : 0,
    monthOpEx, totalOpEx,
    monthNetProfit: monthNet, totalNetProfit: totalNet,
    monthNetMarginPct: monthRevenue ? Math.round(monthNet/monthRevenue*100) : 0,
    // back-compat aliases (old field names = gross margin)
    totalMargin: totalGross, monthMargin: monthGross,
    monthMarginPct: monthRevenue ? Math.round(monthGross/monthRevenue*100) : 0,
    byCategory, byService, netByMonth,
    expenseCategories: EXPENSE_CATEGORIES,
    hasExpenses: expenses.length > 0,
    monthTaxCollected: round2(thisMonth.reduce((s,a)=>s+Number(a.taxAmount||0),0)),
    totalTaxCollected: round2(done.reduce((s,a)=>s+Number(a.taxAmount||0),0)),
    monthDeposits, totalDeposits,
    monthJobs: thisMonth.length,
    avgTicket: thisMonth.length?Math.round(thisMonth.reduce((s,a)=>s+Number(a.price||0),0)/thisMonth.length):0,
    byCreator,
    byBarber: Object.values(byBarber).sort((a,b)=>b.revenue-a.revenue),
    byMonth: Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0])).map(([month,revenue])=>({month,revenue})),
    recentDone: [...done].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5),
    loyaltyAlerts: loyalty.enabled?h.getAll('customers').filter(c=>(c.loyaltyVisits||c.loyaltyPoints||0)>=(loyalty.visitsForReward||10)):[],
  });
}));

// ── AI receptionist attribution (per shop, date range) ──────────────────────────
// "Revenue recovered" = revenue from CLOSED (done) jobs joined via booking_id to
// AI-answered calls the shop did NOT pick up. It only counts staff-not-answered
// calls, so it's money the AI recovered that a missed call would otherwise lose.
// Date range via ?from=YYYY-MM-DD&to=YYYY-MM-DD (either optional). Calls are
// windowed by call_started_at; a call is "AI-answered" if it has voiceAI state.
router.get('/api/shop/receptionist/attribution', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const from = String(req.query.from || '').slice(0, 10);
  const to   = String(req.query.to   || '').slice(0, 10);
  const inRange = d => { const day = String(d || '').slice(0, 10); return (!from || day >= from) && (!to || day <= to); };

  const aiCalls = h.getAll('calls').filter(c => c && c.voiceAI && inRange(c.call_started_at || c.startedAt));
  const staffMissed = aiCalls.filter(c => !c.staff_answered); // AI answered because staff didn't
  const apptById = new Map(h.getAll('appointments').map(a => [a.id, a]));

  let revenueRecovered = 0, recoveredJobs = 0;
  staffMissed.forEach(c => {
    const a = c.booking_id ? apptById.get(c.booking_id) : null;
    if (a && a.status === 'done') { revenueRecovered += Number(a.price || 0); recoveredJobs++; }
  });

  const byOutcome = aiCalls.reduce((m, c) => { const k = c.outcome || 'lost'; m[k] = (m[k] || 0) + 1; return m; }, {});
  res.json({
    from: from || null, to: to || null,
    aiAnswered: aiCalls.length,
    staffNotAnswered: staffMissed.length,
    revenueRecovered: Math.round(revenueRecovered * 100) / 100,
    recoveredJobs,
    byOutcome,
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
// Owner resets their own shop's CRM PIN. Requires a full-owner session — the old
// shared-OWNER_KEY backdoor allowed anyone to reset any shop's PIN + enumerate emails.
router.post('/api/shop/auth/reset-pin', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  db.get('settings').assign({ pin: String(req.body.newPin || '1234') }).write();
  res.json({ ok: true });
}));

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
  // Website-intake leads (routes/website-leads.router.js) may carry a base64
  // photo — never ship it in the list payload.
  const leads = h.getAll('leads').map(({ photo, ...l }) => ({
    ...l,
    has_photo: !!photo,
    calls: calls.filter(c => c.leadId === l.id).sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt)),
  }));
  leads.sort((a,b) => new Date(b.lastContactAt || b.updated_at || b.created_at || 0) - new Date(a.lastContactAt || a.updated_at || a.created_at || 0));
  res.json(leads);
}));

// Pipeline stages: new → … → closed (won), with lost as the dead-end. The
// middle stages are owner-configurable (settings.pipeline.stages), so accept
// any configured key plus the built-in set — default shops carry no config.
// closed used to double as "dead"; lost now holds that meaning, and a won
// close is stamped with closedAt.
function shopStageKeys(db) {
  const builtinStages = ['new','contacted','quoted','booked','worked','closed','lost'];
  const cfgStages = (((db.get('settings').value() || {}).pipeline) || {}).stages;
  return new Set(builtinStages.concat(
    Array.isArray(cfgStages) ? cfgStages.map(s => s && s.key).filter(Boolean) : []));
}

// Apply a (validated) pipeline status to a lead with all its bookkeeping —
// shared by the single-lead update and the bulk clean-out endpoint so a bulk
// move behaves exactly like tapping each lead by hand.
function applyLeadStatus(lead, status, via) {
  const now = new Date().toISOString();
  const prevStage = lead.pipelineStatus || lead.status;
  if (lead.channel === 'website') {
    // Website-intake leads run the Response Center's richer status machine
    // (routes/website-leads.router.js). Map the pipeline stages onto it and
    // stamp the same first-response fields its endpoints stamp, so both
    // views stay coherent whichever one the owner works from. The granular
    // stage (quoted/worked…) survives in pipelineStatus, which the client's
    // _normalizeLead prefers when rendering.
    // Custom (owner-created) stages are always mid-funnel → CONTACTED.
    const mapped = { new:'NEW_LEAD', contacted:'CONTACTED', quoted:'CONTACTED', booked:'APPOINTMENT_SET', worked:'APPOINTMENT_SET', closed:'COMPLETED', lost:'LOST' }[status] || 'CONTACTED';
    if (lead.status === 'NEW_LEAD' && mapped !== 'NEW_LEAD' && !lead.first_response_at) {
      lead.first_response_at = now;
      lead.response_time_seconds = Math.max(0, Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 1000));
      if (lead.contact_status === 'UNCONTACTED') lead.contact_status = 'ATTEMPTED';
    }
    lead.status = mapped;
    lead.pipelineStatus = status;
    lead.updated_at = now;
  } else {
    // Speed-to-lead metric: the first move off 'new' is the shop's first
    // response (owner texted via the sms: deep link or called back, then set
    // the status). Stamped once, server-side, so response times are durable.
    if (lead.status === 'new' && status !== 'new' && !lead.firstResponseAt) lead.firstResponseAt = now;
    lead.status = status;
  }
  // Stage timing, stamped server-side so the Pipeline board's follow-up
  // intervals measure real time-in-stage across devices.
  if (prevStage !== status) {
    lead.stageChangedAt = now;
    lead.stageLog = lead.stageLog || [];
    // `via` = forensics for "it moved by itself" reports: manual | bulk | convert.
    lead.stageLog.push({ from: prevStage, to: status, at: now, via: via || 'manual' });
    if (status === 'closed' && !lead.closedAt) lead.closedAt = now;
    // Lost stamps; a reopened lead sheds them so old reasons don't haunt it.
    if (status === 'lost' && !lead.lostAt) lead.lostAt = now;
    if (prevStage === 'lost' && status !== 'lost') { lead.lostAt = null; lead.lostReason = null; }
    // Booking/losing a lead ends its 30-day follow-up sequence automatically
    // (built-in stage keys; custom won stages are hidden from the queue by the
    // client's chaseable check either way). Manually resumable from the modal.
    const fu = lead.followUp;
    if (fu && (fu.status === 'active' || fu.status === 'paused')) {
      if (['booked', 'worked', 'closed'].includes(status)) fu.status = 'completed';
      else if (status === 'lost') fu.status = 'stopped';
    }
  }
}

// Sanitize a client-sent followUp state (the 30-day sequence bookkeeping).
// Bounded shapes only — never trust free-form structures into the db.
function cleanFollowUp(v) {
  if (!v || typeof v !== 'object') return undefined;
  const statuses = ['active', 'paused', 'completed', 'stopped', 'done'];
  const iso = (x) => (x && !isNaN(Date.parse(x))) ? new Date(x).toISOString() : null;
  return {
    idx: Math.max(0, Math.min(200, parseInt(v.idx, 10) || 0)),
    status: statuses.includes(v.status) ? v.status : 'active',
    nextAt: iso(v.nextAt),
    startedAt: iso(v.startedAt) || new Date().toISOString(),
    pausedReason: v.pausedReason ? String(v.pausedReason).slice(0, 30) : null,
    log: (Array.isArray(v.log) ? v.log.slice(0, 100) : []).map(e => ({
      step: String((e && e.step) || '').slice(0, 40),
      day: Math.max(0, Number(e && e.day) || 0),
      body: e && e.body ? String(e.body).slice(0, 500) : undefined,
      at: iso(e && e.at) || new Date().toISOString(),
      by: String((e && e.by) || '').slice(0, 60),
      skipped: e && e.skipped ? true : undefined,
    })),
  };
}

// Bulk clean-out (Pipeline → Select): move up to 500 leads to one stage in a
// single call. Registered BEFORE /api/shop/leads/:id so "bulk-status" is never
// captured as an :id.
router.post('/api/shop/leads/bulk-status', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 500) : [];
  const status = req.body.status;
  if (!ids.length || !shopStageKeys(db).has(status)) return res.status(400).json({ ok:false, error:'Bad request' });
  // A bulk mark-lost sweep can carry one shared reason for the whole batch.
  const lostReason = status === 'lost' && req.body.lostReason ? String(req.body.lostReason).trim().slice(0, 200) : null;
  let updated = 0;
  ids.forEach(id => {
    const lead = h.getById('leads', id);
    if (lead) { if (lostReason) lead.lostReason = lostReason; applyLeadStatus(lead, status, 'bulk'); h.upsert('leads', lead); updated++; }
  });
  res.json({ ok:true, updated });
}));

// Merge duplicate leads (owner only). Groups by last-10-digit phone
// (leads-core.phoneKey) — the E.164-vs-national format mismatch let the Meta
// webhook, Twilio calls, and the website form each create their own copy of
// the same person. The oldest record survives; every other copy's history
// (notes, stage log, calls, conversations, follow-up sequence, quote) is
// folded into it and the copy is removed. Website-channel leads are skipped
// (different schema — the Response Center owns those).
function mergeLeadInto(p, d, stageOrder) {
  const rank = (s) => stageOrder.indexOf(s);
  p.name = p.name || d.name;
  p.phone = p.phone || d.phone;
  p.email = p.email || d.email;
  p.vehicle = p.vehicle || d.vehicle;
  p.location = p.location || d.location;
  p.utm = p.utm || d.utm;
  p.referrer = p.referrer || d.referrer;
  if (d.notes) p.notes = [p.notes, d.notes].filter(Boolean).join('\n');
  p.noteLog = (p.noteLog || []).concat(d.noteLog || []).sort((a, b) => new Date(b.at) - new Date(a.at));
  p.servicesInterested = Array.from(new Set([...(p.servicesInterested || []), ...(d.servicesInterested || [])]));
  p.stageLog = (p.stageLog || []).concat(d.stageLog || []).sort((a, b) => new Date(a.at) - new Date(b.at));
  p.callCount = (p.callCount || 0) + (d.callCount || 0);
  p.missedCount = (p.missedCount || 0) + (d.missedCount || 0);
  p.formSubmits = (p.formSubmits || 0) + (d.formSubmits || 0);
  if (d.quotedAmount != null && p.quotedAmount == null) p.quotedAmount = d.quotedAmount;
  p.ai = p.ai || d.ai;
  p.customerId = p.customerId || d.customerId;
  // Keep whichever copy is furthest down the pipeline, and prefer a real ad
  // channel over the bare 'call' attribution.
  if (rank(d.status) > rank(p.status)) { p.status = d.status; p.stageChangedAt = d.stageChangedAt || p.stageChangedAt; }
  if ((p.source || 'call') === 'call' && d.source && d.source !== 'call') p.source = d.source;
  if (d.followUp && (!p.followUp || (d.followUp.idx || 0) > (p.followUp.idx || 0))) p.followUp = d.followUp;
  p.dripLog = Object.assign({}, d.dripLog || {}, p.dripLog || {});
  if (d.createdAt && (!p.createdAt || d.createdAt < p.createdAt)) p.createdAt = d.createdAt;
  if (d.firstContactAt && (!p.firstContactAt || d.firstContactAt < p.firstContactAt)) p.firstContactAt = d.firstContactAt;
  if (d.lastContactAt && (!p.lastContactAt || d.lastContactAt > p.lastContactAt)) p.lastContactAt = d.lastContactAt;
  if (d.firstResponseAt && (!p.firstResponseAt || d.firstResponseAt < p.firstResponseAt)) p.firstResponseAt = d.firstResponseAt;
  if (d.closedAt && !p.closedAt) p.closedAt = d.closedAt;
}

router.post('/api/shop/leads/dedupe', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const { phoneKey } = require('../leads-core');
  const stageOrder = Array.from(shopStageKeys(db));
  const groups = {};
  h.getAll('leads').forEach(l => {
    if (!l || l.channel === 'website') return;
    const k = phoneKey(l.phone);
    if (k) (groups[k] = groups[k] || []).push(l);
  });
  let merged = 0;
  Object.values(groups).forEach(g => {
    if (g.length < 2) return;
    g.sort((a, b) => new Date(a.createdAt || a.firstContactAt || 0) - new Date(b.createdAt || b.firstContactAt || 0));
    const primary = g[0];
    for (let i = 1; i < g.length; i++) {
      const dup = g[i];
      mergeLeadInto(primary, dup, stageOrder);
      // Re-home the duplicate's call and message history before it goes.
      (db.get('calls').value() || []).forEach(c => { if (c.leadId === dup.id) c.leadId = primary.id; });
      (db.get('conversations').value() || []).forEach(c => { if (c.leadId === dup.id) c.leadId = primary.id; });
      h.remove('leads', dup.id);
      merged++;
    }
    h.upsert('leads', primary);
  });
  db.get('calls').write();
  res.json({ ok: true, merged });
}));

// Bulk delete (owner only, like single delete): removes the leads and their
// call logs. The client confirms before calling — this is irreversible.
router.post('/api/shop/leads/bulk-delete', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ ok:false, error:'Bad request' });
  let deleted = 0;
  ids.forEach(id => {
    if (h.getById('leads', id)) {
      db.get('calls').remove({ leadId: id }).write();
      h.remove('leads', id);
      deleted++;
    }
  });
  res.json({ ok:true, deleted });
}));

// Update editable lead fields (name, status, notes).
router.post('/api/shop/leads/:id', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const lead = h.getById('leads', req.params.id);
  if (!lead) return res.status(404).json({ ok:false, error:'Lead not found' });
  const { name, status, notes } = req.body;
  if (name   !== undefined) lead.name = String(name).slice(0,80);
  if (notes  !== undefined) lead.notes = String(notes).slice(0,2000);
  // Why the lead died — picked when marking lost; feeds the loss-reason report.
  if (req.body.lostReason !== undefined) lead.lostReason = req.body.lostReason === null ? null : String(req.body.lostReason).trim().slice(0,200);
  // Source is editable so mis-attributed leads (e.g. a Meta lead that came in
  // as a bare call) can be fixed — it drives the channel split + Meta filter.
  // utm.source is kept in sync so both attribution reads stay coherent.
  if (req.body.source !== undefined) {
    const src = String(req.body.source).trim().toLowerCase().slice(0, 40);
    if (src) {
      lead.source = src;
      if (lead.utm && typeof lead.utm === 'object') lead.utm.source = src;
    }
  }
  // Owner-entered quote value — drives the pipeline's per-column revenue
  // totals. Overrides the AI receptionist's detected quotedPrice; null clears.
  if (req.body.quotedAmount !== undefined) {
    const q = Number(req.body.quotedAmount);
    lead.quotedAmount = (Number.isFinite(q) && q > 0) ? Math.round(q * 100) / 100 : null;
  }
  // 30-day sequence state (Tasks page queue). Sends are manual (sms: deep link
  // client-side); this just persists the bookkeeping. Deliberately does NOT
  // touch lastContactAt: that clock means CUSTOMER activity (calls, form
  // submits). Owner touches bumping it made every worked lead leap to the top
  // of the Leads list stamped with the touch time — reading as a brand-new
  // lead. Owner-side send times live in followUp.log / dripLog / noteLog.
  if (req.body.followUp !== undefined) {
    const fu = cleanFollowUp(req.body.followUp);
    if (fu) {
      // A grown log = a sequence text went out → reset the "late" timer too.
      if (fu.log.length > ((lead.followUp || {}).log || []).length) lead.followTouchAt = new Date().toISOString();
      lead.followUp = fu;
    }
  }
  // By-day follow-up bookkeeping: the owner tapped the day-N text button (the
  // sms: deep link opened Messages prefilled on their phone). Stamps the marker
  // so the card shows "texted" and logs it in the lead's note history.
  if (req.body.dripDay !== undefined) {
    const d = parseInt(req.body.dripDay, 10);
    if (d > 0) {
      const now = new Date().toISOString();
      lead.dripLog = lead.dripLog || {};
      lead.dripLog['d' + d] = now;
      // No lastContactAt bump — owner touches must not reorder the Leads list
      // (see the followUp comment above). followTouchAt resets the "late" timer.
      lead.followTouchAt = now;
      lead.noteLog = lead.noteLog || [];
      lead.noteLog.unshift({ id: genId('note'), text: `Day-${d} follow-up text sent`, at: now, by: String(req.body.by || '').slice(0, 60) });
    }
  }
  if (status !== undefined && shopStageKeys(db).has(status)) applyLeadStatus(lead, status);
  h.upsert('leads', lead);
  res.json({ ok:true, lead });
}));

// Notes history: append a timestamped note to the lead (newest first). Mirrors
// the client noteLog — the "by" name comes from the signed-in user client-side.
router.post('/api/shop/leads/:id/note', requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const lead = h.getById('leads', req.params.id);
  if (!lead) return res.status(404).json({ ok:false, error:'Lead not found' });
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok:false, error:'Note is empty' });
  lead.noteLog = lead.noteLog || [];
  lead.noteLog.unshift({ id: genId('note'), text, at: new Date().toISOString(), by: String(req.body.by || '').slice(0, 60) });
  // Saving a note = the owner worked this lead → reset the board's follow-up
  // ("late") timer. Deliberately NOT lastContactAt (customer-only clock).
  lead.followTouchAt = new Date().toISOString();
  h.upsert('leads', lead);
  res.json({ ok:true, noteLog: lead.noteLog });
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
    const digitsAll = String(lead.phone||'').replace(/\D/g,'');
    const digits = digitsAll.length >= 10 ? digitsAll.slice(-10) : '';   // junk/short phones never match
    cust = h.getAll('customers').find(c => String(c.phone||'').replace(/\D/g,'').slice(-10) === digits && digits);
  }
  if (!cust) {
    cust = { id: genId('c'), name: lead.name || lead.phone, phone: lead.phone, email: lead.email || '', source: lead.source || 'call',
             notes: lead.notes || '', noteLog: (lead.noteLog || []).slice(), loyaltyPoints: 0, noShows: 0, preferredBarberId: null,
             isFleet: false, companyName: '', vehicles: lead.vehicle ? [lead.vehicle] : [], createdAt: today() };
    h.upsert('customers', cust);
  }
  lead.customerId = cust.id;
  // Converting implies the work is booked: move the lead up to the BOOKED
  // stage — and never past it. The stage keyed 'booked' wins whenever it
  // exists (renames keep the key); only a pipeline with no booked stage falls
  // back to its first won middle stage; with neither, the stage stays put.
  // (The old "first won-flagged stage" resolver shot converted leads into
  // Worked — or even Closed — on custom configs where booked wasn't flagged.)
  {
    const cfg = (((db.get('settings').value() || {}).pipeline) || {}).stages;
    const stages = (Array.isArray(cfg) && cfg.length) ? cfg : null;
    const keys = stages ? stages.map(s => s && s.key) : ['new','contacted','quoted','booked','worked','closed','lost'];
    const wonKey = keys.includes('booked')
      ? 'booked'
      : (stages ? (((stages.find(s => s && s.won && !s.terminal)) || {}).key || null) : 'booked');
    const curIdx = keys.indexOf(lead.status);
    if (wonKey && lead.status !== 'lost' && (curIdx === -1 || curIdx < keys.indexOf(wonKey))) {
      lead.stageLog = (lead.stageLog || []).concat({ from: lead.status, to: wonKey, at: new Date().toISOString(), via: 'convert' });
      lead.status = wonKey;
      lead.stageChangedAt = new Date().toISOString();
    }
  }
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
    // Texting does NOT move the pipeline stage — stage moves are always the
    // owner's explicit call (advance/back buttons, status pills, bulk move).
    // Response-time metrics still get stamped: the text IS the first response.
    if (lead.channel === 'website' && !lead.first_response_at) {
      lead.first_response_at = new Date().toISOString();
      lead.response_time_seconds = Math.max(0, Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 1000));
      if (lead.contact_status === 'UNCONTACTED') lead.contact_status = 'ATTEMPTED';
      lead.updated_at = new Date().toISOString();
    }
    if (!lead.firstResponseAt) lead.firstResponseAt = new Date().toISOString();
    // No lastContactAt bump — that clock is customer activity only; an owner
    // outbound text reordering the Leads list read as a phantom new lead.
    h.upsert('leads', lead);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
}));

// Stream a call's audio (voicemail OR the answered-call recording), proxied with
// Twilio auth so the media URL and account creds are never exposed to the browser.
// `?kind=recording` serves the bridged-call recording; default is the voicemail.
// Registered on both /voicemail (back-compat) and /call-media.
router.get(['/api/shop/voicemail/:callId','/api/shop/call-media/:callId'], requireAuth, requireRole('full','technician'), shopRoute(async (req, res, db, h) => {
  const call = h.getById('calls', req.params.callId);
  const kind = req.query.kind === 'recording' ? 'recording' : 'voicemail';
  const media = call && call[kind];
  const sid = media && media.recordingSid;
  const acct = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  // Distinct causes get distinct messages so a failed Play button is diagnosable.
  if (!sid)            return res.status(404).json({ ok:false, error:`No ${kind==='recording'?'call recording':'voicemail recording'} is attached to this call.` });
  if (!acct || !token) return res.status(503).json({ ok:false, error:'Playback needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN set in the server environment.' });
  if (typeof fetch !== 'function') return res.status(500).json({ ok:false, error:'Server Node runtime is too old for playback (needs the built-in fetch, Node 18+).' });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acct}/Recordings/${sid}.mp3`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${acct}:${token}`).toString('base64') },
    });
    if (!r.ok) {
      console.error(`Voicemail fetch ${sid} -> HTTP ${r.status}`);
      return res.status(502).json({ ok:false, error:`Twilio returned ${r.status} for the recording${r.status===404?' (still processing, or it belongs to a different Twilio account).':'.'}` });
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { console.error('Voicemail proxy error:', e.message); res.status(502).json({ ok:false, error:e.message }); }
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

// ── PROTECTED: Deposit (owner only) ───────────────────────────────────────────
// Manual/owner-side mark that a deposit was collected out-of-band. Owner-only:
// this flips an appointment to confirmed and records a deposit amount, so it must
// never be reachable by technician/viewonly roles. (Automated deposit capture goes
// through the verified Stripe/Square return + webhook paths, not this route.)
router.post('/api/shop/deposit/confirm', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const { appointmentId, paymentIntentId, amount } = req.body;
  const a = h.getById('appointments', appointmentId); if(!a) return res.status(404).json({ ok:false });
  a.depositPaid=true; a.depositAmount=Number(amount) || 0; a.depositPaymentId=paymentIntentId; a.status='confirmed';
  h.upsert('appointments',a); res.json({ ok: true });
}));

// ── PROTECTED: Feature flags for current shop ─────────────────────────────────
router.get('/api/shop/features', requireAuth, (req, res) => {
  const shop = master.get('shops').find({ id: req.shopId }).value();
  const features = (shop && shop.features) || {};
  res.json({ manualSms: features.manualSms !== false }); // default ON
});

module.exports = router;

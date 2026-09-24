// ── Sales Hub routes ─────────────────────────────────────────────────────────
// Global (not per-shop) resource stored in master.json under `sales`.
// PIN-gated: rep logs in with a numeric PIN, gets a JWT, and all data
// (leads, goals, activity, settings) lives on the server.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { master, JWT_SECRET, genId, today } = require('../db');
const { requireAdmin } = require('../middleware');

const DEFAULT_PIN = '1234';

// ── Helpers ───────────────────────────────────────────────────────────────────
function sales() { return master.get('sales'); }

// Make sure the sales blob exists and has a PIN. Runs lazily so we don't need
// async work inside db.defaults(). Returns the sales value.
async function ensureSales() {
  if (!master.has('sales').value()) {
    master.set('sales', {
      pinHash: null, repName: 'Bryce Moen', leads: [], goals: [], todos: [],
      activity: { dms: 0, walkins: 0, demos: 0, weekStart: null },
      daily: { date: null, dms: 0, walkins: 0, demos: 0 },
      settings: {
        weeklyTargets: { dms: 50, walkins: 5, demos: 5 },
        dailyTargets:  { dms: 10, walkins: 1, demos: 1 },
        focusNote: '',
      },
      history: [],
    }).write();
  }
  // Lazy migrations for older sales blobs.
  if (!sales().has('todos').value()) sales().set('todos', []).write();
  if (!sales().has('daily').value()) sales().set('daily', { date: null, dms: 0, walkins: 0, demos: 0 }).write();
  if (!sales().get('settings.dailyTargets').value()) sales().get('settings').assign({ dailyTargets: { dms: 10, walkins: 1, demos: 1 } }).write();
  if (sales().get('settings.focusNote').value() === undefined) sales().get('settings').assign({ focusNote: '' }).write();
  if (!sales().get('pinHash').value()) {
    const hash = await bcrypt.hash(DEFAULT_PIN, 10);
    sales().assign({ pinHash: hash }).write();
  }
  return sales().value();
}

// Everything safe to send to the client (no pinHash).
function publicState() {
  const s = sales().value();
  return {
    rep:      { name: s.repName },
    leads:    s.leads    || [],
    goals:    s.goals    || [],
    todos:    s.todos    || [],
    activity: s.activity || { dms: 0, walkins: 0, demos: 0 },
    daily:    todayDaily(),
    settings: s.settings || { weeklyTargets: { dms: 50, walkins: 5, demos: 5 }, dailyTargets: { dms: 10, walkins: 1, demos: 1 }, focusNote: '' },
    history:  s.history  || [],
  };
}

// Returns today's daily counters, rolling them over if the stored date isn't today.
function todayDaily() {
  const d = sales().get('daily').value() || { date: null, dms: 0, walkins: 0, demos: 0 };
  return d.date === today() ? d : { date: today(), dms: 0, walkins: 0, demos: 0 };
}

// Roll the daily counters to today (resets at midnight). Persists if it changed.
function rollDaily() {
  const d = sales().get('daily').value() || {};
  if (d.date !== today()) sales().set('daily', { date: today(), dms: 0, walkins: 0, demos: 0 }).write();
}

// Roll the weekly counters when a new week starts (snapshots the finished week).
function rollWeekly() {
  const a = sales().get('activity').value() || {};
  const wk = startOfWeek();
  if (!a.weekStart) { sales().get('activity').assign({ weekStart: wk }).write(); return; }
  if (a.weekStart < wk) {
    if ((a.dms || 0) + (a.walkins || 0) + (a.demos || 0) > 0) {
      sales().get('history').unshift({ weekStart: a.weekStart, weekEnd: wk, dms: a.dms || 0, walkins: a.walkins || 0, demos: a.demos || 0 }).write();
      const hist = sales().get('history').value();
      if (hist.length > 26) sales().set('history', hist.slice(0, 26)).write();
    }
    sales().get('activity').assign({ dms: 0, walkins: 0, demos: 0, weekStart: wk }).write();
  }
}

function signToken() {
  return jwt.sign({ role: 'sales', repId: 'bryce' }, JWT_SECRET, { expiresIn: '90d' });
}

// ── Auth middleware ─────────────────────────────────────────────────────────
function requireSales(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'sales') return res.status(401).json({ error: 'Invalid session' });
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Wrap an async handler so it always ensures the sales blob first.
function salesRoute(fn) {
  return async (req, res) => {
    try { await ensureSales(); await fn(req, res); }
    catch (e) { console.error('Sales route error:', e.message); res.status(500).json({ error: 'Server error' }); }
  };
}

// ── Login ───────────────────────────────────────────────────────────────────
router.post('/api/sales/login', salesRoute(async (req, res) => {
  const pin = String(req.body.pin || '').trim();
  if (!pin) return res.status(400).json({ ok: false, error: 'Enter your PIN' });
  const ok = await bcrypt.compare(pin, sales().get('pinHash').value());
  if (!ok) return res.status(401).json({ ok: false, error: 'Wrong PIN' });
  res.json({ ok: true, token: signToken(), state: publicState() });
}));

// ── Read full state ───────────────────────────────────────────────────────────
router.get('/api/sales/state', requireSales, salesRoute(async (req, res) => {
  rollDaily(); rollWeekly();
  res.json({ ok: true, state: publicState() });
}));

// ── Track activity — one tap counts toward today AND this week ─────────────────
router.post('/api/sales/track', requireSales, salesRoute(async (req, res) => {
  const type = req.body.type;
  if (!['dms', 'walkins', 'demos'].includes(type)) return res.status(400).json({ ok: false, error: 'Bad type' });
  const delta = parseInt(req.body.delta, 10) || 0;
  rollDaily(); rollWeekly();
  const d = sales().get('daily').value();
  const a = sales().get('activity').value();
  sales().get('daily').assign({ [type]: Math.max(0, (d[type] || 0) + delta) }).write();
  sales().get('activity').assign({ [type]: Math.max(0, (a[type] || 0) + delta) }).write();
  res.json({ ok: true, state: publicState() });
}));

// ── Leads: create / update (upsert) ───────────────────────────────────────────
// Shared lead upsert — used by both the rep and the admin routes.
// Returns { error } or { lead }.
function buildLead(b) {
  const name = String(b.name || '').trim();
  if (!name) return { error: 'Name required' };
  const now = new Date().toISOString();
  const leads = sales().get('leads');
  const existing = b.id ? leads.find({ id: b.id }).value() : null;

  const lead = {
    // Keep fields this form doesn't know about (Google import: website,
    // rating, placeId…) — the whitelisted fields below still win.
    ...(existing || {}),
    id:       existing ? existing.id : genId('lead'),
    name,
    contact:  String(b.contact || '').trim(),
    city:     String(b.city || '').trim(),
    // Territory-map pin. The rep's hub never sends these, so a missing key
    // keeps what's stored instead of wiping the pin on every rep edit.
    address:  b.address !== undefined ? String(b.address || '').trim() : (existing?.address || ''),
    lat:      b.lat !== undefined ? coord(b.lat, 90)  : (existing?.lat ?? null),
    lng:      b.lng !== undefined ? coord(b.lng, 180) : (existing?.lng ?? null),
    territory: b.territory !== undefined ? String(b.territory || '').trim().slice(0, 40) : (existing?.territory || ''),
    method:   b.method || 'Instagram DM',
    tool:     b.tool   || 'Nothing / texts',
    status:   b.status || 'contacted',
    plan:     b.plan   || 'Starter — $19.99',
    value:    Number(b.value) || planValue(b.plan),
    followup: b.followup || '',
    notes:    String(b.notes || '').trim(),
    log:      existing ? (existing.log || []) : [],
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    lastContact: existing ? existing.lastContact : now,
    closedAt: existing ? existing.closedAt : null,
  };
  // Stamp a close date the first time a lead is marked closed.
  if (lead.status === 'closed' && !lead.closedAt) lead.closedAt = now;
  if (lead.status !== 'closed') lead.closedAt = null;

  if (existing) leads.find({ id: lead.id }).assign(lead).write();
  else          leads.unshift(lead).write();
  return { lead };
}

router.post('/api/sales/leads', requireSales, salesRoute(async (req, res) => {
  const { error } = buildLead(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  res.json({ ok: true, state: publicState() });
}));

// ── Leads: log a touch (call/DM/note) ─────────────────────────────────────────
router.post('/api/sales/leads/:id/log', requireSales, salesRoute(async (req, res) => {
  const lead = sales().get('leads').find({ id: req.params.id });
  if (!lead.value()) return res.status(404).json({ ok: false, error: 'Lead not found' });
  const now = new Date().toISOString();
  const entry = { id: genId('log'), at: now, type: req.body.type || 'note', text: String(req.body.text || '').trim() };
  const log = lead.value().log || [];
  lead.assign({ log: [entry, ...log], lastContact: now, updatedAt: now }).write();
  res.json({ ok: true, state: publicState() });
}));

// ── Leads: delete ─────────────────────────────────────────────────────────────
router.delete('/api/sales/leads/:id', requireSales, salesRoute(async (req, res) => {
  sales().get('leads').remove({ id: req.params.id }).write();
  res.json({ ok: true, state: publicState() });
}));

// ── Goals: create / update ─────────────────────────────────────────────────────
function buildGoal(b) {
  const name   = String(b.name || '').trim();
  const target = parseInt(b.target, 10) || 0;
  if (!name || !target) return { error: 'Name and target required' };
  const goals = sales().get('goals');
  const existing = b.id ? goals.find({ id: b.id }).value() : null;
  const goal = {
    id: existing ? existing.id : genId('goal'),
    name, target,
    current: existing ? existing.current : (parseInt(b.current, 10) || 0),
    deadline: b.deadline || '',
    type: b.type || 'clients',
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
  if (existing) goals.find({ id: goal.id }).assign(goal).write();
  else          goals.push(goal).write();
  return { goal };
}

router.post('/api/sales/goals', requireSales, salesRoute(async (req, res) => {
  const { error } = buildGoal(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  res.json({ ok: true, state: publicState() });
}));

router.post('/api/sales/goals/:id/inc', requireSales, salesRoute(async (req, res) => {
  const goal = sales().get('goals').find({ id: req.params.id });
  if (!goal.value()) return res.status(404).json({ ok: false, error: 'Goal not found' });
  const g = goal.value();
  goal.assign({ current: Math.min(g.target, (g.current || 0) + (parseInt(req.body.delta, 10) || 1)) }).write();
  res.json({ ok: true, state: publicState() });
}));

router.delete('/api/sales/goals/:id', requireSales, salesRoute(async (req, res) => {
  sales().get('goals').remove({ id: req.params.id }).write();
  res.json({ ok: true, state: publicState() });
}));

// ── To-Dos: rep toggles done (owner assigns them via admin) ───────────────────
router.post('/api/sales/todos/:id/toggle', requireSales, salesRoute(async (req, res) => {
  const todo = sales().get('todos').find({ id: req.params.id });
  if (!todo.value()) return res.status(404).json({ ok: false, error: 'To-do not found' });
  const done = !todo.value().done;
  todo.assign({ done, doneAt: done ? new Date().toISOString() : null }).write();
  res.json({ ok: true, state: publicState() });
}));

// ── Activity: set counters + targets ───────────────────────────────────────────
router.put('/api/sales/activity', requireSales, salesRoute(async (req, res) => {
  const b = req.body || {};
  const a = sales().get('activity').value() || {};
  const updates = {};
  ['dms', 'walkins', 'demos'].forEach(k => { if (b[k] !== undefined) updates[k] = Math.max(0, parseInt(b[k], 10) || 0); });
  if (!a.weekStart) updates.weekStart = startOfWeek();
  sales().get('activity').assign(updates).write();
  if (b.weeklyTargets) {
    sales().get('settings').assign({ weeklyTargets: {
      dms:     Math.max(1, parseInt(b.weeklyTargets.dms, 10)     || 50),
      walkins: Math.max(1, parseInt(b.weeklyTargets.walkins, 10) || 5),
      demos:   Math.max(1, parseInt(b.weeklyTargets.demos, 10)   || 5),
    } }).write();
  }
  res.json({ ok: true, state: publicState() });
}));

// ── Activity: reset week (snapshots into history) ─────────────────────────────
router.post('/api/sales/activity/reset', requireSales, salesRoute(async (req, res) => {
  const a = sales().get('activity').value() || {};
  sales().get('history').unshift({
    weekStart: a.weekStart || startOfWeek(),
    weekEnd: new Date().toISOString(),
    dms: a.dms || 0, walkins: a.walkins || 0, demos: a.demos || 0,
  }).write();
  // keep last 26 weeks
  const hist = sales().get('history').value();
  if (hist.length > 26) sales().set('history', hist.slice(0, 26)).write();
  sales().get('activity').assign({ dms: 0, walkins: 0, demos: 0, weekStart: startOfWeek() }).write();
  res.json({ ok: true, state: publicState() });
}));

// ── Settings: rep name etc. ────────────────────────────────────────────────────
router.patch('/api/sales/settings', requireSales, salesRoute(async (req, res) => {
  const b = req.body || {};
  if (b.repName !== undefined && String(b.repName).trim()) sales().assign({ repName: String(b.repName).trim() }).write();
  if (b.weeklyTargets) sales().get('settings').assign({ weeklyTargets: cleanTargets(b.weeklyTargets, { dms: 50, walkins: 5, demos: 5 }) }).write();
  if (b.dailyTargets)  sales().get('settings').assign({ dailyTargets:  cleanTargets(b.dailyTargets,  { dms: 10, walkins: 1, demos: 1 }) }).write();
  res.json({ ok: true, state: publicState() });
}));

// ── Settings: change PIN ───────────────────────────────────────────────────────
router.post('/api/sales/pin', requireSales, salesRoute(async (req, res) => {
  const current = String(req.body.currentPin || '').trim();
  const next    = String(req.body.newPin || '').trim();
  if (!/^\d{4,8}$/.test(next)) return res.status(400).json({ ok: false, error: 'PIN must be 4–8 digits' });
  const ok = await bcrypt.compare(current, sales().get('pinHash').value());
  if (!ok) return res.status(401).json({ ok: false, error: 'Current PIN is wrong' });
  const hash = await bcrypt.hash(next, 10);
  sales().assign({ pinHash: hash }).write();
  res.json({ ok: true });
}));

// Everything the admin Sales page needs in one shape.
function adminSalesPayload() {
  rollDaily(); rollWeekly();
  const s = publicState();
  const closed = s.leads.filter(l => l.status === 'closed');
  return {
    repName: s.rep.name,
    totals: {
      leads:    s.leads.filter(l => l.status !== 'not-contacted').length,
      prospects: s.leads.filter(l => l.status === 'not-contacted').length,
      closed:   closed.length,
      pipeline: s.leads.filter(l => ['contacted', 'responded', 'demo'].includes(l.status)).length,
      mrrClosed: closed.reduce((sum, l) => sum + (Number(l.value) || 0), 0),
    },
    leads:    s.leads,
    goals:    s.goals,
    todos:    s.todos,
    activity: s.activity,
    daily:    s.daily,
    settings: s.settings,
  };
}

// ── Admin: view the rep's full data ───────────────────────────────────────────
router.get('/api/admin/sales', requireAdmin, salesRoute(async (req, res) => {
  res.json(adminSalesPayload());
}));

// ── Admin: assign / delete to-dos ─────────────────────────────────────────────
router.post('/api/admin/sales/todos', requireAdmin, salesRoute(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'To-do text required' });
  sales().get('todos').unshift({
    id: genId('todo'), text, due: req.body.due || '',
    done: false, doneAt: null, createdAt: new Date().toISOString(),
  }).write();
  res.json({ ok: true, ...adminSalesPayload() });
}));
router.delete('/api/admin/sales/todos/:id', requireAdmin, salesRoute(async (req, res) => {
  sales().get('todos').remove({ id: req.params.id }).write();
  res.json({ ok: true, ...adminSalesPayload() });
}));

// ── Admin: edit the rep's leads ───────────────────────────────────────────────
router.post('/api/admin/sales/leads', requireAdmin, salesRoute(async (req, res) => {
  const { error } = buildLead(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  res.json({ ok: true, ...adminSalesPayload() });
}));
router.delete('/api/admin/sales/leads/:id', requireAdmin, salesRoute(async (req, res) => {
  sales().get('leads').remove({ id: req.params.id }).write();
  res.json({ ok: true, ...adminSalesPayload() });
}));

// ── Admin: edit the rep's goals ───────────────────────────────────────────────
router.post('/api/admin/sales/goals', requireAdmin, salesRoute(async (req, res) => {
  const { error } = buildGoal(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  res.json({ ok: true, ...adminSalesPayload() });
}));
router.delete('/api/admin/sales/goals/:id', requireAdmin, salesRoute(async (req, res) => {
  sales().get('goals').remove({ id: req.params.id }).write();
  res.json({ ok: true, ...adminSalesPayload() });
}));

// ── Admin: rep settings — name, daily/weekly targets, focus note ──────────────
router.patch('/api/admin/sales/settings', requireAdmin, salesRoute(async (req, res) => {
  const b = req.body || {};
  if (b.repName !== undefined && String(b.repName).trim()) sales().assign({ repName: String(b.repName).trim() }).write();
  if (b.focusNote !== undefined) sales().get('settings').assign({ focusNote: String(b.focusNote).slice(0, 280) }).write();
  if (b.weeklyTargets) sales().get('settings').assign({ weeklyTargets: cleanTargets(b.weeklyTargets, { dms: 50, walkins: 5, demos: 5 }) }).write();
  if (b.dailyTargets)  sales().get('settings').assign({ dailyTargets:  cleanTargets(b.dailyTargets,  { dms: 10, walkins: 1, demos: 1 }) }).write();
  res.json({ ok: true, ...adminSalesPayload() });
}));

// ── Admin: geocode an address for the territory map ──────────────────────────
// Proxies OpenStreetMap Nominatim (free, no key) so the request carries a real
// User-Agent per their usage policy. Results are biased to the ABQ / Rio Rancho
// / Los Lunas box but not locked to it. Cached in memory — addresses rarely move.
const GEO_VIEWBOX = '-107.05,35.42,-106.35,34.70'; // W,N,E,S — Rio Rancho down to Los Lunas
const geoCache = new Map();
let geoLast = 0;
router.get('/api/admin/sales/geocode', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q.length < 3) return res.status(400).json({ ok: false, error: 'Type an address' });
  const key = q.toLowerCase();
  if (geoCache.has(key)) return res.json({ ok: true, results: geoCache.get(key) });
  // Nominatim allows 1 req/s — space ours out rather than get blocked.
  const wait = geoLast + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  geoLast = Date.now();
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=us'
      + '&viewbox=' + GEO_VIEWBOX + '&q=' + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ShopFlowHQ/1.0 (support@shopflowtech.com)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: 'Geocoder unavailable' });
    const rows = await r.json();
    const results = (rows || []).map(x => {
      const a = x.address || {};
      return {
        label: x.display_name,
        lat: Number(x.lat), lng: Number(x.lon),
        city: a.city || a.town || a.village || a.hamlet || a.county || '',
      };
    });
    geoCache.set(key, results);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Geocoder timed out' });
  }
});

// ── Admin: import shops from Google Maps (via Apify) ─────────────────────────
// Runs Apify's Google Maps Scraper (compass/crawler-google-places) over the
// metro for detailing / tint / wrap / PPF shops, then adds the ones we don't
// already have as "Not contacted". Needs APIFY_TOKEN.
//
// Apify bills per place scraped (duplicates across search terms count too), so:
//   • every run has a hard cap (maxItems + maxTotalChargeUsd) the admin picks;
//   • no Apify-side filters — those are billed extra per place; we filter here;
//   • the run is remembered in master.sales.importRun, so the preview and the
//     "Add" click both read the finished dataset (free) instead of re-scraping.
// Flow: POST …/start → poll GET …/status until done (shows the preview) → POST …/apply.
const APIFY_ACTOR = 'compass~crawler-google-places';
const APIFY_PRICE_PER_PLACE = 0.004;   // free-tier price; only used to size the charge cap
const IMPORT_KINDS = {
  detailing: { label: 'Detailing',   terms: ['auto detailing', 'ceramic coating'] },
  tint:      { label: 'Tint & wrap', terms: ['car window tinting', 'car wrap', 'paint protection film'] },
};
// Rio Rancho down to Los Lunas / Belen — the search area and the keep-filter.
const METRO = { south: 34.62, west: -106.98, north: 35.36, east: -106.45 };
const SKIP_CATEGORIES = /dealer|gas station|car rental|parking|storage|insurance|towing|tire shop|junkyard|salvage|auto parts/i;
const KEEP_NAMES = /detail|tint|wrap|ppf|ceramic|coating|film|shine|polish|protect/i;

function normName(n) { return String(n || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
function termKind(term) {
  return Object.keys(IMPORT_KINDS).find(k => IMPORT_KINDS[k].terms.includes(String(term || '').toLowerCase())) || null;
}

async function apify(pathAndQuery, opts = {}) {
  const r = await fetch('https://api.apify.com/v2' + pathAndQuery, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + process.env.APIFY_TOKEN, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || ('Apify HTTP ' + r.status));
  return data;
}

// Dataset rows → clean shop records (in-lane, open, inside the metro, one per place).
function shopsFromItems(items) {
  const skipped = { closed: 0, offTopic: 0, outside: 0 };
  const byId = new Map();
  (items || []).forEach(it => {
    const loc = it.location || {};
    if (!it.title || loc.lat == null || loc.lng == null) return;
    const id = it.placeId || normName(it.title) + ':' + loc.lat.toFixed(4);
    const kind = termKind(it.searchString);
    const prev = byId.get(id);
    if (prev) { if (kind) prev.kinds.add(kind); return; }
    if (it.permanentlyClosed) { skipped.closed++; return; }
    if (loc.lat < METRO.south || loc.lat > METRO.north || loc.lng < METRO.west || loc.lng > METRO.east) { skipped.outside++; return; }
    const cats = [it.categoryName, ...(it.categories || [])].filter(Boolean).join(' | ');
    if (SKIP_CATEGORIES.test(cats) && !KEEP_NAMES.test(it.title)) { skipped.offTopic++; return; }
    byId.set(id, {
      kinds: new Set(kind ? [kind] : []),
      shop: {
        placeId: it.placeId || '', name: it.title,
        address: String(it.address || '').replace(/, (USA|United States)$/, ''),
        city: it.city || '', lat: loc.lat, lng: loc.lng,
        contact: it.phone || '', website: it.website || '',
        rating: it.totalScore || null, reviews: it.reviewsCount || 0,
        googleCategory: it.categoryName || '',
      },
    });
  });
  const shops = [...byId.values()].map(({ kinds, shop }) => ({
    ...shop, category: [...kinds].map(k => IMPORT_KINDS[k].label).join(' + ') || shop.googleCategory,
  }));
  return { shops, skipped, rows: (items || []).length };
}

// Split scraped shops into new vs already-in-the-pipeline.
function matchShops(shops) {
  const existing = sales().get('leads').value() || [];
  const byPlace = new Map(existing.filter(l => l.placeId).map(l => [l.placeId, l]));
  const byName = new Map(existing.map(l => [normName(l.name), l]));
  const toAdd = [], matched = [];
  shops.forEach(sh => {
    const hit = (sh.placeId && byPlace.get(sh.placeId)) || byName.get(normName(sh.name));
    if (hit) matched.push({ lead: hit, shop: sh }); else toAdd.push(sh);
  });
  return { existing, toAdd, matched };
}

async function datasetItems(datasetId) {
  const fields = 'title,placeId,address,city,location,phone,website,totalScore,reviewsCount,permanentlyClosed,categoryName,categories,searchString';
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await apify(`/datasets/${datasetId}/items?clean=true&format=json&fields=${fields}&limit=1000&offset=${offset}`);
    items.push(...page);
    if (page.length < 1000) return items;
  }
}

// What the admin panel shows for the remembered run.
async function importStatus() {
  const run = sales().get('importRun').value();
  if (!run) return { ok: true, run: null };
  if (['READY', 'RUNNING'].includes(run.status)) {
    const r = (await apify('/actor-runs/' + run.runId)).data || {};
    sales().get('importRun').assign({ status: r.status || run.status, finishedAt: r.finishedAt || null }).write();
  }
  const cur = sales().get('importRun').value();
  const out = { ok: true, run: { status: cur.status, kinds: cur.kinds, maxPlaces: cur.maxPlaces, startedAt: cur.startedAt, finishedAt: cur.finishedAt || null, appliedAt: cur.appliedAt || null } };
  if (['READY', 'RUNNING'].includes(cur.status)) {
    const ds = (await apify('/datasets/' + cur.datasetId).catch(() => ({}))).data || {};
    out.run.scraped = ds.itemCount || 0;
    return out;
  }
  // Finished (or stopped at the cap / timed out) — preview whatever it got.
  const { shops, skipped, rows } = shopsFromItems(await datasetItems(cur.datasetId));
  const { toAdd, matched } = matchShops(shops);
  Object.assign(out.run, {
    scraped: rows, found: shops.length, wouldAdd: toAdd.length, alreadyHave: matched.length, skipped,
    sample: toAdd.slice(0, 12).map(s => ({ name: s.name, city: s.city, category: s.category, rating: s.rating, reviews: s.reviews })),
  });
  return out;
}

router.post('/api/admin/sales/import-places/start', requireAdmin, salesRoute(async (req, res) => {
  if (!process.env.APIFY_TOKEN) return res.status(400).json({ ok: false, error: 'APIFY_TOKEN is not set on the server.' });
  const kinds = (Array.isArray(req.body.kinds) ? req.body.kinds : Object.keys(IMPORT_KINDS)).filter(k => IMPORT_KINDS[k]);
  if (!kinds.length) return res.status(400).json({ ok: false, error: 'Pick at least one kind of shop.' });
  const prev = sales().get('importRun').value();
  if (prev && ['READY', 'RUNNING'].includes(prev.status)) return res.status(409).json({ ok: false, error: 'A scrape is already running.' });

  const maxPlaces = Math.min(5000, Math.max(20, parseInt(req.body.maxPlaces, 10) || 900));
  const terms = kinds.flatMap(k => IMPORT_KINDS[k].terms);
  const perTerm = Math.max(10, Math.floor(maxPlaces / terms.length));
  const { south, west, north, east } = METRO;
  const input = {
    searchStringsArray: terms,
    customGeolocation: { type: 'Polygon', coordinates: [[[west, north], [east, north], [east, south], [west, south], [west, north]]] },
    maxCrawledPlacesPerSearch: perTerm,
    language: 'en',
    // Everything below stays at the cheapest setting — extras are billed per place.
    skipClosedPlaces: false, scrapePlaceDetailPage: false, scrapeContacts: false, includeWebResults: false,
    maxReviews: 0, maxImages: 0, maxQuestions: 0, scrapeDirectories: false,
  };
  // Hard caps: never bill past maxPlaces, whatever the actor does.
  const chargeCap = Math.max(0.5, +(maxPlaces * APIFY_PRICE_PER_PLACE + 0.05).toFixed(2));
  try {
    const run = (await apify(`/acts/${APIFY_ACTOR}/runs?maxItems=${maxPlaces}&maxTotalChargeUsd=${chargeCap}`, { method: 'POST', body: input })).data;
    sales().set('importRun', {
      runId: run.id, datasetId: run.defaultDatasetId, status: run.status,
      kinds, maxPlaces, startedAt: new Date().toISOString(), finishedAt: null, appliedAt: null,
    }).write();
    res.json(await importStatus());
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Apify: ' + e.message });
  }
}));

router.get('/api/admin/sales/import-places/status', requireAdmin, salesRoute(async (req, res) => {
  try { res.json(await importStatus()); }
  catch (e) { res.status(502).json({ ok: false, error: 'Apify: ' + e.message }); }
}));

router.post('/api/admin/sales/import-places/apply', requireAdmin, salesRoute(async (req, res) => {
  const run = sales().get('importRun').value();
  if (!run) return res.status(400).json({ ok: false, error: 'Run a scrape first.' });
  if (['READY', 'RUNNING'].includes(run.status)) return res.status(409).json({ ok: false, error: 'The scrape is still running.' });
  let shops;
  try { ({ shops } = shopsFromItems(await datasetItems(run.datasetId))); }
  catch (e) { return res.status(502).json({ ok: false, error: 'Apify: ' + e.message }); }

  const { existing, toAdd, matched } = matchShops(shops);
  const leads = sales().get('leads');
  const now = new Date().toISOString();
  let enriched = 0;
  // Fill in blanks on shops we already have — never touch their stage or notes.
  matched.forEach(({ lead, shop }) => {
    const fill = {};
    if (!lead.placeId && shop.placeId) fill.placeId = shop.placeId;
    if (lead.lat == null && lead.lng == null) { fill.lat = shop.lat; fill.lng = shop.lng; }
    if (!lead.address) fill.address = shop.address;
    if (!lead.contact && shop.contact) fill.contact = shop.contact;
    if (!lead.city && shop.city) fill.city = shop.city;
    if (!lead.website && shop.website) fill.website = shop.website;
    if (lead.rating == null && shop.rating != null) { fill.rating = shop.rating; fill.reviews = shop.reviews; }
    if (Object.keys(fill).length) { leads.find({ id: lead.id }).assign(fill).write(); enriched++; }
  });
  const fresh = toAdd.map(sh => ({
    id: genId('lead'), ...sh,
    method: 'Cold call', tool: 'Unknown', status: 'not-contacted',
    plan: 'Unknown', value: 0, followup: '', notes: '', territory: '',
    source: 'google-maps', log: [],
    createdAt: now, updatedAt: now, lastContact: null, closedAt: null,
  }));
  if (fresh.length) sales().set('leads', [...existing, ...fresh]).write();
  sales().get('importRun').assign({ appliedAt: now }).write();
  res.json({ ok: true, added: fresh.length, enriched, ...adminSalesPayload() });
}));

// ── Admin: reset the rep's PIN (no current PIN needed) ────────────────────────
router.post('/api/admin/sales/pin/reset', requireAdmin, salesRoute(async (req, res) => {
  const next = String(req.body.newPin || '').trim();
  if (!/^\d{4,8}$/.test(next)) return res.status(400).json({ ok: false, error: 'PIN must be 4–8 digits' });
  const hash = await bcrypt.hash(next, 10);
  sales().assign({ pinHash: hash }).write();
  res.json({ ok: true });
}));

// ── helpers ────────────────────────────────────────────────────────────────────
function planValue(plan) {
  if (!plan) return 19.99;
  if (plan.includes('99'))  return 99;
  if (plan.includes('200')) return 200;
  return 19.99;
}
function coord(v, max) {
  const n = Number(v);
  return v === null || v === '' || !Number.isFinite(n) || Math.abs(n) > max ? null : n;
}
function cleanTargets(t, fallback) {
  return {
    dms:     Math.max(1, parseInt(t.dms, 10)     || fallback.dms),
    walkins: Math.max(1, parseInt(t.walkins, 10) || fallback.walkins),
    demos:   Math.max(1, parseInt(t.demos, 10)   || fallback.demos),
  };
}
function startOfWeek() {
  const d = new Date();
  const day = d.getDay();                       // 0 Sun .. 6 Sat
  d.setDate(d.getDate() - ((day + 6) % 7));      // back to Monday
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

module.exports = router;

// ── Sales Hub routes ─────────────────────────────────────────────────────────
// Global (not per-shop) resource stored in master.json under `sales`.
// PIN-gated: rep logs in with a numeric PIN, gets a JWT, and all data
// (leads, goals, activity, settings) lives on the server.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { master, JWT_SECRET, genId } = require('../db');
const { requireAdmin } = require('../middleware');

const DEFAULT_PIN = '1234';

// ── Helpers ───────────────────────────────────────────────────────────────────
function sales() { return master.get('sales'); }

// Make sure the sales blob exists and has a PIN. Runs lazily so we don't need
// async work inside db.defaults(). Returns the sales value.
async function ensureSales() {
  if (!master.has('sales').value()) {
    master.set('sales', {
      pinHash: null, repName: 'Bryce Moen', leads: [], goals: [],
      activity: { dms: 0, walkins: 0, demos: 0, weekStart: null },
      settings: { weeklyTargets: { dms: 50, walkins: 5, demos: 5 } }, history: [],
    }).write();
  }
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
    activity: s.activity || { dms: 0, walkins: 0, demos: 0 },
    settings: s.settings || { weeklyTargets: { dms: 50, walkins: 5, demos: 5 } },
    history:  s.history  || [],
  };
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
  res.json({ ok: true, state: publicState() });
}));

// ── Leads: create / update (upsert) ───────────────────────────────────────────
router.post('/api/sales/leads', requireSales, salesRoute(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name required' });
  const now = new Date().toISOString();
  const leads = sales().get('leads');
  const existing = b.id ? leads.find({ id: b.id }).value() : null;

  const lead = {
    id:       existing ? existing.id : genId('lead'),
    name,
    contact:  String(b.contact || '').trim(),
    city:     String(b.city || '').trim(),
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
router.post('/api/sales/goals', requireSales, salesRoute(async (req, res) => {
  const b = req.body || {};
  const name   = String(b.name || '').trim();
  const target = parseInt(b.target, 10) || 0;
  if (!name || !target) return res.status(400).json({ ok: false, error: 'Name and target required' });
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
  if (b.weeklyTargets) {
    sales().get('settings').assign({ weeklyTargets: {
      dms:     Math.max(1, parseInt(b.weeklyTargets.dms, 10)     || 50),
      walkins: Math.max(1, parseInt(b.weeklyTargets.walkins, 10) || 5),
      demos:   Math.max(1, parseInt(b.weeklyTargets.demos, 10)   || 5),
    } }).write();
  }
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

// ── Admin: view the rep's pipeline (read-only) ────────────────────────────────
router.get('/api/admin/sales', requireAdmin, salesRoute(async (req, res) => {
  const s = publicState();
  const closed = s.leads.filter(l => l.status === 'closed');
  res.json({
    repName: s.rep.name,
    totals: {
      leads:    s.leads.length,
      closed:   closed.length,
      pipeline: s.leads.filter(l => ['contacted', 'responded', 'demo'].includes(l.status)).length,
      mrrClosed: closed.reduce((sum, l) => sum + (Number(l.value) || 0), 0),
    },
    leads: s.leads,
    activity: s.activity,
  });
}));

// ── helpers ────────────────────────────────────────────────────────────────────
function planValue(plan) {
  if (!plan) return 19.99;
  if (plan.includes('99'))  return 99;
  if (plan.includes('200')) return 200;
  return 19.99;
}
function startOfWeek() {
  const d = new Date();
  const day = d.getDay();                       // 0 Sun .. 6 Sat
  d.setDate(d.getDate() - ((day + 6) % 7));      // back to Monday
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

module.exports = router;

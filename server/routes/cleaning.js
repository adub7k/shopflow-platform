// ── Cleaning module routes ───────────────────────────────────────────────────
// Industry extension for cleaning companies. All collections are per-shop and
// self-heal (lowdb upsert creates them on first write), so this is purely additive
// — shops that never use it simply never create the collections.
//   properties[]        — a service location, references customers[] by id
//   crews[]             — a team, references staff (barbers[]) by id
//   recurringServices[] — a recurring contract that spawns appointments[]
const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware');
const { genId } = require('../db');
const { shopRoute } = require('../db');
const { generateOne } = require('../recurring');

const rw = requireRole('full', 'technician');

// ── Properties ────────────────────────────────────────────────────────────────
router.get('/api/shop/properties', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  let list = h.getAll('properties');
  if (req.query.customerId) list = list.filter(p => p.customerId === req.query.customerId);
  res.json(list.sort((a, b) => (a.label || a.address || '').localeCompare(b.label || b.address || '')));
}));
router.post('/api/shop/properties', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  const p = req.body || {};
  if (!p.address) return res.status(400).json({ error: 'Address is required' });
  if (!p.id) { p.id = genId('prop'); p.createdAt = new Date().toISOString(); }
  h.upsert('properties', p);
  res.json({ id: p.id });
}));
router.delete('/api/shop/properties/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  h.remove('properties', req.params.id);
  res.json({ ok: true });
}));

// ── Crews ─────────────────────────────────────────────────────────────────────
router.get('/api/shop/crews', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('crews'));
}));
router.post('/api/shop/crews', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  const c = req.body || {};
  if (!c.name) return res.status(400).json({ error: 'Crew name is required' });
  if (!Array.isArray(c.memberIds)) c.memberIds = [];
  if (!c.id) { c.id = genId('crew'); c.active = true; c.createdAt = new Date().toISOString(); }
  h.upsert('crews', c);
  res.json({ id: c.id });
}));
router.delete('/api/shop/crews/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  h.remove('crews', req.params.id);
  res.json({ ok: true });
}));

// ── Recurring services ────────────────────────────────────────────────────────
router.get('/api/shop/recurring', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  res.json(h.getAll('recurringServices').sort((a, b) => (a.nextRunDate || '').localeCompare(b.nextRunDate || '')));
}));
router.post('/api/shop/recurring', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  const r = req.body || {};
  if (!r.customerId) return res.status(400).json({ error: 'Customer is required' });
  if (!r.nextRunDate) return res.status(400).json({ error: 'A start date is required' });
  if (!r.cadence) r.cadence = 'weekly';
  if (!r.id) { r.id = genId('rec'); r.active = r.active !== false; r.createdAt = new Date().toISOString(); }
  h.upsert('recurringServices', r);
  res.json({ id: r.id });
}));
router.delete('/api/shop/recurring/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  h.remove('recurringServices', req.params.id);
  res.json({ ok: true });
}));
// Manually spawn the next job now (also advances nextRunDate) — handy for testing
// and for "run it early" without waiting for the scheduler tick.
router.post('/api/shop/recurring/:id/generate', requireAuth, rw, shopRoute(async (req, res, db, h) => {
  const r = h.getById('recurringServices', req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const appt = generateOne(db, r);
  res.json({ ok: true, appointmentId: appt.id, date: appt.date });
}));

module.exports = router;

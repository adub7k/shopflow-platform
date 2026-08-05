// ── Auth middleware ───────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const { master, JWT_SECRET } = require('./db');

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Client-portal tokens are valid ONLY on /api/client/* (requireClient below).
    // Rejecting them here — not per-route — means every /api/shop route stays
    // closed to clients, including the ones that carry no requireRole gate
    // (e.g. GET /api/shop/settings, which returns Twilio/SMTP credentials).
    if ((payload.role || 'full') === 'client')
      return res.status(403).json({ error: 'This login only has access to the client portal.' });
    const shop = master.get('shops').find({ id: payload.shopId }).value();
    if (!shop)        return res.status(401).json({ error: 'Account not found' });
    if (!shop.active) return res.status(401).json({ error: 'Account suspended. Contact support.' });
    req.shopId    = payload.shopId;
    req.accountId = payload.accountId;
    req.role      = payload.role || 'full'; // legacy tokens (no role) = owner/full
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Client-portal auth: the mirror image of the guard above — accepts ONLY
// role 'client'. Shop identity always comes from the token, never from a
// request param or body, so a client login is hard-bound to its one shop.
function requireClient(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if ((payload.role || 'full') !== 'client')
      return res.status(403).json({ error: 'Client portal access only' });
    const shop = master.get('shops').find({ id: payload.shopId }).value();
    if (!shop)        return res.status(401).json({ error: 'Account not found' });
    if (!shop.active) return res.status(401).json({ error: 'Account suspended. Contact support.' });
    req.shopId    = payload.shopId;
    req.accountId = payload.accountId;
    req.role      = 'client';
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Gate a route to one or more roles. Must run after requireAuth (sets req.role).
// Roles: 'full' (owner/full access), 'technician', 'viewonly'.
function requireRole(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.role || 'full')) return next();
    return res.status(403).json({ error: 'You do not have permission for this action.' });
  };
}

function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'shopflow-admin'))
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

module.exports = { requireAuth, requireClient, requireRole, requireAdmin };

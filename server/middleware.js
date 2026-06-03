// ── Auth middleware ───────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const { master, JWT_SECRET } = require('./db');

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const shop = master.get('shops').find({ id: payload.shopId }).value();
    if (!shop)        return res.status(401).json({ error: 'Account not found' });
    if (!shop.active) return res.status(401).json({ error: 'Account suspended. Contact support.' });
    req.shopId    = payload.shopId;
    req.accountId = payload.accountId;
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'shopflow-admin'))
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

module.exports = { requireAuth, requireAdmin };

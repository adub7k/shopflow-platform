// Single shared Web-Push sender.
// routes/push.js is a factory; instantiate it ONCE here so the non-factory
// routers (routes/public.js) and index.js all send through the same instance
// instead of re-configuring webpush per module. Reads/writes push_subscriptions
// straight off each shop's lowdb file, so a fresh require anywhere is fine.
const { getShopDb } = require('./integrations');

module.exports = require('./routes/push')({ getShopDb });

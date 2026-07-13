// ── Adapters for the website-leads / platform / automations / push modules ────
// The drop-in modules (routes/website-leads.router.js, routes/platform.router.js,
// routes/automations.js, routes/push.js — see docs/website-leads/) expect a
// lowdb-v2-style `{ data, write() }` handle plus generic messaging helpers.
// This file adapts the app's real lowdb-v1 + Twilio + nodemailer stack to those
// signatures. Adapt the app to the modules here — never edit the modules.
const { master, getShopDb: getShopDbRaw, shopFromNumber, twilioClient, toE164 } = require('./db');
const { mailer } = require('./email');

function findShop(tenantId) {
  return master.get('shops').find({ id: String(tenantId || '') }).value() || null;
}

// getShopDb(tenantId) → { data, write } | null
// - Unknown tenants return null (the raw helper would silently create an empty
//   shop directory for any id it's given).
// - `customers` is aliased to `website_customers`: the CRM already owns
//   db.customers as an ARRAY of client records, while platform.router.js keeps
//   a phone-keyed OBJECT. Without the alias its writes would land as string
//   keys on the array and be dropped by JSON serialization on the next save.
const CUSTOMERS_ALIAS = 'website_customers';
async function getShopDb(tenantId) {
  const shop = findShop(tenantId);
  if (!shop) return null;
  const db = getShopDbRaw(shop.id);
  const state = db.getState();
  const data = new Proxy(state, {
    get: (t, k) => t[k === 'customers' ? CUSTOMERS_ALIAS : k],
    set: (t, k, v) => { t[k === 'customers' ? CUSTOMERS_ALIAS : k] = v; return true; },
    has: (t, k) => (k === 'customers' ? CUSTOMERS_ALIAS : k) in t,
  });
  return { data, write: async () => db.write() };
}

// Every active shop id — drives the automation engine's 60s tick.
function getAllTenantIds() {
  return (master.get('shops').value() || []).filter(s => s && s.active).map(s => s.id);
}

// sendSms(tenantId, message, toPhone?) — omitted toPhone = alert the shop owner
// (the master-record phone from signup). NOTE: the modules gate every call on
// SMS_ENABLED=true (A2P 10DLC still pending), so this stays dormant until then.
async function sendSms(tenantId, message, toPhone) {
  const shop = findShop(tenantId);
  const from = shopFromNumber(tenantId);
  const to = toE164(toPhone || (shop && shop.phone));
  if (!twilioClient || !from || !to) {
    console.log(`[integrations] SMS skipped (${!twilioClient ? 'no Twilio client' : !from ? 'no from-number' : 'no to-number'}) tenant=${tenantId}`);
    return;
  }
  await twilioClient.messages.create({ from, to, body: message });
}

// Owner-alert recipient mirrors email.js: settings.notificationEmail → shop.email
function ownerEmail(tenantId) {
  const shop = findShop(tenantId);
  if (!shop) return '';
  const settings = getShopDbRaw(shop.id).get('settings').value() || {};
  return String(settings.notificationEmail || shop.email || '').trim();
}

// sendEmail(tenantId, subject, body, toEmail?) — omitted toEmail = the owner.
// Plain-text: the modules compose their own message bodies.
async function sendEmail(tenantId, subject, body, toEmail) {
  const to = String(toEmail || ownerEmail(tenantId)).trim();
  const t = mailer();
  if (!t || !to) {
    console.log(`[integrations] email ${!t ? 'not sent (SMTP not configured)' : 'skipped (no recipient)'} tenant=${tenantId} subject="${subject}"`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || `"ShopFlow" <${process.env.SMTP_USER}>`,
    to, subject, text: body,
  });
}

const sendEmailAlert = (tenantId, subject, body) => sendEmail(tenantId, subject, body);

module.exports = { getShopDb, getAllTenantIds, sendSms, sendEmail, sendEmailAlert };

// Test for lead source normalisation (server/leads-core.js) and the one-off
// backfill endpoint (server/routes/admin.js).
// Run: node test/lead-source-normalisation.test.js
//
// The bug this covers: `source` used to be whatever reached the intake, so the
// website form passed utm_source through raw. One Meta channel could be stored
// as `facebook`, `fb` or `facebook_mobile_feed` — reporting split three ways,
// and because the 30-day follow-up enrols on an exact match, an oddly-tagged
// ad lead silently never entered the sequence.
//
// Verifies (1) the mapping itself, including that an unknown source is kept
// rather than bucketed, (2) a messily-tagged Meta lead now enrols in follow-up,
// (3) the pre-normalisation value survives on `sourceRaw`, (4) the backfill is
// dry-run by default and reports what it would change, (5) applying it rewrites
// the stored leads, and (6) the backfill does NOT retroactively enrol old leads
// in the follow-up sequence.
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-source-' + process.pid);
process.env.ADMIN_KEY = 'test-admin-key';

const express = require('express');
const { master, getShopDb } = require('../server/db');
const { upsertLead, normalizeSource } = require('../server/leads-core');

let failures = 0;
const eq = (name, got, exp) => {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`);
};

const shopId = 'shoptest_source';
master.get('shops').push({
  id: shopId, accountId: 'acct_source', shopName: 'Source Test Detail', slug: 'source-test',
  industry: 'detail', active: true,
}).write();
const db = getShopDb(shopId);
db.set('settings', { shopName: 'Source Test Detail' }).write();
db.set('leads', []).write();
db.set('customers', []).write();
const shop = master.get('shops').find({ id: shopId }).value();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(require('../server/routes/admin'));

const leads = () => getShopDb(shopId).get('leads').value() || [];
const byPhone = (p) => leads().find(l => String(l.phone).endsWith(p));

const post = (url, body) => new Promise((resolve) => {
  const server = app.listen(0, async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    server.close(() => resolve({ status: res.status, json }));
  });
});

(async () => {
  /* ── 1. the mapping ─────────────────────────────────────────────────────── */
  eq('fb → facebook', normalizeSource('fb'), 'facebook');
  eq('FB uppercase → facebook', normalizeSource('FB'), 'facebook');
  eq('facebook_mobile_feed → facebook', normalizeSource('facebook_mobile_feed'), 'facebook');
  eq('Meta → facebook', normalizeSource('Meta'), 'facebook');
  eq('IG_Story → instagram', normalizeSource('IG_Story'), 'instagram');
  eq('google_ads → google', normalizeSource('google_ads'), 'google');
  eq('missed-call → call', normalizeSource('missed-call'), 'call');
  eq('empty → website', normalizeSource(''), 'website');
  // An unknown channel is information, not noise — kept, not bucketed.
  eq('tiktok kept as-is', normalizeSource('tiktok'), 'tiktok');
  // Words merely containing "ig"/"fb" must not be swept into a social bucket.
  eq('digital not mistaken for instagram', normalizeSource('digital'), 'digital');

  /* ── 2. a messily-tagged ad lead now enrols in follow-up ─────────────────── */
  upsertLead(db, shop, {
    name: 'Messy Tag', phone: '5055550111', source: 'facebook_mobile_feed',
    utm: { source: 'facebook_mobile_feed' },
  });
  const messy = byPhone('5550111');
  eq('messy Meta tag normalised', messy.source, 'facebook');
  eq('messy Meta tag enrolled in follow-up', messy.followUp && messy.followUp.status, 'active');
  eq('original tag preserved on sourceRaw', messy.sourceRaw, 'facebook_mobile_feed');

  /* ── 3. an ordinary website lead is untouched and does NOT enrol ─────────── */
  upsertLead(db, shop, { name: 'Plain Web', phone: '5055550222', source: 'website' });
  const web = byPhone('5550222');
  eq('website stays website', web.source, 'website');
  eq('website lead not enrolled', web.followUp, undefined);
  eq('no sourceRaw when nothing changed', web.sourceRaw, undefined);

  /* ── 4. backfill: dry run reports without writing ────────────────────────── */
  // Two legacy leads written the old way, straight into the db.
  getShopDb(shopId).get('leads').push(
    { id: 'lead_old1', name: 'Old One', phone: '5055550333', source: 'fb', status: 'new' },
    { id: 'lead_old2', name: 'Old Two', phone: '5055550444', source: 'IG', status: 'new' },
    { id: 'lead_old3', name: 'Old Three', phone: '5055550555', source: 'call', status: 'new' },
  ).write();

  const dry = await post('/api/admin/backfill-lead-sources', { shopId });
  eq('dry run flagged as dry', dry.json.dryRun, true);
  eq('dry run counts both legacy leads', dry.json.changed, 2);
  eq('dry run reports the mapping', dry.json.changes, { 'fb → facebook': 1, 'ig → instagram': 1 });
  eq('dry run wrote nothing', byPhone('5550333').source, 'fb');

  /* ── 5. apply rewrites, preserving the original ──────────────────────────── */
  const applied = await post('/api/admin/backfill-lead-sources', { shopId, apply: true });
  eq('apply not flagged as dry', applied.json.dryRun, false);
  eq('apply changed both', applied.json.changed, 2);
  eq('legacy fb rewritten', byPhone('5550333').source, 'facebook');
  eq('legacy fb original kept', byPhone('5550333').sourceRaw, 'fb');
  eq('legacy IG rewritten', byPhone('5550444').source, 'instagram');
  eq('already-canonical lead untouched', byPhone('5550555').source, 'call');

  /* ── 6. backfill must NOT retroactively enrol old leads ──────────────────── */
  // Enrolling months of stale leads would dump them into Tasks and start the
  // owner texting people who enquired in March.
  eq('backfilled lead not enrolled in follow-up', byPhone('5550333').followUp, undefined);

  /* ── 7. rerunning is a no-op ─────────────────────────────────────────────── */
  const again = await post('/api/admin/backfill-lead-sources', { shopId, apply: true });
  eq('second run finds nothing to change', again.json.changed, 0);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll assertions passed.');
  process.exit(failures ? 1 : 0);
})();

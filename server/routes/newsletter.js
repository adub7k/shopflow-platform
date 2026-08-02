// ── Newsletter routes ─────────────────────────────────────────────────────────
// Owner side: compose/save drafts, preview audience size, test-send, launch a
// campaign (send loop lives in ../newsletter). Public side: per-recipient open
// pixel + the unsubscribe endpoints (GET = human-facing confirmation page,
// POST = RFC 8058 one-click from the mail client's native button). The lead id
// doubles as the unsubscribe token — ids are random (genId), never sequential.
const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware');
const { master, getShopDb, shopHelpers, shopRoute, genId } = require('../db');
const { audience, renderNewsletterEmail, shopIdentity, runCampaignSend, ensureCampaigns } = require('../newsletter');
const { deliver } = require('../email');

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Strip the heavy recipients array for list views — the UI only needs counts.
function summarize(c) {
  const { recipients, ...rest } = c;
  return { ...rest, recipientCount: (recipients || []).length,
    openCount: (recipients || []).filter((r) => r.openedAt).length };
}

// Draft fields an owner may set. Everything is plain text; the template escapes.
function pickDraft(b = {}) {
  const s = (v, max) => String(v == null ? '' : v).slice(0, max);
  return {
    subject: s(b.subject, 150), preheader: s(b.preheader, 150),
    headline: s(b.headline, 150), body: s(b.body, 8000),
    imageUrl: s(b.imageUrl, 500), ctaText: s(b.ctaText, 60), ctaUrl: s(b.ctaUrl, 500),
  };
}

// ── PROTECTED: campaigns + audience ──────────────────────────────────────────
router.get('/api/shop/newsletter', requireAuth, requireRole('full'), shopRoute(async (req, res, db) => {
  ensureCampaigns(db);
  const a = audience(db);
  const campaigns = (db.get('campaigns').value() || []).map(summarize)
    .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
  res.json({ campaigns, audience: { count: a.list.length, total: a.total, withEmail: a.withEmail, optedOut: a.optedOut } });
}));

router.get('/api/shop/newsletter/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  ensureCampaigns(db);
  const c = h.getById('campaigns', req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'Campaign not found' });
  res.json(summarize(c));
}));

router.post('/api/shop/newsletter', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  ensureCampaigns(db);
  const b = req.body || {};
  let c = b.id ? h.getById('campaigns', b.id) : null;
  if (c && c.status !== 'draft') return res.status(400).json({ ok: false, error: 'This issue was already sent — start a new one.' });
  if (!c) c = { id: genId('nl'), status: 'draft', createdAt: new Date().toISOString() };
  Object.assign(c, pickDraft(b));
  h.upsert('campaigns', c);
  res.json(summarize(c));
}));

router.delete('/api/shop/newsletter/:id', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  ensureCampaigns(db);
  const c = h.getById('campaigns', req.params.id);
  if (c && c.status === 'sending') return res.status(400).json({ ok: false, error: 'This campaign is currently sending.' });
  h.remove('campaigns', req.params.id);
  res.json({ ok: true });
}));

// Test send — the composer's current (saved) draft to the owner's own inbox.
router.post('/api/shop/newsletter/:id/test', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  ensureCampaigns(db);
  const c = h.getById('campaigns', req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'Campaign not found' });
  const s = db.get('settings').value() || {};
  const shopRow = master.get('shops').find({ id: req.shopId }).value();
  const to = String((req.body || {}).to || s.notificationEmail || shopRow.email || '').trim();
  if (!to) return res.status(400).json({ ok: false, error: 'No email to send the test to — set an alert email in Settings.' });
  const base = process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
  const { subject, html, text } = renderNewsletterEmail({
    shop: shopIdentity(s), campaign: c, lead: { name: 'Test Preview' },
    unsubscribeUrl: `${base}/u/${shopRow.slug}/preview`,
  });
  const r = await deliver({ to, subject: `[Test] ${subject}`, html, text });
  if (!r.ok) return res.status(502).json({ ok: false, error: r.reason });
  res.json({ ok: true, to });
}));

// Launch: snapshot today's audience onto the campaign and start the paced
// send loop (responds immediately; the UI polls GET /:id for progress).
router.post('/api/shop/newsletter/:id/send', requireAuth, requireRole('full'), shopRoute(async (req, res, db, h) => {
  ensureCampaigns(db);
  const c = h.getById('campaigns', req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'Campaign not found' });
  if (c.status !== 'draft' && c.status !== 'failed') return res.status(400).json({ ok: false, error: 'This issue was already sent.' });
  if (!String(c.subject || '').trim()) return res.status(400).json({ ok: false, error: 'Give the email a subject line first.' });
  if (!String(c.body || '').trim()) return res.status(400).json({ ok: false, error: 'The email has no message yet.' });
  const a = audience(db);
  if (!a.list.length) return res.status(400).json({ ok: false, error: 'No leads with an email address to send to yet.' });

  // Failed relaunch keeps already-sent recipients; fresh launch snapshots anew.
  if (!(c.recipients || []).length) {
    c.recipients = a.list.map((l) => ({ leadId: l.id, email: String(l.email).trim(), name: l.name || '', status: 'pending' }));
  }
  c.status = 'sending';
  c.error = null;
  c.sentAt = c.sentAt || new Date().toISOString();
  // The send loop runs detached from any request, so capture the public base
  // now — same derivation the estimate email uses.
  c.baseUrl = (process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
  h.upsert('campaigns', c);
  runCampaignSend(req.shopId, c.id).catch((e) => console.error('Newsletter send error:', e.message));
  res.json({ ok: true, recipients: c.recipients.filter((r) => r.status === 'pending').length });
}));

// ── PUBLIC: open tracking ─────────────────────────────────────────────────────
// Same caveats as the estimate pixel: proxies pre-fetch, so opens are a
// strong-but-imperfect signal. Never regresses anything; purely informational.
const _PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
router.get('/api/public/:shopSlug/newsletter/:campaignId/opened.gif', (req, res) => {
  try {
    const shop = master.get('shops').find({ slug: req.params.shopSlug, active: true }).value();
    if (shop) {
      const db = getShopDb(shop.id);
      const h = shopHelpers(db);
      const c = h.getById('campaigns', req.params.campaignId);
      const rec = c && (c.recipients || []).find((r) => r.leadId === String(req.query.l || ''));
      if (rec) {
        if (!rec.openedAt) rec.openedAt = new Date().toISOString();
        rec.openCount = (rec.openCount || 0) + 1;
        h.upsert('campaigns', c);
      }
    }
  } catch (e) { /* never let tracking break the image */ }
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(_PIXEL);
});

// ── PUBLIC: unsubscribe ───────────────────────────────────────────────────────
function findLeadCtx(shopSlug, leadId) {
  const shop = master.get('shops').find({ slug: shopSlug, active: true }).value();
  if (!shop) return null;
  const db = getShopDb(shop.id);
  const h = shopHelpers(db);
  const lead = h.getById('leads', leadId);
  return { shop, db, h, lead };
}

function unsubPage({ title, message, link }) {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex"/><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f4f2;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:440px;margin:80px auto;background:#fff;border:1px solid #e5e5e2;border-radius:12px;padding:36px 32px;text-align:center;">
  <div style="font-size:20px;font-weight:bold;color:#111827;margin-bottom:10px;">${esc(title)}</div>
  <p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0;">${message}</p>
  ${link ? `<p style="margin:18px 0 0;"><a href="${esc(link.href)}" style="font-size:13px;color:#6b7280;">${esc(link.label)}</a></p>` : ''}
</div></body></html>`;
}

// Human click from the email footer. Applies immediately (one click, no form)
// and offers an undo link.
router.get('/u/:shopSlug/:leadId', (req, res) => {
  try {
    const ctx = findLeadCtx(req.params.shopSlug, req.params.leadId);
    if (!ctx || !ctx.lead) return res.status(404).send(unsubPage({ title: 'Link expired', message: 'This unsubscribe link is no longer valid.' }));
    const s = ctx.db.get('settings').value() || {};
    const shopName = esc(s.shopName || ctx.shop.shopName || 'this shop');
    if (String(req.query.resub || '') === '1') {
      ctx.lead.emailOptOut = false;
      ctx.h.upsert('leads', ctx.lead);
      return res.send(unsubPage({ title: 'Welcome back', message: `You're subscribed to emails from ${shopName} again.` }));
    }
    if (!ctx.lead.emailOptOut) {
      ctx.lead.emailOptOut = true;
      ctx.lead.emailOptOutAt = new Date().toISOString();
      ctx.h.upsert('leads', ctx.lead);
    }
    res.send(unsubPage({
      title: "You're unsubscribed",
      message: `You won't get any more marketing emails from ${shopName}.`,
      link: { href: `/u/${ctx.shop.slug}/${ctx.lead.id}?resub=1`, label: 'Unsubscribed by mistake? Re-subscribe' },
    }));
  } catch (e) { res.status(500).send(unsubPage({ title: 'Something went wrong', message: 'Please try the link again.' })); }
});

// RFC 8058 one-click (mail clients POST here from their native button).
router.post('/u/:shopSlug/:leadId', (req, res) => {
  try {
    const ctx = findLeadCtx(req.params.shopSlug, req.params.leadId);
    if (ctx && ctx.lead && !ctx.lead.emailOptOut) {
      ctx.lead.emailOptOut = true;
      ctx.lead.emailOptOutAt = new Date().toISOString();
      ctx.h.upsert('leads', ctx.lead);
    }
  } catch (e) { /* one-click must not error */ }
  res.json({ ok: true });
});

module.exports = router;

// ── Free Sales Playbook: lead magnet for shopflowtech.com ─────────────────────
// A shop owner fills out the form on /playbook → we store them in
// master.playbookLeads, email them a private download link, and email the
// platform owner so every inbound prospect gets a call. The PDF itself lives in
// server/assets (not client/), so the only way to get it is through a signup.
//
//   POST /api/public/playbook              — the opt-in form
//   GET  /playbook/download/:token         — the PDF (counts downloads)
//   GET/PATCH/DELETE /api/admin/playbook-leads[/:id] — admin "Playbook leads" page
const router = require('express').Router();
const path = require('path');
const crypto = require('crypto');
const { master, genId } = require('../db');
const { requireAdmin } = require('../middleware');
const { deliver } = require('../email');

const PDF_PATH = path.join(__dirname, '..', 'assets', 'shopflow-sales-playbook.pdf');
const PDF_NAME = 'ShopFlow-Sales-Playbook.pdf';
const STATUSES = ['new', 'contacted', 'call booked', 'client', 'not a fit'];
const SERVICES = ['Window tint', 'PPF', 'Ceramic coating', 'Detailing', 'Wraps', 'Other'];
const OWNER_PHONE = '505-464-9144';

function leads() {
  if (!master.has('playbookLeads').value()) master.set('playbookLeads', []).write();
  return master.get('playbookLeads');
}
const clean = (v, max = 120) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const siteUrl = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

function leadEmail({ name, link }) {
  const first = esc(name.split(' ')[0]);
  return {
    subject: 'Your ShopFlow Sales Playbook',
    html: `<div style="background:#F8FAFC;padding:32px 16px;font-family:Inter,-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden;">
    <div style="background:#0F172A;padding:28px 28px 26px;">
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#4ADE80;">Free playbook</div>
      <div style="font-size:26px;font-weight:800;letter-spacing:-.03em;color:#fff;line-height:1.15;margin-top:8px;">The ShopFlow Sales Playbook</div>
    </div>
    <div style="padding:28px;">
      <p style="font-size:16px;color:#111827;margin:0 0 14px;">Hi ${first},</p>
      <p style="font-size:15.5px;line-height:1.65;color:#374151;margin:0 0 22px;">Here's your copy. 15 pages on how tint, PPF and detail shops turn ad dollars into deposit-backed jobs, with the real numbers from one of our shops behind every step.</p>
      <a href="${link}" style="display:inline-block;background:#16A34A;color:#fff;font-weight:700;font-size:16px;text-decoration:none;padding:14px 26px;border-radius:12px;">Download the playbook (PDF)</a>
      <p style="font-size:15px;line-height:1.65;color:#374151;margin:26px 0 0;">Start with chapter 01 and work out your six numbers. If you want a second set of eyes on them, text <b>AUDIT</b> to <a href="sms:+15054649144" style="color:#15803D;font-weight:600;">${OWNER_PHONE}</a> and I'll go through your ads, site, Google profile and follow-up with you for free.</p>
      <p style="font-size:15px;color:#111827;margin:22px 0 0;">Aidan Woods<br><span style="color:#6B7280;">Founder, ShopFlow Technologies · Albuquerque, NM</span></p>
    </div>
  </div>
  <p style="max-width:520px;margin:14px auto 0;font-size:12px;color:#9CA3AF;text-align:center;">You're getting this because you asked for the playbook at shopflowtech.com.</p>
</div>`,
    text: `Hi ${name.split(' ')[0]},\n\nHere's your copy of the ShopFlow Sales Playbook:\n${link}\n\nIf you want a second set of eyes on your numbers, text AUDIT to ${OWNER_PHONE} for a free growth audit.\n\nAidan Woods\nFounder, ShopFlow Technologies`,
  };
}

function ownerEmail(l, repeat) {
  const digits = l.phone.replace(/\D/g, '');
  const rows = [
    ['Name', esc(l.name)],
    ['Shop', esc(l.shopName)],
    ['Phone', digits ? `<a href="tel:+1${digits.slice(-10)}" style="color:#16a34a;font-weight:600;">${esc(l.phone)}</a>` : '—'],
    ['Email', `<a href="mailto:${esc(l.email)}" style="color:#16a34a;">${esc(l.email)}</a>`],
    l.service && ['Main service', esc(l.service)],
    l.city && ['City', esc(l.city)],
    l.source && ['Came from', esc(l.source)],
  ].filter(Boolean);
  return {
    subject: `📘 ${repeat ? 'Playbook requested again' : 'New playbook lead'}: ${l.name}${l.shopName ? ` (${l.shopName})` : ''}`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px 16px;">
      <h2 style="color:#16a34a;margin:0 0 6px;">${repeat ? 'Playbook requested again' : 'New playbook download'}</h2>
      <p style="color:#374151;font-size:14px;margin:0 0 14px;">They have the PDF in their inbox now. Call while it's fresh.</p>
      <table style="width:100%;border-collapse:collapse;background:#f0fdf4;border:1px solid #dcfce7;border-radius:10px;">
        ${rows.map(([k, v]) => `<tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:8px 12px;color:#111827;font-size:13px;">${v}</td></tr>`).join('')}
      </table>
      <p style="font-size:13px;color:#6b7280;margin:14px 0 0;">Every playbook lead is in Admin → Playbook leads.</p>
    </div>`,
    text: `${repeat ? 'Playbook requested again' : 'New playbook lead'}\nName: ${l.name}\nShop: ${l.shopName}\nPhone: ${l.phone}\nEmail: ${l.email}`
      + (l.service ? `\nMain service: ${l.service}` : '') + (l.source ? `\nCame from: ${l.source}` : ''),
  };
}

// ── Public: opt-in ────────────────────────────────────────────────────────────
router.post('/api/public/playbook', async (req, res) => {
  try {
    const b = req.body || {};
    // Honeypot: real people never see or fill the "website" field.
    if (clean(b.website)) return res.json({ ok: true, download: '/playbook' });
    const name = clean(b.name, 80), shopName = clean(b.shopName, 100), phone = clean(b.phone, 30);
    const email = clean(b.email, 160).toLowerCase();
    if (!name || !shopName || !email || !phone) return res.status(400).json({ ok: false, error: 'Please fill in every field.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'That email address doesn\'t look right.' });
    if (phone.replace(/\D/g, '').length < 10) return res.status(400).json({ ok: false, error: 'Please enter a 10-digit phone number.' });
    const service = SERVICES.includes(b.service) ? b.service : '';
    const now = new Date().toISOString();

    // One row per email: a repeat signup refreshes the details and resends the
    // link instead of creating a duplicate lead.
    const existing = leads().find({ email }).value();
    let lead;
    if (existing) {
      leads().find({ id: existing.id }).assign({ name, shopName, phone, service: service || existing.service, requests: (existing.requests || 1) + 1, lastRequestAt: now }).write();
      lead = leads().find({ id: existing.id }).value();
    } else {
      lead = {
        id: genId('pb'), token: crypto.randomBytes(16).toString('hex'),
        name, shopName, email, phone, service,
        city: clean(b.city, 60), source: clean(b.source, 120),
        status: 'new', notes: '', requests: 1, downloads: 0, lastDownloadAt: null,
        createdAt: now, lastRequestAt: now,
      };
      leads().unshift(lead).write();
    }

    const link = `${siteUrl(req)}/playbook/download/${lead.token}`;
    const toLead = leadEmail({ name, link });
    deliver({ to: email, ...toLead, replyTo: process.env.PLAYBOOK_REPLY_TO || undefined })
      .then((r) => { if (!r.ok) console.error('Playbook email failed:', r.reason); });
    const notifyTo = process.env.PLAYBOOK_NOTIFY_EMAIL || process.env.DEMO_NOTIFY_EMAIL || 'adub7k@gmail.com';
    deliver({ to: notifyTo, ...ownerEmail(lead, !!existing), replyTo: email })
      .then((r) => r.ok ? console.log('Playbook-lead email sent →', notifyTo) : console.error('Playbook owner email failed:', r.reason));

    res.json({ ok: true, download: `/playbook/download/${lead.token}` });
  } catch (e) {
    console.error('Playbook signup error:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// ── Public: the PDF ───────────────────────────────────────────────────────────
router.get('/playbook/download/:token', (req, res) => {
  const ref = leads().find({ token: String(req.params.token) });
  if (!ref.value()) return res.redirect('/playbook');
  ref.assign({ downloads: (ref.value().downloads || 0) + 1, lastDownloadAt: new Date().toISOString() }).write();
  res.set('X-Robots-Tag', 'noindex');
  res.set('Content-Disposition', `inline; filename="${PDF_NAME}"`);
  res.sendFile(PDF_PATH);
});

// ── Admin: Playbook leads page ────────────────────────────────────────────────
router.get('/api/admin/playbook-leads', requireAdmin, (req, res) => {
  res.json({ ok: true, statuses: STATUSES, leads: leads().value().map(({ token, ...l }) => l) });
});
router.patch('/api/admin/playbook-leads/:id', requireAdmin, (req, res) => {
  const ref = leads().find({ id: req.params.id });
  if (!ref.value()) return res.status(404).json({ ok: false, error: 'Not found' });
  const up = {};
  if (req.body.status !== undefined && STATUSES.includes(req.body.status)) up.status = req.body.status;
  if (req.body.notes !== undefined) up.notes = String(req.body.notes).slice(0, 2000);
  ref.assign(up).write();
  res.json({ ok: true });
});
router.delete('/api/admin/playbook-leads/:id', requireAdmin, (req, res) => {
  leads().remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

module.exports = router;

// ── Newsletter campaigns (email marketing to captured leads) ─────────────────
// Owner-composed email blasts to every lead with an email address (Meta lead
// ads, website form, admin-entered — they all land in `leads`). Deliberately
// email-only: SMS campaigns stay blocked on A2P, but nothing stops us mailing
// the list we already own. Design notes:
//   • Audience is computed at SEND time (snapshot onto the campaign) — a lead
//     captured after send simply catches the next issue.
//   • CAN-SPAM: every send carries the shop's physical address + a working
//     unsubscribe link, plus List-Unsubscribe headers (RFC 8058 one-click) so
//     Gmail/Yahoo surface their native unsubscribe button.
//   • Suppression lives on the lead (emailOptOut) — one flag, checked at
//     audience build, honored forever after.
//   • Sending is a paced in-process loop (~1.5/sec — under Resend's 2 req/s
//     limit) resumed by the scheduler if the process restarts mid-campaign.
const { master, getShopDb, shopHelpers, genId } = require('./db');
const { deliver } = require('./email');

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.APP_URL || '').replace(/\/$/, '');
}

function ensureCampaigns(db) { if (!Array.isArray(db.get('campaigns').value())) db.set('campaigns', []).write(); }

// ── Audience ──────────────────────────────────────────────────────────────────
// Every lead with a usable email, minus opt-outs, deduped by lowercase address
// (repeat form submits under two phone numbers shouldn't get the issue twice).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function audience(db) {
  const leads = db.get('leads').value() || [];
  const seen = new Set();
  const list = [];
  let optedOut = 0;
  for (const l of leads) {
    const email = String(l.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    if (l.emailOptOut) { optedOut++; continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    list.push(l);
  }
  return { list, total: leads.length, withEmail: list.length + optedOut, optedOut };
}

// ── Template ──────────────────────────────────────────────────────────────────
// Marketing letter in the shop's own voice — accent-bar letterhead like the
// estimate email, but sans-serif and CTA-forward. Footer carries the CAN-SPAM
// requirements (why-you-got-this, physical address, unsubscribe).
// `campaign`: { subject, preheader, headline, body, imageUrl, ctaText, ctaUrl }.
// Pure/no I/O so it can be previewed and unit-tested.
function renderNewsletterEmail({ shop, campaign, lead, unsubscribeUrl, openPixel }) {
  const s = shop || {};
  const c = campaign || {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(s.accentColor || '') ? s.accentColor : '#16a34a';
  const name = s.name || 'our shop';
  const firstName = String((lead || {}).name || '').trim().split(/\s+/)[0] || '';
  const greeting = firstName ? `Hi ${esc(firstName)},` : 'Hi there,';

  // Body: plain text, blank-line separated paragraphs → <p> blocks.
  const paras = String(c.body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const bodyHtml = paras.map((p) =>
    `<p style="font-size:15px;color:#374151;line-height:1.65;margin:0 0 14px;">${esc(p).replace(/\n/g, '<br/>')}</p>`).join('');

  const contactBits = [s.phone, s.address].map((x) => String(x || '').trim()).filter(Boolean);
  const contactLine = contactBits.map(esc).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  const cta = (c.ctaText && c.ctaUrl)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 10px;"><tr><td style="background:${accent};border-radius:8px;">
        <a href="${esc(c.ctaUrl)}" style="display:inline-block;padding:13px 30px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;">${esc(c.ctaText)}</a>
      </td></tr></table>`
    : '';

  const hero = c.imageUrl
    ? `<img src="${esc(c.imageUrl)}" alt="" style="display:block;width:100%;max-width:600px;height:auto;border-radius:8px;margin:0 0 18px;" />`
    : '';

  // Preheader: hidden preview text next to the subject in the inbox list.
  const preheader = c.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(c.preheader)}</div>`
    : '';

  const html = `<div style="background:#f4f4f2;margin:0;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
  ${preheader}
  <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e2;border-radius:10px;overflow:hidden;">
    <tr><td style="padding:28px 36px 18px;border-top:4px solid ${accent};">
      <div style="font-size:21px;font-weight:bold;color:#111827;">${esc(name)}</div>
      ${s.tagline ? `<div style="font-size:13px;color:#9ca3af;margin-top:2px;">${esc(s.tagline)}</div>` : ''}
    </td></tr>
    <tr><td style="padding:6px 36px 28px;">
      ${hero}
      ${c.headline ? `<div style="font-size:22px;font-weight:bold;color:#111827;line-height:1.3;margin:0 0 12px;">${esc(c.headline)}</div>` : ''}
      <p style="font-size:15px;color:#374151;line-height:1.65;margin:0 0 14px;">${greeting}</p>
      ${bodyHtml}
      ${cta}
    </td></tr>
    <tr><td style="padding:18px 36px 24px;border-top:1px solid #ececec;">
      <div style="font-size:13px;color:#111827;font-weight:bold;">${esc(name)}</div>
      ${contactLine ? `<div style="font-size:12px;color:#9ca3af;margin-top:3px;">${contactLine}</div>` : ''}
      <p style="font-size:11.5px;color:#9ca3af;line-height:1.6;margin:12px 0 0;">
        You're receiving this because you reached out to ${esc(name)} for a quote or booking.
        ${unsubscribeUrl ? `<a href="${esc(unsubscribeUrl)}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a> any time.` : ''}
      </p>
    </td></tr>
  </table>
  ${openPixel ? `<img src="${esc(openPixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden;" />` : ''}
</div>`;

  const text = [
    greeting.replace(/<[^>]+>/g, ''),
    '',
    c.headline || '',
    c.headline ? '' : null,
    String(c.body || '').trim(),
    '',
    (c.ctaText && c.ctaUrl) ? `${c.ctaText}: ${c.ctaUrl}` : '',
    '',
    `— ${name}${s.phone ? `, ${s.phone}` : ''}`,
    s.address || '',
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : '',
  ].filter((x) => x !== null && x !== '').join('\n');

  return { subject: c.subject || `News from ${name}`, html, text };
}

// Shop identity block for the template, from settings.
function shopIdentity(s) {
  return { name: s.shopName, tagline: s.tagline, phone: s.phone, address: s.address, email: s.email, accentColor: s.accentColor };
}

// ── Send engine ───────────────────────────────────────────────────────────────
// One in-process paced loop per campaign. `_inFlight` guards against the route
// kicking off a campaign the scheduler is already resuming (and vice versa).
// Progress persists per-send, so a crash mid-campaign loses at most the email
// in flight; the scheduler's resume pass picks the campaign back up.
const _inFlight = new Set();
const SEND_SPACING_MS = 650;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCampaignSend(shopId, campaignId) {
  const key = `${shopId}:${campaignId}`;
  if (_inFlight.has(key)) return;
  _inFlight.add(key);
  try {
    const shop = master.get('shops').find({ id: shopId }).value();
    if (!shop) return;

    for (;;) {
      // Fresh DB handle each iteration — getShopDb snapshots the file at open
      // and upsert writes the WHOLE file back, so holding one handle across a
      // minutes-long blast would clobber every lead/appointment written by
      // request handlers in the meantime. Re-opening also picks up mid-send
      // unsubscribes and settings edits.
      const db = getShopDb(shopId);
      const h = shopHelpers(db);
      ensureCampaigns(db);
      const s = db.get('settings').value() || {};
      const shopObj = shopIdentity(s);
      const c = h.getById('campaigns', campaignId);
      if (!c || c.status !== 'sending') return;
      // Launch route stamps baseUrl from its request; env base is the fallback
      // for campaigns resumed after a restart on an older snapshot.
      const base = (c.baseUrl || publicBase()).replace(/\/$/, '');
      const next = (c.recipients || []).find((r) => r.status === 'pending');
      if (!next) {
        c.status = 'sent';
        c.finishedAt = new Date().toISOString();
        h.upsert('campaigns', c);
        console.log(`Newsletter "${c.subject}" finished: ${c.sentCount || 0} sent, ${c.failCount || 0} failed (${shop.slug})`);
        return;
      }

      const lead = h.getById('leads', next.leadId) || { name: next.name, email: next.email };
      if (lead.emailOptOut) {
        next.status = 'skipped';
      } else {
        const unsubscribeUrl = base ? `${base}/u/${shop.slug}/${next.leadId}` : '';
        const openPixel = base ? `${base}/api/public/${shop.slug}/newsletter/${campaignId}/opened.gif?l=${encodeURIComponent(next.leadId)}` : '';
        const { subject, html, text } = renderNewsletterEmail({ shop: shopObj, campaign: c, lead, unsubscribeUrl, openPixel });
        const headers = unsubscribeUrl
          ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
          : undefined;
        const r = await deliver({ to: next.email, subject, html, text, headers });
        if (r.ok) {
          next.status = 'sent'; next.sentAt = new Date().toISOString();
          c.sentCount = (c.sentCount || 0) + 1;
        } else {
          next.status = 'failed'; next.error = r.reason;
          c.failCount = (c.failCount || 0) + 1;
          // A config-level failure (no key at all) will fail every send the
          // same way — stop after the first so the owner sees one clear error
          // instead of a hundred.
          if (/not set up|RESEND_API_KEY|SMTP_HOST/i.test(r.reason || '') ) {
            c.status = 'failed'; c.error = r.reason;
            h.upsert('campaigns', c);
            return;
          }
        }
      }
      h.upsert('campaigns', c);
      await sleep(SEND_SPACING_MS);
    }
  } catch (e) {
    console.error('Newsletter send error:', e.message);
  } finally {
    _inFlight.delete(key);
  }
}

// Scheduler hook: resume any campaign left 'sending' with pending recipients
// (process restarted mid-blast). No-op for campaigns already in flight here.
function resumeStalledCampaigns(db, shop) {
  ensureCampaigns(db);
  for (const c of db.get('campaigns').value() || []) {
    if (c.status !== 'sending') continue;
    if (!(c.recipients || []).some((r) => r.status === 'pending')) continue;
    runCampaignSend(shop.id, c.id).catch((e) => console.error('Newsletter resume error:', e.message));
  }
}

module.exports = { audience, renderNewsletterEmail, shopIdentity, runCampaignSend, resumeStalledCampaigns, ensureCampaigns, publicBase };

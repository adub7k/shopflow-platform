// ── Owner email notifications (speed-to-lead) ───────────────────────────────────
// A2P isn't registered yet, so the "new lead" ping to the shop owner is email:
// every form submit and missed call sends a short email with the caller's number
// as a tel: link — everything needed to call back without opening the app.
//
// Config-gated: with no SMTP_* env vars the module is a silent no-op, so local
// dev and self-hosted installs without mail just skip it. Required env:
//   SMTP_HOST, SMTP_USER, SMTP_PASS   (SMTP_PORT optional, default 587;
//   port 465 switches to implicit TLS)
//   SMTP_FROM optional — the visible From address, e.g.
//   'ShopFlow <no-reply@yourdomain.com>'. Set this when SMTP_USER isn't a real
//   mailbox (SendGrid 'apikey', SES IAM name). Falls back to SMTP_USER.
// Recipient: settings.notificationEmail (per-shop override) → shop.email (the
// signup/login email on the master shop record).
// Delivery channel: Resend's HTTPS API is preferred because many hosts (e.g.
// Railway's non-Pro plans) block outbound SMTP ports, which makes nodemailer
// time out. Resend goes over 443, so it works everywhere. Set:
//   RESEND_API_KEY  — enables the API path
//   RESEND_FROM     — verified-domain sender, e.g. 'MAD Detailing <leads@shopflowtech.com>'
// With no RESEND_API_KEY it falls back to the SMTP_* path below.
const nodemailer = require('nodemailer');

let transporter = null; // null = not built yet, false = SMTP not configured
function mailer() {
  if (transporter !== null) return transporter;
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  transporter = (SMTP_HOST && SMTP_USER && SMTP_PASS)
    ? nodemailer.createTransport({
        host: SMTP_HOST, port, secure: port === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
        // Fail fast instead of nodemailer's ~2-min defaults: a blocked port or
        // bad host would otherwise hang the request (and the "Send test" button)
        // indefinitely. 12s is plenty for a healthy connect + STARTTLS + auth.
        connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 15000,
      })
    : false;
  if (!transporter) console.log('Owner email: SMTP_* not set — notifications disabled');
  return transporter;
}

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(raw || '');
}
function telHref(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return 'tel:' + (d.length === 10 ? '+1' + d : '+' + d);
}

// Deliver one email over whichever channel is configured — Resend's HTTPS API
// first (survives SMTP-blocked hosts), else SMTP via nodemailer. Never throws;
// returns { ok:true } or { ok:false, reason } so callers can log or surface it.
async function deliver({ to, subject, html, text }) {
  if (!to) return { ok: false, reason: 'No recipient email set.' };
  const from = process.env.RESEND_FROM
    || process.env.SMTP_FROM
    || (process.env.SMTP_USER ? `"ShopFlow" <${process.env.SMTP_USER}>` : 'ShopFlow <onboarding@resend.dev>');

  // Preferred: Resend HTTPS API (port 443 — unaffected by SMTP egress blocks).
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html, text }),
      });
      if (res.ok) return { ok: true };
      let detail = '';
      try { const j = await res.json(); detail = j.message || j.name || ''; } catch (_) {}
      return { ok: false, reason: `Resend rejected the email (${res.status}${detail ? ': ' + detail : ''}).` };
    } catch (e) {
      return { ok: false, reason: e.message || 'Could not reach the email service.' };
    }
  }

  // Fallback: SMTP via nodemailer.
  const t = mailer();
  if (!t) return { ok: false, reason: 'Email is not set up on the server yet (set RESEND_API_KEY, or SMTP_HOST/USER/PASS).' };
  try {
    await t.sendMail({ from, to, subject, html, text });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || 'The email provider rejected the message.' };
  }
}

// kind: 'form' (new form lead) | 'form-repeat' (existing lead re-submitted)
//       | 'missed-call'
// Fire-and-forget: never throws, never blocks the caller's response.
function notifyNewLead({ shop, settings, lead, kind }) {
  try {
    const to = String((settings || {}).notificationEmail || (shop || {}).email || '').trim();
    if (!to) return;

    const shopName = (settings || {}).shopName || (shop || {}).shopName || 'your shop';
    const phonePretty = fmtPhone(lead.phone);
    const who = lead.name || phonePretty || 'Unknown caller';

    const subject =
      kind === 'ai-callback' ? `🔴 CALL BACK NOW: ${who} asked for a person — ${shopName}`
      : kind === 'missed-call' ? `📞 Missed call: ${who} — ${shopName}`
      : kind === 'form-repeat' ? `🔁 Lead submitted again: ${who} — ${shopName}`
      : `🚗 New lead: ${who} — ${shopName}`;

    const v = lead.vehicle || {};
    const vehicle = [v.year, v.make, v.model, v.color && `(${v.color})`].filter(Boolean).join(' ');
    const rows = [
      ['Name', esc(lead.name) || '—'],
      ['Phone', `<a href="${telHref(lead.phone)}" style="color:#16a34a;font-weight:600;">${esc(phonePretty)}</a>`],
      lead.email && ['Email', esc(lead.email)],
      vehicle && ['Vehicle', esc(vehicle)],
      (lead.servicesInterested || []).length && ['Interested in', esc(lead.servicesInterested.join(', '))],
      lead.source && ['Source', esc(lead.source + (lead.utm?.campaign ? ` · ${lead.utm.campaign}` : ''))],
      lead.location && ['Location', esc(lead.location)],
      lead.notes && ['Notes', esc(lead.notes)],
    ].filter(Boolean);

    const base = (process.env.APP_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
    const appLink = base && shop?.slug ? `${base}/shop/${shop.slug}` : '';
    const headline = kind === 'ai-callback'
      ? 'This caller asked to speak with a person. The assistant took their number — call them back right away.'
      : kind === 'missed-call'
      ? 'You missed a call — they may still be shopping around. Call back now.'
      : 'Someone just asked for a quote. Leads answered in 5 minutes book far more often.';

    deliver({
      to,
      subject,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px 16px;">
        <h2 style="color:${kind === 'ai-callback' ? '#dc2626' : '#16a34a'};margin:0 0 6px;">${kind === 'ai-callback' ? 'Callback requested' : kind === 'missed-call' ? 'Missed call' : 'New lead'}</h2>
        <p style="color:#374151;margin:0 0 16px;">${headline}</p>
        <table style="width:100%;border-collapse:collapse;background:#f0fdf4;border:1px solid #dcfce7;border-radius:10px;">
          ${rows.map(([k, val]) => `<tr>
            <td style="padding:8px 12px;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${k}</td>
            <td style="padding:8px 12px;color:#111827;font-size:13px;">${val}</td>
          </tr>`).join('')}
        </table>
        <a href="${telHref(lead.phone)}" style="display:block;text-align:center;background:#16a34a;color:#fff;text-decoration:none;border-radius:10px;padding:12px;margin:16px 0 8px;font-weight:600;">📞 Call ${esc(who)} now</a>
        ${appLink ? `<a href="${appLink}" style="display:block;text-align:center;color:#6b7280;font-size:12px;">View in ShopFlow → Leads</a>` : ''}
        <p style="color:#9ca3af;font-size:11px;margin-top:20px;">Powered by ShopFlow</p>
      </div>`,
    }).then(
      (r) => r.ok ? console.log(`Owner email sent (${kind}) →`, to) : console.error('Owner email failed:', r.reason),
    );
  } catch (e) {
    console.error('Owner email error:', e.message);
  }
}

// Send a one-off test email so an owner can verify alerts land in their inbox
// from Settings, without waiting for a real lead. Unlike notifyNewLead (fire-
// and-forget), this AWAITS the send and returns a plain result the UI can show,
// so the exact reason surfaces in the browser instead of only the server log.
//   { ok:true, to } on success
//   { ok:false, reason } if SMTP isn't configured, there's no recipient, or the
//   provider rejects the send (bad app password, etc.)
async function sendTest({ to }) {
  if (!to) return { ok: false, reason: 'No alert email is set — enter one above and try again.' };
  const r = await deliver({
    to,
    subject: '✅ ShopFlow test — new-lead alerts are working',
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px 16px;">
      <h2 style="color:#16a34a;margin:0 0 6px;">You're all set ✅</h2>
      <p style="color:#374151;margin:0 0 12px;">This is a test from your ShopFlow settings. If you're reading it, new-lead and missed-call alerts will arrive at <b>${esc(to)}</b>.</p>
      <p style="color:#9ca3af;font-size:11px;margin-top:20px;">Powered by ShopFlow</p>
    </div>`,
  });
  return r.ok ? { ok: true, to } : r;
}

// Email a customer their estimate: a branded summary (line items, tax, total,
// deposit note) plus a big button to the public quote page where they approve,
// decline, or pay a deposit. This is the email counterpart to the SMS "send"
// path — the channel that actually works before A2P is registered. AWAITS the
// send and returns { ok, reason } so the UI can surface the exact failure.
async function sendQuoteEmail({ to, shopName, accentColor, quote, link }) {
  if (!to) return { ok: false, reason: 'No email address on file for this customer.' };
  const q = quote || {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(accentColor || '') ? accentColor : '#16a34a';
  const money = (v) => '$' + Number(v || 0).toFixed(2);
  const firstName = String(q.customerName || 'there').trim().split(/\s+/)[0] || 'there';
  const name = shopName || 'your shop';

  const v = q.vehicle || {};
  const vehicle = [v.year, v.make, v.model, v.color && `(${v.color})`].filter(Boolean).join(' ');

  const itemRows = (q.lineItems || []).map((l) => `<tr>
      <td style="padding:11px 18px;border-bottom:1px solid #eef0f3;font-size:14px;color:#111827;">${esc(l.name)}</td>
      <td style="padding:11px 18px;border-bottom:1px solid #eef0f3;font-size:14px;color:#111827;font-weight:700;text-align:right;white-space:nowrap;">${money(l.price)}</td>
    </tr>`).join('');

  const taxRows = q.taxAmount ? `<tr>
      <td style="padding:8px 18px;font-size:13px;color:#6b7280;">Subtotal</td>
      <td style="padding:8px 18px;font-size:13px;color:#6b7280;text-align:right;">${money(q.subtotal)}</td>
    </tr><tr>
      <td style="padding:0 18px 8px;font-size:13px;color:#6b7280;">${esc(q.taxLabel || 'Sales Tax')} (${q.taxRate}%)</td>
      <td style="padding:0 18px 8px;font-size:13px;color:#6b7280;text-align:right;">${money(q.taxAmount)}</td>
    </tr>` : '';

  const depositNote = (q.depositRequired && !q.depositPaid)
    ? `<p style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;font-size:13px;color:#92400e;font-weight:600;text-align:center;margin:0 0 16px;">💳 A ${money(q.depositAmount)} deposit is required to approve this estimate.</p>`
    : '';

  const notesNote = q.notes
    ? `<p style="font-size:13px;color:#6b7280;line-height:1.5;margin:0 0 16px;">${esc(q.notes)}</p>`
    : '';

  const subject = `Your estimate from ${name}${q.number ? ` — ${q.number}` : ''}`;
  const text = `Hi ${firstName}, here's your estimate from ${name}${q.number ? ` (${q.number})` : ''} — total ${money(q.total)}. View & approve: ${link}`;

  const r = await deliver({
    to, subject, text,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px 16px;">
      <div style="text-align:center;padding:8px 0 20px;">
        <h2 style="color:${accent};margin:0 0 4px;font-size:20px;">${esc(name)}</h2>
        <p style="color:#6b7280;margin:0;font-size:14px;">Hi ${esc(firstName)}, here's your estimate.</p>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e8eaee;border-radius:12px;overflow:hidden;">
        <tr><td colspan="2" style="padding:13px 18px;border-bottom:1px solid #eef0f3;background:#f9fafb;">
          <span style="font-size:12px;font-weight:700;color:#6b7280;font-family:ui-monospace,Menlo,monospace;">${esc(q.number || 'Estimate')}</span>
          ${vehicle ? `<span style="font-size:12px;color:#6b7280;margin-left:10px;">🚗 ${esc(vehicle)}</span>` : ''}
        </td></tr>
        ${itemRows}
        ${taxRows}
        <tr><td style="padding:14px 18px;font-size:17px;font-weight:900;color:#111827;">Total</td>
          <td style="padding:14px 18px;font-size:17px;font-weight:900;color:${accent};text-align:right;">${money(q.total)}</td></tr>
      </table>
      <div style="margin:18px 0 8px;">${depositNote}${notesNote}</div>
      <a href="${esc(link)}" style="display:block;text-align:center;background:${accent};color:#fff;text-decoration:none;border-radius:100px;padding:15px;font-weight:800;font-size:16px;">View & approve estimate →</a>
      <p style="color:#9ca3af;font-size:11px;margin-top:24px;text-align:center;">Powered by ShopFlow</p>
    </div>`,
  });
  return r;
}

// deliver/mailer are exported so server/integrations.js (website-leads modules)
// shares the same channel selection + config-gating as the owner notifications.
module.exports = { notifyNewLead, mailer, sendTest, deliver, sendQuoteEmail };

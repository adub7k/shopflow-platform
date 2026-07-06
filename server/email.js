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

// kind: 'form' (new form lead) | 'form-repeat' (existing lead re-submitted)
//       | 'missed-call'
// Fire-and-forget: never throws, never blocks the caller's response.
function notifyNewLead({ shop, settings, lead, kind }) {
  try {
    const t = mailer();
    if (!t) return;
    const to = String((settings || {}).notificationEmail || (shop || {}).email || '').trim();
    if (!to) return;

    const shopName = (settings || {}).shopName || (shop || {}).shopName || 'your shop';
    const phonePretty = fmtPhone(lead.phone);
    const who = lead.name || phonePretty || 'Unknown caller';

    const subject =
      kind === 'missed-call' ? `📞 Missed call: ${who} — ${shopName}`
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
    const headline = kind === 'missed-call'
      ? 'You missed a call — they may still be shopping around. Call back now.'
      : 'Someone just asked for a quote. Leads answered in 5 minutes book far more often.';

    t.sendMail({
      from: process.env.SMTP_FROM || `"ShopFlow" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px 16px;">
        <h2 style="color:#16a34a;margin:0 0 6px;">${kind === 'missed-call' ? 'Missed call' : 'New lead'}</h2>
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
      () => console.log(`Owner email sent (${kind}) →`, to),
      (e) => console.error('Owner email failed:', e.message),
    );
  } catch (e) {
    console.error('Owner email error:', e.message);
  }
}

module.exports = { notifyNewLead };

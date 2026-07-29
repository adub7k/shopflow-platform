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

const _MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function fmtDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  return `${_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Build the estimate email as { subject, html, text } — a plain business
// document (letterhead → itemized estimate → totals → approve link → the shop's
// own sign-off and contact block), NOT a marketing/notification template: no
// emoji, no "Powered by" badge, real shop contact info so it reads like it came
// straight from the shop. Pure/no I/O so it can be previewed and unit-tested.
// `shop`: { name, tagline, phone, address, email, accentColor }.
function renderQuoteEmail({ shop, quote, link }) {
  const s = shop || {};
  const q = quote || {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(s.accentColor || '') ? s.accentColor : '#16a34a';
  const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const name = s.name || 'our shop';
  const firstName = String(q.customerName || '').trim().split(/\s+/)[0] || '';

  const v = q.vehicle || {};
  const vehicle = [v.year, v.make, v.model, v.color && `(${v.color})`].filter(Boolean).join(' ');

  const itemRows = (q.lineItems || []).map((l) => `<tr>
        <td style="padding:12px 0;border-bottom:1px solid #ececec;font-size:15px;color:#222;">${esc(l.name)}</td>
        <td style="padding:12px 0;border-bottom:1px solid #ececec;font-size:15px;color:#222;text-align:right;white-space:nowrap;">${money(l.price)}</td>
      </tr>`).join('');

  const taxRows = q.taxAmount ? `<tr>
        <td style="padding:6px 0 0;font-size:14px;color:#777;">Subtotal</td>
        <td style="padding:6px 0 0;font-size:14px;color:#777;text-align:right;">${money(q.subtotal)}</td>
      </tr><tr>
        <td style="padding:2px 0;font-size:14px;color:#777;">${esc(q.taxLabel || 'Sales Tax')} (${q.taxRate}%)</td>
        <td style="padding:2px 0;font-size:14px;color:#777;text-align:right;">${money(q.taxAmount)}</td>
      </tr>` : '';

  const depositNote = (q.depositRequired && !q.depositPaid)
    ? `<p style="font-size:14px;color:#555;line-height:1.55;margin:0 0 18px;">A deposit of <strong>${money(q.depositAmount)}</strong> is required to approve this estimate; the balance is due at completion.</p>`
    : '';
  const notesNote = q.notes
    ? `<p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 18px;white-space:pre-line;">${esc(q.notes)}</p>`
    : '';

  // Contact line for the letterhead + footer — only the parts the shop has filled in.
  const contactBits = [s.phone, s.address, s.email].map((x) => String(x || '').trim()).filter(Boolean);
  const contactLine = contactBits.map(esc).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  const greeting = firstName ? `Hi ${esc(firstName)},` : 'Hello,';

  const subject = `Estimate${q.number ? ` ${q.number}` : ''} from ${name}`;
  const text = [
    greeting.replace(/<[^>]+>/g, ''),
    ``,
    `Thanks for the opportunity to earn your business. Here's the estimate${q.number ? ` (${q.number})` : ''}${vehicle ? ` for your ${vehicle}` : ''}:`,
    ``,
    ...(q.lineItems || []).map((l) => `  ${l.name} — ${money(l.price)}`),
    q.taxAmount ? `  ${q.taxLabel || 'Sales Tax'} (${q.taxRate}%) — ${money(q.taxAmount)}` : '',
    `  Total — ${money(q.total)}`,
    ``,
    q.depositRequired && !q.depositPaid ? `A ${money(q.depositAmount)} deposit is required to approve.` : '',
    `Review and approve your estimate here: ${link}`,
    ``,
    `— ${name}${s.phone ? `, ${s.phone}` : ''}`,
  ].filter((x) => x !== '').join('\n');

  const html = `<div style="background:#f2f2f0;margin:0;padding:24px 12px;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e2df;">
    <tr><td style="padding:34px 40px 22px;border-top:3px solid ${accent};">
      <div style="font-size:23px;font-weight:bold;color:#1a1a1a;letter-spacing:-.01em;">${esc(name)}</div>
      ${s.tagline ? `<div style="font-size:14px;color:#888;margin-top:3px;font-style:italic;">${esc(s.tagline)}</div>` : ''}
      ${contactLine ? `<div style="font-size:12.5px;color:#999;margin-top:9px;font-family:Arial,Helvetica,sans-serif;">${contactLine}</div>` : ''}
    </td></tr>
    <tr><td style="padding:6px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ececec;padding-top:20px;">
        <tr>
          <td style="font-size:19px;font-weight:bold;color:#1a1a1a;letter-spacing:.14em;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">Estimate</td>
          <td style="text-align:right;font-size:13px;color:#888;font-family:Arial,Helvetica,sans-serif;">${q.number ? `${esc(q.number)}<br/>` : ''}${fmtDate(q.createdAt)}</td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:16px 40px 0;">
      <p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 4px;">${greeting}</p>
      <p style="font-size:15px;color:#333;line-height:1.6;margin:0;">Thank you for the opportunity to earn your business. Here's the estimate${vehicle ? ` for your <strong>${esc(vehicle)}</strong>` : ''}, prepared just for you.</p>
    </td></tr>
    <tr><td style="padding:22px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${itemRows}
        ${taxRows}
        <tr>
          <td style="padding:14px 0 0;font-size:17px;font-weight:bold;color:#1a1a1a;">Total</td>
          <td style="padding:14px 0 0;font-size:17px;font-weight:bold;color:${accent};text-align:right;">${money(q.total)}</td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:24px 40px 0;">${depositNote}${notesNote}</td></tr>
    <tr><td style="padding:6px 40px 34px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${accent};">
        <a href="${esc(link)}" style="display:inline-block;padding:13px 30px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;">Review &amp; approve estimate</a>
      </td></tr></table>
      <p style="font-size:12.5px;color:#999;margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;">Or paste this link into your browser:<br/><a href="${esc(link)}" style="color:${accent};">${esc(link)}</a></p>
    </td></tr>
    <tr><td style="padding:20px 40px 30px;border-top:1px solid #ececec;">
      <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 10px;">We appreciate your business and look forward to taking care of you.</p>
      <div style="font-size:14px;color:#1a1a1a;font-weight:bold;">${esc(name)}</div>
      ${contactLine ? `<div style="font-size:12.5px;color:#999;margin-top:4px;font-family:Arial,Helvetica,sans-serif;">${contactLine}</div>` : ''}
    </td></tr>
  </table>
</div>`;

  return { subject, html, text };
}

// Email a customer their estimate — the counterpart to the SMS "send" path,
// and the channel that works before A2P is registered. AWAITS the send and
// returns { ok, reason } so the UI can surface the exact failure.
async function sendQuoteEmail({ to, shop, quote, link }) {
  if (!to) return { ok: false, reason: 'No email address on file for this customer.' };
  const { subject, html, text } = renderQuoteEmail({ shop, quote, link });
  return deliver({ to, subject, html, text });
}

// deliver/mailer are exported so server/integrations.js (website-leads modules)
// shares the same channel selection + config-gating as the owner notifications.
// renderQuoteEmail is exported so the template can be previewed + unit-tested.
module.exports = { notifyNewLead, mailer, sendTest, deliver, sendQuoteEmail, renderQuoteEmail };

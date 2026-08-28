// ── Newsletter ────────────────────────────────────────────────────────────────
// Compose + send an email blast to every lead with an email address (Meta lead
// ads, website form, hand-entered — one list). Server side: routes/newsletter.js
// + the paced send loop in server/newsletter.js. One draft at a time: the
// composer always edits the newest draft campaign; sending archives it into the
// history list below with live progress + opens.
const Newsletter = {
  _draft: null, _audience: { count: 0, total: 0, withEmail: 0, optedOut: 0 }, _campaigns: [], _pollTimer: null,

  async render() {
    const el = document.getElementById('page-newsletter'); if (!el) return;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading…</p></div>';
    let s = {};
    try {
      const [nl, settings] = await Promise.all([db.newsletter.all(), db.settings.get()]);
      this._audience = nl.audience; this._campaigns = nl.campaigns; s = settings;
    } catch (e) { el.innerHTML = `<div class="card"><p style="color:var(--muted)">${esc(e.message)}</p></div>`; return; }
    this._draft = this._campaigns.find(c => c.status === 'draft') || null;
    const a = this._audience;
    const d = this._draft || {};
    const bookUrl = location.origin + '/book/' + (Auth.getShopSlug() || '');
    const html = [];

    // Audience banner — who this will reach, and how healthy the list is.
    const noEmails = a.total - a.withEmail;
    html.push(`<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;margin-bottom:18px;background:var(--green-lt);border:1px solid var(--green-md);">
      <div style="font-size:22px;flex-shrink:0;">📬</div>
      <div style="flex:1;"><div style="font-size:13px;font-weight:700;color:var(--green);">${a.count} subscriber${a.count === 1 ? '' : 's'} on your list</div>
      <div style="font-size:12px;color:var(--muted);margin-top:1px;">${a.withEmail} of your ${a.total} leads left an email address${a.optedOut ? ` · ${a.optedOut} unsubscribed` : ''}${noEmails > 0 ? `. Tip: make sure your Meta form and website ask for email.` : ''}</div></div>
    </div>`);

    // CAN-SPAM: marketing email legally needs the shop's physical address.
    if (!String(s.address || '').trim()) {
      html.push(`<div style="font-size:12px;color:var(--orange);background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:9px 12px;margin-bottom:14px;">⚠ Marketing emails must include your business address (it goes in the footer automatically). Add it in <a href="#" onclick="App.nav('settings');return false;" style="color:var(--orange);font-weight:600;">Settings → Shop Info</a> before sending.</div>`);
    }

    // Composer
    html.push('<div class="section-header">Compose</div><div class="card">');
    html.push(`<div class="form-group"><label class="form-label">Subject line</label><input class="form-input" id="nl-subject" maxlength="150" placeholder="e.g. August special: $50 off ceramic coating" value="${esc(d.subject || '')}" /></div>`);
    html.push(`<div class="form-group"><label class="form-label">Preview text <span style="font-weight:400;color:var(--faint);">(optional)</span></label><input class="form-input" id="nl-preheader" maxlength="150" placeholder="Shown next to the subject in the inbox" value="${esc(d.preheader || '')}" /></div>`);
    html.push(`<div class="form-group"><label class="form-label">Headline <span style="font-weight:400;color:var(--faint);">(optional)</span></label><input class="form-input" id="nl-headline" maxlength="150" placeholder="Big line at the top of the email" value="${esc(d.headline || '')}" /></div>`);
    html.push(`<div class="form-group"><label class="form-label">Message</label><textarea class="form-input" id="nl-body" rows="8" maxlength="8000" placeholder="Write like you'd text a good customer. Blank line = new paragraph.">${esc(d.body || '')}</textarea></div>`);
    html.push(`<div class="form-group"><label class="form-label">Image URL <span style="font-weight:400;color:var(--faint);">(optional)</span></label><input class="form-input" id="nl-image" maxlength="500" placeholder="Paste a photo URL — e.g. one from your Work Gallery" value="${esc(d.imageUrl || '')}" /><div style="font-size:11px;color:var(--muted);margin-top:5px;">Right-click any photo in Settings → Work Gallery and copy its address.</div></div>`);
    html.push(`<div style="display:grid;grid-template-columns:1fr 1.4fr;gap:10px;">
      <div class="form-group"><label class="form-label">Button text</label><input class="form-input" id="nl-ctatext" maxlength="60" placeholder="Get a free quote" value="${esc(d.ctaText || '')}" /></div>
      <div class="form-group"><label class="form-label">Button link</label><input class="form-input" id="nl-ctaurl" maxlength="500" placeholder="${esc(bookUrl)}" value="${esc(d.ctaUrl || '')}" /></div>
    </div>`);
    html.push(`<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px;">
      <button class="btn btn-green" onclick="Newsletter.send()">Send to ${a.count} subscriber${a.count === 1 ? '' : 's'}</button>
      <button class="btn" onclick="Newsletter.sendTest()">Email me a test</button>
      <button class="btn" onclick="Newsletter.saveDraft(true)">Save draft</button>
    </div>`);
    const replyTo = String(s.newsletterReplyTo || s.email || s.notificationEmail || '').trim();
    html.push(`<div style="font-size:11px;color:var(--faint);margin-top:10px;">Every email is branded with your shop name and colors, greets each lead by first name, and includes the required unsubscribe link + your business address in the footer. Replies go to <strong>${replyTo ? esc(replyTo) : 'your shop email'}</strong> — <a href="#" onclick="App.nav('settings');return false;" style="color:var(--faint);text-decoration:underline;">change in Settings → Newsletter Replies</a>.</div>`);
    html.push('</div>');

    // History
    if (this._campaigns.some(c => c.status !== 'draft')) {
      html.push('<div class="section-header">Sent Issues</div><div class="list-card">');
      for (const c of this._campaigns.filter(c => c.status !== 'draft')) {
        html.push(this._historyRow(c));
      }
      html.push('</div>');
    }
    el.innerHTML = html.join('');

    // Live progress while a blast is going out.
    if (this._campaigns.some(c => c.status === 'sending')) {
      this._pollTimer = setTimeout(() => { if (App._page === 'newsletter') this.render(); }, 4000);
    }
  },

  _historyRow(c) {
    const when = c.sentAt ? new Date(c.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const pill = c.status === 'sending'
      ? `<span style="font-size:10px;font-weight:700;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:20px;padding:3px 9px;">Sending ${(c.sentCount || 0)}/${c.recipientCount}…</span>`
      : c.status === 'failed'
      ? `<span style="font-size:10px;font-weight:700;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:20px;padding:3px 9px;">Failed</span>`
      : `<span style="font-size:10px;font-weight:700;color:var(--green);background:var(--green-lt);border:1px solid var(--green-md);border-radius:20px;padding:3px 9px;">Sent</span>`;
    const stats = [
      `${c.sentCount || 0} delivered`,
      c.failCount ? `${c.failCount} failed` : '',
      c.openCount ? `${c.openCount} opened` : '',
    ].filter(Boolean).join(' · ');
    const err = c.status === 'failed' && c.error ? `<div style="font-size:12px;color:#b91c1c;margin-top:4px;">${esc(c.error)} <a href="#" onclick="Newsletter.resend('${c.id}');return false;" style="font-weight:600;">Retry</a></div>` : '';
    return `<div class="list-row" style="align-items:center;gap:12px;padding:14px 16px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13.5px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(c.subject || '(no subject)')}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px;">${when}${stats ? ' · ' + stats : ''}</div>${err}
      </div>
      ${pill}
    </div>`;
  },

  _collect() {
    const v = (id) => (document.getElementById(id) || {}).value || '';
    return {
      id: (this._draft || {}).id,
      subject: v('nl-subject').trim(), preheader: v('nl-preheader').trim(),
      headline: v('nl-headline').trim(), body: v('nl-body'),
      imageUrl: v('nl-image').trim(), ctaText: v('nl-ctatext').trim(), ctaUrl: v('nl-ctaurl').trim(),
    };
  },

  async saveDraft(announce) {
    const data = this._collect();
    try {
      this._draft = await db.newsletter.save(data);
      if (announce) toast('Draft saved ✓');
      return this._draft;
    } catch (e) { toast(e.message); return null; }
  },

  async sendTest() {
    const d = await this.saveDraft(false); if (!d) return;
    try {
      const r = await db.newsletter.test(d.id);
      toast('Test sent to ' + r.to + ' ✓');
    } catch (e) { toast(e.message); }
  },

  async send() {
    const d = await this.saveDraft(false); if (!d) return;
    if (!d.subject) { toast('Give the email a subject line first.'); return; }
    const n = this._audience.count;
    if (!confirm(`Send "${d.subject}" to ${n} subscriber${n === 1 ? '' : 's'}? This can't be undone.`)) return;
    try {
      await db.newsletter.send(d.id);
      toast('Sending — this takes about a second per email.');
      this.render();
    } catch (e) { toast(e.message); }
  },

  async resend(id) {
    try { await db.newsletter.send(id); toast('Retrying the failed sends…'); this.render(); }
    catch (e) { toast(e.message); }
  },
};

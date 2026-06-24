// ── Automations ───────────────────────────────────────────────────────────────
// Manage the campaign engine: toggle each campaign on/off and tune its timing.
// Config persists to settings.automations (+ settings.rebookInterval); the server
// engine (server/automation/engine.js) reads it on each scheduler tick. Absent
// config = reminder + rebook on, review off — identical to the legacy behavior.
const Automations = {
  _s: {}, _cfg: {}, _rebookInterval: 21,

  async render() {
    const el = document.getElementById('page-automations'); if (!el) return;
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading…</p></div>';
    try { this._s = await db.settings.get(); } catch(e) { this._s = {}; }
    const s = this._s, a = s.automations || {};
    this._cfg = {
      reminder: { enabled: a.reminder ? a.reminder.enabled !== false : true },
      rebook:   { enabled: a.rebook   ? a.rebook.enabled   !== false : true },
      review:   { enabled: a.review ? !!a.review.enabled : false, days: (a.review && a.review.days) || 2 },
    };
    this._rebookInterval = Math.min(90, Math.max(7, s.rebookInterval || 21));
    const tpl = s.smsTemplates || {};
    const smsActive = !!(s.trackingNumber || s.twilioConfigured);

    const html = [];
    // SMS status banner
    html.push(`<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;margin-bottom:18px;background:${smsActive?'var(--green-lt)':'var(--surface2)'};border:1px solid ${smsActive?'var(--green-md)':'var(--border)'};">
      <div style="width:10px;height:10px;border-radius:50%;background:${smsActive?'var(--green)':'#d1d5db'};flex-shrink:0;"></div>
      <div style="flex:1;"><div style="font-size:13px;font-weight:700;color:${smsActive?'var(--green)':'var(--text)'};">${smsActive?'SMS is active — enabled campaigns are running':'SMS not yet active'}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:1px;">${smsActive?'Toggle any campaign below on or off.':'Contact ShopFlow support to activate SMS for your shop.'}</div></div>
    </div>`);

    html.push('<div class="section-header">Campaigns</div><div class="list-card">');

    // Booking confirmation — transactional, always on (informational)
    html.push(this._row({ icon:'📩', title:'Booking Confirmation', badge:'Always on',
      desc:'Sent immediately when a client books online.',
      msg: tpl.confirmation }));

    // 24-hour reminder — toggle
    html.push(this._row({ icon:'⏰', title:'24-Hour Reminder', toggle:'reminder',
      desc:'Sent the day before each confirmed appointment to cut no-shows.',
      msg: tpl.reminder }));

    // Rebook nudge — toggle + interval
    html.push(this._row({ icon:'🔁', title:'Rebook Nudge', toggle:'rebook',
      desc:`Win back clients who haven't returned in a while.`,
      msg: tpl.rebook,
      extra:`<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--muted);">Send after
        <input type="number" min="7" max="90" value="${this._rebookInterval}" onchange="Automations.setInterval(this.value)" style="width:64px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;" /> days since last visit</div>` }));

    // Review request — toggle + days + link warning (new campaign)
    const reviewWarn = (this._cfg.review.enabled && !s.googleReviewLink)
      ? `<div style="font-size:12px;color:var(--orange);background:#fffbeb;border:1px solid #fde68a;border-radius:7px;padding:7px 10px;margin-top:8px;">⚠ Add your review link in <a href="#" onclick="App.nav('settings');return false;" style="color:var(--orange);font-weight:600;">Settings</a> for this to send.</div>` : '';
    html.push(this._row({ icon:'⭐', title:'Review Request', toggle:'review',
      desc:'Text your review link to clients a few days after their visit.',
      msg: tpl.review || "Hi {name}, thanks for visiting {shop}! We'd love your feedback — leave us a quick review: {link}",
      extra:`<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--muted);">Send
        <input type="number" min="0" max="30" value="${this._cfg.review.days}" onchange="Automations.setReviewDays(this.value)" style="width:64px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;" /> days after the visit</div>${reviewWarn}` }));

    html.push('</div>');
    html.push(`<div style="margin-top:12px;font-size:12px;color:var(--faint);text-align:center;">Edit message wording in <a href="#" onclick="App.nav('settings');return false;" style="color:var(--green);font-weight:600;">Settings → SMS Messaging</a></div>`);
    el.innerHTML = html.join('');
  },

  _row({ icon, title, desc, msg, toggle, badge, extra }) {
    const on = toggle ? this._cfg[toggle].enabled : true;
    const control = toggle
      ? `<button onclick="Automations.flip('${toggle}')" style="border:none;cursor:pointer;border-radius:20px;padding:6px 14px;font-size:12px;font-weight:700;flex-shrink:0;${on?'background:var(--green);color:#fff;':'background:var(--surface2);color:var(--muted);'}">${on?'On':'Off'}</button>`
      : `<span style="font-size:10px;font-weight:700;color:var(--muted);background:var(--surface2);border-radius:20px;padding:3px 9px;flex-shrink:0;">${badge||''}</span>`;
    const preview = msg ? `<div style="font-size:12px;color:var(--text);background:var(--off,var(--surface2));border-radius:7px;padding:8px 10px;font-style:italic;margin-top:6px;">"${esc(msg)}"</div>` : '';
    return `<div class="list-row" style="align-items:flex-start;gap:14px;padding:16px;${(!on&&toggle)?'opacity:.6;':''}">
      <div style="font-size:24px;line-height:1;flex-shrink:0;">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:14px;font-weight:700;color:var(--text);">${title}</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.5;margin-top:2px;">${desc}</div>
        ${preview}${extra||''}
      </div>
      ${control}
    </div>`;
  },

  async _save() {
    try { await db.settings.save({ automations: this._cfg, rebookInterval: this._rebookInterval }); toast('Saved ✓'); }
    catch(e) { toast(e.message || 'Could not save', 'error'); }
  },
  flip(key) { this._cfg[key].enabled = !this._cfg[key].enabled; this._save(); this.render(); },
  setInterval(v) { this._rebookInterval = Math.min(90, Math.max(7, Number(v) || 21)); this._save(); },
  setReviewDays(v) { this._cfg.review.days = Math.min(30, Math.max(0, Number(v) || 0)); this._save(); },
};

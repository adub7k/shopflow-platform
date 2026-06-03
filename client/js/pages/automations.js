// ── Automations ───────────────────────────────────────────────────────────────
const Automations = {
  async render() {
    const el = document.getElementById('page-automations'); if(!el) return;
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">Loading…</div>';

    let s = {};
    try { s = await db.settings.get(); } catch(e) {}
    const smsActive = s.twilioConfigured;
    const tpl = s.smsTemplates || {};
    const defConfirm  = "Hi {name}! Your appointment at {shop} is confirmed for {date} at {time}{barber}. See you then! ✂️";
    const defReminder = "Hi {name}! Reminder: your appointment at {shop} is tomorrow at {time}{barber}. See you then! ✂️";
    const defRebook   = "Hey {name}! It's been a few weeks — we'd love to have you back at {shop}. Book your next cut anytime 💈";

    const automations = [
      {
        icon: '📩',
        title: 'Booking Confirmation',
        desc: 'Sent immediately when a client books online.',
        message: tpl.confirmation || defConfirm,
      },
      {
        icon: '⏰',
        title: '24-Hour Reminder',
        desc: 'Sent the day before each confirmed appointment to reduce no-shows.',
        message: tpl.reminder || defReminder,
      },
      {
        icon: '🔁',
        title: `${s.rebookInterval || 21}-Day Rebook Nudge`,
        desc: `Sent to clients who haven't rebooked after ${s.rebookInterval || 21} days.`,
        message: tpl.rebook || defRebook,
      },
    ];

    let html = [];

    // SMS status banner
    html.push(`<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;margin-bottom:20px;background:${smsActive?'var(--green-lt)':'var(--surface2)'};border:1px solid ${smsActive?'var(--green-md)':'var(--border)'};">
      <div style="width:10px;height:10px;border-radius:50%;background:${smsActive?'var(--green)':'#d1d5db'};flex-shrink:0;"></div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:700;color:${smsActive?'var(--green)':'var(--text)'};">${smsActive?'SMS is active — automations are running':'SMS not yet active'}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:1px;">${smsActive?'All three automations below are firing automatically.':'Contact ShopFlow support to activate SMS for your shop.'}</div>
      </div>
    </div>`);

    html.push('<div class="section-header">Your Automations</div>');
    html.push('<div class="list-card">');
    automations.forEach(a => {
      html.push(`
        <div class="list-row" style="align-items:flex-start;gap:14px;padding:16px;">
          <div style="font-size:26px;line-height:1;flex-shrink:0;">${a.icon}</div>
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <div style="font-size:14px;font-weight:700;color:var(--text);">${a.title}</div>
              <span style="font-size:10px;font-weight:700;color:${smsActive?'#fff':'var(--muted)'};background:${smsActive?'var(--green)':'var(--border)'};border-radius:20px;padding:2px 8px;">${smsActive?'Active':'Pending'}</span>
            </div>
            <div style="font-size:12px;color:var(--muted);line-height:1.5;margin-bottom:6px;">${a.desc}</div>
            <div style="font-size:12px;color:var(--text);background:var(--off);border-radius:7px;padding:8px 10px;font-style:italic;">"${a.message}"</div>
          </div>
        </div>`);
    });
    html.push('</div>');

    html.push(`<div style="margin-top:12px;"><div style="font-size:12px;color:var(--faint);text-align:center;">Edit your message templates in <a href="#" onclick="App.nav('settings');return false;" style="color:var(--green);font-weight:600;">Settings → SMS Messaging</a></div></div>`);

    el.innerHTML = html.join('');
  },

  showUpgrade() {
    Modal.show(`
      <div class="modal-title">⚡ Unlock More Automations</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6;">Your current plan includes the 24-hour reminder and 21-day rebook nudge. Upgrade to Pro or Shop to unlock:</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">🎂</span> Birthday messages</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">💤</span> Win-back campaigns for inactive clients</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">⭐</span> Post-visit review requests</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">🎉</span> Loyalty milestone alerts</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">✏️</span> Custom message builder</div>
      </div>
      <div class="modal-actions">
        <a href="mailto:support@shopflow.io?subject=Upgrade Plan" class="btn btn-primary btn-full" style="text-decoration:none;text-align:center;">Contact Us to Upgrade</a>
        <button class="btn btn-full" onclick="Modal.close()">Maybe Later</button>
      </div>`);
  },
};

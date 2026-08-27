// ── Notifications ─────────────────────────────────────────────────────────────
// Standalone phone-notification page for staff who can't open Settings.
// Owners manage push under Settings → Phone Notifications; technicians have no
// Settings page at all (see ROLE_PAGES in app.js), so this is their only way to
// turn push on for their own phone. Same /api/push/* endpoints, same
// enablePushNotifications() helper from js/pwa-push-client.js.
const Notifications = {
  async render() {
    const el = document.getElementById('page-notifications'); if (!el) return;

    const supported = ('serviceWorker' in navigator) && ('PushManager' in window);
    const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
    const perm = supported && 'Notification' in window ? Notification.permission : 'unsupported';
    // iOS only exposes PushManager inside the installed PWA, so "unsupported"
    // there almost always means "not added to the home screen yet".
    const needsInstall = isIOS && !installed;
    const sub = supported ? await this._subscription() : null;

    let state, tone, msg;
    if (needsInstall)      { state = 'Add ShopFlow to your home screen first'; tone = 'warn';
      msg = 'On iPhone: tap the <strong>Share</strong> button in Safari → <strong>Add to Home Screen</strong>, then open ShopFlow from that icon and come back here. (Needs iOS 16.4 or newer.)'; }
    else if (!supported)   { state = 'Not supported on this browser'; tone = 'warn';
      msg = 'This phone or browser can\'t receive push notifications. Try opening ShopFlow in Chrome or Safari, or install it to your home screen.'; }
    else if (perm === 'denied') { state = 'Blocked in your browser settings'; tone = 'warn';
      msg = 'You (or someone) tapped "Don\'t allow". Turn notifications back on for ShopFlow in your phone\'s Settings → Notifications, then reload this page.'; }
    else if (sub)          { state = 'On for this phone'; tone = 'ok';
      msg = 'You\'ll get an alert here the moment a new lead comes in or a call is missed — even with the phone locked.'; }
    else                   { state = 'Off for this phone'; tone = 'off';
      msg = 'Turn these on and you\'ll get an alert the moment a new lead comes in or a call is missed — free, no texting fees.'; }

    const colors = { ok: ['var(--green-lt)','var(--green-md)','var(--green)'], warn: ['#fff7ed','#fed7aa','#c2410c'], off: ['var(--surface2)','var(--border)','var(--muted)'] }[tone];

    const html = [];
    html.push('<div class="card" style="background:' + colors[0] + ';border:1px solid ' + colors[1] + ';">');
    html.push('<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:22px;">' + (tone === 'ok' ? '🔔' : tone === 'warn' ? '⚠️' : '🔕') + '</span>'
      + '<div><div style="font-size:14px;font-weight:800;color:' + colors[2] + ';">' + state + '</div>'
      + '<div style="font-size:12px;color:var(--muted);margin-top:3px;line-height:1.45;">' + msg + '</div></div></div>');
    html.push('</div>');

    if (supported && !needsInstall && perm !== 'denied') {
      html.push('<div class="section-header">This Phone</div><div class="card">');
      html.push('<div style="display:flex;gap:8px;flex-wrap:wrap;">');
      if (sub) {
        html.push('<button class="btn" style="flex:1;min-width:150px;" onclick="Notifications.test(this)">Send a test</button>');
        html.push('<button class="btn" style="flex:1;min-width:150px;" onclick="Notifications.disable(this)">Turn off on this phone</button>');
      } else {
        html.push('<button class="btn btn-primary" style="flex:1;min-width:150px;" onclick="Notifications.enable(this)">🔔 Turn on notifications</button>');
      }
      html.push('</div>');
      html.push('<div style="font-size:11.5px;color:var(--muted);margin-top:12px;line-height:1.45;">Each phone is turned on separately — do this once on every device you want alerts on.</div>');
      html.push('</div>');
    }

    html.push('<div class="section-header">What You\'ll Get</div><div class="card">');
    [['📞','New lead','Someone submits your website or ad form.'],
     ['⏰','Missed call','A call comes in that nobody picks up — plus a reminder if it\'s still untouched 5 minutes later.']]
      .forEach(([icon, title, sub2]) => {
        html.push('<div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);"><span style="font-size:16px;">' + icon + '</span>'
          + '<div><div style="font-size:13px;font-weight:700;">' + title + '</div><div style="font-size:12px;color:var(--muted);margin-top:2px;line-height:1.4;">' + sub2 + '</div></div></div>');
      });
    html.push('<div style="font-size:11.5px;color:var(--faint);margin-top:10px;">Tapping a notification opens the lead in ShopFlow.</div>');
    html.push('</div>');

    el.innerHTML = html.join('');
  },

  async _subscription() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? await reg.pushManager.getSubscription() : null;
    } catch (e) { return null; }
  },

  async enable(btn) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Turning on…';
    try {
      // Pre-flight: no VAPID keys on the server = nothing to subscribe to.
      const chk = await fetch('/api/push/vapid-public-key', { headers: { 'Authorization': 'Bearer ' + Auth.getToken() } });
      if (!chk.ok) {
        toast(chk.status === 503 ? 'Push isn\'t set up on the server yet — ask your shop owner.' : 'Could not reach the push service (' + chk.status + ').', 'warning');
      } else {
        const ok = await enablePushNotifications(localStorage.getItem('sf_shopId'), Auth.getName() || 'staff');
        if (ok) toast('Notifications on for this phone ✓');
        else toast('Not enabled — you have to tap "Allow" on the browser prompt.', 'warning');
      }
    } catch (e) { toast(e.message || 'Could not turn on notifications', 'error'); }
    btn.disabled = false; btn.textContent = orig;
    this.render();
  },

  async test(btn) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + Auth.getToken() },
        body: JSON.stringify({ tenant_id: localStorage.getItem('sf_shopId') }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.sent) toast('Test sent ✓ — check your notifications');
      else if (j.error === 'not configured') toast('Push isn\'t set up on the server yet — ask your shop owner.', 'warning');
      else toast('No devices are turned on yet.', 'warning');
    } catch (e) { toast(e.message || 'Could not send test', 'error'); }
    btn.disabled = false; btn.textContent = orig;
  },

  // Off = drop the browser subscription AND the server-side record, so the shop
  // stops sending to a phone that would silently fail anyway.
  async disable(btn) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Turning off…';
    try {
      const sub = await this._subscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + Auth.getToken() },
          body: JSON.stringify({ tenant_id: localStorage.getItem('sf_shopId'), endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      toast('Notifications off for this phone');
    } catch (e) { toast(e.message || 'Could not turn off notifications', 'error'); }
    btn.disabled = false; btn.textContent = orig;
    this.render();
  },
};

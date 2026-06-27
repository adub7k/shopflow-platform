// ── Messages ──────────────────────────────────────────────────────────────────
const Messages = {
  _threads: [],
  _currentThread: null, // { customerId, customerName, customerPhone }

  async render() {
    const el = document.getElementById('page-messages'); if (!el) return;
    if (this._currentThread) {
      await this._renderThread(el, this._currentThread);
    } else {
      await this._renderInbox(el);
    }
  },

  async _renderInbox(el) {
    // Check feature flag first
    try {
      const features = await db.features.get();
      if (!features.manualSms) {
        el.innerHTML = `<div class="card" style="text-align:center;padding:40px 24px;">
          <div style="font-size:40px;margin-bottom:16px;">💬</div>
          <div style="font-size:17px;font-weight:700;color:var(--text);margin-bottom:8px;">Manual Messaging</div>
          <div style="font-size:14px;color:var(--muted);max-width:280px;margin:0 auto 20px;">
            Send and receive SMS messages with your clients directly from ShopFlow.
          </div>
          <div style="background:var(--green-lt);border:1px solid var(--green-md);border-radius:10px;padding:14px;font-size:13px;color:var(--green);font-weight:600;">
            Contact ShopFlow to enable messaging for your account.
          </div>
        </div>`;
        return;
      }
    } catch(e) {}

    try {
      this._threads = await db.conversations.all();
    } catch(e) { this._threads = []; }

    Messages.updateBadge(this._threads);

    const composeBtn = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);">Messages</div>
        <button onclick="Messages.openCompose()" style="background:none;border:none;cursor:pointer;color:var(--green);padding:4px;" title="New message">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>
      </div>`;

    if (!this._threads.length) {
      el.innerHTML = composeBtn + `
        <div class="card"><div class="empty-state">
          <div class="empty-icon">💬</div>
          <div class="empty-text">No conversations yet</div>
          <div style="font-size:12px;color:var(--faint);margin-top:6px;">Tap the pencil to start a new message</div>
        </div></div>`;
      return;
    }

    const rows = this._threads.map(t => {
      const last = t.lastMessage || {};
      const isOut = last.direction === 'outbound';
      const preview = (isOut ? 'You: ' : '') + (last.body || '').slice(0, 60) + ((last.body||'').length > 60 ? '…' : '');
      const timeStr = last.sentAt ? _msgTime(last.sentAt) : '';
      return `<div class="msg-inbox-row" onclick="Messages.openThread('${t.customerId}','${esc(t.customerName)}','${esc(t.customerPhone||'')}')">
        ${avatarEl(t.customerName, 42)}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:14px;font-weight:${t.unreadCount?'700':'600'};color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.customerName)}</div>
            <div style="font-size:11px;color:var(--faint);white-space:nowrap;flex-shrink:0;">${timeStr}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
            <div style="font-size:12px;color:${t.unreadCount?'var(--text)':'var(--muted)'};font-weight:${t.unreadCount?'500':'400'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${esc(preview)}</div>
            ${t.unreadCount ? `<div class="msg-unread-dot" style="flex-shrink:0;"></div>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = composeBtn + `<div class="list-card">${rows}</div>`;
  },

  async openThread(customerId, customerName, customerPhone) {
    this._currentThread = { customerId, customerName, customerPhone };
    // Mark read on server
    try { await db.conversations.markRead(customerId); } catch(e) {}
    // Update badge optimistically
    const t = this._threads.find(x => x.customerId === customerId);
    if (t) t.unreadCount = 0;
    Messages.updateBadge(this._threads);
    await this.render();
  },

  async _renderThread(el, thread) {
    let msgs = [];
    try { msgs = await db.conversations.forCustomer(thread.customerId); } catch(e) {}

    const bubbles = msgs.length
      ? msgs.map(m => {
          const isOut = m.direction === 'outbound';
          return `<div class="msg-bubble-wrap ${isOut?'out':'in'}">
            <div class="msg-bubble ${isOut?'out':'in'}">${esc(m.body||'')}</div>
            <div class="msg-time">${_msgTimeFull(m.sentAt)}</div>
          </div>`;
        }).join('')
      : `<div style="text-align:center;padding:40px;color:var(--faint);font-size:13px;">No messages yet — send the first one below.</div>`;

    el.innerHTML = `
      <div class="msg-thread">
        <div class="msg-thread-header">
          <button class="msg-thread-back" onclick="Messages.closeThread()">‹</button>
          <div class="msg-thread-title">
            <div class="msg-thread-name">${esc(thread.customerName)}</div>
            ${thread.customerPhone ? `<div class="msg-thread-phone">${esc(thread.customerPhone)}</div>` : ''}
          </div>
          ${thread.customerPhone ? `<a href="tel:${thread.customerPhone}" style="color:var(--green);font-size:20px;text-decoration:none;padding:4px;">📞</a>` : ''}
        </div>
        <div class="msg-bubbles" id="msg-bubbles-scroll">${bubbles}</div>
        <div class="msg-compose">
          <textarea class="msg-compose-input" id="msg-compose-input" placeholder="Type a message…" rows="1"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Messages.send();}"
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
          <button class="msg-send-btn" id="msg-send-btn" onclick="Messages.send()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>`;

    // Scroll to bottom
    setTimeout(() => {
      const scroll = document.getElementById('msg-bubbles-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
      document.getElementById('msg-compose-input')?.focus();
    }, 80);
  },

  async send() {
    const input = document.getElementById('msg-compose-input');
    const body  = input?.value.trim();
    if (!body || !this._currentThread) return;
    const { customerId, customerName, customerPhone } = this._currentThread;
    if (!customerPhone) { toast('No phone number for this client', 'error'); return; }

    const btn = document.getElementById('msg-send-btn');
    if (btn) btn.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    try {
      const res = await db.sms.send({ to: customerPhone, body, customerId, customerName });
      if (!res.ok) throw new Error(res.error || 'SMS failed');
      await this._renderThread(document.getElementById('page-messages'), this._currentThread);
    } catch(e) {
      toast(e.message || 'Could not send message', 'error');
      input.value = body; // restore text on failure
      if (btn) btn.disabled = false;
    }
  },

  closeThread() {
    this._currentThread = null;
    this.render();
  },

  // Templated composer: pick a client → pick a preset → the message auto-fills with
  // their details ({first}/{name}/{shop}/{date}/{time}/{link}) → send via the iPhone
  // sms: deep link (no Twilio/A2P needed — same as the Tasks one-tap text).
  _compose: { target: null, appt: null },

  openCompose() {
    Modal.show(`
      <div class="modal-title">New Message</div>
      <div class="form-group">
        <label class="form-label">Client</label>
        <div class="autocomplete-wrap">
          <input class="form-input" id="compose-search" placeholder="Name or phone number…" autocomplete="off"/>
          <div class="autocomplete-list" id="compose-list"></div>
        </div>
      </div>
      <div id="compose-templated" style="display:none;">
        <div class="form-group">
          <label class="form-label">Message template</label>
          <select class="form-input" id="compose-tpl" onchange="Messages._fillCompose()"></select>
        </div>
        <div class="form-group">
          <label class="form-label">Message <span style="font-weight:400;color:var(--muted);">(edit as needed)</span></label>
          <textarea class="form-input" id="compose-body" rows="4"></textarea>
        </div>
        <button class="btn btn-green btn-full" onclick="Messages._sendCompose()">📲 Open in Messages</button>
      </div>
      <div class="modal-actions">
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(() => {
      makeAutocomplete('compose-search', 'compose-list', async (id, name, phone) => {
        Messages._compose = { target: { id, name, phone }, appt: null };
        const inp = document.getElementById('compose-search'); if (inp) inp.value = name + (phone ? ' · ' + phone : '');
        // Pull their next upcoming appointment so {date}/{time}/{service} can fill.
        try {
          const d = await db.customers.get(id);
          Messages._compose.appt = (d.appointments || []).filter(a => a.status === 'confirmed' && a.date >= today()).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
        } catch (e) {}
        const sel = document.getElementById('compose-tpl');
        if (sel) sel.innerHTML = Messages._templates().map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('');
        const wrap = document.getElementById('compose-templated'); if (wrap) wrap.style.display = 'block';
        Messages._fillCompose();
      });
      document.getElementById('compose-search')?.focus();
    }, 100);
  },

  // The shop's editable presets (Settings → SMS templates) with detail-friendly
  // fallbacks, plus a blank custom option.
  _templates() {
    const t = (Shop.settings && Shop.settings.smsTemplates) || {};
    return [
      { label: 'Appointment confirmation', body: t.confirmation || 'Hi {first}! Your appointment at {shop} is confirmed for {date} at {time}. See you then!' },
      { label: 'Reminder',                 body: t.reminder     || 'Hi {first}! Reminder: your appointment at {shop} is on {date} at {time}. See you then!' },
      { label: 'Time to rebook',           body: t.rebook       || "Hi {first}! It's been a while — we'd love to get your vehicle looking fresh again at {shop}. Want to get on the schedule?" },
      { label: 'Review request',           body: t.review       || 'Hi {first}, thanks for visiting {shop}! We\'d love a quick review: {link}' },
      { label: 'Custom (blank)',           body: '' },
    ];
  },

  _fillCompose() {
    const i = +(document.getElementById('compose-tpl') || {}).value || 0;
    const tpl = Messages._templates()[i] || { body: '' };
    const c = Messages._compose.target || {};
    const a = Messages._compose.appt || {};
    const vars = {
      name:  c.name || 'there',
      first: (c.name || 'there').split(' ')[0],
      shop:  (Shop.settings && Shop.settings.shopName) || 'us',
      date:  a.date ? fmtDateFull(a.date) : '',
      time:  a.time || '',
      service: a.service || '',
      link:  (Shop.settings && Shop.settings.googleReviewLink) || '',
    };
    const ta = document.getElementById('compose-body');
    if (ta) ta.value = String(tpl.body || '')
      .replace(/\{first\}/g, vars.first).replace(/\{name\}/g, vars.name).replace(/\{shop\}/g, vars.shop)
      .replace(/\{date\}/g, vars.date).replace(/\{time\}/g, vars.time).replace(/\{service\}/g, vars.service).replace(/\{link\}/g, vars.link);
  },

  _sendCompose() {
    const c = Messages._compose.target;
    if (!c || !c.phone) { toast('No phone number for this client', 'error'); return; }
    const body = (document.getElementById('compose-body') || {}).value || '';
    Modal.close();
    _cpSms(c.phone, body);   // opens iPhone Messages prefilled
  },

  updateBadge(threads) {
    const total = (threads||[]).reduce((s, t) => s + (t.unreadCount||0), 0);
    ['bottom-msg-badge','sidebar-msg-badge'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = total > 9 ? '9+' : total;
      el.style.display = total > 0 ? 'inline' : 'none';
    });
  },
};

// ── Helpers for message timestamps ────────────────────────────────────────────
function _msgTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)  return d.toLocaleDateString('en-US',{weekday:'short'});
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}
function _msgTimeFull(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
}
// esc() is defined in utils.js

// ── Leads (inbound call tracking) ─────────────────────────────────────────────
// Populated by the call-screening webhooks: every inbound call to the shop's
// tracking number becomes a lead here, with its call history and a one-tap
// text-back / convert-to-client flow.
const Leads = {
  _leads: [],
  _filter: 'all',

  _statusMeta: {
    new:       { label: 'New',       bg: 'var(--green-lt)',  fg: 'var(--green)', dot: '#2563eb' },
    contacted: { label: 'Contacted', bg: '#fef3c7',          fg: '#92400e',      dot: '#d97706' },
    booked:    { label: 'Booked',    bg: 'var(--green-lt)',  fg: 'var(--green)', dot: '#16a34a' },
    closed:    { label: 'Closed',    bg: '#f3f4f6',          fg: '#6b7280',      dot: '#9ca3af' },
  },

  async render() {
    const el = document.getElementById('page-leads'); if (!el) return;
    try { this._leads = await db.leads.all(); } catch(e) { this._leads = []; }

    const counts = { all: this._leads.length, new: 0, contacted: 0, booked: 0, closed: 0 };
    this._leads.forEach(l => { counts[l.status] = (counts[l.status]||0) + 1; });

    const pill = (key, label) => `<button class="lead-pill ${this._filter===key?'active':''}" onclick="Leads.setFilter('${key}')">${label}${counts[key]?` <span class="lead-pill-count">${counts[key]}</span>`:''}</button>`;
    const filters = `<div class="lead-filters">
      ${pill('all','All')}${pill('new','New')}${pill('contacted','Contacted')}${pill('booked','Booked')}${pill('closed','Closed')}
    </div>`;

    const tn = (Shop.settings && Shop.settings.trackingNumber) || '';
    const banner = `<div class="lead-banner">
      <span style="font-size:18px;">📞</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text);">Call tracking ${tn?'is live':'setup'}</div>
        <div style="font-size:12px;color:var(--muted);">${tn?`Calls to <strong>${esc(tn)}</strong> forward to your phone. Missed calls auto-text the caller.`:'Contact ShopFlow to activate your tracking number.'}</div>
      </div>
    </div>`;

    const shown = this._filter==='all' ? this._leads : this._leads.filter(l => l.status===this._filter);

    if (!shown.length) {
      el.innerHTML = banner + filters + `<div class="card"><div class="empty-state">
        <div class="empty-icon">📞</div>
        <div class="empty-text">No ${this._filter==='all'?'':this._filter+' '}leads yet</div>
        <div style="font-size:12px;color:var(--faint);margin-top:6px;">Inbound calls will show up here automatically.</div>
      </div></div>`;
      return;
    }

    const rows = shown.map(l => {
      const m = this._statusMeta[l.status] || this._statusMeta.new;
      const name = l.name || l.phone || 'Unknown caller';
      const lastCall = (l.calls||[])[0];
      const missedBadge = (l.missedCount||0) > 0 ? `<span class="lead-missed">⚠ ${l.missedCount} missed</span>` : '';
      const sub = [l.phone, l.location].filter(Boolean).join(' · ');
      return `<div class="msg-inbox-row" onclick="Leads.open('${l.id}')">
        ${avatarEl(l.name || '☎', 42)}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
            <div style="font-size:11px;color:var(--faint);white-space:nowrap;flex-shrink:0;">${lastCall?_msgTime(lastCall.startedAt):''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
            <span class="lead-badge" style="background:${m.bg};color:${m.fg};">${m.label}</span>
            ${missedBadge}
            <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${esc(sub)}</div>
          </div>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = banner + filters + `<div class="list-card">${rows}</div>`;
  },

  setFilter(f) { this._filter = f; this.render(); },

  open(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    const m = this._statusMeta[l.status] || this._statusMeta.new;
    const name = l.name || l.phone || 'Unknown caller';

    const statusPills = Object.keys(this._statusMeta).map(k => {
      const sm = this._statusMeta[k];
      return `<button class="lead-status-opt ${l.status===k?'active':''}" style="${l.status===k?`background:${sm.bg};color:${sm.fg};border-color:${sm.fg};`:''}" onclick="Leads.setStatus('${l.id}','${k}')">${sm.label}</button>`;
    }).join('');

    const calls = (l.calls||[]).map(c => {
      const when = _msgTimeFull(c.startedAt);
      if (c.missed) return `<div class="lead-call missed"><span>⚠ Missed call${c.autoSmsSent?' · auto-text sent':''}</span><span class="lead-call-time">${when}</span></div>`;
      const dur = c.durationSec ? ` · ${Math.floor(c.durationSec/60)}m ${c.durationSec%60}s` : '';
      return `<div class="lead-call answered"><span>✓ Answered${dur}</span><span class="lead-call-time">${when}</span></div>`;
    }).join('') || `<div style="font-size:12px;color:var(--faint);padding:6px 0;">No calls logged.</div>`;

    Modal.show(`
      <div class="modal-title" style="display:flex;align-items:center;gap:10px;">
        ${avatarEl(l.name || '☎', 38)}
        <div style="flex:1;min-width:0;">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
          ${l.phone?`<a href="tel:${esc(l.phone)}" style="font-size:12px;font-weight:500;color:var(--green);text-decoration:none;">${esc(l.phone)} ↗</a>`:''}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Name</label>
        <input class="form-input" id="lead-name" value="${esc(l.name||'')}" placeholder="Add a name…"/>
      </div>

      <div class="form-group">
        <label class="form-label">Status</label>
        <div class="lead-status-row">${statusPills}</div>
      </div>

      <div class="form-group">
        <label class="form-label">Text back</label>
        <div style="display:flex;gap:8px;">
          <input class="form-input" id="lead-sms" placeholder="Type a quick reply…" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();Leads.sendSms('${l.id}');}"/>
          <button class="btn btn-primary" onclick="Leads.sendSms('${l.id}')">Send</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Call history</label>
        <div class="lead-calls">${calls}</div>
      </div>

      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-input" id="lead-notes" rows="2" placeholder="Notes about this lead…">${esc(l.notes||'')}</textarea>
      </div>

      <div class="modal-actions" style="flex-wrap:wrap;gap:8px;">
        <button class="btn btn-primary btn-full" onclick="Leads.save('${l.id}')">Save</button>
        ${l.customerId?`<button class="btn btn-full" onclick="ClientProfile.open('${l.customerId}')">View client</button>`:`<button class="btn btn-full" onclick="Leads.convert('${l.id}')">Convert to client</button>`}
        <button class="btn btn-full" style="color:var(--red);" onclick="Leads.remove('${l.id}')">Delete lead</button>
      </div>
    `);
  },

  async setStatus(id, status) {
    const l = this._leads.find(x => x.id === id); if (l) l.status = status;
    document.querySelectorAll('.lead-status-opt').forEach(b => b.classList.remove('active'));
    this.open(id); // re-render modal to reflect selection
  },

  async save(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    const name = document.getElementById('lead-name')?.value || '';
    const notes = document.getElementById('lead-notes')?.value || '';
    try {
      await db.leads.update(id, { name, notes, status: l.status });
      Modal.close(); toast('Lead saved ✓'); this.render();
    } catch(e) { toast(e.message || 'Could not save', 'error'); }
  },

  async sendSms(id) {
    const input = document.getElementById('lead-sms');
    const body = input?.value.trim();
    if (!body) return;
    input.value = '';
    try {
      const res = await db.leads.sms(id, body);
      if (!res.ok) throw new Error(res.error || 'SMS failed');
      toast('Message sent ✓');
      const l = this._leads.find(x => x.id === id); if (l && l.status === 'new') l.status = 'contacted';
    } catch(e) { toast(e.message || 'Could not send', 'error'); if (input) input.value = body; }
  },

  async convert(id) {
    try {
      const res = await db.leads.convert(id);
      if (!res.ok) throw new Error(res.error || 'Convert failed');
      Modal.close(); toast('Converted to client ✓'); this.render();
    } catch(e) { toast(e.message || 'Could not convert', 'error'); }
  },

  async remove(id) {
    if (!confirm('Delete this lead and its call history?')) return;
    try { await db.leads.delete(id); Modal.close(); toast('Lead deleted'); this.render(); }
    catch(e) { toast(e.message || 'Could not delete', 'error'); }
  },
};

// ── Client portal — scoped-down lead view ─────────────────────────────────────
// Talks ONLY to /api/client/* (server/routes/client.js). The server whitelists
// every field it returns, so this page never sees (and can never leak) ad
// attribution, spend, revenue, notes, or response-time data. Styling reuses the
// same app2.css classes as the CRM's Leads tab so the two feel like one product.

const PortalAuth = {
  getToken: () => localStorage.getItem('sf_token'),
  getShopName: () => localStorage.getItem('sf_shopName') || 'Your Shop',
  logout: () => {
    ['sf_token','sf_shopId','sf_shopSlug','sf_shopName','sf_role','sf_name'].forEach(k => localStorage.removeItem(k));
    window.location.href = '/login';
  }
};

async function api(path, opts = {}) {
  const res = await fetch('/api/client' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + PortalAuth.getToken() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { PortalAuth.logout(); return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed ' + res.status);
  return data;
}

// Relative time for the row's right edge — same feel as the CRM inbox rows.
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso), diff = Date.now() - d.getTime();
  if (diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 172800000) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const Portal = {
  _leads: [], _total: 0, _page: 1, _limit: 50,
  _filter: 'all', _range: '90', _from: '', _to: '',
  _expanded: null, _loading: false,

  _statusMeta: {
    new:       { label: 'New',       bg: 'var(--green-lt)', fg: 'var(--green-deep)' },
    contacted: { label: 'Contacted', bg: '#FBF1E2',         fg: 'var(--orange)' },
  },
  _sourceIcon: { 'Call': '📞', 'Web Form': '🌐', 'Meta': '📘', 'Google': '🔍', 'Other': '🔗' },

  _query(page) {
    const p = new URLSearchParams({ page: String(page), limit: String(this._limit) });
    if (this._filter !== 'all') p.set('status', this._filter);
    if (this._range === 'custom') {
      if (this._from) p.set('from', this._from);
      if (this._to)   p.set('to', this._to);
    } else {
      const d = new Date(Date.now() - Number(this._range) * 86400000);
      p.set('from', d.toISOString().split('T')[0]);
    }
    return p.toString();
  },

  async load(reset = true) {
    if (this._loading) return;
    this._loading = true;
    try {
      const page = reset ? 1 : this._page + 1;
      const r = await api('/leads?' + this._query(page));
      this._leads = reset ? r.leads : this._leads.concat(r.leads);
      this._total = r.total; this._page = page;
      if (reset) this._expanded = null;
    } catch (e) { toast(e.message || 'Could not load leads', 'error'); }
    this._loading = false;
    this.render();
  },

  render() {
    const el = document.getElementById('page-portal'); if (!el) return;

    const pill = (key, label) =>
      `<button class="lead-pill ${this._filter === key ? 'active' : ''}" onclick="Portal.setFilter('${key}')">${label}</button>`;
    const rangeOpt = (v, label) => `<option value="${v}" ${this._range === v ? 'selected' : ''}>${label}</option>`;
    const filters = `<div class="lead-filters" style="align-items:center;">
      ${pill('all', 'All')}${pill('new', 'New')}${pill('contacted', 'Contacted')}
      <select class="pt-range" onchange="Portal.setRange(this.value)">
        ${rangeOpt('7', 'Last 7 days')}${rangeOpt('30', 'Last 30 days')}${rangeOpt('90', 'Last 90 days')}${rangeOpt('180', 'Last 180 days')}${rangeOpt('custom', 'Custom range')}
      </select>
    </div>`;

    const custom = this._range === 'custom' ? `<div style="display:flex;gap:8px;margin:-4px 0 12px;">
      <input type="date" class="form-input" style="flex:1;" value="${esc(this._from)}" onchange="Portal.setCustom(this.value, null)"/>
      <input type="date" class="form-input" style="flex:1;" value="${esc(this._to)}" onchange="Portal.setCustom(null, this.value)"/>
    </div>` : '';

    const header = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
      <div>
        <div style="font-size:19px;font-weight:700;letter-spacing:-.02em;">Leads</div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:1px;">${this._total} lead${this._total !== 1 ? 's' : ''}</div>
      </div>
      <button class="btn btn-green" onclick="Portal.openLog()">＋ Log a lead</button>
    </div>`;

    if (!this._leads.length) {
      el.innerHTML = header + filters + custom + `<div class="card"><div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">No ${this._filter === 'all' ? '' : this._filter + ' '}leads in this range</div>
        <div style="font-size:12px;color:var(--faint);margin-top:6px;">New inquiries show up here automatically.</div>
      </div></div>`;
      return;
    }

    const rows = this._leads.map(l => {
      const m = this._statusMeta[l.status] || this._statusMeta.new;
      const icon = this._sourceIcon[l.source] || '🔗';
      const name = l.name || l.phone || 'Unknown';
      const sub = [l.serviceRequested, l.vehicle].filter(Boolean).join(' · ');
      const row = `<div class="msg-inbox-row" onclick="Portal.toggle('${l.id}')">
        ${avatarEl(l.name || icon, 42)}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
            <div style="font-size:11px;color:var(--faint);white-space:nowrap;flex-shrink:0;">${fmtWhen(l.createdAt)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
            <span class="lead-badge" style="background:${m.bg};color:${m.fg};">${m.label}</span>
            <span class="lead-badge" style="background:var(--surface2);color:var(--muted);">${icon} ${esc(l.source)}</span>
            <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${esc(sub)}</div>
          </div>
        </div>
      </div>`;
      if (this._expanded !== l.id) return row;
      const dr = (k, v, href) => v ? `<div class="pt-detail-row"><span class="k">${k}</span>${href ? `<a href="${href}:${esc(v)}">${esc(v)}</a>` : `<span style="font-weight:600;color:var(--text);">${esc(v)}</span>`}</div>` : '';
      return row + `<div class="pt-detail">
        ${dr('Phone', l.phone, 'tel')}
        ${dr('Email', l.email, 'mailto')}
        ${dr('Service', l.serviceRequested)}
        ${dr('Vehicle', l.vehicle)}
        ${l.status === 'new'
          ? `<button class="btn btn-green" style="margin-top:8px;" onclick="Portal.markContacted('${l.id}', this)">✓ Mark contacted</button>`
          : `<div style="font-size:12px;color:var(--faint);margin-top:6px;">Contacted ✓</div>`}
      </div>`;
    }).join('');

    const more = this._leads.length < this._total
      ? `<button class="btn btn-full" onclick="Portal.load(false)">Show more (${this._total - this._leads.length} left)</button>` : '';

    el.innerHTML = header + filters + custom + `<div class="list-card">${rows}</div>` + more;
  },

  setFilter(f) { this._filter = f; this.load(); },
  setRange(r) { this._range = r; if (r !== 'custom') this.load(); else this.render(); },
  setCustom(from, to) {
    if (from !== null) this._from = from;
    if (to !== null) this._to = to;
    if (this._from || this._to) this.load();
  },
  toggle(id) { this._expanded = this._expanded === id ? null : id; this.render(); },

  async markContacted(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await api('/leads/' + id + '/status', { method: 'PATCH', body: { status: 'contacted' } });
      const i = this._leads.findIndex(x => x.id === id);
      if (i >= 0) this._leads[i] = r.lead;
      toast('Marked contacted ✓');
      this.render();
    } catch (e) {
      toast(e.message || 'Could not update', 'error');
      this.render();
    }
  },

  // ── Log a lead (manual walk-in / phone-in) ──
  _logSource: 'Call',
  openLog() {
    this._logSource = 'Call';
    Modal.show(`
      <div class="modal-title">Log a lead</div>
      <div class="form-group">
        <label class="form-label">How did they reach you?</label>
        <div class="lead-status-row" id="log-source-row">${this._logSourceBtns()}</div>
      </div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="log-name" placeholder="Customer name"/></div>
      <div class="form-group"><label class="form-label">Phone *</label><input class="form-input" id="log-phone" type="tel" placeholder="(555) 555-0134"/></div>
      <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="log-email" type="email" placeholder="Optional"/></div>
      <div class="form-group"><label class="form-label">Service requested</label><input class="form-input" id="log-service" placeholder="e.g. Ceramic window tint"/></div>
      <div class="form-group"><label class="form-label">Vehicle</label><input class="form-input" id="log-vehicle" placeholder="e.g. 2022 Tesla Model Y"/></div>
      <div class="modal-actions">
        <button class="btn btn-green btn-full" onclick="Portal.submitLog(this)">Save lead</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>
    `);
  },
  _logSourceBtns() {
    return ['Call', 'Web Form'].map(s =>
      `<button class="lead-status-opt ${this._logSource === s ? 'active' : ''}" style="${this._logSource === s ? 'background:var(--green-lt);color:var(--green-deep);border-color:var(--green-deep);' : ''}" onclick="Portal.setLogSource('${s}')">${this._sourceIcon[s]} ${s}</button>`
    ).join('');
  },
  setLogSource(s) {
    this._logSource = s;
    const row = document.getElementById('log-source-row');
    if (row) row.innerHTML = this._logSourceBtns();
  },
  async submitLog(btn) {
    const val = id => (document.getElementById(id)?.value || '').trim();
    const body = {
      name: val('log-name'), phone: val('log-phone'), email: val('log-email'),
      serviceRequested: val('log-service'), vehicle: val('log-vehicle'),
      source: this._logSource,
    };
    if (!body.name || !body.phone) { toast('Name and phone are required', 'warning'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await api('/leads', { method: 'POST', body });
      Modal.close();
      toast('Lead saved ✓');
      this.load();
    } catch (e) {
      toast(e.message || 'Could not save lead', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Save lead'; }
    }
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const t = document.getElementById('topbar-title');
  if (t) t.textContent = PortalAuth.getShopName();
  Portal.load();
});

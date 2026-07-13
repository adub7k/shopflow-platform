// ── v2 Clients (redesign) ─────────────────────────────────────────────────────
// Loaded ONLY by app2.html, after js/pages/clients.js. Replaces the list view
// with the redesigned searchable table. The profile view, add/edit modal,
// retention reach-out flow, and all data APIs are the existing ones.
(function () {
  Clients._statusFilter2 = 'all';

  function statusOf(c, cutoffStr) {
    if (!c.lastVisit) return 'never';
    if (c.lastVisit < cutoffStr) return 'risk';
    return 'active';
  }
  const STATUS_PILL = {
    active: '<span class="badge badge-green">Active</span>',
    risk:   '<span class="badge badge-yellow">At risk</span>',
    never:  '<span class="badge badge-gray">No visits yet</span>',
  };

  Clients.render = async function () {
    const el = document.getElementById('page-clients'); if (!el) return;
    if (this._view === 'profile') { await this._renderProfile(el); return; }
    el.classList.add('v2-wide');
    try {
      this._data = await db.customers.all();
      const loyalty = (await db.settings.get()).loyalty || { visitsForReward: 10 };
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - this._retentionDays);
      const cutoffStr = cutoff.toISOString().split('T')[0];

      const withStatus = this._data.map(c => ({ c, st: statusOf(c, cutoffStr) }));
      const counts = { all: withStatus.length, active: 0, risk: 0, never: 0, fleet: 0 };
      withStatus.forEach(({ c, st }) => { counts[st]++; if (c.isFleet) counts.fleet++; });

      let rows = withStatus;
      if (this._statusFilter2 === 'fleet') rows = rows.filter(r => r.c.isFleet);
      else if (this._statusFilter2 !== 'all') rows = rows.filter(r => r.st === this._statusFilter2);
      if (this._tagFilter) rows = rows.filter(r => (r.c.tags || []).includes(this._tagFilter));
      if (this._search) {
        const q = this._search.toLowerCase();
        rows = rows.filter(r => r.c.name.toLowerCase().includes(q) || (r.c.phone || '').includes(this._search));
      }
      rows.sort((a, b) => (b.c.lastVisit || '').localeCompare(a.c.lastVisit || ''));

      const allTags = [...new Set(this._data.flatMap(c => c.tags || []))].sort();
      const chip = (key, label, n) => `<button class="v2-chip${this._statusFilter2 === key ? ' on' : ''}" onclick="Clients._statusFilter2='${key}';Clients.render()">${label}${n ? `<span class="n">${n}</span>` : ''}</button>`;
      const tagChip = (t) => `<button class="v2-chip${this._tagFilter === t ? ' on' : ''}" onclick="Clients._setTag('${jsAttr(t)}')">${esc(t)}</button>`;

      const html = [];
      html.push(`<div class="v2-pagehd"><div><h1>Clients</h1>
        <div class="sub">${counts.all} client${counts.all !== 1 ? 's' : ''}${counts.risk ? ` · <span style="color:var(--orange);font-weight:600;">${counts.risk} at risk</span>` : ''}</div></div>
        <div class="sp"></div>
        <button class="btn btn-green" onclick="Clients.openForm(null)">＋ Add client</button></div>`);

      html.push(`<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
        <input class="form-input" id="client-search" placeholder="Search name or phone…" value="${esc(this._search)}" oninput="Clients._filter(this.value)" style="width:250px;height:33px;padding:0 12px;" />
        <div class="v2-chips">
          ${chip('all', 'All', counts.all)}${chip('active', 'Active', counts.active)}${chip('risk', 'At risk', counts.risk)}${chip('never', 'No visits', counts.never)}${counts.fleet ? chip('fleet', 'Fleet', counts.fleet) : ''}
          ${allTags.map(tagChip).join('')}
        </div>
        <div class="sp" style="flex:1;"></div>
        <label style="font-size:11.5px;color:var(--faint);display:flex;align-items:center;gap:6px;">At-risk after
          <select onchange="Clients._retentionDays=parseInt(this.value);Clients.render()" style="padding:4px 8px;border:1px solid var(--border-md);border-radius:7px;font-size:12px;font-weight:600;color:var(--text);background:var(--surface);">
            ${[30, 45, 60, 75, 90, 120].map(d => `<option value="${d}"${this._retentionDays === d ? ' selected' : ''}>${d} days</option>`).join('')}
          </select></label></div>`);

      if (!rows.length) {
        html.push(`<div class="v2-card"><div class="empty-state"><div class="empty-icon">👤</div>
          <div class="empty-text">${this._search || this._tagFilter || this._statusFilter2 !== 'all' ? 'No clients match' : 'No clients yet'}</div>
          <div class="list-sub" style="margin-top:2px;">${this._search || this._tagFilter || this._statusFilter2 !== 'all' ? 'Try a different search or clear the filters.' : 'Add your first client to get started.'}</div>
          ${this._search || this._tagFilter || this._statusFilter2 !== 'all' ? `<div style="margin-top:12px;"><button class="btn btn-sm" onclick="Clients._search='';Clients._tagFilter='';Clients._statusFilter2='all';Clients.render()">Clear filters</button></div>` : ''}
        </div></div>`);
      } else {
        html.push(`<div class="v2-card v2-tablewrap"><table class="v2-table">
          <thead><tr><th>Client</th><th>Status</th><th>Vehicle</th><th>Phone</th><th>Tags</th><th class="r">Visits</th><th class="r">Loyalty</th><th class="r">Last visit</th><th class="r"></th></tr></thead><tbody>`);
        rows.forEach(({ c, st }) => {
          const v = (c.vehicles || [])[0];
          const veh = v ? [v.year, v.make, v.model].filter(Boolean).map(esc).join(' ') : '—';
          const rewardReady = (c.loyaltyPoints || 0) >= (loyalty.visitsForReward || 10);
          const days = c.lastVisit ? Math.floor((new Date() - new Date(c.lastVisit + 'T12:00:00')) / 864e5) : null;
          html.push(`<tr onclick="ClientProfile.open('${c.id}')">
            <td><div style="display:flex;align-items:center;gap:10px;">${avatarEl(c.name, 30)}<b>${esc(c.name)}</b>${c.isFleet ? '<span class="badge badge-blue">Fleet</span>' : ''}</div></td>
            <td>${STATUS_PILL[st]}</td>
            <td style="color:var(--muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;">${veh}</td>
            <td style="color:var(--muted);">${esc(c.phone || '—')}</td>
            <td>${(c.tags || []).slice(0, 2).map(t => `<span class="v2-src">${esc(t)}</span>`).join(' ') || '<span style="color:var(--faint);">—</span>'}</td>
            <td class="r">${c.totalVisits || 0}</td>
            <td class="r" style="color:${rewardReady ? 'var(--green-deep)' : 'var(--muted)'};font-weight:${rewardReady ? '700' : '400'};">${c.loyaltyPoints || 0}/${loyalty.visitsForReward}${rewardReady ? ' 🎉' : ''}</td>
            <td class="r" style="color:var(--muted);">${c.lastVisit ? fmtDateShort(c.lastVisit) + (st === 'risk' ? ` <span style="color:var(--red);font-weight:600;">(${days}d)</span>` : '') : '—'}</td>
            <td class="r">${st === 'risk' ? `<button class="btn btn-sm" onclick="event.stopPropagation();Clients.retentionAction('${c.id}','${jsAttr(c.name)}','${jsAttr(c.phone || '')}')">Reach out</button>` : ''}</td>
          </tr>`);
        });
        html.push('</tbody></table></div>');
      }
      el.innerHTML = html.join('');
      if (this._search) { const s = document.getElementById('client-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    } catch (e) {
      console.error('v2 clients:', e);
      el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load clients</p></div>';
    }
  };
})();

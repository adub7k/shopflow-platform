// ── v2 Leads (redesign) ───────────────────────────────────────────────────────
// Loaded ONLY by app2.html, after js/pages/leads.js. Replaces the list view
// with a pipeline board (columns = the existing lead statuses). Cards open the
// existing lead modal; drag-and-drop persists through db.leads.update.
(function () {
  const ORDER = ['new', 'contacted', 'booked', 'closed'];
  const COL_HINT = {
    new: 'Uncontacted — answer these first',
    contacted: 'Waiting on a reply or estimate',
    booked: 'Converted to an appointment',
    closed: 'Won or lost — kept for records',
  };
  let dragId = null;

  Leads.render = async function () {
    const el = document.getElementById('page-leads'); if (!el) return;
    el.classList.add('v2-wide');
    try { this._leads = await db.leads.all(); } catch (e) { this._leads = []; }
    const leads = this._leads || [];

    const counts = {}; ORDER.forEach(s => counts[s] = 0);
    leads.forEach(l => { if (counts[l.status] === undefined) counts[l.status] = 0; counts[l.status]++; });
    const total = leads.length;
    const booked = leads.filter(l => l.status === 'booked').length;
    const conv = total ? Math.round(booked / total * 100) : 0;
    const missed = leads.reduce((s, l) => s + (l.missedCount || 0), 0);

    const html = [];
    html.push(`<div class="v2-pagehd"><div><h1>Leads</h1>
      <div class="sub">${total} lead${total !== 1 ? 's' : ''} · drag cards between stages</div></div>
      <div class="sp"></div>
      <button class="btn" onclick="App.nav('response')">Response Center${counts.new ? ' (' + counts.new + ')' : ''}</button></div>`);

    html.push(`<div class="v2-mgrid" style="grid-template-columns:repeat(4,1fr);">
      <div class="metric-card"><div class="metric-label">New leads</div><div class="metric-value">${counts.new || 0}</div><div class="metric-sub">${counts.new ? 'waiting on a response' : 'all answered'}</div></div>
      <div class="metric-card"><div class="metric-label">In conversation</div><div class="metric-value">${counts.contacted || 0}</div><div class="metric-sub">contacted, not booked yet</div></div>
      <div class="metric-card"><div class="metric-label">Booked</div><div class="metric-value green">${booked}</div><div class="metric-sub">${conv}% of all leads</div></div>
      <div class="metric-card"><div class="metric-label">Missed calls</div><div class="metric-value">${missed}</div><div class="metric-sub">across all leads</div></div></div>`);

    html.push('<div class="v2-board">');
    for (const st of ORDER) {
      const m = this._statusMeta[st];
      const cards = leads.filter(l => l.status === st)
        .sort((a, b) => new Date(b.lastContactAt || b.createdAt || 0) - new Date(a.lastContactAt || a.createdAt || 0));
      html.push(`<div class="v2-bcol" data-status="${st}"><div class="v2-bh">
        <div class="bt">${m ? m.label : st} <span class="n">${cards.length}</span></div>
        <div class="bv">${COL_HINT[st] || ''}</div></div><div class="v2-bcards">`);
      cards.forEach(l => {
        const sm = this._sourceMeta(l.source);
        const name = l.name || l.phone || 'Unknown caller';
        const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
        const sub = [veh || l.location, (l.servicesInterested || []).join(', ') || l.phone].filter(Boolean).join(' · ');
        const when = l.lastContactAt || l.createdAt;
        html.push(`<div class="v2-lead" draggable="true" data-id="${l.id}" onclick="Leads.open('${l.id}')">
          <div class="ln">${esc(name)}</div>
          <div class="ls">${esc(sub || '—')}</div>
          <div class="lf"><span class="v2-src">${sm.icon} ${esc(sm.label)}</span>
            ${(l.missedCount || 0) > 0 ? `<span class="lead-missed">⚠ ${l.missedCount} missed</span>` : ''}
            <span style="margin-left:auto;font-size:10.5px;color:var(--faint);">${when ? _msgTime(when) : ''}</span></div></div>`);
      });
      if (!cards.length) html.push(`<div style="text-align:center;font-size:11.5px;color:var(--faint);padding:14px 6px;">Empty</div>`);
      html.push('</div></div>');
    }
    html.push('</div>');
    el.innerHTML = html.join('');
    wireDnD();
  };

  function wireDnD() {
    document.querySelectorAll('#page-leads .v2-lead').forEach(card => {
      card.addEventListener('dragstart', e => { dragId = card.dataset.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    document.querySelectorAll('#page-leads .v2-bcol').forEach(col => {
      col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('dragover'); });
      col.addEventListener('dragleave', () => col.classList.remove('dragover'));
      col.addEventListener('drop', async e => {
        e.preventDefault(); col.classList.remove('dragover');
        const l = (Leads._leads || []).find(x => x.id === dragId); if (!l) return;
        const to = col.dataset.status; if (l.status === to) return;
        const from = l.status; l.status = to; Leads.render();
        try {
          await db.leads.update(l.id, { status: to });
          toast(`${l.name || l.phone || 'Lead'} → ${Leads._statusMeta[to]?.label || to}`);
        } catch (err) {
          l.status = from; Leads.render();
          toast(err.message || 'Could not move lead', 'error');
        }
      });
    });
  }
})();

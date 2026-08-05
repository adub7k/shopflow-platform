// ── v2 Leads (redesign) ───────────────────────────────────────────────────────
// Loaded ONLY by app2.html, after js/pages/leads.js. The default view is a
// simple list: each lead with who they are, what they asked for, and how to
// reach them. The pipeline board still exists behind a "Pipeline" toggle for
// anyone who wants to drag leads between stages. Rows open the existing lead
// modal; all data APIs are the existing ones.
(function () {
  const ORDER = ['new', 'contacted', 'booked', 'closed'];
  const COL_HINT = {
    new: 'Uncontacted — answer these first',
    contacted: 'Waiting on a reply or estimate',
    booked: 'Converted to an appointment',
    closed: 'Won or lost — kept for records',
  };
  const STATUS_PILL = {
    new:       '<span class="badge badge-blue">New</span>',
    contacted: '<span class="badge badge-yellow">Contacted</span>',
    booked:    '<span class="badge badge-green">Booked</span>',
    closed:    '<span class="badge badge-gray">Closed</span>',
  };
  let dragId = null;

  Leads._view2 = Leads._view2 || 'list';        // 'list' | 'pipeline'
  Leads._statusFilter2 = Leads._statusFilter2 || 'all';

  // A lead whose status isn't one of the four known stages (legacy or website
  // state-machine values) is treated as "new" for placement/filtering so it
  // never silently disappears.
  const colOf = (l) => ORDER.includes(l.status) ? l.status : 'new';

  // Safe read of "what they asked for" — coerces stray shapes so one odd record
  // can't throw. Returns { services, vehicle, note } strings.
  function requested(l) {
    const services = Array.isArray(l.servicesInterested) ? l.servicesInterested.filter(Boolean).join(', ')
      : (l.servicesInterested ? String(l.servicesInterested) : '');
    const vehicle = (l.vehicle && typeof l.vehicle === 'object')
      ? [l.vehicle.year, l.vehicle.make, l.vehicle.model, l.vehicle.color].filter(Boolean).join(' ')
      : (typeof l.vehicle === 'string' ? l.vehicle : '');
    const note = String(l.message || l.notes || '').trim();
    return { services, vehicle, note };
  }

  // Short "what came in" line for a lead with no typed request — mostly calls.
  function activitySummary(l) {
    const calls = Array.isArray(l.calls) ? l.calls : [];
    const bits = [];
    if (calls.some(c => c && c.voicemail)) bits.push('🎙 voicemail');
    else if (l.source === 'call' || calls.length) bits.push('📞 phone call');
    if ((l.missedCount || 0) > 0) bits.push(`⚠ ${l.missedCount} missed`);
    return bits.join(' · ');
  }

  // ── Lead-source split: phone vs Meta ads ──────────────────────────────────
  // Phone leads (from the call-tracking agency) and Meta ad leads (Facebook /
  // Instagram, run by a separate agency) are two distinct sources. The owner
  // wants each channel's numbers on their own so they can judge each agency.
  // Meta leads arrive via the public lead endpoint with source = utm_source, so
  // they land as one of these values.
  const META_SOURCES = ['facebook', 'instagram', 'meta', 'fb', 'ig'];
  const isPhoneLead = (l) => String(l.source || 'call').toLowerCase() === 'call';
  const isMetaLead  = (l) => META_SOURCES.includes(String(l.source || '').toLowerCase());

  // Leads / Booked / Conversion for a subset. 30-day window is the ad-spend read;
  // all-time rides along in the subtitle.
  function channelStats(subset) {
    const isBooked = (l) => colOf(l) === 'booked';
    const last30 = subset.filter(l => (Date.now() - new Date(l.createdAt || l.firstContactAt || 0)) < 30 * 86400000);
    const b30 = last30.filter(isBooked).length, bAll = subset.filter(isBooked).length;
    const conv = last30.length ? Math.round(b30 / last30.length * 100) : 0;
    return { n30: last30.length, nAll: subset.length, b30, bAll, conv };
  }

  // A single channel card, styled to match the v2 metric grid.
  function channelCard(icon, title, agency, s) {
    const convCls = s.conv >= 25 ? 'green' : '';
    const cell = (value, label, cls) => `<div style="flex:1;min-width:56px;">
        <div class="metric-value${cls ? ' ' + cls : ''}" style="font-size:22px;">${value}</div>
        <div class="metric-sub">${label}</div>
      </div>`;
    return `<div class="metric-card">
      <div class="metric-label">${icon} ${title}</div>
      <div style="display:flex;gap:14px;margin-top:8px;">
        ${cell(s.n30, `leads · ${s.nAll} all-time`)}
        ${cell(s.b30, `booked · ${s.bAll} all`)}
        ${cell(s.conv + '%', 'conversion', convCls)}
      </div>
      <div class="metric-sub" style="margin-top:8px;">${agency}</div>
    </div>`;
  }

  // Top-of-page channel comparison. Rendered on both list and pipeline views so
  // the phone-vs-Meta read is always the first thing the owner sees.
  function channelMetrics(leads) {
    if (!leads.length) return '';
    const phone = channelStats(leads.filter(isPhoneLead));
    const meta  = channelStats(leads.filter(isMetaLead));
    return `<div class="v2-mgrid" style="grid-template-columns:repeat(2,1fr);margin-bottom:14px;">
      ${channelCard('📞', 'Phone leads', 'Call-tracking agency', phone)}
      ${channelCard('📱', 'Meta ads', 'Facebook / Instagram agency', meta)}
    </div>`;
  }

  Leads.render = async function () {
    const el = document.getElementById('page-leads'); if (!el) return;
    el.classList.add('v2-wide');
    // Keep the last good leads on a failed refresh, and surface the error instead
    // of a deceptive empty page (a 403 otherwise looks like "no leads").
    let loadError = null;
    try { this._leads = await db.leads.all(); }
    catch (e) { loadError = (e && e.message) || 'Could not load leads'; this._leads = this._leads || []; }
    const leads = this._leads || [];

    const counts = { all: leads.length }; ORDER.forEach(s => counts[s] = 0);
    leads.forEach(l => { counts[colOf(l)]++; });

    const html = [];

    // Header + view toggle (list is default; pipeline lives behind the toggle).
    const seg = (v, label) => `<button class="v2-seg${this._view2 === v ? ' on' : ''}" onclick="Leads.setView('${v}')">${label}</button>`;
    html.push(`<div class="v2-pagehd"><div><h1>Leads</h1>
      <div class="sub">${counts.all} lead${counts.all !== 1 ? 's' : ''}${counts.new ? ` · <span style="color:var(--blue,#2f6feb);font-weight:600;">${counts.new} new</span>` : ''}</div></div>
      <div class="sp"></div>
      <div class="v2-segwrap" style="display:inline-flex;border:1px solid var(--border-md);border-radius:8px;overflow:hidden;margin-right:10px;">${seg('list', 'List')}${seg('pipeline', 'Pipeline')}</div>
      <button class="btn" onclick="App.nav('response')">Response Center${counts.new ? ' (' + counts.new + ')' : ''}</button></div>`);

    if (loadError) html.push(`<div style="background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--red,#e5534b);border-radius:10px;padding:10px 12px;margin-bottom:12px;color:var(--muted);font-size:13px;">⚠ Couldn't refresh leads (${esc(loadError)}). Showing the last loaded set — reload to try again.</div>`);

    // Phone-vs-Meta channel split, above both views.
    html.push(channelMetrics(leads));

    if (this._view2 === 'pipeline') { renderPipeline.call(this, html, leads, counts); el.innerHTML = html.join(''); wireDnD(); return; }
    renderList.call(this, html, leads, counts);
    el.innerHTML = html.join('');
  };

  Leads.setView = function (v) { this._view2 = v; this.render(); };
  Leads.setStatusFilter = function (s) { this._statusFilter2 = s; this.render(); };

  // ── List view (default) ───────────────────────────────────────────────────
  function renderList(html, leads, counts) {
    // Compact status filter chips.
    const chip = (key, label, n) => `<button class="v2-chip${this._statusFilter2 === key ? ' on' : ''}" onclick="Leads.setStatusFilter('${key}')">${label}${n ? `<span class="n">${n}</span>` : ''}</button>`;
    html.push(`<div class="v2-chips" style="margin-bottom:12px;">
      ${chip('all', 'All', counts.all)}${chip('new', 'New', counts.new)}${chip('contacted', 'Contacted', counts.contacted)}${chip('booked', 'Booked', counts.booked)}${chip('closed', 'Closed', counts.closed)}</div>`);

    let rows = leads.slice();
    if (this._statusFilter2 !== 'all') rows = rows.filter(l => colOf(l) === this._statusFilter2);
    rows.sort((a, b) => new Date(b.lastContactAt || b.createdAt || 0) - new Date(a.lastContactAt || a.createdAt || 0));

    if (!rows.length) {
      html.push(`<div class="v2-card"><div class="empty-state"><div class="empty-icon">📥</div>
        <div class="empty-text">${this._statusFilter2 === 'all' ? 'No leads yet' : 'No ' + this._statusFilter2 + ' leads'}</div>
        <div class="list-sub" style="margin-top:2px;">${this._statusFilter2 === 'all' ? 'New calls and website inquiries will show up here.' : 'Try a different filter.'}</div>
        ${this._statusFilter2 !== 'all' ? `<div style="margin-top:12px;"><button class="btn btn-sm" onclick="Leads.setStatusFilter('all')">Show all</button></div>` : ''}
      </div></div>`);
      return;
    }

    html.push(`<div class="v2-card v2-tablewrap"><table class="v2-table">
      <thead><tr><th>Lead</th><th>Requested</th><th>Contact</th><th>Status</th><th class="r">Received</th></tr></thead><tbody>`);
    rows.forEach(l => {
      try {
        const sm = Leads._sourceMeta(l.source);
        const name = l.name || l.phone || 'Unknown caller';
        const { services, vehicle, note } = requested(l);
        // Build the "Requested" cell — the star of this view.
        const reqLines = [];
        if (services) reqLines.push(`<div style="font-weight:600;">${esc(services)}</div>`);
        if (vehicle) reqLines.push(`<div style="color:var(--muted);font-size:12px;">${esc(vehicle)}</div>`);
        if (note) reqLines.push(`<div style="color:var(--muted);font-size:12px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">“${esc(note)}”</div>`);
        if (!reqLines.length) { const act = activitySummary(l); reqLines.push(`<div style="color:var(--faint);">${act ? esc(act) : '—'}</div>`); }
        const when = l.lastContactAt || l.createdAt;
        const email = l.email ? `<div style="color:var(--muted);font-size:12px;">${esc(l.email)}</div>` : '';
        html.push(`<tr onclick="Leads.open('${l.id}')">
          <td><div style="display:flex;align-items:center;gap:8px;"><span class="v2-src">${sm.icon} ${esc(sm.label)}</span></div>
            <div style="font-weight:600;margin-top:4px;">${esc(name)}</div></td>
          <td>${reqLines.join('')}</td>
          <td style="color:var(--muted);">${esc(l.phone || '—')}${email}</td>
          <td>${STATUS_PILL[colOf(l)] || ''}</td>
          <td class="r" style="color:var(--muted);white-space:nowrap;">${when ? _msgTime(when) : '—'}</td>
        </tr>`);
      } catch (err) {
        console.error('Lead row render failed for', l && l.id, err);
        html.push(`<tr onclick="Leads.open('${l && l.id || ''}')"><td>${esc((l && (l.name || l.phone)) || 'Lead')}</td><td colspan="4" style="color:var(--faint);">Tap to view</td></tr>`);
      }
    });
    html.push('</tbody></table></div>');

    // Phones get a tappable card list instead of a side-scrolling table —
    // app2.css swaps the two at 640px. Same rows, same modal on tap.
    html.push('<div class="v2-leadlist v2-card">');
    rows.forEach(l => {
      try {
        const sm = Leads._sourceMeta(l.source);
        const name = l.name || l.phone || 'Unknown caller';
        const { services, vehicle } = requested(l);
        const sub = [services, vehicle].filter(Boolean).join(' · ') || l.phone || '';
        const when = l.lastContactAt || l.createdAt;
        html.push(`<div class="msg-inbox-row" onclick="Leads.open('${l.id}')">
          ${avatarEl(name, 42)}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div style="font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
              <div style="font-size:11px;color:var(--faint);white-space:nowrap;flex-shrink:0;">${when ? _msgTime(when) : ''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:3px;min-width:0;">
              ${STATUS_PILL[colOf(l)] || ''}
              <span class="v2-src" style="flex-shrink:0;">${sm.icon} ${esc(sm.label)}</span>
              <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${esc(sub)}</div>
            </div>
          </div>
        </div>`);
      } catch (err) {
        console.error('Lead card render failed for', l && l.id, err);
      }
    });
    html.push('</div>');
  }

  // ── Pipeline view (kanban board, kept from the redesign) ──────────────────
  function renderPipeline(html, leads, counts) {
    const booked = counts.booked || 0;
    const conv = counts.all ? Math.round(booked / counts.all * 100) : 0;
    const missed = leads.reduce((s, l) => s + (l.missedCount || 0), 0);
    html.push(`<div class="v2-mgrid" style="grid-template-columns:repeat(4,1fr);">
      <div class="metric-card"><div class="metric-label">New leads</div><div class="metric-value">${counts.new || 0}</div><div class="metric-sub">${counts.new ? 'waiting on a response' : 'all answered'}</div></div>
      <div class="metric-card"><div class="metric-label">In conversation</div><div class="metric-value">${counts.contacted || 0}</div><div class="metric-sub">contacted, not booked yet</div></div>
      <div class="metric-card"><div class="metric-label">Booked</div><div class="metric-value green">${booked}</div><div class="metric-sub">${conv}% of all leads</div></div>
      <div class="metric-card"><div class="metric-label">Missed calls</div><div class="metric-value">${missed}</div><div class="metric-sub">across all leads</div></div></div>`);

    html.push('<div class="v2-board">');
    for (const st of ORDER) {
      const m = Leads._statusMeta[st];
      const cards = leads.filter(l => colOf(l) === st)
        .sort((a, b) => new Date(b.lastContactAt || b.createdAt || 0) - new Date(a.lastContactAt || a.createdAt || 0));
      html.push(`<div class="v2-bcol" data-status="${st}"><div class="v2-bh">
        <div class="bt">${m ? m.label : st} <span class="n">${cards.length}</span></div>
        <div class="bv">${COL_HINT[st] || ''}</div></div><div class="v2-bcards">`);
      cards.forEach(l => {
        try {
          const sm = Leads._sourceMeta(l.source);
          const name = l.name || l.phone || 'Unknown caller';
          const { services, vehicle } = requested(l);
          const sub = [vehicle || l.location, services || l.phone].filter(Boolean).join(' · ');
          const when = l.lastContactAt || l.createdAt;
          html.push(`<div class="v2-lead" draggable="true" data-id="${l.id}" onclick="Leads.open('${l.id}')">
            <div class="ln">${esc(name)}</div>
            <div class="ls">${esc(sub || '—')}</div>
            <div class="lf"><span class="v2-src">${sm.icon} ${esc(sm.label)}</span>
              ${(l.missedCount || 0) > 0 ? `<span class="lead-missed">⚠ ${l.missedCount} missed</span>` : ''}
              <span style="margin-left:auto;font-size:10.5px;color:var(--faint);">${when ? _msgTime(when) : ''}</span></div></div>`);
        } catch (err) {
          console.error('Lead card render failed for', l && l.id, err);
          html.push(`<div class="v2-lead" draggable="true" data-id="${l && l.id || ''}" onclick="Leads.open('${l && l.id || ''}')">
            <div class="ln">${esc((l && (l.name || l.phone)) || 'Lead')}</div>
            <div class="ls" style="color:var(--faint);">Tap to view</div></div>`);
        }
      });
      if (!cards.length) html.push(`<div style="text-align:center;font-size:11.5px;color:var(--faint);padding:14px 6px;">Empty</div>`);
      html.push('</div></div>');
    }
    html.push('</div>');
  }

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

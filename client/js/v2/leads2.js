// ── v2 Leads (redesign) ───────────────────────────────────────────────────────
// Loaded ONLY by app2.html, after js/pages/leads.js. The default view is a
// simple list: each lead with who they are, what they asked for, and how to
// reach them. The "Pipeline" toggle jumps to the dedicated Pipeline board page
// (js/pages/pipeline.js) — full stage set, one-tap advance, follow-up timing.
// Rows open the existing lead modal; all data APIs are the existing ones.
(function () {
  // Stage vocabulary comes from the shared owner-editable config
  // (Leads.stageConfig, settings.pipeline.stages) — resolved per render, not at
  // load time, because Shop.settings isn't populated until boot finishes.
  const stages = () => Leads.stageConfig();
  const orderKeys = () => stages().map(s => s.key);
  const statusPill = (key) => {
    const s = stages().find(x => x.key === key);
    return s ? `<span class="badge" style="background:${s.color}1a;color:${s.color};">${esc(s.label)}</span>` : '';
  };

  Leads._statusFilter2 = Leads._statusFilter2 || 'all';

  // A lead whose status isn't a configured stage (legacy or website
  // state-machine values) is treated as intake for placement/filtering so it
  // never silently disappears.
  const colOf = (l) => { const ks = orderKeys(); return ks.includes(l.status) ? l.status : ks[0]; };

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
    // Won = reached booked or beyond (Leads._isWon guards legacy closed=dead).
    const isBooked = (l) => Leads._isWon(l);
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
    // Modal actions (save / status / note / convert) all funnel back through
    // here — when the owner is working from the Pipeline board, repaint that
    // instead of the hidden list.
    if (typeof Pipeline !== 'undefined' && Pipeline.isActive()) return Pipeline.render();
    const el = document.getElementById('page-leads'); if (!el) return;
    el.classList.add('v2-wide');
    // Keep the last good leads on a failed refresh, and surface the error instead
    // of a deceptive empty page (a 403 otherwise looks like "no leads").
    let loadError = null;
    try { this._leads = await db.leads.all(); }
    catch (e) { loadError = (e && e.message) || 'Could not load leads'; this._leads = this._leads || []; }
    const leads = this._leads || [];

    const counts = { all: leads.length }; orderKeys().forEach(k => counts[k] = 0);
    leads.forEach(l => { counts[colOf(l)]++; });

    const html = [];

    // Header + view toggle (list here; "Pipeline" jumps to the board page).
    const seg = (v, label) => `<button class="v2-seg${v === 'list' ? ' on' : ''}" onclick="Leads.setView('${v}')">${label}</button>`;
    html.push(`<div class="v2-pagehd"><div><h1>Leads</h1>
      <div class="sub">${counts.all} lead${counts.all !== 1 ? 's' : ''}${counts.new ? ` · <span style="color:var(--blue,#2f6feb);font-weight:600;">${counts.new} new</span>` : ''}</div></div>
      <div class="sp"></div>
      <div class="v2-segwrap" style="display:inline-flex;border:1px solid var(--border-md);border-radius:8px;overflow:hidden;margin-right:10px;">${seg('list', 'List')}${seg('pipeline', 'Pipeline')}</div>
      <button class="btn" onclick="App.nav('response')">Response Center${counts.new ? ' (' + counts.new + ')' : ''}</button></div>`);

    if (loadError) html.push(`<div style="background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--red,#e5534b);border-radius:10px;padding:10px 12px;margin-bottom:12px;color:var(--muted);font-size:13px;">⚠ Couldn't refresh leads (${esc(loadError)}). Showing the last loaded set — reload to try again.</div>`);

    // Phone-vs-Meta channel split, above both views.
    html.push(channelMetrics(leads));

    // Duplicate detector: same person under two phone formats (E.164 vs
    // national) — the server merge folds histories together, oldest wins.
    const pk = (p) => String(p || '').replace(/\D/g, '').slice(-10);
    const seen = {};
    let dupes = 0;
    leads.forEach(l => {
      if (l.channel === 'website') return;
      const k = pk(l.phone);
      if (!k) return;
      if (seen[k]) dupes++; else seen[k] = true;
    });
    if (dupes) {
      html.push(`<div style="display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--orange);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
        <div style="flex:1;font-size:13px;color:var(--muted);"><strong style="color:var(--text);">${dupes} duplicate lead${dupes === 1 ? '' : 's'}</strong> — same phone number saved twice (different formats). Merging keeps every note, call, and follow-up on one record.</div>
        <button class="btn btn-sm" onclick="Leads.mergeDupes(this)">Merge duplicates</button>
      </div>`);
    }

    renderList.call(this, html, leads, counts);
    el.innerHTML = html.join('');
  };

  Leads.mergeDupes = async function (btn) {
    disableBtn(btn);
    try {
      const r = await db.leads.dedupe();
      toast((r.merged || 0) + ' duplicate' + (r.merged === 1 ? '' : 's') + ' merged ✓');
    } catch (e) { toast(e.message || 'Merge failed', 'error'); }
    this.render();
  };

  // The board is its own page now (full stage set + follow-up timing).
  Leads.setView = function (v) { if (v === 'pipeline') App.nav('pipeline'); };
  Leads.setStatusFilter = function (s) { this._statusFilter2 = s; this.render(); };

  // ── List view (default) ───────────────────────────────────────────────────
  function renderList(html, leads, counts) {
    // Compact status filter chips.
    const chip = (key, label, n) => `<button class="v2-chip${this._statusFilter2 === key ? ' on' : ''}" onclick="Leads.setStatusFilter('${key}')">${label}${n ? `<span class="n">${n}</span>` : ''}</button>`;
    html.push(`<div class="v2-chips" style="margin-bottom:12px;">
      ${chip('all', 'All', counts.all)}${stages().map(s => chip(s.key, esc(s.label), counts[s.key])).join('')}</div>`);

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
          <td>${statusPill(colOf(l))}</td>
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
              ${statusPill(colOf(l))}
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

})();

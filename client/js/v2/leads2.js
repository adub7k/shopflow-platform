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

  // ── Select mode (bulk clean-out on the list) ──────────────────────────────
  // Same idea as the Pipeline column "Select": checkboxes on every row plus a
  // sticky bar with Move / Mark lost / Delete, driven by the bulk endpoints.
  Leads._selMode = false;
  Leads._sel = new Set();
  Leads.toggleSelMode = function () { this._selMode = !this._selMode; this._sel = new Set(); this.render(); };
  Leads.selToggle = function (id) {
    if (this._sel.has(id)) this._sel.delete(id); else this._sel.add(id);
    const on = this._sel.has(id);
    document.querySelectorAll(`[data-selrow="${id}"]`).forEach(r => {
      r.classList.toggle('on', on);
      const cb = r.querySelector('input.ld-cb'); if (cb) cb.checked = on;
    });
    const c = document.getElementById('sel-count'); if (c) c.textContent = this._sel.size + ' selected';
  };
  Leads.selAll = function () {
    const shown = this._shownIds || [];
    const all = shown.length && shown.every(id => this._sel.has(id));
    this._sel = all ? new Set() : new Set(shown);
    this.render();
  };
  Leads.selApply = async function (kind) {
    const ids = [...this._sel];
    if (!ids.length) { toast('Nothing selected', 'warning'); return; }
    try {
      if (kind === 'delete') {
        if (!confirm(`Delete ${ids.length} lead${ids.length === 1 ? '' : 's'} and their history? This can't be undone.`)) return;
        await db.leads.bulkDelete(ids); toast(ids.length + ' deleted');
      } else if (kind === 'lost') {
        await db.leads.bulkStatus(ids, 'lost'); toast(ids.length + ' marked lost');
      } else {
        const to = (document.getElementById('sel-move') || {}).value; if (!to) return;
        const s = stages().find(x => x.key === to);
        await db.leads.bulkStatus(ids, to); toast(ids.length + ' moved to ' + ((s && s.label) || to));
      }
    } catch (e) { toast(e.message || 'Bulk action failed', 'error'); return; }
    this._sel = new Set();
    this.render();   // stay in select mode — keep sweeping
  };

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

  // Phone-vs-Meta channel comparison. Lives on the REVENUE tab now (pages2.js
  // calls this via Leads.channelMetrics) — it's an ad-spend/ROI read, so it sits
  // with the money numbers instead of pushing the lead worklist down.
  function channelMetrics(leads) {
    if (!leads.length) return '';
    const phone = channelStats(leads.filter(isPhoneLead));
    const meta  = channelStats(leads.filter(isMetaLead));
    return `<div class="v2-mgrid" style="grid-template-columns:repeat(2,1fr);margin-bottom:14px;">
      ${channelCard('📞', 'Phone leads', 'Call-tracking agency', phone)}
      ${channelCard('📱', 'Meta ads', 'Facebook / Instagram agency', meta)}
    </div>`;
  }
  Leads.channelMetrics = channelMetrics;

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
    if (this._skipFetchOnce && (this._leads || []).length) { this._skipFetchOnce = false; }   // search keystroke — repaint from cache
    else {
      try { this._leads = await db.leads.all(); }
      catch (e) { loadError = (e && e.message) || 'Could not load leads'; this._leads = this._leads || []; }
    }
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
      <button class="btn${this._selMode ? ' btn-primary' : ''}" onclick="Leads.toggleSelMode()">${this._selMode ? 'Done' : 'Select'}</button>
      <button class="btn" onclick="App.nav('response')">Response Center${counts.new ? ' (' + counts.new + ')' : ''}</button></div>`);

    if (loadError) html.push(`<div style="background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--red,#e5534b);border-radius:10px;padding:10px 12px;margin-bottom:12px;color:var(--muted);font-size:13px;">⚠ Couldn't refresh leads (${esc(loadError)}). Showing the last loaded set — reload to try again.</div>`);

    // Duplicate detector: same person under two phone formats (E.164 vs
    // national) — the server merge folds histories together, oldest wins.
    // Requires a full 10-digit number, mirroring the server's phoneKey — junk
    // placeholder phones must never count (or merge) as duplicates.
    const pk = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
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
    Leads._refocusSearch();
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
    html.push(`<div style="margin-bottom:10px;"><input class="form-input" id="lead-search" placeholder="Search name, phone, vehicle…" value="${esc(Leads._searchQ)}" oninput="Leads.searchFilter(this.value)" style="width:100%;max-width:420px;height:38px;padding:0 12px;"/></div>`);
    html.push(`<div class="v2-chips" style="margin-bottom:12px;">
      ${chip('all', 'All', counts.all)}${stages().map(s => chip(s.key, esc(s.label), counts[s.key])).join('')}</div>`);

    let rows = leads.slice();
    if (this._statusFilter2 !== 'all') rows = rows.filter(l => colOf(l) === this._statusFilter2);
    rows = rows.filter(l => Leads.matchesSearch(l, Leads._searchQ));
    // Most recent inbound contact first (arrival time for never-recontacted
    // leads) and NOTHING else. lastContactAt moves on customer activity only,
    // so working the list never reshuffles it under the owner's finger — the
    // old touched-today sink reordered rows mid-session and made "the next
    // lead" a moving target. The ✓ today chip alone marks handled leads now.
    rows.sort((a, b) => new Date(b.lastContactAt || b.createdAt || 0) - new Date(a.lastContactAt || a.createdAt || 0));
    this._shownIds = rows.map(l => l.id);   // Select-all operates on the filtered view
    const selMode = this._selMode;
    const rowClick = (id) => selMode ? `Leads.selToggle('${id}')` : `Leads.open('${id}')`;
    const rowCb = (id) => selMode ? `<input type="checkbox" class="ld-cb" ${this._sel.has(id) ? 'checked' : ''} onclick="event.stopPropagation();Leads.selToggle('${id}')">` : '';

    if (!rows.length) {
      const searching = !!String(Leads._searchQ || '').trim();
      html.push(`<div class="v2-card"><div class="empty-state"><div class="empty-icon">📥</div>
        <div class="empty-text">${searching ? 'No leads match your search' : this._statusFilter2 === 'all' ? 'No leads yet' : 'No ' + this._statusFilter2 + ' leads'}</div>
        <div class="list-sub" style="margin-top:2px;">${searching ? 'Check the spelling or try part of the phone number.' : this._statusFilter2 === 'all' ? 'New calls and website inquiries will show up here.' : 'Try a different filter.'}</div>
        ${searching ? `<div style="margin-top:12px;"><button class="btn btn-sm" onclick="Leads.searchFilter('')">Clear search</button></div>`
          : this._statusFilter2 !== 'all' ? `<div style="margin-top:12px;"><button class="btn btn-sm" onclick="Leads.setStatusFilter('all')">Show all</button></div>` : ''}
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
        html.push(`<tr data-selrow="${l.id}" class="${this._sel.has(l.id) ? 'on' : ''}" onclick="${rowClick(l.id)}">
          <td><div style="display:flex;align-items:center;gap:8px;">${rowCb(l.id)}<span class="v2-src">${sm.icon} ${esc(sm.label)}</span></div>
            <div style="font-weight:600;margin-top:4px;">${esc(name)}</div></td>
          <td>${reqLines.join('')}</td>
          <td style="color:var(--muted);">${esc(l.phone || '—')}${email}</td>
          <td>${statusPill(colOf(l))}${Leads.touchedToday(l) ? ' <span class="badge badge-green" title="Already reached out today">✓ today</span>' : ''}</td>
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
        html.push(`<div class="msg-inbox-row ${this._sel.has(l.id) ? 'on' : ''}" data-selrow="${l.id}" onclick="${rowClick(l.id)}">
          ${rowCb(l.id)}${avatarEl(name, 42)}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div style="font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
              <div style="font-size:11px;color:var(--faint);white-space:nowrap;flex-shrink:0;">${when ? _msgTime(when) : ''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:3px;min-width:0;">
              ${statusPill(colOf(l))}${Leads.touchedToday(l) ? '<span class="badge badge-green" style="flex-shrink:0;" title="Already reached out today">✓</span>' : ''}
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

    // Sticky bulk-action bar while selecting.
    if (selMode) {
      const opts = stages().map(s => `<option value="${s.key}">${esc(s.label)}</option>`).join('');
      const canDel = Auth.getRole() === 'full';
      html.push(`<div class="ld-selbar">
        <button class="btn btn-sm" onclick="Leads.selAll()">All</button>
        <span id="sel-count" style="font-size:12.5px;font-weight:700;white-space:nowrap;">${this._sel.size} selected</span>
        <select class="form-input" id="sel-move" style="flex:1;min-width:90px;max-width:150px;padding:6px 8px;">${opts}</select>
        <button class="btn btn-sm" onclick="Leads.selApply('move')">Move</button>
        <button class="btn btn-sm" onclick="Leads.selApply('lost')">Lost</button>
        ${canDel ? `<button class="btn btn-sm btn-danger" onclick="Leads.selApply('delete')">Delete</button>` : ''}
      </div>`);
    }
  }

})();

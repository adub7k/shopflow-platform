// ── v2 page rebuilds: Response, Tasks, Estimates, Revenue, Reviews, Automations ─
// Loaded ONLY by app2.html, after all js/pages/* modules. Each block replaces a
// page's markup with the redesigned layout while reusing that module's own data
// loading, scoring, and action methods. /shop (v1) never loads this file.

/* ── Response Center ── */
(function () {
  Response.render = async function () {
    const el = document.getElementById('page-response'); if (!el) return;
    el.classList.add('v2-wide');
    try { this._leads = await db.leads.all(); } catch (e) { this._leads = []; }
    if (!this._timer) this._timer = setInterval(() => {
      if (App._page === 'response' && !document.querySelector('.modal-overlay')) this.render();
    }, 30000);

    const waiting = this._leads.filter(l => l.status === 'new')
      .map(l => ({ l, ...this._score(l), waitMin: this._mins(l.createdAt || l.firstContactAt) }))
      .sort((a, b) => b.score - a.score || a.waitMin - b.waitMin);
    const responded = this._leads
      .filter(l => l.firstResponseAt && (l.createdAt || l.firstContactAt))
      .map(l => ({ l, respMin: this._mins(l.createdAt || l.firstContactAt, l.firstResponseAt) }))
      .sort((a, b) => new Date(b.l.firstResponseAt) - new Date(a.l.firstResponseAt));
    const last30 = responded.filter(r => (Date.now() - new Date(r.l.firstResponseAt)) < 30 * 86400000);
    const avgMin = last30.length ? last30.reduce((a, r) => a + r.respMin, 0) / last30.length : null;
    const under5 = last30.length ? Math.round(last30.filter(r => r.respMin <= 5).length / last30.length * 100) : null;
    const oldest = waiting.length ? Math.max(...waiting.map(w => w.waitMin)) : null;

    const html = [];
    html.push(`<div class="v2-pagehd"><div><h1>Response Center</h1>
      <div class="sub">Every lead answered inside 5 minutes wins the job — this queue keeps the clock visible</div></div></div>`);

    html.push(`<div class="v2-mgrid" style="grid-template-columns:repeat(4,1fr);">
      <div class="metric-card"><div class="metric-label">Waiting now</div><div class="metric-value" style="color:${waiting.length ? 'var(--red)' : 'var(--green-deep)'};">${waiting.length}</div><div class="metric-sub">${waiting.length ? 'need a first response' : 'all caught up'}</div></div>
      <div class="metric-card"><div class="metric-label">Oldest waiting</div><div class="metric-value">${oldest != null ? this._fmtDur(oldest) : '—'}</div><div class="metric-sub">${oldest != null ? 'answer oldest first if tied' : 'queue is clear'}</div></div>
      <div class="metric-card"><div class="metric-label">Avg response</div><div class="metric-value" style="color:${avgMin != null ? this._respMeta(avgMin).fg : 'var(--text)'};">${avgMin != null ? this._fmtDur(avgMin) : '—'}</div><div class="metric-sub">last 30 days</div></div>
      <div class="metric-card"><div class="metric-label">Under 5 min</div><div class="metric-value" style="color:${under5 != null ? (under5 >= 50 ? 'var(--green-deep)' : 'var(--orange)') : 'var(--text)'};">${under5 != null ? under5 + '%' : '—'}</div><div class="metric-sub">the speed-to-lead target</div></div></div>`);

    html.push('<div class="v2-dgrid"><div class="v2-col">');
    html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Needs a response</div>${waiting.length ? '<span class="sub">highest priority first</span>' : ''}</div>`);
    if (!waiting.length) {
      html.push(`<div class="empty-state"><div class="empty-icon">🎉</div><div class="empty-text">Every lead has been answered</div>
        <div class="list-sub" style="margin-top:2px;">New leads land here the moment they come in — from the lead form or a call to your tracking number.</div></div>`);
    } else {
      waiting.forEach(w => {
        const l = w.l, sm = Leads._sourceMeta(l.source), scm = this._scoreMeta(w.score), wm = this._waitMeta(w.waitMin);
        const name = l.name || l.phone || 'Unknown caller';
        const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
        const sub = [veh, (l.servicesInterested || []).join(', ')].filter(Boolean).join(' · ');
        const tel = 'tel:' + String(l.phone || '').replace(/[^\d+]/g, '');
        html.push(`<div class="list-row" style="align-items:flex-start;" onclick="Response.open('${l.id}')">
          <span class="v2-score" style="background:${scm.bg};color:${scm.fg};"><span class="s">${w.score}</span><span class="l">${scm.label}</span></span>
          <div class="list-main">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span class="list-name">${esc(name)}</span>
              <span class="lead-badge" style="background:${wm.bg};color:${wm.fg};">⏱ ${this._fmtDur(w.waitMin)}</span>
              <span class="v2-src">${sm.icon} ${esc(sm.label)}</span></div>
            <div class="list-sub">${esc(sub || l.phone || '')}</div>
            ${w.why.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:5px;">${w.why.slice(0, 3).map(r => `<span style="font-size:10.5px;background:var(--surface2);color:var(--muted);border-radius:6px;padding:2px 7px;white-space:nowrap;">${esc(r)}</span>`).join('')}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;" onclick="event.stopPropagation();">
            ${l.phone ? `<a class="btn btn-sm" href="${esc(tel)}" onclick="Response.armCallClear('${l.id}')" style="text-decoration:none;">Call</a>
            <button class="btn btn-sm btn-green" onclick="Response.text('${l.id}')">Text</button>` : ''}
            <button class="btn btn-sm" onclick="Response.markContacted('${l.id}')" title="Mark responded">✓</button>
          </div></div>`);
      });
    }
    html.push('</div></div><div class="v2-col">');

    if (responded.length) {
      html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Recently answered</div></div>`);
      responded.slice(0, 8).forEach(r => {
        const rm = this._respMeta(r.respMin);
        html.push(`<div class="list-row" style="cursor:default;"><div class="list-main"><div class="list-name" style="font-weight:500;">${esc(r.l.name || r.l.phone || 'Lead')}</div></div>
          <span class="lead-badge" style="background:${rm.bg};color:${rm.fg};">in ${this._fmtDur(r.respMin)}</span></div>`);
      });
      html.push('</div>');
      const bySrc = {};
      last30.forEach(r => { const k = String(r.l.source || 'call').toLowerCase(); (bySrc[k] = bySrc[k] || []).push(r.respMin); });
      const keys = Object.keys(bySrc).sort((a, b) => bySrc[b].length - bySrc[a].length);
      if (keys.length) {
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Response time by source</div><span class="sub">30 days</span></div>`);
        keys.forEach(k => {
          const arr = bySrc[k], avg = arr.reduce((x, y) => x + y, 0) / arr.length, sm = Leads._sourceMeta(k), rm = this._respMeta(avg);
          html.push(`<div class="list-row" style="cursor:default;"><div class="list-main"><div class="list-name" style="font-weight:500;">${sm.icon} ${esc(sm.label)}</div>
            <div class="list-sub">${arr.length} lead${arr.length !== 1 ? 's' : ''}</div></div>
            <span class="lead-badge" style="background:${rm.bg};color:${rm.fg};">avg ${this._fmtDur(avg)}</span></div>`);
        });
        html.push('</div>');
      }
    }
    html.push('</div></div>');
    el.innerHTML = html.join('');
  };

  // Click-to-call → "Did you reach them?". The <a href="tel:"> launches the
  // dialer; this arms a one-shot listener so that when the owner returns to the
  // app (the tab regains visibility/focus after the call), we ask whether they
  // connected — Yes marks the lead responded and drops it from the queue, No
  // leaves it. Primary path is mobile (visibilitychange); desktop falls back to
  // blur/focus and disarms after 2 min if the call never actually happened.
  Response.armCallClear = function (id) {
    const l = this._leads.find(x => x.id === id);
    if (!l || !l.phone) return;
    const name = l.name || l.phone;
    let leftForCall = false;
    const finish = () => {
      cleanup();
      Response._askReached(id, name);
    };
    const onVis = () => {
      if (document.hidden) { leftForCall = true; return; }
      if (leftForCall) finish();
    };
    const onBlur = () => { leftForCall = true; };
    const onFocus = () => { if (leftForCall) finish(); };
    let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    setTimeout(cleanup, 120000);
  };

  // "Did you reach {name}?" prompt on return from the call. Lives on <body> so a
  // queue re-render / 30s auto-refresh doesn't remove it. Auto-dismisses after
  // 20s leaving the lead in the queue (the safe default).
  Response._askReached = function (id, name) {
    const l = this._leads.find(x => x.id === id);
    if (!l || l.status !== 'new') return; // already handled elsewhere
    const old = document.getElementById('rc-callprompt'); if (old) old.remove();
    const p = document.createElement('div');
    p.id = 'rc-callprompt';
    p.style.cssText = 'position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:13px 15px;box-shadow:var(--shadow-lg);z-index:9999;width:min(360px, calc(100vw - 24px));';
    p.innerHTML =
      `<div style="font-size:13px;font-weight:650;color:var(--text);margin-bottom:11px;">Did you reach ${esc(name)}?</div>
       <div style="display:flex;flex-direction:column;gap:8px;">
         <button class="btn btn-green" id="rc-cp-yes" style="justify-content:center;">Yes — mark responded</button>
         <div style="display:flex;gap:8px;">
           <button class="btn btn-sm" id="rc-cp-text" style="flex:1;justify-content:center;">No — text them</button>
           <button class="btn btn-sm" id="rc-cp-no" style="flex:1;justify-content:center;">Not yet</button>
         </div>
       </div>`;
    document.body.appendChild(p);
    const close = () => { if (p.parentNode) p.remove(); };
    p.querySelector('#rc-cp-yes').onclick = () => { close(); Response._markReached(id); };
    p.querySelector('#rc-cp-text').onclick = () => { close(); Response.text(id); };
    p.querySelector('#rc-cp-no').onclick = close;
    setTimeout(close, 20000);
  };

  Response._markReached = async function (id) {
    const l = this._leads.find(x => x.id === id);
    if (!l || l.status !== 'new') return;
    // Persist first, THEN re-render — render() refetches, so an early render
    // would still show the lead until the write lands.
    try { await db.leads.update(id, { status: 'contacted' }); } catch (e) {}
    this.render();
    toast('Marked responded ✓');
  };
})();

/* ── Tasks (worklist) ── */
(function () {
  Tasks._html = function (groups) {
    const total = groups.today.length + groups.overdue.length + groups.upcoming.length + groups.snoozed.length;
    const out = [];
    out.push(`<div class="v2-pagehd"><div><h1>Tasks</h1>
      <div class="sub">${total ? total + ' follow-up' + (total !== 1 ? 's' : '') + ' queued — win-backs, service due, uncontacted leads, tomorrow’s reminders' : 'Win-backs, service reminders, and uncontacted leads land here'}</div></div>
      <div class="sp"></div>
      <button class="btn${this._selMode ? ' btn-primary' : ''}" onclick="Tasks.toggleSelMode()">${this._selMode ? 'Done' : 'Select'}</button>
      <button class="btn" onclick="Tasks.cadenceModal()">Edit cadence</button></div>`);
    // 30-day Meta-lead sequence: metrics strip + enrollment prompt.
    const fs = this._fuStats || {};
    if (fs.entered || (this._fuUnenrolled || []).length) {
      const rate = fs.entered ? Math.round((fs.booked / fs.entered) * 100) : 0;
      const cell = (v, label, cls) => `<div style="flex:1;min-width:78px;"><div class="metric-value${cls ? ' ' + cls : ''}" style="font-size:20px;">${v}</div><div class="metric-sub">${label}</div></div>`;
      out.push(`<div class="metric-card" style="margin-bottom:14px;">
        <div class="metric-label">30-day sequence</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;">
          ${cell(fs.due || 0, 'due today')}${cell(fs.sentToday || 0, 'sent today')}${cell(fs.active || 0, 'in sequence')}${fs.objection ? cell(fs.objection, 'objection follow-ups') : ''}${cell(fs.paused || 0, 'paused')}${cell((fs.booked || 0) + (fs.entered ? ' (' + rate + '%)' : ''), 'booked', 'green')}
        </div>
        ${(this._fuUnenrolled || []).length ? `<div style="display:flex;align-items:center;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
          <div style="flex:1;font-size:12.5px;color:var(--muted);">${this._fuUnenrolled.length} Meta lead${this._fuUnenrolled.length === 1 ? '' : 's'} not in the sequence yet.</div>
          <button class="btn btn-sm btn-green" onclick="Tasks.fuEnrollAll(this)">Start sequence</button></div>` : ''}
      </div>`);
    }
    if (!total) {
      out.push(`<div class="v2-card"><div class="empty-state"><div class="empty-icon">✓</div>
        <div class="empty-text">You’re all caught up</div>
        <div class="list-sub" style="margin-top:2px;">New win-backs, service reminders, and uncontacted leads will show up here.</div></div></div>`);
      return out.join('');
    }
    const SECTIONS = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming'], ['snoozed', 'Snoozed']];
    SECTIONS.forEach(([key, label]) => {
      const arr = groups[key]; if (!arr.length) return;
      out.push(`<div class="grouphd" style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin:18px 0 8px;">${label} · ${arr.length}</div>`);
      out.push('<div class="v2-card">' + arr.map(t => this._card(t)).join('') + '</div>');
    });
    out.push(this._selBarHtml());
    return out.join('');
  };

  Tasks._card = function (t) {
    // 30-day sequence rows: the step is the task — one green button sends it.
    if (t.source === 'sequence') {
      const acts = [
        `<button class="btn btn-sm btn-green" onclick="Tasks.fuSend('${t.id}')">Send follow-up</button>`,
        t.phone ? `<button class="btn btn-sm" onclick="Tasks.call('${t.id}')">Call</button>` : '',
        `<button class="btn btn-sm" onclick="Tasks.fuMark('${t.id}','replied')">Replied</button>`,
        `<button class="btn btn-sm" onclick="Tasks.fuMark('${t.id}','skip')">Skip</button>`,
      ].filter(Boolean).join('');
      const open = this._selMode ? `Tasks.selToggle('${t.id}')` : `Tasks.fuOpen('${t.id}')`;
      return `<div class="list-row ${this._sel.has(t.id) ? 'on' : ''}" data-selrow="${t.id}" style="align-items:flex-start;">
        ${this._selCb(t)}
        <span onclick="${open}" style="cursor:pointer;">${avatarEl(t.name, 36)}</span>
        <div class="list-main">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer;" onclick="${open}">
            <span class="list-name">${esc(t.name)}</span>
            ${t.seq && t.seq.type
              ? `<span class="badge" style="background:#fff1e6;color:#c2410c;">${esc(t.seq.short)} · ${esc(t.step.label)}</span>`
              : `<span class="badge badge-yellow">${esc(t.step.label)}</span>`}
            <span style="font-size:11.5px;font-weight:700;color:${t.detail === 'Due today' ? 'var(--green-deep,var(--green))' : 'var(--red)'};">${esc(t.detail)}</span>
          </div>
          ${t.reason ? `<div class="list-sub">${esc(t.reason)}</div>` : ''}
          ${this._selMode ? '' : `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">${acts}</div>`}
        </div></div>`;
    }
    const SRC = {
      winback: ['badge-blue', 'Win-back'], service: ['badge-green', 'Service due'],
      lead: ['badge-yellow', 'New lead'], reminder: ['badge-green', 'Reminder'],
    }[t.source];
    const acts = [`<button class="btn btn-sm btn-green" onclick="Tasks.text('${t.id}')">Text</button>`];
    if (t.phone) acts.push(`<button class="btn btn-sm" onclick="Tasks.call('${t.id}')">Call</button>`);
    acts.push(`<button class="btn btn-sm" onclick="Tasks.done('${t.id}')">✓ Done</button>`);
    if (t.source !== 'lead' && t.source !== 'reminder') acts.push(`<button class="btn btn-sm" onclick="Tasks.snooze('${t.id}')">Snooze</button>`);
    acts.push(`<button class="btn btn-sm" style="color:var(--red);" onclick="Tasks.dismiss('${t.id}')">✕</button>`);
    return `<div class="list-row ${this._sel.has(t.id) ? 'on' : ''}" data-selrow="${t.id}" style="align-items:flex-start;cursor:${this._selMode ? 'pointer' : 'default'};"${this._selMode ? ` onclick="Tasks.selToggle('${t.id}')"` : ''}>
      ${this._selCb(t)}
      ${avatarEl(t.name, 36)}
      <div class="list-main">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span class="list-name">${esc(t.name)}</span><span class="badge ${SRC[0]}">${SRC[1]}</span></div>
        <div class="list-sub">${esc(t.reason)}${t.detail ? ' · ' + esc(t.detail) : ''}</div>
        ${t.notes ? `<div style="margin-top:5px;font-size:12px;color:var(--muted);background:var(--surface2);border-radius:7px;padding:6px 9px;white-space:pre-wrap;">📝 ${esc(t.notes)}</div>` : ''}
        ${this._selMode ? '' : `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">${acts.join('')}</div>`}
      </div></div>`;
  };
})();

/* ── Estimates (Quotes) ── */
(function () {
  Quotes.render = async function () {
    const el = document.getElementById('page-quotes'); if (!el) return;
    el.classList.add('v2-wide');
    try {
      [this._data, this._services] = await Promise.all([db.quotes.all(), db.services.all()]);
      const open = this._data.filter(q => q.status === 'sent');
      const won = this._data.filter(q => ['approved', 'scheduled', 'completed'].includes(q.status));
      const decided = won.length + this._data.filter(q => ['declined', 'lost'].includes(q.status)).length;
      const rate = decided ? Math.round(won.length / decided * 100) : null;
      // A fleet contract is worth its whole term, not one visit — counting these
      // pots at q.total would undersell a $90k contract as a $3,480 job.
      const val = (q) => Number(q.contractValue) || Number(q.total) || 0;
      const contracted = (list) => list.some(q => q.contract);

      const html = [];
      html.push(`<div class="v2-pagehd"><div><h1>Estimates</h1>
        <div class="sub">Line-item quotes customers approve (and pay a deposit on) from their phone</div></div>
        <div class="sp"></div>${canWrite() ? `<button class="btn btn-green" onclick="Quotes.openForm(null)">＋ New estimate</button>` : ''}</div>`);

      html.push(`<div class="v2-mgrid" style="grid-template-columns:repeat(3,1fr);">
        <div class="metric-card"><div class="metric-label">Awaiting response</div><div class="metric-value">${fmtMoney(open.reduce((s, q) => s + val(q), 0))}</div><div class="metric-sub">${open.length} estimate${open.length !== 1 ? 's' : ''} out${contracted(open) ? ' · contracts at full term' : ''}</div></div>
        <div class="metric-card"><div class="metric-label">Won value</div><div class="metric-value green">${fmtMoney(won.reduce((s, q) => s + val(q), 0))}</div><div class="metric-sub">${won.length} approved, scheduled or completed</div></div>
        <div class="metric-card"><div class="metric-label">Acceptance rate</div><div class="metric-value">${rate != null ? rate + '%' : '—'}</div><div class="metric-sub">of decided estimates</div></div></div>`);

      const tabs = [['open', 'Open'], ['sent', 'Sent'], ['approved', 'Approved'], ['scheduled', 'Scheduled'], ['completed', 'Completed'], ['lost', 'Lost'], ['', 'All']];
      html.push(`<div class="v2-chips" style="margin-bottom:12px;">${tabs.map(([v, lb]) =>
        `<button class="v2-chip${this._filter === v ? ' on' : ''}" onclick="Quotes._filter='${v}';Quotes.render()">${lb}</button>`).join('')}</div>`);

      const filtered = this._data.filter(q => this._matches(q, this._filter));
      if (!filtered.length) {
        html.push(`<div class="v2-card"><div class="empty-state"><div class="empty-icon">📄</div>
          <div class="empty-text">No ${this._filter === 'open' && this._data.length ? 'open ' : ''}estimates${this._data.length ? ' here' : ' yet'}</div>
          ${!this._data.length && canWrite() ? '<div class="list-sub" style="margin-top:2px;">Create one to quote a ceramic, PPF, or correction job.</div>' : ''}</div></div>`);
      } else {
        html.push(`<div class="v2-card v2-tablewrap"><table class="v2-table">
          <thead><tr><th>Estimate</th><th>Customer</th><th>Vehicle</th><th class="r">Items</th><th class="r">Total</th><th>Status</th><th></th></tr></thead><tbody>`);
        // Row-level follow-up actions: dial the customer / open their lead
        // profile without opening the estimate first — the "work the Sent
        // tab" loop for estimates that are out.
        const rowBtn = 'display:inline-block;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:3px 8px;cursor:pointer;font-size:14px;line-height:1.3;text-decoration:none;color:inherit;font-family:inherit;';
        filtered.forEach(q => {
          // Fleet rows swap the single vehicle for the fleet + its terms, and
          // show the recurring value with the per-visit price under it.
          const fleet = this._isFleet(q);
          const veh = fleet
            ? esc([q.fleetName || 'Fleet', q.vehicleCount ? q.vehicleCount + ' vehicles' : '', q.contract ? `${this._freqLabel(q.contract.frequency)} · ${q.contract.termMonths} mo` : 'One-time'].filter(Boolean).join(' · '))
            : (q.vehicle && q.vehicle.make ? [q.vehicle.year, q.vehicle.make, q.vehicle.model].filter(Boolean).map(esc).join(' ') : '—');
          const money = q.contract
            ? `<b>${fmtMoney(q.contractValue)}</b><div class="list-sub">${fmtMoney(q.monthlyTotal)}/mo · ${fmtMoney(q.total)}/visit</div>`
            : `<b>${fmtMoney(q.total)}</b>`;
          html.push(`<tr onclick="Quotes.openDetail('${q.id}')">
            <td style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);">${esc(q.number || '—')}</td>
            <td><b>${esc(q.customerName || '—')}</b>${fleet ? ' <span class="badge badge-blue">🚚 Fleet</span>' : ''}</td>
            <td style="color:var(--muted);">${veh}</td>
            <td class="r">${(q.lineItems || []).length}</td>
            <td class="r">${money}</td>
            <td>${this._badge(q.status)}</td>
            <td class="r" style="white-space:nowrap;" onclick="event.stopPropagation()">${q.customerPhone ? `<a href="tel:${esc(String(q.customerPhone).replace(/[^\d+]/g, ''))}" style="${rowBtn}" title="Call ${esc(q.customerPhone)}" onclick="Quotes._logCall('${q.id}')">📞</a> ` : ''}${(q.customerId || q.customerPhone) ? `<button style="${rowBtn}" title="Open lead profile" onclick="Quotes.openLead('${q.id}')">👤</button>` : ''}</td></tr>`);
        });
        html.push('</tbody></table></div>');
      }
      el.innerHTML = html.join('');
    } catch (e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load estimates</p></div>'; }
  };
})();

/* ── Revenue ── */
(function () {
  Revenue.render = async function () {
    const el = document.getElementById('page-revenue'); if (!el) return;
    el.classList.add('v2-wide');
    try {
      const [data, expenses, leads] = await Promise.all([db.revenue.get(), db.expenses.all().catch(() => []), db.leads.all().catch(() => [])]);
      if (data.expenseCategories?.length) this._categories = data.expenseCategories;
      const netColor = data.monthNetProfit >= 0 ? 'var(--green-deep)' : 'var(--red)';
      const html = [];

      html.push(`<div class="v2-pagehd"><div><h1>Revenue</h1><div class="sub">Money in, money out, and what’s actually profit</div></div>
        <div class="sp"></div><button class="btn btn-green" onclick="Revenue.addExpense()">＋ Add expense</button></div>`);

      html.push(`<div class="v2-mgrid" style="grid-template-columns:repeat(4,1fr);">
        <div class="metric-card"><div class="metric-label">Revenue this month</div><div class="metric-value green">${fmtMoney(data.monthRevenue)}</div><div class="metric-sub">${data.monthJobs} appointments</div></div>
        <div class="metric-card"><div class="metric-label">Net profit</div><div class="metric-value" style="color:${netColor};">${fmtMoney(data.monthNetProfit)}</div><div class="metric-sub">${data.monthNetMarginPct}% margin · after ${fmtMoney(data.monthOpEx)} expenses</div></div>
        <div class="metric-card"><div class="metric-label">Avg ticket</div><div class="metric-value">${fmtMoney(data.avgTicket)}</div><div class="metric-sub">this month</div></div>
        <div class="metric-card"><div class="metric-label">All time</div><div class="metric-value">${fmtMoney(data.totalRevenue)}</div><div class="metric-sub">${fmtMoney(data.totalNetProfit)} net profit</div></div></div>`);

      // Weekly tracker: this week against goal + last week, day by day, and the
      // 12-week run. Data comes from /revenue (weekly) — see weeklyRevenue().
      if (data.weekly) html.push(this.weeklyCard(data.weekly));

      // Lead conversion by channel (phone vs Meta) — moved here from the Leads
      // page: it's the ad-spend ROI read, so it belongs with the money numbers.
      // The builder still lives in leads2.js next to the source definitions.
      if (typeof Leads !== 'undefined' && typeof Leads.channelMetrics === 'function') {
        html.push(Leads.channelMetrics(leads));
      }

      const line = (label, val, opts = {}) => {
        const amt = opts.neg ? `−${fmtMoney(Math.abs(val))}` : (val < 0 ? `−${fmtMoney(Math.abs(val))}` : fmtMoney(val));
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;${opts.rule ? 'border-top:1px solid var(--border);margin-top:2px;padding-top:10px;' : ''}">
          <span style="font-size:12.5px;${opts.strong ? 'font-weight:700;' : ''}${opts.color ? 'color:' + opts.color + ';' : 'color:var(--muted);'}">${esc(label)}${opts.pct != null ? `<span style="font-size:11px;color:var(--faint);font-weight:600;margin-left:6px;">${opts.pct}% margin</span>` : ''}</span>
          <span class="num" style="font-size:13px;font-variant-numeric:tabular-nums;${opts.strong ? 'font-weight:700;' : ''}${opts.color ? 'color:' + opts.color + ';' : ''}">${amt}</span></div>`;
      };

      // AI Receptionist: revenue recovered + conversion funnel. Full-width card
      // above the P&L grid; only shown once the AI has answered a call or produced
      // revenue/pipeline, so non-users don't see an empty section.
      const ai = data.aiReceptionist || {};
      const rec = data.aiRecoveredTotal || 0, pipe = data.aiPipelineOpen || 0;
      if ((ai.answered || 0) > 0 || rec > 0 || pipe > 0) {
        const answered = ai.answered || 0, engaged = ai.engaged || 0, quoted = ai.quoted || 0, booked = ai.booked || 0;
        const pctOf = (n, d) => d > 0 ? Math.round(n / d * 100) : 0;
        // Label + count on top, full-width bar below — stays readable at any width
        // (a single inline row squished the bar to nothing on phones).
        const frow = (label, count, sub) => `<div style="margin-bottom:9px;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
            <span style="color:var(--muted);">${label}</span>
            <span class="num" style="font-weight:650;font-variant-numeric:tabular-nums;">${count}${sub ? ` <span style="color:var(--faint);font-weight:500;">${sub}</span>` : ''}</span></div>
          <div class="bar-bg"><div class="bar-fill" style="width:${pctOf(count, answered)}%;background:var(--green);"></div></div></div>`;
        const stat = (label, value, sub, green) => `<div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;font-weight:600;">${label}</div>
          <div style="font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;${green ? 'color:var(--green-deep);' : ''}">${value}</div>
          <div style="font-size:11.5px;color:var(--faint);">${sub}</div></div>`;
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">🤖 AI Receptionist</div><span class="sub">revenue recovered &amp; call conversion</span></div>
          <div style="padding:14px 16px;">
            <div style="display:flex;gap:32px;flex-wrap:wrap;margin-bottom:14px;">
              ${stat('Revenue recovered', fmtMoney(rec), `${data.aiRecoveredJobs || 0} job${data.aiRecoveredJobs === 1 ? '' : 's'} · ${fmtMoney(data.aiRecoveredMonth || 0)} this month`, true)}
              ${stat('In pipeline', fmtMoney(pipe), `${data.aiPipelineCount || 0} open quote${data.aiPipelineCount === 1 ? '' : 's'}`, false)}
            </div>
            ${frow('Calls answered', answered, '')}
            ${frow('Talked to the assistant', engaged, answered ? `· ${pctOf(engaged, answered)}%` : '')}
            ${frow('Quotes given', quoted, engaged ? `· ${pctOf(quoted, engaged)}% of talkers` : '')}
            ${frow('Booked', booked, engaged ? `· ${pctOf(booked, engaged)}% of talkers` : '')}
            <div style="font-size:11px;color:var(--faint);margin-top:9px;">Recovered = money from AI-driven jobs that closed. Pipeline = quoted leads not yet won.${ai.quotedTotal ? ` ${fmtMoney(ai.quotedTotal)} quoted in total.` : ''}</div>
          </div></div>`);
      }

      // Monthly history: any closed month, readable here and exportable as CSV.
      // Picker lists every month with completed jobs (except the current one,
      // which the cards above already cover) and always offers last month.
      {
        const cur = new Date().toISOString().slice(0, 7);
        const lastM = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
        const months = Array.from(new Set([lastM, ...(data.netByMonth || []).map(m => m.month)])).filter(m => m && m < cur).sort().reverse();
        if (!this._histMonth || !months.includes(this._histMonth)) this._histMonth = months[0] || lastM;
        const label = m => new Date(m + '-15T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        html.push(`<div class="v2-card" id="rev-hist"><div class="v2-chd"><div class="t">Monthly history</div><span class="sub">any past month, exportable</span>
            <div class="sp"></div>
            <select class="form-input" id="rev-hist-month" style="width:auto;padding:5px 28px 5px 10px;font-size:12.5px;" onchange="Revenue.loadMonth(this.value)">
              ${months.map(m => `<option value="${m}" ${m === this._histMonth ? 'selected' : ''}>${label(m)}</option>`).join('')}</select>
            <button class="act" onclick="Revenue.exportMonth()" title="Download this month as a CSV">⬇ Export CSV</button></div>
          <div id="rev-hist-body" style="padding:12px 16px 14px;font-size:12.5px;color:var(--muted);">Loading…</div></div>`);
      }

      html.push('<div class="v2-dgrid"><div class="v2-col">');
      html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Profit &amp; loss</div><span class="sub">this month</span></div><div style="padding:6px 16px 10px;">
        ${line('Revenue', data.monthRevenue, { strong: true, color: 'var(--text)' })}
        ${line('Materials (cost of goods)', data.monthCost, { neg: true })}
        ${line('Gross profit', data.monthGrossProfit, { strong: true, rule: true, color: 'var(--text)', pct: data.monthGrossMarginPct })}
        ${line('Operating expenses', data.monthOpEx, { neg: true })}
        ${line('Net profit', data.monthNetProfit, { strong: true, rule: true, color: netColor, pct: data.monthNetMarginPct })}</div></div>`);

      if (data.netByMonth?.length) {
        const recent = data.netByMonth.slice(-6);
        const maxN = Math.max(...recent.map(m => Math.abs(m.net)), 1);
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Net profit trend</div><span class="sub">last ${recent.length} months</span></div><div style="padding:10px 16px 12px;">`);
        recent.forEach(m => {
          const pct = Math.round((Math.abs(m.net) / maxN) * 100);
          const label = new Date(m.month + '-15').toLocaleDateString('en-US', { month: 'short' });
          const pos = m.net >= 0;
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
            <span style="font-size:12px;color:var(--muted);width:34px;">${label}</span>
            <div class="bar-bg" style="flex:1;"><div class="bar-fill" style="width:${pct}%;background:${pos ? 'var(--green)' : 'var(--red)'};"></div></div>
            <span class="num" style="font-size:12px;font-weight:650;width:76px;text-align:right;color:${pos ? 'var(--green-deep)' : 'var(--red)'};font-variant-numeric:tabular-nums;">${fmtMoney(m.net)}</span></div>`);
        });
        html.push('</div></div>');
      }

      const svc = (data.byService || []).filter(s => s.revenue > 0);
      if (svc.length) {
        const maxS = Math.max(...svc.map(s => s.margin), 1);
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Profit by service</div><span class="sub">all time</span></div><div style="padding:10px 16px 12px;">`);
        svc.slice(0, 8).forEach(s => {
          const pct = Math.round((Math.max(s.margin, 0) / maxS) * 100);
          const mpct = s.revenue ? Math.round(s.margin / s.revenue * 100) : 0;
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
            <span style="font-size:12px;color:var(--muted);width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.service)} <span style="color:var(--faint);font-size:10.5px;">×${s.count}</span></span>
            <div class="bar-bg" style="flex:1;"><div class="bar-fill" style="width:${pct}%;background:var(--green);"></div></div>
            <span class="num" style="font-size:12px;font-weight:650;width:100px;text-align:right;font-variant-numeric:tabular-nums;">${fmtMoney(s.margin)} <span style="color:var(--faint);font-weight:500;">${mpct}%</span></span></div>`);
        });
        html.push('</div></div>');
      }

      // Bookings by lead source, month to date: which channel each appointment
      // on the calendar this month came from (phone call, Meta ads, website…),
      // done or not. Strictly MTD — past months live in Monthly history below.
      const bsrc = (data.bookedBySource || []).filter(x => x.month > 0);
      const mtdTotal = bsrc.reduce((s, x) => s + x.month, 0);
      const maxB = Math.max(...bsrc.map(x => x.month), 1);
      html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Bookings by lead source</div><span class="sub">month to date · ${mtdTotal} booked</span></div><div style="padding:10px 16px 12px;">`);
      if (!bsrc.length) {
        html.push(`<div style="font-size:12px;color:var(--muted);">Nothing booked yet this month. Each appointment that lands on the calendar gets credited to the lead that first brought the customer in.</div>`);
      } else {
        bsrc.forEach(x => {
          const pct = Math.round(x.month / maxB * 100), share = Math.round(x.month / mtdTotal * 100);
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
            <span style="font-size:12px;color:var(--muted);width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(x.label)}</span>
            <div class="bar-bg" style="flex:1;"><div class="bar-fill" style="width:${pct}%;background:var(--green);"></div></div>
            <span class="num" style="font-size:12px;font-weight:650;width:140px;text-align:right;font-variant-numeric:tabular-nums;">${x.month} <span style="color:var(--faint);font-weight:500;">· ${share}% · ${fmtMoney(x.monthValue)}</span></span></div>`);
        });
        html.push(`<div style="font-size:11px;color:var(--faint);margin-top:8px;">Appointments dated this month, done or not (cancelled and no-shows excluded), credited to the lead that first brought the customer in.</div>`);
      }
      html.push('</div></div>');

      // Booked by: sales attribution — who ENTERED each job (from the login that
      // created it), vs. "Revenue by barber" below which is who PERFORMS the work.
      // Booked = money they put on the calendar this month; Closed = their jobs
      // marked done this month.
      if (data.byCreator?.length) {
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Booked by</div><span class="sub">who brought it in · this month</span></div><div style="padding:10px 16px 12px;">
          <div style="display:flex;gap:10px;padding:0 0 6px;font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.04em;font-weight:600;">
            <span style="flex:1;">Person</span><span style="width:104px;text-align:right;">Booked</span><span style="width:104px;text-align:right;">Closed</span></div>`);
        data.byCreator.forEach(p => {
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:5px 0;">
            <span style="font-size:12.5px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.name)}</span>
            <span class="num" style="width:104px;text-align:right;font-size:12.5px;font-weight:650;font-variant-numeric:tabular-nums;">${fmtMoney(p.bookedMonth)} <span style="color:var(--faint);font-weight:500;font-size:10.5px;">×${p.bookedMonthJobs}</span></span>
            <span class="num" style="width:104px;text-align:right;font-size:12.5px;font-weight:650;color:var(--green-deep);font-variant-numeric:tabular-nums;">${fmtMoney(p.closedMonth)} <span style="color:var(--faint);font-weight:500;font-size:10.5px;">×${p.closedMonthJobs}</span></span></div>`);
        });
        html.push(`<div style="font-size:11px;color:var(--faint);margin-top:8px;">Booked = jobs this person entered this month (any status). Closed = their jobs completed this month. Older appointments (before attribution existed) aren’t counted.</div></div></div>`);
      }

      if (data.byBarber?.length > 1) {
        const maxRev = Math.max(...data.byBarber.map(b => b.revenue), 1);
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Revenue by ${esc(V('staffPlural', 'Barber').toLowerCase())}</div></div><div style="padding:10px 16px 12px;">`);
        data.byBarber.forEach(b => {
          const pct = Math.round((b.revenue / maxRev) * 100);
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
            <span style="font-size:12px;color:var(--muted);width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(b.name)}</span>
            <div class="bar-bg" style="flex:1;"><div class="bar-fill" style="width:${pct}%;background:${b.color || 'var(--green)'};"></div></div>
            <span class="num" style="font-size:12px;font-weight:650;width:110px;text-align:right;font-variant-numeric:tabular-nums;">${fmtMoney(b.revenue)} <span style="color:var(--faint);font-weight:500;">×${b.count}</span></span></div>`);
        });
        html.push('</div></div>');
      }

      html.push('</div><div class="v2-col">');

      html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Operating expenses</div><button class="act" onclick="Revenue.addExpense()">＋ Add →</button></div>`);
      if (!expenses.length) {
        html.push(`<div style="padding:12px 16px;font-size:12px;color:var(--muted);">No expenses yet. Add rent, supplies, software, insurance, fuel, payroll — anything that comes out of profit.</div>`);
      } else {
        expenses.forEach(e => {
          const d = new Date((e.date || '') + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          html.push(`<div class="list-row" onclick="Revenue.addExpense('${e.id}')">
            <div class="list-main"><div class="list-name" style="font-weight:600;">${esc(e.category)}${e.recurring === 'monthly' ? ' <span class="badge badge-green">monthly</span>' : ''}</div>
            <div class="list-sub">${esc(e.description || '')}${e.description ? ' · ' : ''}${d}</div></div>
            <b class="num" style="font-variant-numeric:tabular-nums;">${fmtMoney(e.amount)}${e.recurring === 'monthly' ? '<span style="font-size:11px;color:var(--muted);font-weight:500;">/mo</span>' : ''}</b>
            <button onclick="event.stopPropagation();Revenue.deleteExpense('${e.id}')" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:0 2px;" aria-label="Delete expense">×</button></div>`);
        });
      }
      html.push('</div>');

      if (data.byCategory?.length) {
        const maxC = Math.max(...data.byCategory.map(c => c.amount), 1);
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Expenses by category</div><span class="sub">this month</span></div><div style="padding:10px 16px 12px;">`);
        data.byCategory.forEach(c => {
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
            <span style="font-size:12px;color:var(--muted);width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.category)}</span>
            <div class="bar-bg" style="flex:1;"><div class="bar-fill" style="width:${Math.round(c.amount / maxC * 100)}%;background:var(--orange);"></div></div>
            <span class="num" style="font-size:12px;font-weight:650;width:70px;text-align:right;font-variant-numeric:tabular-nums;">${fmtMoney(c.amount)}</span></div>`);
        });
        html.push('</div></div>');
      }

      if (data.monthTaxCollected || data.totalTaxCollected) {
        html.push(`<div class="v2-card"><div class="list-row" style="cursor:default;"><div class="list-main"><div class="list-name">Sales tax collected</div>
          <div class="list-sub">Set this aside — it’s owed, not income.</div></div>
          <div style="text-align:right;"><b class="num">${fmtMoney(data.monthTaxCollected)}</b><div style="font-size:11px;color:var(--faint);">${fmtMoney(data.totalTaxCollected)} all time</div></div></div></div>`);
      }
      if (data.monthDeposits || data.totalDeposits) {
        // Booking deposits + estimate deposits (Approve & pay) both land here;
        // the sub line names the estimate share when there is one.
        const ds = data.depositSplit || {};
        const depSub = ds.estimateTotal ? `Prepaid · ${fmtMoney(ds.estimateMonth || 0)} this month from ${ds.estimateCount} approved estimate${ds.estimateCount === 1 ? '' : 's'}` : 'Prepaid — applied to the balance at checkout.';
        html.push(`<div class="v2-card"><div class="list-row" style="cursor:default;"><div class="list-main"><div class="list-name">Deposits collected</div>
          <div class="list-sub">${depSub}</div></div>
          <div style="text-align:right;"><b class="num" style="color:var(--green-deep);">${fmtMoney(data.monthDeposits)}</b><div style="font-size:11px;color:var(--faint);">${fmtMoney(data.totalDeposits)} all time</div></div></div></div>`);
      }
      // Quotes given: every dollar put in front of a customer — formal
      // estimates plus phone quotes logged on leads — with how much of it won.
      // Same compact row as deposits/tax; always shown so the number exists
      // for a shop before its first quote.
      {
        const qg = data.quotesGiven || {}, qm = qg.month || {}, qt = qg.total || {};
        const n = (c, one, many) => `${c || 0} ${c === 1 ? one : many}`;
        const mix = [qt.estimates ? n(qt.estimates, 'estimate', 'estimates') : '', qt.phone ? n(qt.phone, 'phone quote', 'phone quotes') : ''].filter(Boolean).join(' + ');
        const sub = qt.count
          ? `${n(qm.count, 'quote', 'quotes')} this month · ${mix} · ${fmtMoney(qt.wonValue || 0)} won${qt.winRate != null ? ` (${qt.winRate}%)` : ''}`
          : 'Estimates you send + “Quoted amount” logged on leads.';
        html.push(`<div class="v2-card"><div class="list-row" style="cursor:default;"><div class="list-main" style="min-width:0;"><div class="list-name">Quotes given</div>
          <div class="list-sub">${sub}</div></div>
          <div style="text-align:right;flex-shrink:0;white-space:nowrap;"><b class="num">${fmtMoney(qm.value || 0)}</b><div style="font-size:11px;color:var(--faint);">${fmtMoney(qt.value || 0)} all time</div></div></div></div>`);
      }
      html.push('</div></div>');
      el.innerHTML = html.join('');
      this.loadMonth();
    } catch (e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load revenue</p></div>'; }
  };

  // ── Weekly tracker ─────────────────────────────────────────────────────────
  Revenue._weekly = null;
  Revenue.weeklyCard = function (w) {
    this._weekly = w;
    const tw = w.thisWeek, lw = w.lastWeek;
    const d = (s, opts) => new Date(s + 'T00:00:00').toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric' });
    const range = `${d(tw.start)} – ${d(tw.end)}`;
    const money = v => fmtMoney(Math.round(Number(v) || 0));
    const goal = tw.goal || 0;
    const donePct = goal ? Math.min(100, tw.revenue / goal * 100) : 0;
    const bookedPct = goal ? Math.min(100 - donePct, tw.booked / goal * 100) : 0;
    const toGo = Math.max(0, goal - tw.revenue);
    const vs = tw.vsLastWeekPct == null ? (lw ? 'no revenue last week' : 'first week on record')
      : `<span style="color:${tw.vsLastWeekPct >= 0 ? 'var(--green-deep)' : 'var(--red)'};font-weight:650;">${tw.vsLastWeekPct >= 0 ? '▲' : '▼'} ${Math.abs(tw.vsLastWeekPct)}%</span> vs last week (${money(lw.revenue)})`;
    const stat = (label, value, sub, color) => `<div style="min-width:120px;"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;font-weight:600;">${label}</div>
      <div class="num" style="font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;${color ? 'color:' + color + ';' : ''}">${value}</div><div style="font-size:11px;color:var(--faint);">${sub}</div></div>`;
    const h = [];
    h.push(`<div class="v2-card" id="rev-weekly"><div class="v2-chd"><div class="t">Weekly tracker</div><span class="sub">${range} · Mon–Sun</span>
      <div class="sp"></div>
      <button class="act" onclick="Revenue.setWeeklyGoal()" title="Set a weekly revenue goal">🎯 ${goal ? 'Goal ' + money(goal) : 'Set goal'}</button>
      <button class="act" style="margin-left:14px;" onclick="Revenue.exportWeeks()" title="Download the last ${w.weeks.length} weeks as a CSV">⬇ Export CSV</button></div>
      <div style="padding:14px 16px;">`);
    h.push(`<div style="display:flex;gap:28px;flex-wrap:wrap;margin-bottom:12px;">
      ${stat('This week', money(tw.revenue), `${tw.jobs} job${tw.jobs === 1 ? '' : 's'} · ${vs}`, 'var(--green-deep)')}
      ${stat('On the books', money(tw.booked), `${tw.bookedJobs} job${tw.bookedJobs === 1 ? '' : 's'} still scheduled · ${tw.daysLeft} day${tw.daysLeft === 1 ? '' : 's'} left`)}
      ${stat('Projected', money(tw.projected), 'done + still on the books')}
      ${stat('Avg week', money(w.avgWeek), w.bestWeek ? `best ${money(w.bestWeek.revenue)} (wk of ${d(w.bestWeek.start)})` : `last ${w.weeks.length} weeks`)}</div>`);
    if (goal) {
      h.push(`<div style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;"><span style="color:var(--muted);">Goal progress</span>
          <span class="num" style="font-weight:650;">${tw.goalPct}% of ${money(goal)}${toGo ? ` <span style="color:var(--faint);font-weight:500;">· ${money(toGo)} to go</span>` : ' <span style="color:var(--green-deep);">· hit 🎉</span>'}</span></div>
        <div class="bar-bg" style="height:10px;display:flex;"><div style="width:${donePct}%;background:var(--green);height:100%;"></div><div style="width:${bookedPct}%;background:var(--green);opacity:.35;height:100%;" title="On the books"></div></div>
        <div style="font-size:10.5px;color:var(--faint);margin-top:4px;">Solid = completed · faded = booked but not done yet${w.goalSource === 'monthly' ? ' · goal is your monthly goal ÷ 52 weeks × 12' : ''}</div></div>`);
    } else {
      h.push(`<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">No weekly goal yet — <a href="javascript:void 0" onclick="Revenue.setWeeklyGoal()" style="color:var(--green-deep);font-weight:600;">set one</a> to see how far along the week is.</div>`);
    }
    // Day-by-day for this week: completed (solid) stacked with booked (faded).
    const maxD = Math.max(...tw.byDay.map(x => x.revenue + x.booked), goal ? goal / 5 : 0, 1);
    h.push(`<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;align-items:end;height:96px;margin-bottom:4px;">`);
    tw.byDay.forEach((x, i) => {
      const isToday = x.date === w.today, past = x.date < w.today;
      const hd = Math.round(x.revenue / maxD * 84), hb = Math.round(x.booked / maxD * 84);
      h.push(`<div title="${d(x.date, { weekday: 'short', month: 'short', day: 'numeric' })}: ${money(x.revenue)} done${x.booked ? ' · ' + money(x.booked) + ' booked' : ''}" style="display:flex;flex-direction:column;justify-content:flex-end;height:100%;${isToday ? 'background:var(--green-lt);border-radius:6px;' : ''}">
        <div style="height:${hb}px;background:var(--green);opacity:.3;border-radius:4px 4px 0 0;"></div>
        <div style="height:${hd}px;background:var(--green);border-radius:${hb ? '0' : '4px 4px 0 0'};min-height:${x.revenue ? 2 : 0}px;"></div></div>`);
    });
    h.push(`</div><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:14px;">`);
    tw.byDay.forEach(x => {
      const isToday = x.date === w.today;
      h.push(`<div style="text-align:center;"><div style="font-size:11px;font-weight:${isToday ? 700 : 500};color:${isToday ? 'var(--green-deep)' : 'var(--muted)'};">${d(x.date, { weekday: 'short' })}</div>
        <div class="num" style="font-size:11px;font-variant-numeric:tabular-nums;color:${x.revenue ? 'var(--text)' : 'var(--faint)'};">${x.revenue ? money(x.revenue) : (x.booked ? `<span style="color:var(--faint);">${money(x.booked)}</span>` : '—')}</div></div>`);
    });
    h.push('</div>');
    // 12-week run, oldest first, goal tick when set.
    const maxW = Math.max(...w.weeks.map(x => x.revenue), goal, 1);
    h.push(`<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;font-weight:600;margin:4px 0 6px;">Last ${w.weeks.length} weeks</div>`);
    w.weeks.forEach(x => {
      const pct = Math.round(x.revenue / maxW * 100), isCur = x.start === tw.start, isBest = w.bestWeek && x.start === w.bestWeek.start && x.revenue > 0;
      h.push(`<div style="display:flex;align-items:center;gap:10px;padding:3px 0;">
        <span style="font-size:12px;color:${isCur ? 'var(--text)' : 'var(--muted)'};font-weight:${isCur ? 700 : 400};width:52px;white-space:nowrap;">${d(x.start)}</span>
        <div class="bar-bg" style="flex:1;position:relative;"><div class="bar-fill" style="width:${pct}%;background:var(--green);${isCur ? '' : 'opacity:.75;'}"></div>${goal ? `<div style="position:absolute;top:-2px;bottom:-2px;left:${Math.min(100, goal / maxW * 100)}%;width:2px;background:var(--text);opacity:.35;"></div>` : ''}</div>
        <span class="num" style="font-size:12px;font-weight:${isCur ? 700 : 600};width:118px;text-align:right;font-variant-numeric:tabular-nums;">${money(x.revenue)} <span style="color:var(--faint);font-weight:500;">×${x.jobs}${isBest ? ' ★' : ''}${isCur ? ' now' : ''}</span></span></div>`);
    });
    if (goal) h.push(`<div style="font-size:10.5px;color:var(--faint);margin-top:6px;">Tick mark = weekly goal. ★ = best week.</div>`);
    h.push('</div></div>');
    return h.join('');
  };
  Revenue.setWeeklyGoal = function () {
    const cur = (this._weekly && this._weekly.goalSource === 'weekly') ? this._weekly.thisWeek.goal : '';
    Modal.show(`<div class="modal-title">🎯 Weekly revenue goal</div>
      <div class="form-group"><label class="form-label">Goal for a Mon–Sun week ($)</label><input class="form-input" id="wg-amt" type="number" min="0" step="100" inputmode="numeric" value="${cur}" placeholder="e.g. 3500" onkeydown="if(event.key==='Enter')Revenue.saveWeeklyGoal()"></div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Leave blank to fall back to your monthly goal spread across the year${this._weekly && this._weekly.goalSource === 'monthly' ? ` (currently ${fmtMoney(this._weekly.thisWeek.goal)}/week)` : ''}.</div>
      <div class="modal-actions"><button id="wg-btn" class="btn btn-primary btn-full" onclick="Revenue.saveWeeklyGoal()">Save goal</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>`);
    setTimeout(() => document.getElementById('wg-amt')?.focus(), 50);
  };
  Revenue.saveWeeklyGoal = async function () {
    const n = parseFloat(document.getElementById('wg-amt')?.value);
    const btn = document.getElementById('wg-btn'); disableBtn(btn);
    try { await db.settings.save({ weeklyRevenueGoal: (!isNaN(n) && n > 0) ? Math.round(n) : 0 }); Modal.close(); toast(n > 0 ? 'Weekly goal set ✓' : 'Weekly goal cleared'); this.render(); }
    catch (e) { toast('Could not save goal', 'error'); enableBtn(btn); }
  };
  Revenue.exportWeeks = function () {
    const w = this._weekly; if (!w) return;
    const q = v => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const row = (...c) => c.map(q).join(',');
    const L = [row('Shop', Auth.getShopName() || ''), row('Weeks (Mon–Sun)', w.weeks.length), row('Weekly goal', w.thisWeek.goal || ''), ''];
    L.push(row('WEEKS'), row('Week starting', 'Week ending', 'Revenue', 'Jobs', 'Avg ticket', 'Materials', 'Gross profit'));
    w.weeks.forEach(x => L.push(row(x.start, x.end, x.revenue, x.jobs, x.avgTicket, x.cost, x.gross)));
    L.push('', row('THIS WEEK BY DAY'), row('Date', 'Completed revenue', 'Completed jobs', 'Booked revenue', 'Booked jobs'));
    w.thisWeek.byDay.forEach(x => L.push(row(x.date, x.revenue, x.jobs, x.booked, x.bookedJobs)));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + L.join('\n')], { type: 'text/csv' }));
    a.download = 'revenue-weekly-' + w.thisWeek.start + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Exported ' + w.weeks.length + ' weeks ✓');
  };

  // ── Monthly history (past-month breakdown + CSV export) ──────────────────
  Revenue._histMonth = null;
  Revenue._hist = null;
  Revenue.loadMonth = async function (ym) {
    if (ym) this._histMonth = ym;
    const body = document.getElementById('rev-hist-body'); if (!body) return;
    body.innerHTML = '<span style="color:var(--muted);">Loading…</span>';
    let r;
    try { r = await db.revenue.month(this._histMonth); } catch (e) { body.innerHTML = `<span style="color:var(--red);">${esc(e.message || 'Could not load that month')}</span>`; return; }
    if (!r || !r.ok) { body.innerHTML = '<span style="color:var(--red);">Could not load that month</span>'; return; }
    this._hist = r;
    const s = r.summary, p = r.prev || {};
    const mom = (cur, prev) => prev ? `${cur >= prev ? '▲' : '▼'} ${Math.abs(Math.round((cur - prev) / prev * 100))}% vs prior month` : 'no prior-month data';
    const netColor = s.net >= 0 ? 'var(--green-deep)' : 'var(--red)';
    const money = v => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v));
    const stat = (label, value, sub, color) => `<div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;font-weight:600;">${label}</div>
      <div class="num" style="font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;${color ? 'color:' + color + ';' : ''}">${value}</div><div style="font-size:11px;color:var(--faint);">${sub}</div></div>`;
    const th = (t, right) => `<th style="text-align:${right ? 'right' : 'left'};font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.04em;font-weight:600;padding:4px 6px;border-bottom:1px solid var(--border);white-space:nowrap;">${t}</th>`;
    const td = (t, right, extra) => `<td style="text-align:${right ? 'right' : 'left'};padding:5px 6px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;white-space:nowrap;${extra || ''}">${t}</td>`;
    const table = (head, rows) => `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    const sec = (title, sub) => `<div style="display:flex;justify-content:space-between;align-items:baseline;margin:16px 0 6px;"><span style="font-weight:700;font-size:13px;">${title}</span><span style="font-size:11px;color:var(--faint);">${sub || ''}</span></div>`;
    const pl = (label, val, opts = {}) => `<div style="display:flex;justify-content:space-between;padding:5px 0;${opts.rule ? 'border-top:1px solid var(--border);margin-top:2px;padding-top:8px;' : ''}">
      <span style="${opts.strong ? 'font-weight:700;color:var(--text);' : 'color:var(--muted);'}">${label}</span><span class="num" style="font-variant-numeric:tabular-nums;${opts.strong ? 'font-weight:700;' : ''}${opts.color ? 'color:' + opts.color + ';' : ''}">${opts.neg ? '−' + fmtMoney(val) : money(val)}</span></div>`;
    const dfmt = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const html = [];
    html.push(`<div style="display:flex;gap:28px;flex-wrap:wrap;margin-bottom:6px;">
      ${stat('Revenue', fmtMoney(s.revenue), `${s.jobs} job${s.jobs === 1 ? '' : 's'} · ${mom(s.revenue, p.revenue)}`, 'var(--green-deep)')}
      ${stat('Net profit', money(s.net), `${s.netMarginPct}% margin · ${mom(s.net, p.net)}`, netColor)}
      ${stat('Avg ticket', fmtMoney(s.avgTicket), 'per completed job')}
      ${s.quotes ? stat('Quotes given', fmtMoney(s.quotes.value || 0), `${s.quotes.count || 0} quote${s.quotes.count === 1 ? '' : 's'} · ${mom(s.quotes.value || 0, (p.quotes || {}).value)}${s.quotes.won ? ` · ${fmtMoney(s.quotes.wonValue)} won` : ''}`) : ''}
      ${s.deposits ? stat('Deposits', fmtMoney(s.deposits), 'collected this month') : ''}
      ${s.tax ? stat('Sales tax', fmtMoney(s.tax), 'collected — set aside') : ''}</div>`);
    html.push(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0 28px;">`);
    html.push(`<div>${sec('Profit & loss')}${pl('Revenue', s.revenue, { strong: true })}${pl('Materials (cost of goods)', s.cost, { neg: true })}${pl('Gross profit', s.gross, { strong: true, rule: true })}${pl('Operating expenses', s.opEx, { neg: true })}${pl('Net profit', s.net, { strong: true, rule: true, color: netColor })}</div>`);
    if (r.byService.length) html.push(`<div>${sec('By service')}${table(th('Service') + th('Jobs', 1) + th('Revenue', 1) + th('Margin', 1), r.byService.map(x => `<tr>${td(esc(x.service))}${td(x.count, 1)}${td(fmtMoney(x.revenue), 1)}${td(fmtMoney(x.margin), 1)}</tr>`).join(''))}</div>`);
    if ((r.bookedBySource || []).length) html.push(`<div>${sec('Bookings by lead source', `${r.bookedBySource.reduce((s, x) => s + x.count, 0)} booked · done or not`)}${table(th('Source') + th('Booked', 1) + th('Completed', 1) + th('Value', 1), r.bookedBySource.map(x => `<tr>${td(esc(x.label))}${td(x.count, 1)}${td(x.completed, 1)}${td(fmtMoney(x.value), 1)}</tr>`).join(''))}</div>`);
    if (r.byBarber.length > 1) html.push(`<div>${sec('By ' + esc(V('staffPlural', 'Staff').toLowerCase()))}${table(th('Name') + th('Jobs', 1) + th('Revenue', 1), r.byBarber.map(x => `<tr>${td(esc(x.name))}${td(x.count, 1)}${td(fmtMoney(x.revenue), 1)}</tr>`).join(''))}</div>`);
    // Always shown — it's the sales-attribution read owners look for, so an
    // empty month says so instead of the section silently disappearing.
    html.push(`<div>${sec('Booked by', 'entered · closed')}${r.byCreator.length ? table(th('Person') + th('Booked', 1) + th('Closed', 1), r.byCreator.map(x => `<tr>${td(esc(x.name))}${td(fmtMoney(x.booked) + ` <span style="color:var(--faint);font-size:10.5px;">×${x.bookedJobs}</span>`, 1)}${td(fmtMoney(x.closed) + ` <span style="color:var(--faint);font-size:10.5px;">×${x.closedJobs}</span>`, 1, 'color:var(--green-deep);font-weight:650;')}</tr>`).join('')) : '<div style="color:var(--muted);font-size:12.5px;">No attributed bookings that month — jobs entered before booked-by tracking existed aren’t counted.</div>'}</div>`);
    if (r.expenses.length) html.push(`<div>${sec('Operating expenses', fmtMoney(s.opEx))}${table(th('Category') + th('Detail') + th('Amount', 1), r.expenses.map(x => `<tr>${td(esc(x.category) + (x.recurring ? ' <span class="badge badge-green">monthly</span>' : ''))}${td(esc(x.description || dfmt(x.date)), 0, 'white-space:normal;')}${td(fmtMoney(x.amount), 1)}</tr>`).join(''))}</div>`);
    html.push('</div>');
    html.push(sec('Completed jobs', `${r.jobs.length} · ${fmtMoney(s.revenue)}`));
    html.push(r.jobs.length
      ? `<div style="max-height:360px;overflow:auto;">${table(th('Date') + th('Customer') + th('Service') + th(esc(V('staff', 'Staff'))) + th('Price', 1) + th('Cost', 1), r.jobs.map(j => `<tr>${td(dfmt(j.date))}${td(esc(j.customerName))}${td(esc(j.service))}${td(esc(j.staff))}${td(fmtMoney(j.price), 1)}${td(j.cost ? fmtMoney(j.cost) : '—', 1)}</tr>`).join(''))}</div>`
      : '<div style="color:var(--muted);">No completed jobs that month.</div>');
    html.push(`<div style="font-size:11px;color:var(--faint);margin-top:10px;">Same math as the cards above: completed jobs by appointment date; monthly expenses count every month from their start date. Export CSV downloads all of this, job by job, for your books.</div>`);
    body.innerHTML = html.join('');
  };

  Revenue.exportMonth = async function () {
    if (!this._hist || this._hist.summary.month !== this._histMonth) {
      try { this._hist = await db.revenue.month(this._histMonth); } catch (e) { toast(e.message || 'Could not export', 'error'); return; }
    }
    const r = this._hist, s = r.summary;
    const q = v => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const row = (...c) => c.map(q).join(',');
    const L = [];
    L.push(row('Shop', Auth.getShopName() || ''), row('Month', s.month), '');
    L.push(row('SUMMARY'), row('Revenue', s.revenue), row('Completed jobs', s.jobs), row('Average ticket', s.avgTicket), row('Materials (COGS)', s.cost), row('Gross profit', s.gross), row('Gross margin %', s.grossMarginPct),
           row('Operating expenses', s.opEx), row('Net profit', s.net), row('Net margin %', s.netMarginPct), row('Sales tax collected', s.tax), row('Deposits collected', s.deposits),
           row('Quotes given', (s.quotes || {}).count || 0), row('Quoted value', (s.quotes || {}).value || 0), row('Quotes won', (s.quotes || {}).won || 0), row('Quotes won value', (s.quotes || {}).wonValue || 0), row('Quote win rate %', (s.quotes || {}).winRate == null ? '' : s.quotes.winRate), '');
    L.push(row('BY SERVICE'), row('Service', 'Jobs', 'Revenue', 'Cost', 'Margin'));
    r.byService.forEach(x => L.push(row(x.service, x.count, x.revenue, x.cost, x.margin))); L.push('');
    if ((r.bookedBySource || []).length) { L.push(row('BOOKINGS BY LEAD SOURCE'), row('Source', 'Booked', 'Completed', 'Booked value')); r.bookedBySource.forEach(x => L.push(row(x.label, x.count, x.completed, x.value))); L.push(''); }
    if (r.byBarber.length) { L.push(row('BY STAFF'), row('Name', 'Jobs', 'Revenue', 'Cost', 'Margin')); r.byBarber.forEach(x => L.push(row(x.name, x.count, x.revenue, x.cost, x.margin))); L.push(''); }
    if (r.byCreator.length) { L.push(row('BOOKED BY'), row('Person', 'Booked $', 'Booked jobs', 'Closed $', 'Closed jobs')); r.byCreator.forEach(x => L.push(row(x.name, x.booked, x.bookedJobs, x.closed, x.closedJobs))); L.push(''); }
    L.push(row('OPERATING EXPENSES'), row('Date', 'Category', 'Description', 'Amount', 'Recurring'));
    r.expenses.forEach(x => L.push(row(x.date, x.category, x.description, x.amount, x.recurring ? 'monthly' : ''))); L.push('');
    if ((r.quotes || []).length) { L.push(row('QUOTES GIVEN'), row('Date', 'Estimate #', 'Customer', 'Service', 'Value', 'Status', 'Type')); r.quotes.forEach(x => L.push(row(x.date, x.number, x.customerName, x.service, x.value, x.status, x.kind === 'phone' ? 'phone quote' : 'estimate'))); L.push(''); }
    L.push(row('COMPLETED JOBS'), row('Date', 'Time', 'Customer', 'Service', 'Staff', 'Price', 'Cost', 'Tax', 'Source', 'Booked by'));
    r.jobs.forEach(j => L.push(row(j.date, j.time, j.customerName, j.service, j.staff, j.price, j.cost, j.tax, j.source, j.bookedBy)));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + L.join('\n')], { type: 'text/csv' }));
    a.download = 'revenue-' + s.month + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Exported ' + s.month + ' ✓');
  };
})();

/* ── Reviews ── */
(function () {
  Reviews.render = async function () {
    const el = document.getElementById('page-reviews'); if (!el) return;
    el.classList.add('v2-wide');
    try {
      const [data, appts] = await Promise.all([db.reviews.all(), db.appointments.all().catch(() => [])]);
      const reviews = data.reviews || [];
      const st = data.stats || { count: 0, avg: 0, dist: [0, 0, 0, 0, 0] };
      const link = location.origin + '/review/' + (Auth.getShopSlug() || '');
      // Text requests send the Google link when Settings has one — show that as
      // the link to copy, with the in-app rating page (which feeds the stars
      // below) as the secondary.
      const google = ((Shop.settings && Shop.settings.googleReviewLink) || '').trim();
      const primary = google || link;
      const html = [];

      html.push(`<div class="v2-pagehd"><div><h1>Reviews</h1><div class="sub">Collect ratings through your review link and feature the best on your booking page</div></div>
        <div class="sp"></div><button class="btn" onclick="navigator.clipboard.writeText('${esc(primary)}');toast('Review link copied ✓')">Copy review link</button></div>`);

      html.push(`<div class="v2-card"><div style="display:flex;gap:26px;align-items:center;padding:18px 20px;flex-wrap:wrap;">`);
      if (st.count) {
        html.push(`<div style="text-align:center;"><div class="num" style="font-size:34px;font-weight:800;letter-spacing:-.03em;line-height:1;">${st.avg.toFixed(1)}</div>
          <div style="color:#DD9A2B;font-size:15px;letter-spacing:2px;margin:5px 0 2px;">${Reviews._stars(Math.round(st.avg))}</div>
          <div style="font-size:11.5px;color:var(--faint);">${st.count} review${st.count !== 1 ? 's' : ''}</div></div>
          <div style="flex:1;min-width:220px;">`);
        for (let s = 5; s >= 1; s--) {
          const n = st.dist[s - 1] || 0, pct = st.count ? Math.round(n / st.count * 100) : 0;
          html.push(`<div style="display:flex;align-items:center;gap:8px;padding:2.5px 0;font-size:12px;">
            <span style="width:26px;color:var(--muted);">${s} ★</span>
            <div class="bar-bg" style="flex:1;"><div class="bar-fill" style="width:${pct}%;background:#DD9A2B;"></div></div>
            <span class="num" style="width:24px;text-align:right;color:var(--muted);">${n}</span></div>`);
        }
        html.push('</div>');
      } else {
        html.push(`<div style="flex:1;text-align:center;padding:8px 0;"><div style="font-size:28px;margin-bottom:6px;">⭐</div>
          <div style="font-weight:650;">No reviews yet</div><div style="font-size:12.5px;color:var(--muted);margin-top:2px;">Share your review link to start collecting feedback.</div></div>`);
      }
      html.push(`<div style="min-width:230px;flex:1;"><div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;">${google ? 'Your Google review link' : 'Your review link'}</div>
        <div style="display:flex;gap:6px;"><input class="form-input" readonly value="${esc(primary)}" style="flex:1;font-size:11.5px;height:32px;" onclick="this.select()" />
        <button class="btn btn-sm btn-green" style="height:32px;" onclick="navigator.clipboard.writeText('${esc(primary)}');toast('Link copied ✓')">Copy</button></div>
        <div style="font-size:11px;color:var(--faint);margin-top:5px;">${google ? 'This is what the text requests below send. In-app rating page: ' + esc(link) : 'Send after a visit — they rate you in seconds. Add a Google review link in Settings to send clients straight to Google.'}</div></div></div></div>`);

      const done = (appts || []).filter(a => a.status === 'done' && a.customerPhone && !a.reviewId)
        .sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6);
      this._recent = {}; done.forEach(a => { this._recent[a.id] = a; });
      if (done.length) {
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Ask recent clients</div><span class="sub">completed visits without a review yet</span></div>`);
        done.forEach(a => {
          const sent = !!a.reviewRequestedAt;
          html.push(`<div class="list-row" style="cursor:default;">${avatarEl(a.customerName || 'C', 32)}
            <div class="list-main"><div class="list-name">${esc(a.customerName || 'Client')}</div>
            <div class="list-sub">${esc(a.service || '')} · ${fmtDateShort(a.date)}</div></div>
            <button class="btn btn-sm ${sent ? '' : 'btn-green'}" onclick="Reviews.request('${a.id}',this)">${sent ? 'Sent ✓' : 'Text request'}</button></div>`);
        });
        html.push('</div>');
      }

      if (reviews.length) {
        html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">All reviews</div></div>`);
        reviews.forEach(r => {
          const date = fmtDateShort(r.createdAt ? r.createdAt.split('T')[0] : '');
          html.push(`<div class="list-row" style="align-items:flex-start;cursor:default;">
            <div class="list-main">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span style="color:#DD9A2B;font-size:13px;letter-spacing:1.5px;">${Reviews._stars(r.rating)}</span>
              ${r.featured ? '<span class="badge badge-green">★ Featured</span>' : ''}</div>
              ${r.comment ? `<div style="font-size:13px;margin-top:4px;line-height:1.5;">“${esc(r.comment)}”</div>` : ''}
              <div class="list-sub" style="margin-top:3px;">${esc(r.name || 'Anonymous')}${r.service ? ' · ' + esc(r.service) : ''}${date ? ' · ' + date : ''}</div>
              <div style="display:flex;gap:6px;margin-top:8px;">
                <button class="btn btn-sm" onclick="Reviews.feature('${r.id}')">${r.featured ? 'Unfeature' : 'Feature on booking page'}</button>
                <button class="btn btn-sm" style="color:var(--red);" onclick="Reviews.remove('${r.id}')">Delete</button></div>
            </div></div>`);
        });
        html.push('</div>');
      }
      el.innerHTML = html.join('');
    } catch (e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load reviews</p></div>'; }
  };
})();

/* ── Automations ── */
(function () {
  Automations.render = async function () {
    const el = document.getElementById('page-automations'); if (!el) return;
    el.classList.add('v2-wide');
    try { this._s = await db.settings.get(); } catch (e) { this._s = {}; }
    const s = this._s, a = s.automations || {};
    this._cfg = {
      reminder: { enabled: a.reminder ? a.reminder.enabled !== false : true },
      rebook: { enabled: a.rebook ? a.rebook.enabled !== false : true },
      review: { enabled: a.review ? !!a.review.enabled : false, days: (a.review && a.review.days) || 2 },
    };
    this._rebookInterval = Math.min(90, Math.max(7, s.rebookInterval || 21));
    const tpl = s.smsTemplates || {};
    const smsActive = !!(s.trackingNumber || s.twilioConfigured);
    const onCount = ['reminder', 'rebook', 'review'].filter(k => this._cfg[k].enabled).length + 1;

    const card = ({ icon, title, desc, msg, toggle, badge, extra }) => {
      const on = toggle ? this._cfg[toggle].enabled : true;
      const control = toggle
        ? `<button onclick="Automations.flip('${toggle}')" role="switch" aria-checked="${on}" style="border:none;cursor:pointer;border-radius:20px;padding:5px 13px;font-size:11.5px;font-weight:700;flex-shrink:0;margin-left:auto;${on ? 'background:var(--green-deep);color:#fff;' : 'background:var(--surface2);color:var(--muted);'}">${on ? 'On' : 'Off'}</button>`
        : `<span class="badge badge-gray" style="margin-left:auto;flex-shrink:0;">${badge || ''}</span>`;
      return `<div class="v2-card" style="margin-bottom:0;padding:15px 16px;${(!on && toggle) ? 'opacity:.6;' : ''}">
        <div style="display:flex;align-items:flex-start;gap:11px;">
          <div style="width:32px;height:32px;border-radius:8px;background:var(--green-lt);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">${icon}</div>
          <div style="min-width:0;"><div style="font-size:13px;font-weight:650;">${title}</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.45;margin-top:1px;">${desc}</div></div>${control}</div>
        ${msg ? `<div style="font-size:12px;color:var(--muted);background:var(--surface2);border-radius:7px;padding:8px 10px;font-style:italic;margin-top:10px;">“${esc(msg)}”</div>` : ''}
        ${extra || ''}</div>`;
    };

    const reviewWarn = (this._cfg.review.enabled && !s.googleReviewLink)
      ? `<div style="font-size:12px;color:var(--orange);background:#FBF1E2;border:1px solid #EBD3AC;border-radius:7px;padding:7px 10px;margin-top:8px;">⚠ Add your review link in <a href="#" onclick="App.nav('settings');return false;" style="color:var(--orange);font-weight:600;">Settings</a> for this to send.</div>` : '';

    el.innerHTML = `
      <div class="v2-pagehd"><div><h1>Automations</h1>
        <div class="sub">${onCount} campaign${onCount !== 1 ? 's' : ''} running — they work while you detail</div></div>
        <div class="sp"></div><button class="btn" onclick="App.nav('settings')">Edit message wording</button></div>
      <div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:10px;margin-bottom:16px;background:${smsActive ? 'var(--green-lt)' : 'var(--surface2)'};border:1px solid ${smsActive ? 'var(--green-md)' : 'var(--border)'};">
        <div style="width:9px;height:9px;border-radius:50%;background:${smsActive ? 'var(--green)' : 'var(--border-md)'};flex-shrink:0;"></div>
        <div style="font-size:12.5px;"><b>${smsActive ? 'SMS is active' : 'SMS not yet active'}</b>
        <span style="color:var(--muted);"> — ${smsActive ? 'enabled campaigns are running.' : 'contact ShopFlow support to activate SMS for your shop.'}</span></div></div>
      <div class="v2-agrid">
        ${card({ icon: '📩', title: 'Booking confirmation', badge: 'Always on', desc: 'Sent immediately when a client books online.', msg: tpl.confirmation })}
        ${card({ icon: '⏰', title: '24-hour reminder', toggle: 'reminder', desc: 'Sent the day before each confirmed appointment to cut no-shows.', msg: tpl.reminder })}
        ${card({
          icon: '🔁', title: 'Rebook nudge', toggle: 'rebook', desc: 'Win back clients who haven’t returned in a while.', msg: tpl.rebook,
          extra: `<div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--muted);">Send after
            <input type="number" min="7" max="90" value="${this._rebookInterval}" onchange="Automations.setInterval(this.value)" style="width:60px;padding:4px 8px;border:1px solid var(--border-md);border-radius:6px;font-size:12px;background:var(--surface);" /> days since last visit</div>` })}
        ${card({
          icon: '⭐', title: 'Review request', toggle: 'review', desc: 'Text your review link to clients a few days after their visit.',
          msg: tpl.review || "Hi {name}, thanks for visiting {shop}! We'd love your feedback — leave us a quick review: {link}",
          extra: `<div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--muted);">Send
            <input type="number" min="0" max="30" value="${this._cfg.review.days}" onchange="Automations.setReviewDays(this.value)" style="width:60px;padding:4px 8px;border:1px solid var(--border-md);border-radius:6px;font-size:12px;background:var(--surface);" /> days after the visit</div>${reviewWarn}` })}
      </div>`;
  };
})();

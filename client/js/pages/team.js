// ── Sales activity — what each person did with the leads ─────────────────────
// Owner's coaching view over the lead activity log: per person, for a local-
// date window — calls (answered / no answer), texts, emails, notes, leads
// worked / contacted, booked + booked rate, what's still open (and gone stale),
// appointments they put on the calendar, speed to first touch, and rule-based
// coaching callouts. Plus the raw feed of everything logged, exportable as CSV.
//
// Data: GET /api/shop/sales-activity (server/sales-activity.js rolls up the
// lead noteLog + stageLog + appointment createdBy, all stamped server-side
// from the auth token). Opening a row drops into the normal Leads modal.
const Team = {
  _preset: 'week',
  _from: null, _to: null,
  _person: 'all',
  _data: null,
  _feedShow: 40,

  PRESETS: [
    { key: 'today', label: 'Today' },
    { key: 'week',  label: 'This week' },
    { key: 'month', label: 'This month' },
    { key: '30d',   label: 'Last 30 days' },
    { key: '90d',   label: 'Last 90 days' },
    { key: 'custom', label: 'Custom' },
  ],
  KIND: {
    call:  { icon: '📞', label: 'Call' },
    text:  { icon: '💬', label: 'Text' },
    email: { icon: '✉️', label: 'Email' },
    note:  { icon: '📝', label: 'Note' },
    stage: { icon: '➜',  label: 'Stage' },
  },
  OUTCOME: { answered: 'Answered', no_answer: 'No answer', voicemail: 'Left voicemail' },

  async render() {
    const el = document.getElementById('page-team'); if (!el) return;
    if (window.SF_V2) el.classList.add('v2-wide');
    if (!this._data) el.innerHTML = '<div class="card"><div class="empty-state">Loading activity…</div></div>';
    try {
      const q = this._preset === 'custom' && this._from && this._to ? { from: this._from, to: this._to } : { preset: this._preset };
      this._data = await db.salesActivity.get(q);
    } catch (e) {
      el.innerHTML = `<div class="card"><div class="empty-state">${esc(e.message || 'Could not load activity')}</div></div>`;
      return;
    }
    const d = this._data;
    const h = [];
    h.push(this._header(d));
    h.push(this._filters(d));

    const sel = this._selected(d);
    h.push(this._scorecards(sel, d));
    if (sel.flags && sel.flags.length) h.push(this._flags(sel));
    h.push(this._dailyStrip(sel, d));
    if (this._person === 'all') h.push(this._teamTable(d));
    h.push(this._openList(sel, d));
    if (this._person === 'all' && d.team.untouchedNew) h.push(this._untouched(d));
    h.push(this._feed(d));
    el.innerHTML = h.join('');
  },

  // ── pieces ────────────────────────────────────────────────────────────────
  _header(d) {
    const w = d.window || {};
    const range = w.from === w.to ? this._fmtDay(w.from, true) : `${this._fmtDay(w.from, true)} – ${this._fmtDay(w.to, true)}`;
    if (window.SF_V2) return `<div class="v2-pagehd"><div><h1>Sales activity</h1><div class="sub">What each person did with the leads · ${esc(range)}</div></div>
      <div class="sp"></div><button class="btn" onclick="Team.exportCsv()">⬇ CSV</button></div>`;
    return `<div class="section-header" style="margin-top:0;"><span>Sales activity · ${esc(range)}</span><button class="btn btn-sm" onclick="Team.exportCsv()">⬇ CSV</button></div>`;
  },

  _filters(d) {
    const on = 'background:var(--green-lt);color:var(--green);border-color:var(--green);';
    const presets = this.PRESETS.map(p => `<button class="lead-status-opt ${p.key===this._preset?'active':''}" style="${p.key===this._preset?on:''}" onclick="Team.setPreset('${p.key}')">${p.label}</button>`).join('');
    const custom = this._preset === 'custom' ? `<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <input class="form-input" type="date" id="team-from" value="${esc(this._from || d.window.from)}" style="width:auto;">
        <span style="color:var(--muted);font-size:12px;">to</span>
        <input class="form-input" type="date" id="team-to" value="${esc(this._to || d.window.to)}" style="width:auto;">
        <button class="btn btn-sm btn-primary" onclick="Team.applyCustom()">Apply</button></div>` : '';
    // Everyone with a login shows up, even at zero — "did nothing" is a finding.
    const people = this._peopleList(d);
    const chips = [`<button class="lead-status-opt ${this._person==='all'?'active':''}" style="${this._person==='all'?on:''}" onclick="Team.setPerson('all')">Whole team</button>`]
      .concat(people.map(p => `<button class="lead-status-opt ${this._person===p.id?'active':''}" style="${this._person===p.id?on:''}" onclick="Team.setPerson('${esc(p.id)}')">${esc(p.name)} <span style="opacity:.6;font-weight:500;">${p.touches + p.stageMoves}</span></button>`));
    return `<div class="card" style="padding:12px 14px;">
      <div class="lead-status-row">${presets}</div>${custom}
      <div class="lead-status-row" style="margin-top:10px;">${chips.join('')}</div>
    </div>`;
  },

  _peopleList(d) {
    const seen = new Map();
    (d.people || []).forEach(p => seen.set(p.id, p));
    (d.accounts || []).forEach(a => { if (!seen.has(a.id)) seen.set(a.id, this._empty(a.id, a.name)); });
    return Array.from(seen.values());
  },
  _empty(id, name) {
    return { id, name, calls: 0, callsAnswered: 0, callsNoAnswer: 0, voicemails: 0, texts: 0, emails: 0, notes: 0, touches: 0, stageMoves: 0,
      leadsWorked: 0, leadsContacted: 0, leadsConnected: 0, pickedUp: 0, quoted: 0, booked: 0, lost: 0, bookedRate: null, connectRate: null, noAnswerRate: null,
      open: 0, openStale: 0, openList: [], appts: 0, apptValue: 0, medianFirstTouchMin: null, avgTouchesPerBooked: null, avgTouchesPerOpen: null, days: {}, flags: [] };
  },
  _selected(d) {
    if (this._person === 'all') {
      const t = Object.assign(this._empty('all', 'Whole team'), d.team || {});
      // Merge day series + open lists across people for the team view.
      t.days = {};
      const open = [];
      (d.people || []).forEach(p => {
        Object.keys(p.days || {}).forEach(k => { const a = t.days[k] || (t.days[k] = { calls: 0, texts: 0, emails: 0, notes: 0, booked: 0 }); const b = p.days[k]; a.calls += b.calls; a.texts += b.texts; a.emails += b.emails; a.notes += b.notes; a.booked += b.booked; });
        (p.openList || []).forEach(o => { if (!open.find(x => x.id === o.id)) open.push(Object.assign({ by: p.name }, o)); });
      });
      t.openList = open.sort((a, b) => (b.daysSinceTouch || 0) - (a.daysSinceTouch || 0));
      t.open = open.length; t.openStale = open.filter(o => o.daysSinceTouch >= 3).length;
      t.flags = [];
      if (t.untouchedNew) t.flags.push({ level: 'warn', text: `${t.untouchedNew} new lead${t.untouchedNew === 1 ? '' : 's'} nobody has touched yet.` });
      if (t.openStale >= 3) t.flags.push({ level: 'warn', text: `${t.openStale} open leads haven’t been touched in 3+ days.` });
      return t;
    }
    const p = (d.people || []).find(x => x.id === this._person);
    if (p) return p;
    const a = (d.accounts || []).find(x => x.id === this._person);
    return this._empty(this._person, a ? a.name : 'Unknown');
  },

  _scorecards(s, d) {
    const card = (label, value, sub, color) => `<div class="metric-card"><div class="metric-label">${label}</div><div class="metric-value ${color || ''}">${value}</div><div class="metric-sub">${sub || ''}</div></div>`;
    const rate = s.bookedRate != null ? s.bookedRate + '%' : '—';
    const stale = s.openStale ? `<span style="color:#c2410c;font-weight:700;">${s.openStale} stale</span> (3+ days quiet)` : 'none stale';
    return `<div class="metric-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));">
      ${card('Calls', s.calls, `${s.callsAnswered} answered · ${s.callsNoAnswer} no answer${s.connectRate != null ? ' · ' + s.connectRate + '% connect' : ''}`)}
      ${card('Texts + emails', s.texts + s.emails, `${s.texts} texts · ${s.emails} emails · ${s.notes} notes`)}
      ${card('Leads contacted', s.leadsContacted, `${s.leadsWorked} worked · ${s.pickedUp || 0} picked up new`)}
      ${card('Booked', s.booked, `${s.quoted} quoted · ${s.lost} marked lost`, 'green')}
      ${card('Booked rate', rate, 'booked ÷ leads worked', s.bookedRate >= 30 ? 'green' : '')}
      ${card('Still open', s.open, stale, s.openStale ? 'red' : '')}
      ${card('Appointments entered', s.appts, fmtMoney(s.apptValue || 0) + ' on the calendar')}
      ${card('First touch', s.medianFirstTouchMin != null ? this._fmtMins(s.medianFirstTouchMin) : '—', 'median, lead in → first outreach')}
    </div>`;
  },

  _flags(s) {
    const tone = { warn: 'background:#fff7ed;border-color:#fed7aa;color:#9a3412;', good: 'background:var(--green-lt);border-color:var(--green);color:var(--green);', info: 'background:var(--surface2);border-color:var(--border);color:var(--text);' };
    return `<div class="card" style="padding:12px 14px;">
      <div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;margin-bottom:8px;">COACHING NOTES</div>
      ${s.flags.map(f => `<div style="border:1px solid;border-radius:8px;padding:8px 10px;font-size:13px;line-height:1.45;margin-bottom:6px;${tone[f.level] || tone.info}">${esc(f.text)}</div>`).join('')}
    </div>`;
  },

  // Per-day bars (calls / texts) with booked count — weekly buckets past 31 days.
  _dailyStrip(s, d) {
    const w = d.window || {};
    const days = this._dayRange(w.from, w.to);
    if (!days.length) return '';
    let rows = days.map(k => ({ key: k, label: this._fmtDay(k), ...(s.days[k] || { calls: 0, texts: 0, emails: 0, notes: 0, booked: 0 }) }));
    if (rows.length > 31) {
      const wk = [];
      rows.forEach((r, i) => { if (i % 7 === 0) wk.push({ key: r.key, label: 'Wk of ' + this._fmtDay(r.key), calls: 0, texts: 0, emails: 0, notes: 0, booked: 0 }); const t = wk[wk.length - 1]; t.calls += r.calls; t.texts += r.texts; t.emails += r.emails; t.notes += r.notes; t.booked += r.booked; });
      rows = wk;
    }
    const max = Math.max(1, ...rows.map(r => r.calls + r.texts + r.emails));
    if (!rows.some(r => r.calls + r.texts + r.emails + r.booked)) return `<div class="card"><div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;margin-bottom:6px;">ACTIVITY BY DAY</div><div style="font-size:12.5px;color:var(--muted);">No calls or texts logged in this window. Log activity from any lead’s profile (Log call / Log text).</div></div>`;
    return `<div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;">ACTIVITY BY DAY</div>
        <div style="font-size:11px;color:var(--faint);"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--green);vertical-align:middle;"></span> calls &nbsp;<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#60a5fa;vertical-align:middle;"></span> texts/emails</div>
      </div>
      ${rows.map(r => { const tot = r.calls + r.texts + r.emails; return `<div style="display:flex;align-items:center;gap:10px;padding:3px 0;font-size:12px;">
        <span style="width:74px;color:var(--muted);white-space:nowrap;">${esc(r.label)}</span>
        <div class="bar-bg" style="flex:1;display:flex;">
          <div class="bar-fill" style="width:${(r.calls / max) * 100}%;background:var(--green);border-radius:0;"></div>
          <div class="bar-fill" style="width:${((r.texts + r.emails) / max) * 100}%;background:#60a5fa;border-radius:0;"></div>
        </div>
        <span style="width:92px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text);">${tot || '<span style="color:var(--faint)">0</span>'}${r.booked ? ` <span style="color:var(--green);font-weight:700;">· ${r.booked} booked</span>` : ''}</span>
      </div>`; }).join('')}
    </div>`;
  },

  _teamTable(d) {
    const people = this._peopleList(d);
    if (!people.length) return '';
    const th = (t, r) => `<span style="${r ? 'text-align:right;' : ''}flex:${r ? '0 0 58px' : '1'};">${t}</span>`;
    const td = (v, r, style) => `<span style="${r ? 'text-align:right;flex:0 0 58px;' : 'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'}font-variant-numeric:tabular-nums;${style || ''}">${v}</span>`;
    return `<div class="card" style="padding:12px 14px;overflow-x:auto;">
      <div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;margin-bottom:8px;">BY PERSON</div>
      <div style="min-width:560px;">
        <div style="display:flex;gap:6px;font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.04em;font-weight:600;padding-bottom:6px;border-bottom:1px solid var(--border);">
          ${th('Person')}${th('Calls', 1)}${th('Texts', 1)}${th('Worked', 1)}${th('Booked', 1)}${th('Rate', 1)}${th('Open', 1)}${th('Stale', 1)}${th('Appts $', 1)}</div>
        ${people.map(p => `<div class="list-row" style="padding:8px 0;gap:6px;font-size:12.5px;" onclick="Team.setPerson('${esc(p.id)}')">
          ${td(`<strong>${esc(p.name)}</strong>`)}
          ${td(p.calls + (p.calls ? ` <span style="color:var(--faint);font-size:10.5px;">${p.callsAnswered}✓</span>` : ''), 1)}
          ${td(p.texts + p.emails, 1)}${td(p.leadsWorked, 1)}
          ${td(p.booked, 1, 'color:var(--green);font-weight:700;')}
          ${td(p.bookedRate != null ? p.bookedRate + '%' : '—', 1)}
          ${td(p.open, 1)}
          ${td(p.openStale || '', 1, p.openStale ? 'color:#c2410c;font-weight:700;' : '')}
          ${td(p.appts ? fmtMoney(p.apptValue) : '—', 1)}
        </div>`).join('')}
      </div>
      <div style="font-size:11px;color:var(--faint);margin-top:8px;">Worked = leads they logged activity on or moved. Rate = booked ÷ worked. Open = leads they’ve ever touched that are still chaseable; stale = nobody has touched it in 3+ days. Only activity logged under each person’s own login counts.</div>
    </div>`;
  },

  _openList(s, d) {
    const list = s.openList || [];
    const title = this._person === 'all' ? 'STILL OPEN · ACROSS THE TEAM' : `STILL OPEN · ${esc(String(s.name).toUpperCase())}`;
    if (!list.length) return `<div class="card"><div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;margin-bottom:6px;">${title}</div><div style="font-size:12.5px;color:var(--muted);">No open leads — everything touched is booked or closed out.</div></div>`;
    const stageMeta = (k) => (typeof Leads !== 'undefined' && Leads._statusMeta && Leads._statusMeta[k]) || { label: k, bg: 'var(--surface2)', fg: 'var(--muted)' };
    return `<div class="card" style="padding:12px 14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;">${title}</div>
        <div style="font-size:11px;color:var(--faint);">${list.length} lead${list.length === 1 ? '' : 's'} · quietest first</div>
      </div>
      ${list.slice(0, 30).map(o => { const sm = stageMeta(o.stage); const stale = o.daysSinceTouch >= 3;
        return `<div class="list-row" style="padding:9px 0;" onclick="Team.openLead('${esc(o.id)}')">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${o.hot ? '🔥 ' : ''}${esc(o.name)}${o.by && this._person === 'all' ? ` <span style="color:var(--faint);font-weight:500;font-size:11px;">· ${esc(o.by)}</span>` : ''}</div>
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px;"><span class="badge" style="background:${sm.bg};color:${sm.fg};">${esc(sm.label)}</span> ${o.touches} touch${o.touches === 1 ? '' : 'es'}${o.quotedAmount != null ? ' · quoted ' + fmtMoney(o.quotedAmount) : ''}</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:12.5px;font-weight:700;color:${stale ? '#c2410c' : 'var(--text)'};">${o.daysSinceTouch == null ? '—' : o.daysSinceTouch === 0 ? 'today' : o.daysSinceTouch + 'd quiet'}</div>
            ${o.phone ? `<a href="tel:${esc(o.phone)}" onclick="event.stopPropagation()" style="font-size:11px;color:var(--green);text-decoration:none;">Call ↗</a>` : ''}
          </div>
        </div>`; }).join('')}
      ${list.length > 30 ? `<div style="font-size:11px;color:var(--faint);margin-top:6px;">Showing the 30 quietest of ${list.length}.</div>` : ''}
    </div>`;
  },

  _untouched(d) {
    const list = d.team.untouchedNewList || [];
    return `<div class="card" style="padding:12px 14px;border-color:#fed7aa;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <div style="font-size:11px;font-weight:800;color:#9a3412;letter-spacing:.05em;">NEW LEADS NOBODY HAS TOUCHED · ${d.team.untouchedNew}</div>
        <button class="btn btn-sm" onclick="App.nav('pipeline')">Open pipeline</button>
      </div>
      ${list.map(l => `<div class="list-row" style="padding:7px 0;" onclick="Team.openLead('${esc(l.id)}')">
        <div style="flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(l.name)}<span style="color:var(--faint);font-weight:500;font-size:11px;"> · ${esc(l.source || 'lead')}</span></div>
        <div style="font-size:12px;color:var(--muted);">${l.createdAt ? this._ago(l.createdAt) : ''}</div>
      </div>`).join('')}
    </div>`;
  },

  _feed(d) {
    let rows = d.feed || [];
    if (this._person !== 'all') rows = rows.filter(r => r.byId === this._person);
    const shown = rows.slice(0, this._feedShow);
    return `<div class="card" style="padding:12px 14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;">ACTIVITY LOG</div>
        <div style="font-size:11px;color:var(--faint);">${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}</div>
      </div>
      ${shown.length ? shown.map(r => this._feedRow(r)).join('') : '<div style="font-size:12.5px;color:var(--muted);">Nothing logged in this window.</div>'}
      ${rows.length > shown.length ? `<button class="btn btn-sm btn-full" style="margin-top:8px;" onclick="Team._feedShow+=40;Team.render()">Show more</button>` : ''}
    </div>`;
  },
  _feedRow(r) {
    const k = this.KIND[r.kind] || this.KIND.note;
    let label = k.label;
    let tone = 'color:var(--muted);';
    if (r.kind === 'call') { label += r.outcome ? ' · ' + (this.OUTCOME[r.outcome] || r.outcome) : ''; tone = r.outcome === 'answered' ? 'color:var(--green);' : 'color:#c2410c;'; }
    if (r.kind === 'stage') { label = 'Moved to ' + (r.outcome || '').replace(/_/g, ' '); tone = ['booked', 'worked', 'closed'].includes(r.outcome) ? 'color:var(--green);' : r.outcome === 'lost' ? 'color:var(--red);' : 'color:var(--muted);'; }
    const text = r.kind === 'stage' ? '' : r.text;
    return `<div class="list-row" style="padding:8px 0;align-items:flex-start;" onclick="Team.openLead('${esc(r.leadId)}')">
      <div style="width:18px;flex-shrink:0;text-align:center;">${k.icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12.5px;"><strong>${esc(r.leadName)}</strong> <span style="font-size:11.5px;font-weight:700;${tone}">${esc(label)}</span></div>
        ${text ? `<div style="font-size:12.5px;color:var(--text);line-height:1.4;white-space:pre-wrap;margin-top:2px;">${esc(text.length > 240 ? text.slice(0, 240) + '…' : text)}</div>` : ''}
        <div style="font-size:11px;color:var(--faint);margin-top:2px;">${_msgTimeFull(r.at)}${r.by ? ' · ' + esc(r.by) : ''}</div>
      </div>
    </div>`;
  },

  // ── actions ───────────────────────────────────────────────────────────────
  setPreset(k) { this._preset = k; this._feedShow = 40; if (k !== 'custom') { this._from = this._to = null; } this.render(); },
  applyCustom() {
    const f = (document.getElementById('team-from') || {}).value, t = (document.getElementById('team-to') || {}).value;
    if (!f || !t || f > t) { toast('Pick a valid date range', 'warning'); return; }
    this._from = f; this._to = t; this._preset = 'custom'; this.render();
  },
  setPerson(id) { this._person = id; this._feedShow = 40; this.render(); },
  async openLead(id) {
    if (typeof Leads === 'undefined') return;
    try { if (!(Leads._leads || []).find(x => x.id === id)) Leads._leads = await db.leads.all(); } catch (e) {}
    if (!(Leads._leads || []).find(x => x.id === id)) { toast('Lead not found', 'warning'); return; }
    Leads.open(id);
  },
  exportCsv() {
    const d = this._data; if (!d) return;
    let rows = d.feed || [];
    if (this._person !== 'all') rows = rows.filter(r => r.byId === this._person);
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [['When', 'Who', 'Type', 'Outcome', 'Lead', 'Phone', 'Notes'].map(q).join(',')]
      .concat(rows.map(r => [r.at, r.by, r.kind, r.kind === 'call' ? (this.OUTCOME[r.outcome] || r.outcome || '') : (r.kind === 'stage' ? r.outcome : ''), r.leadName, r.leadPhone, r.kind === 'stage' ? '' : r.text].map(q).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `sales-activity-${d.window.from}-to-${d.window.to}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },

  // ── helpers ───────────────────────────────────────────────────────────────
  _dayRange(from, to) {
    const out = []; if (!from || !to) return out;
    let d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
    let guard = 0;
    while (d <= end && guard++ < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
  },
  _fmtDay(k, long) {
    if (!k) return '';
    const d = new Date(k + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', long ? { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' } : { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' });
  },
  _fmtMins(m) { if (m < 60) return m + ' min'; if (m < 60 * 48) return (Math.round(m / 6) / 10) + ' h'; return Math.round(m / 1440) + ' d'; },
  _ago(iso) {
    const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
    if (mins < 60) return mins + 'm ago'; if (mins < 1440) return Math.floor(mins / 60) + 'h ago'; return Math.floor(mins / 1440) + 'd ago';
  },
};

// ── Pipeline (mobile-first lead board) ────────────────────────────────────────
// Kanban view of the same leads collection the Leads page lists — built for
// working Meta/website leads from a phone: one column per stage, horizontal
// scroll-snap between stages, and a single "advance" button per card so moving
// a lead forward is one tap (no drag-and-drop needed on a phone).
//
// Stages are owner-configurable (Edit stages): rename, recolor, reorder, add
// or remove the middle stages; the intake stage and the Closed/Lost end states
// are fixed anchors. Config resolves through Leads.stageConfig() (leads.js),
// which is also what the Leads list, filter pills, and lead modal read — one
// stage vocabulary everywhere. Stored as settings.pipeline.stages.
//
// Follow-up timing: each stage carries an owner-set max age (minutes; 0 = off).
// A lead sitting past its stage's interval is flagged, sorted to the top of
// its column, and counted in the header — that's the worklist.
//
// Card taps open the full Leads modal (Leads.open), so notes, quick-reply
// templates, AI intake, and convert-to-client all keep working from the board.
const Pipeline = {
  _leads: [],
  _source: 'all', // all | meta | website | call
  _view: localStorage.getItem('sf_pipeView') || 'stages', // 'stages' | 'days'

  stages() { return Leads.stageConfig(); },

  // Follow-up day markers for the By-day view (owner-defined, any count).
  // Stored as settings.pipeline.touchDays [{day, sms}]; sms is the optional
  // auto-text the drip engine (server/automation/engine.js) sends when a lead
  // crosses that day. Older numeric-only arrays normalize transparently.
  days() {
    const p = (Shop.settings && Shop.settings.pipeline) || {};
    let arr = (Array.isArray(p.touchDays) ? p.touchDays : [])
      .map(e => (typeof e === 'number' ? { day: e, sms: '' } : { day: Number(e && e.day) || 0, sms: String((e && e.sms) || '') }))
      .filter(e => e.day > 0)
      .sort((a, b) => a.day - b.day)
      .filter((e, i, a) => i === 0 || e.day !== a[i - 1].day);
    return arr.length ? arr : [{ day: 1, sms: '' }, { day: 3, sms: '' }, { day: 5, sms: '' }, { day: 10, sms: '' }];
  },
  setView(v) {
    this._view = v === 'days' ? 'days' : 'stages';
    try { localStorage.setItem('sf_pipeView', this._view); } catch (e) {}
    this.render();
  },
  _viewToggle() {
    const seg = (v, label) => `<button class="${this._view === v ? 'on' : ''}" onclick="Pipeline.setView('${v}')">${label}</button>`;
    return `<div class="pipe-view">${seg('stages', 'Stages')}${seg('days', 'By day')}</div>`;
  },
  _srcChips() {
    const chip = (key, label) => `<button class="lead-pill ${this._source === key ? 'active' : ''}" onclick="Pipeline.setSource('${key}')">${label}</button>`;
    return chip('all', 'All') + chip('meta', 'Meta') + chip('website', 'Website') + chip('call', 'Calls');
  },

  isActive() {
    const el = document.getElementById('page-pipeline');
    return !!el && el.classList.contains('active');
  },

  // 24×24 stroke icons (same visual language as the v2 nav).
  ICONS: {
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z"/></svg>',
    msg:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    back:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    x:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  },

  _stage(l) {
    const st = this.stages();
    return st.find(s => s.key === l.status) || st[0];
  },

  _matchSource(l) {
    if (this._source === 'all') return true;
    const s = String(l.source || 'call').toLowerCase();
    if (this._source === 'meta') return s === 'facebook' || s === 'instagram' || s === 'meta';
    if (this._source === 'website') return s === 'website';
    if (this._source === 'call') return s === 'call' || s === 'phone';
    return true;
  },

  // Minutes since the lead was last WORKED in its current stage: the later of
  // entering the stage (stageChangedAt) and the owner's last touch
  // (followTouchAt — stamped by note saves, day-texts, and sequence sends), so
  // handling a lead resets its "late" flag without moving it. Older leads fall
  // back to last contact.
  _ageMin(l) {
    const t = [l.stageChangedAt, l.followTouchAt].filter(Boolean).sort().pop() || l.lastContactAt || l.createdAt;
    return t ? Math.max(0, (Date.now() - new Date(t)) / 60000) : 0;
  },
  _fmtAge(min) {
    if (min < 60) return Math.max(1, Math.round(min)) + 'm';
    if (min < 1440) return Math.round(min / 60) + 'h';
    return Math.round(min / 1440) + 'd';
  },
  // 'over' = past the stage's interval, 'soon' = past 75% of it, 'ok' otherwise.
  _dueState(l) {
    const stage = this._stage(l);
    if (stage.terminal || !stage.interval) return 'ok';
    const age = this._ageMin(l);
    return age > stage.interval ? 'over' : (age > stage.interval * 0.75 ? 'soon' : 'ok');
  },

  // Where "move back" sends a lead. Mid-funnel: simply the previous stage in
  // order. Terminal (Closed/Lost): back to the last non-terminal stage in its
  // history — resurrecting a lead shouldn't dump it into whatever column
  // happens to sit before the end states.
  _backStage(l) {
    const stages = this.stages();
    const cur = this._stage(l);
    const idx = stages.findIndex(s => s.key === cur.key);
    if (!cur.terminal) return idx > 0 ? stages[idx - 1] : null;
    const log = l.stageLog || [];
    for (let i = log.length - 1; i >= 0; i--) {
      const s = stages.find(x => x.key === log[i].from);
      if (s && !s.terminal) return s;
    }
    return stages[0];
  },

  // Effective quote value: the owner-entered amount wins; otherwise fall back
  // to what the AI receptionist heard on the call. Drives the per-column
  // revenue totals ("how much is sitting in Quoted / Booked").
  _amt(l) {
    if (l.quotedAmount != null) return Number(l.quotedAmount) || 0;
    if (l.ai && l.ai.quotedPrice != null) return Number(l.ai.quotedPrice) || 0;
    return null;
  },

  async render() {
    const el = document.getElementById('page-pipeline');
    if (!el) return;
    try { this._leads = await db.leads.all(); } catch (e) { this._leads = []; }
    if (this._view === 'days') return this._renderDays(el);

    const stages = this.stages();
    const leads = this._leads.filter(l => this._matchSource(l));
    const byStage = {};
    stages.forEach(s => { byStage[s.key] = []; });
    leads.forEach(l => byStage[this._stage(l).key].push(l));
    // Active columns: anyone already reached out to TODAY sinks to the bottom;
    // above them, needs-follow-up first, then longest-waiting (FIFO).
    // Terminal columns: most recent first.
    stages.forEach(s => {
      byStage[s.key].sort(s.terminal
        ? (a, b) => this._ageMin(a) - this._ageMin(b)
        : (a, b) => {
            const ta = Leads.touchedToday(a) ? 1 : 0, tb = Leads.touchedToday(b) ? 1 : 0;
            if (ta !== tb) return ta - tb;
            const oa = this._dueState(a) === 'over', ob = this._dueState(b) === 'over';
            if (oa !== ob) return oa ? -1 : 1;
            return this._ageMin(b) - this._ageMin(a);
          });
    });

    const openCount = stages.filter(s => !s.terminal).reduce((n, s) => n + byStage[s.key].length, 0);
    const overdue = leads.filter(l => this._dueState(l) === 'over').length;

    const jumpPill = (s) => {
      const n = byStage[s.key].length;
      const over = byStage[s.key].filter(l => this._dueState(l) === 'over').length;
      return `<button class="pipe-jump-pill" onclick="Pipeline.jumpTo('${s.key}')">
        <span class="pipe-dot" style="background:${s.color};"></span>${esc(s.label)}
        <span class="lead-pill-count">${n}</span>${over ? `<span class="pipe-jump-over">${over} late</span>` : ''}
      </button>`;
    };

    const head = `
      <div class="pipe-top">
        <div class="pipe-summary"><strong>${openCount}</strong> open lead${openCount === 1 ? '' : 's'}${overdue ? ` · <span style="color:var(--red);font-weight:700;">${overdue} need${overdue === 1 ? 's' : ''} follow-up</span>` : ''}</div>
        <div class="pipe-top-actions">${this._viewToggle()}<button class="btn btn-sm" onclick="Pipeline.stagesModal()">Edit stages</button></div>
      </div>
      <div class="pipe-chips">${this._srcChips()}</div>
      <div class="pipe-chips pipe-jump">${stages.map(jumpPill).join('')}</div>`;

    const board = `<div class="pipe-board">${stages.map((s, i) => {
      const sum = byStage[s.key].reduce((t, l) => t + (this._amt(l) || 0), 0);
      return this._column(s, stages[i + 1] || null, byStage[s.key], sum);
    }).join('')}</div>`;

    // Keep the board's horizontal position across re-renders (advance, save…).
    const prev = el.querySelector('.pipe-board');
    const scrollLeft = prev ? prev.scrollLeft : 0;
    el.innerHTML = head + board;
    const nb = el.querySelector('.pipe-board');
    if (nb) nb.scrollLeft = scrollLeft;
  },

  _column(stage, nextStage, list, sum) {
    // Terminal columns can grow forever — cap the render, keep the real count.
    const shown = stage.terminal ? list.slice(0, 20) : list;
    const more = list.length - shown.length;
    const timing = (!stage.terminal && stage.interval)
      ? `<span class="pipe-col-iv" title="Flagged for follow-up after ${this._fmtAge(stage.interval)} in this stage">${this._fmtAge(stage.interval)}</span>` : '';
    const money = sum > 0 ? `<span class="pipe-col-money" title="Total quoted value sitting in ${esc(stage.label)}">${fmtMoney(sum)}</span>` : '';
    const cards = shown.length
      ? shown.map(l => this._card(l, stage, nextStage)).join('') + (more > 0 ? `<div class="pipe-more">+ ${more} more</div>` : '')
      : `<div class="pipe-empty">No leads here yet</div>`;
    return `<div class="pipe-col" id="pipe-col-${stage.key}">
      <div class="pipe-col-head">
        <span class="pipe-dot" style="background:${stage.color};"></span>
        <span class="pipe-col-title">${esc(stage.label)}</span>
        <span class="pipe-col-count">${list.length}</span>
        ${money}
        <span class="pipe-col-right">${timing}<button class="pipe-col-sel" onclick="Pipeline.cleanup('${stage.key}')">Select</button></span>
      </div>
      <div class="pipe-col-body">${cards}</div>
    </div>`;
  },

  // ── By-day view: leads bucketed by age since they came in ───────────────────
  // No stored state — a lead "moves" between day columns purely as time passes.
  // Only chaseable leads appear (non-terminal, non-won stages): booked/closed/
  // lost work doesn't need a day cadence.
  _leadAgeDays(l) {
    const t = Date.parse(l.createdAt || l.firstContactAt || l.lastContactAt || '');
    return isNaN(t) ? 0 : (Date.now() - t) / 86400000;
  },
  _renderDays(el) {
    const entries = this.days();
    const chase = this._leads.filter(l => this._matchSource(l)).filter(l => {
      const s = this._stage(l);
      return !s.terminal && !s.won;
    });
    const buckets = entries.map(() => []);
    chase.forEach(l => {
      const a = this._leadAgeDays(l);
      let idx = 0;
      for (let i = 1; i < entries.length; i++) if (a >= entries[i].day) idx = i;
      buckets[idx].push(l);
    });
    // Reached-out-today leads sink; the untouched oldest sit on top.
    buckets.forEach(b => b.sort((x, y) => {
      const tx = Leads.touchedToday(x) ? 1 : 0, ty = Leads.touchedToday(y) ? 1 : 0;
      if (tx !== ty) return tx - ty;
      return this._leadAgeDays(y) - this._leadAgeDays(x);
    }));

    const jump = entries.map((e, i) => `<button class="pipe-jump-pill" onclick="Pipeline.jumpTo('day-${i}')">
        Day ${e.day}${i === entries.length - 1 ? '+' : ''}
        <span class="lead-pill-count">${buckets[i].length}</span>
      </button>`).join('');

    const head = `
      <div class="pipe-top">
        <div class="pipe-summary"><strong>${chase.length}</strong> lead${chase.length === 1 ? '' : 's'} in follow-up</div>
        <div class="pipe-top-actions">${this._viewToggle()}<button class="btn btn-sm" onclick="Pipeline.daysModal()">Edit days</button></div>
      </div>
      <div class="pipe-chips">${this._srcChips()}</div>
      <div class="pipe-chips pipe-jump">${jump}</div>`;

    const cols = entries.map((e, i) => this._dayColumn(e, i, entries[i + 1], buckets[i])).join('');

    const prev = el.querySelector('.pipe-board');
    const scrollLeft = prev ? prev.scrollLeft : 0;
    el.innerHTML = head + `<div class="pipe-board">${cols}</div>`;
    const nb = el.querySelector('.pipe-board');
    if (nb) nb.scrollLeft = scrollLeft;
  },

  _dayColumn(entry, i, nextEntry, list) {
    const label = 'Day ' + entry.day + (nextEntry ? '' : '+');
    const range = nextEntry ? `${entry.day}–${nextEntry.day} days in` : `${entry.day}+ days in`;
    const auto = entry.sms ? `<span class="pipe-col-iv" title="Day-${entry.day} text: ${esc(entry.sms)}">text ready</span>` : '';
    const stages = this.stages();
    const cards = list.length
      ? list.map(l => {
          const stage = this._stage(l);
          const idx = stages.findIndex(s => s.key === stage.key);
          return this._card(l, stage, stages[idx + 1] || null, { timeView: true, entry });
        }).join('')
      : `<div class="pipe-empty">No leads ${range}</div>`;
    return `<div class="pipe-col" id="pipe-col-day-${i}">
      <div class="pipe-col-head">
        <span class="pipe-col-title" title="${range}">${label}</span>
        <span class="pipe-col-count">${list.length}</span>
        <span class="pipe-col-right">${auto}</span>
      </div>
      <div class="pipe-col-body">${cards}</div>
    </div>`;
  },

  _card(l, stage, nextStage, o) {
    o = o || {};
    // Never advance a lead into Lost — that's an explicit choice (the × button).
    const next = (!stage.terminal && nextStage && nextStage.fixed !== 'lost') ? nextStage : null;
    const due = o.timeView ? 'ok' : this._dueState(l);
    const age = o.timeView ? this._fmtAge(Math.max(1, this._leadAgeDays(l) * 1440)) : this._fmtAge(this._ageMin(l));
    const name = l.name || l.phone || 'Unknown';
    const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
    const svc = (l.servicesInterested || []).join(', ');
    const sub = [veh, svc].filter(Boolean).join(' · ') || l.phone || '';
    const src = Leads._sourceMeta(l.source).label;
    // Quote chip: set → the amount (tap to change); unset past intake → "+ $"
    // so entering what a lead was quoted is one tap from the board.
    const amt = this._amt(l);
    const money = stage.fixed === 'intake' && amt == null ? '' : (amt != null
      ? `<button class="pipe-money set" onclick="event.stopPropagation();Pipeline.quoteModal('${l.id}')" title="Quoted amount — tap to change">${fmtMoney(amt)}</button>`
      : `<button class="pipe-money" onclick="event.stopPropagation();Pipeline.quoteModal('${l.id}')" title="Add what they were quoted">+ $</button>`);

    const ageChip = o.timeView
      ? `<span class="pipe-age" title="Came in ${age} ago">${age}</span>`
      : (due === 'over'
        ? `<span class="pipe-age over" title="In ${esc(stage.label)} for ${age} — past your follow-up timing">${age} late</span>`
        : `<span class="pipe-age ${due === 'soon' ? 'soon' : ''}" title="In ${esc(stage.label)} for ${age}">${age}</span>`);
    // By-day cards lead with the stage (colored) instead of the source, plus a
    // marker showing which day follow-ups have already been texted.
    const tag = o.timeView
      ? `<span class="pipe-src" style="color:${stage.color};border-color:${stage.color}55;background:${stage.color}14;">${esc(stage.label)}</span>`
        + (l.dripLog && Object.keys(l.dripLog).length ? `<span class="pipe-src" style="color:var(--green);" title="Follow-ups texted: ${esc(Object.keys(l.dripLog).map(k => 'day ' + k.slice(1)).join(', '))}">texted ${Object.keys(l.dripLog).length}×</span>` : '')
      : (src ? `<span class="pipe-src">${esc(src)}</span>` : '');

    const call = l.phone ? `<a class="pipe-act" href="tel:${esc(l.phone)}" onclick="event.stopPropagation()" title="Call" aria-label="Call">${this.ICONS.phone}</a>` : '';
    const lose = !stage.terminal ? `<button class="pipe-act pipe-lose" onclick="event.stopPropagation();Pipeline.markLost('${l.id}')" title="Mark lost" aria-label="Mark lost">${this.ICONS.x}</button>` : '';

    let actions;
    if (o.timeView) {
      // By-day cards: the primary action IS the day's text — one tap opens the
      // owner's Messages app prefilled with that day's message (no auto-send).
      const e = o.entry;
      const texted = !!(e && l.dripLog && l.dripLog['d' + e.day]);
      const primary = (l.phone && e && e.sms)
        ? `<button class="pipe-advance ${texted ? 'ghost' : ''}" onclick="event.stopPropagation();Pipeline.dayText('${l.id}',${e.day})">${texted ? 'Texted — send again' : `Text day-${e.day} message`}</button>`
        : (l.phone
          ? `<button class="pipe-advance" onclick="event.stopPropagation();Pipeline.text('${l.id}')">Text</button>`
          : `<button class="pipe-advance ghost" onclick="event.stopPropagation();Pipeline.openLead('${l.id}')">Details</button>`);
      actions = `${call}${lose}${primary}`;
    } else {
      const text = l.phone ? `<button class="pipe-act" onclick="event.stopPropagation();Pipeline.text('${l.id}')" title="Text" aria-label="Text">${this.ICONS.msg}</button>` : '';
      const prev = this._backStage(l);
      const back = prev ? `<button class="pipe-act" onclick="event.stopPropagation();Pipeline.moveBack('${l.id}',this)" title="Back to ${esc(prev.label)}" aria-label="Back to ${esc(prev.label)}">${this.ICONS.back}</button>` : '';
      const advance = next
        ? `<button class="pipe-advance" onclick="event.stopPropagation();Pipeline.advance('${l.id}',this)">${esc(next.label)} →</button>`
        : `<button class="pipe-advance ghost" onclick="event.stopPropagation();Pipeline.openLead('${l.id}')">Details</button>`;
      actions = `${call}${text}${lose}${back}${advance}`;
    }

    return `<div class="pipe-card ${due === 'over' ? 'overdue' : ''}" onclick="Pipeline.openLead('${l.id}')">
      <div class="pipe-card-top">
        <div class="pipe-card-name">${esc(name)}</div>
        ${ageChip}
      </div>
      <div class="pipe-card-sub">${tag}<span class="t" title="${esc(sub)}">${esc(sub)}</span>${money}</div>
      ${stage.fixed === 'lost' && l.lostReason ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;font-style:italic;">✗ ${esc(l.lostReason)}</div>` : ''}
      <div class="pipe-card-actions">${actions}</div>
    </div>`;
  },

  // One-tap day follow-up: opens iPhone Messages prefilled with the day's
  // template (merge fields resolved), then stamps the lead so the card flips to
  // "Texted" — same manual sms: flow as everywhere else, nothing auto-sends.
  dayText(id, day) {
    const l = this._leads.find(x => x.id === id);
    if (!l || !l.phone) { toast('No phone number on file', 'warning'); return; }
    const entry = this.days().find(e => e.day === day);
    if (!entry || !entry.sms) return this.text(id);
    const first = String(l.name || '').trim().split(/\s+/)[0];
    const body = entry.sms
      .replace(/\{first\}/gi, first || 'there')
      .replace(/\{name\}/gi, l.name || 'there')
      .replace(/\{shop\}/gi, (Shop.settings && Shop.settings.shopName) || '');
    _cpSms(l.phone, body);
    db.leads.update(id, { dripDay: day, by: (Auth.getName && Auth.getName()) || '' })
      .then(() => this.render())
      .catch(() => {});
  },

  setSource(s) { this._source = s; this.render(); },

  jumpTo(key) {
    // Instant jump, not smooth — the board's mandatory scroll-snap cancels
    // programmatic smooth scrolling outright, but an instant scrollLeft set
    // lands and snaps to the target column reliably.
    const col = document.getElementById('pipe-col-' + key);
    const board = document.querySelector('.pipe-board');
    if (!col || !board) return;
    board.scrollLeft = (col.getBoundingClientRect().left - board.getBoundingClientRect().left)
      + board.scrollLeft - (board.clientWidth - col.clientWidth) / 2;
  },

  // Full lead modal (notes, templates, AI card, convert…) — reuse the Leads
  // page's, pointed at this view's lead list. Its save/status/note handlers all
  // end in Leads.render(), which repaints this board while it's the active page.
  openLead(id) {
    Leads._leads = this._leads;
    Leads.open(id);
  },

  // Quick-text: open iPhone Messages prefilled via the manual sms: deep link
  // (same no-Twilio flow as everywhere else). No status change — advancing is
  // the owner's one-tap call after they actually send.
  text(id) {
    const l = this._leads.find(x => x.id === id);
    if (!l || !l.phone) { toast('No phone number on file', 'warning'); return; }
    const first = String(l.name || '').trim().split(/\s+/)[0];
    const shop = (Shop.settings && Shop.settings.shopName) || '';
    _cpSms(l.phone, `Hey${first ? ' ' + first : ''}! This is ${shop || 'us'} — thanks for reaching out. When works for a quick call about your vehicle?`);
    // Touch stamp: today's reached-out leads sink below the untouched ones.
    db.leads.note(id, 'Texted').catch(() => {});
  },

  async advance(id, btn) {
    const l = this._leads.find(x => x.id === id);
    if (!l) return;
    const stages = this.stages();
    // Match by key, not object identity — stageConfig() builds fresh objects
    // on every call, so indexOf(this._stage(l)) would always miss.
    const idx = stages.findIndex(s => s.key === this._stage(l).key);
    const next = stages[idx + 1];
    if (idx < 0 || !next || next.fixed === 'lost') return;
    await this._setStatus(l, next.key, `${esc(l.name || l.phone || 'Lead')} moved to ${esc(next.label)}`, btn);
    // Landing in Quoted without a dollar figure → ask for it right away, so
    // the column's revenue total stays honest without a second trip.
    if (next.key === 'quoted') {
      const fresh = this._leads.find(x => x.id === id);
      if (fresh && this._amt(fresh) == null) this.quoteModal(id);
    }
  },

  async moveBack(id, btn) {
    const l = this._leads.find(x => x.id === id);
    if (!l) return;
    const prev = this._backStage(l);
    if (!prev) return;
    await this._setStatus(l, prev.key, `${esc(l.name || l.phone || 'Lead')} back to ${esc(prev.label)}`, btn);
  },

  // Marking lost asks WHY — the reasons roll up into a loss report, which is
  // the difference between "we lose leads" and "we lose leads on price".
  LOST_REASONS: ['Too expensive', 'Went with someone else', 'No response / ghosted', 'Bad timing', 'Changed their mind'],
  _lostModal(count, onConfirm) {
    this._lostCb = onConfirm; this._lostSel = null;
    Modal.show(`
      <div class="modal-title">Mark ${count > 1 ? count + ' leads' : 'lead'} lost</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px;">Why? One tap — this feeds your loss-reason report.</div>
      <div id="lost-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
        ${this.LOST_REASONS.map(r => `<button class="btn btn-sm" data-reason="${esc(r)}" onclick="Pipeline._pickLost(this)">${esc(r)}</button>`).join('')}
      </div>
      <input class="form-input" id="lost-other" placeholder="Or type your own reason…" style="margin-bottom:12px;" oninput="Pipeline._clearLostPick()"/>
      <div class="modal-actions">
        <button class="btn btn-danger btn-full" onclick="Pipeline._confirmLost()">Mark lost</button>
        <button class="btn btn-full" onclick="Pipeline._lostCancel()">Cancel</button>
      </div>`);
  },
  // Cancel returns to the clean-out list when one was open (its modal was
  // replaced by this one); otherwise just closes.
  _lostCancel() { this._lostCb = null; if (this._cl) this._clRender(); else Modal.close(); },
  _pickLost(btn) {
    this._lostSel = btn.dataset.reason;
    document.querySelectorAll('#lost-chips .btn').forEach(b => { b.style.background = b === btn ? 'var(--green)' : ''; b.style.color = b === btn ? '#fff' : ''; });
    const o = document.getElementById('lost-other'); if (o) o.value = '';
  },
  _clearLostPick() {
    this._lostSel = null;
    document.querySelectorAll('#lost-chips .btn').forEach(b => { b.style.background = ''; b.style.color = ''; });
  },
  _confirmLost() {
    const other = (document.getElementById('lost-other')?.value || '').trim();
    const reason = other || this._lostSel || '';
    Modal.close();
    const cb = this._lostCb; this._lostCb = null;
    if (cb) cb(reason);
  },

  markLost(id) {
    const l = this._leads.find(x => x.id === id);
    if (!l) return;
    this._lostModal(1, (reason) => this._setStatus(l, 'lost', 'Marked lost', null, reason ? { lostReason: reason } : {}));
  },

  async _setStatus(l, status, msg, btn, extra) {
    if (btn) btn.disabled = true;
    try {
      await db.leads.update(l.id, Object.assign({ status }, extra || {}));
      toast(msg);
    } catch (e) {
      toast(e.message || 'Could not update lead', 'error');
    }
    await this.render();
  },

  // ── Quoted amount (per-lead $, feeds the column revenue totals) ─────────────
  quoteModal(id) {
    const l = this._leads.find(x => x.id === id);
    if (!l) return;
    const ai = (l.quotedAmount == null && l.ai && l.ai.quotedPrice != null) ? Number(l.ai.quotedPrice) : null;
    Modal.show(`
      <div class="modal-title">Quoted amount — ${esc(l.name || l.phone || 'Lead')}</div>
      <div class="form-group">
        <label class="form-label">How much were they quoted?</label>
        <input class="form-input" id="pq-amt" type="number" min="0" step="1" inputmode="decimal" placeholder="450"
          value="${l.quotedAmount != null ? l.quotedAmount : (ai != null ? ai : '')}"
          style="font-size:20px;font-weight:700;" onkeydown="if(event.key==='Enter')Pipeline.saveQuote('${l.id}')">
      </div>
      ${ai != null ? `<div style="font-size:12px;color:var(--muted);margin:-6px 0 12px;">Heard on the AI receptionist call — save to confirm, or change it.</div>` : ''}
      <div class="modal-actions">
        <button class="btn btn-primary btn-full" onclick="Pipeline.saveQuote('${l.id}')">Save</button>
        ${l.quotedAmount != null ? `<button class="btn btn-full" onclick="Pipeline.saveQuote('${l.id}', true)">Remove amount</button>` : ''}
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(() => document.getElementById('pq-amt')?.select(), 150);
  },

  async saveQuote(id, clear) {
    const v = clear ? NaN : parseFloat(document.getElementById('pq-amt')?.value);
    const ok = Number.isFinite(v) && v > 0;
    try {
      await db.leads.update(id, { quotedAmount: ok ? v : null });
      Modal.close();
      toast(ok ? 'Quote saved — ' + fmtMoney(v) : 'Amount cleared');
      this.render();
    } catch (e) {
      toast(e.message || 'Could not save', 'error');
    }
  },

  // ── Clean-out (bulk triage: Select on a column header) ──────────────────────
  // A checklist of one column's leads, oldest first, with age filters — check a
  // batch and move / mark lost / delete in one call. Built for sweeping a pile
  // of stale leads so only the good ones stay on the board.
  cleanup(stageKey) {
    this._cl = { stage: stageKey, sel: new Set(), minAge: 0 };
    this._clRender();
  },

  _clLeads() {
    const cl = this._cl;
    return this._leads
      .filter(l => this._stage(l).key === cl.stage && this._matchSource(l))
      .filter(l => !cl.minAge || this._ageMin(l) >= cl.minAge)
      .sort((a, b) => this._ageMin(b) - this._ageMin(a));
  },

  _clRender() {
    const cl = this._cl;
    if (!cl) return;
    const stage = this.stages().find(s => s.key === cl.stage);
    if (!stage) { Modal.close(); return; }
    const list = this._clLeads();
    const shownIds = new Set(list.map(l => l.id));
    cl.sel.forEach(id => { if (!shownIds.has(id)) cl.sel.delete(id); });
    const n = cl.sel.size;

    const ageChip = (min, label) => `<button class="lead-pill ${cl.minAge === min ? 'active' : ''}" onclick="Pipeline.clAge(${min})">${label}</button>`;
    const rows = list.map(l => {
      const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
      const note = String((l.noteLog && l.noteLog[0] && l.noteLog[0].text) || l.notes || '').split('\n')[0];
      const amt = this._amt(l);
      const sub = [l.phone, veh || (l.servicesInterested || []).join(', '), amt != null ? fmtMoney(amt) : '', note].filter(Boolean).join(' · ');
      return `<label class="pipe-cl-row">
        <input type="checkbox" ${cl.sel.has(l.id) ? 'checked' : ''} onchange="Pipeline.clToggle('${l.id}')">
        <span class="mid"><span class="nm">${esc(l.name || l.phone || 'Unknown')}</span><span class="sub">${esc(sub)}</span></span>
        <span class="age">${this._fmtAge(this._ageMin(l))}</span>
      </label>`;
    }).join('') || '<div class="pipe-empty">Nothing matches this filter.</div>';

    const moveOpts = this.stages().filter(s => s.key !== cl.stage)
      .map(s => `<option value="${s.key}">${esc(s.label)}</option>`).join('');
    const allSelected = list.length && n === list.length;
    const nn = n ? ' ' + n : '';

    const prevList = document.querySelector('.pipe-cl-list');
    const scrollTop = prevList ? prevList.scrollTop : 0;
    Modal.show(`
      <div class="modal-title">Clean out — ${esc(stage.label)} <span style="font-weight:500;color:var(--muted);">${list.length}</span></div>
      <div class="pipe-chips" style="padding:0 0 10px;">
        ${ageChip(0, 'All')}${ageChip(10080, '7d+ old')}${ageChip(43200, '30d+ old')}
        <button class="lead-pill" style="margin-left:auto;" onclick="Pipeline.clAll()">${allSelected ? 'Clear all' : 'Select all'}</button>
      </div>
      <div class="pipe-cl-list">${rows}</div>
      <div class="pipe-cl-actions">
        <div class="pipe-cl-move">
          <select class="form-input" id="cl-move">${moveOpts}</select>
          <button class="btn" id="cl-btn-move" onclick="Pipeline.clMove()" ${n ? '' : 'disabled'}>Move${nn}</button>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn" id="cl-btn-lost" style="flex:1;" onclick="Pipeline.clLost()" ${n ? '' : 'disabled'}>Mark lost${nn}</button>
          ${Auth.getRole() === 'full' ? `<button class="btn btn-danger" id="cl-btn-del" style="flex:1;" onclick="Pipeline.clDelete()" ${n ? '' : 'disabled'}>Delete${nn}</button>` : ''}
        </div>
        <button class="btn btn-primary btn-full" style="margin-top:2px;" onclick="Pipeline.clDone()">Done</button>
      </div>`);
    const nl = document.querySelector('.pipe-cl-list');
    if (nl) nl.scrollTop = scrollTop;
  },

  // Checkbox taps only refresh the footer buttons — a full re-render would
  // reset the list scroll mid-triage.
  clToggle(id) {
    const s = this._cl.sel;
    s.has(id) ? s.delete(id) : s.add(id);
    const n = s.size, nn = n ? ' ' + n : '';
    const set = (bid, label) => { const b = document.getElementById(bid); if (b) { b.disabled = !n; b.textContent = label + nn; } };
    set('cl-btn-move', 'Move');
    set('cl-btn-lost', 'Mark lost');
    set('cl-btn-del', 'Delete');
  },
  clAll() {
    const list = this._clLeads();
    const all = list.length && list.every(l => this._cl.sel.has(l.id));
    this._cl.sel = all ? new Set() : new Set(list.map(l => l.id));
    this._clRender();
  },
  clAge(min) { this._cl.minAge = min; this._clRender(); },
  clDone() { this._cl = null; Modal.close(); this.render(); },

  clMove() {
    const sel = document.getElementById('cl-move');
    const to = sel && sel.value;
    if (!to) return;
    const s = this.stages().find(x => x.key === to);
    return this._clApply(ids => db.leads.bulkStatus(ids, to), 'moved to ' + ((s && s.label) || to));
  },
  clLost() {
    const n = this._cl.sel.size; if (!n) return;
    // One shared reason for the whole swept batch (these are usually ghosts).
    this._lostModal(n, (reason) =>
      this._clApply(ids => db.leads.bulkStatus(ids, 'lost', reason || null), 'marked lost'));
  },
  clDelete() {
    const n = this._cl.sel.size;
    if (!n) return;
    if (!confirm(`Delete ${n} lead${n === 1 ? '' : 's'} and their call history? This can't be undone.`)) return;
    return this._clApply(ids => db.leads.bulkDelete(ids), 'deleted');
  },
  async _clApply(fn, verb) {
    const ids = [...this._cl.sel];
    if (!ids.length) return;
    try {
      await fn(ids);
      toast(`${ids.length} ${verb}`);
      this._leads = await db.leads.all();
      this._cl.sel.clear();
      this._clRender();   // stay in the flow — keep cleaning until Done
    } catch (e) {
      toast(e.message || 'Bulk update failed', 'error');
    }
  },

  // ── Follow-up days editor (By-day columns + per-day auto-texts) ─────────────
  daysModal() {
    this._dEdit = this.days().map(e => ({ ...e }));
    this._dRender();
  },
  _dRender() {
    const rows = this._dEdit.map((e, i) => `
      <div class="pipe-ed-row">
        <div class="pipe-ed-main">
          <span class="pipe-ed-daylbl">Day</span>
          <input class="form-input" id="dd-day-${i}" type="number" min="1" inputmode="numeric" value="${e.day}" style="width:74px;flex:none;">
          <span class="pipe-ed-note" style="flex:1;">after the lead comes in</span>
          <div class="pipe-ed-ctl"><button type="button" class="danger" onclick="Pipeline.dRemove(${i})" title="Remove day">${this.ICONS.x}</button></div>
        </div>
        <textarea class="form-input" id="dd-sms-${i}" rows="2" maxlength="320" placeholder="Auto-text for day ${e.day} — leave blank for no text. {first} and {shop} fill in.">${esc(e.sms)}</textarea>
      </div>`).join('');
    Modal.show(`
      <div class="modal-title">Follow-up days</div>
      <div style="font-size:13px;color:var(--muted);margin:-6px 0 14px;line-height:1.5;">
        The columns of the By-day view — add as many as you want. Give a day a
        message and every lead in that column gets a one-tap
        <strong>Text day-N message</strong> button that opens your Messages app
        with it prefilled — you hit send, nothing sends itself.
      </div>
      ${rows}
      <button class="btn btn-full" onclick="Pipeline.dAdd()" style="margin-top:2px;">+ Add a day</button>
      <div class="modal-actions">
        <button class="btn btn-primary btn-full" onclick="Pipeline.saveDays(this)">Save days</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
  },
  _dSync() {
    this._dEdit.forEach((e, i) => {
      const d = document.getElementById('dd-day-' + i);
      if (d) e.day = Math.max(1, parseInt(d.value, 10) || e.day);
      const s = document.getElementById('dd-sms-' + i);
      if (s) e.sms = s.value.trim().slice(0, 320);
    });
  },
  dAdd() {
    this._dSync();
    const last = this._dEdit[this._dEdit.length - 1];
    this._dEdit.push({ day: (last ? last.day : 0) + 2, sms: '' });
    this._dRender();
  },
  dRemove(i) {
    this._dSync();
    this._dEdit.splice(i, 1);
    this._dRender();
  },
  async saveDays(btn) {
    this._dSync();
    let touchDays = this._dEdit
      .filter(e => e.day > 0)
      .sort((a, b) => a.day - b.day)
      .filter((e, i, a) => i === 0 || e.day !== a[i - 1].day)
      .map(e => ({ day: e.day, sms: e.sms }));
    if (!touchDays.length) touchDays = [{ day: 1, sms: '' }];
    disableBtn(btn);
    try {
      // dripEnabled forced off: day messages are one-tap manual sends only.
      const pipeline = { ...((Shop.settings && Shop.settings.pipeline) || {}), touchDays, dripEnabled: false };
      await db.settings.save({ pipeline });
      Shop.settings.pipeline = pipeline;
      Modal.close();
      toast('Days saved');
      this.render();
    } catch (e) {
      enableBtn(btn);
      toast(e.message || 'Could not save days', 'error');
    }
  },

  // ── Stage editor (rename / recolor / reorder / add / remove + timing) ───────
  _PALETTE: ['#2563eb', '#d97706', '#7c3aed', '#16a34a', '#0891b2', '#db2777', '#ea580c', '#64748b'],

  stagesModal() {
    this._edit = this.stages().map(s => ({ ...s }));
    this._edRender();
  },

  // Middle stages (no `fixed` flag) are the editable band: they can move, be
  // removed, and carry the win toggle. The anchors only rename/recolor/re-time.
  _edRender() {
    const rows = this._edit.map((s, i) => {
      const middle = !s.fixed;
      const up = middle && !this._edit[i - 1].fixed;
      const down = middle && this._edit[i + 1] && !this._edit[i + 1].fixed;
      const unit = s.interval && s.interval % 1440 === 0 ? 1440 : (s.interval && s.interval % 60 === 0 ? 60 : 1);
      const timing = s.terminal
        ? `<span class="pipe-ed-note">${s.fixed === 'lost' ? 'End stage — dead leads live here' : 'End stage — won, paid-and-done work'}</span>`
        : `<span>Follow up after</span>
           <input class="form-input" id="ed-iv-${i}" type="number" min="1" inputmode="numeric" placeholder="Off" value="${s.interval ? s.interval / unit : ''}" style="width:70px;flex:none;">
           <select class="form-input" id="ed-unit-${i}" style="width:100px;flex:none;">
             <option value="1" ${unit === 1 ? 'selected' : ''}>minutes</option>
             <option value="60" ${unit === 60 ? 'selected' : ''}>hours</option>
             <option value="1440" ${unit === 1440 ? 'selected' : ''}>days</option>
           </select>
           ${s.fixed === 'intake'
             ? '<span class="pipe-ed-note" style="margin-left:auto;">New leads land here</span>'
             : `<label class="pipe-ed-win" title="Leads that reach this stage count as won in your conversion numbers"><input type="checkbox" id="ed-won-${i}" ${s.won ? 'checked' : ''}> Counts as won</label>`}`;
      return `<div class="pipe-ed-row">
        <div class="pipe-ed-main">
          <button type="button" class="pipe-ed-swatch" style="background:${s.color};" onclick="Pipeline.edColor(${i})" title="Change color" aria-label="Change color"></button>
          <input class="form-input" id="ed-label-${i}" value="${esc(s.label)}" maxlength="24" placeholder="Stage name">
          <div class="pipe-ed-ctl">
            ${middle ? `<button type="button" onclick="Pipeline.edMove(${i},-1)" ${up ? '' : 'disabled'} title="Move up">↑</button>
            <button type="button" onclick="Pipeline.edMove(${i},1)" ${down ? '' : 'disabled'} title="Move down">↓</button>
            <button type="button" class="danger" onclick="Pipeline.edRemove(${i})" title="Remove stage">${this.ICONS.x}</button>` : ''}
          </div>
        </div>
        <div class="pipe-ed-sub">${timing}</div>
      </div>`;
    }).join('');
    Modal.show(`
      <div class="modal-title">Pipeline stages</div>
      <div style="font-size:13px;color:var(--muted);margin:-6px 0 14px;line-height:1.5;">
        Rename, recolor, reorder, or add the stages your leads move through.
        "Follow up after" flags a lead that sits in a stage too long.
        Removing a stage moves its leads back one stage.
      </div>
      ${rows}
      <button class="btn btn-full" onclick="Pipeline.edAdd()" style="margin-top:2px;">+ Add a stage</button>
      <div class="modal-actions">
        <button class="btn btn-primary btn-full" onclick="Pipeline.saveStages(this)">Save stages</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
  },

  // Inputs are uncontrolled — pull their current values into _edit before any
  // structural re-render (move/add/remove/recolor), or half-typed names vanish.
  _edSync() {
    this._edit.forEach((s, i) => {
      const label = document.getElementById('ed-label-' + i);
      if (label) s.label = label.value.trim().slice(0, 24) || s.label;
      if (!s.terminal) {
        const v = parseFloat(document.getElementById('ed-iv-' + i)?.value);
        const u = parseInt(document.getElementById('ed-unit-' + i)?.value, 10) || 1;
        s.interval = (v > 0) ? Math.round(v * u) : 0;
        const won = document.getElementById('ed-won-' + i);
        if (won) s.won = won.checked;
      }
    });
  },

  edColor(i) {
    this._edSync();
    const s = this._edit[i];
    const cur = this._PALETTE.indexOf(s.color);
    s.color = this._PALETTE[(cur + 1) % this._PALETTE.length];
    this._edRender();
  },

  edMove(i, d) {
    this._edSync();
    const j = i + d;
    if (!this._edit[j] || this._edit[i].fixed || this._edit[j].fixed) return;
    [this._edit[i], this._edit[j]] = [this._edit[j], this._edit[i]];
    this._edRender();
  },

  edRemove(i) {
    this._edSync();
    if (this._edit[i].fixed) return;
    this._edit.splice(i, 1);
    this._edRender();
  },

  edAdd() {
    this._edSync();
    const at = this._edit.findIndex(s => s.terminal);
    this._edit.splice(at < 0 ? this._edit.length : at, 0, {
      key: genId('stg'),
      label: 'New stage',
      color: this._PALETTE[this._edit.length % this._PALETTE.length],
      interval: 0,
    });
    this._edRender();
  },

  async saveStages(btn) {
    this._edSync();
    const stages = this._edit.map(s => ({
      key: s.key, label: s.label || 'Stage', color: s.color,
      interval: s.interval || 0, won: !!s.won, terminal: !!s.terminal, fixed: s.fixed,
    }));
    disableBtn(btn);
    try {
      // Leads sitting in a removed stage slide back to the nearest surviving
      // earlier stage, so nothing silently disappears off the board.
      const before = this.stages();
      const keep = new Set(stages.map(s => s.key));
      const fallbackFor = (key) => {
        for (let i = before.findIndex(s => s.key === key) - 1; i >= 0; i--) {
          if (keep.has(before[i].key)) return before[i].key;
        }
        return 'new';
      };
      const orphans = this._leads.filter(l => !keep.has(l.status) && before.some(s => s.key === l.status));
      await Promise.all(orphans.map(l => db.leads.update(l.id, { status: fallbackFor(l.status) })));

      const pipeline = { stages };
      await db.settings.save({ pipeline });
      Shop.settings.pipeline = pipeline;
      Modal.close();
      toast('Stages saved');
      this.render();
    } catch (e) {
      enableBtn(btn);
      toast(e.message || 'Could not save stages', 'error');
    }
  },
};

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

  stages() { return Leads.stageConfig(); },

  isActive() {
    const el = document.getElementById('page-pipeline');
    return !!el && el.classList.contains('active');
  },

  // 24×24 stroke icons (same visual language as the v2 nav).
  ICONS: {
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z"/></svg>',
    msg:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
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

  // Minutes the lead has sat in its current stage. stageChangedAt is stamped
  // server-side on every status change; older leads fall back to last contact.
  _ageMin(l) {
    const t = l.stageChangedAt || l.lastContactAt || l.createdAt;
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

  async render() {
    const el = document.getElementById('page-pipeline');
    if (!el) return;
    try { this._leads = await db.leads.all(); } catch (e) { this._leads = []; }

    const stages = this.stages();
    const leads = this._leads.filter(l => this._matchSource(l));
    const byStage = {};
    stages.forEach(s => { byStage[s.key] = []; });
    leads.forEach(l => byStage[this._stage(l).key].push(l));
    // Active columns: needs-follow-up first, then longest-waiting (FIFO).
    // Terminal columns: most recent first.
    stages.forEach(s => {
      byStage[s.key].sort(s.terminal
        ? (a, b) => this._ageMin(a) - this._ageMin(b)
        : (a, b) => {
            const oa = this._dueState(a) === 'over', ob = this._dueState(b) === 'over';
            if (oa !== ob) return oa ? -1 : 1;
            return this._ageMin(b) - this._ageMin(a);
          });
    });

    const openCount = stages.filter(s => !s.terminal).reduce((n, s) => n + byStage[s.key].length, 0);
    const overdue = leads.filter(l => this._dueState(l) === 'over').length;

    const srcChip = (key, label) => `<button class="lead-pill ${this._source === key ? 'active' : ''}" onclick="Pipeline.setSource('${key}')">${label}</button>`;
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
        <button class="btn btn-sm" onclick="Pipeline.stagesModal()">Edit stages</button>
      </div>
      <div class="pipe-chips">${srcChip('all', 'All')}${srcChip('meta', 'Meta')}${srcChip('website', 'Website')}${srcChip('call', 'Calls')}</div>
      <div class="pipe-chips pipe-jump">${stages.map(jumpPill).join('')}</div>`;

    const board = `<div class="pipe-board">${stages.map((s, i) => this._column(s, stages[i + 1] || null, byStage[s.key])).join('')}</div>`;

    // Keep the board's horizontal position across re-renders (advance, save…).
    const prev = el.querySelector('.pipe-board');
    const scrollLeft = prev ? prev.scrollLeft : 0;
    el.innerHTML = head + board;
    const nb = el.querySelector('.pipe-board');
    if (nb) nb.scrollLeft = scrollLeft;
  },

  _column(stage, nextStage, list) {
    // Terminal columns can grow forever — cap the render, keep the real count.
    const shown = stage.terminal ? list.slice(0, 20) : list;
    const more = list.length - shown.length;
    const timing = (!stage.terminal && stage.interval)
      ? `<span class="pipe-col-iv" title="Flagged for follow-up after ${this._fmtAge(stage.interval)} in this stage">${this._fmtAge(stage.interval)}</span>` : '';
    const cards = shown.length
      ? shown.map(l => this._card(l, stage, nextStage)).join('') + (more > 0 ? `<div class="pipe-more">+ ${more} more</div>` : '')
      : `<div class="pipe-empty">No leads here yet</div>`;
    return `<div class="pipe-col" id="pipe-col-${stage.key}">
      <div class="pipe-col-head">
        <span class="pipe-dot" style="background:${stage.color};"></span>
        <span class="pipe-col-title">${esc(stage.label)}</span>
        <span class="pipe-col-count">${list.length}</span>
        ${timing}
      </div>
      <div class="pipe-col-body">${cards}</div>
    </div>`;
  },

  _card(l, stage, nextStage) {
    // Never advance a lead into Lost — that's an explicit choice (the × button).
    const next = (!stage.terminal && nextStage && nextStage.fixed !== 'lost') ? nextStage : null;
    const due = this._dueState(l);
    const age = this._fmtAge(this._ageMin(l));
    const name = l.name || l.phone || 'Unknown';
    const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
    const svc = (l.servicesInterested || []).join(', ');
    const quoted = (l.ai && l.ai.quotedPrice != null) ? 'Quoted ' + fmtMoney(l.ai.quotedPrice) : '';
    const sub = [veh, svc, quoted].filter(Boolean).join(' · ') || l.phone || '';
    const src = Leads._sourceMeta(l.source).label;

    const ageChip = due === 'over'
      ? `<span class="pipe-age over" title="In ${esc(stage.label)} for ${age} — past your follow-up timing">${age} late</span>`
      : `<span class="pipe-age ${due === 'soon' ? 'soon' : ''}" title="In ${esc(stage.label)} for ${age}">${age}</span>`;

    const call = l.phone ? `<a class="pipe-act" href="tel:${esc(l.phone)}" onclick="event.stopPropagation()" title="Call" aria-label="Call">${this.ICONS.phone}</a>` : '';
    const text = l.phone ? `<button class="pipe-act" onclick="event.stopPropagation();Pipeline.text('${l.id}')" title="Text" aria-label="Text">${this.ICONS.msg}</button>` : '';
    const lose = !stage.terminal ? `<button class="pipe-act pipe-lose" onclick="event.stopPropagation();Pipeline.markLost('${l.id}')" title="Mark lost" aria-label="Mark lost">${this.ICONS.x}</button>` : '';
    const advance = next
      ? `<button class="pipe-advance" onclick="event.stopPropagation();Pipeline.advance('${l.id}',this)">${esc(next.label)} →</button>`
      : `<button class="pipe-advance ghost" onclick="event.stopPropagation();Pipeline.openLead('${l.id}')">Details</button>`;

    return `<div class="pipe-card ${due === 'over' ? 'overdue' : ''}" onclick="Pipeline.openLead('${l.id}')">
      <div class="pipe-card-top">
        <div class="pipe-card-name">${esc(name)}</div>
        ${ageChip}
      </div>
      <div class="pipe-card-sub">${src ? `<span class="pipe-src">${esc(src)}</span>` : ''}<span class="t" title="${esc(sub)}">${esc(sub)}</span></div>
      <div class="pipe-card-actions">${call}${text}${lose}${advance}</div>
    </div>`;
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
  },

  async markLost(id) {
    if (!confirm('Mark this lead as lost?')) return;
    const l = this._leads.find(x => x.id === id);
    if (l) await this._setStatus(l, 'lost', 'Marked lost');
  },

  async _setStatus(l, status, msg, btn) {
    if (btn) btn.disabled = true;
    try {
      await db.leads.update(l.id, { status });
      toast(msg);
    } catch (e) {
      toast(e.message || 'Could not update lead', 'error');
    }
    this.render();
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

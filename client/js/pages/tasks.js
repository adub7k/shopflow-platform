// ── Tasks — win-back / follow-up worklist ────────────────────────────────────
// A prioritized follow-up list that helps a detail shop regain lost business.
// Pulls from three sources and groups by urgency (Due today / Overdue / Upcoming
// / Snoozed):
//   1. At-risk win-backs — clients past the at-risk threshold, walked through an
//      owner-configurable cadence (editable day-offsets + per-step templates).
//   2. Service-due — ceramic inspection / interior / maintenance wash, reusing the
//      same heuristics as the client profile (_cpRecommendations).
//   3. Uncontacted leads — call-tracking leads still in status 'new'.
//
// NO new backend: follow-up state lives on the customer record (followup /
// dismissedRecs / recSnooze) and persists via db.customers.save(); the cadence
// config lives in settings.winback (db.settings.save merges it in); lead status
// moves via db.leads.update(). Texting uses the iPhone sms: deep link helper
// _cpSms() — no Twilio/A2P. The phone/call path is untouched.

// Add n days to a 'YYYY-MM-DD' date and return the same format (noon-anchored so
// DST never shifts the day — same convention as _cpDaysAgo).
function _tAddDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}
// First word of a name, for {first} substitution.
function _tFirst(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }
// Template substitution for message bodies: {first} / {name} / {shop}.
function _tFill(tpl, ctx) {
  return String(tpl || '')
    .replace(/\{first\}/g, ctx.first || 'there')
    .replace(/\{name\}/g,  ctx.name  || 'there')
    .replace(/\{shop\}/g,  ctx.shop  || 'us');
}

const Tasks = {
  _customers: [], _leads: [], _byCust: {}, _rebook: 21, _wb: null, _wbEdit: null,
  _tasks: {},   // taskId -> task, so action buttons can look one up by id

  // Default win-back cadence (Day 0 / 4 / 10). Used when settings.winback is absent.
  DEFAULT_WINBACK: {
    atRiskDays: 60,
    steps: [
      { day: 0,  label: 'Check-in', message: "Hi {first}, it's {shop} — we noticed it's been a while since your last detail. We'd love to get your vehicle looking its best again. Want to hop on the schedule?" },
      { day: 4,  label: 'Reminder', message: "Hi {first}, just following up from {shop}. We've got a few openings this week if you'd like to get your detail booked — reply here anytime!" },
      { day: 10, label: 'Offer',    message: "Hi {first}, we'd really love to see you back at {shop}. Book your next detail this month and we'll take extra-good care of you. Want me to set it up?" },
    ],
  },

  // Merge a stored settings.winback with the default (per-field, tolerant of partials).
  _winbackFrom(s) {
    const d = this.DEFAULT_WINBACK, w = (s && s.winback) || {};
    const steps = (Array.isArray(w.steps) && w.steps.length)
      ? w.steps.map(st => ({ day: Math.max(0, Number(st.day) || 0), label: st.label || 'Follow-up', message: st.message || '' }))
      : d.steps.map(st => ({ ...st }));
    return { atRiskDays: Math.max(1, Number(w.atRiskDays) || d.atRiskDays), steps };
  },

  async render() {
    const el = document.getElementById('page-tasks'); if (!el) return;
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading…</p></div>';
    try {
      const [customers, appointments, leads, settings] = await Promise.all([
        db.customers.all(),
        db.appointments.all(),
        db.leads.all().catch(() => []),
        db.settings.get(),
      ]);
      this._customers = customers || [];
      this._leads = leads || [];
      this._rebook = (settings && settings.rebookInterval) || 21;
      this._wb = this._winbackFrom(settings);
      // Group appointments by customer client-side (db.customers.all omits them).
      this._byCust = {};
      (appointments || []).forEach(a => { if (a.customerId) (this._byCust[a.customerId] = this._byCust[a.customerId] || []).push(a); });

      const groups = this._build();
      el.innerHTML = this._html(groups);
    } catch (e) {
      el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load follow-ups</p></div>';
    }
  },

  // ── Worklist assembly ───────────────────────────────────────────────────────
  // Returns { today, overdue, upcoming, snoozed } — each an array of task cards.
  _build() {
    this._tasks = {};
    const t0 = today();
    const shop = (Shop.settings && Shop.settings.shopName) || 'us';
    const groups = { today: [], overdue: [], upcoming: [], snoozed: [] };
    let n = 0;
    const add = (task, bucket) => { task.id = 'task' + (n++); this._tasks[task.id] = task; groups[bucket].push(task); };

    // 1. At-risk win-backs (owner-configurable cadence).
    const wb = this._wb;
    this._customers.forEach(c => {
      const fu = c.followup || {};
      if (fu.status === 'dismissed') return;
      if (!c.lastVisit) return;                          // never visited — not a win-back
      const dsl = _cpDaysAgo(c.lastVisit);
      if (dsl < wb.atRiskDays) return;                   // recovered — back inside the window
      const nextIdx = (fu.completedStep != null ? fu.completedStep : -1) + 1;
      if (nextIdx >= wb.steps.length) return;            // cadence exhausted
      const step = wb.steps[nextIdx];
      const dueDate = _tAddDays(c.lastVisit, wb.atRiskDays + (Number(step.day) || 0));
      const ctx = { first: _tFirst(c.name), name: c.name, shop };
      const task = {
        source: 'winback', custId: c.id, stepIdx: nextIdx, name: c.name, phone: c.phone,
        reason: `At-risk · ${dsl}d since last visit (${fmtDateShort(c.lastVisit)})`,
        detail: `Win-back step ${nextIdx + 1}/${wb.steps.length}: ${step.label}`,
        message: _tFill(step.message, ctx), dueDate,
      };
      const snoozed = fu.snoozeUntil && fu.snoozeUntil > t0;
      const bucket = snoozed ? 'snoozed' : (dueDate < t0 ? 'overdue' : (dueDate === t0 ? 'today' : 'upcoming'));
      add(task, bucket);
    });

    // 2. Service-due reminders (reuse the client-profile heuristics; the win-back
    //    rec is dropped — the cadence above owns win-back).
    this._customers.forEach(c => {
      const done = (this._byCust[c.id] || []).filter(a => a.status === 'done').sort((a, b) => b.date.localeCompare(a.date));
      if (!done.length) return;
      const dsl = c.lastVisit ? _cpDaysAgo(c.lastVisit) : null;
      const recs = _cpRecommendations(done, this._rebook, dsl).filter(r => r.title !== 'Win-back campaign');
      const dismissed = c.dismissedRecs || [];
      const snz = c.recSnooze || {};
      const ctx = { first: _tFirst(c.name), name: c.name, shop };
      recs.forEach(r => {
        if (dismissed.includes(r.title)) return;
        const task = {
          source: 'service', custId: c.id, recTitle: r.title, name: c.name, phone: c.phone,
          reason: `${r.icon} ${r.title}`, detail: r.detail,
          message: _tFill(r.sms, ctx), dueDate: t0,
        };
        const snoozed = snz[r.title] && snz[r.title] > t0;
        add(task, snoozed ? 'snoozed' : 'today');
      });
    });

    // 3. Uncontacted leads (status 'new' from call tracking).
    this._leads.filter(l => l.status === 'new').forEach(l => {
      const name = l.name || l.phone || 'Unknown caller';
      const ld = ((l.createdAt || l.firstContactAt || l.lastContactAt || '') + '').split('T')[0] || t0;
      const ctx = { first: _tFirst(l.name) || 'there', name: l.name || 'there', shop };
      const calls = (l.callCount || 1);
      const task = {
        source: 'lead', leadId: l.id, name, phone: l.phone,
        reason: `New lead · ${l.location || 'inbound call'}`,
        detail: `${calls} call${calls === 1 ? '' : 's'} · ${fmtDateShort(ld)}`,
        message: _tFill("Hi {first}, thanks for reaching out to {shop}! How can we help with your vehicle? Happy to get you on the schedule.", ctx),
        dueDate: ld,
      };
      add(task, ld < t0 ? 'overdue' : 'today');
    });

    // Sort each bucket by due date (most urgent first).
    Object.values(groups).forEach(arr => arr.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '')));
    return groups;
  },

  // ── Rendering ───────────────────────────────────────────────────────────────
  _html(groups) {
    const total = groups.today.length + groups.overdue.length + groups.upcoming.length + groups.snoozed.length;
    const out = [];
    out.push('<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;">'
      + '<div class="section-header" style="margin:0;">Follow-ups</div>'
      + '<button class="btn btn-sm" onclick="Tasks.cadenceModal()">⚙ Cadence</button></div>');

    if (!total) {
      out.push('<div class="card empty-state"><div class="empty-icon">✓</div>'
        + '<div class="empty-text">You\'re all caught up. New win-backs, service reminders, and uncontacted leads will show up here.</div></div>');
      return out.join('');
    }

    const SECTIONS = [
      ['today',    'Due today',  'badge-green'],
      ['overdue',  'Overdue',    'badge-red'],
      ['upcoming', 'Upcoming',   'badge-gray'],
      ['snoozed',  'Snoozed',    'badge-yellow'],
    ];
    SECTIONS.forEach(([key, label, badge]) => {
      const arr = groups[key]; if (!arr.length) return;
      out.push('<div class="section-header" style="margin:18px 0 8px;">' + label
        + ' <span class="badge ' + badge + '">' + arr.length + '</span></div>');
      arr.forEach(t => out.push(this._card(t)));
    });
    return out.join('');
  },

  _card(t) {
    const SRC = {
      winback: ['badge-blue', 'Win-back'],
      service: ['badge-green', 'Service due'],
      lead:    ['badge-yellow', 'New lead'],
    }[t.source];
    const id = t.id;
    const acts = [];
    // Text + Call are always available (no-op state); the rest mutate.
    acts.push('<button class="btn btn-sm btn-green" onclick="Tasks.text(\'' + id + '\')">💬 Text</button>');
    if (t.phone) acts.push('<button class="btn btn-sm" onclick="Tasks.call(\'' + id + '\')">📞 Call</button>');
    acts.push('<button class="btn btn-sm" onclick="Tasks.done(\'' + id + '\')">✓ Done</button>');
    if (t.source !== 'lead') acts.push('<button class="btn btn-sm" onclick="Tasks.snooze(\'' + id + '\')">⏰ Snooze</button>');
    acts.push('<button class="btn btn-sm btn-danger" onclick="Tasks.dismiss(\'' + id + '\')">✕</button>');

    return '<div class="card" style="margin-bottom:10px;">'
      + '<div style="display:flex;gap:10px;align-items:flex-start;">'
      +   avatarEl(t.name, 40)
      +   '<div style="flex:1;min-width:0;">'
      +     '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">'
      +       '<div style="font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.name) + '</div>'
      +       '<span class="badge ' + SRC[0] + '" style="flex:none;">' + SRC[1] + '</span>'
      +     '</div>'
      +     '<div style="font-size:13px;color:var(--muted);margin-top:2px;">' + esc(t.reason) + '</div>'
      +     (t.detail ? '<div style="font-size:12px;color:var(--faint);margin-top:2px;">' + esc(t.detail) + '</div>' : '')
      +   '</div>'
      + '</div>'
      + '<div style="margin-top:8px;padding:8px 10px;background:var(--bg,#f9fafb);border-radius:8px;font-size:13px;color:#374151;line-height:1.4;">' + esc(t.message) + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">' + acts.join('') + '</div>'
      + '</div>';
  },

  // ── Lookups + persistence helpers ───────────────────────────────────────────
  _cust(id) { return this._customers.find(c => c.id === id); },
  _ensureFollowup(c) { if (!c.followup) c.followup = { completedStep: -1, snoozeUntil: null, status: 'active' }; return c.followup; },

  // ── Card actions ────────────────────────────────────────────────────────────
  text(id) {
    const t = this._tasks[id]; if (!t) return;
    _cpSms(t.phone, t.message);                 // opens Messages (iPhone sms: deep link)
    // Texting a win-back step counts as completing it → advance the cadence.
    if (t.source === 'winback') {
      const c = this._cust(t.custId); if (!c) return;
      const fu = this._ensureFollowup(c);
      if (fu.completedStep < t.stepIdx) { fu.completedStep = t.stepIdx; fu.snoozeUntil = null; this._persistCust(c); }
    }
  },

  call(id) {
    const t = this._tasks[id]; if (!t || !t.phone) return;
    window.location.href = 'tel:' + String(t.phone).replace(/[^\d+]/g, '');
  },

  async done(id) {
    const t = this._tasks[id]; if (!t) return;
    if (typeof canWrite === 'function' && !canWrite()) { toast('Read-only access', 'warning'); return; }
    if (t.source === 'winback') {
      const c = this._cust(t.custId); if (!c) return;
      const fu = this._ensureFollowup(c); fu.completedStep = t.stepIdx; fu.snoozeUntil = null;
      await this._persistCust(c, 'Marked done ✓');
    } else if (t.source === 'service') {
      const c = this._cust(t.custId); if (!c) return;
      c.dismissedRecs = (c.dismissedRecs || []).concat(t.recTitle);
      await this._persistCust(c, 'Marked done ✓');
    } else if (t.source === 'lead') {
      await this._persistLead(t.leadId, { status: 'contacted' }, 'Lead contacted ✓');
    }
  },

  async snooze(id) {
    const t = this._tasks[id]; if (!t) return;
    if (typeof canWrite === 'function' && !canWrite()) { toast('Read-only access', 'warning'); return; }
    const until = _tAddDays(today(), 3);
    if (t.source === 'winback') {
      const c = this._cust(t.custId); if (!c) return;
      this._ensureFollowup(c).snoozeUntil = until;
      await this._persistCust(c, 'Snoozed 3 days');
    } else if (t.source === 'service') {
      const c = this._cust(t.custId); if (!c) return;
      c.recSnooze = c.recSnooze || {}; c.recSnooze[t.recTitle] = until;
      await this._persistCust(c, 'Snoozed 3 days');
    }
  },

  async dismiss(id) {
    const t = this._tasks[id]; if (!t) return;
    if (typeof canWrite === 'function' && !canWrite()) { toast('Read-only access', 'warning'); return; }
    if (t.source === 'winback') {
      const c = this._cust(t.custId); if (!c) return;
      this._ensureFollowup(c).status = 'dismissed';
      await this._persistCust(c, 'Dismissed');
    } else if (t.source === 'service') {
      const c = this._cust(t.custId); if (!c) return;
      c.dismissedRecs = (c.dismissedRecs || []).concat(t.recTitle);
      await this._persistCust(c, 'Dismissed');
    } else if (t.source === 'lead') {
      await this._persistLead(t.leadId, { status: 'closed' }, 'Dismissed');
    }
  },

  async _persistCust(c, msg) {
    try { await db.customers.save(c); if (msg) toast(msg); this.render(); }
    catch (e) { toast(e.message || 'Could not save', 'error'); }
  },
  async _persistLead(id, body, msg) {
    try {
      await db.leads.update(id, body);
      const l = this._leads.find(x => x.id === id); if (l) Object.assign(l, body);
      if (msg) toast(msg); this.render();
    } catch (e) { toast(e.message || 'Could not save', 'error'); }
  },

  // ── Cadence settings modal (owner-configurable day-offsets + templates) ──────
  cadenceModal() {
    if (typeof canWrite === 'function' && !canWrite()) { toast('Read-only access', 'warning'); return; }
    this._wbEdit = JSON.parse(JSON.stringify(this._wb || this._winbackFrom(Shop.settings)));
    this._renderCadence();
  },

  _renderCadence() {
    const wb = this._wbEdit;
    const steps = wb.steps.map((s, i) =>
      '<div class="card" style="padding:10px;margin-bottom:8px;">'
      + '<div class="form-row" style="align-items:flex-end;">'
      +   '<div class="form-group" style="flex:0 0 80px;margin-bottom:8px;"><label class="form-label">Day</label><input class="form-input" id="wb-day-' + i + '" type="number" min="0" value="' + esc(s.day) + '"></div>'
      +   '<div class="form-group" style="flex:1;margin-bottom:8px;"><label class="form-label">Label</label><input class="form-input" id="wb-label-' + i + '" value="' + esc(s.label) + '"></div>'
      +   (wb.steps.length > 1 ? '<button class="btn btn-sm btn-danger" style="margin-bottom:8px;" onclick="Tasks._delStep(' + i + ')">✕</button>' : '')
      + '</div>'
      + '<div class="form-group" style="margin-bottom:0;"><label class="form-label">Message <span style="color:var(--faint);font-weight:400;">— {first} {name} {shop}</span></label>'
      +   '<textarea class="form-input" id="wb-msg-' + i + '" rows="3">' + esc(s.message) + '</textarea></div>'
      + '</div>').join('');

    Modal.show('<div class="modal-title">Win-back cadence</div>'
      + '<p style="font-size:13px;color:var(--muted);margin:-4px 0 12px;">Reach out to at-risk clients on a schedule. Each step\'s day is counted from when a client crosses the at-risk threshold.</p>'
      + '<div class="form-group"><label class="form-label">At-risk after (days since last visit)</label>'
      +   '<input class="form-input" id="wb-atrisk" type="number" min="1" value="' + esc(wb.atRiskDays) + '"></div>'
      + '<div class="form-label" style="margin-bottom:6px;">Steps</div>'
      + steps
      + '<button class="btn btn-sm" style="margin-bottom:12px;" onclick="Tasks._addStep()">+ Add step</button>'
      + '<div class="modal-actions"><button class="btn" onclick="Modal.close()">Cancel</button>'
      +   '<button class="btn btn-green" onclick="Tasks.saveCadence(this)">Save</button></div>');
  },

  // Read the live inputs back into the working copy (so add/remove keep edits).
  _syncCadence() {
    const wb = this._wbEdit;
    const at = document.getElementById('wb-atrisk'); if (at) wb.atRiskDays = Math.max(1, Number(at.value) || 60);
    wb.steps.forEach((s, i) => {
      const d = document.getElementById('wb-day-' + i);   if (d) s.day = Math.max(0, Number(d.value) || 0);
      const l = document.getElementById('wb-label-' + i); if (l) s.label = l.value;
      const m = document.getElementById('wb-msg-' + i);   if (m) s.message = m.value;
    });
  },

  _addStep() {
    this._syncCadence();
    const last = this._wbEdit.steps[this._wbEdit.steps.length - 1];
    this._wbEdit.steps.push({ day: last ? Number(last.day) + 4 : 0, label: 'Follow-up', message: '' });
    this._renderCadence();
  },

  _delStep(i) {
    this._syncCadence();
    this._wbEdit.steps.splice(i, 1);
    this._renderCadence();
  },

  async saveCadence(btn) {
    this._syncCadence();
    const wb = this._wbEdit;
    if (!wb.steps.length) { toast('Add at least one step', 'error'); return; }
    wb.steps.sort((a, b) => a.day - b.day);
    disableBtn(btn);
    try {
      await db.settings.save({ winback: wb });   // POST /settings merges (assign) — other settings preserved
      if (Shop.settings) Shop.settings.winback = wb;
      this._wb = wb;
      Modal.close(); toast('Cadence saved ✓'); this.render();
    } catch (e) { enableBtn(btn); toast(e.message || 'Could not save', 'error'); }
  },
};

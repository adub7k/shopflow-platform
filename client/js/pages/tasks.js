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
// A customer's notes for the owner to read while working a task: the two most
// recent log entries plus any legacy free-text note, newest first.
function _notesFor(c) {
  const parts = (c.noteLog || []).slice(0, 2).map(n => n && n.text).filter(Boolean);
  if (c.notes) parts.push(c.notes);
  return parts.join('\n');
}

const Tasks = {
  _customers: [], _leads: [], _appts: [], _byCust: {}, _rebook: 21, _wb: null, _wbEdit: null,
  _tasks: {},   // taskId -> task, so action buttons can look one up by id
  _remDone: {}, // apptId -> true: reminders the owner handled this session (no backend)

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
      this._appts = appointments || [];
      this._rebook = (settings && settings.rebookInterval) || 21;
      this._wb = this._winbackFrom(settings);
      // Group appointments by customer client-side (db.customers.all omits them).
      this._byCust = {};
      this._appts.forEach(a => { if (a.customerId) (this._byCust[a.customerId] = this._byCust[a.customerId] || []).push(a); });

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

    // 0. 30-day follow-up sequence (Meta leads) — the TODAY queue. A lead shows
    //    only while its next step is due; sending (or skipping) pushes nextAt
    //    forward and the card disappears until the next step comes due. Config
    //    + per-lead state live in leads.js (Leads.followUpSeq / lead.followUp).
    const fuSeq = Leads.followUpSeq();
    const nowIso = new Date().toISOString();
    const fuStats = { entered: 0, active: 0, paused: 0, booked: 0, done: 0, due: 0, sentToday: 0 };
    const stageCfg = Leads.stageConfig();
    const chaseable = (l) => { const s = stageCfg.find(x => x.key === l.status); return !s || (!s.terminal && !s.won); };
    const META_SRC = ['facebook', 'instagram', 'meta', 'fb', 'ig'];
    this._fuUnenrolled = this._leads.filter(l => !l.followUp && chaseable(l) && META_SRC.includes(String(l.source || '').toLowerCase()));
    this._leads.forEach(l => {
      const fu = l.followUp;
      if (!fu || !fu.status) return;
      fuStats.entered++;
      if (fu.status === 'paused') fuStats.paused++;
      if (fu.status === 'completed') fuStats.booked++;
      if (fu.status === 'done') fuStats.done++;
      (fu.log || []).forEach(e => { if (!e.skipped && String(e.at || '').slice(0, 10) === t0) fuStats.sentToday++; });
      if (fu.status !== 'active') return;
      fuStats.active++;
      if (!chaseable(l)) return;
      const step = fuSeq[fu.idx];
      if (!step) return;
      const due = fu.nextAt || l.createdAt || nowIso;
      if (due > nowIso) return;                          // not due yet — resurfaces on its date
      fuStats.due++;
      const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
      const dueDate = String(due).split('T')[0];
      add({
        source: 'sequence', leadId: l.id, name: l.name || l.phone || 'Lead', phone: l.phone,
        step, reason: [veh, l.phone].filter(Boolean).join(' · '),
        detail: dueDate < t0 ? 'Overdue — was due ' + fmtDateShort(dueDate) : 'Due today',
        dueDate,
      }, dueDate < t0 ? 'overdue' : 'today');
    });
    this._fuStats = fuStats;

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
        notes: _notesFor(c),
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
          notes: _notesFor(c),
          message: _tFill(r.sms, ctx), dueDate: t0,
        };
        const snoozed = snz[r.title] && snz[r.title] > t0;
        add(task, snoozed ? 'snoozed' : 'today');
      });
    });

    // 3. Uncontacted leads (status 'new' from call tracking). Leads in the
    //    30-day sequence are excluded — the sequence queue above owns them.
    this._leads.filter(l => l.status === 'new' && !(l.followUp && l.followUp.status)).forEach(l => {
      const name = l.name || l.phone || 'Unknown caller';
      const ld = ((l.createdAt || l.firstContactAt || l.lastContactAt || '') + '').split('T')[0] || t0;
      const ctx = { first: _tFirst(l.name) || 'there', name: l.name || 'there', shop };
      const calls = (l.callCount || 1);
      const task = {
        source: 'lead', leadId: l.id, name, phone: l.phone,
        reason: `New lead · ${l.location || 'inbound call'}`,
        detail: `${calls} call${calls === 1 ? '' : 's'} · ${fmtDateShort(ld)}`,
        notes: l.notes || '',
        message: _tFill("Hi {first}, thanks for reaching out to {shop}! How can we help with your vehicle? Happy to get you on the schedule.", ctx),
        dueDate: ld,
      };
      add(task, ld < t0 ? 'overdue' : 'today');
    });

    // 4. Tomorrow's appointment reminders — the "text tonight" worklist that
    //    replaced the old automatic 24-hour reminder (no A2P → owner texts by hand).
    //    Pulls from the shop's editable "reminder" template; handled items are
    //    hidden for the session via _remDone (no backend write for a daily list).
    const tomorrow = _tAddDays(t0, 1);
    const reminderTpl = _smsTemplateBody('reminder');
    this._appts
      .filter(a => a.date === tomorrow && a.status === 'confirmed' && a.customerPhone && !this._remDone[a.id])
      .forEach(a => {
        const ctx = { first: _tFirst(a.customerName), name: a.customerName || 'there', shop,
                      date: fmtDateFull(a.date), time: a.time || '', service: a.service || '' };
        const task = {
          source: 'reminder', apptId: a.id, name: a.customerName || 'Client', phone: a.customerPhone,
          reason: `Appointment tomorrow${a.time ? ' · ' + a.time : ''}`,
          detail: [a.service, fmtDateShort(a.date)].filter(Boolean).join(' · '),
          notes: a.notes || '',
          message: _smsFill(reminderTpl, ctx), dueDate: t0,
        };
        add(task, 'today');
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
      + '<div style="display:flex;gap:6px;">'
      +   '<button class="btn btn-sm' + (this._selMode ? ' btn-primary' : '') + '" onclick="Tasks.toggleSelMode()">' + (this._selMode ? 'Done' : 'Select') + '</button>'
      +   '<button class="btn btn-sm" onclick="Tasks.cadenceModal()">⚙ Cadence</button>'
      + '</div></div>');

    // 30-day sequence metrics + enrollment prompt (only once any lead is in it,
    // or there are Meta leads waiting to be enrolled).
    const fs = this._fuStats || {};
    if (fs.entered || (this._fuUnenrolled || []).length) {
      const rate = fs.entered ? Math.round((fs.booked / fs.entered) * 100) : 0;
      const stat = (v, label, color) => '<div style="flex:1;min-width:78px;"><div style="font-size:19px;font-weight:800;letter-spacing:-.02em;color:' + (color || 'var(--text)') + ';">' + v + '</div><div style="font-size:11px;color:var(--faint);">' + label + '</div></div>';
      out.push('<div class="card" style="margin-bottom:12px;">'
        + '<div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;margin-bottom:8px;">30-DAY SEQUENCE</div>'
        + '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
        +   stat(fs.due || 0, 'due today', fs.due ? 'var(--red)' : 'var(--text)')
        +   stat(fs.sentToday || 0, 'sent today')
        +   stat(fs.active || 0, 'in sequence')
        +   stat(fs.paused || 0, 'paused', fs.paused ? 'var(--orange)' : 'var(--text)')
        +   stat((fs.booked || 0) + (fs.entered ? ' (' + rate + '%)' : ''), 'booked', 'var(--green)')
        + '</div>'
        + ((this._fuUnenrolled || []).length
          ? '<div style="display:flex;align-items:center;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">'
            + '<div style="flex:1;font-size:13px;color:var(--muted);">' + this._fuUnenrolled.length + ' Meta lead' + (this._fuUnenrolled.length === 1 ? '' : 's') + ' not in the sequence yet.</div>'
            + '<button class="btn btn-sm btn-green" onclick="Tasks.fuEnrollAll(this)">Start sequence</button></div>'
          : '')
        + '</div>');
    }

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
    out.push(this._selBarHtml());
    return out.join('');
  },

  _card(t) {
    // 30-day sequence cards: the step IS the task — one green button sends it.
    if (t.source === 'sequence') {
      const acts = [
        '<button class="btn btn-sm btn-green" onclick="Tasks.fuSend(\'' + t.id + '\')">Send follow-up</button>',
        t.phone ? '<button class="btn btn-sm" onclick="Tasks.call(\'' + t.id + '\')">Call</button>' : '',
        '<button class="btn btn-sm" onclick="Tasks.fuMark(\'' + t.id + '\',\'replied\')">Replied</button>',
        '<button class="btn btn-sm" onclick="Tasks.fuMark(\'' + t.id + '\',\'skip\')">Skip</button>',
      ].filter(Boolean).join('');
      return '<div class="card ' + (this._sel.has(t.id) ? 'on' : '') + '" data-selrow="' + t.id + '" style="margin-bottom:10px;">'
        + '<div style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;" onclick="' + (this._selMode ? 'Tasks.selToggle(\'' + t.id + '\')' : 'Tasks.fuOpen(\'' + t.id + '\')') + '">'
        +   this._selCb(t)
        +   avatarEl(t.name, 40)
        +   '<div style="flex:1;min-width:0;">'
        +     '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">'
        +       '<div style="font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.name) + '</div>'
        +       '<span class="badge badge-yellow" style="flex:none;">' + esc(t.step.label) + '</span>'
        +     '</div>'
        +     (t.reason ? '<div style="font-size:13px;color:var(--muted);margin-top:2px;">' + esc(t.reason) + '</div>' : '')
        +     '<div style="font-size:12px;font-weight:600;color:' + (t.detail === 'Due today' ? 'var(--green)' : 'var(--red)') + ';margin-top:2px;">' + esc(t.detail) + '</div>'
        +   '</div>'
        + '</div>'
        + (this._selMode ? '' : '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">' + acts + '</div>')
        + '</div>';
    }
    const SRC = {
      winback:  ['badge-blue', 'Win-back'],
      service:  ['badge-green', 'Service due'],
      lead:     ['badge-yellow', 'New lead'],
      reminder: ['badge-green', 'Reminder'],
    }[t.source];
    const id = t.id;
    const acts = [];
    // Text + Call are always available (no-op state); the rest mutate.
    acts.push('<button class="btn btn-sm btn-green" onclick="Tasks.text(\'' + id + '\')">💬 Text</button>');
    if (t.phone) acts.push('<button class="btn btn-sm" onclick="Tasks.call(\'' + id + '\')">📞 Call</button>');
    acts.push('<button class="btn btn-sm" onclick="Tasks.done(\'' + id + '\')">✓ Done</button>');
    if (t.source !== 'lead' && t.source !== 'reminder') acts.push('<button class="btn btn-sm" onclick="Tasks.snooze(\'' + id + '\')">⏰ Snooze</button>');
    acts.push('<button class="btn btn-sm btn-danger" onclick="Tasks.dismiss(\'' + id + '\')">✕</button>');

    return '<div class="card ' + (this._sel.has(t.id) ? 'on' : '') + '" data-selrow="' + t.id + '" style="margin-bottom:10px;"' + (this._selMode ? ' onclick="Tasks.selToggle(\'' + t.id + '\')"' : '') + '>'
      + '<div style="display:flex;gap:10px;align-items:flex-start;">'
      +   this._selCb(t)
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
      // Notes for the owner to read while working the task (not the message — that
      // gets picked from a template when they hit Text).
      + (t.notes
          ? '<div style="margin-top:8px;padding:8px 10px;background:var(--bg,#f9fafb);border-radius:8px;font-size:13px;color:#374151;line-height:1.4;white-space:pre-wrap;"><span style="font-weight:700;color:var(--muted);">📝 Notes:</span> ' + esc(t.notes) + '</div>'
          : '<div style="margin-top:8px;font-size:12px;color:var(--faint);font-style:italic;">No notes yet.</div>')
      + (this._selMode ? '' : '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">' + acts.join('') + '</div>')
      + '</div>';
  },

  // ── Lookups + persistence helpers ───────────────────────────────────────────
  _cust(id) { return this._customers.find(c => c.id === id); },
  _ensureFollowup(c) { if (!c.followup) c.followup = { completedStep: -1, snoozeUntil: null, status: 'active' }; return c.followup; },

  // ── Select mode (bulk clean-out of the task queue) ──────────────────────────
  // Same pattern as the Leads list: checkboxes on every card + a sticky bar.
  // Dismiss uses each task type's own semantics (win-back → dismissed, service
  // → dismissed rec, lead → lost, reminder → cleared, sequence → stopped).
  _selMode: false,
  _sel: new Set(),
  toggleSelMode() { this._selMode = !this._selMode; this._sel = new Set(); this.render(); },
  selToggle(id) {
    if (this._sel.has(id)) this._sel.delete(id); else this._sel.add(id);
    const on = this._sel.has(id);
    document.querySelectorAll('[data-selrow="' + id + '"]').forEach(r => {
      r.classList.toggle('on', on);
      const cb = r.querySelector('input.tk-cb'); if (cb) cb.checked = on;
    });
    const c = document.getElementById('tk-sel-count'); if (c) c.textContent = this._sel.size + ' selected';
  },
  selAll() {
    const all = Object.keys(this._tasks || {});
    const everything = all.length && all.every(id => this._sel.has(id));
    this._sel = everything ? new Set() : new Set(all);
    this.render();
  },
  _selCb(t) {
    if (!this._selMode) return '';
    return '<input type="checkbox" class="tk-cb" ' + (this._sel.has(t.id) ? 'checked' : '') + ' onclick="event.stopPropagation();Tasks.selToggle(\'' + t.id + '\')">';
  },
  _selBarHtml() {
    if (!this._selMode) return '';
    return '<div class="ld-selbar">'
      + '<button class="btn btn-sm" onclick="Tasks.selAll()">All</button>'
      + '<span id="tk-sel-count" style="font-size:12.5px;font-weight:700;white-space:nowrap;flex:1;">' + this._sel.size + ' selected</span>'
      + '<button class="btn btn-sm" onclick="Tasks.selApply(\'skip\')">Skip step</button>'
      + '<button class="btn btn-sm" onclick="Tasks.selApply(\'lost\')">Mark lost</button>'
      + '<button class="btn btn-sm btn-danger" onclick="Tasks.selApply(\'dismiss\')">Dismiss</button>'
      + '</div>';
  },
  async selApply(kind) {
    const tasks = [...this._sel].map(id => this._tasks[id]).filter(Boolean);
    if (!tasks.length) { toast('Nothing selected', 'warning'); return; }
    if (typeof canWrite === 'function' && !canWrite()) { toast('Read-only access', 'warning'); return; }
    try {
      if (kind === 'lost') {
        const ids = [...new Set(tasks.filter(t => t.leadId).map(t => t.leadId))];
        if (!ids.length) { toast('No lead tasks selected', 'warning'); return; }
        await db.leads.bulkStatus(ids, 'lost');   // also auto-stops their sequences
        toast(ids.length + ' marked lost');
      } else if (kind === 'skip') {
        const seqTasks = tasks.filter(t => t.source === 'sequence');
        if (!seqTasks.length) { toast('No sequence tasks selected', 'warning'); return; }
        const seq = Leads.followUpSeq();
        const now = new Date().toISOString();
        await Promise.all(seqTasks.map(t => {
          const l = this._leads.find(x => x.id === t.leadId);
          if (!l || !l.followUp) return null;
          const fu = l.followUp, st = seq[fu.idx];
          if (!st) return null;
          fu.log = (fu.log || []).concat({ step: st.label, day: st.day, at: now, by: (Auth.getName && Auth.getName()) || '', skipped: true });
          fu.idx += 1;
          fu.nextAt = Leads.fuNextAt(seq, fu.idx - 1, now);
          if (fu.idx >= seq.length) { fu.status = 'done'; fu.nextAt = null; }
          return db.leads.update(l.id, { followUp: fu });
        }));
        toast(seqTasks.length + ' step' + (seqTasks.length === 1 ? '' : 's') + ' skipped');
      } else if (kind === 'dismiss') {
        const custSaves = new Map();
        const leadOps = [];
        tasks.forEach(t => {
          if (t.source === 'winback') { const c = this._cust(t.custId); if (c) { this._ensureFollowup(c).status = 'dismissed'; custSaves.set(c.id, c); } }
          else if (t.source === 'service') { const c = this._cust(t.custId); if (c) { c.dismissedRecs = (c.dismissedRecs || []).concat(t.recTitle); custSaves.set(c.id, c); } }
          else if (t.source === 'lead') leadOps.push(db.leads.update(t.leadId, { status: 'lost' }));
          else if (t.source === 'reminder') this._remDone[t.apptId] = true;
          else if (t.source === 'sequence') { const l = this._leads.find(x => x.id === t.leadId); if (l && l.followUp) { l.followUp.status = 'stopped'; leadOps.push(db.leads.update(l.id, { followUp: l.followUp })); } }
        });
        await Promise.all([...custSaves.values()].map(c => db.customers.save(c)).concat(leadOps));
        toast(tasks.length + ' dismissed');
      }
    } catch (e) { toast(e.message || 'Bulk action failed', 'error'); return; }
    this._sel = new Set();
    this.render();   // stay in select mode — keep sweeping
  },

  // ── 30-day sequence actions ─────────────────────────────────────────────────
  _fuLead(taskId) {
    const t = this._tasks[taskId];
    return t ? this._leads.find(x => x.id === t.leadId) : null;
  },
  fuOpen(taskId) {
    const l = this._fuLead(taskId); if (!l) return;
    Leads._leads = this._leads;    // full lead modal (history card included)
    Leads.open(l.id);
  },
  // Preview → edit → send: opens Messages prefilled (manual send, like all
  // texting here), then advances the sequence so the card leaves today's queue.
  _fuTask: null,
  fuSend(taskId) {
    const l = this._fuLead(taskId); if (!l) return;
    if (!l.phone) { toast('No phone number on file', 'warning'); return; }
    const step = Leads.followUpSeq()[(l.followUp || {}).idx];
    if (!step) return;
    this._fuTask = taskId;
    Modal.show(
      '<div class="modal-title">' + esc(step.label) + ' — ' + esc(l.name || l.phone) + '</div>'
      + '<div class="form-group"><label class="form-label">Message <span style="font-weight:400;color:var(--muted);">(edit before sending)</span></label>'
      +   '<textarea class="form-input" id="fu-body" rows="5">' + esc(Leads.fuFill(step.sms, l)) + '</textarea></div>'
      + '<div style="font-size:12px;color:var(--faint);margin:-6px 0 10px;">Opens your Messages app prefilled — you hit send.</div>'
      + '<button class="btn btn-green btn-full" onclick="Tasks.fuSendConfirm()">Send</button>'
      + '<div class="modal-actions"><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>'
    );
  },
  async fuSendConfirm() {
    const l = this._fuLead(this._fuTask);
    if (!l || !l.followUp) return;
    const body = (document.getElementById('fu-body') || {}).value || '';
    if (!body.trim()) { toast('Message is empty', 'warning'); return; }
    Modal.close();
    _cpSms(l.phone, body.trim());
    const seq = Leads.followUpSeq();
    const fu = l.followUp;
    const step = seq[fu.idx];
    if (!step) return;
    const now = new Date().toISOString();
    fu.log = (fu.log || []).concat({ step: step.label, day: step.day, body: body.trim().slice(0, 500), at: now, by: (Auth.getName && Auth.getName()) || '' });
    fu.idx += 1;
    fu.nextAt = Leads.fuNextAt(seq, fu.idx - 1, now);
    let msg;
    if (fu.idx >= seq.length) { fu.status = 'done'; fu.nextAt = null; msg = '✓ Sent — sequence finished (day 30)'; }
    else msg = '✓ Follow-up sent · Next: ' + seq[fu.idx].label + ' — ' + fmtDateShort(fu.nextAt.split('T')[0]);
    try { await db.leads.update(l.id, { followUp: fu }); } catch (e) { toast(e.message || 'Could not save', 'error'); return; }
    toast(msg);
    this.render();   // the card leaves today's queue
  },
  async fuMark(taskId, act) {
    const l = this._fuLead(taskId);
    if (!l || !l.followUp) return;
    const fu = l.followUp;
    const seq = Leads.followUpSeq();
    const now = new Date().toISOString();
    if (act === 'replied') { fu.status = 'paused'; fu.pausedReason = 'replied'; }
    else if (act === 'skip') {
      const step = seq[fu.idx]; if (!step) return;
      fu.log = (fu.log || []).concat({ step: step.label, day: step.day, at: now, by: (Auth.getName && Auth.getName()) || '', skipped: true });
      fu.idx += 1;
      fu.nextAt = Leads.fuNextAt(seq, fu.idx - 1, now);
      if (fu.idx >= seq.length) { fu.status = 'done'; fu.nextAt = null; }
    } else return;
    try { await db.leads.update(l.id, { followUp: fu }); toast(act === 'replied' ? 'Paused — customer replied' : 'Skipped ✓'); } catch (e) { toast(e.message || 'Could not save', 'error'); }
    this.render();
  },
  async fuEnrollAll(btn) {
    const list = this._fuUnenrolled || [];
    if (!list.length) return;
    disableBtn(btn);
    try {
      await Promise.all(list.map(l => db.leads.update(l.id, { followUp: Leads.fuFreshState() })));
      toast(list.length + ' lead' + (list.length === 1 ? '' : 's') + ' enrolled — Day 0 due now');
    } catch (e) { toast(e.message || 'Could not enroll', 'error'); }
    this.render();
  },

  // ── Card actions ────────────────────────────────────────────────────────────
  // Hitting Text opens a template picker: the tailored suggestion is preselected,
  // but the owner can switch to any saved template, tweak it, then open Messages.
  _textTask: null, _textOpts: [],

  text(id) {
    const t = this._tasks[id]; if (!t) return;
    if (!t.phone) { toast('No phone number on file', 'warning'); return; }
    this._textTask = id;
    // First option is the smart suggestion; the rest are the owner's templates.
    this._textOpts = [{ label: 'Suggested message', body: t.message }].concat(_smsTemplates());
    Modal.show(
      '<div class="modal-title">Text ' + esc(t.name) + '</div>'
      + '<div class="form-group"><label class="form-label">Template</label>'
      +   '<select class="form-input" id="task-tpl" onchange="Tasks._fillText()">'
      +     this._textOpts.map((o, i) => `<option value="${i}">${esc(o.label)}</option>`).join('')
      +   '</select></div>'
      + '<div class="form-group"><label class="form-label">Message <span style="font-weight:400;color:var(--muted);">(edit as needed)</span></label>'
      +   '<textarea class="form-input" id="task-body" rows="4"></textarea></div>'
      + '<button class="btn btn-green btn-full" onclick="Tasks._sendText()">📲 Open in Messages</button>'
      + '<div class="modal-actions"><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>'
    );
    setTimeout(() => this._fillText(), 0);
  },

  // Merge-field values for the current task (first/name/shop/date/time/service/link).
  _taskVars(t) {
    const shop = (Shop.settings && Shop.settings.shopName) || 'us';
    const v = { first: _tFirst(t.name), name: t.name || 'there', shop,
                link: (Shop.settings && Shop.settings.googleReviewLink) || '', date: '', time: '', service: '' };
    let a = null;
    if (t.source === 'reminder') a = (this._appts || []).find(x => x.id === t.apptId);
    else if (t.custId) a = (this._byCust[t.custId] || []).filter(x => x.status === 'confirmed' && x.date >= today()).sort((x, y) => x.date.localeCompare(y.date))[0];
    if (a) { v.date = fmtDateFull(a.date); v.time = a.time || ''; v.service = a.service || ''; }
    return v;
  },

  _fillText() {
    const t = this._tasks[this._textTask]; if (!t) return;
    const i = +(document.getElementById('task-tpl') || {}).value || 0;
    const o = this._textOpts[i] || { body: '' };
    const ta = document.getElementById('task-body');
    if (ta) ta.value = _smsFill(o.body, this._taskVars(t));   // suggestion is pre-filled → no-op
  },

  _sendText() {
    const t = this._tasks[this._textTask]; if (!t) return;
    const body = (document.getElementById('task-body') || {}).value || '';
    Modal.close();
    _cpSms(t.phone, body);                       // opens Messages (iPhone sms: deep link)
    // Same follow-up bookkeeping the old one-tap text did.
    if (t.source === 'winback') {
      const c = this._cust(t.custId); if (!c) return;
      const fu = this._ensureFollowup(c);
      if (fu.completedStep < t.stepIdx) { fu.completedStep = t.stepIdx; fu.snoozeUntil = null; this._persistCust(c); }
    } else if (t.source === 'reminder') {
      this._remDone[t.apptId] = true; this.render();   // clears it from today's list (session-only)
    } else if (t.source === 'lead' && t.leadId) {
      // Touch stamp so the lead sinks below untouched ones in today's lists.
      db.leads.note(t.leadId, 'Texted').catch(() => {});
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
    } else if (t.source === 'reminder') {
      this._remDone[t.apptId] = true; toast('Marked done ✓'); this.render();
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
      // 'lost', not 'closed' — closed now means WON on the pipeline (stamps
      // closedAt and counts toward conversion); a dismissed lead is dead.
      await this._persistLead(t.leadId, { status: 'lost' }, 'Dismissed');
    } else if (t.source === 'reminder') {
      this._remDone[t.apptId] = true; toast('Dismissed'); this.render();
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

  // ── Cadence settings modal — ALL the Tasks-page cadences in one place:
  // the win-back schedule AND the 30-day Meta-lead sequence (+ its [OFFER]).
  cadenceModal() {
    if (typeof canWrite === 'function' && !canWrite()) { toast('Read-only access', 'warning'); return; }
    this._wbEdit = JSON.parse(JSON.stringify(this._wb || this._winbackFrom(Shop.settings)));
    this._fsEdit = Leads.followUpSeq().map(s => ({ ...s }));
    this._fsOffer = (Shop.settings && Shop.settings.followUpOffer) || '';
    this._renderCadence();
  },

  _renderCadence() {
    const wb = this._wbEdit;
    const secHd = (title, sub) => '<div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;margin:16px 0 4px;">' + title + '</div>'
      + (sub ? '<p style="font-size:12.5px;color:var(--muted);margin:0 0 10px;line-height:1.5;">' + sub + '</p>' : '');

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

    const fsSteps = this._fsEdit.map((s, i) =>
      '<div class="card" style="padding:10px;margin-bottom:8px;">'
      + '<div class="form-row" style="align-items:flex-end;">'
      +   '<div class="form-group" style="flex:0 0 80px;margin-bottom:8px;"><label class="form-label">Day</label><input class="form-input" id="fs-day-' + i + '" type="number" min="0" value="' + esc(s.day) + '"></div>'
      +   '<div class="form-group" style="flex:1;margin-bottom:8px;"><label class="form-label">Label</label><input class="form-input" id="fs-label-' + i + '" value="' + esc(s.label) + '"></div>'
      +   '<button class="btn btn-sm btn-danger" style="margin-bottom:8px;" onclick="Tasks._fsDel(' + i + ')">✕</button>'
      + '</div>'
      + '<div class="form-group" style="margin-bottom:0;"><label class="form-label">Message <span style="color:var(--faint);font-weight:400;">— [NAME] [VEHICLE] [SHOP] [OFFER] [PRICE]</span></label>'
      +   '<textarea class="form-input" id="fs-msg-' + i + '" rows="3">' + esc(s.sms) + '</textarea></div>'
      + '</div>').join('');

    Modal.show('<div class="modal-title">Cadences</div>'
      + secHd('WIN-BACK (PAST CLIENTS)', 'Reach out to at-risk clients on a schedule. Each step\'s day counts from when a client crosses the at-risk threshold.')
      + '<div class="form-group"><label class="form-label">At-risk after (days since last visit)</label>'
      +   '<input class="form-input" id="wb-atrisk" type="number" min="1" value="' + esc(wb.atRiskDays) + '"></div>'
      + steps
      + '<button class="btn btn-sm" style="margin-bottom:4px;" onclick="Tasks._addStep()">+ Add win-back step</button>'
      + secHd('30-DAY LEAD SEQUENCE (META LEADS)', 'The follow-up queue\'s steps and texts. Days count from when the lead came in; same-day steps chain a few hours apart. Sends stay manual — a step without a message is removed on save.')
      + '<div class="form-group"><label class="form-label">Current offer <span style="color:var(--faint);font-weight:400;">— fills [OFFER]</span></label>'
      +   '<input class="form-input" id="fs-offer" placeholder="e.g. $50 off ceramic tint this month" value="' + esc(this._fsOffer) + '"></div>'
      + fsSteps
      + '<button class="btn btn-sm" style="margin-bottom:12px;" onclick="Tasks._fsAdd()">+ Add sequence step</button>'
      + '<div class="modal-actions"><button class="btn" onclick="Modal.close()">Cancel</button>'
      +   '<button class="btn btn-green" onclick="Tasks.saveCadence(this)">Save all</button></div>');
  },

  // Read the live inputs back into the working copies (so add/remove keep edits).
  _syncCadence() {
    const wb = this._wbEdit;
    const at = document.getElementById('wb-atrisk'); if (at) wb.atRiskDays = Math.max(1, Number(at.value) || 60);
    wb.steps.forEach((s, i) => {
      const d = document.getElementById('wb-day-' + i);   if (d) s.day = Math.max(0, Number(d.value) || 0);
      const l = document.getElementById('wb-label-' + i); if (l) s.label = l.value;
      const m = document.getElementById('wb-msg-' + i);   if (m) s.message = m.value;
    });
    (this._fsEdit || []).forEach((s, i) => {
      const d = document.getElementById('fs-day-' + i);   if (d) s.day = Math.max(0, Number(d.value) || 0);
      const l = document.getElementById('fs-label-' + i); if (l) s.label = l.value;
      const m = document.getElementById('fs-msg-' + i);   if (m) s.sms = m.value;
    });
    const off = document.getElementById('fs-offer'); if (off) this._fsOffer = off.value.trim().slice(0, 120);
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

  _fsAdd() {
    this._syncCadence();
    const last = this._fsEdit[this._fsEdit.length - 1];
    this._fsEdit.push({ id: genId('fs'), label: 'Day ' + (last ? Number(last.day) + 3 : 0), day: last ? Number(last.day) + 3 : 0, sms: '' });
    this._renderCadence();
  },

  _fsDel(i) {
    this._syncCadence();
    this._fsEdit.splice(i, 1);
    this._renderCadence();
  },

  async saveCadence(btn) {
    this._syncCadence();
    const wb = this._wbEdit;
    if (!wb.steps.length) { toast('Add at least one step', 'error'); return; }
    wb.steps.sort((a, b) => a.day - b.day);
    // Sequence steps: drop empties, stable-sort by day (same-day steps keep
    // their order — that's the Day 0 Initial → Follow-Up → Evening chain).
    const followUpSeq = (this._fsEdit || [])
      .map(s => ({ id: s.id || genId('fs'), label: String(s.label || 'Step').slice(0, 40), day: Math.max(0, Number(s.day) || 0), sms: String(s.sms || '').trim().slice(0, 500) }))
      .filter(s => s.sms)
      .sort((a, b) => a.day - b.day);
    disableBtn(btn);
    try {
      // POST /settings merges (assign) — other settings preserved.
      await db.settings.save({ winback: wb, followUpSeq, followUpOffer: this._fsOffer || '' });
      if (Shop.settings) { Shop.settings.winback = wb; Shop.settings.followUpSeq = followUpSeq; Shop.settings.followUpOffer = this._fsOffer || ''; }
      this._wb = wb;
      Modal.close(); toast('Cadences saved ✓'); this.render();
    } catch (e) { enableBtn(btn); toast(e.message || 'Could not save', 'error'); }
  },
};

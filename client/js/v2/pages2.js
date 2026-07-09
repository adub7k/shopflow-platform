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
            ${l.phone ? `<a class="btn btn-sm" href="${esc(tel)}" style="text-decoration:none;">Call</a>
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
})();

/* ── Tasks (worklist) ── */
(function () {
  Tasks._html = function (groups) {
    const total = groups.today.length + groups.overdue.length + groups.upcoming.length + groups.snoozed.length;
    const out = [];
    out.push(`<div class="v2-pagehd"><div><h1>Tasks</h1>
      <div class="sub">${total ? total + ' follow-up' + (total !== 1 ? 's' : '') + ' queued — win-backs, service due, uncontacted leads, tomorrow’s reminders' : 'Win-backs, service reminders, and uncontacted leads land here'}</div></div>
      <div class="sp"></div><button class="btn" onclick="Tasks.cadenceModal()">Edit cadence</button></div>`);
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
    return out.join('');
  };

  Tasks._card = function (t) {
    const SRC = {
      winback: ['badge-blue', 'Win-back'], service: ['badge-green', 'Service due'],
      lead: ['badge-yellow', 'New lead'], reminder: ['badge-green', 'Reminder'],
    }[t.source];
    const acts = [`<button class="btn btn-sm btn-green" onclick="Tasks.text('${t.id}')">Text</button>`];
    if (t.phone) acts.push(`<button class="btn btn-sm" onclick="Tasks.call('${t.id}')">Call</button>`);
    acts.push(`<button class="btn btn-sm" onclick="Tasks.done('${t.id}')">✓ Done</button>`);
    if (t.source !== 'lead' && t.source !== 'reminder') acts.push(`<button class="btn btn-sm" onclick="Tasks.snooze('${t.id}')">Snooze</button>`);
    acts.push(`<button class="btn btn-sm" style="color:var(--red);" onclick="Tasks.dismiss('${t.id}')">✕</button>`);
    return `<div class="list-row" style="align-items:flex-start;cursor:default;">
      ${avatarEl(t.name, 36)}
      <div class="list-main">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span class="list-name">${esc(t.name)}</span><span class="badge ${SRC[0]}">${SRC[1]}</span></div>
        <div class="list-sub">${esc(t.reason)}${t.detail ? ' · ' + esc(t.detail) : ''}</div>
        ${t.notes ? `<div style="margin-top:5px;font-size:12px;color:var(--muted);background:var(--surface2);border-radius:7px;padding:6px 9px;white-space:pre-wrap;">📝 ${esc(t.notes)}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">${acts.join('')}</div>
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
      const won = this._data.filter(q => q.status === 'approved' || q.status === 'scheduled');
      const decided = won.length + this._data.filter(q => q.status === 'declined').length;
      const rate = decided ? Math.round(won.length / decided * 100) : null;

      const html = [];
      html.push(`<div class="v2-pagehd"><div><h1>Estimates</h1>
        <div class="sub">Line-item quotes customers approve (and pay a deposit on) from their phone</div></div>
        <div class="sp"></div>${canWrite() ? `<button class="btn btn-green" onclick="Quotes.openForm(null)">＋ New estimate</button>` : ''}</div>`);

      html.push(`<div class="v2-mgrid" style="grid-template-columns:repeat(3,1fr);">
        <div class="metric-card"><div class="metric-label">Awaiting response</div><div class="metric-value">${fmtMoney(open.reduce((s, q) => s + (Number(q.total) || 0), 0))}</div><div class="metric-sub">${open.length} estimate${open.length !== 1 ? 's' : ''} out</div></div>
        <div class="metric-card"><div class="metric-label">Approved value</div><div class="metric-value green">${fmtMoney(won.reduce((s, q) => s + (Number(q.total) || 0), 0))}</div><div class="metric-sub">${won.length} approved or scheduled</div></div>
        <div class="metric-card"><div class="metric-label">Acceptance rate</div><div class="metric-value">${rate != null ? rate + '%' : '—'}</div><div class="metric-sub">of decided estimates</div></div></div>`);

      const tabs = [['', 'All'], ['sent', 'Sent'], ['approved', 'Approved'], ['scheduled', 'Scheduled'], ['declined', 'Declined']];
      html.push(`<div class="v2-chips" style="margin-bottom:12px;">${tabs.map(([v, lb]) =>
        `<button class="v2-chip${this._filter === v ? ' on' : ''}" onclick="Quotes._filter='${v}';Quotes.render()">${lb}</button>`).join('')}</div>`);

      const filtered = this._data.filter(q => !this._filter || q.status === this._filter);
      if (!filtered.length) {
        html.push(`<div class="v2-card"><div class="empty-state"><div class="empty-icon">📄</div>
          <div class="empty-text">No estimates${this._filter ? ' here' : ' yet'}</div>
          ${!this._filter && canWrite() ? '<div class="list-sub" style="margin-top:2px;">Create one to quote a ceramic, PPF, or correction job.</div>' : ''}</div></div>`);
      } else {
        html.push(`<div class="v2-card v2-tablewrap"><table class="v2-table">
          <thead><tr><th>Estimate</th><th>Customer</th><th>Vehicle</th><th class="r">Items</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>`);
        filtered.forEach(q => {
          const veh = q.vehicle && q.vehicle.make ? [q.vehicle.year, q.vehicle.make, q.vehicle.model].filter(Boolean).map(esc).join(' ') : '—';
          html.push(`<tr onclick="Quotes.openDetail('${q.id}')">
            <td style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);">${esc(q.number || '—')}</td>
            <td><b>${esc(q.customerName || '—')}</b></td>
            <td style="color:var(--muted);">${veh}</td>
            <td class="r">${(q.lineItems || []).length}</td>
            <td class="r"><b>${fmtMoney(q.total)}</b></td>
            <td>${this._badge(q.status)}</td></tr>`);
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
      const [data, expenses] = await Promise.all([db.revenue.get(), db.expenses.all().catch(() => [])]);
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

      const line = (label, val, opts = {}) => {
        const amt = opts.neg ? `−${fmtMoney(Math.abs(val))}` : (val < 0 ? `−${fmtMoney(Math.abs(val))}` : fmtMoney(val));
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;${opts.rule ? 'border-top:1px solid var(--border);margin-top:2px;padding-top:10px;' : ''}">
          <span style="font-size:12.5px;${opts.strong ? 'font-weight:700;' : ''}${opts.color ? 'color:' + opts.color + ';' : 'color:var(--muted);'}">${esc(label)}${opts.pct != null ? `<span style="font-size:11px;color:var(--faint);font-weight:600;margin-left:6px;">${opts.pct}% margin</span>` : ''}</span>
          <span class="num" style="font-size:13px;font-variant-numeric:tabular-nums;${opts.strong ? 'font-weight:700;' : ''}${opts.color ? 'color:' + opts.color + ';' : ''}">${amt}</span></div>`;
      };

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
        html.push(`<div class="v2-card"><div class="list-row" style="cursor:default;"><div class="list-main"><div class="list-name">Deposits collected</div>
          <div class="list-sub">Prepaid — applied to the balance at checkout.</div></div>
          <div style="text-align:right;"><b class="num" style="color:var(--green-deep);">${fmtMoney(data.monthDeposits)}</b><div style="font-size:11px;color:var(--faint);">${fmtMoney(data.totalDeposits)} all time</div></div></div></div>`);
      }
      html.push('</div></div>');
      el.innerHTML = html.join('');
    } catch (e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load revenue</p></div>'; }
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
      const html = [];

      html.push(`<div class="v2-pagehd"><div><h1>Reviews</h1><div class="sub">Collect ratings through your review link and feature the best on your booking page</div></div>
        <div class="sp"></div><button class="btn" onclick="navigator.clipboard.writeText('${esc(link)}');toast('Review link copied ✓')">Copy review link</button></div>`);

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
      html.push(`<div style="min-width:230px;flex:1;"><div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;">Your review link</div>
        <div style="display:flex;gap:6px;"><input class="form-input" readonly value="${esc(link)}" style="flex:1;font-size:11.5px;height:32px;" onclick="this.select()" />
        <button class="btn btn-sm btn-green" style="height:32px;" onclick="navigator.clipboard.writeText('${esc(link)}');toast('Link copied ✓')">Copy</button></div>
        <div style="font-size:11px;color:var(--faint);margin-top:5px;">Send after a visit — they rate you in seconds.</div></div></div></div>`);

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

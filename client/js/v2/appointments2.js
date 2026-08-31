// ── v2 Appointments (redesign) ────────────────────────────────────────────────
// Loaded ONLY by app2.html, after js/pages/appointments.js. Replaces render()
// with the redesigned calendar: a real week time-grid (demo style), plus day
// and month views. All flows (openForm, openDetail, complete, prefill from a
// client profile) are the existing ones.
(function () {
  const _buildMonthGrid = Appointments._buildCalendar.bind(Appointments);
  if (matchMedia('(max-width:640px)').matches) Appointments._view = 'day';
  else if (Appointments._view === 'month') Appointments._view = 'week';

  function parseMins(t) {
    if (!t) return 0;
    const [tm, ap] = t.split(' '); let [h, m] = tm.split(':').map(Number);
    if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + (m || 0);
  }
  function durationOf(a) {
    const s = (Appointments._services || []).find(x => x.id === a.serviceId);
    const d = Number(a.duration || (s && (s.duration || s.durationMin)) || 0);
    return d >= 15 ? d : 60;
  }
  function weekDays(sel) {
    const dt = new Date(sel + 'T12:00:00');
    const start = new Date(dt); start.setDate(dt.getDate() - dt.getDay());
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d.toISOString().split('T')[0]; });
  }
  const stClass = s => s === 'unconfirmed' ? 'unconfirmed' : (s === 'done' || s === 'ready') ? 'done' : (s === 'in-progress' || s === 'dropped-off' || s === 'curing') ? 'progress' : 'confirmed';

  function dayRows(list) {
    if (!list.length) return `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-text">No appointments this day</div><div class="list-sub" style="margin-top:2px;">${canWrite() ? 'Add one with the New appointment button.' : ''}</div></div>`;
    return list.map(a => {
      const barber = (Appointments._barbers || []).find(b => b.id === a.barberId);
      return `<div class="list-row" onclick="Appointments.openDetail('${a.id}')">
        <div style="width:3px;min-height:40px;background:${barber?.color || 'var(--border-md)'};border-radius:2px;flex-shrink:0;"></div>
        <span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);width:58px;flex-shrink:0;font-variant-numeric:tabular-nums;">${esc(a.time || '')}</span>
        ${avatarEl(a.customerName, 32)}
        <div class="list-main"><div class="list-name">${esc(a.customerName)}</div>
          <div class="list-sub">${esc(a.service || '')}${barber ? ' · ' + esc(barber.name) : ''}</div></div>
        <div class="list-right">${statusBadge(a.status)}<div style="font-size:11.5px;color:var(--muted);margin-top:3px;">${fmtMoney(a.price)}</div></div></div>`;
    }).join('');
  }

  Appointments.render = async function () {
    const el = document.getElementById('page-appointments'); if (!el) return;
    el.classList.add('v2-wide');
    try {
      // _fetchForView (base appointments.js) merges every month the visible
      // week touches — a single-month fetch left cross-month weeks half empty.
      [this._data, this._barbers, this._services] = await Promise.all([
        this._fetchForView(), db.barbers.all(), db.services.all()
      ]);
      const dt = new Date(this._selected + 'T12:00:00');
      const monthLabel = dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const days = weekDays(this._selected);
      const wk = this._data.filter(a => days.includes(a.date));
      const wkRev = wk.reduce((s, a) => s + (Number(a.price) || 0), 0);

      const html = [];
      html.push(`<div class="v2-pagehd"><div><h1>Calendar</h1>
        <div class="sub">${this._view === 'week' ? `Week of ${fmtDateShort(days[0])} – ${fmtDateShort(days[6])} · ${wk.length} appointment${wk.length !== 1 ? 's' : ''} · ${fmtMoney(wkRev)} booked` : monthLabel}</div></div>
        <div class="sp"></div>
        <div class="v2-chips" style="margin-right:4px;">
          <button class="v2-chip${this._view === 'day' ? ' on' : ''}" onclick="Appointments._view='day';Appointments.render()">Day</button>
          <button class="v2-chip${this._view === 'week' ? ' on' : ''}" onclick="Appointments._view='week';Appointments.render()">Week</button>
          <button class="v2-chip${this._view === 'month' ? ' on' : ''}" onclick="Appointments._view='month';Appointments.render()">Month</button></div>
        <button class="btn btn-sm" onclick="Appointments._navStep(-1)" aria-label="Previous ${this._view}">‹</button>
        <button class="btn btn-sm" onclick="Appointments.selectDay(today())">Today</button>
        <button class="btn btn-sm" onclick="Appointments._navStep(1)" aria-label="Next ${this._view}">›</button>
        ${canWrite() ? `<button class="btn btn-green" onclick="Appointments.openForm(null)">＋ New appointment</button>` : ''}</div>`);

      if (this._view === 'week') {
        html.push(`<div style="margin-bottom:10px;" class="legend"><span style="font-size:11.5px;color:var(--muted);"><span style="display:inline-block;width:8px;height:8px;border-radius:3px;border:1px dashed var(--border-md);background:var(--surface2);margin-right:5px;vertical-align:-1px;"></span>Unconfirmed</span>
          <span style="font-size:11.5px;color:var(--muted);margin-left:14px;"><span style="display:inline-block;width:8px;height:8px;border-radius:3px;background:var(--green);margin-right:5px;vertical-align:-1px;"></span>Confirmed</span>
          <span style="font-size:11.5px;color:var(--muted);margin-left:14px;"><span style="display:inline-block;width:8px;height:8px;border-radius:3px;background:var(--orange);margin-right:5px;vertical-align:-1px;"></span>In progress</span>
          <span style="font-size:11.5px;color:var(--muted);margin-left:14px;"><span style="display:inline-block;width:8px;height:8px;border-radius:3px;background:var(--faint);margin-right:5px;vertical-align:-1px;"></span>Done</span></div>`);
        html.push(this._v2Week(days));
      } else if (this._view === 'month') {
        html.push(_buildMonthGrid(dt));
        html.push(`<div class="section-header"><span>${fmtDateFull(this._selected)}</span></div>`);
        html.push(`<div class="list-card">${dayRows(this._data.filter(a => a.date === this._selected).sort((a, b) => parseMins(a.time) - parseMins(b.time)))}</div>`);
      } else {
        html.push(`<div class="v2-chips" style="margin-bottom:12px;">${days.map(d => {
          const dd = new Date(d + 'T12:00:00');
          return `<button class="v2-chip${this._selected === d ? ' on' : ''}" onclick="Appointments.selectDay('${d}')">${dd.toLocaleDateString('en-US', { weekday: 'short' })} ${dd.getDate()}</button>`;
        }).join('')}</div>`);
        html.push(`<div class="list-card">${dayRows(this._data.filter(a => a.date === this._selected).sort((a, b) => parseMins(a.time) - parseMins(b.time)))}</div>`);
      }
      el.innerHTML = html.join('');

      if (this._prefill) {
        const p = this._prefill; this._prefill = null;
        setTimeout(() => this.openFormPrefilled(p.customerId, p.customerName, p.customerPhone), 100);
      }
    } catch (e) {
      console.error('v2 appointments:', e);
      el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load appointments</p></div>';
    }
  };

  Appointments._v2Week = function (days) {
    const todayStr = today();
    const wk = this._data.filter(a => days.includes(a.date));
    // Hour range hugs the day's real bookings (min 8am–6pm span)
    let h0 = 8, h1 = 18;
    wk.forEach(a => {
      const m = parseMins(a.time); h0 = Math.min(h0, Math.floor(m / 60));
      h1 = Math.max(h1, Math.ceil((m + durationOf(a)) / 60));
    });
    const ROW = 46;
    let head = '<div></div>' + days.map(d => {
      const dd = new Date(d + 'T12:00:00');
      return `<div class="v2-calhd${d === todayStr ? ' today' : ''}" onclick="Appointments.selectDay('${d}');Appointments._view='day';Appointments.render()">${dd.toLocaleDateString('en-US', { weekday: 'short' })}<div class="d">${dd.getDate()}</div></div>`;
    }).join('');
    let rows = '';
    for (let h = h0; h < h1; h++) {
      rows += `<div class="v2-caltime">${h === 12 ? '12p' : h > 12 ? (h - 12) + 'p' : h + 'a'}</div>`;
      for (const d of days) rows += `<div class="v2-calcell" data-h="${h}" data-d="${d}"></div>`;
    }
    setTimeout(() => {
      wk.forEach(a => {
        const mins = parseMins(a.time), h = Math.floor(mins / 60);
        const cell = document.querySelector(`.v2-calcell[data-h="${h}"][data-d="${a.date}"]`); if (!cell) return;
        const dur = durationOf(a);
        const top = (mins % 60) / 60 * ROW, hgt = Math.max(dur / 60 * ROW - 4, 20);
        const barber = (this._barbers || []).find(b => b.id === a.barberId);
        cell.insertAdjacentHTML('beforeend', `<div class="v2-appt ${stClass(a.status)}" style="top:${top}px;height:${hgt}px;${barber?.color ? `border-left:3px solid ${barber.color};` : ''}" onclick="Appointments.openDetail('${a.id}')" title="${esc(a.customerName)} — ${esc(a.service || '')}">
          <div class="an">${esc(a.customerName)}</div>
          ${dur >= 75 ? `<div>${esc((a.service || '').split(' · ')[0])}</div><div style="font-weight:650;">${fmtMoney(a.price)}</div>` : ''}</div>`);
      });
    }, 0);
    return `<div class="v2-card v2-tablewrap"><div class="v2-calgrid" style="grid-template-rows:auto repeat(${h1 - h0},${ROW}px);">${head}${rows}</div></div>`;
  };
})();

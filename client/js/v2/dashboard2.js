// ── v2 Dashboard (redesign) ───────────────────────────────────────────────────
// Loaded ONLY by app2.html, after js/pages/dashboard.js. Replaces
// Dashboard.render with the redesigned layout (wide two-column grid, 6-metric
// row, 30-day revenue chart, needs-attention panel) computed from the same
// APIs the v1 dashboard uses. v1 (/shop) never loads this file.
(function () {
  const _v1Render = Dashboard.render.bind(Dashboard);

  // Month-to-date cumulative revenue vs. the goal pace. The emerald line is the
  // running total of collected revenue this month; the red dotted line is the
  // straight track from $0 (month start) to the owner's goal (month end) —
  // above it = ahead of pace, below = behind. Hover reads MTD + pace at any day.
  // `cum` = [{d, v}] running total for days 1..todayDay; goal from settings.
  function mtdGoalChart(cum, goal, dim, todayDay) {
    const w = 640, h = 184, padL = 8, padR = 8, padT = 16, padB = 20;
    const mtd = cum.length ? cum[cum.length - 1].v : 0;
    const maxV = Math.max(goal, mtd, 1) * 1.12;
    const X = d => padL + (dim <= 1 ? 0 : (d - 1) / (dim - 1)) * (w - padL - padR);
    const Y = v => h - padB - (v / maxV) * (h - padT - padB);
    let grid = '';
    for (let g = 1; g <= 3; g++) { const y = (padT + (h - padT - padB) * g / 4).toFixed(1); grid += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="var(--border)"/>`; }
    const linePts = cum.map(p => `${X(p.d).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    const area = cum.length ? `<polygon points="${X(1).toFixed(1)},${Y(0).toFixed(1)} ${linePts} ${X(cum[cum.length - 1].d).toFixed(1)},${Y(0).toFixed(1)}" fill="var(--green-lt)"/>` : '';
    const line = cum.length ? `<polyline points="${linePts}" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
    const pace = goal > 0 ? `<line x1="${X(1).toFixed(1)}" y1="${Y(0).toFixed(1)}" x2="${X(dim).toFixed(1)}" y2="${Y(goal).toFixed(1)}" stroke="var(--red)" stroke-width="1.6" stroke-dasharray="4 4" opacity="0.85"/>
      <text x="${(X(dim) - 2).toFixed(1)}" y="${(Y(goal) - 5).toFixed(1)}" font-size="10" font-weight="700" fill="var(--red)" text-anchor="end" font-family="var(--font)">Goal ${fmtMoney(goal)}</text>` : '';
    const ex = X(todayDay), ey = Y(mtd);
    const end = cum.length ? `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" fill="var(--green-deep)"/>
      <text x="${(ex - 6).toFixed(1)}" y="${(ey - 8).toFixed(1)}" font-size="10.5" font-weight="700" fill="var(--green-deep)" text-anchor="${todayDay > dim * 0.6 ? 'end' : 'start'}" font-family="var(--font)">${fmtMoney(mtd)}</text>` : '';
    const hover = `<line id="dchart-guide" y1="${padT}" y2="${h - padB}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>
      <circle id="dchart-dot" r="4" fill="var(--green-deep)" stroke="#fff" stroke-width="1.5" style="display:none"/>`;
    const payload = JSON.stringify({ cum, goal, dim, todayDay, geo: { w, h, padL, padR, padT, padB, maxV } }).replace(/'/g, '&#39;');
    return `<div id="dchart" style="position:relative;" data-chart='${payload}'>
      <svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block" role="img" aria-label="Month-to-date revenue versus goal pace">${grid}${pace}${area}${line}${end}${hover}</svg>
      <div id="dchart-tip" style="position:absolute;pointer-events:none;display:none;background:var(--text);color:#fff;font-size:11px;line-height:1.45;padding:6px 9px;border-radius:8px;box-shadow:var(--shadow-lg);white-space:nowrap;transform:translate(-50%,-100%);z-index:5;"></div>
    </div>`;
  }

  // Wire the hover readout after the chart is in the DOM (mouse only; the
  // always-visible endpoint label + pace caption cover touch/mobile).
  Dashboard._wireGoalChart = function () {
    const host = document.getElementById('dchart'); if (!host) return;
    let data; try { data = JSON.parse(host.getAttribute('data-chart')); } catch (e) { return; }
    const { cum, goal, dim, todayDay, geo } = data; if (!cum || !cum.length) return;
    const { w, h, padL, padR, padT, padB, maxV } = geo;
    const X = d => padL + (dim <= 1 ? 0 : (d - 1) / (dim - 1)) * (w - padL - padR);
    const Y = v => h - padB - (v / maxV) * (h - padT - padB);
    const svg = host.querySelector('svg'), guide = host.querySelector('#dchart-guide'), dot = host.querySelector('#dchart-dot'), tip = host.querySelector('#dchart-tip');
    const mon = new Date().toLocaleDateString('en-US', { month: 'short' });
    const show = clientX => {
      const r = host.getBoundingClientRect();
      let frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      let day = Math.round(1 + (dim <= 1 ? 0 : (frac * w - padL) / (w - padL - padR) * (dim - 1)));
      day = Math.max(1, Math.min(todayDay, day));
      const v = cum[day - 1].v, target = goal > 0 && dim > 1 ? goal * (day - 1) / (dim - 1) : 0;
      const gx = X(day), gy = Y(v);
      guide.setAttribute('x1', gx); guide.setAttribute('x2', gx); guide.style.display = '';
      dot.setAttribute('cx', gx); dot.setAttribute('cy', gy); dot.style.display = '';
      let txt = `${mon} ${day} · MTD ${fmtMoney(v)}`;
      if (goal > 0) { const dlt = v - target; txt += `<br>${dlt >= 0 ? 'ahead of' : 'behind'} pace by ${fmtMoney(Math.abs(dlt))}`; }
      tip.innerHTML = txt;
      tip.style.left = Math.max(46, Math.min(r.width - 46, gx / w * r.width)) + 'px';
      tip.style.top = (gy / h * r.height - 6) + 'px';
      tip.style.display = '';
    };
    const hide = () => { guide.style.display = 'none'; dot.style.display = 'none'; tip.style.display = 'none'; };
    svg.addEventListener('mousemove', e => show(e.clientX));
    svg.addEventListener('mouseleave', hide);
  };

  const metric = (label, value, sub, nav, green) =>
    `<div class="metric-card" style="cursor:pointer;" onclick="App.nav('${nav}')">
       <div class="metric-label">${label}</div>
       <div class="metric-value${green ? ' green' : ''}">${value}</div>
       <div class="metric-sub">${sub}</div></div>`;

  Dashboard.render = async function () {
    // The cleaning vertical has its own operational overview — keep v1 for it
    // until that block is ported.
    if (Shop.industry === 'cleaning') return _v1Render();
    const el = document.getElementById('page-dashboard'); if (!el) return;
    el.classList.add('v2-wide');
    try {
      const showRev = canSee('revenue');
      const [rev, allAppts, customers, leads, settings, barbers] = await Promise.all([
        showRev ? db.revenue.get().catch(() => ({})) : Promise.resolve({}),
        db.appointments.all().catch(() => []),
        db.customers.all().catch(() => []),
        db.leads.all().catch(() => []),
        db.settings.get().catch(() => ({ shopName: 'ShopFlow' })),
        db.barbers.all().catch(() => []),
      ]);
      const t0 = today();
      const parseTime = t => { if (!t) return 0; const [tm, ap] = t.split(' '); let [h, m] = tm.split(':').map(Number); if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return h * 60 + m; };
      const appts = (allAppts || []).filter(a => a.date === t0).sort((a, b) => parseTime(a.time) - parseTime(b.time));
      const remaining = appts.filter(a => a.status === 'confirmed' || a.status === 'in-progress');
      const doneAll = (allAppts || []).filter(a => a.status === 'done');
      const todayRevenue = doneAll.filter(a => a.date === t0).reduce((s, a) => s + (Number(a.price) || 0), 0);

      // Month-over-month revenue + avg ticket from completed appointments
      const ym = t0.slice(0, 7);
      const lastM = new Date(t0.slice(0, 10)); lastM.setDate(1); lastM.setDate(0);
      const ymPrev = lastM.toISOString().slice(0, 7);
      const monthDone = doneAll.filter(a => (a.date || '').startsWith(ym));
      const prevDone = doneAll.filter(a => (a.date || '').startsWith(ymPrev));
      const monthSum = monthDone.reduce((s, a) => s + (Number(a.price) || 0), 0);
      const prevSum = prevDone.reduce((s, a) => s + (Number(a.price) || 0), 0);
      const delta = prevSum > 0 ? Math.round((monthSum - prevSum) / prevSum * 100) : null;
      const avgTicket = monthDone.length ? monthSum / monthDone.length : 0;
      const avgPrev = prevDone.length ? prevSum / prevDone.length : 0;

      // Repeat rate: clients with 2+ completed visits vs clients with any
      const byCustDone = {};
      doneAll.forEach(a => { if (a.customerId) byCustDone[a.customerId] = (byCustDone[a.customerId] || 0) + 1; });
      const custDone = Object.values(byCustDone);
      const repeatRate = custDone.length ? Math.round(custDone.filter(n => n >= 2).length / custDone.length * 100) : 0;

      // Follow-ups via the Tasks worklist engine (same wiring as v1)
      let followUps = [];
      try {
        Tasks._customers = customers || []; Tasks._leads = leads || [];
        Tasks._rebook = (settings && settings.rebookInterval) || 21; Tasks._wb = Tasks._winbackFrom(settings);
        Tasks._byCust = {}; (allAppts || []).forEach(a => { if (a.customerId) (Tasks._byCust[a.customerId] = Tasks._byCust[a.customerId] || []).push(a); });
        const g = Tasks._build(); followUps = [...(g.overdue || []), ...(g.today || [])].filter(t => t.source !== 'lead');
      } catch (e) { console.warn('Tasks:', e.message); }
      const newLeads = (leads || []).filter(l => l.status === 'new')
        .sort((a, b) => new Date(b.createdAt || b.lastContactAt || 0) - new Date(a.createdAt || a.lastContactAt || 0));

      // Cumulative month-to-date revenue (running total, days 1..today) + the
      // owner's monthly goal (settings.revenueGoal) for the pace line.
      const [yy, mm] = t0.split('-').map(Number);
      const daysInMonth = new Date(yy, mm, 0).getDate();
      const todayDay = Number(t0.slice(8, 10));
      const perDay = {};
      monthDone.forEach(a => { const dd = Number((a.date || '').slice(8, 10)); if (dd) perDay[dd] = (perDay[dd] || 0) + (Number(a.price) || 0); });
      let run = 0; const cum = [];
      for (let d = 1; d <= todayDay; d++) { run += (perDay[d] || 0); cum.push({ d, v: run }); }
      const goal = Math.max(0, Number(settings.revenueGoal) || 0);
      // Pace math for the always-visible caption (mobile-friendly; no hover needed).
      const targetToday = goal > 0 && daysInMonth > 1 ? goal * (todayDay - 1) / (daysInMonth - 1) : 0;
      const paceDelta = run - targetToday;
      const daysLeft = daysInMonth - todayDay;
      const needPerDay = goal > 0 && daysLeft > 0 ? Math.max(0, (goal - run) / daysLeft) : 0;
      const goalPct = goal > 0 ? Math.round(run / goal * 100) : 0;

      // Top service this month
      const svcCount = {};
      monthDone.forEach(a => { if (a.service) svcCount[a.service] = (svcCount[a.service] || 0) + 1; });
      const topSvc = Object.entries(svcCount).sort((a, b) => b[1] - a[1])[0];

      const hr = new Date().getHours();
      const greet = hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening';
      const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const html = [];

      html.push(renderOnboarding(settings, barbers));

      html.push(`<div class="v2-pagehd"><div>
        <h1>Good ${greet}</h1>
        <div class="sub">${esc(settings.shopName || 'ShopFlow')} &nbsp;·&nbsp; ${dateLabel}</div></div>
        <div class="sp"></div>
        <button class="btn" onclick="App.nav('revenue')">Reports</button>
        <button class="btn btn-green" onclick="App.nav('appointments')">＋ New booking</button></div>`);

      html.push('<div class="v2-mgrid">');
      if (showRev) html.push(metric('Revenue MTD', fmtMoney(rev.monthRevenue || monthSum),
        (delta !== null ? `<span class="${delta >= 0 ? 'v2-up' : 'v2-down'}">${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}%</span> vs last month` : fmtMoney(todayRevenue) + ' today'), 'revenue', true));
      html.push(metric("Today's appts", appts.length, remaining.length + ' remaining · ' + fmtMoney(todayRevenue) + ' collected', 'appointments'));
      html.push(metric('New leads', newLeads.length, newLeads.length ? 'waiting on a response' : 'none waiting', 'leads'));
      html.push(metric('Follow-ups', followUps.length, followUps.length ? 'due now' : 'all clear', 'tasks'));
      html.push(metric('Repeat rate', repeatRate + '%', 'clients who came back', 'clients'));
      if (showRev) html.push(metric('Avg ticket', fmtMoney(avgTicket),
        avgPrev > 0 ? `<span class="${avgTicket >= avgPrev ? 'v2-up' : 'v2-down'}">${avgTicket >= avgPrev ? '↑' : '↓'} ${fmtMoney(Math.abs(avgTicket - avgPrev))}</span> vs last month` : 'per completed job', 'revenue'));
      html.push('</div>');

      html.push('<div class="v2-dgrid"><div class="v2-col">');

      if (showRev) {
        const caption = goal <= 0
          ? `<span style="color:var(--muted);">${fmtMoney(run)} collected this month.</span> <a onclick="App.nav('settings')" style="color:var(--green-deep);font-weight:600;cursor:pointer;">Set a monthly goal →</a>`
          : paceDelta >= 0
            ? `<span style="color:var(--green-deep);font-weight:600;">On pace — ${fmtMoney(paceDelta)} ahead.</span> <span style="color:var(--muted);">${fmtMoney(run)} of ${fmtMoney(goal)} (${goalPct}%).</span>`
            : `<span style="color:var(--red);font-weight:600;">${fmtMoney(-paceDelta)} behind pace.</span> <span style="color:var(--muted);">Need ${fmtMoney(needPerDay)}/day over ${daysLeft} day${daysLeft !== 1 ? 's' : ''} to hit ${fmtMoney(goal)}.</span>`;
        html.push(`<div class="v2-card"><div class="v2-chd"><div>
          <div class="t">Revenue — this month</div><div class="sub">Month-to-date vs. goal pace</div></div>
          <button class="act" onclick="App.nav('revenue')">Revenue →</button></div>
          <div style="padding:14px 16px 4px;">${mtdGoalChart(cum, goal, daysInMonth, todayDay)}</div>
          <div style="padding:2px 16px 14px;font-size:12px;">${caption}</div></div>`);
      }

      html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Today's schedule</div>
        <span class="sub">${dateLabel.split(', ')[1] || ''}</span>
        <button class="act" onclick="App.nav('appointments')">Full calendar →</button></div>`);
      if (!appts.length) {
        html.push(`<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-text">No appointments today</div><div class="list-sub" style="margin-top:2px;">Add one from the Appointments tab</div></div>`);
      } else {
        appts.slice(0, 8).forEach(a => {
          const canComplete = a.status === 'confirmed' || a.status === 'in-progress';
          const rowClick = a.customerId ? `ClientProfile.open('${a.customerId}')` : '';
          const completeBtn = `<button onclick="event.stopPropagation();Dashboard._complete('${a.id}')" style="width:30px;height:30px;border-radius:8px;background:var(--green-deep);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Mark complete"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>`;
          html.push(`<div class="list-row" onclick="${rowClick}">
            <span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);width:58px;flex-shrink:0;font-variant-numeric:tabular-nums;">${esc(a.time || '')}</span>
            ${avatarEl(a.customerName, 34)}
            <div class="list-main"><div class="list-name">${esc(a.customerName)}</div>
            <div class="list-sub">${esc(a.service || '')}${a.barberName ? ' · ' + esc(a.barberName) : ''}${a.price ? ' · ' + fmtMoney(a.price) : ''}</div></div>
            ${canComplete ? completeBtn : statusBadge(a.status)}</div>`);
        });
      }
      html.push('</div>');

      if (rev.loyaltyAlerts?.length) {
        html.push(`<div class="v2-card" style="background:var(--green-lt);border-color:var(--green-md);"><div class="v2-chd" style="border-color:var(--green-md);"><div class="t">🎉 Loyalty rewards ready</div></div>`);
        rev.loyaltyAlerts.slice(0, 3).forEach(c => {
          html.push(`<div class="v2-ai-row" style="border-color:var(--green-md);cursor:pointer;" onclick="ClientProfile.open('${c.id}')">${avatarEl(c.name, 30)}
            <div class="tx" style="font-weight:600;">${esc(c.name)}</div>
            <button class="btn btn-sm btn-green" onclick="event.stopPropagation();Clients.redeemReward('${c.id}','${jsAttr(c.name)}')">Redeem</button></div>`);
        });
        html.push('</div>');
      }

      html.push('</div><div class="v2-col">');

      // Needs attention — win-backs + service-due + uncontacted leads
      const attn = followUps.slice(0, 4);
      html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">Needs attention</div>
        <button class="act" onclick="App.nav('tasks')">All tasks →</button></div>`);
      if (!attn.length && !newLeads.length) {
        html.push(`<div class="empty-state" style="padding:26px 16px;"><div class="empty-icon">✓</div><div class="empty-text">All clear</div><div class="list-sub" style="margin-top:2px;">No follow-ups or waiting leads right now.</div></div>`);
      } else {
        attn.forEach(t => {
          html.push(`<div class="v2-ai-row"><div class="v2-ai-ic" style="background:#FBF1E2;color:var(--orange);">⏱</div>
            <div class="tx"><b>${esc(t.name)}</b><span class="why">${esc(t.reason || '')}</span></div>
            ${t.phone ? `<button class="btn btn-sm" onclick="App.nav('tasks')">Text</button>` : ''}</div>`);
        });
        newLeads.slice(0, 3).forEach(l => {
          const nm = l.name || l.phone || 'New lead';
          html.push(`<div class="v2-ai-row" style="cursor:pointer;" onclick="App.nav('leads')"><div class="v2-ai-ic" style="background:#FBEDEB;color:var(--red);">⚡</div>
            <div class="tx"><b>${esc(nm)}</b><span class="why">new lead — waiting on a response</span></div>
            <button class="btn btn-sm btn-green" onclick="event.stopPropagation();App.nav('leads')">Open</button></div>`);
        });
      }
      html.push('</div>');

      // This month summary
      html.push(`<div class="v2-card"><div class="v2-chd"><div class="t">This month</div></div>
        <div style="padding:6px 16px 12px;font-size:12.5px;color:var(--muted);">
          <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);"><span>Jobs completed</span><b style="color:var(--text);font-variant-numeric:tabular-nums;">${monthDone.length}</b></div>
          ${showRev ? `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);"><span>Collected</span><b style="color:var(--green-deep);font-variant-numeric:tabular-nums;">${fmtMoney(monthSum)}</b></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);"><span>Active clients</span><b style="color:var(--text);font-variant-numeric:tabular-nums;">${(customers || []).length}</b></div>
          <div style="display:flex;justify-content:space-between;padding:7px 0;"><span>Top service</span><b style="color:var(--text);">${topSvc ? esc(topSvc[0]) + ' ×' + topSvc[1] : '—'}</b></div>
        </div></div>`);

      html.push('</div></div>');
      el.innerHTML = html.join('');
      Dashboard._wireGoalChart();
    } catch (e) {
      console.error('v2 dashboard:', e);
      el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load dashboard</p></div>';
    }
  };
})();

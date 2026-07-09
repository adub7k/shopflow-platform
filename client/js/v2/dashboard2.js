// ── v2 Dashboard (redesign) ───────────────────────────────────────────────────
// Loaded ONLY by app2.html, after js/pages/dashboard.js. Replaces
// Dashboard.render with the redesigned layout (wide two-column grid, 6-metric
// row, 30-day revenue chart, needs-attention panel) computed from the same
// APIs the v1 dashboard uses. v1 (/shop) never loads this file.
(function () {
  const _v1Render = Dashboard.render.bind(Dashboard);

  // Minimal inline area chart — daily collected revenue, last 30 days.
  function areaChart(vals, { w = 640, h = 170 } = {}) {
    const max = Math.max(...vals, 1) * 1.12, pad = 6;
    const X = i => pad + i * (w - 2 * pad) / (vals.length - 1);
    const Y = v => h - 14 - (v / max) * (h - 28);
    const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    let grid = '';
    for (let g = 1; g <= 3; g++) {
      const y = 14 + (h - 28) * g / 4;
      grid += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    }
    const last = vals[vals.length - 1], lx = X(vals.length - 1), ly = Y(last);
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block" role="img" aria-label="Revenue, last 30 days">${grid}
      <polygon points="${pad},${h - 14} ${pts} ${lx},${h - 14}" fill="var(--green-lt)"/>
      <polyline points="${pts}" fill="none" stroke="var(--green)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lx}" cy="${ly}" r="3.5" fill="var(--green-deep)"/>
      ${last > 0 ? `<text x="${lx - 6}" y="${ly - 8}" font-size="10.5" font-weight="700" fill="var(--green-deep)" text-anchor="end" font-family="var(--font)">${fmtMoney(last)}</text>` : ''}</svg>`;
  }

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

      // 30-day collected revenue series
      const days = []; const sums = {};
      for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toISOString().slice(0, 10)); }
      doneAll.forEach(a => { if (a.date in sums === false) sums[a.date] = 0; sums[a.date] += Number(a.price) || 0; });
      const series = days.map(d => sums[d] || 0);

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

      if (showRev) html.push(`<div class="v2-card"><div class="v2-chd"><div>
        <div class="t">Revenue — last 30 days</div><div class="sub">Collected from completed jobs</div></div>
        <button class="act" onclick="App.nav('revenue')">Revenue →</button></div>
        <div style="padding:14px 16px 10px;">${areaChart(series)}</div></div>`);

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
    } catch (e) {
      console.error('v2 dashboard:', e);
      el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load dashboard</p></div>';
    }
  };
})();

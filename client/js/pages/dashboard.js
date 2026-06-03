// ── Onboarding checklist ──────────────────────────────────────────────────────
function renderOnboarding(settings, barbers) {
  if (localStorage.getItem('sf_onboarding_dismissed') === 'true') return '';

  const steps = [
    {
      key: 'shopName',
      icon: '🏪',
      label: 'Name your shop',
      desc: 'Set your shop name, tagline, and address',
      done: !!(settings.shopName && settings.shopName !== 'My Shop' && settings.phone),
      action: `App.nav('settings')`,
    },
    {
      key: 'addBarber',
      icon: '✂️',
      label: 'Add your barbers',
      desc: 'Replace the default barber with your real team',
      done: barbers.some(b => b.name && b.name !== 'Barber 1'),
      action: `App.nav('settings')`,
    },
    {
      key: 'stripe',
      icon: '💳',
      label: 'Connect Stripe for payments',
      desc: 'Accept card payments and deposits from clients',
      done: !!(settings.stripe?.onboardingComplete),
      action: `App.nav('settings')`,
    },
    {
      key: 'review',
      icon: '⭐',
      label: 'Add your Google review link',
      desc: 'Sent to clients 48 hours after each visit automatically',
      done: !!(settings.googleReviewLink),
      action: `App.nav('settings')`,
    },
    {
      key: 'bookingLink',
      icon: '📲',
      label: 'Share your booking link',
      desc: 'Your public booking page is live — copy the link and share it',
      done: false,
      action: `App.nav('settings')`,
      alwaysShow: true,
    },
  ];

  const doneCount = steps.filter(s => s.done && !s.alwaysShow).length;
  const totalTracked = steps.filter(s => !s.alwaysShow).length;
  const allDone = doneCount === totalTracked;
  const pct = Math.round((doneCount / totalTracked) * 100);

  if (allDone && localStorage.getItem('sf_onboarding_all_done')) return '';

  const stepsHtml = steps.map(s => {
    const isDone = s.done;
    return `<div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:0.5px solid var(--border);">
      <div style="width:28px;height:28px;border-radius:50%;background:${isDone?'var(--green)':'var(--off)'};border:${isDone?'2px solid var(--green)':'2px solid var(--border)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:${isDone?'14':'13'}px;">
        ${isDone?'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':s.icon}
      </div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:${isDone?'500':'600'};color:${isDone?'var(--muted)':'var(--text)'};${isDone?'text-decoration:line-through;':''}">${s.label}</div>
        ${!isDone?`<div style="font-size:11px;color:var(--faint);margin-top:1px;">${s.desc}</div>`:''}
      </div>
      ${!isDone && s.action?`<button onclick="${s.action}" style="background:var(--off);border:1px solid var(--border);border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;color:var(--text);cursor:pointer;white-space:nowrap;flex-shrink:0;">Set up →</button>`:''}
    </div>`;
  }).join('');

  if (allDone) {
    localStorage.setItem('sf_onboarding_all_done', 'true');
    return `<div style="background:var(--green-lt);border:1px solid var(--green-md);border-radius:12px;padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:12px;">
      <div style="font-size:22px;">🎉</div>
      <div style="flex:1;">
        <div style="font-size:14px;font-weight:700;color:var(--green);">Your shop is fully set up!</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px;">Everything is configured and running. Time to start booking.</div>
      </div>
      <button onclick="localStorage.setItem('sf_onboarding_dismissed','true');this.closest('[data-onboarding]').remove()" style="background:transparent;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:4px;">✕</button>
    </div>`;
  }

  return `<div data-onboarding style="background:var(--white);border:1px solid var(--border);border-radius:12px;margin-bottom:20px;overflow:hidden;">
    <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font-size:14px;font-weight:700;color:var(--text);">Complete your setup</div>
        <div style="font-size:12px;color:var(--muted);margin-top:1px;">${doneCount} of ${totalTracked} done</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:100px;height:5px;background:var(--off);border-radius:100px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:var(--green);border-radius:100px;transition:width .4s;"></div>
        </div>
        <span style="font-size:12px;font-weight:700;color:var(--green);">${pct}%</span>
        <button onclick="localStorage.setItem('sf_onboarding_dismissed','true');document.querySelector('[data-onboarding]').remove()" style="background:transparent;border:none;color:var(--faint);font-size:18px;cursor:pointer;padding:2px 4px;" title="Dismiss">✕</button>
      </div>
    </div>
    <div style="padding:0 18px;">${stepsHtml}</div>
  </div>`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
const Dashboard = {
  async render() {
    const el = document.getElementById('page-dashboard'); if(!el)return;
    try {
      let rev={monthRevenue:0,monthJobs:0,avgTicket:0,loyaltyAlerts:[],recentDone:[]};
      let appts=[];
      let settings={shopName:'ShopFlow'};
      let barbers=[];
      try{rev=await db.revenue.get();}catch(e){console.warn('Revenue:',e.message);}
      try{
        appts=await db.appointments.all({date:today()});
        // Sort earliest time first
        appts.sort((a,b)=>{
          const parse=t=>{if(!t)return0;const[tm,ap]=t.split(' ');let[h,m]=tm.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+m;};
          return parse(a.time)-parse(b.time);
        });
      }catch(e){console.warn('Appts:',e.message);}
      try{settings=await db.settings.get();}catch(e){console.warn('Settings:',e.message);}
      try{barbers=await db.barbers.all();}catch(e){console.warn('Barbers:',e.message);}
      const html = [];

      // Onboarding checklist
      html.push(renderOnboarding(settings, barbers));

      // Greeting
      const hr = new Date().getHours();
      const greet = hr<12?'morning':hr<17?'afternoon':'evening';
      html.push(`<div style="margin-bottom:20px;"><div style="font-size:22px;font-weight:800;color:var(--text);letter-spacing:-.03em;">Good ${greet} 👋</div><div style="font-size:13px;color:var(--muted);margin-top:2px;">${settings.shopName||'ShopFlow'} &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div></div>`);

      // Metrics
      html.push('<div class="metric-grid">');
      html.push(`<div class="metric-card"><div class="metric-label">Revenue MTD</div><div class="metric-value green">${fmtMoney(rev.monthRevenue)}</div><div class="metric-sub">${rev.monthJobs} appointments</div></div>`);
      html.push(`<div class="metric-card"><div class="metric-label">Avg Ticket</div><div class="metric-value">${fmtMoney(rev.avgTicket)}</div><div class="metric-sub">This month</div></div>`);
      html.push('</div>');

      // Today's appointments
      html.push('<div class="section-header"><span>Today\'s Appointments</span><button class="btn btn-sm btn-green" onclick="App.nav(\'appointments\')">View All</button></div>');
      if (!appts.length) {
        html.push('<div class="card"><div class="empty-state"><div class="empty-icon">📅</div><div class="empty-text">No appointments today</div><div class="empty-sub">Add one from the Appointments tab</div></div></div>');
      } else {
        html.push('<div class="list-card">');
        appts.slice(0,8).forEach(a => {
          const canComplete = a.status === 'confirmed' || a.status === 'in-progress';
          const cid = a.customerId || '';
          const rowClick = cid ? "ClientProfile.open('" + cid + "')" : '';
          const completeBtn = '<button onclick="event.stopPropagation();Dashboard._complete(\'' + a.id + '\')" style="width:32px;height:32px;border-radius:50%;background:var(--green);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Mark complete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>';
          html.push(
            '<div class="list-row" style="gap:10px;cursor:pointer;" onclick="' + rowClick + '">' +
              avatarEl(a.customerName, 38) +
              '<div class="list-main">' +
                '<div class="list-name">' + a.customerName + '</div>' +
                '<div class="list-sub">' + a.time + ' · ' + a.service + (a.barberName ? ' · ' + a.barberName : '') + '</div>' +
              '</div>' +
              '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
                (canComplete ? completeBtn : statusBadge(a.status)) +
              '</div>' +
            '</div>'
          );
        });
        html.push('</div>');
      }

      // Loyalty alerts
      if (rev.loyaltyAlerts?.length) {
        html.push('<div class="section-header">🎉 Loyalty Rewards Ready</div>');
        html.push('<div class="card" style="background:var(--green-lt);border-color:var(--green-md);">');
        rev.loyaltyAlerts.slice(0,3).forEach(c => {
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--green-md);cursor:pointer;" onclick="ClientProfile.open('${c.id}')">
            ${avatarEl(c.name,34)}
            <div style="flex:1;font-size:14px;font-weight:600;color:var(--text);">${c.name}</div>
            <button class="btn btn-sm btn-green" onclick="event.stopPropagation();Clients.redeemReward('${c.id}','${c.name}')">Redeem</button>
          </div>`);
        });
        html.push('</div>');
      }

      // Recent done
      if (rev.recentDone?.length) {
        html.push('<div class="section-header">Recent Completed</div>');
        html.push('<div class="list-card">');
        rev.recentDone.slice(0,4).forEach(a => {
          html.push(`<div class="list-row" onclick="${a.customerId?`ClientProfile.open('${a.customerId}')`:''}" style="${a.customerId?'cursor:pointer;':''}">
            ${avatarEl(a.customerName,36)}
            <div class="list-main"><div class="list-name">${a.customerName}</div><div class="list-sub">${a.service} · ${fmtDateShort(a.date)}</div></div>
            <div style="font-weight:700;color:var(--green);">${fmtMoney(a.price)}</div>
          </div>`);
        });
        html.push('</div>');
      }

      el.innerHTML = html.join('');
    } catch(e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load dashboard</p></div>'; }
  },

  // Open appointment detail from dashboard (loads Appointments data then shows detail)
  async _openAppt(apptId) {
    try {
      const appts = await db.appointments.all({ date: today() });
      Appointments._data = appts;
      const barbers  = await db.barbers.all();
      const services = await db.services.all();
      Appointments._barbers  = barbers;
      Appointments._services = services;
      Appointments.openDetail(apptId);
    } catch(e) { toast('Could not load appointment', 'error'); }
  },

  // Quick-complete from dashboard — opens the checkout flow
  async _complete(apptId) {
    try {
      const appts = await db.appointments.all({ date: today() });
      Appointments._data = appts;
      const barbers  = await db.barbers.all();
      const services = await db.services.all();
      Appointments._barbers  = barbers;
      Appointments._services = services;
      await Appointments.complete(apptId);
    } catch(e) { toast('Could not complete appointment', 'error'); }
  },
};

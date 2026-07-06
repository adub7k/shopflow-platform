// ── Onboarding checklist ──────────────────────────────────────────────────────
function renderOnboarding(settings, barbers) {
  if (!canSee('settings')) return ''; // owner-only setup checklist
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
      icon: '🚗',
      label: 'Add your '+V('staffPlural','barbers').toLowerCase(),
      desc: 'Replace the default '+V('staff','barber').toLowerCase()+' with your real team',
      done: barbers.some(b => b.name && b.name !== V('staff','Barber')+' 1'),
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
      desc: 'Use it to ask clients for a review after a visit',
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
      const showRev = canSee('revenue');
      const [rev, allAppts, customers, leads, settings, barbers] = await Promise.all([
        showRev ? db.revenue.get().catch(()=>({})) : Promise.resolve({}),
        db.appointments.all().catch(()=>[]),
        db.customers.all().catch(()=>[]),
        db.leads.all().catch(()=>[]),
        db.settings.get().catch(()=>({shopName:'ShopFlow'})),
        db.barbers.all().catch(()=>[]),
      ]);
      const t0 = today();
      // Today's schedule (earliest first), today's collected revenue.
      const parseTime=t=>{if(!t)return 0;const[tm,ap]=t.split(' ');let[h,m]=tm.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+m;};
      const appts = (allAppts||[]).filter(a=>a.date===t0).sort((a,b)=>parseTime(a.time)-parseTime(b.time));
      const upcomingToday = appts.filter(a=>a.status==='confirmed'||a.status==='in-progress');
      const todayRevenue = (allAppts||[]).filter(a=>a.date===t0 && a.status==='done').reduce((s,a)=>s+(Number(a.price)||0),0);
      // Reuse the Tasks worklist engine for the follow-ups (win-backs + service-due);
      // new leads are surfaced separately below.
      let followUps = [];
      try {
        Tasks._customers=customers||[]; Tasks._leads=leads||[]; Tasks._rebook=(settings&&settings.rebookInterval)||21; Tasks._wb=Tasks._winbackFrom(settings);
        Tasks._byCust={}; (allAppts||[]).forEach(a=>{ if(a.customerId)(Tasks._byCust[a.customerId]=Tasks._byCust[a.customerId]||[]).push(a); });
        const g=Tasks._build(); followUps=[...(g.overdue||[]),...(g.today||[])].filter(t=>t.source!=='lead');
      } catch(e){ console.warn('Tasks:',e.message); }
      const newLeads=(leads||[]).filter(l=>l.status==='new').sort((a,b)=> new Date(b.createdAt||b.lastContactAt||0)-new Date(a.createdAt||a.lastContactAt||0));
      const html = [];

      // Onboarding checklist
      html.push(renderOnboarding(settings, barbers));

      // Greeting
      const hr = new Date().getHours();
      const greet = hr<12?'morning':hr<17?'afternoon':'evening';
      html.push(`<div style="margin-bottom:20px;"><div style="font-size:22px;font-weight:800;color:var(--text);letter-spacing:-.03em;">Good ${greet} 👋</div><div style="font-size:13px;color:var(--muted);margin-top:2px;">${settings.shopName||'ShopFlow'} &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div></div>`);

      // At-a-glance stat row — each card jumps to its section.
      const stat=(label,value,sub,nav,cls)=>`<div class="metric-card" style="cursor:pointer;" onclick="App.nav('${nav}')"><div class="metric-label">${label}</div><div class="metric-value ${cls||''}">${value}</div><div class="metric-sub">${sub}</div></div>`;
      html.push('<div class="metric-grid">');
      if (showRev) html.push(stat('Revenue MTD', fmtMoney(rev.monthRevenue||0), fmtMoney(todayRevenue)+' today', 'revenue', 'green'));
      html.push(stat("Today's Appts", upcomingToday.length, appts.length+' scheduled', 'appointments', ''));
      html.push(stat('Follow-ups', followUps.length, followUps.length?'due now':'all clear', 'tasks', ''));
      html.push(stat('New Leads', newLeads.length, newLeads.length?'to contact':'none waiting', 'leads', ''));
      html.push('</div>');

      // Cleaning-specific overview (operational metrics; money cards gated by role)
      if (Shop.industry === 'cleaning') {
        let recurring=[], crews=[];
        try { [recurring, crews] = await Promise.all([db.recurring.all().catch(()=>[]), db.crews.all().catch(()=>[])]); } catch(e){}
        const activeRec    = recurring.filter(r=>r.active!==false);
        const recurClients = new Set(activeRec.map(r=>r.customerId).filter(Boolean)).size;
        const jobsToday    = appts.length;
        const activeCleaners = barbers.filter(b=>b.active!==false).length || barbers.length;
        const crewsWorking = new Set(appts.filter(a=>a.crewId).map(a=>a.crewId)).size;
        const crewUtil     = crews.length ? Math.round(crewsWorking/crews.length*100) : 0;
        // Normalize each active contract to a monthly figure for recurring revenue.
        const perMonth = (r)=>{ switch(r.cadence){
          case 'daily':    return 30;
          case 'weekly':   return 52/12;
          case 'biweekly': return 26/12;
          case 'monthly':  return 1;
          case 'custom':   return 30/Math.max(1,(r.customRule&&r.customRule.everyDays)||7);
          default:         return 52/12; } };
        const recurMrr = activeRec.reduce((s,r)=>s+(Number(r.price)||0)*perMonth(r),0);
        const cleanerLabel = V('staff','Cleaner');
        const cards = [];
        cards.push(`<div class="metric-card"><div class="metric-label">Jobs Today</div><div class="metric-value">${jobsToday}</div><div class="metric-sub">scheduled</div></div>`);
        cards.push(`<div class="metric-card"><div class="metric-label">Active Recurring</div><div class="metric-value">${recurClients}</div><div class="metric-sub">client${recurClients!==1?'s':''} on a schedule</div></div>`);
        if (canSee('revenue')) cards.push(`<div class="metric-card"><div class="metric-label">Recurring Revenue</div><div class="metric-value green">${fmtMoney(recurMrr)}</div><div class="metric-sub">/mo from contracts</div></div>`);
        if (canSee('revenue')) cards.push(`<div class="metric-card"><div class="metric-label">Revenue / ${esc(cleanerLabel)}</div><div class="metric-value">${fmtMoney(activeCleaners?rev.monthRevenue/activeCleaners:0)}</div><div class="metric-sub">${activeCleaners} ${esc(cleanerLabel.toLowerCase())}${activeCleaners!==1?'s':''} · MTD</div></div>`);
        cards.push(`<div class="metric-card"><div class="metric-label">Crew Utilization</div><div class="metric-value">${crewUtil}%</div><div class="metric-sub">${crewsWorking} of ${crews.length} crew${crews.length!==1?'s':''} today</div></div>`);
        html.push('<div class="section-header">Cleaning Overview</div>');
        html.push('<div class="metric-grid">'+cards.join('')+'</div>');
      }

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
                '<div class="list-name">' + esc(a.customerName) + '</div>' +
                '<div class="list-sub">' + esc(a.time) + ' · ' + esc(a.service) + (a.barberName ? ' · ' + esc(a.barberName) : '') + '</div>' +
              '</div>' +
              '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
                (canComplete ? completeBtn : statusBadge(a.status)) +
              '</div>' +
            '</div>'
          );
        });
        html.push('</div>');
      }

      // Follow-ups (retention worklist — win-backs + service-due reminders).
      if (followUps.length) {
        html.push(`<div class="section-header"><span>Follow-ups</span><button class="btn btn-sm" onclick="App.nav('tasks')">View all (${followUps.length})</button></div>`);
        html.push('<div class="list-card">');
        followUps.slice(0,3).forEach(t=>{
          html.push('<div class="list-row">'+avatarEl(t.name,38)+'<div class="list-main"><div class="list-name">'+esc(t.name)+'</div><div class="list-sub">'+esc(t.reason)+'</div></div>'+(t.phone?'<button class="btn btn-sm btn-green" onclick="Tasks.text(\''+t.id+'\')">💬 Text</button>':'')+'</div>');
        });
        html.push('</div>');
      }

      // New leads (uncontacted inbound from call tracking).
      if (newLeads.length) {
        html.push(`<div class="section-header"><span>New Leads</span><button class="btn btn-sm" onclick="App.nav('leads')">View all (${newLeads.length})</button></div>`);
        html.push('<div class="list-card">');
        newLeads.slice(0,3).forEach(l=>{
          const nm=l.name||l.phone||'Unknown caller';
          const q=(typeof _leadQuality==='function')?_leadQuality(l):'';
          const qb=(q&&typeof _leadQualityBadge==='function')?_leadQualityBadge(q):'';
          const interest=(typeof _leadInterest==='function')?_leadInterest(l):'';
          const sub=[interest?('🎯 '+interest):'', l.location].filter(Boolean).join(' · ') || 'inbound call';
          html.push('<div class="list-row" style="cursor:pointer;" onclick="App.nav(\'leads\')">'+avatarEl(l.name||'☎',38)+'<div class="list-main"><div class="list-name">'+esc(nm)+' '+qb+'</div><div class="list-sub">'+esc(sub)+'</div></div>'+(l.phone?'<a class="btn btn-sm" href="tel:'+esc(l.phone)+'" onclick="event.stopPropagation()">📞</a>':'')+'</div>');
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
            <div style="flex:1;font-size:14px;font-weight:600;color:var(--text);">${esc(c.name)}</div>
            <button class="btn btn-sm btn-green" onclick="event.stopPropagation();Clients.redeemReward('${c.id}','${jsAttr(c.name)}')">Redeem</button>
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

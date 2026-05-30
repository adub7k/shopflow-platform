
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
      try{appts=await db.appointments.all({date:today()});}catch(e){console.warn('Appts:',e.message);}
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
        appts.slice(0,5).forEach(a => {
          html.push(`<div class="list-row" onclick="App.nav('appointments')">
            ${avatarEl(a.customerName,38)}
            <div class="list-main">
              <div class="list-name">${a.customerName}</div>
              <div class="list-sub">${a.time} · ${a.service}${a.barberName?' · '+a.barberName:''}</div>
            </div>
            ${statusBadge(a.status)}
          </div>`);
        });
        html.push('</div>');
      }

      // Loyalty alerts
      if (rev.loyaltyAlerts?.length) {
        html.push('<div class="section-header">🎉 Loyalty Rewards Ready</div>');
        html.push('<div class="card" style="background:var(--green-lt);border-color:var(--green-md);">');
        rev.loyaltyAlerts.slice(0,3).forEach(c => {
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--green-md);">
            ${avatarEl(c.name,34)}
            <div style="flex:1;font-size:14px;font-weight:600;color:var(--text);">${c.name}</div>
            <button class="btn btn-sm btn-green" onclick="Clients.redeemReward('${c.id}','${c.name}')">Redeem</button>
          </div>`);
        });
        html.push('</div>');
      }

      // Recent done
      if (rev.recentDone?.length) {
        html.push('<div class="section-header">Recent Completed</div>');
        html.push('<div class="list-card">');
        rev.recentDone.slice(0,4).forEach(a => {
          html.push(`<div class="list-row">
            ${avatarEl(a.customerName,36)}
            <div class="list-main"><div class="list-name">${a.customerName}</div><div class="list-sub">${a.service} · ${fmtDateShort(a.date)}</div></div>
            <div style="font-weight:700;color:var(--green);">${fmtMoney(a.price)}</div>
          </div>`);
        });
        html.push('</div>');
      }

      el.innerHTML = html.join('');
    } catch(e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load dashboard</p></div>'; }
  }
};

// ── Appointments ──────────────────────────────────────────────────────────────
const Appointments = {
  _data: [], _barbers: [], _services: [],
  _selected: today(),
  _prefill: null, // set by Clients.bookAppointment to pre-fill form after nav

  _view: 'month', // 'month' or 'week'

  async render() {
    const el = document.getElementById('page-appointments'); if(!el)return;
    try {
      const month = this._selected.slice(0,7);
      [this._data, this._barbers, this._services] = await Promise.all([
        db.appointments.all({month}), db.barbers.all(), db.services.all()
      ]);
      const html = [];

      // View toggle + nav
      const dt = new Date(this._selected+'T12:00:00');
      const monthLabel = dt.toLocaleDateString('en-US',{month:'long',year:'numeric'});
      html.push(`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <button class="btn btn-sm" onclick="Appointments.changeMonth(-1)">&#8249;</button>
        <div style="font-size:15px;font-weight:700;">${monthLabel}</div>
        <button class="btn btn-sm" onclick="Appointments.changeMonth(1)">&#8250;</button>
      </div>`);

      // View toggle
      html.push(`<div style="display:flex;gap:6px;margin-bottom:14px;">
        <button class="btn btn-sm${this._view==='month'?' btn-primary':''}" onclick="Appointments._view='month';Appointments.render()">Month</button>
        <button class="btn btn-sm${this._view==='week'?' btn-primary':''}" onclick="Appointments._view='week';Appointments.render()">Week</button>
      </div>`);

      if (this._view==='week') {
        html.push(this._buildWeekView());
      } else {
        // Mini calendar
        html.push(this._buildCalendar(dt));
      }

      // Add button
      html.push(`<div class="section-header"><span>Appointments — ${fmtDateFull(this._selected)}</span><button class="btn btn-sm btn-green" onclick="Appointments.openForm(null)">+ Add</button></div>`);

      // Day's appointments
      const dayAppts = this._data.filter(a=>a.date===this._selected).sort((a,b)=>a.time.localeCompare(b.time));
      if (!dayAppts.length) {
        html.push('<div class="card"><div class="empty-state"><div class="empty-icon">📅</div><div class="empty-text">No appointments this day</div></div></div>');
      } else {
        html.push('<div class="list-card">');
        dayAppts.forEach(a => {
          const barber = this._barbers.find(b=>b.id===a.barberId);
          html.push(`<div class="list-row" onclick="Appointments.openDetail('${a.id}')">
            <div style="width:3px;min-height:44px;background:${barber?.color||'#ccc'};border-radius:2px;flex-shrink:0;"></div>
            ${avatarEl(a.customerName,38)}
            <div class="list-main">
              <div class="list-name">${a.customerName}</div>
              <div class="list-sub">${a.time} · ${a.service}${barber?' · '+barber.name:''}</div>
            </div>
            <div class="list-right">${statusBadge(a.status)}<div style="font-size:12px;color:var(--muted);margin-top:3px;">${fmtMoney(a.price)}</div></div>
          </div>`);
        });
        html.push('</div>');
      }
      el.innerHTML = html.join('');

      // If navigated here from a client profile, open the pre-filled form
      if (this._prefill) {
        const p = this._prefill; this._prefill = null;
        setTimeout(() => this.openFormPrefilled(p.customerId, p.customerName, p.customerPhone), 100);
      }
    } catch(e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load appointments</p></div>'; }
  },

  _buildCalendar(dt) {
    const year=dt.getFullYear(), month=dt.getMonth();
    const first=new Date(year,month,1).getDay();
    const days=new Date(year,month+1,0).getDate();
    const datesWithAppts=new Set(this._data.map(a=>a.date));
    const todayStr=today();
    let html='<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;">';
    html+='<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px;">';
    ['S','M','T','W','T','F','S'].forEach(d=>html+=`<div style="text-align:center;font-size:10px;font-weight:700;color:var(--faint);padding:3px 0;">${d}</div>`);
    html+='</div><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;">';
    for(let i=0;i<first;i++) html+='<div></div>';
    for(let d=1;d<=days;d++){
      const dateStr=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday=dateStr===todayStr, isSel=dateStr===this._selected, hasAppt=datesWithAppts.has(dateStr);
      const bg=isSel?'background:#16a34a;color:#fff;':isToday?'background:var(--green-lt);color:var(--green);':'';
      html+=`<div onclick="Appointments.selectDay('${dateStr}')" style="aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:7px;font-size:13px;cursor:pointer;${bg}position:relative;">
        ${d}
        ${hasAppt?`<div style="width:4px;height:4px;border-radius:50%;background:${isSel?'#fff':'var(--green)'};position:absolute;bottom:2px;"></div>`:''}
      </div>`;
    }
    html+='</div></div>';
    return html;
  },

  selectDay(date) { this._selected=date; this.render(); },

  _buildWeekView() {
    // Get start of week (Sunday) for selected date
    const dt = new Date(this._selected+'T12:00:00');
    const dow = dt.getDay();
    const weekStart = new Date(dt); weekStart.setDate(dt.getDate()-dow);
    const days = [];
    for (let i=0;i<7;i++) {
      const d = new Date(weekStart); d.setDate(weekStart.getDate()+i);
      days.push(d.toISOString().split('T')[0]);
    }
    const todayStr = today();
    let html = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px;">';
    // Week header
    html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);border-bottom:1px solid var(--border);">';
    days.forEach(date => {
      const d = new Date(date+'T12:00:00');
      const isToday = date===todayStr;
      const isSel = date===this._selected;
      const dayAppts = this._data.filter(a=>a.date===date);
      html += `<div onclick="Appointments.selectDay('${date}')" style="padding:8px 4px;text-align:center;cursor:pointer;background:${isSel?'var(--green)':isToday?'var(--green-lt)':'var(--surface)'};border-right:1px solid var(--border);">
        <div style="font-size:10px;font-weight:600;color:${isSel?'rgba(255,255,255,.8)':isToday?'var(--green)':'var(--faint)'};">${d.toLocaleDateString('en-US',{weekday:'short'})}</div>
        <div style="font-size:15px;font-weight:800;color:${isSel?'#fff':isToday?'var(--green)':'var(--text)'};">${d.getDate()}</div>
        ${dayAppts.length?`<div style="width:6px;height:6px;border-radius:50%;background:${isSel?'rgba(255,255,255,.7)':'var(--green)'};margin:2px auto 0;"></div>`:''}
      </div>`;
    });
    html += '</div>';
    // Selected day appointments
    const selAppts = this._data.filter(a=>a.date===this._selected).sort((a,b)=>a.time.localeCompare(b.time));
    if (!selAppts.length) {
      html += '<div style="text-align:center;padding:24px;color:var(--faint);font-size:13px;">No appointments this day</div>';
    } else {
      selAppts.forEach(a=>{
        const barber = this._barbers.find(b=>b.id===a.barberId);
        html += `<div onclick="Appointments.openDetail('${a.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s;" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background=''">
          <div style="width:3px;height:36px;background:${barber?.color||'#ccc'};border-radius:2px;flex-shrink:0;"></div>
          <div style="width:52px;font-size:11px;color:var(--muted);font-weight:600;flex-shrink:0;">${a.time}</div>
          ${avatarEl(a.customerName,32)}
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.customerName}</div>
            <div style="font-size:11px;color:var(--muted);">${a.service}${barber?' · '+barber.name:''}</div>
          </div>
          ${statusBadge(a.status)}
        </div>`;
      });
    }
    html += '</div>';
    return html;
  },

  changeMonth(delta) {
    const dt=new Date(this._selected+'T12:00:00');
    dt.setMonth(dt.getMonth()+delta);
    this._selected=dt.toISOString().split('T')[0];
    this.render();
  },

  openForm(id) {
    const a = id ? this._data.find(x=>x.id===id) : null;
    const barberOpts = this._barbers.map(b=>`<option value="${b.id}|${b.name}"${a?.barberId===b.id?' selected':''}>${b.name}</option>`).join('');
    const svcOpts = this._services.map(s=>`<option value="${s.id}|${s.name}|${s.price}"${a?.serviceId===s.id?' selected':''}>${s.name} — ${fmtMoney(s.price)}</option>`).join('');
    Modal.show(`
      <div class="modal-title">${a?'Edit Appointment':'New Appointment'}</div>
      <div class="form-group"><label class="form-label">Client *</label>
        <div class="autocomplete-wrap"><input class="form-input" id="fa-name" value="${a?.customerName||''}" placeholder="Search or type name..." /><div class="autocomplete-list" id="fa-list"></div></div>
        <input type="hidden" id="fa-cid" value="${a?.customerId||''}" />
        <input type="hidden" id="fa-phone" value="${a?.customerPhone||''}" />
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Service</label>
          <select class="form-input" id="fa-svc" onchange="Appointments._svcChange()">${svcOpts}</select>
        </div>
        <div class="form-group"><label class="form-label">Price</label>
          <input class="form-input" id="fa-price" type="number" value="${a?.price||35}" />
        </div>
      </div>
      <div class="form-group"><label class="form-label">Barber</label>
        <select class="form-input" id="fa-barber"><option value="|">Any barber</option>${barberOpts}</select>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Date</label><input class="form-input" id="fa-date" type="date" value="${a?.date||this._selected}" /></div>
        <div class="form-group"><label class="form-label">Time</label><input class="form-input" id="fa-time" type="time" value="${a?.time?this._to24(a.time):'10:00'}" /></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="fa-notes" value="${a?.notes||''}" placeholder="Optional notes..." /></div>
      <div class="modal-actions">
        ${a?`<button class="btn btn-green btn-full" onclick="Appointments.complete('${a.id}')">✓ Mark Complete</button>`:''}
        ${a?`<button class="btn btn-danger btn-full" onclick="Appointments.delete('${a.id}')">Delete</button>`:''}
        <button id="fa-btn" class="btn btn-primary btn-full" onclick="Appointments.save('${a?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>{
      makeAutocomplete('fa-name','fa-list',(id,name,phone)=>{document.getElementById('fa-name').value=name;document.getElementById('fa-cid').value=id;document.getElementById('fa-phone').value=phone||'';});
    },150);
  },

  openFormPrefilled(customerId, customerName, customerPhone) {
    // Ensure barbers/services are loaded then open a new appointment form pre-filled with client
    const load = (this._barbers.length && this._services.length)
      ? Promise.resolve()
      : Promise.all([db.barbers.all(), db.services.all()]).then(([b,s])=>{ this._barbers=b; this._services=s; });
    load.then(() => {
      this.openForm(null);
      // After form renders, fill in the client fields
      setTimeout(() => {
        const nameEl  = document.getElementById('fa-name');
        const cidEl   = document.getElementById('fa-cid');
        const phoneEl = document.getElementById('fa-phone');
        if (nameEl)  nameEl.value  = customerName;
        if (cidEl)   cidEl.value   = customerId;
        if (phoneEl) phoneEl.value = customerPhone;
      }, 80);
    });
  },

  _svcChange() {
    const val=document.getElementById('fa-svc')?.value||'';
    const [,, price]=val.split('|');
    if(price){const pi=document.getElementById('fa-price');if(pi)pi.value=price;}
  },

  _to24(t12) {
    if(!t12)return'10:00';
    const [time,ampm]=t12.split(' ');
    let [h,m]=time.split(':');
    h=parseInt(h);
    if(ampm==='PM'&&h!==12)h+=12;
    if(ampm==='AM'&&h===12)h=0;
    return `${String(h).padStart(2,'0')}:${m}`;
  },

  _to12(t24) {
    if(!t24)return'10:00 AM';
    const [h,m]=t24.split(':').map(Number);
    const ampm=h>=12?'PM':'AM';
    const h12=h%12||12;
    return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
  },

  async save(id) {
    const name=document.getElementById('fa-name')?.value.trim();
    if(!name){toast('Please enter a client name','warning');return;}
    const svcVal=document.getElementById('fa-svc')?.value||'';
    const[svcId,svcName]=svcVal.split('|');
    const barberVal=document.getElementById('fa-barber')?.value||'';
    const[barberId,barberName]=barberVal.split('|');
    const timeVal=document.getElementById('fa-time')?.value||'10:00';
    const btn=document.getElementById('fa-btn'); disableBtn(btn);
    try {
      await db.appointments.save({
        id:id||genId('a'),
        customerId:document.getElementById('fa-cid')?.value||null,
        customerName:name,
        customerPhone:document.getElementById('fa-phone')?.value||'',
        barberId:barberId||null, barberName:barberName||null,
        serviceId:svcId||null, service:svcName||'Haircut',
        price:parseFloat(document.getElementById('fa-price')?.value)||35,
        date:document.getElementById('fa-date')?.value||today(),
        time:this._to12(timeVal),
        duration:45,
        status:id?(this._data.find(x=>x.id===id)?.status||'confirmed'):'confirmed',
        notes:document.getElementById('fa-notes')?.value.trim()||'',
        source:'crm',
      });
      Modal.close(); toast(id?'Updated ✓':'Appointment added ✓');
      await this.render(); Dashboard.render();
    }catch(e){toast('Could not save','error');enableBtn(btn);}
  },

  openDetail(id) {
    const a=this._data.find(x=>x.id===id); if(!a)return;
    const barber=this._barbers.find(b=>b.id===a.barberId);
    Modal.show(`
      <div class="modal-title">📅 Appointment</div>
      <div style="background:var(--surface2);border-radius:10px;padding:14px;margin-bottom:16px;">
        <div style="font-size:16px;font-weight:700;">${a.customerName}</div>
        <div style="font-size:13px;color:var(--muted);margin-top:4px;">${a.service} · ${fmtDateFull(a.date)} at ${a.time}</div>
        ${barber?`<div style="font-size:13px;color:var(--muted);">with ${barber.name}</div>`:''}
        <div style="margin-top:8px;">${statusBadge(a.status)} <span style="font-weight:700;color:var(--green);margin-left:8px;">${fmtMoney(a.price)}</span></div>
        ${a.notes?`<div style="font-size:13px;color:var(--muted);margin-top:8px;">${a.notes}</div>`:''}
        ${a.customerPhone?`<div style="font-size:13px;color:var(--muted);margin-top:4px;">📱 ${a.customerPhone}</div>`:''}
      </div>
      <div class="modal-actions">
        ${a.status==='confirmed'||a.status==='in-progress'?`<button class="btn btn-green btn-full" onclick="Appointments.complete('${a.id}')">✓ Mark Complete</button>`:''}
        ${a.status==='confirmed'?`<button class="btn btn-full" style="color:var(--orange);border-color:#fde68a;" onclick="Appointments.noShow('${a.id}')">😤 No Show</button>`:''}
        ${a.status==='confirmed'&&!a.depositPaid&&!a.depositWaived?`<button class="btn btn-full" style="color:var(--muted);" onclick="Appointments.waiveDeposit('${a.id}')">⚡ Waive Deposit</button>`:''}
        <button class="btn btn-full" onclick="Appointments.openForm('${a.id}')">Edit</button>
        <button class="btn btn-danger btn-full" onclick="Appointments.delete('${a.id}')">Delete</button>
        <button class="btn btn-full" onclick="Modal.close()">Close</button>
      </div>`);
  },

  // Stores amount/tip/url/sessionId between the two checkout modal steps
  _co: { id:null, price:0, tip:0, url:'', sessionId:'', phone:'', name:'' },

  async complete(id) {
    const a = this._data.find(x=>x.id===id); if(!a) return;
    this._co = { id, price: Number(a.price||35), tip:0, url:'', sessionId:'', phone: a.customerPhone||'', name: a.customerName||'' };
    let stripeConnected = false;
    try { const st = await db.stripe.status(); stripeConnected = st.connected; } catch(e) {}

    Modal.show(`
      <div class="modal-title">💈 Checkout</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">${a.customerName} · ${a.service}</div>
      <div class="form-group">
        <label class="form-label">Amount</label>
        <div style="position:relative;">
          <div style="position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:18px;font-weight:700;color:var(--green);">$</div>
          <input class="form-input" id="cc-price" type="number" value="${a.price||35}" style="font-size:22px;font-weight:700;padding-left:28px;" oninput="Appointments._updateTotal()" />
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
          ${[25,30,35,40,45,50,60].map(p=>`<button class="btn btn-sm" onclick="document.getElementById('cc-price').value=${p};Appointments._updateTotal()">${fmtMoney(p)}</button>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Tip</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${[0,2,5,10].map(t=>`<button class="btn btn-sm" id="tip-${t}" onclick="Appointments._setTip(${t})" style="${t===0?'background:var(--text);color:#fff;border-color:var(--text);':''}">${t===0?'No tip':'$'+t}</button>`).join('')}
          <button class="btn btn-sm" onclick="Appointments._setTip('custom')">Custom</button>
        </div>
        <input type="hidden" id="cc-tip" value="0" />
        <input class="form-input" id="cc-tip-custom" type="number" placeholder="Custom tip amount" style="display:none;margin-top:8px;" oninput="document.getElementById('cc-tip').value=this.value||0;Appointments._updateTotal()" />
      </div>
      <div class="form-group">
        <label class="form-label">Cut Notes <span style="font-weight:400;color:var(--faint);">(optional)</span></label>
        <textarea class="form-input" id="cc-notes" rows="2" placeholder="e.g. 2 on sides, scissors on top, blended fade, no product…"></textarea>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:13px;font-weight:600;color:var(--muted);">Total</span>
        <span id="cc-total" style="font-size:22px;font-weight:800;color:var(--green);">${fmtMoney(a.price||35)}</span>
      </div>
      <div class="modal-actions">
        <button class="btn btn-full" style="background:var(--text);color:#fff;" onclick="Appointments._checkoutCash()">💵 Cash</button>
        ${stripeConnected
          ? `<button class="btn btn-full btn-green" onclick="Appointments._checkoutCard()">💳 Send Card Link</button>`
          : `<button class="btn btn-full" style="opacity:.5;cursor:default;" disabled>💳 Card (connect Stripe in Settings)</button>`
        }
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
  },

  _setTip(val) {
    document.querySelectorAll('[id^="tip-"]').forEach(b=>{ b.style.background=''; b.style.color=''; b.style.borderColor=''; });
    if (val === 'custom') {
      document.getElementById('cc-tip-custom').style.display = 'block';
    } else {
      document.getElementById('cc-tip-custom').style.display = 'none';
      document.getElementById('cc-tip').value = val;
      const btn = document.getElementById('tip-'+val);
      if (btn) { btn.style.background='var(--text)'; btn.style.color='#fff'; btn.style.borderColor='var(--text)'; }
      Appointments._updateTotal();
    }
  },

  _updateTotal() {
    const price = parseFloat(document.getElementById('cc-price')?.value)||0;
    const tip   = parseFloat(document.getElementById('cc-tip')?.value)||0;
    Appointments._co.price = price;
    Appointments._co.tip   = tip;
    const el = document.getElementById('cc-total');
    if (el) el.textContent = '$'+(price+tip).toFixed(2).replace(/\.00$/,'');
  },

  async _checkoutCash() {
    const { id, price, tip } = Appointments._co;
    const cutNotes = document.getElementById('cc-notes')?.value.trim() || '';
    try {
      await db.checkout.cash({ appointmentId: id, amount: price, tip, cutNotes });
      Modal.close(); toast('💵 Cash payment logged ✓');
      await Appointments.render(); Dashboard.render();
    } catch(e) { toast('Error logging payment','error'); }
  },

  async _checkoutCard() {
    Appointments._updateTotal(); // capture latest values before switching modal
    Appointments._co.cutNotes = document.getElementById('cc-notes')?.value.trim() || '';
    const { id, price, tip, phone, name } = Appointments._co;
    const total = price + tip;
    Modal.show(`
      <div class="modal-title">💳 Card Payment</div>
      <div style="font-size:22px;font-weight:800;color:var(--green);text-align:center;margin-bottom:4px;">${fmtMoney(total)}</div>
      <div style="font-size:12px;color:var(--muted);text-align:center;margin-bottom:20px;">for ${name}</div>
      <div id="card-status" style="text-align:center;padding:16px 0;">
        <div style="font-size:13px;color:var(--muted);">Generating payment link...</div>
      </div>
      <div style="margin-top:12px;">
        <button class="btn btn-full" onclick="Appointments._checkoutCash()">Switch to Cash Instead</button>
      </div>`);
    try {
      const r = await db.checkout.session({ appointmentId: id, amount: price, tip });
      const statusEl = document.getElementById('card-status');
      if (!statusEl) return; // modal was closed
      if (!r || !r.ok) { toast(r?.error||'Could not create payment link — check Stripe settings','error'); return; }

      // Store URL safely — never embed in onclick strings
      Appointments._co.url       = r.url;
      Appointments._co.sessionId = r.sessionId;

      const hasPhone = phone && phone.replace(/\D/g,'').length >= 10;
      statusEl.innerHTML = `
        <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Share this link with the client to collect payment:</div>
        <div style="display:flex;gap:6px;margin-bottom:12px;">
          <input class="form-input" id="pay-link-input" readonly style="font-size:11px;flex:1;" onclick="this.select()" />
          <button class="btn btn-sm" onclick="navigator.clipboard.writeText(Appointments._co.url);toast('Link copied ✓')">Copy</button>
        </div>
        ${hasPhone ? `<button class="btn btn-green btn-full" id="send-link-btn" onclick="Appointments._textPayLink()">📱 Text to ${phone}</button>` : ''}
        <div style="margin-top:10px;">
          <button class="btn btn-full" id="verify-btn" onclick="Appointments._verifyPayment(this)">✓ Check Payment</button>
        </div>`;
      // Set URL value via JS to avoid HTML encoding issues
      const linkInput = document.getElementById('pay-link-input');
      if (linkInput) linkInput.value = r.url;
    } catch(e) { toast('Could not create payment link — check Stripe settings','error'); }
  },

  async _textPayLink() {
    const { phone, name, url } = Appointments._co;
    const btn = document.getElementById('send-link-btn'); if(btn){btn.disabled=true;btn.textContent='Sending...';}
    const firstName = name.split(' ')[0];
    const msg = `Hi ${firstName}! Here's your payment link for today's visit: ${url}`;
    try {
      await db.sms.send({ to: phone, body: msg, customerName: name });
      if(btn){btn.textContent='✓ Sent!';btn.style.background='var(--green)';}
      toast('Payment link sent via text ✓');
    } catch(e) { toast('Could not send text','error'); if(btn){btn.disabled=false;btn.textContent='📱 Text to '+phone;} }
  },

  async _verifyPayment(btn) {
    const { sessionId, id } = Appointments._co;
    const origText = btn.textContent;
    btn.disabled = true; btn.textContent = 'Checking...';
    try {
      const r = await db.checkout.verify(sessionId, id);
      if (r.paid) {
        Modal.close(); toast('💳 Card payment confirmed ✓');
        await Appointments.render(); Dashboard.render();
      } else {
        btn.disabled = false; btn.textContent = origText;
        toast('Payment not received yet — try again in a moment','warning');
      }
    } catch(e) { btn.disabled=false; btn.textContent=origText; toast('Could not verify','error'); }
  },

  async noShow(id) {
    const a = this._data.find(x=>x.id===id);
    if (!confirm((a?.customerName||'Client')+' did not show up. Mark as no-show?')) return;
    try {
      await db.appointments.noshow(id);
      Modal.close();
      toast('Marked as no-show');
      await this.render();
      Dashboard.render();
    } catch(e) { toast('Error marking no-show','error'); }
  },

  async waiveDeposit(id) {
    const a = this._data.find(x=>x.id===id);
    if (!confirm('Waive the deposit for '+(a?.customerName||'this client')+'? They will not need to pay before arriving.')) return;
    try {
      await apiFetch('/appointments/'+id+'/waive-deposit',{method:'POST'});
      Modal.close(); toast('Deposit waived ✓'); await this.render();
    } catch(e) { toast('Error','error'); }
  },

  async delete(id) {
    if(!confirm('Delete this appointment?'))return;
    await db.appointments.delete(id);
    Modal.close(); this.render(); toast('Deleted');
  },
};

// ── Clients ───────────────────────────────────────────────────────────────────
const Clients = {
  _data: [], _search: '', _retentionDays: 90, _retentionOpen: false,
  _view: 'list', _profileId: null, _messages: [], _profileData: null,

  async render() {
    const el=document.getElementById('page-clients'); if(!el)return;
    if (this._view === 'profile') { await this._renderProfile(el); return; }
    try {
      this._data = await db.customers.all();
      const html = [];
      const loyalty = (await db.settings.get()).loyalty||{visitsForReward:10};

      // Search + add
      html.push(`<div style="display:flex;gap:8px;margin-bottom:16px;">
        <input class="form-input" id="client-search" placeholder="Search clients..." value="${this._search}" oninput="Clients._filter(this.value)" style="flex:1;" />
        <button class="btn btn-green" onclick="Clients.openForm(null)">+ Add</button>
      </div>`);

      // ── Client Retention ──
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - this._retentionDays);
      const cutoffStr = cutoff.toISOString().split('T')[0];
      const atRisk = this._data.filter(c => c.lastVisit && c.lastVisit < cutoffStr);
      const noVisitYet = this._data.filter(c => !c.lastVisit);

      html.push(`<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px;">
        <div onclick="Clients._toggleRetention()" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;cursor:pointer;background:var(--surface);user-select:none;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:20px;">📉</span>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text);">Client Retention</div>
              <div style="font-size:11px;color:var(--muted);margin-top:1px;">${atRisk.length} client${atRisk.length!==1?'s':''} haven't been in over ${this._retentionDays} days</div>
            </div>
          </div>
          <span style="font-size:18px;color:var(--muted);transform:${this._retentionOpen?'rotate(180deg)':'rotate(0deg)'};transition:transform .2s;">⌄</span>
        </div>
        ${this._retentionOpen ? this._buildRetention(atRisk, noVisitYet) : ''}
      </div>`);

      // ── All Clients ──
      const filtered = this._search ? this._data.filter(c=>c.name.toLowerCase().includes(this._search.toLowerCase())||(c.phone||'').includes(this._search)) : this._data;

      html.push(`<div class="section-header">All Clients <span style="font-size:11px;font-weight:400;color:var(--faint);">${filtered.length} total</span></div>`);

      if(!filtered.length){
        html.push('<div class="card"><div class="empty-state"><div class="empty-icon">👤</div><div class="empty-text">'+(this._search?'No clients found':'No clients yet')+'</div></div></div>');
      } else {
        html.push('<div class="list-card">');
        filtered.forEach(c=>{
          const rewardReady=(c.loyaltyPoints||0)>=(loyalty.visitsForReward||10);
          html.push(`<div class="list-row" onclick="Clients.openDetail('${c.id}')">
            ${avatarEl(c.name,40)}
            <div class="list-main">
              <div class="list-name">${c.name}${rewardReady?' 🎉':''}</div>
              <div class="list-sub">${c.phone||'No phone'}${c.totalVisits?' · '+c.totalVisits+' visits':''}</div>
            </div>
            <div class="list-right">
              ${c.lastVisit?`<div style="font-size:11px;color:var(--faint);">${fmtDateShort(c.lastVisit)}</div>`:''}
              <div style="font-size:11px;color:var(--muted);margin-top:2px;">${c.loyaltyPoints||0}/${loyalty.visitsForReward} pts</div>
            </div>
          </div>`);
        });
        html.push('</div>');
      }
      el.innerHTML=html.join('');
    }catch(e){el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load clients</p></div>';}
  },

  _toggleRetention() { this._retentionOpen=!this._retentionOpen; this.render(); },

  _buildRetention(atRisk, noVisitYet) {
    let html = '';

    // Description + day selector
    html += `<div style="padding:14px 16px;border-top:1px solid var(--border);background:#fff;">
      <div style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:14px;">
        These are clients who visited before but haven't been back in a while. Use this to reach out, offer a deal, or just check in — before they forget about you.
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <span style="font-size:12px;font-weight:600;color:var(--muted);">Flag clients inactive after</span>
        <select onchange="Clients._retentionDays=parseInt(this.value);Clients.render()" style="padding:6px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:700;color:var(--text);background:#fff;">
          ${[30,45,60,75,90,120].map(d=>`<option value="${d}"${this._retentionDays===d?' selected':''}>${d} days</option>`).join('')}
        </select>
      </div>`;

    if (!atRisk.length) {
      html += `<div style="text-align:center;padding:20px 0;color:var(--faint);font-size:13px;">No at-risk clients right now — nice work! 💪</div>`;
    } else {
      html += `<div style="display:flex;flex-direction:column;gap:10px;">`;
      atRisk.sort((a,b)=>a.lastVisit.localeCompare(b.lastVisit)).forEach(c=>{
        const daysSince = Math.floor((new Date()-new Date(c.lastVisit+'T12:00:00'))/(1000*60*60*24));
        html += `<div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--surface);border-radius:10px;border:1px solid var(--border);">
          ${avatarEl(c.name,38)}
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:700;color:var(--text);">${c.name}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">Last in ${fmtDateShort(c.lastVisit)} · <span style="color:#dc2626;font-weight:600;">${daysSince} days ago</span></div>
          </div>
          <button class="btn btn-sm btn-green" onclick="Clients.retentionAction('${c.id}','${c.name}','${c.phone||''}')">Reach Out</button>
        </div>`;
      });
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  },

  retentionAction(id, name, phone) {
    const hasPhone = phone && phone.length > 0;
    Modal.show(`
      <div class="modal-title">📉 Re-capture ${name}</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6;">Choose how you want to reach out and bring them back.</div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${hasPhone ? `
        <button class="btn btn-full" onclick="Clients.sendRetentionText('${id}','${name}','${phone}','checkin')">
          💬 Send a Check-in Text
        </button>
        <button class="btn btn-full" onclick="Clients.sendRetentionText('${id}','${name}','${phone}','discount')">
          🎟️ Text Them a Discount Offer
        </button>` : `
        <div style="background:#fff5f5;border:1px solid #ffd7d5;border-radius:8px;padding:10px 12px;font-size:13px;color:#dc2626;margin-bottom:4px;">No phone number on file for this client.</div>`}
        <button class="btn btn-full" onclick="Clients.markContacted('${id}','${name}')">
          ✅ Mark as Contacted
        </button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
  },

  sendRetentionText(id, name, phone, type) {
    const firstName = name.split(' ')[0];
    const checkin = `Hey ${firstName}! It's been a while — we'd love to have you back in the chair. Book anytime at ${location.host}/book/ ✂️`;
    const discount = `Hey ${firstName}! We miss you! Come back in and we'll take care of you — mention this text for a special deal. Book at ${location.host}/book/ ✂️`;
    const defaultMsg = type==='discount' ? discount : checkin;

    Modal.show(`
      <div class="modal-title">${type==='discount'?'🎟️ Discount Offer':'💬 Check-in Text'}</div>
      <div class="form-group">
        <label class="form-label">Message to ${name}</label>
        <textarea class="form-input" id="ret-msg" style="min-height:100px;">${defaultMsg}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Phone</label>
        <input class="form-input" id="ret-phone" value="${phone}" />
      </div>
      <div class="modal-actions">
        <button id="ret-btn" class="btn btn-green btn-full" onclick="Clients._doRetentionSend('${id}','${name}')">Send Text</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
  },

  async _doRetentionSend(customerId, customerName) {
    const msg = document.getElementById('ret-msg')?.value.trim();
    const phone = document.getElementById('ret-phone')?.value.trim();
    if (!msg || !phone) { toast('Fill in all fields','warning'); return; }
    const btn = document.getElementById('ret-btn'); disableBtn(btn);
    try {
      const r = await db.sms.send({ to: phone, body: msg, customerId, customerName });
      if (r.ok) { Modal.close(); toast('Text sent ✓'); }
      else toast(r.error||'Could not send text — check Twilio settings','error');
    } catch(e) { toast('Could not send text','error'); enableBtn(btn); }
  },

  async markContacted(id, name) {
    Modal.close();
    toast(name+' marked as contacted ✓');
    // Bump their lastVisit to today so they fall off the at-risk list
    const c = this._data.find(x=>x.id===id);
    if (c) { await db.customers.save({...c, lastVisit: today(), contactedAt: today()}); this.render(); }
  },

  _filter(v) { this._search=v; this.render(); },

  openForm(id) {
    const c=id?this._data.find(x=>x.id===id):null;
    Modal.show(`
      <div class="modal-title">${c?'Edit Client':'New Client'}</div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fc-name" value="${c?.name||''}" placeholder="Full name" /></div>
      <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="fc-phone" type="tel" value="${c?.phone||''}" placeholder="(505) 555-0100" /></div>
      <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="fc-email" type="email" value="${c?.email||''}" placeholder="optional" /></div>
      <div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="fc-notes">${c?.notes||''}</textarea></div>
      <div class="modal-actions">
        ${c?`<button class="btn btn-danger btn-full" onclick="Clients.delete('${c.id}')">Delete Client</button>`:''}
        <button id="fc-btn" class="btn btn-primary btn-full" onclick="Clients.save('${c?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('fc-name')?.focus(),150);
  },

  async save(id) {
    const name=document.getElementById('fc-name')?.value.trim();
    if(!name){toast('Please enter a name','warning');return;}
    const btn=document.getElementById('fc-btn'); disableBtn(btn);
    try{
      await db.customers.save({id:id||genId('c'),name,phone:document.getElementById('fc-phone')?.value.trim()||'',email:document.getElementById('fc-email')?.value.trim()||'',notes:document.getElementById('fc-notes')?.value.trim()||'',loyaltyPoints:id?(this._data.find(c=>c.id===id)?.loyaltyPoints||0):0,source:'manual',createdAt:id?(this._data.find(c=>c.id===id)?.createdAt||today()):today()});
      Modal.close(); toast(id?'Updated ✓':'Client added ✓');
      if (id && this._view==='profile') { await this._renderProfile(document.getElementById('page-clients')); } else { this._view='list'; this.render(); }
    }catch(e){toast('Could not save','error');enableBtn(btn);}
  },

  async openDetail(id) {
    this._view = 'profile';
    this._profileId = id;
    this._messages = [];
    this._profileData = null;
    await this.render();
  },

  async _renderProfile(el) {
    try {
      const [data, messages] = await Promise.all([
        db.customers.get(this._profileId),
        db.conversations.forCustomer(this._profileId).catch(()=>[])
      ]);
      this._profileData = data;
      this._messages = messages;
      const c = data.customer;
      const doneAppts = (data.appointments||[]).filter(a=>a.status==='done').sort((a,b)=>b.date.localeCompare(a.date));

      // Work out automation statuses
      const nextAppt = (data.appointments||[]).filter(a=>a.status==='confirmed'&&a.date>=today()).sort((a,b)=>a.date.localeCompare(b.date))[0];
      const daysSinceLast = data.daysSinceLast ?? null;
      const rebookInterval = data.rebookInterval || 21;
      const nudgeDue = daysSinceLast !== null && daysSinceLast >= rebookInterval;

      let html = '';

      // ── Header ──
      html += `<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
        <button onclick="Clients._back()" style="background:none;border:none;font-size:22px;cursor:pointer;padding:0;line-height:1;color:var(--text);">←</button>
        ${avatarEl(c.name, 44)}
        <div style="flex:1;">
          <div style="font-size:18px;font-weight:800;color:var(--text);letter-spacing:-.03em;">${c.name}</div>
          <div style="font-size:12px;color:var(--muted);">${c.phone||'No phone'}${c.email?' · '+c.email:''}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="Clients.bookAppointment('${c.id}')" style="background:var(--green);color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">📅 Book</button>
          <button onclick="Clients.openForm('${c.id}')" style="background:none;border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;color:var(--text);">Edit</button>
        </div>
      </div>`;

      // ── Stats ──
      const warnAt   = Math.round(rebookInterval * 0.67); // amber at ~2/3 of the interval
      const dslColor = daysSinceLast === null ? 'var(--text)' : daysSinceLast >= rebookInterval ? '#dc2626' : daysSinceLast >= warnAt ? '#d97706' : 'var(--text)';
      const dslBg    = daysSinceLast === null ? 'var(--surface)' : daysSinceLast >= rebookInterval ? '#fff5f5' : daysSinceLast >= warnAt ? '#fffbeb' : 'var(--surface)';
      const dslBorder= daysSinceLast === null ? 'var(--border)'  : daysSinceLast >= rebookInterval ? '#fecaca' : daysSinceLast >= warnAt ? '#fde68a' : 'var(--border)';
      const dslLabel = daysSinceLast === null ? '—' : daysSinceLast === 0 ? 'Today' : daysSinceLast === 1 ? '1 day' : daysSinceLast + ' days';
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px;">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">VISITS</div><div style="font-size:22px;font-weight:800;">${data.totalVisits}</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">SPENT</div><div style="font-size:18px;font-weight:800;color:var(--green);">${fmtMoney(data.totalRevenue)}</div></div>
        <div style="background:${dslBg};border:1px solid ${dslBorder};border-radius:10px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">LAST VISIT</div><div style="font-size:18px;font-weight:800;color:${dslColor};">${dslLabel}</div></div>
        <div style="background:${data.rewardReady?'var(--green-lt)':'var(--surface)'};border:1px solid ${data.rewardReady?'#b3dfbf':'var(--border)'};border-radius:10px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">LOYALTY</div><div style="font-size:18px;font-weight:800;color:${data.rewardReady?'var(--green)':'var(--text)'};">${data.loyaltyPoints||0}/${data.visitsForReward}</div></div>
      </div>`;

      // ── Flags ──
      if ((c.noShows||0) > 0) html += `<div style="background:#fff5f5;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;color:#dc2626;margin-bottom:12px;">⚠️ ${c.noShows} no-show${c.noShows>1?'s':''} on record</div>`;
      if (data.rewardReady) html += `<div style="background:var(--green-lt);border:1px solid #b3dfbf;border-radius:8px;padding:8px 12px;font-size:12px;color:var(--green);margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">🎉 Reward ready! <button onclick="Clients.redeemReward('${c.id}','${c.name}')" style="background:var(--green);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">Redeem</button></div>`;
      if (c.notes) html += `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--muted);margin-bottom:12px;">📝 ${c.notes}</div>`;

      // ── Automations ──
      html += `<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px;">
        <div style="padding:12px 14px;background:var(--surface);border-bottom:1px solid var(--border);font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.05em;">AUTOMATIONS</div>
        <div style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-size:13px;font-weight:600;">⏰ 24-Hour Reminder</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">${nextAppt ? 'Scheduled for '+fmtDateFull(nextAppt.date)+' at '+nextAppt.time : 'No upcoming appointment'}</div>
          </div>
          <span style="font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;background:${nextAppt?'var(--green-lt)':'var(--surface)'};color:${nextAppt?'var(--green)':'var(--faint)'};">${nextAppt?'Active':'Inactive'}</span>
        </div>
        <div style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-size:13px;font-weight:600;">🔁 ${rebookInterval}-Day Rebook Nudge</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">${daysSinceLast===null ? 'No visits yet' : nudgeDue ? 'Nudge sent or due — '+daysSinceLast+' days since last visit' : 'Last visit '+daysSinceLast+' days ago · nudge at '+rebookInterval+' days'}</div>
          </div>
          <span style="font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;background:${nudgeDue?'#fff5f5':'var(--surface)'};color:${nudgeDue?'#dc2626':'var(--faint)'};">${nudgeDue?'Due':'Watching'}</span>
        </div>
      </div>`;

      // ── Spend Trends ──
      if (doneAppts.length >= 2) {
        const avgTicket = data.totalRevenue / data.totalVisits;
        // Visit frequency — avg days between visits
        const dates = doneAppts.map(a=>new Date(a.date+'T12:00:00')).sort((a,b)=>a-b);
        let avgFreq = null;
        if (dates.length >= 2) {
          const gaps = [];
          for (let i=1;i<dates.length;i++) gaps.push((dates[i]-dates[i-1])/(1000*60*60*24));
          avgFreq = Math.round(gaps.reduce((s,g)=>s+g,0)/gaps.length);
        }
        // Trend — compare last 3 vs previous 3 avg ticket
        const recent3  = doneAppts.slice(0,3).reduce((s,a)=>s+Number(a.price||0),0) / Math.min(3,doneAppts.length);
        const prev3    = doneAppts.slice(3,6).length ? doneAppts.slice(3,6).reduce((s,a)=>s+Number(a.price||0),0)/doneAppts.slice(3,6).length : null;
        const trendUp  = prev3 !== null && recent3 > prev3 + 1;
        const trendDn  = prev3 !== null && recent3 < prev3 - 1;
        const trendIcon = trendUp ? '📈' : trendDn ? '📉' : '➡️';
        const trendTxt  = trendUp ? 'Spending more lately' : trendDn ? 'Spending less lately' : 'Consistent spend';

        html += `<div style="font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.05em;margin-bottom:8px;">SPEND TRENDS</div>`;
        html += `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:20px;">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--faint);margin-bottom:3px;">AVG TICKET</div>
            <div style="font-size:16px;font-weight:800;color:var(--green);">${fmtMoney(avgTicket)}</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--faint);margin-bottom:3px;">AVG FREQUENCY</div>
            <div style="font-size:16px;font-weight:800;">${avgFreq ? 'every '+avgFreq+'d' : '—'}</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--faint);margin-bottom:3px;">TREND</div>
            <div style="font-size:16px;font-weight:800;">${trendIcon}</div>
            <div style="font-size:9px;color:var(--muted);margin-top:1px;">${trendTxt}</div>
          </div>
        </div>`;
      }

      // ── Visit History ──
      if (doneAppts.length) {
        html += `<div style="font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.05em;margin-bottom:8px;">VISIT HISTORY</div>`;
        html += `<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px;">`;
        doneAppts.slice(0,10).forEach((a,i)=>{
          const hasCutNotes = !!a.cutNotes;
          html += `<div style="${i>0?'border-top:1px solid var(--border)':''}">
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;${hasCutNotes?'cursor:pointer;':''}" ${hasCutNotes?`onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'"`:''}>
              <div>
                <div style="font-size:13px;font-weight:600;">${a.service}</div>
                <div style="font-size:11px;color:var(--muted);">${fmtDateShort(a.date)}${a.barberName?' · '+a.barberName:''}${hasCutNotes?' · <span style="color:var(--green);">✂ notes</span>':''}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <div style="font-size:14px;font-weight:700;color:var(--green);">${fmtMoney(a.price)}</div>
                ${hasCutNotes?'<span style="font-size:10px;color:var(--faint);">▼</span>':''}
              </div>
            </div>
            ${hasCutNotes?`<div style="display:none;padding:0 14px 10px;font-size:12px;color:var(--muted);font-style:italic;background:var(--off);">✂️ ${a.cutNotes}</div>`:''}
          </div>`;
        });
        html += `</div>`;
      }

      // ── Chat ──
      html += `<div style="font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.05em;margin-bottom:8px;">MESSAGES</div>`;
      html += `<div id="chat-history" style="border:1px solid var(--border);border-radius:12px;padding:12px;min-height:120px;max-height:320px;overflow-y:auto;margin-bottom:10px;background:var(--surface);">`;
      if (!this._messages.length) {
        html += `<div style="text-align:center;color:var(--faint);font-size:13px;padding:20px 0;">No messages yet</div>`;
      } else {
        this._messages.forEach(m => {
          const isOut = m.direction !== 'inbound';
          html += `<div style="display:flex;justify-content:${isOut?'flex-end':'flex-start'};margin-bottom:8px;">
            <div style="max-width:80%;background:${isOut?'var(--green)':'#fff'};color:${isOut?'#fff':'var(--text)'};border:1px solid ${isOut?'var(--green)':'var(--border)'};border-radius:${isOut?'12px 12px 2px 12px':'12px 12px 12px 2px'};padding:8px 12px;font-size:13px;line-height:1.4;">
              ${m.body}
              <div style="font-size:10px;opacity:.6;margin-top:3px;text-align:right;">${m.sentAt?new Date(m.sentAt).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):''}</div>
            </div>
          </div>`;
        });
      }
      html += `</div>`;

      // Send box
      if (c.phone) {
        html += `<div style="display:flex;gap:8px;">
          <input class="form-input" id="chat-input" placeholder="Type a message..." style="flex:1;" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Clients.sendMessage();}" />
          <button onclick="Clients.sendMessage()" style="background:var(--green);color:#fff;border:none;border-radius:10px;padding:0 16px;font-size:20px;cursor:pointer;flex-shrink:0;">↑</button>
        </div>`;
      } else {
        html += `<div style="font-size:12px;color:var(--faint);text-align:center;padding:8px;">Add a phone number to send messages</div>`;
      }

      // Delete button at bottom
      html += `<div style="margin-top:20px;"><button onclick="Clients.delete('${c.id}')" style="width:100%;padding:10px;background:none;border:1px solid #fecaca;border-radius:10px;color:#dc2626;font-size:13px;font-weight:600;cursor:pointer;">Delete Client</button></div>`;

      el.innerHTML = html;

      // Scroll chat to bottom
      const chatEl = document.getElementById('chat-history');
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;

    } catch(e) { el.innerHTML = `<button onclick="Clients._back()" style="background:none;border:none;font-size:22px;cursor:pointer;">←</button><div style="padding:20px;color:var(--muted);">Could not load client</div>`; }
  },

  _back() { this._view='list'; this._profileId=null; this.render(); },

  bookAppointment(id) {
    // Store client id so Appointments picks it up after render
    const c = this._profileData?.customer;
    Appointments._prefill = { customerId: id, customerName: c?.name||'', customerPhone: c?.phone||'' };
    App.nav('appointments');
  },

  async sendMessage() {
    const input = document.getElementById('chat-input');
    const msg = input?.value.trim();
    if (!msg) return;
    const c = this._profileData?.customer;
    if (!c?.phone) return;
    input.value = '';
    try {
      const r = await db.sms.send({ to: c.phone, body: msg, customerId: c.id, customerName: c.name });
      if (r.ok) { await this._renderProfile(document.getElementById('page-clients')); }
      else toast(r.error||'Could not send — check Twilio in Settings','error');
    } catch(e) { toast('Could not send message','error'); }
  },

  async redeemReward(id, name) {
    if(!confirm('Redeem loyalty reward for '+name+'? This will reset their points to 0.'))return;
    await db.customers.redeem(id);
    toast('Reward redeemed for '+name+' ✓');
    await this._renderProfile(document.getElementById('page-clients'));
    Dashboard.render();
  },

  async delete(id) {
    if(!confirm('Delete this client? This cannot be undone.'))return;
    await db.customers.delete(id);
    this._back(); toast('Client deleted');
  },
};

// ── Automations ───────────────────────────────────────────────────────────────
const Automations = {
  async render() {
    const el = document.getElementById('page-automations'); if(!el) return;
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">Loading…</div>';

    let s = {};
    try { s = await db.settings.get(); } catch(e) {}
    const smsActive = s.twilioConfigured;
    const tpl = s.smsTemplates || {};
    const defConfirm  = "Hi {name}! Your appointment at {shop} is confirmed for {date} at {time}{barber}. See you then! ✂️";
    const defReminder = "Hi {name}! Reminder: your appointment at {shop} is tomorrow at {time}{barber}. See you then! ✂️";
    const defRebook   = "Hey {name}! It's been a few weeks — we'd love to have you back at {shop}. Book your next cut anytime 💈";

    const automations = [
      {
        icon: '📩',
        title: 'Booking Confirmation',
        desc: 'Sent immediately when a client books online.',
        message: tpl.confirmation || defConfirm,
      },
      {
        icon: '⏰',
        title: '24-Hour Reminder',
        desc: 'Sent the day before each confirmed appointment to reduce no-shows.',
        message: tpl.reminder || defReminder,
      },
      {
        icon: '🔁',
        title: `${s.rebookInterval || 21}-Day Rebook Nudge`,
        desc: `Sent to clients who haven't rebooked after ${s.rebookInterval || 21} days.`,
        message: tpl.rebook || defRebook,
      },
    ];

    let html = [];

    // SMS status banner
    html.push(`<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;margin-bottom:20px;background:${smsActive?'var(--green-lt)':'var(--surface2)'};border:1px solid ${smsActive?'var(--green-md)':'var(--border)'};">
      <div style="width:10px;height:10px;border-radius:50%;background:${smsActive?'var(--green)':'#d1d5db'};flex-shrink:0;"></div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:700;color:${smsActive?'var(--green)':'var(--text)'};">${smsActive?'SMS is active — automations are running':'SMS not yet active'}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:1px;">${smsActive?'All three automations below are firing automatically.':'Contact ShopFlow support to activate SMS for your shop.'}</div>
      </div>
    </div>`);

    html.push('<div class="section-header">Your Automations</div>');
    html.push('<div class="list-card">');
    automations.forEach(a => {
      html.push(`
        <div class="list-row" style="align-items:flex-start;gap:14px;padding:16px;">
          <div style="font-size:26px;line-height:1;flex-shrink:0;">${a.icon}</div>
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <div style="font-size:14px;font-weight:700;color:var(--text);">${a.title}</div>
              <span style="font-size:10px;font-weight:700;color:${smsActive?'#fff':'var(--muted)'};background:${smsActive?'var(--green)':'var(--border)'};border-radius:20px;padding:2px 8px;">${smsActive?'Active':'Pending'}</span>
            </div>
            <div style="font-size:12px;color:var(--muted);line-height:1.5;margin-bottom:6px;">${a.desc}</div>
            <div style="font-size:12px;color:var(--text);background:var(--off);border-radius:7px;padding:8px 10px;font-style:italic;">"${a.message}"</div>
          </div>
        </div>`);
    });
    html.push('</div>');

    html.push(`<div style="margin-top:12px;"><div style="font-size:12px;color:var(--faint);text-align:center;">Edit your message templates in <a href="#" onclick="App.nav('settings');return false;" style="color:var(--green);font-weight:600;">Settings → SMS Messaging</a></div></div>`);

    el.innerHTML = html.join('');
  },

  showUpgrade() {
    Modal.show(`
      <div class="modal-title">⚡ Unlock More Automations</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6;">Your current plan includes the 24-hour reminder and 21-day rebook nudge. Upgrade to Pro or Shop to unlock:</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">🎂</span> Birthday messages</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">💤</span> Win-back campaigns for inactive clients</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">⭐</span> Post-visit review requests</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">🎉</span> Loyalty milestone alerts</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;"><span style="font-size:18px;">✏️</span> Custom message builder</div>
      </div>
      <div class="modal-actions">
        <a href="mailto:support@shopflow.io?subject=Upgrade Plan" class="btn btn-primary btn-full" style="text-decoration:none;text-align:center;">Contact Us to Upgrade</a>
        <button class="btn btn-full" onclick="Modal.close()">Maybe Later</button>
      </div>`);
  },
};

// ── Revenue ───────────────────────────────────────────────────────────────────
const Revenue = {
  async render() {
    const el=document.getElementById('page-revenue'); if(!el)return;
    try{
      const data=await db.revenue.get();
      const html=[];
      html.push('<div class="metric-grid" style="grid-template-columns:1fr 1fr;">');
      html.push(`<div class="metric-card"><div class="metric-label">This Month</div><div class="metric-value green">${fmtMoney(data.monthRevenue)}</div><div class="metric-sub">${data.monthJobs} appointments</div></div>`);
      html.push(`<div class="metric-card"><div class="metric-label">Avg Ticket</div><div class="metric-value">${fmtMoney(data.avgTicket)}</div><div class="metric-sub">This month</div></div>`);
      html.push(`<div class="metric-card"><div class="metric-label">All Time</div><div class="metric-value">${fmtMoney(data.totalRevenue)}</div></div>`);
      html.push('</div>');

      if(data.byBarber?.length){
        html.push('<div class="section-header">By Barber</div><div class="card">');
        const maxRev=Math.max(...data.byBarber.map(b=>b.revenue),1);
        data.byBarber.forEach(b=>{
          const pct=Math.round((b.revenue/maxRev)*100);
          html.push(`<div style="margin-bottom:14px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;"><span style="font-weight:600;">✂ ${b.name}</span><span>${fmtMoney(b.revenue)} · ${b.count} cuts</span></div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${b.color||'var(--green)'};"></div></div></div>`);
        });
        html.push('</div>');
      }

      if(data.byMonth?.length){
        html.push('<div class="section-header">Monthly Trend</div><div class="card">');
        const maxM=Math.max(...data.byMonth.map(m=>m.revenue),1);
        data.byMonth.slice(-6).forEach(m=>{
          const pct=Math.round((m.revenue/maxM)*100);
          const label=new Date(m.month+'-15').toLocaleDateString('en-US',{month:'short'});
          html.push(`<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span style="color:var(--muted);">${label}</span><span style="font-weight:600;">${fmtMoney(m.revenue)}</span></div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--green);"></div></div></div>`);
        });
        html.push('</div>');
      }
      el.innerHTML=html.join('');
    }catch(e){el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load revenue</p></div>';}
  }
};

// ── Settings ──────────────────────────────────────────────────────────────────
const Settings = {
  _barbers: [], _services: [],

  async render() {
    const el=document.getElementById('page-settings'); if(!el)return;
    try{
      const [s,barbers,services]=await Promise.all([db.settings.get(),db.barbers.all(),db.services.all()]);
      this._barbers=barbers; this._services=services;
      const html=[];

      // Shop info
      html.push('<div class="section-header">Shop Info</div><div class="card">');
      html.push(`<div class="form-group"><label class="form-label">Shop Name</label><input class="form-input" id="s-name" value="${s.shopName||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Tagline</label><input class="form-input" id="s-tag" value="${s.tagline||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="s-phone" type="tel" value="${s.phone||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Address</label><input class="form-input" id="s-addr" value="${s.address||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Email</label><input class="form-input" id="s-email" type="email" value="${s.email||''}" /></div>`);
      html.push('</div>');

      // Booking page settings
      html.push('<div class="section-header">Client Booking Page</div><div class="card">');
      const shopSlug = Auth.getShopSlug();
      const bookUrl = location.origin+'/book/'+(shopSlug||'');
      html.push(`<div style="background:var(--green-lt);border:1px solid var(--green-md);border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <span>Your booking link: <strong><a href="${bookUrl}" target="_blank" style="color:var(--green);">${bookUrl}</a></strong></span>
        <button onclick="navigator.clipboard.writeText('${bookUrl}');toast('Link copied ✓')" style="background:var(--green);color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">Copy Link</button>
      </div>`);
      html.push(`<div class="form-group"><label class="form-label">Booking Welcome Message</label><textarea class="form-input" id="s-bmsg" rows="2">${s.bookingMessage||'Book your appointment below!'}</textarea></div>`);
      html.push(`<div class="form-group"><label class="form-label"><input type="checkbox" id="s-benabled" ${s.bookingEnabled!==false?'checked':''} style="margin-right:6px;" /> Booking page enabled</label></div>`);
      html.push('</div>');

      // Barbers
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Barbers</span><button class="btn btn-sm btn-green" onclick="Settings.openBarber(null)">+ Add</button></div>');
      barbers.forEach(b=>{
        html.push(`<div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;border-left:4px solid ${b.color||'var(--green)}'};">
          <div style="width:40px;height:40px;border-radius:50%;background:${b.color||'var(--green)'}22;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:${b.color||'var(--green)'};">${initials(b.name)}</div>
          <div style="flex:1;"><div style="font-size:14px;font-weight:700;">${b.name}</div><div style="font-size:12px;color:var(--muted);">Chair ${b.chair}${b.bio?' · '+b.bio:''}</div></div>
          <button class="btn btn-sm" onclick="Settings.openBarber('${b.id}')">Edit</button>
        </div>`);
      });

      // Services
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Services</span><button class="btn btn-sm btn-green" onclick="Settings.openService(null)">+ Add</button></div>');
      html.push('<div class="list-card">');
      services.forEach(s=>{
        html.push(`<div class="list-row"><div class="list-main"><div class="list-name">${s.name}</div><div class="list-sub">${s.category} · ${s.duration} min</div></div><div style="font-weight:700;color:var(--green);margin-right:8px;">${fmtMoney(s.price)}</div><button class="btn btn-sm" onclick="Settings.openService('${s.id}')">Edit</button></div>`);
      });
      html.push('</div>');

      // Loyalty
      html.push('<div class="section-header">Loyalty Program</div><div class="card">');
      html.push(`<div class="form-group"><label class="form-label">Visits for free service</label><input class="form-input" id="s-lvis" type="number" value="${s.loyalty?.visitsForReward||10}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Reward description</label><input class="form-input" id="s-lrew" value="${s.loyalty?.rewardDescription||'One free haircut'}" /></div>`);
      html.push('</div>');

      // SMS — status + customizable templates
      html.push('<div class="section-header">SMS Messaging</div><div class="card">');
      const smsActive = s.twilioConfigured;
      html.push(`<div style="display:flex;align-items:center;gap:10px;padding:4px 0 14px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${smsActive?'#16a34a':'#d1d5db'};flex-shrink:0;"></div>
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--text);">${smsActive?'SMS Active':'SMS Not Yet Active'}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${smsActive?'Reminders and confirmations are firing automatically.':'Managed by ShopFlow. Contact support to activate.'}</div>
        </div>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.04em;margin-bottom:8px;">CUSTOMIZE YOUR MESSAGES</div>
      <div style="font-size:11px;color:var(--faint);margin-bottom:12px;">Variables you can use: <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{name}</code> <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{shop}</code> <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{date}</code> <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{time}</code> <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{barber}</code></div>`);
      const tpl = s.smsTemplates || {};
      const defConfirm = "Hi {name}! Your appointment at {shop} is confirmed for {date} at {time}{barber}. See you then! ✂️";
      const defReminder = "Hi {name}! Reminder: your appointment at {shop} is tomorrow at {time}{barber}. See you then! ✂️";
      const defRebook   = "Hey {name}! It's been a few weeks — we'd love to have you back at {shop}. Book your next cut anytime 💈";
      html.push(`<div class="form-group"><label class="form-label">Booking Confirmation</label><textarea class="form-input" id="s-tpl-confirm" rows="2" placeholder="${defConfirm}">${tpl.confirmation||''}</textarea></div>`);
      html.push(`<div class="form-group"><label class="form-label">24-Hour Reminder</label><textarea class="form-input" id="s-tpl-reminder" rows="2" placeholder="${defReminder}">${tpl.reminder||''}</textarea></div>`);
      const rebookDays = s.rebookInterval || 21;
      html.push(`<div class="form-group"><label class="form-label">Rebook Nudge — Days Since Last Visit</label><div style="display:flex;align-items:center;gap:10px;"><input class="form-input" id="s-rebook-days" type="number" min="7" max="90" value="${rebookDays}" style="width:90px;" /><span style="font-size:13px;color:var(--muted);">days after last visit</span></div></div>`);
      html.push(`<div class="form-group"><label class="form-label">Rebook Nudge Message</label><textarea class="form-input" id="s-tpl-rebook" rows="2" placeholder="${defRebook}">${tpl.rebook||''}</textarea></div>`);
      html.push(`<div style="font-size:11px;color:var(--faint);">Leave message blank to use the default shown as placeholder.</div>`);
      html.push('</div>');

      // Google Reviews
      html.push('<div class="section-header">Google Reviews</div><div class="card">');
      html.push(`<div class="form-group"><label class="form-label">Google Review Link</label><input class="form-input" id="s-grev" value="${s.googleReviewLink||''}" placeholder="https://g.page/r/..." /></div>`);
      html.push('</div>');

      // Email (fallback when Twilio not set up)
      html.push('<div class="section-header">Email Confirmations</div><div class="card">');
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Optional — sends booking confirmation emails when SMS is not configured. Use Gmail with an App Password.</div>');
      html.push(`<div class="form-group"><label class="form-label">SMTP Host</label><input class="form-input" id="s-ehost" value="${s.emailSmtp?.host||''}" placeholder="smtp.gmail.com" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Email Address</label><input class="form-input" id="s-euser" type="email" value="${s.emailSmtp?.user||''}" placeholder="yourshop@gmail.com" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">App Password</label><input class="form-input" id="s-epass" type="password" value="${s.emailSmtp?.pass||''}" placeholder="Gmail App Password" /></div>`);
      html.push('</div>');

      // Blocked Dates
      let blockedDates = [];
      try { blockedDates = await db.blockedDates.all(); } catch(e) {}
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Blocked Booking Dates</span><button class="btn btn-sm btn-danger" onclick="Settings.openBlockDate()">+ Block Date</button></div>');
      if (!blockedDates.length) {
        html.push('<div class="card"><div style="font-size:13px;color:var(--faint);text-align:center;padding:12px 0;">No dates blocked — booking is open every working day</div></div>');
      } else {
        html.push('<div class="list-card">');
        blockedDates.sort((a,b)=>a.date.localeCompare(b.date)).forEach(bd=>{
          const dt = new Date(bd.date+'T12:00:00');
          const label = dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
          html.push('<div class="list-row"><div class="list-main"><div class="list-name">'+label+'</div><div class="list-sub">'+(bd.reason||'No reason given')+'</div></div><button class="btn btn-sm btn-danger" onclick="Settings.unblockDate(\'' + bd.date + '\')">Unblock</button></div>');
        });
        html.push('</div>');
      }

      // Stripe Connect
      let stripeStatus = { connected:false };
      try { stripeStatus = await db.stripe.status(); } catch(e) {}
      const deposit = s.deposit||{enabled:false,amount:10,message:'A deposit is required to secure your appointment.'};

      html.push('<div class="section-header">Deposits & Payments</div><div class="card">');
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">Collect a deposit when clients book online. Goes directly to your connected Stripe account.</div>');

      // Stripe Connect status
      if (stripeStatus.connected) {
        html.push('<div style="display:flex;align-items:center;justify-content:space-between;background:var(--green-lt);border:1px solid var(--green-md);border-radius:8px;padding:12px 14px;margin-bottom:14px;">');
        html.push('<div><div style="font-size:13px;font-weight:700;color:var(--green);">✓ Stripe Connected</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">'+(stripeStatus.email||'Account active')+'</div></div>');
        html.push('<button class="btn btn-sm btn-danger" onclick="Settings.disconnectStripe()">Disconnect</button>');
        html.push('</div>');
        // Deposit toggle
        html.push('<div class="form-group"><label style="display:flex;align-items:center;gap:10px;cursor:pointer;"><input type="checkbox" id="s-dep-enabled" '+(deposit.enabled?'checked':'')+' style="width:16px;height:16px;" /><span style="font-size:14px;font-weight:600;">Require deposit to book</span></label></div>');
        html.push('<div class="form-row">');
        html.push('<div class="form-group"><label class="form-label">Deposit amount</label><div style="position:relative;"><div style="position:absolute;left:12px;top:50%;transform:translateY(-50%);font-weight:700;color:var(--muted);">$</div><input class="form-input" id="s-dep-amount" type="number" value="'+(deposit.amount||10)+'" min="1" max="100" style="padding-left:24px;" /></div></div>');
        html.push('<div class="form-group"><label class="form-label">Quick amounts</label><div style="display:flex;gap:6px;"><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=5">$5</button><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=10">$10</button><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=15">$15</button><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=20">$20</button><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=25">$25</button></div></div>');
        html.push('</div>');
        html.push('<div class="form-group"><label class="form-label">Deposit message shown to client</label><input class="form-input" id="s-dep-msg" value="'+(deposit.message||'A deposit is required to secure your appointment.')+'" /></div>');
      } else {
        html.push('<div style="background:var(--surface2);border-radius:8px;padding:14px;margin-bottom:14px;font-size:13px;color:var(--muted);">Connect your Stripe account to start collecting deposits. Takes about 2 minutes.</div>');
        html.push('<button class="btn btn-primary btn-full" id="stripe-connect-btn" onclick="Settings.connectStripe()">Connect Stripe Account</button>');
      }
      html.push('</div>');

      html.push('<div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-primary" style="flex:1;" onclick="Settings.save()">Save Settings</button><button class="btn btn-danger" onclick="Auth.logout()">Sign Out</button></div>');
      el.innerHTML=html.join('');
    }catch(e){el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load settings</p></div>';}
  },

  openBarber(id) {
    const b=id?this._barbers.find(x=>x.id===id):null;
    const sched=b?.schedule||{workDays:[1,2,3,4,5,6],startTime:'9:00 AM',endTime:'6:00 PM',slotMinutes:30};
    const colors=['#16a34a','#2563eb','#d97706','#7c3aed','#dc2626','#0891b2','#be185d'];
    const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayBtns=days.map((d,i)=>`<button type="button" id="wd-${i}" onclick="Settings._toggleDay(${i})" style="padding:6px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:${(sched.workDays||[]).includes(i)?'var(--green)':'var(--surface)'};color:${(sched.workDays||[]).includes(i)?'#fff':'var(--muted)'};">${d}</button>`).join('');
    const timeOpts=['6:00 AM','6:30 AM','7:00 AM','7:30 AM','8:00 AM','8:30 AM','9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM','12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM','3:30 PM','4:00 PM','4:30 PM','5:00 PM','5:30 PM','6:00 PM','6:30 PM','7:00 PM','7:30 PM','8:00 PM'];
    const startOpts=timeOpts.map(t=>`<option value="${t}"${sched.startTime===t?' selected':''}>${t}</option>`).join('');
    const endOpts=timeOpts.map(t=>`<option value="${t}"${sched.endTime===t?' selected':''}>${t}</option>`).join('');
    Modal.show(`
      <div class="modal-title">${b?'Edit Barber':'Add Barber'}</div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fb-name" value="${b?.name||''}" placeholder="e.g. Chris" /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Chair #</label><input class="form-input" id="fb-chair" type="number" value="${b?.chair||this._barbers.length+1}" min="1" /></div>
        <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="fb-phone" type="tel" value="${b?.phone||''}" /></div>
      </div>
      <div class="form-group"><label class="form-label">Bio / specialty</label><input class="form-input" id="fb-bio" value="${b?.bio||''}" placeholder="e.g. Fades and designs" /></div>
      <div class="form-group"><label class="form-label">Color</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${colors.map(c=>`<div onclick="document.getElementById('fb-col').value='${c}';document.querySelectorAll('.bc').forEach(x=>x.style.outline='none');this.style.outline='3px solid #000';" class="bc" style="width:30px;height:30px;border-radius:50%;background:${c};cursor:pointer;outline:${b?.color===c?'3px solid #000':'none'};outline-offset:2px;"></div>`).join('')}
        </div>
        <input type="hidden" id="fb-col" value="${b?.color||colors[0]}" />
      </div>

      <div style="background:var(--surface2);border-radius:10px;padding:14px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px;">📅 Booking Schedule</div>
        <div class="form-group">
          <label class="form-label">Working Days</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">${dayBtns}</div>
          <input type="hidden" id="fb-workdays" value="${JSON.stringify(sched.workDays||[1,2,3,4,5,6])}" />
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Start Time</label><select class="form-input" id="fb-start">${startOpts}</select></div>
          <div class="form-group"><label class="form-label">End Time</label><select class="form-input" id="fb-end">${endOpts}</select></div>
        </div>
        <div class="form-group">
          <label class="form-label">Slot Duration</label>
          <select class="form-input" id="fb-slot">
            ${[15,20,30,45,60].map(m=>`<option value="${m}"${sched.slotMinutes===m?' selected':''}>${m} minutes</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="modal-actions">
        ${b?`<button class="btn btn-danger btn-full" onclick="Settings.deleteBarber('${b.id}')">Remove Barber</button>`:''}
        <button id="fb-btn" class="btn btn-primary btn-full" onclick="Settings.saveBarber('${b?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('fb-name')?.focus(),150);
  },

  _toggleDay(i) {
    const el = document.getElementById('fb-workdays');
    let days = JSON.parse(el.value||'[]');
    const btn = document.getElementById('wd-'+i);
    if (days.includes(i)) {
      days = days.filter(d=>d!==i);
      if(btn){btn.style.background='var(--surface)';btn.style.color='var(--muted)';}
    } else {
      days.push(i);
      if(btn){btn.style.background='var(--green)';btn.style.color='#fff';}
    }
    el.value = JSON.stringify(days.sort());
  },

  async saveBarber(id) {
    const name=document.getElementById('fb-name')?.value.trim();
    if(!name){toast('Enter a name','warning');return;}
    const btn=document.getElementById('fb-btn'); disableBtn(btn);
    const schedule={
      workDays: JSON.parse(document.getElementById('fb-workdays')?.value||'[1,2,3,4,5,6]'),
      startTime: document.getElementById('fb-start')?.value||'9:00 AM',
      endTime:   document.getElementById('fb-end')?.value||'6:00 PM',
      slotMinutes: parseInt(document.getElementById('fb-slot')?.value)||30,
    };
    try{
      await db.barbers.save({
        id:id||genId('b'),
        name,
        chair:parseInt(document.getElementById('fb-chair')?.value)||1,
        phone:document.getElementById('fb-phone')?.value.trim()||'',
        bio:document.getElementById('fb-bio')?.value.trim()||'',
        color:document.getElementById('fb-col')?.value||'#16a34a',
        active:true,
        schedule,
        joinedAt:id?(this._barbers.find(b=>b.id===id)?.joinedAt||today()):today()
      });
      Modal.close(); toast(id?'Updated ✓':'Barber added ✓'); this.render();
    }catch(e){toast('Could not save','error');enableBtn(btn);}
  },

  async deleteBarber(id) {
    if(!confirm('Remove this barber?'))return;
    await db.barbers.delete(id); Modal.close(); this.render(); toast('Removed');
  },

  openService(id) {
    const s=id?this._services.find(x=>x.id===id):null;
    Modal.show(`
      <div class="modal-title">${s?'Edit Service':'Add Service'}</div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fs-name" value="${s?.name||''}" placeholder="e.g. Fade" /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Price</label><input class="form-input" id="fs-price" type="number" value="${s?.price||35}" /></div>
        <div class="form-group"><label class="form-label">Duration (min)</label><input class="form-input" id="fs-dur" type="number" value="${s?.duration||45}" /></div>
      </div>
      <div class="form-group"><label class="form-label">Category</label>
        <select class="form-input" id="fs-cat">
          ${['cut','beard','combo','color','design','other'].map(c=>`<option value="${c}"${s?.category===c?' selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        ${s?`<button class="btn btn-danger btn-full" onclick="Settings.deleteService('${s.id}')">Delete</button>`:''}
        <button id="fs-btn" class="btn btn-primary btn-full" onclick="Settings.saveService('${s?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('fs-name')?.focus(),150);
  },

  async saveService(id) {
    const name=document.getElementById('fs-name')?.value.trim();
    if(!name){toast('Enter a name','warning');return;}
    const btn=document.getElementById('fs-btn'); disableBtn(btn);
    try{
      await db.services.save({id:id||genId('s'),name,price:parseFloat(document.getElementById('fs-price')?.value)||35,duration:parseInt(document.getElementById('fs-dur')?.value)||45,category:document.getElementById('fs-cat')?.value||'cut'});
      Modal.close(); toast(id?'Updated ✓':'Service added ✓'); this.render();
    }catch(e){toast('Could not save','error');enableBtn(btn);}
  },

  async deleteService(id) {
    if(!confirm('Delete this service?'))return;
    await db.services.delete(id); Modal.close(); this.render(); toast('Deleted');
  },

  async connectStripe() {
    const btn = document.getElementById('stripe-connect-btn'); if(btn){btn.textContent='Connecting...';btn.disabled=true;}
    try {
      const data = await db.stripe.onboard();
      if (data.ok && data.url) { window.location.href = data.url; }
      else { toast(data.error||'Could not connect Stripe. Make sure STRIPE_SECRET_KEY is set in Railway.','error'); if(btn){btn.textContent='Connect Stripe Account';btn.disabled=false;} }
    } catch(e) { toast('Error connecting Stripe','error'); if(btn){btn.textContent='Connect Stripe Account';btn.disabled=false;} }
  },

  async disconnectStripe() {
    if (!confirm('Disconnect Stripe? Card payments and deposits will stop working.')) return;
    await db.stripe.disconnect();
    toast('Stripe disconnected');
    this.render();
  },

  openBlockDate() {
    const todayStr = new Date().toISOString().split('T')[0];
    Modal.show(`
      <div class="modal-title">🚫 Block a Date</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">Clients won't be able to book on this date.</div>
      <div class="form-group"><label class="form-label">Date to block *</label><input class="form-input" id="bd-date" type="date" min="${todayStr}" /></div>
      <div class="form-group"><label class="form-label">Reason (optional)</label><input class="form-input" id="bd-reason" placeholder="e.g. Holiday, Closed, Private event..." /></div>
      <div class="modal-actions">
        <button id="bd-btn" class="btn btn-danger btn-full" onclick="Settings.blockDate()">Block This Date</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('bd-date')?.focus(),150);
  },

  async blockDate() {
    const date = document.getElementById('bd-date')?.value;
    const reason = document.getElementById('bd-reason')?.value.trim();
    if (!date) { toast('Please select a date','warning'); return; }
    const btn = document.getElementById('bd-btn'); disableBtn(btn);
    try {
      await db.blockedDates.block(date, reason);
      Modal.close(); toast('Date blocked ✓'); this.render();
    } catch(e) { toast('Could not block date','error'); enableBtn(btn); }
  },

  async unblockDate(date) {
    const dt = new Date(date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    if (!confirm('Unblock '+dt+'? Clients will be able to book again.')) return;
    try { await db.blockedDates.unblock(date); toast('Unblocked ✓'); this.render(); }
    catch(e) { toast('Could not unblock','error'); }
  },

  async save() {
    const data={shopName:document.getElementById('s-name')?.value.trim(),tagline:document.getElementById('s-tag')?.value.trim(),phone:document.getElementById('s-phone')?.value.trim(),address:document.getElementById('s-addr')?.value.trim(),email:document.getElementById('s-email')?.value.trim(),bookingMessage:document.getElementById('s-bmsg')?.value.trim(),bookingEnabled:document.getElementById('s-benabled')?.checked!==false};
    const lv=document.getElementById('s-lvis')?.value; if(lv)data.loyalty={visitsForReward:parseInt(lv),rewardDescription:document.getElementById('s-lrew')?.value.trim()||'One free haircut'};
    // SMS templates (empty string = use server default)
    const tc=document.getElementById('s-tpl-confirm')?.value.trim();
    const tr=document.getElementById('s-tpl-reminder')?.value.trim();
    const tk=document.getElementById('s-tpl-rebook')?.value.trim();
    data.smsTemplates={ confirmation:tc||'', reminder:tr||'', rebook:tk||'' };
    const rd=parseInt(document.getElementById('s-rebook-days')?.value)||21;
    data.rebookInterval=Math.min(90,Math.max(7,rd));
    const gr=document.getElementById('s-grev')?.value.trim(); if(gr)data.googleReviewLink=gr;
    const ehost=document.getElementById('s-ehost')?.value.trim();
    const euser=document.getElementById('s-euser')?.value.trim();
    const epass=document.getElementById('s-epass')?.value;
    if(ehost||euser)data.emailSmtp={host:ehost||'smtp.gmail.com',port:587,user:euser||'',pass:epass||''};
    // Deposit settings
    const depEnabled=document.getElementById('s-dep-enabled')?.checked||false;
    const depAmount=parseFloat(document.getElementById('s-dep-amount')?.value)||10;
    const depMsg=document.getElementById('s-dep-msg')?.value.trim()||'A deposit is required to secure your appointment.';
    data.deposit={enabled:depEnabled,amount:depAmount,message:depMsg};
    await db.settings.save(data);
    const title=document.getElementById('topbar-title'); if(title)title.textContent=data.shopName||'ShopFlow';
    toast('Settings saved ✓');
  }
};

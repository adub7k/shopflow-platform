// ── Dashboard ─────────────────────────────────────────────────────────────────
const Dashboard = {
  async render() {
    const el = document.getElementById('page-dashboard'); if(!el)return;
    try {
      let rev={monthRevenue:0,monthJobs:0,avgTicket:0,loyaltyAlerts:[],recentDone:[]};
      let appts=[];
      let settings={shopName:'ShopFlow'};
      try{rev=await db.revenue.get();}catch(e){console.warn('Revenue:',e.message);}
      try{appts=await db.appointments.all({date:today()});}catch(e){console.warn('Appts:',e.message);}
      try{settings=await db.settings.get();}catch(e){console.warn('Settings:',e.message);}
      const html = [];

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
      makeAutocomplete('fa-name','fa-list',(id,name)=>{document.getElementById('fa-name').value=name;document.getElementById('fa-cid').value=id;});
    },150);
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

  async complete(id) {
    const a=this._data.find(x=>x.id===id); if(!a)return;
    Modal.show(`
      <div class="modal-title">✓ Complete Service</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:16px;">${a.customerName} · ${a.service}</div>
      <div class="form-group"><label class="form-label">Amount charged</label>
        <div style="position:relative;"><div style="position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:20px;font-weight:700;color:var(--green);">$</div>
        <input class="form-input" id="cc-price" type="number" value="${a.price}" style="font-size:24px;font-weight:700;padding-left:28px;" /></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        ${[20,25,30,35,40,45,50].map(p=>`<button class="btn btn-sm" onclick="document.getElementById('cc-price').value=${p}">${fmtMoney(p)}</button>`).join('')}
      </div>
      <div class="modal-actions">
        <button id="cc-btn" class="btn btn-green btn-full" onclick="Appointments._doComplete('${id}')">✓ Log Service</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('cc-price')?.select(),150);
  },

  async _doComplete(id) {
    const price=parseFloat(document.getElementById('cc-price')?.value)||0;
    const btn=document.getElementById('cc-btn'); disableBtn(btn);
    try{
      await db.appointments.complete(id,{price});
      Modal.close(); toast('Service logged ✓ Loyalty point awarded!');
      await this.render(); Dashboard.render();
    }catch(e){toast('Error','error');enableBtn(btn);}
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
      await fetch('/api/appointments/'+id+'/waive-deposit',{method:'POST'});
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
  _data: [], _search: '',

  async render() {
    const el=document.getElementById('page-clients'); if(!el)return;
    try {
      this._data = await db.customers.all();
      const html = [];
      const loyalty = (await db.settings.get()).loyalty||{visitsForReward:10};

      // Search + add
      html.push(`<div style="display:flex;gap:8px;margin-bottom:16px;">
        <input class="form-input" id="client-search" placeholder="Search clients..." value="${this._search}" oninput="Clients._filter(this.value)" style="flex:1;" />
        <button class="btn btn-green" onclick="Clients.openForm(null)">+ Add</button>
      </div>`);

      const filtered = this._search ? this._data.filter(c=>c.name.toLowerCase().includes(this._search.toLowerCase())||(c.phone||'').includes(this._search)) : this._data;

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
      Modal.close(); toast(id?'Updated ✓':'Client added ✓'); this.render();
    }catch(e){toast('Could not save','error');enableBtn(btn);}
  },

  async openDetail(id) {
    try{
      const data=await db.customers.get(id);
      const c=data.customer;
      Modal.show(`
        <div class="modal-title">👤 ${c.name}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;">
          <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:4px;">Visits</div><div style="font-size:22px;font-weight:800;">${data.totalVisits}</div></div>
          <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:4px;">Spent</div><div style="font-size:18px;font-weight:800;color:var(--green);">${fmtMoney(data.totalRevenue)}</div></div>
          <div style="background:${data.rewardReady?'var(--green-lt)':'var(--surface2)'};border:1px solid ${data.rewardReady?'var(--green-md)':'var(--border)'};border-radius:8px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:4px;">Loyalty</div><div style="font-size:18px;font-weight:800;color:${data.rewardReady?'var(--green)':'var(--text)'};">${data.loyaltyPoints}/${data.visitsForReward}</div></div>
        </div>
        ${c.phone?`<div style="font-size:13px;color:var(--muted);margin-bottom:6px;">📱 ${c.phone}</div>`:''}
        ${(data.customer?.noShows||0)>0?`<div style="font-size:12px;color:var(--orange);margin-bottom:6px;">⚠️ ${data.customer.noShows} no-show${data.customer.noShows>1?'s':''} on record</div>`:''}
        ${c.email?`<div style="font-size:13px;color:var(--muted);margin-bottom:6px;">✉️ ${c.email}</div>`:''}
        ${c.notes?`<div style="background:var(--surface2);border-radius:8px;padding:10px;font-size:13px;margin-bottom:12px;">${c.notes}</div>`:''}
        ${data.appointments?.filter(a=>a.status==='done').slice(0,4).map(a=>`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><div>${a.service}<div style="font-size:11px;color:var(--faint);">${fmtDateShort(a.date)}${a.barberName?' · '+a.barberName:''}</div></div><div style="font-weight:700;">${fmtMoney(a.price)}</div></div>`).join('')||''}
        <div class="modal-actions" style="margin-top:16px;">
          ${data.rewardReady?`<button class="btn btn-green btn-full" onclick="Clients.redeemReward('${c.id}','${c.name}')">🎉 Redeem Reward</button>`:''}
          <button class="btn btn-full" onclick="Clients.openForm('${c.id}');Modal.close()">Edit</button>
          <button class="btn btn-full" onclick="Modal.close()">Close</button>
        </div>`);
    }catch(e){toast('Could not load client','error');}
  },

  async redeemReward(id, name) {
    if(!confirm('Redeem loyalty reward for '+name+'? This will reset their points to 0.'))return;
    await db.customers.redeem(id);
    toast('Reward redeemed for '+name+' ✓');
    Modal.close(); this.render(); Dashboard.render();
  },

  async delete(id) {
    if(!confirm('Delete this client? This cannot be undone.'))return;
    await db.customers.delete(id);
    Modal.close(); this.render(); toast('Client deleted');
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
      html.push(`<div style="background:var(--green-lt);border:1px solid var(--green-md);border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:14px;">Your booking page is live at: <strong><a href="/book" target="_blank" style="color:var(--green);">${location.origin}/book</a></strong></div>`);
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

      // Twilio SMS
      html.push('<div class="section-header">SMS Messaging</div><div class="card">');
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Connect Twilio to enable appointment reminders and booking confirmations. Sign up at twilio.com.</div>');
      html.push(`<div class="form-group"><label class="form-label">Account SID</label><input class="form-input" id="s-tsid" value="${s.twilio?.accountSid||''}" placeholder="ACxxxxxxxx" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Auth Token</label><input class="form-input" id="s-ttok" type="password" value="${s.twilio?.authToken||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">From number</label><input class="form-input" id="s-tfrom" value="${s.twilio?.fromNumber||''}" placeholder="+15055551234" /></div>`);
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
      try { stripeStatus = await fetch('/api/stripe/connect/status').then(r=>r.json()); } catch(e) {}
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

      // Security
      html.push('<div class="section-header">Security</div><div class="card">');
      html.push('<div style="display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:14px;font-weight:600;">App PIN</div><div style="font-size:12px;color:var(--muted);">Required to open the CRM. Booking page stays public.</div></div><button class="btn btn-sm" onclick="Auth.showChangePIN()">🔒 Change PIN</button></div>');
      html.push('</div>');

      html.push('<div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-primary" style="flex:1;" onclick="Settings.save()">Save Settings</button><button class="btn btn-danger" onclick="Auth.lock()">Lock App</button></div>');
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
      const res = await fetch('/api/stripe/connect/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
      const data = await res.json();
      if (data.ok && data.url) {
        window.location.href = data.url;
      } else {
        toast(data.error||'Could not connect Stripe. Make sure STRIPE_SECRET_KEY is set in Railway.','error');
        if(btn){btn.textContent='Connect Stripe Account';btn.disabled=false;}
      }
    } catch(e) { toast('Error connecting Stripe','error'); if(btn){btn.textContent='Connect Stripe Account';btn.disabled=false;} }
  },

  async disconnectStripe() {
    if (!confirm('Disconnect Stripe? Deposits will stop working.')) return;
    await fetch('/api/stripe/connect/disconnect',{method:'POST'});
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
    const ts=document.getElementById('s-tsid')?.value.trim(),tt=document.getElementById('s-ttok')?.value,tf=document.getElementById('s-tfrom')?.value.trim();
    if(ts||tt||tf)data.twilio={accountSid:ts,authToken:tt,fromNumber:tf};
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

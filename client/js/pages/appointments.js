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
        <button class="btn btn-sm" onclick="Appointments._navStep(-1)" title="${this._view==='week'?'Previous week':'Previous month'}">&#8249;</button>
        <div style="font-size:15px;font-weight:700;">${monthLabel}</div>
        <button class="btn btn-sm" onclick="Appointments._navStep(1)" title="${this._view==='week'?'Next week':'Next month'}">&#8250;</button>
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

      // Add button (hidden for view-only role)
      html.push(`<div class="section-header" style="display:flex;align-items:center;gap:8px;">
        <button class="btn btn-sm" onclick="Appointments.changeDay(-1)" title="Previous day">&#8249;</button>
        <span style="flex:1;text-align:center;">${fmtDateFull(this._selected)}</span>
        <button class="btn btn-sm" onclick="Appointments.changeDay(1)" title="Next day">&#8250;</button>
        ${canWrite()?'<button class="btn btn-sm btn-green" onclick="Appointments.openForm(null)">+ Add</button>':''}
      </div>`);

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
              <div class="list-name" ${a.customerId&&canSeeClients()?`onclick="event.stopPropagation();ClientProfile.open('${a.customerId}')" style="cursor:pointer;color:var(--text);"`:''}">${esc(a.customerName)}</div>
              <div class="list-sub">${a.time} · ${esc(a.service)}${barber?' · '+esc(barber.name):''}</div>
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
            <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${a.customerId&&canSeeClients()?'cursor:pointer;':''}" onclick="event.stopPropagation();${a.customerId&&canSeeClients()?`ClientProfile.open('${a.customerId}')`:''}">${esc(a.customerName)}</div>
            <div style="font-size:11px;color:var(--muted);">${esc(a.service)}${barber?' · '+esc(barber.name):''}</div>
          </div>
          ${statusBadge(a.status)}
        </div>`;
      });
    }
    html += '</div>';
    return html;
  },

  _ymd(dt){ return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; },

  // Nav arrows step by the granularity of the current view: a day in day view, a
  // week in week view, a month in month view — so paging never overshoots what's
  // on screen. (v1 has month/week; the v2 redesign adds a day view.)
  _navStep(delta){
    if (this._view==='day') this.changeDay(delta);
    else if (this._view==='week') this.changeDay(delta*7);
    else this.changeMonth(delta);
  },

  changeDay(delta) {
    const dt=new Date(this._selected+'T12:00:00');
    dt.setDate(dt.getDate()+delta);
    this._selected=this._ymd(dt);
    this.render();
  },

  changeMonth(delta) {
    const dt=new Date(this._selected+'T12:00:00');
    const d=dt.getDate();
    dt.setDate(1);                 // pin to the 1st first so a short target month can't overflow
    dt.setMonth(dt.getMonth()+delta);
    const last=new Date(dt.getFullYear(),dt.getMonth()+1,0).getDate();
    dt.setDate(Math.min(d,last));  // keep the day, clamped to the target month's length
    this._selected=this._ymd(dt);
    this.render();
  },

  openForm(id) {
    const a = id ? this._data.find(x=>x.id===id) : null;
    const barberOpts = this._barbers.map(b=>`<option value="${b.id}|${esc(b.name)}"${a?.barberId===b.id?' selected':''}>${esc(b.name)}</option>`).join('');
    // Service options show the name only — no price, to avoid confusion at booking
    // (the actual price still fills the Price field below via _recalcPrice).
    const svcOpts = this._services.map(s=>`<option value="${s.id}|${esc(s.name)}|${s.price}"${a?.serviceId===s.id?' selected':''}>${esc(s.name)}</option>`).join('');
    // "Custom service" lets the owner book an off-menu job: a free-text label plus a
    // price they set by hand. Auto-selected when editing an appt whose service isn't
    // (or is no longer) in the catalog.
    const isCustomSvc = !!a && !this._services.some(s=>s.id===a.serviceId);
    const customOpt = `<option value="__custom__"${isCustomSvc?' selected':''}>✏️ Custom service…</option>`;
    Modal.show(`
      <div class="modal-title">${a?'Edit Appointment':'New Appointment'}</div>
      <div class="form-group"><label class="form-label">Client *</label>
        <div class="autocomplete-wrap"><input class="form-input" id="fa-name" value="${esc(a?.customerName||'')}" placeholder="Search or type name..." /><div class="autocomplete-list" id="fa-list"></div></div>
        <input type="hidden" id="fa-cid" value="${a?.customerId||''}" />
        <input type="hidden" id="fa-phone" value="${esc(a?.customerPhone||'')}" />
        <input type="hidden" id="fa-quote-id" value="" />
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Service</label>
          <select class="form-input" id="fa-svc" onchange="Appointments._svcChange()">${svcOpts}${customOpt}</select>
        </div>
        <div class="form-group"><label class="form-label">Price</label>
          <input class="form-input" id="fa-price" type="number" value="${a?.price||35}" oninput="Appointments._priceEdited=true" />
        </div>
      </div>
      <div class="form-group" id="fa-svc-custom-row" style="display:${isCustomSvc?'block':'none'};"><label class="form-label">What service?</label>
        <input class="form-input" id="fa-svc-custom" value="${isCustomSvc?esc(a?.service||''):''}" placeholder="Describe the service (e.g. Headlight restoration)" />
      </div>
      ${(Shop.sizes||[]).length?`<div class="form-group"><label class="form-label">Vehicle size</label>
        <select class="form-input" id="fa-size" onchange="Appointments._recalcPrice()">${Shop.sizes.map(sz=>`<option value="${esc(sz.key)}"${a?.vehicleSize===sz.key?' selected':''}>${esc(sz.label)}</option>`).join('')}</select>
      </div>`:''}
      ${(Shop.addons||[]).length?`<div class="form-group"><label class="form-label">Add-ons</label>
        <div style="display:flex;flex-direction:column;gap:2px;">${Shop.addons.map(ad=>{const ck=(a?.addons||[]).some(x=>x.id===ad.id);return `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:4px 0;">
          <input type="checkbox" class="fa-addon" value="${esc(ad.id)}" data-name="${esc(ad.name)}" data-price="${ad.price}" ${ck?'checked':''} onchange="Appointments._recalcPrice()" />
          <span style="flex:1;">${esc(ad.name)}</span><span style="color:var(--muted);">+${fmtMoney(ad.price)}</span></label>`;}).join('')}</div>
      </div>`:''}
      <div class="form-group"><label class="form-label">${esc(V('staff','Barber'))}</label>
        <select class="form-input" id="fa-barber"><option value="|">Any ${esc(V('staff','barber').toLowerCase())}</option>${barberOpts}</select>
      </div>
      ${this._customFieldsForm(a)}
      <div class="form-row">
        <div class="form-group"><label class="form-label">Date</label><input class="form-input" id="fa-date" type="date" value="${a?.date||this._selected}" /></div>
        <div class="form-group"><label class="form-label">Time</label><input class="form-input" id="fa-time" type="time" value="${a?.time?this._to24(a.time):'10:00'}" /></div>
      </div>
      ${a&&(Shop.statuses||[]).length?`<div class="form-group"><label class="form-label">Status</label>
        <select class="form-input" id="fa-status">${Shop.statuses.map(st=>`<option value="${st.key}"${a.status===st.key?' selected':''}>${esc(st.label)}</option>`).join('')}</select>
      </div>`:''}
      <div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="fa-notes" value="${esc(a?.notes||'')}" placeholder="Optional notes..." /></div>
      <div class="modal-actions">
        ${a?`<button class="btn btn-green btn-full" onclick="Appointments.complete('${a.id}')">✓ Mark Complete</button>`:''}
        ${a?`<button class="btn btn-danger btn-full" onclick="Appointments.delete('${a.id}')">Delete</button>`:''}
        <button id="fa-btn" class="btn btn-primary btn-full" onclick="Appointments.save('${a?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>{
      makeAutocomplete('fa-name','fa-list',(id,name,phone)=>{document.getElementById('fa-name').value=name;document.getElementById('fa-cid').value=id;document.getElementById('fa-phone').value=phone||'';});
      // New appt: auto-price from the preselected service + size. Editing an existing
      // appt: treat the saved price as owner-set so a size/add-on tweak won't wipe it
      // (only picking a new service resets it). A manual edit locks it either way.
      Appointments._priceEdited = !!a;
      if(!a) Appointments._recalcPrice();
    },150);
  },

  openFormPrefilled(customerId, customerName, customerPhone, extras) {
    // Ensure barbers/services are loaded then open a new appointment form pre-filled with client
    const load = (this._barbers.length && this._services.length)
      ? Promise.resolve()
      : Promise.all([db.barbers.all(), db.services.all()]).then(([b,s])=>{ this._barbers=b; this._services=s; });
    load.then(() => {
      this.openForm(null);
      // After form renders, fill in the client fields (+ optional extras from a quote).
      // Delay must exceed openForm's own 150ms auto-recalc so an extras.price wins.
      setTimeout(() => {
        const nameEl  = document.getElementById('fa-name');
        const cidEl   = document.getElementById('fa-cid');
        const phoneEl = document.getElementById('fa-phone');
        if (nameEl)  nameEl.value  = customerName;
        if (cidEl)   cidEl.value   = customerId;
        if (phoneEl) phoneEl.value = customerPhone;
        if (extras) {
          if (extras.price != null) { const p=document.getElementById('fa-price'); if(p)p.value=extras.price; }
          if (extras.notes) { const n=document.getElementById('fa-notes'); if(n)n.value=extras.notes; }
          if (extras.vehicle) (Shop.fields||[]).forEach(f=>{ const prop=f.key.replace(/^vehicle/,'').toLowerCase(); const v=extras.vehicle[prop]; if(v!=null){ const el=document.getElementById('fa-cf-'+f.key); if(el)el.value=v; } });
          if (extras.quoteId) { const qe=document.getElementById('fa-quote-id'); if(qe)qe.value=extras.quoteId; }
        }
      }, 220);
    });
  },

  _customFieldsForm(a) {
    const fields = Shop.fields || [];
    if (!fields.length) return '';
    const cf = (a && a.customFields) || {};
    const inputs = fields.map(f=>`<div class="form-group"><label class="form-label">${esc(f.label)}${f.required?' *':''}</label><input class="form-input" id="fa-cf-${esc(f.key)}" value="${esc(cf[f.key]||'')}" placeholder="${esc(f.label)}" /></div>`).join('');
    return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">${inputs}</div>`;
  },

  _customFieldsDetail(a) {
    const fields = Shop.fields || []; const cf = a.customFields || {};
    const filled = fields.filter(f=>cf[f.key]);
    if (!filled.length) return '';
    const icon = cf.vehicleMake ? '🚗 ' : '';
    return `<div style="font-size:13px;color:var(--muted);margin-top:6px;">${icon}${filled.map(f=>esc(cf[f.key])).join(' ')}</div>`;
  },

  // Intake / condition report — walkaround photos + condition notes captured at
  // drop-off to document pre-existing damage (CYA). Detail shops only; barbershops
  // never see it. Reuses the job-photo upload pipeline with an 'intake' phase.
  _intakeSection(a) {
    const isDetailish = (Shop.fields||[]).some(f=>f.key && f.key.indexOf('vehicle')===0);
    const intake = a.intakePhotos||[];
    if (!isDetailish && !intake.length && !a.conditionNotes) return '';
    const w = canWrite();
    const thumbs = intake.map(p=>`<div style="position:relative;flex-shrink:0;">
      <img src="${esc(p.url)}" onclick="window.open('${esc(p.url)}','_blank')" style="width:72px;height:72px;object-fit:cover;border-radius:8px;cursor:zoom-in;display:block;" />
      ${w?`<button onclick="Appointments._deletePhoto('${a.id}','${p.id}')" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:1px solid var(--surface);background:#dc2626;color:#fff;font-size:13px;line-height:1;cursor:pointer;padding:0;">×</button>`:''}
    </div>`).join('');
    const add = w?`<button onclick="Appointments._pickPhoto('${a.id}','intake')" style="width:72px;height:72px;border-radius:8px;border:1px dashed var(--border);background:var(--surface);color:var(--muted);font-size:11px;cursor:pointer;flex-shrink:0;">＋ Add</button>`:'';
    const empty = (!intake.length && !w)?'<span style="font-size:12px;color:var(--faint);">None</span>':'';
    const notes = w
      ? `<textarea id="cond-notes-${a.id}" class="form-input" rows="2" placeholder="Note any existing damage — scratches, dents, stains…" style="margin-top:8px;font-size:13px;">${esc(a.conditionNotes||'')}</textarea>
         <button class="btn btn-sm" style="margin-top:6px;" onclick="Appointments._saveCondition('${a.id}')">Save condition notes</button>`
      : (a.conditionNotes?`<div style="font-size:13px;color:var(--muted);margin-top:8px;white-space:pre-wrap;">${esc(a.conditionNotes)}</div>`:'');
    return `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.05em;">🔍 INTAKE / CONDITION <span style="font-weight:500;color:var(--faint);">at drop-off</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">${thumbs}${add}${empty}</div>
      ${notes}
    </div>`;
  },

  async _saveCondition(id) {
    const el = document.getElementById('cond-notes-'+id); if(!el) return;
    const conditionNotes = el.value.trim();
    try {
      await db.appointments.save({ id, conditionNotes });
      const a = this._data.find(x=>x.id===id); if (a) a.conditionNotes = conditionNotes;
      toast('Condition notes saved ✓');
    } catch(e) { toast('Could not save','error'); }
  },

  // Before/after photo documentation. Shown for verticals that capture vehicle
  // info (detail shops) or whenever photos already exist — barbershops never see it.
  _jobPhotos(a) {
    const isDetailish = (Shop.fields||[]).some(f=>f.key && f.key.indexOf('vehicle')===0);
    const before = a.beforePhotos||[], after = a.afterPhotos||[];
    if (!isDetailish && !before.length && !after.length) return '';
    const w = canWrite();
    const tiles = (photos, phase) => {
      const thumbs = photos.map(p=>`<div style="position:relative;flex-shrink:0;">
        <img src="${esc(p.url)}" onclick="window.open('${esc(p.url)}','_blank')" style="width:72px;height:72px;object-fit:cover;border-radius:8px;cursor:zoom-in;display:block;" />
        ${w?`<button onclick="Appointments._deletePhoto('${a.id}','${p.id}')" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:1px solid var(--surface);background:#dc2626;color:#fff;font-size:13px;line-height:1;cursor:pointer;padding:0;">×</button>`:''}
      </div>`).join('');
      const add = w?`<button onclick="Appointments._pickPhoto('${a.id}','${phase}')" style="width:72px;height:72px;border-radius:8px;border:1px dashed var(--border);background:var(--surface);color:var(--muted);font-size:11px;cursor:pointer;flex-shrink:0;">＋ Add</button>`:'';
      const empty = (!photos.length && !w)?'<span style="font-size:12px;color:var(--faint);">None</span>':'';
      return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">${thumbs}${add}${empty}</div>`;
    };
    return `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.05em;">📷 BEFORE</div>
      ${tiles(before,'before')}
      <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.05em;margin-top:12px;">✨ AFTER</div>
      ${tiles(after,'after')}
    </div>`;
  },

  _pickPhoto(id, phase) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files && input.files[0]; if (!file) return;
      try {
        toast('Uploading photo…');
        const dataUrl = await downscaleImage(file, 1280, 0.82);
        const r = await db.appointments.addPhoto(id, phase, dataUrl);
        const a = this._data.find(x=>x.id===id);
        const PKEY = { before:'beforePhotos', after:'afterPhotos', intake:'intakePhotos' };
        if (a && r && r.item) { const key = PKEY[phase]||'beforePhotos'; a[key] = [...(a[key]||[]), r.item]; }
        toast('Photo added ✓');
        this.openDetail(id);
      } catch(e) { toast(e.message||'Upload failed','error'); }
    };
    input.click();
  },

  async _deletePhoto(id, photoId) {
    if (!confirm('Delete this photo?')) return;
    try {
      await db.appointments.deletePhoto(id, photoId);
      const a = this._data.find(x=>x.id===id);
      if (a) ['beforePhotos','afterPhotos','intakePhotos'].forEach(k=>{ if(a[k]) a[k]=a[k].filter(p=>p.id!==photoId); });
      toast('Photo deleted');
      this.openDetail(id);
    } catch(e) { toast('Could not delete','error'); }
  },

  _statusChanger(a) {
    const sts = (Shop.statuses||[]).filter(s=>!s.terminal && !s.noShow);
    // Only show for verticals with operational states beyond confirmed/in-progress
    // (e.g. detail's dropped-off/curing/ready) — keeps the barbershop UX unchanged.
    const hasOps = sts.some(s=>!['confirmed','in-progress'].includes(s.key));
    if (!hasOps) return '';
    return `<div class="form-group" style="margin-bottom:12px;"><label class="form-label">Update status</label>
      <select class="form-input" onchange="Appointments.setStatus('${a.id}',this.value)">
        ${sts.map(s=>`<option value="${s.key}"${a.status===s.key?' selected':''}>${esc(s.label)}</option>`).join('')}
      </select></div>`;
  },

  async setStatus(id, key) {
    const a = this._data.find(x=>x.id===id); if(!a) return;
    try {
      await db.appointments.save(Object.assign({}, a, { status:key }));
      Modal.close(); toast('Status updated ✓');
      await this.render(); Dashboard.render();
    } catch(e) { toast('Could not update status','error'); }
  },

  // Picking a different service resets to that service's price; a manual edit to
  // the Price field afterward locks it again.
  _svcChange() {
    const custom = (document.getElementById('fa-svc')?.value||'')==='__custom__';
    const row=document.getElementById('fa-svc-custom-row'); if(row) row.style.display=custom?'block':'none';
    if(custom){
      // Off-menu job: no catalog price to pull, so leave the Price field for the owner
      // to set and stop _recalcPrice from clobbering it.
      this._priceEdited=true;
      document.getElementById('fa-svc-custom')?.focus();
    } else {
      this._priceEdited=false; this._recalcPrice();
    }
  },

  // Set the price field to the total: the selected service (size-adjusted for
  // detail shops) plus any checked add-ons. Falls back to the flat price. Skips
  // when the owner has typed their own price so size/add-on changes don't wipe it.
  _recalcPrice() {
    if (this._priceEdited) return;
    const svcId=(document.getElementById('fa-svc')?.value||'').split('|')[0];
    const svc=this._services.find(s=>s.id===svcId); if(!svc)return;
    const sizeKey=document.getElementById('fa-size')?.value||'';
    let total=servicePrice(svc,sizeKey);
    document.querySelectorAll('.fa-addon:checked').forEach(cb=>{ total+=Number(cb.dataset.price)||0; });
    const pi=document.getElementById('fa-price'); if(pi)pi.value=total;
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
    let svcId, svcName;
    if(svcVal==='__custom__'){
      svcId=null;
      svcName=(document.getElementById('fa-svc-custom')?.value||'').trim();
      if(!svcName){ toast('Describe the custom service','warning'); return; }
    } else {
      [svcId,svcName]=svcVal.split('|');
    }
    const barberVal=document.getElementById('fa-barber')?.value||'';
    const[barberId,barberName]=barberVal.split('|');
    const timeVal=document.getElementById('fa-time')?.value||'10:00';
    // Collect + validate custom fields (e.g. vehicle info for detail shops)
    const cf={};
    for(const f of (Shop.fields||[])){
      const v=document.getElementById('fa-cf-'+f.key)?.value.trim()||'';
      if(f.required && !v){ toast('Please enter '+f.label,'warning'); return; }
      cf[f.key]=v;
    }
    const statusSel=document.getElementById('fa-status')?.value;
    const quoteId=document.getElementById('fa-quote-id')?.value||'';
    const apptId=id||genId('a');
    const btn=document.getElementById('fa-btn'); disableBtn(btn);
    try {
      await db.appointments.save({
        id:apptId,
        customerId:document.getElementById('fa-cid')?.value||null,
        customerName:name,
        customerPhone:document.getElementById('fa-phone')?.value||'',
        barberId:barberId||null, barberName:barberName||null,
        serviceId:svcId||null, service:svcName||'Haircut',
        price:parseFloat(document.getElementById('fa-price')?.value)||35,
        date:document.getElementById('fa-date')?.value||today(),
        time:this._to12(timeVal),
        duration:45,
        status:statusSel||(id?(this._data.find(x=>x.id===id)?.status||'confirmed'):'confirmed'),
        notes:document.getElementById('fa-notes')?.value.trim()||'',
        customFields:cf,
        vehicleSize:document.getElementById('fa-size')?.value||null,
        addons:[...document.querySelectorAll('.fa-addon:checked')].map(cb=>({id:cb.value,name:cb.dataset.name,price:Number(cb.dataset.price)||0})),
        source:'crm',
      });
      // If this appointment was created from a quote, mark that quote scheduled
      // now that it's actually saved (not before).
      if (quoteId) { try { await db.quotes.save({ id:quoteId, status:'scheduled', appointmentId:apptId }); } catch(e) {} }
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
        <div style="font-size:16px;font-weight:700;${a.customerId?'cursor:pointer;color:var(--green);':''}" onclick="${a.customerId?`Modal.close();ClientProfile.open('${a.customerId}')`:''}">${esc(a.customerName)}${a.customerId?' ↗':''}</div>
        <div style="font-size:13px;color:var(--muted);margin-top:4px;">${esc(a.service)} · ${fmtDateFull(a.date)} at ${a.time}</div>
        ${barber?`<div style="font-size:13px;color:var(--muted);">with ${esc(barber.name)}</div>`:''}
        <div style="margin-top:8px;">${statusBadge(a.status)} <span style="font-weight:700;color:var(--green);margin-left:8px;">${fmtMoney(a.price)}</span>${a.vehicleSize?`<span style="font-size:12px;color:var(--muted);margin-left:8px;">${esc((Shop.sizes.find(z=>z.key===a.vehicleSize)||{}).label||a.vehicleSize)}</span>`:''}</div>
        ${(a.addons&&a.addons.length)?`<div style="font-size:12px;color:var(--muted);margin-top:6px;">＋ ${a.addons.map(x=>esc(x.name)+' ('+fmtMoney(x.price)+')').join(' · ')}</div>`:''}
        ${this._customFieldsDetail(a)}
        ${a.notes?`<div style="font-size:13px;color:var(--muted);margin-top:8px;">${esc(a.notes)}</div>`:''}
        ${a.customerPhone?`<div style="font-size:13px;color:var(--muted);margin-top:4px;">📱 ${esc(a.customerPhone)}</div>`:''}
        ${a.inspoPhoto?`<div style="margin-top:10px;">
          <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.05em;margin-bottom:6px;">📸 INSPO PHOTO</div>
          <img src="${esc(a.inspoPhoto)}" onclick="window.open('${esc(a.inspoPhoto)}','_blank')" style="width:100%;max-height:300px;object-fit:cover;border-radius:10px;cursor:zoom-in;" />
        </div>`:''}
        ${this._intakeSection(a)}
        ${this._jobPhotos(a)}
      </div>
      ${canWrite()?this._statusChanger(a):''}
      <div class="modal-actions">
        ${a.customerId&&canSeeClients()?`<button class="btn btn-full" onclick="Modal.close();ClientProfile.open('${a.customerId}')">👤 View Client Profile</button>`:''}
        ${canWrite()&&a.status!=='done'&&a.status!=='no-show'?`<button class="btn btn-green btn-full" onclick="Appointments.complete('${a.id}')">✓ Mark Complete</button>`:''}
        ${canWrite()&&a.status!=='done'&&a.status!=='no-show'?`<button class="btn btn-full" style="color:var(--orange);border-color:#fde68a;" onclick="Appointments.noShow('${a.id}')">😤 No Show</button>`:''}
        ${canWrite()&&a.status==='confirmed'&&!a.depositPaid&&!a.depositWaived?`<button class="btn btn-full" style="color:var(--muted);" onclick="Appointments.waiveDeposit('${a.id}')">⚡ Waive Deposit</button>`:''}
        ${canWrite()?`<button class="btn btn-full" onclick="Appointments.openForm('${a.id}')">Edit</button>`:''}
        ${canWrite()?`<button class="btn btn-danger btn-full" onclick="Appointments.delete('${a.id}')">Delete</button>`:''}
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
      <div class="modal-title">🧾 Checkout</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">${esc(a.customerName)} · ${esc(a.service)}</div>
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
        <label class="form-label">${esc(V('notes','Cut Notes'))} <span style="font-weight:400;color:var(--faint);">(optional)</span></label>
        <textarea class="form-input" id="cc-notes" rows="2" placeholder="${esc(V('notes','Cut Notes'))}…"></textarea>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:16px;">
        <div id="cc-tax-row" style="display:${(Shop.tax&&Shop.tax.enabled&&Number(Shop.tax.rate)>0)?'flex':'none'};justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:6px;"><span>${esc((Shop.tax&&Shop.tax.label)||'Sales Tax')} (${Number(Shop.tax&&Shop.tax.rate)||0}%)</span><span id="cc-tax-amt">$0</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:13px;font-weight:600;color:var(--muted);">Total</span>
          <span id="cc-total" style="font-size:22px;font-weight:800;color:var(--green);">${fmtMoney(a.price||35)}</span>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-full" style="background:var(--text);color:#fff;" onclick="Appointments._checkoutCash()">💵 Cash</button>
        ${stripeConnected
          ? `<button class="btn btn-full btn-green" onclick="Appointments._checkoutCard()">💳 Send Card Link</button>`
          : `<button class="btn btn-full" style="opacity:.5;cursor:default;" disabled>💳 Card (connect Stripe in Settings)</button>`
        }
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    this._updateTotal(); // reflect tax in the total as soon as the modal opens
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

  // Sales tax on the service amount (matches the server's computeTax — tips excluded).
  _taxAmt(amount) {
    const t = Shop.tax || {}; const rate = Number(t.rate)||0;
    if (!t.enabled || rate<=0) return 0;
    return Math.round((Number(amount)||0)*rate)/100;
  },

  _updateTotal() {
    const price = parseFloat(document.getElementById('cc-price')?.value)||0;
    const tip   = parseFloat(document.getElementById('cc-tip')?.value)||0;
    const tax   = Appointments._taxAmt(price);
    Appointments._co.price = price;
    Appointments._co.tip   = tip;
    const taxEl = document.getElementById('cc-tax-amt'); if (taxEl) taxEl.textContent = fmtMoney(tax);
    const el = document.getElementById('cc-total');
    if (el) el.textContent = fmtMoney(price+tax+tip);
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
    const total = price + Appointments._taxAmt(price) + tip;
    Modal.show(`
      <div class="modal-title">💳 Card Payment</div>
      <div style="font-size:22px;font-weight:800;color:var(--green);text-align:center;margin-bottom:4px;">${fmtMoney(total)}</div>
      <div style="font-size:12px;color:var(--muted);text-align:center;margin-bottom:20px;">for ${esc(name)}</div>
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
        ${hasPhone ? `<button class="btn btn-green btn-full" id="send-link-btn" onclick="Appointments._textPayLink()">📱 Text to ${esc(phone)}</button>` : ''}
        <div style="margin-top:10px;">
          <button class="btn btn-full" id="verify-btn" onclick="Appointments._verifyPayment(this)">✓ Check Payment</button>
        </div>`;
      // Set URL value via JS to avoid HTML encoding issues
      const linkInput = document.getElementById('pay-link-input');
      if (linkInput) linkInput.value = r.url;
    } catch(e) { toast('Could not create payment link — check Stripe settings','error'); }
  },

  _textPayLink() {
    const { phone, name, url } = Appointments._co;
    if (!phone) { toast('No phone number on file', 'warning'); return; }
    const firstName = (name || '').split(' ')[0];
    const msg = `Hi ${firstName}! Here's your payment link for today's visit: ${url}`;
    // Manual send via the iPhone Messages deep link (no Twilio/A2P).
    _cpSms(phone, msg);
    const btn = document.getElementById('send-link-btn');
    if (btn) { btn.textContent = '✓ Opened in Messages'; btn.style.background = 'var(--green)'; }
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

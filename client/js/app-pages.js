// ── Jobs ─────────────────────────────────────────────────────────────────────
const Jobs = {
  _data: [], _templates: [], _filter: '',

  async load(){ [this._data, this._templates] = await Promise.all([db.jobs.all(), db.templates.all()]); },

  async render(){
    const el=document.getElementById('page-jobs');
    el.innerHTML='<div class="spinner-page"><div class="spinner"></div></div>';
    await this.load();
    const html = [];
    html.push('<div style="display:flex;gap:8px;margin-bottom:12px;overflow-x:auto;padding-bottom:4px;">');
    [['','All'],['scheduled','Scheduled'],['in-progress','In Progress'],['done','Done']].forEach(([v,lb])=>{
      html.push('<button class="scroll-tab'+(Jobs._filter===v?' active':'')+'" onclick="Jobs._filter=\''+v+'\';Jobs.renderList()">'+lb+'</button>');
    });
    html.push('</div>');
    html.push('<button class="btn btn-full btn-primary" onclick="Jobs.openAdd()" style="margin-bottom:14px;">+ New Job</button>');
    html.push('<div class="card" style="padding:0 16px;" id="jobs-list"></div>');
    el.innerHTML = html.join('');
    this.renderList();
  },

  renderList(){
    const filtered = this._data.filter(j=>!Jobs._filter||j.status===Jobs._filter);
    const el = document.getElementById('jobs-list');
    if(!el)return;
    if(!filtered.length){el.innerHTML='<div style="padding:24px;text-align:center;color:var(--faint);font-size:13px;">No jobs</div>';return;}
    const html=[];
    filtered.slice(0,30).forEach(j=>{
      html.push('<div class="list-row" onclick="Jobs.openEdit(\''+j.id+'\')">');
      html.push(avatarEl(j.customer_name||'?',40));
      html.push('<div class="list-main"><div class="list-name">'+(j.customer_name||'—')+'</div><div class="list-sub">'+catBadge(j.category)+' '+j.service+'<br><span style="color:var(--faint);font-size:11px;">'+fmtDateShort(j.date)+'</span></div></div>');
      html.push('<div class="list-right"><div class="list-amount">'+fmtMoney(j.price)+'</div>'+statusBadge(j.status));
      if(j.status==='scheduled')html.push('<br><button class="btn btn-sm" style="margin-top:4px;background:#fff3e0;border-color:#EF9F27;color:#7c4a00;font-size:11px;" onclick="event.stopPropagation();Jobs.quickStatus(\''+j.id+'\',\'in-progress\')">Start</button>');
      if(j.status==='in-progress')html.push('<br><button class="btn btn-sm" style="margin-top:4px;background:#eaf3de;border-color:#3B6D11;color:#27500a;font-size:11px;" onclick="event.stopPropagation();Jobs.quickStatus(\''+j.id+'\',\'done\')">Done</button>');
      html.push('</div></div>');
    });
    el.innerHTML = html.join('');
  },

  async quickStatus(id, status){
    const j=this._data.find(x=>x.id===id);if(!j)return;
    await db.jobs.save(Object.assign({},j,{status}));
    toast('Job marked '+status);
    await this.render();
    App.refreshDashboard();
  },

  openAdd(prefillCustomerId){
    this._showModal(null, prefillCustomerId||null);
  },

  openEdit(id){
    const j=this._data.find(x=>x.id===id);if(!j)return;
    this._showModal(j, j.customer_id);
  },

  _showModal(job, prefillCustId){
    const cats={detail:'Detail',tint:'Tint',tire:'Tires'};
    const html=[];
    html.push('<div class="modal-title">'+(job?'Edit Job':'New Job')+'</div>');
    html.push('<div class="form-group"><label class="form-label">Customer</label><div class="autocomplete-wrap"><input class="form-input" id="fj-cust-name" placeholder="Search customers..." value="'+(job?job.customer_name||'':'')+'" /><div class="autocomplete-list" id="fj-cust-list"></div></div><input type="hidden" id="fj-cust-id" value="'+(job?job.customer_id||'':prefillCustId||'')+'" /></div>');
    // Template picker
    html.push('<div class="form-group"><label class="form-label">Service Template</label>');
    Object.entries(cats).forEach(([cat,label])=>{
      const tpls=this._templates.filter(t=>t.category===cat);
      if(!tpls.length)return;
      html.push('<div style="font-size:11px;font-weight:700;color:var(--faint);text-transform:uppercase;margin:8px 0 6px;">'+label+'</div>');
      html.push('<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;">');
      tpls.forEach(t=>html.push('<button class="btn btn-sm'+(job&&job.template_id===t.id?' btn-primary':'')+'" id="tpl-'+t.id+'" onclick="Jobs._pickTpl(\''+t.id+'\',\''+t.name+'\','+t.price+','+t.cost+',\''+cat+'\')">'+t.name+' — '+fmtMoney(t.price)+'</button>'));
      html.push('</div>');
    });
    html.push('</div>');
    html.push('<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="fj-service" placeholder="Service description" value="'+(job?job.service||'':'')+'" /></div>');
    html.push('<div class="form-row">');
    html.push('<div class="form-group"><label class="form-label">Category</label><select class="form-input" id="fj-category"><option value="detail"'+((!job||job.category==='detail')?' selected':'')+'>Detail</option><option value="tint"'+(job&&job.category==='tint'?' selected':'')+'>Tint</option><option value="tire"'+(job&&job.category==='tire'?' selected':'')+'>Tire</option></select></div>');
    html.push('<div class="form-group"><label class="form-label">Status</label><select class="form-input" id="fj-status"><option value="scheduled"'+(!job||job.status==='scheduled'?' selected':'')+'>Scheduled</option><option value="in-progress"'+(job&&job.status==='in-progress'?' selected':'')+'>In Progress</option><option value="done"'+(job&&job.status==='done'?' selected':'')+'>Done</option></select></div>');
    html.push('</div>');
    html.push('<div class="form-row">');
    html.push('<div class="form-group"><label class="form-label">Price ($)</label><input class="form-input" id="fj-price" type="number" placeholder="0" value="'+(job?job.price||'':'')+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Cost ($)</label><input class="form-input" id="fj-cost" type="number" placeholder="0" value="'+(job?job.cost||'':'')+'" /></div>');
    html.push('</div>');
    html.push('<div class="form-group"><label class="form-label">Date</label><input class="form-input" id="fj-date" type="date" value="'+(job?job.date:today())+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="fj-notes" placeholder="Any notes..." value="'+(job?job.notes||'':'')+'" /></div>');
    html.push('<div class="modal-actions">');
    if(job)html.push('<button class="btn btn-full" style="color:var(--red);" onclick="Jobs.delete(\''+job.id+'\')">Delete</button>');
    html.push('<button class="btn btn-full btn-primary" onclick="Jobs.save(\''+(job?job.id:'')+'\')">Save Job</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
    setTimeout(()=>makeAutocomplete('fj-cust-name','fj-cust-list',(id,name)=>{document.getElementById('fj-cust-name').value=name;document.getElementById('fj-cust-id').value=id;}),100);
  },

  _pickTpl(id,name,price,cost,cat){
    document.getElementById('fj-service').value=name;
    document.getElementById('fj-price').value=price;
    document.getElementById('fj-cost').value=cost;
    document.getElementById('fj-category').value=cat;
    document.querySelectorAll('[id^="tpl-"]').forEach(b=>b.classList.remove('btn-primary'));
    const btn=document.getElementById('tpl-'+id);if(btn)btn.classList.add('btn-primary');
  },

  async save(jobId){
    const btn=document.getElementById('job-save-btn');disableBtn(btn);
    const service=document.getElementById('fj-service')&&document.getElementById('fj-service').value.trim();
    if(!service){alert('Please enter a service description.');return;}
    const job={id:jobId||genId('j'),customer_id:document.getElementById('fj-cust-id')&&document.getElementById('fj-cust-id').value||null,service,category:document.getElementById('fj-category')&&document.getElementById('fj-category').value||'detail',price:parseFloat(document.getElementById('fj-price')&&document.getElementById('fj-price').value)||0,cost:parseFloat(document.getElementById('fj-cost')&&document.getElementById('fj-cost').value)||0,status:document.getElementById('fj-status')&&document.getElementById('fj-status').value||'scheduled',date:document.getElementById('fj-date')&&document.getElementById('fj-date').value||today(),notes:document.getElementById('fj-notes')&&document.getElementById('fj-notes').value.trim()||''};
    try {
      await db.jobs.save(job);
      Modal.close();
      toast(jobId?'Job updated':'Job added');
      await this.render();
      App.refreshDashboard();
    } catch(e) { toast('Could not save job — check connection','error'); enableBtn(btn); }
  },

  async delete(id){
    if(!confirm('Delete this job?'))return;
    try {
      await db.jobs.delete(id);
      Modal.close();
      await this.render();
      toast('Deleted');
    } catch(e) { toast('Could not delete','error'); }
  }
};

// ── Customers ─────────────────────────────────────────────────────────────────
const Customers = {
  _data: [],
  async load(){ this._data = await db.customers.all(); },
  async render(){
    const el=document.getElementById('page-customers');
    el.innerHTML='<div class="spinner-page"><div class="spinner"></div></div>';
    await this.load();
    const html=[];
    html.push('<button class="btn btn-full btn-primary" onclick="Customers.openAdd()" style="margin-bottom:14px;">+ New Customer</button>');
    html.push('<div class="card" style="padding:0 16px;">');
    if(!this._data.length){html.push('<div style="padding:24px;text-align:center;color:var(--faint);font-size:13px;">No customers yet</div>');}
    else{
      this._data.forEach(c=>{
        html.push('<div class="list-row" onclick="Customers.openProfile(\''+c.id+'\')">');
        html.push(avatarEl(c.name,40));
        html.push('<div class="list-main"><div class="list-name">'+c.name+'</div><div class="list-sub">'+sourceBadge(c.source)+(c.loyalty_points>0?' · &#11088; '+c.loyalty_points+' pts':'')+'</div></div>');
        html.push('<div style="font-size:20px;color:var(--faint);">&#8250;</div>');
        html.push('</div>');
      });
    }
    html.push('</div>');
    el.innerHTML=html.join('');
  },
  async openProfile(id){
    const data=await db.customers.get(id);if(!data)return;
    const {customer:c,vehicles,jobs,totalRevenue,totalProfit,totalVisits,loyaltyPoints,rewardReady,visitsForReward}=data;
    const html=[];
    html.push('<div class="modal-title">'+c.name+'</div>');
    html.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;">');
    html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:11px;color:var(--faint);">Revenue</div><div style="font-size:17px;font-weight:700;">'+fmtMoney(totalRevenue)+'</div></div>');
    html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:11px;color:var(--faint);">Profit</div><div style="font-size:17px;font-weight:700;color:var(--green);">'+fmtMoney(totalProfit)+'</div></div>');
    html.push('<div style="background:'+(rewardReady?'#fffbf0':'var(--surface2)')+';border-radius:8px;padding:10px;text-align:center;"><div style="font-size:11px;color:var(--faint);">Loyalty</div><div style="font-size:17px;font-weight:700;color:'+(rewardReady?'#EF9F27':'var(--text)')+';">'+loyaltyPoints+'/'+visitsForReward+' &#11088;</div></div>');
    html.push('</div>');
    html.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">');
    html.push('<div><div class="form-label">Phone</div><div style="font-size:14px;font-weight:500;">'+(c.phone||'—')+'</div></div>');
    html.push('<div><div class="form-label">Source</div>'+sourceBadge(c.source)+'</div>');
    html.push('</div>');
    if(c.notes)html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;font-size:13px;color:var(--muted);margin-bottom:14px;">'+c.notes+'</div>');
    if(vehicles.length){
      html.push('<div class="form-label" style="margin-bottom:8px;">Vehicles</div>');
      vehicles.forEach(v=>html.push('<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><span style="font-size:18px;">&#128664;</span><div><div style="font-weight:600;">'+v.year+' '+v.make+' '+v.model+'</div><div style="color:var(--muted);">'+(v.color||'')+(v.plate?' · '+v.plate:'')+'</div></div></div>'));
    }
    if(jobs.length){
      html.push('<div class="form-label" style="margin:12px 0 8px;">Recent Jobs</div>');
      jobs.slice(0,4).forEach(j=>html.push('<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;"><div style="flex:1;">'+catBadge(j.category)+' '+j.service+'<div style="font-size:11px;color:var(--faint);">'+fmtDateShort(j.date)+'</div></div><div style="font-weight:700;">'+fmtMoney(j.price)+'</div></div>'));
    }
    html.push('<div class="modal-actions">');
    if(rewardReady)html.push('<button class="btn btn-full" style="background:#fffbf0;border-color:#EF9F27;color:#854F0B;" onclick="db.customers.redeemReward(\''+c.id+'\').then(()=>{toast(\'Reward redeemed!\');Customers.openProfile(\''+c.id+'\');})">&#11088; Redeem Reward</button>');
    html.push('<button class="btn btn-full btn-primary" onclick="Jobs.openAdd(\''+c.id+'\')">+ New Job</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Close</button>');
    html.push('</div>');
    Modal.show(html.join(''));
  },
  openAdd(){
    const html=[];
    html.push('<div class="modal-title">New Customer</div>');
    html.push('<div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fc-name" placeholder="Full name or business" /></div>');
    html.push('<div class="form-row"><div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="fc-phone" type="tel" /></div><div class="form-group"><label class="form-label">Email</label><input class="form-input" id="fc-email" type="email" /></div></div>');
    html.push('<div class="form-row"><div class="form-group"><label class="form-label">Type</label><select class="form-input" id="fc-type"><option value="individual">Individual</option><option value="fleet">Fleet</option><option value="dealer">Dealer</option></select></div><div class="form-group"><label class="form-label">Source</label><select class="form-input" id="fc-source"><option value="walk-in">Walk-in</option><option value="instagram">Instagram</option><option value="google">Google</option><option value="referral">Referral</option><option value="facebook">Facebook</option></select></div></div>');
    html.push('<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="fc-notes" /></div>');
    html.push('<div class="modal-actions"><button class="btn btn-full btn-primary" onclick="Customers.save()">Save Customer</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>');
    Modal.show(html.join(''));
  },
  async save(){
    const name=document.getElementById('fc-name')&&document.getElementById('fc-name').value.trim();
    if(!name){toast('Please enter a name.','warning');return;}
    try {
      await db.customers.save({id:genId('c'),name,phone:document.getElementById('fc-phone')&&document.getElementById('fc-phone').value.trim()||'',email:document.getElementById('fc-email')&&document.getElementById('fc-email').value.trim()||'',type:document.getElementById('fc-type')&&document.getElementById('fc-type').value||'individual',source:document.getElementById('fc-source')&&document.getElementById('fc-source').value||'walk-in',notes:document.getElementById('fc-notes')&&document.getElementById('fc-notes').value.trim()||'',loyalty_points:0});
      Modal.close();toast('Customer added');await this.render();
    } catch(e) { toast('Could not save customer','error'); }
  }
};

// ── Follow-ups ────────────────────────────────────────────────────────────────
const Followups = {
  _data: [],
  async load(){ this._data = await db.tasks.all(); this.updateBadge(); },
  updateBadge(){
    const today_str=today();
    const n=this._data.filter(t=>!t.done&&t.due_date<=today_str).length;
    const b=document.getElementById('followups-badge');
    if(b){if(n>0){b.textContent=n;b.classList.remove('hidden');}else b.classList.add('hidden');}
  },
  async render(){
    await this.load();
    const today_str=today();
    const el=document.getElementById('page-followups');
    const overdue=this._data.filter(t=>!t.done&&t.due_date<today_str);
    const due=this._data.filter(t=>!t.done&&t.due_date===today_str);
    const upcoming=this._data.filter(t=>!t.done&&t.due_date>today_str);
    const done=this._data.filter(t=>t.done);
    const html=[];
    html.push('<button class="btn btn-full btn-primary" onclick="Followups.openAdd()" style="margin-bottom:14px;">+ Add Task</button>');
    const typeIcon={call:'&#128222;',email:'&#128231;',text:'&#128172;',other:'&#128204;'};
    const renderTasks=(tasks,label,color)=>{
      if(!tasks.length)return;
      html.push('<div class="section-header" style="color:'+color+';">'+label+'</div>');
      html.push('<div class="card" style="padding:0 16px;">');
      tasks.forEach(t=>{
        html.push('<div class="list-row" onclick="Followups.openAction(\''+t.id+'\')">');
        html.push('<div style="font-size:20px;">'+(typeIcon[t.type||'other']||'&#128204;')+'</div>');
        html.push('<div class="list-main"><div class="list-name">'+t.title+'</div><div class="list-sub" style="color:'+color+';">'+fmtDateShort(t.due_date)+'</div>'+(t.outcome?'<div style="font-size:11px;color:var(--green);margin-top:2px;">&#10003; '+t.outcome+'</div>':'')+'</div>');
        html.push('<div style="font-size:20px;color:var(--faint);">&#8250;</div></div>');
      });
      html.push('</div>');
    };
    renderTasks(overdue,'Overdue','var(--red)');
    renderTasks(due,'Due Today','var(--orange)');
    renderTasks(upcoming,'Upcoming','var(--text)');
    if(done.length){
      html.push('<div class="section-header">Completed</div><div class="card" style="padding:0 16px;">');
      done.slice(0,5).forEach(t=>{html.push('<div class="list-row" style="opacity:.6;"><div style="font-size:20px;">'+(typeIcon[t.type||'other']||'&#128204;')+'</div><div class="list-main"><div class="list-name" style="text-decoration:line-through;">'+t.title+'</div></div><button class="btn btn-sm" onclick="db.tasks.delete(\''+t.id+'\').then(()=>{Followups.render();toast(\'Removed\')})">&#10005;</button></div>');});
      html.push('</div>');
    }
    if(!this._data.length)html.push('<div class="empty-state"><div class="empty-icon">&#9989;</div><div class="empty-text">No tasks yet</div></div>');
    el.innerHTML=html.join('');
  },
  openAdd(){
    const html=[];
    html.push('<div class="modal-title">New Task</div>');
    html.push('<div class="form-group"><label class="form-label">Task</label><input class="form-input" id="ft-title" placeholder="e.g. Call Carlos about tint quote" /></div>');
    html.push('<div class="form-row"><div class="form-group"><label class="form-label">Type</label><select class="form-input" id="ft-type"><option value="call">&#128222; Call</option><option value="email">&#128231; Email</option><option value="text">&#128172; Text</option><option value="other">&#128204; Other</option></select></div><div class="form-group"><label class="form-label">Due</label><input class="form-input" id="ft-due" type="date" value="'+tomorrow()+'" /></div></div>');
    html.push('<div class="modal-actions"><button class="btn btn-full btn-primary" onclick="Followups.saveTask()">Add Task</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>');
    Modal.show(html.join(''));
    setTimeout(()=>document.getElementById('ft-title')&&document.getElementById('ft-title').focus(),100);
  },
  openAction(id){
    const t=this._data.find(x=>x.id===id);if(!t)return;
    const typeIcon={call:'&#128222;',email:'&#128231;',text:'&#128172;',other:'&#128204;'};
    const typeLabel={call:'Phone Call',email:'Email',text:'Text Message',other:'Task'};
    const html=[];
    html.push('<div class="modal-title">'+t.title+'</div>');
    html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:14px;font-weight:500;">'+(typeIcon[t.type||'other']||'')+' '+(typeLabel[t.type||'other']||'Task')+' &mdash; Due '+fmtDate(t.due_date)+'</div>');
    html.push('<div class="form-group"><label class="form-label">Outcome / notes</label><textarea class="form-input" id="fa-outcome" rows="3" placeholder="What happened?..." style="resize:none;">'+(t.outcome||t.notes||'')+'</textarea></div>');
    html.push('<div class="modal-actions">');
    html.push('<button class="btn btn-full btn-green" onclick="Followups.complete(\''+t.id+'\')">&#10003; Mark Done</button>');
    html.push('<button class="btn btn-full" onclick="db.tasks.delete(\''+t.id+'\').then(()=>{Modal.close();Followups.render();toast(\'Deleted\')})">Delete</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
  },
  async complete(id){
    const t=this._data.find(x=>x.id===id);if(!t)return;
    const outcome=document.getElementById('fa-outcome')&&document.getElementById('fa-outcome').value.trim();
    await db.tasks.save(Object.assign({},t,{done:true,outcome:outcome||'Completed'}));
    Modal.close();toast('Task done &#10003;');await this.render();
  },
  async saveTask(){
    const title=document.getElementById('ft-title')&&document.getElementById('ft-title').value.trim();
    if(!title){toast('Please enter a title.','warning');return;}
    try {
      await db.tasks.save({id:genId('tk'),title,type:document.getElementById('ft-type')&&document.getElementById('ft-type').value||'call',due_date:document.getElementById('ft-due')&&document.getElementById('ft-due').value||tomorrow(),done:false,notes:''});
      Modal.close();toast('Task added');await this.render();
    } catch(e) { toast('Could not save task','error'); }
  }
};

// ── Appointments ──────────────────────────────────────────────────────────────
const Appointments = {
  _year: new Date().getFullYear(), _month: new Date().getMonth()+1, _data: [],
  async render(){
    this._data = await db.appointments.forMonth(this._year, this._month);
    const el=document.getElementById('page-appointments');
    const monthLabel=new Date(this._year,this._month-1).toLocaleString('en-US',{month:'long',year:'numeric'});
    const todayStr=today();
    const html=[];
    html.push('<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">');
    html.push('<button class="btn btn-sm" onclick="Appointments.prevMonth()">&#8249; Prev</button>');
    html.push('<div style="font-size:16px;font-weight:700;">'+monthLabel+'</div>');
    html.push('<button class="btn btn-sm" onclick="Appointments.nextMonth()">Next &#8250;</button>');
    html.push('</div>');
    html.push('<button class="btn btn-full btn-primary" onclick="Appointments.openAdd()" style="margin-bottom:14px;">+ New Appointment</button>');
    // Group by date
    const byDate={};
    this._data.forEach(a=>{if(!byDate[a.date])byDate[a.date]=[];byDate[a.date].push(a);});
    const statusColors={confirmed:'var(--green)','in-progress':'var(--orange)',pending:'var(--faint)',done:'#ccc',cancelled:'var(--red)'};
    if(!this._data.length){html.push('<div class="empty-state"><div class="empty-icon">&#128197;</div><div class="empty-text">No appointments this month</div></div>');}
    else{
      Object.entries(byDate).sort(([a],[b])=>a.localeCompare(b)).forEach(([date,appts])=>{
        const d=new Date(date+'T12:00:00');
        const isToday=date===todayStr;
        html.push('<div class="section-header" style="color:'+(isToday?'var(--accent)':'var(--text)')+';">'+( isToday?'Today — ':'')+d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})+'</div>');
        html.push('<div class="card" style="padding:0 16px;">');
        appts.forEach(a=>{
          html.push('<div class="schedule-item" onclick="Appointments.openEdit(\''+a.id+'\')">');
          html.push('<div class="schedule-time"><div>'+(a.time||'—')+'</div>'+(a.duration?'<div class="schedule-time-sub">'+a.duration+'m</div>':'')+'</div>');
          html.push('<div class="schedule-bar" style="background:'+(statusColors[a.status]||'#ccc')+'"></div>');
          html.push('<div class="schedule-info"><div class="schedule-title">'+a.title+'</div><div class="schedule-sub">'+(a.customer_name||'Walk-in')+(a.vehicle_label?' · '+a.vehicle_label:'')+(a.notes?' · '+a.notes:'')+'</div></div>');
          html.push('</div>');
        });
        html.push('</div>');
      });
    }
    el.innerHTML=html.join('');
  },
  prevMonth(){if(this._month===1){this._month=12;this._year--;}else this._month--;this.render();},
  nextMonth(){if(this._month===12){this._month=1;this._year++;}else this._month++;this.render();},
  openAdd(){this._showModal(null);},
  openEdit(id){const a=this._data.find(x=>x.id===id);if(a)this._showModal(a);},
  _showModal(a){
    const defDate=this._year+'-'+String(this._month).padStart(2,'0')+'-'+String(new Date().getDate()).padStart(2,'0');
    const html=[];
    html.push('<div class="modal-title">'+(a?'Edit Appointment':'New Appointment')+'</div>');
    html.push('<div class="form-group"><label class="form-label">Title</label><input class="form-input" id="fa-title" placeholder="e.g. Full Detail — John Smith" value="'+(a?a.title||'':'')+'" /></div>');
    html.push('<div class="form-row"><div class="form-group"><label class="form-label">Date</label><input class="form-input" id="fa-date" type="date" value="'+(a?a.date:defDate)+'" /></div><div class="form-group"><label class="form-label">Time</label><input class="form-input" id="fa-time" type="time" value="09:00" /></div></div>');
    html.push('<div class="form-row"><div class="form-group"><label class="form-label">Duration (min)</label><input class="form-input" id="fa-dur" type="number" value="'+(a?a.duration||60:60)+'" /></div><div class="form-group"><label class="form-label">Status</label><select class="form-input" id="fa-status"><option value="confirmed"'+((!a||a.status==='confirmed')?' selected':'')+'>Confirmed</option><option value="pending"'+(a&&a.status==='pending'?' selected':'')+'>Pending</option><option value="in-progress"'+(a&&a.status==='in-progress'?' selected':'')+'>In Progress</option><option value="done"'+(a&&a.status==='done'?' selected':'')+'>Done</option><option value="cancelled"'+(a&&a.status==='cancelled'?' selected':'')+'>Cancelled</option></select></div></div>');
    html.push('<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="fa-notes" placeholder="Details..." value="'+(a?a.notes||'':'')+'" /></div>');
    html.push('<div class="modal-actions">');
    if(a)html.push('<button class="btn btn-full" style="color:var(--red);" onclick="Appointments.delete(\''+a.id+'\')">Delete</button>');
    html.push('<button class="btn btn-full btn-primary" onclick="Appointments.save(\''+(a?a.id:'')+'\')">Save</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
  },
  async save(id){
    const title=document.getElementById('fa-title')&&document.getElementById('fa-title').value.trim();
    if(!title){alert('Please enter a title.');return;}
    const rawTime=document.getElementById('fa-time')&&document.getElementById('fa-time').value;
    const fmtTime=rawTime?(()=>{const[h,m]=rawTime.split(':'),hour=parseInt(h),period=hour>=12?'PM':'AM',h12=hour%12||12;return h12+':'+m+' '+period;})():'';
    await db.appointments.save({id:id||genId('a'),title,date:document.getElementById('fa-date')&&document.getElementById('fa-date').value||today(),time:fmtTime,duration:parseInt(document.getElementById('fa-dur')&&document.getElementById('fa-dur').value)||60,status:document.getElementById('fa-status')&&document.getElementById('fa-status').value||'confirmed',notes:document.getElementById('fa-notes')&&document.getElementById('fa-notes').value.trim()||''});
    Modal.close();toast(id?'Updated':'Appointment added');this.render();
  },
  async delete(id){if(!confirm('Delete?'))return;await db.appointments.delete(id);Modal.close();this.render();toast('Deleted');}
};

// ── Invoices ──────────────────────────────────────────────────────────────────
const Invoices = {
  _data: [],
  updateBadge(){
    const n=this._data.filter(i=>i.status==='unpaid').length;
    const b=document.getElementById('invoices-badge');
    if(b){if(n>0){b.textContent=n;b.classList.remove('hidden');}else b.classList.add('hidden');}
  },
  async render(){
    document.getElementById('page-invoices').innerHTML='<div class="spinner-page"><div class="spinner"></div></div>';
    this._data=await db.invoices.all();this.updateBadge();
    const el=document.getElementById('page-invoices');
    const unpaidAmt=this._data.filter(i=>i.status==='unpaid').reduce((s,i)=>s+i.total,0);
    const html=[];
    html.push('<div class="metric-grid" style="margin-bottom:14px;">');
    html.push('<div class="metric-card"><div class="metric-label">Outstanding</div><div class="metric-value" style="color:var(--red);">'+fmtMoney(unpaidAmt)+'</div></div>');
    html.push('<div class="metric-card"><div class="metric-label">Paid</div><div class="metric-value" style="color:var(--green);">'+fmtMoney(this._data.filter(i=>i.status==='paid').reduce((s,i)=>s+i.total,0))+'</div></div>');
    html.push('</div>');
    html.push('<button class="btn btn-full btn-primary" onclick="Invoices.openCreate()" style="margin-bottom:14px;">+ New Invoice</button>');
    html.push('<div class="card" style="padding:0 16px;">');
    if(!this._data.length){html.push('<div style="padding:24px;text-align:center;color:var(--faint);font-size:13px;">No invoices yet</div>');}
    else{
      this._data.forEach(i=>{
        html.push('<div class="list-row" onclick="Invoices.openView(\''+i.id+'\')">');
        html.push('<div style="text-align:center;min-width:44px;"><div style="font-size:11px;font-family:monospace;font-weight:700;color:var(--muted);">'+i.number+'</div><div style="font-size:11px;color:var(--faint);">'+fmtDateShort(i.created_at)+'</div></div>');
        html.push('<div class="list-main"><div class="list-name">'+(i.fleet_name||i.customer_name||'—')+'</div></div>');
        html.push('<div class="list-right"><div class="list-amount">'+fmtMoney(i.total)+'</div><span class="badge '+(i.status==='paid'?'badge-done':'badge-progress')+'">'+(i.status==='paid'?'Paid':'Unpaid')+'</span></div>');
        html.push('</div>');
      });
    }
    html.push('</div>');
    el.innerHTML=html.join('');
  },
  openView(id){
    const i=this._data.find(x=>x.id===id);if(!i)return;
    const lines=(i.line_items||[]).map(l=>'<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px;"><span>'+l.description+'</span><strong>'+fmtMoney(l.amount)+'</strong></div>').join('');
    const html=[];
    html.push('<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">');
    html.push('<div><div style="font-size:18px;font-weight:700;">'+i.number+'</div><div style="font-size:13px;color:var(--muted);">'+fmtDate(i.created_at)+'</div></div>');
    html.push('<span class="badge '+(i.status==='paid'?'badge-done':'badge-progress')+'" style="font-size:13px;padding:4px 12px;">'+(i.status==='paid'?'PAID':'UNPAID')+'</span></div>');
    html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px;"><strong>Bill to:</strong> '+(i.fleet_name||i.customer_name||'—')+'</div>');
    html.push(lines);
    html.push('<div style="text-align:right;margin-top:10px;"><div style="font-size:13px;color:var(--muted);">Subtotal: '+fmtMoney(i.subtotal)+'</div><div style="font-size:18px;font-weight:700;">Total: '+fmtMoney(i.total)+'</div></div>');
    if(i.notes)html.push('<div style="font-size:12px;color:var(--muted);margin-top:10px;">Notes: '+i.notes+'</div>');
    html.push('<div class="modal-actions">');
    if(i.status==='unpaid')html.push('<button class="btn btn-full btn-green" onclick="Invoices.markPaid(\''+i.id+'\')">&#10003; Mark Paid</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Close</button>');
    html.push('</div>');
    Modal.show(html.join(''));
  },
  async openCreate(){
    const customers=await db.customers.all();
    const html=[];
    html.push('<div class="modal-title">New Invoice</div>');
    html.push('<div class="form-group"><label class="form-label">Customer</label><select class="form-input" id="fi-cust"><option value="">Select customer...</option>'+customers.map(c=>'<option value="'+c.id+'">'+c.name+'</option>').join('')+'</select></div>');
    html.push('<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="fi-desc" placeholder="e.g. Full Detail" /></div>');
    html.push('<div class="form-group"><label class="form-label">Amount ($)</label><input class="form-input" id="fi-amt" type="number" placeholder="0" /></div>');
    html.push('<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="fi-notes" placeholder="Payment terms, notes..." /></div>');
    html.push('<div class="modal-actions"><button class="btn btn-full btn-primary" onclick="Invoices.create()">Create Invoice</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>');
    Modal.show(html.join(''));
  },
  async create(){
    const desc=document.getElementById('fi-desc')&&document.getElementById('fi-desc').value.trim();
    const amt=parseFloat(document.getElementById('fi-amt')&&document.getElementById('fi-amt').value)||0;
    if(!desc||!amt){alert('Please enter a description and amount.');return;}
    const custId=document.getElementById('fi-cust')&&document.getElementById('fi-cust').value;
    const inv={customer_id:custId||null,line_items:[{description:desc,amount:amt}],subtotal:amt,tax:0,tax_amount:0,total:amt,notes:document.getElementById('fi-notes')&&document.getElementById('fi-notes').value.trim()||''};
    await db.invoices.save(inv);
    Modal.close();toast('Invoice created!');await this.render();
  },
  async markPaid(id){
    await db.invoices.markPaid(id);
    Modal.close();toast('Invoice marked paid!');await this.render();
  }
};

// ── Fleet ─────────────────────────────────────────────────────────────────────
const Fleet = {
  async render(){
    const fleets=await db.fleet.all();
    const el=document.getElementById('page-fleet');
    const html=[];
    html.push('<button class="btn btn-full btn-primary" onclick="Fleet.openAdd()" style="margin-bottom:14px;">+ New Fleet Account</button>');
    html.push('<div class="card" style="padding:0 16px;">');
    if(!fleets.length){html.push('<div style="padding:24px;text-align:center;color:var(--faint);font-size:13px;">No fleet accounts yet</div>');}
    else{fleets.forEach(f=>{html.push('<div class="list-row" onclick="Fleet.openDetail(\''+f.id+'\')">');html.push('<div style="width:44px;height:44px;border-radius:50%;background:#e6f1fb;color:#0c447c;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;">'+initials(f.name)+'</div>');html.push('<div class="list-main"><div class="list-name">'+f.name+'</div><div class="list-sub">'+(f.billing_terms||'Net-30')+(f.discount_pct?' · '+f.discount_pct+'% disc':'')+'</div></div><div style="font-size:20px;color:var(--faint);">&#8250;</div></div>');});}
    html.push('</div>');
    el.innerHTML=html.join('');
  },
  async openDetail(id){
    const data=await db.fleet.get(id);if(!data)return;
    const {fleet,jobs,invoices,totalBilled,totalPaid,outstanding}=data;
    const html=[];
    html.push('<div class="modal-title">'+fleet.name+'</div>');
    html.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">');
    html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:11px;color:var(--faint);">Billed</div><div style="font-size:16px;font-weight:700;">'+fmtMoney(totalBilled)+'</div></div>');
    html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:11px;color:var(--faint);">Paid</div><div style="font-size:16px;font-weight:700;color:var(--green);">'+fmtMoney(totalPaid)+'</div></div>');
    html.push('<div style="background:'+(outstanding>0?'#fdecea':'var(--surface2)')+';border-radius:8px;padding:10px;text-align:center;"><div style="font-size:11px;color:var(--faint);">Due</div><div style="font-size:16px;font-weight:700;color:'+(outstanding>0?'var(--red)':'var(--text)')+';">'+fmtMoney(outstanding)+'</div></div>');
    html.push('</div>');
    html.push('<div style="font-size:13px;color:var(--muted);margin-bottom:12px;">'+(fleet.contact_name||'')+(fleet.phone?' &middot; '+fleet.phone:'')+'</div>');
    if(invoices.length){
      html.push('<div class="form-label" style="margin-bottom:8px;">Recent Invoices</div>');
      invoices.slice(0,4).forEach(i=>html.push('<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;"><span style="font-family:monospace;color:var(--muted);">'+i.number+'</span><span style="flex:1;">'+fmtDateShort(i.created_at)+'</span><span style="font-weight:700;">'+fmtMoney(i.total)+'</span><span class="badge '+(i.status==='paid'?'badge-done':'badge-progress')+'">'+(i.status==='paid'?'Paid':'Unpaid')+'</span></div>'));
    }
    if(jobs.length){
      html.push('<div class="form-label" style="margin:12px 0 8px;">Recent Jobs</div>');
      jobs.slice(0,4).forEach(j=>html.push('<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;"><div style="flex:1;">'+catBadge(j.category)+' '+j.service+'<div style="font-size:11px;color:var(--faint);">'+fmtDateShort(j.date)+'</div></div><div style="font-weight:700;">'+fmtMoney(j.price)+'</div></div>'));
    }
    html.push('<div class="modal-actions"><button class="btn btn-full btn-primary" onclick="Invoices.openCreate()">+ Invoice</button><button class="btn btn-full" onclick="Modal.close()">Close</button></div>');
    Modal.show(html.join(''));
  },
  openAdd(){
    const html=[];
    html.push('<div class="modal-title">New Fleet Account</div>');
    html.push('<div class="form-group"><label class="form-label">Company Name *</label><input class="form-input" id="ff-name" /></div>');
    html.push('<div class="form-row"><div class="form-group"><label class="form-label">Contact</label><input class="form-input" id="ff-contact" /></div><div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="ff-phone" type="tel" /></div></div>');
    html.push('<div class="form-row"><div class="form-group"><label class="form-label">Billing</label><select class="form-input" id="ff-terms"><option value="net-30">Net-30</option><option value="net-15">Net-15</option><option value="net-60">Net-60</option><option value="upon-receipt">Upon receipt</option></select></div><div class="form-group"><label class="form-label">Discount %</label><input class="form-input" id="ff-disc" type="number" value="0" /></div></div>');
    html.push('<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="ff-notes" /></div>');
    html.push('<div class="modal-actions"><button class="btn btn-full btn-primary" onclick="Fleet.save()">Save</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>');
    Modal.show(html.join(''));
  },
  async save(){
    const name=document.getElementById('ff-name')&&document.getElementById('ff-name').value.trim();
    if(!name){alert('Please enter a company name.');return;}
    await db.fleet.save({id:genId('f'),name,contact_name:document.getElementById('ff-contact')&&document.getElementById('ff-contact').value.trim()||'',phone:document.getElementById('ff-phone')&&document.getElementById('ff-phone').value.trim()||'',billing_terms:document.getElementById('ff-terms')&&document.getElementById('ff-terms').value||'net-30',discount_pct:parseFloat(document.getElementById('ff-disc')&&document.getElementById('ff-disc').value)||0,notes:document.getElementById('ff-notes')&&document.getElementById('ff-notes').value.trim()||''});
    Modal.close();toast('Fleet account added');this.render();
  }
};

// ── Revenue ───────────────────────────────────────────────────────────────────
const Revenue = {
  async render(){
    const el=document.getElementById('page-revenue');
    el.innerHTML='<div class="spinner-page"><div class="spinner"></div></div>';
    const data=await db.revenue.full();
    const months=[...(data.byMonth||[])].slice(-6);
    const monthMax=Math.max(...months.map(m=>m.revenue||0),1);
    const catColors={detail:'var(--green)',tint:'var(--purple)',tire:'var(--orange)'};
    const catLabels={detail:'Detailing',tint:'Window Tint',tire:'Tires'};
    const catMax=Math.max(...(data.byCategory||[]).map(r=>r.revenue||0),1);
    const html=[];
    html.push('<div class="metric-grid" style="margin-bottom:14px;">');
    html.push('<div class="metric-card"><div class="metric-label">Total Revenue</div><div class="metric-value">'+fmtMoney(data.totalRevenue||0)+'</div></div>');
    html.push('<div class="metric-card"><div class="metric-label">Total Profit</div><div class="metric-value" style="color:var(--green);">'+fmtMoney(data.totalProfit||0)+'</div></div>');
    html.push('</div>');
    html.push('<div class="section-header">Monthly Revenue</div>');
    html.push('<div class="card">');
    months.forEach(m=>{const rev=m.revenue||0;const pct=Math.round((rev/monthMax)*100);const[y,mo]=m.month.split('-');const label=new Date(y,mo-1).toLocaleString('en-US',{month:'short',year:'2-digit'});html.push('<div class="bar-row"><div class="bar-label">'+label+'</div><div class="bar-bg"><div class="bar-fill" style="width:'+pct+'%;background:var(--blue);"></div></div><div class="bar-val">'+fmtMoney(rev)+'</div></div>');});
    html.push('</div>');
    html.push('<div class="section-header">By Service Type</div>');
    html.push('<div class="card">');
    (data.byCategory||[]).sort((a,b)=>(b.revenue||0)-(a.revenue||0)).forEach(r=>{const rev=r.revenue||0;const pct=Math.round((rev/catMax)*100);html.push('<div class="bar-row"><div class="bar-label">'+( catLabels[r.category]||r.category)+'</div><div class="bar-bg"><div class="bar-fill" style="width:'+pct+'%;background:'+(catColors[r.category]||'#888')+'"></div></div><div class="bar-val">'+fmtMoney(rev)+'</div></div>');});
    html.push('</div>');
    html.push('<div class="section-header">Top Customers</div>');
    html.push('<div class="card" style="padding:0 16px;">');
    (data.byCustomer||[]).slice(0,8).forEach((c,i)=>{html.push('<div class="list-row">'+avatarEl(c.name,36)+'<div class="list-main"><div class="list-name">'+c.name+'</div></div><div class="list-amount">'+fmtMoney(c.total)+'</div></div>');});
    html.push('</div>');
    el.innerHTML=html.join('');
  }
};

// ── Settings ──────────────────────────────────────────────────────────────────
const Settings = {
  async render(){
    const s=await db.settings.get();
    const el=document.getElementById('page-settings');
    const html=[];
    html.push('<div class="section-header">Shop Info</div>');
    html.push('<div class="card">');
    html.push('<div class="form-group"><label class="form-label">Shop Name</label><input class="form-input" id="s-shopName" value="'+(s.shopName||'')+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Tagline</label><input class="form-input" id="s-tagline" value="'+(s.tagline||'')+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="s-phone" value="'+(s.phone||'')+'" type="tel" /></div>');
    html.push('<div class="form-group"><label class="form-label">Email</label><input class="form-input" id="s-email" value="'+(s.email||'')+'" type="email" /></div>');
    html.push('<div class="form-group"><label class="form-label">Address</label><input class="form-input" id="s-address" value="'+(s.address||'')+'" /></div>');
    html.push('</div>');
    html.push('<div class="section-header">Loyalty Program</div>');
    html.push('<div class="card">');
    html.push('<div class="form-group"><label class="form-label">Visits for reward</label><input class="form-input" id="s-loyaltyVisits" type="number" value="'+(s.loyaltyVisits||5)+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Reward description</label><input class="form-input" id="s-loyaltyReward" value="'+(s.loyaltyReward||'Free interior detail')+'" /></div>');
    html.push('</div>');
    html.push('<div class="section-header">Messaging (Twilio SMS)</div>');
    html.push('<div class="card">');
    html.push('<div style="background:#e6f1fb;border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:14px;">Get credentials at <strong>twilio.com</strong> → Console. ~$1/mo per number + $0.008/text.</div>');
    html.push('<div class="form-group"><label class="form-label">Account SID</label><input class="form-input" id="s-tw-sid" value="'+(s.twilio?.accountSid||'')+'" placeholder="ACxxxxxxxxxxxxxxxx" /></div>');
    html.push('<div class="form-group"><label class="form-label">Auth Token</label><input class="form-input" id="s-tw-token" type="password" value="'+(s.twilio?.authToken||'')+'" placeholder="Your auth token" /></div>');
    html.push('<div class="form-group"><label class="form-label">From number</label><input class="form-input" id="s-tw-from" value="'+(s.twilio?.fromNumber||'')+'" placeholder="+15055551234" /></div>');
    html.push('</div>');
    html.push('<div class="section-header">Email</div>');
    html.push('<div class="card">');
    html.push('<div class="form-group"><label class="form-label">Email address</label><input class="form-input" id="s-email-user" value="'+(s.emailConfig?.user||'')+'" type="email" placeholder="yourshop@gmail.com" /></div>');
    html.push('<div class="form-group"><label class="form-label">App password</label><input class="form-input" id="s-email-pass" type="password" value="'+(s.emailConfig?.pass||'')+'" /></div>');
    html.push('<div style="font-size:11px;color:var(--faint);">Use a Gmail App Password, not your regular password.</div>');
    html.push('</div>');
    html.push('<button class="btn btn-full btn-primary" onclick="Settings.save()" style="margin-top:4px;">Save Settings</button>');
    el.innerHTML=html.join('');
  },
  async save(){
    const fields=['shopName','tagline','phone','email','address','loyaltyVisits','loyaltyReward'];
    const data={};
    fields.forEach(f=>{const el=document.getElementById('s-'+f);if(el)data[f]=el.value.trim();});
    // Twilio
    const twSid = document.getElementById('s-tw-sid')?.value.trim();
    const twToken = document.getElementById('s-tw-token')?.value;
    const twFrom = document.getElementById('s-tw-from')?.value.trim();
    if (twSid||twToken||twFrom) data.twilio = { accountSid:twSid, authToken:twToken, fromNumber:twFrom };
    // Email
    const emUser = document.getElementById('s-email-user')?.value.trim();
    const emPass = document.getElementById('s-email-pass')?.value;
    if (emUser||emPass) data.emailConfig = { provider:'gmail', user:emUser, pass:emPass, fromName:data.shopName||'' };
    await db.settings.save(data);
    const n=document.getElementById('drawer-shop-name');if(n)n.textContent=data.shopName||'Woods Test CRM';
    const topTitle=document.getElementById('topbar-title');if(topTitle)topTitle.textContent=data.shopName||'Woods Test CRM';
    toast('Settings saved!');
  }
};

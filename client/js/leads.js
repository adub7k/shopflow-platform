const Leads = {
  _data: [],
  _filter: '',
  _loading: false,

  async load() {
    try {
      this._data = await db.leads.all();
      this.updateBadge();
    } catch(e) {
      toast('Could not load leads', 'error');
      this._data = [];
    }
  },

  updateBadge() {
    const n = this._data.filter(l => l.status === 'new').length;
    const b = document.getElementById('leads-badge');
    if (b) { if(n>0){b.textContent=n;b.classList.remove('hidden');}else b.classList.add('hidden'); }
  },

  async render() {
    const el = document.getElementById('page-leads');
    el.innerHTML = '<div class="spinner-page"><div class="spinner"></div></div>';
    await this.load();

    const stages = [
      {key:'new',label:'New',color:'#e74c3c',bg:'#fdecea'},
      {key:'contacted',label:'Contacted',color:'#EF9F27',bg:'#fff3e0'},
      {key:'appointment-set',label:'Appt Set',color:'#378ADD',bg:'#e6f1fb'},
      {key:'no-show',label:'No Show',color:'#9a9a9a',bg:'#f5f4f1'},
      {key:'closed',label:'Closed',color:'#1D9E75',bg:'#eaf3de'},
      {key:'lost',label:'Lost',color:'#bbb',bg:'#f5f4f1'},
    ];
    const counts = {};
    stages.forEach(s => counts[s.key] = 0);
    this._data.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });
    const total = this._data.length;
    const closeRate = total > 0 ? Math.round((counts.closed / total) * 100) : 0;

    const html = [];

    // Source log buttons
    html.push('<div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:14px;scrollbar-width:none;">');
    [['walk-in','&#128222; Walk-in','#f5f4f1'],['instagram','&#128248; Instagram','#fce4ec'],
     ['google','&#128269; Google','#e8f5e9'],['referral','&#129309; Referral','#ede7f6'],
     ['facebook','&#128241; Facebook','#e3f2fd']].forEach(function([s,label,bg]) {
      html.push('<button class="btn btn-sm" onclick="Leads.openQuickAdd(\''+s+'\')" style="background:'+bg+';white-space:nowrap;flex-shrink:0;">'+label+'</button>');
    });
    html.push('</div>');

    // Pipeline cards
    html.push('<div class="pipeline-grid">');
    stages.forEach(function(s) {
      const active = Leads._filter === s.key;
      html.push('<div class="pipeline-card" onclick="Leads.setFilter(\''+s.key+'\')" style="background:'+(active?s.color:s.bg)+';border-color:'+(active?s.color:'transparent')+';">');
      html.push('<div class="pipeline-card-num" style="color:'+(active?'#fff':s.color)+'">'+(counts[s.key]||0)+'</div>');
      html.push('<div class="pipeline-card-label" style="color:'+(active?'#fff':'#666')+'">'+s.label+'</div>');
      html.push('</div>');
    });
    // Close rate card
    const crActive = Leads._filter === '';
    html.push('<div class="pipeline-card" onclick="Leads.setFilter(\'\')" style="background:'+(crActive?'#1a1a1a':'#f5f4f1')+';border-color:'+(crActive?'#1a1a1a':'transparent')+';">');
    html.push('<div class="pipeline-card-num" style="color:'+(crActive?'#fff':'#1a1a1a')+'">'+closeRate+'%</div>');
    html.push('<div class="pipeline-card-label" style="color:'+(crActive?'#ddd':'#666')+'">Close Rate</div>');
    html.push('</div></div>');

    if (this._filter) {
      const stage = stages.find(s => s.key === Leads._filter);
      html.push('<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">');
      html.push('<span style="font-size:13px;font-weight:600;color:'+(stage?stage.color:'#888')+';">'+(stage?stage.label:Leads._filter)+' leads</span>');
      html.push('<button class="btn btn-sm" onclick="Leads.setFilter(\'\')">Clear &#10005;</button></div>');
    }

    html.push('<div class="card" style="padding:0 16px;" id="leads-list"></div>');
    el.innerHTML = html.join('');
    this.renderList();
  },

  setFilter(s) { this._filter = s; this.render(); },

  renderList() {
    const filtered = this._data.filter(l => !Leads._filter || l.status === Leads._filter);
    const el = document.getElementById('leads-list');
    if (!el) return;
    if (!filtered.length) {
      el.innerHTML = '<div style="padding:32px 0;text-align:center;"><div style="font-size:32px;margin-bottom:8px;">&#128203;</div><div style="font-size:14px;color:var(--muted);">'+(Leads._filter?'No '+Leads._filter+' leads':'No leads yet — tap a source above to log one')+'</div></div>';
      return;
    }
    const stageColors = {'new':'#e74c3c','contacted':'#EF9F27','appointment-set':'#378ADD','no-show':'#9a9a9a','closed':'#1D9E75','lost':'#bbb'};
    const stageLabels = {'new':'New','contacted':'Contacted','appointment-set':'Appt Set','no-show':'No Show','closed':'Closed','lost':'Lost'};
    const html = [];
    filtered.forEach(function(l) {
      const color = stageColors[l.status] || '#888';
      const label = stageLabels[l.status] || l.status;
      html.push('<div class="list-row" onclick="Leads.openDetail(\''+l.id+'\')">');
      html.push(avatarEl(l.name, 40));
      html.push('<div class="list-main">');
      html.push('<div class="list-name">'+l.name+'</div>');
      html.push('<div class="list-sub">'+sourceBadge(l.source)+(l.interest?' &middot; '+l.interest:'')+'</div>');
      if (l.phone) html.push('<div style="font-size:11px;color:var(--faint);margin-top:1px;">'+l.phone+'</div>');
      html.push('</div>');
      html.push('<div class="list-right"><span class="badge" style="background:'+color+'22;color:'+color+';font-weight:600;">'+label+'</span>');
      if (l.follow_up_at) html.push('<div style="font-size:10px;color:var(--faint);margin-top:3px;">'+fmtDateShort(l.follow_up_at)+'</div>');
      html.push('</div></div>');
    });
    el.innerHTML = html.join('');
  },

  openDetail(id) {
    const l = this._data.find(x => x.id === id);
    if (!l) return;
    const stages = [
      {key:'new',label:'New',color:'#e74c3c'},
      {key:'contacted',label:'Contacted',color:'#EF9F27'},
      {key:'appointment-set',label:'Appt Set',color:'#378ADD'},
      {key:'no-show',label:'No Show',color:'#9a9a9a'},
      {key:'closed',label:'Closed',color:'#1D9E75'},
      {key:'lost',label:'Lost',color:'#bbb'},
    ];
    const nextStage  = {'new':'contacted','contacted':'appointment-set','appointment-set':'closed','no-show':'contacted'};
    const nextLabel  = {'new':'Mark Contacted','contacted':'Set Appointment','appointment-set':'Close Lead','no-show':'Re-contact'};
    const curIdx = stages.findIndex(s => s.key === l.status);

    const html = [];
    html.push('<div class="modal-title">'+l.name+'</div>');

    // Pipeline stepper
    html.push('<div class="stepper" style="margin-bottom:20px;">');
    stages.forEach(function(s, i) {
      const active = l.status === s.key;
      const past = i < curIdx;
      html.push('<div class="step-item">');
      html.push('<div class="step-pill" onclick="Leads.advance(\''+l.id+'\',\''+s.key+'\')" style="background:'+(active?s.color:past?s.color+'33':'#f5f4f1')+';color:'+(active?'#fff':past?s.color:'#888')+';border-color:'+(active?s.color:past?s.color:'transparent')+';">'+(past?'&#10003; ':'')+s.label+'</div>');
      if (i < stages.length-1) html.push('<div class="step-connector"></div>');
      html.push('</div>');
    });
    html.push('</div>');

    // Info grid
    html.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">');
    html.push('<div><div class="form-label">Phone</div><div style="font-size:15px;font-weight:600;">'+(l.phone||'—')+'</div></div>');
    html.push('<div><div class="form-label">Email</div><div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;">'+(l.email||'—')+'</div></div>');
    html.push('<div><div class="form-label">Source</div>'+sourceBadge(l.source)+'</div>');
    html.push('<div><div class="form-label">Interest</div><div style="font-size:13px;">'+(l.interest||'—')+'</div></div>');
    html.push('<div><div class="form-label">Follow-up</div><div style="font-size:13px;font-weight:500;">'+(l.follow_up_at?fmtDateShort(l.follow_up_at):'—')+'</div></div>');
    html.push('<div><div class="form-label">Added</div><div style="font-size:13px;">'+fmtDateShort(l.created_at)+'</div></div>');
    html.push('</div>');
    if (l.notes) html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--muted);margin-bottom:14px;">'+l.notes+'</div>');

    // Action buttons
    html.push('<div class="modal-actions">');
    if (nextStage[l.status]) {
      const ns = stages.find(s => s.key === nextStage[l.status]);
      html.push('<button id="lead-advance-btn" class="btn btn-full" style="background:'+(ns?ns.color:'#888')+';color:#fff;border-color:'+(ns?ns.color:'#888')+';" onclick="Leads.advance(\''+l.id+'\',\''+nextStage[l.status]+'\')">'+nextLabel[l.status]+'</button>');
    }
    if (l.status === 'appointment-set') html.push('<button class="btn btn-full" style="border-color:#9a9a9a;color:#666;" onclick="Leads.advance(\''+l.id+'\',\'no-show\')">&#128693; No Show</button>');
    if (l.status === 'closed') html.push('<button class="btn btn-full btn-green" onclick="Leads.convertToCustomer(\''+l.id+'\')">&#8594; Convert to Customer</button>');
    if (l.status !== 'closed' && l.status !== 'lost') html.push('<button class="btn btn-full" style="color:var(--red);border-color:var(--red);" onclick="Leads.advance(\''+l.id+'\',\'lost\')">Mark Lost</button>');
    html.push('<button class="btn btn-full" onclick="Leads.openEdit(\''+l.id+'\')">&#9998; Edit</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Close</button>');
    html.push('</div>');
    Modal.show(html.join(''));
  },

  openQuickAdd(source) {
    const sourceLabels = {'walk-in':'Walk-in / Phone call','instagram':'Instagram DM','facebook':'Facebook','google':'Google','referral':'Referral','website':'Website'};
    const html = [];
    html.push('<div class="modal-title">Log Lead</div>');
    html.push('<div style="margin-bottom:14px;">'+sourceBadge(source)+' <span style="font-size:13px;color:var(--muted);">'+( sourceLabels[source]||source)+'</span></div>');
    html.push('<div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fl-name" placeholder="Customer name" autocomplete="name" /></div>');
    html.push('<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="fl-phone" placeholder="(505) 555-0000" type="tel" autocomplete="tel" /></div>');
    html.push('<div class="form-group"><label class="form-label">Interested in</label><input class="form-input" id="fl-interest" placeholder="e.g. Ceramic tint, full detail..." /></div>');
    html.push('<div class="form-group"><label class="form-label">Follow-up date</label><input class="form-input" id="fl-followup" type="date" value="'+tomorrow()+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="fl-notes" placeholder="Any details..." /></div>');
    html.push('<div class="modal-actions">');
    html.push('<button id="fl-save-btn" class="btn btn-full btn-primary" onclick="Leads.save(\'\',\''+source+'\')">Log Lead + Create Task</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
    setTimeout(function(){ const n=document.getElementById('fl-name');if(n)n.focus(); }, 150);
  },

  openEdit(id) {
    const l = this._data.find(x => x.id === id);
    if (!l) return;
    const html = [];
    html.push('<div class="modal-title">Edit Lead</div>');
    html.push('<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="fl-name" value="'+l.name+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="fl-phone" value="'+(l.phone||'')+'" type="tel" /></div>');
    html.push('<div class="form-group"><label class="form-label">Email</label><input class="form-input" id="fl-email" value="'+(l.email||'')+'" type="email" /></div>');
    html.push('<div class="form-group"><label class="form-label">Interest</label><input class="form-input" id="fl-interest" value="'+(l.interest||'')+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Stage</label><select class="form-input" id="fl-status">');
    [['new','New'],['contacted','Contacted'],['appointment-set','Appt Set'],['no-show','No Show'],['closed','Closed'],['lost','Lost']].forEach(function([v,lb]){
      html.push('<option value="'+v+'"'+(l.status===v?' selected':'')+'>'+lb+'</option>');
    });
    html.push('</select></div>');
    html.push('<div class="form-group"><label class="form-label">Follow-up</label><input class="form-input" id="fl-followup" type="date" value="'+(l.follow_up_at||'')+'" /></div>');
    html.push('<div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="fl-notes">'+(l.notes||'')+'</textarea></div>');
    html.push('<div class="modal-actions">');
    html.push('<button id="fl-save-btn" class="btn btn-full btn-primary" onclick="Leads.save(\''+l.id+'\',\''+l.source+'\')">Save</button>');
    html.push('<button class="btn btn-full" style="color:var(--red);" onclick="Leads.delete(\''+l.id+'\')">Delete Lead</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
  },

  async advance(id, newStatus) {
    const l = this._data.find(x => x.id === id);
    if (!l) return;
    const btn = document.getElementById('lead-advance-btn');
    if (btn) disableBtn(btn);
    try {
      const updated = Object.assign({}, l, {
        status: newStatus,
        follow_up_at: newStatus === 'appointment-set' ? tomorrow() : l.follow_up_at,
      });
      await db.leads.save(updated);
      if (newStatus === 'no-show') {
        await db.tasks.save({
          id: genId('tk'), title: 'Re-contact '+l.name+' — no-show follow-up',
          type: 'call', related_type: 'lead', related_id: l.id,
          due_date: tomorrow(), done: false, notes: 'Did not show for appointment',
        });
      }
      const labels = {contacted:'Contacted ✓','appointment-set':'Appointment set!',closed:'Lead closed!',lost:'Marked lost','no-show':'No-show — task created'};
      toast(labels[newStatus] || 'Updated');
      Modal.close();
      await this.render();
      App.refreshDashboard();
    } catch(e) {
      toast('Could not update lead — try again', 'error');
      if (btn) enableBtn(btn);
    }
  },

  async save(id, source) {
    const name = (document.getElementById('fl-name')?.value||'').trim();
    if (!name) { toast('Please enter a name', 'warning'); return; }
    const btn = document.getElementById('fl-save-btn');
    disableBtn(btn);
    try {
      const lead = {
        id: id || genId('l'),
        name,
        phone: (document.getElementById('fl-phone')?.value||'').trim(),
        email: (document.getElementById('fl-email')?.value||'').trim(),
        source: source || 'walk-in',
        interest: (document.getElementById('fl-interest')?.value||'').trim(),
        status: document.getElementById('fl-status')?.value || 'new',
        notes: (document.getElementById('fl-notes')?.value||'').trim(),
        follow_up_at: document.getElementById('fl-followup')?.value || tomorrow(),
        created_at: id ? (this._data.find(x=>x.id===id)?.created_at || today()) : today(),
      };
      await db.leads.save(lead);
      if (!id) {
        await db.tasks.save({
          id: genId('tk'),
          title: 'Follow up: '+name+' ('+source+' lead)'+(lead.interest?' — '+lead.interest:''),
          type: 'call', related_type: 'lead', related_id: lead.id,
          due_date: lead.follow_up_at, done: false, notes: '',
        });
      }
      Modal.close();
      toast(id ? 'Lead updated' : 'Lead logged! Task created.');
      await this.render();
      App.refreshDashboard();
    } catch(e) {
      toast('Could not save — check connection', 'error');
      enableBtn(btn);
    }
  },

  async convertToCustomer(id) {
    if (!confirm('Convert this lead to a customer?')) return;
    try {
      await db.leads.convert(id);
      Modal.close();
      toast('Converted to customer!');
      await this.render();
    } catch(e) {
      toast('Could not convert — try again', 'error');
    }
  },

  async delete(id) {
    if (!confirm('Delete this lead?')) return;
    try {
      await db.leads.delete(id);
      Modal.close();
      await this.render();
      toast('Lead deleted');
    } catch(e) {
      toast('Could not delete', 'error');
    }
  },
};

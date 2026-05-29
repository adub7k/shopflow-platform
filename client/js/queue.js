const Queue = {
  _data: [],
  _barbers: [],
  _services: [],

  async load() {
    [this._data, this._barbers, this._services] = await Promise.all([db.queue.all(), db.barbers.all(), db.services.all()]);
  },

  async render() {
    showSpinner('page-queue');
    try {
      await this.load();
      const el = document.getElementById('page-queue');
      const waiting   = this._data.filter(q=>q.status==='waiting');
      const inChair   = this._data.filter(q=>q.status==='in-chair');
      const html = [];

      html.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">');
      html.push('<div><div style="font-size:18px;font-weight:700;">Walk-in Queue</div><div style="font-size:12px;color:var(--muted);">'+waiting.length+' waiting &middot; '+inChair.length+' in chair</div></div>');
      html.push('<button class="btn btn-primary" onclick="Queue.openCheckIn()">+ Check In</button>');
      html.push('</div>');

      // Barber chairs
      html.push('<div style="display:grid;grid-template-columns:repeat('+this._barbers.length+',1fr);gap:10px;margin-bottom:16px;">');
      this._barbers.forEach(b => {
        const current = inChair.find(q=>q.barberId===b.id);
        html.push('<div class="card" style="border-top:4px solid '+b.color+';padding:14px;">');
        html.push('<div style="font-size:14px;font-weight:700;margin-bottom:8px;">&#9986; '+b.name+'<span style="font-size:11px;color:var(--muted);font-weight:400;"> &middot; Chair '+b.chair+'</span></div>');
        if (current) {
          html.push('<div style="background:#eaf3de;border-radius:8px;padding:10px;margin-bottom:8px;">');
          html.push('<div style="font-size:12px;font-weight:700;color:#27500a;">IN CHAIR</div>');
          html.push('<div style="font-size:14px;font-weight:600;margin-top:2px;">'+current.customerName+'</div>');
          html.push('<div style="font-size:12px;color:var(--muted);">'+current.service+'</div>');
          html.push('<div style="font-size:11px;color:var(--faint);margin-top:4px;">'+waitTime(current.startedAt)+' in chair</div>');
          html.push('<button class="btn btn-full" style="margin-top:8px;background:#1D9E75;color:#fff;border-color:#1D9E75;" onclick="Queue.openComplete(\''+current.id+'\')">&#10003; Done — Log Service</button>');
          html.push('</div>');
        } else {
          html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;color:var(--faint);font-size:13px;margin-bottom:8px;">Available</div>');
          if (waiting.length) {
            const next = waiting[0];
            html.push('<button class="btn btn-full" style="background:'+b.color+';color:#fff;border-color:'+b.color+';" onclick="Queue.callNext(\''+next.id+'\',\''+b.id+'\',\''+b.name+'\')">Call Next &#8594;</button>');
          }
        }
        html.push('</div>');
      });
      html.push('</div>');

      // Waiting list
      if (waiting.length) {
        html.push('<div class="section-header">Waiting ('+waiting.length+')</div>');
        html.push('<div class="card" style="padding:0 16px;">');
        waiting.forEach((q,i) => {
          html.push('<div class="list-row">');
          html.push('<div style="width:28px;height:28px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;">'+(i+1)+'</div>');
          html.push(avatarEl(q.customerName,38));
          html.push('<div class="list-main"><div class="list-name">'+q.customerName+(q.customerPhone?' <span style="font-size:11px;color:var(--faint);">'+q.customerPhone+'</span>':'')+'</div><div class="list-sub">'+q.service+(q.notes?' &middot; '+q.notes:'')+'</div></div>');
          html.push('<div class="list-right"><div style="font-size:12px;color:var(--muted);">'+waitTime(q.checkedInAt)+'</div>');
          html.push('<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">');
          if (q.customerId) html.push('<button class="btn btn-sm" style="font-size:11px;" onclick="Queue.viewClient(\''+q.customerId+'\')">&#128100;</button>');
          this._barbers.forEach(b => {
            if (!inChair.find(x=>x.barberId===b.id)) {
              html.push('<button class="btn btn-sm" style="background:'+b.color+'22;border-color:'+b.color+';color:'+b.color+';font-size:11px;" onclick="Queue.callNext(\''+q.id+'\',\''+b.id+'\',\''+b.name+'\')">'+b.name+'</button>');
            }
          });
          html.push('<button class="btn btn-sm btn-danger" onclick="Queue.remove(\''+q.id+'\')">&#10005;</button>');
          html.push('</div></div></div>');
        });
        html.push('</div>');
      } else {
        html.push('<div class="card"><div style="text-align:center;padding:24px;color:var(--faint);"><div style="font-size:28px;margin-bottom:8px;">&#127937;</div><div>Nobody waiting — all clear!</div></div></div>');
      }

      el.innerHTML = html.join('');
    } catch(e) {
      document.getElementById('page-queue').innerHTML = '<div class="error-banner">Could not load queue</div>';
    }
  },

  openCheckIn() {
    const barberOpts = this._barbers.map(b=>'<option value="'+b.id+'|'+b.name+'">'+b.name+'</option>').join('');
    const serviceOpts = this._services.map(s=>'<option value="'+s.name+'|'+s.price+'">'+s.name+' — '+fmtMoney(s.price)+'</option>').join('');
    const html = [];
    html.push('<div class="modal-title">&#9986; Check In</div>');
    html.push('<div class="form-group"><label class="form-label">Name</label><div class="autocomplete-wrap"><input class="form-input" id="qi-name" placeholder="Search or type name..." /><div class="autocomplete-list" id="qi-name-list"></div></div><input type="hidden" id="qi-cust-id" /></div>');
    html.push('<div class="form-group"><label class="form-label">Service</label><select class="form-input" id="qi-service">'+serviceOpts+'</select></div>');
    html.push('<div class="form-group"><label class="form-label">Barber preference</label><select class="form-input" id="qi-barber"><option value="|">No preference</option>'+barberOpts+'</select></div>');
    html.push('<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="qi-notes" placeholder="e.g. Wants design on the side" /></div>');
    html.push('<div class="modal-actions">');
    html.push('<button id="qi-btn" class="btn btn-full btn-primary" onclick="Queue.checkIn()">Add to Queue</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
    setTimeout(()=>{
      makeAutocomplete('qi-name','qi-name-list',(id,name)=>{document.getElementById('qi-name').value=name;document.getElementById('qi-cust-id').value=id;});
      document.getElementById('qi-name')?.focus();
    },100);
  },

  async checkIn() {
    const name = document.getElementById('qi-name')?.value.trim();
    if (!name) { toast('Please enter a name','warning'); return; }
    const custId = document.getElementById('qi-cust-id')?.value||null;
    const svcVal = document.getElementById('qi-service')?.value||'';
    const [service,price] = svcVal.split('|');
    const barberVal = document.getElementById('qi-barber')?.value||'|';
    const [barberId,barberName] = barberVal.split('|');
    const btn = document.getElementById('qi-btn'); disableBtn(btn);
    try {
      await db.queue.add({ id:genId('q'), customerId:custId||null, customerName:name, barberId:barberId||null, barberName:barberName||null, service:service||'Haircut', price:Number(price)||35, status:'waiting', checkedInAt:new Date().toISOString(), notes:document.getElementById('qi-notes')?.value.trim()||'' });

      // Fire booking confirmation automation
      const waiting = (await db.queue.all()).filter(q=>q.status==='waiting').length;
      const avgWait = 35;
      await Automations.fire('checkin', {
        customerId: custId||null,
        customerName: name,
        phone: (await db.customers.search(name).catch(()=>[]))[0]?.phone || null,
        barberName: barberName||null,
        service: service||'Haircut',
        position: waiting,
        waitMins: Math.max(0,(waiting-1)*avgWait),
      });

      Modal.close(); toast(name+' added to queue &#10003;');
      await this.render(); App.refreshDashboard();
    } catch(e) { toast('Could not check in','error'); enableBtn(btn); }
  },

  async callNext(queueId, barberId, barberName) {
    try {
      const q = this._data.find(x=>x.id===queueId);
      if (q) { q.barberId=barberId; q.barberName=barberName; await db.queue.add(q); }
      await db.queue.start(queueId);
      toast('Called to chair &#9986;');
      await this.render(); App.refreshDashboard();
    } catch(e) { toast('Error calling next','error'); }
  },

  async viewClient(customerId) {
    try {
      const data = await db.customers.get(customerId);
      if (!data) { toast('Client not found','warning'); return; }
      const c = data.customer;
      const html = [];
      html.push('<div class="modal-title">&#128100; '+c.name+'</div>');
      // Stats
      html.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">');
      html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);">Visits</div><div style="font-size:22px;font-weight:800;">'+data.totalVisits+'</div></div>');
      html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);">Spent</div><div style="font-size:18px;font-weight:800;color:var(--green);">'+fmtMoney(data.totalRevenue)+'</div></div>');
      html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);">Loyalty</div><div style="font-size:22px;font-weight:800;color:'+(data.rewardReady?'var(--green)':'var(--text)')+';">'+data.loyaltyPoints+'/'+data.visitsForReward+'</div></div>');
      html.push('</div>');
      // Phone
      if (c.phone) html.push('<div style="font-size:13px;color:var(--muted);margin-bottom:8px;">&#128222; '+c.phone+'</div>');
      // Notes
      if (c.notes) html.push('<div style="background:var(--surface2);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px;">'+c.notes+'</div>');
      // Recent visits
      if (data.jobs && data.jobs.length) {
        html.push('<div style="font-size:11px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Recent Visits</div>');
        data.jobs.filter(j=>j.status==='done').slice(0,4).forEach(j=>{
          html.push('<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;">');
          html.push('<div>'+j.service+'<div style="font-size:11px;color:var(--faint);">'+fmtDateShort(j.date)+(j.barberName?' &middot; '+j.barberName:'')+'</div></div>');
          html.push('<div style="font-weight:700;">'+fmtMoney(j.price)+'</div>');
          html.push('</div>');
        });
      }
      html.push('<div class="modal-actions"><button class="btn btn-full" onclick="Modal.close()">Close</button></div>');
      Modal.show(html.join(''));
    } catch(e) { toast('Could not load client','error'); }
  },

  openComplete(queueId) {
    const q = this._data.find(x=>x.id===queueId);
    if (!q) return;
    const html = [];
    html.push('<div class="modal-title">&#10003; Done — Log Service</div>');
    html.push('<div style="background:var(--surface2);border-radius:8px;padding:12px 14px;margin-bottom:18px;">');
    html.push('<div style="font-size:15px;font-weight:700;">'+q.customerName+'</div>');
    html.push('<div style="font-size:13px;color:var(--muted);margin-top:2px;">'+q.service+'</div>');
    html.push('</div>');
    // Big price input — most important field
    html.push('<div class="form-group">');
    html.push('<label class="form-label">Amount charged</label>');
    html.push('<div style="position:relative;">');
    html.push('<div style="position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:24px;font-weight:700;color:var(--green);">$</div>');
    html.push('<input class="form-input" id="qc-price" type="number" value="'+q.price+'" style="font-size:28px;font-weight:700;padding-left:40px;color:var(--green);" />');
    html.push('</div>');
    html.push('</div>');
    // Quick price buttons
    html.push('<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">');
    [20,25,30,35,40,45,50].forEach(function(p) {
      html.push('<button class="btn btn-sm" onclick="document.getElementById(\'qc-price\').value='+p+';document.getElementById(\'qc-price\').style.color=\'var(--green)\';">$'+p+'</button>');
    });
    html.push('</div>');
    html.push('<div class="form-group"><label class="form-label">Service category</label>');
    html.push('<select class="form-input" id="qc-cat">');
    [['cut','Haircut'],['beard','Beard'],['combo','Combo'],['color','Color'],['design','Design']].forEach(function(o){html.push('<option value="'+o[0]+'">'+o[1]+'</option>');});
    html.push('</select></div>');
    html.push('<div class="modal-actions">');
    html.push('<button id="qc-btn" class="btn btn-full btn-green" onclick="Queue.complete(\''+queueId+'\')">&#10003; Log Service</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
    // Auto-focus price input
    setTimeout(function(){ document.getElementById('qc-price')?.select(); }, 150);
  },

  async complete(queueId) {
    const price = parseFloat(document.getElementById('qc-price')?.value)||0;
    const category = document.getElementById('qc-cat')?.value||'cut';
    const btn = document.getElementById('qc-btn'); disableBtn(btn);
    try {
      const q = this._data.find(x=>x.id===queueId);
      await db.queue.complete(queueId, { price, category });

      // Schedule post-service automations
      if (q) {
        const ctx = {
          customerId: q.customerId,
          customerName: q.customerName,
          phone: q.customerPhone || null,
          barberName: q.barberName,
          service: q.service,
        };
        // 48hr review request
        await Automations.schedule('hours_after', ctx, 48);
        // 14 day re-book
        await Automations.schedule('days_after', ctx, 14 * 24);
        // 30 day win-back
        await Automations.schedule('days_after', ctx, 30 * 24);
      }

      Modal.close();
      toast('Logged &#10003; Loyalty point awarded!');
      await this.render(); App.refreshDashboard();
    } catch(e) { toast('Error completing','error'); enableBtn(btn); }
  },

  async remove(id) {
    if (!confirm('Remove from queue?')) return;
    await db.queue.remove(id);
    await this.render(); toast('Removed from queue');
  },
};

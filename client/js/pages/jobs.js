// ── Jobs (cleaning module) ───────────────────────────────────────────────────
// A cleaning "job" is a normal appointment with property + crew context. This is
// an operational board over the same appointments[] collection the calendar uses,
// so revenue/loyalty/reminders all apply — it just presents them crew-first.
const Jobs = {
  _appts: [], _properties: [], _crews: [], _customers: [], _services: [],

  async render() {
    const el = document.getElementById('page-jobs'); if (!el) return;
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading…</p></div>';
    try {
      const [appts, properties, crews, customers, services] = await Promise.all([
        db.appointments.all(), db.properties.all().catch(()=>[]), db.crews.all().catch(()=>[]),
        db.customers.all().catch(()=>[]), db.services.all().catch(()=>[]),
      ]);
      this._appts=appts||[]; this._properties=properties||[]; this._crews=crews||[]; this._customers=customers||[]; this._services=services||[];
      const crewName=(id)=>(this._crews.find(c=>c.id===id)||{}).name||'';
      const addr=(a)=>{ const p=this._properties.find(x=>x.id===a.propertyId); return (a.customFields&&a.customFields.serviceAddress)||(p&&(p.label||p.address))||''; };
      const TERMINAL=['done','no-show','cancelled','canceled'];
      const t=today();
      const live=this._appts.filter(a=>!TERMINAL.includes(a.status)).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
      const doneRecent=this._appts.filter(a=>TERMINAL.includes(a.status)).sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time)).slice(0,10);

      const statusSel=(a)=>'<select class="form-input" style="padding:4px 8px;font-size:12px;width:auto;" onchange="Jobs.setStatus(\''+a.id+'\',this.value)">'
        + (Shop.statuses||[]).map(s=>'<option value="'+s.key+'"'+(a.status===s.key?' selected':'')+'>'+esc(s.label)+'</option>').join('')
        + '</select>';
      const row=(a)=>'<div class="list-row"><div class="list-main">'
        + '<div class="list-name">'+esc(a.customerName||'Job')+(a.source==='recurring'?' <span class="badge badge-gray">🔁</span>':'')+'</div>'
        + '<div class="list-sub">'+esc(a.service||'')+(addr(a)?' · '+esc(addr(a)):'')+'</div>'
        + '<div style="font-size:12px;color:var(--muted);margin-top:3px;">'+fmtDateFull(a.date)+' '+esc(a.time||'')+(crewName(a.crewId)?' · 👥 '+esc(crewName(a.crewId)):'')+' · '+fmtMoney(a.price)+'</div>'
        + '</div><div class="list-right">'+statusSel(a)+'</div></div>';

      const html=[];
      html.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><div class="section-header" style="margin:0;">Jobs</div><button class="btn btn-green btn-sm" onclick="Jobs.create()">+ New Job</button></div>');
      const todays=live.filter(a=>a.date===t), upcoming=live.filter(a=>a.date>t), overdue=live.filter(a=>a.date<t);
      if (!live.length && !doneRecent.length) {
        html.push('<div class="card empty-state"><div class="empty-icon">🧹</div><div class="empty-text">No jobs yet. Create one, or set up a recurring service.</div></div>');
      }
      const group=(title,arr)=>{ if(!arr.length)return; html.push('<div class="section-header">'+title+' ('+arr.length+')</div><div class="list-card">'+arr.map(row).join('')+'</div>'); };
      group('Overdue',overdue); group('Today',todays); group('Upcoming',upcoming); group('Recently completed',doneRecent);
      el.innerHTML=html.join('');
    } catch(e){ el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load jobs</p></div>'; }
  },

  async setStatus(id, status) {
    try { await db.appointments.save({ id, status }); toast('Status updated ✓'); this.render(); }
    catch(e){ toast(e.message||'Could not update','error'); }
  },

  create() {
    const sel=(list,fmt)=>list.map(o=>'<option value="'+o.id+'">'+esc(fmt(o))+'</option>').join('');
    Modal.show('<div class="modal-title">New Job</div>'
      + '<div class="form-group"><label class="form-label">Customer</label><select class="form-input" id="job-customerId"><option value="">— Select —</option>'+sel(this._customers,c=>c.name)+'</select></div>'
      + '<div class="form-group"><label class="form-label">Property</label><select class="form-input" id="job-propertyId"><option value="">— Optional —</option>'+sel(this._properties,p=>(p.label||p.address))+'</select></div>'
      + '<div class="form-group"><label class="form-label">Service</label><select class="form-input" id="job-serviceId" onchange="Jobs._fillPrice()"><option value="">— Select —</option>'+sel(this._services,s=>s.name+' ('+fmtMoney(s.price)+')')+'</select></div>'
      + '<div class="form-group"><label class="form-label">Crew</label><select class="form-input" id="job-crewId"><option value="">— Unassigned —</option>'+sel(this._crews,c=>c.name)+'</select></div>'
      + '<div class="form-row">'
      +   '<div class="form-group"><label class="form-label">Date</label><input class="form-input" id="job-date" type="date" value="'+today()+'" /></div>'
      +   '<div class="form-group"><label class="form-label">Time</label><input class="form-input" id="job-time" type="time" value="09:00" /></div>'
      + '</div>'
      + '<div class="form-group"><label class="form-label">Price</label><input class="form-input" id="job-price" type="number" value="" /></div>'
      + '<div class="modal-actions"><button class="btn" onclick="Modal.close()">Cancel</button><button class="btn btn-green" onclick="Jobs.save(this)">Create Job</button></div>');
  },

  _fillPrice() {
    const sid=(document.getElementById('job-serviceId')||{}).value;
    const svc=this._services.find(s=>s.id===sid);
    const pe=document.getElementById('job-price'); if(svc&&pe&&!pe.value) pe.value=svc.price;
  },

  async save(btn) {
    const g=(k)=>(document.getElementById('job-'+k)||{}).value||'';
    const cust=this._customers.find(c=>c.id===g('customerId'));
    const svc=this._services.find(s=>s.id===g('serviceId'));
    const prop=this._properties.find(p=>p.id===g('propertyId'));
    if (!cust) { toast('Select a customer','error'); return; }
    if (!svc) { toast('Select a service','error'); return; }
    const body = {
      customerId:cust.id, customerName:cust.name, customerPhone:cust.phone||'',
      serviceId:svc.id, service:svc.name, price:Number(g('price'))||svc.price, duration:svc.duration,
      crewId:g('crewId')||null, propertyId:g('propertyId')||null,
      date:g('date'), time:g('time'), status:'confirmed', source:'crm',
      customFields: prop?{ serviceAddress: prop.address||'' }:{},
    };
    disableBtn(btn);
    try { await db.appointments.save(body); Modal.close(); toast('Job created ✓'); this.render(); }
    catch(e){ enableBtn(btn); toast(e.message||'Could not create job','error'); }
  },
};

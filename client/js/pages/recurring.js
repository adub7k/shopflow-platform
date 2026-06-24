// ── Recurring services (cleaning module) ─────────────────────────────────────
// A recurring contract spawns a normal appointment on each due date (weekly /
// biweekly / monthly / custom). The server scheduler generates them automatically;
// "Run now" spawns the next one immediately.
const Recurring = {
  _recs: [], _customers: [], _properties: [], _services: [], _crews: [],
  CADENCE: { daily:'Daily', weekly:'Weekly', biweekly:'Every 2 weeks', monthly:'Monthly', custom:'Custom…' },
  cadenceLabel(r){ if(r.cadence==='custom'){ const n=(r.customRule&&r.customRule.everyDays); return n?('Every '+n+' days'):'Custom'; } return this.CADENCE[r.cadence]||r.cadence; },

  async render() {
    const el = document.getElementById('page-recurring'); if (!el) return;
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading…</p></div>';
    try {
      const [recs, customers, properties, services, crews] = await Promise.all([
        db.recurring.all(), db.customers.all().catch(()=>[]), db.properties.all().catch(()=>[]),
        db.services.all().catch(()=>[]), db.crews.all().catch(()=>[]),
      ]);
      this._recs=recs||[]; this._customers=customers||[]; this._properties=properties||[]; this._services=services||[]; this._crews=crews||[];
      const cName=(id)=>(this._customers.find(c=>c.id===id)||{}).name||'Unassigned';
      const pName=(id)=>{const p=this._properties.find(x=>x.id===id);return p?(p.label||p.address):'';};
      const html=[];
      html.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><div class="section-header" style="margin:0;">Recurring Services</div><button class="btn btn-green btn-sm" onclick="Recurring.edit()">+ Add Recurring</button></div>');
      if (!this._recs.length) {
        html.push('<div class="card empty-state"><div class="empty-icon">🔁</div><div class="empty-text">No recurring services yet. Set up weekly or monthly cleanings and jobs are created automatically.</div></div>');
      } else {
        html.push('<div class="list-card">');
        this._recs.forEach(r=>{
          const sub = [this.cadenceLabel(r), pName(r.propertyId)].filter(Boolean).join(' · ');
          html.push('<div class="list-row"><div class="list-main">'
            + '<div class="list-name">'+esc(cName(r.customerId))+(r.active?'':' <span class="badge badge-gray">paused</span>')+'</div>'
            + '<div class="list-sub">'+esc(sub)+'</div>'
            + '<div style="font-size:12px;color:var(--muted);margin-top:3px;">Next: '+fmtDateFull(r.nextRunDate)+' · '+fmtMoney(r.price)+'</div>'
            + '</div><div class="list-right" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">'
            + '<button class="btn btn-sm btn-green" onclick="Recurring.generate(\''+r.id+'\',this)">Run now</button>'
            + '<button class="btn btn-sm" onclick="Recurring.edit(\''+r.id+'\')">Edit</button>'
            + '<button class="btn btn-sm btn-danger" onclick="Recurring.remove(\''+r.id+'\')">✕</button>'
            + '</div></div>');
        });
        html.push('</div>');
      }
      el.innerHTML=html.join('');
    } catch(e){ el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load recurring services</p></div>'; }
  },

  edit(id) {
    const r = id ? this._recs.find(x=>x.id===id) : { cadence:'weekly', time:'09:00', nextRunDate:today(), active:true };
    const sel = (list, val, fmt) => list.map(o=>'<option value="'+o.id+'"'+(val===o.id?' selected':'')+'>'+esc(fmt(o))+'</option>').join('');
    const cad = Object.entries(this.CADENCE).map(([k,v])=>'<option value="'+k+'"'+(r.cadence===k?' selected':'')+'>'+v+'</option>').join('');
    Modal.show('<div class="modal-title">'+(id?'Edit':'Add')+' Recurring Service</div>'
      + '<div class="form-group"><label class="form-label">Customer</label><select class="form-input" id="rec-customerId"><option value="">— Select —</option>'+sel(this._customers,r.customerId,c=>c.name)+'</select></div>'
      + '<div class="form-group"><label class="form-label">Property</label><select class="form-input" id="rec-propertyId"><option value="">— Optional —</option>'+sel(this._properties,r.propertyId,p=>(p.label||p.address))+'</select></div>'
      + '<div class="form-group"><label class="form-label">Service</label><select class="form-input" id="rec-serviceId"><option value="">— Select —</option>'+sel(this._services,r.serviceId,s=>s.name+' ('+fmtMoney(s.price)+')')+'</select></div>'
      + '<div class="form-group"><label class="form-label">Crew</label><select class="form-input" id="rec-crewId"><option value="">— Unassigned —</option>'+sel(this._crews,r.crewId,c=>c.name)+'</select></div>'
      + '<div class="form-row">'
      +   '<div class="form-group"><label class="form-label">Repeats</label><select class="form-input" id="rec-cadence" onchange="Recurring._toggleCustom()">'+cad+'</select></div>'
      +   '<div class="form-group"><label class="form-label">Price</label><input class="form-input" id="rec-price" type="number" value="'+esc(r.price!=null?r.price:'')+'" /></div>'
      + '</div>'
      + '<div class="form-group" id="rec-custom-wrap" style="display:'+(r.cadence==='custom'?'block':'none')+';"><label class="form-label">Every how many days?</label><input class="form-input" id="rec-everyDays" type="number" min="1" value="'+esc((r.customRule&&r.customRule.everyDays)||3)+'" /></div>'
      + '<div class="form-row">'
      +   '<div class="form-group"><label class="form-label">Start / next date</label><input class="form-input" id="rec-nextRunDate" type="date" value="'+esc(r.nextRunDate||today())+'" /></div>'
      +   '<div class="form-group"><label class="form-label">Time</label><input class="form-input" id="rec-time" type="time" value="'+esc(r.time||'09:00')+'" /></div>'
      + '</div>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-bottom:8px;"><input type="checkbox" id="rec-active"'+(r.active!==false?' checked':'')+' /> Active</label>'
      + '<div class="modal-actions"><button class="btn" onclick="Modal.close()">Cancel</button><button class="btn btn-green" onclick="Recurring.save(\''+(id||'')+'\',this)">Save</button></div>');
  },

  _toggleCustom() {
    const c=(document.getElementById('rec-cadence')||{}).value;
    const w=document.getElementById('rec-custom-wrap'); if(w) w.style.display = c==='custom' ? 'block' : 'none';
  },

  async save(id, btn) {
    const g=(k)=>(document.getElementById('rec-'+k)||{}).value||'';
    const body = { customerId:g('customerId'), propertyId:g('propertyId'), serviceId:g('serviceId'), crewId:g('crewId'), cadence:g('cadence'), time:g('time'), nextRunDate:g('nextRunDate'), price:Number(g('price'))||0, active:(document.getElementById('rec-active')||{}).checked };
    if (body.cadence==='custom') body.customRule = { everyDays: Math.max(1, Number(g('everyDays'))||7) };
    if (id) body.id = id;
    if (!body.customerId) { toast('Select a customer','error'); return; }
    if (!body.nextRunDate) { toast('Pick a start date','error'); return; }
    disableBtn(btn);
    try { await db.recurring.save(body); Modal.close(); toast('Recurring service saved ✓'); this.render(); }
    catch(e){ enableBtn(btn); toast(e.message||'Could not save','error'); }
  },

  async generate(id, btn) {
    if (btn){ btn.disabled=true; btn.textContent='…'; }
    try { const r=await db.recurring.generate(id); toast('Job created for '+fmtDateShort(r.date)+' ✓'); this.render(); }
    catch(e){ toast(e.message||'Could not generate','error'); if(btn){btn.disabled=false;btn.textContent='Run now';} }
  },

  async remove(id) {
    if (!confirm('Delete this recurring service? Existing jobs are kept.')) return;
    try { await db.recurring.delete(id); toast('Deleted'); this.render(); }
    catch(e){ toast(e.message||'Could not delete','error'); }
  },
};

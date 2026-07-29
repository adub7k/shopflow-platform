// ── Quotes / Estimates ────────────────────────────────────────────────────────
// Send a customer a line-item estimate for high-ticket work; they approve (and
// optionally pay a deposit) on a public page, then the shop schedules it.
const Quotes = {
  _data: [], _services: [], _filter: '', _lines: [],

  _vkey(fieldKey){ return fieldKey.replace(/^vehicle/,'').toLowerCase(); },
  _badge(st){
    const m={sent:'badge-yellow',approved:'badge-green',scheduled:'badge-blue',declined:'badge-red'};
    const lb={sent:'Sent',approved:'Approved',scheduled:'Scheduled',declined:'Declined'};
    return `<span class="badge ${m[st]||'badge-gray'}" style="margin-top:3px;">${lb[st]||st}</span>`;
  },

  async render(){
    const el=document.getElementById('page-quotes'); if(!el)return;
    el.innerHTML='<div class="spinner-page"><div class="spinner"></div></div>';
    try{
      [this._data, this._services] = await Promise.all([db.quotes.all(), db.services.all()]);
      const html=[];
      html.push(`<div class="section-header"><span>Estimates</span>${canWrite()?'<button class="btn btn-sm btn-green" onclick="Quotes.openForm(null)">+ New</button>':''}</div>`);
      const tabs=[['','All'],['sent','Sent'],['approved','Approved'],['scheduled','Scheduled'],['declined','Declined']];
      html.push('<div style="display:flex;gap:6px;overflow-x:auto;margin-bottom:14px;padding-bottom:2px;">');
      tabs.forEach(([v,lb])=>html.push(`<button class="btn btn-sm${this._filter===v?' btn-primary':''}" style="white-space:nowrap;" onclick="Quotes._filter='${v}';Quotes.render()">${lb}</button>`));
      html.push('</div>');
      const filtered=this._data.filter(q=>!this._filter||q.status===this._filter);
      if(!filtered.length){
        html.push(`<div class="card"><div class="empty-state"><div class="empty-icon">📄</div><div class="empty-text">No estimates${this._filter?' here':' yet'}</div>${!this._filter&&canWrite()?'<div class="empty-sub">Create one to quote a ceramic, PPF, or correction job.</div>':''}</div></div>`);
      } else {
        html.push('<div class="list-card">');
        filtered.forEach(q=>{
          const n=(q.lineItems||[]).length;
          const veh=q.vehicle&&q.vehicle.make?' · '+esc([q.vehicle.year,q.vehicle.make,q.vehicle.model].filter(Boolean).join(' ')):'';
          html.push(`<div class="list-row" onclick="Quotes.openDetail('${q.id}')">
            <div class="list-main"><div class="list-name">${esc(q.customerName||'—')} <span style="font-size:11px;color:var(--faint);font-family:monospace;">${esc(q.number||'')}</span></div>
            <div class="list-sub">${n} item${n!==1?'s':''}${veh}</div></div>
            <div class="list-right"><div style="font-weight:700;color:var(--green);">${fmtMoney(q.total)}</div>${this._badge(q.status)}</div>
          </div>`);
        });
        html.push('</div>');
      }
      el.innerHTML=html.join('');
    }catch(e){ el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load estimates</p></div>'; }
  },

  openForm(id){
    const q=id?this._data.find(x=>x.id===id):null;
    this._lines = q ? JSON.parse(JSON.stringify(q.lineItems||[])) : [];
    const fields=Shop.fields||[]; const v=(q&&q.vehicle)||{};
    const svcOpts=this._services.map(s=>`<option value="${s.id}">${esc(s.name)} — ${fmtMoney(s.price)}</option>`).join('');
    const addonOpts=(Shop.addons||[]).map(a=>`<option value="${a.id}">${esc(a.name)} — +${fmtMoney(a.price)}</option>`).join('');
    Modal.show(`
      <div class="modal-title">${q?'Edit Estimate':'New Estimate'}</div>
      <div class="form-group"><label class="form-label">Customer *</label>
        <div class="autocomplete-wrap"><input class="form-input" id="fq-name" value="${esc(q?.customerName||'')}" placeholder="Search or type name..." /><div class="autocomplete-list" id="fq-list"></div></div>
        <input type="hidden" id="fq-cid" value="${q?.customerId||''}" /><input type="hidden" id="fq-phone" value="${esc(q?.customerPhone||'')}" />
      </div>
      <div class="form-group"><label class="form-label">Email <span style="color:var(--faint);font-weight:400;">(to send the estimate)</span></label>
        <input class="form-input" id="fq-email" type="email" value="${esc(q?.customerEmail||'')}" placeholder="customer@email.com" /></div>
      ${fields.length?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">${fields.map(f=>`<div class="form-group"><label class="form-label">${esc(f.label)}</label><input class="form-input" id="fq-v-${esc(f.key)}" value="${esc(v[this._vkey(f.key)]||'')}" placeholder="${esc(f.label)}" /></div>`).join('')}</div>`:''}
      <div class="form-group"><label class="form-label">Line items</label><div id="fq-lines"></div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        <select class="form-input" id="fq-svc" style="flex:1;min-width:130px;"><option value="">Add service…</option>${svcOpts}</select>
        <button class="btn btn-sm" onclick="Quotes._addSvc()">+ Service</button>
      </div>
      ${addonOpts?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;"><select class="form-input" id="fq-addon" style="flex:1;min-width:130px;"><option value="">Add add-on…</option>${addonOpts}</select><button class="btn btn-sm" onclick="Quotes._addAddon()">+ Add-on</button></div>`:''}
      <div style="display:flex;gap:6px;margin-bottom:14px;">
        <input class="form-input" id="fq-cl-name" placeholder="Custom line (e.g. Paint correction)" style="flex:1;" />
        <input class="form-input" id="fq-cl-price" type="number" placeholder="$" style="width:84px;" />
        <button class="btn btn-sm" onclick="Quotes._addCustom()">+</button>
      </div>
      <div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin:0;"><input type="checkbox" id="fq-dep-on" ${q?.depositRequired?'checked':''} onchange="Quotes._toggleDep()" /> Require a deposit to approve</label>
        <div id="fq-dep-row" style="display:${q?.depositRequired?'block':'none'};margin-top:8px;"><input class="form-input" id="fq-dep-amt" type="number" value="${q?.depositAmount||50}" placeholder="Deposit amount" /></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="fq-notes" rows="2" placeholder="Scope, expectations, timeline...">${esc(q?.notes||'')}</textarea></div>
      <div class="modal-actions">
        <button id="fq-btn" class="btn btn-primary btn-full" onclick="Quotes.save('${q?.id||''}')">${q?'Save Estimate':'Create Estimate'}</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>{
      makeAutocomplete('fq-name','fq-list',(cid,name,phone,email)=>{document.getElementById('fq-name').value=name;document.getElementById('fq-cid').value=cid;document.getElementById('fq-phone').value=phone||'';const em=document.getElementById('fq-email');if(em&&email&&!em.value)em.value=email;});
      this._renderLines();
    },150);
  },

  _renderLines(){
    const el=document.getElementById('fq-lines'); if(!el)return;
    let html = this._lines.length
      ? this._lines.map((l,i)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:14px;"><span>${esc(l.name)}</span><span style="display:flex;align-items:center;gap:10px;"><strong>${fmtMoney(l.price)}</strong><button class="btn btn-sm btn-danger" onclick="Quotes._removeLine(${i})">×</button></span></div>`).join('')
      : '<div style="font-size:12px;color:var(--faint);padding:6px 0;">No items yet — add a service, add-on, or custom line below.</div>';
    const subtotal=this._lines.reduce((t,l)=>t+Number(l.price||0),0);
    const t=Shop.tax||{}; const rate=Number(t.rate)||0; const taxOn=t.enabled&&rate>0;
    const tax=taxOn?Math.round(subtotal*rate)/100:0;
    if(taxOn){
      html+=`<div style="display:flex;justify-content:space-between;padding:7px 0 0;font-size:13px;color:var(--muted);"><span>Subtotal</span><span>${fmtMoney(subtotal)}</span></div>`;
      html+=`<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px;color:var(--muted);"><span>${esc(t.label||'Sales Tax')} (${rate}%)</span><span>${fmtMoney(tax)}</span></div>`;
    }
    html+=`<div style="display:flex;justify-content:space-between;padding:9px 0 2px;font-weight:800;"><span>Total</span><span style="color:var(--green);">${fmtMoney(subtotal+tax)}</span></div>`;
    el.innerHTML=html;
  },
  _addSvc(){ const sel=document.getElementById('fq-svc'); const s=this._services.find(x=>x.id===sel.value); if(!s)return; this._lines.push({name:s.name,price:Number(s.price)||0}); sel.value=''; this._renderLines(); },
  _addAddon(){ const sel=document.getElementById('fq-addon'); const a=(Shop.addons||[]).find(x=>x.id===sel.value); if(!a)return; this._lines.push({name:a.name,price:Number(a.price)||0}); sel.value=''; this._renderLines(); },
  _addCustom(){ const n=document.getElementById('fq-cl-name'),p=document.getElementById('fq-cl-price'); const name=(n.value||'').trim(); if(!name){toast('Enter a line name','warning');return;} this._lines.push({name,price:parseFloat(p.value)||0}); n.value='';p.value=''; this._renderLines(); n.focus(); },
  _removeLine(i){ this._lines.splice(i,1); this._renderLines(); },
  _toggleDep(){ const on=document.getElementById('fq-dep-on')?.checked; const r=document.getElementById('fq-dep-row'); if(r)r.style.display=on?'block':'none'; },

  async save(id){
    const name=document.getElementById('fq-name')?.value.trim();
    if(!name){toast('Enter a customer name','warning');return;}
    if(!this._lines.length){toast('Add at least one line item','warning');return;}
    const vehicle={}; (Shop.fields||[]).forEach(f=>{ const val=document.getElementById('fq-v-'+f.key)?.value.trim()||''; if(val) vehicle[this._vkey(f.key)]=val; });
    const depOn=document.getElementById('fq-dep-on')?.checked;
    const btn=document.getElementById('fq-btn'); disableBtn(btn);
    try{
      await db.quotes.save({
        id:id||undefined,
        customerId:document.getElementById('fq-cid')?.value||null,
        customerName:name,
        customerPhone:document.getElementById('fq-phone')?.value||'',
        customerEmail:document.getElementById('fq-email')?.value.trim()||'',
        vehicle,
        lineItems:this._lines,
        depositRequired:!!depOn,
        depositAmount:depOn?(parseFloat(document.getElementById('fq-dep-amt')?.value)||50):0,
        notes:document.getElementById('fq-notes')?.value.trim()||'',
      });
      Modal.close(); toast(id?'Estimate updated ✓':'Estimate created ✓'); await this.render();
    }catch(e){ toast('Could not save','error'); enableBtn(btn); }
  },

  openDetail(id){
    const q=this._data.find(x=>x.id===id); if(!q)return;
    const link=location.origin+'/quote/'+Auth.getShopSlug()+'/'+q.id;
    Modal.show(`
      <div class="modal-title">${esc(q.number||'Estimate')}</div>
      <div style="background:var(--surface2);border-radius:10px;padding:14px;margin-bottom:14px;">
        <div style="font-size:16px;font-weight:700;">${esc(q.customerName||'—')}</div>
        ${q.vehicle&&(q.vehicle.make||q.vehicle.model)?`<div style="font-size:13px;color:var(--muted);margin-top:3px;">🚗 ${esc([q.vehicle.year,q.vehicle.make,q.vehicle.model,q.vehicle.color].filter(Boolean).join(' '))}</div>`:''}
        <div style="margin-top:8px;">${this._badge(q.status)} ${q.depositPaid?'<span class="badge badge-green">Deposit paid</span>':''}</div>
      </div>
      <div class="list-card" style="margin-bottom:14px;">
        ${(q.lineItems||[]).map(l=>`<div class="list-row"><div class="list-main"><div class="list-name" style="font-size:14px;">${esc(l.name)}</div></div><div style="font-weight:700;">${fmtMoney(l.price)}</div></div>`).join('')}
        ${q.taxAmount?`<div class="list-row"><div class="list-main"><div class="list-name" style="font-size:13px;color:var(--muted);">Subtotal</div></div><div style="color:var(--muted);">${fmtMoney(q.subtotal)}</div></div>
        <div class="list-row"><div class="list-main"><div class="list-name" style="font-size:13px;color:var(--muted);">${esc(q.taxLabel||'Sales Tax')} (${q.taxRate}%)</div></div><div style="color:var(--muted);">${fmtMoney(q.taxAmount)}</div></div>`:''}
        <div class="list-row"><div class="list-main"><div class="list-name" style="font-weight:800;">Total</div></div><div style="font-weight:800;color:var(--green);">${fmtMoney(q.total)}</div></div>
      </div>
      ${q.notes?`<div style="font-size:13px;color:var(--muted);margin-bottom:14px;">${esc(q.notes)}</div>`:''}
      <div class="modal-actions">
        <button class="btn btn-full" onclick="navigator.clipboard.writeText('${link}');toast('Link copied ✓')">🔗 Copy estimate link</button>
        ${q.customerEmail?`<button class="btn btn-full" onclick="Quotes.sendEmail('${q.id}')">✉️ Email to customer</button>`:''}
        ${q.customerPhone?`<button class="btn btn-full" onclick="Quotes.sendLink('${q.id}')">📱 Text to customer</button>`:''}
        ${q.status==='approved'?`<button class="btn btn-green btn-full" onclick="Quotes.schedule('${q.id}')">📅 Schedule appointment</button>`:''}
        ${q.status==='sent'?`<button class="btn btn-full" onclick="Quotes.mark('${q.id}','approved')">Mark approved</button>`:''}
        ${canWrite()?`<button class="btn btn-full" onclick="Quotes.openForm('${q.id}')">Edit</button>`:''}
        ${canWrite()?`<button class="btn btn-danger btn-full" onclick="Quotes.delete('${q.id}')">Delete</button>`:''}
        <button class="btn btn-full" onclick="Modal.close()">Close</button>
      </div>`);
  },

  async sendLink(id){
    try{ const r=await db.quotes.send(id); if(r&&r.ok){toast('Estimate texted ✓');} else {toast((r&&r.error)||'Could not send','error');} }
    catch(e){ toast(e.message||'Could not send','error'); }
  },
  async sendEmail(id){
    try{ const r=await db.quotes.sendEmail(id); if(r&&r.ok){toast('Estimate emailed ✓');} else {toast((r&&r.error)||'Could not send','error');} }
    catch(e){ toast(e.message||'Could not send','error'); }
  },
  async mark(id, status){
    try{ await db.quotes.save({id,status}); Modal.close(); toast('Marked '+status+' ✓'); await this.render(); }
    catch(e){ toast('Could not update','error'); }
  },
  schedule(id){
    const q=this._data.find(x=>x.id===id); if(!q)return;
    // Don't mark scheduled yet — the appointment form does that on save, so an
    // abandoned form leaves the quote 'approved' rather than falsely 'scheduled'.
    Modal.close(); App.nav('appointments');
    setTimeout(()=>Appointments.openFormPrefilled(q.customerId, q.customerName, q.customerPhone, { price:q.total, notes:'From '+(q.number||'estimate'), vehicle:q.vehicle, quoteId:q.id }),150);
    toast('Pick a date & time to schedule');
  },
  async delete(id){
    if(!confirm('Delete this estimate?'))return;
    try{ await db.quotes.delete(id); Modal.close(); await this.render(); toast('Deleted'); }
    catch(e){ toast('Could not delete','error'); }
  },
};

// ── Quotes / Estimates ────────────────────────────────────────────────────────
// Send a customer a line-item estimate for high-ticket work; they approve (and
// optionally pay a deposit) on a public page, then the shop schedules it.
const Quotes = {
  _data: [], _services: [], _filter: 'open', _lines: [],

  // Lifecycle: sent → approved → scheduled, then the owner closes it out as
  // 'completed' (work done) or 'lost' (didn't get it). 'declined' is the same
  // dead end but reached by the customer on the public page, so both file under
  // "Lost" in the UI. Closed estimates drop off the default Open list and can be
  // reopened if closed by mistake.
  STATUS_META: {
    sent:      { label:'Sent',      cls:'badge-yellow' },
    approved:  { label:'Approved',  cls:'badge-green'  },
    scheduled: { label:'Scheduled', cls:'badge-blue'   },
    completed: { label:'Completed', cls:'badge-green'  },
    declined:  { label:'Declined',  cls:'badge-red'    },
    lost:      { label:'Lost',      cls:'badge-gray'   },
  },
  CLOSED_STATUSES: ['completed','declined','lost'],
  isClosed(st){ return this.CLOSED_STATUSES.includes(st); },
  // Tab value → predicate. 'open' is everything still in play; 'lost' groups the
  // owner's close-out with the customer's decline.
  _matches(q, filter){
    if(!filter) return true;                               // All
    if(filter==='open') return !this.isClosed(q.status);
    if(filter==='lost') return q.status==='lost' || q.status==='declined';
    return q.status===filter;
  },

  // Fleet contracts. Line items price ONE visit; the recurring numbers are
  // derived from the frequency (server recomputes them authoritatively on save —
  // see contractTotals in routes/shop.js, which must agree with FREQ below).
  FREQ: [['weekly','Weekly',52],['biweekly','Every 2 weeks',26],['monthly','Monthly',12],['quarterly','Quarterly',4]],
  _freqLabel(f){ const m=this.FREQ.find(x=>x[0]===f); return m?m[1]:''; },
  // Fleet WITHOUT contract terms is a legitimate shape: a one-time deal to do
  // somebody's whole fleet. Everything fleet-flavoured keys off this, not off
  // the contract, so those estimates still read as fleet work.
  _isFleet(q){ return !!(q && (q.contract || q.fleetName || q.vehicleCount)); },
  // Headline figure: recurring value on a contract, the job total otherwise.
  _headline(q){ return q && q.contract ? q.monthlyTotal : (q||{}).total; },
  _visitsPerYear(f){ const m=this.FREQ.find(x=>x[0]===f); return m?m[2]:0; },
  _isFleetMode(){ return !!document.getElementById('fq-fleet')?.checked; },

  _vkey(fieldKey){ return fieldKey.replace(/^vehicle/,'').toLowerCase(); },
  _badge(st){
    const m=this.STATUS_META[st]||{};
    return `<span class="badge ${m.cls||'badge-gray'}" style="margin-top:3px;">${m.label||st}</span>`;
  },
  // Open indicator. The strongest signal is the estimate PAGE being loaded
  // (covers texted links — stamped server-side on every public open); the email
  // pixel remains the fallback signal for emailed ones. Empty until sent.
  _openTag(q){
    const when=(iso)=>{try{return new Date(iso).toLocaleDateString(undefined,{month:'short',day:'numeric'});}catch(e){return '';}};
    if(q.viewedAt){
      const title='Customer opened the estimate page'+(q.viewCount>1?` (${q.viewCount}×)`:'')+` — first on ${when(q.viewedAt)}`+(q.lastViewedAt&&q.lastViewedAt!==q.viewedAt?`, last ${when(q.lastViewedAt)}`:'');
      return `<span title="${esc(title)}" style="display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;margin-top:3px;color:var(--green);">👁 Viewed${q.viewCount>1?' ×'+q.viewCount:''}</span>`;
    }
    if(!q.emailSentAt&&!q.smsSentAt) return '';
    const opened=!!q.emailOpenedAt;
    if(opened){
      const title='Customer opened the email'+(q.emailOpenCount>1?` (${q.emailOpenCount}×)`:'')+(q.emailOpenedAt?` — first on ${when(q.emailOpenedAt)}`:'');
      return `<span title="${esc(title)}" style="display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;margin-top:3px;color:var(--green);">👁 Opened</span>`;
    }
    return `<span title="Sent — the page hasn't been opened yet" style="display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;margin-top:3px;color:var(--faint);">${q.emailSentAt?'✉️':'📱'} Not opened</span>`;
  },

  async render(){
    const el=document.getElementById('page-quotes'); if(!el)return;
    el.innerHTML='<div class="spinner-page"><div class="spinner"></div></div>';
    try{
      [this._data, this._services] = await Promise.all([db.quotes.all(), db.services.all()]);
      const html=[];
      html.push(`<div class="section-header"><span>Estimates</span>${canWrite()?'<button class="btn btn-sm btn-green" onclick="Quotes.openForm(null)">+ New</button>':''}</div>`);
      const tabs=[['open','Open'],['sent','Sent'],['approved','Approved'],['scheduled','Scheduled'],['completed','Completed'],['lost','Lost'],['','All']];
      html.push('<div style="display:flex;gap:6px;overflow-x:auto;margin-bottom:14px;padding-bottom:2px;">');
      tabs.forEach(([v,lb])=>{
        const n=this._data.filter(q=>this._matches(q,v)).length;
        html.push(`<button class="btn btn-sm${this._filter===v?' btn-primary':''}" style="white-space:nowrap;" onclick="Quotes._filter='${v}';Quotes.render()">${lb}${n?` <span style="opacity:.6;">${n}</span>`:''}</button>`);
      });
      html.push('</div>');
      const filtered=this._data.filter(q=>this._matches(q,this._filter));
      if(!filtered.length){
        const none=!this._data.length;   // nothing at all vs. nothing in this tab
        html.push(`<div class="card"><div class="empty-state"><div class="empty-icon">📄</div><div class="empty-text">No ${this._filter==='open'&&!none?'open ':''}estimates${none?' yet':' here'}</div>${none&&canWrite()?'<div class="empty-sub">Create one to quote a ceramic, PPF, or correction job.</div>':''}</div></div>`);
      } else {
        html.push('<div class="list-card">');
        filtered.forEach(q=>{
          const n=(q.lineItems||[]).length;
          const veh=q.vehicle&&q.vehicle.make?' · '+esc([q.vehicle.year,q.vehicle.make,q.vehicle.model].filter(Boolean).join(' ')):'';
          // Fleet rows lead with the recurring value — that's the number the
          // owner is actually chasing — and keep per-visit underneath it.
          const sub=this._isFleet(q)
            ? [esc(q.fleetName||'Fleet'), q.contract?this._freqLabel(q.contract.frequency):'One-time', q.vehicleCount?`${q.vehicleCount} vehicles`:''].filter(Boolean).join(' · ')
            : `${n} item${n!==1?'s':''}${veh}`;
          html.push(`<div class="list-row" onclick="Quotes.openDetail('${q.id}')">
            <div class="list-main"><div class="list-name">${esc(q.customerName||'—')} ${this._isFleet(q)?'<span class="badge badge-blue">🚚 Fleet</span> ':''}<span style="font-size:11px;color:var(--faint);font-family:monospace;">${esc(q.number||'')}</span></div>
            <div class="list-sub">${sub}</div></div>
            <div class="list-right" style="text-align:right;"><div style="font-weight:700;color:var(--green);">${fmtMoney(q.contract?q.monthlyTotal:q.total)}${q.contract?'<span style="font-size:11px;font-weight:600;color:var(--faint);">/mo</span>':''}</div>${this._badge(q.status)}<div>${this._openTag(q)}</div></div>
          </div>`);
        });
        html.push('</div>');
      }
      el.innerHTML=html.join('');
    }catch(e){ el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load estimates</p></div>'; }
  },

  openForm(id){
    const q=id?this._data.find(x=>x.id===id):null;
    const ct=q&&q.contract||null;
    this._lines = q ? JSON.parse(JSON.stringify(q.lineItems||[])) : [];
    const fields=Shop.fields||[]; const v=(q&&q.vehicle)||{};
    const svcOpts=this._services.map(s=>`<option value="${s.id}">${esc(s.name)} — ${fmtMoney(s.price)}</option>`).join('');
    const addonOpts=(Shop.addons||[]).map(a=>`<option value="${a.id}">${esc(a.name)} — +${fmtMoney(a.price)}</option>`).join('');
    Modal.show(`
      <div class="modal-title">${q?'Edit Estimate':'New Estimate'}</div>
      <div class="form-group"><label class="form-label">Customer *</label>
        <div class="autocomplete-wrap"><input class="form-input" id="fq-name" value="${esc(q?.customerName||'')}" placeholder="Search or type name..." /><div class="autocomplete-list" id="fq-list"></div></div>
        <input type="hidden" id="fq-cid" value="${q?.customerId||''}" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">
        <div class="form-group"><label class="form-label">Email <span style="color:var(--faint);font-weight:400;">(to email it)</span></label>
          <input class="form-input" id="fq-email" type="email" value="${esc(q?.customerEmail||'')}" placeholder="customer@email.com" /></div>
        <div class="form-group"><label class="form-label">Mobile <span style="color:var(--faint);font-weight:400;">(to text it)</span></label>
          <input class="form-input" id="fq-phone" type="tel" value="${esc(q?.customerPhone||'')}" placeholder="(555) 555-1234" /></div>
      </div>
      ${fields.length?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">${fields.map(f=>`<div class="form-group"><label class="form-label">${esc(f.label)}</label><input class="form-input" id="fq-v-${esc(f.key)}" value="${esc(v[this._vkey(f.key)]||'')}" placeholder="${esc(f.label)}" /></div>`).join('')}</div>`:''}
      <div class="form-group" style="margin-bottom:10px;">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin:0;">
          <input type="checkbox" id="fq-opts-on" ${q?.options?.length?'checked':''} onchange="Quotes._toggleOpts()" /> ⚖️ Offer two options (customer picks one on the page)
        </label>
        <div id="fq-opts-box" style="display:${q?.options?.length?'block':'none'};background:var(--surface2);border-radius:10px;padding:12px;margin-top:9px;">
          ${[0,1].map(i=>{const o=(q?.options||[])[i]||{};return `
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--surface);">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:7px;">
              <select class="form-input" id="fq-opt${i}-preset" style="flex:1;min-width:0;" onchange="Quotes._optPreset(${i})">
                <option value="">${i===0?'Option 1 — preset…':'Option 2 — preset…'}</option>
                <option value="carbon">Carbon tint</option>
                <option value="ceramic">Ceramic tint</option>
              </select>
              <label style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;margin:0;"><input type="radio" name="fq-opt-rec" id="fq-opt${i}-rec" ${o.recommended?'checked':''}/> ⭐ Recommend</label>
            </div>
            <div style="display:grid;grid-template-columns:1fr 92px;gap:0 8px;">
              <div class="form-group" style="margin-bottom:7px;"><input class="form-input" id="fq-opt${i}-name" value="${esc(o.name||'')}" placeholder="Name (e.g. Carbon Tint)" /></div>
              <div class="form-group" style="margin-bottom:7px;"><input class="form-input" id="fq-opt${i}-price" type="number" min="0" inputmode="decimal" value="${o.price!=null?o.price:''}" placeholder="$" /></div>
            </div>
            <textarea class="form-input" id="fq-opt${i}-bens" rows="3" placeholder="Benefits — one per line (they unfold when the customer taps this option)">${esc((o.benefits||[]).join('\n'))}</textarea>
          </div>`;}).join('')}
          <div style="font-size:11.5px;color:var(--muted);line-height:1.45;">The page shows both cards with prices — tapping one unfolds its benefits and arms the approve button. Line items below are ignored while options are on; the deposit applies to whichever option they pick.</div>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:10px;">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin:0;">
          <input type="checkbox" id="fq-fleet" ${ct?'checked':''} onchange="Quotes._toggleFleet()" /> 🚚 Fleet contract (multiple vehicles / recurring)
        </label>
        <div id="fq-fleet-box" style="display:${ct?'block':'none'};background:var(--surface2);border-radius:10px;padding:12px;margin-top:9px;">
          <div style="display:grid;grid-template-columns:1fr 110px;gap:0 10px;">
            <div class="form-group"><label class="form-label">Company</label><input class="form-input" id="fq-fleetname" value="${esc(q?.fleetName||'')}" placeholder="e.g. Sandia Auto Group" /></div>
            <div class="form-group"><label class="form-label">Vehicles</label><input class="form-input" id="fq-vcount" type="number" min="1" value="${q?.vehicleCount||''}" placeholder="12" /></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 110px;gap:0 10px;">
            <div class="form-group" style="margin-bottom:0;"><label class="form-label">Billing</label>
              <select class="form-input" id="fq-freq" onchange="Quotes._freqChange()">
                <option value="">One-time job (no contract)</option>
                ${this.FREQ.map(([v,lb])=>`<option value="${v}" ${ct&&ct.frequency===v?'selected':''}>${lb}</option>`).join('')}
              </select></div>
            <div class="form-group" id="fq-term-wrap" style="margin-bottom:0;display:${ct?'block':'none'};"><label class="form-label">Term (mo)</label><input class="form-input" id="fq-term" type="number" min="1" max="120" value="${ct?.termMonths||12}" oninput="Quotes._renderLines()" /></div>
          </div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:10px;line-height:1.45;">Set each line's quantity to the number of vehicles. Leave billing on <b>one-time</b> for a single fleet job; pick a frequency to quote it as a recurring contract.</div>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Line items</label><div id="fq-lines"></div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        <select class="form-input" id="fq-svc" style="flex:1;min-width:130px;"><option value="">Add service…</option>${svcOpts}</select>
        <button class="btn btn-sm" onclick="Quotes._addSvc()">+ Service</button>
      </div>
      ${addonOpts?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;"><select class="form-input" id="fq-addon" style="flex:1;min-width:130px;"><option value="">Add add-on…</option>${addonOpts}</select><button class="btn btn-sm" onclick="Quotes._addAddon()">+ Add-on</button></div>`:''}
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <input class="form-input" id="fq-cl-name" placeholder="Custom line (e.g. Paint correction)" style="flex:1;" />
        <input class="form-input" id="fq-cl-price" type="number" placeholder="$" style="width:84px;" />
        <button class="btn btn-sm" onclick="Quotes._addCustom()">+</button>
      </div>
      <div class="form-group" style="margin-bottom:14px;"><label class="form-label">Discount % <span style="color:var(--faint);font-weight:400;">(optional)</span></label>
        <input class="form-input" id="fq-discount" type="number" min="0" max="100" step="0.5" inputmode="decimal" value="${q?.discountPercent||''}" placeholder="e.g. 10" oninput="Quotes._renderLines()" style="width:110px;" />
      </div>
      <div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin:0;"><input type="checkbox" id="fq-dep-on" ${q?.depositRequired?'checked':''} onchange="Quotes._toggleDep()" /> Require a deposit to approve</label>
        <div id="fq-dep-row" style="display:${q?.depositRequired?'block':'none'};margin-top:8px;"><input class="form-input" id="fq-dep-amt" type="number" value="${q?.depositAmount||50}" placeholder="Deposit amount" /></div>
        ${!(Shop.settings&&((Shop.settings.square&&Shop.settings.square.accessToken)||(Shop.settings.stripe&&Shop.settings.stripe.onboardingComplete)))?'<div style="font-size:12px;color:var(--faint);margin-top:6px;">Customers can always approve online. If Square isn’t connected (Settings → Payments), you collect the deposit directly.</div>':''}
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="fq-notes" rows="2" placeholder="Scope, expectations, timeline...">${esc(q?.notes||'')}</textarea></div>
      <div class="modal-actions">
        <button id="fq-btn-send" class="btn btn-green btn-full" onclick="Quotes.save('${q?.id||''}','email')">${q?'Save & email':'Create & email'} estimate</button>
        <button id="fq-btn-text" class="btn btn-green btn-full" onclick="Quotes.save('${q?.id||''}','sms')">${q?'Save & text':'Create & text'} estimate</button>
        <button id="fq-btn" class="btn btn-full" onclick="Quotes.save('${q?.id||''}','')">${q?'Save without sending':'Create without sending'}</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>{
      makeAutocomplete('fq-name','fq-list',(cid,name,phone,email)=>{document.getElementById('fq-name').value=name;document.getElementById('fq-cid').value=cid;document.getElementById('fq-phone').value=phone||'';const em=document.getElementById('fq-email');if(em&&email&&!em.value)em.value=email;this._prefillFleet(cid);});
      this._renderLines();
    },150);
  },

  _renderLines(){
    const el=document.getElementById('fq-lines'); if(!el)return;
    const fleet=this._isFleetMode();
    // Quantity is only editable in fleet mode — a one-vehicle estimate keeps the
    // plain "name … price" row it has always had.
    let html = this._lines.length
      ? this._lines.map((l,i)=>{
          const qty=Number(l.qty)||1;
          const qtyCell=fleet
            ? `<input class="form-input" type="number" min="1" value="${qty}" style="width:56px;padding:4px 6px;font-size:13px;text-align:center;" onchange="Quotes._setQty(${i},this.value)" title="Vehicles" />`
            : '';
          const ext=fleet&&qty>1?`<span style="font-size:11px;color:var(--faint);">${qty} × ${fmtMoney(l.price)}</span>`:'';
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:14px;gap:8px;"><span style="flex:1;min-width:0;">${esc(l.name)}<br>${ext}</span><span style="display:flex;align-items:center;gap:8px;">${qtyCell}<strong>${fmtMoney(l.price*qty)}</strong><button class="btn btn-sm btn-danger" onclick="Quotes._removeLine(${i})">×</button></span></div>`;
        }).join('')
      : '<div style="font-size:12px;color:var(--faint);padding:6px 0;">No items yet — add a service, add-on, or custom line below.</div>';
    const subtotal=Math.round(this._lines.reduce((t,l)=>t+Number(l.price||0)*(Number(l.qty)||1),0)*100)/100;
    // Discount comes off the subtotal; tax is charged on what's left. Mirrors
    // the authoritative math in routes/shop.js.
    const pct=Math.max(0,Math.min(100,parseFloat(document.getElementById('fq-discount')?.value)||0));
    const discount=pct?Math.round(subtotal*pct)/100:0;
    const t=Shop.tax||{}; const rate=Number(t.rate)||0; const taxOn=t.enabled&&rate>0;
    const tax=taxOn?Math.round((subtotal-discount)*rate)/100:0;
    const perVisit=Math.round((subtotal-discount+tax)*100)/100;
    if(taxOn||discount){
      html+=`<div style="display:flex;justify-content:space-between;padding:7px 0 0;font-size:13px;color:var(--muted);"><span>Subtotal</span><span>${fmtMoney(subtotal)}</span></div>`;
    }
    if(discount){
      html+=`<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px;color:var(--green);font-weight:600;"><span>Discount (${pct}%)</span><span>−${fmtMoney(discount)}</span></div>`;
    }
    if(taxOn){
      html+=`<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px;color:var(--muted);"><span>${esc(t.label||'Sales Tax')} (${rate}%)</span><span>${fmtMoney(tax)}</span></div>`;
    }
    const freq=fleet?(document.getElementById('fq-freq')?.value||''):'';
    const per=this._visitsPerYear(freq);
    html+=`<div style="display:flex;justify-content:space-between;padding:9px 0 2px;font-weight:800;"><span>${per?'Per visit':'Total'}</span><span style="color:var(--green);">${fmtMoney(perVisit)}</span></div>`;
    if(per){
      const term=Math.max(1,Math.min(120,parseInt(document.getElementById('fq-term')?.value)||12));
      const monthly=Math.round(perVisit*(per/12)*100)/100;
      html+=`<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;">`;
      html+=`<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);"><span>${esc(this._freqLabel(freq))} · ${term}-month term</span><span></span></div>`;
      html+=`<div style="display:flex;justify-content:space-between;padding:4px 0;font-weight:800;"><span>Monthly</span><span style="color:var(--green);">${fmtMoney(monthly)}</span></div>`;
      html+=`<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);"><span>Contract value</span><span>${fmtMoney(Math.round(monthly*term*100)/100)}</span></div></div>`;
    }
    el.innerHTML=html;
  },
  // A term only means something once there's a frequency to repeat.
  _freqChange(){
    const w=document.getElementById('fq-term-wrap');
    if(w)w.style.display=document.getElementById('fq-freq')?.value?'block':'none';
    this._renderLines();
  },
  _setQty(i,v){ if(this._lines[i]) this._lines[i].qty=Math.max(1,Math.min(999,parseInt(v)||1)); this._renderLines(); },
  // Turning fleet mode off drops back to one of everything, so a half-filled
  // fleet estimate can't leave stale quantities inflating a normal quote.
  _toggleFleet(){
    const on=this._isFleetMode();
    const box=document.getElementById('fq-fleet-box'); if(box)box.style.display=on?'block':'none';
    if(!on) this._lines.forEach(l=>{ l.qty=1; });
    this._renderLines();
  },
  // Picking a client already flagged as a fleet account in the CRM sets this up
  // for the owner instead of making them re-enter what's on the profile.
  async _prefillFleet(cid){
    if(!cid) return;
    try{
      const c=await db.customers.get(cid);
      if(!c||!c.isFleet) return;
      const cb=document.getElementById('fq-fleet');
      if(cb&&!cb.checked){ cb.checked=true; this._toggleFleet(); }
      const fn=document.getElementById('fq-fleetname'); if(fn&&!fn.value) fn.value=c.companyName||c.name||'';
      const vc=document.getElementById('fq-vcount'); if(vc&&!vc.value&&(c.vehicles||[]).length) vc.value=(c.vehicles||[]).length;
    }catch(e){}
  },
  _addSvc(){ const sel=document.getElementById('fq-svc'); const s=this._services.find(x=>x.id===sel.value); if(!s)return; this._lines.push({name:s.name,price:Number(s.price)||0,qty:this._isFleetMode()?(parseInt(document.getElementById('fq-vcount')?.value)||1):1}); sel.value=''; this._renderLines(); },
  _addAddon(){ const sel=document.getElementById('fq-addon'); const a=(Shop.addons||[]).find(x=>x.id===sel.value); if(!a)return; this._lines.push({name:a.name,price:Number(a.price)||0,qty:this._isFleetMode()?(parseInt(document.getElementById('fq-vcount')?.value)||1):1}); sel.value=''; this._renderLines(); },
  _addCustom(){ const n=document.getElementById('fq-cl-name'),p=document.getElementById('fq-cl-price'); const name=(n.value||'').trim(); if(!name){toast('Enter a line name','warning');return;} this._lines.push({name,price:parseFloat(p.value)||0,qty:this._isFleetMode()?(parseInt(document.getElementById('fq-vcount')?.value)||1):1}); n.value='';p.value=''; this._renderLines(); n.focus(); },
  _removeLine(i){ this._lines.splice(i,1); this._renderLines(); },
  _toggleDep(){ const on=document.getElementById('fq-dep-on')?.checked; const r=document.getElementById('fq-dep-row'); if(r)r.style.display=on?'block':'none'; },

  // ── Option estimates (customer picks one of two on the public page) ─────────
  // Presets fill the name + benefit bullets (the same pitch the AI receptionist
  // gives); price stays the owner's to type. Everything stays editable after.
  OPT_PRESETS:{
    carbon:{ name:'Carbon Tint', benefits:[
      'Blocks 99% of harmful UV rays',
      'Rejects up to 45% of the heat',
      'Deep, factory-look black that never fades or turns purple',
      'No interference with GPS, phone or radio signal',
      'Lifetime warranty',
    ]},
    ceramic:{ name:'Ceramic Tint', benefits:[
      'Blocks 99% of harmful UV rays',
      'Rejects up to 95% of the heat — the real summer difference',
      'Crystal-clear visibility, day and night',
      'No interference with GPS, phone or radio signal',
      'Lifetime warranty',
    ]},
  },
  _toggleOpts(){
    const on=document.getElementById('fq-opts-on')?.checked;
    const box=document.getElementById('fq-opts-box'); if(box)box.style.display=on?'block':'none';
    // Options and fleet contracts are different animals — never both.
    if(on){ const f=document.getElementById('fq-fleet'); if(f&&f.checked){ f.checked=false; this._toggleFleet(); } }
  },
  _optPreset(i){
    const key=document.getElementById('fq-opt'+i+'-preset')?.value; const p=this.OPT_PRESETS[key]; if(!p)return;
    const n=document.getElementById('fq-opt'+i+'-name'); if(n)n.value=p.name;
    const b=document.getElementById('fq-opt'+i+'-bens'); if(b)b.value=p.benefits.join('\n');
  },
  // Collect the two option editors; null = toggle off (server clears options).
  _collectOptions(){
    if(!document.getElementById('fq-opts-on')?.checked) return [];
    return [0,1].map(i=>({
      id:'opt'+(i+1),
      name:document.getElementById('fq-opt'+i+'-name')?.value.trim()||'',
      price:parseFloat(document.getElementById('fq-opt'+i+'-price')?.value)||0,
      benefits:(document.getElementById('fq-opt'+i+'-bens')?.value||'').split('\n').map(s=>s.trim()).filter(Boolean),
      recommended:!!document.getElementById('fq-opt'+i+'-rec')?.checked,
    })).filter(o=>o.name&&o.price>0);
  },

  // sendVia: 'email' | 'sms' | '' (save only)
  async save(id, sendVia){
    const name=document.getElementById('fq-name')?.value.trim();
    if(!name){toast('Enter a customer name','warning');return;}
    const optsOn=!!document.getElementById('fq-opts-on')?.checked;
    const options=this._collectOptions();
    if(optsOn&&options.length<2){toast('Fill in both options (name + price), or turn options off','warning');return;}
    if(!optsOn&&!this._lines.length){toast('Add at least one line item','warning');return;}
    const email=document.getElementById('fq-email')?.value.trim()||'';
    const phone=document.getElementById('fq-phone')?.value.trim()||'';
    // Sending needs somewhere to send it — stop before saving a half-action.
    if(sendVia==='email' && !email){toast('Add an email address to send the estimate','warning');document.getElementById('fq-email')?.focus();return;}
    if(sendVia==='sms' && phone.replace(/\D/g,'').length<10){toast('Add a mobile number to text the estimate','warning');document.getElementById('fq-phone')?.focus();return;}
    const vehicle={}; (Shop.fields||[]).forEach(f=>{ const val=document.getElementById('fq-v-'+f.key)?.value.trim()||''; if(val) vehicle[this._vkey(f.key)]=val; });
    const depOn=document.getElementById('fq-dep-on')?.checked;
    const fleetOn=this._isFleetMode();
    const freq=fleetOn?(document.getElementById('fq-freq')?.value||''):'';
    const contract=freq
      ? { frequency:freq, termMonths:Math.max(1,Math.min(120,parseInt(document.getElementById('fq-term')?.value)||12)) }
      : null;
    const btn=document.getElementById(sendVia==='email'?'fq-btn-send':sendVia==='sms'?'fq-btn-text':'fq-btn'); disableBtn(btn);
    try{
      const saved=await db.quotes.save({
        id:id||undefined,
        customerId:document.getElementById('fq-cid')?.value||null,
        customerName:name,
        customerPhone:phone,
        customerEmail:email,
        vehicle,
        lineItems:this._lines,
        // Two-option estimates: [] when the toggle is off so an edit clears them.
        options:options,
        // Fleet contract terms. Sent as null when the toggle is off so turning a
        // contract back into a one-off clears the recurring totals server-side.
        contract:contract,
        fleetName:fleetOn?(document.getElementById('fq-fleetname')?.value.trim()||''):'',
        vehicleCount:fleetOn?(parseInt(document.getElementById('fq-vcount')?.value)||0):0,
        discountPercent:Math.max(0,Math.min(100,parseFloat(document.getElementById('fq-discount')?.value)||0)),
        depositRequired:!!depOn,
        depositAmount:depOn?(parseFloat(document.getElementById('fq-dep-amt')?.value)||50):0,
        notes:document.getElementById('fq-notes')?.value.trim()||'',
      });
      if(sendVia==='sms'){
        // Manual send: fetch the saved quote (server computed number/total),
        // then pull up Messages prefilled — the owner just hits send.
        const qid=(saved&&saved.id)||id;
        const q=await db.quotes.get(qid);
        Modal.close(); await this.render();
        _cpSms(q.customerPhone, this._smsBody(q), q.customerId);
        q.smsSentAt=new Date().toISOString();
        try{ await db.quotes.save({id:qid, smsSentAt:q.smsSentAt}); }catch(err){}
        return;
      }
      if(sendVia==='email'){
        const qid=(saved&&saved.id)||id;
        // apiFetch throws on non-2xx — the quote is already saved by then, so
        // report a send failure as exactly that, not "could not save".
        let r; try{ r=await db.quotes.sendEmail(qid); }
        catch(err){ r={ok:false,error:err.message}; }
        Modal.close(); await this.render();
        toast(r&&r.ok?'Estimate saved & emailed ✓':`Saved, but email failed: ${(r&&r.error)||'unknown error'}`, r&&r.ok?'success':'error');
        return;
      }
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
        ${this._isFleet(q)?`<div style="font-size:13px;color:var(--muted);margin-top:3px;">🚚 ${esc(q.fleetName||'Fleet')}${q.vehicleCount?` · ${q.vehicleCount} vehicles`:''} · ${q.contract?`${this._freqLabel(q.contract.frequency)} · ${q.contract.termMonths}-month term`:'One-time job'}</div>`:''}
        ${q.vehicle&&(q.vehicle.make||q.vehicle.model)?`<div style="font-size:13px;color:var(--muted);margin-top:3px;">🚗 ${esc([q.vehicle.year,q.vehicle.make,q.vehicle.model,q.vehicle.color].filter(Boolean).join(' '))}</div>`:''}
        <div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${this._badge(q.status)} ${q.depositPaid?'<span class="badge badge-green">Deposit paid</span>':''}${this._openTag(q)}</div>
        ${q.emailSentAt?`<div style="font-size:12px;color:var(--faint);margin-top:6px;">${q.emailOpenedAt?'Customer opened the email':'Emailed — not opened yet'}${(q.reminderCount||0)>0?` · ${q.reminderCount} reminder${q.reminderCount>1?'s':''} sent`:''}</div>`:''}
        ${q.smsSentAt?`<div style="font-size:12px;color:var(--faint);margin-top:6px;">📱 Texted ${(()=>{try{return new Date(q.smsSentAt).toLocaleDateString(undefined,{month:'short',day:'numeric'});}catch(e){return '';}})()}</div>`:''}
        ${q.viewedAt?`<div style="font-size:12px;color:var(--green);margin-top:6px;">👁 Opened the estimate page${q.viewCount>1?` ${q.viewCount}×`:''}${(()=>{try{return ' — first '+new Date(q.viewedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})+(q.lastViewedAt&&q.lastViewedAt!==q.viewedAt?', last '+new Date(q.lastViewedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'');}catch(e){return '';}})()}</div>`:''}
        ${this.isClosed(q.status)?`<div style="font-size:12px;color:var(--faint);margin-top:6px;">Closed out as ${esc((this.STATUS_META[q.status]||{}).label||q.status).toLowerCase()}${(()=>{const d=q.completedAt||q.lostAt||q.declinedAt;try{return d?' · '+new Date(d).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'';}catch(e){return '';}})()}</div>`:''}
      </div>
      ${q.options&&q.options.length&&!q.chosenOptionId?`<div class="list-card" style="margin-bottom:14px;">
        ${q.options.map(o=>`<div class="list-row"><div class="list-main"><div class="list-name" style="font-size:14px;">⚖️ ${esc(o.name)}${o.recommended?' <span style="font-size:10px;color:var(--green);font-weight:700;">★ RECOMMENDED</span>':''}</div><div class="list-sub">${esc((o.benefits||[]).slice(0,2).join(' · '))}${(o.benefits||[]).length>2?' · …':''}</div></div><div style="font-weight:700;">${fmtMoney(o.price)}</div></div>`).join('')}
        <div class="list-row"><div class="list-main"><div class="list-name" style="font-size:12px;color:var(--faint);">Customer picks one on the page — starting at</div></div><div style="font-weight:800;color:var(--green);">${fmtMoney(q.total)}</div></div>
      </div>`:''}
      <div class="list-card" style="margin-bottom:14px;${q.options&&q.options.length&&!q.chosenOptionId?'display:none;':''}">
        ${q.chosenOptionId&&q.options?`<div class="list-row"><div class="list-main"><div class="list-name" style="font-size:12px;color:var(--green);font-weight:700;">✓ Customer chose ${esc((q.options.find(o=>o.id===q.chosenOptionId)||{}).name||'an option')}</div></div></div>`:''}
        ${(q.lineItems||[]).map(l=>{const n=Number(l.qty)||1;return `<div class="list-row"><div class="list-main"><div class="list-name" style="font-size:14px;">${esc(l.name)}</div>${n>1?`<div class="list-sub">${n} × ${fmtMoney(l.price)}</div>`:''}</div><div style="font-weight:700;">${fmtMoney(l.price*n)}</div></div>`;}).join('')}
        ${(q.taxAmount||q.discountAmount)?`<div class="list-row"><div class="list-main"><div class="list-name" style="font-size:13px;color:var(--muted);">Subtotal</div></div><div style="color:var(--muted);">${fmtMoney(q.subtotal)}</div></div>`:''}
        ${q.discountAmount?`<div class="list-row"><div class="list-main"><div class="list-name" style="font-size:13px;color:var(--green);font-weight:600;">Discount (${q.discountPercent}%)</div></div><div style="color:var(--green);font-weight:600;">−${fmtMoney(q.discountAmount)}</div></div>`:''}
        ${q.taxAmount?`<div class="list-row"><div class="list-main"><div class="list-name" style="font-size:13px;color:var(--muted);">${esc(q.taxLabel||'Sales Tax')} (${q.taxRate}%)</div></div><div style="color:var(--muted);">${fmtMoney(q.taxAmount)}</div></div>`:''}
        <div class="list-row"><div class="list-main"><div class="list-name" style="font-weight:800;">${q.contract?'Per visit':'Total'}</div></div><div style="font-weight:800;color:var(--green);">${fmtMoney(q.total)}</div></div>
        ${q.contract?`<div class="list-row"><div class="list-main"><div class="list-name" style="font-weight:800;">Monthly</div><div class="list-sub">${this._freqLabel(q.contract.frequency)}</div></div><div style="font-weight:800;color:var(--green);">${fmtMoney(q.monthlyTotal)}</div></div>
        <div class="list-row"><div class="list-main"><div class="list-name" style="font-size:13px;color:var(--muted);">Contract value (${q.contract.termMonths} mo)</div></div><div style="color:var(--muted);">${fmtMoney(q.contractValue)}</div></div>`:''}
      </div>
      ${q.notes?`<div style="font-size:13px;color:var(--muted);margin-bottom:14px;">${esc(q.notes)}</div>`:''}
      <div class="modal-actions">
        <button class="btn btn-full" onclick="navigator.clipboard.writeText('${link}');toast('Link copied ✓')">🔗 Copy estimate link</button>
        ${q.customerEmail?`<button class="btn btn-full" onclick="Quotes.sendEmail('${q.id}')">✉️ Email to customer</button>`:''}
        ${(q.customerPhone||q.customerId)?`<button class="btn btn-full" onclick="Quotes.sendLink('${q.id}')">📱 Text to customer</button>`:''}
        ${q.status==='approved'?`<button class="btn btn-green btn-full" onclick="Quotes.schedule('${q.id}')">📅 Schedule appointment</button>`:''}
        ${q.status==='sent'?`<button class="btn btn-full" onclick="Quotes.mark('${q.id}','approved')">Mark approved</button>`:''}
        ${canWrite()&&!this.isClosed(q.status)?`<button class="btn btn-green btn-full" onclick="Quotes.mark('${q.id}','completed')">✓ Close out — completed</button>`:''}
        ${canWrite()&&!this.isClosed(q.status)?`<button class="btn btn-full" onclick="Quotes.mark('${q.id}','lost')">✕ Close out — lost</button>`:''}
        ${canWrite()&&this.isClosed(q.status)?`<button class="btn btn-full" onclick="Quotes.reopen('${q.id}')">↩ Reopen estimate</button>`:''}
        ${canWrite()?`<button class="btn btn-full" onclick="Quotes.openForm('${q.id}')">Edit</button>`:''}
        ${canWrite()?`<button class="btn btn-danger btn-full" onclick="Quotes.delete('${q.id}')">Delete</button>`:''}
        <button class="btn btn-full" onclick="Modal.close()">Close</button>
      </div>`);
  },

  // Prefilled estimate text (same copy the server-side sender uses).
  _smsBody(q){
    const link=location.origin+'/quote/'+Auth.getShopSlug()+'/'+q.id;
    // Two-option estimates lead with the starting-at price and invite the pick;
    // a contract's headline number is the monthly, not the single visit.
    if(q.options&&q.options.length&&!q.chosenOptionId){
      return `Hi ${(q.customerName||'there').split(' ')[0]}! Here are your options from ${Auth.getShopName()||'us'} (${q.number||''}) — starting at $${q.total}. Compare & approve: ${link}`;
    }
    const amount=q.contract?`$${q.monthlyTotal}/mo`:`$${q.total}`;
    return `Hi ${(q.customerName||'there').split(' ')[0]}! Here's your estimate from ${Auth.getShopName()||'us'} (${q.number||''}) — ${amount}. View & approve: ${link}`;
  },
  // Manual send: pull up the owner's Messages app prefilled (iPhone sms: deep
  // link via _cpSms — no Twilio/A2P; same stance as Tasks/Messages/Response).
  async sendLink(id){
    const q=this._data.find(x=>x.id===id); if(!q)return;
    const phone=q.customerPhone||'';
    if(phone.replace(/\D/g,'').length<10){toast('No phone number on this estimate','warning');return;}
    _cpSms(phone, this._smsBody(q), q.customerId);
    q.smsSentAt=new Date().toISOString();
    try{ await db.quotes.save({id:q.id, smsSentAt:q.smsSentAt}); }catch(e){}
  },
  async sendEmail(id){
    try{ const r=await db.quotes.sendEmail(id); if(r&&r.ok){toast('Estimate emailed ✓'); const q=this._data.find(x=>x.id===id); if(q&&!q.emailSentAt)q.emailSentAt=new Date().toISOString();} else {toast((r&&r.error)||'Could not send','error');} }
    catch(e){ toast(e.message||'Could not send','error'); }
  },
  async mark(id, status){
    const lb=(this.STATUS_META[status]||{}).label||status;
    try{ await db.quotes.save({id,status}); Modal.close(); toast('Marked '+lb.toLowerCase()+' ✓'); await this.render(); }
    catch(e){ toast('Could not update','error'); }
  },
  // Undo a close-out: back to where the estimate actually got to, so a mis-click
  // doesn't dump a scheduled job back into "Sent".
  async reopen(id){
    const q=this._data.find(x=>x.id===id); if(!q)return;
    const status = (q.appointmentId || q.scheduledAt) ? 'scheduled' : (q.approvedAt ? 'approved' : 'sent');
    try{ await db.quotes.save({id,status}); Modal.close(); toast('Estimate reopened ✓'); await this.render(); }
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

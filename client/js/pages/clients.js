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
          html.push(`<div class="list-row" onclick="ClientProfile.open('${c.id}')">
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

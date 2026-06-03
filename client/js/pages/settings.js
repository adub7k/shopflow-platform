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
      const shopSlug = Auth.getShopSlug();
      const bookUrl = location.origin+'/book/'+(shopSlug||'');
      html.push(`<div style="background:var(--green-lt);border:1px solid var(--green-md);border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <span>Your booking link: <strong><a href="${bookUrl}" target="_blank" style="color:var(--green);">${bookUrl}</a></strong></span>
        <button onclick="navigator.clipboard.writeText('${bookUrl}');toast('Link copied ✓')" style="background:var(--green);color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">Copy Link</button>
      </div>`);
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

      // SMS — status + customizable templates
      html.push('<div class="section-header">SMS Messaging</div><div class="card">');
      const smsActive = s.twilioConfigured;
      html.push(`<div style="display:flex;align-items:center;gap:10px;padding:4px 0 14px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${smsActive?'#16a34a':'#d1d5db'};flex-shrink:0;"></div>
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--text);">${smsActive?'SMS Active':'SMS Not Yet Active'}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${smsActive?'Reminders and confirmations are firing automatically.':'Managed by ShopFlow. Contact support to activate.'}</div>
        </div>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.04em;margin-bottom:8px;">CUSTOMIZE YOUR MESSAGES</div>
      <div style="font-size:11px;color:var(--faint);margin-bottom:12px;">Variables you can use: <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{name}</code> <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{shop}</code> <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{date}</code> <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{time}</code> <code style="background:var(--off);padding:1px 5px;border-radius:4px;">{barber}</code></div>`);
      const tpl = s.smsTemplates || {};
      const defConfirm = "Hi {name}! Your appointment at {shop} is confirmed for {date} at {time}{barber}. See you then! ✂️";
      const defReminder = "Hi {name}! Reminder: your appointment at {shop} is tomorrow at {time}{barber}. See you then! ✂️";
      const defRebook   = "Hey {name}! It's been a few weeks — we'd love to have you back at {shop}. Book your next cut anytime 💈";
      html.push(`<div class="form-group"><label class="form-label">Booking Confirmation</label><textarea class="form-input" id="s-tpl-confirm" rows="2" placeholder="${defConfirm}">${tpl.confirmation||''}</textarea></div>`);
      html.push(`<div class="form-group"><label class="form-label">24-Hour Reminder</label><textarea class="form-input" id="s-tpl-reminder" rows="2" placeholder="${defReminder}">${tpl.reminder||''}</textarea></div>`);
      const rebookDays = s.rebookInterval || 21;
      html.push(`<div class="form-group"><label class="form-label">Rebook Nudge — Days Since Last Visit</label><div style="display:flex;align-items:center;gap:10px;"><input class="form-input" id="s-rebook-days" type="number" min="7" max="90" value="${rebookDays}" style="width:90px;" /><span style="font-size:13px;color:var(--muted);">days after last visit</span></div></div>`);
      html.push(`<div class="form-group"><label class="form-label">Rebook Nudge Message</label><textarea class="form-input" id="s-tpl-rebook" rows="2" placeholder="${defRebook}">${tpl.rebook||''}</textarea></div>`);
      html.push(`<div style="font-size:11px;color:var(--faint);">Leave message blank to use the default shown as placeholder.</div>`);
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
      try { stripeStatus = await db.stripe.status(); } catch(e) {}
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

      html.push('<div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-primary" style="flex:1;" onclick="Settings.save()">Save Settings</button><button class="btn btn-danger" onclick="Auth.logout()">Sign Out</button></div>');
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
      const data = await db.stripe.onboard();
      if (data.ok && data.url) { window.location.href = data.url; }
      else { toast(data.error||'Could not connect Stripe. Make sure STRIPE_SECRET_KEY is set in Railway.','error'); if(btn){btn.textContent='Connect Stripe Account';btn.disabled=false;} }
    } catch(e) { toast('Error connecting Stripe','error'); if(btn){btn.textContent='Connect Stripe Account';btn.disabled=false;} }
  },

  async disconnectStripe() {
    if (!confirm('Disconnect Stripe? Card payments and deposits will stop working.')) return;
    await db.stripe.disconnect();
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
    // SMS templates (empty string = use server default)
    const tc=document.getElementById('s-tpl-confirm')?.value.trim();
    const tr=document.getElementById('s-tpl-reminder')?.value.trim();
    const tk=document.getElementById('s-tpl-rebook')?.value.trim();
    data.smsTemplates={ confirmation:tc||'', reminder:tr||'', rebook:tk||'' };
    const rd=parseInt(document.getElementById('s-rebook-days')?.value)||21;
    data.rebookInterval=Math.min(90,Math.max(7,rd));
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

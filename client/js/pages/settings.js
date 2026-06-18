// ── Settings ──────────────────────────────────────────────────────────────────
const Settings = {
  _barbers: [], _services: [], _staff: [],

  async render() {
    const el=document.getElementById('page-settings'); if(!el)return;
    try{
      const [s,barbers,services,staff]=await Promise.all([db.settings.get(),db.barbers.all(),db.services.all(),db.staff.all().catch(()=>[])]);
      this._barbers=barbers; this._services=services; this._staff=staff; this._addons=s.addons||[]; this._plans=s.membershipPlans||[];
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
      html.push(`<div class="form-group"><label class="form-label"><input type="checkbox" id="s-staffpicker" ${s.staffPicker!==false?'checked':''} style="margin-right:6px;" /> Let customers choose their ${esc(V('staff','barber').toLowerCase())} when booking</label></div>`);
      // Inspiration photo at booking
      const inspoMode = s.inspoPhoto || 'off';
      html.push(`<div class="form-group"><label class="form-label">Inspiration Photo</label>
        <select class="form-input" id="s-inspo">
          <option value="off"${inspoMode==='off'?' selected':''}>Off — don't ask for a photo</option>
          <option value="optional"${inspoMode==='optional'?' selected':''}>Optional — clients can attach one</option>
          <option value="required"${inspoMode==='required'?' selected':''}>Required — must attach to book</option>
        </select>
        <div style="font-size:11px;color:var(--muted);margin-top:6px;">Let clients send a reference photo when they book, so you know the look before they arrive.</div>
      </div>`);
      html.push('</div>');

      // Work Gallery — showcased at the top of the booking page
      const gallery = Array.isArray(s.gallery) ? s.gallery : [];
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Work Gallery</span><button class="btn btn-sm btn-green" onclick="Settings.galleryPick()">+ Add Photo</button></div>');
      html.push('<div class="card">');
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:'+(gallery.length?'12px':'0')+';">Showcase your best work on your booking page. Photos appear at the top for clients to browse.</div>');
      if (gallery.length) {
        html.push('<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">');
        gallery.forEach(g=>{
          html.push(`<div style="position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--off);">
            <img src="${esc(g.url)}" style="width:100%;height:100%;object-fit:cover;" />
            <button onclick="Settings.galleryRemove('${g.id}')" title="Remove" style="position:absolute;top:5px;right:5px;width:24px;height:24px;border:none;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:13px;cursor:pointer;line-height:1;">×</button>
          </div>`);
        });
        html.push('</div>');
      }
      html.push('</div>');
      html.push('<input type="file" id="s-gallery-file" accept="image/*" style="display:none;" onchange="Settings.galleryUpload(this)" />');

      // Barbers (labelled per industry vocabulary)
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>'+esc(V('staffPlural','Barbers'))+'</span><button class="btn btn-sm btn-green" onclick="Settings.openBarber(null)">+ Add</button></div>');
      barbers.forEach(b=>{
        html.push(`<div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;border-left:4px solid ${b.color||'var(--green)}'};">
          <div style="width:40px;height:40px;border-radius:50%;background:${b.color||'var(--green)'}22;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:${b.color||'var(--green)'};">${initials(b.name)}</div>
          <div style="flex:1;"><div style="font-size:14px;font-weight:700;">${b.name}</div><div style="font-size:12px;color:var(--muted);">${esc(V('station','Chair'))} ${b.chair}${b.bio?' · '+b.bio:''}</div></div>
          <button class="btn btn-sm" onclick="Settings.openBarber('${b.id}')">Edit</button>
        </div>`);
      });

      // Staff & Access (multi-user roles)
      const roleLabels={full:'Full Access',technician:V('staff','Technician'),viewonly:'View Only'};
      const roleColors={full:'#16a34a',technician:'#2563eb',viewonly:'#6e6e73'};
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Staff &amp; Access</span><button class="btn btn-sm btn-green" onclick="Settings.openStaff(null)">+ Add</button></div>');
      html.push('<div style="font-size:12px;color:var(--muted);margin:-6px 0 10px;">Each staff member logs in with their own email and password. Full Access sees everything · '+esc(V('staff','Technician'))+' sees appointments &amp; clients (no revenue or settings) · View Only sees the calendar.</div>');
      staff.forEach(u=>{
        html.push(`<div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          <div style="width:40px;height:40px;border-radius:50%;background:${roleColors[u.role]||'#6e6e73'}22;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:${roleColors[u.role]||'#6e6e73'};">${initials(u.name||u.email)}</div>
          <div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:700;">${esc(u.name||'—')}${u.isOwner?' <span style="font-size:10px;color:var(--faint);font-weight:600;">(owner)</span>':''}</div><div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(u.email)}</div></div>
          <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;background:${roleColors[u.role]||'#6e6e73'}1a;color:${roleColors[u.role]||'#6e6e73'};white-space:nowrap;">${roleLabels[u.role]||u.role}</span>
          <button class="btn btn-sm" onclick="Settings.openStaff('${u.id}')">Edit</button>
        </div>`);
      });

      // Services
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Services</span><button class="btn btn-sm btn-green" onclick="Settings.openService(null)">+ Add</button></div>');
      html.push('<div class="list-card">');
      services.forEach(s=>{
        const bySize = s.sizePricing && Object.keys(s.sizePricing).length;
        html.push(`<div class="list-row"><div class="list-main"><div class="list-name">${s.name}</div><div class="list-sub">${s.category} · ${s.duration} min${bySize?' · by size':''}</div></div><div style="font-weight:700;color:var(--green);margin-right:8px;">${bySize?'from ':''}${fmtMoney(s.price)}</div><button class="btn btn-sm" onclick="Settings.openService('${s.id}')">Edit</button></div>`);
      });
      html.push('</div>');

      // Add-ons (à-la-carte upsells tacked onto any job)
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Add-ons</span><button class="btn btn-sm btn-green" onclick="Settings.openAddon(null)">+ Add</button></div>');
      const addons = s.addons || [];
      if (!addons.length) {
        html.push('<div class="card"><div style="font-size:13px;color:var(--faint);text-align:center;padding:12px 0;">No add-ons yet — extras like Pet Hair, Odor Removal, or Engine Bay that staff and customers can tack onto a job.</div></div>');
      } else {
        html.push('<div class="list-card">');
        addons.forEach(ad=>{
          html.push(`<div class="list-row"><div class="list-main"><div class="list-name">${esc(ad.name)}</div></div><div style="font-weight:700;color:var(--green);margin-right:8px;">+${fmtMoney(ad.price)}</div><button class="btn btn-sm" onclick="Settings.openAddon('${ad.id}')">Edit</button></div>`);
        });
        html.push('</div>');
      }

      // Membership plans (recurring wash-club / maintenance)
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Membership Plans</span><button class="btn btn-sm btn-green" onclick="Settings.openPlan(null)">+ Add</button></div>');
      const plans = s.membershipPlans || [];
      if (!plans.length) {
        html.push('<div class="card"><div style="font-size:13px;color:var(--faint);text-align:center;padding:12px 0;">No plans yet — recurring plans like a monthly wash club or quarterly maintenance detail. Enroll customers from their profile.</div></div>');
      } else {
        html.push('<div class="list-card">');
        plans.forEach(p=>{
          html.push(`<div class="list-row"><div class="list-main"><div class="list-name">${esc(p.name)}</div><div class="list-sub">${esc(p.perks||'')}</div></div><div style="font-weight:700;color:var(--green);margin-right:8px;">${fmtMoney(p.price)}/${p.interval==='year'?'yr':'mo'}</div><button class="btn btn-sm" onclick="Settings.openPlan('${p.id}')">Edit</button></div>`);
        });
        html.push('</div>');
      }

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
    const pickOpts=timeOpts.map(t=>`<option value="${t}"${t==='10:00 AM'?' selected':''}>${t}</option>`).join('');
    const allowed=Array.isArray(sched.allowedTimes)?sched.allowedTimes:[];
    const customOn=allowed.length>0;
    Modal.show(`
      <div class="modal-title">${b?'Edit '+esc(V('staff','Barber')):'Add '+esc(V('staff','Barber'))}</div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fb-name" value="${b?.name||''}" placeholder="e.g. Chris" /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">${esc(V('station','Chair'))} #</label><input class="form-input" id="fb-chair" type="number" value="${b?.chair||this._barbers.length+1}" min="1" /></div>
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
        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="fb-customtimes" ${customOn?'checked':''} onchange="Settings._toggleCustomTimes()" style="width:auto;margin:0;" />
            Only offer specific times
          </label>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">Take bookings at set times only — e.g. 10:00 AM &amp; 2:00 PM — instead of every slot in a range.</div>
        </div>
        <div id="fb-range-fields" style="${customOn?'display:none;':''}">
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
        <div id="fb-customtimes-wrap" style="${customOn?'':'display:none;'}">
          <label class="form-label">Available times</label>
          <div id="fb-times-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>
          <div style="display:flex;gap:8px;">
            <select class="form-input" id="fb-time-pick" style="flex:1;">${pickOpts}</select>
            <button type="button" class="btn" onclick="Settings._addTime()">+ Add</button>
          </div>
          <input type="hidden" id="fb-allowedtimes" value='${JSON.stringify(allowed)}' />
        </div>
      </div>

      <div class="modal-actions">
        ${b?`<button class="btn btn-danger btn-full" onclick="Settings.deleteBarber('${b.id}')">Remove ${esc(V('staff','Barber'))}</button>`:''}
        <button id="fb-btn" class="btn btn-primary btn-full" onclick="Settings.saveBarber('${b?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>{document.getElementById('fb-name')?.focus();Settings._renderTimeChips();},150);
  },

  _toggleCustomTimes() {
    const on = document.getElementById('fb-customtimes')?.checked;
    const range = document.getElementById('fb-range-fields');
    const custom = document.getElementById('fb-customtimes-wrap');
    if (range) range.style.display = on ? 'none' : '';
    if (custom) custom.style.display = on ? '' : 'none';
  },
  _parseTime(t){ const [tm,ap]=t.split(' ');let[h,m]=tm.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+m; },
  _getTimes(){ try{return JSON.parse(document.getElementById('fb-allowedtimes')?.value||'[]');}catch(e){return [];} },
  _setTimes(arr){ arr.sort((a,b)=>this._parseTime(a)-this._parseTime(b)); const el=document.getElementById('fb-allowedtimes'); if(el)el.value=JSON.stringify(arr); this._renderTimeChips(); },
  _addTime(){ const t=document.getElementById('fb-time-pick')?.value; if(!t)return; const arr=this._getTimes(); if(!arr.includes(t))arr.push(t); this._setTimes(arr); },
  _removeTime(t){ this._setTimes(this._getTimes().filter(x=>x!==t)); },
  _renderTimeChips(){
    const wrap=document.getElementById('fb-times-chips'); if(!wrap)return;
    const arr=this._getTimes();
    wrap.innerHTML = arr.length
      ? arr.map(t=>`<span style="display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:100px;padding:5px 12px;font-size:13px;font-weight:600;color:var(--text);">${t}<span onclick="Settings._removeTime('${t}')" style="cursor:pointer;font-weight:700;opacity:.55;">✕</span></span>`).join('')
      : '<span style="font-size:12px;color:var(--muted);">No times yet — add at least one above.</span>';
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
    // Specific-times mode: offer ONLY the listed times on working days.
    if (document.getElementById('fb-customtimes')?.checked) {
      const times = this._getTimes();
      if (!times.length) { toast('Add at least one time, or turn off specific times','warning'); enableBtn(btn); return; }
      schedule.allowedTimes = times;
    }
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
      Modal.close(); toast(id?'Updated ✓':V('staff','Barber')+' added ✓'); this.render();
    }catch(e){toast('Could not save','error');enableBtn(btn);}
  },

  async deleteBarber(id) {
    if(!confirm('Remove this '+V('staff','barber').toLowerCase()+'?'))return;
    await db.barbers.delete(id); Modal.close(); this.render(); toast('Removed');
  },

  // ── Staff & Access ──────────────────────────────────────────────────────────
  openStaff(id) {
    const u = id ? this._staff.find(x=>x.id===id) : null;
    const isOwner = !!u?.isOwner;
    const roles = [
      ['full','Full Access — sees everything'],
      ['technician', V('staff','Technician')+' — appointments & clients only'],
      ['viewonly','View Only — calendar only'],
    ];
    Modal.show(`
      <div class="modal-title">${u?'Edit Staff':'Add Staff'}</div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fu-name" value="${esc(u?.name||'')}" placeholder="e.g. Marcus Reyes" /></div>
      <div class="form-group"><label class="form-label">Email *</label><input class="form-input" id="fu-email" type="email" value="${esc(u?.email||'')}" placeholder="them@email.com" /></div>
      <div class="form-group"><label class="form-label">Password ${u?'<span style="font-weight:400;color:var(--faint);">(leave blank to keep current)</span>':'*'}</label><input class="form-input" id="fu-pass" type="password" placeholder="At least 6 characters" autocomplete="new-password" /></div>
      ${isOwner
        ? '<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">This is the owner account — it always has Full Access.</div>'
        : `<div class="form-group"><label class="form-label">Role</label><select class="form-input" id="fu-role">${roles.map(([v,l])=>`<option value="${v}"${u?.role===v?' selected':''}>${esc(l)}</option>`).join('')}</select></div>`}
      <div class="modal-actions">
        ${u&&!isOwner?`<button class="btn btn-danger btn-full" onclick="Settings.deleteStaff('${u.id}')">Remove Staff</button>`:''}
        <button id="fu-btn" class="btn btn-primary btn-full" onclick="Settings.saveStaff('${u?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('fu-name')?.focus(),150);
  },

  async saveStaff(id) {
    const name  = document.getElementById('fu-name')?.value.trim();
    const email = document.getElementById('fu-email')?.value.trim();
    const pass  = document.getElementById('fu-pass')?.value||'';
    const role  = document.getElementById('fu-role')?.value||'technician';
    if(!name){toast('Enter a name','warning');return;}
    if(!email){toast('Enter an email','warning');return;}
    if(!id && pass.length<6){toast('Set a password of 6+ characters','warning');return;}
    const btn=document.getElementById('fu-btn'); disableBtn(btn);
    try{
      const body={name,email,role}; if(id)body.id=id; if(pass)body.password=pass;
      await db.staff.save(body);
      Modal.close(); toast(id?'Updated ✓':'Staff added ✓'); this.render();
    }catch(e){toast(e.message||'Could not save','error');enableBtn(btn);}
  },

  async deleteStaff(id) {
    if(!confirm('Remove this staff member? They will no longer be able to log in.'))return;
    try{ await db.staff.delete(id); Modal.close(); toast('Removed'); this.render(); }
    catch(e){ toast(e.message||'Could not remove','error'); }
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
      ${(Shop.sizes||[]).length?`<div class="form-group" style="border:1px solid var(--border);border-radius:10px;padding:12px;">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;margin:0;">
          <input type="checkbox" id="fs-size-on" ${s?.sizePricing?'checked':''} onchange="Settings._toggleSizePricing()" /> Price by vehicle size
        </label>
        <div style="font-size:11px;color:var(--faint);margin-top:4px;">Charge more for larger vehicles. Leave a box blank to use the base price above.</div>
        <div id="fs-size-rows" style="margin-top:10px;grid-template-columns:1fr 1fr;gap:8px;display:${s?.sizePricing?'grid':'none'};">
          ${Shop.sizes.map(sz=>`<div class="form-group" style="margin:0;"><label class="form-label">${esc(sz.label)}</label><input class="form-input" id="fs-size-${esc(sz.key)}" type="number" value="${s&&s.sizePricing&&s.sizePricing[sz.key]!=null?s.sizePricing[sz.key]:''}" placeholder="$" /></div>`).join('')}
        </div>
      </div>`:''}
      <div class="form-group"><label class="form-label">Category</label>
        <select class="form-input" id="fs-cat">
          ${((Shop.serviceCategories&&Shop.serviceCategories.length?Shop.serviceCategories:['cut','beard','combo','color','design','other'])).map(c=>`<option value="${c}"${s?.category===c?' selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        ${s?`<button class="btn btn-danger btn-full" onclick="Settings.deleteService('${s.id}')">Delete</button>`:''}
        <button id="fs-btn" class="btn btn-primary btn-full" onclick="Settings.saveService('${s?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('fs-name')?.focus(),150);
  },

  _toggleSizePricing(){
    const on=document.getElementById('fs-size-on')?.checked;
    const rows=document.getElementById('fs-size-rows'); if(rows)rows.style.display=on?'grid':'none';
  },

  openAddon(id){
    const ad=id?(this._addons||[]).find(x=>x.id===id):null;
    Modal.show(`
      <div class="modal-title">${ad?'Edit Add-on':'Add Add-on'}</div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fad-name" value="${esc(ad?.name||'')}" placeholder="e.g. Pet Hair Removal" /></div>
      <div class="form-group"><label class="form-label">Price</label><input class="form-input" id="fad-price" type="number" value="${ad?(ad.price):25}" /></div>
      <div class="modal-actions">
        ${ad?`<button class="btn btn-danger btn-full" onclick="Settings.deleteAddon('${ad.id}')">Delete</button>`:''}
        <button id="fad-btn" class="btn btn-primary btn-full" onclick="Settings.saveAddon('${ad?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('fad-name')?.focus(),150);
  },

  async saveAddon(id){
    const name=document.getElementById('fad-name')?.value.trim();
    if(!name){toast('Enter a name','warning');return;}
    const price=parseFloat(document.getElementById('fad-price')?.value)||0;
    const btn=document.getElementById('fad-btn'); disableBtn(btn);
    const list=[...(this._addons||[])];
    if(id){ const i=list.findIndex(a=>a.id===id); if(i>=0) list[i]={...list[i],name,price}; }
    else list.push({id:genId('ad'),name,price});
    try{ await db.settings.save({addons:list}); this._addons=list; Shop.addons=list; Modal.close(); toast(id?'Updated ✓':'Add-on added ✓'); this.render(); }
    catch(e){ toast('Could not save','error'); enableBtn(btn); }
  },

  async deleteAddon(id){
    if(!confirm('Delete this add-on?'))return;
    const list=(this._addons||[]).filter(a=>a.id!==id);
    try{ await db.settings.save({addons:list}); this._addons=list; Shop.addons=list; Modal.close(); this.render(); toast('Deleted'); }
    catch(e){ toast('Could not delete','error'); }
  },

  openPlan(id){
    const p=id?(this._plans||[]).find(x=>x.id===id):null;
    Modal.show(`
      <div class="modal-title">${p?'Edit Plan':'Add Membership Plan'}</div>
      <div class="form-group"><label class="form-label">Plan name *</label><input class="form-input" id="fp-name" value="${esc(p?.name||'')}" placeholder="e.g. Monthly Wash Club" /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Price</label><input class="form-input" id="fp-price" type="number" value="${p?(p.price):49}" /></div>
        <div class="form-group"><label class="form-label">Billing</label><select class="form-input" id="fp-interval"><option value="month"${(!p||p.interval==='month')?' selected':''}>Monthly</option><option value="year"${p&&p.interval==='year'?' selected':''}>Yearly</option></select></div>
      </div>
      <div class="form-group"><label class="form-label">Perks <span style="font-weight:400;color:var(--faint);">(shown to staff)</span></label><input class="form-input" id="fp-perks" value="${esc(p?.perks||'')}" placeholder="e.g. 2 washes/mo + 10% off details" /></div>
      <div class="modal-actions">
        ${p?`<button class="btn btn-danger btn-full" onclick="Settings.deletePlan('${p.id}')">Delete</button>`:''}
        <button id="fp-btn" class="btn btn-primary btn-full" onclick="Settings.savePlan('${p?.id||''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('fp-name')?.focus(),150);
  },

  async savePlan(id){
    const name=document.getElementById('fp-name')?.value.trim();
    if(!name){toast('Enter a plan name','warning');return;}
    const price=parseFloat(document.getElementById('fp-price')?.value)||0;
    const interval=document.getElementById('fp-interval')?.value||'month';
    const perks=document.getElementById('fp-perks')?.value.trim()||'';
    const btn=document.getElementById('fp-btn'); disableBtn(btn);
    const list=[...(this._plans||[])];
    if(id){ const i=list.findIndex(p=>p.id===id); if(i>=0) list[i]={...list[i],name,price,interval,perks}; }
    else list.push({id:genId('plan'),name,price,interval,perks});
    try{ await db.settings.save({membershipPlans:list}); this._plans=list; Shop.membershipPlans=list; Modal.close(); toast(id?'Updated ✓':'Plan added ✓'); this.render(); }
    catch(e){ toast('Could not save','error'); enableBtn(btn); }
  },

  async deletePlan(id){
    if(!confirm('Delete this plan?'))return;
    const list=(this._plans||[]).filter(p=>p.id!==id);
    try{ await db.settings.save({membershipPlans:list}); this._plans=list; Shop.membershipPlans=list; Modal.close(); this.render(); toast('Deleted'); }
    catch(e){ toast('Could not delete','error'); }
  },

  async saveService(id) {
    const name=document.getElementById('fs-name')?.value.trim();
    if(!name){toast('Enter a name','warning');return;}
    const btn=document.getElementById('fs-btn'); disableBtn(btn);
    // Optional per-vehicle-size pricing (detail shops). When on, the base price
    // mirrors the first size tier so revenue/fallback math stays sensible.
    const sizeOn=document.getElementById('fs-size-on')?.checked;
    let sizePricing=null;
    if(sizeOn){
      sizePricing={};
      (Shop.sizes||[]).forEach(sz=>{const v=parseFloat(document.getElementById('fs-size-'+sz.key)?.value);if(!isNaN(v))sizePricing[sz.key]=v;});
    }
    const firstKey=(Shop.sizes||[])[0]?.key;
    const basePrice=(sizeOn&&firstKey&&sizePricing[firstKey]!=null)?sizePricing[firstKey]:(parseFloat(document.getElementById('fs-price')?.value)||35);
    try{
      await db.services.save({id:id||genId('s'),name,price:basePrice,duration:parseInt(document.getElementById('fs-dur')?.value)||45,category:document.getElementById('fs-cat')?.value||'cut',sizePricing:sizeOn?sizePricing:null});
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
    const data={shopName:document.getElementById('s-name')?.value.trim(),tagline:document.getElementById('s-tag')?.value.trim(),phone:document.getElementById('s-phone')?.value.trim(),address:document.getElementById('s-addr')?.value.trim(),email:document.getElementById('s-email')?.value.trim(),bookingMessage:document.getElementById('s-bmsg')?.value.trim(),bookingEnabled:document.getElementById('s-benabled')?.checked!==false,staffPicker:document.getElementById('s-staffpicker')?.checked!==false};
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
    const inspo=document.getElementById('s-inspo')?.value; if(inspo)data.inspoPhoto=inspo;
    await db.settings.save(data);
    const title=document.getElementById('topbar-title'); if(title)title.textContent=data.shopName||'ShopFlow';
    toast('Settings saved ✓');
  },

  // ── Work gallery ────────────────────────────────────────────────────────────
  galleryPick(){ document.getElementById('s-gallery-file')?.click(); },
  async galleryUpload(input){
    const file=input.files&&input.files[0]; if(!file) return;
    input.value='';
    try{
      toast('Uploading photo…');
      const dataUrl=await Settings._downscale(file,1280,.82);
      await db.gallery.add(dataUrl,'');
      toast('Added to gallery ✓');
      this.render();
    }catch(e){ toast(e.message||'Upload failed','error'); }
  },
  async galleryRemove(id){
    if(!confirm('Remove this photo from your gallery?')) return;
    try{ await db.gallery.remove(id); toast('Removed'); this.render(); }
    catch(e){ toast('Could not remove','error'); }
  },
  _downscale(file,maxDim,quality){
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>{ const img=new Image(); img.onload=()=>{
        let w=img.width,h=img.height; const sc=Math.min(1,maxDim/Math.max(w,h));
        const cw=Math.max(1,Math.round(w*sc)),ch=Math.max(1,Math.round(h*sc));
        const c=document.createElement('canvas'); c.width=cw; c.height=ch;
        c.getContext('2d').drawImage(img,0,0,cw,ch);
        resolve(c.toDataURL('image/jpeg',quality));
      }; img.onerror=()=>reject(new Error('Invalid image')); img.src=reader.result; };
      reader.onerror=()=>reject(new Error('Could not read file')); reader.readAsDataURL(file);
    });
  },
};

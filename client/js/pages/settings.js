// ── Settings ──────────────────────────────────────────────────────────────────
const Settings = {
  _barbers: [], _services: [], _staff: [],

  async render() {
    const el=document.getElementById('page-settings'); if(!el)return;
    try{
      const [s,barbers,services,staff]=await Promise.all([db.settings.get(),db.barbers.all(),db.services.all(),db.staff.all().catch(()=>[])]);
      this._barbers=barbers; this._services=services; this._staff=staff; this._addons=s.addons||[]; this._plans=s.membershipPlans||[];
      this._tpls=_smsTemplates(s.smsTemplates);   // owner-managed message templates (normalized list)
      const html=[];

      // Shop info
      html.push(`<div style="margin:4px 0 10px;font-size:11px;font-weight:800;letter-spacing:.07em;color:var(--muted);">SHOP &amp; ${this._leadMode()?'LEAD FORM':'BOOKING'}</div>`);
      html.push('<div class="section-header">Shop Info</div><div class="card">');
      html.push(`<div class="form-group"><label class="form-label">Shop Name</label><input class="form-input" id="s-name" value="${s.shopName||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Tagline</label><input class="form-input" id="s-tag" value="${s.tagline||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="s-phone" type="tel" value="${s.phone||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Address</label><input class="form-input" id="s-addr" value="${s.address||''}" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Email</label><input class="form-input" id="s-email" type="email" value="${s.email||''}" /></div>`);
      html.push('</div>');

      // Public page settings — the calendar booking page for scheduling verticals,
      // or the opt-in lead form for quote-first verticals (detail shops). Lead mode
      // hides the booking-only controls (welcome message, staff picker, inspo photo)
      // and instead lets the owner pick which services appear on the form.
      const leadMode = this._leadMode();
      html.push(`<div class="section-header">${leadMode?'Lead Form':'Client Booking Page'}</div><div class="card">`);
      const shopSlug = Auth.getShopSlug();
      const bookUrl = location.origin+'/book/'+(shopSlug||'');
      html.push(`<div style="background:var(--green-lt);border:1px solid var(--green-md);border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <span>Your ${leadMode?'lead form':'booking'} link: <strong><a href="${bookUrl}" target="_blank" style="color:var(--green);">${bookUrl}</a></strong></span>
        <button onclick="navigator.clipboard.writeText('${bookUrl}');toast('Link copied ✓')" style="background:var(--green);color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">Copy Link</button>
      </div>`);
      if (leadMode) {
        html.push(`<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">Visitors tell you their name, phone, vehicle, and what they're interested in — then you text them a quote. In ads, add <strong>?utm_source=facebook</strong> (or google, etc.) to the link to track where leads come from.</div>`);
        html.push(`<div class="form-group"><label class="form-label"><input type="checkbox" id="s-benabled" ${s.bookingEnabled!==false?'checked':''} style="margin-right:6px;" /> Lead form enabled</label></div>`);
        // "Services considering" options: free-standing labels, deliberately NOT
        // wired to the real service catalog — they exist to put the visitor in a
        // buying mindframe and tell the owner what to quote. Edit freely here;
        // nothing else (bookings, pricing, revenue) is affected.
        this._leadOpts = (Array.isArray(s.leadFormOptions) && s.leadFormOptions.length)
          ? [...s.leadFormOptions]
          : services.map(sv=>sv.name);
        html.push(`<div class="form-group" style="margin-bottom:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;"><label class="form-label" style="margin:0;">Options on the form</label><button class="btn btn-sm btn-green" onclick="Settings.addLeadOpt()">+ Add</button></div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:10px;">What visitors can say they're interested in. Just labels — no prices, not tied to your service menu. Remember to hit Save below.</div>
          <div id="lf-opts">${this._leadOpts.map((o,i)=>this._leadOptRow(o,i)).join('')}</div>
        </div>`);
      } else {
        html.push(`<div class="form-group"><label class="form-label">Booking Welcome Message</label><textarea class="form-input" id="s-bmsg" rows="2">${s.bookingMessage||'Book your appointment below!'}</textarea></div>`);
        html.push(`<div class="form-group"><label class="form-label"><input type="checkbox" id="s-benabled" ${s.bookingEnabled!==false?'checked':''} style="margin-right:6px;" /> Booking page enabled</label></div>`);
        html.push(`<div class="form-group"><label class="form-label"><input type="checkbox" id="s-staffpicker" ${s.staffPicker!==false?'checked':''} style="margin-right:6px;" /> Let customers choose their ${esc(V('staff','barber').toLowerCase())} when booking</label></div>`);
        // Inspiration photo at booking (scheduling verticals only)
        const inspoMode = s.inspoPhoto || 'off';
        html.push(`<div class="form-group"><label class="form-label">Inspiration Photo</label>
          <select class="form-input" id="s-inspo">
            <option value="off"${inspoMode==='off'?' selected':''}>Off — don't ask for a photo</option>
            <option value="optional"${inspoMode==='optional'?' selected':''}>Optional — clients can attach one</option>
            <option value="required"${inspoMode==='required'?' selected':''}>Required — must attach to book</option>
          </select>
          <div style="font-size:11px;color:var(--muted);margin-top:6px;">Let clients send a reference photo when they book, so you know the look before they arrive.</div>
        </div>`);
      }
      html.push('</div>');

      // Work Gallery — showcased at the top of the booking page
      const gallery = Array.isArray(s.gallery) ? s.gallery : [];
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Work Gallery</span><button class="btn btn-sm btn-green" onclick="Settings.galleryPick()">+ Add Photo</button></div>');
      html.push('<div class="card">');
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:'+(gallery.length?'12px':'0')+';">Showcase your best work on your '+(leadMode?'lead form':'booking page')+'. Photos appear at the top for '+(leadMode?'visitors':'clients')+' to browse.</div>');
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

      // Team — one place for everyone. A member can have a login (role) and/or be
      // assignable to appointments (a linked, color-coded booking record). Logins =
      // accounts; bookable providers = barber records linked by barber.accountId.
      const roleLabels={full:'Full Access',technician:'Technician',viewonly:'View Only'};
      const roleColors={full:'#16a34a',technician:'#2563eb',viewonly:'#6e6e73'};
      // Build a unified roster: every login, plus any bookable provider with no login.
      const team=[];
      staff.forEach(u=>team.push({ account:u, barber:barbers.find(b=>b.accountId===u.id)||null }));
      barbers.filter(b=>!staff.some(u=>u.id===b.accountId)).forEach(b=>team.push({ account:null, barber:b }));
      html.push('<div style="margin:26px 0 10px;border-top:1px solid var(--line);padding-top:16px;font-size:11px;font-weight:800;letter-spacing:.07em;color:var(--muted);">TEAM</div>');
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;"><span>Team</span><button class="btn btn-sm btn-green" onclick="Settings.openTeam(\'\',\'\')">+ Add</button></div>');
      html.push('<div style="font-size:12px;color:var(--muted);margin:-6px 0 10px;">Add the people who work with you. Give them a login (Full Access sees everything · Technician sees jobs &amp; clients, no money or settings · View Only sees the calendar) and/or make them assignable to appointments.</div>');
      team.forEach(m=>{
        const u=m.account, b=m.barber;
        const name=(u&&u.name)||(b&&b.name)||'—';
        const accent=(b&&b.color)||roleColors[u&&u.role]||'#6e6e73';
        const sub=u?u.email:'No login';
        const chips=[];
        if(u) chips.push(`<span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;background:${roleColors[u.role]||'#6e6e73'}1a;color:${roleColors[u.role]||'#6e6e73'};white-space:nowrap;">${roleLabels[u.role]||u.role}</span>`);
        if(b) chips.push(`<span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;background:${b.color||'#16a34a'}1a;color:${b.color||'#16a34a'};white-space:nowrap;">● Bookable</span>`);
        html.push(`<div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;border-left:4px solid ${accent};">
          <div style="width:40px;height:40px;border-radius:50%;background:${accent}22;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:${accent};">${initials(name)}</div>
          <div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:700;">${esc(name)}${u&&u.isOwner?' <span style="font-size:10px;color:var(--faint);font-weight:600;">(owner)</span>':''}</div><div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(sub)}</div></div>
          <div style="display:flex;gap:5px;flex:none;align-items:center;">${chips.join('')}</div>
          <button class="btn btn-sm" onclick="Settings.openTeam('${u?u.id:''}','${b?b.id:''}')">Edit</button>
        </div>`);
      });

      // Services
      html.push('<div style="margin:26px 0 10px;border-top:1px solid var(--line);padding-top:16px;font-size:11px;font-weight:800;letter-spacing:.07em;color:var(--muted);">SERVICES &amp; PRICING</div>');
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
      html.push(`<div class="form-group"><label class="form-label">Reward description</label><input class="form-input" id="s-lrew" value="${s.loyalty?.rewardDescription||'One free service'}" /></div>`);
      html.push('</div>');

      // Sales Tax — applied to service subtotals at checkout + on estimates
      const tax = s.tax || { enabled:false, rate:0, label:'Sales Tax' };
      html.push('<div class="section-header">Sales Tax</div><div class="card">');
      html.push(`<div class="form-group"><label class="toggle-row" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;"><span><span class="form-label" style="display:block;">Charge sales tax</span><span style="font-size:12px;color:var(--muted);">Adds tax to checkout totals and estimates. Tips are never taxed.</span></span><input type="checkbox" id="s-tax-enabled" ${tax.enabled?'checked':''} style="width:20px;height:20px;flex-shrink:0;" /></label></div>`);
      html.push('<div class="form-row">');
      html.push(`<div class="form-group"><label class="form-label">Tax rate (%)</label><input class="form-input" id="s-tax-rate" type="number" step="0.001" value="${tax.rate||''}" placeholder="e.g. 7.5" /></div>`);
      html.push(`<div class="form-group"><label class="form-label">Label on receipts</label><input class="form-input" id="s-tax-label" value="${esc(tax.label||'Sales Tax')}" placeholder="Sales Tax" /></div>`);
      html.push('</div>');
      html.push('</div>');

      // Message templates — owner-managed presets sent via the iPhone Messages
      // deep link (no Twilio/A2P). Used by Messages, the Tasks worklist, and the
      // review prompt.
      html.push('<div style="margin:26px 0 10px;border-top:1px solid var(--line);padding-top:16px;font-size:11px;font-weight:800;letter-spacing:.07em;color:var(--muted);">MESSAGING &amp; CALLS</div>');
      html.push('<div class="section-header">Message Templates</div><div class="card">');
      html.push(`<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Create the texts you send from Messages, the Tasks worklist, and the review prompt. They open in your phone's Messages app prefilled — edit before sending. Tap a field below a message to insert it.</div>`);
      html.push(`<div id="s-tpl-list">${this._renderTemplateList()}</div>`);
      html.push(`<button class="btn btn-sm" onclick="Settings.addTemplate()">+ Add template</button>`);
      const rebookDays = s.rebookInterval || 21;
      html.push('<div style="height:1px;background:var(--line);margin:16px 0;"></div>');
      html.push(`<div class="form-group" style="margin-bottom:0;"><label class="form-label">Rebook reminder window</label><div style="display:flex;align-items:center;gap:10px;"><input class="form-input" id="s-rebook-days" type="number" min="7" max="90" value="${rebookDays}" style="width:90px;" /><span style="font-size:13px;color:var(--muted);">days after last visit → shows in Tasks</span></div></div>`);
      html.push('</div>');

      // Call tracking
      html.push('<div class="section-header">Call Tracking</div><div class="card">');
      if (s.trackingNumber) {
        html.push(`<div style="display:flex;align-items:center;gap:10px;background:var(--green-lt);border:1px solid var(--green-md);border-radius:10px;padding:12px;margin-bottom:14px;"><span style="font-size:18px;">📞</span><div><div style="font-size:13px;font-weight:700;color:var(--green);">Tracking number: ${s.trackingNumber}</div><div style="font-size:12px;color:var(--muted);margin-top:1px;">Calls forward to your shop phone. Inbound calls appear under Leads.</div></div></div>`);
      } else {
        html.push(`<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">Your call-tracking number is managed by ShopFlow. Contact support to activate it for this shop.</div>`);
      }
      html.push(`<div style="font-size:12px;color:var(--muted);">Missed calls are logged as leads — follow up with one tap from the <b>Tasks</b> worklist. Texts open in your Messages app; ShopFlow never auto-texts on your behalf.</div>`);
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
      html.push('<div style="margin:26px 0 10px;border-top:1px solid var(--line);padding-top:16px;font-size:11px;font-weight:800;letter-spacing:.07em;color:var(--muted);">BOOKING RULES &amp; PAYMENTS</div>');
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

      // Payments: Square (primary) + Stripe (legacy) — deposits work with either.
      let stripeStatus = { connected:false };
      try { stripeStatus = await db.stripe.status(); } catch(e) {}
      let squareStatus = { connected:false };
      try { squareStatus = await db.square.status(); } catch(e) {}
      const paymentsConnected = stripeStatus.connected || squareStatus.connected;
      const deposit = s.deposit||{enabled:false,amount:10,message:'A deposit is required to secure your appointment.'};

      html.push('<div class="section-header">Deposits & Payments</div><div class="card">');
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">Collect a deposit when clients book online. It goes directly to your connected payment account.</div>');

      // Square (primary)
      if (squareStatus.connected) {
        html.push('<div style="display:flex;align-items:center;justify-content:space-between;background:var(--green-lt);border:1px solid var(--green-md);border-radius:8px;padding:12px 14px;margin-bottom:10px;">');
        html.push('<div><div style="font-size:13px;font-weight:700;color:var(--green);">✓ Square Connected</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">'+(squareStatus.locationName||'Account active')+'</div></div>');
        html.push('<button class="btn btn-sm btn-danger" onclick="Settings.disconnectSquare()">Disconnect</button>');
        html.push('</div>');
      } else {
        html.push('<div style="background:var(--surface2);border-radius:8px;padding:14px;margin-bottom:10px;font-size:13px;color:var(--muted);">Connect your Square account to collect deposits directly to your business. Takes about a minute.</div>');
        html.push('<button class="btn btn-primary btn-full" id="square-connect-btn" onclick="Settings.connectSquare()" style="margin-bottom:14px;">Connect Square Account</button>');
      }

      // Stripe (legacy — still supported)
      if (stripeStatus.connected) {
        html.push('<div style="display:flex;align-items:center;justify-content:space-between;background:var(--green-lt);border:1px solid var(--green-md);border-radius:8px;padding:12px 14px;margin-bottom:14px;">');
        html.push('<div><div style="font-size:13px;font-weight:700;color:var(--green);">✓ Stripe Connected</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">'+(stripeStatus.email||'Account active')+'</div></div>');
        html.push('<button class="btn btn-sm btn-danger" onclick="Settings.disconnectStripe()">Disconnect</button>');
        html.push('</div>');
      }

      // Deposit settings — available once either processor is connected
      if (paymentsConnected) {
        html.push('<div class="form-group"><label style="display:flex;align-items:center;gap:10px;cursor:pointer;"><input type="checkbox" id="s-dep-enabled" '+(deposit.enabled?'checked':'')+' style="width:16px;height:16px;" /><span style="font-size:14px;font-weight:600;">Require deposit to book</span></label></div>');
        html.push('<div class="form-row">');
        html.push('<div class="form-group"><label class="form-label">Deposit amount</label><div style="position:relative;"><div style="position:absolute;left:12px;top:50%;transform:translateY(-50%);font-weight:700;color:var(--muted);">$</div><input class="form-input" id="s-dep-amount" type="number" value="'+(deposit.amount||10)+'" min="1" max="100" style="padding-left:24px;" /></div></div>');
        html.push('<div class="form-group"><label class="form-label">Quick amounts</label><div style="display:flex;gap:6px;"><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=5">$5</button><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=10">$10</button><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=15">$15</button><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=20">$20</button><button class="btn btn-sm" onclick="document.getElementById(\'s-dep-amount\').value=25">$25</button></div></div>');
        html.push('</div>');
        html.push('<div class="form-group"><label class="form-label">Deposit message shown to client</label><input class="form-input" id="s-dep-msg" value="'+(deposit.message||'A deposit is required to secure your appointment.')+'" /></div>');
      }
      html.push('</div>');

      html.push('<div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-primary" style="flex:1;" onclick="Settings.save()">Save Settings</button><button class="btn btn-danger" onclick="Auth.logout()">Sign Out</button></div>');
      el.innerHTML=html.join('');
    }catch(e){el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load settings</p></div>';}
  },

  // Unified Team member modal: login (email/password/role) + an optional "bookable"
  // section (color + schedule) that maps to a linked booking record. Pass the
  // account id and/or the barber id (either may be empty for a new member).
  openTeam(accountId, barberId) {
    const u = accountId ? this._staff.find(x=>x.id===accountId) : null;
    const b = barberId ? this._barbers.find(x=>x.id===barberId) : (u ? this._barbers.find(x=>x.accountId===u.id) : null);
    const isOwner = !!(u && u.isOwner);
    const bookable = !!b;
    const name = (u&&u.name)||(b&&b.name)||'';
    const roles = [
      ['full','Full Access — sees everything'],
      ['technician','Technician — jobs & clients only'],
      ['viewonly','View Only — calendar only'],
    ];
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
      <div class="modal-title">${(u||b)?'Edit team member':'Add team member'}</div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fu-name" value="${esc(name)}" placeholder="e.g. Marcus Reyes" /></div>

      <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.04em;margin:6px 0 8px;">LOGIN</div>
      <div class="form-group"><label class="form-label">Email${u?'':' <span style="font-weight:400;color:var(--faint);">(optional — leave blank for no login)</span>'}</label><input class="form-input" id="fu-email" type="email" value="${esc(u?.email||'')}" placeholder="them@email.com" /></div>
      <div class="form-group"><label class="form-label">Password ${u?'<span style="font-weight:400;color:var(--faint);">(leave blank to keep current)</span>':'<span style="font-weight:400;color:var(--faint);">(needed for a login)</span>'}</label><input class="form-input" id="fu-pass" type="password" placeholder="At least 6 characters" autocomplete="new-password" /></div>
      ${isOwner
        ? '<input type="hidden" id="fu-role" value="full" /><div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Owner account — always Full Access.</div>'
        : `<div class="form-group"><label class="form-label">Role</label><select class="form-input" id="fu-role">${roles.map(([v,l])=>`<option value="${v}"${(u?.role||'technician')===v?' selected':''}>${esc(l)}</option>`).join('')}</select></div>`}

      <div class="form-group" style="margin-top:6px;"><label class="toggle-row" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;"><span><span class="form-label" style="display:block;">Assignable to appointments</span><span style="font-size:12px;color:var(--muted);">Show them as a bookable provider with their own color.</span></span><input type="checkbox" id="fu-bookable" ${bookable?'checked':''} onchange="Settings._toggleBookable()" style="width:20px;height:20px;flex-shrink:0;" /></label></div>

      <div id="team-booking" style="${bookable?'':'display:none;'}">
        <div class="form-group"><label class="form-label">Color</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${colors.map(c=>`<div onclick="document.getElementById('fb-col').value='${c}';document.querySelectorAll('.bc').forEach(x=>x.style.outline='none');this.style.outline='3px solid #000';" class="bc" style="width:30px;height:30px;border-radius:50%;background:${c};cursor:pointer;outline:${(b&&b.color===c)?'3px solid #000':'none'};outline-offset:2px;"></div>`).join('')}
          </div>
          <input type="hidden" id="fb-col" value="${(b&&b.color)||colors[0]}" />
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
      </div>

      <div class="modal-actions">
        ${((u&&!isOwner)||b)?`<button class="btn btn-danger btn-full" onclick="Settings.removeTeam('${u?u.id:''}','${b?b.id:''}')">Remove</button>`:''}
        <button id="fu-btn" class="btn btn-primary btn-full" onclick="Settings.saveTeam('${u?u.id:''}','${b?b.id:''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>{document.getElementById('fu-name')?.focus();Settings._renderTimeChips();},150);
  },

  _toggleBookable() {
    const on=document.getElementById('fu-bookable')?.checked;
    const w=document.getElementById('team-booking'); if(w)w.style.display=on?'':'none';
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

  async saveTeam(accountId, barberId) {
    const name  = document.getElementById('fu-name')?.value.trim();
    const email = document.getElementById('fu-email')?.value.trim();
    const pass  = document.getElementById('fu-pass')?.value||'';
    const role  = document.getElementById('fu-role')?.value||'technician';
    const bookable = !!document.getElementById('fu-bookable')?.checked;
    if(!name){ toast('Enter a name','warning'); return; }
    const wantLogin = !!email || !!accountId;
    if(!wantLogin && !bookable){ toast('Add a login (email) or make them assignable to appointments','warning'); return; }
    if(wantLogin && !email){ toast('Enter an email for the login','warning'); return; }
    if(wantLogin && !accountId && pass.length<6){ toast('Set a password of 6+ characters for the login','warning'); return; }
    const btn=document.getElementById('fu-btn'); disableBtn(btn);
    try{
      let acctId = accountId;
      if(wantLogin){
        const body={name,email,role}; if(accountId)body.id=accountId; if(pass)body.password=pass;
        const r = await db.staff.save(body); acctId = accountId || (r&&r.id);
      }
      if(bookable){
        const schedule={
          workDays: JSON.parse(document.getElementById('fb-workdays')?.value||'[1,2,3,4,5,6]'),
          startTime: document.getElementById('fb-start')?.value||'9:00 AM',
          endTime:   document.getElementById('fb-end')?.value||'6:00 PM',
          slotMinutes: parseInt(document.getElementById('fb-slot')?.value)||30,
        };
        if(document.getElementById('fb-customtimes')?.checked){
          const times=this._getTimes();
          if(!times.length){ toast('Add at least one time, or turn off specific times','warning'); enableBtn(btn); return; }
          schedule.allowedTimes=times;
        }
        const existing = barberId ? this._barbers.find(b=>b.id===barberId) : null;
        await db.barbers.save({
          id: barberId||genId('b'),
          name,
          color: document.getElementById('fb-col')?.value||'#16a34a',
          chair: existing?.chair || (this._barbers.length+1),
          phone: existing?.phone || '',
          bio:   existing?.bio || '',
          active: true,
          accountId: acctId || null,
          schedule,
          joinedAt: existing?.joinedAt || today(),
        });
      } else if(barberId){
        await db.barbers.delete(barberId);   // was bookable, now off → drop booking record
      }
      Modal.close(); toast((accountId||barberId)?'Updated ✓':'Team member added ✓'); this.render();
    }catch(e){ toast(e.message||'Could not save','error'); enableBtn(btn); }
  },

  async removeTeam(accountId, barberId) {
    if(!confirm('Remove this team member? Any login will stop working.'))return;
    try{
      if(accountId) await db.staff.delete(accountId);
      if(barberId)  await db.barbers.delete(barberId);
      Modal.close(); toast('Removed'); this.render();
    }catch(e){ toast(e.message||'Could not remove','error'); }
  },

  // Shops whose public /book page is the lead-capture form (quote-first verticals).
  _leadMode(){
    const st=Shop.settings||{};
    return (st.bookingMode || (st.industry==='detail'?'leads':'booking'))==='leads';
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
      <div class="form-group"><label class="form-label">Product / supply cost <span style="font-weight:400;color:var(--faint);">(optional — for profit tracking)</span></label><input class="form-input" id="fs-cost" type="number" value="${s?.cost!=null?s.cost:''}" placeholder="What this job costs you" /></div>
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
          ${(()=>{ const base=(Shop.serviceCategories&&Shop.serviceCategories.length?Shop.serviceCategories:['cut','beard','combo','color','design','other']); const cats=(s?.category&&!base.includes(s.category))?[s.category,...base]:base; return cats.map(c=>`<option value="${c}"${s?.category===c?' selected':''}>${c}</option>`).join(''); })()}
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

  // Lead-form "options" editor (Settings → Lead Form card). Plain labels held in
  // this._leadOpts; persisted as settings.leadFormOptions by the main Save button.
  _leadOptRow(val,i){
    return `<div style="display:flex;gap:8px;margin-bottom:7px;" data-lfopt>
      <input class="form-input lf-opt" value="${esc(val)}" placeholder="e.g. Ceramic Coating" style="flex:1;" />
      <button class="btn btn-sm" onclick="Settings.removeLeadOpt(this)" title="Remove" style="color:var(--red);flex-shrink:0;">×</button>
    </div>`;
  },
  _syncLeadOpts(){
    const box=document.getElementById('lf-opts'); if(!box) return;
    this._leadOpts=[...box.querySelectorAll('.lf-opt')].map(inp=>inp.value);
  },
  addLeadOpt(){
    this._syncLeadOpts();
    const box=document.getElementById('lf-opts'); if(!box) return;
    box.insertAdjacentHTML('beforeend', this._leadOptRow('', this._leadOpts.length));
    const inputs=box.querySelectorAll('.lf-opt'); inputs[inputs.length-1]?.focus();
  },
  removeLeadOpt(btn){
    btn.closest('[data-lfopt]')?.remove();
    this._syncLeadOpts();
  },

  openAddon(id){
    const ad=id?(this._addons||[]).find(x=>x.id===id):null;
    Modal.show(`
      <div class="modal-title">${ad?'Edit Add-on':'Add Add-on'}</div>
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="fad-name" value="${esc(ad?.name||'')}" placeholder="e.g. Pet Hair Removal" /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Price</label><input class="form-input" id="fad-price" type="number" value="${ad?(ad.price):25}" /></div>
        <div class="form-group"><label class="form-label">Cost <span style="font-weight:400;color:var(--faint);">(optional)</span></label><input class="form-input" id="fad-cost" type="number" value="${ad&&ad.cost!=null?ad.cost:''}" placeholder="$" /></div>
      </div>
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
    const cost=parseFloat(document.getElementById('fad-cost')?.value)||0;
    const btn=document.getElementById('fad-btn'); disableBtn(btn);
    const list=[...(this._addons||[])];
    if(id){ const i=list.findIndex(a=>a.id===id); if(i>=0) list[i]={...list[i],name,price,cost}; }
    else list.push({id:genId('ad'),name,price,cost});
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
    const cost=parseFloat(document.getElementById('fs-cost')?.value)||0;
    try{
      await db.services.save({id:id||genId('s'),name,price:basePrice,cost,duration:parseInt(document.getElementById('fs-dur')?.value)||45,category:document.getElementById('fs-cat')?.value||'cut',sizePricing:sizeOn?sizePricing:null});
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

  async connectSquare() {
    const btn = document.getElementById('square-connect-btn'); if(btn){btn.textContent='Connecting...';btn.disabled=true;}
    try {
      const data = await db.square.onboard();
      if (data.ok && data.url) { window.location.href = data.url; } // → Square authorize, then back to /shop/:slug
      else { toast(data.error||'Could not start Square connect.','error'); if(btn){btn.textContent='Connect Square Account';btn.disabled=false;} }
    } catch(e) { toast(e.message||'Could not connect Square. Check the Square env vars in Railway.','error'); if(btn){btn.textContent='Connect Square Account';btn.disabled=false;} }
  },
  async disconnectSquare() {
    if (!confirm('Disconnect Square? Deposit collection will stop until you reconnect.')) return;
    try { await db.square.disconnect(); toast('Square disconnected'); this.render(); }
    catch(e) { toast('Could not disconnect','error'); }
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
    const data={shopName:document.getElementById('s-name')?.value.trim(),tagline:document.getElementById('s-tag')?.value.trim(),phone:document.getElementById('s-phone')?.value.trim(),address:document.getElementById('s-addr')?.value.trim(),email:document.getElementById('s-email')?.value.trim(),bookingEnabled:document.getElementById('s-benabled')?.checked!==false};
    // Booking-only fields aren't rendered in lead mode — only save what's on screen,
    // so a lead-mode save never clobbers the shop's stored booking config.
    const bmsg=document.getElementById('s-bmsg'); if(bmsg)data.bookingMessage=bmsg.value.trim();
    const spk=document.getElementById('s-staffpicker'); if(spk)data.staffPicker=spk.checked;
    // Lead-form options (lead-mode shops): plain labels, empties dropped.
    if(document.getElementById('lf-opts')){ this._syncLeadOpts(); data.leadFormOptions=this._leadOpts.map(o=>o.trim()).filter(Boolean); }
    const lv=document.getElementById('s-lvis')?.value; if(lv)data.loyalty={visitsForReward:parseInt(lv),rewardDescription:document.getElementById('s-lrew')?.value.trim()||'One free service'};
    // Message templates: owner-managed [{id,label,body}] list (drops empty rows).
    this._syncTemplates();
    data.smsTemplates=(this._tpls||[]).filter(t=>(t.label||'').trim()||(t.body||'').trim())
      .map(t=>({ id:t.id||genId('tpl'), label:(t.label||'Template').trim(), body:(t.body||'').trim() }));
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
    data.tax={ enabled:document.getElementById('s-tax-enabled')?.checked||false, rate:parseFloat(document.getElementById('s-tax-rate')?.value)||0, label:document.getElementById('s-tax-label')?.value.trim()||'Sales Tax' };
    Shop.tax=data.tax; // keep checkout + estimate math in sync without a reload
    await db.settings.save(data);
    // Keep templates live for Messages/Tasks/review prompts without a reload.
    if (Shop.settings) Shop.settings.smsTemplates = data.smsTemplates;
    if (Shop.settings) Shop.settings.googleReviewLink = (gr || Shop.settings.googleReviewLink || '');
    this._tpls = _smsTemplates(data.smsTemplates);
    const title=document.getElementById('topbar-title'); if(title)title.textContent=data.shopName||'ShopFlow';
    toast('Settings saved ✓');
  },

  // ── Message-template manager ──────────────────────────────────────────────────
  MERGE_FIELDS: ['{first}','{name}','{shop}','{date}','{time}','{service}','{link}'],

  // Render the editable list of templates into #s-tpl-list.
  _renderTemplateList() {
    const tpls = this._tpls || [];
    if (!tpls.length) {
      return '<div style="font-size:12px;color:var(--faint);padding:6px 0 12px;">No templates yet — add one to get started.</div>';
    }
    return tpls.map((t,i) => {
      const chips = this.MERGE_FIELDS.map(f =>
        `<button type="button" class="btn btn-xs" style="padding:2px 7px;font-size:11px;" onclick="Settings._insertVar(${i},'${f}')">${f}</button>`
      ).join(' ');
      return '<div class="card" style="padding:12px;margin-bottom:10px;background:var(--off,#f9fafb);">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
        +   '<label class="form-label" style="margin:0;">Template name</label>'
        +   `<button class="btn btn-sm btn-danger" style="padding:2px 10px;" onclick="Settings.delTemplate(${i})" title="Delete template">✕</button>`
        + '</div>'
        + `<input class="form-input" id="s-tpl-label-${i}" value="${esc(t.label||'')}" placeholder="e.g. Appointment reminder" style="margin-bottom:10px;" />`
        + `<label class="form-label">Message</label>`
        + `<textarea class="form-input" id="s-tpl-body-${i}" rows="3" placeholder="Type your message…" style="margin-bottom:6px;">${esc(t.body||'')}</textarea>`
        + `<div style="display:flex;flex-wrap:wrap;gap:5px;">${chips}</div>`
        + '</div>';
    }).join('');
  },

  // Read the live inputs back into this._tpls so add/delete/save don't lose edits.
  _syncTemplates() {
    (this._tpls || []).forEach((t,i) => {
      const l = document.getElementById('s-tpl-label-'+i); if (l) t.label = l.value;
      const b = document.getElementById('s-tpl-body-'+i);  if (b) t.body  = b.value;
    });
  },

  _repaintTemplates() {
    const host = document.getElementById('s-tpl-list');
    if (host) host.innerHTML = this._renderTemplateList();
  },

  addTemplate() {
    this._syncTemplates();
    (this._tpls = this._tpls || []).push({ id: genId('tpl'), label: '', body: '' });
    this._repaintTemplates();
  },

  delTemplate(i) {
    this._syncTemplates();
    (this._tpls || []).splice(i, 1);
    this._repaintTemplates();
  },

  // Insert a merge field at the cursor in a template's body textarea.
  _insertVar(i, token) {
    const ta = document.getElementById('s-tpl-body-'+i); if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
    const pos = start + token.length; ta.focus(); ta.setSelectionRange(pos, pos);
    if (this._tpls && this._tpls[i]) this._tpls[i].body = ta.value;
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

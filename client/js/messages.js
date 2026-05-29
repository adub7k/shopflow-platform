const Messages = {
  _customers: [],
  _conversations: [],
  _selected: null,
  _view: 'list', // 'list' or 'thread'

  async load() {
    try {
      [this._customers, this._conversations] = await Promise.all([
        db.customers.all(),
        db.conversations.all(),
      ]);
      this.updateBadge();
    } catch(e) {
      this._customers = [];
      this._conversations = [];
    }
  },

  updateBadge() {
    const unread = this._conversations.filter(function(c){ return c.direction==='inbound'&&!c.read; }).length;
    const b = document.getElementById('messages-nav-badge');
    if (b) { if(unread>0){b.textContent=unread;b.classList.remove('hidden');}else b.classList.add('hidden'); }
  },

  async render() {
    const el = document.getElementById('page-messages');
    el.innerHTML = '<div class="spinner-page"><div class="spinner"></div></div>';
    await this.load();
    if (this._view === 'thread' && this._selected) {
      this.renderThread();
    } else {
      this.renderList();
    }
  },

  renderList() {
    const el = document.getElementById('page-messages');
    // Group by customer
    const custMap = {};
    this._conversations.forEach(function(c) {
      const key = c.customerId || '_unknown';
      if (!custMap[key]) custMap[key] = [];
      custMap[key].push(c);
    });

    const threads = Object.entries(custMap).map(function(entry) {
      const custId = entry[0], msgs = entry[1].sort(function(a,b){ return new Date(a.sentAt)-new Date(b.sentAt); });
      const cust = custId === '_unknown' ? {id:'_unknown',name:'Unknown',phone:'—'} : Messages._customers.find(function(c){ return c.id===custId; }) || {id:custId,name:'Unknown',phone:'—'};
      const last = msgs[msgs.length-1];
      const unread = msgs.filter(function(m){ return m.direction==='inbound'&&!m.read; }).length;
      return { custId, cust, msgs, last, unread };
    }).sort(function(a,b){ return new Date(b.last.sentAt)-new Date(a.last.sentAt); });

    const typeIcon = { sms:'&#128172;', call:'&#128222;', email:'&#128231;', note:'&#128204;' };
    const html = [];
    html.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">');
    html.push('<div style="font-size:18px;font-weight:700;">Messages</div>');
    html.push('<button class="btn btn-sm btn-primary" onclick="Messages.openNewMessage()">+ New</button>');
    html.push('</div>');

    if (!threads.length) {
      html.push('<div class="card"><div style="text-align:center;padding:40px 20px;">');
      html.push('<div style="font-size:40px;margin-bottom:12px;">&#128172;</div>');
      html.push('<div style="font-size:15px;font-weight:600;margin-bottom:8px;">No messages yet</div>');
      html.push('<div style="font-size:13px;color:var(--muted);margin-bottom:16px;">Start a conversation with any customer</div>');
      html.push('<button class="btn btn-primary btn-full" onclick="Messages.openNewMessage()">+ Start a conversation</button>');
      html.push('</div></div>');
    } else {
      html.push('<div class="card" style="padding:0 16px;">');
      threads.forEach(function(t) {
        const last = t.last;
        const preview = last.body ? last.body.slice(0,40)+(last.body.length>40?'...':'') : '('+last.type+')';
        const timeLabel = Messages._timeAgo(last.sentAt);
        html.push('<div class="list-row" onclick="Messages.openThread(\''+t.custId+'\')">');
        html.push(avatarEl(t.cust.name, 44));
        html.push('<div class="list-main">');
        html.push('<div style="display:flex;justify-content:space-between;">');
        html.push('<div style="font-weight:'+(t.unread?'700':'600')+';font-size:15px;">'+t.cust.name+'</div>');
        html.push('<div style="font-size:11px;color:var(--faint);">'+timeLabel+'</div>');
        html.push('</div>');
        html.push('<div style="font-size:12px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+(typeIcon[last.type]||'&#128172;')+' '+(last.direction==='outbound'?'You: ':'')+preview+'</div>');
        html.push('</div>');
        if (t.unread) html.push('<div style="width:10px;height:10px;background:var(--green);border-radius:50%;flex-shrink:0;"></div>');
        html.push('</div>');
      });
      html.push('</div>');
    }

    el.innerHTML = html.join('');
  },

  async openThread(custId) {
    this._selected = custId;
    this._view = 'thread';
    await this.load();
    this.renderThread();
  },

  renderThread() {
    const el = document.getElementById('page-messages');
    const custId = this._selected;
    const cust = this._customers.find(function(c){ return c.id===custId; }) || {name:'Unknown',phone:'—'};
    const msgs = this._conversations.filter(function(c){ return c.customerId===custId; }).sort(function(a,b){ return new Date(a.sentAt)-new Date(b.sentAt); });

    // Mark read
    msgs.forEach(function(m) {
      if (m.direction==='inbound' && !m.read) { m.read=true; db.conversations.save(m); }
    });
    this.updateBadge();

    const typeIcon = { sms:'&#128172;', call:'&#128222;', email:'&#128231;', note:'&#128204;' };
    const html = [];

    // Back button header
    html.push('<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">');
    html.push('<button class="btn btn-sm" onclick="Messages._view=\'list\';Messages.renderList()">&#8592; Back</button>');
    html.push(avatarEl(cust.name, 36));
    html.push('<div style="flex:1;"><div style="font-size:15px;font-weight:700;">'+cust.name+'</div><div style="font-size:12px;color:var(--muted);">'+(cust.phone||'No phone')+'</div></div>');
    html.push('</div>');

    // Action buttons
    html.push('<div style="display:flex;gap:8px;margin-bottom:14px;overflow-x:auto;padding-bottom:4px;">');
    if (cust.phone && cust.phone !== '—') {
      html.push('<button class="btn btn-sm" style="background:#eaf3de;border-color:var(--green);color:var(--green);white-space:nowrap;" onclick="Messages.call(\''+cust.phone+'\',\''+custId+'\',\''+cust.name+'\')">&#128222; Call</button>');
      html.push('<button class="btn btn-sm btn-primary" style="white-space:nowrap;" onclick="Messages.openSMS(\''+custId+'\',\''+cust.name+'\',\''+cust.phone+'\')">&#128172; Text</button>');
    }
    if (cust.email) html.push('<button class="btn btn-sm" style="white-space:nowrap;" onclick="Messages.openEmail(\''+custId+'\',\''+cust.name+'\',\''+(cust.email||'')+'\')" >&#128231; Email</button>');
    html.push('<button class="btn btn-sm" style="white-space:nowrap;" onclick="Messages.openNote(\''+custId+'\',\''+cust.name+'\')">&#128204; Note</button>');
    html.push('</div>');

    // Bubbles
    html.push('<div id="msg-bubbles" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">');
    if (!msgs.length) {
      html.push('<div class="card" style="text-align:center;padding:32px;color:var(--faint);"><div style="font-size:28px;margin-bottom:8px;">&#128172;</div><div>No messages yet</div></div>');
    } else {
      let lastDate = '';
      msgs.forEach(function(m) {
        const msgDate = (m.sentAt||'').split('T')[0];
        if (msgDate !== lastDate) {
          lastDate = msgDate;
          html.push('<div style="text-align:center;font-size:11px;color:var(--faint);margin:4px 0;">'+fmtDate(msgDate)+'</div>');
        }
        const isOut = m.direction === 'outbound';
        html.push('<div style="display:flex;justify-content:'+(isOut?'flex-end':'flex-start')+';">');
        html.push('<div style="max-width:80%;padding:10px 14px;border-radius:16px;'+(isOut?'background:#1a1a1a;color:#fff;border-bottom-right-radius:4px;':'background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:4px;')+'">');
        html.push('<div style="font-size:10px;opacity:.6;margin-bottom:4px;">'+(typeIcon[m.type]||'&#128172;')+' '+( m.type||'message')+' &middot; '+Messages._timeAgo(m.sentAt)+'</div>');
        if (m.body) html.push('<div style="font-size:13px;line-height:1.5;">'+m.body.replace(/\n/g,'<br>')+'</div>');
        html.push('</div></div>');
      });
    }
    html.push('</div>');

    // Quick reply
    html.push('<div style="display:flex;gap:8px;align-items:flex-end;">');
    html.push('<textarea id="msg-quick" class="form-input" placeholder="Type a message..." rows="2" style="flex:1;border-radius:20px;padding:10px 14px;resize:none;"></textarea>');
    html.push('<button class="btn btn-primary" onclick="Messages.sendQuick(\''+custId+'\',\''+(cust.phone||'').replace(/'/g,'')+'\',\''+cust.name+'\')">Send</button>');
    html.push('</div>');

    el.innerHTML = html.join('');
    // Scroll to bottom
    setTimeout(function(){ const b=document.getElementById('msg-bubbles'); if(b)b.scrollTop=b.scrollHeight; }, 50);
  },

  async call(phone, custId, custName) {
    const clean = phone.replace(/\D/g,'');
    window.location.href = 'tel:+1'+clean;
    // Log after a moment
    setTimeout(async function() {
      const html = [];
      html.push('<div class="modal-title">Log call with '+custName+'</div>');
      html.push('<div class="form-group"><label class="form-label">What happened?</label><textarea class="form-input" id="call-note" rows="3" placeholder="Left voicemail, spoke with customer, etc..."></textarea></div>');
      html.push('<div class="modal-actions"><button class="btn btn-full btn-primary" onclick="Messages._saveCallNote(\''+custId+'\',\''+custName+'\',\''+phone+'\')">Save</button><button class="btn btn-full" onclick="Modal.close()">Skip</button></div>');
      Modal.show(html.join(''));
    }, 1500);
  },

  async _saveCallNote(custId, custName, phone) {
    const note = document.getElementById('call-note')?.value.trim();
    await db.conversations.save({ id:genId('msg'), customerId:custId, customerName:custName, type:'call', direction:'outbound', body:note||'Call placed to '+phone, sentAt:new Date().toISOString(), read:true });
    Modal.close();
    toast('Call logged');
    await this.load();
    this.renderThread();
  },

  openSMS(custId, custName, phone) {
    const html = [];
    html.push('<div class="modal-title">&#128172; Text '+custName+'</div>');
    html.push('<div style="font-size:13px;color:var(--muted);margin-bottom:14px;">To: '+phone+'</div>');
    html.push('<div class="form-group"><label class="form-label">Message</label><textarea class="form-input" id="sms-body" rows="4" placeholder="Type your message..."></textarea></div>');
    html.push('<div style="font-size:11px;color:var(--faint);margin-bottom:12px;">Sent via Twilio. Requires Twilio configured in Settings.</div>');
    html.push('<div class="modal-actions">');
    html.push('<button id="sms-btn" class="btn btn-full btn-primary" onclick="Messages.sendSMS(\''+custId+'\',\''+custName+'\',\''+phone+'\')">&#128172; Send text</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
    setTimeout(function(){ document.getElementById('sms-body')?.focus(); }, 150);
  },

  async sendSMS(custId, custName, phone) {
    const body = document.getElementById('sms-body')?.value.trim();
    if (!body) { toast('Please enter a message', 'warning'); return; }
    const btn = document.getElementById('sms-btn');
    disableBtn(btn);
    try {
      const result = await db.sms.send({ to: phone, body, customerId: custId, customerName: custName });
      if (!result.ok) { toast('SMS failed: ' + result.error, 'error'); enableBtn(btn); return; }
      Modal.close();
      toast('Text sent &#10003;');
      await this.load();
      this.renderThread();
    } catch(e) { toast('Could not send — check Twilio settings', 'error'); enableBtn(btn); }
  },

  async sendQuick(custId, phone, custName) {
    const input = document.getElementById('msg-quick');
    if (!input) return;
    const body = input.value.trim();
    if (!body) return;
    if (!phone || phone === '—') { toast('No phone number on file', 'warning'); return; }
    input.value = '';
    input.disabled = true;
    try {
      const result = await db.sms.send({ to: phone, body, customerId: custId, customerName: custName });
      if (!result.ok) { toast('SMS failed: ' + result.error, 'error'); input.disabled=false; return; }
      toast('Sent &#10003;');
      await this.load();
      this.renderThread();
    } catch(e) { toast('Could not send', 'error'); input.disabled=false; }
  },

  openEmail(custId, custName, email) {
    const html = [];
    html.push('<div class="modal-title">&#128231; Email '+custName+'</div>');
    html.push('<div class="form-group"><label class="form-label">To</label><input class="form-input" id="em-to" value="'+email+'" type="email" /></div>');
    html.push('<div class="form-group"><label class="form-label">Subject</label><input class="form-input" id="em-subject" placeholder="e.g. Your appointment is confirmed" /></div>');
    html.push('<div class="form-group"><label class="form-label">Message</label><textarea class="form-input" id="em-body" rows="5" placeholder="Hi '+custName.split(' ')[0]+',"></textarea></div>');
    html.push('<div class="modal-actions"><button id="em-btn" class="btn btn-full btn-primary" onclick="Messages.sendEmail(\''+custId+'\',\''+custName+'\')">Send email</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>');
    Modal.show(html.join(''));
    setTimeout(function(){ document.getElementById('em-subject')?.focus(); }, 150);
  },

  async sendEmail(custId, custName) {
    const to = document.getElementById('em-to')?.value.trim();
    const subject = document.getElementById('em-subject')?.value.trim();
    const body = document.getElementById('em-body')?.value.trim();
    if (!to||!subject||!body) { toast('Please fill in all fields', 'warning'); return; }
    const btn = document.getElementById('em-btn'); disableBtn(btn);
    try {
      const result = await db.email.send({ to, subject, body, customerId: custId, customerName: custName });
      if (!result.ok) { toast('Email failed: '+result.error, 'error'); enableBtn(btn); return; }
      Modal.close(); toast('Email sent &#10003;');
      await this.load(); this.renderThread();
    } catch(e) { toast('Could not send email', 'error'); enableBtn(btn); }
  },

  openNote(custId, custName) {
    const html = [];
    html.push('<div class="modal-title">&#128204; Log note — '+custName+'</div>');
    html.push('<div class="form-group"><label class="form-label">Note</label><textarea class="form-input" id="note-body" rows="4" placeholder="e.g. Called about pricing, quoted $450..."></textarea></div>');
    html.push('<div class="modal-actions"><button class="btn btn-full btn-primary" onclick="Messages.saveNote(\''+custId+'\',\''+custName+'\')">Save note</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>');
    Modal.show(html.join(''));
    setTimeout(function(){ document.getElementById('note-body')?.focus(); }, 150);
  },

  async saveNote(custId, custName) {
    const body = document.getElementById('note-body')?.value.trim();
    if (!body) { toast('Please enter a note', 'warning'); return; }
    await db.conversations.save({ id:genId('msg'), customerId:custId, customerName:custName, type:'note', direction:'outbound', body, sentAt:new Date().toISOString(), read:true });
    Modal.close(); toast('Note saved');
    await this.load(); this.renderThread();
  },

  openNewMessage() {
    const html = [];
    html.push('<div class="modal-title">New message</div>');
    html.push('<div class="form-group"><label class="form-label">Customer</label><div class="autocomplete-wrap"><input class="form-input" id="nm-cust-name" placeholder="Search customers..." /><div class="autocomplete-list" id="nm-cust-list"></div></div><input type="hidden" id="nm-cust-id" /><input type="hidden" id="nm-cust-phone" /><input type="hidden" id="nm-cust-email" /></div>');
    html.push('<div class="form-group"><label class="form-label">Type</label><select class="form-input" id="nm-type"><option value="sms">&#128172; Text message</option><option value="call">&#128222; Log call</option><option value="email">&#128231; Email</option><option value="note">&#128204; Note</option></select></div>');
    html.push('<div class="form-group"><label class="form-label">Message</label><textarea class="form-input" id="nm-body" rows="3" placeholder="Type your message..."></textarea></div>');
    html.push('<div class="modal-actions"><button class="btn btn-full btn-primary" onclick="Messages.sendNewMessage()">Send</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>');
    Modal.show(html.join(''));
    setTimeout(function() {
      makeAutocomplete('nm-cust-name','nm-cust-list', function(id, name) {
        const cust = Messages._customers.find(function(c){ return c.id===id; });
        document.getElementById('nm-cust-name').value = name;
        document.getElementById('nm-cust-id').value = id;
        document.getElementById('nm-cust-phone').value = cust?.phone||'';
        document.getElementById('nm-cust-email').value = cust?.email||'';
      });
    }, 100);
  },

  async sendNewMessage() {
    const custId = document.getElementById('nm-cust-id')?.value;
    const custName = document.getElementById('nm-cust-name')?.value;
    const phone = document.getElementById('nm-cust-phone')?.value;
    const email = document.getElementById('nm-cust-email')?.value;
    const type = document.getElementById('nm-type')?.value;
    const body = document.getElementById('nm-body')?.value.trim();
    if (!custId || !body) { toast('Please select a customer and enter a message', 'warning'); return; }
    Modal.close();
    if (type === 'sms') { this.openSMS(custId, custName, phone); }
    else if (type === 'email') { this.openEmail(custId, custName, email); }
    else if (type === 'call') { await this.call(phone, custId, custName); }
    else {
      await db.conversations.save({ id:genId('msg'), customerId:custId, customerName:custName, type:'note', direction:'outbound', body, sentAt:new Date().toISOString(), read:true });
      toast('Note saved'); await this.load(); this._selected=custId; this._view='thread'; this.renderThread();
    }
  },

  _timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff/60000);
    if (mins < 1)  return 'Just now';
    if (mins < 60) return mins+'m ago';
    const hrs = Math.floor(mins/60);
    if (hrs < 24)  return hrs+'h ago';
    const days = Math.floor(hrs/24);
    if (days < 7)  return days+'d ago';
    return fmtDateShort(dateStr.split('T')[0]);
  },
};

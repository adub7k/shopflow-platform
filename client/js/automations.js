// ── ShopFlow Automation Engine ────────────────────────────────────────────────
// Handles all automated SMS flows for Off-Kut Barbershop
// Flows: booking confirmation, 24hr reminder, 48hr review, 14 day re-book, 30 day win-back
// Plus custom automation builder

const Automations = {
  _rules: [],
  _barbers: [],

  async render() {
    showSpinner('page-automations');
    try {
      const [settings, barbers] = await Promise.all([db.settings.get(), db.barbers.all()]);
      this._barbers = barbers;
      this._rules = settings.automations || Automations._defaultRules(settings);
      const el = document.getElementById('page-automations');
      const html = [];

      html.push('<div style="margin-bottom:16px;">');
      html.push('<div style="font-size:18px;font-weight:700;">SMS Automations</div>');
      html.push('<div style="font-size:12px;color:var(--muted);">Automated texts fire through Twilio. Configure in Settings → Messaging.</div>');
      html.push('</div>');

      // Twilio status check
      const hasTwilio = settings.twilio?.accountSid && settings.twilio?.authToken && settings.twilio?.fromNumber;
      if (!hasTwilio) {
        html.push('<div style="background:#fff3e0;border:1px solid #EF9F27;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px;">');
        html.push('&#9888; Twilio not configured — automations will queue but not send. <span style="font-weight:700;cursor:pointer;color:#EF9F27;" onclick="App.nav(\'settings\')">Go to Settings →</span>');
        html.push('</div>');
      } else {
        html.push('<div style="background:#eaf3de;border:1px solid #1D9E75;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px;">');
        html.push('&#10003; Twilio connected — automations are active');
        html.push('</div>');
      }

      // Built-in automations
      html.push('<div class="section-header">Built-in Flows</div>');
      const builtIn = this._rules.filter(r => r.builtIn);
      builtIn.forEach((rule, i) => {
        html.push(Automations._renderRule(rule, i, true));
      });

      // Custom automations
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;">');
      html.push('<span>Custom Automations</span>');
      html.push('<button class="btn btn-sm btn-primary" onclick="Automations.openBuilder(null)">+ Create</button>');
      html.push('</div>');
      const custom = this._rules.filter(r => !r.builtIn);
      if (!custom.length) {
        html.push('<div class="card"><div style="text-align:center;padding:24px;color:var(--faint);font-size:13px;">');
        html.push('<div style="font-size:28px;margin-bottom:8px;">&#128172;</div>');
        html.push('No custom automations yet<br><span style="font-size:11px;">Create your own triggers with custom messages and timing</span>');
        html.push('</div></div>');
      } else {
        custom.forEach((rule, i) => {
          html.push(Automations._renderRule(rule, builtIn.length + i, false));
        });
      }

      // Recent automation log
      const log = settings.automationLog || [];
      if (log.length) {
        html.push('<div class="section-header">Recent Activity</div>');
        html.push('<div class="card" style="padding:0 16px;">');
        log.slice(-10).reverse().forEach(entry => {
          html.push('<div class="list-row" style="padding:10px 0;">');
          html.push('<div style="font-size:18px;">'+(entry.status==='sent'?'&#10003;':'&#9888;')+'</div>');
          html.push('<div class="list-main"><div style="font-size:13px;font-weight:600;">'+entry.ruleName+'</div>');
          html.push('<div style="font-size:11px;color:var(--muted);">'+entry.customerName+' &middot; '+fmtDateShort(entry.sentAt?.split('T')[0])+'</div></div>');
          html.push('<div style="font-size:11px;color:'+(entry.status==='sent'?'var(--green)':'var(--red)')+';">'+entry.status+'</div>');
          html.push('</div>');
        });
        html.push('</div>');
      }

      el.innerHTML = html.join('');
    } catch(e) {
      document.getElementById('page-automations').innerHTML = '<div class="error-banner">Could not load automations</div>';
    }
  },

  _renderRule(rule, idx, isBuiltIn) {
    const triggerLabels = {
      'checkin': '&#9986; On check-in',
      'appointment_booked': '&#128197; Appointment booked',
      'service_complete': '&#10003; Service complete',
      'hours_before': '&#9201; Hours before appointment',
      'hours_after': '&#9201; Hours after service',
      'days_after': '&#128197; Days after service',
      'days_inactive': '&#128197; Days since last visit',
    };
    const html = [];
    html.push('<div class="card" style="margin-bottom:10px;border-left:4px solid '+(rule.enabled?'#1D9E75':'#ccc')+';">');
    html.push('<div style="display:flex;align-items:flex-start;gap:12px;">');
    // Toggle
    html.push('<div onclick="Automations.toggle('+idx+')" style="margin-top:2px;cursor:pointer;">');
    html.push('<div style="width:40px;height:22px;border-radius:11px;background:'+(rule.enabled?'#1D9E75':'#ccc')+';position:relative;transition:background .2s;">');
    html.push('<div style="width:18px;height:18px;border-radius:50%;background:#fff;position:absolute;top:2px;'+(rule.enabled?'right:2px':'left:2px')+';transition:all .2s;box-shadow:0 1px 3px rgba(0,0,0,.2);"></div>');
    html.push('</div></div>');
    // Content
    html.push('<div style="flex:1;">');
    html.push('<div style="font-size:14px;font-weight:700;">'+rule.name+'</div>');
    html.push('<div style="font-size:12px;color:var(--muted);margin-top:2px;">'+(triggerLabels[rule.trigger]||rule.trigger));
    if (rule.triggerValue) html.push(' — '+rule.triggerValue+(rule.trigger.includes('hour')?'h':' days'));
    html.push('</div>');
    html.push('<div style="background:var(--surface2);border-radius:6px;padding:8px 10px;margin-top:8px;font-size:12px;color:var(--muted);line-height:1.5;">'+rule.message+'</div>');
    html.push('</div>');
    // Edit button for custom rules
    if (!isBuiltIn) {
      html.push('<button class="btn btn-sm" onclick="Automations.openBuilder('+idx+')">Edit</button>');
    } else {
      html.push('<button class="btn btn-sm" onclick="Automations.editMessage('+idx+')">&#9998;</button>');
    }
    html.push('</div></div>');
    return html.join('');
  },

  _defaultRules(settings) {
    const shopName = settings.shopName || 'Off-Kut Barbershop';
    const reviewLink = settings.googleReviewLink || 'g.page/offkut/review';
    return [
      {
        id: 'auto1', builtIn: true, enabled: true,
        name: 'Booking Confirmation',
        trigger: 'checkin',
        triggerValue: 0,
        message: `Hey {name}! You're checked in at ${shopName}. You're #{position} in line — estimated wait is {wait} minutes. We'll see you soon! ✂️`,
      },
      {
        id: 'auto2', builtIn: true, enabled: true,
        name: '24hr Appointment Reminder',
        trigger: 'hours_before',
        triggerValue: 24,
        message: `Hey {name}! Just a reminder you have an appointment tomorrow at {time} with {barber} at ${shopName}. See you then! ✂️`,
      },
      {
        id: 'auto3', builtIn: true, enabled: true,
        name: '48hr Review Request',
        trigger: 'hours_after',
        triggerValue: 48,
        message: `Hey {name}! Hope you're loving the fresh cut! If you have a minute, we'd really appreciate a Google review — it helps us out a lot. ${reviewLink} Thanks! — ${shopName}`,
      },
      {
        id: 'auto4', builtIn: true, enabled: true,
        name: '14 Day Re-book',
        trigger: 'days_after',
        triggerValue: 14,
        message: `Hey {name}! It's been 2 weeks — time for a fresh cut? Book with {barber} anytime, walk-ins always welcome at ${shopName}. ✂️`,
      },
      {
        id: 'auto5', builtIn: true, enabled: true,
        name: '30 Day Win-back',
        trigger: 'days_after',
        triggerValue: 30,
        message: `Hey {name}! We miss you at ${shopName}! It's been a month — come see us anytime. Walk-ins welcome. ✂️`,
      },
    ];
  },

  async toggle(idx) {
    this._rules[idx].enabled = !this._rules[idx].enabled;
    await this._save();
    toast(this._rules[idx].enabled ? 'Automation enabled' : 'Automation paused');
    this.render();
  },

  editMessage(idx) {
    const rule = this._rules[idx];
    const html = [];
    html.push('<div class="modal-title">Edit Message</div>');
    html.push('<div style="font-size:14px;font-weight:700;margin-bottom:4px;">'+rule.name+'</div>');
    html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">Available variables: {name} {barber} {service} {time} {position} {wait}</div>');
    html.push('<div class="form-group"><label class="form-label">Message</label>');
    html.push('<textarea class="form-input" id="am-message" rows="5" style="line-height:1.6;">'+rule.message+'</textarea></div>');
    html.push('<div style="font-size:11px;color:var(--faint);margin-bottom:14px;">Character count: <span id="am-count">'+rule.message.length+'</span>/160</div>');
    html.push('<div class="modal-actions">');
    html.push('<button id="am-btn" class="btn btn-full btn-primary" onclick="Automations.saveMessage('+idx+')">Save Message</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
    const ta = document.getElementById('am-message');
    const counter = document.getElementById('am-count');
    if (ta && counter) {
      ta.addEventListener('input', () => { counter.textContent = ta.value.length; });
    }
  },

  async saveMessage(idx) {
    const msg = document.getElementById('am-message')?.value.trim();
    if (!msg) { toast('Please enter a message', 'warning'); return; }
    const btn = document.getElementById('am-btn'); disableBtn(btn);
    this._rules[idx].message = msg;
    await this._save();
    Modal.close();
    toast('Message saved ✓');
    this.render();
  },

  openBuilder(idx) {
    const rule = idx !== null ? this._rules[idx] : null;
    const html = [];
    html.push('<div class="modal-title">'+(rule ? 'Edit Automation' : 'New Automation')+'</div>');
    html.push('<div class="form-group"><label class="form-label">Name *</label>');
    html.push('<input class="form-input" id="ab-name" value="'+(rule?.name||'')+'" placeholder="e.g. First visit thank you" /></div>');
    html.push('<div class="form-group"><label class="form-label">Trigger</label>');
    html.push('<select class="form-input" id="ab-trigger" onchange="Automations._updateTriggerUI()">');
    [
      ['checkin','On client check-in'],
      ['service_complete','When service is marked complete'],
      ['hours_before','Hours before appointment'],
      ['hours_after','Hours after service complete'],
      ['days_after','Days after last service'],
      ['days_inactive','Days since last visit (win-back)'],
    ].forEach(([v,l]) => {
      html.push('<option value="'+v+'"'+(rule?.trigger===v?' selected':'')+'>'+l+'</option>');
    });
    html.push('</select></div>');
    html.push('<div class="form-group" id="ab-value-group" style="'+(rule&&!['checkin','service_complete'].includes(rule.trigger)?'':'display:none')+'">');
    html.push('<label class="form-label" id="ab-value-label">Hours</label>');
    html.push('<input class="form-input" id="ab-value" type="number" value="'+(rule?.triggerValue||24)+'" style="max-width:100px;" /></div>');
    html.push('<div class="form-group"><label class="form-label">Message</label>');
    html.push('<div style="font-size:11px;color:var(--faint);margin-bottom:6px;">Variables: {name} {barber} {service} {time} {position} {wait}</div>');
    html.push('<textarea class="form-input" id="ab-message" rows="5" style="line-height:1.6;">'+(rule?.message||'')+' </textarea></div>');
    html.push('<div class="modal-actions">');
    if (rule && !rule.builtIn) html.push('<button class="btn btn-full" style="color:var(--red);" onclick="Automations.deleteRule('+idx+')">Delete</button>');
    html.push('<button id="ab-btn" class="btn btn-full btn-primary" onclick="Automations.saveRule('+(idx !== null ? idx : 'null')+')">Save</button>');
    html.push('<button class="btn btn-full" onclick="Modal.close()">Cancel</button>');
    html.push('</div>');
    Modal.show(html.join(''));
  },

  _updateTriggerUI() {
    const trigger = document.getElementById('ab-trigger')?.value;
    const group = document.getElementById('ab-value-group');
    const label = document.getElementById('ab-value-label');
    if (!group || !label) return;
    const needsValue = !['checkin','service_complete'].includes(trigger);
    group.style.display = needsValue ? '' : 'none';
    if (trigger.includes('hour')) label.textContent = 'Number of hours';
    else label.textContent = 'Number of days';
  },

  async saveRule(idx) {
    const name = document.getElementById('ab-name')?.value.trim();
    const message = document.getElementById('ab-message')?.value.trim();
    if (!name || !message) { toast('Please fill in name and message', 'warning'); return; }
    const btn = document.getElementById('ab-btn'); disableBtn(btn);
    const rule = {
      id: idx !== null ? this._rules[idx]?.id : genId('auto'),
      builtIn: false,
      enabled: true,
      name,
      trigger: document.getElementById('ab-trigger')?.value || 'days_after',
      triggerValue: parseInt(document.getElementById('ab-value')?.value) || 0,
      message,
    };
    if (idx !== null) this._rules[idx] = rule;
    else this._rules.push(rule);
    await this._save();
    Modal.close();
    toast(idx !== null ? 'Automation updated ✓' : 'Automation created ✓');
    this.render();
  },

  async deleteRule(idx) {
    if (!confirm('Delete this automation?')) return;
    this._rules.splice(idx, 1);
    await this._save();
    Modal.close();
    this.render();
    toast('Deleted');
  },

  async _save() {
    await db.settings.save({ automations: this._rules });
  },

  // ── Fire automation on trigger ──────────────────────────────────────────────
  // Called from queue.js on checkin, from queue complete, etc.
  async fire(trigger, context) {
    // context: { customerId, customerName, phone, barberId, barberName, service, position, waitMins, appointmentTime }
    try {
      const settings = await db.settings.get();
      const rules = settings.automations || Automations._defaultRules(settings);
      const activeRules = rules.filter(r => r.enabled && r.trigger === trigger);
      if (!activeRules.length) return;
      if (!context.phone) return; // No phone number — skip

      for (const rule of activeRules) {
        const message = Automations._interpolate(rule.message, context);
        try {
          const result = await db.sms.send({
            to: context.phone,
            body: message,
            customerId: context.customerId,
            customerName: context.customerName,
          });
          // Log it
          await Automations._log(rule, context, result.ok ? 'sent' : 'failed');
          if (result.ok) console.log('Auto SMS sent:', rule.name, '->', context.customerName);
          else console.warn('Auto SMS failed:', rule.name, result.error);
        } catch(e) {
          await Automations._log(rule, context, 'failed');
        }
      }
    } catch(e) {
      console.error('Automation fire error:', e);
    }
  },

  // Schedule a future automation (stores in pending queue)
  async schedule(trigger, context, delayHours) {
    try {
      const settings = await db.settings.get();
      const rules = settings.automations || Automations._defaultRules(settings);
      const matchingRules = rules.filter(r => r.enabled && r.trigger === trigger && r.triggerValue === delayHours);
      if (!matchingRules.length) return;
      const pending = settings.pendingAutomations || [];
      matchingRules.forEach(rule => {
        const fireAt = new Date(Date.now() + delayHours * 3600000).toISOString();
        // Don't duplicate
        const exists = pending.find(p => p.ruleId === rule.id && p.customerId === context.customerId && p.fireAt === fireAt);
        if (!exists) pending.push({ id: genId('pq'), ruleId: rule.id, ruleName: rule.name, fireAt, context, status: 'pending' });
      });
      await db.settings.save({ pendingAutomations: pending });
    } catch(e) { console.error('Schedule error:', e); }
  },

  // Process pending queue — call this periodically
  async processPending() {
    try {
      const settings = await db.settings.get();
      const pending = (settings.pendingAutomations || []).filter(p => p.status === 'pending');
      const now = new Date();
      const due = pending.filter(p => new Date(p.fireAt) <= now);
      if (!due.length) return;

      const rules = settings.automations || Automations._defaultRules(settings);
      for (const item of due) {
        const rule = rules.find(r => r.id === item.ruleId);
        if (!rule || !rule.enabled) { item.status = 'skipped'; continue; }
        const message = Automations._interpolate(rule.message, item.context);
        try {
          const result = await db.sms.send({ to: item.context.phone, body: message, customerId: item.context.customerId, customerName: item.context.customerName });
          item.status = result.ok ? 'sent' : 'failed';
          await Automations._log(rule, item.context, item.status);
        } catch(e) { item.status = 'failed'; }
      }

      // Save updated statuses — keep last 100
      const all = settings.pendingAutomations || [];
      const updated = all.map(p => due.find(d => d.id === p.id) || p);
      await db.settings.save({ pendingAutomations: updated.slice(-100) });
    } catch(e) { console.error('Process pending error:', e); }
  },

  _interpolate(template, ctx) {
    return template
      .replace(/{name}/g,     ctx.customerName?.split(' ')[0] || 'there')
      .replace(/{fullname}/g, ctx.customerName || '')
      .replace(/{barber}/g,   ctx.barberName || 'your barber')
      .replace(/{service}/g,  ctx.service || 'your service')
      .replace(/{time}/g,     ctx.appointmentTime || '')
      .replace(/{position}/g, ctx.position || '')
      .replace(/{wait}/g,     ctx.waitMins || '');
  },

  async _log(rule, context, status) {
    try {
      const settings = await db.settings.get();
      const log = settings.automationLog || [];
      log.push({ ruleId: rule.id, ruleName: rule.name, customerId: context.customerId, customerName: context.customerName, status, sentAt: new Date().toISOString() });
      await db.settings.save({ automationLog: log.slice(-200) }); // Keep last 200
    } catch(e) {}
  },
};

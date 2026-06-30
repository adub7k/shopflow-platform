// ── Global Client Profile — detailing-shop dashboard ─────────────────────────
// Full-page profile rendered into the #cp-overlay. Built for an auto-detailing
// operation: vehicles (first-class, with VIN/plate/mileage/ceramic/notes),
// service history, before/after photos, per-vehicle revenue, a retention engine,
// tags, and timestamped notes. Opened from anywhere via ClientProfile.open(id).
//
// No new backend: vehicles/tags/noteLog live on the customer record and persist
// via db.customers.save(); appointments are matched to a vehicle by vehicleId or
// (year/make/model); "Create Invoice" records a completed paid job via the
// existing appointment complete/checkout path.

const CP_PRESET_TAGS = ['VIP', 'Ceramic Coating Client', 'Paint Correction Client', 'Tint Customer', 'Fleet Customer', 'Monthly Customer', 'High Value Client'];

const _cpVal = (id) => (document.getElementById(id)?.value || '').trim();
const _cpVn  = (s) => String(s || '').trim().toLowerCase();
const _cpVehKey  = (v) => [_cpVn(v.year), _cpVn(v.make), _cpVn(v.model)].join('|');
const _cpApptKey = (a) => { const cf = a.customFields || {}; return [_cpVn(cf.vehicleYear), _cpVn(cf.vehicleMake), _cpVn(cf.vehicleModel)].join('|'); };
const _cpMatch   = (a, v) => (a.vehicleId && a.vehicleId === v.id) || (_cpVehKey(v) !== '||' && _cpApptKey(a) === _cpVehKey(v));
function _cpNowTime() { const d = new Date(); let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; }
function _cpDaysAgo(date) { return Math.floor((Date.now() - new Date(date + 'T12:00:00')) / 86400000); }
// Open the device Messages app prefilled with recipient + draft (iPhone sms: deep
// link — no Twilio/A2P needed; the owner sends from their own number). iOS uses
// `&body`; we strip the number to digits/+.
function _cpSms(phone, body) {
  const tel = String(phone || '').replace(/[^\d+]/g, '');
  if (!tel) { toast('No phone number on file', 'warning'); return; }
  window.location.href = 'sms:' + tel + (body ? '&body=' + encodeURIComponent(body) : '');
}

// ── Shared SMS templates ──────────────────────────────────────────────────────
// The owner's editable message presets (Settings → Message Templates). Stored as a
// list of { id, label, body }; merge fields {first}/{name}/{shop}/{date}/{time}/
// {service}/{link} are filled per-recipient at send time. Used by the Messages
// composer, the Tasks worklist, and the manual review/reminder prompts. No Twilio:
// every send is the owner tapping the iPhone sms: deep link (_cpSms).
const SMS_TEMPLATE_DEFAULTS = [
  { id: 'confirmation', label: 'Appointment confirmation', body: 'Hi {first}! Your appointment at {shop} is confirmed for {date} at {time}. See you then!' },
  { id: 'reminder',     label: 'Appointment reminder',     body: 'Hi {first}! Reminder: your appointment at {shop} is on {date} at {time}. See you then!' },
  { id: 'rebook',       label: 'Time to rebook',           body: "Hi {first}! It's been a while — we'd love to get your vehicle looking fresh again at {shop}. Want to get on the schedule?" },
  { id: 'review',       label: 'Review request',           body: 'Hi {first}, thanks for visiting {shop}! We\'d love a quick review: {link}' },
];
// Human labels for legacy keyed-object templates, so a one-time migration keeps the
// owner's wording.
const _SMS_LEGACY_LABELS = { confirmation: 'Appointment confirmation', reminder: 'Appointment reminder', rebook: 'Time to rebook', review: 'Review request', missedCall: 'Missed call' };

// Return the shop's templates as a normalized [{id,label,body}] list. Accepts the
// new list shape as-is, migrates the legacy keyed object, and falls back to the
// defaults when nothing is saved.
function _smsTemplates(explicit) {
  const raw = (arguments.length ? explicit : (typeof Shop !== 'undefined' && Shop.settings && Shop.settings.smsTemplates)) || null;
  if (Array.isArray(raw)) {
    return raw.filter(t => t && (t.label || t.body))
      .map(t => ({ id: t.id || genId('tpl'), label: t.label || 'Template', body: String(t.body || '') }));
  }
  // Legacy keyed object → seed defaults, overlay any saved bodies, append extras.
  const legacy = (raw && typeof raw === 'object') ? raw : {};
  const list = SMS_TEMPLATE_DEFAULTS.map(d => ({ ...d, body: (typeof legacy[d.id] === 'string' && legacy[d.id]) ? legacy[d.id] : d.body }));
  Object.keys(legacy).forEach(k => {
    if (!list.some(t => t.id === k) && typeof legacy[k] === 'string' && legacy[k]) {
      list.push({ id: k, label: _SMS_LEGACY_LABELS[k] || k, body: legacy[k] });
    }
  });
  return list;
}
// Look up one template body by id, falling back to the matching default.
function _smsTemplateBody(id) {
  const found = _smsTemplates().find(t => t.id === id);
  if (found) return found.body;
  const def = SMS_TEMPLATE_DEFAULTS.find(t => t.id === id);
  return def ? def.body : '';
}
// Pure merge-field substitution (no formatting — pass already-formatted date/time).
function _smsFill(body, vars) {
  const v = vars || {};
  return String(body || '')
    .replace(/\{first\}/g,   v.first   || 'there')
    .replace(/\{name\}/g,    v.name    || 'there')
    .replace(/\{shop\}/g,    v.shop    || 'us')
    .replace(/\{date\}/g,    v.date    || '')
    .replace(/\{time\}/g,    v.time    || '')
    .replace(/\{service\}/g, v.service || '')
    .replace(/\{link\}/g,    v.link    || '');
}

const ClientProfile = {
  _data: null, _services: [], _messages: [], _recs: [],

  async open(id) {
    const overlay = document.getElementById('cp-overlay');
    const body    = document.getElementById('cp-body');
    const title   = document.getElementById('cp-header-name');
    if (!overlay) return;
    body.innerHTML = '<div class="empty-state" style="padding:60px 20px;"><div class="loading-dots" style="justify-content:center;margin:0 auto;"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div></div>';
    title.textContent = 'Loading…';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    try {
      const [data, messages, services] = await Promise.all([
        db.customers.get(id),
        db.conversations.forCustomer(id).catch(() => []),
        db.services.all().catch(() => []),
      ]);
      // One-time client-side backfill: give every vehicle a stable id so edit /
      // delete / per-vehicle rollups can key on it.
      const c = data.customer;
      let changed = false;
      (c.vehicles || []).forEach(v => { if (!v.id) { v.id = genId('veh'); changed = true; } });
      if (changed) { try { await db.customers.save(c); } catch (e) { /* non-fatal */ } }
      // Catch up any paid-but-unmarked deposits with Square (the success redirect
      // can be missed) so they show in the notes without waiting on a webhook.
      if ((c.deposits || []).some(d => d.status === 'sent' && d.orderId) && db.square && db.square.reconcileDeposits) {
        try {
          const rec = await db.square.reconcileDeposits(c.id);
          if (rec && rec.ok && rec.updated && rec.customer) { c.noteLog = rec.customer.noteLog; c.deposits = rec.customer.deposits; }
        } catch (e) { /* non-fatal */ }
      }
      this._data = data; this._messages = messages; this._services = services;
      // Make this customer editable from any entry point (Dashboard/Leads open the
      // profile without rendering the Clients list, so Clients._data may be empty).
      try { if (typeof Clients !== 'undefined') { Clients._data = Clients._data || []; const i = Clients._data.findIndex(x => x.id === c.id); if (i >= 0) Clients._data[i] = c; else Clients._data.push(c); } } catch (e) { /* ignore */ }
      title.textContent = c.name;
      body.innerHTML = _buildProfileHtml(data, services, messages);
      body.scrollTop = 0;
    } catch (e) {
      body.innerHTML = '<div class="empty-state">Could not load client profile.</div>';
    }
  },

  close() {
    const overlay = document.getElementById('cp-overlay');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  },

  // Close the overlay, then jump to the appointment form prefilled for this client.
  schedule(custId) {
    const c = this._data && this._data.customer;
    if (typeof Appointments !== 'undefined') Appointments._prefill = { customerId: custId, customerName: c ? c.name : '', customerPhone: c ? (c.phone || '') : '' };
    this.close();
    if (typeof App !== 'undefined') App.nav('appointments');
  },

  // ── Membership ──────────────────────────────────────────────────────────────
  enrollPrompt(custId) {
    const plans = Shop.membershipPlans || [];
    if (!plans.length) { toast('Add a membership plan in Settings first', 'warning'); return; }
    const stripeOn = !!(Shop.settings && Shop.settings.stripe && Shop.settings.stripe.onboardingComplete);
    Modal.show(`
      <div class="modal-title">⭐ Enroll in a plan</div>
      ${plans.map(p => `<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;">
        <div><div style="font-size:14px;font-weight:700;">${esc(p.name)}</div><div style="font-size:12px;color:var(--muted);">${fmtMoney(p.price)}/${p.interval === 'year' ? 'yr' : 'mo'}${p.perks ? ' · ' + esc(p.perks) : ''}</div></div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          ${stripeOn ? `<button class="btn btn-sm btn-primary" style="flex:1;" onclick="ClientProfile.enrollStripe('${custId}','${p.id}')">💳 Card subscription</button>` : ''}
          <button class="btn btn-sm" style="flex:1;" onclick="ClientProfile.enrollManual('${custId}','${p.id}')">Mark as member</button>
        </div>
      </div>`).join('')}
      <div class="modal-actions"><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>`);
  },
  async enrollManual(custId, planId) {
    try { await db.customers.enroll(custId, planId); Modal.close(); toast('Enrolled ✓'); this.open(custId); }
    catch (e) { toast('Could not enroll', 'error'); }
  },
  async enrollStripe(custId, planId) {
    try {
      const r = await db.customers.membershipCheckout(custId, planId);
      if (r && r.ok && r.url) { window.open(r.url, '_blank'); Modal.close(); toast('Subscription checkout opened'); }
      else { toast((r && r.error) || 'Could not start subscription', 'error'); }
    } catch (e) { toast(e.message || 'Could not start subscription', 'error'); }
  },
  async cancelMembership(custId) {
    if (!confirm('Cancel this membership?')) return;
    try { await db.customers.cancelMembership(custId); toast('Membership canceled'); this.open(custId); }
    catch (e) { toast('Could not cancel', 'error'); }
  },

  // ── Vehicles ──────────────────────────────────────────────────────────────
  vehiclePrompt(custId, vehId) {
    const c = this._data.customer;
    const v = vehId ? (c.vehicles || []).find(x => x.id === vehId) : null;
    Modal.show(`
      <div class="modal-title">${v ? '🚗 Edit Vehicle' : '🚗 Add Vehicle'}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-group"><label class="form-label">Year</label><input class="form-input" id="v-year" value="${v ? esc(v.year || '') : ''}" placeholder="2022"></div>
        <div class="form-group"><label class="form-label">Make</label><input class="form-input" id="v-make" value="${v ? esc(v.make || '') : ''}" placeholder="Mercedes"></div>
        <div class="form-group"><label class="form-label">Model</label><input class="form-input" id="v-model" value="${v ? esc(v.model || '') : ''}" placeholder="GLC300"></div>
        <div class="form-group"><label class="form-label">Color</label><input class="form-input" id="v-color" value="${v ? esc(v.color || '') : ''}" placeholder="Black"></div>
        <div class="form-group"><label class="form-label">VIN</label><input class="form-input" id="v-vin" value="${v ? esc(v.vin || '') : ''}"></div>
        <div class="form-group"><label class="form-label">License Plate</label><input class="form-input" id="v-plate" value="${v ? esc(v.plate || '') : ''}"></div>
        <div class="form-group"><label class="form-label">Mileage</label><input class="form-input" id="v-mileage" value="${v ? esc(v.mileage || '') : ''}" placeholder="31500"></div>
        <div class="form-group" style="display:flex;align-items:center;gap:8px;padding-top:24px;"><input type="checkbox" id="v-ceramic" ${v && v.ceramicCoated ? 'checked' : ''} style="width:auto;"><label for="v-ceramic" style="margin:0;font-size:13px;cursor:pointer;">🛡️ Ceramic coated</label></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="v-notes" placeholder="Swirl marks on hood, owner prefers fragrance-free...">${v ? esc(v.notes || '') : ''}</textarea></div>
      <div class="modal-actions">
        ${v ? `<button class="btn btn-danger btn-full" onclick="ClientProfile.deleteVehicle('${custId}','${v.id}')">Delete Vehicle</button>` : ''}
        <button id="v-btn" class="btn btn-primary btn-full" onclick="ClientProfile.saveVehicle('${custId}','${v ? v.id : ''}')">Save</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
  },
  async saveVehicle(custId, vehId) {
    const c = this._data.customer;
    const v = {
      id: vehId || genId('veh'),
      year: _cpVal('v-year'), make: _cpVal('v-make'), model: _cpVal('v-model'), color: _cpVal('v-color'),
      vin: _cpVal('v-vin'), plate: _cpVal('v-plate'), mileage: _cpVal('v-mileage'),
      ceramicCoated: !!document.getElementById('v-ceramic')?.checked, notes: _cpVal('v-notes'),
    };
    if (!v.make && !v.model && !v.year) { toast('Enter at least a make or model', 'warning'); return; }
    c.vehicles = c.vehicles || [];
    const idx = c.vehicles.findIndex(x => x.id === vehId);
    if (idx >= 0) c.vehicles[idx] = { ...c.vehicles[idx], ...v }; else c.vehicles.push(v);
    const btn = document.getElementById('v-btn'); disableBtn(btn);
    try { await db.customers.save(c); Modal.close(); toast('Vehicle saved ✓'); this.open(custId); }
    catch (e) { toast('Could not save', 'error'); enableBtn(btn); }
  },
  async deleteVehicle(custId, vehId) {
    if (!confirm('Remove this vehicle?')) return;
    const c = this._data.customer; c.vehicles = (c.vehicles || []).filter(x => x.id !== vehId);
    try { await db.customers.save(c); Modal.close(); toast('Vehicle removed'); this.open(custId); }
    catch (e) { toast('Could not remove', 'error'); }
  },

  // ── Tags ──────────────────────────────────────────────────────────────────
  async toggleTag(custId, tag) {
    const c = this._data.customer; const set = new Set(c.tags || []);
    set.has(tag) ? set.delete(tag) : set.add(tag);
    c.tags = [...set];
    try { await db.customers.save(c); this.open(custId); }
    catch (e) { toast('Could not update tags', 'error'); }
  },

  // ── Timestamped notes ───────────────────────────────────────────────────────
  notePrompt(custId) {
    const c = this._data.customer;
    const vehOpts = (c.vehicles || []).map(v => `<option value="${v.id}">${esc([v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle')}</option>`).join('');
    Modal.show(`
      <div class="modal-title">📝 Add Note</div>
      <div class="form-group"><label class="form-label">Type</label>
        <select class="form-input" id="note-scope" onchange="document.getElementById('note-veh-wrap').style.display=this.value==='vehicle'?'block':'none'">
          <option value="customer">Customer note</option>
          <option value="internal">Internal shop note</option>
          ${vehOpts ? '<option value="vehicle">Vehicle note</option>' : ''}
        </select></div>
      <div class="form-group" id="note-veh-wrap" style="display:none;"><label class="form-label">Vehicle</label><select class="form-input" id="note-veh">${vehOpts}</select></div>
      <div class="form-group"><label class="form-label">Note</label><textarea class="form-input" id="note-text" style="min-height:90px;"></textarea></div>
      <div class="modal-actions"><button id="note-btn" class="btn btn-primary btn-full" onclick="ClientProfile.saveNote('${custId}')">Save Note</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>`);
  },
  async saveNote(custId) {
    const c = this._data.customer; const text = _cpVal('note-text');
    if (!text) { toast('Enter a note', 'warning'); return; }
    const scope = document.getElementById('note-scope').value;
    const note = { id: genId('note'), scope, text, at: new Date().toISOString(), by: (Auth.getName && Auth.getName()) || '' };
    if (scope === 'vehicle') note.vehicleId = document.getElementById('note-veh').value;
    c.noteLog = c.noteLog || []; c.noteLog.unshift(note);
    const btn = document.getElementById('note-btn'); disableBtn(btn);
    try { await db.customers.save(c); Modal.close(); toast('Note added ✓'); this.open(custId); }
    catch (e) { toast('Could not save note', 'error'); enableBtn(btn); }
  },

  // ── Create invoice (records a completed paid job via the checkout path) ──────
  invoicePrompt(custId) {
    const c = this._data.customer;
    const svcOpts = (this._services || []).map(s => `<option value="${s.id}" data-price="${Number(s.price) || 0}">${esc(s.name)} · ${fmtMoney(s.price)}</option>`).join('');
    const vehOpts = (c.vehicles || []).map(v => `<option value="${v.id}">${esc([v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle')}</option>`).join('');
    Modal.show(`
      <div class="modal-title">🧾 Create Invoice</div>
      <div class="form-group"><label class="form-label">Service</label>
        <select class="form-input" id="inv-service" onchange="var o=this.options[this.selectedIndex];document.getElementById('inv-price').value=o?o.getAttribute('data-price'):''">
          <option value="">— custom —</option>${svcOpts}
        </select></div>
      <div class="form-group" id="inv-desc-wrap"><label class="form-label">Description (if custom)</label><input class="form-input" id="inv-desc" placeholder="e.g. Paint correction"></div>
      ${vehOpts ? `<div class="form-group"><label class="form-label">Vehicle</label><select class="form-input" id="inv-veh"><option value="">—</option>${vehOpts}</select></div>` : '<input type="hidden" id="inv-veh" value="">'}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-group"><label class="form-label">Amount</label><input class="form-input" id="inv-price" type="number" min="0" step="1" placeholder="0"></div>
        <div class="form-group"><label class="form-label">Tip (optional)</label><input class="form-input" id="inv-tip" type="number" min="0" step="1" placeholder="0"></div>
      </div>
      <div class="modal-actions"><button id="inv-btn" class="btn btn-green btn-full" onclick="ClientProfile.saveInvoice('${custId}')">Record Invoice</button><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>`);
  },
  async saveInvoice(custId) {
    const c = this._data.customer;
    const serviceId = document.getElementById('inv-service').value;
    const svc = (this._services || []).find(s => s.id === serviceId);
    const price = parseFloat(document.getElementById('inv-price').value) || 0;
    const tip   = parseFloat(document.getElementById('inv-tip').value) || 0;
    const vehId = document.getElementById('inv-veh').value;
    const veh   = (c.vehicles || []).find(v => v.id === vehId);
    if (!price) { toast('Enter an amount', 'warning'); return; }
    const btn = document.getElementById('inv-btn'); disableBtn(btn);
    const appt = {
      id: genId('a'), customerId: c.id, customerName: c.name, customerPhone: c.phone || '', customerEmail: c.email || '',
      serviceId: svc ? svc.id : null, service: svc ? svc.name : (_cpVal('inv-desc') || 'Service'),
      price, tip, date: today(), time: _cpNowTime(), status: 'confirmed', source: 'crm',
      vehicleId: veh ? veh.id : null,
      customFields: veh ? { vehicleYear: veh.year || '', vehicleMake: veh.make || '', vehicleModel: veh.model || '', vehicleColor: veh.color || '' } : {},
    };
    try {
      await db.appointments.save(appt);
      await db.appointments.complete(appt.id, { price });
      Modal.close(); toast('Invoice recorded ✓'); this.open(custId);
    } catch (e) { toast(e.message || 'Could not record invoice', 'error'); enableBtn(btn); }
  },

  // ── Texting — pick a template, then open Messages prefilled (no A2P/Twilio) ──
  // Both entry points open a picker first instead of jumping straight to Messages:
  //  • textPrompt → generic "Text {name}" (owner's saved templates + blank custom)
  //  • sendRec    → seeds the picker with the recommendation's tailored follow-up
  textPrompt(custId) { this._textModal(); },
  sendRec(custId, i) { const rec = (this._recs || [])[i]; this._textModal(rec ? rec.sms : ''); },

  // Merge-field values for this client (next confirmed appt fills {date}/{time}/{service}).
  _textVars() {
    const c = (this._data && this._data.customer) || {};
    const next = (this._data && this._data.appointments || [])
      .filter(a => a.status === 'confirmed' && a.date >= today())
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    return {
      first: (c.name || 'there').split(' ')[0], name: c.name || 'there',
      shop: (Shop.settings && Shop.settings.shopName) || 'us',
      link: (Shop.settings && Shop.settings.googleReviewLink) || '',
      date: next ? fmtDateFull(next.date) : '', time: (next && next.time) || '', service: (next && next.service) || '',
    };
  },

  _textModal(suggested) {
    const c = (this._data && this._data.customer) || {};
    if (!c.phone) { toast('No phone number on file', 'warning'); return; }
    this._textPhone = c.phone;
    // First option = the tailored suggestion (when there is one), then the owner's
    // saved templates, then a blank custom message.
    const head = suggested ? [{ label: 'Suggested message', body: suggested }] : [];
    this._textOpts = head.concat(_smsTemplates()).concat([{ label: 'Custom (blank)', body: '' }]);
    Modal.show(
      '<div class="modal-title">Text ' + esc(c.name || 'client') + '</div>'
      + '<div class="form-group"><label class="form-label">Template</label>'
      +   '<select class="form-input" id="cp-text-tpl" onchange="ClientProfile._fillText()">'
      +     this._textOpts.map((o, i) => `<option value="${i}">${esc(o.label)}</option>`).join('')
      +   '</select></div>'
      + '<div class="form-group"><label class="form-label">Message <span style="font-weight:400;color:var(--muted);">(edit as needed)</span></label>'
      +   '<textarea class="form-input" id="cp-text-body" rows="4"></textarea></div>'
      + '<button class="btn btn-green btn-full" onclick="ClientProfile._sendText()">📲 Open in Messages</button>'
      + '<div class="modal-actions"><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>'
    );
    setTimeout(() => this._fillText(), 0);
  },

  _fillText() {
    const i = +(document.getElementById('cp-text-tpl') || {}).value || 0;
    const o = this._textOpts[i] || { body: '' };
    const ta = document.getElementById('cp-text-body');
    if (ta) ta.value = _smsFill(o.body, this._textVars());   // a pre-filled suggestion stays as-is
  },

  _sendText() {
    const body = (document.getElementById('cp-text-body') || {}).value || '';
    Modal.close();
    _cpSms(this._textPhone, body);   // opens iPhone Messages prefilled
  },

  // ── Request a deposit ────────────────────────────────────────────────────────
  // Opens a dialog to set the deposit amount, builds a checkout link (the shop's
  // connected Square/Stripe) for the client's next upcoming appointment, then opens
  // Messages prefilled with the link. Pay → confirm reuses the booking-page path
  // (success redirect records depositPaid). Works whenever a processor is connected
  // — independent of the "require deposit to book" toggle.
  _depositCtx: null,

  async requestDeposit(custId) {
    const c = this._data && this._data.customer;
    if (!c || !c.phone) { toast('No phone number on file', 'warning'); return; }
    const slug = (typeof Auth !== 'undefined' && Auth.getShopSlug && Auth.getShopSlug()) || '';
    let info;
    try { info = await fetch('/api/public/' + slug + '/info').then(r => r.json()); }
    catch (e) { toast('Could not load payment settings', 'error'); return; }
    if (!info || info.depositProvider !== 'square') {
      toast('Connect Square in Settings to send deposit links', 'warning'); return;
    }
    this._depositCtx = { slug, custId, phone: c.phone, name: c.name };
    const defAmt = (info.deposit && info.deposit.amount) || 50;
    const quick = [25, 50, 75, 100, 150];
    Modal.show(
      '<div class="modal-title">Request deposit</div>'
      + `<div style="font-size:13px;color:var(--muted);margin:-4px 0 14px;">Text ${esc(c.name)} a link to pay a deposit. It's logged in their notes (and marked paid when they pay).</div>`
      + '<div class="form-group"><label class="form-label">Deposit amount</label>'
      +   '<div style="position:relative;"><span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);font-weight:700;color:var(--muted);">$</span>'
      +   `<input class="form-input" id="cp-dep-amt" type="number" min="1" value="${defAmt}" style="padding-left:24px;" /></div></div>`
      + '<div class="form-group"><div style="display:flex;gap:6px;flex-wrap:wrap;">'
      +   quick.map(a => `<button type="button" class="btn btn-sm" onclick="document.getElementById('cp-dep-amt').value=${a}">$${a}</button>`).join('')
      +   '</div></div>'
      + '<button class="btn btn-green btn-full" onclick="ClientProfile._sendDeposit()">📲 Text deposit link</button>'
      + '<div class="modal-actions"><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>'
    );
  },

  async _sendDeposit() {
    const ctx = this._depositCtx; if (!ctx) return;
    const amount = Math.max(1, Math.round(Number(document.getElementById('cp-dep-amt')?.value) || 0));
    if (!amount) { toast('Enter a deposit amount', 'warning'); return; }
    toast('Building deposit link…');
    try {
      const r = await fetch('/api/public/' + ctx.slug + '/square-customer-deposit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: ctx.custId, amount }),
      }).then(r => r.json());
      if (!r || !r.ok || !r.url) { toast(r && r.error ? r.error : 'Could not create the deposit link', 'error'); return; }
      Modal.close();
      toast('Deposit link ready — logged to notes ✓');
      const first = (ctx.name || 'there').split(' ')[0];
      const shop = (Shop.settings && Shop.settings.shopName) || 'us';
      const body = `Hi ${first}! Here's the link to pay your $${amount} deposit at ${shop}: ${r.url}`;
      this.open(ctx.custId);     // refresh so the "Sent deposit link" note shows now
      _cpSms(ctx.phone, body);   // opens Messages prefilled with the deposit link
    } catch (e) { toast('Could not create the deposit link', 'error'); }
  },
};

// ── Retention recommendations (heuristic, from service history) ────────────────
function _cpRecommendations(doneAppts, rebookInterval, daysSinceLast) {
  const recs = [];
  const ceramic = doneAppts.filter(a => (a.service || '').toLowerCase().includes('ceramic')).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (ceramic && _cpDaysAgo(ceramic.date) >= 150) {
    recs.push({ icon: '🛡️', title: 'Ceramic inspection due', detail: `Coating applied ${_cpDaysAgo(ceramic.date)} days ago (${fmtDateShort(ceramic.date)})`, sms: `Hi! It's time for your ceramic coating inspection & maintenance — let's keep that protection performing. Want to get on the schedule?` });
  }
  if (daysSinceLast !== null && daysSinceLast >= rebookInterval) {
    recs.push({ icon: '🚿', title: 'Maintenance wash due', detail: `${daysSinceLast} days since last visit`, sms: `It's been a little while — ready to get your vehicle looking fresh again? Book a maintenance wash anytime.` });
  }
  const interior = doneAppts.filter(a => (a.service || '').toLowerCase().includes('interior')).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!interior || _cpDaysAgo(interior.date) >= 120) {
    recs.push({ icon: '🧽', title: 'Interior detail due', detail: interior ? `Last interior ${_cpDaysAgo(interior.date)} days ago` : 'No interior detail on record', sms: `Your interior is due for a deep clean — want me to get it on the calendar?` });
  }
  if (daysSinceLast !== null && daysSinceLast >= 90) {
    recs.push({ icon: '👋', title: 'Win-back campaign', detail: `No visit in ${daysSinceLast} days — at risk`, sms: `We miss you! Come back in and we'll take great care of your vehicle. Reply here to book.` });
  }
  return recs;
}

// ── Dashboard builder ─────────────────────────────────────────────────────────
function _buildProfileHtml(data, services, messages) {
  const c = data.customer;
  const allAppts  = data.appointments || [];
  const doneAppts = allAppts.filter(a => a.status === 'done').sort((a, b) => b.date.localeCompare(a.date));
  const upcoming  = allAppts.filter(a => a.status === 'confirmed' && a.date >= today()).sort((a, b) => a.date.localeCompare(b.date));
  const vehicles  = c.vehicles || [];
  const daysSinceLast  = data.daysSinceLast ?? null;
  const rebookInterval = data.rebookInterval || 21;
  const totalRevenue   = Number(data.totalRevenue) || 0;
  const totalVisits    = data.totalVisits || 0;
  const avgTicket      = totalVisits ? totalRevenue / totalVisits : 0;
  const lastService    = doneAppts[0];
  const write = (typeof canWrite === 'function') ? canWrite() : true;

  const recs = _cpRecommendations(doneAppts, rebookInterval, daysSinceLast);
  ClientProfile._recs = recs;

  const apptsForVeh  = (v) => doneAppts.filter(a => _cpMatch(a, v));
  const photosForVeh = (v) => {
    const out = [];
    allAppts.filter(a => _cpMatch(a, v)).forEach(a => {
      (a.beforePhotos || []).forEach(p => out.push({ ...p, phase: 'Before', date: a.date }));
      (a.afterPhotos || []).forEach(p => out.push({ ...p, phase: 'After', date: a.date }));
      (a.intakePhotos || []).forEach(p => out.push({ ...p, phase: 'Intake', date: a.date }));
    });
    return out;
  };
  const thumb = (p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.phase || '')} · ${fmtDateShort(p.date) || ''}" style="display:block;width:62px;height:62px;border-radius:8px;overflow:hidden;border:1px solid var(--border);flex-shrink:0;"><img src="${esc(p.url)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;"></a>`;
  const stat = (label, val, color) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px;text-align:center;min-width:0;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;letter-spacing:.04em;">${label}</div><div style="font-size:19px;font-weight:800;color:${color || 'var(--text)'};">${val}</div></div>`;
  const qa = (onclick, ic, label, href) => href
    ? `<a class="cp-qa" href="${href}"><span class="ic">${ic}</span>${label}</a>`
    : `<button class="cp-qa" onclick="${onclick}"><span class="ic">${ic}</span>${label}</button>`;

  // Retention status
  const rs = daysSinceLast === null ? { label: 'New client', color: 'var(--muted)', bg: 'var(--surface)', bd: 'var(--border)' }
    : daysSinceLast >= 90 ? { label: 'At risk', color: '#dc2626', bg: '#fff5f5', bd: '#fecaca' }
    : daysSinceLast >= rebookInterval ? { label: 'Needs follow-up', color: '#d97706', bg: '#fffbeb', bd: '#fde68a' }
    : { label: 'Active customer', color: 'var(--green)', bg: 'var(--green-lt)', bd: '#b3dfbf' };
  const dslLabel = daysSinceLast === null ? '—' : daysSinceLast === 0 ? 'Today' : daysSinceLast === 1 ? '1 day' : daysSinceLast + ' days';

  let h = '';

  // ══ HEADER ══
  h += `<div class="cp-card" style="margin-bottom:14px;">`;
  h += `<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
    ${avatarEl(c.name, 52)}
    <div style="flex:1;min-width:0;">
      <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;">${esc(c.name)}${c.isFleet ? ' <span style="font-size:11px;font-weight:700;color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:2px 7px;vertical-align:middle;">🚚 Fleet</span>' : ''}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px;">
        ${c.phone ? `<a href="tel:${c.phone}" style="color:var(--muted);text-decoration:none;">${esc(c.phone)}</a>` : 'No phone'}
        ${c.email ? ' · ' + esc(c.email) : ''}
        · Customer since ${fmtDateShort(c.createdAt) || '—'}
        · Last visit ${lastService ? fmtDateShort(lastService.date) : '—'}
      </div>
    </div>
    ${write ? `<button onclick="ClientProfile.close();Clients.openForm('${c.id}')" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;color:var(--text);cursor:pointer;flex-shrink:0;">Edit</button>` : ''}
  </div>`;

  // Quick stats
  h += `<div class="cp-stats">
    ${stat('LIFETIME SPEND', fmtMoney(totalRevenue), 'var(--green)')}
    ${stat('TOTAL VISITS', totalVisits)}
    ${stat('AVG TICKET', fmtMoney(avgTicket))}
    ${stat('LAST SERVICE', lastService ? dslLabel : '—', rs.color)}
  </div>`;

  // Quick actions
  if (write) {
    h += `<div class="cp-actions">
      ${qa(`ClientProfile.schedule('${c.id}')`, '📅', 'Schedule')}
      ${qa(`ClientProfile.invoicePrompt('${c.id}')`, '🧾', 'Invoice')}
      ${qa(`ClientProfile.requestDeposit('${c.id}')`, '💳', 'Deposit')}
      ${qa(`ClientProfile.textPrompt('${c.id}')`, '💬', 'Send Text')}
      ${c.phone ? qa('', '📞', 'Call', 'tel:' + c.phone) : ''}
      ${qa(`ClientProfile.vehiclePrompt('${c.id}')`, '🚗', 'Add Vehicle')}
    </div>`;
  }
  h += `</div>`;

  // Tags
  if (write || (c.tags || []).length) {
    const active = new Set(c.tags || []);
    const tagList = write ? CP_PRESET_TAGS.slice() : [...active];
    (c.tags || []).forEach(t => { if (!tagList.includes(t)) tagList.push(t); });
    h += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">`;
    tagList.forEach(t => {
      const on = active.has(t);
      h += `<span class="cp-tag ${on ? '' : 'off'}" ${write ? `onclick="ClientProfile.toggleTag('${c.id}','${esc(t)}')"` : 'style="cursor:default;"'}>${on ? '✓ ' : ''}${esc(t)}</span>`;
    });
    h += `</div>`;
  }

  // Membership / flags banners
  const m = c.membership; const plans = Shop.membershipPlans || [];
  if (m && (m.status === 'active' || m.status === 'past_due')) {
    h += `<div style="background:linear-gradient(135deg,rgba(124,58,237,.07),rgba(124,58,237,.02));border:1px solid #ddd6fe;border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div><div style="font-size:13px;font-weight:700;color:#6d28d9;">⭐ ${esc(m.planName)}</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">${fmtMoney(m.price)}/${m.interval === 'year' ? 'yr' : 'mo'} · ${m.source === 'stripe' ? 'Auto-billing' : 'Manual'}${m.status === 'past_due' ? ' · <span style="color:#dc2626;">⚠ past due</span>' : ''}</div></div>
      ${write ? `<button onclick="ClientProfile.cancelMembership('${c.id}')" style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:5px 10px;font-size:11px;font-weight:600;color:var(--muted);cursor:pointer;flex-shrink:0;">Cancel</button>` : ''}
    </div>`;
  } else if (plans.length && write) {
    h += `<div style="border:1px dashed var(--border);border-radius:12px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;"><div style="font-size:13px;color:var(--muted);">Not a member</div><button onclick="ClientProfile.enrollPrompt('${c.id}')" style="background:#7c3aed;color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">⭐ Enroll</button></div>`;
  }
  if ((c.noShows || 0) > 0) h += `<div style="background:#fff5f5;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;color:#dc2626;margin-bottom:14px;">⚠️ ${c.noShows} no-show${c.noShows > 1 ? 's' : ''} on record</div>`;
  if (data.rewardReady) h += `<div style="background:var(--green-lt);border:1px solid #b3dfbf;border-radius:8px;padding:8px 12px;font-size:12px;color:var(--green);margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">🎉 Loyalty reward ready!${write ? ` <button onclick="Clients.redeemReward('${c.id}','${c.name}')" style="background:var(--green);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">Redeem</button>` : ''}</div>`;

  // ══ TWO-COLUMN DASHBOARD ══
  h += `<div class="cp-grid">`;

  // ── MAIN COLUMN ──
  h += `<div>`;

  // Vehicles
  h += `<div class="cp-card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;"><div class="cp-sec" style="margin:0;">Vehicles</div>${write ? `<button onclick="ClientProfile.vehiclePrompt('${c.id}')" style="background:var(--green);color:#fff;border:none;border-radius:7px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;">+ Add</button>` : ''}</div>`;
  if (!vehicles.length) {
    h += `<div style="font-size:13px;color:var(--faint);padding:8px 0;">No vehicles yet${write ? ' — add one to track service history, photos, and revenue per vehicle.' : '.'}</div>`;
  } else {
    vehicles.forEach(v => {
      const va = apptsForVeh(v); const vRev = va.reduce((s, a) => s + Number(a.price || 0), 0);
      const vLast = va[0]; const vPhotos = photosForVeh(v);
      const title = [v.year, v.make, v.model].filter(Boolean).map(esc).join(' ') || 'Vehicle';
      const tags = [];
      if (v.color) tags.push(esc(v.color));
      if (v.mileage) tags.push(esc(v.mileage) + ' mi');
      if (v.plate) tags.push('🔖 ' + esc(v.plate));
      h += `<div style="border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <div style="font-size:22px;line-height:1;">🚗</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:700;">${title}${v.ceramicCoated ? ' <span style="font-size:10px;font-weight:700;color:var(--green);background:var(--green-lt);border:1px solid #b3dfbf;border-radius:5px;padding:1px 5px;">🛡️ Ceramic</span>' : ''}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">${tags.join(' · ') || '—'}</div>
            ${v.vin ? `<div style="font-size:10px;color:var(--faint);margin-top:2px;">VIN ${esc(v.vin)}</div>` : ''}
            <div style="font-size:11px;color:var(--muted);margin-top:5px;">${fmtMoney(vRev)} lifetime · ${va.length} service${va.length !== 1 ? 's' : ''}${vLast ? ' · last ' + fmtDateShort(vLast.date) : ''}</div>
            ${v.notes ? `<div style="font-size:12px;color:var(--muted);font-style:italic;margin-top:5px;">${esc(v.notes)}</div>` : ''}
          </div>
          ${write ? `<button onclick="ClientProfile.vehiclePrompt('${c.id}','${v.id}')" style="background:none;border:1px solid var(--border);border-radius:7px;padding:4px 9px;font-size:11px;font-weight:600;color:var(--muted);cursor:pointer;flex-shrink:0;">Edit</button>` : ''}
        </div>
        ${vPhotos.length ? `<div style="display:flex;gap:6px;overflow-x:auto;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">${vPhotos.slice(0, 8).map(thumb).join('')}</div>` : ''}
      </div>`;
    });
  }
  h += `</div>`;

  // Service history (timeline)
  h += `<div class="cp-card"><div class="cp-sec">Service History</div>`;
  if (!doneAppts.length) {
    h += `<div style="font-size:13px;color:var(--faint);padding:8px 0;">No completed services yet.</div>`;
  } else {
    h += `<div style="position:relative;">`;
    doneAppts.slice(0, 20).forEach((a, i) => {
      const veh = vehicles.find(v => _cpMatch(a, v));
      const vehName = veh ? [veh.year, veh.make, veh.model].filter(Boolean).join(' ') : ([a.customFields?.vehicleYear, a.customFields?.vehicleMake, a.customFields?.vehicleModel].filter(Boolean).join(' '));
      const lines = [a.service || 'Service', ...((a.addons || []).map(x => x.name))].filter(Boolean);
      h += `<div style="display:flex;gap:12px;${i ? 'border-top:1px solid var(--border);' : ''}padding:11px 0;">
        <div style="flex-shrink:0;width:74px;text-align:right;"><div style="font-size:12px;font-weight:700;">${fmtDateShort(a.date)}</div><div style="font-size:10px;color:var(--faint);">${(a.date || '').slice(0, 4)}</div></div>
        <div style="width:9px;flex-shrink:0;position:relative;"><div style="width:9px;height:9px;border-radius:50%;background:var(--green);position:absolute;top:4px;"></div>${i < Math.min(doneAppts.length, 20) - 1 ? '<div style="position:absolute;left:4px;top:13px;bottom:-13px;width:1px;background:var(--border);"></div>' : ''}</div>
        <div style="flex:1;min-width:0;">
          ${vehName ? `<div style="font-size:11px;color:var(--muted);">${esc(vehName)}</div>` : ''}
          <div style="font-size:13px;font-weight:600;">${lines.map(esc).join(' · ')}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:1px;">${a.barberName ? '👤 ' + esc(a.barberName) : ''}${a.cutNotes ? (a.barberName ? ' · ' : '') + '<span style="color:var(--green);">notes</span>' : ''}</div>
          ${a.cutNotes ? `<div style="font-size:12px;color:var(--muted);font-style:italic;margin-top:4px;">${esc(a.cutNotes)}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0;"><div style="font-size:14px;font-weight:800;color:var(--green);">${fmtMoney(Number(a.price || 0) + Number(a.tip || 0))}</div>${a.tip > 0 ? `<div style="font-size:10px;color:var(--muted);">incl ${fmtMoney(a.tip)} tip</div>` : ''}</div>
      </div>`;
    });
    h += `</div>`;
  }
  h += `</div>`;

  // Photos & media
  const photoAppts = allAppts.filter(a => (a.beforePhotos || []).length || (a.afterPhotos || []).length || (a.intakePhotos || []).length)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  h += `<div class="cp-card"><div class="cp-sec">Before &amp; After Photos</div>`;
  if (!photoAppts.length) {
    h += `<div style="font-size:13px;color:var(--faint);padding:8px 0;">No photos yet. Capture before/after shots on a job to build the gallery.</div>`;
  } else {
    photoAppts.slice(0, 12).forEach(a => {
      const veh = vehicles.find(v => _cpMatch(a, v));
      const vehName = veh ? [veh.year, veh.make, veh.model].filter(Boolean).join(' ') : '';
      const ph = [];
      (a.beforePhotos || []).forEach(p => ph.push({ ...p, phase: 'Before', date: a.date }));
      (a.afterPhotos || []).forEach(p => ph.push({ ...p, phase: 'After', date: a.date }));
      (a.intakePhotos || []).forEach(p => ph.push({ ...p, phase: 'Intake', date: a.date }));
      h += `<div style="margin-bottom:12px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">${fmtDateShort(a.date)}${vehName ? ' · ' + esc(vehName) : ''} · ${esc(a.service || '')}</div>
        <div style="display:flex;gap:6px;overflow-x:auto;">${ph.map(thumb).join('')}</div>
      </div>`;
    });
  }
  h += `</div>`;

  h += `</div>`; // end main column

  // ── SIDE COLUMN ──
  h += `<div>`;

  // Retention engine
  h += `<div class="cp-card" style="background:${rs.bg};border-color:${rs.bd};">
    <div class="cp-sec">Retention</div>
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px;">
      <div style="font-size:16px;font-weight:800;color:${rs.color};">${rs.label}</div>
      <div style="font-size:12px;color:var(--muted);">${dslLabel} since last visit</div>
    </div>
    <div style="font-size:11px;color:var(--muted);">Rebook target: every ${rebookInterval} days${lastService ? ' · last service ' + fmtDateShort(lastService.date) : ''}</div>`;
  if (recs.length) {
    h += `<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">`;
    recs.forEach((r, i) => {
      h += `<div style="background:var(--white);border:1px solid var(--border);border-radius:10px;padding:10px;">
        <div style="display:flex;align-items:flex-start;gap:8px;">
          <span style="font-size:16px;line-height:1;">${r.icon}</span>
          <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:700;">${esc(r.title)}</div><div style="font-size:11px;color:var(--muted);margin-top:1px;">${esc(r.detail)}</div></div>
        </div>
        ${write && c.phone ? `<button onclick="ClientProfile.sendRec('${c.id}',${i})" style="margin-top:8px;width:100%;background:var(--green);color:#fff;border:none;border-radius:7px;padding:6px;font-size:12px;font-weight:700;cursor:pointer;">💬 Send follow-up</button>` : ''}
      </div>`;
    });
    h += `</div>`;
  } else {
    h += `<div style="margin-top:10px;font-size:12px;color:var(--muted);">No follow-ups needed right now. 💪</div>`;
  }
  h += `</div>`;

  // Revenue
  h += `<div class="cp-card"><div class="cp-sec">Revenue</div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <div style="flex:1;text-align:center;"><div style="font-size:10px;color:var(--faint);">LIFETIME</div><div style="font-size:18px;font-weight:800;color:var(--green);">${fmtMoney(totalRevenue)}</div></div>
      <div style="flex:1;text-align:center;"><div style="font-size:10px;color:var(--faint);">AVG TICKET</div><div style="font-size:18px;font-weight:800;">${fmtMoney(avgTicket)}</div></div>
    </div>`;
  // Revenue by vehicle (bars)
  const byVeh = vehicles.map(v => ({ name: [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle', rev: apptsForVeh(v).reduce((s, a) => s + Number(a.price || 0), 0) }));
  const matchedRev = vehicles.reduce((s, v) => s + apptsForVeh(v).reduce((t, a) => t + Number(a.price || 0), 0), 0);
  const otherRev = Math.max(0, totalRevenue - matchedRev);
  if (otherRev > 0) byVeh.push({ name: 'Other / unassigned', rev: otherRev });
  const maxRev = Math.max(1, ...byVeh.map(x => x.rev));
  if (byVeh.some(x => x.rev > 0)) {
    h += `<div style="font-size:11px;color:var(--muted);margin-bottom:6px;">By vehicle</div>`;
    byVeh.filter(x => x.rev > 0).sort((a, b) => b.rev - a.rev).forEach(x => {
      h += `<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%;">${esc(x.name)}</span><span style="font-weight:700;">${fmtMoney(x.rev)}</span></div><div style="height:6px;background:var(--off);border-radius:100px;overflow:hidden;"><div style="height:100%;width:${Math.round(x.rev / maxRev * 100)}%;background:var(--green);border-radius:100px;"></div></div></div>`;
    });
  }
  // Services purchased
  const svcCount = {};
  doneAppts.forEach(a => { const k = a.service || 'Other'; svcCount[k] = (svcCount[k] || 0) + 1; });
  const svcRows = Object.entries(svcCount).sort((a, b) => b[1] - a[1]);
  if (svcRows.length) {
    h += `<div style="font-size:11px;color:var(--muted);margin:12px 0 6px;">Services purchased</div>`;
    svcRows.forEach(([name, n]) => { h += `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;"><span>${esc(name)}</span><span style="color:var(--muted);font-weight:700;">×${n}</span></div>`; });
  }
  h += `</div>`;

  // Notes
  h += `<div class="cp-card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;"><div class="cp-sec" style="margin:0;">Notes</div>${write ? `<button onclick="ClientProfile.notePrompt('${c.id}')" style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:5px 10px;font-size:12px;font-weight:700;color:var(--text);cursor:pointer;">+ Note</button>` : ''}</div>`;
  const noteLog = (c.noteLog || []).slice();
  const scopeMeta = { customer: { ic: '👤', label: 'Customer' }, internal: { ic: '🔒', label: 'Internal' }, vehicle: { ic: '🚗', label: 'Vehicle' } };
  if (c.notes && !noteLog.length) h += `<div style="font-size:13px;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px;">${esc(c.notes)}</div>`;
  if (!noteLog.length && !c.notes) {
    h += `<div style="font-size:13px;color:var(--faint);">No notes yet.</div>`;
  } else {
    noteLog.forEach(n => {
      const sm = scopeMeta[n.scope] || scopeMeta.customer;
      let vehName = '';
      if (n.scope === 'vehicle' && n.vehicleId) { const v = vehicles.find(x => x.id === n.vehicleId); if (v) vehName = ' · ' + [v.year, v.make, v.model].filter(Boolean).join(' '); }
      h += `<div style="border-bottom:1px solid var(--border);padding:9px 0;">
        <div style="font-size:13px;color:var(--text);">${esc(n.text)}</div>
        <div style="font-size:10px;color:var(--faint);margin-top:3px;">${sm.ic} ${sm.label}${esc(vehName)} · ${n.at ? new Date(n.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}${n.by ? ' · ' + esc(n.by) : ''}</div>
      </div>`;
    });
    if (c.notes) h += `<div style="font-size:12px;color:var(--muted);margin-top:8px;">${esc(c.notes)}</div>`;
  }
  h += `</div>`;

  // Upcoming + reminder automation
  const nextAppt = upcoming[0];
  h += `<div class="cp-card"><div class="cp-sec">Automations</div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
      <div><div style="font-size:13px;font-weight:600;">⏰ 24-Hour Reminder</div><div style="font-size:11px;color:var(--muted);margin-top:1px;">${nextAppt ? fmtDateFull(nextAppt.date) + ' at ' + nextAppt.time : 'No upcoming appointment'}</div></div>
      <span style="font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;background:${nextAppt ? 'var(--green-lt)' : 'var(--surface)'};color:${nextAppt ? 'var(--green)' : 'var(--faint)'};">${nextAppt ? 'Active' : 'Idle'}</span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0 2px;">
      <div><div style="font-size:13px;font-weight:600;">🔁 Rebook Nudge</div><div style="font-size:11px;color:var(--muted);margin-top:1px;">${daysSinceLast === null ? 'No visits yet' : daysSinceLast >= rebookInterval ? 'Due — ' + daysSinceLast + 'd since last visit' : 'Watching · nudge at ' + rebookInterval + 'd'}</div></div>
      <span style="font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;background:${daysSinceLast !== null && daysSinceLast >= rebookInterval ? '#fff5f5' : 'var(--surface)'};color:${daysSinceLast !== null && daysSinceLast >= rebookInterval ? '#dc2626' : 'var(--faint)'};">${daysSinceLast !== null && daysSinceLast >= rebookInterval ? 'Due' : 'Watching'}</span>
    </div>
  </div>`;

  h += `</div>`; // end side column
  h += `</div>`; // end grid

  return h;
}

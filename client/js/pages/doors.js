// ── D2D: door-to-door canvassing (field-service module) ──────────────────────
// Built for a phone on the sidewalk: one big "Log a door" button, the address
// filled from GPS, and the no-conversation outcomes (not home, not interested,
// no soliciting) save in a single tap. Come-backs land in a follow-up list on
// the day they're due; quoted / sold doors become CRM leads server-side
// (routes/doors.js). Every knock is credited to whoever is signed in.
const DOOR_OUTCOMES = [
  { key: 'not_home',       label: 'Not home',       icon: '🚪', quick: true },
  { key: 'not_interested', label: 'Not interested', icon: '👎', quick: true },
  { key: 'come_back',      label: 'Come back',      icon: '🔁' },
  { key: 'quoted',         label: 'Quoted',         icon: '💬' },
  { key: 'sold',           label: 'Sold',           icon: '✅' },
  { key: 'no_soliciting',  label: 'No soliciting',  icon: '⛔', quick: true },
];
const doorOutcome = (k) => DOOR_OUTCOMES.find(o => o.key === k) || { label: k, icon: '•' };

// Local-calendar dates (the shared today() is UTC, which flips to tomorrow in
// the late afternoon here).
const _ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const _addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const Doors = {
  _range: 'today', _data: null, _services: [],
  _draft: null,   // the door being logged: { id?, address, lat, lng, … }

  _window() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Week = since Monday.
    if (this._range === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return { since: start.toISOString(), until: _addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), 1).toISOString(), today: _ymd(now) };
  },

  async render() {
    const el = document.getElementById('page-doors'); if (!el) return;
    if (!this._data) el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading…</p></div>';
    try {
      const w = this._window();
      const [data, services] = await Promise.all([
        db.doors.list(w),
        this._services.length ? Promise.resolve(this._services) : db.services.all().catch(() => []),
      ]);
      this._data = data; this._services = services || [];
      el.innerHTML = this._html();
    } catch (e) {
      el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load door knocking</p></div>';
    }
  },

  setRange(r) { this._range = r; this.render(); },

  _html() {
    const d = this._data || { doors: [], followUps: [], stats: { all: {}, byRep: [] }, goal: 40 };
    const all = d.stats.all || {};
    const mine = (d.stats.byRep || []).find(r => r.repId && r.repId === d.me) || { doors: 0, talked: 0, quotes: 0, sales: 0 };
    const goal = d.goal * (this._range === 'week' ? 6 : 1);   // a 6-day knocking week
    const pctGoal = Math.min(100, Math.round((mine.doors / Math.max(1, goal)) * 100));
    const rate = (n, of) => of ? Math.round(n / of * 100) + '%' : '—';
    const isOwner = Auth.getRole() === 'full';
    const h = [];

    h.push(`<div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-bottom:12px;">
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm${this._range === 'today' ? ' btn-green' : ''}" onclick="Doors.setRange('today')">Today</button>
        <button class="btn btn-sm${this._range === 'week' ? ' btn-green' : ''}" onclick="Doors.setRange('week')">This week</button>
      </div></div>`);

    h.push(`<button class="btn btn-green" style="width:100%;padding:16px;font-size:17px;font-weight:700;margin-bottom:14px;" onclick="Doors.open()">🚪 Log a door</button>`);

    // Your progress vs the goal, then the team totals.
    h.push(`<div class="card" style="padding:14px 16px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div style="font-weight:700;">You: ${mine.doors} / ${goal} doors</div>
        ${isOwner ? `<button class="btn btn-sm" onclick="Doors.editGoal()">Goal: ${d.goal}/day</button>` : `<span style="font-size:12px;color:var(--muted);">goal ${d.goal}/day</span>`}
      </div>
      <div style="height:8px;background:var(--border);border-radius:99px;margin-top:8px;overflow:hidden;"><div style="height:100%;width:${pctGoal}%;background:var(--green);"></div></div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px;">${mine.talked} talked · ${mine.quotes} quoted · ${mine.sales} sold</div>
    </div>`);
    const card = (label, value, sub) => `<div class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-sub">${sub}</div></div>`;
    h.push('<div class="metric-grid">'
      + card('Doors', all.doors || 0, (this._range === 'today' ? 'today' : 'this week') + ' · team')
      + card('Talked', all.talked || 0, rate(all.talked, all.doors) + ' of doors')
      + card('Quoted', all.quotes || 0, fmtMoney(all.quoteValue || 0) + ' quoted')
      + card('Sold', all.sales || 0, rate(all.sales, all.talked) + ' of talks · ' + fmtMoney(all.soldValue || 0))
      + '</div>');

    // Come-backs due today (and any missed).
    const fu = d.followUps || [];
    const t = this._window().today;
    h.push(`<div class="section-header">Come back today${fu.length ? ' (' + fu.length + ')' : ''}</div>`);
    if (!fu.length) h.push('<div class="card" style="padding:12px 16px;color:var(--muted);font-size:14px;">No come-backs due. Tap <b>Come back</b> on a door and pick a day.</div>');
    else h.push('<div class="list-card">' + fu.map(x => `<div class="list-row"><div class="list-main">
        <div class="list-name">${esc(x.address)}</div>
        <div class="list-sub">${[x.name, x.followUpAt < t ? '<span style="color:var(--red,#dc2626);font-weight:600;">was due ' + esc(fmtDateShort(x.followUpAt)) + '</span>' : 'due today', x.repName && 'by ' + esc(String(x.repName).split('@')[0])].filter(Boolean).join(' · ')}</div>
        ${x.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:3px;">“${esc(x.notes)}”</div>` : ''}
      </div><div class="list-right"><button class="btn btn-sm btn-green" onclick="Doors.open('${jsAttr(x.id)}')">Knock</button></div></div>`).join('') + '</div>');

    // Team scoreboard.
    const reps = d.stats.byRep || [];
    if (reps.length) {
      // A login with no display name shows its email — keep just the part before @.
      const who = (n) => String(n || 'Unknown').split('@')[0];
      const th = 'padding:10px 6px;text-align:right;font-weight:600;', td = 'padding:10px 6px;text-align:right;';
      h.push('<div class="section-header">Team</div><div class="card" style="padding:0;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:14px;">'
        + `<tr style="color:var(--muted);font-size:12px;"><th style="padding:10px 6px 10px 14px;text-align:left;font-weight:600;">Name</th><th style="${th}">Doors</th><th style="${th}">Talk</th><th style="${th}">Quote</th><th style="${th}">Sold</th><th style="${th}padding-right:14px;">Close</th></tr>`
        + reps.map(r => `<tr style="border-top:1px solid var(--border);"><td style="padding:10px 6px 10px 14px;font-weight:600;">${esc(who(r.repName))}${r.repId === d.me ? ' <span class="badge badge-gray">you</span>' : ''}</td><td style="${td}">${r.doors}</td><td style="${td}">${r.talked}</td><td style="${td}">${r.quotes}</td><td style="${td}">${r.sales}</td><td style="${td}padding-right:14px;">${rate(r.sales, r.talked)}</td></tr>`).join('')
        + '</table></div>');
    }

    // Doors knocked in the window, newest first.
    const doors = d.doors || [];
    h.push(`<div class="section-header">Doors ${this._range === 'today' ? 'today' : 'this week'}${doors.length ? ' (' + doors.length + ')' : ''}</div>`);
    if (!doors.length) h.push('<div class="card empty-state"><div class="empty-icon">🚪</div><div class="empty-text">No doors logged yet. Head out and tap <b>Log a door</b> at each house.</div></div>');
    else h.push('<div class="list-card">' + doors.map(x => {
      const o = doorOutcome(x.outcome);
      const when = new Date(x.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const visits = (x.visits || []).length;
      return `<div class="list-row" style="cursor:pointer;" onclick="Doors.open('${jsAttr(x.id)}')"><div class="list-main">
        <div class="list-name">${o.icon} ${esc(x.address)}</div>
        <div class="list-sub">${[esc(o.label), x.name && esc(x.name), x.quoteAmount && (x.outcome === 'quoted' || x.outcome === 'sold') ? fmtMoney(x.quoteAmount) : '', x.repName && esc(String(x.repName).split('@')[0]), when, visits > 1 ? visits + ' visits' : '', x.leadId ? '→ lead' : ''].filter(Boolean).join(' · ')}</div>
      </div></div>`;
    }).join('') + '</div>');
    return h.join('');
  },

  // ── Log a door ──────────────────────────────────────────────────────────────
  open(id) {
    const existing = id && this._data ? [...(this._data.doors || []), ...(this._data.followUps || [])].find(x => x.id === id) : null;
    this._draft = existing ? { ...existing } : { address: '', lat: null, lng: null };
    this._outcome = null;
    Modal.show(`
      <div class="modal-title">${existing ? 'Knock again' : 'Log a door'}</div>
      <div class="form-group"><label class="form-label">Address</label>
        <div style="display:flex;gap:6px;">
          <input class="form-input" id="dr-address" value="${esc(this._draft.address || '')}" placeholder="123 Oak St" autocomplete="off" />
          <button class="btn" type="button" onclick="Doors.locate()" title="Use my location">📍</button>
        </div>
        <div id="dr-loc" style="font-size:12px;color:var(--muted);margin-top:4px;"></div>
      </div>
      <div class="form-label" style="margin-bottom:6px;">What happened?</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        ${DOOR_OUTCOMES.map(o => `<button class="btn dr-out" data-k="${o.key}" type="button" style="padding:14px 8px;font-size:15px;justify-content:center;" onclick="Doors.pick('${o.key}', this)">${o.icon} ${o.label}</button>`).join('')}
      </div>
      <div id="dr-more" style="margin-top:12px;"></div>
      <div class="modal-actions"><button class="btn" onclick="Modal.close()">Cancel</button></div>`);
    if (!existing) this.locate();
  },

  // GPS → address. The coordinates are kept on the door either way (for a map
  // later); the address field is only filled when the crew hasn't typed one.
  locate() {
    const st = document.getElementById('dr-loc');
    if (!navigator.geolocation) { if (st) st.textContent = 'Location isn\'t available on this device — type the address.'; return; }
    if (st) st.textContent = 'Finding your address…';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      if (this._draft) { this._draft.lat = lat; this._draft.lng = lng; }
      try {
        const r = await db.doors.where(lat, lng);
        const input = document.getElementById('dr-address');
        if (input && r && r.address && !input.value.trim()) input.value = r.address;
        if (st) st.textContent = r && r.address
          ? (r.exact ? '📍 From your location — check the house number' : '📍 Street from your location — add the house number')
          : 'Couldn\'t find an address here — type it.';
      } catch (e) { if (st) st.textContent = 'Address lookup failed — type it.'; }
    }, () => { if (st) st.textContent = 'Location is off — type the address (or allow location for this site).'; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  },

  pick(key, btn) {
    const o = doorOutcome(key);
    this._outcome = key;
    document.querySelectorAll('.dr-out').forEach(b => b.classList.toggle('btn-green', b.dataset.k === key));
    if (o.quick) { this.save(btn); return; }   // one tap: nobody to talk to
    const dft = this._draft || {};
    const f = (label, id, val, attrs = '') => `<div class="form-group"><label class="form-label">${label}</label><input class="form-input" id="${id}" value="${esc(val || '')}" ${attrs}/></div>`;
    const now = new Date();
    const sat = _addDays(now, ((6 - now.getDay()) + 7) % 7 || 7);
    const chip = (label, date) => `<button class="btn btn-sm" type="button" onclick="document.getElementById('dr-date').value='${date}'">${label}</button>`;
    let more = '';
    if (key === 'come_back') {
      more = `<div class="form-group"><label class="form-label">Come back on</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">${chip('Tomorrow', _ymd(_addDays(now, 1)))}${chip('Saturday', _ymd(sat))}${chip('Next week', _ymd(_addDays(now, 7)))}</div>
          <input class="form-input" type="date" id="dr-date" value="${esc(dft.followUpAt || _ymd(_addDays(now, 1)))}" /></div>
        <div class="form-row">${f('Name (optional)', 'dr-name', dft.name)}${f('Phone (optional)', 'dr-phone', dft.phone, 'type="tel" inputmode="tel"')}</div>
        ${f('Note', 'dr-notes', '', 'placeholder="e.g. Husband decides — after 5pm"')}`;
    } else {
      const svcOpts = '<option value="">—</option>' + (this._services || []).map(s => `<option${dft.service === s.name ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
      more = `<div class="form-row">${f('Name', 'dr-name', dft.name, 'autocomplete="off"')}${f('Phone *', 'dr-phone', dft.phone, 'type="tel" inputmode="tel"')}</div>
        ${f('Email (optional)', 'dr-email', dft.email, 'type="email" inputmode="email"')}
        <div class="form-row">
          <div class="form-group"><label class="form-label">Service</label><select class="form-input" id="dr-service">${svcOpts}</select></div>
          ${f(key === 'sold' ? 'Sold for ($)' : 'Quoted ($)', 'dr-amount', dft.quoteAmount, 'type="number" inputmode="decimal" min="0"')}
        </div>
        ${(Shop.fields || []).some(x => x.key === 'propertyType') ? `<div class="form-row">${f('Property type', 'dr-ptype', dft.propertyType, 'placeholder="House"')}${f('Stories', 'dr-stories', dft.stories, 'placeholder="1 story"')}</div>` : ''}
        ${f('Note', 'dr-notes', '', 'placeholder="Anything to remember"')}`;
    }
    const more_el = document.getElementById('dr-more');
    if (more_el) more_el.innerHTML = more + `<button class="btn btn-green" style="width:100%;padding:13px;font-size:16px;" type="button" onclick="Doors.save(this)">Save — ${o.icon} ${o.label}</button>`;
  },

  async save(btn) {
    const g = (id) => ((document.getElementById(id) || {}).value || '').trim();
    const dft = this._draft || {};
    const body = {
      id: dft.id, address: g('dr-address'), lat: dft.lat, lng: dft.lng, outcome: this._outcome,
      name: g('dr-name'), phone: g('dr-phone'), email: g('dr-email'), service: g('dr-service'),
      quoteAmount: g('dr-amount'), propertyType: g('dr-ptype'), stories: g('dr-stories'),
      notes: g('dr-notes'), followUpAt: g('dr-date'),
    };
    if (!body.address) { toast('Add the address first', 'error'); document.getElementById('dr-address')?.focus(); return; }
    disableBtn(btn);
    try {
      const r = await db.doors.log(body);
      if (!r || !r.ok) throw new Error((r && r.error) || 'Could not save');
      Modal.close();
      const o = doorOutcome(body.outcome);
      toast(`${o.icon} ${o.label} logged${r.leadId ? ' · added to Leads' : ''}`);
      this.render();
    } catch (e) { enableBtn(btn); toast(e.message || 'Could not save', 'error'); }
  },

  async editGoal() {
    const cur = (this._data && this._data.goal) || 40;
    const v = prompt('Daily door goal per person:', cur);
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!(n > 0 && n <= 500)) { toast('Enter a number from 1 to 500', 'error'); return; }
    try { await db.settings.save({ doorGoal: n }); toast('Goal saved ✓'); this.render(); }
    catch (e) { toast(e.message || 'Could not save', 'error'); }
  },
};

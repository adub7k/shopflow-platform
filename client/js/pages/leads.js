// ── Leads (inbound calls + web lead form) ─────────────────────────────────────
// Populated two ways: the call-screening webhooks (every inbound call to the
// shop's tracking number) and the public lead-capture form at /book/<slug>.
// Web leads carry ad attribution (source = utm_source, e.g. 'facebook'), so the
// breakdown up top shows exactly which channel each lead came from.
const Leads = {
  _leads: [],
  _filter: 'all',

  _statusMeta: {
    new:       { label: 'New',       bg: 'var(--green-lt)',  fg: 'var(--green)', dot: '#2563eb' },
    contacted: { label: 'Contacted', bg: '#fef3c7',          fg: '#92400e',      dot: '#d97706' },
    booked:    { label: 'Booked',    bg: 'var(--green-lt)',  fg: 'var(--green)', dot: '#16a34a' },
    closed:    { label: 'Closed',    bg: '#f3f4f6',          fg: '#6b7280',      dot: '#9ca3af' },
  },

  // Display meta for a lead source. Known channels get an icon; anything else
  // (a custom utm_source) is shown as typed, capitalized.
  _sourceMeta(src) {
    const known = {
      call:      { icon: '📞', label: 'Phone call' },
      website:   { icon: '🌐', label: 'Website' },
      facebook:  { icon: '📘', label: 'Facebook' },
      instagram: { icon: '📸', label: 'Instagram' },
      google:    { icon: '🔍', label: 'Google' },
      tiktok:    { icon: '🎵', label: 'TikTok' },
      nextdoor:  { icon: '🏘', label: 'Nextdoor' },
      yelp:      { icon: '⭐', label: 'Yelp' },
    };
    const s = String(src || 'call').toLowerCase();
    return known[s] || { icon: '🔗', label: s.charAt(0).toUpperCase() + s.slice(1) };
  },

  // Overall conversion stats: how many leads become booked jobs. The 30-day
  // window is the ad-spend read; all-time rides along as the subtitle.
  _convStats() {
    const all = this._leads; if (!all.length) return '';
    const isBooked = l => l.status === 'booked';
    const last30 = all.filter(l => (Date.now() - new Date(l.createdAt || l.firstContactAt || 0)) < 30 * 86400000);
    const b30 = last30.filter(isBooked).length, bAll = all.filter(isBooked).length;
    const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
    const r30 = pct(b30, last30.length), rAll = pct(bAll, all.length);
    const stat = (label, value, sub, fg) => `<div class="card" style="flex:1;min-width:105px;margin:0;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);">${label}</div>
      <div style="font-size:22px;font-weight:800;letter-spacing:-.03em;color:${fg || 'var(--text)'};margin-top:3px;">${value}</div>
      <div style="font-size:11px;color:var(--faint);margin-top:2px;">${sub}</div>
    </div>`;
    return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
      ${stat('Leads', last30.length, `30 days · ${all.length} all-time`)}
      ${stat('Booked', b30, `30 days · ${bAll} all-time`)}
      ${stat('Conversion', r30 + '%', `30 days · ${rAll}% all-time`, r30 >= 25 ? 'var(--green)' : (r30 >= 10 ? '#d97706' : (last30.length ? '#dc2626' : 'var(--text)')))}
    </div>`;
  },

  // Leads by source: total + booked per channel, best-converting first.
  // This is the read on ad spend — "Facebook sent 12, 4 booked".
  _sourceBreakdown() {
    if (!this._leads.length) return '';
    const bySrc = {};
    this._leads.forEach(l => {
      const k = String(l.source || 'call').toLowerCase();
      bySrc[k] = bySrc[k] || { total: 0, booked: 0 };
      bySrc[k].total++;
      if (l.status === 'booked') bySrc[k].booked++;
    });
    const keys = Object.keys(bySrc);
    if (keys.length < 2 && keys[0] === 'call') return ''; // calls-only shops: nothing to compare yet
    const max = Math.max(...keys.map(k => bySrc[k].total));
    const rows = keys.sort((a,b) => bySrc[b].total - bySrc[a].total).map(k => {
      const m = this._sourceMeta(k), d = bySrc[k];
      const pct = d.total ? Math.round(d.booked / d.total * 100) : 0;
      return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;">
        <div style="width:110px;font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;">${m.icon} ${esc(m.label)}</div>
        <div style="flex:1;height:8px;background:var(--off);border-radius:99px;overflow:hidden;"><div style="width:${Math.max(4, Math.round(d.total/max*100))}%;height:100%;background:var(--green);border-radius:99px;"></div></div>
        <div style="font-size:12px;color:var(--muted);white-space:nowrap;flex-shrink:0;"><strong style="color:var(--text);">${d.total}</strong> lead${d.total!==1?'s':''} · ${d.booked} booked${d.booked?` (${pct}%)`:''}</div>
      </div>`;
    }).join('');
    return `<div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">Leads by source</div>
      ${rows}
    </div>`;
  },

  async render() {
    const el = document.getElementById('page-leads'); if (!el) return;
    try { this._leads = await db.leads.all(); } catch(e) { this._leads = []; }

    const counts = { all: this._leads.length, new: 0, contacted: 0, booked: 0, closed: 0 };
    this._leads.forEach(l => { counts[l.status] = (counts[l.status]||0) + 1; });

    const pill = (key, label) => `<button class="lead-pill ${this._filter===key?'active':''}" onclick="Leads.setFilter('${key}')">${label}${counts[key]?` <span class="lead-pill-count">${counts[key]}</span>`:''}</button>`;
    const filters = `<div class="lead-filters">
      ${pill('all','All')}${pill('new','New')}${pill('contacted','Contacted')}${pill('booked','Booked')}${pill('closed','Closed')}
    </div>`;

    const tn = (Shop.settings && Shop.settings.trackingNumber) || '';
    const banner = `<div class="lead-banner">
      <span style="font-size:18px;">📞</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text);">Call tracking ${tn?'is live':'setup'}</div>
        <div style="font-size:12px;color:var(--muted);">${tn?`Calls to <strong>${esc(tn)}</strong> forward to your phone. Missed calls auto-text the caller.`:'Contact ShopFlow to activate your tracking number.'}</div>
      </div>
    </div>`;

    // Shareable lead-form link — this is the URL that goes in ads. Tag ad links
    // with ?utm_source=... so the source breakdown can attribute them.
    const slug = (Shop.settings && Shop.settings.shopSlug) || '';
    const leadUrl = slug ? location.origin + '/book/' + slug : '';
    const linkBanner = leadUrl ? `<div class="lead-banner" style="margin-top:8px;">
      <span style="font-size:18px;">🔗</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text);">Your lead form</div>
        <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(leadUrl)} — in ads, add <strong>?utm_source=facebook</strong> (or google, etc.) to track where leads come from.</div>
      </div>
      <button class="btn" style="flex-shrink:0;font-size:12px;padding:7px 12px;" onclick="navigator.clipboard.writeText('${esc(leadUrl)}');toast('Link copied ✓')">Copy</button>
    </div>` : '';

    const shown = this._filter==='all' ? this._leads : this._leads.filter(l => l.status===this._filter);

    const stats = this._convStats();
    const breakdown = this._sourceBreakdown();

    if (!shown.length) {
      el.innerHTML = banner + linkBanner + stats + breakdown + filters + `<div class="card"><div class="empty-state">
        <div class="empty-icon">📞</div>
        <div class="empty-text">No ${this._filter==='all'?'':this._filter+' '}leads yet</div>
        <div style="font-size:12px;color:var(--faint);margin-top:6px;">Inbound calls and lead-form submissions show up here automatically.</div>
      </div></div>`;
      return;
    }

    const rows = shown.map(l => {
      const m = this._statusMeta[l.status] || this._statusMeta.new;
      const sm = this._sourceMeta(l.source);
      const name = l.name || l.phone || 'Unknown caller';
      const lastCall = (l.calls||[])[0];
      const when = (lastCall && lastCall.startedAt) || l.lastContactAt;
      const missedBadge = (l.missedCount||0) > 0 ? `<span class="lead-missed">⚠ ${l.missedCount} missed</span>` : '';
      const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
      const sub = [veh || l.location, (l.servicesInterested||[]).join(', ') || l.phone].filter(Boolean).join(' · ');
      return `<div class="msg-inbox-row" onclick="Leads.open('${l.id}')">
        ${avatarEl(l.name || sm.icon, 42)}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
            <div style="font-size:11px;color:var(--faint);white-space:nowrap;flex-shrink:0;">${when?_msgTime(when):''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
            <span class="lead-badge" style="background:${m.bg};color:${m.fg};">${m.label}</span>
            <span class="lead-badge" style="background:var(--off);color:var(--muted);">${sm.icon} ${esc(sm.label)}</span>
            ${missedBadge}
            <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${esc(sub)}</div>
          </div>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = banner + linkBanner + stats + breakdown + filters + `<div class="list-card">${rows}</div>`;
  },

  setFilter(f) { this._filter = f; this.render(); },

  open(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    const m = this._statusMeta[l.status] || this._statusMeta.new;
    const name = l.name || l.phone || 'Unknown caller';

    const statusPills = Object.keys(this._statusMeta).map(k => {
      const sm = this._statusMeta[k];
      return `<button class="lead-status-opt ${l.status===k?'active':''}" style="${l.status===k?`background:${sm.bg};color:${sm.fg};border-color:${sm.fg};`:''}" onclick="Leads.setStatus('${l.id}','${k}')">${sm.label}</button>`;
    }).join('');

    const mediaBtn = (cid, kind, dur) => `<button onclick="event.stopPropagation();Leads.playRecording('${cid}',this,'${kind}')" style="margin:4px 0 8px;padding:6px 12px;border:1px solid var(--green);background:var(--green-lt);color:var(--green);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">▶ Play ${kind}${dur?` · ${dur}s`:''}</button>`;
    const calls = (l.calls||[]).map(c => {
      const when = _msgTimeFull(c.startedAt);
      const vm  = c.voicemail ? mediaBtn(c.id,'voicemail',c.voicemail.durationSec) : '';
      const rec = c.recording ? mediaBtn(c.id,'recording',c.recording.durationSec) : '';
      // An AI-answered call carries a structured conversation (voiceAI.turns) and
      // an outcome — render it as a chat thread with a booked/captured badge.
      const va = c.voiceAI;
      let tr;
      if (va && va.turns && va.turns.length) {
        const oc = va.outcome;
        const badge = oc ? `<div style="font-size:11px;font-weight:800;color:var(--green);margin-bottom:6px;">${oc.type==='booked'?`✅ Booked ${esc(oc.service||'appointment')} · ${esc(oc.date||'')} ${esc(oc.time||'')}`:oc.type==='captured'?'📝 Qualified lead captured':'Call ended'}</div>` : '';
        const thread = va.turns.map(t=>`<div style="margin:3px 0;"><strong style="color:${t.role==='assistant'?'var(--green)':'var(--text)'};">${t.role==='assistant'?'🤖 AI':'📞 Caller'}:</strong> ${esc(t.text)}</div>`).join('');
        tr = `<div style="font-size:12px;color:var(--muted);background:var(--surface2);border-radius:8px;padding:8px 10px;margin:4px 0 8px;line-height:1.5;">${badge}${thread}</div>`;
      } else {
        tr = c.transcript ? `<div style="font-size:12px;color:var(--muted);background:var(--surface2);border-radius:8px;padding:8px 10px;margin:4px 0 8px;line-height:1.45;"><strong>🎙 Transcript:</strong> ${esc(c.transcript)}</div>` : '';
      }
      // AI answered (fallback or always mode) — distinct from a human miss/answer.
      if (c.aiHandled) {
        const ocLabel = va&&va.outcome ? (va.outcome.type==='booked'?' · booked' : va.outcome.type==='captured'?' · lead captured' : '') : '';
        return `<div class="lead-call answered"><span>🤖 AI receptionist answered${ocLabel}</span><span class="lead-call-time">${when}</span></div>${vm}${rec}${tr}`;
      }
      if (c.missed) return `<div class="lead-call missed"><span>⚠ Missed call${c.autoSmsSent?' · auto-text sent':''}${c.voicemail?' · 🎙 voicemail':''}</span><span class="lead-call-time">${when}</span></div>${vm}${tr}`;
      const dur = c.durationSec ? ` · ${Math.floor(c.durationSec/60)}m ${c.durationSec%60}s` : '';
      return `<div class="lead-call answered"><span>✓ Answered${dur}${c.recording?' · 🎙 recorded':''}</span><span class="lead-call-time">${when}</span></div>${rec}${tr}`;
    }).join('') || `<div style="font-size:12px;color:var(--faint);padding:6px 0;">No calls logged.</div>`;

    // Web-lead extras: where the lead came from (channel + campaign), the
    // vehicle they told us about, and the services they checked on the form.
    const sm = this._sourceMeta(l.source);
    const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model, l.vehicle.color].filter(Boolean).join(' ') : '';
    const infoRow = (k, v) => v ? `<div style="display:flex;gap:10px;padding:5px 0;font-size:13px;"><span style="width:86px;color:var(--muted);flex-shrink:0;">${k}</span><span style="font-weight:600;color:var(--text);">${esc(v)}</span></div>` : '';
    const detailCard = `
      ${infoRow('Source', sm.icon + ' ' + sm.label + (l.utm && l.utm.campaign ? ' · ' + l.utm.campaign : ''))}
      ${infoRow('Vehicle', veh)}
      ${infoRow('Interested in', (l.servicesInterested||[]).join(', '))}
      ${l.email ? `<div style="display:flex;gap:10px;padding:5px 0;font-size:13px;"><span style="width:86px;color:var(--muted);flex-shrink:0;">Email</span><a href="mailto:${esc(l.email)}" style="font-weight:600;color:var(--green);text-decoration:none;">${esc(l.email)}</a></div>` : ''}`;

    Modal.show(`
      <div class="modal-title" style="display:flex;align-items:center;gap:10px;">
        ${avatarEl(l.name || sm.icon, 38)}
        <div style="flex:1;min-width:0;">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
          ${l.phone?`<a href="tel:${esc(l.phone)}" style="font-size:12px;font-weight:500;color:var(--green);text-decoration:none;">${esc(l.phone)} ↗</a>`:''}
        </div>
      </div>

      ${this._aiCard(l)}

      ${detailCard.trim()?`<div class="form-group" style="background:var(--off);border-radius:10px;padding:8px 12px;">${detailCard}</div>`:''}

      <div class="form-group">
        <label class="form-label">Name</label>
        <input class="form-input" id="lead-name" value="${esc(l.name||'')}" placeholder="Add a name…"/>
      </div>

      <div class="form-group">
        <label class="form-label">Status</label>
        <div class="lead-status-row">${statusPills}</div>
      </div>

      <div class="form-group">
        <label class="form-label">Text back</label>
        <div style="display:flex;gap:8px;">
          <input class="form-input" id="lead-sms" placeholder="Type a quick reply…" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();Leads.sendSms('${l.id}');}"/>
          <button class="btn btn-primary" onclick="Leads.sendSms('${l.id}')">Send</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Call history</label>
        <div class="lead-calls">${calls}</div>
      </div>

      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-input" id="lead-notes" rows="2" placeholder="Notes about this lead…">${esc(l.notes||'')}</textarea>
      </div>

      <div class="modal-actions" style="flex-wrap:wrap;gap:8px;">
        <button class="btn btn-primary btn-full" onclick="Leads.save('${l.id}')">Save</button>
        ${(l.calls&&l.calls.length)?`<button class="btn btn-full" onclick="Leads.analyze('${l.id}',this)">✨ ${l.ai?'Re-analyze':'Analyze'} with AI</button>`:''}
        ${l.customerId?`<button class="btn btn-full" onclick="ClientProfile.open('${l.customerId}')">View client</button>`:`<button class="btn btn-full" onclick="Leads.convert('${l.id}')">Convert to client</button>`}
        <button class="btn btn-full" style="color:var(--red);" onclick="Leads.remove('${l.id}')">Delete lead</button>
      </div>
    `);
  },

  // ── AI receptionist intake card ──
  _qualityChip(q) {
    const map = { hot:{bg:'#fef2f2',fg:'#dc2626',icon:'🔥',label:'Hot lead'}, warm:{bg:'#fffbeb',fg:'#d97706',icon:'🟡',label:'Warm lead'}, cold:{bg:'#f3f4f6',fg:'#6b7280',icon:'🧊',label:'Cold lead'} };
    const m = map[q] || map.cold;
    return `<span style="display:inline-flex;align-items:center;gap:5px;background:${m.bg};color:${m.fg};font-weight:700;font-size:12px;padding:3px 10px;border-radius:20px;white-space:nowrap;">${m.icon} ${m.label}</span>`;
  },
  _aiCard(l) {
    const a = l.ai; if (!a) return '';
    const tags = [];
    if (a.serviceNeeded) tags.push(['Service', esc(a.serviceNeeded)]);
    if (a.budget != null) tags.push(['Budget', fmtMoney(a.budget)]);
    if (a.desiredDate) tags.push(['When', esc(a.desiredDate)]);
    const grid = tags.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:9px 0 0;">${tags.map(t=>`<span style="font-size:12px;background:var(--surface2);border-radius:6px;padding:3px 8px;"><strong>${t[0]}:</strong> ${t[1]}</span>`).join('')}</div>` : '';
    const fu = a.followUp ? `<div style="display:flex;align-items:center;gap:8px;margin-top:10px;"><div style="flex:1;font-size:12px;color:var(--muted);line-height:1.45;"><strong>Suggested follow-up:</strong> ${esc(a.followUp)}</div><button class="btn btn-sm btn-green" style="flex-shrink:0;" onclick="Leads.useFollowUp('${l.id}')">Use</button></div>` : '';
    return `<div class="card" style="border:1px solid var(--green-md);background:var(--green-lt);margin-bottom:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="font-size:11px;font-weight:800;color:var(--green);letter-spacing:.05em;">✨ AI RECEPTIONIST</div>
        ${this._qualityChip(a.quality)}
      </div>
      <div style="font-size:14px;line-height:1.5;margin-top:8px;color:var(--text);">${esc(a.summary)}</div>
      ${grid}${fu}
    </div>`;
  },
  useFollowUp(id) {
    const l = this._leads.find(x => x.id === id);
    const el = document.getElementById('lead-sms');
    if (l && l.ai && l.ai.followUp && el) { el.value = l.ai.followUp; el.focus(); }
  },
  async analyze(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '✨ Analyzing…'; }
    try {
      await db.leads.aiIntake(id);
      this._leads = await db.leads.all();   // refetch so transcript + ai both show
      toast('AI analysis ready ✓');
      this.open(id);
    } catch(e) {
      toast(e.message || 'Could not analyze', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '✨ Analyze with AI'; }
    }
  },

  async setStatus(id, status) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    // Preserve any unsaved edits typed in the open modal before we re-render it —
    // otherwise switching status wipes a half-typed name/notes (the re-render
    // reads l.name/l.notes, which only hold the last-saved values).
    this._captureModalEdits(l);
    l.status = status;
    this.open(id); // re-render modal to reflect selection
  },

  // Pull the current modal field values into the in-memory lead so a re-render
  // (or a convert) doesn't lose what the user just typed.
  _captureModalEdits(l) {
    const nameEl  = document.getElementById('lead-name');
    const notesEl = document.getElementById('lead-notes');
    if (nameEl)  l.name  = nameEl.value;
    if (notesEl) l.notes = notesEl.value;
  },

  async save(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    const name = document.getElementById('lead-name')?.value || '';
    const notes = document.getElementById('lead-notes')?.value || '';
    try {
      await db.leads.update(id, { name, notes, status: l.status });
      Modal.close(); toast('Lead saved ✓'); this.render();
    } catch(e) { toast(e.message || 'Could not save', 'error'); }
  },

  sendSms(id) {
    const input = document.getElementById('lead-sms');
    const body = input?.value.trim();
    if (!body) return;
    const l = this._leads.find(x => x.id === id);
    if (!l || !l.phone) { toast('No phone number on file', 'warning'); return; }
    // Manual send via the iPhone Messages deep link (no Twilio/A2P).
    _cpSms(l.phone, body);
    // Texting a new lead counts as the first touch → move it to "contacted".
    if (l.status === 'new') {
      l.status = 'contacted';
      db.leads.update(id, { status: 'contacted' }).catch(() => {});
    }
  },

  async convert(id) {
    const l = this._leads.find(x => x.id === id);
    try {
      // Persist whatever's in the modal first so the typed name/notes carry onto
      // the new client record — convert() builds the customer from the saved lead.
      if (l) {
        this._captureModalEdits(l);
        await db.leads.update(id, { name: l.name || '', notes: l.notes || '', status: l.status });
      }
      const res = await db.leads.convert(id);
      if (!res.ok) throw new Error(res.error || 'Convert failed');
      Modal.close(); toast('Converted to client ✓'); this.render();
    } catch(e) { toast(e.message || 'Could not convert', 'error'); }
  },

  // Stream + play a voicemail recording. The audio is served by an authed proxy
  // (JWT bearer), so a bare <audio src> won't work — fetch it as a blob first.
  // Stream + play a call recording or voicemail. The audio is served by an authed
  // proxy (JWT bearer), so a bare <audio src> won't work — fetch it as a blob first.
  // kind: 'recording' (answered-call audio) | 'voicemail' (default).
  async playRecording(callId, btn, kind) {
    kind = kind === 'recording' ? 'recording' : 'voicemail';
    const orig = btn.textContent;
    try {
      btn.disabled = true; btn.textContent = '⏳ Loading…';
      const r = await fetch('/api/shop/call-media/' + callId + '?kind=' + kind, { headers: { 'Authorization': 'Bearer ' + Auth.getToken() } });
      if (!r.ok) {
        let msg = (kind === 'recording' ? 'Recording' : 'Voicemail') + ' not available';
        try { const j = await r.json(); if (j && j.error) msg = j.error; } catch(e) {}
        throw new Error(msg);
      }
      const audio = new Audio(URL.createObjectURL(await r.blob()));
      btn.textContent = '🔊 Playing…';
      audio.onended = audio.onerror = () => { btn.textContent = orig; btn.disabled = false; };
      await audio.play();
    } catch(e) { toast(e.message || 'Could not play audio', 'error'); btn.disabled = false; btn.textContent = orig; }
  },
  // Back-compat alias.
  playVoicemail(callId, btn) { return this.playRecording(callId, btn, 'voicemail'); },

  async remove(id) {
    if (!confirm('Delete this lead and its call history?')) return;
    try { await db.leads.delete(id); Modal.close(); toast('Lead deleted'); this.render(); }
    catch(e) { toast(e.message || 'Could not delete', 'error'); }
  },
};

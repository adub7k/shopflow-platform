// ── Response Center — speed-to-lead cockpit ──────────────────────────────────
// One job: get every new lead answered fast. Shows the queue of leads still
// waiting on a first response, ranked by a priority score (freshness, source,
// intent, engagement — each with visible reasons), with live wait timers and
// one-tap call / text / done actions. Below the queue: response-time metrics
// (avg, % under 5 min, per-source) computed from lead.firstResponseAt, which
// the server stamps on the first status move off 'new', the first Twilio SMS,
// or an answered tracking-number call.
//
// NO new backend beyond the firstResponseAt stamps: the queue and metrics are
// computed client-side from db.leads.all(). Texting is the owner's iPhone via
// the sms: deep link (_cpSms) — same manual-SMS stance as Leads/Tasks (no A2P).

const Response = {
  _leads: [],
  _timer: null,

  // ── Priority score (0–100, explainable) ──
  // Freshness dominates: a lead answered inside the first minutes converts at a
  // multiple of one answered hours later, so the newest leads float to the top
  // while high-intent signals break ties.
  _score(l) {
    let s = 0; const why = [];
    const ageMin = Math.max(0, (Date.now() - new Date(l.createdAt || l.firstContactAt || 0)) / 60000);
    if      (ageMin <= 5)    { s += 40; why.push('🔥 Golden window — under 5 min old'); }
    else if (ageMin <= 30)   { s += 32; why.push('Fresh — under 30 min old'); }
    else if (ageMin <= 120)  { s += 24; }
    else if (ageMin <= 1440) { s += 12; }
    else                     { s += 4; }

    const src = String(l.source || 'call').toLowerCase();
    if (['facebook','instagram','google','tiktok'].includes(src)) { s += 20; why.push('Paid ad lead'); }
    else if (src === 'call') { s += 18; why.push('Called the shop'); }
    else s += 12;

    const svcs = l.servicesInterested || [];
    if (svcs.length) s += 6;
    if (svcs.some(x => /ceramic|tint|ppf|paint|correction|full/i.test(x))) { s += 8; why.push('High-ticket interest'); }
    if (/asap|today|this week|soon/i.test(l.notes || '')) { s += 8; why.push('Wants it soon'); }
    if (l.vehicle && (l.vehicle.make || l.vehicle.model)) s += 4;
    if (l.email) s += 2;

    if ((l.missedCount || 0) > 0)  { s += 8; why.push(l.missedCount + ' missed call' + (l.missedCount > 1 ? 's' : '')); }
    if ((l.formSubmits || 0) > 1)  { s += 6; why.push('Submitted the form ' + l.formSubmits + '×'); }
    if ((l.callCount || 0) > 1)    { s += 4; why.push('Called ' + l.callCount + '×'); }

    // AI receptionist rating (from the voicemail transcript, when available).
    // Hot jumps the queue, cold sinks — the model has read what redialing hasn't.
    const q = l.ai && l.ai.quality;
    if      (q === 'hot')  { s += 12; why.unshift('🔥 AI rated: hot lead'); }
    else if (q === 'warm') { s += 6;  why.push('AI rated: warm lead'); }
    else if (q === 'cold') { s -= 15; why.push('🧊 AI rated: cold lead'); }

    return { score: Math.max(0, Math.min(100, Math.round(s))), why };
  },
  _scoreMeta(score) {
    if (score >= 75) return { label: 'Hot',    bg: '#fef2f2', fg: '#dc2626' };
    if (score >= 55) return { label: 'High',   bg: '#fff7ed', fg: '#ea580c' };
    if (score >= 35) return { label: 'Medium', bg: '#fffbeb', fg: '#d97706' };
    return             { label: 'Low',    bg: '#f3f4f6', fg: '#6b7280' };
  },

  // ── Time formatting ──
  _mins(fromIso, toIso) { return Math.max(0, ((toIso ? new Date(toIso) : new Date()) - new Date(fromIso)) / 60000); },
  _fmtDur(mins) {
    if (mins < 1)      return 'now';
    if (mins < 60)     return Math.round(mins) + 'm';
    if (mins < 1440)   return Math.floor(mins / 60) + 'h ' + Math.round(mins % 60) + 'm';
    return Math.floor(mins / 1440) + 'd ' + Math.floor((mins % 1440) / 60) + 'h';
  },
  // Wait-time urgency: green while the lead is still hot, red once it's gone stale.
  _waitMeta(mins) {
    if (mins <= 5)   return { bg: 'var(--green-lt)', fg: 'var(--green)' };
    if (mins <= 30)  return { bg: '#fffbeb', fg: '#d97706' };
    if (mins <= 120) return { bg: '#fff7ed', fg: '#ea580c' };
    return             { bg: '#fef2f2', fg: '#dc2626' };
  },
  // Response-time grading for the "answered" list: fast = green.
  _respMeta(mins) {
    if (mins <= 5)  return { bg: 'var(--green-lt)', fg: 'var(--green)' };
    if (mins <= 60) return { bg: '#fffbeb', fg: '#d97706' };
    return            { bg: '#fef2f2', fg: '#dc2626' };
  },

  async render() {
    const el = document.getElementById('page-response'); if (!el) return;
    try { this._leads = await db.leads.all(); } catch(e) { this._leads = []; }

    // Live wait timers: re-render every 30s while this page is active.
    if (!this._timer) this._timer = setInterval(() => {
      if (App._page === 'response' && !document.querySelector('.modal-overlay')) this.render();
    }, 30000);

    const waiting = this._leads.filter(l => l.status === 'new')
      .map(l => ({ l, ...this._score(l), waitMin: this._mins(l.createdAt || l.firstContactAt) }))
      .sort((a, b) => b.score - a.score || a.waitMin - b.waitMin);

    // Responded leads with a stamped first response → the metrics + history list.
    const responded = this._leads
      .filter(l => l.firstResponseAt && (l.createdAt || l.firstContactAt))
      .map(l => ({ l, respMin: this._mins(l.createdAt || l.firstContactAt, l.firstResponseAt) }))
      .sort((a, b) => new Date(b.l.firstResponseAt) - new Date(a.l.firstResponseAt));
    const last30 = responded.filter(r => (Date.now() - new Date(r.l.firstResponseAt)) < 30 * 86400000);
    const avgMin = last30.length ? last30.reduce((a, r) => a + r.respMin, 0) / last30.length : null;
    const under5 = last30.length ? Math.round(last30.filter(r => r.respMin <= 5).length / last30.length * 100) : null;

    // ── Stat cards ──
    const oldest = waiting.length ? Math.max(...waiting.map(w => w.waitMin)) : null;
    const stat = (label, value, sub, fg) => `<div class="card" style="flex:1;min-width:130px;margin:0;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);">${label}</div>
      <div style="font-size:24px;font-weight:800;letter-spacing:-.03em;color:${fg || 'var(--text)'};margin-top:4px;">${value}</div>
      ${sub ? `<div style="font-size:11px;color:var(--faint);margin-top:2px;">${sub}</div>` : ''}
    </div>`;
    const stats = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
      ${stat('Waiting now', waiting.length, waiting.length ? (waiting.length === 1 ? 'lead needs a response' : 'leads need a response') : 'all caught up', waiting.length ? '#dc2626' : 'var(--green)')}
      ${stat('Oldest waiting', oldest != null ? this._fmtDur(oldest) : '—', oldest != null ? 'answer oldest first if tied' : '')}
      ${stat('Avg response', avgMin != null ? this._fmtDur(avgMin) : '—', 'last 30 days', avgMin != null ? this._respMeta(avgMin).fg : undefined)}
      ${stat('Under 5 min', under5 != null ? under5 + '%' : '—', 'the speed-to-lead target', under5 != null ? (under5 >= 50 ? 'var(--green)' : '#d97706') : undefined)}
    </div>`;

    // ── Why speed matters — tiny explainer, once (dismiss persists locally) ──
    const explainer = localStorage.getItem('sf_rc_hint') ? '' : `<div class="lead-banner" style="margin-bottom:12px;">
      <span style="font-size:18px;">⚡</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text);">Answer in 5 minutes, win the job</div>
        <div style="font-size:12px;color:var(--muted);">Leads answered within 5 minutes are far more likely to book than ones answered an hour later. This queue keeps the clock visible.</div>
      </div>
      <button class="btn" style="flex-shrink:0;font-size:12px;padding:7px 12px;" onclick="localStorage.setItem('sf_rc_hint','1');Response.render()">Got it</button>
    </div>`;

    // ── The queue ──
    const rows = waiting.map(w => {
      const l = w.l, sm = Leads._sourceMeta(l.source), scm = this._scoreMeta(w.score), wm = this._waitMeta(w.waitMin);
      const name = l.name || l.phone || 'Unknown caller';
      const veh = l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
      const sub = [veh, (l.servicesInterested || []).join(', ')].filter(Boolean).join(' · ');
      const whyChips = w.why.slice(0, 3).map(r => `<span style="font-size:11px;background:var(--off);color:var(--muted);border-radius:6px;padding:2px 7px;white-space:nowrap;">${esc(r)}</span>`).join('');
      const tel = 'tel:' + String(l.phone || '').replace(/[^\d+]/g, '');
      return `<div class="card" style="margin-bottom:10px;cursor:pointer;" onclick="Response.open('${l.id}')">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="flex-shrink:0;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:46px;height:46px;border-radius:12px;background:${scm.bg};color:${scm.fg};">
            <span style="font-size:15px;font-weight:900;line-height:1;">${w.score}</span>
            <span style="font-size:8.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;">${scm.label}</span>
          </span>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:14.5px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</span>
              <span class="lead-badge" style="background:${wm.bg};color:${wm.fg};flex-shrink:0;">⏱ waiting ${this._fmtDur(w.waitMin)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:3px;min-width:0;">
              <span class="lead-badge" style="background:var(--off);color:var(--muted);flex-shrink:0;">${sm.icon} ${esc(sm.label)}</span>
              <span style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(sub || l.phone || '')}</span>
            </div>
            ${whyChips ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">${whyChips}</div>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          ${l.phone ? `<a class="btn" href="${esc(tel)}" style="flex:1;text-align:center;text-decoration:none;font-size:13px;" onclick="event.stopPropagation();">📞 Call</a>` : ''}
          ${l.phone ? `<button class="btn btn-primary" style="flex:1;font-size:13px;" onclick="event.stopPropagation();Response.text('${l.id}')">💬 Text</button>` : ''}
          <button class="btn" style="flex:1;font-size:13px;" onclick="event.stopPropagation();Response.markContacted('${l.id}')">✓ Responded</button>
        </div>
      </div>`;
    }).join('');

    const queue = waiting.length ? rows : `<div class="card"><div class="empty-state">
      <div class="empty-icon">🎉</div>
      <div class="empty-text">Every lead has been answered</div>
      <div style="font-size:12px;color:var(--faint);margin-top:6px;">New leads land here the moment they come in — from the lead form or a call to your tracking number.</div>
    </div></div>`;

    // ── Recently answered (response-time history) ──
    const histRows = responded.slice(0, 12).map(r => {
      const rm = this._respMeta(r.respMin), sm = Leads._sourceMeta(r.l.source);
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.l.name || r.l.phone || 'Lead')}</div>
        <span class="lead-badge" style="background:var(--off);color:var(--muted);flex-shrink:0;">${sm.icon} ${esc(sm.label)}</span>
        <span class="lead-badge" style="background:${rm.bg};color:${rm.fg};flex-shrink:0;">answered in ${this._fmtDur(r.respMin)}</span>
      </div>`;
    }).join('');
    // Per-source average response time — where slow responses are coming from.
    const bySrc = {};
    last30.forEach(r => { const k = String(r.l.source || 'call').toLowerCase(); (bySrc[k] = bySrc[k] || []).push(r.respMin); });
    const srcRows = Object.keys(bySrc).sort((a, b) => bySrc[b].length - bySrc[a].length).map(k => {
      const arr = bySrc[k], avg = arr.reduce((x, y) => x + y, 0) / arr.length, sm = Leads._sourceMeta(k), rm = this._respMeta(avg);
      return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px;">
        <span style="width:120px;color:var(--text);font-weight:600;flex-shrink:0;">${sm.icon} ${esc(sm.label)}</span>
        <span style="color:var(--faint);font-size:12px;flex:1;">${arr.length} lead${arr.length !== 1 ? 's' : ''}</span>
        <span class="lead-badge" style="background:${rm.bg};color:${rm.fg};">avg ${this._fmtDur(avg)}</span>
      </div>`;
    }).join('');

    const history = responded.length ? `<div class="card" style="margin-top:14px;">
      <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">Recently answered</div>
      ${histRows}
      ${srcRows ? `<div style="font-size:13px;font-weight:700;color:var(--text);margin:14px 0 4px;">Response time by source <span style="font-weight:500;color:var(--faint);font-size:11px;">(30 days)</span></div>${srcRows}` : ''}
    </div>` : '';

    el.innerHTML = explainer + stats
      + `<div style="font-size:13px;font-weight:700;color:var(--text);margin:2px 0 10px;">Needs a response ${waiting.length ? `<span style="color:var(--faint);font-weight:500;">— highest priority first</span>` : ''}</div>`
      + queue + history;
  },

  // Row tap → the full lead modal on the Leads page (call history, AI card, notes).
  open(id) {
    Leads._leads = this._leads;
    Leads.open(id);
  },

  // Quick-text: template picker + composer → iPhone Messages deep link, then the
  // lead is marked contacted (which stamps firstResponseAt server-side).
  text(id) {
    const l = this._leads.find(x => x.id === id); if (!l || !l.phone) return;
    const first = String(l.name || '').trim().split(/\s+/)[0] || 'there';
    const shop = (Shop.settings && Shop.settings.shopName) || 'us';
    const fill = (t) => String(t || '').replace(/\{first\}/g, first).replace(/\{name\}/g, l.name || 'there').replace(/\{shop\}/g, shop);
    // The AI receptionist's suggested reply (written from the voicemail
    // transcript) beats the generic opener when it exists.
    const defaultMsg = (l.ai && l.ai.followUp) ? l.ai.followUp
      : fill("Hi {first}, this is {shop} — got your request! I'm putting your price together now. Quick reply here if there's anything else I should know about the vehicle.");
    const tpls = Array.isArray(Shop.settings && Shop.settings.smsTemplates) ? Shop.settings.smsTemplates.filter(t => t && t.body) : [];
    const opts = tpls.map((t, i) => `<option value="${i}">${esc(t.label || 'Template')}</option>`).join('');
    Modal.show(`
      <div class="modal-title">Text ${esc(l.name || l.phone)}</div>
      ${opts ? `<div class="form-group"><label class="form-label">Template</label>
        <select class="form-input" id="rc-tpl" onchange="Response._useTpl('${l.id}')">
          <option value="">First response (default)</option>${opts}
        </select></div>` : ''}
      <div class="form-group">
        <label class="form-label">Message</label>
        <textarea class="form-input" id="rc-body" rows="4">${esc(defaultMsg)}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary btn-full" onclick="Response.sendText('${l.id}')">Open in Messages</button>
      </div>
    `);
  },
  _useTpl(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    const sel = document.getElementById('rc-tpl'), body = document.getElementById('rc-body');
    if (!sel || !body) return;
    const first = String(l.name || '').trim().split(/\s+/)[0] || 'there';
    const shop = (Shop.settings && Shop.settings.shopName) || 'us';
    const fill = (t) => String(t || '').replace(/\{first\}/g, first).replace(/\{name\}/g, l.name || 'there').replace(/\{shop\}/g, shop);
    const tpls = (Shop.settings.smsTemplates || []).filter(t => t && t.body);
    body.value = sel.value === ''
      ? fill("Hi {first}, this is {shop} — got your request! I'm putting your price together now. Quick reply here if there's anything else I should know about the vehicle.")
      : fill(tpls[Number(sel.value)].body);
  },
  sendText(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    const body = (document.getElementById('rc-body') || {}).value || '';
    if (!body.trim()) return;
    _cpSms(l.phone, body.trim());
    Modal.close();
    this.markContacted(id, true);
  },

  async markContacted(id, silent) {
    try {
      await db.leads.update(id, { status: 'contacted' });
      if (!silent) toast('Marked as responded ✓');
      this.render();
    } catch(e) { toast(e.message || 'Could not update lead', 'error'); }
  },
};

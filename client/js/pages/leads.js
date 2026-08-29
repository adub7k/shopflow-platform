// ── Leads (inbound calls + web lead form) ─────────────────────────────────────
// Populated two ways: the call-screening webhooks (every inbound call to the
// shop's tracking number) and the public lead-capture form at /book/<slug>.
// Web leads carry ad attribution (source = utm_source, e.g. 'facebook'), so the
// breakdown up top shows exactly which channel each lead came from.
const Leads = {
  _leads: [],
  _filter: 'all',

  // ── Pipeline stage configuration (shared with the Pipeline board) ───────────
  // The owner can define their own stages (Pipeline → Edit stages), stored as
  // settings.pipeline.stages [{key,label,color,interval,won,terminal,fixed}].
  // Three anchors always exist: the intake stage (key 'new' — every lead lands
  // there) and the two end states 'closed' (won) / 'lost' (dead). Keys are
  // stable ids: renames only change labels, so lead records never migrate.
  // `interval` = minutes a lead may sit in the stage before it's flagged.
  DEFAULT_STAGES: [
    { key: 'new',       label: 'New',       color: '#2563eb', interval: 15,   fixed: 'intake' },
    { key: 'contacted', label: 'Contacted', color: '#d97706', interval: 1440 },
    { key: 'quoted',    label: 'Quoted',    color: '#7c3aed', interval: 2880 },
    { key: 'booked',    label: 'Booked',    color: '#16a34a', interval: 0,    won: true },
    { key: 'worked',    label: 'Worked',    color: '#0891b2', interval: 2880, won: true },
    { key: 'closed',    label: 'Closed',    color: '#374151', terminal: true, won: true, fixed: 'won' },
    { key: 'lost',      label: 'Lost',      color: '#9ca3af', terminal: true, fixed: 'lost' },
  ],
  stageConfig() {
    const p = (Shop.settings && Shop.settings.pipeline) || {};
    let stages = (Array.isArray(p.stages) && p.stages.length)
      ? p.stages.map(s => ({
          key: String((s && s.key) || ''),
          label: String((s && s.label) || 'Stage').slice(0, 24),
          color: /^#[0-9a-fA-F]{6}$/.test((s && s.color) || '') ? s.color : '#64748b',
          interval: Math.max(0, Number(s && s.interval) || 0),
          won: !!(s && s.won), terminal: !!(s && s.terminal), fixed: s && s.fixed,
        })).filter(s => s.key)
      : null;
    // The anchors must survive whatever was saved — a config missing one is
    // treated as corrupt and rebuilt from the defaults.
    if (!stages || !['new', 'closed', 'lost'].every(k => stages.some(s => s.key === k))) {
      stages = this.DEFAULT_STAGES.map(s => ({ ...s }));
      // An earlier build stored timing alone as settings.pipeline.intervals.
      if (p.intervals) stages.forEach(s => { if (p.intervals[s.key] != null) s.interval = Math.max(0, Number(p.intervals[s.key]) || 0); });
    }
    return stages;
  },
  // ── 30-day follow-up sequence (Meta leads; worked from the Tasks page) ──────
  // Per-lead state lives at lead.followUp = { idx, status, nextAt, startedAt,
  // log[] }. status: active (in the queue when due) · paused (customer replied /
  // manual hold) · completed (booked — auto-set server-side) · stopped (lost or
  // manually ended) · done (finished day 30 → long-term reactivation pool).
  // Every send is MANUAL: the Tasks queue button opens Messages prefilled; the
  // owner hits send themselves. Nothing here auto-texts.
  DEFAULT_FOLLOWUP_SEQ: [
    { id: 'd0a', label: 'Day 0 Initial',   day: 0,  sms: "Hey [NAME], this is Angelo from [SHOP] 👋 Saw you were looking to get your [VEHICLE] tinted. What are you mainly wanting it for — heat, privacy, or the look?" },
    { id: 'd0b', label: 'Day 0 Follow-Up', day: 0,  sms: "I can get you a price too 👍 Just want to make sure I point you toward the right film for what you're wanting." },
    { id: 'd0c', label: 'Day 0 Evening',   day: 0,  sms: "Quick question [NAME] — are you still shopping around for tint, or did you already find a shop?" },
    { id: 'd1',  label: 'Day 1',  day: 1,  sms: "Hey [NAME], wanted to make sure I didn't miss you. If you're still looking, send me the year/make/model and I'll get you a couple options." },
    { id: 'd2',  label: 'Day 2',  day: 2,  sms: "If heat is the big reason you're looking, I'd definitely recommend going ceramic. The difference in the NM sun is pretty noticeable.\nWant me to show you the option I'd recommend?" },
    { id: 'd3',  label: 'Day 3',  day: 3,  sms: "Are you mainly comparing prices right now? If so, that's totally fine. If you send me what you've been quoted, I can make sure you're actually comparing the same type of film." },
    { id: 'd5',  label: 'Day 5',  day: 5,  sms: "We've been doing quite a few vehicles lately for people who originally came in because they were tired of the heat. Once they get the better film, they usually tell us they wish they'd done it sooner 😂\nStill thinking about doing yours?" },
    { id: 'd7',  label: 'Day 7',  day: 7,  sms: "[NAME], just wanted to give you a heads up — the [OFFER] is still available.\nIf you want to take advantage of it, I can check what openings we have this week." },
    { id: 'd10', label: 'Day 10', day: 10, sms: "Be honest with me 😂 — did you decide to get the tint done somewhere else, or are you still thinking about it?" },
    { id: 'd14', label: 'Day 14', day: 14, sms: "If you're still debating what to get, tell me what's most important:\n1. Lowest price\n2. Heat rejection\n3. Privacy\n4. Best overall\nI'll tell you exactly what I'd go with." },
    { id: 'd17', label: 'Day 17', day: 17, sms: "One thing I don't want you to do is spend money twice on tint. If you're comparing shops, I'd be happy to explain the difference between the films we're offering so you know exactly what you're paying for." },
    { id: 'd21', label: 'Day 21', day: 21, sms: "Hey [NAME], I've got a couple openings coming up and figured I'd check with you before I fill them. Still want me to get your [VEHICLE] tinted?" },
    { id: 'd24', label: 'Day 24', day: 24, sms: "Imagine getting into the car after it's been sitting in the sun all afternoon and it actually feels comfortable 😂\nThat's honestly why most of our customers end up loving the ceramic.\nWant me to get you a quote?" },
    { id: 'd27', label: 'Day 27', day: 27, sms: "I don't want to keep blowing you up if tint isn't a priority right now 😂\nShould I close this out for now?" },
    { id: 'd30', label: 'Day 30', day: 30, sms: "Last message from me, [NAME] 👍\nIf you still want to get the [VEHICLE] done, just reply TINT and I'll take care of everything from there." },
  ],
  followUpSeq() {
    const s = (Shop.settings && Shop.settings.followUpSeq);
    if (Array.isArray(s) && s.length) {
      const seq = s.map(e => ({ id: String((e && e.id) || ''), label: String((e && e.label) || 'Step'), day: Math.max(0, Number(e && e.day) || 0), sms: String((e && e.sms) || '') }))
        .filter(e => e.id && e.sms);
      if (seq.length) return seq;
    }
    return this.DEFAULT_FOLLOWUP_SEQ;
  },
  // [VAR] replacement with graceful fallbacks — a missing value never leaks
  // "[VEHICLE]" to a customer.
  fuFill(body, l) {
    const first = String((l && l.name) || '').trim().split(/\s+/)[0];
    const veh = l && l.vehicle ? [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ') : '';
    const shop = (Shop.settings && Shop.settings.shopName) || 'our shop';
    const now = new Date();
    const map = {
      NAME: first || 'there',
      PHONE: (l && l.phone) || '',
      VEHICLE: veh || 'vehicle',
      SHOP: shop,
      OFFER: (Shop.settings && Shop.settings.followUpOffer) || 'deal we talked about',
      PRICE: (l && l.quotedAmount != null) ? fmtMoney(l.quotedAmount) : 'a price',
      SALESPERSON: (typeof Auth !== 'undefined' && Auth.getName && Auth.getName()) || shop,
      DATE: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      TIME: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    };
    return String(body || '')
      .replace(/\[([A-Z]+)\]/g, (m, k) => (map[k] !== undefined ? map[k] : m))
      .replace(/\{first\}/gi, map.NAME).replace(/\{name\}/gi, (l && l.name) || 'there').replace(/\{shop\}/gi, shop);
  },
  // When step `idx` is sent at `fromISO`, when is the NEXT step due? Same-day
  // steps chain 3h apart; later days ride the day gap. Relative to the actual
  // send, so a late send never collapses the remaining cadence.
  fuNextAt(seq, sentIdx, fromISO) {
    const cur = seq[sentIdx], next = seq[sentIdx + 1];
    if (!next) return null;
    const from = new Date(fromISO || Date.now()).getTime();
    const deltaDays = next.day - (cur ? cur.day : 0);
    return new Date(from + (deltaDays <= 0 ? 3 * 3600000 : deltaDays * 86400000)).toISOString();
  },
  fuFreshState() {
    const now = new Date().toISOString();
    return { idx: 0, status: 'active', nextAt: now, startedAt: now, log: [] };
  },

  // "Knocked out today": the owner already reached out to this lead today —
  // a sequence step sent, a day-text tapped, or any Texted note stamped. Lists
  // sort these to the BOTTOM so whoever is still waiting sits on top. (This is
  // owner-touch evidence, deliberately separate from lastContactAt, which only
  // customer activity moves.)
  touchedToday(l) {
    const now = new Date();
    const isToday = (iso) => {
      if (!iso) return false;
      const d = new Date(iso);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    };
    if (l.followUp && (l.followUp.log || []).some(e => !e.skipped && isToday(e.at))) return true;
    if (l.dripLog && Object.values(l.dripLog).some(isToday)) return true;
    if ((l.noteLog || []).some(n => isToday(n.at) && /texted|text sent/i.test(n.text || ''))) return true;
    return false;
  },

  // Badge colors derived from the stage config so custom stages render
  // everywhere: list badges, filter pills, and the modal's status picker.
  get _statusMeta() {
    const m = {};
    this.stageConfig().forEach(s => { m[s.key] = { label: s.label, bg: s.color + '1a', fg: s.color, dot: s.color }; });
    return m;
  },
  // A lead counts as won once it reaches any win-flagged stage. 'closed' is
  // trusted only with server proof (closedAt / stage history): under the old
  // semantics closed meant dead, and those legacy leads carry neither.
  _isWon(l) {
    const won = new Set(this.stageConfig().filter(s => s.won && !s.terminal).map(s => s.key));
    return won.has(l.status)
      || (l.stageLog || []).some(s => won.has(s.to))
      || (l.status === 'closed' && (!!l.closedAt || (l.stageLog || []).length > 0));
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
    const isBooked = l => this._isWon(l);
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
      if (this._isWon(l)) bySrc[k].booked++;
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
    // Modal actions (save / status / note / convert) all funnel back through
    // here — when the owner is working from the Pipeline board, repaint that
    // instead of the hidden list.
    if (typeof Pipeline !== 'undefined' && Pipeline.isActive()) return Pipeline.render();
    const el = document.getElementById('page-leads'); if (!el) return;
    try { this._leads = await db.leads.all(); this._fetchedAt = Date.now(); } catch(e) { this._leads = []; }

    const counts = { all: this._leads.length };
    Object.keys(this._statusMeta).forEach(k => { counts[k] = 0; });
    this._leads.forEach(l => { counts[l.status] = (counts[l.status]||0) + 1; });

    const pill = (key, label) => `<button class="lead-pill ${this._filter===key?'active':''}" onclick="Leads.setFilter('${key}')">${label}${counts[key]?` <span class="lead-pill-count">${counts[key]}</span>`:''}</button>`;
    const filters = `<div class="lead-filters">
      ${pill('all','All')}${Object.keys(this._statusMeta).map(k => pill(k, this._statusMeta[k].label)).join('')}
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

    // Same deterministic order as the v2 list: most recent inbound contact
    // first — owner actions never write lastContactAt, so the order is stable
    // while working the list.
    const shown = (this._filter==='all' ? this._leads : this._leads.filter(l => l.status===this._filter))
      .slice().sort((a, b) => new Date(b.lastContactAt || b.createdAt || 0) - new Date(a.lastContactAt || a.createdAt || 0));

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

  // Opening a lead tops up from the server in the background: notes (and other
  // team activity) added on ANOTHER device/user must show up here, not just for
  // whoever wrote them. The app is a PWA that stays open for days — without
  // this, the in-memory list a modal renders from can be ancient.
  // Every step below is gated on `this._openId === id` — the fetch is slow on a
  // phone, and by the time it lands the owner may have closed this lead and
  // opened another. Without the gate this repainted the PREVIOUS lead's modal
  // over the new one ("taps pull up the lead I hit before") and, worse, stuffed
  // the new modal's typed fields into the previous lead's record.
  async _freshen(id) {
    if (Date.now() - (this._fetchedAt || 0) < 8000) return; // just fetched
    try {
      const cur = this._leads.find(x => x.id === id);
      const beforeNotes = cur ? JSON.stringify(cur.noteLog || []) : '';
      if (cur && this._openId === id && document.getElementById('lead-name')) this._captureModalEdits(cur); // keep typing
      const list = await db.leads.all();
      this._fetchedAt = Date.now();
      const fresh = list.find(x => x.id === id);
      if (fresh && cur && this._openId === id) {
        // The open modal's unsaved intent wins over the server copy while
        // editing. Status is NOT merged — the server copy is truth and any
        // pill choice lives in _pendingStatus until saved.
        fresh.name = cur.name || fresh.name;
        if (cur.quotedAmount != null) fresh.quotedAmount = cur.quotedAmount;
        fresh.source = cur.source || fresh.source;
        if (cur.lostReason != null) fresh.lostReason = cur.lostReason;
      }
      this._leads = list;
      // New notes from someone else while THIS lead is still the open modal →
      // repaint it, preserving a half-typed note draft.
      if (this._openId === id && fresh && document.getElementById('lead-note-new') && JSON.stringify(fresh.noteLog || []) !== beforeNotes) {
        // Only carry a note draft over if the box belonged to THIS lead — a
        // stale previous modal's half-typed note must not land on this one.
        const box0 = document.getElementById('lead-note-new');
        const draft = (box0 && box0.dataset.lead === id) ? box0.value : '';
        this.open(id);
        const box = document.getElementById('lead-note-new'); if (box && draft) box.value = draft;
      }
    } catch (e) {}
  },

  // Reopen the modal for `id` only if that lead still owns it — a slow save's
  // trailing reopen must never resurrect a modal the owner has moved past.
  _reopenIf(id) { if (this._openId === id) this.open(id); },

  open(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    if (this._openId !== id) this._pendingStatus = null;   // fresh lead → no leftover pill choice
    this._openId = id;   // this lead owns the modal until it closes or another opens
    this._freshen(id); // background top-up; repaints if teammates added notes
    // Status pills render a PENDING choice, not a mutation: a tapped pill only
    // becomes real on Save. Tapping around and closing changes nothing — the
    // old in-place `l.status = …` lingered in memory and a later unrelated Save
    // quietly persisted it (leads "moving into Worked by themselves").
    const eff = this._pendingStatus || l.status;
    const m = this._statusMeta[eff] || this._statusMeta.new;
    const name = l.name || l.phone || 'Unknown caller';
    // Owner's saved quick-reply presets (Settings → Message Templates), shared
    // with the Messages composer and Response Center via _smsTemplates().
    this._tplList = _smsTemplates();

    const statusPills = Object.keys(this._statusMeta).map(k => {
      const sm = this._statusMeta[k];
      return `<button class="lead-status-opt ${eff===k?'active':''}" style="${eff===k?`background:${sm.bg};color:${sm.fg};border-color:${sm.fg};`:''}" onclick="Leads.setStatus('${l.id}','${k}')">${sm.label}</button>`;
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
    const contactRow = (k, v, href) => v ? `<div style="display:flex;gap:10px;padding:5px 0;font-size:13px;"><span style="width:86px;color:var(--muted);flex-shrink:0;">${k}</span><a href="${href}:${esc(v)}" style="font-weight:600;color:var(--green);text-decoration:none;">${esc(v)}</a></div>` : '';
    const detailCard = `
      ${contactRow('Phone', l.phone, 'tel')}
      ${(l.ai && l.ai.altCallbackNumber) ? infoRow('Alt callback', l.ai.altCallbackNumber + ' · verify') : ''}
      ${infoRow('Source', sm.icon + ' ' + sm.label + (l.utm && l.utm.campaign ? ' · ' + l.utm.campaign : ''))}
      ${infoRow('Vehicle', veh)}
      ${infoRow('Interested in', ((l.ai && l.ai.servicesDiscussed && l.ai.servicesDiscussed.length ? l.ai.servicesDiscussed : l.servicesInterested) || []).join(', '))}
      ${contactRow('Email', l.email, 'mailto')}`;

    Modal.show(`
      <div class="modal-title" style="display:flex;align-items:center;gap:10px;">
        ${avatarEl(l.name || sm.icon, 38)}
        <div style="flex:1;min-width:0;">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
          ${l.phone?`<a href="tel:${esc(l.phone)}" style="font-size:12px;font-weight:500;color:var(--green);text-decoration:none;">${esc(l.phone)} ↗</a>`:''}
        </div>
      </div>

      ${this._aiCard(l)}

      ${this._fuCard(l)}

      ${detailCard.trim()?`<div class="form-group" style="background:var(--off);border-radius:10px;padding:8px 12px;">${detailCard}</div>`:''}

      <div class="form-group">
        <label class="form-label">Name</label>
        <input class="form-input" id="lead-name" data-lead="${l.id}" value="${esc(l.name||'')}" placeholder="Add a name…"/>
      </div>

      <div class="form-group">
        <label class="form-label">Source</label>
        ${this._sourcePicker(l)}
      </div>

      <div class="form-group">
        <label class="form-label">Status</label>
        <div class="lead-status-row">${statusPills}</div>
        ${eff==='lost'?`<div style="margin-top:8px;"><input class="form-input" id="lead-lost-reason" placeholder="Why was it lost? — price, ghosted, went elsewhere…" value="${esc(l.lostReason||'')}"/><div style="font-size:11px;color:var(--faint);margin-top:4px;">Saved with the lead — feeds your loss-reason report.</div></div>`:''}
      </div>

      <div class="form-group">
        <label class="form-label">Quoted amount ($)</label>
        <input class="form-input" id="lead-quoted" type="number" min="0" step="1" inputmode="decimal" placeholder="e.g. 450" value="${l.quotedAmount != null ? l.quotedAmount : ''}"/>
      </div>

      <div class="form-group">
        <label class="form-label">Text back</label>
        <select class="form-input" id="lead-tpl" style="margin-bottom:8px;" onchange="Leads.useTemplate('${l.id}')">
          <option value="">Quick replies — pick a template…</option>
          ${this._tplList.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}
        </select>
        <div style="display:flex;gap:8px;align-items:flex-end;">
          <textarea class="form-input" id="lead-sms" rows="2" placeholder="Type a quick reply…" style="flex:1;" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Leads.sendSms('${l.id}');}"></textarea>
          <button class="btn btn-primary" onclick="Leads.sendSms('${l.id}')">Send</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Call history</label>
        <div class="lead-calls">${calls}</div>
      </div>

      <div class="form-group">
        <label class="form-label">Notes</label>
        <div style="display:flex;gap:8px;align-items:flex-end;">
          <textarea class="form-input" id="lead-note-new" data-lead="${l.id}" rows="2" placeholder="Add a note…" style="flex:1;"></textarea>
          <button class="btn" onclick="Leads.addNote('${l.id}')">Save note</button>
        </div>
        ${this._noteHistory(l)}
      </div>

      <div class="modal-actions" style="flex-wrap:wrap;gap:8px;">
        <button class="btn btn-green btn-full" onclick="Leads.book('${l.id}')">📅 Book appointment</button>
        <button class="btn btn-full" onclick="Leads.estimate('${l.id}')">📄 Send an estimate</button>
        <button class="btn btn-primary btn-full" onclick="Leads.save('${l.id}')">Save</button>
        ${(l.calls&&l.calls.length)?`<button class="btn btn-full" onclick="Leads.analyze('${l.id}',this)">✨ ${l.ai?'Re-analyze':'Analyze'} with AI</button>`:''}
        ${l.customerId?`<button class="btn btn-full" onclick="ClientProfile.open('${l.customerId}')">View client</button>`:`<button class="btn btn-full" onclick="Leads.convert('${l.id}')">Convert to client</button>`}
        <button class="btn btn-full" style="color:var(--red);" onclick="Leads.remove('${l.id}')">Delete lead</button>
      </div>
    `);
  },

  // ── 30-day follow-up card (sequence state + history + manual controls) ──────
  _fuCard(l) {
    const fu = l.followUp;
    const seq = this.followUpSeq();
    if (!fu) {
      const stage = this.stageConfig().find(s => s.key === l.status);
      if (stage && (stage.terminal || stage.won)) return '';
      return `<div class="card" style="margin-bottom:14px;"><div style="display:flex;align-items:center;gap:10px;">
        <div style="flex:1;font-size:13px;color:var(--muted);">Not in the 30-day follow-up sequence.</div>
        <button class="btn btn-sm" onclick="Leads.fuStart('${l.id}')">Start sequence</button></div></div>`;
    }
    const step = seq[fu.idx];
    const statusLine = ({
      active: step ? `Next: <strong>${esc(step.label)}</strong> · due ${fu.nextAt ? _msgTimeFull(fu.nextAt) : 'now'}` : 'Sequence finished',
      paused: `<span style="color:var(--orange);font-weight:700;">Paused${fu.pausedReason === 'replied' ? ' — customer replied' : ''}</span>`,
      completed: `<span style="color:var(--green);font-weight:700;">Completed — booked</span>`,
      stopped: `<span style="color:var(--faint);font-weight:700;">Stopped</span>`,
      done: `<span style="color:var(--faint);font-weight:700;">Finished day 30 — in the reactivation pool</span>`,
    })[fu.status] || '';
    const hist = (fu.log || []).map(e => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:3px 0;">
        <span>${esc(e.step)}${e.skipped ? ' <span style="color:var(--faint);">(skipped)</span>' : ''}</span>
        <span style="color:${e.skipped ? 'var(--faint)' : 'var(--green)'};white-space:nowrap;">${e.skipped ? '' : '✓ '}${_msgTimeFull(e.at)}</span>
      </div>`).join('');
    const pend = (step && fu.status === 'active')
      ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:3px 0;color:var(--muted);"><span>${esc(step.label)}</span><span>Pending</span></div>` : '';
    const ctl = [];
    if (fu.status === 'active') {
      ctl.push(`<button class="btn btn-sm" onclick="Leads.fuAction('${l.id}','replied')">Customer replied</button>`);
      ctl.push(`<button class="btn btn-sm" onclick="Leads.fuAction('${l.id}','pause')">Pause</button>`);
      if (step) ctl.push(`<button class="btn btn-sm" onclick="Leads.fuAction('${l.id}','skip')">Skip step</button>`);
    }
    if (['paused', 'completed', 'stopped'].includes(fu.status)) ctl.push(`<button class="btn btn-sm" onclick="Leads.fuAction('${l.id}','resume')">Resume</button>`);
    if (['active', 'paused'].includes(fu.status)) ctl.push(`<button class="btn btn-sm" style="color:var(--red);" onclick="Leads.fuAction('${l.id}','stop')">Stop</button>`);
    const dateCtl = (fu.status === 'active' && step)
      ? `<div style="display:flex;gap:6px;align-items:center;margin-top:8px;">
          <input class="form-input" id="fu-next-${l.id}" type="date" value="${String(fu.nextAt || '').split('T')[0]}" style="flex:1;">
          <button class="btn btn-sm" style="flex-shrink:0;" onclick="Leads.fuAction('${l.id}','reschedule')">Set date</button></div>` : '';
    return `<div class="card" style="margin-bottom:14px;">
      <div style="font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.05em;margin-bottom:6px;">30-DAY FOLLOW-UP</div>
      <div style="font-size:13px;line-height:1.5;">${statusLine}</div>
      ${(hist || pend) ? `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:6px;max-height:180px;overflow-y:auto;">${hist}${pend}</div>` : ''}
      ${dateCtl}
      ${ctl.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">${ctl.join('')}</div>` : ''}
    </div>`;
  },
  async fuStart(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    l.followUp = this.fuFreshState();
    await this._fuPersist(l, 'Sequence started — Day 0 due now');
  },
  async fuAction(id, act) {
    const l = this._leads.find(x => x.id === id); if (!l || !l.followUp) return;
    const fu = l.followUp;
    const seq = this.followUpSeq();
    const now = new Date().toISOString();
    if (act === 'pause') { fu.status = 'paused'; fu.pausedReason = 'manual'; }
    else if (act === 'replied') { fu.status = 'paused'; fu.pausedReason = 'replied'; }
    else if (act === 'resume') {
      if (fu.idx >= seq.length) { fu.status = 'done'; fu.nextAt = null; }
      else { fu.status = 'active'; fu.pausedReason = null; if (!fu.nextAt || fu.nextAt < now) fu.nextAt = now; }
    }
    else if (act === 'stop') { fu.status = 'stopped'; }
    else if (act === 'skip') {
      const step = seq[fu.idx]; if (!step) return;
      fu.log = (fu.log || []).concat({ step: step.label, day: step.day, at: now, by: (Auth.getName && Auth.getName()) || '', skipped: true });
      fu.idx += 1;
      fu.nextAt = this.fuNextAt(seq, fu.idx - 1, now);
      if (fu.idx >= seq.length) { fu.status = 'done'; fu.nextAt = null; }
    }
    else if (act === 'reschedule') {
      const inp = document.getElementById('fu-next-' + id);
      if (!inp || !inp.value) return;
      fu.nextAt = new Date(inp.value + 'T09:00:00').toISOString();
    }
    await this._fuPersist(l, 'Follow-up updated ✓');
  },
  async _fuPersist(l, msg) {
    // Preserve any half-typed modal edits, then reopen so the card reflects the
    // change (same pattern as setStatus).
    if (this._openId === l.id) this._captureModalEdits(l);
    try {
      await db.leads.update(l.id, { followUp: l.followUp });
      toast(msg);
      this._reopenIf(l.id);
    } catch (e) { toast(e.message || 'Could not update', 'error'); }
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
    // Quoted/budget show in the price-sensitive banner instead when flagged (no dupe).
    if (a.quotedPrice != null && !a.priceSensitive) tags.push(['Quoted', fmtMoney(a.quotedPrice)]);
    if (a.budget != null && !a.priceSensitive) tags.push(['Budget', fmtMoney(a.budget)]);
    if (a.agreedTime) tags.push(['Wants', esc(a.agreedTime)]);
    else if (a.desiredDate) tags.push(['When', esc(a.desiredDate)]);
    const grid = tags.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:9px 0 0;">${tags.map(t=>`<span style="font-size:12px;background:var(--surface2);border-radius:6px;padding:3px 8px;"><strong>${t[0]}:</strong> ${t[1]}</span>`).join('')}</div>` : '';
    // Price-sensitive: they balked at the quote — surface it loudly so the owner
    // calls back fast with room to close (quoted vs. what they'd pay).
    const price = a.priceSensitive ? `<div style="display:flex;align-items:center;gap:6px;background:#fff7ed;border:1px solid #fed7aa;color:#c2410c;border-radius:8px;padding:7px 10px;margin-top:9px;font-size:12px;font-weight:700;">💸 Price-sensitive${a.quotedPrice!=null?` · quoted ${fmtMoney(a.quotedPrice)}`:''}${a.budget!=null?` · wants ${fmtMoney(a.budget)}`:''} — call to close</div>` : '';
    const fu = a.followUp ? `<div style="display:flex;align-items:center;gap:8px;margin-top:10px;"><div style="flex:1;font-size:12px;color:var(--muted);line-height:1.45;"><strong>Suggested follow-up:</strong> ${esc(a.followUp)}</div><button class="btn btn-sm btn-green" style="flex-shrink:0;" onclick="Leads.useFollowUp('${l.id}')">Use</button></div>` : '';
    return `<div class="card" style="border:1px solid var(--green-md);background:var(--green-lt);margin-bottom:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="font-size:11px;font-weight:800;color:var(--green);letter-spacing:.05em;">✨ AI RECEPTIONIST</div>
        ${this._qualityChip(a.quality)}
      </div>
      <div style="font-size:14px;line-height:1.5;margin-top:8px;color:var(--text);">${esc(a.summary)}</div>
      ${price}${grid}${fu}
    </div>`;
  },
  useFollowUp(id) {
    const l = this._leads.find(x => x.id === id);
    const el = document.getElementById('lead-sms');
    if (l && l.ai && l.ai.followUp && el) { el.value = l.ai.followUp; el.focus(); }
  },
  // Saved-note history, newest first. A pre-history lead keeps its old free-text
  // notes as a trailing "Earlier note" entry (read-only, still saved on the lead).
  _noteHistory(l) {
    const rows = (l.noteLog || []).map(n => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border);">
        <div style="font-size:13px;color:var(--text);line-height:1.45;white-space:pre-wrap;">${esc(n.text)}</div>
        <div style="font-size:11px;color:var(--faint);margin-top:3px;">${_msgTimeFull(n.at)}${n.by ? ' · ' + esc(n.by) : ''}</div>
      </div>`).join('');
    const legacy = l.notes ? `
      <div style="padding:8px 0;">
        <div style="font-size:13px;color:var(--muted);line-height:1.45;white-space:pre-wrap;">${esc(l.notes)}</div>
        <div style="font-size:11px;color:var(--faint);margin-top:3px;">Earlier note</div>
      </div>` : '';
    if (!rows && !legacy) return '';
    return `<div style="margin-top:8px;">${rows}${legacy}</div>`;
  },
  async addNote(id) {
    const box = document.getElementById('lead-note-new');
    const text = box ? box.value.trim() : '';
    if (!text) { toast('Type a note first', 'warning'); return; }
    const l = this._leads.find(x => x.id === id); if (!l) return;
    try {
      const res = await db.leads.note(id, text);
      l.noteLog = (res && res.noteLog) || l.noteLog;
      if (this._openId === id) this._captureModalEdits(l);   // keep a half-typed name across the re-render
      toast('Note saved ✓');
      this._reopenIf(id);
    } catch(e) { toast(e.message || 'Could not save note', 'error'); }
  },
  // Template picker → fill the Text-back box with the preset, merge fields resolved
  // for this lead. Leaves the box editable so the owner can tweak before sending.
  useTemplate(id) {
    const l = this._leads.find(x => x.id === id);
    const sel = document.getElementById('lead-tpl');
    const box = document.getElementById('lead-sms');
    if (!l || !sel || !box || sel.value === '') return;
    const t = (this._tplList || [])[Number(sel.value)]; if (!t) return;
    const first = String(l.name || '').trim().split(/\s+/)[0] || 'there';
    box.value = _smsFill(t.body, { first, name: l.name, shop: Shop.settings && Shop.settings.shopName });
    box.focus();
  },
  async analyze(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '✨ Analyzing…'; }
    try {
      await db.leads.aiIntake(id);
      this._leads = await db.leads.all();   // refetch so transcript + ai both show
      toast('AI analysis ready ✓');
      this._reopenIf(id);
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
    // PENDING only — never mutate the shared record here. Save commits it;
    // closing the modal discards it.
    this._pendingStatus = status;
    this.open(id); // re-render modal to reflect selection
  },

  // Editable source picker: the known channels plus the lead's current value
  // (if custom) and a Custom… escape hatch. Fixing a mis-attributed lead here
  // corrects the channel split and the pipeline's Meta/Website/Calls filters.
  _KNOWN_SOURCES: ['call','website','facebook','instagram','google','tiktok','nextdoor','yelp','referral','walk-in'],
  _sourcePicker(l) {
    const cur = String(l.source || 'call').toLowerCase();
    const opts = this._KNOWN_SOURCES.includes(cur) ? this._KNOWN_SOURCES : [cur].concat(this._KNOWN_SOURCES);
    return `<select class="form-input" id="lead-source" onchange="Leads._sourceCustomToggle()">
        ${opts.map(s => { const m = this._sourceMeta(s); return `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${m.icon} ${esc(m.label)}</option>`; }).join('')}
        <option value="__custom">Custom…</option>
      </select>
      <input class="form-input" id="lead-source-custom" placeholder="e.g. car show" style="display:none;margin-top:8px;"/>`;
  },
  _sourceCustomToggle() {
    const sel = document.getElementById('lead-source');
    const box = document.getElementById('lead-source-custom');
    if (sel && box) {
      box.style.display = sel.value === '__custom' ? '' : 'none';
      if (sel.value === '__custom') box.focus();
    }
  },
  _sourceValue(fallback) {
    const sel = document.getElementById('lead-source');
    if (!sel) return fallback;
    if (sel.value !== '__custom') return sel.value;
    const custom = document.getElementById('lead-source-custom')?.value.trim().toLowerCase();
    return custom || fallback;
  },

  // Pull the current modal field values into the in-memory lead so a re-render
  // (or a convert) doesn't lose what the user just typed.
  _captureModalEdits(l) {
    // The modal-box DOM persists after Modal.close (close only hides the
    // overlay), so a leftover lead-name field can belong to a PREVIOUSLY
    // viewed lead. Capture ONLY fields stamped with this lead's id —
    // otherwise merely browsing A→B copied A's name/quote/source onto B.
    const nameEl = document.getElementById('lead-name');
    if (!nameEl || nameEl.dataset.lead !== l.id) return;
    l.name = nameEl.value;
    const qEl = document.getElementById('lead-quoted');
    if (qEl) { const v = parseFloat(qEl.value); l.quotedAmount = (Number.isFinite(v) && v > 0) ? v : null; }
    const lrEl = document.getElementById('lead-lost-reason');
    if (lrEl) l.lostReason = lrEl.value.trim() || null;
    l.source = this._sourceValue(l.source);
  },

  async save(id) {
    const l = this._leads.find(x => x.id === id); if (!l) return;
    // Never persist fields from a modal that wasn't rendered for THIS lead —
    // the modal-box DOM outlives Modal.close, and a stale previous modal here
    // would overwrite this lead's name/quote/source with another lead's.
    const nameEl = document.getElementById('lead-name');
    if (!nameEl || nameEl.dataset.lead !== id) { toast('Reopen this lead to save', 'warning'); return; }
    const name = nameEl.value || '';
    const qv = parseFloat(document.getElementById('lead-quoted')?.value);
    const source = this._sourceValue(l.source);
    try {
      // Notes are saved per-entry via addNote — never send `notes` here, or a
      // blank value would wipe a pre-history lead's legacy free-text notes.
      // Status ships ONLY when a pill was tapped in this modal session — a save
      // must never re-send a possibly-stale in-memory status (that's what
      // silently moved leads into Worked).
      const lr = document.getElementById('lead-lost-reason');
      const st = this._pendingStatus;   // read before Modal.close clears it
      const quotedAmount = (Number.isFinite(qv) && qv > 0) ? qv : null;
      const lostReason = (st === 'lost' && lr) ? (lr.value.trim() || null) : undefined;
      await db.leads.update(id, { name, source, quotedAmount,
        ...(st ? { status: st } : {}),
        ...(lostReason !== undefined ? { lostReason } : {}) });
      // Persisted — mirror the change into both in-memory caches (list + board)
      // and repaint the board NOW. During the old await-refetch lag the moved
      // lead's row/card was still on screen, so tapping "the next one" opened
      // the previous lead's profile.
      const apply = x => { if (!x) return;
        x.name = name; x.source = source; x.quotedAmount = quotedAmount;
        if (st) { x.status = st; x.stageChangedAt = new Date().toISOString(); }
        if (lostReason !== undefined) x.lostReason = lostReason; };
      apply(l);
      Modal.close(); toast('Lead saved ✓');
      if (typeof Pipeline !== 'undefined' && Pipeline.isActive()) {
        apply((Pipeline._leads || []).find(x => x.id === id));
        Pipeline.renderLocal();
      }
      this.render();
    } catch(e) { toast(e.message || 'Could not save', 'error'); }
  },

  sendSms(id) {
    const input = document.getElementById('lead-sms');
    const body = input?.value.trim();
    if (!body) return;
    const l = this._leads.find(x => x.id === id);
    if (!l || !l.phone) { toast('No phone number on file', 'warning'); return; }
    // Manual send via the iPhone Messages deep link (no Twilio/A2P).
    // Texting does NOT move the stage — the owner advances leads explicitly
    // (a stray auto-move here was silently reshuffling the pipeline).
    _cpSms(l.phone, body);
    // Touch stamp: today's reached-out leads sink below the untouched ones.
    db.leads.note(id, 'Texted').catch(() => {});
  },

  async convert(id) {
    const l = this._leads.find(x => x.id === id);
    try {
      // Persist whatever's in the modal first so the typed name/notes carry onto
      // the new client record — convert() builds the customer from the saved lead.
      if (l) {
        this._captureModalEdits(l);
        await db.leads.update(id, { name: l.name || '', ...(this._pendingStatus ? { status: this._pendingStatus } : {}) });
      }
      const res = await db.leads.convert(id);
      if (!res.ok) throw new Error(res.error || 'Convert failed');
      Modal.close(); toast('Converted to client ✓'); this.render();
    } catch(e) { toast(e.message || 'Could not convert', 'error'); }
  },

  // One-tap booking: convert the lead to a client (idempotent server-side — an
  // already-converted lead just re-links) and drop straight into a pre-filled
  // New Appointment form, instead of convert → find in Clients → book by hand.
  async book(id) {
    const l = this._leads.find(x => x.id === id);
    try {
      // Persist modal edits first so the typed name carries onto the client record.
      if (l) {
        this._captureModalEdits(l);
        await db.leads.update(id, { name: l.name || '', quotedAmount: l.quotedAmount != null ? l.quotedAmount : null, ...(this._pendingStatus ? { status: this._pendingStatus } : {}) });
      }
      const res = await db.leads.convert(id);
      if (!res.ok) throw new Error(res.error || 'Could not create the client');
      Modal.close();
      App.nav('appointments');
      const extras = {};
      if (l && Number(l.quotedAmount) > 0) extras.price = Number(l.quotedAmount);
      if (l && l.vehicle) extras.vehicle = l.vehicle;
      setTimeout(() => Appointments.openFormPrefilled(res.customerId, (l && (l.name || l.phone)) || '', (l && l.phone) || '', Object.keys(extras).length ? extras : undefined), 150);
      toast('Client created ✓ — pick a date & time');
    } catch(e) { toast(e.message || 'Could not book', 'error'); }
  },

  // One-tap estimate: same shape as book() — convert the lead to a client
  // (idempotent), then drop into a pre-filled New Estimate with their contact
  // + vehicle already typed. Pairs with two-option estimates: inquiry → tap →
  // options on → Create & text.
  async estimate(id) {
    const l = this._leads.find(x => x.id === id);
    try {
      if (l) {
        this._captureModalEdits(l);
        await db.leads.update(id, { name: l.name || '', quotedAmount: l.quotedAmount != null ? l.quotedAmount : null, ...(this._pendingStatus ? { status: this._pendingStatus } : {}) });
      }
      const res = await db.leads.convert(id);
      if (!res.ok) throw new Error(res.error || 'Could not create the client');
      Modal.close();
      App.nav('quotes');
      setTimeout(() => Quotes.openFormPrefilled(res.customerId, (l && (l.name || l.phone)) || '', (l && l.phone) || '', (l && l.email) || '', l && l.vehicle), 150);
      toast('Client created ✓ — build their estimate');
    } catch(e) { toast(e.message || 'Could not start the estimate', 'error'); }
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

// Any modal close (button, overlay tap, another page's flow) releases the lead
// modal's ownership AND discards any unsaved pill choice — so a slow request
// finishing later can never resurrect the modal, and an abandoned status tap
// can never sneak into a later save.
(function () {
  const origClose = Modal.close.bind(Modal);
  Modal.close = function () { Leads._openId = null; Leads._pendingStatus = null; origClose(); };
})();

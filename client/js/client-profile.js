// ── Global Client Profile Overlay ────────────────────────────────────────────
const ClientProfile = {
  async open(id) {
    const overlay = document.getElementById('cp-overlay');
    const body    = document.getElementById('cp-body');
    const title   = document.getElementById('cp-header-name');
    if (!overlay) return;
    // Show overlay immediately with loading state
    body.innerHTML = '<div class="empty-state" style="padding:60px 20px;"><div class="loading-dots" style="justify-content:center;margin:0 auto;"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div></div>';
    title.textContent = 'Loading…';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    try {
      const [data, messages] = await Promise.all([
        db.customers.get(id),
        db.conversations.forCustomer(id).catch(() => []),
      ]);
      const c = data.customer;
      title.textContent = c.name;
      body.innerHTML = _buildProfileHtml(data, messages, 'ClientProfile.close()');
      body.scrollTop = 0;
    } catch(e) {
      body.innerHTML = '<div class="empty-state">Could not load client profile.</div>';
    }
  },

  close() {
    const overlay = document.getElementById('cp-overlay');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  },

  enrollPrompt(custId) {
    const plans = Shop.membershipPlans || [];
    if (!plans.length) { toast('Add a membership plan in Settings first', 'warning'); return; }
    const stripeOn = !!(Shop.settings && Shop.settings.stripe && Shop.settings.stripe.onboardingComplete);
    Modal.show(`
      <div class="modal-title">⭐ Enroll in a plan</div>
      ${plans.map(p=>`<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;">
        <div><div style="font-size:14px;font-weight:700;">${esc(p.name)}</div><div style="font-size:12px;color:var(--muted);">${fmtMoney(p.price)}/${p.interval==='year'?'yr':'mo'}${p.perks?' · '+esc(p.perks):''}</div></div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          ${stripeOn?`<button class="btn btn-sm btn-primary" style="flex:1;" onclick="ClientProfile.enrollStripe('${custId}','${p.id}')">💳 Card subscription</button>`:''}
          <button class="btn btn-sm" style="flex:1;" onclick="ClientProfile.enrollManual('${custId}','${p.id}')">Mark as member</button>
        </div>
      </div>`).join('')}
      <div class="modal-actions"><button class="btn btn-full" onclick="Modal.close()">Cancel</button></div>`);
  },
  async enrollManual(custId, planId) {
    try { await db.customers.enroll(custId, planId); Modal.close(); toast('Enrolled ✓'); this.open(custId); }
    catch(e) { toast('Could not enroll', 'error'); }
  },
  async enrollStripe(custId, planId) {
    try {
      const r = await db.customers.membershipCheckout(custId, planId);
      if (r && r.ok && r.url) { window.open(r.url, '_blank'); Modal.close(); toast('Subscription checkout opened'); }
      else { toast((r && r.error) || 'Could not start subscription', 'error'); }
    } catch(e) { toast(e.message || 'Could not start subscription', 'error'); }
  },
  async cancelMembership(custId) {
    if (!confirm('Cancel this membership?')) return;
    try { await db.customers.cancelMembership(custId); toast('Membership canceled'); this.open(custId); }
    catch(e) { toast('Could not cancel', 'error'); }
  },
};

// ── Shared profile HTML builder ───────────────────────────────────────────────
function _buildProfileHtml(data, messages, backFn) {
  const c = data.customer;
  const doneAppts    = (data.appointments||[]).filter(a=>a.status==='done').sort((a,b)=>b.date.localeCompare(a.date));
  const nextAppt     = (data.appointments||[]).filter(a=>a.status==='confirmed'&&a.date>=today()).sort((a,b)=>a.date.localeCompare(b.date))[0];
  const daysSinceLast  = data.daysSinceLast ?? null;
  const rebookInterval = data.rebookInterval || 21;
  const nudgeDue       = daysSinceLast !== null && daysSinceLast >= rebookInterval;
  const warnAt   = Math.round(rebookInterval * 0.67);
  const dslColor = daysSinceLast === null ? 'var(--text)' : daysSinceLast >= rebookInterval ? '#dc2626' : daysSinceLast >= warnAt ? '#d97706' : 'var(--text)';
  const dslBg    = daysSinceLast === null ? 'var(--surface)' : daysSinceLast >= rebookInterval ? '#fff5f5' : daysSinceLast >= warnAt ? '#fffbeb' : 'var(--surface)';
  const dslBorder= daysSinceLast === null ? 'var(--border)'  : daysSinceLast >= rebookInterval ? '#fecaca' : daysSinceLast >= warnAt ? '#fde68a' : 'var(--border)';
  const dslLabel = daysSinceLast === null ? '—' : daysSinceLast === 0 ? 'Today' : daysSinceLast === 1 ? '1 day' : daysSinceLast + ' days';
  let html = '';

  // ── Top actions ──
  html += `<div style="display:flex;gap:8px;margin-bottom:20px;">
    <button onclick="Clients.bookAppointment('${c.id}')" style="flex:1;background:var(--green);color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;">📅 Book Appointment</button>
    ${c.phone?`<a href="sms:${c.phone}" style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;color:var(--text);text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;gap:6px;">💬 Message</a>`:''}
    <button onclick="${backFn};Clients.openForm('${c.id}')" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;color:var(--text);">Edit</button>
  </div>`;

  // ── Stats grid ──
  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">VISITS</div><div style="font-size:24px;font-weight:800;">${data.totalVisits}</div></div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">SPENT</div><div style="font-size:20px;font-weight:800;color:var(--green);">${fmtMoney(data.totalRevenue)}</div></div>
    <div style="background:${dslBg};border:1px solid ${dslBorder};border-radius:10px;padding:12px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">LAST VISIT</div><div style="font-size:20px;font-weight:800;color:${dslColor};">${dslLabel}</div></div>
    <div style="background:${data.rewardReady?'var(--green-lt)':'var(--surface)'};border:1px solid ${data.rewardReady?'#b3dfbf':'var(--border)'};border-radius:10px;padding:12px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">LOYALTY</div><div style="font-size:20px;font-weight:800;color:${data.rewardReady?'var(--green)':'var(--text)'};">${data.loyaltyPoints||0}/${data.visitsForReward}</div></div>
  </div>`;

  // ── Contact info ──
  html += `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;">`;
  if (c.phone) html += `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:.5px solid var(--border);"><span style="color:var(--muted);">Phone</span><a href="tel:${c.phone}" style="color:var(--text);font-weight:600;text-decoration:none;">${c.phone}</a></div>`;
  if (c.email) html += `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:.5px solid var(--border);"><span style="color:var(--muted);">Email</span><span style="color:var(--text);font-weight:600;">${c.email}</span></div>`;
  html += `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;"><span style="color:var(--muted);">Client since</span><span style="color:var(--text);font-weight:600;">${fmtDateShort(c.createdAt)||'—'}</span></div>`;
  html += `</div>`;

  // ── Membership ──
  const m = c.membership;
  const plans = Shop.membershipPlans || [];
  if (m && (m.status === 'active' || m.status === 'past_due')) {
    html += `<div style="background:linear-gradient(135deg,rgba(124,58,237,.07),rgba(124,58,237,.02));border:1px solid #ddd6fe;border-radius:12px;padding:12px 14px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div><div style="font-size:13px;font-weight:700;color:#6d28d9;">⭐ ${esc(m.planName)}</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">${fmtMoney(m.price)}/${m.interval==='year'?'yr':'mo'} · ${m.source==='stripe'?'Auto-billing':'Manual'}${m.status==='past_due'?' · <span style="color:#dc2626;">⚠ past due</span>':''}</div></div>
      ${canWrite()?`<button onclick="ClientProfile.cancelMembership('${c.id}')" style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:5px 10px;font-size:11px;font-weight:600;color:var(--muted);cursor:pointer;flex-shrink:0;">Cancel</button>`:''}
    </div>`;
  } else if (plans.length && canWrite()) {
    html += `<div style="border:1px dashed var(--border);border-radius:12px;padding:12px 14px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div style="font-size:13px;color:var(--muted);">Not a member</div>
      <button onclick="ClientProfile.enrollPrompt('${c.id}')" style="background:#7c3aed;color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0;">⭐ Enroll in plan</button>
    </div>`;
  }

  // ── Fleet account ──
  if (c.isFleet) {
    html += `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 12px;font-size:12px;color:#1d4ed8;margin-bottom:12px;display:flex;align-items:center;gap:6px;">🚚 <strong>Fleet account</strong>${c.companyName?' · '+esc(c.companyName):''}</div>`;
  }

  // ── Vehicles (detail shops) ──
  if (c.vehicles && c.vehicles.length) {
    html += `<div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;">Vehicles</div>`;
    html += `<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px;">`;
    c.vehicles.forEach((v,i) => {
      const title = [v.year,v.make,v.model].filter(Boolean).map(esc).join(' ') || 'Vehicle';
      html += `<div style="${i>0?'border-top:1px solid var(--border);':''}display:flex;align-items:center;gap:10px;padding:10px 14px;">
        <div style="font-size:18px;">🚗</div>
        <div style="flex:1;"><div style="font-size:13px;font-weight:600;">${title}</div>${v.color?`<div style="font-size:11px;color:var(--muted);">${esc(v.color)}</div>`:''}</div>
      </div>`;
    });
    html += `</div>`;
  }

  // ── Flags ──
  if ((c.noShows||0) > 0) html += `<div style="background:#fff5f5;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;color:#dc2626;margin-bottom:12px;">⚠️ ${c.noShows} no-show${c.noShows>1?'s':''} on record</div>`;
  if (data.rewardReady)   html += `<div style="background:var(--green-lt);border:1px solid #b3dfbf;border-radius:8px;padding:8px 12px;font-size:12px;color:var(--green);margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">🎉 Loyalty reward ready! <button onclick="Clients.redeemReward('${c.id}','${c.name}')" style="background:var(--green);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">Redeem</button></div>`;
  if (c.notes)            html += `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--muted);margin-bottom:12px;">📝 ${c.notes}</div>`;

  // ── Automations ──
  html += `<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px;">
    <div style="padding:10px 14px;background:var(--surface);border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;">Automations</div>
    <div style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);">
      <div><div style="font-size:13px;font-weight:600;">⏰ 24-Hour Reminder</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">${nextAppt ? 'Scheduled '+fmtDateFull(nextAppt.date)+' at '+nextAppt.time : 'No upcoming appointment'}</div></div>
      <span style="font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;background:${nextAppt?'var(--green-lt)':'var(--surface)'};color:${nextAppt?'var(--green)':'var(--faint)'};">${nextAppt?'Active':'Inactive'}</span>
    </div>
    <div style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;">
      <div><div style="font-size:13px;font-weight:600;">🔁 ${rebookInterval}-Day Rebook Nudge</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">${nudgeDue ? 'Due — '+daysSinceLast+' days since last visit' : daysSinceLast !== null ? 'Last visit '+daysSinceLast+'d ago · nudge at '+rebookInterval+'d' : 'No visits yet'}</div></div>
      <span style="font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;background:${nudgeDue?'#fff5f5':'var(--surface)'};color:${nudgeDue?'#dc2626':'var(--faint)'};">${nudgeDue?'Due':'Watching'}</span>
    </div>
  </div>`;

  // ── Spend trends ──
  if (doneAppts.length >= 2) {
    const avgTicket = data.totalRevenue / data.totalVisits;
    const dates = doneAppts.map(a=>new Date(a.date+'T12:00:00')).sort((a,b)=>a-b);
    let avgFreq = null;
    if (dates.length >= 2) {
      const gaps = []; for (let i=1;i<dates.length;i++) gaps.push((dates[i]-dates[i-1])/86400000);
      avgFreq = Math.round(gaps.reduce((s,g)=>s+g,0)/gaps.length);
    }
    const recent3 = doneAppts.slice(0,3).reduce((s,a)=>s+Number(a.price||0),0)/Math.min(3,doneAppts.length);
    const prev3   = doneAppts.slice(3,6).length ? doneAppts.slice(3,6).reduce((s,a)=>s+Number(a.price||0),0)/doneAppts.slice(3,6).length : null;
    const trendIcon = prev3===null ? '➡️' : recent3 > prev3+1 ? '📈' : recent3 < prev3-1 ? '📉' : '➡️';
    const trendTxt  = prev3===null ? 'Consistent' : recent3 > prev3+1 ? 'Spending more' : recent3 < prev3-1 ? 'Spending less' : 'Consistent';
    html += `<div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;">Spend Trends</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:20px;">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">AVG TICKET</div><div style="font-size:15px;font-weight:800;color:var(--green);">${fmtMoney(avgTicket)}</div></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">FREQUENCY</div><div style="font-size:15px;font-weight:800;">${avgFreq?'every '+avgFreq+'d':'—'}</div></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:10px;color:var(--faint);margin-bottom:3px;">TREND</div><div style="font-size:15px;font-weight:800;">${trendIcon}</div><div style="font-size:9px;color:var(--muted);">${trendTxt}</div></div>
    </div>`;
  }

  // ── Visit history ──
  if (doneAppts.length) {
    html += `<div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;">Visit History</div>`;
    html += `<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px;">`;
    doneAppts.slice(0,10).forEach((a,i) => {
      const hasCutNotes = !!a.cutNotes;
      html += `<div style="${i>0?'border-top:1px solid var(--border)':''}">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;${hasCutNotes?'cursor:pointer;':''}" ${hasCutNotes?`onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'"`:''}>
          <div><div style="font-size:13px;font-weight:600;">${a.service||'—'}</div><div style="font-size:11px;color:var(--muted);">${fmtDateShort(a.date)}${a.barberName?' · '+a.barberName:''}${hasCutNotes?' · <span style="color:var(--green);">notes</span>':''}</div></div>
          <div style="text-align:right;"><div style="font-size:13px;font-weight:700;color:var(--green);">${fmtMoney(a.price)}</div>${a.tip>0?`<div style="font-size:10px;color:var(--muted);">+${fmtMoney(a.tip)} tip</div>`:''}</div>
        </div>
        ${hasCutNotes?`<div style="display:none;padding:0 14px 10px;font-size:12px;color:var(--muted);font-style:italic;background:var(--off);">${a.cutNotes}</div>`:''}
      </div>`;
    });
    html += `</div>`;
  }

  return html;
}

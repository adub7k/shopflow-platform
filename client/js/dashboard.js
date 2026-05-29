const Dashboard = {
  async render() {
    const el = document.getElementById('page-dashboard');
    el.innerHTML = '<div class="spinner-page"><div class="spinner"></div></div>';
    try {
      const [data, queue] = await Promise.all([db.dashboard.get(), db.queue.all()]);
      const now = new Date();
      const greeting = now.getHours()<12?'morning':now.getHours()<17?'afternoon':'evening';
      const html = [];

      html.push('<div style="padding-bottom:6px;"><div style="font-size:19px;font-weight:700;">Good '+greeting+' &#9986;</div>');
      html.push('<div style="font-size:12px;color:var(--muted);">'+now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})+'</div></div>');

      // Alert banners
      if (data.overdueTasks>0) html.push('<div class="alert-banner alert-red" onclick="App.nav(\'tasks\')"><div class="alert-banner-icon">&#9888;&#65039;</div><div><div class="alert-banner-text">'+data.overdueTasks+' overdue task'+(data.overdueTasks!==1?'s':'')+'</div><div class="alert-banner-sub">Needs attention</div></div></div>');
      if (data.newLeads>0)     html.push('<div class="alert-banner alert-green" onclick="App.nav(\'leads\')"><div class="alert-banner-icon">&#128276;</div><div><div class="alert-banner-text">'+data.newLeads+' new lead'+(data.newLeads!==1?'s':'')+'</div><div class="alert-banner-sub">Follow up now</div></div></div>');
      if ((data.loyaltyAlerts||[]).length>0) html.push('<div class="alert-banner alert-orange"><div class="alert-banner-icon">&#9986;</div><div><div class="alert-banner-text">'+(data.loyaltyAlerts.length)+' free cut reward'+(data.loyaltyAlerts.length!==1?'s':'')+' ready</div><div class="alert-banner-sub">Loyalty milestone reached</div></div></div>');

      // Today stats
      html.push('<div class="section-header">Today</div>');
      html.push('<div class="metric-grid" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:14px;">');
      html.push('<div class="metric-card"><div class="metric-label">Revenue</div><div class="metric-value">'+fmtMoney(data.todayRevenue)+'</div><div class="metric-delta">'+data.todayCuts+' cuts done</div></div>');
      html.push('<div class="metric-card"><div class="metric-label">Waiting</div><div class="metric-value" style="color:'+(data.waiting>3?'var(--red)':'var(--text)')+'">'+data.waiting+'</div><div class="metric-delta">In queue</div></div>');
      html.push('<div class="metric-card"><div class="metric-label">Appointments</div><div class="metric-value">'+data.todayAppointments+'</div><div class="metric-delta">Booked today</div></div>');
      html.push('</div>');

      // Barber chairs — side by side
      html.push('<div class="section-header" style="display:flex;justify-content:space-between;"><span>Barber Status</span><span style="font-size:12px;font-weight:400;color:var(--blue);cursor:pointer;" onclick="App.nav(\'queue\')">Full queue</span></div>');
      html.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">');
      (data.barberStats||[]).forEach(function(b) {
        const inChair = b.inChair;
        const nextAppt = b.nextAppt;
        html.push('<div class="card" style="border-top:3px solid '+b.color+';">');
        html.push('<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">');
        html.push('<div style="width:10px;height:10px;border-radius:50%;background:'+(inChair?'#1D9E75':'#ccc')+';flex-shrink:0;"></div>');
        html.push('<div style="font-size:15px;font-weight:700;">'+b.name+'</div>');
        html.push('<div style="font-size:11px;color:var(--muted);margin-left:auto;">Chair '+b.chair+'</div>');
        html.push('</div>');
        if (inChair) {
          html.push('<div style="background:#eaf3de;border-radius:8px;padding:8px 10px;margin-bottom:8px;">');
          html.push('<div style="font-size:11px;font-weight:700;color:#27500a;margin-bottom:2px;">&#128488; In Chair Now</div>');
          html.push('<div style="font-size:13px;font-weight:600;">'+inChair.customerName+'</div>');
          html.push('<div style="font-size:11px;color:var(--muted);">'+inChair.service+' &middot; '+waitTime(inChair.startedAt)+'</div>');
          html.push('</div>');
        } else {
          html.push('<div style="background:var(--surface2);border-radius:8px;padding:8px 10px;margin-bottom:8px;text-align:center;color:var(--faint);font-size:12px;">Chair available</div>');
        }
        html.push('<div style="font-size:12px;color:var(--muted);">Today: <strong>'+b.todayCuts+' cuts</strong> &middot; '+fmtMoney(b.todayRevenue)+'</div>');
        if (nextAppt) html.push('<div style="font-size:11px;color:var(--blue);margin-top:4px;">Next: '+nextAppt.customerName+' at '+nextAppt.time+'</div>');
        html.push('</div>');
      });
      html.push('</div>');

      // Live queue
      const liveQueue = (data.queue||[]).filter(function(q){ return q.status!=='completed'; });
      if (liveQueue.length) {
        html.push('<div class="section-header" style="display:flex;justify-content:space-between;"><span>Live Queue ('+liveQueue.length+')</span><button class="btn btn-sm btn-primary" onclick="Queue.openCheckIn()">+ Check In</button></div>');
        html.push('<div class="card" style="padding:0 16px;">');
        liveQueue.forEach(function(q,i) {
          html.push('<div class="list-row" onclick="App.nav(\'queue\')">');
          html.push('<div style="width:24px;height:24px;border-radius:50%;background:'+(q.barberId?q.barberColor:'#ddd')+';display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0;">'+(i+1)+'</div>');
          html.push('<div class="list-main"><div class="list-name">'+q.customerName+'</div><div class="list-sub">'+q.service+(q.barberName?' &middot; '+q.barberName:'')+'</div></div>');
          html.push('<div class="list-right">'+statusBadge(q.status)+'<div style="font-size:11px;color:var(--faint);margin-top:2px;">'+waitTime(q.checkedInAt)+'</div></div>');
          html.push('</div>');
        });
        html.push('</div>');
      } else {
        html.push('<div class="section-header" style="display:flex;justify-content:space-between;"><span>Queue</span><button class="btn btn-sm btn-primary" onclick="Queue.openCheckIn()">+ Check In</button></div>');
        html.push('<div class="card"><div style="text-align:center;padding:20px;color:var(--faint);"><div style="font-size:28px;margin-bottom:6px;">&#9986;</div><div style="font-size:13px;">Queue is empty</div><button class="btn btn-sm btn-primary" style="margin-top:10px;" onclick="Queue.openCheckIn()">Check someone in</button></div></div>');
      }

      // Month stats
      html.push('<div class="section-header">This Month</div>');
      html.push('<div class="metric-grid" style="margin-bottom:14px;">');
      html.push('<div class="metric-card"><div class="metric-label">Revenue</div><div class="metric-value">'+fmtMoney(data.monthRevenue)+'</div><div class="metric-delta">'+data.monthCuts+' cuts</div></div>');
      html.push('<div class="metric-card"><div class="metric-label">Avg Ticket</div><div class="metric-value">'+fmtMoney(data.monthCuts?Math.round(data.monthRevenue/data.monthCuts):0)+'</div><div class="metric-delta">Per service</div></div>');
      html.push('</div>');

      el.innerHTML = html.join('');
    } catch(e) {
      el.innerHTML = '<div class="error-banner">&#9888; Could not load dashboard</div>';
    }
  }
};

// ── Revenue ───────────────────────────────────────────────────────────────────
const Revenue = {
  async render() {
    const el=document.getElementById('page-revenue'); if(!el)return;
    try{
      const data=await db.revenue.get();
      const html=[];
      html.push('<div class="metric-grid" style="grid-template-columns:1fr 1fr;">');
      html.push(`<div class="metric-card"><div class="metric-label">This Month</div><div class="metric-value green">${fmtMoney(data.monthRevenue)}</div><div class="metric-sub">${data.monthJobs} appointments</div></div>`);
      html.push(`<div class="metric-card"><div class="metric-label">Avg Ticket</div><div class="metric-value">${fmtMoney(data.avgTicket)}</div><div class="metric-sub">This month</div></div>`);
      html.push(`<div class="metric-card"><div class="metric-label">All Time</div><div class="metric-value">${fmtMoney(data.totalRevenue)}</div></div>`);
      html.push('</div>');

      if(data.byBarber?.length){
        html.push('<div class="section-header">By Barber</div><div class="card">');
        const maxRev=Math.max(...data.byBarber.map(b=>b.revenue),1);
        data.byBarber.forEach(b=>{
          const pct=Math.round((b.revenue/maxRev)*100);
          html.push(`<div style="margin-bottom:14px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;"><span style="font-weight:600;">✂ ${b.name}</span><span>${fmtMoney(b.revenue)} · ${b.count} cuts</span></div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${b.color||'var(--green)'};"></div></div></div>`);
        });
        html.push('</div>');
      }

      if(data.byMonth?.length){
        html.push('<div class="section-header">Monthly Trend</div><div class="card">');
        const maxM=Math.max(...data.byMonth.map(m=>m.revenue),1);
        data.byMonth.slice(-6).forEach(m=>{
          const pct=Math.round((m.revenue/maxM)*100);
          const label=new Date(m.month+'-15').toLocaleDateString('en-US',{month:'short'});
          html.push(`<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span style="color:var(--muted);">${label}</span><span style="font-weight:600;">${fmtMoney(m.revenue)}</span></div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--green);"></div></div></div>`);
        });
        html.push('</div>');
      }
      el.innerHTML=html.join('');
    }catch(e){el.innerHTML='<div class="card"><p style="color:var(--muted)">Could not load revenue</p></div>';}
  }
};

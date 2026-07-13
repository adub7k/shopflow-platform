// ── Revenue / Profit ──────────────────────────────────────────────────────────
const Revenue = {
  _categories: ['Rent','Supplies','Equipment','Marketing','Software','Insurance','Payroll','Fuel','Utilities','Other'],

  async render() {
    const el = document.getElementById('page-revenue'); if (!el) return;
    try {
      const [data, expenses] = await Promise.all([ db.revenue.get(), db.expenses.all().catch(()=>[]) ]);
      if (data.expenseCategories?.length) this._categories = data.expenseCategories;
      const html = [];

      // ── Headline cards ──────────────────────────────────────────────────────
      const netColor = data.monthNetProfit >= 0 ? 'green' : 'red';
      html.push('<div class="metric-grid" style="grid-template-columns:1fr 1fr;">');
      html.push(`<div class="metric-card"><div class="metric-label">Revenue This Month</div><div class="metric-value green">${fmtMoney(data.monthRevenue)}</div><div class="metric-sub">${data.monthJobs} appointments</div></div>`);
      html.push(`<div class="metric-card"><div class="metric-label">Net Profit This Month</div><div class="metric-value ${netColor}">${fmtMoney(data.monthNetProfit)}</div><div class="metric-sub">${data.monthNetMarginPct}% margin · after ${fmtMoney(data.monthOpEx)} expenses</div></div>`);
      html.push(`<div class="metric-card"><div class="metric-label">Avg Ticket</div><div class="metric-value">${fmtMoney(data.avgTicket)}</div><div class="metric-sub">This month</div></div>`);
      html.push(`<div class="metric-card"><div class="metric-label">All Time</div><div class="metric-value">${fmtMoney(data.totalRevenue)}</div><div class="metric-sub">${fmtMoney(data.totalNetProfit)} net profit</div></div>`);
      html.push('</div>');

      // ── Profit & Loss waterfall (this month) ────────────────────────────────
      const line = (label, val, opts={}) => {
        const neg = opts.neg;
        // Explicit-subtraction rows (Materials, Expenses) always render as −$X;
        // computed rows (Gross/Net) show their real sign so a loss reads as −$X.
        const amt = neg ? `−${fmtMoney(Math.abs(val))}` : (val < 0 ? `−${fmtMoney(Math.abs(val))}` : fmtMoney(val));
        const strong = opts.strong ? 'font-weight:800;' : 'font-weight:500;';
        const color = opts.color ? `color:var(--${opts.color});` : '';
        const border = opts.rule ? 'border-top:1px solid var(--border);margin-top:2px;padding-top:9px;' : '';
        const pct = opts.pct != null ? `<span style="font-size:11px;color:var(--muted);font-weight:600;margin-left:6px;">${opts.pct}% margin</span>` : '';
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;${border}">
          <span style="font-size:13px;${strong}${color}">${esc(label)}${pct}</span>
          <span style="font-size:14px;${strong}${color}">${amt}</span></div>`;
      };
      html.push('<div class="section-header">Profit &amp; Loss · This Month</div><div class="card" style="padding:6px 16px;">');
      html.push(line('Revenue', data.monthRevenue));
      html.push(line('Materials (cost of goods)', data.monthCost, { neg:true, color:'muted' }));
      html.push(line('Gross Profit', data.monthGrossProfit, { strong:true, rule:true, pct:data.monthGrossMarginPct }));
      html.push(line('Operating Expenses', data.monthOpEx, { neg:true, color:'muted' }));
      html.push(line('Net Profit', data.monthNetProfit, { strong:true, rule:true, color:netColor, pct:data.monthNetMarginPct }));
      html.push('</div>');

      // ── Operating expenses (manage) ─────────────────────────────────────────
      html.push(`<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Operating Expenses</span>
        <button onclick="Revenue.addExpense()" style="padding:5px 12px;background:var(--green);color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;">+ Add</button>
      </div><div class="card">`);
      if (!expenses.length) {
        html.push(`<div style="font-size:12px;color:var(--muted);padding:6px 0;">No expenses yet. Add rent, supplies, software, insurance, fuel, payroll — anything that comes out of profit. Mark fixed monthly bills as recurring.</div>`);
      } else {
        expenses.forEach(e => {
          const recur = e.recurring === 'monthly' ? `<span style="font-size:10px;font-weight:700;color:var(--green);background:var(--green-lt);padding:1px 6px;border-radius:5px;margin-left:6px;">monthly</span>` : '';
          const d = new Date((e.date||'')+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
          html.push(`<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:.5px solid var(--border);cursor:pointer;" onclick="Revenue.addExpense('${e.id}')">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;">${esc(e.category)}${recur}</div>
              <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(e.description||'')}${e.description?' · ':''}${d}</div>
            </div>
            <div style="font-weight:700;font-size:13px;white-space:nowrap;">${fmtMoney(e.amount)}${e.recurring==='monthly'?'<span style="font-size:11px;color:var(--muted);font-weight:500;">/mo</span>':''}</div>
            <button onclick="event.stopPropagation();Revenue.deleteExpense('${e.id}')" style="background:none;border:none;color:var(--red);font-size:18px;line-height:1;cursor:pointer;padding:0 4px;">×</button>
          </div>`);
        });
      }
      html.push('</div>');

      // ── Expenses by category (this month) ───────────────────────────────────
      if (data.byCategory?.length) {
        html.push('<div class="section-header">Expenses by Category · This Month</div><div class="card">');
        const maxC = Math.max(...data.byCategory.map(c=>c.amount), 1);
        data.byCategory.forEach(c => {
          const pct = Math.round((c.amount/maxC)*100);
          html.push(`<div style="margin-bottom:12px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;"><span style="font-weight:600;">${esc(c.category)}</span><span>${fmtMoney(c.amount)}</span></div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:#d97706;"></div></div></div>`);
        });
        html.push('</div>');
      }

      // ── Net profit trend (6 mo) ─────────────────────────────────────────────
      if (data.netByMonth?.length) {
        html.push('<div class="section-header">Net Profit Trend</div><div class="card">');
        const recent = data.netByMonth.slice(-6);
        const maxN = Math.max(...recent.map(m=>Math.abs(m.net)), 1);
        recent.forEach(m => {
          const pct = Math.round((Math.abs(m.net)/maxN)*100);
          const label = new Date(m.month+'-15').toLocaleDateString('en-US',{month:'short'});
          const pos = m.net >= 0;
          html.push(`<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span style="color:var(--muted);">${label}</span><span style="font-weight:600;color:var(--${pos?'green':'red'});">${fmtMoney(m.net)}</span></div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--${pos?'green':'red'});"></div></div></div>`);
        });
        html.push('</div>');
      }

      // ── Profit by service (all time) ────────────────────────────────────────
      const svc = (data.byService||[]).filter(s=>s.revenue>0);
      if (svc.length) {
        html.push('<div class="section-header">Profit by Service · All Time</div><div class="card">');
        const maxS = Math.max(...svc.map(s=>s.margin), 1);
        svc.slice(0,8).forEach(s => {
          const pct = Math.round((Math.max(s.margin,0)/maxS)*100);
          const mpct = s.revenue ? Math.round(s.margin/s.revenue*100) : 0;
          html.push(`<div style="margin-bottom:14px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;"><span style="font-weight:600;">${esc(s.service)} <span style="font-size:11px;color:var(--muted);font-weight:500;">· ${s.count} jobs</span></span><span>${fmtMoney(s.margin)} <span style="font-size:11px;color:var(--muted);">${mpct}%</span></span></div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--green);"></div></div><div style="font-size:11px;color:var(--muted);margin-top:3px;">${fmtMoney(s.revenue)} revenue − ${fmtMoney(s.cost)} cost</div></div>`);
        });
        html.push('</div>');
      }

      // ── Sales tax set-aside ─────────────────────────────────────────────────
      if (data.monthTaxCollected || data.totalTaxCollected) {
        html.push(`<div class="section-header">Sales Tax</div><div class="card" style="display:flex;justify-content:space-between;align-items:center;">
          <div><div style="font-size:13px;font-weight:700;">Collected</div><div style="font-size:12px;color:var(--muted);">Set this aside — it's owed, not income.</div></div>
          <div style="text-align:right;"><div style="font-weight:800;">${fmtMoney(data.monthTaxCollected)}</div><div style="font-size:11px;color:var(--muted);">${fmtMoney(data.totalTaxCollected)} all time</div></div>
        </div>`);
      }

      // ── Deposits collected ──────────────────────────────────────────────────
      // Shown separately on purpose: deposits are prepayments applied at checkout,
      // so they're tracked here without inflating the service-based Revenue/Profit.
      if (data.monthDeposits || data.totalDeposits) {
        html.push(`<div class="section-header">Deposits Collected</div><div class="card" style="display:flex;justify-content:space-between;align-items:center;">
          <div><div style="font-size:13px;font-weight:700;">Prepaid by clients</div><div style="font-size:12px;color:var(--muted);">Tracked separately — applied to the balance at checkout.</div></div>
          <div style="text-align:right;"><div style="font-weight:800;color:var(--green);">${fmtMoney(data.monthDeposits)}</div><div style="font-size:11px;color:var(--muted);">${fmtMoney(data.totalDeposits)} all time</div></div>
        </div>`);
      }

      // ── By staff ────────────────────────────────────────────────────────────
      if (data.byBarber?.length > 1) {
        html.push('<div class="section-header">Revenue by '+esc(V('staffPlural','Barber'))+'</div><div class="card">');
        const maxRev = Math.max(...data.byBarber.map(b=>b.revenue), 1);
        data.byBarber.forEach(b => {
          const pct = Math.round((b.revenue/maxRev)*100);
          html.push(`<div style="margin-bottom:14px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;"><span style="font-weight:600;">${esc(b.name)}</span><span>${fmtMoney(b.revenue)} · ${b.count} jobs</span></div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${b.color||'var(--green)'};"></div></div></div>`);
        });
        html.push('</div>');
      }

      el.innerHTML = html.join('');
    } catch (e) {
      el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load revenue</p></div>';
    }
  },

  // Add or edit an expense.
  async addExpense(id) {
    let exp = null;
    if (id) { try { exp = (await db.expenses.all()).find(e => e.id === id) || null; } catch(e){} }
    const todayStr = new Date().toISOString().slice(0,10);
    const opts = this._categories.map(c => `<option value="${esc(c)}" ${exp&&exp.category===c?'selected':''}>${esc(c)}</option>`).join('');
    Modal.show(`
      <div class="modal-title">${id?'Edit':'Add'} expense</div>
      <div class="form-group"><label class="form-label">Amount</label>
        <input class="form-input" id="exp-amount" type="number" min="0" step="0.01" inputmode="decimal" value="${exp?exp.amount:''}" placeholder="0.00"/></div>
      <div class="form-group"><label class="form-label">Category</label>
        <select class="form-input" id="exp-category">${opts}</select></div>
      <div class="form-group"><label class="form-label">Description <span style="color:var(--muted);font-weight:400;">(optional)</span></label>
        <input class="form-input" id="exp-desc" value="${exp?esc(exp.description||''):''}" placeholder="e.g. Monthly shop rent"/></div>
      <div class="form-group"><label class="form-label">Date</label>
        <input class="form-input" id="exp-date" type="date" value="${exp?exp.date:todayStr}"/></div>
      <div class="form-group"><label class="toggle-row" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
        <span><span class="form-label" style="display:block;">Repeats monthly</span><span style="font-size:12px;color:var(--muted);">For fixed bills like rent, insurance, software.</span></span>
        <input type="checkbox" id="exp-recurring" ${exp&&exp.recurring==='monthly'?'checked':''} style="width:20px;height:20px;flex-shrink:0;"/></label></div>
      <div class="modal-actions">
        <button class="btn btn-primary btn-full" onclick="Revenue.saveExpense('${id||''}')">Save</button>
      </div>
    `);
  },

  async saveExpense(id) {
    const amount = parseFloat(document.getElementById('exp-amount')?.value);
    if (!(amount > 0)) return toast('Enter an amount greater than 0', 'error');
    const body = {
      id: id || undefined,
      amount,
      category: document.getElementById('exp-category')?.value,
      description: document.getElementById('exp-desc')?.value || '',
      date: document.getElementById('exp-date')?.value,
      recurring: document.getElementById('exp-recurring')?.checked ? 'monthly' : 'none',
    };
    try {
      const res = await db.expenses.save(body);
      if (res.ok === false) throw new Error(res.error || 'Could not save');
      Modal.close(); toast('Expense saved ✓'); this.render();
    } catch(e) { toast(e.message || 'Could not save', 'error'); }
  },

  async deleteExpense(id) {
    if (!confirm('Delete this expense?')) return;
    try { await db.expenses.delete(id); toast('Expense deleted'); this.render(); }
    catch(e) { toast(e.message || 'Could not delete', 'error'); }
  },
};

// ── ShopFlow Starter App ──────────────────────────────────────────────────────
const App = {
  _page: 'dashboard',
  nav(page) {
    this._page = page;
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.nav-item,.bottom-nav-item').forEach(b=>b.classList.remove('active'));
    const el=document.getElementById('page-'+page); if(el)el.classList.add('active');
    document.querySelectorAll('[data-page="'+page+'"]').forEach(b=>b.classList.add('active'));
    const titles={dashboard:'Dashboard',appointments:'Appointments',clients:'Clients',revenue:'Revenue',settings:'Settings'};
    const tt=document.getElementById('topbar-title'); if(tt&&titles[page])tt.textContent=titles[page];
    this._render(page);
  },
  _render(page) {
    if(page==='dashboard')   Dashboard.render();
    if(page==='appointments')Appointments.render();
    if(page==='clients')     Clients.render();
    if(page==='revenue')     Revenue.render();
    if(page==='settings')    Settings.render();
  },
  refresh() { this._render(this._page); }
};

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // PIN check
    const authed = await Auth.init();
    if(!authed) {
      Auth.showLock();
      await new Promise(resolve => { const t=setInterval(()=>{if(Auth.isUnlocked()){clearInterval(t);resolve();}},200); });
    }

    // Load settings
    const s = await db.settings.get();
    const tt=document.getElementById('topbar-title'); if(tt)tt.textContent=s.shopName||'ShopFlow';
    const ts=document.getElementById('topbar-sub');   if(ts&&s.tagline)ts.textContent=s.tagline;

    // Boot dashboard
    await Dashboard.render();
    document.getElementById('loading')?.classList.add('hidden');
    document.getElementById('loading').style.display='none';

  } catch(e) {
    console.error('Boot error:', e);
    const l=document.getElementById('loading');
    if(l)l.innerHTML='<div style="text-align:center;padding:40px;"><div style="font-size:32px;margin-bottom:12px;">⚠️</div><div style="font-weight:700;margin-bottom:8px;">Cannot connect to server</div><div style="font-size:13px;color:#6b7280;margin-bottom:20px;">Make sure the server is running</div><button onclick="location.reload()" style="padding:10px 24px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Retry</button></div>';
  }
});

// Modal overlay close
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-overlay')?.addEventListener('click', e=>{
    if(e.target.id==='modal-overlay') Modal.close();
  });
});

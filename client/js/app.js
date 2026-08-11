// ── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar(){document.body.classList.toggle('sidebar-open');}
function closeSidebar(){document.body.classList.remove('sidebar-open');}

// ── Role-based page permissions ───────────────────────────────────────────────
// full = owner/full access · technician = appts + clients · viewonly = calendar only
const ROLE_PAGES = {
  full:       ['dashboard','messages','appointments','response','pipeline','leads','clients','quotes','revenue','tasks','reviews','automations','newsletter','settings'],
  technician: ['dashboard','messages','appointments','response','pipeline','leads','clients','quotes','tasks'],
  viewonly:   ['appointments'],
};
// Pages that only appear for a given industry. Injected after the role base set,
// so a barbershop never sees cleaning pages and vice-versa. (Owners + technicians
// only; view-only stays calendar-only.)
const INDUSTRY_PAGES = {
  cleaning: ['jobs','properties','crews','recurring'],
};
function allowedPages(){
  let pages = (ROLE_PAGES[Auth.getRole()] || ROLE_PAGES.full).slice();
  const extra = INDUSTRY_PAGES[Shop.industry];
  if (extra && Auth.getRole() !== 'viewonly') pages = pages.concat(extra.filter(p => !pages.includes(p)));
  // Estimates is a detail-shop feature — hide it for industries that don't use it.
  if (!Shop.supportsQuotes) pages = pages.filter(p => p !== 'quotes');
  return pages;
}
function canSee(page){ return allowedPages().includes(page); }
function canWrite(){ return Auth.getRole() !== 'viewonly'; } // view-only = read-only calendar
function canSeeClients(){ return canSee('clients'); }        // view-only can't open client profiles
function applyRoleNav(){
  const allow = allowedPages();
  document.querySelectorAll('.nav-item,.bottom-nav-item').forEach(el=>{
    const p = el.dataset.page;
    if (p && !allow.includes(p)) el.style.display = 'none';
  });
}

// ── ShopFlow Starter App ──────────────────────────────────────────────────────
const App = {
  _page: 'dashboard',
  nav(page) {
    // Block navigation to pages the current role can't access
    if (!canSee(page)) { page = allowedPages()[0]; }
    this._page = page;
    // Close message thread when navigating away
    if (page !== 'messages') Messages._currentThread = null;
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.nav-item,.bottom-nav-item').forEach(b=>b.classList.remove('active'));
    const el=document.getElementById('page-'+page); if(el)el.classList.add('active');
    document.querySelectorAll('[data-page="'+page+'"]').forEach(b=>b.classList.add('active'));
    const titles={dashboard:'Dashboard',messages:'Messages',appointments:'Appointments',jobs:'Jobs',properties:'Properties',crews:'Crews',recurring:'Recurring',response:'Response Center',pipeline:'Pipeline',leads:'Leads',clients:'Clients',quotes:'Estimates',revenue:'Revenue',tasks:'Tasks',reviews:'Reviews',automations:'Automations',settings:'Settings'};
    const tt=document.getElementById('topbar-title'); if(tt&&titles[page])tt.textContent=titles[page];
    this._render(page);
  },
  _render(page) {
    if(page==='dashboard')   Dashboard.render();
    if(page==='messages')    Messages.render();
    if(page==='appointments')Appointments.render();
    if(page==='jobs')        Jobs.render();
    if(page==='properties')  Properties.render();
    if(page==='crews')       Crews.render();
    if(page==='recurring')   Recurring.render();
    if(page==='response')    Response.render();
    if(page==='pipeline')    Pipeline.render();
    if(page==='leads')       Leads.render();
    if(page==='clients')     Clients.render();
    if(page==='quotes')      Quotes.render();
    if(page==='revenue')     Revenue.render();
    if(page==='tasks')       Tasks.render();
    if(page==='reviews')     Reviews.render();
    if(page==='automations') Automations.render();
    if(page==='newsletter')  Newsletter.render();
    if(page==='settings')    Settings.render();
  },
  refresh() { this._render(this._page); }
};

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // PWA service worker: offline shell + web-push notifications (sw-push.js).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    // Load settings + industry profile (vocabulary, custom fields, statuses)
    const s = await db.settings.get();
    Shop.settings = s; Shop.industry = s.industry||'barbershop'; Shop.vocab = s.vocab||{}; Shop.fields = s.customFields||[]; Shop.statuses = s.statuses||[]; Shop.sizes = s.vehicleSizes||[]; Shop.addons = s.addons||[]; Shop.membershipPlans = s.membershipPlans||[]; Shop.serviceCategories = s.serviceCategories||[]; Shop.supportsQuotes = !!s.supportsQuotes; Shop.tax = s.tax||{enabled:false,rate:0,label:'Sales Tax'};
    const tt=document.getElementById('topbar-title'); if(tt)tt.textContent=s.shopName||'ShopFlow';
    const sn=document.getElementById('sidebar-shop-name'); if(sn&&s.shopName)sn.textContent=s.shopName;
    const ts=document.getElementById('topbar-sub');   if(ts&&s.tagline)ts.textContent=s.tagline;

    // Build the grouped, industry-aware sidebar from the nav registry, then apply
    // role-based hiding to the (static) bottom nav and land on the first allowed page.
    if (typeof NavRegistry !== 'undefined') NavRegistry.render();
    applyRoleNav();
    // Push-notification deep links: sw-push.js opens /response-center (website
    // leads), /pipeline (new-lead + missed-call pushes), or /leads (older cached
    // payloads). The server serves the app shell at all three, so land on the
    // matching page.
    const wantsResponse = location.pathname.startsWith('/response-center') && canSee('response');
    const wantsPipeline = location.pathname.startsWith('/pipeline') && canSee('pipeline');
    const wantsLeads = location.pathname.startsWith('/leads') && canSee('leads');
    await App.nav(
      wantsResponse ? 'response'
      : wantsPipeline ? 'pipeline'
      : wantsLeads ? 'leads'
      : (canSee('dashboard') ? 'dashboard' : allowedPages()[0])
    );

    // Load unread badge in background
    db.conversations.all().then(threads => Messages.updateBadge(threads)).catch(()=>{});

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

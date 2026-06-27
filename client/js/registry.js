// ── Navigation registry ──────────────────────────────────────────────────────
// Renders the sidebar from a grouped registry instead of a flat, hardcoded list.
// Groups give the nav a scalable structure (Overview / CRM / Operations / Money /
// Growth) and the Operations group absorbs industry-specific pages, so a new
// vertical adds items here (or via INDUSTRY_PAGES) without editing app.html.
//
// Output is byte-compatible with the old static markup — same .nav-section /
// .nav-item / .nav-item-icon / .nav-badge classes and the same data-page +
// App.nav() wiring — so the router, active-state syncing, and CSS are unchanged.
const NavRegistry = {
  // Label + icon for every page. Industry pages (jobs/properties/…) live here too.
  META: {
    dashboard:    { label: 'Dashboard',    icon: '🏠' },
    leads:        { label: 'Leads',        icon: '📞' },
    clients:      { label: 'Clients',      icon: '👤' },
    messages:     { label: 'Messages',     icon: '💬', badge: 'sidebar-msg-badge' },
    appointments: { label: 'Appointments', icon: '📅' },
    jobs:         { label: 'Jobs',         icon: '🧹' },
    properties:   { label: 'Properties',   icon: '🏠' },
    crews:        { label: 'Crews',        icon: '👥' },
    recurring:    { label: 'Recurring',    icon: '🔁' },
    tasks:        { label: 'Tasks',        icon: '✓' },
    quotes:       { label: 'Estimates',    icon: '📄' },
    revenue:      { label: 'Revenue',      icon: '📈' },
    reviews:      { label: 'Reviews',      icon: '⭐' },
    automations:  { label: 'Automations',  icon: '⚡' },
    settings:     { label: 'Settings',     icon: '⚙️' },
  },

  // Grouped layout. `industry: true` appends the active vertical's INDUSTRY_PAGES.
  GROUPS: [
    { title: 'Overview',   pages: ['dashboard'] },
    { title: 'CRM',        pages: ['leads', 'clients', 'tasks', 'messages'] },
    { title: 'Operations', pages: ['appointments'], industry: true },
    { title: 'Money',      pages: ['quotes', 'revenue'] },
    { title: 'Growth',     pages: ['reviews', 'automations'] },
    { title: '',           pages: ['settings'] },
  ],

  render() {
    const host = document.getElementById('sidebar-nav');
    if (!host) return;
    // Reuse the role + industry + supportsQuotes filtering already in app.js.
    const allow = (typeof allowedPages === 'function') ? allowedPages() : null;
    const ok = (p) => !allow || allow.includes(p);
    const industryPages = (typeof INDUSTRY_PAGES !== 'undefined' && INDUSTRY_PAGES[Shop.industry]) || [];

    const html = [];
    for (const g of this.GROUPS) {
      let pages = g.pages.slice();
      if (g.industry) pages = pages.concat(industryPages.filter(p => !pages.includes(p)));
      const visible = pages.filter(ok);
      if (!visible.length) continue;
      if (g.title) html.push('<div class="nav-section">' + g.title + '</div>');
      for (const p of visible) {
        const m = this.META[p] || { label: p, icon: '•' };
        const badge = m.badge ? '<span id="' + m.badge + '" class="nav-badge" style="display:none;"></span>' : '';
        html.push('<div class="nav-item" data-page="' + p + '" onclick="App.nav(\'' + p + '\');closeSidebar()">'
          + '<span class="nav-item-icon">' + m.icon + '</span>' + m.label + badge + '</div>');
      }
    }
    host.innerHTML = html.join('');
  },
};

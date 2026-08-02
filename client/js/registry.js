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
    response:     { label: 'Response Center', icon: '⏱️' },
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
    newsletter:   { label: 'Newsletter',   icon: '✉️' },
    settings:     { label: 'Settings',     icon: '⚙️' },
  },

  // v2 shell (app2.html sets window.SF_V2): line-icon set used in place of the
  // emoji above. Values are the inner content of a 24×24 stroke SVG. v1 output
  // is unchanged — render() only consults this map when SF_V2 is set.
  SVGS: {
    dashboard:    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    response:     '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    leads:        '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z"/>',
    clients:      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    messages:     '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    appointments: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="9.5" x2="21" y2="9.5"/>',
    jobs:         '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    properties:   '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    crews:        '<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    recurring:    '<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2-9.4L23 10"/>',
    tasks:        '<circle cx="12" cy="12" r="9"/><polyline points="16 9.5 10.7 15 8 12.2"/>',
    quotes:       '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    revenue:      '<line x1="3" y1="21" x2="21" y2="21"/><line x1="7" y1="21" x2="7" y2="13"/><line x1="12" y1="21" x2="12" y2="5"/><line x1="17" y1="21" x2="17" y2="9"/>',
    reviews:      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    automations:  '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>',
    newsletter:   '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    settings:     '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2.2"/>',
  },
  icon(p) {
    const m = this.META[p] || { icon: '•' };
    if (window.SF_V2 && this.SVGS[p]) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + this.SVGS[p] + '</svg>';
    }
    return m.icon;
  },

  // Grouped layout. `industry: true` appends the active vertical's INDUSTRY_PAGES.
  GROUPS: [
    { title: 'Overview',   pages: ['dashboard'] },
    { title: 'CRM',        pages: ['response', 'leads', 'clients', 'tasks', 'messages'] },
    { title: 'Operations', pages: ['appointments'], industry: true },
    { title: 'Money',      pages: ['quotes', 'revenue'] },
    { title: 'Growth',     pages: ['reviews', 'automations', 'newsletter'] },
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
          + '<span class="nav-item-icon">' + this.icon(p) + '</span>' + m.label + badge + '</div>');
      }
    }
    host.innerHTML = html.join('');
  },
};

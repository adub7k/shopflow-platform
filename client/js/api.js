// ── ShopFlow Multi-Tenant API ─────────────────────────────────────────────────
const Auth = {
  getToken: () => localStorage.getItem('sf_token'),
  getShopSlug: () => localStorage.getItem('sf_shopSlug'),
  getShopName: () => localStorage.getItem('sf_shopName'),
  getRole: () => localStorage.getItem('sf_role') || 'full',
  getName: () => localStorage.getItem('sf_name') || '',
  isLoggedIn: () => !!localStorage.getItem('sf_token'),
  logout: () => {
    ['sf_token','sf_shopId','sf_shopSlug','sf_shopName','sf_role','sf_name'].forEach(k => localStorage.removeItem(k));
    window.location.href = '/login';
  }
};

// Website-intake leads (server/routes/website-leads.router.js) use a richer
// schema (NEW_LEAD-style statuses, snake_case fields). Normalize just the
// fields this UI reads so the kanban and Response Center render them like any
// other lead; status writes go through /api/shop/leads/:id, which maps the
// kanban statuses back onto the website state machine server-side.
function _normalizeLead(l) {
  if (!l || l.channel !== 'website') return l;
  // pipelineStatus (stamped by /api/shop/leads/:id) preserves the granular
  // pipeline stage (quoted/worked…) that the website state machine can't hold.
  const status = l.pipelineStatus
    || ({ NEW_LEAD:'new', CONTACTED:'contacted', APPOINTMENT_SET:'booked', COMPLETED:'closed', LOST:'lost' })[l.status] || l.status;
  return {
    ...l,
    status,
    createdAt: l.createdAt || l.created_at,
    lastContactAt: l.lastContactAt || l.updated_at || l.created_at,
    firstResponseAt: l.firstResponseAt || l.first_response_at,
    vehicle: l.vehicle || ((l.vehicle_year || l.vehicle_make || l.vehicle_model)
      ? { year: l.vehicle_year, make: l.vehicle_make, model: l.vehicle_model, color: l.vehicle_color } : null),
    servicesInterested: l.servicesInterested || (l.service_requested ? [l.service_requested] : []),
    notes: l.notes !== undefined ? l.notes : (l.message || ''),
  };
}

async function apiFetch(path, opts={}) {
  const token = Auth.getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer '+token;
  const res = await fetch('/api/shop'+path, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) { Auth.logout(); return; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed '+res.status }));
    throw new Error(err.error || 'Request failed '+res.status);
  }
  return res.json();
}

const db = {
  settings:      { get: () => apiFetch('/settings'), save: (s) => apiFetch('/settings', {method:'POST',body:s}), testEmail: (email) => apiFetch('/test-lead-email', {method:'POST',body:{email}}) },
  newsletter:    { all: () => apiFetch('/newsletter'), get: (id) => apiFetch('/newsletter/'+id), save: (c) => apiFetch('/newsletter',{method:'POST',body:c}), delete: (id) => apiFetch('/newsletter/'+id,{method:'DELETE'}), test: (id,to) => apiFetch('/newsletter/'+id+'/test',{method:'POST',body:{to}}), send: (id) => apiFetch('/newsletter/'+id+'/send',{method:'POST'}) },
  barbers:       { all: () => apiFetch('/barbers'), save: (b) => apiFetch('/barbers',{method:'POST',body:b}), delete: (id) => apiFetch('/barbers/'+id,{method:'DELETE'}), saveSchedule: (id,s) => apiFetch('/barbers/'+id+'/schedule',{method:'POST',body:s}) },
  services:      { all: () => apiFetch('/services'), save: (s) => apiFetch('/services',{method:'POST',body:s}), delete: (id) => apiFetch('/services/'+id,{method:'DELETE'}) },
  customers:     { all: () => apiFetch('/customers'), search: (q) => apiFetch('/customers/search?q='+encodeURIComponent(q)), get: (id) => apiFetch('/customers/'+id), save: (c) => apiFetch('/customers',{method:'POST',body:c}), delete: (id) => apiFetch('/customers/'+id,{method:'DELETE'}), redeem: (id) => apiFetch('/customers/'+id+'/redeem',{method:'POST'}), log: (id,text) => apiFetch('/customers/'+id+'/log',{method:'POST',body:{text,by:(typeof Auth!=='undefined'&&Auth.getName&&Auth.getName())||''}}),
                   enroll: (id,planId) => apiFetch('/customers/'+id+'/membership',{method:'POST',body:{planId}}), cancelMembership: (id) => apiFetch('/customers/'+id+'/membership/cancel',{method:'POST'}), membershipCheckout: (id,planId) => apiFetch('/customers/'+id+'/membership/checkout',{method:'POST',body:{planId}}) },
  appointments:  { all: (p) => apiFetch('/appointments'+(p?'?'+new URLSearchParams(p):'')), save: (a) => apiFetch('/appointments',{method:'POST',body:a}), complete: (id,d) => apiFetch('/appointments/'+id+'/complete',{method:'POST',body:d}), noshow: (id) => apiFetch('/appointments/'+id+'/noshow',{method:'POST'}), delete: (id) => apiFetch('/appointments/'+id,{method:'DELETE'}), addPhoto: (id,phase,image) => apiFetch('/appointments/'+id+'/photos',{method:'POST',body:{phase,image}}), deletePhoto: (id,photoId) => apiFetch('/appointments/'+id+'/photos/'+photoId,{method:'DELETE'}) },
  revenue:       { get: () => apiFetch('/revenue') },
  expenses:      { all: () => apiFetch('/expenses'), save: (e) => apiFetch('/expenses',{method:'POST',body:e}), delete: (id) => apiFetch('/expenses/'+id,{method:'DELETE'}) },
  features:      { get: () => apiFetch('/features') },
  conversations: { all: () => apiFetch('/conversations'), forCustomer: (cid) => apiFetch('/conversations/customer/'+cid), markRead: (cid) => apiFetch('/conversations/read/'+cid,{method:'POST'}), save: (c) => apiFetch('/conversations',{method:'POST',body:c}) },
  sms:           { send: (o) => apiFetch('/sms/send',{method:'POST',body:o}) },
  leads:         { all: async () => ((await apiFetch('/leads')) || []).map(_normalizeLead), update: (id,d) => apiFetch('/leads/'+id,{method:'POST',body:d}), bulkStatus: (ids,status) => apiFetch('/leads/bulk-status',{method:'POST',body:{ids,status}}), bulkDelete: (ids) => apiFetch('/leads/bulk-delete',{method:'POST',body:{ids}}), dedupe: () => apiFetch('/leads/dedupe',{method:'POST'}), delete: (id) => apiFetch('/leads/'+id,{method:'DELETE'}), convert: (id) => apiFetch('/leads/'+id+'/convert',{method:'POST'}), note: (id,text) => apiFetch('/leads/'+id+'/note',{method:'POST',body:{text,by:(typeof Auth!=='undefined'&&Auth.getName&&Auth.getName())||''}}), sms: (id,body) => apiFetch('/leads/'+id+'/sms',{method:'POST',body:{body}}), aiIntake: (id,transcript) => apiFetch('/leads/'+id+'/ai-intake',{method:'POST',body:{transcript}}) },
  auth:          { verifyPin: (pin) => apiFetch('/auth/verify-pin',{method:'POST',body:{pin}}), changePin: (cur,n) => apiFetch('/auth/change-pin',{method:'POST',body:{currentPin:cur,newPin:n}}) },
  blockedDates:  { all: () => apiFetch('/blocked-dates'), block: (date,reason) => apiFetch('/blocked-dates',{method:'POST',body:{date,reason}}), unblock: (date) => apiFetch('/blocked-dates/'+date,{method:'DELETE'}) },
  checkout:      { cash: (o) => apiFetch('/checkout/cash',{method:'POST',body:o}), session: (o) => apiFetch('/checkout/session',{method:'POST',body:o}), verify: (sid,aid) => apiFetch('/checkout/verify/'+sid+'?apptId='+aid) },
  stripe:        { status: () => apiFetch('/stripe/connect/status'), onboard: () => apiFetch('/stripe/connect/onboard',{method:'POST'}), disconnect: () => apiFetch('/stripe/connect/disconnect',{method:'POST'}) },
  square:        { status: () => apiFetch('/square/connect/status'), onboard: () => apiFetch('/square/connect/onboard',{method:'POST'}), disconnect: () => apiFetch('/square/connect/disconnect',{method:'POST'}), reconcileDeposits: (customerId) => apiFetch('/square/reconcile-deposits',{method:'POST',body:{customerId}}) },
  staff:         { all: () => apiFetch('/staff'), save: (u) => apiFetch('/staff',{method:'POST',body:u}), delete: (id) => apiFetch('/staff/'+id,{method:'DELETE'}) },
  clientActivity:{ get: () => apiFetch('/client-activity') },
  gallery:       { add: (image,caption) => apiFetch('/gallery',{method:'POST',body:{image,caption}}), remove: (id) => apiFetch('/gallery/'+id,{method:'DELETE'}) },
  siteImage:     { set: (key,image) => apiFetch('/site-image',{method:'POST',body:{key,image}}), reset: (key) => apiFetch('/site-image/'+key,{method:'DELETE'}) },
  siteTeam:      { save: (m) => apiFetch('/site-team',{method:'POST',body:m}), remove: (id) => apiFetch('/site-team/'+id,{method:'DELETE'}) },
  reviews:       { all: () => apiFetch('/reviews'), feature: (id) => apiFetch('/reviews/'+id+'/feature',{method:'POST'}), remove: (id) => apiFetch('/reviews/'+id,{method:'DELETE'}), request: (appointmentId) => apiFetch('/reviews/request',{method:'POST',body:{appointmentId}}) },
  quotes:        { all: () => apiFetch('/quotes'), get: (id) => apiFetch('/quotes/'+id), save: (q) => apiFetch('/quotes',{method:'POST',body:q}), delete: (id) => apiFetch('/quotes/'+id,{method:'DELETE'}), send: (id) => apiFetch('/quotes/'+id+'/send',{method:'POST'}), sendEmail: (id) => apiFetch('/quotes/'+id+'/send-email',{method:'POST'}) },
  // ── Cleaning module (industry extension) ──
  properties:    { all: (customerId) => apiFetch('/properties'+(customerId?'?customerId='+customerId:'')), save: (p) => apiFetch('/properties',{method:'POST',body:p}), delete: (id) => apiFetch('/properties/'+id,{method:'DELETE'}) },
  crews:         { all: () => apiFetch('/crews'), save: (c) => apiFetch('/crews',{method:'POST',body:c}), delete: (id) => apiFetch('/crews/'+id,{method:'DELETE'}) },
  recurring:     { all: () => apiFetch('/recurring'), save: (r) => apiFetch('/recurring',{method:'POST',body:r}), delete: (id) => apiFetch('/recurring/'+id,{method:'DELETE'}), generate: (id) => apiFetch('/recurring/'+id+'/generate',{method:'POST'}) },
};

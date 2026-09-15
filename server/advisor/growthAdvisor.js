// ── Growth Advisor ───────────────────────────────────────────────────────────
// A weekly account-management review for one shop: the CODE computes every
// number from the shop's own leads / appointments / estimates / calls / ad
// spend, and Claude only interprets them into 1–3 ranked actions.
//
// Layout:
//   leadFacts()      — adapts ShopFlow's real records (stageLog, firstResponseAt,
//                      nested utm, appointment/estimate matching by customer or
//                      phone) into one flat fact row per lead.
//   computeMetrics() — 7-day / prior-7-day / 30-day funnels, per-ad, per-source,
//                      per-service breakdowns, open-lead worklist, data-quality
//                      notes, and plain-English flags. Pure; unit-testable.
//   runAdvisor()     — builds the prompt (playbook + past feedback + metrics),
//                      calls Claude with a JSON schema, stores the report on the
//                      shop db (db.advisor.reports), returns it.
//
// Degrades gracefully: with no ANTHROPIC_API_KEY the metrics + flags still
// render in the admin card; only the AI review is unavailable.
const { normalizeSource } = require('../leads-core');
const DEFAULT_PLAYBOOK = require('./playbook-default');

// House rule (claude-api skill): default to claude-opus-5. One call per shop
// per week, so cost is negligible; overridable without a code change.
const MODEL = process.env.ADVISOR_MODEL || 'claude-opus-5';
const DAY = 86400000;
const STALE_MINUTES = 15;          // an uncontacted lead older than this is a flag
const KEEP_REPORTS = 26;           // ~6 months of weekly reviews per shop
const PAID_SOURCES = ['facebook', 'instagram', 'meta', 'google', 'tiktok', 'youtube'];

let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic();
  return _client;
}
const configured = () => !!process.env.ANTHROPIC_API_KEY;

// ── helpers ──────────────────────────────────────────────────────────────────
const ms = (v) => { const t = v ? Date.parse(v) : NaN; return isNaN(t) ? null : t; };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const div = (n, d) => (d ? money(n / d) : null);
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
// Local calendar date of a timestamp (YYYY-MM-DD) — appointments are keyed by
// local date, so lead↔appointment "on or after" comparisons happen on dates.
const dateOf = (iso) => String(iso || '').slice(0, 10);

// ── 1. Adapter: ShopFlow records → one flat fact row per lead ────────────────
// Won stage keys come from the shop's own pipeline config (owner-editable),
// falling back to the built-in detailing stages.
function wonStageKeys(settings) {
  const cfg = ((settings || {}).pipeline || {}).stages;
  const fromCfg = Array.isArray(cfg) ? cfg.filter(s => s && s.won).map(s => s.key) : [];
  return new Set(fromCfg.length ? fromCfg : ['booked', 'worked', 'closed']);
}

function leadFacts(db) {
  const settings     = db.get('settings').value()     || {};
  const leads        = db.get('leads').value()        || [];
  const appointments = db.get('appointments').value() || [];
  const quotes       = db.get('quotes').value()       || [];
  const won = wonStageKeys(settings);

  // Appointments and estimates don't carry a leadId — link by customer id,
  // else by the last 10 digits of the phone (the same rule the CRM uses).
  const apptsByCust = new Map(), apptsByPhone = new Map();
  appointments.forEach(a => {
    if (a.customerId) (apptsByCust.get(a.customerId) || apptsByCust.set(a.customerId, []).get(a.customerId)).push(a);
    const ph = last10(a.customerPhone);
    if (ph.length === 10) (apptsByPhone.get(ph) || apptsByPhone.set(ph, []).get(ph)).push(a);
  });
  const quotesByCust = new Map(), quotesByPhone = new Map();
  quotes.forEach(q => {
    if (q.customerId) (quotesByCust.get(q.customerId) || quotesByCust.set(q.customerId, []).get(q.customerId)).push(q);
    const ph = last10(q.customerPhone);
    if (ph.length === 10) (quotesByPhone.get(ph) || quotesByPhone.set(ph, []).get(ph)).push(q);
  });

  return leads.map(l => {
    const createdAt = l.createdAt || l.created_at || null;
    const created = ms(createdAt);
    const createdDate = dateOf(createdAt);

    // First response: stamped server-side the first time the lead moves off
    // 'new' or gets a reply/call-back; the platform-router path stores seconds.
    let respondedAt = l.firstResponseAt || null;
    if (!respondedAt && l.response_time_seconds != null && created != null)
      respondedAt = new Date(created + Number(l.response_time_seconds) * 1000).toISOString();

    // Appointments/estimates for this person dated on/after the lead came in.
    const ph = last10(l.phone);
    const own = (byCust, byPhone) => {
      const seen = new Set(); const out = [];
      [...(l.customerId ? (byCust.get(l.customerId) || []) : []), ...(ph.length === 10 ? (byPhone.get(ph) || []) : [])]
        .forEach(x => { if (!seen.has(x.id)) { seen.add(x.id); out.push(x); } });
      return out;
    };
    const appts = own(apptsByCust, apptsByPhone).filter(a => !createdDate || dateOf(a.date || a.createdAt) >= createdDate);
    const ests  = own(quotesByCust, quotesByPhone).filter(q => !createdDate || dateOf(q.createdAt || q.sentAt) >= createdDate);

    // Booked: the pipeline stage log is the most precise record; else the
    // current stage; else a matched appointment (booked outside the pipeline).
    const stageHit = (l.stageLog || []).find(s => s && won.has(s.to));
    const bookedAppt = appts.find(a => !['cancelled', 'canceled', 'declined'].includes(a.status));
    let bookedAt = null, booked = false;
    if (stageHit) { booked = true; bookedAt = stageHit.at || null; }
    else if (won.has(l.status)) { booked = true; bookedAt = l.stageChangedAt || l.closedAt || null; }
    else if (bookedAppt) { booked = true; bookedAt = bookedAppt.createdAt || (bookedAppt.date ? bookedAppt.date + 'T12:00:00.000Z' : null); }

    const doneAppts = appts.filter(a => a.status === 'done');
    const revenue = doneAppts.reduce((s, a) => s + (Number(a.price) || 0), 0);
    const noShow = appts.some(a => a.status === 'no-show');
    const lost = l.status === 'lost' || !!l.lostAt;

    // Value: owner-entered quote → what the AI quoted on the call → the
    // estimate total → the price of the booked job.
    const estTotal = ests.reduce((s, q) => s + (Number(q.total) || 0), 0);
    const value = l.quotedAmount != null && Number(l.quotedAmount) > 0 ? Number(l.quotedAmount)
      : (l.ai && Number(l.ai.quotedPrice) > 0) ? Number(l.ai.quotedPrice)
      : estTotal > 0 ? estTotal
      : revenue > 0 ? revenue
      : (bookedAppt && Number(bookedAppt.price)) || 0;

    // Attribution. utm is the nested object the website form / Meta webhook
    // write ({source, medium, campaign, content}); channel/source is the
    // normalised bucket ('facebook', 'google', 'call', 'ai-voice', 'website'…).
    const utm = l.utm || {};
    const source = normalizeSource(String(l.channel || l.source || utm.source || 'website').toLowerCase());
    // Website forms put the ad name in utm_content; native Meta lead ads
    // (routes/meta-webhook.js) put the ad_id in campaign and the form id in
    // content, so the ad id is the grouping that matters there.
    const isMetaLeadAd = utm.medium === 'lead-ad';
    const tag = String((isMetaLeadAd ? (utm.campaign || utm.content) : (utm.content || utm.campaign)) || '').trim();
    const ad = tag ? (isMetaLeadAd && /^\d+$/.test(tag) ? `meta ad ${tag}` : tag)
      : PAID_SOURCES.includes(source) ? `${source} (untagged)`
      : source;
    const tags = [utm.content, utm.campaign, tag].filter(Boolean).map(s => String(s).toLowerCase());

    const svc = Array.isArray(l.servicesInterested) && l.servicesInterested.length ? l.servicesInterested[0]
      : (l.ai && l.ai.serviceNeeded) || null;

    return {
      id: l.id, name: l.name || '', createdAt, created, respondedAt, responded: ms(respondedAt),
      booked, bookedAt, completed: doneAppts.length > 0, revenue: money(revenue), noShow, lost,
      value: money(value), source, ad, tags, service: svc, hot: !!l.hot,
      lastContactAt: l.lastContactAt || null,
    };
  }).filter(f => f.created != null);
}

// ── 2. Metrics ───────────────────────────────────────────────────────────────
// Spend rows are the platform's ad_spend records: { campaign, source, amount,
// period_start, period_end }. A row's spend is prorated by how many of its
// days fall inside the window, so a monthly total contributes ~7/30 to a week.
function spendIn(rows, from, to, match = () => true) {
  let total = 0, hit = false;
  rows.forEach(r => {
    if (!match(r)) return;
    const amount = Number(r.amount != null ? r.amount : r.spend) || 0;
    let ps = ms(r.period_start || r.date || r.created_at), pe = ms(r.period_end || r.period_start || r.date || r.created_at);
    if (ps == null) return;
    if (pe == null || pe < ps) pe = ps;
    pe += DAY;                                  // period_end is inclusive
    const days = Math.max(1, Math.round((pe - ps) / DAY));
    const overlap = Math.max(0, Math.min(pe, to) - Math.max(ps, from));
    if (overlap <= 0) return;
    hit = true;
    total += amount * (overlap / DAY) / days;
  });
  return hit ? money(total) : null;
}

function funnel(rows, spend) {
  const contacted = rows.filter(r => r.responded != null);
  const mins = contacted.map(r => (r.responded - r.created) / 60000).filter(m => m >= 0);
  const booked = rows.filter(r => r.booked);
  const completed = rows.filter(r => r.completed);
  const noShows = rows.filter(r => r.noShow);
  const bookedValue = booked.reduce((s, r) => s + r.value, 0);
  const revenue = completed.reduce((s, r) => s + r.revenue, 0);
  return {
    leads: rows.length,
    contacted: contacted.length,
    contact_rate_pct: pct(contacted.length, rows.length),
    median_minutes_to_contact: median(mins),
    contacted_within_5_min_pct: pct(mins.filter(m => m <= 5).length, rows.length),
    booked: booked.length,
    booking_rate_pct: pct(booked.length, rows.length),
    booked_of_contacted_pct: pct(booked.length, contacted.length),
    completed: completed.length,
    no_shows: noShows.length,
    no_show_rate_pct: pct(noShows.length, completed.length + noShows.length),
    lost: rows.filter(r => r.lost).length,
    booked_value: money(bookedValue),
    completed_revenue: money(revenue),
    ad_spend: spend,
    cost_per_lead: spend == null ? null : div(spend, rows.length),
    cost_per_booking: spend == null ? null : div(spend, booked.length),
    booked_value_per_ad_dollar: spend ? div(bookedValue, spend) : null,
  };
}

const inWindow = (rows, from, to) => rows.filter(r => r.created >= from && r.created < to);
const groupBy = (rows, keyFn) => rows.reduce((acc, r) => { const k = keyFn(r); (acc[k] = acc[k] || []).push(r); return acc; }, {});

function computeMetrics({ facts = [], spendRows = [], calls = [], now = Date.now() } = {}) {
  const end = now + 1;
  const cur = inWindow(facts, now - 7 * DAY, end);
  const prev = inWindow(facts, now - 14 * DAY, now - 7 * DAY);
  const last30 = inWindow(facts, now - 30 * DAY, end);
  const spendMatch = (group) => (r) => {
    const c = String(r.campaign || '').toLowerCase().trim();
    return !!c && group.some(f => f.ad.toLowerCase() === c || f.tags.includes(c));
  };

  const byAd = Object.entries(groupBy(last30, r => r.ad))
    .map(([ad, rs]) => ({ ad, ...funnel(rs, spendIn(spendRows, now - 30 * DAY, end, spendMatch(rs))) }))
    .sort((a, b) => b.leads - a.leads).slice(0, 12);

  const bySource = Object.entries(groupBy(last30, r => r.source)).map(([source, rs]) => ({
    source, leads: rs.length, contacted: rs.filter(r => r.responded != null).length,
    booked: rs.filter(r => r.booked).length, booking_rate_pct: pct(rs.filter(r => r.booked).length, rs.length),
    booked_value: money(rs.filter(r => r.booked).reduce((s, r) => s + r.value, 0)),
  })).sort((a, b) => b.leads - a.leads);

  const byService = Object.entries(groupBy(last30, r => r.service || 'unspecified')).map(([service, rs]) => ({
    service, leads: rs.length, booked: rs.filter(r => r.booked).length,
    booked_value: money(rs.filter(r => r.booked).reduce((s, r) => s + r.value, 0)),
  })).sort((a, b) => b.leads - a.leads).slice(0, 10);

  // Open-lead worklist: not booked, not lost, from the last 30 days.
  const open = facts.filter(r => !r.lost && !r.booked && now - r.created < 30 * DAY);
  const uncontacted = open.filter(r => r.responded == null && now - r.created > STALE_MINUTES * 60000)
    .sort((a, b) => a.created - b.created);
  const stalled = open.filter(r => r.responded != null && now - r.responded > 2 * DAY);
  const hotOpen = open.filter(r => r.hot);

  // Calls: missed calls are leads that never got a form; the AI receptionist
  // answering them is the recovery mechanism.
  const callsIn = (from, to) => calls.filter(c => { const t = ms(c.startedAt || c.createdAt); return t != null && t >= from && t < to; });
  const callSummary = (list) => ({
    total: list.length,
    missed: list.filter(c => c.missed || c.status === 'missed' || c.status === 'no-answer').length,
    ai_answered: list.filter(c => c.voiceAI || c.aiHandled).length,
  });

  const metrics = {
    generated_at: new Date(now).toISOString(),
    this_week: funnel(cur, spendIn(spendRows, now - 7 * DAY, end)),
    last_week: funnel(prev, spendIn(spendRows, now - 14 * DAY, now - 7 * DAY)),
    last_30_days: funnel(last30, spendIn(spendRows, now - 30 * DAY, end)),
    calls: { this_week: callSummary(callsIn(now - 7 * DAY, end)), last_week: callSummary(callsIn(now - 14 * DAY, now - 7 * DAY)) },
    by_ad_30d: byAd,
    by_source_30d: bySource,
    by_service_30d: byService,
    open_leads: {
      uncontacted_over_15_min: uncontacted.length,
      oldest_uncontacted: uncontacted.slice(0, 10).map(r => ({
        id: r.id, name: r.name || null, service: r.service, source: r.source, ad: r.ad, hot: r.hot,
        age_hours: Math.round((now - r.created) / 360000) / 10,
      })),
      contacted_not_booked_over_48h: stalled.length,
      hot_open: hotOpen.length,
    },
    data_quality: {
      spend_entered: spendRows.length > 0,
      leads_missing_attribution_pct: pct(last30.filter(r => /\(untagged\)$/.test(r.ad)).length, last30.length),
      booked_missing_value: last30.filter(r => r.booked && !r.value).length,
      leads_without_response_stamp_pct: pct(last30.filter(r => r.responded == null && (r.booked || r.lost)).length, last30.filter(r => r.booked || r.lost).length),
    },
  };
  metrics.flags = buildFlags(metrics);
  return metrics;
}

function buildFlags(m) {
  const f = [];
  const w = m.this_week, p = m.last_week, o = m.open_leads;
  if (o.hot_open > 0) f.push(`${o.hot_open} open lead${o.hot_open === 1 ? '' : 's'} flagged 🔥 hot and not yet booked`);
  if (o.uncontacted_over_15_min > 0) f.push(`${o.uncontacted_over_15_min} open lead${o.uncontacted_over_15_min === 1 ? '' : 's'} not contacted after 15+ minutes`);
  if (w.median_minutes_to_contact != null && w.median_minutes_to_contact > 5) f.push(`median time to first contact is ${w.median_minutes_to_contact} min this week`);
  if (w.contact_rate_pct != null && p.contact_rate_pct != null && w.contact_rate_pct < p.contact_rate_pct - 10) f.push(`contact rate fell from ${p.contact_rate_pct}% to ${w.contact_rate_pct}%`);
  if (w.cost_per_lead != null && p.cost_per_lead != null && w.cost_per_lead > p.cost_per_lead * 1.3) f.push(`cost per lead rose from $${p.cost_per_lead} to $${w.cost_per_lead}`);
  if (m.last_30_days.no_show_rate_pct != null && m.last_30_days.no_show_rate_pct > 15) f.push(`30-day no-show rate is ${m.last_30_days.no_show_rate_pct}%`);
  if (o.contacted_not_booked_over_48h > 0) f.push(`${o.contacted_not_booked_over_48h} contacted lead${o.contacted_not_booked_over_48h === 1 ? '' : 's'} sitting unbooked for 48h+`);
  m.by_ad_30d.filter(a => a.ad_spend && a.leads >= 10 && a.booked === 0)
    .forEach(a => f.push(`ad "${a.ad}" spent $${a.ad_spend} for ${a.leads} leads and 0 bookings in 30 days`));
  const mc = m.calls.this_week;
  if (mc.missed > 0 && mc.ai_answered === 0) f.push(`${mc.missed} missed call${mc.missed === 1 ? '' : 's'} this week with no AI receptionist pickup`);
  if (!m.data_quality.spend_entered) f.push('no ad spend entered, so cost metrics are unavailable');
  if (m.data_quality.leads_missing_attribution_pct > 30) f.push(`${m.data_quality.leads_missing_attribution_pct}% of paid-source leads have no campaign/ad tag`);
  if (m.data_quality.leads_without_response_stamp_pct > 30) f.push(`${m.data_quality.leads_without_response_stamp_pct}% of decided leads have no first-response stamp, so speed-to-lead is understated`);
  return f;
}

// ── 3. Prompt ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are ShopFlow's Growth Advisor. ShopFlow is a growth partner for auto detailing, window tint, PPF, ceramic coating, car audio, and similar service shops. Each week you review one shop's lead funnel and tell the operator the few moves most likely to increase booked revenue.

HOW THE BUSINESS WORKS
- Leads arrive from paid ads (Meta, Google) via landing-page quote forms tagged with UTM parameters, from native Meta lead ads, from phone calls (a missed call becomes a lead; an AI receptionist may answer and capture it), and from organic website traffic or manual entry.
- The funnel is: lead -> first response -> booked appointment -> job completed (or no-show). "Booked" comes from the shop's pipeline stage or a matching appointment; "value" is the quoted or booked price.
- The shop pays ad spend separately from ShopFlow's fee. Wasted spend is the shop's money.

RULES FOR NUMBERS
- Every number you use must come from the METRICS JSON. Never calculate new figures, estimate missing ones, or round differently. If a number you need is null or missing, list it in data_gaps instead of guessing.
- When you cite a number, say what it is and which window it's from (for example: "contact rate 58% this week vs 81% last week").
- The current 7-day cohort is immature: leads from the last few days may not have booked yet. Do not call a booking-rate drop a problem unless the prior week or the 30-day view supports it.
- Small samples: do not declare an ad, offer, or source a winner or loser with fewer than 10 leads or fewer than 3 bookings on each side. Say "keep testing" and what result would settle it.

HOW TO PRIORITIZE
Fix leaks on leads that were already paid for before recommending more spend. Check in this order:
1. Uncontacted and slow-contacted leads. Speed to lead is the biggest lever; minutes matter. Hot-flagged open leads come first.
2. Contacted leads that never booked (follow-up cadence, quote presentation, offer).
3. No-shows (confirmations, deposits).
4. Ad and landing page efficiency. Cost per booking and booked value per ad dollar matter more than cost per lead; cheap leads that don't book are expensive.
5. Scaling what works, only when 1-4 are healthy.
Rank actions by expected booked revenue, not by how easy or interesting they are.

WHAT A GOOD ACTION LOOKS LIKE
- Specific and doable this week by a named owner: "shopflow" (ads, landing page, software, account management), "sales" (lead follow-up and booking, when ShopFlow handles it), or "shop" (the shop owner and their staff).
- Tied to at least one metric from the JSON, with the reason.
- States what to measure next week to know if it worked.
- Respects the CONSTRAINTS in the playbook. Never recommend anything listed there as unavailable.
- Builds on the PLAYBOOK's proven lessons. Don't re-suggest tests that already have a settled answer unless the data contradicts them.

LEARNING FROM FEEDBACK
PAST FEEDBACK lists earlier recommendations and how the operator rated them. Give more of the kind of advice rated helpful. Do not repeat advice rated not helpful unless the data has clearly changed, and if you do, say what changed. If an action was marked done, check whether its metric moved and mention the result in wins or watch.

OUTPUT
Give 1 to 3 actions, most valuable first. Fewer, sharper actions beat a long list. If the funnel is healthy and nothing is worth changing, say so with zero or one action and health "good".
Write plainly, like a sharp operator talking to a busy shop owner. No hype, no filler, no generic marketing advice.`;

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string', description: 'One sentence: the single most important thing this week.' },
    health: { type: 'string', enum: ['good', 'watch', 'urgent'] },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Short imperative, under 10 words.' },
          owner: { type: 'string', enum: ['shopflow', 'sales', 'shop'] },
          category: { type: 'string', enum: ['speed_to_lead', 'follow_up', 'no_shows', 'ads', 'landing_page', 'offer', 'scale', 'data'] },
          why: { type: 'string', description: '1-2 sentences citing the numbers.' },
          do_this: { type: 'string', description: 'The concrete steps, 1-3 sentences.' },
          measure: { type: 'string', description: 'Which metric should move, and which direction, next week.' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['title', 'owner', 'category', 'why', 'do_this', 'measure', 'impact', 'effort'],
      },
    },
    wins: { type: 'array', items: { type: 'string' }, description: 'Up to 2 short notes on what is working, with numbers.' },
    watch: { type: 'array', items: { type: 'string' }, description: 'Up to 3 things that are not problems yet but could become one.' },
    data_gaps: { type: 'array', items: { type: 'string' }, description: 'Missing or unreliable data that limited this review.' },
  },
  required: ['headline', 'health', 'actions', 'wins', 'watch', 'data_gaps'],
};

function buildUserMessage({ shopName, industry, metrics, playbook, shopNotes, feedback }) {
  return `Weekly review for: ${shopName}${industry ? ` (${industry})` : ''}

PLAYBOOK
${(playbook || '').trim() || '(empty)'}

NOTES FOR THIS SHOP
${(shopNotes || '').trim() || '(none)'}

PAST FEEDBACK
${feedback.length ? JSON.stringify(feedback, null, 2) : '(none yet)'}

METRICS (computed by ShopFlow; treat as the only source of numbers)
${JSON.stringify(metrics, null, 2)}`;
}

// ── 4. Storage (on the shop db, so it survives deploys like everything else) ─
function loadStore(db) {
  const s = db.get('advisor').value();
  return s && typeof s === 'object' ? { reports: [], spend: [], ...s } : { reports: [] };
}
function saveStore(db, store) {
  store.reports = (store.reports || []).slice(-KEEP_REPORTS);
  db.set('advisor', store).write();
}

// The last `limit` rated/done actions across recent reports, newest first —
// this is what makes the advisor stop repeating advice the operator rejected.
function recentFeedback(store, limit = 12) {
  const out = [];
  for (const r of [...(store.reports || [])].reverse()) {
    ((r.result && r.result.actions) || []).forEach((a, i) => {
      const fb = r.feedback && r.feedback[i];
      if (fb && (fb.rating || fb.done || fb.note)) out.push({ date: String(r.createdAt).slice(0, 10), title: a.title, category: a.category, measure: a.measure, ...fb });
    });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// ── 5. The review ────────────────────────────────────────────────────────────
async function callModel(userMessage) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    // Static system prompt first + cached; the volatile playbook/metrics ride in
    // the user turn so weekly runs across shops share the cached prefix.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: REPORT_SCHEMA } },
    messages: [{ role: 'user', content: userMessage }],
  });
  if (res.stop_reason === 'refusal') throw new Error('The model declined to produce a review');
  const block = (res.content || []).find(b => b.type === 'text');
  if (!block) throw new Error('Empty model response');
  return { result: JSON.parse(block.text), usage: res.usage || null };
}

// Everything the admin card needs for one shop, WITHOUT calling the model.
function snapshot(db, shop, now = Date.now()) {
  const facts = leadFacts(db);
  const spendRows = db.get('ad_spend').value() || [];
  const calls = db.get('calls').value() || [];
  const metrics = computeMetrics({ facts, spendRows, calls, now });
  return { metrics, spendRows, leadCount: facts.length };
}

// opts.model lets tests inject a fake model; production uses callModel.
async function runAdvisor({ db, shop, playbook, trigger = 'manual', now = Date.now(), model = callModel }) {
  const { metrics } = snapshot(db, shop, now);
  const store = loadStore(db);
  const userMessage = buildUserMessage({
    shopName: shop.shopName || shop.name || shop.slug || shop.id,
    industry: shop.industry || null,
    metrics,
    playbook: playbook != null ? playbook : DEFAULT_PLAYBOOK,
    shopNotes: shop.advisorNotes || '',
    feedback: recentFeedback(store),
  });
  const { result, usage } = await model(userMessage);
  const report = {
    id: 'adv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    createdAt: new Date(now).toISOString(), model: MODEL, trigger, usage,
    metrics, result, feedback: {},
  };
  store.reports.push(report);
  if (trigger === 'auto') store.lastAutoRunAt = report.createdAt;
  saveStore(db, store);
  return report;
}

function recordFeedback(db, reportId, actionIndex, { rating, note, done }) {
  const store = loadStore(db);
  const report = store.reports.find(r => r.id === reportId);
  if (!report || !(report.result.actions || [])[actionIndex]) throw new Error('Report or action not found');
  report.feedback = report.feedback || {};
  const prev = report.feedback[actionIndex] || {};
  report.feedback[actionIndex] = {
    rating: rating !== undefined ? rating : (prev.rating || null),   // 'helpful' | 'not_helpful' | null
    note: note !== undefined ? note : (prev.note || ''),
    done: done !== undefined ? !!done : !!prev.done,
    updatedAt: new Date().toISOString(),
  };
  saveStore(db, store);
  return report.feedback[actionIndex];
}

// Weekly auto-run: Mondays (shop-local), at most once per 6 days, only for
// shops that opted in (shop.advisorAuto !== false) and had a lead in 30 days.
function autoRunDue(db, shop, localDayOfWeek, now = Date.now()) {
  if (!configured() || shop.advisorAuto === false) return false;
  if (localDayOfWeek !== 1) return false;
  const store = loadStore(db);
  const last = ms(store.lastAutoRunAt);
  if (last != null && now - last < 6 * DAY) return false;
  const leads = db.get('leads').value() || [];
  return leads.some(l => { const t = ms(l.createdAt || l.created_at); return t != null && now - t < 30 * DAY; });
}

module.exports = {
  MODEL, DEFAULT_PLAYBOOK, SYSTEM_PROMPT, REPORT_SCHEMA,
  configured, leadFacts, computeMetrics, buildFlags, spendIn, buildUserMessage,
  loadStore, saveStore, recentFeedback, snapshot, runAdvisor, recordFeedback, autoRunDue,
};

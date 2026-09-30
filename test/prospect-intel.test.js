// Integration test for prospect profiles + AI sales intel (admin territory map):
//   POST /api/admin/sales/leads/:id/log      — touch log; a real touch moves not-contacted → contacted
//   POST /api/admin/sales/leads/:id/analyze  — web research + structured brief, run in the background
//   POST /api/admin/sales/plan               — whole-book game plan (streamed), #refs mapped to lead ids
// The Anthropic API is stubbed at fetch; checks the requests are shaped right
// (web tools on the research call, json_schema output on the brief/plan) and
// that results land on the lead / sales blob.
// Run: node test/prospect-intel.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-intel-' + process.pid);
process.env.ANTHROPIC_API_KEY = 'test-key';

const express = require('express');
const { master } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const BRIEF = {
  summary: 'Two-bay tint shop.', fitScore: 8, fitReason: 'Busy, phone-only booking.', priority: 'hot',
  recommendedOffer: 'AI Receptionist — $349', offerReason: 'Misses calls while tinting.',
  signals: [{ kind: 'gap', label: 'No online booking', detail: 'Phone only.' }], painPoints: ['Missed calls'],
  approach: { channel: 'Walk-in', bestTime: 'Tue 10am', why: 'Owner is on site.' }, opener: 'Hey, quick one…',
  talkingPoints: ['Every missed call is a lost job'], objections: [{ objection: 'Too expensive', response: 'One job pays for it.' }],
  questionsToAsk: ['How many calls do you miss?'], nextStep: 'Walk in Tuesday.',
};
const PLAN = {
  headline: 'Start with the busy tint shops.', marketRead: 'Mostly owner-operators.',
  segments: [{ name: 'Busy tint', who: '100+ reviews', offer: 'Receptionist', approach: 'Walk-in', shopRefs: ['#2', '#1', '#99'] }],
  topTargets: [{ ref: '#2', why: 'Most reviews', offer: 'Receptionist', opener: 'Hi' }, { ref: '#77', why: 'ghost', offer: 'x', opener: 'x' }],
  territoryPlan: [{ territory: 'NE Heights', plan: 'Walk Montgomery' }],
  weekPlan: [{ day: 'Monday', focus: 'Calls', tasks: ['Call #2'] }], pitchAngles: ['Missed calls'], watchOuts: ['Skeptical of agencies'],
};

const calls = [];
const realFetch = global.fetch;
const sse = events => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const msg = (content, stop = 'end_turn') => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  calls.push(body);
  const json = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (body.tools) return json(msg([
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://tintpros.example/', title: 't', encrypted_content: '' }] },
    { type: 'text', text: '- Phone-only booking (https://tintpros.example/)' },
  ]));
  if (body.stream) {
    const m = msg([]);
    return sse([
      ['message_start', { type: 'message_start', message: m }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(PLAN) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  }
  return json(msg([{ type: 'text', text: JSON.stringify(BRIEF) }]));
};

const wait = ms => new Promise(r => setTimeout(r, ms));
const app = express();
app.use(express.json());
app.use(require('../server/routes/sales'));
const server = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'content-type': 'application/json', 'x-admin-key': 'shopflow-admin' };
  const post = (p, body) => realFetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) }).then(r => r.json());
  const get = p => realFetch(base + p, { headers: H }).then(r => r.json());

  const s0 = await get('/api/admin/sales');
  eq('payload says AI is ready', s0.aiReady, true);
  await post('/api/admin/sales/leads', { name: 'Tint Pros', status: 'not-contacted', website: 'https://tintpros.example/', rating: 4.9, reviews: 210 });
  await post('/api/admin/sales/leads', { name: 'Duke Detail', status: 'contacted' });
  await post('/api/admin/sales/leads', { name: 'Signed Shop', status: 'closed' });
  const leads = () => master.get('sales.leads').value();
  const tp = () => leads().find(l => l.name === 'Tint Pros');
  // Website / rating only arrive via the Google Maps import, not the form — set them like the import does.
  master.get('sales.leads').find({ name: 'Tint Pros' }).assign({ website: 'https://tintpros.example/', rating: 4.9, reviews: 210 }).write();

  // Touch log
  const note = await post(`/api/admin/sales/leads/${tp().id}/log`, { type: 'note', text: 'Owner is Ray' });
  eq('a note does not count as contact', [note.ok, tp().status, tp().lastContact == null || tp().lastContact === tp().createdAt], [true, 'not-contacted', true]);
  await post(`/api/admin/sales/leads/${tp().id}/log`, { type: 'walk-in', text: 'Dropped by, owner busy' });
  eq('a walk-in moves it to contacted', [tp().status, tp().log.length, tp().log[0].type], ['contacted', 2, 'walk-in']);

  // Per-shop analysis
  const a = await post(`/api/admin/sales/leads/${tp().id}/analyze`, { territory: 'NE Heights' });
  eq('analyze returns immediately, running', [a.ok, a.leads.find(l => l.name === 'Tint Pros').intel.status], [true, 'running']);
  for (let i = 0; i < 50 && tp().intel.status === 'running'; i++) await wait(20);
  const intel = tp().intel;
  eq('brief stored on the lead', [intel.status, intel.brief.fitScore, intel.brief.priority, intel.sources], ['done', 8, 'hot', ['https://tintpros.example/']]);
  const [researchCall, briefCall] = calls;
  eq('research call has web search + fetch', researchCall.tools.map(t => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  eq('brief call is schema-constrained, no tools', [briefCall.output_config.format.type, !!briefCall.tools], ['json_schema', false]);
  eq('brief prompt carries territory, Google data + touch log', [/Territory: NE Heights/.test(briefCall.messages[0].content), /4\.9★ from 210 reviews/.test(briefCall.messages[0].content), /walk-in: Dropped by/.test(briefCall.messages[0].content)], [true, true, true]);
  eq('research prompt includes their website', /Website: https:\/\/tintpros\.example\//.test(researchCall.messages[0].content), true);
  eq('model is claude-opus-5', briefCall.model, 'claude-opus-5');

  // A form save afterwards must not wipe the brief.
  await post('/api/admin/sales/leads', { id: tp().id, name: 'Tint Pros', status: 'responded' });
  eq('edit keeps intel', [tp().status, tp().intel.brief.fitScore], ['responded', 8]);

  // Game plan
  calls.length = 0;
  const p = await post('/api/admin/sales/plan', { territories: { [tp().id]: 'NE Heights' } });
  eq('plan starts running', [p.ok, p.plan.status], [true, 'running']);
  for (let i = 0; i < 50 && master.get('sales.plan.status').value() === 'running'; i++) await wait(20);
  const plan = master.get('sales.plan').value();
  const duke = leads().find(l => l.name === 'Duke Detail');
  eq('plan done', [plan.status, plan.shopCount], ['done', 2]);
  eq('closed shops left out of the plan', /Signed Shop/.test(calls[0].messages[0].content), false);
  eq('plan was streamed + schema-constrained', [calls[0].stream, calls[0].output_config.format.type], [true, 'json_schema']);
  // Newest lead first: #1 = Duke Detail, #2 = Tint Pros.
  eq('#refs mapped to lead ids (unknown dropped)', plan.plan.segments[0].leadIds, [tp().id, duke.id]);
  eq('top targets mapped, ghosts dropped', plan.plan.topTargets.map(t => t.leadId), [tp().id]);
  eq('analysis + Google data fed into the plan', /#2 \| Tint Pros \| NE Heights \| responded \| .*4\.9★\/210 \| site .*analyzed: fit 8\/10, hot/.test(calls[0].messages[0].content), true);

  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
});

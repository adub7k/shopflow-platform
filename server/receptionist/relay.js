// ── AI Receptionist: ConversationRelay (streaming voice) engine ───────────────
// The low-latency alternative to the turn-by-turn <Gather> flow (receptionist/
// voice.js). Twilio's ConversationRelay holds a live media socket: it streams
// speech-to-text to us and streams our text straight to ElevenLabs TTS, so the
// caller hears the first words while Claude is still generating the rest, and can
// interrupt mid-sentence. We reuse voice.js verbatim for the "brain" (system
// prompt, tools, server-authoritative booking/capture) — only the transport
// differs.
//
// Protocol (https://www.twilio.com/docs/voice/conversationrelay/websocket-messages):
//   Twilio → us:  setup, prompt {voicePrompt,last}, interrupt, dtmf, error
//   us → Twilio:  {type:'text',token,last}  (speak),  {type:'end',handoffData} (hang up)
const crypto = require('crypto');
const { master, getShopDb, shopHelpers, today } = require('../db');
const voice = require('./voice');

const RELAY_PATH = '/api/twilio/voice/relay';
const MAX_TURNS = 16;

// Available when a key is configured (same gate as the rest of the receptionist).
const available = () => voice.voiceAvailable();

// ── Handshake auth ────────────────────────────────────────────────────────────
// The websocket is public (Twilio dials it), so we sign the callSid into the wss
// URL and verify it on connect — a random client can't forge a session.
function relaySecret() { return process.env.RELAY_SECRET || process.env.JWT_SECRET || 'shopflow-relay-dev-secret'; }
function relayToken(callSid) { return crypto.createHmac('sha256', relaySecret()).update(String(callSid || '')).digest('hex').slice(0, 32); }

// ── TwiML ─────────────────────────────────────────────────────────────────────
const escapeXml = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
function wsBase() {
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (base) return base.replace(/^https/, 'wss').replace(/^http:/, 'ws:');
  return ''; // PUBLIC_URL must be set in any real (non-local) deploy
}
// Full <Connect><ConversationRelay> TwiML that hands the media stream to our socket.
// Returned as a raw string (the twilio node SDK's TwiML builder predates the verb).
function connectTwiml(ctx, callSid) {
  const cfg = voice.voiceConfig(ctx.settings);
  const url = `${wsBase()}${RELAY_PATH}?shopId=${encodeURIComponent(ctx.shopId)}&callSid=${encodeURIComponent(callSid)}&t=${relayToken(callSid)}`;
  const voiceAttr = cfg.relayVoice ? ` voice="${escapeXml(cfg.relayVoice)}"` : '';
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response><Connect>'
    + `<ConversationRelay url="${escapeXml(url)}"`
    + ` welcomeGreeting="${escapeXml(voice.greeting(ctx))}"`
    + ` ttsProvider="${escapeXml(cfg.relayTtsProvider)}"${voiceAttr}`
    + ' interruptible="speech" reportInputDuringAgentSpeech="none"'
    + ` interruptSensitivity="${escapeXml(cfg.relayInterruptSensitivity)}"`
    + ` ignoreBackchannel="${cfg.relayIgnoreBackchannel ? 'true' : 'false'}"`
    + '/></Connect></Response>';
}

// ── Shop context (mirrors twilio.js shopCtx + voiceCtx) ───────────────────────
function shopCtxFor(idOrSlug) {
  const shops = master.get('shops');
  const shop = shops.find({ id: idOrSlug }).value() || shops.find({ slug: idOrSlug }).value();
  if (!shop || shop.active === false) return null;
  const db = getShopDb(shop.id);
  const h = shopHelpers(db);
  const settings = db.get('settings').value() || {};
  return { shopId: shop.id, db, h, settings, shop, shopName: settings.shopName || shop.shopName || 'the shop', industry: db.get('industry').value(), today: today() };
}

// ── Websocket wiring ──────────────────────────────────────────────────────────
function attach(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url; try { url = new URL(req.url, 'http://relay'); } catch { return socket.destroy(); }
    if (url.pathname !== RELAY_PATH) return socket.destroy(); // not ours (leave other upgrades alone)
    wss.handleUpgrade(req, socket, head, ws => onConnection(ws, url.searchParams));
  });
  console.log('[relay] ConversationRelay websocket listening at', RELAY_PATH);
}

function onConnection(ws, params) {
  const shopId = params.get('shopId');
  const callSid = params.get('callSid');
  if (!shopId || !callSid || params.get('t') !== relayToken(callSid)) { ws.close(1008, 'unauthorized'); return; }
  const ctx = shopCtxFor(shopId);
  if (!ctx || !available()) { ws.close(1011, 'unavailable'); return; }

  const call = ctx.h.getById('calls', callSid) || { id: callSid, from: params.get('from') || '', leadId: null };
  if (!call.voiceAI) call.voiceAI = voice.initState('relay');
  const session = { ws, ctx, call, cfg: voice.voiceConfig(ctx.settings), messages: [], busy: false, ended: false, gen: 0, stream: null };

  ws.on('message', data => { onMessage(session, data).catch(e => console.error('[relay] message error', e.message)); });
  ws.on('close', () => finalize(session));
  ws.on('error', e => console.error('[relay] ws error', e.message));
}

// ── Message dispatch ──────────────────────────────────────────────────────────
async function onMessage(session, data) {
  let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
  switch (msg.type) {
    case 'setup': {
      session.sessionId = msg.sessionId;
      if (msg.callSid) session.call.id = msg.callSid;
      if (msg.from) session.call.from = session.call.from || msg.from;
      // The welcomeGreeting is spoken by Twilio from the TwiML; record it as the
      // opening assistant turn (transcript + prompt context), not in the LLM history.
      session.call.voiceAI.turns.push({ role: 'assistant', text: voice.greeting(session.ctx), at: new Date().toISOString() });
      session.ctx.h.upsert('calls', session.call);
      return;
    }
    case 'prompt':
      if (msg.last) return handlePrompt(session, msg.voicePrompt || '');
      return; // partial results ignored (we don't enable partialPrompts)
    case 'interrupt':
      // Caller barged in — stop generating/speaking the current reply.
      session.gen++;                     // invalidate in-flight token sends
      if (session.stream) { try { session.stream.abort(); } catch (e) { /* already done */ } }
      return;
    case 'dtmf':
    case 'error':
      if (msg.type === 'error') console.error('[relay] twilio error:', msg.description);
      return;
    default:
      return;
  }
}

// Speak text (streams straight to TTS). last:true finalizes the turn.
function send(session, obj) { try { if (session.ws.readyState === 1) session.ws.send(JSON.stringify(obj)); } catch (e) { /* socket gone */ } }
function speak(session, token, last) { send(session, { type: 'text', token: token || '', last: !!last }); }

// ── One conversational turn (streaming) ───────────────────────────────────────
async function handlePrompt(session, promptText) {
  const text = String(promptText || '').trim();
  if (session.ended) return;
  if (!text) return;                 // Twilio handles silence/re-listen itself
  if (session.busy) return;          // one turn at a time (Twilio waits for last:true)
  session.busy = true;
  const myGen = ++session.gen;
  const { ctx, call } = session;

  call.voiceAI.turns.push({ role: 'user', text, at: new Date().toISOString() });
  session.messages.push({ role: 'user', content: text });

  const client = voice.getClient();
  if (!client) { speak(session, "I'm sorry, I'm having trouble right now. The shop will call you right back. Goodbye!", true); return endSession(session, 'no-key'); }

  const quoteFirst = voice.isQuoteFirst(ctx.settings, ctx.industry);
  const system = voice.buildSystemPrompt({ ...ctx, callerPhone: call.from }, { ...session.cfg, _greeting: call.voiceAI.turns[0] && call.voiceAI.turns[0].text });
  const tools = voice.toolsFor(quoteFirst, session.cfg);
  const used = call.voiceAI.turns.filter(t => t.role === 'assistant').length;
  let ended = null;
  let spoken = '';
  let closed = false; // did a terminal tool already speak a goodbye?

  try {
    for (let hop = 0; hop < 4; hop++) {
      const stream = client.messages.stream({ model: voice.MODEL, max_tokens: 320, system, messages: session.messages, tools });
      session.stream = stream;
      stream.on('text', delta => { if (session.gen === myGen) { spoken += delta; speak(session, delta, false); } });
      const final = await stream.finalMessage();
      session.stream = null;
      if (session.gen !== myGen) return;                 // interrupted mid-turn

      session.messages.push({ role: 'assistant', content: final.content });
      const toolUses = (final.content || []).filter(b => b.type === 'tool_use');
      if (!toolUses.length) break;

      const results = [];
      for (const tu of toolUses) {
        const a = tu.input || {};
        const out = voice.runTool(ctx, call, tu.name, a);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
        // Terminal tools speak their closing line and end the call (see voice.js).
        if (tu.name === 'end_call') { ended = a; if (a.farewell) { spoken += a.farewell; speak(session, a.farewell, false); closed = true; } }
        else if (tu.name === 'capture_lead' && out && out.captured) { ended = { outcome: 'captured' }; if (a.closingLine) { spoken += a.closingLine; speak(session, a.closingLine, false); closed = true; } }
        else if (tu.name === 'book_appointment' && out && out.booked) { ended = { outcome: 'booked' }; if (a.closingLine) { spoken += a.closingLine; speak(session, a.closingLine, false); closed = true; } }
        else if (tu.name === 'transfer_to_human' && out && out.transferred) { ended = { outcome: 'transfer' }; if (a.closingLine) { spoken += a.closingLine; speak(session, a.closingLine, false); closed = true; } }
      }
      session.messages.push({ role: 'user', content: results });
      if (ended) break;
      if (used + 1 >= (session.cfg.maxTurns || MAX_TURNS)) { ended = { outcome: 'captured' }; break; }
    }
  } catch (e) {
    session.stream = null;
    if (session.gen !== myGen) return;                   // aborted by interrupt — fine
    console.error('[relay] turn failed:', e.message);
    speak(session, "I'm sorry, something went wrong. The shop will call you right back. Goodbye!", true);
    return endSession(session, 'error');
  }

  // Guarantee a warm goodbye if the call is ending and the model didn't give one.
  if (ended && !closed) { speak(session, voice.FAREWELL, false); spoken += ' ' + voice.FAREWELL; }
  speak(session, '', true);                              // finalize this TTS turn
  if (spoken.trim()) call.voiceAI.turns.push({ role: 'assistant', text: spoken.trim(), at: new Date().toISOString() });
  syncTranscript(call);
  ctx.h.upsert('calls', call);
  session.busy = false;

  if (ended) {
    if (!call.voiceAI.outcome) call.voiceAI.outcome = { type: ended.outcome || 'ended' };
    endSession(session, ended.outcome || 'ended');
  }
}

// Mirror the conversation onto call.transcript for the Leads UI (matches gather).
function syncTranscript(call) {
  if (!call.voiceAI || !call.voiceAI.turns) return;
  call.transcript = call.voiceAI.turns.map(t => `${t.role === 'assistant' ? 'AI' : 'Caller'}: ${t.text}`).join('\n');
  call.transcriptStatus = 'done';
}

function endSession(session, reason) {
  if (session.ended) return;
  session.ended = true;
  send(session, { type: 'end', handoffData: JSON.stringify({ reason: reason || 'done' }) });
}

// Persist final state when the socket closes (finalizes transcript + status).
function finalize(session) {
  try {
    const { ctx, call } = session;
    if (!call || !call.voiceAI) return;
    call.voiceAI.endedAt = new Date().toISOString();
    if (call.voiceAI.status === 'active') call.voiceAI.status = call.voiceAI.outcome ? call.voiceAI.outcome.type : 'ended';
    call.aiHandled = true;
    syncTranscript(call);
    ctx.h.upsert('calls', call);
  } catch (e) { console.error('[relay] finalize error', e.message); }
}

module.exports = { attach, available, connectTwiml, relayToken, RELAY_PATH, __test: { onMessage, handlePrompt, shopCtxFor } };

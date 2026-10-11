// ── AI Receptionist routes (authed) ──────────────────────────────────────────
// Lets the shop run/re-run AI intake on a lead's call — either on the transcript
// already captured from a voicemail, or on a transcript pasted in by hand. The
// automatic path lives in routes/twilio.js (the transcription callback).
const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware');
const { shopRoute } = require('../db');
const { runIntake } = require('../receptionist/intake');
const { transcribeEnabled, transcribeCall } = require('../receptionist/transcribe');

// Build the ctx shape the intake helper expects from a shop-scoped request.
function ctxFrom(req, db, h) {
  return { shopId: req.shopId, db, h, settings: db.get('settings').value() || {}, shopName: (db.get('settings').value() || {}).shopName || 'the shop' };
}

// The call "Analyze with AI" works on: the lead's most recent conversation —
// a call with a transcript, or a recorded call a person answered (which we can
// transcribe now even if its automatic transcription failed). `calls` is
// newest-first. Falls back to the newest call.
function pickIntakeCall(calls) {
  const answeredRecording = c => !!(c.recording && c.recording.recordingSid && !c.voiceAI);
  return calls.find(c => c.transcript || answeredRecording(c)) || calls[0] || null;
}

// POST /api/shop/leads/:id/ai-intake  { transcript? }
// Runs AI intake against the lead's most recent conversation (see
// pickIntakeCall), transcribing a recorded call first when it has no transcript
// yet. force:true so an owner can always (re)analyze.
router.post('/api/shop/leads/:id/ai-intake', requireAuth, requireRole('full', 'technician'), shopRoute(async (req, res, db, h) => {
  const lead = h.getById('leads', req.params.id);
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

  const calls = h.getAll('calls').filter(c => c.leadId === lead.id)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  const pasted = req.body && req.body.transcript;
  const call = pickIntakeCall(calls);
  if (!call) return res.status(400).json({ ok: false, error: 'This lead has no call to analyze.' });

  const ctx = ctxFrom(req, db, h);
  let transcript = pasted;
  if (!pasted && !call.transcript && call.recording && call.recording.recordingSid && transcribeEnabled()) {
    // Retry path for answered calls whose automatic transcription failed (or
    // pre-dates it): transcribe now, surfacing the real error if it fails again.
    const t = await transcribeCall(ctx, call.id, call.recording.recordingSid, { retries: 2, delayMs: 1000 });
    if (!t.text) return res.status(502).json({ ok: false, reason: 'transcribe-failed', error: `Couldn't transcribe the call recording (${t.error}).` });
    transcript = t.text;
  }

  // A recorded call a person answered (not the AI receptionist) is a two-way
  // conversation → intake plus a sales-skills scorecard.
  const kind = call.recording && !call.voiceAI ? 'call' : undefined;
  const result = await runIntake(ctx, call.id, { transcript, force: true, kind });

  if (!result.ok) {
    const msg = result.reason === 'no-key'        ? 'AI is not configured. Set ANTHROPIC_API_KEY to enable.'
              : result.reason === 'no-transcript' ? 'No transcript available for this call yet.'
              : (result.message || 'Could not analyze this call.');
    return res.status(result.reason === 'no-key' ? 503 : 400).json({ ok: false, reason: result.reason, error: msg });
  }
  res.json({ ok: true, ai: result.ai, transcript: transcript || call.transcript || '' });
}));

module.exports = router;
module.exports.pickIntakeCall = pickIntakeCall;

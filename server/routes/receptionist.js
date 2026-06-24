// ── AI Receptionist routes (authed) ──────────────────────────────────────────
// Lets the shop run/re-run AI intake on a lead's call — either on the transcript
// already captured from a voicemail, or on a transcript pasted in by hand. The
// automatic path lives in routes/twilio.js (the transcription callback).
const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware');
const { shopRoute } = require('../db');
const { runIntake } = require('../receptionist/intake');

// Build the ctx shape the intake helper expects from a shop-scoped request.
function ctxFrom(req, db, h) {
  return { shopId: req.shopId, db, h, settings: db.get('settings').value() || {}, shopName: (db.get('settings').value() || {}).shopName || 'the shop' };
}

// POST /api/shop/leads/:id/ai-intake  { transcript? }
// Runs AI intake against the lead's most recent call that has a transcript
// (or the one passed in). force:true so an owner can always (re)analyze.
router.post('/api/shop/leads/:id/ai-intake', requireAuth, requireRole('full', 'technician'), shopRoute(async (req, res, db, h) => {
  const lead = h.getById('leads', req.params.id);
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

  const calls = h.getAll('calls').filter(c => c.leadId === lead.id)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  // Prefer a call that already has a transcript; else the most recent call.
  const call = calls.find(c => c.transcript) || calls[0];
  if (!call) return res.status(400).json({ ok: false, error: 'This lead has no call to analyze.' });

  const result = await runIntake(ctxFrom(req, db, h), call.id, {
    transcript: req.body && req.body.transcript,
    force: true,
  });

  if (!result.ok) {
    const msg = result.reason === 'no-key'        ? 'AI is not configured. Set ANTHROPIC_API_KEY to enable.'
              : result.reason === 'no-transcript' ? 'No transcript available for this call yet.'
              : (result.message || 'Could not analyze this call.');
    return res.status(result.reason === 'no-key' ? 503 : 400).json({ ok: false, reason: result.reason, error: msg });
  }
  res.json({ ok: true, ai: result.ai, transcript: call.transcript || (req.body && req.body.transcript) || '' });
}));

module.exports = router;

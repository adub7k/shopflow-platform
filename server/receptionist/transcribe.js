// ── Answered-call transcription (ElevenLabs Scribe) ───────────────────────────
// Voicemails are transcribed by Twilio's built-in <Record transcribe>, but the
// bridged <Dial> recording (the actual conversation) is not — so we pull the mp3
// and run it through ElevenLabs Scribe. The recording is dual-channel
// (record-from-answer-dual: caller and shop on separate tracks), so we ask Scribe
// to transcribe each channel independently and stitch the two sides back together
// in time order — giving a speaker-labelled "who said what" transcript that the AI
// intake can reason over.
//
// Best-effort: any failure just leaves the call with its playable recording and no
// transcript. The API key lives only in the ELEVENLABS_API_KEY env var (never in
// the repo); with no key set, transcribeEnabled() is false and this is inert.
const EL_KEY   = process.env.ELEVENLABS_API_KEY || '';
const EL_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const TW_SID   = process.env.TWILIO_ACCOUNT_SID || '';
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Transcription is available only when we can both fetch the recording (Twilio
// creds) and call ElevenLabs (key).
function transcribeEnabled() { return !!EL_KEY && !!TW_SID && !!TW_TOKEN; }

// Fetch a Twilio recording's mp3. Retries a few times because the recording media
// can lag the status callback by a second or two (404 until it's finalized).
async function fetchRecordingMp3(recordingSid, { retries, delayMs }) {
  const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Recordings/${recordingSid}.mp3`;
  const basic = 'Basic ' + Buffer.from(TW_SID + ':' + TW_TOKEN).toString('base64');
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(mediaUrl, { headers: { Authorization: basic } });
      if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); if (buf.length) return buf; }
      else if (r.status !== 404) return null;   // 401/403/etc → give up; 404 → not ready yet
    } catch (e) { /* transient — fall through to the retry delay */ }
    await new Promise(s => setTimeout(s, delayMs));
  }
  return null;
}

// Merge Scribe's per-channel word streams into a readable, speaker-labelled
// transcript. Each entry of `transcripts` is one recording channel; we interleave
// their words by start time so the dialogue reads in order. Channels map to
// "Speaker 1"/"Speaker 2" — which is the caller vs the shop can vary by carrier,
// so we leave it to the AI to infer roles from what's said. Falls back to blocking
// each channel's full text when word-level timings aren't present.
function stitchMultiChannel(transcripts) {
  const words = [];
  transcripts.forEach((t, ci) => {
    const label = `Speaker ${ci + 1}`;
    const ws = Array.isArray(t.words) ? t.words.filter(w => w && w.type === 'word' && w.text) : [];
    if (ws.length) ws.forEach(w => words.push({ start: Number(w.start) || 0, text: w.text, label }));
    else if (t.text) words.push({ start: ci, text: String(t.text), label });   // whole-channel fallback
  });
  if (!words.length) return '';
  words.sort((a, b) => a.start - b.start);

  const lines = [];
  let curLabel = null, buf = [];
  const flush = () => {
    if (!buf.length) return;
    lines.push(`${curLabel}: ${buf.join(' ').replace(/\s+([,.!?])/g, '$1')}`);
    buf = [];
  };
  for (const w of words) {
    if (w.label !== curLabel) { flush(); curLabel = w.label; }
    buf.push(w.text);
  }
  flush();
  return lines.join('\n');
}

// Fetch a Twilio recording and transcribe it with ElevenLabs Scribe. Returns the
// transcript text, or '' on any failure.
async function transcribeTwilioRecording(recordingSid, { retries = 4, delayMs = 2000 } = {}) {
  if (!transcribeEnabled() || !recordingSid) return '';

  const audio = await fetchRecordingMp3(recordingSid, { retries, delayMs });
  if (!audio) return '';

  try {
    const form = new FormData();
    form.append('model_id', EL_MODEL);
    form.append('use_multi_channel', 'true');   // caller + shop on separate tracks
    form.append('tag_audio_events', 'false');   // no "(laughter)" noise in a lead transcript
    form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'call.mp3');

    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY },      // fetch sets the multipart boundary itself
      body: form,
    });
    if (!r.ok) return '';
    const data = await r.json();

    // Multi-channel → { transcripts: [ {text, words}, ... ] }; single-channel or a
    // mono recording → { text, words }. Handle both; prefer the stitched dialogue.
    if (Array.isArray(data && data.transcripts) && data.transcripts.length) {
      return stitchMultiChannel(data.transcripts)
        || data.transcripts.map(t => (t && t.text) || '').filter(Boolean).join('\n');
    }
    return (data && data.text) || '';
  } catch (e) {
    return '';
  }
}

module.exports = { transcribeEnabled, transcribeTwilioRecording };

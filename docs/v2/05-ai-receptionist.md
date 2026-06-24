# 05 — AI Receptionist Module

Builds **on top of** the existing `server/routes/twilio.js` flow (do not rewrite it). Today's flow already:
logs a lead + call on every inbound call, dials the shop with whisper/screen, detects missed calls, fires an
idempotent missed-call auto-SMS, records voicemail, and converts leads to customers. V2 adds the **AI layer**.

## 1. Capability map (have vs. build)

| Capability | Status | V2 work |
|---|---|---|
| Answer / route inbound calls | ✅ exists | reuse `voice/:shopId` → whisper → screen → complete |
| Missed-call text-back | ✅ exists | reuse; enrich with AI-extracted name/service |
| Voicemail capture | ✅ exists | add transcription |
| Lead + contact + call-log auto-create | ✅ exists | reuse `upsertLeadFromCall()` |
| **Call recording of live calls** | ⚠ partial | capture `RecordingSid` on `<Dial record="record-from-answer">` |
| **Transcription** | ❌ build | Twilio transcription on voicemail + recording |
| **AI summary** | ❌ build | LLM over transcript → 3-line summary |
| **Structured intake** (service, budget, desired date) | ❌ build | LLM extraction → fields on the lead |
| **Lead-quality score** | ❌ build | rules + LLM → `hot/warm/cold` |
| **Follow-up recommendation** | ❌ build | template suggestion attached to lead |
| **AI voice answering** (full IVR) | ❌ optional/Phase 4b | Twilio `<Gather input="speech">` + LLM dialog → only if you want the AI to *talk* |

## 2. Data additions (additive, on existing collections)

```jsonc
// calls[] gains (all optional):
{
  "recordingSid": "RE…",
  "transcript": "full text…",
  "transcriptStatus": "pending|done|failed"
}

// leads[] gains an ai block (optional):
{
  "ai": {
    "summary": "Caller wants a full detail on an F-150 before next weekend; budget ~$250.",
    "serviceNeeded": "Full Detail",
    "budget": 250,
    "desiredDate": "2026-06-29",
    "quality": "hot|warm|cold",
    "followUp": "Text quote for Full Detail (truck size) + 2 weekend slots.",
    "model": "claude-haiku-4-5",
    "generatedAt": "iso"
  }
}
```
No schema break: old leads/calls simply lack `ai`/`transcript`. The CRM UI shows the AI block when present.

## 3. Pipeline

```
inbound call ──► twilio.js (existing) ──► call + lead created
      │
      ├─ accepted  ──► record-from-answer ──► RecordingStatusCallback ──► receptionist/intake.js
      └─ missed/vm ──► voicemail recorded  ──► TranscribeCallback     ──► receptionist/intake.js
                                                                          │
   receptionist/intake.js:                                               │
     1. fetch transcript (Twilio)                                        │
     2. summary.js  → LLM summary (Claude; see claude-api skill)         │
     3. extract intake fields (service/budget/date) via tool-use schema  │
     4. scoring.js  → quality + follow-up recommendation                 │
     5. write calls[].transcript + leads[].ai (idempotent by callSid)    │
     6. (optional) auto-SMS enriched text-back using extracted name/svc  ◄┘
```

- **LLM provider:** Claude (default per house style — see the `claude-api` skill before implementing).
  Use a small fast model (`claude-haiku-4-5`) with **tool-use / structured output** so intake fields come back
  as validated JSON, not free text. Summaries: same model, 3-line cap.
- **Idempotency:** key all writes by `callSid` (matches the existing missed-SMS idempotency pattern) so Twilio
  retries never double-process.
- **Graceful degradation:** if `ANTHROPIC_API_KEY` is unset, the receptionist still does everything it does
  today (lead, call log, raw transcript) and just omits the `ai` block. Nothing regresses.

## 4. CRM surfacing

- **Leads page:** lead card shows quality chip (🔥/🟡/🧊), one-line AI summary, extracted service/budget/date,
  and a one-tap "Send recommended follow-up" using `leads[].ai.followUp`.
- **Call log:** play recording/voicemail (existing `/api/shop/voicemail/:callId` proxy, extended to recordings)
  + expandable transcript.
- **Dashboard:** `missedCalls` and `newLeads` widgets already cover the surface; add a "Needs follow-up"
  attention row sourced from `leads.ai.followUp` where `status='new'`.

## 5. Cost / safety guards

- Transcribe + summarize **once per call** (idempotent); cap transcript length sent to the LLM.
- Per-shop toggle `settings.aiReceptionist.enabled` (default off until the shop opts in) — mirrors the existing
  `callTracking.enabled` flag.
- Redact obvious PII patterns from logs; never store the API key in shop DBs (env only, like Twilio creds today).

## 6. Out of scope for first cut

Full conversational AI voice answering (`<Gather input="speech">` dialog where the AI books the appointment
live) is **Phase 4b / optional** — it's a larger UX and latency surface. The first cut makes the receptionist
*understand and summarize* every call and *populate the CRM*, which is the brief's core ask, before it *speaks*.

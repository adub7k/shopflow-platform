# Staging "breakaway" — safe Twilio testing

A separate Railway environment for testing Twilio credential changes (recording,
transcripts, AI receptionist) **without any risk to Angelo's live line**.

## Why a separate environment (not just a second number)

Twilio credentials are read from the **deployment's environment**, globally — not
per shop (`server/db.js` builds `twilioClient` once at boot from
`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`; `verifyTwilio` reads `process.env` per
request). So setting the auth token to enable recording/playback affects **every**
shop in that deploy, including `mad-detailing`. A second phone number isolates the
*leads/calls/forwarding*, but **not** the credentials. True isolation = a second
Railway environment with its own env vars and its own data volume.

`staging` deploys from the **`staging`** git branch; production deploys from
`main`. They never share state.

---

## 1. Create the Railway environment

1. Railway project → **New Environment** → name it `staging`.
2. Set its **source branch to `staging`** (Settings → Service → Source → Branch).
3. Leave the start command default: `node server/index.js` (Railway injects `PORT`).
4. Add a **volume** (or accept the ephemeral disk — staging data is disposable).
   `DATA_DIR` defaults to `/data` if a volume is mounted, else `./data`.

## 2. Environment variables (staging only)

Paste these into the **staging** environment's Variables (NOT production):

| Variable | Value | Purpose |
|---|---|---|
| `JWT_SECRET` | *(fresh random string)* | auth signing — staging-only |
| `ADMIN_KEY` | *(fresh random string)* | admin endpoints — staging-only |
| `SEED_DEMO` | `true` | auto-creates the `demo-detail` test shop on boot |
| `ANTHROPIC_API_KEY` | *(your key)* | AI voicemail intake + receptionist classify |
| `RECEPTIONIST_MODEL` | `claude-haiku-4-5` | cheap/fast model for testing |
| `TWILIO_ACCOUNT_SID` | *(your Account SID)* | required for recording **playback** |
| `TWILIO_AUTH_TOKEN` | *(your Auth Token)* | recording playback + signature validation |
| `TWILIO_FROM_NUMBER` | *(your 2nd/test number, E.164)* | maps the test number to the test shop |
| `TWILIO_FROM_SHOP` | `demo-detail` | boot migration assigns the number to that shop |
| `PUBLIC_URL` | `https://<your-staging-host>` | exact staging URL (see note below) |

Initial Twilio validation: with the **hardened `verifyTwilio`** on this branch you
can leave signature validation **ON** (do NOT set `TWILIO_VALIDATE_SIGNATURE`) —
it now validates against `PUBLIC_URL` *or* the real request host, so a `PUBLIC_URL`
mismatch can't 403 the line. If you ever want to bypass validation while debugging,
`TWILIO_VALIDATE_SIGNATURE=false` is the escape hatch.

Do **not** set Stripe/Square vars — those features simply no-op when unset.

## 3. Point the test number at staging

In the **Twilio console**, for your **second/test number** → Voice → "A call comes
in" → Webhook (HTTP POST):

```
https://<your-staging-host>/api/twilio/voice/demo-detail
```

(`shopCtx` resolves `demo-detail` by slug.) Angelo's `mad-detailing` number stays
pointed at production — untouched.

---

## 4. Verify on staging (the breakaway test calls)

Log in at `https://<staging-host>/shop/demo-detail` (demo@detail.com / demo1234).

**Voicemail recording + playback + transcript + AI:**
1. Call the test number; **don't** answer the forwarded leg (let it ring out).
2. Leave a short voicemail, e.g. *"Hi, I'd like to get my Tesla ceramic coated, what's your pricing?"*
3. In **Leads**, open the new lead:
   - ▶ **Play** the voicemail → it should stream (proves the token + playback proxy).
   - The **transcript** appears, and (with `ANTHROPIC_API_KEY` set) the AI fields
     populate `lead.ai` (summary / serviceNeeded / hot-warm-cold).
4. **Ring-through check:** call again and **answer** the forwarded leg (press a key
   at the whisper) → confirm the call bridges normally and is marked *contacted*.

**Signature hardening is live** — calls should ring with validation ON. If anything
403s, check `PUBLIC_URL` matches the staging host (or temporarily set
`TWILIO_VALIDATE_SIGNATURE=false` and report it).

---

## 5. Promote to production (only after staging passes)

Once staging proves the token is safe with validation ON:
1. Merge the `verifyTwilio` hardening to `main` (production auto-deploys; behavior
   is identical for any shop without a token).
2. On **production**, set `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`, validation
   **ON** (no `TWILIO_VALIDATE_SIGNATURE`), `PUBLIC_URL=https://shopflowtech.com`
   (or unset → request host).
3. Confirm on Angelo's number: rings, voicemail plays, transcript/AI populate.
4. Keep **Settings → Call Tracking → "Auto-text missed callers" OFF** until A2P is
   registered (a live `twilioClient` otherwise falsely marks "auto-text sent").

## Local quick test (no Railway)

```
node --check server/routes/twilio.js
node test/verify-twilio.test.js   # signature hardening unit test
```

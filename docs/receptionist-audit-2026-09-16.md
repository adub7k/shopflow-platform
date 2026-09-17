# ShopFlow AI Receptionist — Deep Audit & Elite Automotive Sales Plan

**Date:** 2026-09-16 · **Scope:** `~/shopflow-platform` receptionist (prod `main`) · **Status:** audit only, no code changed

---

## 0. What actually exists (architecture map)

The receptionist is four files plus the Twilio route. Everything else in the repo is CRM.

| Layer | File | What it does today |
|---|---|---|
| Telephony entry | `server/routes/twilio.js` | Inbound call → lead upsert → either `<Dial>` the shop (fallback mode) or hand to the AI (always mode). Missed call → AI or voicemail. |
| Turn engine A ("Standard") | `routes/twilio.js` `aiGather()` + `receptionist/voice.js` `runTurn()` | Twilio `<Gather input="speech">` does STT (Google V1 `phone_call` model + hints). Each turn is one HTTP POST → one Claude call → Polly `<Say>`. |
| Turn engine B ("Streaming") | `receptionist/relay.js` | Twilio ConversationRelay websocket. Deepgram `nova-3-general` STT + hints → streamed Claude tokens → ElevenLabs TTS. Same brain as A. |
| The brain | `receptionist/voice.js` `buildSystemPrompt()` + `toolsFor()` | One ~1,500-word system prompt rebuilt every turn. Model `claude-haiku-4-5`, `max_tokens 320`, no temperature/effort set, no prompt caching. Tools: `capture_lead`, `transfer_to_human`, `end_call` (+ `check_availability`/`book_appointment` for calendar shops). |
| Grounding | `server/booking.js` `getMenu()` | Service name, price, per-size price, duration. **`description` is fetched but never put in the prompt.** |
| Knowledge | `settings.voiceAI.notes` (≤1,500 chars free text) | The only "knowledge base". No structure. |
| Post-call intake | `receptionist/intake.js` | Voicemail / answered-call transcripts → Opus structured extraction → `lead.ai`. |
| Answered-call STT | `receptionist/transcribe.js` | ElevenLabs Scribe, no custom vocabulary. |
| Voicemail STT | Twilio `<Record transcribe>` | Twilio basic transcription, **no hints at all**. |
| CRM surface | `client/js/pages/leads.js` | Shows raw `Caller:` STT lines as the transcript, `lead.ai.servicesDiscussed` as "Interested in", `serviceNeeded` as a tag. |
| Tests | `test/voice-receptionist.test.js`, `relay-smoke.test.js`, `receptionist-attribution.test.js` | Scripted stub model. They prove plumbing (tool wiring, name guard, retries), not conversation quality. Zero terminology tests. |

**Things that do not exist anywhere:** a terminology dictionary, canonical service aliases, any STT post-processing, any spelling/fuzzy correction, intent detection outside the model, a structured knowledge base, cross-call memory injection, a model-in-the-loop eval, or a pronunciation layer for TTS.

### The word pipeline, end to end

```
caller audio
  → STT (Google V1 phone_call [gather] | Deepgram nova-3 [relay])  ← hints = menu names + 30 base terms
  → raw text (no normalization, no correction, relay has NO confidence gate)
  → stored verbatim as "Caller: …" in call.transcript (owner sees garble even when AI understood)
  → Haiku 4.5 + 1,500-word prompt (no glossary; "ceramic" is ambiguous across 2 menu lines)
  → free-text tool fields (serviceNeeded / servicesDiscussed accept ANY string)
  → lead.ai.* → Leads UI "Interested in", owner email, Revenue Recovered metric
  → spoken reply → Polly <Say> plain text  |  ElevenLabs via streamed deltas, no lexicon
```

Every one of those arrows is a place a word can go wrong, and none of them has a guard.

---

## 1. PHASE 1 — System audit scores (diagnostic only)

Scoring key: 1–3 = missing/broken, 4–6 = works for the happy path, 7–8 = solid, 9–10 = elite.

| # | Category | Score | Verdict |
|---|---|---|---|
| 1 | Automotive knowledge | **3** | Only what's on the menu + two hard-coded tint stats. Nothing on VLT, legality, coating vs PPF, correction stages, detailing conditions. |
| 2 | Sales ability | **4** | Aggressive close ("offer TWO times the MOMENT you say a price") but no value-building, no discovery. |
| 3 | Lead qualification | **5** | Name + vehicle + service are enforced. Goals, timing, condition, decision-maker are not. |
| 4 | Discovery questions | **2** | Prompt asks for name and body style. That's it. Actively told to ask ONE question and move on. |
| 5 | Value building | **3** | One canned tint pitch (carbon vs ceramic). Zero for coating, PPF, detailing, correction. |
| 6 | Objection handling | **3** | One rule: "ONE attempt then offer times." No objection classification, no underlying-cause logic. |
| 7 | Price handling | **5** | Well-grounded (menu only, size-aware). But binary: tint = always quote, coating/PPF = never quote, even when the menu has a price and the caller directly asks. |
| 8 | Appointment setting | **5** | Quote-first shops get two fixed placeholder slots (Sat 10 / Mon 2) not checked against the calendar or blocked dates. Calendar shops book live correctly. |
| 9 | Conversation naturalness | **6** | Good brevity rules, honest identity, warm greeting. But rigid scripts ("who do I have the pleasure of speaking with?") and forced sequencing. |
| 10 | Context retention | **6** | Within a call: full history, fine. Across calls: **zero** — the lead record already has name/vehicle/prior summary and the prompt never sees it. Relay: a barge-in mid-generation makes the session deaf (bug B1). |
| 11 | Accuracy | **5** | Prices are accurate by construction. Product facts are two hard-coded numbers that may not match the shop's film. |
| 12 | Terminology accuracy | **3** | No dictionary, no aliases, no normalization, tool fields are free text, "Ceramic Coating" vs "Ceramic Window Tint" share a token with opposite price rules. **This is the word-error bug.** |
| 13 | Hallucination resistance | **6** | Strong on price/availability/booking (server-authoritative). Weak on services (free-text), product claims (prompt-injected stats), and a promise the system can't keep (bug B4). |
| 14 | Service recommendation logic | **2** | None. The model is not told when to recommend coating over correction, PPF vs coating, interior vs full detail. |
| 15 | Follow-up logic | **4** | `followUp` string + Response Center + owner email works. But the AI promises "I'll text you the quote" and **nothing texts the caller** (A2P off). |
| 16 | CRM integration | **7** | Best part of the system: lead upsert, `lead.ai`, attribution, revenue recovered, hot flag, Response Center all wired. Gaps: relay path skips the never-miss owner email (B2), false "captured" at turn cap (B3). |
| 17 | Error handling | **6** | Gather: excellent (retries, graceful hangup, never-miss email). Relay: retry exists, but B1/B2/B3 are real production defects. |
| 18 | Voice/transcription reliability | **4** | Gather runs Twilio's weakest STT (`phone_call`, Google V1; `enhanced` deprecated) when `deepgram_nova-3` is available on the same attribute. Hints include em-dash service names. Relay has no confidence gate. Voicemail STT has no vocabulary at all. |
| 19 | TTS/pronunciation | **5** | ElevenLabs quality is high, but "PPF", "VLT", "F-150", "4Runner", "%", "$" are at the mercy of the model's spelling; no lexicon; deltas are streamed token-by-token. Polly path is plain text, no SSML. |
| 20 | Overall production readiness | **5** | It works and books real leads. It is a good *receptionist*. It is not yet a *salesperson*, and terminology is unguarded. |

### Detail per category

**1. Automotive knowledge (3).** Works: menu grounding, vehicle-size pricing. Weak: the prompt bans "general questions/advice" so "does tint keep my car cool?" gets steered away instead of answered. Change: structured per-service knowledge (Phase 8) injected into the prompt, and an explicit "answer honest education questions in one sentence, then continue" rule. Importance: **high** — this is the whole product promise.

**2. Sales ability (4).** Works: never leaves empty-handed, name-first. Weak: the flow is *close, close, close* with no value step; "the MOMENT you mention any price… offer the TWO specific times" reads as pushy on a real call. Change: staged flow (Phase 2) with a readiness detector. Importance: high.

**3. Lead qualification (5).** Works: name, vehicle, service, body style inferred. Weak: no goal (heat vs privacy vs looks), no timeline, no condition, no "who decides". Change: per-service qualification fields in `capture_lead` (Phase 3). Importance: high.

**4. Discovery questions (2).** Nothing service-specific exists. Change: per-service question banks with a "max 2 questions before you give something back" cap. Importance: high.

**5. Value building (3).** Only the tint pitch. Change: value statements per service from the KB, spoken in ≤2 sentences, only after the goal is known. Importance: high.

**6. Objection handling (3).** Change: Phase 4 classifier (which of 5 underlying objections) + one response each + graceful exit to capture. Importance: high.

**7. Price handling (5).** Works: exact prices, per size, starting-at framing for tint. Weak: coating/PPF hard-blocked from quoting even on "just give me a number"; no "range with reasons" middle ground; no discussion of what's included. Change: three price modes per service in the KB: `quote`, `range`, `consult` — owner's choice per service. Importance: medium-high.

**8. Appointment setting (5).** Weak: `proposeSlots()` ignores `blockedDates` and existing appointments → can offer a day the shop is closed. Change: pull real open days from `computeAvailability`. Importance: medium.

**9. Naturalness (6).** Works: one-sentence rule, no lists, honest identity, warm greeting. Weak: scripted phrases repeat verbatim call after call; no style-matching. Change: Phase 5 rules, banned-phrase list, variation. Importance: medium.

**10. Context retention (6).** Weak: returning callers re-asked for name; relay deafness bug. Change: inject `lead.name/vehicle/ai.summary/servicesDiscussed` for repeat callers; fix B1. Importance: high (B1 is a live defect).

**11–13. Accuracy / terminology / hallucination.** See Phase 6 and 7. Importance: **critical** — the reported bug.

**14. Recommendation logic (2).** Nothing. Change: decision rules per service (Phase 3). Importance: high.

**15. Follow-up logic (4).** Broken promise (B4). Change: either send the quote SMS via the existing `sms:` deep-link path the owner taps, or change the promise to "the shop will text you." Importance: high (trust).

**16. CRM integration (7).** Fix B2/B3. Importance: medium.

**17. Error handling (6).** Fix B1. Importance: high.

**18. STT reliability (4).** Change: `speechModel: 'deepgram_nova-3'` on gather, clean hint phrases (strip "—", split compound names), add confidence gate on relay via the normalization layer, add vocabulary to voicemail/Scribe paths. Importance: **critical**.

**19. TTS (5).** Change: "spoken-form" rewrite of the model's reply before TTS (PPF → "P P F", 20% → "twenty percent", F-150 → "F one fifty", $450 → "four hundred fifty dollars" for Polly). Importance: medium-high.

**20. Production readiness (5).** Ship the bug fixes and the accuracy layer first; then the sales system.

---

## 2. Confirmed defects (found by reading and, for B1, by execution)

| ID | Where | Defect | Impact |
|---|---|---|---|
| **B1** | `relay.js` `handlePrompt()` lines 212, 235 | On barge-in while the model is still generating, both early `return`s skip `session.busy = false`. Every later caller utterance hits `if (session.busy) return;` and is dropped. **Reproduced with a stub**: second prompt never reached the model. | Caller talks, AI goes silent for the rest of the call. Matches the "cut out / dead air" reports. |
| **B2** | `relay.js` `finalize()` | No never-miss owner notification when the socket closes without a capture. Gather has it (`endAiCall` → `notifyNewLead('missed-call')`); relay does not. | A relay caller who hangs up mid-conversation generates no owner email. Lead silently lost. |
| **B3** | `relay.js` line 231 | Hitting the turn cap sets `ended = { outcome: 'captured' }` without calling `capture_lead`. `stampCallAttribution` then reports `outcome: 'captured'`. | False "captured" in Revenue Recovered; no `lead.ai` written; owner not told. |
| **B4** | `voice.js` prompt line 217 | "Tell them you will text the quote to the number they are calling from either way." No code sends that text (A2P is off; capture only emails the owner). | The AI makes a promise the system breaks on every quoted call. |
| **B5** | `voice.js` `proposeSlots()` | Offers `Sat 10 AM / Mon 2 PM` from the staff work-day list only; ignores `blockedDates` and existing bookings. | Can offer a closed day. |
| **B6** | `voice.js` `menuLines()` | `getMenu()` returns `description` per service; the prompt never includes it. | Owner-written service descriptions (what's included, film brand, warranty) are invisible to the AI. |
| **B7** | `voice.js` `buildSystemPrompt()` | The lead already exists (`upsertLeadFromCall`) with name, vehicle, prior `ai.summary`; none of it is injected. | Repeat callers are asked their name again; prior quote context lost. |
| **B8** | prompt line 214 | "45% heat / 95% heat / 99% UV" are hard-coded claims, not shop data. "carbon = the standard Window Tint line" is a prose mapping to a menu name that may not exist. | Product-fact hallucination by design; wrong for any shop whose films differ. |
| **B9** | prompt line 237 | "Do not answer general questions, give advice…" | Blocks the education the user wants ("is ceramic tint worth it?", "does tint keep it cool?"). |
| **B10** | `voice.js`/`relay.js` model calls | No `cache_control`; volatile fields (today, caller phone, two slots) sit at the **top** of the prompt. | Full prompt re-billed every turn; higher latency. |
| **B11** | `routes/twilio.js` `aiGather()` | `speechModel: 'phone_call'` (Google V1). Twilio Gather also accepts `deepgram_nova-3`. | Standard engine uses the least accurate STT available. |
| **B12** | `voice.js` `speechHints()` | Passes menu names verbatim: `"Window Tint — Full Vehicle"` (em-dash), `"PPF — Full Front"`. Hints should be clean spoken phrases. | Weaker keyterm biasing; the phrases as written are never actually spoken. |
| **B13** | tool schemas | `serviceNeeded`, `servicesDiscussed` are free strings. | Model can write "PPF coating", "ceramic tint" for a coating call, etc., and it lands in the CRM. |
| **B14** | `intake.js` / `<Record transcribe>` | Voicemail transcription has no vocabulary; Scribe has none either. | Voicemail leads get the worst word accuracy of all. |
| **B15** | `voice.js` `businessHours()` | Uses `staff[0].schedule` only. | Wrong hours if the first staff row isn't representative. |

---

## 3. PHASE 1b — Root cause of "getting words wrong"

There is no single cause. There are four layers, and the user sees all of them as "the AI got the word wrong." Ranked by likelihood from the implementation:

**1. STT substitution (most likely, ~50% of incidents).** Evidence: Bryce's relay calls logged "ceramic → Syringe", "window tint → windowton", "full vehicle → old vehicle" *before* hints were added. Hints reduced it but: gather still runs Google V1 `phone_call` (B11); hint phrases contain em-dashes (B12); relay has no confidence gate; and nothing rewrites the transcript, so the garbled text is both fed to the model and shown to the owner as the transcript. **"ceramic tent"**, **"paint correction → pain correction"**, **"PPF → P P F / puff / PBF"**, **"clear bra → clear bra / clear brow"** all originate here.

**2. Model-side conflation (~30%).** The prompt contains "Ceramic Coating ($600)" (never quote) and "Ceramic Window Tint ($450–600)" (always quote) with no glossary telling Haiku they are different products. On a garbled "how much for ceramic", the model must guess, and the closing rule "never leave a call empty-handed" pushes it to pick one and run. The tool schemas then let it write whatever it guessed into the CRM (B13). Haiku 4.5 at default sampling (temperature 1.0, no effort control) increases variance. This is where **"ceramic coating → ceramic tint"** and **"paint correction → paint protection"** happen.

**3. TTS rendering (~15%).** Relay streams every token delta straight to ElevenLabs with no lexicon. The model writes "PPF" → ElevenLabs may say "puff" or "P-P-F"; "4Runner" → "four runner"; "20%" is fine with normalization on, but "5%" in a list can be read "five". The Polly path gets plain text; "PPF" is usually spelled out, but "VLT" and model names are unpredictable.

**4. Display (~5%).** Even when the model understood, the owner reads `Caller: how much for ceramic tent` in the Leads UI and reports "wrong words." A display-side normalization would remove this class entirely.

**Ruled out:** context loss within a call (full history is sent), tool output (server data is exact), model config *as the primary cause* (it amplifies layer 2, doesn't create layer 1), spelling logic (none exists), knowledge (menu is exact; product facts are the issue, not spelling).

**What I need from you to split layers 1 and 2 precisely:** 5–10 real transcripts where a word was wrong (Leads → call → transcript, or the admin shop report's "best transcripts"). If the `Caller:` line is wrong → layer 1. If the `Caller:` line is right and the `AI:` line is wrong → layer 2 or 3.

---

## 4. PHASE 2 — Sales audit

**Current flow, as the prompt enforces it:**
1. Greet → 2. get first name → 3. (tint only) two-sentence carbon/ceramic pitch → 4. starting-at prices → 5. offer two fixed times + promise a text → 6. read-back → 7. capture → hang up.

For coating/PPF: skip 3–4, say "depends on paint, come in", then 5–7. For detailing/correction: nothing service-specific at all.

**Against the ideal 14-step flow:**

| Ideal step | Present? | Notes |
|---|---|---|
| 1 Why they called | partial | Implicit from first utterance; never confirmed. |
| 2 Identify vehicle | yes | Good; body-style inference. |
| 3 Identify service/problem | partial | Service yes; *problem* (swirls? heat? resale?) never. |
| 4 Discovery questions | **no** | Banned by "ask ONE question then stop" + "don't list options." |
| 5 Customer priorities | **no** | |
| 6 Educate | **no** (tint only) | B9 actively prevents it. |
| 7 Build value | tint only | |
| 8 Present option | partial | Both tint levels; nothing else. |
| 9 Price when appropriate | rigid | Always for tint, never for coating/PPF. |
| 10 Objections | minimal | One attempt. |
| 11 Ask for appointment | yes, too early | Fired the moment a price is spoken. |
| 12 Confirm details | yes | Read-back rule is good. |
| 13 Reduce friction | partial | "Shop confirms" is friction-reducing; broken text promise is not. |
| 14 End naturally | yes | closingLine + FAREWELL. |

**Verdict:** the current system is a good *capture* script, not a *sales* process. It skips the four steps (discovery, priorities, education, value) that separate a rep from a form.

**The balance rule I recommend (goes into the prompt as a hard rule):**

> Before answering a price question, ask **at most two** clarifying questions, and only ones that change the answer (vehicle and coverage for tint; paint condition and goal for coating/correction; interior condition for detailing; vehicle use and coverage for PPF). If the caller already gave those, or says "just give me a number," give the number immediately. Never ask a third question before you've given the caller something back.

**Readiness signals → stop selling, book:** "yeah let's do it", "when can you get me in", "how do I book", "what do you need from me", "I'm free Saturday", repeats the price back without objection, asks about deposit/duration/drop-off. On any of these: skip remaining discovery, confirm, capture.

**Stop-selling signals → just answer:** hours, location, "do you do X", "how long does it take", "is it worth it" — answer in one sentence, then a light "want me to check what it'd run for your car?" once, not twice.

---

## 5. PHASE 3 — Service-specific sales intelligence

Each block below is written to become a `knowledge` entry (Phase 8) and a prompt section. Facts marked ⚠️ must come from the shop, not the prompt.

### 5.1 Window tint

**Understands:** heat rejection (ceramic ≫ carbon ≫ dyed on infrared), UV (all decent films ~99%), glare, privacy, looks, fading/purpling (dyed), VLT % = light let in (5% limo, 15–20% dark, 35% common, 50%+ light), coverage zones (front two, rear/back glass, full sides+rear, windshield, windshield strip/visor, sunroof, panoramic roof), factory privacy glass on trucks/SUVs (rear already dark → front-match), legality (⚠️ per state; NM shop → shop provides its legal-front-VLT guidance), removal of old film costs extra, cure/no-roll-down window (⚠️ shop's days).

**Discovery (pick ≤2):**
- "Is this mostly for heat, privacy, the look, or all three?"
- "What are we tinting: the sides and back, or the windshield too?" (if SUV/truck: "Does it already have the dark factory glass in the back?")
- "Any old tint on it now?"
- "How dark are you thinking, or do you want a recommendation?"

**Value statements (one at a time):**
- Heat: "Ceramic is the one that actually changes how the cabin feels — it blocks the infrared heat, not just the light, so you can go lighter and still stay cooler."
- Legal + look: "Most people match the factory rear and go legal on the fronts so it looks even and you're not getting pulled over."
- Dyed vs ceramic: "Dyed film is cheaper up front and looks the same on day one — the difference shows up in year two when it purples and in July when it doesn't block heat."

**Qualification logic:** vehicle → coverage → goal → level. If goal = heat or "hot car/black interior" → recommend ceramic. If goal = privacy/looks only and budget-sensitive → carbon is a fair answer. Windshield/panoramic asked → note it's a separate line item (⚠️ price) and legality (⚠️).

**Upsells / cross-sells:** windshield strip or full windshield (ceramic clear/70%), sunroof, tint removal, ceramic coating on glass (⚠️ if offered), "while it's here" maintenance detail.

**Common objections:** "cheaper down the street" (film grade + warranty + install quality), "too dark is illegal" (offer legal front + darker rear), "does tint keep it cool" (yes for ceramic, marginal for dyed), "ceramic worth it?" (if heat matters, yes; if not, carbon).

**Booking language:** "Tint's usually a [⚠️ N-hour] job — you can drop it or wait. I've got [day] or [day]; which is easier?"

### 5.2 Ceramic coating

**Does:** hard sacrificial layer over clear coat → gloss, hydrophobic (water beads/sheets, dirt releases), easier washing, chemical/UV/bird-dropping/water-spot resistance, keeps paint looking new longer. Durations ⚠️ (1-yr / 3-yr / 5-yr+ tiers per shop). **Does NOT:** stop rock chips, prevent scratches/swirls, make the car never need washing, fix existing swirls (that's correction). Requires prep: wash, decon (iron/clay), paint correction (at least one-step) before coating — the correction is most of the labor and why price varies with paint condition. Maintenance: pH-neutral wash, no automatic brush washes, occasional topper (⚠️ shop's maintenance plan).

**Discovery (≤2):**
- "Is the car new, or has it been driven a bit — any swirls or scratches you can see in the sun?"
- "What's the goal: keep it looking new, easier to wash, or protect resale?"
- "Garage-kept or outside most of the time?"

**Value framework:** goal-first. New car → "lock it in before the first swirl." Daily driver → "wash time drops, water beads off, bird droppings wipe off instead of etching." Resale → "paint condition is the first thing a buyer sees."

**Price conversation:** owner picks `quote` / `range` / `consult` per tier. Recommended: *range with reason* ("on a sedan with paint in decent shape it usually lands around [⚠️ low]–[⚠️ high]; where it lands depends on how much correction the paint needs, which takes us two minutes in person"). Hard block only if the owner chose `consult`.

**Correction/coating bundling logic:** coating always includes at least one-step prep. If the caller mentions swirls/scratches → two-step likely → set the expectation now ("that moves it into the two-step correction tier"). If the caller says "I just want the coating, no polishing" → explain the coating locks in whatever is under it.

**Objections:** "too expensive" → what it replaces (waxing every 3 months for years), and the tiers. "I can do it myself with a spray" → consumer spray coatings last months, not years; prep is the difference. "Will it stop rock chips?" → **no**, that's PPF; offer the combo.

**Booking:** "Coating is a [⚠️ 1–2 day] job. Easiest is a quick look so we quote it right — got 10 minutes [day] or [day]?"

### 5.3 PPF

**Protects against:** rock chips, road debris, bug etching, light scratches (self-healing top coat on heat), swirls from washing on covered panels. Zones: partial front (bumper, partial hood, partial fenders, mirrors), full front (full hood, full fenders, bumper, mirrors), track pack (+ rockers, A-pillars, roof edge), full body. High-impact areas: bumper, hood leading edge, mirrors, rockers, door cups, door edges, rear bumper ledge. "Clear bra" = PPF (older term). Prep: paint must be corrected before film or defects are sealed under it. PPF vs coating: PPF = impact protection, coating = chemical/gloss/ease. Together: film on the front, coating over everything (including over the film) — the premium combo. Film brand/warranty ⚠️.

**Discovery (≤2):**
- "How much highway driving — is this a daily commuter or more of a weekend car?"
- "Are you thinking just the front end where the chips hit, or more coverage?"
- "New car, or does it already have some chips we'd need to address?"

**Value:** "The front of a car on the highway is basically sandblasted over a few years — PPF takes that instead of your paint, and it heals the little scratches with heat."

**Package recommendation logic:** commuter/highway → full front minimum. Truck/SUV → add rockers. New high-value car → full front + coating. Already chipped → correction/touch-up first, be honest that film doesn't hide chips. Budget-sensitive → partial front (bumper + partial hood) as an entry point.

**Objections:** "too expensive" → cost of one bumper respray vs film. "Will it protect against scratches?" → light ones yes and it self-heals; key scratches no. "Can you see it?" → edges on a good install are nearly invisible (⚠️ shop's wrapped-edge policy). "I already have ceramic" → fine, PPF goes on after light prep; different job.

**Cross-sell:** coating over PPF; tint (same visit); interior protection.

**Booking:** "PPF is a multi-day job [⚠️], so we usually look at the car first. Can you swing by [day] or [day] for a quick look and a firm number?"

### 5.4 Auto detailing

**Understands:** interior (vacuum, shampoo/extraction, leather clean+condition, plastics, glass, headliner spot-clean) vs exterior (wash, decon, wax/sealant, tires/trim) vs full. Maintenance detail = regular light interior/exterior for a car kept clean. Deep clean = neglected interior. Condition drivers: pet hair (big labor add), stains, odor (smoke/mildew → ozone/enzyme), sand, kids' seats, mold. Condition-based pricing is legit — say so plainly.

**Discovery (≤2):**
- "Inside, outside, or the whole thing?"
- "How's the inside right now — pretty clean, or has it been a while? Any pet hair, stains, or smell?"
- "Sedan, SUV, or truck?"

**Condition assessment → tier:** "pretty clean" → maintenance/standard; "been a while / kids / pets / smoke" → deep/full + add-ons (pet hair, odor, extraction). Owner's menu decides names.

**Priority detection:** "smell" → odor is the sale; "selling it" → full + light exterior for photos; "new baby" → interior sanitize; "just want it to shine" → exterior + wax/sealant.

**Pricing conversation:** quote the base tier for the size, then name the add-on that applies: "Full detail on an SUV starts at [$], and heavy pet hair is usually an extra [⚠️ $]. Sound about right for yours?"

**Objections:** "car wash is $30" → hours vs minutes; "I can vacuum myself" → extraction and decon are the difference; "too expensive" → offer the interior-only or maintenance tier.

**Upsells:** engine bay, headlight restore, odor treatment, sealant/1-yr coating, seat protection; recurring maintenance plan.

**Booking:** "That's about a [⚠️ N]-hour job. I've got [day] morning or [day] afternoon — which works?"

### 5.5 Paint correction

**Understands:** one-step (polish, removes 50–70% of swirls, adds gloss) vs two-step (compound then polish, removes most defects; heavier, pricier) vs spot/wet-sand for deep scratches. Defects: swirls (wash-induced), oxidation (chalky, faded), water spots (etched minerals), scratches (fingernail test: catches → likely too deep to polish out), holograms. Gloss restoration is the promise; **it does not add protection** — coating/sealant after is what keeps it. Clear coat is finite; correction removes microns; can't repeat forever.

**Discovery (≤2):**
- "What are you seeing — swirls in the sun, scratches, or is the paint dull/faded?"
- "Does a fingernail catch in the scratch?"
- "Are you planning to protect it after with a coating, or just bring the shine back?"

**Education (one sentence each):** "Swirls come from washing — a one-step polish takes most of them out." "If your nail catches, that's through the clear coat; polishing won't remove it but we can make it much less visible." "Correction makes it look new; a coating keeps it that way."

**Expectation management:** never promise 100% removal; "most" for one-step, "nearly all" for two-step; deep scratches → "improve, not erase."

**Pricing:** tier by size + condition; range with reason; in-person look for two-step.

**Objections:** "why not just wax it" → wax fills, correction removes; "I'll just get it repainted" → correction is a fraction of that if the clear coat is intact.

**Coating cross-sell (strong):** "Honestly, if you're paying for correction, coating it after is the smart move — otherwise the swirls come back in a few months of washing." Bundle → the coating tier that includes the correction level.

---

## 6. PHASE 4 — Objection handling

**Classifier first, response second.** The model tags every objection with one of five underlying causes and must respond to the cause, never argue:

| Cause | Tell-tales | Response strategy |
|---|---|---|
| **A. Can't afford right now** | "payday", "next month", "tight right now" | Validate, offer the lower tier or a later date, capture with a follow-up date. Never discount. |
| **B. Doesn't see the value** | "that's a lot for tint", "just windows" | One value sentence tied to *their stated goal*, then the two options. |
| **C. Comparing competitors** | "found someone cheaper", "other shop said" | Ask what film/what's included (politely); state ours (⚠️ film grade, warranty, correction included). No trash talk. |
| **D. Doesn't trust yet** | "never heard of you", "how long you been around", "reviews?" | ⚠️ shop facts (years, reviews, warranty), offer the in-person look. |
| **E. Doesn't understand what's included** | "what do I get for that", "why is coating $X" | Explain what's in the price in one sentence (prep, correction, product, warranty). |

**Rules:** one response per objection, max two total in a call; never ask budget; never offer a discount; after two, capture with a texted-quote follow-up and end warmly.

**Specific objections:**

| Objection | Likely cause | Response (spoken, one breath) |
|---|---|---|
| "That's too expensive." | B/A/E | "Totally fair — most of that is the [correction/film grade/labor hours]. Is it the number itself, or were you expecting something different to be included?" → route A/B/E. |
| "I found someone cheaper." | C | "Could be a fair deal — do you know what film they're using, and does it come with a warranty? Ours is [⚠️] with [⚠️]. If it's close, I'd still love a look at the car." |
| "I need to think about it." | B/D | "Of course. What's the main thing you're weighing?" (one ask) → "I'll have the shop text the details so you have it in writing." Capture as warm. |
| "I need to talk to my husband/wife." | D/A | "Makes sense — want me to have the shop text the quote so you can show them? What day would work if they're on board?" Capture with tentative day. |
| "Can you do it cheaper?" | A/B | "I can't change the price from here, but I can get you the right tier — [lower option] would be [$]. Would that fit better?" |
| "How long does it take?" | not an objection | Answer from menu duration; offer drop-off/wait; move to booking. |
| "What's the cheapest option?" | A | Give it straight (menu min for their size), then one sentence on what the next tier adds. |
| "I only want tint." | not an objection | "You got it — [tint questions]." Do not cross-sell. |
| "I don't need ceramic coating." | B or just no | "No problem." Stop. Continue with what they want. |
| "I'll call you back." | A/D | "Sure — can I grab your name so the shop knows who's calling, and I'll have them text you the quote?" Capture. |
| "I need to wait until payday." | A | "Totally fine — when's that? I can pencil in the week after and the shop will confirm." Capture with date. |
| "Can you just give me a price?" | E/impatience | Give it now (base for their size, starting-at). No further questions first. |
| "I already have ceramic coating." | context | "Perfect — then PPF/tint/maintenance is the natural next step; the coating stays." |
| "I already have PPF." | context | "Nice. Coating over it keeps the film and paint slick; or tint/detail." |
| "Is ceramic tint worth it?" | education | "If heat is the goal, yes — it blocks the infrared. If it's just looks/privacy, carbon does the job for less." |
| "Does tint keep my car cool?" | education | "Ceramic noticeably; dyed barely. It won't make it cold, it keeps it from being an oven." |
| "Will PPF protect against scratches?" | education | "Light ones yes, and it self-heals with heat. Deep scratches and keys, no." |
| "Will ceramic coating protect against rock chips?" | education | "No — that's PPF's job. Coating is gloss, chemical, and easy-wash protection. A lot of people do both." |

---

## 7. PHASE 5 — Human-like conversation rules

Explicit rules for the prompt (replace the current "ONE sentence" block):

1. **Length matches input.** Short question → one sentence. Explanation asked → two, max three. Never a paragraph.
2. **Mirror the caller.** Casual → casual ("yeah, no problem"). Formal → formal. Slang is fine to *understand*, don't imitate it awkwardly.
3. **Banned phrases:** "Absolutely!", "Great question", "I'd be happy to", "Certainly", "As an AI", "who do I have the pleasure of speaking with", "I understand your concern", any sentence starting "Great,".
4. **Never repeat a sentence you've already said** in this call. Vary confirmations.
5. **Never re-ask** anything in history or in the lead record. If unsure, confirm ("the Tacoma, right?") instead of re-asking.
6. **One question per turn.** Two only when they're naturally paired ("sedan or SUV, and is it inside, outside, or both?").
7. **Give before you take.** Never ask a second qualifying question without having said something useful first.
8. **Answer the literal question first**, then steer. ("Yes, we do PPF. Front end or more?")
9. **Enthusiasm is quiet.** No exclamation marks except the greeting and the goodbye.
10. **Recognize readiness** (list in §4) and stop selling immediately.
11. **Recognize "just tell me"** and drop the sequence.
12. **Numbers in speech:** write prices in words for TTS ("four fifty" is fine informally: "starts at four fifty"), percentages in words, acronyms spaced ("P P F") or expanded ("paint protection film") on first use.
13. **Name once early, once at the end.** Not every sentence.
14. **Silence is OK.** After a price, stop talking. Let them react.
15. **If you don't know, say so** and offer the shop. No fillers.

---

## 8. PHASE 6 — Accuracy / word-error system

### Recommendation: yes to all of these, in this hierarchy

**Architecture (where correction happens):**

```
Speech → STT (best model + clean hints)
       → [NEW] normalize.js: deterministic text normalization
             1. exact alias table  (ceramic tent → ceramic tint)          confidence 1.0
             2. phonetic/fuzzy match against the shop's vocabulary          0.6–0.9
             3. context rule (last AI question was about coating → "ceramic" = coating)
             4. tag, don't replace, below threshold: "ceramic [tint?|coating?]"
       → [NEW] intent + entity extraction (service, vehicle, coverage, goal) — canonical IDs
       → model (sees BOTH raw and normalized text, plus the glossary)
       → tool calls with ENUM service IDs (strict schema)
       → [NEW] speak.js: spoken-form rewrite (PPF → "P P F", 20% → "twenty percent")
       → TTS
       → transcript stored as raw + normalized; UI shows normalized, raw on hover
```

**Components:**

| Component | Build? | Detail |
|---|---|---|
| Terminology dictionary | **Yes** | One file `server/receptionist/vocab.js`: canonical terms, aliases, known STT garbles, spoken forms. Industry-level (shared) + shop-level (menu names + owner-added). |
| Canonical service names | **Yes** | Every menu service gets a `canonical` slug (`tint.ceramic.full`, `coating.ceramic.3yr`, `ppf.full_front`, `detail.full`, `correction.two_step`). Tools accept only these. |
| Fuzzy matching | **Yes, bounded** | Double-metaphone + Damerau-Levenshtein against vocab only (not English). Threshold ≥0.85 auto, 0.6–0.85 tag. |
| Context-aware correction | **Yes** | "ceramic" alone resolves by (a) last AI question, (b) services already discussed, (c) menu (if only one ceramic product exists). Never by default assumption. |
| STT post-processing | **Yes** | The normalize step above. Runs on gather and relay text before the model, and on voicemail/Scribe transcripts before intake. |
| Vocabulary injection | **Yes, fix it** | Clean hint phrases (no em-dashes, split compound names into spoken forms), add makes/models common in the shop's market, add VLT numbers as phrases ("five percent", "thirty five percent"). |
| Entity normalization | **Yes** | Vehicle: year/make/model → size class via a lookup table (200 common models) with model fallback. Coverage: "fronts", "front two", "the two front" → `coverage.front_two`. VLT: "5", "five", "limo" → 5. |
| Service aliases | **Yes** | clear bra → PPF; paint coating → ceramic coating; tint film/window film → window tint; buff/polish → correction; shampoo → interior detail. |
| Confidence thresholds | **Yes** | STT confidence (gather) + fuzzy score (both). Below 0.6: confirm. |
| Confirmation logic | **Yes** | The model is told: when a term is tagged `[?]`, confirm in the reply naturally ("ceramic *coating* for the paint, or ceramic *tint* for the windows?"). |
| Human escalation | exists | `transfer_to_human` — add trigger: 2 failed confirmations of the same term. |
| Logging | **Yes** | `call.voiceAI.corrections[] = {raw, normalized, method, score, confirmed}`; an admin view of the most frequent garbles per shop → feeds the alias table. |
| Automated tests | **Yes** | Terminology suite (§11) runs deterministic normalize tests with no API; conversation suite runs against the real model. |

**Safe correction hierarchy (never blind autocorrect):**

1. **Never** rewrite a word that is already a valid vocab term.
2. **Auto-replace** only from the explicit alias table (human-curated, from logs) or fuzzy ≥0.85 against a *single* candidate.
3. **Tag** when 0.6–0.85, or when two candidates tie (ceramic tint vs coating) → model must confirm.
4. **Leave alone** below 0.6.
5. **Protected pairs** — these are never cross-mapped by fuzzy matching, only by explicit context: `ceramic coating ↔ ceramic tint`, `paint correction ↔ paint protection`, `PPF ↔ PPF+coating`, `window tint ↔ window treatment`, `full front ↔ full body`, `one-step ↔ two-step`.
6. The model always receives the raw line too, so a bad normalization can be overridden by common sense.

**Where it lives:** normalization is deterministic Node code (no model call) so it costs nothing and is testable offline. Entity extraction can start as regex/table and later become a small structured-output call if needed.

---

## 9. PHASE 7 — Hallucination prevention rules

**Server-enforced (not just prompted):**
- Prices: only from `getMenu()`; the reply text is scanned for `$` amounts / spoken amounts and any number not in the menu for that service+size fails the turn → regenerate with a warning (one retry, then "the shop will confirm the price").
- Services: tool `serviceId`/`servicesDiscussed` are enums of canonical IDs; anything else is rejected by `strict: true`.
- Availability/times: only from `computeAvailability`; `proposeSlots` fixed (B5).
- Discounts: reply scan for "discount / off / % off / deal / special" → fail-turn unless the KB has a `promotions` entry.
- Warranty / brands / durations: only from the KB fields; absent → the model is told the field is "not provided — say the shop will confirm."
- Legal claims: only the KB `legal` field; absent → "I'd have the shop confirm what's legal for the front windows here."

**Prompt rules (short, positive, grouped):**
- "Facts you may state: the SERVICE MENU, the KNOWLEDGE entries below, and the caller's own words. Anything else — brands, warranties, durations, legal limits, promotions, availability — say you're not sure and the shop will confirm. Not knowing is fine; guessing is not."
- "If a knowledge field says *not provided*, do not fill it from general knowledge."
- "When the caller asks something the shop hasn't provided, answer with the general principle only if it's universally true of the service (e.g., coatings don't stop rock chips), never with a number, brand, or promise."

**Fallback ladder:** exact answer → general principle without numbers → "shop will confirm" + capture → transfer_to_human.

---

## 10. PHASE 8 — Sales knowledge base

**What I need from you (per shop, per service).** Owner fills in the UI; blanks mean the AI says "not provided."

```jsonc
// settings.knowledge.services[] — one per canonical service
{
  "id": "coating.ceramic.3yr",              // canonical, links to menu serviceId(s)
  "menuServiceIds": ["s4"],
  "displayName": "3-Year Ceramic Coating",
  "spokenName": "three year ceramic coating",
  "aliases": ["ceramic", "paint coating", "coating", "nano coating"],
  "category": "coating",                     // tint | coating | ppf | detail | correction
  "description": "…what it is, in one line…",
  "includes": ["wash + decon", "one-step correction", "coating application", "cure"],
  "benefits": ["gloss", "hydrophobic", "easier washing", "UV/chemical protection"],
  "limitations": ["does not stop rock chips", "does not remove existing scratches"],
  "pricing": {
    "mode": "range",                          // quote | range | consult
    "bySize": { "sedan": [800, 1200], "suv": [1000, 1400], "truck": [1100, 1600] },
    "drivers": ["paint condition", "correction level"],
    "deposit": 50
  },
  "options": [{ "name": "5-year", "delta": "+$400" }],
  "packages": [{ "name": "Correction + Coating", "ids": ["correction.two_step", "coating.ceramic.3yr"] }],
  "addons": [{ "name": "Wheels off + coated", "price": 150 }],
  "faqs": [{ "q": "How long does it last?", "a": "About 3 years with proper washing." }],
  "objections": [{ "trigger": "too expensive", "response": "…" }],
  "competitorComparison": "We use [brand]; many shops skip the correction step.",
  "warranty": "3 years against fading/peeling, requires annual inspection",
  "duration": { "hours": 8, "dropOff": true, "days": 1 },
  "preparation": "Arrive with a mostly empty car; no wash needed.",
  "aftercare": "No washing for 7 days; hand wash only after.",
  "legal": null,
  "bookingRequirements": ["in-person look for two-step", "deposit"],
  "vehicleConsiderations": ["matte paint needs matte-specific coating", "no coating over failing clear coat"],
  "recommendWhen": ["new car", "daily driver", "wants easy washing"],
  "doNotRecommendWhen": ["wants chip protection (→ ppf)", "clear coat failing"],
  "crossSell": ["ppf.full_front", "tint.ceramic.full"],
  "brands": ["Gtechniq Crystal Serum Light"]   // optional; blank → never named
}

// settings.knowledge.shop — shop-wide
{
  "yearsInBusiness": 6, "reviewSummary": "4.9 stars, 300+ Google reviews",
  "hours": "…", "location": "…", "parking": "…", "mobile": false,
  "paymentMethods": ["card", "cash", "financing via …"],
  "cancellationPolicy": "…", "warrantyGeneral": "…",
  "legalTintFront": "20% VLT front sides in NM",  // owner-provided, never inferred
  "filmBrands": { "carbon": "…", "ceramic": "…" }, "ppfBrand": "…",
  "cureDays": { "tint": 3, "coating": 7 },
  "promotions": [],                                // empty = the AI never mentions deals
  "assistantStyle": "casual"                        // casual | professional
}
```

**Maintainability across ShopFlow clients:** ship an **industry template** (`server/knowledge/templates/detail.json`, `tint.json`) with every field pre-written as *general principles* and every shop-specific field blank. Onboarding = owner fills blanks in Settings → Knowledge. The prompt renders only filled fields. Templates are versioned so an improvement ships to every client on deploy without touching their data.

**Minimum viable fill per shop (what to ask Angelo tomorrow):** for each menu service: pricing mode, what's included, duration, warranty, brand (or "don't name it"), and the front-window legal VLT they tell customers. That's ~15 minutes.

---

## 11. PHASE 9 — Test suite

### 11.1 Conversation tests (36)

Format: **Persona · Input(s) → Expected behavior · FAIL if…**

1. **Easy buyer, tint.** "Hey, I want ceramic tint on my 2022 Camry, when can you get me in?" → Recognizes readiness; confirms coverage (sides+rear?) in one question max; quotes ceramic starting-at for sedan; offers real open days; captures as `booked`. FAIL: asks goal/level questions; delays price; offers a blocked day.
2. **Price-only, Model 3.** "How much is ceramic tint for a Model 3?" → One clarifier (windshield/roof included?) OR gives the sedan starting-at immediately if the caller sounds impatient; never a bare "$599, want to book?" FAIL: three questions before a number; quotes coating price.
3. **"Just give me a price."** "Dude I just want a number for a full detail on a Tahoe." → Immediate SUV full-detail price, one sentence on add-ons, then a soft booking ask. FAIL: any discovery question first.
4. **Confused, doesn't know service.** "My paint looks dull and I want it to shine again and stay that way." → Identifies correction + coating; explains in two sentences; asks one condition question. FAIL: recommends tint or detailing; quotes without asking condition.
5. **Ceramic ambiguity.** "How much for ceramic?" → Clarifies: "ceramic *coating* for the paint, or ceramic *tint* for the windows?" FAIL: picks one silently.
6. **STT garble 1.** "how much for ceramic tent on a four runner" → Normalizer maps tent→tint, four runner→4Runner (SUV); AI proceeds with ceramic tint SUV. Transcript shows normalized. FAIL: "we don't offer tents"; asks size when 4Runner known.
7. **STT garble 2.** "do you do pain correction" → maps to paint correction; AI asks what they're seeing. FAIL: maps to paint protection.
8. **STT garble 3.** "I want P P F on the front end" / "puff on the front" → PPF full front. FAIL: "PPF coating" anywhere in reply or CRM.
9. **STT garble 4.** "clear brow for my truck" → clear bra → PPF. FAIL: unknown-service path.
10. **Protected pair.** "I already have ceramic coating, do I still need tint?" → Does not conflate; answers tint on its own merits. FAIL: says "you already have ceramic tint."
11. **Price shopper, competitor.** "The other shop quoted me $250 for full tint." → Cause C; asks film/warranty politely; states ours; invites the look. FAIL: matches price, disparages competitor, offers discount.
12. **Too expensive, vague.** "That's too much." → Asks the one diagnostic ("the number, or what's included?"); routes; max two attempts; captures warm. FAIL: asks budget; discounts; argues.
13. **Payday.** "Can't till the 1st." → Cause A; captures with a follow-up date; no pressure. FAIL: pushes the two times anyway.
14. **Spouse.** "Gotta ask my wife." → Offers texted quote to show her; tentative day. FAIL: "what would it take to decide today?" pressure.
15. **Angry customer.** "You people never answer the phone, I've called three times." → Apologizes once, sincerely; asks name; transfer_to_human with reason. FAIL: sells; explains it's an AI at length; loops.
16. **Wants a human immediately.** "Is this a robot? Let me talk to a person." → Honest identity; transfer_to_human within one turn. FAIL: keeps qualifying.
17. **Slang.** "Yo what y'all charge to blackout the fronts on a Charger?" → Understands front-two windows, dark VLT; mentions legal front VLT from KB (or "shop will confirm what's legal"); quotes front-two price. FAIL: doesn't understand; lectures.
18. **Changes mind.** Tint → "actually forget tint, what about coating?" → Drops tint, no re-asking name/vehicle; coating discovery. FAIL: re-asks vehicle; keeps offering tint slots.
19. **Multiple services.** "Tint, PPF front, and coating on a new Model Y." → Handles all three; no bundled single total; suggests in-person look given PPF+coating; captures with all three in `servicesDiscussed` as canonical IDs. FAIL: one bundled number; drops a service.
20. **Repeat caller.** Lead already has name "Marcus" + "2021 Tacoma" + prior tint quote → Greets by name, references the Tacoma, doesn't re-ask. FAIL: "can I get your name?"
21. **Education only.** "Does tint actually keep the car cooler?" → Answers honestly in one or two sentences; one light offer; if declined, ends warmly. FAIL: refuses as "general question"; hard pitch.
22. **Coating vs rock chips.** "Will ceramic coating stop rock chips?" → "No, that's PPF." Offers combo. FAIL: says yes or "helps with chips."
23. **PPF scratches.** "Will PPF stop scratches?" → light yes, deep no, self-heal explained. FAIL: absolute yes.
24. **Legal tint question with blank KB.** "What's the darkest I can legally go?" and `legalTintFront` empty → "I'd have the shop confirm what's legal here; most go [darker] on the rear." FAIL: states a percentage.
25. **Off-menu adjacent.** "Do you do headlight restoration?" (not on menu, detail shop) → "Not listed, but the shop may — I'll note it and have them confirm." Captures. FAIL: invents a price; flat "no."
26. **Off-menu unrelated.** "Do you fix transmissions?" → Polite no, closest service, end. FAIL: captures as a lead for transmission work.
27. **Windshield/panoramic.** "Can you tint the windshield and the glass roof on my Model 3?" → Identifies as separate items; legal note from KB; price mode per KB. FAIL: includes in "full vehicle" price.
28. **Detailing condition.** "Interior detail for a minivan, kids destroyed it, there's goldfish everywhere." → Deep tier + extraction; asks about pet hair/stains only if not stated; quotes SUV/XL base + add-on. FAIL: quotes maintenance tier.
29. **Odor.** "Car smells like smoke, can you get it out?" → Odor treatment as the sale; realistic expectation ("greatly reduce, sometimes fully"). FAIL: guarantees removal.
30. **Correction expectation.** "There's a scratch my nail catches in, can you polish it out?" → Honest: likely through clear coat; improve not erase; suggest look. FAIL: promises removal.
31. **Interrupts (relay).** Caller talks over the AI's price sentence with "wait, what was the first number?" → AI stops, answers. FAIL: session goes deaf (B1).
32. **Turn cap.** 12+ turns of chit-chat → wraps up with a real capture_lead, not a silent 'captured'. FAIL: B3.
33. **Hangup mid-call (relay).** Caller hangs up after giving name + service → owner gets an email with what was gathered. FAIL: B2.
34. **Silence/noise.** Two silences → graceful end + owner email. (Exists; keep as regression.)
35. **Fleet.** "I've got six work trucks that need tint." → Recognizes fleet; doesn't quote 6×; captures as fleet with `isFleet`; shop follows up. FAIL: multiplies a price.
36. **Ready mid-discovery.** AI asks goal; caller: "Just book me Saturday, ceramic, whole car." → Stops discovery, confirms, captures booked. FAIL: asks remaining questions.

### 11.2 Terminology accuracy suite (deterministic, no API)

Each row: heard → expected canonical (or tag). Runs against `normalize.js`.

| Heard (STT) | Expected | Action |
|---|---|---|
| ceramic tent | ceramic tint | auto |
| ceramic ten | ceramic tint | auto |
| sir amic tint | ceramic tint | auto |
| syringe tint | ceramic tint | auto (logged garble) |
| carbon tent | carbon tint | auto |
| died tint / dye tint | dyed tint | auto |
| windowton / window ton | window tint | auto |
| window treatment | window tint | **tag** (protected) |
| tent film | tint film | auto |
| visor strip / sun strip / eyebrow | windshield strip | auto |
| front windshield | windshield | auto |
| the two fronts / fronts / front two | front two windows | auto |
| back glass / rear glass | rear windshield | auto |
| pano roof / glass roof / moonroof | panoramic roof / sunroof | auto |
| V L T / vlt / villa tea | VLT | auto |
| five percent / limo / 5 | VLT 5 | auto |
| thirty five / 35 | VLT 35 | auto (only in tint context) |
| ceramic (alone) | — | **tag**: coating vs tint |
| ceramic coding / ceramic coat | ceramic coating | auto |
| paint coding / paint coating | ceramic coating | auto |
| nano coating / glass coating | ceramic coating | auto |
| hydro phobic / hydrophobic | hydrophobic | auto |
| pain correction / paint correction / paint connection | paint correction | auto |
| paint protection (alone) | — | **tag**: PPF vs coating |
| paint protection film / P P F / PPF / puff / PBF / PFF | PPF | auto |
| PPF coating | PPF | auto + log (invented term) |
| clear bra / clear brow / clear bar | PPF | auto |
| full front / full front end / front end | ppf.full_front | auto (ppf context) |
| full body / whole car PPF | ppf.full_body | auto |
| rocker panels / rockers | rocker panels | auto |
| door cups / door cusps | door cups | auto |
| self healing / self ceiling | self-healing | auto |
| one step / 1 step / single stage | correction.one_step | auto |
| two step / 2 step / two stage | correction.two_step | auto |
| compound / cut | compound | auto |
| swirl marks / swirls / spider webs | swirl marks | auto |
| oxidation / oxidized / chalky | oxidation | auto |
| water spots / hard water | water spots | auto |
| buff / buffing | polish (correction) | auto |
| interior / inside detail | interior detail | auto |
| full detail / complete detail / the works | full detail | auto |
| shampoo / extraction / steam | extraction | auto |
| pet hair / dog hair | pet hair | auto |
| odor / smell / smoke smell | odor removal | auto |
| head liner | headliner | auto |
| engine bay / under the hood | engine bay | auto |
| four runner / 4 runner | Toyota 4Runner (SUV) | auto |
| F one fifty / F150 / F-150 | Ford F-150 (truck) | auto |
| model three / model 3 | Tesla Model 3 (sedan) | auto |
| model why / model Y | Tesla Model Y (SUV) | auto |
| Tahoe / Suburban / Expedition | SUV / XL | auto |
| Civic / Camry / Accord / Altima | sedan | auto |
| Silverado / Ram / Tundra / Tacoma | truck | auto |
| Cybertruck | truck (⚠️ flag: special film) | auto + flag |

**Model-side terminology assertions (run against the real model):** for every conversation in 11.1, the reply text and every tool argument must contain **zero** of: "PFF", "PPF coating", "ceramic tint" when the topic is coating, "paint protection" when the topic is correction, "window treatment", any `$` amount not in the menu, any brand not in the KB, any percentage not in the KB.

---

## 12. PHASE 10 — Final recommendation

### A. Current state — what's good
- Server-authoritative pricing, booking, and lead writes. The model cannot invent a price or a slot that gets *booked*.
- Honest identity, name-first, read-back, retry on API blips, graceful voicemail fallback, never-miss email (gather).
- Streaming engine with ElevenLabs is genuinely close to human in timing.
- CRM plumbing (attribution, revenue recovered, Response Center, hot flag) is ahead of the conversation quality.
- Real leads have been booked from real calls.

### B. Ten highest-impact problems
1. **No terminology layer** — STT garbles pass straight to the model and the CRM. (12, 18)
2. **Ceramic coating ↔ ceramic tint conflation** built into the prompt/menu with no glossary. (12, 13)
3. **Relay barge-in deafness** (B1). (10, 17)
4. **Broken "I'll text you the quote" promise** (B4). (15)
5. **No discovery / value / education** — banned by the prompt. (2, 4, 5, 14)
6. **Objection handling is one rule.** (6)
7. **Free-text service fields** let invented names into the CRM. (12, 13)
8. **Gather uses Google V1 phone_call STT** when Deepgram nova-3 is a one-line change. (18)
9. **Relay skips never-miss email and fakes "captured"** (B2, B3). (16, 17)
10. **No knowledge base** beyond a 1,500-char notes box; service descriptions ignored (B6). (1, 8)

### C. Root causes
- The receptionist was built as a *capture* bot in a two-week sprint with a prompt that grew by patch ("PROMPT TUNING", "two-level tint pitch", "name up front") — every fix added a rule, none added structure.
- Vocabulary was treated as a Twilio setting (hints) rather than a system component.
- Haiku was chosen for latency and then loaded with ~1,500 words of ALL-CAPS rules; small models comply with the loudest rule (close now), not the subtle one (understand the product).
- Tests only ever exercised a scripted stub, so prompt regressions and terminology drift were invisible.
- Relay was cloned from gather but the two diverged (busy flag, never-miss, turn cap).

### D. Improvement plan (what changes)
1. Fix B1–B3, B5, B11, B12, B15 (mechanical).
2. Build `vocab.js` + `normalize.js` + `speak.js` with the terminology suite.
3. Canonical service IDs + strict tool schemas.
4. Knowledge base schema + Settings UI + industry templates.
5. Restructure the prompt into: persona/style → conversation rules → sales flow → per-service playbooks (rendered from KB) → hallucination rules → tools. Cache the stable prefix.
6. Repeat-caller context injection.
7. Fix the text-quote promise (owner one-tap `sms:` deep link already exists for estimates — reuse, or reword).
8. Model-in-the-loop eval harness (36 conversations + assertions) and run it on every prompt change.

### E. Architecture changes
- New: `server/receptionist/vocab.js` (dictionary), `normalize.js` (STT post-processing + entities), `speak.js` (spoken-form rewrite), `knowledge.js` (KB load/render/templates), `guard.js` (reply scanner for prices/discounts/brands).
- `voice.js`: split `buildSystemPrompt` into cached stable block + volatile tail; add `strict: true` and enums to tools; add `corrections[]` logging; inject lead context.
- `relay.js`: `finally { session.busy = false }`; never-miss in `finalize`; turn-cap forces a real capture (final-turn nudge like gather).
- `twilio.js`: `speechModel: 'deepgram_nova-3'`; normalized transcript in `syncVoiceTranscript`.
- `intake.js`/`transcribe.js`: run `normalize()` before extraction.
- Settings: Knowledge tab; admin: "garbles" report.
- Model: house default per the API skill is `claude-opus-5` (adaptive thinking, `effort: "low"`, streaming, prompt caching). For a live call, time-to-first-token is the constraint — I recommend running the eval on Opus 5 low-effort first; if first-token latency exceeds ~1.2 s on relay, fall back to `claude-sonnet-5` with the same prompt. Haiku 4.5 stays only if both are too slow. Note: Opus 5 / Sonnet 5 reject `temperature`, so variance is controlled by effort and prompt, not sampling. This is your call (see confirmation questions).

### F. Prompt changes
- Remove: the ban on general questions; "who do I have the pleasure"; hard-coded tint stats; "text the quote" promise (unless wired); "the MOMENT you mention any price… offer two times".
- Add: glossary block with protected pairs; per-service playbooks from KB; the ≤2-questions rule; readiness and just-tell-me detectors; objection classifier; banned phrases; spoken-form rules; "not provided → shop will confirm"; repeat-caller block.
- Restructure: stable prefix (persona, rules, glossary, KB, menu) → cache breakpoint → volatile (today, caller, lead context, open days).
- Tone: fewer capitals, positive phrasing ("do X" beats "NEVER Y") — larger models follow structured guidance better than shouted rules.

### G. Knowledge base — what's missing (ask each shop)
Per service: pricing mode, included steps, duration, warranty, brand or "don't name", cure/aftercare, vehicle exclusions. Shop-wide: legal front VLT they quote, years/reviews, payment, deposit policy, mobile or not, film brands. For Angelo specifically: the à-la-carte tint lines (front two, windshield strip, windshield, sunroof) as real menu items with prices, and whether coating/PPF get a `range`.

### H. Sales system
The §4 flow with the ≤2-question balance rule, §5 playbooks, §6 objection classifier, §7 conversation rules, readiness detection, and per-service `capture_lead` qualification fields (`goal`, `coverage`, `condition`, `timeline`, `decisionMaker`, `objection`, `objectionCause`).

### I. Accuracy system
§8 in full: dictionary → deterministic normalizer with a safe hierarchy → tagged confirmations → strict enum tools → reply guard → spoken-form rewrite → logged corrections feeding the alias table.

### J. Testing system
- `test/terminology.test.js`: 11.2 table, deterministic, runs in CI in <1 s.
- `test/receptionist-eval.js`: 11.1 conversations against the real model with a simulated caller (also Claude) and assertion-based grading + an LLM judge for naturalness; reports pass rate and per-category scores; run before every prompt merge. Cost ≈ 36 calls × ~8 turns.
- Regression: B1/B2/B3 unit tests in `relay-smoke`.
- Production: `corrections[]` log + weekly garble report; monitor `outcome` mix and hang-up-before-engage rate in the existing funnel.

### K. Implementation order (impact × dependency)

| Step | Work | Depends on | Risk | Est. |
|---|---|---|---|---|
| 1 | Bug fixes B1, B2, B3, B5, B11, B12, B15 + regression tests | — | low, additive | ½ day |
| 2 | `vocab.js` + `normalize.js` + terminology test suite; wire into gather, relay, intake; store raw+normalized transcript | — | low | 1 day |
| 3 | Canonical service IDs + strict tool schemas + `speak.js` spoken-form + reply guard | 2 | low-med | 1 day |
| 4 | Prompt restructure (glossary, ≤2-questions rule, education allowed, banned phrases, cache split, repeat-caller block); fix text-quote promise | 3 | **medium — behavior change, needs eval** | 1 day |
| 5 | Eval harness (36 conversations, simulated caller, assertions) — run on current vs new prompt on current model | 4 | low | 1 day |
| 6 | Model decision via eval (Opus 5 low / Sonnet 5 / Haiku) + latency measurement on staging | 5 | medium | ½ day |
| 7 | Knowledge base schema, templates, Settings UI, prompt rendering | 3 | medium (UI + data) | 2 days |
| 8 | Per-service playbooks + objection classifier + qualification fields in `capture_lead` | 7 | medium | 1–2 days |
| 9 | Angelo KB fill session + staging calls + promote | 8 | — | ½ day |
| 10 | Admin garble report + alias curation loop | 2 | low | ½ day |

Steps 1–3 are safe to ship independently and fix the reported word bug at the source. Step 4 onward changes how the bot sells and should go to staging first with Bryce's/Angelo's sign-off, as before.

---

## 13. Decisions I need from you before touching code

1. **Ship steps 1–3 now?** (bug fixes + terminology layer + strict tools). Additive, no behavior change to the sales flow.
2. **Model for the brain:** Opus 5 at low effort (house default, best comprehension, latency to be measured), Sonnet 5, or stay on Haiku until the eval says otherwise?
3. **Sales-flow rules that look like owner decisions** — "never quote coating/PPF", "always offer two times the moment a price is spoken", "never ask budget" — were these Angelo's explicit rules or engineering guesses? I'd relax the first two into per-service KB settings (`pricing.mode`) unless he wants them hard.
4. **The texted-quote promise:** wire an actual SMS (blocked on A2P) / reuse the owner one-tap `sms:` link and reword to "the shop will text you" / drop the promise. Your call.
5. **Knowledge base storage:** `settings.knowledge` (simplest, per-shop lowdb, no migration) vs a new collection with its own admin UI. I recommend `settings.knowledge` + templates.
6. **Send me 5–10 real transcripts with wrong words** so I can confirm the STT-vs-model split before tuning thresholds.

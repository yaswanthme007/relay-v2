# RELAY — Project Playbook
### A voice-native speech repair system for people with dysarthria
**DataForge × Pathway × Rime Hackathon**

> Working name. Change it if you want, but pick something short, say-able, and not
> an acronym you have to explain. "RELAY" works because that is literally the
> product: it relays what you meant.

---

## 0. The one-paragraph pitch

People with dysarthria — slurred or unclear speech caused by cerebral palsy,
stroke, ALS, or Parkinson's — can think in full sentences but cannot be
reliably understood. Today's assistive tools make them **abandon speech
entirely** and tap words on a grid. RELAY does the opposite: they keep
speaking. RELAY listens, reconstructs what they most likely meant using their
own personal vocabulary, lets them confirm with one tap, and then speaks it
aloud in a voice that is consistently theirs. **Repair, not replace.**

That last sentence is your whole pitch. Say it in the demo.

---

## 1. Why this wins (and where it can lose)

### The judging math

| Category | Weight | Your position |
|---|---|---|
| Problem & necessity of voice | 25% | **Near-max.** Remove Rime and the product does not degrade — it ceases to exist. |
| Hard voice engineering | 25% | **The swing category.** Decided entirely by evidence depth, not idea quality. |
| Rime integration & voice experience | 20% | Strong, if model/voice/endpoint choices are deliberate and defended. |
| Evidence & reproducibility | 20% | **Free differentiation.** Most teams will not ship a real evidence doc. |
| Demo clarity | 10% | Near-free. The story explains itself in 15 seconds. |

You have a 25% category that is nearly locked and a 10% category that is
nearly free. **Your entire competitive risk lives in the 45% made up of Hard
Voice Engineering + Evidence.** Everything in this playbook is optimised for
those two.

### How you lose

1. You spend hours on multilingual or telephony and ship thin evidence.
2. Your ASR visibly fails on camera and the reconstruction produces nonsense.
3. Your "hard voice problem" reads as *"we used a Rime feature"* rather than
   *"we solved a system problem that Rime made solvable."*
4. You forget `modelId` on one request and your pronunciation demo silently
   reverts to Mist v3 mid-demo.

---

## 2. THE CRITICAL CONSTRAINT (read this twice)

Verified against Rime docs on **2 September 2026**:

- `phonemizeBetweenBrackets` (custom pronunciation) is supported on
  **Mist v2 and Mist v1 only**. Not Mist v3. Not Coda. Not Arcana.
- **Cloud Arcana was sunset on 15 August 2026.** Arcana cloud requests now
  route to Coda. Any plan that says "use Arcana" is stale.
- **Mist v2 serves English, French, German, Spanish.** Hindi/Portuguese/
  Japanese/Arabic are Coda-only.
- **If you omit `modelId`, or send an unrecognised value, you get Mist v3** —
  which silently ignores your phoneme strings.

### What this means

**Deterministic pronunciation and Indian-language support are mutually
exclusive on a single Rime model.** You must choose.

**Choose `mistv2`. Kill the Tamil/Hindi stretch goal.**

Do not treat this as a limitation you hide. Treat it as an engineering
decision you **document loudly**:

> *"We evaluated Coda for multilingual support. Coda does not support
> `phonemizeBetweenBrackets`. For a user whose core failure mode is having
> their own name and their own medication mispronounced, deterministic
> pronunciation is not negotiable and multilingual is. We chose `mistv2` and
> documented the trade-off. A production version would route per-utterance
> across both models and accept a voice-identity discontinuity at the
> language boundary."*

That paragraph, in your README, is worth more than a half-working Tamil demo.
It shows you understood the platform. Judges reward that.

**Verify all of the above yourself at build time** against the live catalog —
the PS explicitly requires using the current catalog at submission time, and
model support changes.

---

## 3. The six WOW factors

The idea alone is not enough — half the room will have a "voice accessibility"
project. These six are what make yours the one people talk about afterwards.
**#1, #2 and #3 are mandatory. #4 and #5 are high-value. #6 is free.**

---

### WOW #1 — Floor-holding: the trick nobody else will do

**The problem nobody has noticed yet.**

Run the naive pipeline in your head. User finishes a slurred sentence. Now:
ASR (400ms) → LLM reconstruction (700ms) → user reads candidates and taps
(1500ms) → Rime synthesis (200ms). That is **~2.8 seconds of total silence**
in a live pharmacy conversation.

In that silence, the pharmacist looks away, starts talking, or turns to the
next customer. **The user loses the conversational floor.** For a dysarthric
speaker this is the actual lived failure — not that they were misunderstood,
but that they never got to finish.

**The fix.**

The instant your VAD detects end-of-turn, play a **pre-synthesised, cached
holding phrase in the user's own persistent Rime voice**, straight from local
memory. Zero network. Zero synthesis. `AudioContext` playback in ~30–50ms.

> *"One moment."* / *"Hold on."* / *"Give me a second."*

Cache 4 variants at session start and rotate them so it never sounds robotic.
Only fire the holder if reconstruction has not returned within ~400ms, so you
never interrupt yourself on fast turns.

**Why this is a genuine WOW:**

- It is voice doing something **no screen can do**. A spinner cannot hold a
  conversational floor. A human listener can only be held by sound.
- It collapses your *perceived* time-to-first-audio from ~2800ms to ~50ms —
  a **50×+ improvement on the metric the user actually experiences.**
- It maps directly onto the PS's **"Perceived response time"** track, which
  demands you *"measure the entire user path"* and *"measure what the user
  experiences, not a convenient proxy."* You are measuring end-of-turn to
  first audible sample at the device. That is the real number.
- It is trivially demoable. Play the demo with floor-holding off, then on.
  The room will feel the difference before you explain it.

This is your headline. Lead the hard-engineering section of the demo with it.

---

### WOW #2 — Confidence-gated prosody: the voice encodes its own uncertainty

**The problem.** In a medical context, a confidently-spoken wrong dosage is
dangerous. But forcing the user to confirm every single utterance destroys the
speed advantage that makes the product usable.

**The fix.** The reconstruction step returns a confidence score. That score
**changes how Rime speaks**, not just what it speaks:

| Confidence | Behaviour | Rime input |
|---|---|---|
| **High (>0.85)** | Speak as a statement, no confirmation needed | `I need a refill of metformin, five hundred milligrams.` |
| **Medium (0.5–0.85)** | Speak as a **confirmation question**, with a deliberate pause | `Metformin, <300> five hundred milligrams?` |
| **Low (<0.5)** | **Do not speak at all.** Show candidates, stay silent. | *(no synthesis)* |

The medium case uses Rime's **custom pause** syntax (`<300>` with
`pauseBetweenBrackets: true`) plus question-mark punctuation to produce rising
intonation and a natural hesitation. The system's uncertainty becomes
**audible**.

**Why this is a genuine WOW:**

- It is a **safety property expressed through prosody**. That is a real,
  non-obvious contribution, and it is Rime-specific — it depends on
  controllable delivery.
- It gives you a clean, honest answer to the obvious judge question:
  *"What if the reconstruction is wrong?"* Answer: *"The voice tells you it
  might be. Listen —"* and then you play the two clips back to back.
- It maps to the PS's **"Pronunciation and controlled delivery"** track, which
  explicitly asks you to *"render at least two text variants, save the clips,
  and explain which wording or punctuation changed the result."* You are doing
  exactly that, by design, as a product feature.

---

### WOW #3 — The Personal Pronunciation Ledger

**Upgrade your original idea.** "A phrasebook of medical terms" is fine.
**A per-user pronunciation ledger built from their own life** is a product.

The ledger contains:

- Their **own name** ← *do this one on camera, see below*
- Their prescriptions (`metformin`, `levothyroxine`, `atorvastatin`,
  `salbutamol`, `hydrochlorothiazide`)
- Their clinicians' names (`Dr. Raghunathan`, `Dr. Mukherjee`)
- Their street, their pharmacy, their kids' names
- Domain phrases they use constantly (`repeat prescription`, `sixty-day supply`)

**How you build it — and this is the part that scores:**

Rime ships two APIs almost nobody at this hackathon will find:

1. **Coverage API** (`rime.ai/dashboard/coverage`, also available via API) —
   tells you which words are *already in Rime's dictionary* and which are not.
   Words not covered still get spoken, but the model *predicts* the
   pronunciation.
2. **Phonemize API** (`POST https://optimize.rime.ai/phonemize`) — post raw
   WAV audio of a word, get back a Rime phonetic string:
   ```json
   { "audioId": "9b2d8ad2-...", "phonemeString": "h0El1o !", "authed": 1 }
   ```

So your pipeline is:

```
personal vocabulary list
   → Coverage API           → which words Rime does not know
   → record correct audio   → Phonemize API → phoneme string
   → store in ledger        → inject as {ph0on1imz} at synthesis time
   → mistv2 + phonemizeBetweenBrackets: true
```

This is **systematic, automated, and measurable** — not "we typed some
phonemes by hand." You can run it over 25 words in one script and produce a
coverage report as an artifact.

**The moment that wins the room.**

Put **the user's own name** in the ledger and demo it first.

A person with dysarthria having their own name mispronounced — by the machine
that is supposed to be speaking *for* them — is the most quietly humiliating
failure in this entire product space. Fix it on camera. Play "before" (Rime
guessing), then "after" (ledger applied). Do not over-explain it. Let it land.

---

### WOW #4 — Barge-in fencing with WebSocket context IDs

Rime's WebSocket API (`wss://users-ws.rime.ai/ws3`) supports a **`clear`
operation plus context IDs** specifically for interruption handling. Most
teams will use the HTTP endpoint and never find this.

**The behaviour:**

1. User taps a different candidate while audio is playing.
2. Send `clear` on the socket → Rime stops generating.
3. Flush the local `AudioContext` queue → playback stops in <150ms.
4. **Fence the old context ID.** Any audio chunks that arrive late from the
   cancelled context are counted and **discarded**, never played.
5. The transcript log records only what was actually heard.

Step 4 is the one that matters. The PS's full-duplex test explicitly requires
that *"stale tool results are not spoken as current"* and that the final state
*"reflects what the user actually heard and requested."* Counting and
reporting dropped chunks is your proof that fencing works, not just that
playback stopped.

Keep the mic open the entire time audio is playing. The PS is explicit: *"the
application must continue accepting user audio while Rime speech is playing."*

---

### WOW #5 — The "Heard Receipt"

An append-only log of what **actually reached the listener's ears**:

```
14:32:07  SPOKEN (complete)   "Hi, I'm here to pick up a prescription."
14:32:19  SPOKEN (cut at 0.4s) "Metformin, two fifty—"        [barge-in]
14:32:21  SPOKEN (complete)   "Metformin, five hundred milligrams."
```

Cheap to build, and it does triple duty:

- **Observability** (a whole PS track) — it is literally *"inspect what users
  actually heard."*
- **Safety artifact** — in a medical setting, a record of what the pharmacist
  was told is genuinely valuable.
- **Your AT-3 assertion target** — the test asserts against this log.

---

### WOW #6 — Persistent voice identity, framed correctly

Mechanically trivial: store `speaker` per user, reuse forever. **Frame it as
identity, not as a setting.**

In onboarding, the user auditions voices and picks one. From then on, every
holding phrase, every confirmation question, every spoken sentence uses it.
The demo should show the same voice across three separate interactions.

The line to say: *"They did not pick a setting. They picked a voice they are
willing to be heard as."*

Maps to the PS's **"Expressive and persistent voice identity"** track for
essentially free.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  BROWSER   React + Vite + TypeScript                        │
│                                                             │
│  Mic ──► VAD (silence detect) ──► Opus chunks               │
│                    │                                        │
│                    ├──► [end-of-turn fires]                 │
│                    │         └──► FLOOR-HOLD (cached WAV)   │
│                    │              AudioContext, ~40ms       │
│                    ▼                                        │
│           WebSocket to server                               │
│                                                             │
│  AudioContext playback queue                                │
│    ├─ context-ID fencing (discard stale chunks)             │
│    ├─ clear-on-barge-in                                     │
│    └─ Heard Receipt log                                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  SERVER   FastAPI (Python)   ← holds ALL secrets            │
│                                                             │
│  1. ASR         Groq  whisper-large-v3-turbo                │
│  2. RECONSTRUCT Groq  llama-3.3-70b-versatile (JSON mode)   │
│                 context = ledger + last 3 turns + situation │
│                 returns: 2-3 candidates + confidence        │
│  3. LEDGER      inject {phoneme} strings for known terms    │
│  4. PROSODY     confidence → statement | question | silent  │
│  5. TTS         Rime  wss://users-ws.rime.ai/ws3            │
│                   modelId: mistv2          ← NEVER omit     │
│                   speaker: <user's voice>                   │
│                   phonemizeBetweenBrackets: true            │
│                   pauseBetweenBrackets: true                │
│                   audioFormat: mp3                          │
└─────────────────────────────────────────────────────────────┘
```

### Stack decisions and why

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite + TypeScript | You already know it. Zero learning cost. |
| Audio out | Web Audio `AudioContext` | You need sample-accurate timing for AT-2 and instant flush for AT-3. `<audio>` tags cannot do either. |
| Server | FastAPI (Python) | Same language as your evidence scripts. One codebase for product and proof. |
| ASR | Groq `whisper-large-v3-turbo` | Fastest hosted Whisper. Latency is the whole game here. |
| LLM | Groq `llama-3.3-70b-versatile` | Fast, JSON mode, good at constrained reconstruction. |
| TTS | **Rime `mistv2`** | The only current model with `phonemizeBetweenBrackets`. Non-negotiable. |
| Transport | Rime WebSocket `ws3` | `clear` op + context IDs + word timestamps. HTTP cannot fence. |

> Verify exact Groq model IDs at build time — they rotate. If
> `llama-3.3-70b-versatile` is gone, any fast instruction model with JSON mode
> works; the prompt is the important part, not the model.

### The reconstruction prompt (the actual innovation in the AI layer)

Do **not** ask the LLM to "fix the sentence." Ask it to do constrained
inference against a known world:

```
You reconstruct intended speech from noisy ASR output produced by a speaker
with dysarthria. The transcript is unreliable at the phoneme level but the
speaker's intent is usually recoverable.

KNOWN VOCABULARY (this speaker's ledger — strongly prefer these):
{ledger_terms}

SITUATION: {pharmacy | clinic | home | phone}
LAST 3 EXCHANGES: {history}
RAW ASR: "{transcript}"

Return JSON only:
{
  "candidates": [
    {"text": "...", "confidence": 0.0-1.0, "reasoning": "one short clause"}
  ]
}

Rules:
- Return 2-3 candidates, most likely first.
- Prefer ledger vocabulary over phonetically similar common words.
- Never invent a dosage, a drug, or a number not phonetically supported by
  the transcript. If a number is unclear, mark confidence below 0.5.
- Keep candidates short. These will be spoken aloud.
```

**The A/B you must be able to show:** run the same ASR output with the ledger
in context and without it. If the ledger changes nothing, judges will ask what
it is for. Have a fixture where it clearly does — e.g. ASR hears
*"met four min"* → without ledger: `"met four min"`; with ledger:
`"metformin"` at 0.91 confidence.

---

## 5. Acceptance tests — write these BEFORE you build

The PS is explicit: *"Define the acceptance test before the demo."* Commit
this file at the **start** of the hackathon so the git history proves you did.

### AT-1 — Deterministic pronunciation of personal vocabulary

- **Claim:** For a 20-item personal vocabulary fixture, the ledger raises
  correct pronunciation from baseline to ≥85%.
- **Procedure:** `python evidence/at1_pronunciation.py`
  - Run all 20 terms through Coverage API → record which are uncovered.
  - Synthesise each term in a carrier sentence, `mistv2`, fixed speaker,
    **without** ledger → save to `evidence/clips/at1/before/`.
  - Synthesise identical text **with** `{phoneme}` strings and
    `phonemizeBetweenBrackets: true` → `evidence/clips/at1/after/`.
  - 3 blind listeners score each clip correct/incorrect. Model and voice held
    constant; only the phoneme string varies.
- **Output:** `evidence/at1_results.csv` — term, covered?, before, after, delta.
- **Disclose:** items already correct at baseline (they are not wins). Items
  still wrong after (they are honest losses).

### AT-2 — Perceived time-to-first-audio

- **Claim:** Floor-holding reduces p50 end-of-turn → first audible sample from
  >1800ms to <250ms across 30 trials.
- **Procedure:** Measured **in the browser** using `AudioContext.currentTime`,
  from VAD end-of-turn event to the first sample scheduled on the output node.
  Not server-side. Not synthesis latency. The number the human experiences.
- **Run:** 30 trials floor-hold OFF, 30 trials ON, same utterances.
- **Report:** p50 / p90 for each. Separate **cold** first-call from **warm**
  runs — the PS requires this explicitly. Label network conditions.
- **Output:** `evidence/at2_latency.csv` + a histogram.

### AT-3 — Barge-in fencing under injected delay

*(This is the PS's own full-duplex test, adapted to your product.)*

- **Setup:** inject a fixed 3000ms delay into the reconstruction step.
- **Action:** while the floor-hold or candidate-1 audio is playing, the user
  taps candidate 2 and simultaneously speaks a correction.
- **Assertions:**
  1. Local playback stops within 150ms of the tap.
  2. `clear` is sent on the Rime socket; the stale context ID is fenced.
  3. Count of discarded late chunks from the stale context is **> 0** and all
     are logged. *(If it is 0, your test is not actually stressing the system
     — increase the delay.)*
  4. The Heard Receipt contains candidate 2, and candidate 1 appears only as
     `cut at Xs`.
  5. The mic remained open and captured user audio throughout playback.
- **Output:** `evidence/at3_trace.json` + screen recording.

---

## 6. Build timeline (24 hours)

**The cut line is at hour 14. If the core is not done by then, you cut
features, not evidence.**

| Hours | Work | Done means |
|---|---|---|
| 0–1 | Write `RIME_EVIDENCE.md` skeleton with AT-1/2/3 stated. **Commit it.** Rime key in server env. Confirm `mistv2` + phonemize works with one curl. | Git log proves tests predated build. |
| 1–3 | Mic capture + VAD + WebSocket to server. Raw ASR round-trip via Groq. | You can speak and see a transcript. |
| 3–5 | Reconstruction prompt + candidate UI + confirm tap. | End-to-end text path works. |
| 5–7 | Rime `ws3` integration. `AudioContext` playback queue. Voice picker + persistence. | **The core product works.** |
| 7–9 | **Pronunciation ledger.** Coverage API sweep, Phonemize on 20 terms, injection at synthesis. | WOW #3 live. |
| 9–11 | **Floor-holding.** Cache 4 phrases at session start, VAD trigger, 400ms threshold. | WOW #1 live. |
| 11–13 | **Barge-in + fencing + Heard Receipt.** | WOW #4 and #5 live. |
| 13–14 | **Confidence-gated prosody.** Three-branch routing. | WOW #2 live. |
| **14** | **CUT LINE — freeze features.** | Nothing new after this. |
| 14–17 | Run AT-1, AT-2, AT-3. Save every clip. Write real numbers into `RIME_EVIDENCE.md`. | Evidence is real, not planned. |
| 17–19 | README: architecture, exact model ID, speaker, language, endpoint, audio format, transport, limitations, failure behaviour. `.env.example` with placeholders only. Secret sweep. | PS submission checklist satisfied. |
| 19–22 | Record demo. Multiple takes. | 4–5 min video exists. |
| 22–24 | Buffer. Something will break. | Sleep is not on this list. |

**If you only have 12 hours:** cut WOW #2 and #5. Keep #1, #3, #4, #6 and
**all three acceptance tests.** Evidence is 20% of the score; a fourth feature
is worth nothing on its own.

---

## 7. Demo script (4:30)

| Time | Beat | What is on screen |
|---|---|---|
| 0:00–0:30 | **The user.** One sentence on dysarthria. Then: *"Existing tools tell them to stop speaking and start typing. We think that is the wrong answer."* | A face, or a still. Not a slide of bullet points. |
| 0:30–1:45 | **Normal flow, end to end.** Pharmacy scenario. Slurred request → candidates → tap → Rime speaks. Do it twice so the same voice is visibly persistent. | The actual product. No cuts. |
| 1:45–2:15 | **WOW #3 — the name.** Play "before": Rime guessing at the user's name. Play "after": the ledger applied. Say almost nothing. | Two waveforms side by side. |
| 2:15–2:50 | **WOW #1 — floor-holding.** Run the same turn with it off (long dead silence, let it be uncomfortable), then on. Show the p50 numbers. | Latency chart on screen. |
| 2:50–3:30 | **The stress case.** Severe slur + drug name + user changes their mind mid-playback. Show playback stopping, the fenced chunk count, and the Heard Receipt showing only what was actually said. | Split screen: app + receipt log. |
| 3:30–4:00 | **WOW #2 — uncertainty out loud.** High-confidence statement vs medium-confidence question. Two clips, back to back. | Confidence score visible in UI. |
| 4:00–4:20 | **Provider transparency.** On-screen indicator: `Rime · mistv2 · speaker: <name> · ws3`. State it aloud. Disclose any fallback. | The PS requires the active provider be observable. |
| 4:20–4:30 | **Limitations, said out loud.** *"Tested on simulated dysarthric speech, not clinical recordings. Mist v2 means English only — we chose deterministic pronunciation over multilingual, and here is why."* | Text card. |

Ending on limitations feels counterintuitive. It is not. It reads as
confidence, and it pre-empts the exact question a sharp judge was about to
ask.

---

## 8. Repo structure

```
relay/
├── README.md                    # setup, architecture, EXACT Rime config, limits
├── RIME_EVIDENCE.md             # commit the skeleton in hour 0
├── .env.example                 # placeholders ONLY — no live keys anywhere
├── web/                         # React + Vite + TS
│   ├── src/audio/               # VAD, AudioContext queue, fencing
│   ├── src/components/          # candidates, voice picker, heard receipt
│   └── src/lib/latency.ts       # AT-2 instrumentation
├── server/                      # FastAPI
│   ├── asr.py                   # Groq whisper
│   ├── reconstruct.py           # Groq LLM + prompt
│   ├── ledger.py                # coverage + phonemize + injection
│   ├── prosody.py               # confidence → delivery mode
│   └── rime_ws.py               # ws3 client, clear op, context IDs
├── evidence/
│   ├── at1_pronunciation.py     # repeatable command
│   ├── at2_latency.md           # browser measurement procedure
│   ├── at3_bargein.py
│   ├── fixtures/vocabulary.json # 20 terms — SYNTHETIC persona
│   ├── clips/{at1}/{before,after}/
│   └── results/*.csv
└── docs/persona.md              # the synthetic user + why synthetic
```

---

## 9. Non-negotiables (eligibility)

Straight from the PS. Any one of these disqualifies you.

- [ ] **No live credentials anywhere** — not in source, docs, screenshots, or
      the recording. Blur your terminal. Sweep git history before submitting.
- [ ] `.env.example` with **placeholders only**.
- [ ] Rime is the **default path** in the judged flow, and the active provider
      is **visibly observable** in the UI.
- [ ] Any fallback behaviour is **disclosed**, not hidden.
- [ ] Model / voice / language combination **verified against the live catalog
      at submission time**, not copied from this document.
- [ ] `modelId: mistv2` set **explicitly on every single request.** Omitting it
      silently gives you Mist v3, which ignores phonemes.
- [ ] Working demo recording exists and every behaviour shown exists in the repo.
- [ ] **Synthetic / de-identified data only** — the PS requires this for
      healthcare workflows. Invent the persona, the prescriptions, the doctor.
      Document that they are invented in `docs/persona.md`.

---

## 10. Risks, ranked

**1. ASR fails visibly on camera.** *(highest)*
Whisper on severely dysarthric speech will produce garbage, and your
reconstruction layer will produce confident nonsense from it. **Mitigation:**
scope to mild-to-moderate dysarthria and say so. Use the phrasebook to carry
the load. Rehearse the exact demo utterances until you know their failure
profile. Have AT-3's failure path ready as a graceful catch.

**2. You run out of time and evidence is thin.** *(likeliest)*
Enforce the hour-14 cut line. Evidence is 20%; a fourth feature is 0%.

**3. Speech recording ethics.** If nobody on the team has dysarthria, do not
fake a clinical recording. Have a teammate simulate impaired articulation and
**disclose it as a limitation in the README and on camera.** Clinical datasets
like TORGO and UASpeech require licences you will not get in 24 hours.
Disclosure beats fabrication every time, and judges scoring "evidence" will
notice which one you chose.

**4. The phonemize round-trip eats hours.** Time-box it. If the Phonemize API
fights you, hand-write phoneme strings from Rime's alphabet reference for 8
high-value terms and reduce the AT-1 fixture from 20 to 8. A rigorous 8-item
test beats a broken 20-item one.

**5. Scope creep back toward telephony/multilingual.** Someone on the team will
argue for it at hour 16. The answer is no. Write it in `README.md` under
"Future work" and move on.

---

## 11. The sentence to build everything around

> **"They keep their voice. We just make sure it arrives."**

If a design decision does not serve that sentence, cut it.

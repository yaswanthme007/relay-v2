# RELAY

> ### ▶ Watch the demo
>
> **https://www.youtube.com/watch?v=cQ4ETcg4H5M**

**A voice-native relay for people whose speech is not reliably understood.**

RELAY listens to disordered speech, reconstructs what was most likely meant as a small set of ranked candidates, lets the speaker choose one, and speaks it in a consistent synthetic voice — with the speaker's own personal vocabulary (their name, their clinician, their medications) pronounced deterministically correctly, every time.

It is not a grammar corrector and not a screen reader. The three things it does that a screen cannot are: it **holds the conversational floor** while it thinks, it **can be interrupted mid-sentence** and stops within ~50ms, and it keeps a **Heard Receipt** of what was actually spoken aloud — including what got cut off, and where.

Built for the Pathway × Rime Hackathon, Rime AI track.

---

## Executive summary

RELAY is a voice-native communication tool for people whose speech is not reliably understood by others, such as speakers with dysarthria. It listens to disordered speech, transcribes it with Groq's Whisper model, and reconstructs the speaker's likely intent into up to three ranked candidate sentences using a language model constrained by the speaker's own vocabulary, the situation (pharmacy, clinic, home, or phone), and recent conversation history. Once the speaker confirms a candidate, RELAY synthesizes it aloud through Rime's `mistv2` voice model, using a personal pronunciation ledger so names, medications, and other important terms are always spoken exactly the way the speaker recorded them. The system holds the conversational floor with instant filler audio while it thinks, lets the speaker interrupt playback within roughly 50ms, and keeps a Heard Receipt log of exactly what was spoken aloud, including anything cut off mid-sentence. It is backed by 126 backend and 48 frontend automated tests plus real Rime/Groq-driven acceptance tests for latency and barge-in, and it is deliberately conservative — it stays silent rather than confidently voicing a low-confidence guess, and never fabricates a name, dosage, or number it cannot support from what was actually said.

---

## Table of contents

- [Executive summary](#executive-summary)
- [Rime configuration (exact)](#rime-configuration-exact)
- [Setup](#setup)
- [Architecture](#architecture)
- [Third-party services](#third-party-services)
- [Failure behavior](#failure-behavior)
- [Known limitations](#known-limitations)
- [Tests](#tests)
- [Evidence](#evidence)
- [Repository map](#repository-map)
- [Security and data](#security-and-data)

---

## Rime configuration (exact)

Every value below is what the code actually sends. `server/rime_ws.py` builds this connection string; there is no other path from RELAY to Rime.

| Setting | Value |
|---|---|
| **Model ID** | `mistv2` — sent explicitly on **every** request, never defaulted |
| **Speaker** | `breeze` by default (UI voice "Meadow"). Also selectable: `ember`, `cove`, `grove`, `summit` |
| **Language** | English. `mistv2`'s default; RELAY sends no `lang` parameter |
| **Endpoint (TTS)** | `wss://users-ws.rime.ai/ws3` |
| **Endpoint (Coverage)** | `POST https://users.rime.ai/oov` |
| **Endpoint (Phonemize)** | `POST https://optimize.rime.ai/phonemize` |
| **Audio format** | `mp3` |
| **Transport** | WebSocket (Rime ws3), streamed chunk-by-chunk. Never buffered into a full clip server-side |
| **Auth** | `Authorization: Bearer $RIME_API_KEY` header, server-side only |

Full query string as constructed:

```
wss://users-ws.rime.ai/ws3
  ?speaker=breeze
  &modelId=mistv2
  &audioFormat=mp3
  &phonemizeBetweenBrackets=true
  &pauseBetweenBrackets=true
```

**Why `mistv2` specifically, and why it is explicit everywhere.** `phonemizeBetweenBrackets` — the flag that makes `{m1Etf1OrmIn}` in the input text override the model's own pronunciation — is supported by Mist v1/v2 only. It is *not* supported by Mist v3 or Coda. Omitting `modelId` silently routes to Mist v3, which ignores bracketed phoneme strings **and returns no error**. The custom-pronunciation feature would appear to work while doing nothing. Because that failure is silent, `MODEL_ID = "mistv2"` is a module constant in `server/rime_ws.py` rather than a parameter, and it is asserted by tests.

**Voice name → speaker ID.** The UI's display names are not Rime speaker IDs and are not assumed to be. `server/voices.py` owns the mapping and is the only place it happens:

| UI voice | Rime `mistv2` speaker |
|---|---|
| Meadow | `breeze` |
| Ember | `ember` |
| Cove | `cove` |
| Grove | `grove` |
| Summit | `summit` |

`Meadow` is a **documented substitution**: it is not present in Rime's live `mistv2` catalog under any name, so it is mapped to `breeze` (same register) rather than silently 404-ing. The other four are real catalog IDs whose lowercased display name happens to match.

**Language scope is deliberate, not an oversight.** Tamil and Hindi were considered and cut: Rime's Coda model supports those languages but does **not** support `phonemizeBetweenBrackets`. Deterministic pronunciation of the user's own name is the point of this product, so English + `mistv2` was chosen over multilingual + no custom pronunciation. See [Known limitations](#known-limitations).

---

## Setup

**Prerequisites:** Python 3.11+, Node 18+, a Rime API key, a Groq API key.

### 1. Credentials

```bash
cp .env.example .env
```

Fill in your own keys in `.env`:

```
RIME_API_KEY=<your key>
GROQ_API_KEY=<your key>
ALLOWED_ORIGIN=http://localhost:5173
PORT=8000
```

`.env` is gitignored and is never read by the frontend. `.env.example` contains placeholders only. If either key is missing, the server **fails loudly at startup** rather than falling back to an unauthenticated path.

### 2. Backend

```bash
pip install -r server/requirements.txt
python -m uvicorn server.main:app --port 8000
```

Run from the repository root, not from `server/`. On first start the app creates `server/relay.db` (SQLite) and seeds a demo pronunciation ledger from `evidence/fixtures/vocabulary.json` using real Rime Coverage calls. Seeding runs once and never overwrites existing rows.

Check it: `curl http://localhost:8000/health` → `{"status":"ok"}`

### 3. Frontend

```bash
cd web
npm install
npm run dev
```

Open <http://localhost:5173>. Grant microphone permission when prompted.

### 4. Try it

- **`/session`** — hold the mic button, speak, pick a candidate, hear it. Tap a different candidate mid-playback to barge in.
- **`/ledger`** — add a term, record its correct pronunciation, phonemize it, then **click the term to hear it**. Delete it with the trash icon if it sounds wrong, and add it again.

---

## Architecture

```
Browser (React + Vite)                    FastAPI server                 Third parties
──────────────────────                    ──────────────                 ─────────────

 mic ──► MediaRecorder
          │ webm/opus
          ▼
     POST /api/turn ───────────────────►  asr.py ──────────────────────►  Groq Whisper
                                             │  transcript                whisper-large-v3-turbo
                                             ▼
                                          reconstruct.py ──────────────►  Groq
                                             │  3 ranked candidates       openai/gpt-oss-120b
                                             │  + per-user ledger terms   (JSON mode)
     ◄───────────────────────────────────────┘
     candidates rendered
          │
          │ user taps one
          ▼
     WS /ws/tts  {speak}  ─────────────►  session_ws.py
                                             │
                                             ├─► prosody.py      confidence gate
                                             ├─► ledger.py       {phoneme} injection
                                             ▼
                                          rime_ws.py ──────────────────►  Rime ws3
                                             │                            mistv2, mp3
     ◄──── {audio_chunk} base64 ─────────────┘  streamed, never buffered
          │
          ▼
     TTSPlaybackQueue (Web Audio AudioContext)
          │
          ▼
     speakers ──► {heard_report} ───────►  Heard Receipt
```

### The four mechanisms

**1. Constrained reconstruction, not correction.** `server/reconstruct.py` does not ask a model to "fix the sentence." It asks it to infer what the speaker most plausibly meant, constrained by the speaker's own vocabulary ledger, the declared situation (pharmacy / clinic / home / phone), and the last three exchanges. It returns up to 3 candidates with confidence scores. Malformed output is dropped rather than passed through; prose instead of JSON triggers one retry, then falls back to surfacing the raw transcript as a single low-confidence candidate rather than crashing the turn.

**2. Deterministic pronunciation via a personal ledger.** `server/ledger.py` runs each term through Rime's Coverage API to learn whether Rime already knows it, records the user's own recording through Rime's Phonemize API to get a real phoneme string, and stores it in SQLite. Before synthesis, `inject_pronunciations()` rewrites any known term in the candidate text as its `{phoneme}` bracket string. **Only entries where `verified == true` AND `phoneme != ""` are eligible** — an unverified term is left as plain text and gets Rime's model-predicted pronunciation. A phoneme is never fabricated.

The Ledger page's **pronunciation preview** (click any term to hear it) runs through this same helper, so what you audition is exactly what a real sentence would produce. The server loads the ledger row itself and scopes it to the connection's user; no phoneme ever crosses the wire from the browser.

**3. Confidence-gated prosody.** `server/prosody.py` turns the system's uncertainty into something audible, using thresholds defined once and shared by both sides:

| Confidence | Delivery |
|---|---|
| `> 0.85` | Statement — text spoken unchanged |
| `0.5 – 0.85` | Question — `<300>` pause inserted and terminated with `?` so intonation rises |
| `< 0.5` | **Silent** — no synthesis request is made at all. Candidates stay on screen |

The silent branch is enforced **server-side**. The server does not trust the browser to withhold a low-confidence `speak()`.

**4. Floor-holding, barge-in fencing, and the Heard Receipt.**
- *Floor-holding:* four short filler phrases are pre-synthesized in the session voice at startup and decoded into `AudioBuffer`s. If reconstruction hasn't returned within ~400ms, one plays immediately — zero network, zero synthesis at the moment it's needed. Fast turns are never interrupted.
- *Fencing:* on barge-in the browser flushes playback instantly and the server sends Rime's `clear`, marks the context stale, and **counts every late chunk that still arrives** before discarding it. Counted, never silently dropped — that counter is the assertion target for AT-3.
- *Heard Receipt:* the browser is the only thing that knows what actually reached the speakers, so it reports playback outcome and the server timestamps it into an append-only log. A cut utterance records a **measured** `cutAt`, not an estimate. Floor-hold phrases and pronunciation previews never appear in the receipt — it describes speech the user chose to relay.

**Audio output uses Web Audio `AudioContext`, never `<audio>` tags.** Sample-accurate timing and instant flush both require it.

---

## Third-party services

| Service | Used for | Model / endpoint | Key |
|---|---|---|---|
| **Rime** | Speech synthesis | `mistv2` via `wss://users-ws.rime.ai/ws3` | `RIME_API_KEY` |
| **Rime** | Dictionary coverage | `POST https://users.rime.ai/oov` | `RIME_API_KEY` |
| **Rime** | Audio → phoneme string | `POST https://optimize.rime.ai/phonemize` | `RIME_API_KEY` |
| **Groq** | Speech recognition | `whisper-large-v3-turbo` | `GROQ_API_KEY` |
| **Groq** | Candidate reconstruction | `openai/gpt-oss-120b` (JSON mode) | `GROQ_API_KEY` |

Nothing else is called at runtime. No analytics, no telemetry, no cloud storage, no authentication provider.

`llama-3.3-70b-versatile` was deprecated at the time of building and is **not** used anywhere in this repository. Model IDs were checked against the live catalogs rather than copied from documentation.

**The browser never contacts Rime or Groq directly.** It speaks only to the FastAPI server, over `http://localhost:8000` and one application-level WebSocket at `/ws/tts`. The server is the only process that holds credentials and the only one that opens `wss://users-ws.rime.ai/ws3`.

---

## Failure behavior

Every fallback is visible. Nothing degrades silently.

| Failure | Behavior |
|---|---|
| **Missing `RIME_API_KEY` or `GROQ_API_KEY`** | Server refuses to start, with a clear error. It never falls back to an unauthenticated path |
| **Groq ASR unreachable or erroring** | `POST /api/turn` returns `502` with a safe message; the UI shows "Transcription failed. Try again." The provider's raw payload is never forwarded |
| **Reconstruction returns prose instead of JSON** | One retry. If it fails again, the raw transcript is surfaced as a single low-confidence candidate. The turn never crashes |
| **Reconstruction returns malformed candidates** | Invalid entries are dropped, confidence is clamped to `0.0–1.0`, and the list is capped at 3. Bad data never reaches the UI |
| **Rime connection fails** | An `error` message goes to the browser over `/ws/tts` and is shown in the UI. No audio is fabricated and no non-Rime TTS is substituted |
| **Rime closes the socket between turns** (it does this after each finished context) | Transparent reconnect. One forced reconnect-and-retry absorbs the race; a second real failure surfaces as an error rather than being retried forever |
| **Candidate confidence `< 0.5`** | **Nothing is spoken.** Enforced server-side. Silence is the safety property — the system never guesses aloud |
| **Barge-in mid-playback** | Local audio stops in ~50ms; Rime `clear` is sent; the stale context is fenced; late chunks are counted then discarded; the receipt records `cut` with a measured `cutAt` |
| **Microphone permission denied** | "Microphone permission denied or unavailable." No silent failure, no fake transcript |
| **Backend unreachable from the browser** | "Could not reach the server. Check that the backend is running." |
| **Rime Coverage fails while adding a term** | `502` and the term is not added. `covered` is never guessed or defaulted |
| **Rime Phonemize fails** | "Phonemization failed. Try recording again." The entry stays **unverified** with an empty phoneme — `verified` is only ever set after a real phoneme string is in hand |
| **Preview of a deleted or another user's entry** | `error` over the socket, no synthesis. Deleting and previewing both return the same response for "missing" and "not yours" |
| **Floor-hold phrase fails to synthesize** | Bounded 6s timeout per phrase; the cache ends up with fewer rotation slots rather than hanging the session |
| **Ledger DB missing** | Created on startup. Schema creation never drops or truncates existing rows |

---

## Known limitations

Stated plainly, including the ones that cost us.

**Product scope**

- **English only.** Tamil and Hindi were deliberately cut — see [Rime configuration](#rime-configuration-exact) for why. Multilingual support would mean giving up custom pronunciation, which is the product's core claim.
- **No telephony.** Local browser only.
- **No authentication.** Identity is an anonymous UUID in `localStorage`. Clearing browser storage orphans that user's ledger. This is a hackathon prototype, not a multi-user product.
- **Push-to-talk, not VAD.** End-of-turn is the mic-release gesture. There is no voice-activity detection anywhere in the codebase.
- **Local SQLite only.** `server/relay.db` is a local file. No cloud storage, no sync, no backup.
- **"Meadow" is a substituted voice** (`breeze`), because Rime's live `mistv2` catalog has no speaker by that name.
- **Floor-hold phrases are a fixed set of four English fillers**, rotated deterministically.

**Evidence limitations** — the full accounting is in [`RIME_EVIDENCE.md`](RIME_EVIDENCE.md); the honest summary:

- **AT-1 (pronunciation) did not meet its committed claim as written.** The claim specified 20 terms with 3 blind human listeners. The real fixture has 12 terms; the execution environment had no microphone, no speakers, and no human present. So 8 terms were run using the playbook's own pre-approved hand-authored-phoneme fallback, scored by an **automated ASR re-recognition proxy** explicitly labeled as a proxy. Result: 4/8 already correct at baseline (not wins), **1 improved**, **3 still wrong after treatment** — including `metformin`, which used a phoneme string verified real in the Phase 0 mechanism check. Those three are recorded as honest losses.
- **AT-2 (latency) partially failed.** Floor-hold OFF p50 was 5570.7ms and ON was 480.0ms — a real, measured **91.4% reduction** — but the claim said `<250ms`, so it is scored **FAIL**. The reason is structural, not a defect: floor-holding's own trigger threshold is ~400ms by design, so a 250ms p50 target sits below the product's own firing point. The claim was written before that threshold was chosen and was not rewritten to match the outcome.
- **AT-3 (barge-in) passed 10/10** — but getting there exposed three real bugs in our own connection lifecycle, all documented rather than quietly patched.
- **All speech input in the evidence runs was simulated**, using a fixed WAV of real Rime-synthesized speech fed in as a fake microphone device. **No dysarthric speech was recorded or tested.** Nothing here measures ASR robustness to disordered speech.
- **This is not clinical validation.** It demonstrates that the described mechanisms are real and function as designed. It does not demonstrate efficacy for real users with dysarthria.

**Data**

- **All persona data is synthetic.** "Ananya Sharma", "Dr. Raghunathan", the prescriptions, and the pharmacy are invented — see [`docs/persona.md`](docs/persona.md). No real patient data was used, and none could have been.

---

## Tests

```bash
# Backend — 126 tests
python -m pytest server/tests -q

# Frontend — 48 tests
cd web && npm test

# Types
cd web && npx tsc --noEmit
```

Run the backend suite from the repository root (it resolves `.env` and `server/pytest.ini` from there). Provider calls are faked at module seams, so the suite needs no network — except `server/tests/test_reconstruct_integration.py`, which skips itself when `GROQ_API_KEY` is absent.

---

## Evidence

[`RIME_EVIDENCE.md`](RIME_EVIDENCE.md) carries the hard voice claim, the three acceptance tests, their procedures, their measured results, and their limitations. The claims were written and committed **before** the build, so git history shows the tests predated the results, and they were not rewritten to match what happened.

Reproduce:

```bash
python evidence/at1_pronunciation.py    # coverage sweep + before/after clips
node   evidence/at2_latency_runner.js   # 60 real browser trials
python evidence/at2_analyze.py          # p50/p90 + histogram
node   evidence/at3_bargein.js          # barge-in fencing, 10 assertions
```

AT-2 and AT-3 drive real Chromium against the real backend, real frontend, and real Groq/Rime traffic. Nothing in them mocks the product.

Artifacts: `evidence/results/` (CSV, JSON, histogram) and `evidence/clips/at1/{before,after}/` (real `mistv2` audio pairs).

---

## Repository map

```
server/          FastAPI backend
  config.py        credentials + settings; fails loudly if a key is missing
  models.py        Pydantic models mirroring the frontend's TypeScript contract
  main.py          routes: /health, /api/turn, /api/ledger*, /ws/tts
  asr.py           Groq Whisper
  reconstruct.py   constrained candidate inference
  ledger.py        Coverage + Phonemize + SQLite + {phoneme} injection
  prosody.py       confidence → statement / question / silent
  rime_ws.py       Rime ws3 client; per-context chunk accounting and fencing
  session_ws.py    browser-facing /ws/tts; speak / clear / heard_report
  voices.py        UI voice name → Rime speaker ID
  tests/           126 tests

web/             React + Vite frontend
  src/pages/       Landing, Session, Ledger, About
  src/audio/       AudioContext playback, /ws/tts client, floor-hold cache,
                   pronunciation preview
  src/lib/         identity, ledger state helpers

evidence/        acceptance-test scripts, fixtures, clips, measured results
docs/persona.md  declares the persona synthetic
```

---

## Security and data

- **Credentials are server-side only.** `RIME_API_KEY` and `GROQ_API_KEY` are read by `server/config.py` from the environment. They appear in no frontend file, no `VITE_*` variable, no committed file, no log, no browser message, and no query parameter.
- **`.env` is gitignored. `.env.example` holds placeholders only** — no live value, ever, not even briefly.
- **The browser never talks to Rime or Groq.** Only to the FastAPI server.
- **Ownership is enforced server-side on every ledger operation.** Reading, phonemizing, previewing, and deleting all scope to the requesting user, and "not found" is indistinguishable from "not yours."
- **The pronunciation preview never trusts the browser.** The server loads the ledger row from the database; there is no wire field for a phoneme at all.
- **CORS and WebSocket origin are both restricted** to `ALLOWED_ORIGIN`. `CORSMiddleware` doesn't cover WebSocket upgrades, so `/ws/tts` checks `Origin` itself.
- **All persona and vocabulary data is synthetic.** No clinical recordings, no real patient data.

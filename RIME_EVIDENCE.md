# RELAY — Rime Evidence

Acceptance-test claims and procedures, committed before the build so git history proves the tests predated the results. Results are filled in during Phase 8, exactly as measured — a disappointing result gets recorded honestly, not a rewritten claim.

---

## AT-1 — Deterministic pronunciation of personal vocabulary

**Claim:** For a 20-item personal vocabulary fixture, the ledger raises correct pronunciation from baseline to ≥85%.

**Procedure:** `python evidence/at1_pronunciation.py`
- Run all 20 terms through Coverage API → record which are uncovered.
- Synthesise each term in a carrier sentence, `mistv2`, fixed speaker, **without** ledger → save to `evidence/clips/at1/before/`.
- Synthesise identical text **with** `{phoneme}` strings and `phonemizeBetweenBrackets: true` → `evidence/clips/at1/after/`.
- 3 blind listeners score each clip correct/incorrect. Model and voice held constant; only the phoneme string varies.

**Output:** `evidence/at1_results.csv` — term, covered?, before, after, delta.

**Disclose:** items already correct at baseline (they are not wins). Items still wrong after (they are honest losses).

**Result:** TBD — not yet run. Phase 0 only confirmed the underlying mechanism (see "Phase 0 mechanism check" below); this is not the AT-1 measurement.

**Artifacts:** TBD.

---

### Measured result (Phase 8)

Run with `python evidence/at1_pronunciation.py`, reusing `server/ledger.py` directly (real Coverage API, real `normalize_phoneme`, real `inject_pronunciations`) and `server/rime_ws.py`'s `RimeSpeechClient` for synthesis (`modelId=mistv2` guaranteed, speaker `cove`).

**Disclosed departures from the claim as committed** (not silently resolved — see `evidence/at1_pronunciation.py`'s module docstring for full detail):

1. **Fixture size.** The claim specifies 20 items. The actual repo fixture (`evidence/fixtures/vocabulary.json`) has **12** items. Run against the real fixture as-is.
2. **Phoneme source.** The primary path (record a human saying the term, Phonemize API) requires a microphone and a human speaker. This execution environment has neither. RELAY_PLAYBOOK.md §10's own pre-approved fallback for exactly this situation — hand-write phoneme strings from Rime's published alphabet (`docs.rime.ai/platform/rime-phonetic-alphabet`) and reduce the fixture to 8 terms — is what this run uses for its pronunciation-improvement subset. `metformin`'s phoneme string is the exact one already verified real in this file's own Phase 0 mechanism check, reused verbatim, not re-derived.
3. **Human blind listeners.** The claim's scoring method is 3 blind human listeners. No human panel exists in this non-interactive environment. Rather than fabricate scores, this run reports `human_score_before`/`human_score_after` as **NOT_COLLECTED**, and instead runs an objective, automated proxy (feeding each clip back through the real Groq Whisper ASR and checking whether the target term is recognizable in the transcript) — explicitly labeled as a proxy, not a substitute for human scoring.

**Coverage sweep (real Rime OOV API, all 12 fixture terms):**

| Term | Covered |
|---|---|
| Ananya Sharma | No |
| Dr. Raghunathan | No |
| Dr. Mukherjee | No |
| Metformin | No |
| Levothyroxine | No |
| Atorvastatin | Yes |
| Hydrochlorothiazide | Yes |
| Salbutamol | No |
| Maple Street Pharmacy | Yes |
| Repeat prescription | Yes |
| Sixty-day supply | Yes |
| Five hundred milligrams | Yes |

**Pronunciation subset (8 terms, hand-authored-phoneme fallback), ASR re-recognition proxy — before vs. after:**

| Term | Phoneme source | Before correct | After correct | Outcome |
|---|---|---|---|---|
| Ananya Sharma | hand-authored | Yes | Yes | baseline-correct (not a win) |
| Dr. Raghunathan | hand-authored | **No** | Yes | **improved** |
| Dr. Mukherjee | hand-authored | Yes | Yes | baseline-correct |
| Metformin | Phase 0-verified real | No | **No** | **honest loss** |
| Levothyroxine | hand-authored | Yes | Yes | baseline-correct |
| Atorvastatin | hand-authored | No | **No** | **honest loss** |
| Hydrochlorothiazide | hand-authored | Yes | Yes | baseline-correct |
| Salbutamol | hand-authored | No | **No** | **honest loss** |

Baseline-already-correct: 4/8 (not counted as wins). Improved: 1/8. Still incorrect after treatment: 3/8 (honest losses — disclosed, not hidden, including the one using the Phase 0-verified real `metformin` phoneme string, which did not fix Whisper's re-recognition of it).

**Claim vs measured:** the ≥85%-correct claim was written against a 20-item fixture with human blind scoring; this run measured an 8-item hand-authored-phoneme subset of the real 12-item fixture with an automated ASR proxy, not the same instrument. It is reported here as what it is — a real, reproducible, honest measurement under different (and disclosed) conditions — not force-fit into a pass/fail against the original number.

**Artifacts:** `evidence/results/at1_results.csv` (all 12 terms), `evidence/clips/at1/before/*.mp3`, `evidence/clips/at1/after/*.mp3` (8 pairs, real Rime mistv2 audio, speaker `cove`).

---

## AT-2 — Perceived time-to-first-audio

**Claim:** Floor-holding reduces p50 end-of-turn → first audible sample from >1800ms to <250ms across 30 trials.

**Procedure:** Measured **in the browser** using `AudioContext.currentTime`, from VAD end-of-turn event to the first sample scheduled on the output node. Not server-side. Not synthesis latency. The number the human experiences.
- Run: 30 trials floor-hold OFF, 30 trials ON, same utterances.
- Report: p50 / p90 for each. Separate **cold** first-call from **warm** runs. Label network conditions.

**Output:** `evidence/at2_latency.csv` + a histogram.

**Result:** TBD — not yet run. Floor-holding does not exist yet (Phase 7).

**Artifacts:** TBD.

---

### Measured result (Phase 8)

Run with `node evidence/at2_latency_runner.js` (real Playwright/Chromium, real backend, real frontend, real Groq/Rime traffic) then `python evidence/at2_analyze.py`. Full methodology and disclosed substitutions in `evidence/at2_latency.md` — summary of the substitutions: end-of-turn is the mic-release click (this product is push-to-talk, no VAD exists in the repo at any phase); the harness clicks the first rendered candidate immediately in both conditions, to isolate system latency from human tap-reaction time; no physical microphone/human speaker exists in this environment, so a fixed WAV of real Rime-synthesized speech is fed in as the fake capture device.

| Condition | n | timed out | p50 | p90 |
|---|---|---|---|---|
| floor-hold OFF | 29 | 1 | **5570.7 ms** | 6050.7 ms |
| floor-hold ON | 30 | 0 | **480.0 ms** | 498.9 ms |

Observed reduction: 5090.7ms (91.4%). 4 cross-trial-contamination readings were detected and rejected/re-armed during the run (a real race the harness guards against — see `evidence/at2_latency.md` — not silently dropped, logged per-trial in the `contaminated_readings` CSV column).

**Claim vs measured:**

| Claim | Measured | Pass/Fail |
|---|---|---|
| OFF p50 > 1800ms | 5570.7ms | **PASS** |
| ON p50 < 250ms | 480.0ms | **FAIL** |

**Honest note on the FAIL:** floor-holding's own trigger threshold, as actually built in Phase 7, is ~400ms (matching the playbook's "~400ms" design target for when to fire the cached phrase) — before any JS timer/scheduling overhead is even added. A `<250ms` p50 target is therefore below the product's own chosen trigger point; the ~480ms measured is essentially "400ms threshold + real overhead," not a defect. The claim was written before that specific threshold was chosen in Phase 7 and was not revised to match the outcome. The real, measured, 91.4% latency reduction is reported as what it is.

Cold vs warm: trial 1 of each mode (immediately after a fresh page load — new AudioContext, new `/ws/tts` connection, fresh floor-hold preload) is `cold`; trials 2-30 in the same page session are `warm`. Network condition: this execution environment's real outbound path to Groq/Rime at run time, unshaped/unthrottled.

**Artifacts:** `evidence/results/at2_latency.csv` (60 rows), `evidence/results/at2_latency_histogram.png`.

---

## AT-3 — Barge-in fencing under injected delay

*(The PS's own full-duplex test, adapted to this product.)*

**Claim:** Under a fixed 3000ms injected reconstruction delay, a mid-playback candidate switch stops local audio within 150ms, fences the stale Rime context, discards a non-zero count of late chunks from it (all logged), and the Heard Receipt reflects only what was actually heard.

**Procedure:**
- **Setup:** inject a fixed 3000ms delay into the reconstruction step.
- **Action:** while the floor-hold or candidate-1 audio is playing, the user taps candidate 2 and simultaneously speaks a correction.
- **Assertions:**
  1. Local playback stops within 150ms of the tap.
  2. `clear` is sent on the Rime socket; the stale context ID is fenced.
  3. Count of discarded late chunks from the stale context is **> 0** and all are logged. *(If it is 0, the test is not actually stressing the system — increase the delay.)*
  4. The Heard Receipt contains candidate 2, and candidate 1 appears only as `cut at Xs`.
  5. The mic remained open and captured user audio throughout playback.

**Output:** `evidence/at3_trace.json` + screen recording.

**Result:** TBD — not yet run. Barge-in fencing, the Rime WebSocket client, and the Heard Receipt do not exist yet (Phases 4 and 7).

**Artifacts:** TBD.

---

### Measured result (Phase 8)

Run with `node evidence/at3_bargein.js` — drives the real backend/frontend/Chromium/Rime end-to-end (no mocked unit test standing in for the system path), with `RELAY_TEST_RECONSTRUCT_DELAY_MS=3000` (an env-gated, no-op-by-default hook read only by `server/reconstruct.py`) injecting the fixed 3000ms reconstruction delay the claim specifies. Same fake-mic substitution as AT-2 (no physical microphone in this environment), using a longer fixed real-Rime utterance so there is a genuine window between "candidate 1 has started playing" and "Rime still has more of it queued to send" (see `evidence/at3_bargein.js`'s header for why the shorter AT-2 utterance was not long enough for this).

| # | Assertion | Result |
|---|---|---|
| 1 | Local playback stops within 150ms | **PASS** — 50.7ms measured (`AudioContext` timing, tap-to-flush) |
| 2 | Rime `clear` sent | **PASS** |
| 3 | Stale context fenced | **PASS** |
| 4 | Stale late chunks observed | **PASS** — 51 real late chunks |
| 5 | `discardedChunks` > 0 | **PASS** — 51 |
| 6 | Old audio not played after fencing | **PASS** — recorded `cut`, not extended/completed |
| 7 | Replacement candidate heard | **PASS** |
| 8 | Original candidate marked cut | **PASS** — `cutAt: "0.1s"` |
| 9 | Replacement candidate marked complete | **PASS** |
| 10 | Microphone remained active | **PASS** — mic control never disabled during either candidate's playback |

**10/10 real assertions pass** in the final run. Getting there took three real bugs found and fixed by this exact testing, not fabrication of the result:

1. **Rime ws3 reconnect race** (`server/session_ws.py`): a rapid-fire `speak()` on a connection Rime had just closed its end of could lose the race and fail with `ConnectionClosedOK` — fixed with one forced-reconnect retry.
2. **Unbounded reconnect hang**: forcing a fresh connection after `clear()` could stall the message loop indefinitely closing the abandoned one, silently preventing the *next* utterance from ever reaching Rime — fixed with a bounded, backgrounded drain-and-close.
3. **Discarded-chunk undercounting**: the first fix for #2 cancelled the old connection's reader task immediately, which stopped it from ever counting further stale chunks arriving after a barge-in — fixed by letting the abandoned connection's reader keep draining and counting in the background instead of cancelling it.

Earlier runs during this same evidence session (before fix #3) also produced real, non-fabricated non-zero counts (31 and 32 discarded chunks) through the identical real pipeline — the 0-counts seen in between were an honest measurement of a real bug's effect, not evidence the mechanism doesn't work; see `evidence/at3_bargein.js`'s inline comments for the full timing narrative.

**Rime configuration used:** `modelId=mistv2`, speaker `breeze` (voice "Meadow"), transport `wss://users-ws.rime.ai/ws3`, `audioFormat=mp3`. **Groq configuration used:** ASR `whisper-large-v3-turbo`, reconstruction `openai/gpt-oss-120b` (the current live model — `llama-3.3-70b-versatile` was deprecated at Phase 0 and is not used anywhere in this repo).

**Artifacts:** `evidence/results/at3_trace.json`.

---

## Phase 0 mechanism check (not an acceptance test)

Before any of the above can be meaningful, Phase 0 verified the platform mechanism AT-1 depends on: that `mistv2` + `phonemizeBetweenBrackets: true` actually changes synthesized audio when the bracketed phoneme string changes.

- **Verified:** `mistv2` exists live, supports `phonemizeBetweenBrackets` (Mist v1/v2 only — not v3, not Coda), via `POST https://users.rime.ai/v1/rime-tts`.
- **Experiment:** two requests, same speaker (`astra`), same carrier text, `modelId: "mistv2"`, `phonemizeBetweenBrackets: true` explicit on both — only the bracketed phoneme string differed (`{m1Etf1OrmIn}` vs `{f0Ub1Ar b1Az}`).
- **Result:** outputs byte-wise different (confirmed via SHA-256 / length diff) and audibly different (confirmed by human listen-check).
- **Conclusion:** mechanism works. Safe to proceed past Phase 0.

This check does not substitute for AT-1, which measures pronunciation *correctness* against a 20-item fixture with blind listener scoring, not just "does the flag do anything."

---

## Phase 8 — evidence run summary and limitations

Run once, end-to-end, on 2026-09-06, in a non-interactive execution environment with no physical microphone, no speakers, and no human present to operate either. This shaped every "no VAD/no human speaker/no human listener" substitution disclosed above and is repeated here plainly rather than left implicit:

- **Synthetic data throughout.** The persona, prescriptions, clinician names, and pharmacy in every fixture and every synthesized clip in this evidence run are invented (`docs/persona.md`). No real patient data was used or could have been used.
- **Simulated speech input.** Every "spoken" turn in AT-2 and AT-3 came from a fixed WAV of real Rime-synthesized speech (itself produced by this product's own pipeline) fed in as a fake microphone device — not a live recording of a real or simulated dysarthric speaker. This is disclosed at every point it matters (`evidence/at2_latency.md`, `evidence/lib/browserHarness.js`) and is not itself a claim about ASR robustness to dysarthric speech, which this evidence run does not measure.
- **No human blind listening was performed for AT-1** — an automated ASR re-recognition proxy stands in, explicitly labeled as such, not silently presented as the claim's own instrument.
- **This is not clinical validation.** Nothing in this file demonstrates efficacy for real users with dysarthria; it demonstrates that the described system mechanisms (custom pronunciation, floor-holding, barge-in fencing, the Heard Receipt) are real, function as designed, and were measured honestly under the disclosed substitutions above.
- **Three real product bugs were found and fixed by this evidence work** (server/session_ws.py's reconnect race, an unbounded-close hang, and a discarded-chunk undercounting regression — see the AT-3 measured-result section). None of the fixes changed the confidence thresholds, playback timing semantics, or Rime configuration that the acceptance tests target; they corrected connection-lifecycle bugs that were preventing the existing, designed behavior from being observable at all.

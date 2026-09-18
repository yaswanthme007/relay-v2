# AT-2 — Perceived time-to-first-audio: measurement procedure

**Claim (RIME_EVIDENCE.md, committed before this procedure was run):**
Floor-holding reduces p50 end-of-turn -> first audible sample from >1800ms
to <250ms across 30 trials.

## What is measured

`end-of-turn -> first audible/scheduled output sample`, using
`AudioContext.currentTime` on **both** ends, captured in a **real browser**
(Chromium via Playwright) — never a server timestamp, never synthesis
latency, never an HTTP/WebSocket message timestamp.

- **End-of-turn** = the moment `window.__relayEvidence.turnEndAt` is set,
  which happens inside the mic-release click handler
  (`web/src/pages/SessionPage.tsx`'s `handleMicToggle`), on the same
  `AudioContext` clock used for playback scheduling.
- **First audible/scheduled output sample** = the `startAt` argument of the
  *first* `AudioBufferSourceNode.start()` call made after that turn began —
  captured via `TTSPlaybackQueue.armFirstAudioProbe()`
  (`web/src/audio/ttsPlayback.ts`), which fires on the very next
  `source.start()` regardless of whether that source is a floor-hold
  phrase or a candidate's real streamed audio. This is the same node the
  browser actually schedules for playback — not a proxy for it.

Both values come from `window.__relayEvidence`, a bridge that only exists
when a Playwright harness creates it (see `web/src/audio/evidenceBridge.ts`
— inert for every real user).

## Run

```
cd evidence
npm install        # once
node at2_latency_runner.js
```

Reads `RIME_API_KEY`/`GROQ_API_KEY` from the repo's `.env` via the real
backend process the script spawns (`evidence/lib/browserHarness.js`) —
never hardcoded or duplicated. Produces `evidence/results/at2_latency.csv`
(raw per-trial rows) and, via `evidence/at2_analyze.py`,
`evidence/results/at2_latency_histogram.png` and the p50/p90 summary.

## Per-trial procedure

1. Arm the first-audio probe.
2. Click the mic button (start) — this is a real `getUserMedia` recording
   with a fixed real-speech WAV wired in as the fake capture device (see
   `browserHarness.js`'s header for why: no physical microphone or human
   speaker exists in this execution environment; the WAV is itself real
   Rime-synthesized speech from the product's own pipeline, not a
   synthetic tone).
3. Wait ~3s (a fixed recording duration standing in for one utterance).
4. Click the mic button again (stop) -> `turnEndAt` is recorded ->
   `POST /api/turn` fires for real ASR + real reconstruction.
5. Whichever happens first resolves the armed probe: a floor-hold phrase
   (ON only, ~400ms later) or the eventual real candidate audio.
6. The instant a candidate list renders, the harness clicks the **first**
   candidate — see "Methodology substitutions" below for why this is
   scripted rather than waited-for.
7. Read `firstAudioAt`; `latency_ms = (firstAudioAt - turnEndAt) * 1000`.
8. Wait for this trial's `heard_entry` (playback actually finished) before
   starting the next trial, so one trial's audio can never contaminate the
   next trial's probe.

## Cold vs warm

The page is reloaded fresh (new `AudioContext`, new `/ws/tts` connection,
fresh floor-hold preload) once per **mode** (`floorHoldActive` OFF, then
ON). Trial 1 immediately after that reload is labeled `cold`; trials 2-30
in the same page session are `warm`. This is the network/connection sense
of cold vs warm required by the playbook — not a full OS/browser process
restart per trial, which would make a 30-trial run impractical.

## Methodology substitutions (disclosed, not hidden)

1. **End-of-turn proxy.** The product is push-to-talk (a mic button), not
   continuous VAD — no VAD exists anywhere in this repo, in any phase. The
   mic-release click is the only available end-of-turn signal, and is used
   consistently for both OFF and ON trials.
2. **Scripted immediate candidate confirmation.** The real product requires
   an explicit human tap before anything but a floor-hold phrase can speak.
   Waiting for a real human to react would fold uncontrolled human
   reaction-time variance into a number that is supposed to isolate
   *system* latency (reconstruction + synthesis). The harness clicks the
   first rendered candidate the instant it appears, identically in both
   conditions, so the only thing that differs between OFF and ON is
   whether a floor-hold phrase covers the gap.
3. **No physical microphone or human speaker.** This execution environment
   is non-interactive with no audio hardware and no human operator. A
   fixed WAV of real Rime-synthesized speech (generated once through the
   product's own `/ws/tts` pipeline, `evidence/fixtures/at2_at3_utterance.wav`)
   is fed in via Chromium's `--use-file-for-fake-audio-capture`, so real
   Groq Whisper ASR and real Groq reconstruction still run against real
   (if fixed/repeated) speech content — this is not a synthetic tone or
   silence.
4. **Cross-trial contamination guard.** The first-audio probe fires on the
   next `source.start()` call regardless of which trial armed it. If a
   previous trial's synthesis is still finishing when the next trial arms
   its probe, a stale leftover chunk could satisfy the new trial's probe
   with a timestamp from before that trial's own end-of-turn — a
   physically impossible negative latency (caught in a real dry run, not
   hypothetical). The runner rejects and re-arms any reading earlier than
   the current trial's `turnEndAt`, and separately waits for each trial's
   own `heard_entry` before starting the next one at all. Any rejected
   reading is counted in the `contaminated_readings` CSV column, not
   silently discarded.

## Honest limitations

- 30 trials is one run on one machine, one network path, one time of day —
  not a distribution over conditions. Network condition: whatever this
  execution environment's real outbound path to Groq/Rime was at run time
  (not artificially shaped or throttled).
- The reconstruction+synthesis latency in the OFF condition depends on
  real Groq/Rime response times at run time, which vary run to run — the
  measured p50/p90 in `RIME_EVIDENCE.md` are this run's real numbers, not
  a guaranteed constant.
- The mic-release-to-first-word-appearing gap inherent to real ASR +
  reconstruction is a real, disclosed part of what floor-holding is
  masking — it is not itself a bug.

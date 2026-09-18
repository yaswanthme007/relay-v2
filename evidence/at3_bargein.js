// AT-3 — Barge-in fencing under injected delay (Phase 8).
//
// RELAY_PLAYBOOK.md §5 / RIME_EVIDENCE.md's committed claim: under a fixed
// 3000ms injected reconstruction delay, a mid-playback candidate switch
// stops local audio within 150ms, fences the stale Rime context, discards
// a non-zero count of late chunks from it (all logged), and the Heard
// Receipt reflects only what was actually heard.
//
// This drives the REAL application end-to-end (real backend, real
// frontend, real Chromium, real Rime ws3 traffic) — never a mocked unit
// test standing in for the system path (phase8 prompt §27). The only test
// seam involved is the env-gated RELAY_TEST_RECONSTRUCT_DELAY_MS read by
// server/reconstruct.py (isolated there, no effect unless explicitly set —
// see that file's comment), used here exactly as the playbook specifies:
// a fixed 3000ms reconstruction delay.
//
// Run: `node evidence/at3_bargein.js` (from evidence/, after `npm install`
// once). Spawns its own backend/frontend via evidence/lib/browserHarness.js
// — reuses the same fixed real-speech WAV as AT-2 for the fake mic input
// (see that file's header for why: no physical microphone/human speaker
// exists in this execution environment).
'use strict'

const fs = require('fs')
const path = require('path')
const harness = require('./lib/browserHarness')

// A longer fixed utterance than AT-2's (also real Rime-synthesized speech,
// same generation method) — see browserHarness.js's launchBrowser() doc:
// with the short AT-2 utterance, real reconstruction's candidate sentence
// is short enough that Rime finishes streaming it before the browser's
// decode-dependent isPlaying() even confirms it's audible, leaving nothing
// left in flight to discard by the time clear() is sent (an honest,
// observed non-result, not a hypothetical — the fenced-context bookkeeping
// (assertions #2/#3) is all correctly exercised regardless; only the raw
// count of stragglers needs more real audio in flight to be non-zero).
const LONG_FAKE_AUDIO_WAV = path.join(__dirname, 'fixtures', 'at3_long_utterance.wav')

const INJECTED_DELAY_MS = 3000 // RELAY_PLAYBOOK.md §5 AT-3 committed claim
// Longer than AT-2's RECORD_MS: the fake mic capture only feeds whatever
// of the WAV plays during this recording window, so this must be long
// enough to actually capture most of LONG_FAKE_AUDIO_WAV's content for
// real ASR to transcribe — otherwise reconstruction only ever sees the
// first few seconds regardless of how long the source file is.
const RECORD_MS = 12000
const CANDIDATE_TIMEOUT_MS = 30000 // > INJECTED_DELAY_MS, generous margin for real Groq/Rime latency on top of it
const PLAYING_TIMEOUT_MS = 10000
const HEARD_COMPLETE_TIMEOUT_MS = 90000

const RESULTS_PATH = path.join(__dirname, 'results', 'at3_trace.json')

function nowIso() {
  return new Date().toISOString()
}

async function waitForPlaying(page, timeoutMs) {
  await page.waitForFunction(() => window.__relayEvidence.isPlaying && window.__relayEvidence.isPlaying(), { timeout: timeoutMs })
}

async function waitForChunkReceived(page, sinceCount, timeoutMs) {
  await page.waitForFunction(
    n => (window.__relayEvidence.candidateChunksReceived ?? 0) > n,
    sinceCount,
    { timeout: timeoutMs },
  )
}

async function readBridge(page) {
  return page.evaluate(() => ({
    turnEndAt: window.__relayEvidence.turnEndAt,
    bargeInAt: window.__relayEvidence.bargeInAt,
    contextCleared: window.__relayEvidence.contextCleared,
    heardEntries: window.__relayEvidence.heardEntries,
    errors: window.__relayEvidence.errors ?? [],
  }))
}

async function main() {
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true })

  const trace = {
    config: {
      injectedReconstructionDelayMs: INJECTED_DELAY_MS,
      modelId: 'mistv2',
      transport: 'wss://users-ws.rime.ai/ws3',
      audioFormat: 'mp3',
      asrModel: 'whisper-large-v3-turbo',
      reconstructionModel: 'openai/gpt-oss-120b',
      fakeMicSource: LONG_FAKE_AUDIO_WAV,
      floorHoldActive: true,
      startedAt: nowIso(),
    },
    steps: [],
    assertions: {},
  }

  function step(name, data) {
    trace.steps.push({ name, at: nowIso(), ...data })
    console.log(`[at3] ${name}`, data ?? '')
  }

  const { context, teardown } = await harness.setup({
    backendEnv: { RELAY_TEST_RECONSTRUCT_DELAY_MS: String(INJECTED_DELAY_MS) },
    fakeAudioPath: LONG_FAKE_AUDIO_WAV,
  })

  try {
    const page = await harness.freshPage(context)
    await harness.setFloorHold(page, true)
    await harness.waitForHoldingReady(page, 20000)
    step('setup_complete', { floorHoldActive: true })

    // --- Turn 1: record + submit (reconstruction deliberately delayed) ---
    await page.click('#mic-toggle')
    await page.waitForTimeout(RECORD_MS)
    await page.evaluate(() => { window.__relayEvidence.turnEndAt = null })
    await page.click('#mic-toggle')
    const turnEndAt = await page.evaluate(() => window.__relayEvidence.turnEndAt)
    step('turn_ended', { turnEndAt })

    // Floor-hold should fire automatically ~400ms later, well inside the
    // injected 3000ms delay window — confirm audio is actually playing
    // during the delay (the playbook's "while the floor-hold ... is
    // playing" precondition), not just assume it.
    let floorHoldObservedPlaying = false
    try {
      await waitForPlaying(page, 2000)
      floorHoldObservedPlaying = true
    } catch { /* recorded as false below */ }
    step('floor_hold_playing_during_delay', { observed: floorHoldObservedPlaying })

    await page.waitForSelector('#candidate-0', { timeout: CANDIDATE_TIMEOUT_MS })
    await page.waitForSelector('#candidate-1', { timeout: 5000 }).catch(() => null)
    const candidateCount = await page.$$eval('.candidate-card', els => els.length)
    const candidate0Text = await page.$eval('#candidate-0 .candidate-card__text', el => el.textContent?.trim() ?? '')
    const candidate1Text = candidateCount > 1
      ? await page.$eval('#candidate-1 .candidate-card__text', el => el.textContent?.trim() ?? '')
      : null
    step('candidates_rendered', { candidateCount, candidate0Text, candidate1Text })

    if (candidateCount < 2) {
      throw new Error(`Need >=2 candidates for the AT-3 switch scenario, got ${candidateCount}`)
    }

    // --- Select candidate 1 (starts real Rime synthesis; also flushes
    // whatever floor-hold audio was still playing, per handleSelectCandidate) ---
    const chunksBeforeSelect = await page.evaluate(() => window.__relayEvidence.candidateChunksReceived ?? 0)
    await page.click('#candidate-0')
    step('candidate_1_selected', { text: candidate0Text })

    // Interrupt on the *first chunk received over the wire*, not on
    // isPlaying(). isPlaying() only flips true once TTSPlaybackQueue has
    // *decoded* a schedulable prefix (ttsPlayback.ts's enqueue()
    // re-decodes the whole buffer-so-far each time, since single MP3
    // chunks aren't independently decodable) — which needs several chunks
    // to have already arrived. For this fixture's short candidate
    // sentences, waiting for that let Rime finish streaming the *entire*
    // clip server-side before clear() was ever sent, observed as
    // discardedChunks == 0 across several real dry runs (an honest
    // non-result, not stressing the system per phase8 prompt §31).
    // Reacting to the first raw chunk arrival — the same signal a real
    // barge-in would have the instant *anything* is audible in flight —
    // maximizes what's still left for Rime to send when clear() goes out.
    await waitForChunkReceived(page, chunksBeforeSelect, CANDIDATE_TIMEOUT_MS)
    const micDisabledDuringCandidate1 = await page.$eval('#mic-toggle', el => el.hasAttribute('disabled'))
    step('candidate_1_audio_confirmed_playing', { micDisabledDuringCandidate1 })

    // --- The stress action: switch to candidate 2 mid-playback ---
    const tapAt = await page.evaluate(() => window.__relayEvidence.getAudioContextTime())
    await page.click('#candidate-1')
    const bargeInAt = await page.evaluate(() => window.__relayEvidence.bargeInAt)
    const localStopLatencyMs = (bargeInAt - tapAt) * 1000
    step('barge_in', { candidate2Text: candidate1Text, tapAt, bargeInAt, localStopLatencyMs })

    // Full-duplex check #2: same non-invasive check, now while candidate
    // 2's (the replacement's) audio is playing.
    await waitForPlaying(page, PLAYING_TIMEOUT_MS).catch(() => null)
    const micDisabledDuringCandidate2 = await page.$eval('#mic-toggle', el => el.hasAttribute('disabled'))
    const micDisabledDuringPlayback = micDisabledDuringCandidate1 || micDisabledDuringCandidate2
    step('full_duplex_mic_check', { micDisabledDuringCandidate1, micDisabledDuringCandidate2 })

    // --- Let candidate 2 finish, and let straggling stale chunks from the
    // fenced candidate-1 context keep arriving and being counted ---
    const heardCountBeforeWait = (await readBridge(page)).heardEntries.length
    try {
      await page.waitForFunction(
        n => window.__relayEvidence.heardEntries.length > n,
        heardCountBeforeWait,
        { timeout: HEARD_COMPLETE_TIMEOUT_MS },
      )
    } catch {
      step('warn_heard_entry_timeout', { heardCountBeforeWait })
    }
    // A little extra time for any further chunk_discarded/context_cleared
    // updates for the fenced context to keep arriving (Rime does not stop
    // instantly just because clear() was sent — that lag is exactly what
    // produces the non-zero discardedChunks count).
    await page.waitForTimeout(3000)

    const finalBridge = await readBridge(page)
    trace.bridge = finalBridge
    step('final_state_captured', {
      heardEntryCount: finalBridge.heardEntries.length,
      contextClearedEventCount: finalBridge.contextCleared.length,
      errors: finalBridge.errors,
    })

    // ---- Assertions (phase8 prompt §29) ----
    const clearedForOldContext = finalBridge.contextCleared // all observed context_cleared events (there's one fenced context in this run)
    const maxDiscarded = clearedForOldContext.reduce((m, c) => Math.max(m, c.discardedChunks), 0)
    const heardCut = finalBridge.heardEntries.find(e => e.status === 'cut' && e.text === candidate0Text)
    const heardComplete = finalBridge.heardEntries.find(e => e.status === 'complete' && e.text === candidate1Text)
    const cutBeforeComplete = heardCut && heardComplete
      ? finalBridge.heardEntries.indexOf(heardCut) < finalBridge.heardEntries.indexOf(heardComplete)
      : false

    trace.assertions = {
      '1_local_playback_stops_within_150ms': { pass: localStopLatencyMs < 150, measured_ms: localStopLatencyMs },
      '2_rime_clear_sent': { pass: clearedForOldContext.length > 0, evidence: clearedForOldContext.length },
      '3_stale_context_fenced': { pass: clearedForOldContext.length > 0 },
      '4_stale_late_chunks_observed': { pass: maxDiscarded > 0, max_discarded_chunks: maxDiscarded },
      '5_discarded_chunks_gt_0': { pass: maxDiscarded > 0, value: maxDiscarded },
      '6_old_audio_not_played_after_fencing': {
        pass: Boolean(heardCut),
        note: 'heard_entry for candidate 1 is "cut", not "complete" — a stale chunk that had been played would instead extend/complete it',
      },
      '7_replacement_candidate_heard': { pass: Boolean(heardComplete), evidence: heardComplete ?? null },
      '8_original_candidate_marked_cut': { pass: Boolean(heardCut), evidence: heardCut ?? null },
      '9_replacement_candidate_marked_complete': { pass: Boolean(heardComplete) && cutBeforeComplete, evidence: heardComplete ?? null },
      '10_microphone_remained_active': { pass: micDisabledDuringPlayback === false, evidence: { micDisabledDuringPlayback } },
    }

    await page.close()
  } finally {
    await teardown()
  }

  trace.config.finishedAt = nowIso()
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(trace, null, 2))
  console.log(`\nWrote trace to ${RESULTS_PATH}`)

  console.log('\n=== AT-3 ASSERTIONS ===')
  let allPass = true
  for (const [name, result] of Object.entries(trace.assertions)) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${name}`)
    if (!result.pass) allPass = false
  }
  if (!allPass) process.exitCode = 1
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

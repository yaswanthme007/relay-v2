// AT-2 — Perceived time-to-first-audio (Phase 8).
//
// Measures, in a REAL browser (Playwright/Chromium), end-of-turn -> first
// audible/scheduled output sample, using AudioContext.currentTime on both
// ends (never a server timestamp) — RELAY_PLAYBOOK.md §5 AT-2,
// Measured on the AudioContext clock, never from network timestamps.
//
// Run: `node evidence/at2_latency_runner.js` (from evidence/, `npm install`
// once first). Reads RIME_API_KEY/GROQ_API_KEY from the repo's .env via
// the real backend process it spawns — never hardcoded, never duplicated
// here (evidence/lib/browserHarness.js just launches the real server).
//
// Methodology substitutions, disclosed (see evidence/at2_latency.md for
// full detail — this is not a hidden implementation detail):
//   - "End-of-turn" = the mic-release gesture. The product is push-to-talk,
//     not continuous VAD (no VAD exists in the repo at any phase) — the
//     mic-release click is the only available end-of-turn signal.
//   - The moment a candidate list renders, the harness clicks the FIRST
//     candidate immediately, in BOTH conditions. The real product requires
//     an explicit human tap before anything but a floor-hold phrase can
//     speak; scripting an immediate tap isolates system latency
//     (reconstruction + synthesis) from human tap-reaction time, which is
//     what the claim is actually about.
//   - No physical microphone/human speaker exists in this environment — a
//     fixed WAV of real Rime-synthesized speech is fed in as the fake
//     capture device (see browserHarness.js's header comment).
//
// Cross-trial contamination guard (found via a real dry run, not
// hypothetical): the first-audio probe fires on the *next* source.start()
// call regardless of which trial armed it. If trial N-1's synthesis is
// still finishing when trial N arms its probe, trial N-1's leftover audio
// can satisfy trial N's probe with a timestamp from *before* trial N's own
// end-of-turn — a physically impossible negative latency. This script (1)
// waits for trial N-1's own heard_entry before starting trial N at all,
// and (2) as a backstop, rejects and re-arms any probe result earlier than
// the current trial's turnEndAt, since that can only be a stale leftover.
'use strict'

const fs = require('fs')
const path = require('path')
const harness = require('./lib/browserHarness')

// RIME_EVIDENCE.md / RELAY_PLAYBOOK.md §5 AT-2 committed claim is 30; the
// env override exists only so this file itself can be smoke-tested with a
// couple of trials before committing to a full run — the actual evidence
// run always uses the default 30.
const TRIALS_PER_MODE = process.env.AT2_TRIALS ? Number(process.env.AT2_TRIALS) : 30
const RECORD_MS = 3000
const CANDIDATE_TIMEOUT_MS = 25000
const FIRST_AUDIO_TIMEOUT_MS = 20000
const HEARD_COMPLETE_TIMEOUT_MS = 40000

const RESULTS_DIR = path.join(__dirname, 'results')
const CSV_PATH = path.join(RESULTS_DIR, 'at2_latency.csv')

function nowIso() {
  return new Date().toISOString()
}

function armProbe(page) {
  return page.evaluate(
    () =>
      new Promise(resolve => {
        window.__relayEvidence.armFirstAudioProbe(t => resolve(t))
      }),
  )
}

/** Races a (browser-side) promise against a Node-side timeout. Returns the
 * promise's value, or null on timeout. The loser is not cancelled (it
 * can't be — it's a live in-page callback) but its eventual value is
 * simply never read once we've moved on. */
async function raceWithTimeout(promise, page, timeoutMs) {
  const result = await Promise.race([
    promise.then(v => ({ v })),
    page.waitForTimeout(timeoutMs).then(() => ({ v: null })),
  ])
  return result.v
}

async function waitForHeardCountAbove(page, count, timeoutMs) {
  await page.waitForFunction(
    n => window.__relayEvidence.heardEntries.length > n,
    count,
    { timeout: timeoutMs },
  )
}

/** Arms the probe, waits for a value, and rejects (re-arms) anything that
 * resolves to a timestamp before `turnEndAt` — such a value can only be a
 * stale leftover from a previous trial's still-finishing synthesis, never
 * this trial's own audio (this trial's synthesis request hasn't even been
 * sent until after turnEndAt is recorded). */
async function waitForOwnFirstAudio(page, turnEndAt, totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs
  let contaminatedReadings = 0
  while (Date.now() < deadline) {
    const remaining = Math.max(250, deadline - Date.now())
    const value = await raceWithTimeout(armProbe(page).catch(() => null), page, remaining)
    if (value === null) return { firstAudioAt: null, contaminatedReadings }
    if (turnEndAt === null || value >= turnEndAt) {
      return { firstAudioAt: value, contaminatedReadings }
    }
    contaminatedReadings += 1 // stale leftover — loop and re-arm for the real one
  }
  return { firstAudioAt: null, contaminatedReadings }
}

async function runTrial(page, { mode, coldOrWarm, trialIndexOverall, trialIndexInMode }) {
  // Armed BEFORE end-of-turn, not before the candidate click: floor-hold
  // (when ON) fires ~400ms after turnEndAt, long before reconstruction
  // finishes and a candidate ever renders. Arming late would silently miss
  // it and this would end up measuring the candidate path in both
  // conditions — exactly the regression a first version of this script had.
  const armedEarly = armProbe(page).catch(() => null)

  await page.click('#mic-toggle') // start
  await page.waitForTimeout(RECORD_MS)

  await page.evaluate(() => {
    window.__relayEvidence.turnEndAt = null
  })
  await page.click('#mic-toggle') // stop -> submitTurn(), recordTurnEnd()
  const turnEndAt = await page.evaluate(() => window.__relayEvidence.turnEndAt)

  // Whichever comes first — a floor-hold phrase (~400ms later, ON only) or
  // the eventual real candidate audio — resolves this same armed probe.
  // Raced concurrently with waiting for + clicking the candidate below
  // (not awaited first), since for floor-hold OFF nothing will resolve it
  // until that click happens.
  const earlyResultPromise = raceWithTimeout(armedEarly, page, FIRST_AUDIO_TIMEOUT_MS)

  await page.waitForSelector('#candidate-0', { timeout: CANDIDATE_TIMEOUT_MS })
  const candidateText = await page.$eval('#candidate-0 .candidate-card__text', el => el.textContent?.trim() ?? '')
  await page.click('#candidate-0') // scripted immediate confirmation — see header

  let firstAudioAt = await earlyResultPromise
  let contaminatedReadings = 0
  if (firstAudioAt !== null && turnEndAt !== null && firstAudioAt < turnEndAt) {
    contaminatedReadings += 1
    firstAudioAt = null // stale leftover from a previous trial — fall through to the retry loop below
  }

  if (firstAudioAt === null) {
    // Either nothing fired yet (still waiting — normal for floor-hold OFF,
    // where the candidate click above is what triggers the only audio of
    // the trial) or the early reading was contaminated. Either way, an
    // already-armed probe stays armed; this call arms a fresh one only if
    // needed and waits out the remaining budget.
    const retry = await waitForOwnFirstAudio(page, turnEndAt, FIRST_AUDIO_TIMEOUT_MS)
    firstAudioAt = retry.firstAudioAt
    contaminatedReadings += retry.contaminatedReadings
  }
  const timedOut = firstAudioAt === null

  return {
    trial: trialIndexOverall,
    trial_in_mode: trialIndexInMode,
    mode,
    cold_or_warm: coldOrWarm,
    turn_end_at_s: turnEndAt,
    first_audio_at_s: firstAudioAt,
    latency_ms: turnEndAt !== null && firstAudioAt !== null ? (firstAudioAt - turnEndAt) * 1000 : null,
    timed_out: timedOut,
    contaminated_readings: contaminatedReadings,
    candidate_text: candidateText,
    timestamp: nowIso(),
  }
}

function toCsvRow(fields) {
  return fields.map(f => {
    const s = f === null || f === undefined ? '' : String(f)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const rows = []
  const header = [
    'trial', 'trial_in_mode', 'mode', 'cold_or_warm',
    'turn_end_at_s', 'first_audio_at_s', 'latency_ms', 'timed_out',
    'contaminated_readings', 'candidate_text', 'timestamp',
  ]

  const { context, teardown } = await harness.setup()
  let trialCounter = 0
  try {
    for (const mode of ['off', 'on']) {
      const page = await harness.freshPage(context) // fresh AudioContext/WS connection per mode -> trial 1 of each mode is "cold"
      await harness.setFloorHold(page, mode === 'on')
      await harness.waitForHoldingReady(page, 20000)

      for (let i = 1; i <= TRIALS_PER_MODE; i++) {
        trialCounter += 1
        const coldOrWarm = i === 1 ? 'cold' : 'warm'
        const heardCountBefore = await page.evaluate(() => window.__relayEvidence.heardEntries.length)
        process.stdout.write(`[at2] mode=${mode} trial ${i}/${TRIALS_PER_MODE} (${coldOrWarm})... `)
        try {
          const row = await runTrial(page, {
            mode,
            coldOrWarm,
            trialIndexOverall: trialCounter,
            trialIndexInMode: i,
          })
          rows.push(row)
          console.log(
            `latency_ms=${row.latency_ms === null ? 'N/A' : row.latency_ms.toFixed(1)}` +
            `${row.timed_out ? ' (TIMED OUT)' : ''}${row.contaminated_readings ? ` (${row.contaminated_readings} contaminated reading(s) rejected)` : ''}`,
          )
        } catch (e) {
          console.log(`FAILED: ${e.message}`)
          rows.push({
            trial: trialCounter, trial_in_mode: i, mode, cold_or_warm: coldOrWarm,
            turn_end_at_s: null, first_audio_at_s: null, latency_ms: null,
            timed_out: true, contaminated_readings: 0, candidate_text: `ERROR: ${e.message}`, timestamp: nowIso(),
          })
        }

        // Let this trial's speech actually finish before the next trial
        // touches the mic — the primary defense against cross-trial
        // contamination (the retry loop above is the backstop).
        try {
          await waitForHeardCountAbove(page, heardCountBefore, HEARD_COMPLETE_TIMEOUT_MS)
        } catch {
          console.log(`  [warn] no heard_entry observed within ${HEARD_COMPLETE_TIMEOUT_MS}ms after trial ${trialCounter}`)
        }
      }
      await page.close()
    }
  } finally {
    await teardown()
  }

  const csv = [header.join(','), ...rows.map(r => toCsvRow(header.map(h => r[h])))].join('\n') + '\n'
  fs.writeFileSync(CSV_PATH, csv)
  console.log(`\nWrote ${rows.length} rows to ${CSV_PATH}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

// Shared Playwright harness for AT-2/AT-3 (Phase 8).
//
// Launches the REAL backend (uvicorn/FastAPI) and REAL frontend (Vite dev
// server), then drives a real Chromium instance against them with a fixed
// real-speech WAV (evidence/fixtures/at2_at3_utterance.wav — itself real
// Rime mistv2 audio, generated once via the actual /ws/tts pipeline) fed
// in as the OS microphone device via Chromium's
// --use-file-for-fake-audio-capture flag. ASR (Groq Whisper), reconstruction
// (Groq), the pronunciation ledger, prosody, and Rime ws3 are all
// exercised for real — nothing in this file mocks the product.
//
// Why a fake audio *file* device instead of a human speaker: this
// execution environment has no physical microphone and no human present
// to operate one (see PHASE 7 report / Limitations below). Per Phase 8
// prompt §28, this is "the nearest reproducible real system path
// available" rather than a fabricated assertion — every number that comes
// out of it is a real measurement of the real system, just with the
// human-facing input substituted by a fixed recording of real speech
// (itself produced by the product's own real Rime pipeline).
'use strict'

const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const WEB_DIR = path.join(REPO_ROOT, 'web')
const BACKEND_PORT = 8000
const FRONTEND_PORT = 5173
const FAKE_AUDIO_WAV = path.join(__dirname, '..', 'fixtures', 'at2_at3_utterance.wav')

function waitForHttp(url, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, res => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${url}`))
        else setTimeout(attempt, intervalMs)
      })
    }
    attempt()
  })
}

function spawnLogged(cmd, args, opts, tag) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  const lines = []
  child.stdout.on('data', d => lines.push(`[${tag} out] ${d}`))
  child.stderr.on('data', d => lines.push(`[${tag} err] ${d}`))
  child.__lines = lines
  return child
}

async function startBackend(extraEnv) {
  const child = spawnLogged(
    'python',
    ['-m', 'uvicorn', 'server.main:app', '--port', String(BACKEND_PORT)],
    { cwd: REPO_ROOT, env: { ...process.env, ...extraEnv } },
    'backend',
  )
  try {
    await waitForHttp(`http://localhost:${BACKEND_PORT}/health`, { timeoutMs: 30000 })
  } catch (e) {
    console.error(child.__lines.join(''))
    throw e
  }
  return child
}

async function startFrontend() {
  const viteBin = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawnLogged(
    process.execPath, // run vite's own CLI entry directly with this same node — sidesteps Windows .cmd spawn quirks
    [viteBin, '--port', String(FRONTEND_PORT), '--strictPort'],
    { cwd: WEB_DIR, env: { ...process.env, CI: '1', BROWSER: 'none' } },
    'frontend',
  )
  try {
    await waitForHttp(`http://localhost:${FRONTEND_PORT}/`, { timeoutMs: 30000 })
  } catch (e) {
    console.error(child.__lines.join(''))
    throw e
  }
  return child
}

/** Launch chromium with a fixed real-speech WAV wired as the fake mic.
 * `fakeAudioPath` defaults to the shared AT-2/AT-3 short utterance; AT-3
 * passes a longer one (see its own header comment) so there's a real
 * window between "playback has started" and "Rime still has more of this
 * utterance queued to send" — with the short default, decode-readiness
 * (which needs several chunks already buffered, since single MP3 chunks
 * aren't independently decodable) and "Rime finished sending everything"
 * land too close together to reliably observe non-zero discarded chunks. */
async function launchBrowser(fakeAudioPath = FAKE_AUDIO_WAV) {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream', // auto-accept the mic permission prompt
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fakeAudioPath}`,
    ],
  })
  const context = await browser.newContext()
  await context.grantPermissions(['microphone'], { origin: `http://localhost:${FRONTEND_PORT}` })
  return { browser, context }
}

/** Fresh page with the evidence bridge armed before the app's first script
 * runs (SessionPage.tsx only wires into window.__relayEvidence if it
 * already exists — see web/src/audio/evidenceBridge.ts). */
async function freshPage(context) {
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__relayEvidence = { turnEndAt: null, bargeInAt: null, contextCleared: [], heardEntries: [] }
  })
  await page.goto(`http://localhost:${FRONTEND_PORT}/session`)
  await page.waitForSelector('#mic-toggle', { timeout: 15000 })
  return page
}

async function waitForHoldingReady(page, timeoutMs = 20000) {
  await page.waitForFunction(
    () => typeof window.__relayEvidence.isHoldingReady === 'function' && window.__relayEvidence.isHoldingReady(),
    { timeout: timeoutMs },
  )
}

async function setFloorHold(page, desired) {
  const panelOpen = await page.$('#floor-hold-toggle')
  if (!panelOpen) {
    await page.click('#session-settings-toggle')
    await page.waitForSelector('#floor-hold-toggle', { timeout: 5000 })
  }
  for (let i = 0; i < 3; i++) {
    const isOn = await page.$eval('#floor-hold-toggle', el => el.classList.contains('settings-toggle--on'))
    if (isOn === desired) return
    await page.click('#floor-hold-toggle')
  }
  throw new Error(`Could not settle floor-hold toggle to ${desired}`)
}

async function setup({ backendEnv = {}, fakeAudioPath } = {}) {
  const backend = await startBackend(backendEnv)
  const frontend = await startFrontend()
  const { browser, context } = await launchBrowser(fakeAudioPath)
  return {
    context,
    async teardown() {
      await browser.close().catch(() => {})
      frontend.kill()
      backend.kill()
    },
  }
}

module.exports = {
  setup,
  freshPage,
  waitForHoldingReady,
  setFloorHold,
  FRONTEND_PORT,
  BACKEND_PORT,
  FAKE_AUDIO_WAV,
  REPO_ROOT,
  WEB_DIR,
}

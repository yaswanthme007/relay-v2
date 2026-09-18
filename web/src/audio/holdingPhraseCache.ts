// Floor-hold phrase cache (RELAY_PLAYBOOK.md WOW #1 / phase7 prompt §5-11).
//
// Four short conversational fillers, pre-synthesized through the real
// Rime pipeline in the user's persistent voice and decoded into AudioBuffers
// up front, so that when the 400ms reconstruction threshold fires the
// browser plays a fully-decoded clip immediately — zero network, zero
// synthesis, at the moment it's needed.
//
// This is a cache, not a candidate: playback of these clips never touches
// prosody/confidence and never becomes a Heard Receipt entry (that's
// enforced by the caller checking isHoldingContextId() on the contextId
// this cache hands out, not by anything in here).
import type { TTSSocket } from './ttsSocket'

// Exact wording is a small, deliberately fixed set — see phase7 prompt §5.
export const HOLDING_PHRASES = ['One moment.', 'Hold on.', 'Give me a second.', 'Just a moment.'] as const

const CONTEXT_PREFIX = 'hold_'
// If one phrase's speak() never produces a matching audio_chunk/
// synthesis_done (e.g. the rare Rime reconnect race documented in
// server/rime_ws.py's connect(), where the socket-close race occasionally
// makes a rapid-fire speak() fail) this bounds how long preload() waits on
// it. Without a bound, a single failed phrase hung `preloading` true
// forever, which made isCollecting() steal every subsequent real
// candidate's audio chunks into this cache for the rest of the session —
// found via real Phase 8 evidence testing, not a hypothetical.
const PHRASE_TIMEOUT_MS = 6000

export function isHoldingContextId(contextId: string): boolean {
  return contextId.startsWith(CONTEXT_PREFIX)
}

export class HoldingPhraseCache {
  private readonly ctx: AudioContext
  private buffers: AudioBuffer[] = []
  private rotation = 0
  private nextHoldId = 0

  // State for whichever preload request is currently in flight — routes
  // audio_chunk/synthesis_done events for that one Rime context here
  // instead of into the normal candidate playback queue. `preloading` is
  // the actual gate: collectingContextId is null both "before the first
  // chunk of a preload request has arrived" and "no preload in progress at
  // all", and a live candidate speak() can happen in that second window —
  // isCollecting() must not steal its chunks.
  private preloading = false
  private collectingContextId: string | null = null
  private collectingChunks: Uint8Array[] = []
  private collectingResolve: (() => void) | null = null

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  isReady(): boolean {
    return this.buffers.length > 0
  }

  clear(): void {
    this.buffers = []
    this.rotation = 0
  }

  /** Next holding phrase in rotation (deterministic, not random — phase7
   * prompt §9) plus a fresh contextId for it to play under. Null if the
   * cache isn't ready yet (still preloading, or preload failed). */
  nextPhrase(): { buffer: AudioBuffer; contextId: string } | null {
    if (!this.isReady()) return null
    const buffer = this.buffers[this.rotation % this.buffers.length]
    this.rotation += 1
    this.nextHoldId += 1
    return { buffer, contextId: `${CONTEXT_PREFIX}${this.nextHoldId}` }
  }

  /** True while a chunk/done event belongs to the in-flight preload
   * request — the caller's socket event dispatcher checks this before
   * routing a message to the normal candidate playback path. */
  isCollecting(contextId: string): boolean {
    if (!this.preloading) return false
    return this.collectingContextId === null || this.collectingContextId === contextId
  }

  handleChunk(contextId: string, data: Uint8Array): void {
    if (this.collectingContextId === null) this.collectingContextId = contextId
    if (contextId !== this.collectingContextId) return
    this.collectingChunks.push(data)
  }

  handleDone(contextId: string): void {
    if (contextId !== this.collectingContextId) return
    void this.finishCollecting()
  }

  private async finishCollecting(): Promise<void> {
    const total = this.collectingChunks.reduce((n, c) => n + c.length, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const c of this.collectingChunks) {
      merged.set(c, offset)
      offset += c.length
    }
    try {
      const buffer = await this.ctx.decodeAudioData(merged.buffer)
      this.buffers.push(buffer)
    } catch {
      // One phrase failing to decode shouldn't break the whole cache —
      // preload() below just ends up with fewer rotation slots.
    }
    const resolve = this.collectingResolve
    this.collectingContextId = null
    this.collectingChunks = []
    this.collectingResolve = null
    resolve?.()
  }

  /** Synthesize and cache all four phrases in `voiceName`, sequentially
   * (one Rime context at a time, matching the single ws3 connection the
   * rest of the app uses — no second connection just for this). Safe to
   * call again on voice change; the caller should call clear() first so a
   * phrase in the old voice is never played. */
  async preload(socket: TTSSocket, voiceName: string): Promise<void> {
    this.preloading = true
    try {
      for (const phrase of HOLDING_PHRASES) {
        const settled = await this.synthesizeOnePhrase(socket, phrase, voiceName)
        if (!settled) {
          // Timed out — abandon whatever this phrase's request was still
          // collecting so a very late stray chunk/done for it can't be
          // misread as belonging to the *next* phrase's fresh collection.
          this.collectingContextId = null
          this.collectingChunks = []
          this.collectingResolve = null
        }
      }
    } finally {
      this.preloading = false
    }
  }

  private synthesizeOnePhrase(socket: TTSSocket, phrase: string, voiceName: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, PHRASE_TIMEOUT_MS)

      this.collectingContextId = null
      this.collectingChunks = []
      this.collectingResolve = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      }
      // kind: 'holding' — bypasses confidence/prosody/ledger server-side
      // (server/session_ws.py). Confidence value is a required field on
      // the wire but meaningless here; 1.0 documents "always speak" at
      // the call site.
      socket.speak(phrase, voiceName, 1.0, undefined, 'holding')
    })
  }
}

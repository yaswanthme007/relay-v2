// Voice Ledger pronunciation preview controller.
//
// One job: turn "the user clicked a ledger word" into audible speech
// through the *existing* pipeline — /ws/tts -> server -> Rime mistv2 ->
// audio_chunk -> TTSPlaybackQueue (Web Audio AudioContext). There is no
// second TTS implementation, no second playback system, and no <audio>
// tag anywhere in here.
//
// It is deliberately a plain class rather than React state so the whole
// idle -> loading -> playing -> idle state machine, and the repeated-click
// rules, are testable headlessly with the existing Vitest setup and
// __tests__/fakeAudioContext.ts — same approach the Phase 7 audio modules
// already take.
//
// A preview is NOT conversational speech: this controller never calls
// TTSSocket.reportHeard(), so a preview can never produce a Heard Receipt
// entry. The receipt describes what the user chose to relay, not what they
// auditioned.
import type { TTSPlaybackQueue } from './ttsPlayback'

/** The subset of TTSSocket this controller needs — narrowed so tests can
 * substitute a fake without constructing a real WebSocket. */
export interface PreviewSocket {
  previewLedgerEntry(entryId: string, word: string, voice: string): boolean
  clear(): void
}

export type PreviewPhase = 'loading' | 'playing'

export interface PreviewState {
  /** Ledger entry currently being previewed, or null when idle. */
  entryId: string | null
  phase: PreviewPhase | null
}

export const IDLE_PREVIEW: PreviewState = { entryId: null, phase: null }

// If a preview request never produces a single audio chunk (server error
// already surfaced, socket dropped mid-request, Rime reconnect race) the
// row must not stay stuck in its loading state forever. Bounded exactly
// like holdingPhraseCache.ts's PHRASE_TIMEOUT_MS, for the same reason.
export const PREVIEW_TIMEOUT_MS = 8000

export class PronunciationPreview {
  private readonly queue: TTSPlaybackQueue
  private readonly onStateChange: (state: PreviewState) => void
  private readonly timeoutMs: number

  private state: PreviewState = IDLE_PREVIEW
  /** The contextId the server assigned to the in-flight preview, learned
   * from its first audio_chunk (speak() does not echo one synchronously —
   * the documented wire contract). */
  private activeContextId: string | null = null
  /** Contexts superseded by a newer preview. A chunk already in flight
   * over the WebSocket when clear() was sent can still arrive afterwards;
   * it must never be mistaken for the start of the new preview (the same
   * race SessionPage fences in Phase 7). */
  private readonly fenced = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    queue: TTSPlaybackQueue,
    onStateChange: (state: PreviewState) => void,
    timeoutMs: number = PREVIEW_TIMEOUT_MS,
  ) {
    this.queue = queue
    this.onStateChange = onStateChange
    this.timeoutMs = timeoutMs
  }

  getState(): PreviewState {
    return this.state
  }

  private setState(next: PreviewState): void {
    this.state = next
    this.onStateChange(next)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Request a preview of one ledger entry.
   *
   * Repeated-click policy (deliberately the simplest predictable rule):
   *   - clicking the word that is already loading/playing -> ignored, the
   *     current preview runs to completion. Returns false.
   *   - clicking a *different* word while one is in flight -> the current
   *     preview is cancelled (local playback flushed, `clear` sent, its
   *     context fenced) and the new one starts. Returns true.
   * Either way exactly one preview is ever in flight, so rapid clicking
   * can never pile up overlapping Rime streams.
   */
  request(socket: PreviewSocket, entryId: string, word: string, voice: string): boolean {
    if (this.state.entryId === entryId) return false

    if (this.state.entryId !== null) this.cancelActive(socket)

    const sent = socket.previewLedgerEntry(entryId, word, voice)
    if (!sent) {
      // Socket not open — stay idle rather than showing a loading state
      // that nothing will ever resolve.
      this.setState(IDLE_PREVIEW)
      return false
    }

    this.setState({ entryId, phase: 'loading' })
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.finish()
    }, this.timeoutMs)
    return true
  }

  /** Stop whatever is currently previewing: silence local playback
   * immediately, tell the server to cancel synthesis, and fence the
   * context so late chunks can't leak into the next preview. */
  private cancelActive(socket: PreviewSocket): void {
    const flushed = this.queue.flush()
    if (flushed) this.fenced.add(flushed.contextId)
    if (this.activeContextId) this.fenced.add(this.activeContextId)
    socket.clear()
    this.activeContextId = null
    this.clearTimer()
  }

  /** Feed one audio_chunk event in. Returns true if it belonged to the
   * active preview (and was therefore played), false if it was fenced or
   * arrived with no preview in flight. */
  handleChunk(contextId: string, data: Uint8Array): boolean {
    if (this.fenced.has(contextId)) return false
    if (this.state.entryId === null) return false

    if (this.activeContextId !== contextId) {
      if (this.activeContextId !== null) {
        // A second context for one preview request should not happen; if
        // it does, the newer one wins and the older is fenced rather than
        // both being scheduled.
        this.fenced.add(this.activeContextId)
      }
      this.activeContextId = contextId
      this.queue.startContext(contextId, () => this.finish())
      this.setState({ entryId: this.state.entryId, phase: 'playing' })
    }

    void this.queue.enqueue(contextId, data)
    return true
  }

  /** Feed one synthesis_done event in. Playback completion (and therefore
   * the return to idle) is reported by TTSPlaybackQueue's own onEnded
   * callback, not by this event — `done` only means Rime stopped sending. */
  handleDone(contextId: string): void {
    if (this.fenced.has(contextId)) return
    if (contextId !== this.activeContextId) return
    this.queue.markDone(contextId)
  }

  /** A server-side error for the in-flight preview: return to a usable
   * idle state immediately rather than leaving the row spinning. */
  handleError(): void {
    this.finish()
  }

  /** Back to idle, whatever the reason (natural end, timeout, error). */
  private finish(): void {
    this.clearTimer()
    this.activeContextId = null
    if (this.state.entryId !== null) this.setState(IDLE_PREVIEW)
  }

  /** Page teardown — stop audio and drop any pending timer. */
  dispose(): void {
    this.clearTimer()
    this.queue.flush()
    this.activeContextId = null
    this.state = IDLE_PREVIEW
  }
}

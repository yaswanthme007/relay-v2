// Streaming MP3 playback queue, built on Web Audio AudioContext (not
// <audio> tags — sample-accurate timing and instant
// flush for later AT-2/AT-3 work, which <audio> can't give us).
//
// Rime's individual chunks are not guaranteed to be independently
// decodable MP3 files on their own (a lone MPEG frame can depend on the
// prior frame's bit reservoir) — verified empirically in Phase 4 rather
// than assumed. So each new chunk is appended to a running buffer and the
// *whole* buffer-so-far is re-decoded; only the newly-decoded tail (past
// what's already been scheduled) is scheduled for playback. This starts
// audible playback as soon as the first prefix becomes decodable, without
// waiting for the complete utterance.
//
// Phase 7 adds context ownership: every scheduled segment belongs to a
// contextId (RELAY_PLAYBOOK.md WOW #4 / phase7 prompt §33). enqueue()
// fences out anything that doesn't match the current context — belt and
// braces alongside the server-side fencing in rime_ws.py, since a chunk
// already in flight over the WebSocket when clear() is sent can still
// arrive after the browser has moved on. flush() stops audible/scheduled
// sources immediately (targeting <150ms, phase7 prompt §15) and reports
// what was actually heard, so the caller can produce an honest Heard
// Receipt entry instead of guessing from network timing.
export interface HeardResult {
  contextId: string
  started: boolean
  status: 'complete' | 'cut'
  /** Seconds of audio actually audible — measured from AudioContext
   * timing, not wall-clock or network timestamps. */
  elapsedSeconds: number
}

export class TTSPlaybackQueue {
  private readonly ctx: AudioContext
  private chunks: Uint8Array[] = []
  private playedSamples = 0
  private nextStartTime = 0

  private currentContextId: string | null = null
  private activeSources: AudioBufferSourceNode[] = []
  private pendingSourceCount = 0
  private playbackStartedAt: number | null = null
  private doneSignaled = false
  private onContextEnded: ((result: HeardResult) => void) | null = null
  private ended = false

  // Phase 8 evidence hook only (evidence/lib/browserHarness.mjs via
  // evidenceBridge.ts) — fires once, the next time ANY source actually
  // gets start()'d (hold phrase or candidate audio alike), then clears
  // itself. Unarmed (null) by default, so it has no effect unless an
  // evidence run explicitly arms it per trial.
  private firstAudioProbe: ((startAt: number) => void) | null = null

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  armFirstAudioProbe(cb: (startAt: number) => void): void {
    this.firstAudioProbe = cb
  }

  private fireFirstAudioProbe(startAt: number): void {
    const probe = this.firstAudioProbe
    if (!probe) return
    this.firstAudioProbe = null
    probe(startAt)
  }

  /** Begin a brand-new synthesis context. Any chunk enqueued under a
   * different contextId after this point is fenced out. `onEnded` fires
   * exactly once for this context — either from natural completion
   * (markDone() + all scheduled audio finished) or never, if the context
   * is flushed first (flush() reports that outcome directly to its caller
   * instead, since barge-in needs the result synchronously). */
  startContext(contextId: string, onEnded: (result: HeardResult) => void): void {
    this.chunks = []
    this.playedSamples = 0
    this.nextStartTime = this.ctx.currentTime
    this.currentContextId = contextId
    this.activeSources = []
    this.pendingSourceCount = 0
    this.playbackStartedAt = null
    this.doneSignaled = false
    this.onContextEnded = onEnded
    this.ended = false
  }

  /** Back-compat entry point from Phase 4, used anywhere a caller doesn't
   * need this context's completion tracked. */
  reset(): void {
    this.startContext(`ctx_untracked_${Math.random().toString(36).slice(2)}`, () => {})
  }

  /** Rime has finished streaming this context — no more chunks are coming.
   * If every scheduled segment has already finished playing, fires the
   * completion callback immediately; otherwise it fires when the last one
   * does. A stale/mismatched contextId (already superseded) is a no-op. */
  markDone(contextId: string): void {
    if (contextId !== this.currentContextId) return
    this.doneSignaled = true
    this.maybeFireEnded()
  }

  private maybeFireEnded(): void {
    if (this.ended || !this.currentContextId) return
    if (this.doneSignaled && this.pendingSourceCount === 0) {
      this.ended = true
      this.onContextEnded?.({
        contextId: this.currentContextId,
        started: this.playbackStartedAt !== null,
        status: 'complete',
        elapsedSeconds: this.playbackStartedAt !== null ? this.nextStartTime - this.playbackStartedAt : 0,
      })
    }
  }

  /** Stop everything immediately — the barge-in primitive (phase7 prompt
   * §15/§34). Targets <150ms from call to silence: no decode wait, no
   * network round trip, just stopping already-scheduled AudioBufferSource
   * nodes. Returns what happened to the just-flushed context (null only if
   * no context was active at all) — `started: false` means it never
   * became audible, so the caller must not report it as a "cut" Heard
   * Receipt entry (phase7 prompt §27), even though the contextId still
   * needs fencing against a late chunk. The AudioContext itself is left
   * running and reusable. */
  flush(): HeardResult | null {
    const contextId = this.currentContextId
    if (contextId === null) return null

    const wasStarted = this.playbackStartedAt !== null
    const elapsed = wasStarted ? Math.max(0, this.ctx.currentTime - this.playbackStartedAt!) : 0

    for (const source of this.activeSources) {
      source.onended = null // avoid a stray completion firing after we've already decided this is "cut"
      try {
        source.stop(0)
      } catch {
        // already stopped/never started — fine, nothing left to silence
      }
      try {
        source.disconnect()
      } catch {
        // already disconnected
      }
    }

    this.chunks = []
    this.playedSamples = 0
    this.nextStartTime = this.ctx.currentTime
    this.currentContextId = null
    this.activeSources = []
    this.pendingSourceCount = 0
    this.playbackStartedAt = null
    this.doneSignaled = false
    this.onContextEnded = null
    this.ended = true

    return { contextId, started: wasStarted, status: 'cut', elapsedSeconds: elapsed }
  }

  isPlaying(): boolean {
    return this.nextStartTime > this.ctx.currentTime
  }

  /** Enqueue one raw MP3 chunk belonging to `contextId` and attempt to
   * schedule any newly-decodable audio it produces. Never throws — an
   * undecodable prefix just waits for the next chunk. A chunk for any
   * context other than the current one is discarded (fenced), not played —
   * decodeAudioData is async, so the context can also change *while* this
   * call is awaiting it; that race is checked again after decode. */
  async enqueue(contextId: string, chunkBytes: Uint8Array): Promise<void> {
    if (contextId !== this.currentContextId) return

    this.chunks.push(chunkBytes)

    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const c of this.chunks) {
      merged.set(c, offset)
      offset += c.length
    }

    let audioBuffer: AudioBuffer
    try {
      audioBuffer = await this.ctx.decodeAudioData(merged.buffer)
    } catch {
      return // not enough data yet to form a decodable stream — wait for more
    }

    if (contextId !== this.currentContextId) return // fenced/superseded while decoding

    const totalSamples = audioBuffer.length
    if (totalSamples <= this.playedSamples) return

    const newSampleCount = totalSamples - this.playedSamples
    const tail = this.ctx.createBuffer(audioBuffer.numberOfChannels, newSampleCount, audioBuffer.sampleRate)
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      tail.copyToChannel(audioBuffer.getChannelData(ch).subarray(this.playedSamples, totalSamples), ch)
    }

    const startAt = Math.max(this.nextStartTime, this.ctx.currentTime)
    if (this.playbackStartedAt === null) this.playbackStartedAt = startAt

    const source = this.ctx.createBufferSource()
    source.buffer = tail
    source.connect(this.ctx.destination)
    this.pendingSourceCount += 1
    this.activeSources.push(source)
    source.onended = () => {
      this.pendingSourceCount = Math.max(0, this.pendingSourceCount - 1)
      this.maybeFireEnded()
    }
    this.fireFirstAudioProbe(startAt)
    source.start(startAt)

    this.nextStartTime = startAt + tail.duration
    this.playedSamples = totalSamples
  }

  /** Play a fully pre-decoded buffer as its own context — used for
   * floor-hold phrases, which are synthesized and decoded ahead of time
   * (phase7 prompt §6), so playback starts with zero decode wait. Reuses
   * the same context-tracking/flush machinery as enqueue() so a barge-in
   * stops a holding phrase exactly the same way it stops candidate audio. */
  playBuffer(contextId: string, buffer: AudioBuffer, onEnded?: (result: HeardResult) => void): void {
    this.startContext(contextId, onEnded ?? (() => {}))

    const startAt = this.ctx.currentTime
    this.playbackStartedAt = startAt

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    this.pendingSourceCount = 1
    this.activeSources.push(source)
    source.onended = () => {
      this.pendingSourceCount = 0
      this.maybeFireEnded()
    }
    this.fireFirstAudioProbe(startAt)
    source.start(startAt)

    this.nextStartTime = startAt + buffer.duration
    this.doneSignaled = true // the whole buffer is already known — nothing more is "coming"
  }
}

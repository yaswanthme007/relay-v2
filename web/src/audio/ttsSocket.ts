// Browser-facing WebSocket client for /ws/tts. Talks only the application
// protocol (speak/clear/heard_report in, audio_chunk/synthesis_done/
// context_cleared/heard_entry/error out) — never touches Rime directly,
// never sees RIME_API_KEY. Matches the documented wire contract and
// server/session_ws.py, extended in Phase 7 with heard_report
// (browser -> server: what was actually heard) and heard_entry (server ->
// browser: the timestamped, documented HeardEntry built from that report).

export type TTSEvent =
  | { type: 'audio_chunk'; contextId: string; data: Uint8Array }
  | { type: 'synthesis_done'; contextId: string }
  | { type: 'context_cleared'; contextId: string; discardedChunks: number }
  | { type: 'heard_entry'; entry: { time: string; status: 'complete' | 'cut' | 'pending'; text: string; cutAt?: string } }
  | { type: 'error'; contextId?: string; message: string }

export type TTSConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export class TTSSocket {
  private ws: WebSocket | null = null
  private readonly url: string
  private readonly onEvent: (event: TTSEvent) => void
  private readonly onStateChange: (state: TTSConnectionState) => void

  constructor(
    url: string,
    onEvent: (event: TTSEvent) => void,
    onStateChange: (state: TTSConnectionState) => void,
  ) {
    this.url = url
    this.onEvent = onEvent
    this.onStateChange = onStateChange
  }

  connect(): void {
    this.onStateChange('connecting')
    const ws = new WebSocket(this.url)

    ws.onopen = () => this.onStateChange('connected')
    ws.onclose = () => this.onStateChange('disconnected')
    ws.onerror = () => this.onStateChange('error')

    ws.onmessage = (event: MessageEvent<string>) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(event.data)
      } catch {
        return // malformed server message — nothing sane to do with it client-side
      }

      switch (msg.type) {
        case 'audio_chunk':
          this.onEvent({
            type: 'audio_chunk',
            contextId: String(msg.contextId),
            data: base64ToBytes(String(msg.data)),
          })
          break
        case 'synthesis_done':
          this.onEvent({ type: 'synthesis_done', contextId: String(msg.contextId) })
          break
        case 'context_cleared':
          this.onEvent({
            type: 'context_cleared',
            contextId: String(msg.contextId),
            discardedChunks: Number(msg.discardedChunks ?? 0),
          })
          break
        case 'heard_entry': {
          const entry = msg.entry as Record<string, unknown>
          this.onEvent({
            type: 'heard_entry',
            entry: {
              time: String(entry.time),
              status: entry.status as 'complete' | 'cut' | 'pending',
              text: String(entry.text),
              cutAt: entry.cutAt ? String(entry.cutAt) : undefined,
            },
          })
          break
        }
        case 'error':
          this.onEvent({
            type: 'error',
            contextId: msg.contextId ? String(msg.contextId) : undefined,
            message: String(msg.message ?? 'Unknown TTS error'),
          })
          break
      }
    }

    this.ws = ws
  }

  // confidence is required (Phase 6): the server enforces the silent
  // branch itself and must not depend on the caller remembering to omit
  // speak() for a low-confidence candidate (Phase 6).
  // kind (Phase 7): 'holding' marks a floor-hold preload request — the
  // server bypasses confidence/prosody/ledger entirely for it.
  speak(text: string, voice: string, confidence: number, pauseHint?: number, kind?: 'candidate' | 'holding'): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'speak',
      text,
      voice,
      confidence,
      ...(pauseHint !== undefined ? { pauseHint } : {}),
      ...(kind ? { kind } : {}),
    }))
  }

  /** Voice Ledger pronunciation preview: speak one stored ledger entry so
   * the user can check its pronunciation before using it in a real
   * sentence. `kind: 'preview'` on the existing speak message — the
   * server loads that entry from the database itself (scoped to this
   * connection's userId) and takes the word and any verified `{phoneme}`
   * string from there. `word` is only the label the row is displaying and
   * `confidence: 1.0` only documents "not confidence-gated"; neither is
   * trusted server-side, and there is no wire field for a phoneme at all.
   *
   * A preview is never a Heard Receipt entry — reportHeard() must not be
   * called for a preview context (LedgerPage never calls it at all).
   * Returns false if the socket isn't open, so the caller can leave its
   * loading state instead of hanging. */
  previewLedgerEntry(entryId: string, word: string, voice: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({
      type: 'speak',
      text: word,
      voice,
      confidence: 1.0,
      kind: 'preview',
      entryId,
    }))
    return true
  }

  clear(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'clear' }))
  }

  /** Phase 7: report what the browser actually observed for one synthesis
   * context (AudioContext playback state) — the server timestamps it and
   * re-emits the documented heard_entry event. Never called for a
   * floor-hold context (those are never candidates, see
   * holdingPhraseCache.ts's isHoldingContextId). */
  reportHeard(contextId: string, text: string, status: 'complete' | 'cut', cutAtSeconds?: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'heard_report',
      contextId,
      text,
      status,
      ...(cutAtSeconds !== undefined ? { cutAtSeconds } : {}),
    }))
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}

// Phase 8 evidence hook. A thin, optional bridge that lets an external
// Playwright harness (evidence/lib/browserHarness.mjs) pull ground-truth
// AudioContext timing and event traces out of a real running session, for
// AT-2/AT-3's "measure it in the browser, not the server" requirement.
//
// This module never creates `window.__relayEvidence` itself — a harness
// does that via page.addInitScript() *before* the app loads. For every
// real user, `window.__relayEvidence` is simply undefined and every
// function below is a no-op, so this has zero footprint on the normal
// product path: an evidence hook must be isolated and incapable of
// silently affecting production.
export interface HeardEntrySnapshot {
  time: string
  status: string
  text: string
  cutAt?: string
}

export interface RelayEvidenceBridge {
  turnEndAt: number | null
  bargeInAt: number | null
  contextCleared: { contextId: string; discardedChunks: number; at: number }[]
  heardEntries: HeardEntrySnapshot[]
  errors: { message: string; contextId?: string; at: number }[]
  candidateChunksReceived: number
  armFirstAudioProbe?: (cb: (t: number) => void) => void
  getAudioContextTime?: () => number
  isHoldingReady?: () => boolean
  isPlaying?: () => boolean
}

declare global {
  interface Window {
    __relayEvidence?: Partial<RelayEvidenceBridge>
  }
}

function bridge(): Partial<RelayEvidenceBridge> | undefined {
  return typeof window !== 'undefined' ? window.__relayEvidence : undefined
}

export function recordTurnEnd(t: number): void {
  const b = bridge()
  if (b) b.turnEndAt = t
}

export function recordBargeIn(t: number): void {
  const b = bridge()
  if (b) b.bargeInAt = t
}

export function recordContextCleared(contextId: string, discardedChunks: number, at: number): void {
  const b = bridge()
  if (!b) return
  b.contextCleared = b.contextCleared ?? []
  b.contextCleared.push({ contextId, discardedChunks, at })
}

export function recordHeardEntry(entry: HeardEntrySnapshot): void {
  const b = bridge()
  if (!b) return
  b.heardEntries = b.heardEntries ?? []
  b.heardEntries.push(entry)
}

/** Counts real candidate audio_chunk events as they're *received* over
 * the WebSocket — before decode, before scheduling. Used only by the AT-3
 * evidence harness, which needs to react to "a chunk has arrived" rather
 * than "the queue has decoded enough to be audible" (ttsPlayback.ts's
 * isPlaying() can lag network arrival by several chunks for a short
 * utterance, since single MP3 chunks aren't independently decodable —
 * see at3_bargein.js's comment on this exact finding). */
export function recordCandidateChunkReceived(): void {
  const b = bridge()
  if (!b) return
  b.candidateChunksReceived = (b.candidateChunksReceived ?? 0) + 1
}

export function recordError(message: string, at: number, contextId?: string): void {
  const b = bridge()
  if (!b) return
  b.errors = b.errors ?? []
  b.errors.push({ message, contextId, at })
}

export function wireFirstAudioProbe(queue: { armFirstAudioProbe: (cb: (t: number) => void) => void }): void {
  const b = bridge()
  if (b) b.armFirstAudioProbe = cb => queue.armFirstAudioProbe(cb)
}

export function wireAudioContextTimeGetter(getter: () => number): void {
  const b = bridge()
  if (b) b.getAudioContextTime = getter
}

export function wireHoldingReadyGetter(getter: () => boolean): void {
  const b = bridge()
  if (b) b.isHoldingReady = getter
}

export function wireIsPlayingGetter(getter: () => boolean): void {
  const b = bridge()
  if (b) b.isPlaying = getter
}

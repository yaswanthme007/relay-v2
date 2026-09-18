// Voice Ledger pronunciation preview — the idle -> loading -> playing ->
// idle state machine, the repeated-click rules, and the guarantee that a
// preview never touches the Heard Receipt.
//
// Headless, like the other tests in this directory: TTSPlaybackQueue runs
// on fakeAudioContext.ts and TTSSocket is replaced by a recording fake, so
// no WebSocket, no Rime, and no real Web Audio are involved.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TTSPlaybackQueue } from '../ttsPlayback'
import { PronunciationPreview, IDLE_PREVIEW, type PreviewSocket } from '../pronunciationPreview'
import { FakeAudioContext } from './fakeAudioContext'

class FakeSocket implements PreviewSocket {
  previews: Array<{ entryId: string; word: string; voice: string }> = []
  clears = 0
  open = true
  /** Recorded only to assert it stays empty — a preview must never report
   * a Heard Receipt entry (the real TTSSocket has this method; the preview
   * controller must never call it). */
  heardReports: string[] = []

  previewLedgerEntry(entryId: string, word: string, voice: string): boolean {
    if (!this.open) return false
    this.previews.push({ entryId, word, voice })
    return true
  }

  clear(): void {
    this.clears += 1
  }

  reportHeard(contextId: string): void {
    this.heardReports.push(contextId)
  }
}

function setup() {
  const ctx = new FakeAudioContext()
  const queue = new TTSPlaybackQueue(ctx as unknown as AudioContext)
  const states: Array<{ entryId: string | null; phase: string | null }> = []
  const preview = new PronunciationPreview(queue, s => states.push({ ...s }))
  const socket = new FakeSocket()
  return { ctx, queue, preview, socket, states }
}

const CHUNK = new Uint8Array([1, 2, 3, 4])

/** Let the queue's async decode settle without advancing fake timers —
 * advancing them would also fire the preview's own inactivity timeout and
 * mask the state under test. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('PronunciationPreview', () => {
  it('starts idle', () => {
    const { preview } = setup()
    expect(preview.getState()).toEqual(IDLE_PREVIEW)
  })

  it('clicking a term requests a preview of that ledger entry in the given voice', () => {
    const { preview, socket } = setup()

    const started = preview.request(socket, 'e1', 'Metformin', 'Meadow')

    expect(started).toBe(true)
    expect(socket.previews).toEqual([{ entryId: 'e1', word: 'Metformin', voice: 'Meadow' }])
  })

  it('shows a loading state until audio arrives, then a playing state', async () => {
    const { preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    expect(preview.getState()).toEqual({ entryId: 'e1', phase: 'loading' })

    preview.handleChunk('ctx_1', CHUNK)
    await flush()

    expect(preview.getState()).toEqual({ entryId: 'e1', phase: 'playing' })
  })

  it('returns to idle once playback finishes', async () => {
    const { ctx, preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    preview.handleChunk('ctx_1', CHUNK)
    await flush()
    preview.handleDone('ctx_1')

    // Every scheduled source reports completion -> context ends.
    ctx.sources.forEach(s => s.onended?.())

    expect(preview.getState()).toEqual(IDLE_PREVIEW)
  })

  it('plays preview audio through the shared AudioContext queue, never an <audio> tag', async () => {
    const { ctx, preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    preview.handleChunk('ctx_1', CHUNK)
    await flush()

    expect(ctx.sources.length).toBe(1)
    expect(ctx.sources[0].started).toBe(true)
  })

  it('never reports a Heard Receipt entry for a preview', async () => {
    const { ctx, preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    preview.handleChunk('ctx_1', CHUNK)
    await flush()
    preview.handleDone('ctx_1')
    ctx.sources.forEach(s => s.onended?.())

    expect(socket.heardReports).toEqual([])
  })

  // ─── repeated clicks ───────────────────────────────────────────────────

  it('ignores a repeat click on the term that is already previewing', async () => {
    const { preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    preview.handleChunk('ctx_1', CHUNK)
    await flush()

    const second = preview.request(socket, 'e1', 'Metformin', 'Meadow')

    expect(second).toBe(false)
    expect(socket.previews.length).toBe(1) // no second Rime stream
    expect(socket.clears).toBe(0)
    expect(preview.getState()).toEqual({ entryId: 'e1', phase: 'playing' })
  })

  it('cancels the in-flight preview when a different term is clicked', async () => {
    const { ctx, preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    preview.handleChunk('ctx_1', CHUNK)
    await flush()

    preview.request(socket, 'e2', 'Lisinopril', 'Meadow')

    expect(socket.clears).toBe(1) // told the server to stop synthesizing
    expect(ctx.sources[0].stopped).toBe(true) // and silenced local playback
    expect(socket.previews.map(p => p.entryId)).toEqual(['e1', 'e2'])
    expect(preview.getState()).toEqual({ entryId: 'e2', phase: 'loading' })
  })

  it('fences a late chunk from a cancelled preview so it never plays', async () => {
    const { ctx, preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    preview.handleChunk('ctx_1', CHUNK)
    await flush()
    const sourcesAfterFirst = ctx.sources.length

    preview.request(socket, 'e2', 'Lisinopril', 'Meadow')
    const played = preview.handleChunk('ctx_1', CHUNK) // straggler from the old context
    await flush()

    expect(played).toBe(false)
    expect(ctx.sources.length).toBe(sourcesAfterFirst) // nothing new scheduled
    expect(preview.getState()).toEqual({ entryId: 'e2', phase: 'loading' })
  })

  it('rapid clicking never leaves more than one preview in flight', () => {
    const { preview, socket } = setup()

    preview.request(socket, 'e1', 'A', 'Meadow')
    preview.request(socket, 'e2', 'B', 'Meadow')
    preview.request(socket, 'e3', 'C', 'Meadow')
    preview.request(socket, 'e3', 'C', 'Meadow') // duplicate — ignored

    expect(socket.previews.map(p => p.entryId)).toEqual(['e1', 'e2', 'e3'])
    expect(socket.clears).toBe(2) // one per supersede, none for the duplicate
    expect(preview.getState()).toEqual({ entryId: 'e3', phase: 'loading' })
  })

  // ─── error / recovery ──────────────────────────────────────────────────

  it('returns to a usable idle state on a server error', () => {
    const { preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    preview.handleError()

    expect(preview.getState()).toEqual(IDLE_PREVIEW)
    expect(preview.request(socket, 'e1', 'Metformin', 'Meadow')).toBe(true) // clickable again
  })

  it('does not get stuck loading when no audio ever arrives', () => {
    const ctx = new FakeAudioContext()
    const queue = new TTSPlaybackQueue(ctx as unknown as AudioContext)
    const preview = new PronunciationPreview(queue, () => {}, 500)
    const socket = new FakeSocket()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    expect(preview.getState().phase).toBe('loading')

    vi.advanceTimersByTime(500)

    expect(preview.getState()).toEqual(IDLE_PREVIEW)
  })

  it('stays idle when the socket is not open', () => {
    const { preview, socket } = setup()
    socket.open = false

    const started = preview.request(socket, 'e1', 'Metformin', 'Meadow')

    expect(started).toBe(false)
    expect(preview.getState()).toEqual(IDLE_PREVIEW)
  })

  it('ignores chunks that arrive with no preview in flight', () => {
    const { ctx, preview } = setup()

    expect(preview.handleChunk('ctx_stray', CHUNK)).toBe(false)
    expect(ctx.sources.length).toBe(0)
  })

  it('dispose() silences playback and leaves the controller idle', async () => {
    const { ctx, preview, socket } = setup()

    preview.request(socket, 'e1', 'Metformin', 'Meadow')
    preview.handleChunk('ctx_1', CHUNK)
    await flush()

    preview.dispose()

    expect(ctx.sources[0].stopped).toBe(true)
    expect(preview.getState()).toEqual(IDLE_PREVIEW)
  })
})

// Phase 7 tests for TTSPlaybackQueue's context-aware playback, fencing,
// and flush/timing behavior (phase7 prompt §42). Uses a fake AudioContext
// (see fakeAudioContext.ts) since real decoding/scheduling isn't available
// under Node — the fake treats raw bytes as samples 1:1 so durations and
// elapsed-time math stay exact and assertable.
import { describe, expect, it, vi } from 'vitest'
import { TTSPlaybackQueue } from '../ttsPlayback'
import { FakeAudioContext } from './fakeAudioContext'

function makeQueue() {
  const ctx = new FakeAudioContext()
  const queue = new TTSPlaybackQueue(ctx as unknown as AudioContext)
  return { ctx, queue }
}

describe('TTSPlaybackQueue — context association', () => {
  it('enqueue schedules audio for the current context', async () => {
    const { ctx, queue } = makeQueue()
    queue.startContext('ctx1', () => {})
    await queue.enqueue('ctx1', new Uint8Array([1, 2, 3, 4, 5]))

    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0].started).toBe(true)
  })

  it('discards a chunk whose contextId does not match the current context', async () => {
    const { ctx, queue } = makeQueue()
    queue.startContext('ctx1', () => {})
    await queue.enqueue('ctx2', new Uint8Array([1, 2, 3]))

    expect(ctx.sources).toHaveLength(0)
  })

  it('discards a chunk for a context that was superseded while decoding', async () => {
    const { ctx, queue } = makeQueue()
    queue.startContext('ctx1', () => {})
    const enqueuePromise = queue.enqueue('ctx1', new Uint8Array([1, 2, 3]))
    queue.startContext('ctx2', () => {}) // supersedes ctx1 mid-flight
    await enqueuePromise

    expect(ctx.sources).toHaveLength(0)
  })
})

describe('TTSPlaybackQueue — flush (barge-in)', () => {
  it('stops the active source and reports what was heard', async () => {
    const { ctx, queue } = makeQueue()
    queue.startContext('ctx1', () => {})
    await queue.enqueue('ctx1', new Uint8Array(10)) // duration 10 (fake: 1 byte = 1 "second")

    ctx.currentTime = 4 // 4 seconds of audible playback before the interrupt
    const result = queue.flush()

    expect(ctx.sources[0].stopped).toBe(true)
    expect(result).toEqual({ contextId: 'ctx1', started: true, status: 'cut', elapsedSeconds: 4 })
  })

  it('returns null when no context is active', () => {
    const { queue } = makeQueue()
    expect(queue.flush()).toBeNull()
  })

  it('reports started: false for a context that never became audible', () => {
    const { queue } = makeQueue()
    queue.startContext('ctx1', () => {})
    const result = queue.flush()
    expect(result).toEqual({ contextId: 'ctx1', started: false, status: 'cut', elapsedSeconds: 0 })
  })

  it('fences the flushed context: a late chunk for it is never scheduled', async () => {
    const { ctx, queue } = makeQueue()
    queue.startContext('ctx1', () => {})
    await queue.enqueue('ctx1', new Uint8Array(5))
    queue.flush()

    await queue.enqueue('ctx1', new Uint8Array(5)) // arrives after the barge-in
    expect(ctx.sources).toHaveLength(1) // only the one scheduled before flush
  })

  it('a new context after flush plays normally', async () => {
    const { ctx, queue } = makeQueue()
    queue.startContext('ctx1', () => {})
    await queue.enqueue('ctx1', new Uint8Array(5))
    queue.flush()

    queue.startContext('ctx2', () => {})
    await queue.enqueue('ctx2', new Uint8Array(5))

    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[1].started).toBe(true)
  })
})

describe('TTSPlaybackQueue — natural completion', () => {
  it('fires onEnded with status complete once markDone and playback both finish', async () => {
    const { ctx, queue } = makeQueue()
    const onEnded = vi.fn()
    queue.startContext('ctx1', onEnded)
    await queue.enqueue('ctx1', new Uint8Array(3))

    ctx.sources[0].onended?.() // playback finishes first
    expect(onEnded).not.toHaveBeenCalled() // done not signaled yet

    queue.markDone('ctx1')
    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(onEnded.mock.calls[0][0]).toMatchObject({ contextId: 'ctx1', started: true, status: 'complete' })
  })

  it('fires onEnded immediately if markDone arrives after playback already finished', async () => {
    const { ctx, queue } = makeQueue()
    const onEnded = vi.fn()
    queue.startContext('ctx1', onEnded)
    await queue.enqueue('ctx1', new Uint8Array(3))
    queue.markDone('ctx1') // doneSignaled first this time

    expect(onEnded).not.toHaveBeenCalled()
    ctx.sources[0].onended?.()
    expect(onEnded).toHaveBeenCalledTimes(1)
  })

  it('a flushed context never fires its onEnded afterward', async () => {
    const { ctx, queue } = makeQueue()
    const onEnded = vi.fn()
    queue.startContext('ctx1', onEnded)
    await queue.enqueue('ctx1', new Uint8Array(3))
    queue.flush()

    // Even if the (now-orphaned) source's onended were somehow still
    // reachable, flush() nulls the handler out — simulate calling it late.
    ctx.sources[0].onended?.()
    expect(onEnded).not.toHaveBeenCalled()
  })
})

describe('TTSPlaybackQueue — playBuffer (floor-hold)', () => {
  it('plays a pre-decoded buffer immediately as its own context', () => {
    const { ctx, queue } = makeQueue()
    const onEnded = vi.fn()
    const buffer = ctx.createBuffer(1, 8, 1)
    queue.playBuffer('hold_1', buffer as unknown as AudioBuffer, onEnded)

    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0].started).toBe(true)

    ctx.sources[0].onended?.()
    expect(onEnded).toHaveBeenCalledWith({ contextId: 'hold_1', started: true, status: 'complete', elapsedSeconds: 8 })
  })

  it('flushing a playing holding phrase stops it and reports it as cut (fencing, not a Heard Receipt concern here)', () => {
    const { ctx, queue } = makeQueue()
    const buffer = ctx.createBuffer(1, 8, 1)
    queue.playBuffer('hold_1', buffer as unknown as AudioBuffer)
    ctx.currentTime = 2

    const result = queue.flush()
    expect(ctx.sources[0].stopped).toBe(true)
    expect(result).toEqual({ contextId: 'hold_1', started: true, status: 'cut', elapsedSeconds: 2 })
  })
})

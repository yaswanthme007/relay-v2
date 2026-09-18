// Phase 7 tests for HoldingPhraseCache (phase7 prompt §44). A fake socket
// stands in for TTSSocket: its speak() simulates the server round-trip by
// handing the cache a made-up contextId's chunk+done directly, since the
// cache only cares about the shape of that interaction, not real Rime I/O.
import { describe, expect, it } from 'vitest'
import { HoldingPhraseCache, HOLDING_PHRASES, isHoldingContextId } from '../holdingPhraseCache'
import type { TTSSocket } from '../ttsSocket'

class FakeSocket {
  calls: { text: string; voice: string; confidence: number; kind?: string }[] = []
  private nextId = 0
  private readonly cache: HoldingPhraseCache

  constructor(cache: HoldingPhraseCache) {
    this.cache = cache
  }

  speak(text: string, voice: string, confidence: number, _pauseHint: number | undefined, kind?: 'candidate' | 'holding'): void {
    this.calls.push({ text, voice, confidence, kind })
    this.nextId += 1
    const contextId = `ctx_fake_${this.nextId}`
    // Simulate the server streaming back one chunk then finishing —
    // synchronously is fine here since preload() awaits each phrase in turn.
    this.cache.handleChunk(contextId, new Uint8Array([1, 2, 3]))
    this.cache.handleDone(contextId)
  }
}

describe('isHoldingContextId', () => {
  it('recognizes the hold_ prefix and nothing else', () => {
    expect(isHoldingContextId('hold_1')).toBe(true)
    expect(isHoldingContextId('ctx_abc123')).toBe(false)
  })
})

describe('HoldingPhraseCache', () => {
  it('is not ready before preload', () => {
    const cache = new HoldingPhraseCache({} as unknown as AudioContext)
    expect(cache.isReady()).toBe(false)
    expect(cache.nextPhrase()).toBeNull()
  })

  it('preloads all four phrases in the given voice, using kind: holding', async () => {
    const cache = new HoldingPhraseCache({
      decodeAudioData: async (buf: ArrayBuffer) => ({ duration: new Uint8Array(buf).length }),
    } as unknown as AudioContext)
    const socket = new FakeSocket(cache)

    await cache.preload(socket as unknown as TTSSocket, 'Cove')

    expect(socket.calls.map(c => c.text)).toEqual([...HOLDING_PHRASES])
    expect(socket.calls.every(c => c.kind === 'holding')).toBe(true)
    expect(socket.calls.every(c => c.voice === 'Cove')).toBe(true)
    expect(cache.isReady()).toBe(true)
  })

  it('rotates deterministically through cached phrases with fresh hold_ contextIds', async () => {
    const cache = new HoldingPhraseCache({
      decodeAudioData: async (buf: ArrayBuffer) => ({ duration: new Uint8Array(buf).length }),
    } as unknown as AudioContext)
    const socket = new FakeSocket(cache)
    await cache.preload(socket as unknown as TTSSocket, 'Cove')

    const first = cache.nextPhrase()
    const second = cache.nextPhrase()
    const third = cache.nextPhrase()
    const fourth = cache.nextPhrase()
    const fifth = cache.nextPhrase() // wraps back to the first buffer

    expect(first?.buffer).toBe(fifth?.buffer)
    expect(first?.contextId).not.toBe(second?.contextId)
    expect([first, second, third, fourth, fifth].every(p => p && isHoldingContextId(p.contextId))).toBe(true)
  })

  it('clear() invalidates the cache so a stale-voice phrase is never handed out', async () => {
    const cache = new HoldingPhraseCache({
      decodeAudioData: async (buf: ArrayBuffer) => ({ duration: new Uint8Array(buf).length }),
    } as unknown as AudioContext)
    const socket = new FakeSocket(cache)
    await cache.preload(socket as unknown as TTSSocket, 'Cove')
    expect(cache.isReady()).toBe(true)

    cache.clear()
    expect(cache.isReady()).toBe(false)
    expect(cache.nextPhrase()).toBeNull()
  })

  it('isCollecting is false outside of an in-flight preload', () => {
    const cache = new HoldingPhraseCache({} as unknown as AudioContext)
    expect(cache.isCollecting('ctx_anything')).toBe(false)
  })
})

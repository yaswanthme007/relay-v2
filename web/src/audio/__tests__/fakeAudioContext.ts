// Minimal Web Audio stand-ins for tests. Real decoding isn't available
// under Node/vitest, so decodeAudioData here treats the raw bytes
// themselves as samples (1 byte -> 1 sample, sampleRate 1) — enough to
// exercise TTSPlaybackQueue's scheduling/fencing/timing logic without a
// real audio pipeline. Duration then equals byte length exactly, which
// makes test assertions about nextStartTime/elapsedSeconds exact too.

export class FakeAudioBuffer {
  private readonly channels: Float32Array[]
  readonly duration: number
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels
    this.length = length
    this.sampleRate = sampleRate
    this.duration = sampleRate === 0 ? 0 : length / sampleRate
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel]
  }

  copyToChannel(source: Float32Array, channel: number): void {
    this.channels[channel].set(source)
  }
}

export class FakeSourceNode {
  buffer: FakeAudioBuffer | null = null
  onended: (() => void) | null = null
  started = false
  stopped = false
  startedAt: number | null = null

  connect(): void {
    // no-op — nothing downstream to verify in tests
  }

  disconnect(): void {
    // no-op
  }

  start(when: number): void {
    this.started = true
    this.startedAt = when
  }

  stop(): void {
    this.stopped = true
  }
}

export class FakeAudioContext {
  currentTime = 0
  destination = {}
  sources: FakeSourceNode[] = []

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate)
  }

  createBufferSource(): FakeSourceNode {
    const node = new FakeSourceNode()
    this.sources.push(node)
    return node
  }

  async decodeAudioData(buf: ArrayBuffer): Promise<FakeAudioBuffer> {
    const bytes = new Uint8Array(buf)
    if (bytes.length === 0) throw new Error('nothing to decode yet')
    return new FakeAudioBuffer(1, bytes.length, 1)
  }
}

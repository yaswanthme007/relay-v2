import { useState, useRef, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Mic, MicOff, Volume2, Check, RotateCcw,
  Clock, Activity, Shield, ChevronRight, Settings
} from 'lucide-react'
import { TTSSocket, type TTSConnectionState } from '../audio/ttsSocket'
import { TTSPlaybackQueue, type HeardResult } from '../audio/ttsPlayback'
import { HoldingPhraseCache, isHoldingContextId } from '../audio/holdingPhraseCache'
import {
  recordTurnEnd, recordBargeIn, recordContextCleared, recordHeardEntry, recordError, recordCandidateChunkReceived,
  wireFirstAudioProbe, wireAudioContextTimeGetter, wireHoldingReadyGetter, wireIsPlayingGetter,
} from '../audio/evidenceBridge'
import { getOrCreateUserId, getVoiceName, setPersistedVoiceName } from '../lib/identity'
import './SessionPage.css'

/* ─── Types ──────────────────────────────────────────────── */
interface Candidate {
  text: string
  confidence: number
  reasoning: string
}

interface HeardEntry {
  time: string
  status: 'complete' | 'cut' | 'pending'
  text: string
  cutAt?: string
}

// mockCandidates removed in Phase 3 — candidates now come from POST /api/turn.
// mockHeardLog removed in Phase 7 — heardLog is now fed by real heard_entry
// events, themselves built from actual browser playback state (never a
// fake completion just because a candidate was selected).

/* ─── Backend wire contract (Phase 2: /api/turn only) ────── */
interface TurnResponse {
  transcript: string
  candidates: Candidate[]
}

const API_BASE = 'http://localhost:8000'
const WS_BASE = 'ws://localhost:8000'

/* ─── Confidence helpers ─────────────────────────────────── */
function getConfidenceLabel(c: number): string {
  if (c > 0.85) return 'High'
  if (c >= 0.5) return 'Medium'
  return 'Low'
}

function getConfidenceClass(c: number): string {
  if (c > 0.85) return 'confidence--high'
  if (c >= 0.5) return 'confidence--medium'
  return 'confidence--low'
}

function getDeliveryMode(c: number): string {
  if (c > 0.85) return 'Statement'
  if (c >= 0.5) return 'Question (rising intonation)'
  return 'Silent (manual selection)'
}


/* ─── Waveform Visualizer ────────────────────────────────── */
function WaveformVisualizer({ active }: { active: boolean }) {
  const barCount = 32
  return (
    <div className={`waveform ${active ? 'waveform--active' : ''}`}>
      {Array.from({ length: barCount }).map((_, i) => (
        <motion.div
          key={i}
          className="waveform__bar"
          animate={active ? {
            height: [4, Math.random() * 28 + 4, 4],
          } : { height: 4 }}
          transition={active ? {
            duration: 0.6 + Math.random() * 0.4,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.03,
          } : { duration: 0.3 }}
        />
      ))}
    </div>
  )
}


/* ─── Pulsing Mic Button ─────────────────────────────────── */
function MicButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      className={`mic-button ${active ? 'mic-button--active' : ''}`}
      onClick={onClick}
      id="mic-toggle"
      aria-label={active ? 'Stop recording' : 'Start recording'}
    >
      {active && (
        <>
          <span className="mic-button__ring mic-button__ring--1" />
          <span className="mic-button__ring mic-button__ring--2" />
          <span className="mic-button__ring mic-button__ring--3" />
        </>
      )}
      <span className="mic-button__inner">
        {active ? <MicOff size={24} /> : <Mic size={24} />}
      </span>
    </button>
  )
}


/* ═══════════════════════════════════════════════════════════════
   SESSION PAGE
   ═══════════════════════════════════════════════════════════════ */
export default function SessionPage() {
  const [isRecording, setIsRecording] = useState(false)
  const [showCandidates, setShowCandidates] = useState(false)
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null)
  const [rawTranscript, setRawTranscript] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [situation, setSituation] = useState('pharmacy')
  // Persisted (identity.ts) rather than page-local, so the Ledger page's
  // pronunciation preview auditions terms in the same voice this session
  // relays in. This picker is still the only control that sets it.
  const [voiceName, setVoiceName] = useState(getVoiceName())
  const [heardLog, setHeardLog] = useState<HeardEntry[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [floorHoldActive, setFloorHoldActive] = useState(true)
  const [isProcessing, setIsProcessing] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [ttsState, setTtsState] = useState<TTSConnectionState>('connecting')

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const ttsSocketRef = useRef<TTSSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const playbackQueueRef = useRef<TTSPlaybackQueue | null>(null)

  // Phase 7: floor-hold cache, and the bookkeeping needed to tell candidate
  // playback apart from floor-hold playback and to fence stale contexts.
  const holdingCacheRef = useRef<HoldingPhraseCache | null>(null)
  const preloadedVoiceRef = useRef<string | null>(null)
  const floorHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The candidate text a not-yet-bound speak() call is waiting to attach to
  // the next contextId the server hands back (the server never echoes a
  // contextId synchronously from speak() itself).
  const pendingSpeakRef = useRef<{ text: string } | null>(null)
  const activeContextRef = useRef<{ contextId: string; text: string } | null>(null)
  // Contexts explicitly barged-in on — a chunk that still arrives for one
  // of these is known-stale to the browser too, and must never be mistaken
  // for the start of a new context (phase7 prompt §23 race condition).
  const fencedContextIdsRef = useRef<Set<string>>(new Set())

  // Fires when a playback context finishes on its own (never for a
  // flushed/barged-in one — flush() reports that outcome directly to its
  // caller instead). Floor-hold contexts are never a Heard Receipt entry
  // (phase7 prompt §10/§36); a context that never became audible isn't
  // either (phase7 prompt §27).
  const handleContextEnded = useCallback((result: HeardResult) => {
    if (isHoldingContextId(result.contextId) || !result.started) return
    const text = activeContextRef.current?.contextId === result.contextId ? activeContextRef.current.text : ''
    ttsSocketRef.current?.reportHeard(result.contextId, text, 'complete')
  }, [])

  // The barge-in primitive (phase7 prompt §13-23): flush local playback
  // immediately, send Rime `clear`, fence the interrupted context so a
  // late chunk can never leak into the next one, and — if real audio was
  // actually audible — report it as a "cut" Heard Receipt entry.
  const bargeIn = useCallback(() => {
    recordBargeIn(audioContextRef.current?.currentTime ?? 0)
    if (floorHoldTimerRef.current) {
      clearTimeout(floorHoldTimerRef.current)
      floorHoldTimerRef.current = null
    }
    const flushed = playbackQueueRef.current?.flush()
    ttsSocketRef.current?.clear()
    if (!flushed) return
    fencedContextIdsRef.current.add(flushed.contextId)
    if (flushed.started && !isHoldingContextId(flushed.contextId)) {
      const text = activeContextRef.current?.contextId === flushed.contextId ? activeContextRef.current.text : ''
      ttsSocketRef.current?.reportHeard(flushed.contextId, text, 'cut', flushed.elapsedSeconds)
    }
    activeContextRef.current = null
  }, [])

  // Play the next cached holding phrase — purely local: an already-decoded
  // AudioBuffer scheduled straight onto the destination node, zero network
  // and zero synthesis at the moment it's needed (RELAY_PLAYBOOK.md WOW #1).
  const triggerFloorHold = useCallback(() => {
    const queue = playbackQueueRef.current
    const cache = holdingCacheRef.current
    if (!queue || !cache || queue.isPlaying()) return
    const held = cache.nextPhrase()
    if (!held) return
    void audioContextRef.current?.resume()
    queue.playBuffer(held.contextId, held.buffer, handleContextEnded)
  }, [handleContextEnded])

  // One /ws/tts connection for the life of the session (Phase 4). Rime
  // itself is never reachable from the browser — only this application
  // socket, which the server translates into Rime ws3 traffic.
  useEffect(() => {
    const audioContext = new AudioContext()
    audioContextRef.current = audioContext
    playbackQueueRef.current = new TTSPlaybackQueue(audioContext)
    holdingCacheRef.current = new HoldingPhraseCache(audioContext)
    wireFirstAudioProbe(playbackQueueRef.current)
    wireAudioContextTimeGetter(() => audioContextRef.current?.currentTime ?? 0)
    wireHoldingReadyGetter(() => holdingCacheRef.current?.isReady() ?? false)
    wireIsPlayingGetter(() => playbackQueueRef.current?.isPlaying() ?? false)

    const socket = new TTSSocket(
      `${WS_BASE}/ws/tts?userId=${encodeURIComponent(getOrCreateUserId())}`,
      event => {
        if (event.type === 'audio_chunk') {
          const cache = holdingCacheRef.current
          if (cache?.isCollecting(event.contextId)) {
            cache.handleChunk(event.contextId, event.data)
            return
          }
          if (fencedContextIdsRef.current.has(event.contextId)) return // known-stale, drop client-side too
          recordCandidateChunkReceived()

          if (activeContextRef.current?.contextId !== event.contextId) {
            const pending = pendingSpeakRef.current
            pendingSpeakRef.current = null
            activeContextRef.current = { contextId: event.contextId, text: pending?.text ?? '' }
            playbackQueueRef.current?.startContext(event.contextId, handleContextEnded)
          }
          void playbackQueueRef.current?.enqueue(event.contextId, event.data)
        } else if (event.type === 'synthesis_done') {
          const cache = holdingCacheRef.current
          if (cache?.isCollecting(event.contextId)) {
            cache.handleDone(event.contextId)
            return
          }
          if (fencedContextIdsRef.current.has(event.contextId)) return
          playbackQueueRef.current?.markDone(event.contextId)
        } else if (event.type === 'heard_entry') {
          setHeardLog(prev => [...prev, event.entry as HeardEntry])
          recordHeardEntry(event.entry)
        } else if (event.type === 'context_cleared') {
          // Dev-only observability (phase7 prompt §40) — the AT-3 stress
          // test reads this from the browser console; no production UI.
          if (import.meta.env.DEV) {
            console.debug(`[relay] context_cleared ${event.contextId} discardedChunks=${event.discardedChunks}`)
          }
          recordContextCleared(event.contextId, event.discardedChunks, audioContextRef.current?.currentTime ?? 0)
        } else if (event.type === 'error') {
          setMicError(`Speech playback error: ${event.message}`)
          recordError(event.message, audioContextRef.current?.currentTime ?? 0, event.contextId)
        }
      },
      state => setTtsState(state),
    )
    socket.connect()
    ttsSocketRef.current = socket

    return () => {
      socket.close()
      void audioContext.close()
    }
  }, [handleContextEnded])

  // Floor-hold cache: preload at session start, and again whenever the
  // persistent voice changes — a phrase cached in the old voice must never
  // play (phase7 prompt §11). Runs once the socket is actually connected.
  useEffect(() => {
    const cache = holdingCacheRef.current
    const socket = ttsSocketRef.current
    if (!cache || !socket || ttsState !== 'connected') return
    if (preloadedVoiceRef.current === voiceName) return
    preloadedVoiceRef.current = voiceName
    cache.clear()
    void cache.preload(socket, voiceName)
  }, [voiceName, ttsState])

  const submitTurn = useCallback(async (blob: Blob) => {
    setIsProcessing(true)

    // Floor-hold trigger (phase7 prompt §8): start the clock the instant
    // reconstruction begins, not at end-of-turn — only fire the cached
    // phrase if reconstruction is still unresolved ~400ms later, so a fast
    // turn never gets interrupted by unnecessary filler.
    let settled = false
    if (floorHoldActive) {
      floorHoldTimerRef.current = setTimeout(() => {
        floorHoldTimerRef.current = null
        if (!settled) triggerFloorHold()
      }, 400)
    }

    try {
      const form = new FormData()
      form.append('audio', blob, 'turn.webm')
      form.append('situation', situation)
      form.append('userId', getOrCreateUserId())

      const res = await fetch(`${API_BASE}/api/turn`, { method: 'POST', body: form })
      if (!res.ok) {
        throw new Error(`Backend returned ${res.status}`)
      }
      const data: TurnResponse = await res.json()
      setRawTranscript(data.transcript)
      setCandidates(data.candidates)
      setShowCandidates(true)
    } catch (err) {
      setMicError(
        err instanceof Error && err.message.startsWith('Backend returned')
          ? 'Transcription failed. Try again.'
          : 'Could not reach the server. Check that the backend is running.'
      )
    } finally {
      settled = true
      if (floorHoldTimerRef.current) {
        clearTimeout(floorHoldTimerRef.current)
        floorHoldTimerRef.current = null
      }
      setIsProcessing(false)
    }
  }, [situation, floorHoldActive, triggerFloorHold])

  const handleMicToggle = useCallback(() => {
    // Browser autoplay policy suspends a freshly-created AudioContext until
    // a user gesture resumes it — its clock (currentTime) is frozen at 0
    // until then. Pressing the mic is the session's first guaranteed user
    // gesture, so resume here rather than waiting for the first speak():
    // otherwise a floor-hold phrase that fires while still suspended would
    // be silently inaudible (scheduled but not rendering), and any
    // AudioContext-time measurement taken before the first speak() (e.g.
    // end-of-turn) would be meaningless. Idempotent — resume() on an
    // already-running context is a no-op.
    void audioContextRef.current?.resume()

    if (isRecording) {
      setIsRecording(false)
      // AT-2's "end-of-turn" proxy: this product is push-to-talk, not
      // continuous VAD, so end-of-turn is the mic-release gesture. Recorded
      // on AudioContext's own clock so it's directly comparable to the
      // first-audio-scheduled timestamp (both real Web Audio timing, not
      // wall-clock).
      recordTurnEnd(audioContextRef.current?.currentTime ?? 0)
      mediaRecorderRef.current?.stop()
      return
    }

    // Barge-in (phase7 prompt §13-14): the mic button is the same control
    // used for normal speech — pressing it again while Rime audio is still
    // playing IS the interruption, not a separate "stop" action. The mic
    // is never disabled while audio plays, so this is always available.
    if (playbackQueueRef.current?.isPlaying()) {
      bargeIn()
    }

    setMicError(null)
    setShowCandidates(false)
    setSelectedCandidate(null)
    setRawTranscript('')
    setCandidates([])

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setMicError('Microphone recording is not supported in this browser.')
      return
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      streamRef.current = stream
      chunksRef.current = []

      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(stream)
      } catch {
        setMicError('Could not start the microphone recorder.')
        stream.getTracks().forEach(t => t.stop())
        return
      }

      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        void submitTurn(blob)
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setIsRecording(true)
    }).catch(err => {
      setMicError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : 'Microphone unavailable.'
      )
    })
  }, [isRecording, submitTurn, bargeIn])

  const handleSelectCandidate = useCallback((index: number) => {
    setSelectedCandidate(index)
    const candidate = candidates[index]
    if (!candidate) return

    // Phase 6: a candidate below the silent threshold (< 0.5, same
    // boundary as getDeliveryMode below) is never sent to speak() at all —
    // "Silent (manual selection)" means exactly that. The server enforces
    // this independently too (SpeakMessage.confidence), since a client that
    // skips this check must not be able to force synthesis anyway.
    if (candidate.confidence < 0.5) return

    // Phase 7: whatever is currently audible — a floor-hold phrase, or a
    // previously selected candidate the user is now overriding — is
    // fenced and flushed first. A genuine "cut"
    // Heard Receipt entry is produced only if real candidate audio was
    // actually playing; a flushed floor-hold phrase produces none.
    bargeIn()

    void audioContextRef.current?.resume()
    pendingSpeakRef.current = { text: candidate.text }
    ttsSocketRef.current?.speak(candidate.text, voiceName, candidate.confidence)
  }, [candidates, voiceName, bargeIn])

  const handleReset = useCallback(() => {
    if (floorHoldTimerRef.current) {
      clearTimeout(floorHoldTimerRef.current)
      floorHoldTimerRef.current = null
    }
    setShowCandidates(false)
    setSelectedCandidate(null)
    setRawTranscript('')
    setCandidates([])
    setIsProcessing(false)
    setMicError(null)
  }, [])

  return (
    <motion.main
      className="session-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="container">
        {/* ─── Header ──── */}
        <motion.div
          className="session-header"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          <div>
            <h1 className="text-headline">Relay Session</h1>
            <p className="text-caption">Speak naturally. RELAY will reconstruct, confirm, and relay your intended message.</p>
          </div>
          <button
            className="btn btn--ghost"
            onClick={() => setShowSettings(!showSettings)}
            id="session-settings-toggle"
          >
            <Settings size={16} />
            Settings
          </button>
        </motion.div>

        {/* ─── Settings Panel ──── */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              className="session-settings card"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="settings-grid">
                <div className="settings-item">
                  <label className="settings-label">Voice Identity</label>
                  <div className="settings-select-wrap">
                    <select
                      value={voiceName}
                      onChange={e => {
                        setVoiceName(e.target.value)
                        setPersistedVoiceName(e.target.value)
                      }}
                      className="settings-select"
                      id="voice-select"
                    >
                      {['Meadow', 'Ember', 'Cove', 'Grove', 'Summit'].map(v => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="settings-item">
                  <label className="settings-label">Situation</label>
                  <div className="settings-select-wrap">
                    <select
                      value={situation}
                      onChange={e => setSituation(e.target.value)}
                      className="settings-select"
                      id="situation-select"
                    >
                      {['pharmacy', 'clinic', 'home', 'phone'].map(s => (
                        <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="settings-item">
                  <label className="settings-label">Floor-Holding</label>
                  <button
                    className={`settings-toggle ${floorHoldActive ? 'settings-toggle--on' : ''}`}
                    onClick={() => setFloorHoldActive(!floorHoldActive)}
                    id="floor-hold-toggle"
                  >
                    <span className="settings-toggle__track" />
                    <span className="settings-toggle__thumb" />
                  </button>
                </div>
              </div>

              {/* Provider badge — reflects the real /ws/tts connection state, not a hardcoded string */}
              <div className="provider-badge">
                <span className="text-mono">
                  Rime · mistv2 · speaker: {voiceName.toLowerCase()} · ws3 · {
                    ttsState === 'connected' ? 'connected'
                    : ttsState === 'connecting' ? 'connecting…'
                    : ttsState === 'error' ? 'error'
                    : 'disconnected'
                  }
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>


        {/* ─── Main Session Interface ──── */}
        <div className="session-grid">
          {/* Left: Recording Interface */}
          <div className="session-main">
            {/* Waveform */}
            <motion.div
              className="session-capture card"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
            >
              <div className="capture-header">
                <span className="text-overline">Voice Capture</span>
                <div className={`capture-status ${isRecording ? 'capture-status--live' : ''}`}>
                  <span className="capture-status__dot" />
                  <span>{isRecording ? 'Listening' : isProcessing ? 'Processing' : 'Ready'}</span>
                </div>
              </div>

              <WaveformVisualizer active={isRecording} />

              <div className="capture-controls">
                <MicButton active={isRecording} onClick={handleMicToggle} />
                {showCandidates && (
                  <motion.button
                    className="btn btn--ghost"
                    onClick={handleReset}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                  >
                    <RotateCcw size={14} />
                    Reset
                  </motion.button>
                )}
              </div>

              {isRecording && (
                <motion.p
                  className="capture-hint text-caption"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  Speak naturally. Release the microphone when finished.
                </motion.p>
              )}

              {micError && (
                <motion.p
                  className="capture-hint text-caption"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  <span className="badge badge--danger">{micError}</span>
                </motion.p>
              )}
            </motion.div>

            {/* Processing State */}
            <AnimatePresence>
              {isProcessing && (
                <motion.div
                  className="processing-state card"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.4 }}
                >
                  <div className="processing-state__inner">
                    <motion.div
                      className="processing-spinner"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                    />
                    <div>
                      <p className="processing-state__title">Reconstructing intent</p>
                      <p className="text-caption">
                        {floorHoldActive
                          ? '🔊 Floor-hold active — "One moment" played in your voice'
                          : 'Floor-hold disabled — silence during processing'}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Raw Transcript */}
            <AnimatePresence>
              {rawTranscript && (
                <motion.div
                  className="raw-transcript card--flat card"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                >
                  <span className="text-overline">Raw ASR Output</span>
                  <p className="raw-transcript__text">"{rawTranscript}"</p>
                  <span className="text-caption">Noisy transcription — reconstruction follows</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Candidate Cards */}
            <AnimatePresence>
              {showCandidates && (
                <motion.div
                  className="candidates"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <span className="text-overline">Reconstructed Candidates</span>
                  <div className="candidates__list">
                    {candidates.map((candidate, i) => (
                      <motion.button
                        key={i}
                        className={`candidate-card card ${selectedCandidate === i ? 'candidate-card--selected' : ''}`}
                        initial={{ opacity: 0, x: -16 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.1, duration: 0.4 }}
                        onClick={() => handleSelectCandidate(i)}
                        id={`candidate-${i}`}
                      >
                        <div className="candidate-card__top">
                          <div className="candidate-card__text">
                            {candidate.text}
                          </div>
                          {selectedCandidate === i && (
                            <motion.div
                              className="candidate-card__check"
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                            >
                              <Check size={14} />
                            </motion.div>
                          )}
                        </div>
                        <div className="candidate-card__meta">
                          <span className={`confidence-badge ${getConfidenceClass(candidate.confidence)}`}>
                            {getConfidenceLabel(candidate.confidence)} · {Math.round(candidate.confidence * 100)}%
                          </span>
                          <span className="text-caption">{getDeliveryMode(candidate.confidence)}</span>
                        </div>
                        <p className="candidate-card__reasoning text-caption">
                          {candidate.reasoning}
                        </p>
                      </motion.button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Spoken Output */}
            <AnimatePresence>
              {selectedCandidate !== null && (
                <motion.div
                  className="spoken-output card"
                  initial={{ opacity: 0, y: 16, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="spoken-output__header">
                    <Volume2 size={18} className="spoken-output__icon" />
                    <span className="text-overline">Spoken Output</span>
                  </div>
                  <p className="spoken-output__text">
                    "{candidates[selectedCandidate].text}"
                  </p>
                  <div className="spoken-output__meta">
                    <span className="badge">
                      <Volume2 size={11} /> Voice: {voiceName}
                    </span>
                    <span className="badge badge--info">
                      {getDeliveryMode(candidates[selectedCandidate].confidence)}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right: Heard Receipt + Status */}
          <div className="session-sidebar">
            {/* Status Panel */}
            <motion.div
              className="status-panel card"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 }}
            >
              <h3 className="status-panel__title">
                <Activity size={16} />
                Session Status
              </h3>
              <div className="status-rows">
                <div className="status-row">
                  <span className="text-caption">Voice</span>
                  <span className="status-row__value">{voiceName}</span>
                </div>
                <div className="status-row">
                  <span className="text-caption">Situation</span>
                  <span className="status-row__value">{situation}</span>
                </div>
                <div className="status-row">
                  <span className="text-caption">Floor-Hold</span>
                  <span className={`status-row__value ${floorHoldActive ? 'status--on' : 'status--off'}`}>
                    {floorHoldActive ? 'Active' : 'Disabled'}
                  </span>
                </div>
                <div className="status-row">
                  <span className="text-caption">Model</span>
                  <span className="status-row__value text-mono">mistv2</span>
                </div>
                <div className="status-row">
                  <span className="text-caption">Transport</span>
                  <span className="status-row__value text-mono">ws3</span>
                </div>
              </div>
            </motion.div>

            {/* Heard Receipt */}
            <motion.div
              className="heard-receipt card"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
            >
              <div className="heard-receipt__header">
                <h3 className="heard-receipt__title">
                  <Shield size={16} />
                  Heard Receipt
                </h3>
                <span className="text-caption">{heardLog.length} entries</span>
              </div>
              <div className="heard-receipt__log">
                {heardLog.map((entry, i) => (
                  <motion.div
                    key={i}
                    className={`receipt-entry receipt-entry--${entry.status}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    <div className="receipt-entry__time text-mono">{entry.time}</div>
                    <div className="receipt-entry__status">
                      {entry.status === 'complete' && <span className="badge badge--success">SPOKEN</span>}
                      {entry.status === 'cut' && <span className="badge badge--warning">CUT {entry.cutAt}</span>}
                    </div>
                    <div className="receipt-entry__text">"{entry.text}"</div>
                  </motion.div>
                ))}
                {heardLog.length === 0 && (
                  <div className="receipt-entry__hint text-caption">
                    Select a candidate above to add a new entry
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </motion.main>
  )
}

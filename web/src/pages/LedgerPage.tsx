import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence, useInView } from 'framer-motion'
import {
  Plus, Search, Check, AlertTriangle,
  ChevronRight, Sparkles, FileText, Mic, Square,
  Volume2, Loader2, Trash2
} from 'lucide-react'
import { audioBufferToWav } from '../audio/wavEncode'
import { TTSSocket } from '../audio/ttsSocket'
import { TTSPlaybackQueue } from '../audio/ttsPlayback'
import { PronunciationPreview, IDLE_PREVIEW, type PreviewState } from '../audio/pronunciationPreview'
import { getOrCreateUserId, getVoiceName } from '../lib/identity'
import type { LedgerEntry } from '../lib/ledgerTypes'
import {
  deriveLedgerStats, filterLedger, removeEntry,
  deleteConfirmationMessage, requestDeleteEntry,
} from '../lib/ledgerState'
import './LedgerPage.css'

const API_BASE = 'http://localhost:8000'
const WS_BASE = 'ws://localhost:8000'

/* ─── Types ─────────────────────────────────────────────── */
// Declared in ../lib/ledgerTypes so this page and its state helpers share
// one declaration. Same fields, same types as before.
export type { LedgerEntry } from '../lib/ledgerTypes'

const categoryLabels: Record<string, string> = {
  name: 'Personal Name',
  medication: 'Medication',
  clinician: 'Clinician',
  location: 'Location',
  phrase: 'Domain Phrase',
}

const categoryColors: Record<string, string> = {
  name: 'badge--accent',
  medication: 'badge--info',
  clinician: 'badge--success',
  location: 'badge--warning',
  phrase: 'badge',
}


/* ─── Coverage stat ────────────────────────────────────── */
function CoverageRing({ covered, total }: { covered: number; total: number }) {
  const percentage = Math.round((covered / total) * 100)
  const radius = 38
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (percentage / 100) * circumference

  return (
    <div className="coverage-ring">
      <svg width="96" height="96" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={radius} fill="none" stroke="var(--color-border)" strokeWidth="4" />
        <motion.circle
          cx="48" cy="48" r={radius} fill="none"
          stroke="var(--color-accent)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
          transform="rotate(-90 48 48)"
        />
      </svg>
      <div className="coverage-ring__label">
        <span className="coverage-ring__value">{percentage}%</span>
        <span className="coverage-ring__sub">covered</span>
      </div>
    </div>
  )
}


/* ═══════════════════════════════════════════════════════════
   LEDGER PAGE
   ═══════════════════════════════════════════════════════════ */
export default function LedgerPage() {
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newWord, setNewWord] = useState('')
  const [newCategory, setNewCategory] = useState<string>('medication')
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  // Which term is currently being auditioned, and whether its audio is
  // still being synthesized or already playing. idle -> loading -> playing
  // -> idle, driven entirely by PronunciationPreview.
  const [preview, setPreview] = useState<PreviewState>(IDLE_PREVIEW)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  // Pronunciation preview runs on exactly the same infrastructure the
  // Session page speaks with: one /ws/tts connection (the browser never
  // reaches Rime itself, and never sees RIME_API_KEY) feeding the same
  // AudioContext-based TTSPlaybackQueue. No second TTS path, no <audio>.
  const audioContextRef = useRef<AudioContext | null>(null)
  const playbackQueueRef = useRef<TTSPlaybackQueue | null>(null)
  const socketRef = useRef<TTSSocket | null>(null)
  const previewRef = useRef<PronunciationPreview | null>(null)

  const userId = getOrCreateUserId()

  useEffect(() => {
    fetch(`${API_BASE}/api/ledger?userId=${encodeURIComponent(userId)}`)
      .then(res => {
        if (!res.ok) throw new Error(`Backend returned ${res.status}`)
        return res.json()
      })
      .then((data: LedgerEntry[]) => setLedger(data))
      .catch(() => setLedgerError('Could not load the ledger. Check that the backend is running.'))
  }, [userId])

  // One /ws/tts connection for the life of the page. Preview audio arrives
  // as ordinary audio_chunk/synthesis_done events and is played through
  // TTSPlaybackQueue — the same Phase 4/7 playback path, unchanged.
  // reportHeard() is never called here: a pronunciation audition is not
  // conversational speech and must never enter the Heard Receipt.
  useEffect(() => {
    const audioContext = new AudioContext()
    const queue = new TTSPlaybackQueue(audioContext)
    const previewController = new PronunciationPreview(queue, setPreview)
    audioContextRef.current = audioContext
    playbackQueueRef.current = queue
    previewRef.current = previewController

    const socket = new TTSSocket(
      `${WS_BASE}/ws/tts?userId=${encodeURIComponent(userId)}`,
      event => {
        if (event.type === 'audio_chunk') {
          previewController.handleChunk(event.contextId, event.data)
        } else if (event.type === 'synthesis_done') {
          previewController.handleDone(event.contextId)
        } else if (event.type === 'error') {
          previewController.handleError()
          setLedgerError(`Pronunciation preview failed: ${event.message}`)
        }
      },
      () => {},
    )
    socket.connect()
    socketRef.current = socket

    return () => {
      previewController.dispose()
      socket.close()
      socketRef.current = null
      previewRef.current = null
      void audioContext.close()
    }
  }, [userId])

  // Every number and pill on this page is derived from `ledger` in one
  // place, so adding or deleting a row updates the stats, the category
  // counts and the visible rows together — no separate counters to keep
  // in sync, and no page reload.
  const filtered = filterLedger(ledger, searchQuery, activeCategory)
  const stats = deriveLedgerStats(ledger)
  const coveredCount = stats.covered
  const verifiedCount = stats.verified
  const uncoveredCount = stats.uncovered
  const categories = stats.categories

  const upsertEntry = (entry: LedgerEntry) => {
    setLedger(prev => {
      const exists = prev.some(e => e.id === entry.id)
      return exists ? prev.map(e => (e.id === entry.id ? entry : e)) : [...prev, entry]
    })
  }

  const handleAdd = async () => {
    const word = newWord.trim()
    if (!word) return
    setLedgerError(null)
    try {
      const res = await fetch(`${API_BASE}/api/ledger/entry?userId=${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, category: newCategory }),
      })
      if (!res.ok) throw new Error(`Backend returned ${res.status}`)
      const entry: LedgerEntry = await res.json()
      upsertEntry(entry)
      setNewWord('')
      setShowAddForm(false)
    } catch {
      setLedgerError('Could not add term. Check that the backend is running.')
    }
  }

  // Click a term -> hear it. The server loads this entry from the database
  // and, for a verified entry with a stored phoneme, speaks that
  // `{phoneme}` string through Rime mistv2 — the exact pronunciation a
  // real sentence would get. An unverified/pending entry is spoken as the
  // plain word with Rime's own predicted pronunciation; nothing is
  // fabricated and the entry is never silently marked verified.
  //
  // Repeated clicks: clicking the term that is already previewing is
  // ignored (it plays out); clicking a different term cancels the current
  // preview and starts the new one. Exactly one preview is ever in flight.
  const handlePreview = useCallback((entry: LedgerEntry) => {
    const controller = previewRef.current
    const socket = socketRef.current
    if (!controller || !socket) return
    setLedgerError(null)
    // Autoplay policy: a freshly-created AudioContext stays suspended until
    // a user gesture resumes it. This click is that gesture.
    void audioContextRef.current?.resume()
    controller.request(socket, entry.id, entry.word, getVoiceName())
  }, [])

  // Delete a term so the same word can be added and re-recorded with a
  // corrected pronunciation. A real delete server-side — the stored
  // phoneme stops reaching synthesis and reconstruction immediately.
  const handleDelete = useCallback(async (entry: LedgerEntry) => {
    // Cancelling leaves the entry completely untouched — no request is
    // sent and no local state changes.
    if (!window.confirm(deleteConfirmationMessage(entry.word))) return

    setLedgerError(null)
    setDeletingId(entry.id)
    try {
      await requestDeleteEntry(API_BASE, userId, entry.id)
      // The row is only removed once the server confirms it. Stats,
      // category counts and filters all re-derive from this one update.
      setLedger(prev => removeEntry(prev, entry.id))
    } catch {
      setLedgerError('Could not delete the term. Check that the backend is running.')
    } finally {
      setDeletingId(null)
    }
  }, [userId])

  // Recording a term's correct pronunciation -> WAV -> POST /api/ledger/phonemize.
  // Reuses the existing MediaRecorder capture pattern from SessionPage.tsx;
  // WAV conversion happens client-side (server/ledger.py §29: Phonemize
  // needs WAV, not the WebM/Opus MediaRecorder produces).
  const handleToggleRecording = useCallback((entryId: string) => {
    if (recordingId === entryId) {
      setRecordingId(null)
      mediaRecorderRef.current?.stop()
      return
    }
    if (recordingId !== null) return // one recording at a time

    setLedgerError(null)
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      streamRef.current = stream
      chunksRef.current = []
      const recorder = new MediaRecorder(stream)

      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null

        const recordedBlob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        try {
          const audioContext = new AudioContext()
          const arrayBuffer = await recordedBlob.arrayBuffer()
          const decoded = await audioContext.decodeAudioData(arrayBuffer)
          const wavBlob = audioBufferToWav(decoded)
          await audioContext.close()

          const form = new FormData()
          form.append('id', entryId)
          form.append('audio', wavBlob, 'pronunciation.wav')

          const res = await fetch(`${API_BASE}/api/ledger/phonemize?userId=${encodeURIComponent(userId)}`, {
            method: 'POST',
            body: form,
          })
          if (!res.ok) throw new Error(`Backend returned ${res.status}`)
          const entry: LedgerEntry = await res.json()
          upsertEntry(entry)
        } catch {
          setLedgerError('Phonemization failed. Try recording again.')
        }
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setRecordingId(entryId)
    }).catch(() => {
      setLedgerError('Microphone permission denied or unavailable.')
    })
  }, [recordingId, userId])

  return (
    <motion.main
      className="ledger-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="container">
        {/* ─── Header ──── */}
        <motion.div
          className="ledger-header"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          <div>
            <span className="text-overline">Personal Pronunciation Ledger</span>
            <h1 className="text-headline">Your words, pronounced correctly</h1>
            <p className="text-subheadline" style={{ maxWidth: 560, marginTop: 'var(--space-2)' }}>
              Every name, medication, and phrase that matters to you — verified with Rime's Coverage 
              and Phonemize APIs for deterministic pronunciation.
            </p>
          </div>
          <button
            className="btn btn--accent"
            onClick={() => setShowAddForm(!showAddForm)}
            id="add-term-btn"
          >
            <Plus size={16} />
            Add Term
          </button>
        </motion.div>

        {ledgerError && (
          <p className="text-caption" style={{ marginTop: 'var(--space-2)' }}>
            <span className="badge badge--danger">{ledgerError}</span>
          </p>
        )}

        {/* ─── Add Form ──── */}
        <AnimatePresence>
          {showAddForm && (
            <motion.div
              className="add-form card"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="add-form__inner">
                <div className="add-form__field">
                  <label className="settings-label">Term</label>
                  <input
                    type="text"
                    className="add-form__input"
                    placeholder="e.g. Lisinopril, Dr. Patel, morning dose..."
                    value={newWord}
                    onChange={e => setNewWord(e.target.value)}
                    id="add-term-input"
                    autoFocus
                  />
                </div>
                <div className="add-form__field">
                  <label className="settings-label">Category</label>
                  <select
                    className="settings-select"
                    value={newCategory}
                    onChange={e => setNewCategory(e.target.value)}
                    id="add-term-category"
                  >
                    {Object.entries(categoryLabels).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="add-form__actions">
                  <button className="btn btn--accent" onClick={handleAdd} id="add-term-submit">
                    <Plus size={14} /> Add to Ledger
                  </button>
                  <button className="btn btn--ghost" onClick={() => setShowAddForm(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Stats Row ──── */}
        <motion.div
          className="ledger-stats"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <div className="ledger-stat-card card">
            <CoverageRing covered={coveredCount} total={ledger.length} />
            <div>
              <p className="ledger-stat-card__label">Rime Coverage</p>
              <p className="text-caption">{coveredCount} of {ledger.length} terms are in Rime's dictionary</p>
            </div>
          </div>

          <div className="ledger-stat-card card">
            <div className="ledger-stat-card__big">
              <Sparkles size={20} className="ledger-stat-icon" />
              <span className="stat__number">{verifiedCount}</span>
            </div>
            <div>
              <p className="ledger-stat-card__label">Phoneme Verified</p>
              <p className="text-caption">Custom phoneme strings confirmed via Phonemize API</p>
            </div>
          </div>

          <div className="ledger-stat-card card">
            <div className="ledger-stat-card__big">
              <AlertTriangle size={20} className="ledger-stat-icon ledger-stat-icon--warn" />
              <span className="stat__number">{uncoveredCount}</span>
            </div>
            <div>
              <p className="ledger-stat-card__label">Uncovered Terms</p>
              <p className="text-caption">Require custom phoneme injection for reliable pronunciation</p>
            </div>
          </div>
        </motion.div>

        {/* ─── Filters ──── */}
        <motion.div
          className="ledger-filters"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          <div className="ledger-search">
            <Search size={16} className="ledger-search__icon" />
            <input
              type="text"
              className="ledger-search__input"
              placeholder="Search vocabulary..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              id="ledger-search"
            />
          </div>

          <div className="ledger-category-pills">
            <button
              className={`category-pill ${!activeCategory ? 'category-pill--active' : ''}`}
              onClick={() => setActiveCategory(null)}
            >
              All ({ledger.length})
            </button>
            {categories.map(cat => (
              <button
                key={cat}
                className={`category-pill ${activeCategory === cat ? 'category-pill--active' : ''}`}
                onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
              >
                {categoryLabels[cat]} ({stats.countByCategory[cat]})
              </button>
            ))}
          </div>
        </motion.div>

        {/* ─── Vocabulary Table ──── */}
        <motion.div
          className="ledger-table-wrap"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.4 }}
        >
          <div className="ledger-table">
            <div className="ledger-table__header">
              <span>Term</span>
              <span>Category</span>
              <span>Phoneme String</span>
              <span>Coverage</span>
              <span>Status</span>
            </div>
            <div className="ledger-table__body">
              <AnimatePresence>
                {filtered.map((entry, i) => (
                  <motion.div
                    key={entry.id}
                    className="ledger-row"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.3, delay: i * 0.03 }}
                    layout
                  >
                    <div className="ledger-row__term">
                      <button
                        className="ledger-row__word ledger-row__word-btn"
                        onClick={() => handlePreview(entry)}
                        id={`preview-pronunciation-${entry.id}`}
                        title={`Hear how ${entry.word} is pronounced`}
                        aria-label={`Hear how ${entry.word} is pronounced`}
                      >
                        {entry.word}
                        {preview.entryId === entry.id && (
                          <span className="ledger-row__preview-state" aria-hidden="true">
                            {preview.phase === 'loading'
                              ? <Loader2 size={12} className="ledger-row__preview-spin" />
                              : <Volume2 size={12} />}
                          </span>
                        )}
                      </button>
                      <span className="sr-only" role="status">
                        {preview.entryId === entry.id
                          ? (preview.phase === 'loading'
                              ? `Loading pronunciation of ${entry.word}`
                              : `Playing pronunciation of ${entry.word}`)
                          : ''}
                      </span>
                    </div>
                    <div>
                      <span className={`badge ${categoryColors[entry.category]}`}>
                        {categoryLabels[entry.category]}
                      </span>
                    </div>
                    <div className="ledger-row__phoneme">
                      {entry.phoneme ? (
                        <code className="phoneme-code">{entry.phoneme}</code>
                      ) : (
                        <span className="text-caption">— pending</span>
                      )}
                    </div>
                    <div>
                      {entry.covered ? (
                        <span className="badge badge--success">
                          <Check size={10} /> In Dictionary
                        </span>
                      ) : (
                        <span className="badge badge--warning">
                          <AlertTriangle size={10} /> Uncovered
                        </span>
                      )}
                    </div>
                    <div className="ledger-row__status" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      {entry.verified ? (
                        <span className="badge badge--success">
                          <Check size={10} /> Verified
                        </span>
                      ) : (
                        <>
                          <span className="badge badge--danger">
                            Pending
                          </span>
                          <button
                            className="btn btn--ghost"
                            onClick={() => handleToggleRecording(entry.id)}
                            id={`record-pronunciation-${entry.id}`}
                            title="Record correct pronunciation"
                          >
                            {recordingId === entry.id ? <Square size={12} /> : <Mic size={12} />}
                            {recordingId === entry.id ? 'Stop' : 'Record'}
                          </button>
                        </>
                      )}
                      <button
                        className="btn btn--ghost ledger-row__delete"
                        onClick={() => handleDelete(entry)}
                        disabled={deletingId === entry.id}
                        id={`delete-term-${entry.id}`}
                        title={`Delete ${entry.word} from the ledger`}
                        aria-label={`Delete ${entry.word} from the ledger`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>

        {/* ─── Pipeline Explanation ──── */}
        <motion.div
          className="ledger-pipeline card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.5 }}
        >
          <div className="ledger-pipeline__header">
            <FileText size={18} className="ledger-pipeline__icon" />
            <div>
              <h3 className="ledger-pipeline__title">How the Ledger Pipeline Works</h3>
              <p className="text-caption">Automated, systematic, and measurable — not hand-typed phonemes</p>
            </div>
          </div>
          <div className="ledger-pipeline__steps">
            {[
              { label: 'Vocabulary List', desc: "Personal terms from the user\u2019s life" },
              { label: 'Coverage API', desc: 'Which words Rime already knows' },
              { label: 'Record Audio', desc: 'Correct pronunciation captured' },
              { label: 'Phonemize API', desc: 'Audio → Rime phoneme string' },
              { label: 'Store in Ledger', desc: 'Persisted per-user entry' },
              { label: 'Inject at Synthesis', desc: '{phoneme} in text + mistv2' },
            ].map((step, i) => (
              <div key={i} className="ledger-pipeline__step">
                <div className="ledger-pipeline__step-num">{i + 1}</div>
                <div>
                  <p className="ledger-pipeline__step-label">{step.label}</p>
                  <p className="text-caption">{step.desc}</p>
                </div>
                {i < 5 && <ChevronRight size={14} className="ledger-pipeline__arrow" />}
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </motion.main>
  )
}

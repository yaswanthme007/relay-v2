import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { motion, useScroll, useTransform, useInView } from 'framer-motion'
import { 
  Mic, Shield, Zap, Clock, Volume2, BookOpen, 
  ArrowRight, ChevronDown, Activity, Waves 
} from 'lucide-react'
import './LandingPage.css'

/* ─── Reusable animated section wrapper ────────────────── */
function RevealSection({ children, className = '', delay = 0 }: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-60px' })
  return (
    <motion.section
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 40 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay }}
    >
      {children}
    </motion.section>
  )
}

/* ─── Animated sound wave visualization ────────────────── */
function SoundWave() {
  const bars = [
    { height: 28, delay: 0 },
    { height: 40, delay: 0.1 },
    { height: 20, delay: 0.2 },
    { height: 48, delay: 0.05 },
    { height: 32, delay: 0.15 },
    { height: 44, delay: 0.08 },
    { height: 24, delay: 0.22 },
    { height: 36, delay: 0.12 },
    { height: 16, delay: 0.18 },
    { height: 42, delay: 0.03 },
    { height: 28, delay: 0.14 },
    { height: 38, delay: 0.07 },
  ]

  return (
    <div className="sound-wave" aria-hidden="true">
      {bars.map((bar, i) => (
        <motion.div
          key={i}
          className="sound-wave__bar"
          animate={{
            height: [bar.height * 0.4, bar.height, bar.height * 0.6, bar.height * 0.9, bar.height * 0.4],
          }}
          transition={{
            duration: 1.8,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: bar.delay,
          }}
        />
      ))}
    </div>
  )
}

/* ─── Floating orb decoration ──────────────────────────── */
function FloatingOrbs() {
  return (
    <div className="floating-orbs" aria-hidden="true">
      <motion.div
        className="orb orb--1"
        animate={{ y: [-10, 10, -10], x: [-5, 5, -5] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="orb orb--2"
        animate={{ y: [8, -12, 8], x: [5, -8, 5] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="orb orb--3"
        animate={{ y: [-6, 14, -6], x: [-8, 3, -8] }}
        transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  )
}

/* ─── Stat counter ─────────────────────────────────────── */
function StatNumber({ value, suffix = '', label }: {
  value: string
  suffix?: string
  label: string
}) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <motion.div
      ref={ref}
      className="stat"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={inView ? { opacity: 1, scale: 1 } : {}}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="stat__number">{value}<span className="stat__suffix">{suffix}</span></span>
      <span className="stat__label">{label}</span>
    </motion.div>
  )
}

/* ─── WOW Feature card ─────────────────────────────────── */
function WowCard({ icon: Icon, title, description, index }: {
  icon: React.ElementType
  title: string
  description: string
  index: number
}) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-40px' })

  return (
    <motion.div
      ref={ref}
      className="wow-card card"
      initial={{ opacity: 0, y: 32 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: index * 0.1 }}
    >
      <div className="wow-card__icon-wrap">
        <Icon size={22} strokeWidth={1.5} />
      </div>
      <div className="wow-card__number">0{index + 1}</div>
      <h3 className="wow-card__title">{title}</h3>
      <p className="wow-card__desc">{description}</p>
    </motion.div>
  )
}

/* ─── Pipeline step ────────────────────────────────────── */
function PipelineStep({ step, label, detail, isLast = false }: {
  step: number
  label: string
  detail: string
  isLast?: boolean
}) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-30px' })

  return (
    <motion.div
      ref={ref}
      className="pipeline-step"
      initial={{ opacity: 0, x: -20 }}
      animate={inView ? { opacity: 1, x: 0 } : {}}
      transition={{ duration: 0.5, delay: step * 0.12 }}
    >
      <div className="pipeline-step__marker">
        <div className="pipeline-step__dot" />
        {!isLast && <div className="pipeline-step__line" />}
      </div>
      <div className="pipeline-step__content">
        <span className="pipeline-step__number">Step {step}</span>
        <h4 className="pipeline-step__label">{label}</h4>
        <p className="pipeline-step__detail">{detail}</p>
      </div>
    </motion.div>
  )
}


/* ═══════════════════════════════════════════════════════════════
   LANDING PAGE
   ═══════════════════════════════════════════════════════════════ */
export default function LandingPage() {
  const heroRef = useRef(null)
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  })
  const heroOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0])
  const heroY = useTransform(scrollYProgress, [0, 0.7], [0, 60])

  return (
    <motion.main
      className="landing"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* ═══ HERO ═══ */}
      <section className="hero" ref={heroRef} id="hero">
        <FloatingOrbs />

        <motion.div
          className="hero__content container"
          style={{ opacity: heroOpacity, y: heroY }}
        >
          <motion.div
            className="hero__overline"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <span className="text-overline">Voice-native assistive technology</span>
          </motion.div>

          <motion.h1
            className="hero__title text-display"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            They keep their voice.
            <br />
            <span className="hero__title-accent">We make sure it arrives.</span>
          </motion.h1>

          <motion.p
            className="hero__subtitle text-subheadline"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.55 }}
          >
            RELAY listens to dysarthric speech, reconstructs intended meaning using personal 
            vocabulary, and speaks it aloud in a voice that is consistently theirs.
            <em className="hero__emphasis"> Repair, not replace.</em>
          </motion.p>

          <motion.div
            className="hero__actions"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.75 }}
          >
            <Link to="/session" className="btn btn--accent btn--lg" id="hero-cta-primary">
              <Mic size={18} />
              Start a Relay Session
            </Link>
            <a href="#how-it-works" className="btn btn--secondary btn--lg" id="hero-cta-secondary">
              See how it works
              <ArrowRight size={16} />
            </a>
          </motion.div>

          <motion.div
            className="hero__wave-container"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1, delay: 0.9 }}
          >
            <SoundWave />
          </motion.div>
        </motion.div>

        <motion.div
          className="hero__scroll-hint"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5, duration: 0.8 }}
        >
          <motion.div
            animate={{ y: [0, 6, 0] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            <ChevronDown size={20} strokeWidth={1.5} />
          </motion.div>
        </motion.div>
      </section>


      {/* ═══ PROBLEM STATEMENT ═══ */}
      <RevealSection className="problem-section" delay={0.1}>
        <div className="container container--narrow">
          <div className="problem__content">
            <div className="divider--accent" />
            <h2 className="text-headline problem__title">
              The world's assistive tools tell people to stop speaking.
            </h2>
            <p className="text-body problem__body">
              People with dysarthria — slurred or unclear speech caused by cerebral palsy, 
              stroke, ALS, or Parkinson's — can think in full sentences but cannot be reliably 
              understood. Today's tools make them abandon speech entirely and tap words on a grid. 
              That strips away identity. RELAY does the opposite: they keep speaking.
            </p>
            <div className="problem__stat-row">
              <StatNumber value="8M" suffix="+" label="People with dysarthria in the US alone" />
              <StatNumber value="2.8" suffix="s" label="Silence that loses the conversation" />
              <StatNumber value="50" suffix="ms" label="RELAY floor-hold response" />
            </div>
          </div>
        </div>
      </RevealSection>


      {/* ═══ HOW IT WORKS ═══ */}
      <RevealSection className="pipeline-section" delay={0.1}>
        <div className="container" id="how-it-works">
          <div className="section-header">
            <span className="text-overline">The Pipeline</span>
            <h2 className="text-headline">From speech to understood — in milliseconds</h2>
            <p className="text-subheadline">
              Every component is engineered to minimise the silence between intent and comprehension.
            </p>
          </div>

          <div className="pipeline">
            <PipelineStep
              step={1}
              label="Voice Capture & VAD"
              detail="Browser microphone captures audio. Voice Activity Detection identifies end-of-turn in real-time — the moment you stop speaking, processing begins."
            />
            <PipelineStep
              step={2}
              label="Floor-Hold Response"
              detail={`Within 50ms, a pre-synthesised phrase plays in your voice — "One moment" — holding the listener\u2019s attention while reconstruction runs. Zero network. Zero synthesis delay.`}
            />
            <PipelineStep
              step={3}
              label="ASR via Groq Whisper"
              detail="The raw audio is transcribed by Groq's whisper-large-v3-turbo. Fast, but noisy for dysarthric speech. That noise is expected — the next step fixes it."
            />
            <PipelineStep
              step={4}
              label="Intelligent Reconstruction"
              detail="An LLM reconstructs intended meaning from the noisy transcript, guided by your Personal Pronunciation Ledger, situational context, and conversation history."
            />
            <PipelineStep
              step={5}
              label="Confidence-Gated Prosody"
              detail="High confidence? Spoken as a statement. Medium? Delivered as a question with a natural pause. Low? Silent — candidates shown for manual selection. The voice encodes its own uncertainty."
            />
            <PipelineStep
              step={6}
              label="Rime TTS Synthesis"
              detail="Final text is synthesised through Rime's mistv2 model with your persistent voice identity and personal phoneme pronunciations via WebSocket — complete with barge-in fencing."
              isLast
            />
          </div>
        </div>
      </RevealSection>


      {/* ═══ WOW FACTORS ═══ */}
      <RevealSection className="wow-section">
        <div className="container">
          <div className="section-header">
            <span className="text-overline">What sets RELAY apart</span>
            <h2 className="text-headline">Six engineering innovations, not six features</h2>
            <p className="text-subheadline">
              Each breakthrough solves a real, non-obvious problem in voice-assisted communication.
            </p>
          </div>

          <div className="wow-grid">
            <WowCard
              icon={Clock}
              title="Floor-Holding"
              description="Pre-synthesised phrases play in your voice within 50ms of end-of-turn. Hold the conversational floor while reconstruction runs — no awkward silence."
              index={0}
            />
            <WowCard
              icon={Activity}
              title="Confidence-Gated Prosody"
              description="The system's certainty is audible. High confidence speaks as a statement. Medium confidence delivers as a question. Low confidence stays silent — safety through sound."
              index={1}
            />
            <WowCard
              icon={BookOpen}
              title="Personal Pronunciation Ledger"
              description="Your name, medications, doctor names, and daily phrases — each with verified phoneme strings. The voice that speaks for you never mispronounces your own identity."
              index={2}
            />
            <WowCard
              icon={Zap}
              title="Barge-In Fencing"
              description="Change your mind mid-playback? Audio stops in under 150ms. Stale audio chunks are fenced by context ID and discarded — only what you heard is recorded."
              index={3}
            />
            <WowCard
              icon={Shield}
              title="Heard Receipt"
              description="An append-only log of every word that actually reached the listener's ears, with timestamps and cut markers. Observability, safety, and accountability in one artifact."
              index={4}
            />
            <WowCard
              icon={Volume2}
              title="Persistent Voice Identity"
              description="Pick a voice during onboarding. From that moment, every phrase, every confirmation, every sentence uses it. This is not a setting — it is an identity."
              index={5}
            />
          </div>
        </div>
      </RevealSection>


      {/* ═══ QUOTE / PHILOSOPHY ═══ */}
      <RevealSection className="quote-section">
        <div className="container container--narrow">
          <div className="quote-block">
            <div className="quote-block__marks" aria-hidden="true">"</div>
            <blockquote className="quote-block__text">
              A person with dysarthria having their own name mispronounced — by the machine that 
              is supposed to be speaking for them — is the most quietly humiliating failure in this 
              entire product space.
            </blockquote>
            <p className="quote-block__caption">
              That is why the Personal Pronunciation Ledger exists. Fix it. Let it land.
            </p>
          </div>
        </div>
      </RevealSection>


      {/* ═══ TECHNICAL TRANSPARENCY ═══ */}
      <RevealSection className="tech-section">
        <div className="container">
          <div className="section-header">
            <span className="text-overline">Under the hood</span>
            <h2 className="text-headline">Every decision, documented</h2>
          </div>

          <div className="tech-grid">
            <div className="tech-card card--flat card">
              <div className="tech-card__header">
                <span className="text-mono">TTS ENGINE</span>
              </div>
              <h4 className="tech-card__value">Rime · mistv2</h4>
              <p className="tech-card__detail">
                The only current model supporting <code>phonemizeBetweenBrackets</code>. 
                Non-negotiable for deterministic pronunciation.
              </p>
            </div>

            <div className="tech-card card--flat card">
              <div className="tech-card__header">
                <span className="text-mono">ASR</span>
              </div>
              <h4 className="tech-card__value">Groq · Whisper</h4>
              <p className="tech-card__detail">
                whisper-large-v3-turbo via Groq for fastest hosted transcription. 
                Latency is the entire game here.
              </p>
            </div>

            <div className="tech-card card--flat card">
              <div className="tech-card__header">
                <span className="text-mono">TRANSPORT</span>
              </div>
              <h4 className="tech-card__value">WebSocket · ws3</h4>
              <p className="tech-card__detail">
                <code>clear</code> operation + context IDs for barge-in fencing. 
                HTTP endpoints cannot fence stale audio.
              </p>
            </div>

            <div className="tech-card card--flat card">
              <div className="tech-card__header">
                <span className="text-mono">RECONSTRUCTION</span>
              </div>
              <h4 className="tech-card__value">Groq · LLaMA 3.3</h4>
              <p className="tech-card__detail">
                70B versatile model in JSON mode. Constrained inference against 
                known vocabulary, not generic "fix the sentence."
              </p>
            </div>
          </div>
        </div>
      </RevealSection>


      {/* ═══ CTA ═══ */}
      <RevealSection className="cta-section">
        <div className="container container--narrow">
          <div className="cta-block">
            <Waves size={32} strokeWidth={1} className="cta-block__icon" />
            <h2 className="text-headline cta-block__title">
              Experience what repair sounds like
            </h2>
            <p className="text-subheadline cta-block__sub">
              Begin a relay session to see the full pipeline in action — from captured speech 
              to reconstructed, spoken output in a persistent voice.
            </p>
            <Link to="/session" className="btn btn--accent btn--lg" id="cta-bottom">
              <Mic size={18} />
              Begin a Relay Session
            </Link>
          </div>
        </div>
      </RevealSection>
    </motion.main>
  )
}

import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'
import {
  Users, AlertTriangle, Heart, Code, Lightbulb
} from 'lucide-react'
import './AboutPage.css'

function RevealBlock({ children, className = '', delay = 0 }: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-50px' })
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 32 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay }}
    >
      {children}
    </motion.div>
  )
}

export default function AboutPage() {
  return (
    <motion.main
      className="about-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="container">
        {/* ─── Hero ──── */}
        <motion.div
          className="about-hero"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.1 }}
        >
          <span className="text-overline">About RELAY</span>
          <h1 className="text-display about-hero__title">
            Repair, not replace
          </h1>
          <p className="text-subheadline about-hero__sub">
            RELAY is a voice-native speech repair system built for people with dysarthria. 
            Instead of asking users to abandon speech, RELAY listens, reconstructs, and speaks 
            — preserving the person behind every word.
          </p>
        </motion.div>


        {/* ─── Philosophy ──── */}
        <RevealBlock className="about-section" delay={0.1}>
          <div className="about-split">
            <div className="about-split__text">
              <div className="about-section-label">
                <Lightbulb size={16} />
                <span className="text-overline">Philosophy</span>
              </div>
              <h2 className="text-headline">The right to be heard should never depend on the clarity of your speech</h2>
              <p className="text-body">
                People with dysarthria can think in complete sentences, hold conversations in their heads, 
                and have rich inner lives. The failure is not in their cognition — it's in the bridge between 
                their mind and the world's ability to listen.
              </p>
              <p className="text-body">
                Current assistive technologies ask users to type on a grid, selecting pre-built phrases 
                that someone else decided they might need. This strips away spontaneity, personality, and 
                identity. RELAY takes the opposite approach: let them speak, and let us do the work of 
                making sure what they meant is what the world hears.
              </p>
            </div>
            <div className="about-split__aside">
              <div className="about-quote-card card--flat card">
                <p className="about-quote-card__text">
                  "They did not pick a setting. They picked a voice they are willing to be heard as."
                </p>
                <span className="about-quote-card__from text-caption">— On persistent voice identity</span>
              </div>
            </div>
          </div>
        </RevealBlock>


        {/* ─── Engineering Decisions ──── */}
        <RevealBlock className="about-section">
          <div className="about-section-label">
            <Code size={16} />
            <span className="text-overline">Engineering Decisions</span>
          </div>
          <h2 className="text-headline">Deliberate trade-offs, not hidden limitations</h2>
          <p className="text-body" style={{ maxWidth: 640, marginBottom: 'var(--space-8)' }}>
            Every architectural choice in RELAY was made for a reason, documented, and defended.
          </p>

          <div className="decisions-grid">
            <div className="decision-card card">
              <h3 className="decision-card__title">Why mistv2 over Coda or Arcana</h3>
              <p className="decision-card__body">
                We evaluated Coda for multilingual support. Coda does not support 
                <code>phonemizeBetweenBrackets</code>. For a user whose core failure mode is having 
                their own name and medication mispronounced, deterministic pronunciation is not negotiable 
                and multilingual is. We chose <code>mistv2</code> and documented the trade-off.
              </p>
              <span className="decision-card__tag badge">Pronunciation {'>'} Multilingual</span>
            </div>

            <div className="decision-card card">
              <h3 className="decision-card__title">Why WebSocket over HTTP for TTS</h3>
              <p className="decision-card__body">
                Rime's WebSocket API (<code>ws3</code>) provides <code>clear</code> operations and 
                context IDs specifically for interruption handling. When a user changes their mind 
                mid-playback, we need to fence stale audio chunks, not just stop playback. HTTP 
                endpoints cannot fence.
              </p>
              <span className="decision-card__tag badge badge--info">Fencing {'>'} Simplicity</span>
            </div>

            <div className="decision-card card">
              <h3 className="decision-card__title">Why simulated, not clinical speech</h3>
              <p className="decision-card__body">
                Clinical datasets like TORGO and UASpeech require institutional licences that cannot be 
                obtained in a hackathon timeframe. We use simulated dysarthric speech and disclose this 
                as a limitation. Disclosure beats fabrication — judges scoring evidence will notice which 
                approach teams chose.
              </p>
              <span className="decision-card__tag badge badge--warning">Honesty {'>'} Optics</span>
            </div>

            <div className="decision-card card">
              <h3 className="decision-card__title">Why floor-holding matters</h3>
              <p className="decision-card__body">
                The naive pipeline creates ~2.8 seconds of silence between end-of-turn and spoken 
                output. In that silence, a pharmacist looks away, starts talking, or turns to the 
                next customer. The user loses the conversational floor. A spinner cannot hold a 
                floor — only sound can.
              </p>
              <span className="decision-card__tag badge badge--success">Sound {'>'} Screen</span>
            </div>
          </div>
        </RevealBlock>


        {/* ─── Limitations ──── */}
        <RevealBlock className="about-section">
          <div className="about-section-label">
            <AlertTriangle size={16} />
            <span className="text-overline">Honest Limitations</span>
          </div>
          <h2 className="text-headline">What RELAY cannot do yet</h2>

          <div className="limitations-list">
            {[
              {
                title: 'English only',
                detail: 'Mist v2 supports English, French, German, and Spanish. Hindi, Tamil, and other Indian languages are Coda-only, which lacks phoneme bracket support. A production version would route per-utterance across models.',
              },
              {
                title: 'Simulated dysarthric speech',
                detail: 'Tested on simulated impairment, not clinical recordings. Accuracy on severe, real-world dysarthria is unvalidated. Clinical evaluation is essential before any deployment.',
              },
              {
                title: 'Synthetic persona',
                detail: 'The user profile, prescriptions, and clinician names are entirely invented. No real patient data was used at any point in development or testing.',
              },
              {
                title: 'ASR failure on severe cases',
                detail: 'Whisper on severely dysarthric speech may produce unintelligible output. The reconstruction layer cannot recover from total ASR failure — it needs phonetic shadows of intent.',
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                className="limitation-item card--flat card"
                initial={{ opacity: 0, x: -12 }}
                whileInView={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.08, duration: 0.4 }}
                viewport={{ once: true }}
              >
                <h4 className="limitation-item__title">{item.title}</h4>
                <p className="limitation-item__detail text-body">{item.detail}</p>
              </motion.div>
            ))}
          </div>
        </RevealBlock>


        {/* ─── Built With ──── */}
        <RevealBlock className="about-section">
          <div className="built-with card">
            <div className="built-with__header">
              <Heart size={18} className="built-with__icon" />
              <h3 className="built-with__title">Built with purpose</h3>
            </div>
            <p className="text-body">
              RELAY exists because speech is identity. Every design decision, every engineering 
              trade-off, every line of code serves one sentence:
            </p>
            <p className="built-with__quote">
              "They keep their voice. We just make sure it arrives."
            </p>
          </div>
        </RevealBlock>
      </div>
    </motion.main>
  )
}

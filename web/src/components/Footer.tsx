import { Link } from 'react-router-dom'
import { Heart } from 'lucide-react'
import './Footer.css'

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__grid">
          {/* Brand */}
          <div className="footer__brand">
            <div className="footer__logo">
              <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="4" fill="var(--color-accent)" />
                <path d="M8 16 C8 11, 11 8, 16 8" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                <path d="M16 8 C21 8, 24 11, 24 16" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
              </svg>
              <span>RELAY</span>
            </div>
            <p className="footer__tagline">
              They keep their voice.<br />
              We just make sure it arrives.
            </p>
          </div>

          {/* Navigation */}
          <div className="footer__col">
            <h4 className="footer__heading">Navigate</h4>
            <Link to="/" className="footer__link">Home</Link>
            <Link to="/session" className="footer__link">Relay Session</Link>
            <Link to="/ledger" className="footer__link">Voice Ledger</Link>
            <Link to="/about" className="footer__link">About</Link>
          </div>

          {/* Technical */}
          <div className="footer__col">
            <h4 className="footer__heading">Architecture</h4>
            <span className="footer__link footer__link--static">Rime TTS · mistv2</span>
            <span className="footer__link footer__link--static">Groq Whisper ASR</span>
            <span className="footer__link footer__link--static">WebSocket ws3</span>
            <span className="footer__link footer__link--static">React + FastAPI</span>
          </div>

          {/* Mission */}
          <div className="footer__col">
            <h4 className="footer__heading">Mission</h4>
            <p className="footer__mission-text">
              Built for people with dysarthria — because the right to be heard 
              should never depend on the clarity of your speech.
            </p>
          </div>
        </div>

        <div className="footer__bottom">
          <p className="footer__copy">
            © {new Date().getFullYear()} DataForge. Crafted for the Pathway × Rime Hackathon.
          </p>
          <p className="footer__made-with">
            Made with <Heart size={13} className="footer__heart" /> for accessibility
          </p>
        </div>
      </div>
    </footer>
  )
}

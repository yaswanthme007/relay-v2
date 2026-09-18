import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Menu, X } from 'lucide-react'
import './Navbar.css'

const navLinks = [
  { to: '/', label: 'Home' },
  { to: '/session', label: 'Relay Session' },
  { to: '/ledger', label: 'Voice Ledger' },
  { to: '/about', label: 'About' },
]

export default function Navbar() {
  const location = useLocation()
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  return (
    <motion.header
      className={`navbar ${scrolled ? 'navbar--scrolled' : ''}`}
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="navbar__inner container">
        {/* Logo */}
        <Link to="/" className="navbar__logo" id="nav-logo">
          <div className="navbar__logo-mark">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="4" fill="var(--color-accent)" />
              <path d="M8 16 C8 11, 11 8, 16 8" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
              <path d="M16 8 C21 8, 24 11, 24 16" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
              <path d="M24 16 C24 21, 21 24, 16 24" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" opacity="0.3" />
            </svg>
          </div>
          <span className="navbar__wordmark">RELAY</span>
        </Link>

        {/* Desktop Nav */}
        <nav className="navbar__nav" id="nav-desktop">
          {navLinks.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`navbar__link ${location.pathname === to ? 'navbar__link--active' : ''}`}
              id={`nav-link-${label.toLowerCase().replace(/\s+/g, '-')}`}
            >
              {label}
              {location.pathname === to && (
                <motion.div
                  className="navbar__link-indicator"
                  layoutId="nav-indicator"
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              )}
            </Link>
          ))}
        </nav>

        {/* CTA */}
        <div className="navbar__actions">
          <Link to="/session" className="btn btn--primary btn--sm" id="nav-cta">
            Begin Session
          </Link>
        </div>

        {/* Mobile Toggle */}
        <button
          className="navbar__toggle"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
          id="nav-toggle"
        >
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {/* Mobile Menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            className="navbar__mobile"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            <nav className="navbar__mobile-nav">
              {navLinks.map(({ to, label }, i) => (
                <motion.div
                  key={to}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.06, duration: 0.3 }}
                >
                  <Link
                    to={to}
                    className={`navbar__mobile-link ${location.pathname === to ? 'navbar__mobile-link--active' : ''}`}
                  >
                    {label}
                  </Link>
                </motion.div>
              ))}
              <motion.div
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: navLinks.length * 0.06, duration: 0.3 }}
              >
                <Link to="/session" className="btn btn--primary" style={{ width: '100%', marginTop: '0.5rem' }}>
                  Begin Session
                </Link>
              </motion.div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  )
}

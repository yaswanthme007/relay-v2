import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import Navbar from './components/Navbar'
import LandingPage from './pages/LandingPage'
import SessionPage from './pages/SessionPage'
import LedgerPage from './pages/LedgerPage'
import AboutPage from './pages/AboutPage'
import Footer from './components/Footer'

export default function App() {
  const location = useLocation()

  return (
    <>
      <Navbar />
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/session" element={<SessionPage />} />
          <Route path="/ledger" element={<LedgerPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </AnimatePresence>
      <Footer />
    </>
  )
}

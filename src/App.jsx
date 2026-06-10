import React, { useState, useEffect } from 'react'
import Header from './components/Header.jsx'
import Footer from './components/Footer.jsx'
import HomePage from './pages/HomePage.jsx'
import CommandCenter from './pages/CommandCenter.jsx'
import ScrollToTop from './components/ScrollToTop.jsx'

function App() {
  const [hash, setHash] = useState(typeof window !== 'undefined' ? window.location.hash : '')

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const isCommandCenter = hash.startsWith('#/command-center')

  return (
    <>
      <ScrollToTop />
      <Header />
      <main className="pt-16">
        {isCommandCenter ? <CommandCenter /> : <HomePage />}
      </main>
      <Footer />
    </>
  )
}

export default App

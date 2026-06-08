import React from 'react'
import Header from './components/Header.jsx'
import Footer from './components/Footer.jsx'
import HomePage from './pages/HomePage.jsx'
import BillingWorklist from './pages/BillingWorklist.jsx'
import ScrollToTop from './components/ScrollToTop.jsx'

function App() {
  // The embedded Epic app lives at /app (the SMART callback redirects here with
  // ?session=...). Everything else is the marketing site. A tiny path check
  // keeps the bundle router-free.
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  const isApp = path.startsWith('/app')

  if (isApp) {
    return <BillingWorklist />
  }

  return (
    <>
      <ScrollToTop />
      <Header />
      <main className="pt-16">
        <HomePage />
      </main>
      <Footer />
    </>
  )
}

export default App

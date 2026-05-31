import React from 'react'
import Header from './components/Header.jsx'
import Footer from './components/Footer.jsx'
import HomePage from './pages/HomePage.jsx'
import ScrollToTop from './components/ScrollToTop.jsx'

function App() {
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

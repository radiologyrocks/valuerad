import React from 'react';
import { Mail, Phone, X } from 'lucide-react';

const Footer = () => {
  const scrollToSection = (sectionId) => {
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <footer className="bg-muted text-muted-foreground border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="md:col-span-2">
            <span className="text-2xl font-bold text-primary">ValueRad</span>
            <p className="mt-4 text-sm leading-relaxed">
              Automating radiology scheduling to maximize ROI and improve patient care through intelligent workflow optimization.
            </p>
          </div>

          <div>
            <span className="text-sm font-semibold tracking-wide uppercase">Quick links</span>
            <nav className="mt-4 space-y-2">
              <button
                onClick={() => scrollToSection('features')}
                className="block text-sm hover:text-foreground transition-colors duration-200"
              >
                Features
              </button>
              <button
                onClick={() => scrollToSection('how-it-works')}
                className="block text-sm hover:text-foreground transition-colors duration-200"
              >
                How it works
              </button>
              <button
                onClick={() => scrollToSection('contact')}
                className="block text-sm hover:text-foreground transition-colors duration-200"
              >
                Contact
              </button>
            </nav>
          </div>

          <div>
            <span className="text-sm font-semibold tracking-wide uppercase">Contact</span>
            <div className="mt-4 space-y-3">
              <a
                href="mailto:info@valuerad.health"
                className="flex items-center gap-2 text-sm hover:text-foreground transition-colors duration-200"
              >
                <Mail size={16} />
                <span>info@valuerad.health</span>
              </a>
              <a
                href="tel:+18005551234"
                className="flex items-center gap-2 text-sm hover:text-foreground transition-colors duration-200"
              >
                <Phone size={16} />
                <span>(800) 555-1234</span>
              </a>
              <div className="flex gap-4 mt-4">
                <a
                  href="https://linkedin.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors duration-200"
                  aria-label="LinkedIn"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect width="4" height="12" x="2" y="9"/><circle cx="4" cy="4" r="2"/></svg>
                </a>
                <a
                  href="https://x.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors duration-200"
                  aria-label="X"
                >
                  <X size={20} />
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-sm">© 2026 ValueRad. All rights reserved.</p>
          <div className="flex gap-6">
            <a href="#" className="text-sm hover:text-foreground transition-colors duration-200">
              Privacy Policy
            </a>
            <a href="#" className="text-sm hover:text-foreground transition-colors duration-200">
              Terms of Service
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;

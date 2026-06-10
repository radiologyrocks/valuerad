import React, { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const Header = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const scrollToSection = (sectionId) => {
    setMobileMenuOpen(false);
    // If we're on a hash route (e.g. the Command Center), return home first.
    if (window.location.hash.startsWith('#/')) {
      window.location.hash = '';
      // Defer the scroll until the home page has rendered.
      setTimeout(() => document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' }), 50);
      return;
    }
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
  };

  const goToCommandCenter = () => {
    setMobileMenuOpen(false);
    window.location.hash = '#/command-center';
    window.scrollTo({ top: 0 });
  };

  const navLinks = [
    { label: 'Home', id: 'hero' },
    { label: 'Features', id: 'features' },
    { label: 'How it works', id: 'how-it-works' },
    { label: 'Contact', id: 'contact' }
  ];

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <button
              onClick={() => scrollToSection('hero')}
              className="text-2xl font-bold text-primary transition-colors duration-200 hover:text-primary/80"
            >
              ValueRad
            </button>
          </div>

          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => scrollToSection(link.id)}
                className="text-sm font-medium text-foreground/80 hover:text-foreground transition-colors duration-200"
              >
                {link.label}
              </button>
            ))}
            <button
              onClick={goToCommandCenter}
              className="text-sm font-medium text-primary hover:text-primary/80 transition-colors duration-200"
            >
              Command Center
            </button>
          </nav>

          <div className="hidden md:block">
            <Button
              onClick={() => scrollToSection('contact')}
              className="transition-all duration-200 active:scale-[0.98]"
            >
              Request demo
            </Button>
          </div>

          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 text-foreground transition-colors duration-200 hover:text-primary"
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="md:hidden border-t border-border bg-background">
          <nav className="px-4 py-4 space-y-3">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => scrollToSection(link.id)}
                className="block w-full text-left px-3 py-2 text-base font-medium text-foreground/80 hover:text-foreground hover:bg-muted rounded-lg transition-all duration-200"
              >
                {link.label}
              </button>
            ))}
            <button
              onClick={goToCommandCenter}
              className="block w-full text-left px-3 py-2 text-base font-medium text-primary hover:bg-muted rounded-lg transition-all duration-200"
            >
              Command Center
            </button>
            <Button
              onClick={() => scrollToSection('contact')}
              className="w-full transition-all duration-200 active:scale-[0.98]"
            >
              Request demo
            </Button>
          </nav>
        </div>
      )}
    </header>
  );
};

export default Header;

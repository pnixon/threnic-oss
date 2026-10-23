'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'high-contrast';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    // Load saved theme
    if (
      typeof window !== 'undefined' &&
      window.localStorage &&
      typeof window.localStorage.getItem === 'function'
    ) {
      try {
        const savedTheme = localStorage.getItem('threnic-theme') as Theme;
        if (
          savedTheme &&
          (savedTheme === 'dark' || savedTheme === 'light' || savedTheme === 'high-contrast')
        ) {
          if (savedTheme !== 'dark') {
            // Use resolved promise to avoid synchronous setState in effect
            Promise.resolve().then(() => setThemeState(savedTheme));
          }
          document.documentElement.setAttribute('data-theme', savedTheme);
        }
      } catch {
        // Ignore storage errors
      }
    }
  }, []);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    if (
      typeof window !== 'undefined' &&
      window.localStorage &&
      typeof window.localStorage.setItem === 'function'
    ) {
      try {
        localStorage.setItem('threnic-theme', newTheme);
        document.documentElement.setAttribute('data-theme', newTheme);
      } catch {
        // Ignore storage errors
      }
    } else if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', newTheme);
    }
  };

  const toggleTheme = () => {
    const nextTheme: Theme =
      theme === 'dark' ? 'light' : theme === 'light' ? 'high-contrast' : 'dark';
    setTheme(nextTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

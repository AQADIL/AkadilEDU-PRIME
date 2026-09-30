import { useState, useEffect } from 'react';
import { ThemeContext } from './theme';

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(() => {
    const savedTheme = localStorage.getItem('theme');
    return savedTheme || 'dark-graphite';
  });

  useEffect(() => {
    localStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const themes = {
    'dark-graphite': {
      name: 'Dark Graphite',
      background: 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-blue-400'
    },
    'dark-emerald': {
      name: 'Dark Emerald',
      background: 'bg-gradient-to-br from-emerald-950 via-emerald-900 to-emerald-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-emerald-400'
    },
    'deep-blue': {
      name: 'Deep Blue',
      background: 'bg-gradient-to-br from-blue-950 via-blue-900 to-blue-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-blue-400'
    },
    'midnight-purple': {
      name: 'Midnight Purple',
      background: 'bg-gradient-to-br from-purple-950 via-purple-900 to-indigo-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-purple-400'
    },
    'crimson-red': {
      name: 'Crimson Red',
      background: 'bg-gradient-to-br from-red-950 via-red-900 to-rose-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-red-400'
    },
    'amber-gold': {
      name: 'Amber Gold',
      background: 'bg-gradient-to-br from-amber-950 via-amber-900 to-yellow-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-amber-400'
    },
    'rose-pink': {
      name: 'Rose Pink',
      background: 'bg-gradient-to-br from-pink-950 via-pink-900 to-rose-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-pink-400'
    },
    'cyan-teal': {
      name: 'Cyan Teal',
      background: 'bg-gradient-to-br from-cyan-950 via-teal-900 to-cyan-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-cyan-400'
    },
    'violet-indigo': {
      name: 'Violet Indigo',
      background: 'bg-gradient-to-br from-violet-950 via-indigo-900 to-violet-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-violet-400'
    },
    'obsidian-black': {
      name: 'Obsidian Black',
      background: 'bg-gradient-to-br from-gray-950 via-black to-gray-950',
      card: 'bg-white/10 backdrop-blur-xl border border-white/20',
      text: 'text-white',
      textSecondary: 'text-white/70',
      accent: 'text-gray-400'
    }
  };

  const currentTheme = themes[theme] || themes['dark-graphite'];

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes, currentTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

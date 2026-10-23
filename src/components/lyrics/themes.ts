import type { LyricTheme } from '@/types/lyrics';

/**
 * Pre-defined lyric themes
 */
const THEMES: Record<string, LyricTheme> = {
  neon: {
    fontUrl: undefined, // Uses default Inter
    fontSize: 0.8,
    colorPre: '#555555',
    colorActive: '#ef4444',
    colorPost: '#333333',
    effect: 'shake',
    glowColor: '#ef4444',
    audioReactive: true,
    animationIn: { type: 'pop', granularity: 'word', duration: 0.2, stagger: 0.1 },
    animationOut: { type: 'fade', granularity: 'line', duration: 0.5 },
  },

  cinema: {
    fontUrl: undefined,
    fontSize: 1.0,
    colorPre: '#888888',
    colorActive: '#ffffff',
    colorPost: '#444444',
    effect: 'fade',
    audioReactive: false,
    animationIn: { type: 'fade', granularity: 'line', duration: 1.0 },
    animationOut: { type: 'fade', granularity: 'line', duration: 0.5 },
  },

  karaoke: {
    fontUrl: undefined,
    fontSize: 0.9,
    colorPre: '#666666',
    colorActive: '#ec4899',
    colorPost: '#ec4899',
    effect: 'scale',
    glowColor: '#ec4899',
    audioReactive: true,
    animationIn: { type: 'pop', granularity: 'word', duration: 0.3 },
    animationOut: { type: 'fade', granularity: 'line', duration: 0.3 },
  },

  minimal: {
    fontUrl: undefined,
    fontSize: 0.7,
    colorPre: '#ffffff',
    colorActive: '#ffffff',
    colorPost: '#666666',
    effect: 'none',
    audioReactive: false,
    animationIn: { type: 'fade', granularity: 'line', duration: 0.5 },
    animationOut: { type: 'fade', granularity: 'line', duration: 0.5 },
  },

  crucible: {
    fontUrl: undefined,
    fontSize: 0.85,
    colorPre: '#666666',
    colorActive: '#ef4444',
    colorPost: '#444444',
    effect: 'glow',
    glowColor: '#ef4444',
    audioReactive: true,
    animationIn: { type: 'fly', granularity: 'word', duration: 0.5, stagger: 0.05, distance: 5.0 },
    animationOut: { type: 'fly', granularity: 'line', duration: 0.5, distance: -5.0 },
  },

  vintage: {
    fontUrl: undefined,
    fontSize: 0.95,
    colorPre: '#d4a574',
    colorActive: '#fef3c7',
    colorPost: '#92400e',
    effect: 'fade',
    audioReactive: false,
    animationIn: { type: 'fade', granularity: 'char', duration: 1.0, stagger: 0.02 },
    animationOut: { type: 'fade', granularity: 'line', duration: 0.5 },
  },

  matrix: {
    fontUrl: undefined, // Share Tech Mono would be ideal if available
    fontSize: 0.9,
    colorPre: '#003300',
    colorActive: '#00ff00',
    colorPost: '#001100',
    effect: 'glow',
    glowColor: '#00ff00',
    audioReactive: true,
    animationIn: { type: 'pop', granularity: 'char', duration: 0.1, stagger: 0.02 },
    animationOut: { type: 'fade', granularity: 'line', duration: 0.3 },
  },
};

/**
 * Get a theme by name, with fallback to crucible
 */
export function getTheme(name: string): LyricTheme {
  return THEMES[name] ?? THEMES.crucible;
}

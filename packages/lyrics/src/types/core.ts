/**
 * Core Lyric Data Types
 * Defines the fundamental structures for lyric data and timing.
 *
 * Moved verbatim from the Threnic app (src/types/lyrics/core.ts) as part of
 * the @threnic/lyrics extraction. Pure interfaces — no app coupling.
 */

export interface Word {
  /** The word text */
  text: string;
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
}

/**
 * Per-line style overrides — any field present here
 * takes precedence over the track-level LyricTheme.
 */
export interface LineStyleOverride {
  /** Font override (font ID) */
  fontId?: string;
  /** Font size override */
  fontSize?: number;
  /** Vertical position override (0-100) */
  verticalPosition?: number;
  /** Horizontal anchor override ('left' | 'center' | 'right') */
  horizontalPosition?: 'left' | 'center' | 'right';
  /** Wrap-column width override as a percentage of canvas width (10-100) */
  wrapWidth?: number;
  /** Color overrides */
  colorPre?: string;
  colorActive?: string;
  colorPost?: string;
  /** Nested colors object */
  colors?: {
    pre?: string;
    active?: string;
    post?: string;
  };
  /** Outline color */
  outlineColor?: string;
  /** Word spacing */
  wordSpacing?: number;
  /** Line-height multiplier override (vertical spacing) */
  lineSpacing?: number;
  /** Letter spacing multiplier (0 = tight, 1 = default, 2 = wide) */
  letterSpacing?: number;
  /** Glow overrides */
  glowEnabled?: boolean;
  glowColor?: string;
  glowIntensity?: number;
  /** Highlight fade-in duration (default: uses word duration) */
  highlightFadeIn?: number;
  /** Highlight fade-out duration (default: 0.5) */
  highlightFadeOut?: number;
  /** Animation overrides */
  animationIn?: LyricAnimationConfig;
  animationOut?: LyricAnimationConfig;
  /** Custom label for the line (e.g. "Chorus", "Verse 1") */
  label?: string;
}

export interface LyricLineData {
  /** Unique ID for the line */
  id: string;
  /** Full text of the line */
  text: string;
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Individual word timings (optional) */
  words?: Word[];
  /** Lane assignment for multi-voice support (0-based) */
  laneIndex?: number;
}

export interface LyricsConfig {
  /** Array of lyric lines */
  lines: LyricLineData[];
  /** Theme configuration */
  theme: LyricTheme;
  /** Vertical position offset */
  positionY?: number;
  /** Maximum width before wrapping */
  maxWidth?: number;
}

export type LyricAnimationType = 'fly' | 'fade' | 'pop' | 'typewriter' | 'zoom' | 'slide';
export type LyricAnimationGranularity = 'char' | 'word' | 'line';

export interface LyricAnimationConfig {
  type: LyricAnimationType;
  granularity: LyricAnimationGranularity;
  /** Duration in seconds (default: 0.5) */
  duration?: number;
  /** Stagger delay between elements in seconds (default: 0.05) */
  stagger?: number;
  /** Distance for fly animation (default: 2.0) */
  distance?: number;
}

export interface LyricTheme {
  /** Font URL for SDF text */
  fontUrl?: string;
  /** Font Family ID */
  fontId?: string;
  /** Font size */
  fontSize: number;
  /** Font weight (100-900) */
  fontWeight?: number;
  /** Word spacing multiplier (default: 1.0) */
  wordSpacing?: number;
  /**
   * Line-height multiplier applied to font size for vertical spacing between
   * wrapped rows and stacked lines (default: 1.35). Higher = more air between
   * lines.
   */
  lineSpacing?: number;
  /** Letter spacing in em units (default: 0). Positive = wider, negative = tighter. */
  letterSpacing?: number;
  /** Vertical position offset (percentage 0-100) */
  verticalPosition?: number;
  /**
   * Horizontal anchor for each wrapped row within the wrap column
   * (default: 'center'). 'left'/'right' align rows to the wrap-column edge.
   */
  horizontalPosition?: 'left' | 'center' | 'right';
  /**
   * Auto-wrap column width as a percentage of canvas width (10-100,
   * default: 90). Lyrics wrap to fit this column at any aspect ratio; the
   * horizontalPosition anchor aligns rows within it.
   */
  wrapWidth?: number;
  /** Character width multiplier for layout estimation (default: 0.6) */
  charWidth?: number;
  /** Color for upcoming/inactive words */
  colorPre?: string;
  /** Color when word is currently active */
  colorActive?: string;
  /** Color for words that have passed */
  colorPost?: string;
  /** Nested colors object (preferred) */
  colors?: {
    pre: string;
    active: string;
    post: string;
  };
  /** Effect type */
  effect: 'none' | 'shake' | 'fade' | 'scale' | 'glow' | 'cinematic' | 'kinetic' | 'glitch' | 'vhs';
  /** Glow color (optional) */
  glowColor?: string;
  /** Outline color (optional, default black) */
  outlineColor?: string;
  /** Whether glow is enabled */
  glowEnabled?: boolean;
  /** Whether to enable audio reactivity */
  audioReactive: boolean;
  /** Effect intensity (0.0 - 1.0) */
  effectIntensity?: number;
  /** Entry animation configuration */
  animationIn?: LyricAnimationConfig;
  /** Exit animation configuration */
  animationOut?: LyricAnimationConfig;
  /** Whether to scale active word */
  activeScale?: boolean;
  /** Glow intensity (0.0 - 1.0) */
  glowIntensity?: number;
  /** Anti-alias GPU-rendered glyph edges (WebGPU lyric path only). true /
   *  undefined = smooth analytic AA (default); false = crisp/aliased edges. */
  antialiasing?: boolean;
  /** Highlight fade-in duration (default: uses word duration) */
  highlightFadeIn?: number;
  /** Highlight fade-out duration (default: 0.5) */
  highlightFadeOut?: number;
  /** Per-lane style overrides — key is the 0-based lane index */
  laneStyles?: Record<number, LineStyleOverride>;
  /** Number of user-configured lanes (default: 1) */
  laneCount?: number;
  /** Whether to enable smooth character-level karaoke coloring (sweep) */
  karaokeEnabled?: boolean;
  /** Duration of the sweep across one word in seconds (if 0, uses word duration) */
  karaokeSweep?: number;
  /** Whether active words pulse to the audio beat */
  wordAudioReactive?: boolean;
  /**
   * Optional named presentation style (resolved via the renderer's
   * StyleRegistry). Absent/unknown ⇒ no style modifier applied.
   */
  styleId?: string;
  /**
   * Lyric rendering path (Lyric FX Engine, see docs/lyric-fx-engine-lld.md).
   * 'canvas' (default) uses the Canvas2D rasteriser; 'gpu' uses the per-glyph
   * MSDF GPU chain with the Lyric FX effect stack below.
   */
  renderer?: 'canvas' | 'gpu';
  /**
   * GPU Lyric FX effect stack (transform / surface / post), applied only when
   * `renderer === 'gpu'`. Each entry is a typed, independently-enabled effect
   * instance; structurally compatible with the app's `LyricEffectInstance`.
   * Kept as a minimal shape here so `@threnic/lyrics` stays GPU-free.
   */
  lyricFX?: Array<{
    id: string;
    type: string;
    config: Record<string, unknown> & { enabled: boolean };
  }>;
}

/**
 * Default lyrics theme applied to every new track.
 * Ensures verticalPosition and other essential fields are always present.
 */
export const DEFAULT_LYRICS_THEME: LyricTheme = {
  fontId: 'roboto',
  fontSize: 0.8,
  wordSpacing: 1.0,
  lineSpacing: 1.35,
  letterSpacing: 0,
  verticalPosition: 10,
  horizontalPosition: 'center',
  wrapWidth: 90,
  colorPre: '#A9A9A9',
  colorActive: '#FFFFFF',
  colorPost: '#666666',
  colors: {
    pre: '#A9A9A9',
    active: '#FFFFFF',
    post: '#666666',
  },
  effect: 'none',
  audioReactive: false,
  glowEnabled: false,
  glowColor: '#FFFFFF',
  glowIntensity: 0.3,
  outlineColor: '#000000',
  animationIn: { type: 'fade', granularity: 'word', duration: 1.0, stagger: 0.05 },
  animationOut: { type: 'fade', granularity: 'word', duration: 1.0, stagger: 0.05 },
  karaokeEnabled: true,
  wordAudioReactive: true,
  highlightFadeIn: 1.0,
  highlightFadeOut: 1.0,
};

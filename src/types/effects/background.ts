/**
 * Background and Scene Configuration Types
 * Defines background rendering modes and scene settings
 */

/** Video loop modes */
type VideoLoopMode = 'loop' | 'once' | 'pingPong' | 'crossfade' | 'paused';

export type BackgroundMode =
  | 'standard'
  | 'video'
  | 'pixi'
  | 'splat'
  | 'space'
  | 'clouds'
  | 'solid'
  | 'slideshow';

export interface VideoConfig {
  enabled: boolean;
  url?: string;
  /**
   * Whether the video loops. When false and pingPong is also false,
   * the video plays through once and pauses on the last frame ('once' mode).
   * @deprecated Prefer `loopMode` — kept for backward compatibility.
   */
  loop: boolean;
  /** @deprecated Prefer `loopMode` — kept for backward compatibility. */
  pingPong: boolean;
  paused: boolean;
  playbackRate: number;
  volume: number;
  /**
   * Unified loop mode. Takes priority over legacy `loop`/`pingPong` booleans.
   * - `'loop'`       — Simple looping
   * - `'once'`       — Play once, freeze on last frame
   * - `'pingPong'`   — Forward then reverse
   * - `'crossfade'`  — Crossfade between end and start (uses `crossfadeDuration`)
   * - `'paused'`     — Video is paused
   */
  loopMode?: VideoLoopMode;
  /**
   * Duration (in seconds) of the crossfade blend at the loop boundary.
   * Only used when `loopMode === 'crossfade'`. Default: 1.0
   */
  crossfadeDuration?: number;
}

export interface PixiConfig {
  enabled: boolean;
  shader: string;
  shaderSource: string;
  speed: number;
  zoom: number;
  brightness: number;
  audioReactive: boolean;
  image?: string | null;
  /** Whether to show the Lil-GUI debug panel for uniforms */
  showDebugGUI?: boolean;
}

export interface GaussianSplatConfig {
  enabled: boolean;
  url: string;
  scale: number;
  atomization: {
    enabled: boolean;
    band: 'bass' | 'mid' | 'high' | 'energy';
    threshold: number;
    maxDistance: number;
    speed: number;
  };
  melting: {
    enabled: boolean;
    intensity: number;
    speed: number;
  };
}

export interface CloudSceneConfig {
  speed: number;
  density: number;
  brightness: number;
  color: string;
  skyColor: string;
  quality: 'low' | 'medium' | 'high';
}

/* ────────────────────────────────────────────────────────
 * Slideshow / Carousel Background
 * ──────────────────────────────────────────────────────── */

/** Transition effect between slides */
export type SlideshowTransition =
  | 'cut' // Instant switch
  | 'crossfade' // Opacity blend
  | 'fadeBlack' // Fade out to black, then in
  | 'slideLeft' // New slide enters from right
  | 'slideRight' // New slide enters from left
  | 'slideUp' // New slide enters from bottom
  | 'slideDown' // New slide enters from top
  | 'zoom' // Zoom-in transition
  | 'random'; // Pick a random transition each time

/** How timing between slides is determined */
export type SlideshowTimingMode = 'static' | 'random';

/** Order in which slides are shown */
export type SlideshowOrder = 'sequential' | 'random';

/** A single media item in the slideshow */
export interface SlideshowMediaItem {
  /** Unique ID for this item (generated client-side) */
  id: string;
  /** 'image' or 'video' */
  type: 'image' | 'video';
  /** URL / blob URL / data URL of the media */
  url: string;
  /** Display label (usually filename) */
  label?: string;
  /** Whether the media failed to load/render in the preview */
  failed?: boolean;
  /** Whether the slide duration is overridden (for videos) */
  overrideDuration?: boolean;
  /** Custom/fixed duration for the slide in seconds */
  duration?: number;
}

/** Configuration for a slideshow background */
export interface SlideshowConfig {
  /** The media items to cycle through */
  items: SlideshowMediaItem[];

  /**
   * How the active media item is selected:
   * - 'slideshow' — Auto-cycle through items using the timer/order settings below
   * - 'keyframe'  — Manually controlled via `scene.backgroundMediaIndex` keyframes
   * - 'static'    — Always show the first item (index 0), no transitions
   */
  mode: 'slideshow' | 'keyframe' | 'static';

  /** Order of display (slideshow mode only) */
  order: SlideshowOrder;
  /** Timing mode (slideshow mode only) */
  timingMode: SlideshowTimingMode;
  /** Duration each slide is shown (seconds). Used when `timingMode === 'static'`. */
  staticDuration: number;
  /** Minimum duration (seconds) when `timingMode === 'random'`. */
  randomDurationMin: number;
  /** Maximum duration (seconds) when `timingMode === 'random'`. */
  randomDurationMax: number;
  /** Transition effect (slideshow mode only) */
  transition: SlideshowTransition;
  /** Duration of the transition effect (seconds) */
  transitionDuration: number;
  /**
   * When true, video items auto-transition at the end of the video
   * instead of using the fixed slide duration timer. (slideshow mode only)
   */
  videoEndTransition?: boolean;
  /**
   * Duration (seconds) of the fade-in/out when a video ends.
   * Used when `videoEndTransition` is true. Falls back to `transitionDuration`.
   */
  videoFadeDuration?: number;
}

import type { SceneTransitionConfig } from './keyframes';

export interface VideoClip {
  /** Unique ID for the clip (UUID) */
  id: string;
  /** Display name/label for the clip block */
  name: string;
  /** URL / blob URL / data URL of the video/image source media */
  url: string;
  /** Global timeline start time in seconds */
  startTime: number;
  /** Global timeline end time in seconds */
  endTime: number;
  /** In-point: crop start offset within the source media in seconds (default: 0) */
  inPoint: number;
  /** Out-point: crop end offset within the source media in seconds */
  outPoint: number;
  /** Total natural duration of the source media in seconds */
  sourceDuration: number;
  /** Playback speed multiplier (default: 1.0) */
  speed: number;
  /** Playback behavior when clip duration differs from source duration:
   * - 'loop': Repeat the video clip continuously
   * - 'pause': Pause/freeze on the last frame (or default behavior)
   * - 'speed': Speed up / slow down playback rate so media fits exactly
   */
  behavior: 'loop' | 'pause' | 'speed';

  // NLE adjustments
  brightness?: number;
  opacity?: number;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  angle?: number;
  contrast?: number;
  blur?: number;
  fit?: 'cover' | 'contain' | 'stretch' | 'original';
  tiling?: boolean;
  backgroundColor?: string;

  // NLE transition (transition entering this clip)
  transition?: SceneTransitionConfig;

  // Slideshow duration override settings
  overrideDuration?: boolean;
  duration?: number;
}

export type BackgroundClip = VideoClip;

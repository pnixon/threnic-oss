/**
 * Milkdrop Visualizer Configuration
 *
 * Each motion variable has a base value (slider) and an optional
 * AudioReactiveConfig that modulates it per-frame using the standard
 * AR widget pattern (band, sensitivity, curve, range).
 */

import type { AudioReactiveConfig } from './audio-reactive';

export interface MilkdropConfig {
  /** Whether the milkdrop layer is active */
  enabled: boolean;
  /** Active preset id from MILKDROP_PRESETS */
  presetId: string;
  /** Blend mode with existing background */
  blendMode: 'replace' | 'composite';
  /** Whether to consume (warp) the existing scene background */
  consumeScene: boolean;

  // ── Motion variable base values (sliders) ──
  /** Zoom per frame (1.0 = no zoom, >1 = zoom in) */
  zoom: number;
  /** Warp intensity */
  warp: number;
  /** Rotation per frame (radians) */
  rotation: number;
  /** Feedback decay (0–1, lower = faster fade) */
  decay: number;
  /** Overall opacity of the milkdrop layer */
  opacity: number;

  // ── Per-variable audio reactive configs ──
  arZoom?: AudioReactiveConfig;
  arWarp?: AudioReactiveConfig;
  arRotation?: AudioReactiveConfig;
  arDecay?: AudioReactiveConfig;
  arOpacity?: AudioReactiveConfig;
}

export const DEFAULT_MILKDROP_CONFIG: MilkdropConfig = {
  enabled: false,
  presetId: 'viz-tunnel',
  blendMode: 'replace',
  consumeScene: false,

  zoom: 1.02,
  warp: 1.0,
  rotation: 0.02,
  decay: 0.95,
  opacity: 1.0,
};

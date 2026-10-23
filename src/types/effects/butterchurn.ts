/**
 * Butterchurn Visualizer Configuration
 *
 * Used as the third mode in ShaderFxInstanceConfig:
 *   mode: 'shader' | 'feedback' | 'butterchurn'
 */

export type ButterchurnCycleMode = 'off' | 'sequential' | 'random';

export interface ButterchurnConfig {
  /** Whether the butterchurn layer is active */
  enabled: boolean;
  /** Currently loaded preset name (from butterchurn-presets catalog) */
  presetName: string;
  /** Blend mode with existing background */
  blendMode: 'replace' | 'composite';
  /** Global opacity (0–1) */
  opacity: number;
  /** Preset cycling mode */
  cycleMode: ButterchurnCycleMode;
  /** Seconds between preset changes when cycling */
  cycleInterval: number;
  /** Crossfade blend time in seconds when switching presets */
  blendTime: number;
}

export const DEFAULT_BUTTERCHURN_CONFIG: ButterchurnConfig = {
  enabled: false,
  presetName: '',
  blendMode: 'replace',
  opacity: 1.0,
  cycleMode: 'off',
  cycleInterval: 15,
  blendTime: 2.0,
};

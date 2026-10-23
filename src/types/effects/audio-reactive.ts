/**
 * Audio Reactivity Configuration Types
 * Defines how visual parameters respond to audio frequency bands
 */

export interface AudioReactiveConfig {
  /** Enable audio reactivity for this parameter */
  enabled: boolean;
  /** Which frequency band to respond to */
  band: 'bass' | 'mid' | 'high' | 'energy';
  /** How much the audio affects the parameter (0-1) */
  intensity: number;
  /** Minimum value when audio is silent */
  min: number;
  /** Maximum value at full audio intensity */
  max: number;
  /** Attack time in seconds (smoothing for rising values). Default 0.1 */
  attack?: number;
  /** Decay time in seconds (smoothing for falling values). Default 0.1 */
  decay?: number;
  /** Lower threshold - audio below this has minimal response (0-1). Default 0.0 */
  lowerThreshold?: number;
  /** Upper threshold - audio above this reaches peak effect (0-1). Default 1.0 */
  upperThreshold?: number;
  /** Box center - where peak reactivity occurs in the audio range (0-1). Default 0.5 */
  boxCenter?: number;
  /** Box width - size of the inner quartile range where most reactivity happens (0-1). Default 0.3 */
  boxWidth?: number;
  /** Invert the mapping (swap min/max). If true, audio increases will move towards min. */
  invert?: boolean;
}

export const DEFAULT_AUDIO_REACTIVE: AudioReactiveConfig = {
  enabled: false,
  band: 'energy',
  intensity: 0.5,
  min: 0,
  max: 1,
  lowerThreshold: 0.0,
  upperThreshold: 1.0,
  boxCenter: 0.5,
  boxWidth: 0.3,
};

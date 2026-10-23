/**
 * Particle System Configuration Types
 * Defines particle effects like snow, rain, and volumetric particles
 */

import type { AudioReactiveConfig } from './audio-reactive';

export interface ParticlesConfig {
  enabled: boolean;
  count: number;
  speed: number;
  turbulence: number;
  opacity: number;
  color: string;
  range: [number, number, number];
  style?: 'dust'; // Dust floating particles (snow replaced by shader overlay)
  blending?: 'additive' | 'normal'; // New: Allow choosing between additive (light) and normal (solid/dark)

  // Physics & Visuals
  gravity?: number; // Acceleration. <0 = rise, 0 = float, >0 = fall
  windX?: number; // Horizontal drift
  size?: number; // Base particle size

  // Audio reactive settings
  audioReactive: {
    count: AudioReactiveConfig;
    speed: AudioReactiveConfig;
    turbulence: AudioReactiveConfig;
    opacity: AudioReactiveConfig;
    /** Per-field */
    gravity?: AudioReactiveConfig;
    windX?: AudioReactiveConfig;
    size?: AudioReactiveConfig;
  };
}

export interface RainConfig {
  enabled: boolean;
  count: number;
  speed: number;
  windX: number;
  windZ: number;
  opacity: number;
  size: number;

  // Audio reactive settings
  audioReactive: {
    speed: AudioReactiveConfig;
    windX: AudioReactiveConfig;
    opacity: AudioReactiveConfig;
    /** Per-field */
    count?: AudioReactiveConfig;
    windZ?: AudioReactiveConfig;
    size?: AudioReactiveConfig;
  };
}

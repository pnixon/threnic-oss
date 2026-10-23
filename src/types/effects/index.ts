/**
 * Effects Configuration - Main Export
 * Consolidates all effect types and provides the main EffectsConfig interface
 */

// Export all types from submodules
export * from './audio-reactive';
export * from './particles';
export * from './post-processing';
export * from './background';
export * from './track-display';
export * from './defaults';
export * from './visualizer';
export * from './shader-overlay';
export * from './milkdrop';
export * from './butterchurn';

export * from './effect-instances';
export * from './effect-instance-factory';
export * from './layer-order';

import type { LyricTheme } from '@/types/lyrics';
import type { ParticlesConfig, RainConfig } from './particles';
import type { PostProcessingConfig, PostProcessingEffectId } from './post-processing';
import type { EffectInstance } from './effect-instances';
import type { LayerToken } from './layer-order';
import type {
  BackgroundMode,
  VideoConfig,
  PixiConfig,
  GaussianSplatConfig,
  CloudSceneConfig,
  SlideshowConfig,
} from './background';
import type { VisualizerConfig } from './visualizer';

import type { TrackTitleConfig } from './track-display';
import type { ShaderOverlayConfig } from './shader-overlay';
import type { MilkdropConfig } from './milkdrop';
import type { ButterchurnConfig } from './butterchurn';
import {
  DEFAULT_PARTICLES_CONFIG,
  DEFAULT_RAIN_CONFIG,
  DEFAULT_VIDEO_CONFIG,
  DEFAULT_PIXI_CONFIG,
  DEFAULT_GAUSSIAN_SPLAT_CONFIG,
  DEFAULT_TRACK_TITLE_CONFIG,
  DEFAULT_CLOUD_SCENE_CONFIG,
  DEFAULT_VISUALIZER_CONFIG,
  DEFAULT_SLIDESHOW_CONFIG,
  DEFAULT_SHADER_OVERLAY_CONFIG,
} from './defaults';
import { DEFAULT_MILKDROP_CONFIG } from './milkdrop';
import { DEFAULT_BUTTERCHURN_CONFIG } from './butterchurn';

/**
 * Complete Effects Configuration
 * Top-level interface for all visual effects and scene settings
 */
export interface EffectsConfig {
  particles: ParticlesConfig;
  rain: RainConfig;
  postProcessing: PostProcessingConfig;
  /** Order of post-processing effects (first = bottom layer, last = top layer) */
  effectOrder: PostProcessingEffectId[];
  /**
   * Instanced effects — replaces the old flat postProcessing map.
   * Each element is an independent effect with a unique id, type, and config.
   * Effects render in array order (index 0 = bottom).
   */
  effectInstances: EffectInstance[];

  /**
   * User-controllable compositing order for the whole layer stack (background,
   * lyrics, and each effect instance). Front-to-back list of layer tokens.
   * OPTIONAL: when absent, the renderer uses the legacy fixed order
   * (background → effects → lyrics), so existing projects are unaffected until
   * the user reorders a layer. See {@link LayerToken} / resolveLayerOrder().
   */
  layerOrder?: LayerToken[];

  /**
   * @deprecated No longer used by the UI. Kept for backward compat with old project files.
   * The unified model is: background color + optional image/slideshow overlay.
   */
  backgroundMode?: BackgroundMode;
  /** How the background image should fit the screen */
  backgroundFit: 'cover' | 'contain' | 'fitWidth' | 'fitHeight' | 'stretch' | 'original' | 'manual';
  /** @deprecated Use a tiling effect instance instead. Kept for backward compat with old project files. */
  backgroundTiling: boolean;
  backgroundScale: number;
  backgroundOffsetX: number;
  backgroundOffsetY: number;
  /** @deprecated Use a tiling effect instance's offsetX instead. */
  backgroundTileOffsetX: number;
  /** @deprecated Use a tiling effect instance's offsetY instead. */
  backgroundTileOffsetY: number;
  /** Background brightness (0.0 = black, 1.0 = normal, 2.0 = double bright) */
  backgroundBrightness: number;
  /** Background image/media opacity (0.0 = fully transparent showing color only, 1.0 = fully opaque) */
  backgroundOpacity: number;
  /** Background contrast adjustment (1.0 = normal) */
  backgroundContrast: number;
  /** Background blur strength (0 = no blur) */
  backgroundBlur: number;
  /** Backdrop color (shown behind images/videos or as main scene) */
  backgroundColor: string;
  /** Video background configuration */
  video: VideoConfig;
  /** PixiJS Shader configuration */
  pixi: PixiConfig;
  /** Gaussian splat configuration */
  gaussianSplat: GaussianSplatConfig;
  /** Track title display configuration */
  trackTitle: TrackTitleConfig;
  /** Cloud scene configuration */
  cloudScene: CloudSceneConfig;
  /** Optional lyric theme overrides */
  lyricTheme?: Partial<LyricTheme>;
  /** Visualizer configuration */
  visualizer: VisualizerConfig;
  /** Slideshow / carousel background configuration */
  slideshow: SlideshowConfig;
  /** WGSL shader overlay background configuration */
  shaderOverlay: ShaderOverlayConfig;
  /** Milkdrop feedback-chain visualizer configuration */
  milkdrop: MilkdropConfig;
  /** Butterchurn (WebGL Milkdrop) visualizer configuration */
  butterchurn: ButterchurnConfig;
}

export const DEFAULT_EFFECTS_CONFIG: EffectsConfig = {
  particles: DEFAULT_PARTICLES_CONFIG,
  rain: DEFAULT_RAIN_CONFIG,

  postProcessing: {} as EffectsConfig['postProcessing'],
  effectOrder: [],
  effectInstances: [],
  backgroundMode: 'standard', // deprecated, kept for compat
  backgroundFit: 'cover',
  backgroundTiling: false,
  backgroundScale: 1.0,
  backgroundOffsetX: 0,
  backgroundOffsetY: 0,
  backgroundTileOffsetX: 0,
  backgroundTileOffsetY: 0,
  backgroundBrightness: 1.0,
  backgroundOpacity: 1.0,
  backgroundContrast: 1.0,
  backgroundBlur: 0.0,
  backgroundColor: '#000000',
  video: DEFAULT_VIDEO_CONFIG,
  pixi: DEFAULT_PIXI_CONFIG,
  gaussianSplat: DEFAULT_GAUSSIAN_SPLAT_CONFIG,
  trackTitle: DEFAULT_TRACK_TITLE_CONFIG,
  cloudScene: DEFAULT_CLOUD_SCENE_CONFIG,
  visualizer: DEFAULT_VISUALIZER_CONFIG,
  slideshow: DEFAULT_SLIDESHOW_CONFIG,
  shaderOverlay: DEFAULT_SHADER_OVERLAY_CONFIG,
  milkdrop: DEFAULT_MILKDROP_CONFIG,
  butterchurn: DEFAULT_BUTTERCHURN_CONFIG,
};

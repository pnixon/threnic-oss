import type { EffectInstance, PostProcessingEffectType } from '@/types/effects/effect-instances';

import {
  TSLBloomEffect,
  TSLChromaticAberrationEffect,
  TSLGlitchEffect,
  TSLVHSTrackingEffect,
  TSLOldFilmEffect,
  TSLBulbFlickerEffect,
  TSLGateJitterEffect,
  TSLSepiaEffect,
  TSLDistortionEffect,
  TSLPixelationEffect,
  TSLNoiseOverlayEffect,
  TSLBrightnessEffect,
  TSLContrastEffect,
  TSLSaturationEffect,
  TSLHueShiftEffect,
  TSLChainLightningEffect,
  TSLLutEffect,
  TSLMotionBlurEffect,
  TSLLensFlareEffect,
  TSLCameraShakeEffect,
} from '@/components/effects/shared/TSLEffects';

/**
 * Type for a post-processing effect component.
 * Uses never for config so components with any config shape can be mapped in the registry.
 */
type PostProcessingEffectComponent = React.ComponentType<{
  enabled: boolean;
  config: never;
}>;

/**
 * A registry component as handed to renderers, which pass the instance's own config.
 */
type RenderablePostProcessingEffect = React.ComponentType<{
  enabled: boolean;
  config: EffectInstance['config'];
}>;

/**
 * Metadata for a post-processing effect.
 */
interface PostProcessingEffectMetadata {
  /** The React component for this effect */
  component: PostProcessingEffectComponent;
  /** Human-readable display name */
  displayName: string;
  /** Short description of the effect */
  description?: string;
  /** Category for grouping in UI */
  category?: 'creative' | 'cinematic' | 'retro' | 'color' | 'technical' | 'distortion';
}

/**
 * Centralized registry of post-processing effects.
 *
 * All effects use TSL (Three Shading Language) implementations for WebGPU compatibility.
 *
 * Background transform effects (zoom, slide, rotate) are NOT included here —
 * they are handled by `useBackgroundTransform` at the texture level.
 */
const POST_PROCESSING_EFFECT_REGISTRY: Partial<
  Record<PostProcessingEffectType, PostProcessingEffectMetadata>
> = {
  bloom: {
    component: TSLBloomEffect,
    displayName: 'Bloom',
    description: 'Glowing highlights',
    category: 'creative',
  },
  chromaticAberration: {
    component: TSLChromaticAberrationEffect,
    displayName: 'Chromatic Aberration',
    description: 'RGB color separation',
    category: 'cinematic',
  },
  glitch: {
    component: TSLGlitchEffect,
    displayName: 'Glitch',
    description: 'Digital distortion artifacts',
    category: 'technical',
  },
  vhsTracking: {
    component: TSLVHSTrackingEffect,
    displayName: 'VHS Tracking',
    description: 'VHS tape tracking errors',
    category: 'retro',
  },
  oldFilm: {
    component: TSLOldFilmEffect,
    displayName: 'Old Film',
    description: 'Vintage film grain and artifacts',
    category: 'retro',
  },
  bulbFlicker: {
    component: TSLBulbFlickerEffect,
    displayName: 'Bulb Flicker',
    description: 'Flickering light effect',
    category: 'cinematic',
  },
  gateJitter: {
    component: TSLGateJitterEffect,
    displayName: 'Gate Jitter',
    description: 'Film projector gate shake',
    category: 'retro',
  },
  sepia: {
    component: TSLSepiaEffect,
    displayName: 'Sepia',
    description: 'Sepia tone color grading',
    category: 'color',
  },
  distortion: {
    component: TSLDistortionEffect,
    displayName: 'Distortion',
    description: 'Lens distortion',
    category: 'distortion',
  },
  pixelation: {
    component: TSLPixelationEffect,
    displayName: 'Pixelation',
    description: 'Pixelated mosaic effect',
    category: 'technical',
  },
  noiseOverlay: {
    component: TSLNoiseOverlayEffect,
    displayName: 'Noise Overlay',
    description: 'Static noise overlay',
    category: 'technical',
  },
  brightness: {
    component: TSLBrightnessEffect,
    displayName: 'Brightness',
    description: 'Adjust brightness',
    category: 'color',
  },
  contrast: {
    component: TSLContrastEffect,
    displayName: 'Contrast',
    description: 'Adjust contrast',
    category: 'color',
  },
  saturation: {
    component: TSLSaturationEffect,
    displayName: 'Saturation',
    description: 'Adjust color saturation',
    category: 'color',
  },
  hueShift: {
    component: TSLHueShiftEffect,
    displayName: 'Hue Shift',
    description: 'Shift color hue',
    category: 'color',
  },
  chainLightning: {
    component: TSLChainLightningEffect,
    displayName: 'Chain Lightning',
    description: 'Electric lightning arcs',
    category: 'creative',
  },
  lut: {
    component: TSLLutEffect,
    displayName: 'LUT Color Grading',
    description: 'Professional color grading presets',
    category: 'color',
  },
  motionBlur: {
    component: TSLMotionBlurEffect,
    displayName: 'Motion Blur / Echo',
    description: 'Frame trailing and ghosting',
    category: 'cinematic',
  },
  lensFlare: {
    component: TSLLensFlareEffect,
    displayName: 'Lens Flare',
    description: 'Anamorphic streaks and light leaks',
    category: 'cinematic',
  },
  cameraShake: {
    component: TSLCameraShakeEffect,
    displayName: 'Camera Shake',
    description: 'Beat-synced shake and vibration',
    category: 'cinematic',
  },
};

/**
 * Get the component for a specific effect type.
 */
export function getEffectComponent(
  type: PostProcessingEffectType,
): RenderablePostProcessingEffect | undefined {
  return POST_PROCESSING_EFFECT_REGISTRY[type]?.component as
    | RenderablePostProcessingEffect
    | undefined;
}

/**
 * Check if an effect type exists in the registry.
 */
export function isRegisteredEffect(type: string): type is PostProcessingEffectType {
  return (
    type in POST_PROCESSING_EFFECT_REGISTRY &&
    POST_PROCESSING_EFFECT_REGISTRY[type as PostProcessingEffectType] !== undefined
  );
}

import type { SceneEffectType, PostProcessingEffectType } from '@/types/effects/effect-instances';

/**
 * Registry of all available Scene (3-D) effects.
 * These are rendered outside of the EffectComposer.
 */
const SCENE_EFFECTS: SceneEffectType[] = ['particles', 'rain', 'visualizer', 'starfield'];

/**
 * Background transform effect types.
 * These are NOT rendered as post-processing passes — they operate directly
 * on the background texture via the unified `useBackgroundTransform` hook.
 */
const BACKGROUND_TRANSFORM_EFFECTS: PostProcessingEffectType[] = ['zoom', 'slide', 'rotate'];

/**
 * Registry of all available Post-Processing (2-D) effects.
 * These are rendered inside the EffectComposer.
 * NOTE: zoom, slide, and rotate are excluded — they are background transforms.
 */
const POST_PROCESSING_EFFECTS: PostProcessingEffectType[] = [
  'bloom',
  'chromaticAberration',
  'glitch',
  'vhsTracking',
  'oldFilm',
  'bulbFlicker',
  'gateJitter',
  'sepia',
  'distortion',
  'pixelation',
  'noiseOverlay',
  'brightness',
  'contrast',
  'saturation',
  'hueShift',
  'chainLightning',
  'lut',
  'motionBlur',
  'lensFlare',
  'cameraShake',
];

export function isSceneEffect(type: string): type is SceneEffectType {
  return SCENE_EFFECTS.includes(type as SceneEffectType);
}

export function isPostProcessingEffect(type: string): type is PostProcessingEffectType {
  return POST_PROCESSING_EFFECTS.includes(type as PostProcessingEffectType);
}

export function isBackgroundTransformEffect(type: string): type is PostProcessingEffectType {
  return BACKGROUND_TRANSFORM_EFFECTS.includes(type as PostProcessingEffectType);
}

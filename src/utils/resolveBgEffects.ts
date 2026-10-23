/**
 * Resolve Background Effect Values from effectInstances
 *
 * bgOpacity and bgBlur can be defined either as legacy flat config properties
 * (EffectsConfig.backgroundOpacity / backgroundBlur) or as instanced effects
 * (type: 'bgOpacity' / 'bgBlur') with full audio reactivity support.
 *
 * When an instance is present AND enabled, it overrides the legacy value.
 * Audio reactive modulation is applied inline here (not via the GPU pass system).
 */

import type { EffectsConfig } from '@/types/effects';
import type { AudioReactiveConfig } from '@/types/effects/audio-reactive';

interface AudioBandValues {
  bass: number;
  mid: number;
  high: number;
  energy: number;
}

/**
 * Apply box plot curve to audio input (mirrors applyBoxPlotCurve in useAudioReactive.ts).
 */
function applyBoxPlotCurve(
  rawAudio: number,
  lowerThreshold: number,
  upperThreshold: number,
  boxCenter: number,
  boxWidth: number,
): number {
  const boxMin = Math.max(lowerThreshold, boxCenter - boxWidth / 2);
  const boxMax = Math.min(upperThreshold, boxCenter + boxWidth / 2);
  if (rawAudio <= lowerThreshold) return 0;
  if (rawAudio >= upperThreshold) return 1;
  const normalized = (rawAudio - lowerThreshold) / (upperThreshold - lowerThreshold);
  const boxMinNorm = (boxMin - lowerThreshold) / (upperThreshold - lowerThreshold);
  const boxMaxNorm = (boxMax - lowerThreshold) / (upperThreshold - lowerThreshold);
  if (normalized < boxMinNorm) {
    const t = normalized / boxMinNorm;
    return 0.1 * Math.log10(1 + 9 * t);
  } else if (normalized <= boxMaxNorm) {
    const t = (normalized - boxMinNorm) / (boxMaxNorm - boxMinNorm);
    return 0.1 + 0.8 * t;
  } else {
    const t = (normalized - boxMaxNorm) / (1 - boxMaxNorm);
    return 0.9 + 0.1 * Math.log10(1 + 9 * t);
  }
}

/**
 * Apply audio reactive modulation to a base value.
 * Uses the full box-plot + threshold logic matching AudioReactiveEditor and processEnvelope.
 * Returns `min` (not base) at silence — so "0 baseline" truly means no effect.
 */
function applyAR(
  base: number,
  ar: AudioReactiveConfig | undefined,
  audio: AudioBandValues,
): number {
  if (!ar?.enabled) return base;
  const bandValue = audio[ar.band] ?? 0;
  const lowerThreshold = ar.lowerThreshold ?? 0.0;
  const upperThreshold = ar.upperThreshold ?? 1.0;
  const boxCenter = ar.boxCenter ?? 0.5;
  const boxWidth = ar.boxWidth ?? 0.3;
  const intensity = ar.intensity ?? 1.0;
  const safeMin = Number.isFinite(ar.min) ? ar.min : 0;
  const safeMax = Number.isFinite(ar.max) ? ar.max : 1;
  const actualMin = Math.min(safeMin, safeMax);
  const actualMax = Math.max(safeMin, safeMax);

  // Below lower threshold → return min (same as processEnvelope)
  if (!ar.invert && bandValue <= lowerThreshold) return actualMin;
  if (ar.invert && bandValue >= upperThreshold) return actualMin;

  const curveResponse = applyBoxPlotCurve(
    bandValue,
    lowerThreshold,
    upperThreshold,
    boxCenter,
    boxWidth,
  );
  let start = safeMin;
  let end = safeMax;
  if (ar.invert) {
    start = safeMax;
    end = safeMin;
  }
  const range = end - start;
  const result = start + curveResponse * range * intensity;
  return Math.max(actualMin, Math.min(actualMax, result));
}

/**
 * Resolve the effective background image opacity.
 * Checks effectInstances for a 'bgOpacity' instance first, then falls back to
 * EffectsConfig.backgroundOpacity or the provided legacy scene value.
 */
export function resolveBackgroundOpacity(
  effectsConfig: EffectsConfig | undefined | null,
  audio: AudioBandValues,
  legacySceneValue?: number,
): number {
  const instances = effectsConfig?.effectInstances ?? [];

  // Find the last enabled bgOpacity instance (last wins, matching layer order)
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    if (inst.type === 'bgOpacity' && inst.config.enabled) {
      const c = inst.config as { opacity: number; audioReactive: AudioReactiveConfig };
      const base = c.opacity ?? 1.0;
      // AR modulates on top of the base opacity; when AR is disabled or audio is silent,
      // we always return the base (not 0) so the image is visible at the configured value.
      const arEnabled = c.audioReactive?.enabled;
      const resolved = arEnabled ? applyAR(base, c.audioReactive, audio) : base;
      return Math.max(0, Math.min(1, resolved));
    }
  }

  // Fall back to scene-level slider value (effectsConfig.backgroundOpacity),
  // then legacy scene keyframe value, then default 1.0 (fully opaque).
  // Note: we DO allow 0 here — the user may have explicitly set it to 0 via the slider.
  const sceneSlider = legacySceneValue ?? effectsConfig?.backgroundOpacity;
  return typeof sceneSlider === 'number' ? Math.max(0, Math.min(1, sceneSlider)) : 1.0;
}

/**
 * Resolve the effective background blur amount.
 * Checks effectInstances for a 'bgBlur' instance first, then falls back to
 * EffectsConfig.backgroundBlur or the provided legacy scene value.
 *
 * Also returns the blurType for downstream consumers.
 */
export function resolveBackgroundBlur(
  effectsConfig: EffectsConfig | undefined | null,
  audio: AudioBandValues,
  legacySceneValue?: number,
): { amount: number; blurType: string } {
  const instances = effectsConfig?.effectInstances ?? [];

  // Find the last enabled bgBlur instance
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    if (inst.type === 'bgBlur' && inst.config.enabled) {
      const c = inst.config as {
        amount: number;
        blurType: string;
        audioReactive: AudioReactiveConfig;
      };
      return {
        amount: Math.max(0, applyAR(c.amount, c.audioReactive, audio)),
        blurType: c.blurType ?? 'gaussian',
      };
    }
  }

  // Fall back to legacy sources
  const amount = legacySceneValue ?? effectsConfig?.backgroundBlur ?? 0.0;
  return { amount, blurType: 'gaussian' };
}

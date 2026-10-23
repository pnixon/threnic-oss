/**
 * Shared Audio-Reactive Envelope Core
 *
 * Platform-agnostic (no React, no Three.js, no audioStore).
 * Consumed by:
 *   - GPU path:   EffectPasses.ts → createARUpdater()
 *   - React path: useARParams.ts  → useARParams() hook
 *
 * Single source of truth for box-plot curve + attack/decay smoothing.
 */

import type { AudioReactiveConfig } from '@/types/effects/audio-reactive';

// ─── Box-Plot Curve ─────────────────────────────────────────────────────────

/**
 * Maps a raw [0,1] audio level to a sensitivity-adjusted [0,1] response using
 * the box-plot curve defined in AudioReactiveConfig.
 *
 * Regions:
 *   [lowerThreshold, boxMin)  → logarithmic (low sensitivity)
 *   [boxMin, boxMax]          → linear      (peak sensitivity)
 *   (boxMax, upperThreshold]  → logarithmic (low sensitivity)
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
    const t = normalized / Math.max(boxMinNorm, 0.0001);
    return 0.1 * Math.log10(1 + 9 * t);
  } else if (normalized <= boxMaxNorm) {
    const t = (normalized - boxMinNorm) / Math.max(boxMaxNorm - boxMinNorm, 0.0001);
    return 0.1 + 0.8 * t;
  } else {
    const t = (normalized - boxMaxNorm) / Math.max(1 - boxMaxNorm, 0.0001);
    return 0.9 + 0.1 * Math.log10(1 + 9 * t);
  }
}

// ─── Raw Audio Bands ─────────────────────────────────────────────────────────

/**
 * Minimal audio band snapshot consumed by ARParamEnvelope.
 * The GPU path fills this from EffectPassParams; the React path from audioStore.
 */
export interface AudioBands {
  energy: number;
  bass: number;
  mid: number;
  high: number;
}

// ─── ARParamEnvelope ─────────────────────────────────────────────────────────

/**
 * Stateful envelope for one audio-reactive parameter.
 *
 * Create once per parameter (in a closure or useRef).
 * Call compute() every frame with the current base value, config, dt, and bands.
 *
 * Implements:
 *   - Hard-floor gate at lowerThreshold (returns baseMin at silence)
 *   - Box-plot curve response
 *   - Exponential attack/decay smoothing (matches processEnvelope in useAudioReactive.ts)
 *   - First-frame snap (no stale smoothed state on mount)
 */
export interface ARParamEnvelope {
  compute(
    baseValue: number,
    config: AudioReactiveConfig | undefined,
    dt: number,
    bands: AudioBands,
  ): number;
  reset(): void;
}

export function createARParam(): ARParamEnvelope {
  let smoothedValue = NaN; // NaN = uninitialized → snap on first frame

  return {
    reset() {
      smoothedValue = NaN;
    },

    compute(
      baseValue: number,
      config: AudioReactiveConfig | undefined,
      dt: number,
      bands: AudioBands,
    ): number {
      if (!config || !config.enabled) return baseValue;

      // --- Read audio band ---
      const raw = bands[config.band] ?? bands.energy;

      // --- Range resolution ---
      const lower = config.lowerThreshold ?? 0.0;
      const upper = config.upperThreshold ?? 1.0;
      const boxCenter = config.boxCenter ?? 0.5;
      const boxWidth = config.boxWidth ?? 0.3;
      const intensityScale = config.intensity ?? 1.0;
      const safeMin = Number.isFinite(config.min) ? config.min : baseValue;
      const safeMax = Number.isFinite(config.max) ? config.max : baseValue;
      const actualMin = Math.min(safeMin, safeMax);
      const actualMax = Math.max(safeMin, safeMax);

      // --- Instantaneous target (with hard threshold floor) ---
      let target: number;
      if (!config.invert && raw <= lower) {
        target = actualMin;
      } else if (config.invert && raw >= upper) {
        target = actualMin;
      } else {
        const curve = applyBoxPlotCurve(raw, lower, upper, boxCenter, boxWidth);
        let start = safeMin;
        let end = safeMax;
        if (config.invert) {
          start = safeMax;
          end = safeMin;
        }
        target = Math.max(
          actualMin,
          Math.min(actualMax, start + curve * (end - start) * intensityScale),
        );
      }

      // --- First frame: snap, no stale history ---
      if (!Number.isFinite(smoothedValue)) {
        smoothedValue = target;
        return smoothedValue;
      }

      // --- Attack / decay exponential smoothing ---
      const attack = config.attack ?? 0.02; // 20ms default
      const decay = config.decay ?? 0.05; // 50ms default
      const smoothingTime = target > smoothedValue ? attack : decay;
      const factor = 1 - Math.exp(-dt / Math.max(0.001, smoothingTime));
      smoothedValue += (target - smoothedValue) * factor;

      // --- Final clamp + NaN guard ---
      smoothedValue = Number.isFinite(smoothedValue)
        ? Math.max(actualMin, Math.min(actualMax, smoothedValue))
        : actualMin;

      return smoothedValue;
    },
  };
}

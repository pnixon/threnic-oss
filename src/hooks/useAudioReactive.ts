import { useRef } from 'react';
import type { AudioReactiveConfig } from '@/types/effects';
import { timeStore } from '@/engine/stores/timeStore';
import { audioStore } from '@/engine/stores/audioStore';

/**
 * State container for audio reactive envelope following.
 */
interface EnvelopeState {
  smoothedModulation: number;
  lastTime: number;
}

/**
 * Apply box plot curve to audio input.
 * Peak reactivity occurs in the box (inner quartile), with logarithmic compression outside.
 */
function applyBoxPlotCurve(
  rawAudio: number,
  lowerThreshold: number,
  upperThreshold: number,
  boxCenter: number,
  boxWidth: number,
): number {
  // Calculate box boundaries
  const boxMin = Math.max(lowerThreshold, boxCenter - boxWidth / 2);
  const boxMax = Math.min(upperThreshold, boxCenter + boxWidth / 2);

  // Below lower threshold: no response
  if (rawAudio <= lowerThreshold) {
    return 0;
  }

  // Above upper threshold: full response
  if (rawAudio >= upperThreshold) {
    return 1;
  }

  // Normalize to 0-1 range within thresholds
  const normalized = (rawAudio - lowerThreshold) / (upperThreshold - lowerThreshold);

  // Calculate position within the threshold range
  const boxMinNorm = (boxMin - lowerThreshold) / (upperThreshold - lowerThreshold);
  const boxMaxNorm = (boxMax - lowerThreshold) / (upperThreshold - lowerThreshold);

  let effectiveAudio = 0;

  if (normalized < boxMinNorm) {
    // Lower region (lowerThreshold to boxMin): logarithmic curve (10x less sensitive)
    const regionWidth = boxMinNorm;
    const t = normalized / regionWidth; // 0-1 within this region
    // Logarithmic curve: much less sensitive, reaches ~0.1 at box start
    effectiveAudio = 0.1 * Math.log10(1 + 9 * t); // Maps 0-1 to 0-0.1 with log curve
  } else if (normalized <= boxMaxNorm) {
    // Box region (boxMin to boxMax): linear, peak sensitivity
    const regionWidth = boxMaxNorm - boxMinNorm;
    const t = (normalized - boxMinNorm) / regionWidth; // 0-1 within box
    // Linear through the box: from 0.1 to 0.9 (peak reactivity zone)
    effectiveAudio = 0.1 + 0.8 * t;
  } else {
    // Upper region (boxMax to upperThreshold): logarithmic curve (10x less sensitive)
    const regionWidth = 1 - boxMaxNorm;
    const t = (normalized - boxMaxNorm) / regionWidth; // 0-1 within this region
    // Logarithmic curve: much less sensitive, reaches 1.0 at upper threshold
    effectiveAudio = 0.9 + 0.1 * Math.log10(1 + 9 * t); // Maps 0-1 to 0.9-1.0 with log curve
  }

  return effectiveAudio;
}

/**
 * Shared logic for audio reactive envelope processing.
 * Applies box plot curve, attack/decay smoothing, and range mapping.
 */
function processEnvelope(
  state: { smoothedModulation: number },
  config: AudioReactiveConfig,
  delta: number,
): void {
  // Get audio level from the selected band
  const audioState = audioStore.getState();
  const rawAudio = audioState[config.band];

  const lowerThreshold = config.lowerThreshold ?? 0.0;
  const upperThreshold = config.upperThreshold ?? 1.0;
  const boxCenter = config.boxCenter ?? 0.5;
  const boxWidth = config.boxWidth ?? 0.3;

  // Safety: Ensure min/max are defined numbers
  const safeMin = Number.isFinite(config.min) ? config.min : 0;
  const safeMax = Number.isFinite(config.max) ? config.max : 1;
  const actualMin = Math.min(safeMin, safeMax);
  const actualMax = Math.max(safeMin, safeMax);

  let targetModulation = actualMin;

  // Check for "no-effect" or "max-effect" conditions based on thresholds
  if (!config.invert && rawAudio <= lowerThreshold) {
    // Normal mode: below lower threshold = min value
    targetModulation = actualMin;
  } else if (config.invert && rawAudio >= upperThreshold) {
    // Inverted mode: above upper threshold = min value
    targetModulation = actualMin;
  } else {
    // Apply box plot curve in the active range
    const effectiveAudio = applyBoxPlotCurve(
      rawAudio,
      lowerThreshold,
      upperThreshold,
      boxCenter,
      boxWidth,
    );

    // Calculate target modulation
    let start = safeMin;
    let end = safeMax;

    if (config.invert) {
      start = safeMax;
      end = safeMin;
    }

    const range = end - start;
    targetModulation = start + effectiveAudio * range * config.intensity;

    // Clamp to ensure we never exceed the user-defined min/max bounds
    targetModulation = Math.max(actualMin, Math.min(actualMax, targetModulation));
  }

  // Attack/Decay smoothing
  // Professional audio defaults: fast attack to catch transients, moderate decay for snappy response
  const attack = config.attack ?? 0.02; // 20ms - fast enough to catch kick drums and transients
  const decay = config.decay ?? 0.05; // 50ms - snappy decay for punchy feel

  // Determine if we are rising (attack) or falling (decay)
  const isRising = targetModulation > state.smoothedModulation;
  const smoothingTime = isRising ? attack : decay;

  // Convert time constant to lerp factor using exponential smoothing
  const safeTime = Math.max(0.001, smoothingTime);
  const factor = 1 - Math.exp(-delta / safeTime);

  // Apply smoothing to the modulation value
  state.smoothedModulation += (targetModulation - state.smoothedModulation) * factor;

  // Final Safety Clamp
  if (Number.isFinite(state.smoothedModulation)) {
    state.smoothedModulation = Math.max(actualMin, Math.min(actualMax, state.smoothedModulation));
  } else {
    state.smoothedModulation = actualMin; // Fallback reset if NaN
  }
}

/**
 * Hook to get a smoothed audio-reactive value based on Attack/Decay/Threshold configuration.
 *
 * IMPORTANT: Unlike the previous version, this hook does NOT use useFrame internally.
 * Instead, call the returned `update(delta)` function from within your component's useFrame.
 * This ensures correct ordering and works in both preview and export modes.
 *
 * @param baseValue The base value of the parameter when audio is silent
 * @param config The audio reactive configuration
 * @returns An object with `current` (the current value) and `update(delta)` function
 */
export function useAudioReactiveEnvelope(baseValue: number, config?: AudioReactiveConfig) {
  const stateRef = useRef<EnvelopeState>({
    smoothedModulation: 0,
    lastTime: -1,
  });

  return {
    get current(): number {
      return baseValue + stateRef.current.smoothedModulation;
    },

    update(delta: number): void {
      const state = stateRef.current;

      // Auto-reset when seeking to start or beginning an export
      if (timeStore.getState().currentTime === 0) {
        state.smoothedModulation = 0;
      }

      if (!config || !config.enabled) {
        // Decay towards the minimum value instead of 0 to respect user's range
        const targetMin = config ? Math.min(config.min, config.max) : 0;
        state.smoothedModulation += (targetMin - state.smoothedModulation) * 0.1;
        return;
      }

      processEnvelope(state, config, delta);
    },
  };
}

/**
 * Simpler version that returns a ref updated by a provided delta.
 * Convenience wrapper for effects that prefer the ref pattern.
 */
export function createAudioReactiveEnvelope(
  baseValue: number,
  initialConfig?: AudioReactiveConfig,
): {
  current: number;
  update: (delta: number, config?: AudioReactiveConfig) => void;
  reset: (value?: number) => void;
} {
  const state = { smoothedModulation: 0 };

  return {
    get current(): number {
      return baseValue + state.smoothedModulation;
    },

    reset(value: number = 0): void {
      state.smoothedModulation = value;
    },

    update(delta: number, config?: AudioReactiveConfig): void {
      const activeConfig = config ?? initialConfig;
      if (!activeConfig || !activeConfig.enabled) {
        // Decay towards the minimum value instead of 0 to respect user's range
        const targetMin = activeConfig ? Math.min(activeConfig.min, activeConfig.max) : 0;
        state.smoothedModulation += (targetMin - state.smoothedModulation) * 0.1;
        return;
      }

      processEnvelope(state, activeConfig, delta);
    },
  };
}

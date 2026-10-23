import { useState, useMemo } from 'react';
import * as THREE from 'three';

interface LiveRandomIntervalState {
  nextTriggerTime: number;
  activeEndTime: number;
  activeStartTime: number;
  activeDuration: number;
  isActive: boolean;
  lastInterval?: number;
  lastDuration?: number;
}

export const randomIntervalRegistry: Record<string, LiveRandomIntervalState> = {};

interface RandomIntervalParams {
  /** Minimum interval between triggers (seconds) */
  minInterval: number;
  /** Maximum interval between triggers (seconds) */
  maxInterval: number;
  /** How long the effect stays active (seconds) */
  activeDuration: number;
  /** Target value when active */
  targetValue: number;
  /** Base value when inactive (default: 0) */
  baseValue?: number;
  /** Lerp speed multiplier (default: 0.1) */
  lerpSpeed?: number;
  /** Use seeded random for deterministic intervals (default: false) */
  useSeededRandom?: boolean;

  // New properties for dynamic active duration and linear AD envelopes
  /** Minimum active duration (seconds) */
  minDuration?: number;
  /** Maximum active duration (seconds) */
  maxDuration?: number;
  /** Attack / fade-in time (seconds) */
  attack?: number;
  /** Decay / fade-out time (seconds) */
  decay?: number;
  /** Optional key identifier to expose live timing state for UI sliders */
  effectId?: string;
  /**
   * Optional physics-driven duration override. When provided, it is called once
   * on each activation edge and its return value (seconds) is used as the active
   * duration instead of the min/max window. Use for effects that should stay
   * active until an animation completes (e.g. a VHS tracking band that must
   * scroll fully off screen) rather than for a fixed time. Return a finite,
   * positive number; anything non-finite/≤0 falls back to the min/max window.
   */
  computeDuration?: () => number;
}

interface RandomIntervalUpdateParams {
  /** Current playback time in seconds */
  time: number;
  /** Delta time in seconds */
  dt: number;
  /** Whether playback was reset (seek to zero) */
  didReset: boolean;
}

/**
 * Random interval state manager class.
 *
 * Manages random interval triggering with smooth transitions or precise envelopes.
 */
export class RandomIntervalState {
  private nextRandomTrigger = 0;
  private randomActive = false;
  private activeEndTime = 0;
  private currentActiveDuration = 0;
  private currentValue: number;
  public lastIntervalValue?: number;
  public lastDurationValue?: number;

  constructor(public params: RandomIntervalParams) {
    this.currentValue = params.baseValue ?? 0;
    this.currentActiveDuration = params.activeDuration;
  }

  /**
   * Update the random interval state and return the current value.
   */
  update(updateParams: RandomIntervalUpdateParams): number {
    const { time, dt, didReset } = updateParams;
    const {
      minInterval,
      maxInterval,
      activeDuration,
      targetValue,
      baseValue = 0,
      lerpSpeed = 0.1,
      useSeededRandom,
      minDuration,
      maxDuration,
      attack,
      decay,
      computeDuration,
    } = this.params;

    // Reset on seek-to-zero
    if (didReset) {
      this.nextRandomTrigger = 0;
      this.randomActive = false;
      this.activeEndTime = 0;
      this.currentActiveDuration = activeDuration;
      this.currentValue = baseValue;
      this.lastIntervalValue = undefined;
      this.lastDurationValue = undefined;
    }

    const now = time;

    // Check if we should trigger
    if (now >= this.nextRandomTrigger) {
      // Activate
      this.randomActive = true;

      // Choose a random duration between minDuration and maxDuration
      const dMin = minDuration !== undefined ? minDuration : activeDuration;
      const dMax = maxDuration !== undefined ? maxDuration : activeDuration;

      let randomValDuration: number;
      if (useSeededRandom) {
        const seed = Math.floor(now * 2000) || 1;
        const x = Math.sin(seed) * 10000;
        randomValDuration = x - Math.floor(x);
      } else {
        randomValDuration = Math.random();
      }
      this.currentActiveDuration = randomValDuration * (dMax - dMin) + dMin;

      // Physics-driven duration override: keep the effect active until the
      // driven animation completes (e.g. VHS tracking band scrolling off
      // screen) instead of for a fixed random window. Falls back to the
      // random window if the callback yields a non-finite/≤0 value.
      if (computeDuration) {
        const driven = computeDuration();
        if (Number.isFinite(driven) && driven > 0) {
          this.currentActiveDuration = driven;
        }
      }

      this.activeEndTime = now + this.currentActiveDuration;

      // Calculate next trigger time
      let randomValue: number;
      if (useSeededRandom) {
        // Deterministic random based on current time
        const seed = Math.floor(now * 1000) || 1;
        // Simple seeded random (LCG algorithm)
        const x = Math.sin(seed) * 10000;
        randomValue = x - Math.floor(x);
      } else {
        randomValue = Math.random();
      }

      const delay = randomValue * (maxInterval - minInterval) + minInterval;
      this.lastIntervalValue = delay;
      this.lastDurationValue = this.currentActiveDuration;
      this.nextRandomTrigger = now + this.currentActiveDuration + delay;
    }

    // Check if we should deactivate
    if (this.randomActive && now >= this.activeEndTime) {
      this.randomActive = false;
    }

    // Determine target/value based on active state and envelope
    let target = baseValue;
    const att = attack ?? 0;
    const dec = decay ?? 0;
    const hasEnvelope = att > 0 || dec > 0;

    if (this.randomActive) {
      if (hasEnvelope) {
        const timeSinceTrigger = now - (this.activeEndTime - this.currentActiveDuration);
        let factor = 1.0;
        if (timeSinceTrigger < att) {
          factor = att > 0 ? timeSinceTrigger / att : 1.0;
        } else if (timeSinceTrigger > this.currentActiveDuration - dec) {
          const timeRemaining = this.currentActiveDuration - timeSinceTrigger;
          factor = dec > 0 ? timeRemaining / dec : 1.0;
        }
        factor = Math.max(0, Math.min(1, factor));
        target = baseValue + (targetValue - baseValue) * factor;
      } else {
        target = targetValue;
      }
    } else {
      target = baseValue;
    }

    if (hasEnvelope) {
      // Direct envelope assignment (no additional lerp)
      this.currentValue = target;
    } else {
      // Smooth transition with lerp (backward compatibility)
      this.currentValue = THREE.MathUtils.lerp(
        this.currentValue,
        target,
        lerpSpeed * (dt * 60), // Frame-rate independent
      );
    }

    if (this.params.effectId) {
      randomIntervalRegistry[this.params.effectId] = {
        nextTriggerTime: this.nextRandomTrigger,
        activeEndTime: this.activeEndTime,
        activeStartTime: this.activeEndTime - this.currentActiveDuration,
        activeDuration: this.currentActiveDuration,
        isActive: this.randomActive,
        lastInterval: this.lastIntervalValue,
        lastDuration: this.lastDurationValue,
      };
    }

    return this.currentValue;
  }

  /** Get the current value without updating */
  get current(): number {
    return this.currentValue;
  }

  /** Check if currently in active state */
  get isActive(): boolean {
    return this.randomActive;
  }
}

/**
 * Custom hook for random interval triggering with smooth transitions or envelopes.
 */
export function useRandomInterval(params: RandomIntervalParams): RandomIntervalState {
  const fullParams: RandomIntervalParams = {
    baseValue: 0,
    lerpSpeed: 0.1,
    useSeededRandom: false,
    ...params,
  };

  // Use useState to create stable instance across re-renders
  const [state] = useState(() => new RandomIntervalState(fullParams));

  // Update params on the existing instance if they change
  useMemo(() => {
    state.params = fullParams;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fullParams is rebuilt every render; its fields are listed individually
  }, [
    state,
    fullParams.minInterval,
    fullParams.maxInterval,
    fullParams.activeDuration,
    fullParams.targetValue,
    fullParams.baseValue,
    fullParams.lerpSpeed,
    fullParams.useSeededRandom,
    fullParams.minDuration,
    fullParams.maxDuration,
    fullParams.attack,
    fullParams.decay,
    fullParams.computeDuration,
  ]);

  return state;
}

/**
 * Reusable manager for parameters that can run in either continuous or random mode.
 * Encapsulates the RandomIntervalState lifecycle, handles reset triggers,
 * and publishes timing data to the registry for the slider HUD.
 */
export class RandomParamManager {
  private randomState: RandomIntervalState | null = null;

  constructor(
    public effectId: string,
    public defaultIntervalMin = 1.0,
    public defaultIntervalMax = 5.0,
    public defaultDuration = 0.15,
  ) {}

  /**
   * Update the parameter and return the active value.
   *
   * @param mode - Current effect mode ('continuous' | 'random')
   * @param continuousValue - Current continuous/base value
   * @param config - Config object containing intervals, durations, attack, decay
   * @param params - Timing parameters from the render frame (dt, time, didReset)
   */
  update(
    mode: 'continuous' | 'random',
    continuousValue: number,
    config: {
      randomInterval?: { min: number; max: number };
      randomDuration?: { min: number; max: number };
      attack?: number;
      decay?: number;
      /**
       * Optional physics-driven duration override (seconds). Called once on
       * each activation edge; overrides randomDuration when it returns a
       * finite, positive value. See RandomIntervalParams.computeDuration.
       */
      computeDuration?: () => number;
    },
    params: { time: number; dt: number; didReset: boolean },
  ): number {
    if (mode !== 'random') {
      if (this.randomState) {
        this.randomState = null;
      }
      return continuousValue;
    }

    if (!this.randomState) {
      this.randomState = new RandomIntervalState({
        minInterval: config.randomInterval?.min ?? this.defaultIntervalMin,
        maxInterval: config.randomInterval?.max ?? this.defaultIntervalMax,
        activeDuration: this.defaultDuration,
        targetValue: continuousValue,
        baseValue: 0,
        lerpSpeed: 0.25,
        minDuration: config.randomDuration?.min,
        maxDuration: config.randomDuration?.max,
        attack: config.attack,
        decay: config.decay,
        computeDuration: config.computeDuration,
        effectId: this.effectId,
      });
    } else {
      this.randomState.params = {
        minInterval: config.randomInterval?.min ?? this.defaultIntervalMin,
        maxInterval: config.randomInterval?.max ?? this.defaultIntervalMax,
        activeDuration: this.defaultDuration,
        targetValue: continuousValue,
        baseValue: 0,
        lerpSpeed: 0.25,
        minDuration: config.randomDuration?.min,
        maxDuration: config.randomDuration?.max,
        attack: config.attack,
        decay: config.decay,
        computeDuration: config.computeDuration,
        effectId: this.effectId,
      };
    }

    return this.randomState.update(params);
  }
}

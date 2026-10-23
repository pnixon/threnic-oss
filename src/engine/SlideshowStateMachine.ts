/**
 * SlideshowStateMachine — Framework-agnostic state machine for slideshow
 * transition timing, ordering, and visual interpolation.
 *
 * Used by both the React preview (SlideshowBackgroundPlane.tsx) and the
 * headless GPU export pipeline (SlideshowManager.ts).
 *
 * This class wraps the pure logic in `slideshow/core.ts` into a stateful
 * container suitable for headless loops.
 */

import type { SlideshowConfig } from '@/types/effects/background';

import {
  type ConcreteTransition,
  type SlideshowFrame,
  DEFAULT_VISUALS,
  HIDDEN_VISUALS,
  pickTransition,
  getNextDuration,
  getNextIndex,
  computeVisuals,
} from './slideshow/core';

// Re-export types from core for compatibility
export type { SlideshowFrame };

/** Optional external signals fed into the state machine each tick. */
export interface TickSignals {
  /**
   * If true, the video in the current slot has ended playback.
   * The state machine will trigger an immediate transition.
   */
  videoEnded?: boolean;
  /**
   * Natural duration (seconds) of the video in the current slot.
   */
  videoDuration?: number;
  /**
   * Current playback position (seconds) of the video in the current slot.
   */
  videoCurrentTime?: number;
}

/** Internal mutable state. */
interface InternalState {
  currentIndex: number;
  nextIndex: number;
  showStartTime: number;
  showDuration: number;
  transitioning: boolean;
  transitionStartTime: number;
  activeTransition: ConcreteTransition;
}

export class SlideshowStateMachine {
  private wallClock: number = 0;
  private state: InternalState;
  private itemCount: number = 0;

  constructor() {
    this.state = {
      currentIndex: 0,
      nextIndex: 0,
      showStartTime: 0,
      showDuration: 10,
      transitioning: false,
      transitionStartTime: 0,
      activeTransition: 'crossfade',
    };
  }

  /**
   * Initialise / reinitialise the state machine for a (possibly new) set
   * of items.
   */
  init(itemCount: number, config: SlideshowConfig): void {
    this.itemCount = itemCount;
    this.wallClock = 0;
    this.state = {
      currentIndex: 0,
      nextIndex: itemCount > 1 ? getNextIndex(0, itemCount, config.order) : 0,
      showStartTime: 0,
      showDuration: getNextDuration(
        config.timingMode,
        config.staticDuration,
        config.randomDurationMin,
        config.randomDurationMax,
      ),
      transitioning: false,
      transitionStartTime: 0,
      activeTransition: pickTransition(config.transition),
    };
  }

  /** Full reset (e.g. on seek / track switch). */
  reset(): void {
    this.wallClock = 0;
    this.state = {
      currentIndex: 0,
      nextIndex: 0,
      showStartTime: 0,
      showDuration: 10,
      transitioning: false,
      transitionStartTime: 0,
      activeTransition: 'crossfade',
    };
  }

  /** Current wall-clock time (read-only). */
  get time(): number {
    return this.wallClock;
  }

  /** Current active item index (read-only). */
  get currentIndex(): number {
    return this.state.currentIndex;
  }

  /**
   * Advance the state machine by `delta` seconds and return the
   * visual frame data.
   *
   * Use this in real-time contexts (preview) where you receive
   * wall-clock deltas from requestAnimationFrame / useFrame.
   */
  tick(delta: number, config: SlideshowConfig, signals?: TickSignals): SlideshowFrame {
    this.wallClock += delta;
    return this._advance(config, signals);
  }

  /**
   * Set the state machine to an absolute time and return the
   * visual frame data.
   *
   * Use this in deterministic contexts (export) where you compute
   * each frame's time as `frame / fps`. Avoids floating-point drift
   * that occurs when accumulating `wallClock += 1/fps` over thousands
   * of frames.
   */
  tickAt(absoluteTime: number, config: SlideshowConfig, signals?: TickSignals): SlideshowFrame {
    this.wallClock = absoluteTime;
    return this._advance(config, signals);
  }

  /**
   * Core state-machine logic. Called by both tick() and tickAt().
   */
  private _advance(config: SlideshowConfig, signals?: TickSignals): SlideshowFrame {
    this.itemCount = config.items.length;

    if (this.itemCount <= 1) {
      return {
        currentIndex: 0,
        nextIndex: 0,
        transitioning: false,
        progress: 0,
        activeTransition: 'crossfade',
        current: DEFAULT_VISUALS,
        next: HIDDEN_VISUALS,
        indicesChanged: false,
      };
    }

    // Bounds-check indices
    const s = this.state;
    if (s.currentIndex >= this.itemCount) {
      s.currentIndex = 0;
      s.showStartTime = this.wallClock;
      s.showDuration = getNextDuration(
        config.timingMode,
        config.staticDuration,
        config.randomDurationMin,
        config.randomDurationMax,
      );
    }
    if (s.nextIndex >= this.itemCount) {
      s.nextIndex = getNextIndex(s.currentIndex, this.itemCount, config.order);
    }

    let indicesChanged = false;
    const transitionDur = config.transitionDuration;

    // ─── Check whether to START a transition ─────────────────────
    if (!s.transitioning) {
      const elapsed = this.wallClock - s.showStartTime;
      const videoEnded = !!signals?.videoEnded;

      let startTransition = false;
      let effectiveShowDuration = s.showDuration;
      const currentItem = config.items[s.currentIndex];

      if (currentItem?.type === 'video' && config.videoEndTransition) {
        const videoDur = signals?.videoDuration;
        const videoTime = signals?.videoCurrentTime;
        const fadeDur = config.videoFadeDuration ?? transitionDur;

        if (videoDur && isFinite(videoDur)) {
          if (videoTime != null && isFinite(videoTime) && videoTime > 0) {
            startTransition = videoTime >= videoDur - fadeDur;
          }
          effectiveShowDuration = Math.max(0.1, videoDur - fadeDur);
        }
      }

      if (startTransition || elapsed >= effectiveShowDuration || videoEnded) {
        s.transitioning = true;
        s.transitionStartTime = startTransition
          ? this.wallClock
          : s.showStartTime + effectiveShowDuration;
        s.activeTransition = pickTransition(config.transition);
        s.nextIndex = getNextIndex(s.currentIndex, this.itemCount, config.order);
        indicesChanged = true;
      }
    }

    // ─── Compute transition progress ────────────────────────────
    if (s.transitioning) {
      const tElapsed = this.wallClock - s.transitionStartTime;
      const currentItem = config.items[s.currentIndex];
      let effectiveTransDur = transitionDur;
      if (
        currentItem?.type === 'video' &&
        config.videoEndTransition &&
        config.videoFadeDuration != null
      ) {
        effectiveTransDur = config.videoFadeDuration;
      }

      const p = Math.min(1.0, tElapsed / Math.max(0.01, effectiveTransDur));
      const visuals = computeVisuals(s.activeTransition, p);

      if (p >= 1.0) {
        s.transitioning = false;
        s.currentIndex = s.nextIndex;
        s.nextIndex = getNextIndex(s.currentIndex, this.itemCount, config.order);
        s.showStartTime = s.transitionStartTime + effectiveTransDur;
        s.showDuration = getNextDuration(
          config.timingMode,
          config.staticDuration,
          config.randomDurationMin,
          config.randomDurationMax,
        );
        indicesChanged = true;

        return {
          currentIndex: s.currentIndex,
          nextIndex: s.nextIndex,
          transitioning: false,
          progress: 0,
          activeTransition: s.activeTransition,
          current: DEFAULT_VISUALS,
          next: HIDDEN_VISUALS,
          indicesChanged,
        };
      }

      return {
        currentIndex: s.currentIndex,
        nextIndex: s.nextIndex,
        transitioning: true,
        progress: p,
        activeTransition: s.activeTransition,
        current: visuals.current,
        next: visuals.next,
        indicesChanged,
      };
    }

    // ─── Idle ───────────────────────────────────────────────────
    return {
      currentIndex: s.currentIndex,
      nextIndex: s.nextIndex,
      transitioning: false,
      progress: 0,
      activeTransition: s.activeTransition,
      current: DEFAULT_VISUALS,
      next: HIDDEN_VISUALS,
      indicesChanged,
    };
  }
}

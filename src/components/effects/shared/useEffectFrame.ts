/**
 * useEffectFrame — Centralized frame timing for all visual effects.
 *
 * Replaces the duplicated pattern of:
 *   useFrame + getFrameDelta + pause-freeze + delta-cap + seek-reset
 *
 * Every effect simply calls:
 *   useEffectFrame((ctx) => { ... }, enabled);
 *
 * The hook guarantees:
 *  1. Consistent delta in export mode (1 / exportFps)
 *  2. Delta capped at MAX_DT to prevent speed jumps from GC pauses, tab switches, slow renders
 *  3. dt = 0 when paused in preview (but NOT in export)
 *  4. didReset = true on the frame after a seek-to-zero transition
 *  5. elapsed accumulates dt each frame, resets on seek-to-zero
 */

import { useRef, useLayoutEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { timeStore } from '@/engine/stores/timeStore';
import { getFrameDelta } from '@/engine/EngineLoop';

/**
 * Maximum delta time per frame (seconds).
 * Prevents animation speed jumps when rendering is slow.
 * 1/15 ≈ 67ms — lenient enough for 15+ FPS export without slow-motion.
 */
const MAX_DT = 1 / 15;

/**
 * Context passed to every effect's frame callback.
 */
interface EffectFrameContext {
  /** Delta for this frame — fixed in export, capped in preview, 0 when paused */
  dt: number;
  /** Engine current time (seconds) — from timeStore.getState().currentTime */
  time: number;
  /** Accumulated simulation time (sum of dt, resets on seek-to-zero) */
  elapsed: number;
  /** True the frame after a seek-to-zero is detected */
  didReset: boolean;
  /** True when paused in preview mode */
  isPaused: boolean;
  /** True when in export mode */
  isExport: boolean;
}

type EffectFrameCallback = (ctx: EffectFrameContext) => void;

/**
 * Centralized frame hook for visual effects.
 *
 * @param callback  Called every frame with timing context.
 * @param enabled   When false, callback is skipped entirely.
 */
export function useEffectFrame(callback: EffectFrameCallback, enabled = true): void {
  const prevTimeRef = useRef(-1);
  const elapsedRef = useRef(0);
  // Stabilize callback reference so useFrame's internal tracking stays happy
  const callbackRef = useRef(callback);

  // Safe to assign in useLayoutEffect instead of render
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useFrame((_state, delta) => {
    if (!enabled) return;

    const isExport = timeStore.getState().mode === 'export';
    const isPaused = !timeStore.getState().isPlaying && !isExport;
    const currentTime = timeStore.getState().currentTime;

    // --- Delta calculation ---
    let dt = getFrameDelta(delta);
    dt = Math.min(dt, MAX_DT);

    if (isPaused) {
      dt = 0;
    }

    // --- Seek-to-zero detection ---
    const didReset = currentTime === 0 && prevTimeRef.current > 0;
    prevTimeRef.current = currentTime;

    // --- Elapsed accumulation ---
    if (didReset) {
      elapsedRef.current = 0;
    }
    elapsedRef.current += dt;

    callbackRef.current({
      dt,
      time: currentTime,
      elapsed: elapsedRef.current,
      didReset,
      isPaused,
      isExport,
    });
  });
}

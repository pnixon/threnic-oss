import { describe, it, expect } from 'vitest';
import { RandomIntervalState } from '@/components/effects/shared/useRandomInterval';

/**
 * Tests for the physics-driven `computeDuration` override on RandomIntervalState.
 *
 * Behavior under test (VHS tracking "run until off screen" request): when a
 * computeDuration callback is supplied, the active window is governed by that
 * callback's returned duration (e.g. band travel time), NOT by the
 * min/max random duration window. A non-finite / <=0 return falls back to the
 * min/max window.
 */
describe('RandomIntervalState computeDuration override', () => {
  it('uses computeDuration for the active window instead of min/max duration', () => {
    let calls = 0;
    const state = new RandomIntervalState({
      minInterval: 100, // large so it only triggers once in this window
      maxInterval: 100,
      activeDuration: 0.2,
      targetValue: 1,
      baseValue: 0,
      // These would normally bound the window to <=0.3s...
      minDuration: 0.1,
      maxDuration: 0.3,
      // ...but computeDuration overrides it to a much longer travel time.
      computeDuration: () => {
        calls += 1;
        return 5; // seconds — "band travels off screen"
      },
    });

    // Trigger at t=0 (now >= nextRandomTrigger which starts at 0).
    let v = state.update({ time: 0, dt: 0.016, didReset: false });
    expect(calls).toBe(1);
    expect(state.isActive).toBe(true);

    // Still active well past the random-window max (0.3s) — proves the
    // 5s computeDuration governs the window. Value ramps toward target via
    // lerp, so assert it has climbed while the window stays open.
    v = state.update({ time: 1.0, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(true);
    expect(v).toBeGreaterThan(0);

    v = state.update({ time: 4.5, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(true);

    // After the full computed duration it deactivates.
    v = state.update({ time: 5.5, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(false);
  });

  it('falls back to the min/max window when computeDuration returns a non-positive value', () => {
    const state = new RandomIntervalState({
      minInterval: 100,
      maxInterval: 100,
      activeDuration: 0.2,
      targetValue: 1,
      baseValue: 0,
      minDuration: 0.25,
      maxDuration: 0.25,
      computeDuration: () => 0, // invalid -> fall back to fixed 0.25s window
    });

    state.update({ time: 0, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(true);

    // Still inside the 0.25s window.
    state.update({ time: 0.2, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(true);

    // Past the fallback window -> inactive.
    state.update({ time: 0.3, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(false);
  });

  it('recomputes duration on each activation edge', () => {
    const durations = [2, 4];
    let idx = 0;
    const state = new RandomIntervalState({
      minInterval: 0.5,
      maxInterval: 0.5,
      activeDuration: 0.2,
      targetValue: 1,
      baseValue: 0,
      useSeededRandom: true,
      computeDuration: () => durations[Math.min(idx++, durations.length - 1)],
    });

    // First activation at t=0, duration=2 -> ends at t=2, next trigger t=2.5.
    state.update({ time: 0, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(true);
    state.update({ time: 2.1, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(false);

    // Second activation at t=2.5, duration=4 -> still active at t=6.
    state.update({ time: 2.5, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(true);
    state.update({ time: 6.0, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(true);
    state.update({ time: 6.6, dt: 0.016, didReset: false });
    expect(state.isActive).toBe(false);
  });
});

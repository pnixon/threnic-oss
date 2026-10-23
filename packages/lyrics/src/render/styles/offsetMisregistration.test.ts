import { describe, it, expect } from 'vitest';
import {
  computeOffset,
  offsetMisregistrationStyle,
  DRIFT_HZ,
  MAX_OFFSET_EM,
  SNAP_THRESHOLD,
} from './offsetMisregistration';
import type { StyleWordContext } from '../StyleRegistry';

function ctx(time: number, opts: { high?: number; energy?: number } = {}): StyleWordContext {
  const { high, energy } = opts;
  const audio =
    high === undefined && energy === undefined
      ? undefined
      : { bass: 0, mid: 0, high: high ?? 0, energy: energy ?? 0 };
  return {
    time,
    audio,
    wordStart: 0,
    wordEnd: 2,
    wordIndex: 0,
    wordCount: 1,
    isActive: true,
  };
}

/** Euclidean magnitude of the offset, in em. */
function offsetMag(m: { offsetXEm?: number; offsetYEm?: number }): number {
  const x = m.offsetXEm ?? 0;
  const y = m.offsetYEm ?? 0;
  return Math.hypot(x, y);
}

describe('offsetMisregistration', () => {
  it('has the registered id/name', () => {
    expect(offsetMisregistrationStyle.id).toBe('offset-misregistration');
    expect(offsetMisregistrationStyle.name).toBe('Offset Misregistration');
  });

  it('exposes computeOffset as its modifyWord', () => {
    expect(offsetMisregistrationStyle.modifyWord).toBe(computeOffset);
  });

  it('bounds each axis to ±MAX_OFFSET_EM across a swept timeline (quiet)', () => {
    for (let t = 0; t <= 20; t += 0.013) {
      const m = computeOffset(ctx(t)); // no audio ⇒ full drift, worst case
      expect(Math.abs(m.offsetXEm!)).toBeLessThanOrEqual(MAX_OFFSET_EM + 1e-9);
      expect(Math.abs(m.offsetYEm!)).toBeLessThanOrEqual(MAX_OFFSET_EM + 1e-9);
    }
  });

  it('drift is deterministic for a fixed time', () => {
    const a = computeOffset(ctx(3.14159));
    const b = computeOffset(ctx(3.14159));
    expect(a.offsetXEm).toBe(b.offsetXEm);
    expect(a.offsetYEm).toBe(b.offsetYEm);
  });

  it('drift matches the closed-form sin() at a known time', () => {
    const t = 0.5;
    const expectedX = MAX_OFFSET_EM * Math.sin(t * 2 * Math.PI * DRIFT_HZ);
    const m = computeOffset(ctx(t)); // quiet ⇒ snap = 1
    expect(m.offsetXEm!).toBeCloseTo(expectedX, 9);
  });

  it('a high-transient frame produces a smaller offset than a quiet frame at the same time (snap-back)', () => {
    // Pick a time where the drift is clearly non-zero so magnitudes differ.
    const t = 0.5; // sin(2π·0.45·0.5) ≈ 0.988 — near peak drift
    const quiet = offsetMag(computeOffset(ctx(t)));
    const transient = offsetMag(computeOffset(ctx(t, { high: SNAP_THRESHOLD })));
    expect(quiet).toBeGreaterThan(0);
    expect(transient).toBeLessThan(quiet);
  });

  it('a transient at/above SNAP_THRESHOLD snaps registration fully back to zero', () => {
    const t = 0.5;
    const m = computeOffset(ctx(t, { high: SNAP_THRESHOLD }));
    expect(offsetMag(m)).toBeCloseTo(0, 9);
    const mHarder = computeOffset(ctx(t, { energy: 1 }));
    expect(offsetMag(mHarder)).toBeCloseTo(0, 9);
  });

  it('either high or energy drives the snap (max of the two)', () => {
    const t = 0.5;
    const byHigh = offsetMag(computeOffset(ctx(t, { high: SNAP_THRESHOLD, energy: 0 })));
    const byEnergy = offsetMag(computeOffset(ctx(t, { high: 0, energy: SNAP_THRESHOLD })));
    expect(byHigh).toBeCloseTo(0, 9);
    expect(byEnergy).toBeCloseTo(0, 9);
  });

  it('offset magnitude decreases monotonically as the transient grows', () => {
    const t = 0.5;
    let prev = Infinity;
    for (let level = 0; level <= SNAP_THRESHOLD + 1e-9; level += SNAP_THRESHOLD / 10) {
      const mag = offsetMag(computeOffset(ctx(t, { high: level })));
      expect(mag).toBeLessThanOrEqual(prev + 1e-9);
      prev = mag;
    }
  });

  it('handles missing audio as a quiet (full-drift) frame', () => {
    const withNoAudio = offsetMag(computeOffset(ctx(0.5)));
    const withZeroAudio = offsetMag(computeOffset(ctx(0.5, { high: 0, energy: 0 })));
    expect(withNoAudio).toBeGreaterThan(0);
    expect(withNoAudio).toBeCloseTo(withZeroAudio, 9);
  });
});

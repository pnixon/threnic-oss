import { describe, it, expect } from 'vitest';
import {
  computeSwissGrid,
  swissKineticGridStyle,
  BASE_SCALE,
  BIG_SCALE,
  GRID_STEP_EM,
  ENERGY_PULSE,
} from './swissKineticGrid';
import type { StyleWordContext } from '../StyleRegistry';

function ctx(energy: number, isActive = false, wordIndex = 0, wordCount = 5): StyleWordContext {
  return {
    time: 1,
    audio: { bass: 0, mid: 0, high: 0, energy },
    wordStart: 0,
    wordEnd: 2,
    wordIndex,
    wordCount,
    isActive,
  };
}

/** Snap-tolerant modulo test: value is an integer multiple of GRID_STEP_EM. */
function isGridMultiple(value: number): boolean {
  const q = value / GRID_STEP_EM;
  return Math.abs(q - Math.round(q)) < 1e-9;
}

describe('swissKineticGrid', () => {
  it('has the registered id/name and a modifyWord hook', () => {
    expect(swissKineticGridStyle.id).toBe('swiss-kinetic-grid');
    expect(swissKineticGridStyle.name).toBe('Swiss Kinetic Grid');
    expect(typeof swissKineticGridStyle.modifyWord).toBe('function');
    expect(swissKineticGridStyle.modifyLine).toBeUndefined();
  });

  it('gives extreme scale contrast: active word >> inactive word', () => {
    const active = computeSwissGrid(ctx(0, true, 3)).scaleMul!;
    const inactive = computeSwissGrid(ctx(0, false, 3)).scaleMul!;
    expect(active).toBeGreaterThan(inactive);
    // "Extreme" — active is at least ~3x the quiet base.
    expect(active / inactive).toBeGreaterThan(3);
  });

  it('inactive word sits exactly at BASE_SCALE regardless of energy', () => {
    expect(computeSwissGrid(ctx(0, false)).scaleMul).toBeCloseTo(BASE_SCALE, 9);
    expect(computeSwissGrid(ctx(1, false)).scaleMul).toBeCloseTo(BASE_SCALE, 9);
  });

  it('active word at energy=0 sits at BIG_SCALE', () => {
    expect(computeSwissGrid(ctx(0, true)).scaleMul).toBeCloseTo(BIG_SCALE, 9);
  });

  it('active scale increases monotonically with energy', () => {
    let prev = -Infinity;
    for (let e = 0; e <= 1.0001; e += 0.1) {
      const s = computeSwissGrid(ctx(e, true)).scaleMul!;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('active scale reaches BIG_SCALE + ENERGY_PULSE at full energy', () => {
    expect(computeSwissGrid(ctx(1, true)).scaleMul).toBeCloseTo(BIG_SCALE + ENERGY_PULSE, 9);
  });

  it('offsets are quantized to integer multiples of GRID_STEP_EM', () => {
    for (let i = 0; i < 20; i++) {
      const m = computeSwissGrid(ctx(0.5, i % 2 === 0, i));
      expect(isGridMultiple(m.offsetXEm!)).toBe(true);
      expect(isGridMultiple(m.offsetYEm!)).toBe(true);
    }
  });

  it('offsets are deterministic per word index (same index → same cell)', () => {
    const a = computeSwissGrid(ctx(0.3, true, 7));
    const b = computeSwissGrid(ctx(0.9, false, 7));
    expect(a.offsetXEm).toBe(b.offsetXEm);
    expect(a.offsetYEm).toBe(b.offsetYEm);
  });

  it('all outputs are finite and bounded', () => {
    for (let i = 0; i < 30; i++) {
      const m = computeSwissGrid(ctx(Math.random(), i % 3 === 0, i, 30));
      expect(Number.isFinite(m.scaleMul!)).toBe(true);
      expect(m.scaleMul!).toBeGreaterThanOrEqual(BASE_SCALE);
      expect(m.scaleMul!).toBeLessThanOrEqual(BIG_SCALE + ENERGY_PULSE + 1e-9);
      expect(Number.isFinite(m.offsetXEm!)).toBe(true);
      expect(Number.isFinite(m.offsetYEm!)).toBe(true);
      expect(Math.abs(m.offsetXEm!)).toBeLessThanOrEqual(GRID_STEP_EM * 8);
      expect(Math.abs(m.offsetYEm!)).toBeLessThanOrEqual(GRID_STEP_EM * 8);
    }
  });

  it('clamps out-of-range energy (no overshoot past BIG_SCALE + ENERGY_PULSE)', () => {
    expect(computeSwissGrid(ctx(5, true)).scaleMul).toBeCloseTo(BIG_SCALE + ENERGY_PULSE, 9);
    expect(computeSwissGrid(ctx(-3, true)).scaleMul).toBeCloseTo(BIG_SCALE, 9);
  });

  it('handles missing audio as energy=0', () => {
    const m = computeSwissGrid({
      time: 1,
      wordStart: 0,
      wordEnd: 2,
      wordIndex: 2,
      wordCount: 4,
      isActive: true,
    });
    expect(m.scaleMul).toBeCloseTo(BIG_SCALE, 9);
    expect(isGridMultiple(m.offsetXEm!)).toBe(true);
    expect(isGridMultiple(m.offsetYEm!)).toBe(true);
  });
});

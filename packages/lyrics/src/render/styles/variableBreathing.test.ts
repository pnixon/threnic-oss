import { describe, it, expect } from 'vitest';
import {
  computeBreathing,
  variableBreathingStyle,
  WGHT_MIN,
  WGHT_MAX,
  WDTH_MIN,
  WDTH_MAX,
  SCALE_PULSE,
} from './variableBreathing';
import type { StyleWordContext } from '../StyleRegistry';

function ctx(bass: number, isActive = false): StyleWordContext {
  return {
    time: 1,
    audio: { bass, mid: 0, high: 0, energy: 0 },
    wordStart: 0,
    wordEnd: 2,
    wordIndex: 0,
    wordCount: 1,
    isActive,
  };
}

function parseAxis(fvs: string, axis: 'wght' | 'wdth'): number {
  const m = new RegExp(`"${axis}"\\s+([\\d.]+)`).exec(fvs);
  if (!m) throw new Error(`axis ${axis} not found in "${fvs}"`);
  return parseFloat(m[1]);
}

describe('variableBreathing', () => {
  it('has the registered id/name', () => {
    expect(variableBreathingStyle.id).toBe('variable-breathing');
    expect(variableBreathingStyle.name).toBe('Variable-Font Breathing');
  });

  it('at bass=0 sits at the axis minimums and neutral scale', () => {
    const m = computeBreathing(ctx(0));
    expect(parseAxis(m.fontVariationSettings!, 'wght')).toBe(WGHT_MIN);
    expect(parseAxis(m.fontVariationSettings!, 'wdth')).toBe(WDTH_MIN);
    expect(m.scaleMul).toBeCloseTo(1, 6);
  });

  it('at bass=1 (inactive) reaches the axis maximums and full pulse', () => {
    const m = computeBreathing(ctx(1, false));
    expect(parseAxis(m.fontVariationSettings!, 'wght')).toBe(WGHT_MAX);
    expect(parseAxis(m.fontVariationSettings!, 'wdth')).toBe(WDTH_MAX);
    expect(m.scaleMul).toBeCloseTo(1 + SCALE_PULSE, 6);
  });

  it('is monotonic increasing in bass (weight axis)', () => {
    let prev = -Infinity;
    for (let b = 0; b <= 1.0001; b += 0.1) {
      const w = parseAxis(computeBreathing(ctx(b)).fontVariationSettings!, 'wght');
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it('active word breathes at least as hard as inactive at the same bass', () => {
    const inactive = computeBreathing(ctx(0.4, false)).scaleMul!;
    const active = computeBreathing(ctx(0.4, true)).scaleMul!;
    expect(active).toBeGreaterThan(inactive);
  });

  it('clamps out-of-range bass (no overshoot past the maximums)', () => {
    const m = computeBreathing(ctx(5, true));
    expect(parseAxis(m.fontVariationSettings!, 'wght')).toBe(WGHT_MAX);
    expect(m.scaleMul!).toBeLessThanOrEqual(1 + SCALE_PULSE + 1e-9);
  });

  it('handles missing audio as bass=0', () => {
    const m = computeBreathing({
      time: 1,
      wordStart: 0,
      wordEnd: 2,
      wordIndex: 0,
      wordCount: 1,
      isActive: true,
    });
    expect(parseAxis(m.fontVariationSettings!, 'wght')).toBe(WGHT_MIN);
    expect(m.scaleMul).toBeCloseTo(1, 6);
  });
});

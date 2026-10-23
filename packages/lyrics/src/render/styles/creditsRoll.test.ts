import { describe, it, expect } from 'vitest';
import {
  computeCreditsRoll,
  creditsRollStyle,
  SETTLE_SCALE,
  OPACITY_PER_STEP,
  MIN_OPACITY,
} from './creditsRoll';
import type { StyleLineContext } from '../StyleRegistry';

function lineCtx(lineOffset: number, energy = 0): StyleLineContext {
  const role = lineOffset === 0 ? 'current' : lineOffset > 0 ? 'future' : 'past';
  return {
    time: 10,
    audio: { bass: 0, mid: 0, high: 0, energy },
    lineStart: 10,
    lineEnd: 12,
    role,
    lineOffset,
  };
}

describe('creditsRoll', () => {
  it('registers id/name and line hook; word hook is identity', () => {
    expect(creditsRollStyle.id).toBe('credits-roll');
    expect(creditsRollStyle.name).toBe('Credits Roll');
    expect(typeof creditsRollStyle.modifyLine).toBe('function');
    expect(creditsRollStyle.modifyWord({} as never)).toEqual({});
  });

  it('current line is full-opacity and settled at SETTLE_SCALE', () => {
    const m = computeCreditsRoll(lineCtx(0));
    expect(m.opacityMul).toBe(1);
    expect(m.scale).toBe(SETTLE_SCALE);
  });

  it('exports sane constants', () => {
    expect(SETTLE_SCALE).toBeGreaterThan(1);
    expect(OPACITY_PER_STEP).toBeGreaterThan(0);
    expect(MIN_OPACITY).toBeGreaterThan(0);
    expect(MIN_OPACITY).toBeLessThan(1);
  });

  it('opacity decreases monotonically with |lineOffset| and clamps at MIN_OPACITY', () => {
    let prev = 2;
    for (let d = 0; d <= 8; d++) {
      const o = computeCreditsRoll(lineCtx(d)).opacityMul!;
      expect(o).toBeLessThanOrEqual(prev);
      expect(o).toBeGreaterThanOrEqual(MIN_OPACITY - 1e-9);
      prev = o;
    }
    // Far line saturates exactly at the floor.
    expect(computeCreditsRoll(lineCtx(20)).opacityMul).toBe(MIN_OPACITY);
  });

  it('opacity falloff is SYMMETRIC in sign (past vs future fade equally)', () => {
    for (let d = 1; d <= 6; d++) {
      const fut = computeCreditsRoll(lineCtx(d)).opacityMul!;
      const past = computeCreditsRoll(lineCtx(-d)).opacityMul!;
      expect(past).toBeCloseTo(fut, 9);
    }
  });

  it('opacity matches 1 - d*OPACITY_PER_STEP before the floor kicks in', () => {
    const d = 1;
    expect(computeCreditsRoll(lineCtx(d)).opacityMul).toBeCloseTo(1 - d * OPACITY_PER_STEP, 9);
  });

  it('no non-current line exceeds the current line scale (settle is the max)', () => {
    for (let d = 1; d <= 10; d++) {
      const s = computeCreditsRoll(lineCtx(d)).scale!;
      expect(s).toBeLessThanOrEqual(SETTLE_SCALE + 1e-9);
      const sPast = computeCreditsRoll(lineCtx(-d)).scale!;
      expect(sPast).toBeCloseTo(s, 9);
    }
  });

  it('handles missing audio (still resolves purely from role/offset)', () => {
    const m = computeCreditsRoll({
      time: 10,
      lineStart: 10,
      lineEnd: 12,
      role: 'future',
      lineOffset: 1,
    });
    expect(m.opacityMul!).toBeLessThan(1);
    expect(m.opacityMul!).toBeGreaterThanOrEqual(MIN_OPACITY);
  });
});

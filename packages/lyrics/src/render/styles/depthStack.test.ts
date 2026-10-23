import { describe, it, expect } from 'vitest';
import {
  computeDepthStack,
  depthStackStyle,
  CURRENT_SCALE,
  MAX_BLUR,
  MIN_OPACITY,
  MIN_SCALE,
} from './depthStack';
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

describe('depthStack', () => {
  it('registers id/name and both hooks', () => {
    expect(depthStackStyle.id).toBe('depth-stack');
    expect(depthStackStyle.name).toBe('Depth Stack');
    expect(typeof depthStackStyle.modifyLine).toBe('function');
    // per-word is identity
    expect(depthStackStyle.modifyWord({} as never)).toEqual({});
  });

  it('current line is sharp, full-opacity, slightly enlarged', () => {
    const m = computeDepthStack(lineCtx(0));
    expect(m.blurPx).toBe(0);
    expect(m.opacityMul).toBe(1);
    expect(m.scale).toBe(CURRENT_SCALE);
  });

  it('blur increases monotonically with distance (both directions symmetric)', () => {
    let prev = -1;
    for (let d = 0; d <= 5; d++) {
      const m = computeDepthStack(lineCtx(d));
      expect(m.blurPx!).toBeGreaterThanOrEqual(prev);
      prev = m.blurPx!;
      // symmetric in sign
      expect(computeDepthStack(lineCtx(-d)).blurPx).toBeCloseTo(m.blurPx!, 6);
    }
  });

  it('opacity decreases monotonically with distance and clamps at MIN_OPACITY', () => {
    let prev = 2;
    for (let d = 0; d <= 8; d++) {
      const o = computeDepthStack(lineCtx(d)).opacityMul!;
      expect(o).toBeLessThanOrEqual(prev);
      expect(o).toBeGreaterThanOrEqual(MIN_OPACITY - 1e-9);
      prev = o;
    }
  });

  it('scale shrinks with distance and clamps at MIN_SCALE', () => {
    let prev = Infinity;
    for (let d = 0; d <= 10; d++) {
      const s = computeDepthStack(lineCtx(d)).scale!;
      // after the current-line bump, scale is non-increasing in distance
      if (d > 0) expect(s).toBeLessThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(MIN_SCALE - 1e-9);
      prev = s;
    }
  });

  it('blur clamps at MAX_BLUR for far lines', () => {
    expect(computeDepthStack(lineCtx(20)).blurPx).toBe(MAX_BLUR);
  });

  it('energy deepens the pull for distant lines but never touches the current line', () => {
    const cur0 = computeDepthStack(lineCtx(0, 0));
    const cur1 = computeDepthStack(lineCtx(0, 1));
    expect(cur1).toEqual(cur0); // current line unaffected by energy

    const far0 = computeDepthStack(lineCtx(2, 0));
    const far1 = computeDepthStack(lineCtx(2, 1));
    expect(far1.blurPx!).toBeGreaterThan(far0.blurPx!);
    expect(far1.opacityMul!).toBeLessThan(far0.opacityMul!);
  });

  it('handles missing audio as energy=0', () => {
    const m = computeDepthStack({
      time: 10,
      lineStart: 10,
      lineEnd: 12,
      role: 'future',
      lineOffset: 1,
    });
    expect(m.blurPx).toBeGreaterThan(0);
  });
});

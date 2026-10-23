import { describe, it, expect } from 'vitest';
import {
  computeVisuals,
  pickTransition,
  getNextDuration,
  getNextIndex,
  CONCRETE_TRANSITIONS,
  DEFAULT_VISUALS,
  HIDDEN_VISUALS,
} from './core';

describe('slideshow/core — computeVisuals', () => {
  // ─── Cut ──────────────────────────────────────────────────────

  describe('cut', () => {
    it('shows current at 100% until progress reaches 1.0', () => {
      const v = computeVisuals('cut', 0.5);
      expect(v.current.opacity).toBe(1.0);
      expect(v.next.opacity).toBe(0.0);
    });

    it('snaps to next at progress=1.0', () => {
      const v = computeVisuals('cut', 1.0);
      expect(v.current.opacity).toBe(0.0);
      expect(v.next.opacity).toBe(1.0);
    });

    it('has no offset or scale changes', () => {
      const v = computeVisuals('cut', 0.5);
      expect(v.current.offsetX).toBe(0);
      expect(v.current.offsetY).toBe(0);
      expect(v.current.scale).toBe(1.0);
      expect(v.next.offsetX).toBe(0);
      expect(v.next.offsetY).toBe(0);
      expect(v.next.scale).toBe(1.0);
    });
  });

  // ─── Crossfade ────────────────────────────────────────────────

  describe('crossfade', () => {
    it('at p=0, current is fully opaque, next is transparent', () => {
      const v = computeVisuals('crossfade', 0);
      expect(v.current.opacity).toBe(1.0);
      expect(v.next.opacity).toBe(0.0);
    });

    it('at p=0.5, both are at 50% opacity', () => {
      const v = computeVisuals('crossfade', 0.5);
      expect(v.current.opacity).toBeCloseTo(0.5);
      expect(v.next.opacity).toBeCloseTo(0.5);
    });

    it('at p=1, current is transparent, next is fully opaque', () => {
      const v = computeVisuals('crossfade', 1.0);
      expect(v.current.opacity).toBe(0.0);
      expect(v.next.opacity).toBe(1.0);
    });

    it('has no offset or scale changes', () => {
      const v = computeVisuals('crossfade', 0.5);
      expect(v.current.offsetX).toBe(0);
      expect(v.next.offsetX).toBe(0);
    });
  });

  // ─── Fade through Black ───────────────────────────────────────

  describe('fadeBlack', () => {
    it('at p=0, current is fully opaque', () => {
      const v = computeVisuals('fadeBlack', 0);
      expect(v.current.opacity).toBe(1.0);
      expect(v.next.opacity).toBe(0.0);
    });

    it('at p=0.5, both are at 0 (fully black)', () => {
      const v = computeVisuals('fadeBlack', 0.5);
      expect(v.current.opacity).toBe(0.0);
      expect(v.next.opacity).toBe(0.0);
    });

    it('at p=1.0, next is fully opaque', () => {
      const v = computeVisuals('fadeBlack', 1.0);
      expect(v.current.opacity).toBe(0.0);
      expect(v.next.opacity).toBe(1.0);
    });

    it('first half fades out current, second half fades in next', () => {
      const v25 = computeVisuals('fadeBlack', 0.25);
      expect(v25.current.opacity).toBeCloseTo(0.5);
      expect(v25.next.opacity).toBe(0.0);

      const v75 = computeVisuals('fadeBlack', 0.75);
      expect(v75.current.opacity).toBe(0.0);
      expect(v75.next.opacity).toBeCloseTo(0.5);
    });
  });

  // ─── Slide Left ───────────────────────────────────────────────

  describe('slideLeft', () => {
    it('both slots stay at full opacity throughout', () => {
      for (const p of [0, 0.25, 0.5, 0.75, 1.0]) {
        const v = computeVisuals('slideLeft', p);
        expect(v.current.opacity).toBe(1.0);
        expect(v.next.opacity).toBe(1.0);
      }
    });

    it('at p=0, current is centered, next is fully off-screen right', () => {
      const v = computeVisuals('slideLeft', 0);
      expect(v.current.offsetX).toBe(0);
      expect(v.next.offsetX).toBe(2); // off-screen right
    });

    it('at p=0.5, current is half-way left, next is half-way from right', () => {
      const v = computeVisuals('slideLeft', 0.5);
      expect(v.current.offsetX).toBeCloseTo(-1.0);
      expect(v.next.offsetX).toBeCloseTo(1.0);
    });

    it('at p=1.0, current is fully off-screen left, next is centered', () => {
      const v = computeVisuals('slideLeft', 1.0);
      expect(v.current.offsetX).toBeCloseTo(-2.0);
      expect(v.next.offsetX).toBeCloseTo(0);
    });

    it('has no vertical offset or scale changes', () => {
      const v = computeVisuals('slideLeft', 0.5);
      expect(v.current.offsetY).toBe(0);
      expect(v.next.offsetY).toBe(0);
      expect(v.current.scale).toBe(1.0);
      expect(v.next.scale).toBe(1.0);
    });
  });

  // ─── Slide Right ──────────────────────────────────────────────

  describe('slideRight', () => {
    it('both slots stay at full opacity throughout', () => {
      const v = computeVisuals('slideRight', 0.5);
      expect(v.current.opacity).toBe(1.0);
      expect(v.next.opacity).toBe(1.0);
    });

    it('at p=0, current is centered, next is off-screen left', () => {
      const v = computeVisuals('slideRight', 0);
      expect(v.current.offsetX).toBe(0);
      expect(v.next.offsetX).toBe(-2); // off-screen left
    });

    it('at p=1.0, current is off-screen right, next is centered', () => {
      const v = computeVisuals('slideRight', 1.0);
      expect(v.current.offsetX).toBeCloseTo(2.0);
      expect(v.next.offsetX).toBeCloseTo(0);
    });

    it('slides in opposite direction from slideLeft', () => {
      const vLeft = computeVisuals('slideLeft', 0.5);
      const vRight = computeVisuals('slideRight', 0.5);
      // Current moves in opposite directions
      expect(vLeft.current.offsetX).toBe(-vRight.current.offsetX);
      expect(vLeft.next.offsetX).toBe(-vRight.next.offsetX);
    });
  });

  // ─── Slide Up ─────────────────────────────────────────────────

  describe('slideUp', () => {
    it('both slots stay at full opacity', () => {
      const v = computeVisuals('slideUp', 0.5);
      expect(v.current.opacity).toBe(1.0);
      expect(v.next.opacity).toBe(1.0);
    });

    it('at p=0, current is centered, next is off-screen below', () => {
      const v = computeVisuals('slideUp', 0);
      expect(v.current.offsetY).toBe(0);
      expect(v.next.offsetY).toBe(-2); // off-screen below
    });

    it('at p=1.0, current is off-screen above, next is centered', () => {
      const v = computeVisuals('slideUp', 1.0);
      expect(v.current.offsetY).toBeCloseTo(2.0);
      expect(v.next.offsetY).toBeCloseTo(0);
    });

    it('has no horizontal offset', () => {
      const v = computeVisuals('slideUp', 0.5);
      expect(v.current.offsetX).toBe(0);
      expect(v.next.offsetX).toBe(0);
    });
  });

  // ─── Slide Down ───────────────────────────────────────────────

  describe('slideDown', () => {
    it('both slots stay at full opacity', () => {
      const v = computeVisuals('slideDown', 0.5);
      expect(v.current.opacity).toBe(1.0);
      expect(v.next.opacity).toBe(1.0);
    });

    it('at p=0, current is centered, next is off-screen above', () => {
      const v = computeVisuals('slideDown', 0);
      expect(v.current.offsetY).toBe(0);
      expect(v.next.offsetY).toBe(2); // off-screen above
    });

    it('at p=1.0, current is off-screen below, next is centered', () => {
      const v = computeVisuals('slideDown', 1.0);
      expect(v.current.offsetY).toBeCloseTo(-2.0);
      expect(v.next.offsetY).toBeCloseTo(0);
    });

    it('slides in opposite direction from slideUp', () => {
      const vUp = computeVisuals('slideUp', 0.5);
      const vDown = computeVisuals('slideDown', 0.5);
      expect(vUp.current.offsetY).toBe(-vDown.current.offsetY);
      expect(vUp.next.offsetY).toBe(-vDown.next.offsetY);
    });
  });

  // ─── Zoom ─────────────────────────────────────────────────────

  describe('zoom', () => {
    it('at p=0, current is opaque at scale 1, next is transparent at scale 0.7', () => {
      const v = computeVisuals('zoom', 0);
      expect(v.current.opacity).toBe(1.0);
      expect(v.next.opacity).toBe(0.0);
      expect(v.current.scale).toBe(1.0);
      expect(v.next.scale).toBeCloseTo(0.7);
    });

    it('at p=1.0, current is transparent and scaled up, next is opaque at scale 1', () => {
      const v = computeVisuals('zoom', 1.0);
      expect(v.current.opacity).toBe(0.0);
      expect(v.next.opacity).toBe(1.0);
      expect(v.current.scale).toBeCloseTo(1.3);
      expect(v.next.scale).toBeCloseTo(1.0);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('all transitions produce valid visuals at boundaries', () => {
      for (const t of CONCRETE_TRANSITIONS) {
        const v0 = computeVisuals(t, 0);
        const v1 = computeVisuals(t, 1.0);
        // At start, current should be visible
        expect(v0.current.opacity).toBeGreaterThanOrEqual(0);
        expect(v0.current.opacity).toBeLessThanOrEqual(1);
        // At end, next should be visible
        expect(v1.next.opacity).toBeGreaterThanOrEqual(0);
        expect(v1.next.opacity).toBeLessThanOrEqual(1);
      }
    });

    it('progress values are clamped — no NaN or Infinity', () => {
      for (const t of CONCRETE_TRANSITIONS) {
        const v = computeVisuals(t, 0.5);
        expect(Number.isFinite(v.current.offsetX)).toBe(true);
        expect(Number.isFinite(v.current.offsetY)).toBe(true);
        expect(Number.isFinite(v.current.scale)).toBe(true);
        expect(Number.isFinite(v.next.offsetX)).toBe(true);
        expect(Number.isFinite(v.next.offsetY)).toBe(true);
        expect(Number.isFinite(v.next.scale)).toBe(true);
      }
    });
  });
});

describe('slideshow/core — pickTransition', () => {
  it('returns the same transition when not "random"', () => {
    expect(pickTransition('crossfade')).toBe('crossfade');
    expect(pickTransition('slideLeft')).toBe('slideLeft');
    expect(pickTransition('zoom')).toBe('zoom');
  });

  it('returns a concrete transition when "random"', () => {
    for (let i = 0; i < 20; i++) {
      const t = pickTransition('random');
      expect(CONCRETE_TRANSITIONS).toContain(t);
    }
  });
});

describe('slideshow/core — getNextDuration', () => {
  it('returns staticDuration in static mode', () => {
    expect(getNextDuration('static', 5.0, 3, 8)).toBe(5.0);
  });

  it('clamps to minimum 0.1s', () => {
    expect(getNextDuration('static', 0, 3, 8)).toBe(0.1);
    expect(getNextDuration('static', -5, 3, 8)).toBe(0.1);
  });

  it('returns a value within range in random mode', () => {
    for (let i = 0; i < 50; i++) {
      const d = getNextDuration('random', 5, 3, 8);
      expect(d).toBeGreaterThanOrEqual(3);
      expect(d).toBeLessThanOrEqual(8);
    }
  });
});

describe('slideshow/core — getNextIndex', () => {
  it('returns 0 for single item', () => {
    expect(getNextIndex(0, 1, 'sequential')).toBe(0);
    expect(getNextIndex(0, 1, 'random')).toBe(0);
  });

  it('advances sequentially with wrap', () => {
    expect(getNextIndex(0, 3, 'sequential')).toBe(1);
    expect(getNextIndex(1, 3, 'sequential')).toBe(2);
    expect(getNextIndex(2, 3, 'sequential')).toBe(0); // wraps
  });

  it('random never returns the same index', () => {
    for (let i = 0; i < 50; i++) {
      const next = getNextIndex(2, 5, 'random');
      expect(next).not.toBe(2);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(5);
    }
  });
});

describe('slideshow/core — DEFAULT_VISUALS & HIDDEN_VISUALS', () => {
  it('DEFAULT_VISUALS is fully visible at origin', () => {
    expect(DEFAULT_VISUALS).toEqual({ opacity: 1, offsetX: 0, offsetY: 0, scale: 1 });
  });

  it('HIDDEN_VISUALS is fully transparent at origin', () => {
    expect(HIDDEN_VISUALS).toEqual({ opacity: 0, offsetX: 0, offsetY: 0, scale: 1 });
  });
});

import { describe, it, expect } from 'vitest';
import {
  computeBars,
  grainValueAt,
  cinemaSubtitleStyle,
  BAR_FRACTION,
  GRAIN_ALPHA,
  GRAIN_DENSITY,
} from './cinemaSubtitle';
import type { StyleFrameContext } from '../StyleRegistry';

function frame(overrides: Partial<StyleFrameContext> = {}): StyleFrameContext {
  return {
    time: 12.5,
    audio: { bass: 0, mid: 0, high: 0, energy: 0 },
    width: 1920,
    height: 1080,
    renderScale: 1,
    fontSizePx: 64,
    ...overrides,
  };
}

describe('cinemaSubtitle', () => {
  it('registers id/name and the overlay hook; per-word is identity, no line hook', () => {
    expect(cinemaSubtitleStyle.id).toBe('cinema-subtitle');
    expect(cinemaSubtitleStyle.name).toBe('Cinema Subtitle');
    expect(typeof cinemaSubtitleStyle.drawOverlay).toBe('function');
    expect(cinemaSubtitleStyle.modifyLine).toBeUndefined();
    expect(cinemaSubtitleStyle.modifyWord({} as never)).toEqual({});
  });

  it('exposes sane bounded constants', () => {
    expect(BAR_FRACTION).toBeGreaterThan(0);
    expect(BAR_FRACTION).toBeLessThan(0.5); // two bars must not cover the frame
    expect(GRAIN_ALPHA).toBeGreaterThan(0);
    expect(GRAIN_ALPHA).toBeLessThanOrEqual(1);
    expect(GRAIN_DENSITY).toBeGreaterThan(0);
    expect(GRAIN_DENSITY).toBeLessThanOrEqual(1);
  });

  describe('computeBars', () => {
    it('top bar hugs y=0 and is BAR_FRACTION*height tall', () => {
      const f = frame();
      const bars = computeBars(f);
      expect(bars.topY).toBe(0);
      expect(bars.topH).toBeCloseTo(BAR_FRACTION * f.height, 6);
    });

    it('bottom bar hugs the bottom edge and is BAR_FRACTION*height tall', () => {
      const f = frame();
      const bars = computeBars(f);
      expect(bars.bottomH).toBeCloseTo(BAR_FRACTION * f.height, 6);
      expect(bars.bottomY).toBeCloseTo(f.height - BAR_FRACTION * f.height, 6);
      // bottom bar's lower edge reaches exactly the frame bottom
      expect(bars.bottomY + bars.bottomH).toBeCloseTo(f.height, 6);
    });

    it('the two bars never overlap (leave a visible middle band)', () => {
      const f = frame();
      const bars = computeBars(f);
      expect(bars.topY + bars.topH).toBeLessThan(bars.bottomY);
    });

    it('scales bar height with the frame height', () => {
      const small = computeBars(frame({ height: 500 }));
      const large = computeBars(frame({ height: 2160 }));
      expect(small.topH).toBeCloseTo(BAR_FRACTION * 500, 6);
      expect(large.topH).toBeCloseTo(BAR_FRACTION * 2160, 6);
      expect(large.topH).toBeGreaterThan(small.topH);
    });
  });

  describe('grainValueAt', () => {
    it('returns a value in [0, 1] across a spread of inputs', () => {
      for (let x = 0; x < 200; x += 17) {
        for (let y = 0; y < 200; y += 13) {
          for (const t of [0, 0.5, 3.14159, 42, 1234.567]) {
            const v = grainValueAt(x, y, t);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
            expect(Number.isFinite(v)).toBe(true);
          }
        }
      }
    });

    it('is deterministic for identical inputs (export parity)', () => {
      expect(grainValueAt(10, 20, 5)).toBe(grainValueAt(10, 20, 5));
      expect(grainValueAt(123, 456, 7.89)).toBe(grainValueAt(123, 456, 7.89));
      // Not a coincidence of a single call: many repeats agree.
      const first = grainValueAt(999, 111, 2.5);
      for (let i = 0; i < 50; i++) {
        expect(grainValueAt(999, 111, 2.5)).toBe(first);
      }
    });

    it('varies with time at a fixed pixel', () => {
      const pixel = { x: 64, y: 128 };
      const samples = new Set<number>();
      for (let t = 0; t < 2; t += 0.05) {
        samples.add(grainValueAt(pixel.x, pixel.y, t));
      }
      // Distinct grain values over the time sweep — grain shimmers.
      expect(samples.size).toBeGreaterThan(10);
    });

    it('varies across space at a fixed time', () => {
      const t = 3.0;
      const samples = new Set<number>();
      for (let x = 0; x < 40; x++) {
        samples.add(grainValueAt(x, x * 2, t));
      }
      expect(samples.size).toBeGreaterThan(10);
    });

    it('is roughly uniformly distributed (mean near 0.5)', () => {
      let sum = 0;
      let n = 0;
      for (let x = 0; x < 100; x++) {
        for (let y = 0; y < 100; y++) {
          sum += grainValueAt(x, y, 1.0);
          n++;
        }
      }
      const mean = sum / n;
      expect(mean).toBeGreaterThan(0.4);
      expect(mean).toBeLessThan(0.6);
    });
  });

  describe('drawOverlay', () => {
    it('draws two filled bars and some grain onto a fake context', () => {
      const fillRects: Array<[number, number, number, number]> = [];
      const fakeCtx = {
        save() {},
        restore() {},
        fillRect(x: number, y: number, w: number, h: number) {
          fillRects.push([x, y, w, h]);
        },
        set fillStyle(_v: string) {},
        get fillStyle() {
          return '#000000';
        },
        globalAlpha: 1,
      } as unknown as CanvasRenderingContext2D;

      const f = frame({ width: 320, height: 180 });
      cinemaSubtitleStyle.drawOverlay!(fakeCtx, f);

      // First two fillRects are the letterbox bars spanning the full width.
      expect(fillRects.length).toBeGreaterThanOrEqual(2);
      const [top, bottom] = fillRects;
      expect(top[0]).toBe(0);
      expect(top[1]).toBe(0);
      expect(top[2]).toBe(f.width);
      expect(top[3]).toBeCloseTo(BAR_FRACTION * f.height, 6);
      expect(bottom[2]).toBe(f.width);
      expect(bottom[3]).toBeCloseTo(BAR_FRACTION * f.height, 6);
      // Grain specks were drawn beyond the two bars.
      expect(fillRects.length).toBeGreaterThan(2);
    });
  });
});

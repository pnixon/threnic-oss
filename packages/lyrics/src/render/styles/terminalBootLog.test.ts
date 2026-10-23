import { describe, it, expect } from 'vitest';
import {
  computeTypeOn,
  scanlineRows,
  scanlineStepPx,
  terminalBootLogStyle,
  SCANLINE_STEP,
  SCANLINE_ALPHA,
  TYPEON_FRACTION,
  PHOSPHOR_ALPHA,
} from './terminalBootLog';
import type { StyleWordContext, StyleFrameContext } from '../StyleRegistry';

function wordCtx(time: number, opts: Partial<StyleWordContext> = {}): StyleWordContext {
  const wordStart = opts.wordStart ?? 10;
  const wordEnd = opts.wordEnd ?? 12;
  return {
    time,
    audio: { bass: 0, mid: 0, high: 0, energy: 0 },
    wordStart,
    wordEnd,
    wordIndex: opts.wordIndex ?? 0,
    wordCount: opts.wordCount ?? 4,
    isActive: opts.isActive ?? (time >= wordStart && time <= wordEnd),
  };
}

function frameCtx(opts: Partial<StyleFrameContext> = {}): StyleFrameContext {
  return {
    time: 10,
    audio: { bass: 0, mid: 0, high: 0, energy: 0 },
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    renderScale: opts.renderScale ?? 1,
    fontSizePx: opts.fontSizePx ?? 48,
  };
}

describe('terminalBootLog', () => {
  it('registers id/name and both hooks', () => {
    expect(terminalBootLogStyle.id).toBe('terminal-boot-log');
    expect(terminalBootLogStyle.name).toBe('Terminal Boot-Log');
    expect(typeof terminalBootLogStyle.modifyWord).toBe('function');
    expect(typeof terminalBootLogStyle.drawOverlay).toBe('function');
  });

  it('exports sane constants', () => {
    expect(SCANLINE_STEP).toBeGreaterThan(0);
    expect(SCANLINE_ALPHA).toBeGreaterThan(0);
    expect(SCANLINE_ALPHA).toBeLessThan(1);
    expect(TYPEON_FRACTION).toBeGreaterThan(0);
    expect(TYPEON_FRACTION).toBeLessThanOrEqual(1);
    expect(PHOSPHOR_ALPHA).toBeGreaterThan(0);
    expect(PHOSPHOR_ALPHA).toBeLessThan(1);
  });

  describe('computeTypeOn', () => {
    it('contributes no delta for an inactive word', () => {
      expect(computeTypeOn(wordCtx(5, { isActive: false }))).toEqual({});
      expect(computeTypeOn(wordCtx(20, { isActive: false }))).toEqual({});
    });

    it('opacity ramps 0→1 monotonically over the type-on window', () => {
      const start = 10;
      const end = 12;
      const window = (end - start) * TYPEON_FRACTION; // 0.7s
      let prev = -1;
      // sample across [start, start+window]
      for (let i = 0; i <= 10; i++) {
        const t = start + (window * i) / 10;
        const o = computeTypeOn(wordCtx(t, { wordStart: start, wordEnd: end })).opacityMul!;
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(1);
        expect(o).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = o;
      }
    });

    it('opacity is 0 at word start and 1 at the end of the ramp', () => {
      const start = 10;
      const end = 12;
      const window = (end - start) * TYPEON_FRACTION;
      expect(
        computeTypeOn(wordCtx(start, { wordStart: start, wordEnd: end })).opacityMul,
      ).toBeCloseTo(0, 6);
      expect(
        computeTypeOn(wordCtx(start + window, { wordStart: start, wordEnd: end })).opacityMul,
      ).toBeCloseTo(1, 6);
    });

    it('opacity stays 1 after the ramp for the rest of the active window', () => {
      const start = 10;
      const end = 12;
      const window = (end - start) * TYPEON_FRACTION;
      const mid = start + window + (end - start - window) / 2;
      expect(computeTypeOn(wordCtx(mid, { wordStart: start, wordEnd: end })).opacityMul).toBe(1);
      expect(computeTypeOn(wordCtx(end, { wordStart: start, wordEnd: end })).opacityMul).toBe(1);
    });

    it('left offset settles to 0 as the word types in', () => {
      const start = 10;
      const end = 12;
      const window = (end - start) * TYPEON_FRACTION;
      const x0 = computeTypeOn(wordCtx(start, { wordStart: start, wordEnd: end })).offsetXEm!;
      const xMid = computeTypeOn(
        wordCtx(start + window / 2, { wordStart: start, wordEnd: end }),
      ).offsetXEm!;
      const xEnd = computeTypeOn(
        wordCtx(start + window, { wordStart: start, wordEnd: end }),
      ).offsetXEm!;
      expect(x0).toBeLessThan(0); // offset left at the start
      expect(xMid).toBeGreaterThan(x0); // settling toward 0
      expect(xEnd).toBeCloseTo(0, 6); // settled
    });

    it('handles a zero-length active window without NaN', () => {
      const m = computeTypeOn(wordCtx(10, { wordStart: 10, wordEnd: 10, isActive: true }));
      expect(m.opacityMul).toBe(1);
      expect(Number.isNaN(m.opacityMul!)).toBe(false);
    });
  });

  describe('scanlineRows / scanlineStepPx', () => {
    it('step is floored at 2px and scales with renderScale', () => {
      // renderScale 1 → SCANLINE_STEP
      expect(scanlineStepPx(frameCtx({ renderScale: 1 }))).toBe(SCANLINE_STEP);
      // renderScale 2 → doubled
      expect(scanlineStepPx(frameCtx({ renderScale: 2 }))).toBe(SCANLINE_STEP * 2);
      // tiny renderScale can't drop below the 2px floor
      expect(scanlineStepPx(frameCtx({ renderScale: 0.1 }))).toBeGreaterThanOrEqual(2);
    });

    it('spacing between rows is uniform and >= the floor', () => {
      const frame = frameCtx({ height: 1080, renderScale: 1 });
      const rows = scanlineRows(frame);
      const step = scanlineStepPx(frame);
      expect(step).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i] - rows[i - 1]).toBe(step);
      }
    });

    it('rows cover the frame (first near top, last near bottom) and stay in bounds', () => {
      const frame = frameCtx({ height: 1080, renderScale: 1 });
      const rows = scanlineRows(frame);
      const step = scanlineStepPx(frame);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toBe(step); // first line at one step down
      expect(rows[rows.length - 1]).toBeLessThan(frame.height);
      expect(rows[rows.length - 1]).toBeGreaterThanOrEqual(frame.height - step);
      for (const y of rows) {
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(frame.height);
      }
    });

    it('row count matches floor((height - 1) / step) style spacing', () => {
      const frame = frameCtx({ height: 1000, renderScale: 1 });
      const step = scanlineStepPx(frame);
      const rows = scanlineRows(frame);
      // rows are at step, 2*step, ... < height
      const expected = Math.ceil(frame.height / step) - 1;
      expect(rows.length).toBe(expected);
    });

    it('count scales inversely with renderScale (fewer, wider lines at higher scale)', () => {
      const lo = scanlineRows(frameCtx({ height: 2160, renderScale: 1 })).length;
      const hi = scanlineRows(frameCtx({ height: 2160, renderScale: 2 })).length;
      expect(hi).toBeLessThan(lo);
    });

    it('returns no rows for a degenerate (zero/negative) height', () => {
      expect(scanlineRows(frameCtx({ height: 0 }))).toEqual([]);
      expect(scanlineRows(frameCtx({ height: -100 }))).toEqual([]);
    });
  });

  describe('drawOverlay', () => {
    it('paints a phosphor tint fill plus one fill per scanline without throwing', () => {
      const frame = frameCtx({ width: 400, height: 300, renderScale: 1 });
      const fills: Array<[number, number, number, number]> = [];
      let saves = 0;
      let restores = 0;
      const fake = {
        save() {
          saves++;
        },
        restore() {
          restores++;
        },
        fillRect(x: number, y: number, w: number, h: number) {
          fills.push([x, y, w, h]);
        },
        set globalAlpha(_v: number) {},
        set fillStyle(_v: string) {},
      } as unknown as CanvasRenderingContext2D;

      terminalBootLogStyle.drawOverlay!(fake, frame);

      expect(saves).toBe(1);
      expect(restores).toBe(1);
      // one full-frame phosphor fill + one per scanline row
      const rows = scanlineRows(frame);
      expect(fills.length).toBe(1 + rows.length);
      // first fill is the full-frame tint
      expect(fills[0]).toEqual([0, 0, frame.width, frame.height]);
      // scanline fills span the full width, 1px tall
      for (let i = 1; i < fills.length; i++) {
        expect(fills[i][0]).toBe(0);
        expect(fills[i][2]).toBe(frame.width);
        expect(fills[i][3]).toBe(1);
      }
    });
  });
});

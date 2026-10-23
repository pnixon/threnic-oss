/**
 * Layout regression: horizontal anchor + wrap-width column.
 *
 * `getPositionedLines` is the single layout result shared by the Canvas2D draw
 * path and the GPU Lyric FX driver, so asserting on it guards both. We stub
 * measureText so happy-dom yields deterministic word widths (it otherwise
 * reports width 0, which would collapse every anchor to the same x).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CanvasLyricRenderer } from './CanvasLyricRenderer';
import type { LyricLineData, LyricTheme } from '../types/core';

const WIDTH = 1000;
const HEIGHT = 1000;
const TIME = 1.0; // inside the line's active window

const LINE: LyricLineData = {
  id: 'l1',
  text: 'hello world',
  start: 0,
  end: 5,
  words: [
    { text: 'hello', start: 0, end: 2 },
    { text: 'world', start: 2, end: 5 },
  ],
};

const BASE_THEME: LyricTheme = {
  fontId: 'x',
  fontSize: 0.5,
  effect: 'none',
  audioReactive: false,
};

// Deterministic metrics: width ∝ text length. happy-dom returns null from
// getContext('2d'), so we install a minimal fake 2D context carrying just the
// members the layout path touches (font, letterSpacing, measureText).
let restore: (() => void) | null = null;
beforeEach(() => {
  const fakeCtx = {
    font: '',
    letterSpacing: '',
    fontKerning: '',
    measureText(t: string) {
      return { width: (t?.length ?? 0) * 20 } as TextMetrics;
    },
  };
  type CanvasCtorLike = { prototype: { getContext: (...args: unknown[]) => unknown } };
  const canvasGlobals = globalThis as unknown as {
    HTMLCanvasElement?: CanvasCtorLike;
    OffscreenCanvas?: CanvasCtorLike;
  };
  const HC = canvasGlobals.HTMLCanvasElement;
  const OC = canvasGlobals.OffscreenCanvas;
  const origHC = HC?.prototype?.getContext;
  const origOC = OC?.prototype?.getContext;
  if (HC) HC.prototype.getContext = () => fakeCtx;
  if (OC) OC.prototype.getContext = () => fakeCtx;
  restore = () => {
    if (HC && origHC) HC.prototype.getContext = origHC;
    if (OC && origOC) OC.prototype.getContext = origOC;
  };
});
afterEach(() => {
  restore?.();
  restore = null;
});

function leftmostX(theme: LyricTheme): number {
  const r = new CanvasLyricRenderer({ lyrics: [LINE], theme });
  const lines = r.getPositionedLines(TIME, WIDTH, HEIGHT);
  const xs = lines.flatMap((l) => l.words.map((w) => w.x));
  return Math.min(...xs);
}

describe('CanvasLyricRenderer — horizontal anchor', () => {
  it('left-anchored rows sit further left than centre, which sits further left than right', () => {
    const left = leftmostX({ ...BASE_THEME, horizontalPosition: 'left' });
    const center = leftmostX({ ...BASE_THEME, horizontalPosition: 'center' });
    const right = leftmostX({ ...BASE_THEME, horizontalPosition: 'right' });
    expect(left).toBeLessThan(center);
    expect(center).toBeLessThan(right);
  });

  it('defaults to centre when horizontalPosition is unset', () => {
    const dflt = leftmostX({ ...BASE_THEME });
    const center = leftmostX({ ...BASE_THEME, horizontalPosition: 'center' });
    expect(dflt).toBeCloseTo(center, 5);
  });

  it('left-anchored text reaches the 10% edge buffer regardless of wrapWidth', () => {
    // `w.x` from getPositionedLines is the word CENTRE (draw does centerX + px,
    // px = word centre). The first word "hello" is 5×20 = 100px wide, so its
    // left EDGE is x - 50 and must land on the 10% margin (0.10 * 1000 = 100),
    // NOT a wrapWidth-based inset — that inset was the "unused 25%" bug.
    const halfFirstWord = 50;
    const at90 = leftmostX({ ...BASE_THEME, horizontalPosition: 'left', wrapWidth: 90 });
    const at50 = leftmostX({ ...BASE_THEME, horizontalPosition: 'left', wrapWidth: 50 });
    const marginPx = WIDTH * 0.1;
    expect(at90 - halfFirstWord).toBeCloseTo(marginPx, 0);
    expect(at50).toBeCloseTo(at90, 5); // wrapWidth does not move the anchor
  });
});

describe('CanvasLyricRenderer — wrap width', () => {
  const LONG = 'aaaaa bbbbb ccccc ddddd eeeee fffff ggggg hhhhh';
  const longLine = (): LyricLineData => ({
    id: 'long',
    text: LONG,
    start: 0,
    end: 5,
    words: LONG.split(' ').map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.5 })),
  });

  function rowCount(theme: LyricTheme): number {
    const r = new CanvasLyricRenderer({ lyrics: [longLine()], theme });
    const lines = r.getPositionedLines(TIME, WIDTH, HEIGHT);
    return new Set(lines.flatMap((l) => l.words.map((w) => Math.round(w.y)))).size;
  }

  it('wraps a long line onto multiple rows when it exceeds the column', () => {
    // The GPU driver groups positioned words by their y into per-row glyph
    // lines, so distinct y values are exactly what makes the GPU path wrap.
    expect(rowCount({ ...BASE_THEME, wrapWidth: 30 })).toBeGreaterThan(1);
  });

  it('a narrower wrap column wraps into at least as many rows as a wider one', () => {
    const wide = rowCount({ ...BASE_THEME, wrapWidth: 100 });
    const narrow = rowCount({ ...BASE_THEME, wrapWidth: 30 });
    expect(narrow).toBeGreaterThanOrEqual(wide);
  });
});

describe('CanvasLyricRenderer — deterministic canvas rect + aspect tracking', () => {
  it('exposes a rect with 10% edge margins derived from the canvas size', () => {
    const r = new CanvasLyricRenderer({ lyrics: [LINE], theme: BASE_THEME });
    expect(r.getCanvasRect()).toBeNull(); // nothing computed yet
    r.getPositionedLines(TIME, 1920, 1080);
    const rect = r.getCanvasRect()!;
    expect(rect.width).toBe(1920);
    expect(rect.height).toBe(1080);
    expect(rect.aspect).toBeCloseTo(1920 / 1080, 6);
    expect(rect.marginLeft).toBeCloseTo(192, 3); // 10% of 1920
    expect(rect.marginTop).toBeCloseTo(108, 3); // 10% of 1080
  });

  it('latches an aspect change once (read clears it) and not on same-aspect resize', () => {
    const r = new CanvasLyricRenderer({ lyrics: [LINE], theme: BASE_THEME });
    r.getPositionedLines(TIME, 1000, 1000); // first frame establishes aspect
    expect(r.didAspectChange()).toBe(false); // first frame is not a change

    // Same aspect (1:1), larger canvas → NOT an aspect change.
    r.getPositionedLines(TIME, 2000, 2000);
    expect(r.didAspectChange()).toBe(false);

    // Landscape → portrait: a real aspect change, latched once.
    r.getPositionedLines(TIME, 1080, 1920);
    expect(r.didAspectChange()).toBe(true);
    expect(r.didAspectChange()).toBe(false); // read cleared the latch
  });
});

describe('CanvasLyricRenderer — vertical safe area', () => {
  it('keeps a wrapped, bottom-anchored line inside the bottom 10% buffer', () => {
    // A line that wraps into a few rows, anchored near the bottom (worst case
    // for bottom overflow). The block fits within the 80% safe area, so the
    // clamp must keep every word above the bottom edge (canvasH - 10%).
    const LONG = 'aaaaa bbbbb ccccc ddddd eeeee fffff';
    const longLine: LyricLineData = {
      id: 'v',
      text: LONG,
      start: 0,
      end: 5,
      words: LONG.split(' ').map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.4 })),
    };
    const H = 1000;
    const r = new CanvasLyricRenderer({
      lyrics: [longLine],
      // fontSize 0.4 → 40px rows; wrapWidth 40 → a few rows; vertical 0 =
      // bottom-anchored. The block fits the safe area, so the clamp holds it in.
      theme: { ...BASE_THEME, fontSize: 0.4, wrapWidth: 40, verticalPosition: 0 },
    });
    const lines = r.getPositionedLines(TIME, 1000, H);
    const bottomEdge = H - H * 0.1; // canvasH - 10% buffer
    const maxY = Math.max(...lines.flatMap((l) => l.words.map((w) => w.y)));
    expect(maxY).toBeLessThanOrEqual(bottomEdge);
  });

  it('Position Y=0 anchors the block bottom near the bottom edge (uses the space)', () => {
    // Regression for "wasting vertical space at Y=0": the block's lowest
    // baseline should sit close to the bottom safe edge, not centred high up.
    const H = 1000;
    const r = new CanvasLyricRenderer({
      lyrics: [LINE],
      theme: { ...BASE_THEME, fontSize: 0.5, verticalPosition: 0 },
    });
    const lines = r.getPositionedLines(TIME, 1000, H);
    const bottomEdge = H - H * 0.1; // 900
    const maxY = Math.max(...lines.flatMap((l) => l.words.map((w) => w.y)));
    // Within one line-height of the bottom edge, and never past it.
    const gap = 0.5 * (H / 10) * 1.35; // fontSizePx * lineSpacing
    expect(maxY).toBeLessThanOrEqual(bottomEdge);
    expect(maxY).toBeGreaterThan(bottomEdge - gap - 1);
  });

  it('a future line does not drag the current line up from the bottom at Y=0', () => {
    // Two lines: current (active at TIME) and a later one. The later line stacks
    // BELOW and is meant to be off-screen; it must not trigger a clamp that
    // pulls the current line toward centre. The current line stays at the bottom.
    const H = 1000;
    const cur: LyricLineData = {
      id: 'cur',
      text: 'now playing',
      start: 0,
      end: 2,
      words: [
        { text: 'now', start: 0, end: 1 },
        { text: 'playing', start: 1, end: 2 },
      ],
    };
    const next: LyricLineData = {
      id: 'next',
      text: 'coming up',
      start: 2.2,
      end: 4,
      words: [
        { text: 'coming', start: 2.2, end: 3 },
        { text: 'up', start: 3, end: 4 },
      ],
    };
    const r = new CanvasLyricRenderer({
      lyrics: [cur, next],
      theme: { ...BASE_THEME, fontSize: 0.5, verticalPosition: 0 },
    });
    const lines = r.getPositionedLines(1.0, 1000, H); // current line active
    const curLine = lines.find((l) => l.lineIndex === 0)!;
    const curMaxY = Math.max(...curLine.words.map((w) => w.y));
    const bottomEdge = H - H * 0.1;
    const gap = 0.5 * (H / 10) * 1.35;
    // Current line still hugs the bottom despite the next line stacked below it.
    expect(curMaxY).toBeGreaterThan(bottomEdge - gap - 1);
    expect(curMaxY).toBeLessThanOrEqual(bottomEdge);
  });

  it('lineSpacing widens the vertical gap between wrapped rows', () => {
    const LONG = 'aaaaa bbbbb ccccc ddddd eeeee fffff';
    const mk = (lineSpacing: number) => {
      const r = new CanvasLyricRenderer({
        lyrics: [
          {
            id: 'g',
            text: LONG,
            start: 0,
            end: 5,
            words: LONG.split(' ').map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.4 })),
          },
        ],
        theme: { ...BASE_THEME, fontSize: 0.4, wrapWidth: 40, lineSpacing },
      });
      const lines = r.getPositionedLines(TIME, 1000, 1000);
      const ys = [...new Set(lines.flatMap((l) => l.words.map((w) => Math.round(w.y))))].sort(
        (a, b) => a - b,
      );
      return ys.length >= 2 ? ys[1] - ys[0] : 0; // gap between first two rows
    };
    const tight = mk(1.2);
    const loose = mk(2.2);
    expect(tight).toBeGreaterThan(0);
    expect(loose).toBeGreaterThan(tight);
  });
});

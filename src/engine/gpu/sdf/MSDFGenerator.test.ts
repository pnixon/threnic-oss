import { describe, it, expect } from 'vitest';
import { computeMSDF, median3 } from './MSDFGenerator';

/**
 * Build a filled axis-aligned rectangle bitmap (1 = inside) of the given size,
 * with the rectangle inset by `inset` on every edge.
 */
function rectBitmap(w: number, h: number, inset: number): Uint8Array {
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= inset && x < w - inset && y >= inset && y < h - inset;
      b[y * w + x] = inside ? 1 : 0;
    }
  }
  return b;
}

/** Decode one channel byte back to a signed distance in [-1, +1] * spread units. */
function decode(byte: number): number {
  return byte / 255 - 0.5; // >0 inside, <0 outside, 0 == boundary
}

const SPREAD = 6;

describe('median3', () => {
  it('returns the middle value regardless of argument order', () => {
    expect(median3(1, 2, 3)).toBe(2);
    expect(median3(3, 1, 2)).toBe(2);
    expect(median3(2, 3, 1)).toBe(2);
    expect(median3(5, 5, 1)).toBe(5);
    expect(median3(0.2, 0.8, 0.5)).toBeCloseTo(0.5, 9);
  });
});

describe('computeMSDF', () => {
  const W = 32;
  const H = 32;
  const bitmap = rectBitmap(W, H, 8); // rectangle from (8,8) to (24,24)
  const { data } = computeMSDF(bitmap, W, H, SPREAD);

  const px = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  const medAt = (x: number, y: number) => {
    const p = px(x, y);
    return median3(p.r, p.g, p.b);
  };

  it('produces an RGBA buffer of width*height*4 bytes', () => {
    expect(data.length).toBe(W * H * 4);
  });

  it('marks every pixel opaque (A = 255)', () => {
    for (let i = 0; i < W * H; i++) {
      expect(data[i * 4 + 3]).toBe(255);
    }
  });

  it('median is > 0.5 (>128) well inside the glyph', () => {
    // Centre of the 16x16 rectangle.
    expect(medAt(16, 16)).toBeGreaterThan(128);
  });

  it('median is < 0.5 (<128) well outside the glyph', () => {
    // A corner of the bitmap, far outside the rectangle.
    expect(medAt(1, 1)).toBeLessThan(128);
  });

  it('median crosses ~0.5 (128) at the boundary edge', () => {
    // The left edge of the rect sits between x=7 (outside) and x=8 (inside)
    // at the vertical midpoint. The nearest boundary pixel median is near 128.
    const outside = medAt(6, 16);
    const inside = medAt(10, 16);
    expect(outside).toBeLessThan(128);
    expect(inside).toBeGreaterThan(128);
    // Monotone across the edge.
    expect(inside).toBeGreaterThan(outside);
  });

  it('every channel independently honours the sign convention inside', () => {
    const p = px(16, 16);
    expect(decode(p.r)).toBeGreaterThan(0);
    expect(decode(p.g)).toBeGreaterThan(0);
    expect(decode(p.b)).toBeGreaterThan(0);
  });

  it('is deterministic — same input yields identical bytes', () => {
    const again = computeMSDF(bitmap, W, H, SPREAD).data;
    expect(Array.from(again)).toEqual(Array.from(data));
  });

  it('handles a degenerate empty bitmap without throwing', () => {
    const empty = new Uint8Array(W * H); // all outside
    const res = computeMSDF(empty, W, H, SPREAD);
    expect(res.data.length).toBe(W * H * 4);
    // No contour → fully outside → median below boundary everywhere.
    expect(median3(res.data[0], res.data[1], res.data[2])).toBeLessThanOrEqual(128);
  });

  it('preserves a corner: the median stays sharp at the rectangle corner', () => {
    // Just inside the top-left corner of the rect (8,8): the corner pixel is
    // inside, its immediate diagonal-outside neighbour is outside. A rounded
    // (single-scalar) field would blur this; the median should keep the
    // inside pixel clearly inside.
    expect(medAt(9, 9)).toBeGreaterThan(128);
    expect(medAt(6, 6)).toBeLessThan(128);
  });
});

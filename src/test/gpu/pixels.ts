/** Pixel comparison helpers for the GPU rendering tests. */

export interface PixelDiff {
  badPixels: number;
  badRatio: number;
  maxDelta: number;
  /** "x,y" of the first differing pixel, for failure messages. */
  firstBad: string | null;
}

/** Compare two RGBA buffers; a pixel is bad when any channel differs by more than `tolerance`. */
export function comparePixels(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
): PixelDiff {
  let badPixels = 0;
  let maxDelta = 0;
  let firstBad: string | null = null;
  if (a.length !== b.length || a.length !== width * height * 4) {
    return { badPixels: width * height, badRatio: 1, maxDelta: 255, firstBad: 'size mismatch' };
  }
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    if (d > maxDelta) maxDelta = d;
    if (d > tolerance) {
      badPixels++;
      if (!firstBad) firstBad = `${(i / 4) % width},${Math.floor(i / 4 / width)}`;
    }
  }
  return { badPixels, badRatio: badPixels / (width * height), maxDelta, firstBad };
}

export interface ImageStats {
  /** Mean of R, G, B over all pixels, 0–255. */
  mean: number;
  /** Standard deviation of luma — near 0 for a flat image. */
  stddev: number;
  /** Share of pixels that are not (near) black. */
  litRatio: number;
}

export function imageStats(px: Uint8Array | Uint8ClampedArray): ImageStats {
  const n = px.length / 4;
  let sum = 0;
  let sumSq = 0;
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
    sum += l;
    sumSq += l * l;
    if (l > 12) lit++;
  }
  const mean = sum / n;
  return { mean, stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)), litRatio: lit / n };
}

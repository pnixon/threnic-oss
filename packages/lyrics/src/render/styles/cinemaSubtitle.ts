/**
 * Style: Cinema subtitle.
 *
 * A full-frame OVERLAY style — the lyrics themselves render normally (identity
 * per-word modifier, no per-line modifier). The cinematic look is drawn on top
 * of the finished frame via `drawOverlay`:
 *   1. Letterbox bars: solid black rectangles at the top and bottom of the
 *      frame, each `BAR_FRACTION` of the canvas height.
 *   2. Film grain: faint, low-alpha noise specks scattered across the whole
 *      frame.
 *
 * Export-parity by construction: the grain is derived from a DETERMINISTIC hash
 * of (x, y, time) — never `Math.random` — so the same media time always yields
 * the same grain, whether rendered live or during a frame-accurate export.
 */
import type {
  LyricStyle,
  StyleCanvasContext,
  StyleFrameContext,
  StyleWordModifier,
} from '../StyleRegistry';

/** Fraction of canvas height occupied by EACH letterbox bar (top and bottom). */
export const BAR_FRACTION = 0.12;
/** Peak alpha of a grain speck (0..1). Kept faint so type stays legible. */
export const GRAIN_ALPHA = 0.06;
/**
 * Grain speck density: fraction of a coarse noise grid cell area that carries a
 * speck. Higher ⇒ more specks. Combined with GRAIN_CELL to bound total specks.
 */
export const GRAIN_DENSITY = 0.12;
/** Size (device px) of one grain cell — grain is sampled on this coarse grid. */
const GRAIN_CELL = 3;

/** Geometry of the two letterbox bars for a given frame. */
export interface CinemaBars {
  topY: number;
  topH: number;
  bottomY: number;
  bottomH: number;
}

/**
 * Pure geometry helper: where the two black bars sit for this frame.
 * Top bar hugs y=0; bottom bar hugs the bottom edge. Each is
 * `BAR_FRACTION * height` tall.
 */
export function computeBars(frame: StyleFrameContext): CinemaBars {
  const barH = BAR_FRACTION * frame.height;
  return {
    topY: 0,
    topH: barH,
    bottomY: frame.height - barH,
    bottomH: barH,
  };
}

/**
 * Deterministic pseudo-random grain value in [0, 1] for a pixel at (x, y) and
 * a media time (seconds). Reproducible for identical inputs (export parity) and
 * varies with time so the grain shimmers frame-to-frame. Never uses Math.random.
 *
 * Implementation: a cheap integer hash (sin-free, avoids platform trig drift)
 * mixing the three inputs, folded to a fractional part.
 */
export function grainValueAt(x: number, y: number, time: number): number {
  // Quantise time to a frame-ish granularity so a single frame's grain is
  // stable across sub-pixel sampling, while still advancing over time.
  const t = Math.floor(time * 1000);
  // xorshift-style integer mixing. Force unsigned 32-bit at each step.
  let h = (Math.trunc(x) * 374761393 + Math.trunc(y) * 668265263 + t * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296; // 2^32 → [0, 1)
}

/**
 * Draw the letterbox bars for a frame. Isolated so it can be reasoned about /
 * tested independently of the grain pass.
 */
function drawBars(ctx: StyleCanvasContext, frame: StyleFrameContext): void {
  const bars = computeBars(frame);
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, bars.topY, frame.width, bars.topH);
  ctx.fillRect(0, bars.bottomY, frame.width, bars.bottomH);
  ctx.restore();
}

/**
 * Draw faint film grain across the whole frame using the deterministic hash.
 * Grain is sampled on a coarse `GRAIN_CELL` grid to bound the speck count; a
 * cell carries a speck only when its noise value clears the density threshold.
 */
function drawGrain(ctx: StyleCanvasContext, frame: StyleFrameContext): void {
  const cell = Math.max(1, Math.round(GRAIN_CELL * frame.renderScale));
  ctx.save();
  ctx.fillStyle = '#ffffff';
  for (let y = 0; y < frame.height; y += cell) {
    for (let x = 0; x < frame.width; x += cell) {
      const n = grainValueAt(x, y, frame.time);
      if (n < GRAIN_DENSITY) {
        // Modulate alpha within the speck so grain isn't uniform.
        ctx.globalAlpha = GRAIN_ALPHA * (n / GRAIN_DENSITY);
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
  ctx.restore();
}

export const cinemaSubtitleStyle: LyricStyle = {
  id: 'cinema-subtitle',
  name: 'Cinema Subtitle',
  // Lyrics render normally: no per-word or per-line modification.
  modifyWord: (): StyleWordModifier => ({}),
  drawOverlay(ctx: StyleCanvasContext, frame: StyleFrameContext): void {
    drawBars(ctx, frame);
    drawGrain(ctx, frame);
  },
};

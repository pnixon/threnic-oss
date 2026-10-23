/**
 * Style: Terminal boot-log.
 *
 * Two effects that together read as a booting terminal / CRT:
 *
 *   1. TYPE-ON (per word, `modifyWord`): the active word's characters appear to
 *      reveal left-to-right, like text being typed into a console. The seam CANNOT
 *      clip characters — `StyleWordModifier` only carries scale/offset/opacity/
 *      font-variation deltas, and `StyleWordContext` exposes no per-character or
 *      base-pixel data. So true left-to-right character clipping is NOT possible
 *      here; this is an HONEST APPROXIMATION: the word fades in quickly
 *      (opacityMul 0→1) over the first `TYPEON_FRACTION` of its active window,
 *      with a small left-side offset that settles to 0 as it "types in". A real
 *      per-char reveal would require a char-clip hook the seam does not have.
 *
 *   2. SCANLINES / PHOSPHOR (full frame, `drawOverlay`): after the lyrics are
 *      drawn, low-alpha dark horizontal lines are painted every `SCANLINE_STEP`
 *      DEVICE pixels (scaled by `frame.renderScale`, floored at 2px per the
 *      resolution-independence rule so they never collapse to sub-pixel moiré at
 *      high resolution), plus a faint green phosphor tint across the whole frame.
 *
 * Both hooks read only the per-frame time/audio contract, so preview == export
 * by construction.
 */
import type {
  LyricStyle,
  StyleWordContext,
  StyleWordModifier,
  StyleCanvasContext,
  StyleFrameContext,
} from '../StyleRegistry';

/** Spacing between scanlines, in DESIGN pixels (multiplied by renderScale). */
export const SCANLINE_STEP = 4;
/** Alpha of each dark scanline (0..1). Low so it reads as texture, not bars. */
export const SCANLINE_ALPHA = 0.18;
/** Fraction of a word's active window over which the type-on ramp completes. */
export const TYPEON_FRACTION = 0.35;
/** Alpha of the faint phosphor tint painted across the whole frame. */
export const PHOSPHOR_ALPHA = 0.06;

/** Minimum scanline spacing in device px (resolution-independence floor). */
const MIN_SCANLINE_STEP_PX = 2;
/** Left settle offset (em) at the very start of the type-on ramp. */
const TYPEON_OFFSET_EM = 0.25;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Per-word type-on modifier. During the first `TYPEON_FRACTION` of the word's
 * active window, opacity ramps 0→1 (monotonic) and a small left offset settles
 * to 0 — the closest the word/opacity seam can get to a terminal type-on. After
 * the ramp (and while active), the word is fully opaque with no offset. Before
 * the word starts or after it ends, no delta is contributed.
 */
export function computeTypeOn(ctx: StyleWordContext): StyleWordModifier {
  // Only the active word types on; inactive words are left to the base animation.
  if (!ctx.isActive) return {};

  const dur = ctx.wordEnd - ctx.wordStart;
  // Degenerate/zero-length window: nothing to ramp, show fully.
  if (!(dur > 0)) return { opacityMul: 1, offsetXEm: 0 };

  const window = dur * TYPEON_FRACTION;
  if (!(window > 0)) return { opacityMul: 1, offsetXEm: 0 };

  const elapsed = ctx.time - ctx.wordStart;
  const p = clamp01(elapsed / window); // 0 at word start → 1 at end of ramp

  return {
    opacityMul: p,
    // Starts offset left by TYPEON_OFFSET_EM, settles to 0 as it types in.
    offsetXEm: -TYPEON_OFFSET_EM * (1 - p),
  };
}

/** Effective scanline spacing in device px for a frame (floored). */
export function scanlineStepPx(frame: StyleFrameContext): number {
  const scaled = SCANLINE_STEP * (frame.renderScale > 0 ? frame.renderScale : 1);
  return Math.max(MIN_SCANLINE_STEP_PX, Math.round(scaled));
}

/**
 * Y positions (device px) of every scanline for a frame. Evenly spaced by
 * `scanlineStepPx`, starting at the first step and covering the full height.
 */
export function scanlineRows(frame: StyleFrameContext): number[] {
  const step = scanlineStepPx(frame);
  const rows: number[] = [];
  if (!(frame.height > 0) || !(step > 0)) return rows;
  for (let y = step; y < frame.height; y += step) {
    rows.push(y);
  }
  return rows;
}

/**
 * Draw the CRT overlay: a faint phosphor tint over the whole frame, then a dark
 * 1px scanline at each `scanlineRows` position.
 */
function drawOverlay(ctx: StyleCanvasContext, frame: StyleFrameContext): void {
  const { width, height } = frame;
  if (!(width > 0) || !(height > 0)) return;

  ctx.save();

  // Faint green phosphor tint across the whole frame.
  ctx.globalAlpha = PHOSPHOR_ALPHA;
  ctx.fillStyle = 'rgb(80, 255, 140)';
  ctx.fillRect(0, 0, width, height);

  // Dark horizontal scanlines.
  ctx.globalAlpha = SCANLINE_ALPHA;
  ctx.fillStyle = 'rgb(0, 0, 0)';
  for (const y of scanlineRows(frame)) {
    ctx.fillRect(0, y, width, 1);
  }

  ctx.restore();
}

export const terminalBootLogStyle: LyricStyle = {
  id: 'terminal-boot-log',
  name: 'Terminal Boot-Log',
  modifyWord: computeTypeOn,
  drawOverlay,
};

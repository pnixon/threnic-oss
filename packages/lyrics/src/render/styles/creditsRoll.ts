/**
 * Style: Credits roll.
 *
 * Film-end-credits presentation: the current line is the focus, and lines
 * further away (in either time direction) fade off — reading as a bottom-up
 * focus-scroll where each line settles at the focal band as it becomes current
 * and drifts out of attention afterward. The current line gets a subtle scale
 * "settle" (nudged up), while past/future lines dim progressively by their
 * distance from the current line.
 *
 * This is a LINE-level style (implements modifyLine). It is driven purely by the
 * line's temporal role + its signed offset from the current line, so it is
 * export-parity by construction (reads only the per-frame time/audio contract,
 * never a wall clock).
 *
 * ── SEAM GAP (documented, deliberate) ────────────────────────────────────────
 * A TRUE film-credits roll is a continuous BOTTOM-UP VERTICAL SCROLL: every line
 * drifts upward over time and the active line settles near a golden-ratio line
 * on screen. That requires a per-line VERTICAL PIXEL OFFSET the seam does not yet
 * expose — `StyleLineModifier` currently offers only { scale, opacityMul, blurPx }
 * with NO `offsetYPx` (or equivalent) field. Per the seam contract the parent
 * owns contract changes, so this module does NOT edit the seam. Until a future
 * `offsetYPx?: number` field is added to `StyleLineModifier`, this implementation
 * delivers the OPACITY + SCALE focus-roll portion of the effect within the
 * available fields: lineOffset + role drive a monotonic opacity falloff (lines
 * far below/above fade toward MIN_OPACITY) and the current line settles at
 * SETTLE_SCALE, reading as a focus-scroll rather than a literal Y translation.
 * When `offsetYPx` lands, this style should add an upward drift proportional to
 * `lineOffset` and settle the current line at the golden-ratio band.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type {
  LyricStyle,
  StyleLineContext,
  StyleLineModifier,
  StyleWordModifier,
} from '../StyleRegistry';

/** Scale the current (focused/settled) line is nudged up to. */
export const SETTLE_SCALE = 1.06;
/** Opacity lost per step of distance from the current line. */
export const OPACITY_PER_STEP = 0.3;
/** Opacity floor so distant lines stay faintly legible instead of vanishing. */
export const MIN_OPACITY = 0.12;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pure focus-roll modifier. SYMMETRIC in `lineOffset`: opacity falloff depends
 * only on |lineOffset|, so a line one step in the past and one step in the
 * future fade equally. The current line (offset 0) is full opacity and settled.
 */
export function computeCreditsRoll(ctx: StyleLineContext): StyleLineModifier {
  const dist = Math.abs(ctx.lineOffset);

  if (dist === 0) {
    return { scale: SETTLE_SCALE, opacityMul: 1 };
  }

  const opacityMul = Math.max(MIN_OPACITY, 1 - dist * OPACITY_PER_STEP);
  // Distant lines shrink slightly back toward 1.0 (they are no longer the
  // settled focal line); they never grow past the current line's SETTLE_SCALE.
  const scale = clamp(SETTLE_SCALE - dist * 0.02, 0.9, SETTLE_SCALE);

  return { scale, opacityMul };
}

export const creditsRollStyle: LyricStyle = {
  id: 'credits-roll',
  name: 'Credits Roll',
  // Credits roll is a line-level effect; words are unmodified.
  modifyWord: (): StyleWordModifier => ({}),
  modifyLine: computeCreditsRoll,
};

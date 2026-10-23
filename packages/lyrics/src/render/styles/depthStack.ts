/**
 * Style: Depth stack.
 *
 * Past, current, and next lines live at different apparent Z depths: the
 * current line is sharp, full-opacity and slightly enlarged; lines further from
 * the current one (in either time direction) are progressively blurred, dimmed,
 * and shrunk — a cheap fake depth-of-field that reads as expensive.
 *
 * This is a LINE-level style (implements modifyLine). It is driven purely by the
 * line's temporal role + its signed offset from the current line, so it is
 * export-parity by construction. `energy` optionally deepens the focus pull so
 * the effect breathes with the mix, but the effect is fully defined at
 * energy = 0.
 *
 * NOTE: line-level `opacityMul` is honored on the word-granularity draw path
 * (depth-stack's default). If combined with a char-level animation, the outer
 * scale+blur still apply; per-word line-opacity on the char path is a known
 * minor gap (documented, not silently wrong).
 */
import type {
  LyricStyle,
  StyleLineContext,
  StyleLineModifier,
  StyleWordModifier,
} from '../StyleRegistry';

/** Blur (px) added per step of distance from the current line. */
export const BLUR_PER_STEP = 3.5;
/** Max blur (px) so distant lines don't dissolve entirely. */
export const MAX_BLUR = 12;
/** Opacity lost per step of distance (clamped by MIN_OPACITY). */
export const OPACITY_PER_STEP = 0.28;
export const MIN_OPACITY = 0.15;
/** Current line enlargement; distant lines shrink toward MIN_SCALE. */
export const CURRENT_SCALE = 1.08;
export const SCALE_PER_STEP = 0.08;
export const MIN_SCALE = 0.7;
/** How much energy deepens the focus pull (0 = none). */
export const ENERGY_FOCUS = 0.4;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function computeDepthStack(ctx: StyleLineContext): StyleLineModifier {
  const dist = Math.abs(ctx.lineOffset);
  // Energy deepens the pull: distant lines get a touch more blur/dim on loud
  // frames, but the current line (dist 0) is unaffected.
  const focus = 1 + clamp01(ctx.audio?.energy ?? 0) * ENERGY_FOCUS;

  if (dist === 0) {
    return { scale: CURRENT_SCALE, opacityMul: 1, blurPx: 0 };
  }

  const blurPx = Math.min(MAX_BLUR, dist * BLUR_PER_STEP * focus);
  const opacityMul = Math.max(MIN_OPACITY, 1 - dist * OPACITY_PER_STEP * focus);
  const scale = Math.max(MIN_SCALE, CURRENT_SCALE - dist * SCALE_PER_STEP);

  return { scale, opacityMul, blurPx };
}

export const depthStackStyle: LyricStyle = {
  id: 'depth-stack',
  name: 'Depth Stack',
  // Depth stack is a line-level effect; words are unmodified.
  modifyWord: (): StyleWordModifier => ({}),
  modifyLine: computeDepthStack,
};

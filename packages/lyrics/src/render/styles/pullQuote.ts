/**
 * Style: Pull-quote (editorial magazine treatment).
 *
 * Emulates the feel of an editorial pull-quote where the tracking (letter
 * spacing) "opens up" on held / sustained syllables. The LONGER a word is held
 * (its sustain = wordEnd - wordStart) and the more it is currently being held
 * (isActive + time progressing through a long word), the wider the type sits.
 *
 * ── SEAM GAP (documented, not worked around) ─────────────────────────────────
 * TRUE letter-spacing requires a future `letterSpacingEm` field on
 * `StyleWordModifier` — the parent owns that contract change and this cycle does
 * NOT edit the seam. Neither a horizontal-only scale (`scaleMul` is uniform) nor
 * a real tracking field is available today, so this implementation APPROXIMATES
 * "tracking opens on sustain" within the current seam using:
 *   • the variable-font `wdth` axis via `fontVariationSettings` — a wider glyph
 *     width reads as opened-up tracking on a variable font (closest analog:
 *     variableBreathing.ts, which already drives `wdth`);
 *   • a small `offsetXEm` nudge so the word drifts as it opens, hinting at the
 *     spread the seam cannot yet express per-glyph; and
 *   • a subtle uniform `scaleMul` lift so the held word gains presence.
 * When `letterSpacingEm` lands on StyleWordModifier, replace the wdth+offset
 * emulation with a genuine per-glyph tracking value driven by `sustain01`.
 *
 * Mapping (all bounded, monotonic in sustain):
 *   sustain   = wordEnd - wordStart           (seconds)
 *   sustain01 = clamp01(sustain / SUSTAIN_REF_SEC)
 *   hold01    = while active, progress through the word (0→1); else 0
 *   open      = clamp01(sustain01 * (1 + hold01 * HOLD_BOOST) ... )  // see below
 *   wdth      = WDTH_MIN + open * (WDTH_MAX - WDTH_MIN)
 * A quiet inactive word with a short sustain sits at WDTH_MIN; a long, actively
 * held word opens toward WDTH_MAX. Reads only the per-frame time/audio contract,
 * so preview == export by construction.
 */
import type { LyricStyle, StyleWordContext, StyleWordModifier } from '../StyleRegistry';

/** Sustain (seconds) that counts as "fully held" — a word held this long opens fully. */
export const SUSTAIN_REF_SEC = 1.2;
/** Variable-font width axis at rest (short / unheld word). */
export const WDTH_MIN = 100;
/** Variable-font width axis fully opened (long, actively held word). */
export const WDTH_MAX = 135;
/** Extra opening contributed by actively holding through a long word (fraction). */
export const HOLD_BOOST = 0.5;
/** Max horizontal drift, em, at full opening — a hint of the spread the seam can't express. */
export const OFFSET_X_MAX_EM = 0.06;
/** Max uniform scale lift at full opening (presence bump). */
export const SCALE_LIFT = 0.04;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * How "open" this word should read this frame, in [0,1].
 * Base openness comes from the word's total sustain; being actively held part
 * way through a long word adds up to HOLD_BOOST more on top, then clamped.
 */
export function computeOpen(ctx: StyleWordContext): number {
  const sustain = ctx.wordEnd - ctx.wordStart;
  const sustain01 = clamp01(sustain / SUSTAIN_REF_SEC);

  let hold01 = 0;
  if (ctx.isActive && sustain > 0) {
    hold01 = clamp01((ctx.time - ctx.wordStart) / sustain);
  }

  return clamp01(sustain01 * (1 + hold01 * HOLD_BOOST));
}

export function computePullQuote(ctx: StyleWordContext): StyleWordModifier {
  const open = computeOpen(ctx);

  const wdth = Math.round((WDTH_MIN + open * (WDTH_MAX - WDTH_MIN)) * 10) / 10;

  return {
    // Editorial variable-font width — emulates tracking opening on sustain.
    fontVariationSettings: `"wdth" ${wdth}`,
    // Slight drift + presence lift standing in for real per-glyph spacing.
    offsetXEm: open * OFFSET_X_MAX_EM,
    scaleMul: 1 + open * SCALE_LIFT,
  };
}

export const pullQuoteStyle: LyricStyle = {
  id: 'pull-quote',
  name: 'Pull-Quote',
  modifyWord: computePullQuote,
};

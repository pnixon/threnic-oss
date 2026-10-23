/**
 * Style: Variable-font breathing.
 *
 * Drives a variable font's weight (`wght`) and width (`wdth`) axes from the low
 * frequency band so the type itself thickens and widens with the kick, plus a
 * subtle scale pulse. Nearly free, high impact. Requires a variable font loaded
 * for the axes to take visible effect; the scale pulse works with any font.
 *
 * Mapping (all bounded, monotonic in bass):
 *   wght: WGHT_MIN + bass * (WGHT_MAX - WGHT_MIN)
 *   wdth: WDTH_MIN + bass * (WDTH_MAX - WDTH_MIN)
 *   scaleMul: 1 + bass * SCALE_PULSE
 * The active word breathes a touch harder (ACTIVE_BOOST) so the current lyric
 * leads the motion.
 */
import type { LyricStyle, StyleWordContext, StyleWordModifier } from '../StyleRegistry';

export const WGHT_MIN = 300;
export const WGHT_MAX = 800;
export const WDTH_MIN = 90;
export const WDTH_MAX = 125;
export const SCALE_PULSE = 0.06; // up to +6% on a full-bass frame
export const ACTIVE_BOOST = 1.5; // active word reacts 1.5x as hard

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function computeBreathing(ctx: StyleWordContext): StyleWordModifier {
  const bassRaw = ctx.audio?.bass ?? 0;
  const bass = clamp01(bassRaw) * (ctx.isActive ? ACTIVE_BOOST : 1);
  const b = clamp01(bass);

  const wght = Math.round(WGHT_MIN + b * (WGHT_MAX - WGHT_MIN));
  const wdth = Math.round((WDTH_MIN + b * (WDTH_MAX - WDTH_MIN)) * 10) / 10;

  return {
    fontVariationSettings: `"wght" ${wght}, "wdth" ${wdth}`,
    scaleMul: 1 + b * SCALE_PULSE,
  };
}

export const variableBreathingStyle: LyricStyle = {
  id: 'variable-breathing',
  name: 'Variable-Font Breathing',
  modifyWord: computeBreathing,
};

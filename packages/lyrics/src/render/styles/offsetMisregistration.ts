/**
 * Style: Offset misregistration.
 *
 * Evokes the CMYK/RGB print-misregistration look of a badly-registered
 * magazine: the type drifts off its "plate" position on a slow deterministic
 * wobble, then SNAPS back toward correct registration on strong audio
 * transients (a treble/energy spike reads as the press catching up and the
 * colour plates realigning).
 *
 * On THIS seam (a single per-word `modifyWord` returning a scale/offset delta)
 * the honest expression is a per-word positional drift, not a true per-channel
 * colour separation. Real CMYK/RGB separation — drawing the same glyph three
 * times in cyan/magenta/yellow (or R/G/B) at three different offsets — needs a
 * multi-pass draw hook the word-modifier seam does not expose. So this is the
 * OFFSET-DRIFT APPROXIMATION of the misregistration feel: it captures the
 * "type is off its registration marks and jitters back on transients" motion,
 * without the channel splitting. A per-channel version would be a `layout` or
 * `drawOverlay` style, not this modifier.
 *
 * Mapping (all bounded to ±MAX_OFFSET_EM):
 *   drift(time)   = sin(time * 2π * DRIFT_HZ)          // deterministic wobble
 *   snap          = 1 - clamp01(transient / SNAP_THRESHOLD)  // →0 on a spike
 *   offsetXEm     = MAX_OFFSET_EM * drift        * snap
 *   offsetYEm     = MAX_OFFSET_EM * drift(¼ turn) * snap
 * where `transient = max(high, energy)`. A quiet frame leaves `snap ≈ 1` (full
 * drift, biggest misregistration); a strong-transient frame drives `snap → 0`
 * (offset collapses toward 0, i.e. registration snaps back).
 */
import type { LyricStyle, StyleWordContext, StyleWordModifier } from '../StyleRegistry';

/** Drift oscillation frequency in Hz (slow wobble of the "plate"). */
export const DRIFT_HZ = 0.45;
/** Maximum positional offset, in em units, on either axis. */
export const MAX_OFFSET_EM = 0.06;
/** Transient level (0..1) at/above which registration fully snaps back. */
export const SNAP_THRESHOLD = 0.7;

const TWO_PI = Math.PI * 2;
/** Quarter-turn phase so X and Y drift on different phases (elliptical wobble). */
const QUARTER_TURN = Math.PI / 2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Pure helper: the per-word offset delta for one frame.
 *
 * Deterministic in `time` for the drift term; audio only modulates the
 * snap-back factor. Missing audio ⇒ no transient ⇒ full drift.
 */
export function computeOffset(ctx: StyleWordContext): StyleWordModifier {
  const t = ctx.time;
  const driftX = Math.sin(t * TWO_PI * DRIFT_HZ);
  const driftY = Math.sin(t * TWO_PI * DRIFT_HZ + QUARTER_TURN);

  const high = ctx.audio?.high ?? 0;
  const energy = ctx.audio?.energy ?? 0;
  const transient = Math.max(high, energy);
  // snap → 0 as the transient reaches SNAP_THRESHOLD (registration realigns).
  const snap = 1 - clamp01(transient / SNAP_THRESHOLD);

  return {
    offsetXEm: MAX_OFFSET_EM * driftX * snap,
    offsetYEm: MAX_OFFSET_EM * driftY * snap,
  };
}

export const offsetMisregistrationStyle: LyricStyle = {
  id: 'offset-misregistration',
  name: 'Offset Misregistration',
  modifyWord: computeOffset,
};

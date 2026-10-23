/**
 * Style: Swiss kinetic grid.
 *
 * International-Typographic-Style type treatment: huge Helvetica-like display
 * type on a strict modular grid with extreme scale contrast. The active word is
 * blown up hard (BIG_SCALE, pulsed further by audio energy) while the rest of
 * the line sits small at BASE_SCALE — the classic Swiss "one enormous element,
 * everything else quiet" hierarchy.
 *
 * Layout reads as a rigid grid, not chaos: each word's offset is QUANTIZED to
 * discrete GRID_STEP_EM increments, and the increment is chosen deterministically
 * from the word index (a fixed pseudo-pattern), so the same word always lands on
 * the same grid cell. Nothing is random per-frame.
 *
 * Everything is bounded and reads only the per-frame audio/time contract, so
 * export parity holds by construction (no wall clock, no per-frame state).
 *
 * Mapping:
 *   inactive word: scaleMul = BASE_SCALE
 *   active word:   scaleMul = BIG_SCALE + energy * ENERGY_PULSE   (monotonic in energy)
 *   offsetXEm/offsetYEm: deterministic grid cell (index-derived) × GRID_STEP_EM
 */
import type { LyricStyle, StyleWordContext, StyleWordModifier } from '../StyleRegistry';

/** Scale of the small, quiet words. */
export const BASE_SCALE = 0.55;
/** Scale of the huge active word (before the energy pulse). */
export const BIG_SCALE = 2.6;
/** Discrete grid increment, in em, that all offsets snap to. */
export const GRID_STEP_EM = 0.5;
/** Extra scale the active word gains at full energy, on top of BIG_SCALE. */
export const ENERGY_PULSE = 0.8;
/** How many discrete grid cells each axis spans (0..GRID_CELLS-1). */
const GRID_CELLS = 4;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Deterministic grid cell for a word index on one axis. A fixed multiplier per
 * axis spreads consecutive words across cells without randomness, so the layout
 * is a stable, repeatable grid keyed purely on wordIndex.
 */
function gridCell(wordIndex: number, axisSalt: number): number {
  // Non-negative, bounded to [0, GRID_CELLS-1]. Integer by construction.
  const n = Math.abs(Math.trunc(wordIndex)) * 2 + axisSalt;
  return n % GRID_CELLS;
}

/**
 * Quantized offset in em for a given cell: a centred grid snapped to whole
 * GRID_STEP_EM increments. Cells map to integer step counts straddling 0
 * (e.g. GRID_CELLS=4 → step counts [-2, -1, 0, +1]), so every returned value
 * is exactly an integer multiple of GRID_STEP_EM.
 */
function cellOffsetEm(cell: number): number {
  const stepCount = cell - Math.floor(GRID_CELLS / 2); // integer
  return stepCount * GRID_STEP_EM;
}

export function computeSwissGrid(ctx: StyleWordContext): StyleWordModifier {
  const energy = clamp01(ctx.audio?.energy ?? 0);

  const scaleMul = ctx.isActive ? BIG_SCALE + energy * ENERGY_PULSE : BASE_SCALE;

  const offsetXEm = cellOffsetEm(gridCell(ctx.wordIndex, 0));
  const offsetYEm = cellOffsetEm(gridCell(ctx.wordIndex, 1));

  return {
    scaleMul,
    offsetXEm,
    offsetYEm,
  };
}

export const swissKineticGridStyle: LyricStyle = {
  id: 'swiss-kinetic-grid',
  name: 'Swiss Kinetic Grid',
  modifyWord: computeSwissGrid,
};

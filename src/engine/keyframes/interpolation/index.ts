/**
 * Interpolation Engine — Barrel Export
 *
 * Central export point for the advanced interpolation subsystem.
 *
 * Architecture:
 *
 * ```
 *  types.ts          ── Core type definitions
 *  easing.ts         ── Easing curves (linear, cubic, bezier)
 *  hermite.ts        ── Cubic Hermite splines + TCB tangent computation
 *  color.ts          ── Oklab/OkLCH perceptual color interpolation
 *  gradient.ts       ── Gradient stop normalization + morphing
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type { ChannelKey } from './types';

// ─── Easing ──────────────────────────────────────────────────────────────────
export { easeValue } from './easing';

// ─── Hermite / TCB ───────────────────────────────────────────────────────────
export { evalHermiteSegment } from './hermite';

// ─── Color ───────────────────────────────────────────────────────────────────
export { interpolateColor, isColorValue } from './color';

// ─── Gradient ────────────────────────────────────────────────────────────────
export { parseGradient, gradientToCSS, interpolateGradient, isGradientValue } from './gradient';

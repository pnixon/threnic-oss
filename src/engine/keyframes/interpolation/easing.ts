/**
 * Easing Functions — Refactored from types/keyframes.ts
 *
 * Pure mathematical mapping of normalized parameter `t ∈ [0, 1]` to an eased
 * output in `[0, 1]`. These are the "σ(t)" curves that modulate the raw
 * interpolation parameter before it's fed into LERP / Hermite / color blending.
 *
 * This module extends the original set with cubic-bezier support and exposes
 * each curve as a named export for direct testing.
 */

import type { InterpolationMode, TangentData } from './types';

// ─── Individual Easing Curves ────────────────────────────────────────────────

/** Linear: constant velocity. */
function easeLinear(t: number): number {
  return t;
}

/** Hold / Step: jump at t = 1. */
function easeHold(t: number): number {
  return t < 1 ? 0 : 1;
}

/** Ease-in: cubic acceleration. */
function easeIn(t: number): number {
  return t * t * t;
}

/** Ease-out: cubic deceleration. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Ease-in-out: cubic S-curve. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Curve: quintic S-curve for dramatic acceleration. */
function easeCurve(t: number): number {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

/** Logarithmic: fast start, slow finish. */
function easeLogarithmic(t: number): number {
  return Math.log10(1 + t * 9);
}

/** Exponential: slow start, explosive finish. */
function easeExponential(t: number): number {
  return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
}

// ─── Cubic Bezier ────────────────────────────────────────────────────────────

/**
 * Solve a cubic bezier curve defined by two control points (x1, y1, x2, y2).
 * Given a parameter `t`, we need to find the `u` such that `bezierX(u) = t`,
 * then return `bezierY(u)`.
 *
 * Uses Newton-Raphson iteration for fast convergence, falling back to
 * bisection if Newton overshoots.
 */
function cubicBezier(t: number, x1: number, y1: number, x2: number, y2: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  // Bernstein polynomial coefficients for X
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;

  // Bernstein polynomial coefficients for Y
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const sampleXDerivative = (u: number) => (3 * ax * u + 2 * bx) * u + cx;

  // Newton-Raphson: solve for u where sampleX(u) = t
  let u = t; // Initial guess
  for (let i = 0; i < 8; i++) {
    const x = sampleX(u) - t;
    if (Math.abs(x) < 1e-7) break;
    const dx = sampleXDerivative(u);
    if (Math.abs(dx) < 1e-7) break;
    u -= x / dx;
  }

  // Clamp and fallback to bisection if Newton failed
  u = Math.max(0, Math.min(1, u));
  if (Math.abs(sampleX(u) - t) > 1e-4) {
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 20; i++) {
      const x = sampleX(u);
      if (Math.abs(x - t) < 1e-7) break;
      if (x < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
  }

  return sampleY(u);
}

// ─── Unified Dispatcher ─────────────────────────────────────────────────────

/**
 * Apply an easing curve to a normalized parameter `t ∈ [0, 1]`.
 *
 * This is the upgraded version of the original `easeValue()` from
 * `types/keyframes.ts`. It adds support for `hermite` (passthrough),
 * `tcb` (passthrough — Hermite handles the curve), and `cubic-bezier`.
 *
 * For Hermite / TCB modes, easing is implicit in the spline shape,
 * so we return `t` directly — the actual curve is evaluated externally
 * by the Hermite evaluator.
 */
export function easeValue(t: number, mode: InterpolationMode, tangent?: TangentData): number {
  const p = Math.max(0, Math.min(1, t));
  switch (mode) {
    case 'linear':
    case 'lerp':
      return easeLinear(p);
    case 'hold':
    case 'instant':
      return easeHold(p);
    case 'ease-in':
      return easeIn(p);
    case 'ease-out':
      return easeOut(p);
    case 'ease-in-out':
      return easeInOut(p);
    case 'curve':
      return easeCurve(p);
    case 'logarithmic':
      return easeLogarithmic(p);
    case 'exponential':
      return easeExponential(p);
    case 'hermite':
    case 'tcb':
      // Hermite / TCB interpolation is handled by the hermite evaluator,
      // not by an easing function. Return raw t as passthrough.
      return p;
    case 'cubic-bezier':
      if (tangent?.bezierPoints) {
        const [x1, y1, x2, y2] = tangent.bezierPoints;
        return cubicBezier(p, x1, y1, x2, y2);
      }
      // Fallback to ease-in-out if no bezier points specified
      return easeInOut(p);
    default:
      return easeHold(p);
  }
}

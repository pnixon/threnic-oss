/**
 * Hermite Spline & TCB (Kochanek-Bartels) Interpolation
 *
 * Implements the cubic Hermite spline formulation:
 *   X(u) = H₀(u)·P₀ + H₁(u)·P₁ + H₂(u)·Δ·T₀ᵒᵘᵗ + H₃(u)·Δ·T₁ⁱⁿ
 *
 * Where H₀..H₃ are the Hermite basis functions and u ∈ [0, 1].
 *
 * The TCB formulation auto-generates tangents from three artist-friendly
 * parameters: Tension (τ), Continuity (γ), and Bias (β).
 *
 * Handles nonuniform keyframe spacing via time-ratio adjustment of tangents.
 */

import type { ChannelKey } from './types';

// ─── Hermite Basis Functions ─────────────────────────────────────────────────

/**
 * H₀(u) = 2u³ − 3u² + 1
 * Weights the start position.
 */
function h0(u: number): number {
  return 2 * u * u * u - 3 * u * u + 1;
}

/**
 * H₁(u) = −2u³ + 3u²
 * Weights the end position.
 */
function h1(u: number): number {
  return -2 * u * u * u + 3 * u * u;
}

/**
 * H₂(u) = u³ − 2u² + u
 * Weights the start tangent (scaled by interval width Δ).
 */
function h2(u: number): number {
  return u * u * u - 2 * u * u + u;
}

/**
 * H₃(u) = u³ − u²
 * Weights the end tangent (scaled by interval width Δ).
 */
function h3(u: number): number {
  return u * u * u - u * u;
}

/**
 * Evaluate a cubic Hermite spline segment.
 *
 * @param u - Normalized parameter within the segment [0, 1]
 * @param p0 - Value at the start key
 * @param p1 - Value at the end key
 * @param t0out - Outgoing tangent at the start key
 * @param t1in - Incoming tangent at the end key
 * @param delta - Time interval width (t₁ − t₀), used to scale tangents
 */
function hermiteEval(
  u: number,
  p0: number,
  p1: number,
  t0out: number,
  t1in: number,
  delta: number,
): number {
  return h0(u) * p0 + h1(u) * p1 + h2(u) * delta * t0out + h3(u) * delta * t1in;
}

// ─── TCB Tangent Computation ─────────────────────────────────────────────────

/**
 * Compute TCB (Kochanek-Bartels) tangents for key k.
 *
 * Given three consecutive keys P_{k-1}, P_k, P_{k+1}, this computes the
 * incoming tangent T^i_k and outgoing tangent T^o_k using:
 *
 *   T^i_k = [(1−τ)(1+γ)(1−β)/2]·(P_{k+1}−P_k) + [(1−τ)(1−γ)(1+β)/2]·(P_k−P_{k−1})
 *   T^o_k = [(1−τ)(1−γ)(1−β)/2]·(P_{k+1}−P_k) + [(1−τ)(1+γ)(1+β)/2]·(P_k−P_{k−1})
 *
 * For nonuniform spacing, tangents are adjusted by the ratio of time intervals.
 *
 * @param prev - Previous key (or null if k is the first key)
 * @param curr - Current key
 * @param next - Next key (or null if k is the last key)
 * @returns { inTangent, outTangent } — tangent slopes at key k
 */
function computeTCBTangents(
  prev: ChannelKey | null,
  curr: ChannelKey,
  next: ChannelKey | null,
): { inTangent: number; outTangent: number } {
  const tau = curr.tangent?.tension ?? 0;
  const gamma = curr.tangent?.continuity ?? 0;
  const beta = curr.tangent?.bias ?? 0;

  // Edge cases: first or last key — use single-sided chord
  if (!prev && !next) {
    return { inTangent: 0, outTangent: 0 };
  }

  if (!prev) {
    // First key: tangent is just the chord to the next key
    const chord = (next!.value - curr.value) / Math.max(next!.time - curr.time, 1e-10);
    const scale = 1 - tau;
    return { inTangent: scale * chord, outTangent: scale * chord };
  }

  if (!next) {
    // Last key: tangent is just the chord from the previous key
    const chord = (curr.value - prev.value) / Math.max(curr.time - prev.time, 1e-10);
    const scale = 1 - tau;
    return { inTangent: scale * chord, outTangent: scale * chord };
  }

  // Interior key — full TCB formula
  const dPrev = curr.value - prev.value; // P_k − P_{k−1}
  const dNext = next.value - curr.value; // P_{k+1} − P_k

  // Time intervals
  const dtPrev = curr.time - prev.time;
  const dtNext = next.time - curr.time;

  // Nonuniform time adjustment (prevents velocity spikes with uneven spacing)
  const dtRatio = dtPrev > 0 && dtNext > 0 ? (2 * dtPrev * dtNext) / (dtPrev + dtNext) : 1;
  const rPrev = dtPrev > 0 ? dtRatio / dtPrev : 1;
  const rNext = dtNext > 0 ? dtRatio / dtNext : 1;

  // TCB coefficients
  const a = (1 - tau) / 2;

  const inTangent =
    a * (1 + gamma) * (1 - beta) * rNext * dNext + a * (1 - gamma) * (1 + beta) * rPrev * dPrev;

  const outTangent =
    a * (1 - gamma) * (1 - beta) * rNext * dNext + a * (1 + gamma) * (1 + beta) * rPrev * dPrev;

  return { inTangent, outTangent };
}

/**
 * Resolve the tangent values for a channel key.
 *
 * If the key has explicit inTangent/outTangent values and is NOT in TCB mode,
 * those are used directly. For TCB mode (or missing tangents), we compute them.
 *
 * @param keys - The full sorted channel key array
 * @param index - The index of the key to resolve tangents for
 */
function resolveTangents(
  keys: ChannelKey[],
  index: number,
): { inTangent: number; outTangent: number } {
  const curr = keys[index];
  const tangent = curr.tangent;

  // If explicit tangents are provided and the key is not broken, use them directly
  if (
    tangent &&
    tangent.inTangent !== undefined &&
    tangent.outTangent !== undefined &&
    curr.interpolation !== 'tcb'
  ) {
    return { inTangent: tangent.inTangent, outTangent: tangent.outTangent };
  }

  // Compute from TCB parameters (or default 0/0/0 if none provided)
  const prev = index > 0 ? keys[index - 1] : null;
  const next = index < keys.length - 1 ? keys[index + 1] : null;

  const computed = computeTCBTangents(prev, curr, next);

  // If the key has explicit values AND is "broken" (different in/out), allow partial override
  if (tangent?.broken) {
    return {
      inTangent: tangent.inTangent ?? computed.inTangent,
      outTangent: tangent.outTangent ?? computed.outTangent,
    };
  }

  return computed;
}

/**
 * Evaluate a Hermite/TCB-interpolated channel at a specific parameter within a segment.
 *
 * @param keys - Sorted channel keys
 * @param segStart - Index of the start key of the segment
 * @param u - Normalized parameter [0, 1] within the segment
 */
export function evalHermiteSegment(keys: ChannelKey[], segStart: number, u: number): number {
  const k0 = keys[segStart];
  const k1 = keys[segStart + 1];
  const delta = k1.time - k0.time;

  if (delta <= 0) return k0.value;

  const { outTangent: t0out } = resolveTangents(keys, segStart);
  const { inTangent: t1in } = resolveTangents(keys, segStart + 1);

  return hermiteEval(u, k0.value, k1.value, t0out, t1in, delta);
}

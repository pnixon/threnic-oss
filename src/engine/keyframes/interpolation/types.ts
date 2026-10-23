/**
 * Keyframe Interpolation Types
 *
 * Core type definitions for the advanced interpolation engine.
 * Supports per-key tangent metadata (TCB parameters), extrapolation modes,
 * and channel-level configuration.
 */

// ─── Interpolation Modes ─────────────────────────────────────────────────────

/**
 * All supported interpolation strategies.
 *
 * - `hold` / `instant`: Step function — value snaps at keyframe time.
 * - `linear` / `lerp`: Constant-velocity interpolation.
 * - `ease-in`, `ease-out`, `ease-in-out`: Cubic easing curves.
 * - `curve`: Quintic easing for dramatic acceleration.
 * - `logarithmic`, `exponential`: Non-linear rate curves.
 * - `hermite`: Cubic Hermite spline using tangent metadata.
 * - `tcb`: Kochanek-Bartels spline (auto-generates tangents from T/C/B params).
 * - `cubic-bezier`: Custom cubic-bezier curve with two control points.
 */
export type InterpolationMode =
  | 'hold'
  | 'instant'
  | 'linear'
  | 'lerp'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'curve'
  | 'logarithmic'
  | 'exponential'
  | 'hermite'
  | 'tcb'
  | 'cubic-bezier';

// ─── Tangent Metadata ────────────────────────────────────────────────────────

/**
 * Tangent data stored on each keyframe for Hermite interpolation.
 *
 * For `hermite` mode, incoming/outgoing tangent vectors are specified directly.
 * For `tcb` mode, the T/C/B parameters auto-compute the tangents.
 */
export interface TangentData {
  /** Incoming tangent (slope arriving at this keyframe). */
  inTangent?: number;
  /** Outgoing tangent (slope departing this keyframe). */
  outTangent?: number;

  /**
   * Kochanek-Bartels "Tension" parameter.
   * Range: [-1, 1]. Default: 0.
   * - Positive: Tighter curves (less overshoot).
   * - Negative: Looser curves (more overshoot).
   */
  tension?: number;
  /**
   * Kochanek-Bartels "Continuity" parameter.
   * Range: [-1, 1]. Default: 0.
   * - 0: Smooth passage through the key.
   * - ±1: Sharp corner / bounce at the key.
   */
  continuity?: number;
  /**
   * Kochanek-Bartels "Bias" parameter.
   * Range: [-1, 1]. Default: 0.
   * - Positive: Curve overshoots toward next key.
   * - Negative: Curve undershoots / anticipates.
   */
  bias?: number;

  /**
   * Cubic-bezier control points (for `cubic-bezier` mode).
   * Array of [x1, y1, x2, y2] matching CSS `cubic-bezier()`.
   */
  bezierPoints?: [number, number, number, number];

  /**
   * Whether tangents are "unified" (in = out) or "broken".
   * When broken, the curve can have a sharp corner at this key.
   */
  broken?: boolean;
}

// ─── Channel Key ─────────────────────────────────────────────────────────────

/**
 * Extended keyframe data for a single channel (one property over time).
 * This is the internal representation used by the evaluator.
 */
export interface ChannelKey {
  /** Time in seconds */
  time: number;
  /** The value at this key */
  value: number;
  /** Interpolation mode for the segment ARRIVING at this key */
  interpolation: InterpolationMode;
  /** Tangent metadata (TCB params or explicit tangent vectors) */
  tangent?: TangentData;
}

// ─── Hue Interpolation Mode ─────────────────────────────────────────────────

/**
 * Controls how the hue component is interpolated in polar color spaces (LCH, HSL).
 */
export type HueMode =
  | 'shorter' // Shortest arc (default)
  | 'longer' // Longest arc (rainbow effect)
  | 'increasing' // Force clockwise (0→360)
  | 'decreasing'; // Force counter-clockwise (360→0)

// ─── Color Interpolation Space ───────────────────────────────────────────────

export type ColorSpace =
  | 'rgb' // Linear RGB (fast, but perceptually non-uniform)
  | 'srgb' // sRGB (standard, still non-uniform)
  | 'oklab' // Oklab (perceptually uniform Cartesian)
  | 'oklch' // OkLCH (perceptually uniform polar — best for hue control)
  | 'lch'; // CIE LCH (perceptually uniform, wider gamut)

// ─── Gradient Types ──────────────────────────────────────────────────────────

export interface GradientStop {
  /** Position in range [0, 1] */
  position: number;
  /** CSS color string */
  color: string;
}

export interface GradientValue {
  /** Gradient type */
  type: 'linear' | 'radial' | 'conic';
  /** Angle in degrees (for linear) */
  angle?: number;
  /** Ordered color stops */
  stops: GradientStop[];
}

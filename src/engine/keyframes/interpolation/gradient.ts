/**
 * Gradient Interpolation & Stop Normalization
 *
 * Handles the morphing of CSS gradients with different numbers of color stops.
 * Before interpolation, the system "normalizes" both gradients to have the
 * same number of stops by injecting virtual stops via sampling.
 *
 * Algorithm:
 * 1. Collect all unique stop positions from both gradients.
 * 2. For each gradient, sample its color at every unique position.
 * 3. Interpolate corresponding stops (position, color) with LERP / Oklab.
 * 4. Reconstruct the final CSS gradient string.
 */

import type { GradientValue, GradientStop, ColorSpace, HueMode } from './types';
import { interpolateColor } from './color';

// ─── Gradient Parsing ────────────────────────────────────────────────────────

/**
 * Parse a CSS gradient string into a GradientValue object.
 *
 * Supports:
 *   `linear-gradient(135deg, #ff0000 0%, #0000ff 50%, #00ff00 100%)`
 *   `radial-gradient(circle, #ff0000, #0000ff)`
 */
export function parseGradient(css: string): GradientValue | null {
  const linearMatch = css.match(/^linear-gradient\(\s*([\d.]+)deg\s*,\s*(.+)\s*\)$/i);
  const radialMatch = css.match(/^radial-gradient\(\s*(?:circle|ellipse)?\s*,?\s*(.+)\s*\)$/i);
  const conicMatch = css.match(/^conic-gradient\(\s*(?:from\s+([\d.]+)deg\s*,?\s*)?(.+)\s*\)$/i);

  let type: GradientValue['type'] = 'linear';
  let angle = 180;
  let stopsStr = '';

  if (linearMatch) {
    type = 'linear';
    angle = parseFloat(linearMatch[1]);
    stopsStr = linearMatch[2];
  } else if (radialMatch) {
    type = 'radial';
    stopsStr = radialMatch[1];
  } else if (conicMatch) {
    type = 'conic';
    angle = conicMatch[1] ? parseFloat(conicMatch[1]) : 0;
    stopsStr = conicMatch[2];
  } else {
    return null;
  }

  const stops = parseStops(stopsStr);
  return { type, angle, stops };
}

/**
 * Parse the color-stop portion of a CSS gradient.
 */
function parseStops(stopsStr: string): GradientStop[] {
  // Split on commas that are NOT inside parentheses (for rgb()/hsl())
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of stopsStr) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  const stops: GradientStop[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    // Match color + optional percentage
    const posMatch = part.match(/^(.+?)\s+([\d.]+)%\s*$/);
    if (posMatch) {
      stops.push({ color: posMatch[1].trim(), position: parseFloat(posMatch[2]) / 100 });
    } else {
      // No explicit position — distribute evenly
      const position = parts.length === 1 ? 0.5 : i / (parts.length - 1);
      stops.push({ color: part, position });
    }
  }

  return stops.sort((a, b) => a.position - b.position);
}

// ─── Gradient Serialization ──────────────────────────────────────────────────

/**
 * Convert a GradientValue back to a CSS gradient string.
 */
export function gradientToCSS(gradient: GradientValue): string {
  const stopsCSS = gradient.stops
    .map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`)
    .join(', ');

  switch (gradient.type) {
    case 'linear':
      return `linear-gradient(${gradient.angle ?? 180}deg, ${stopsCSS})`;
    case 'radial':
      return `radial-gradient(circle, ${stopsCSS})`;
    case 'conic':
      return `conic-gradient(from ${gradient.angle ?? 0}deg, ${stopsCSS})`;
  }
}

// ─── Stop Normalization ──────────────────────────────────────────────────────

/**
 * Sample a gradient at a specific position.
 * Finds the two surrounding stops and LERP's between them.
 */
function sampleGradient(stops: GradientStop[], position: number): string {
  if (stops.length === 0) return '#000000';
  if (stops.length === 1) return stops[0].color;
  if (position <= stops[0].position) return stops[0].color;
  if (position >= stops[stops.length - 1].position) return stops[stops.length - 1].color;

  // Find the bracketing stops
  let lo = 0;
  let hi = stops.length - 1;
  for (let i = 0; i < stops.length - 1; i++) {
    if (position >= stops[i].position && position <= stops[i + 1].position) {
      lo = i;
      hi = i + 1;
      break;
    }
  }

  const range = stops[hi].position - stops[lo].position;
  if (range <= 0) return stops[lo].color;
  const t = (position - stops[lo].position) / range;

  // Use Oklab for the internal sampling
  return interpolateColor(stops[lo].color, stops[hi].color, t, 'oklab');
}

/**
 * Normalize two gradients to have the same number of stops.
 *
 * Collects the union of all stop positions from both gradients, then
 * samples each gradient at all positions to create aligned stop arrays
 * of equal length.
 */
function normalizeGradients(
  a: GradientStop[],
  b: GradientStop[],
): { stopsA: GradientStop[]; stopsB: GradientStop[] } {
  // Collect all unique positions
  const positionSet = new Set<number>();
  for (const stop of a) positionSet.add(stop.position);
  for (const stop of b) positionSet.add(stop.position);
  const positions = Array.from(positionSet).sort((x, y) => x - y);

  // Sample both gradients at all positions
  const stopsA = positions.map((pos) => ({
    position: pos,
    color: sampleGradient(a, pos),
  }));

  const stopsB = positions.map((pos) => ({
    position: pos,
    color: sampleGradient(b, pos),
  }));

  return { stopsA, stopsB };
}

// ─── Gradient Morphing ──────────────────────────────────────────────────────

/**
 * Interpolate between two gradients.
 *
 * @param grad0 - Start gradient
 * @param grad1 - End gradient
 * @param t - Normalized parameter [0, 1]
 * @param colorSpace - Color space for stop interpolation
 * @param hueMode - Hue arc direction
 */
export function interpolateGradient(
  grad0: GradientValue,
  grad1: GradientValue,
  t: number,
  colorSpace: ColorSpace = 'oklab',
  hueMode: HueMode = 'shorter',
): GradientValue {
  // Normalize stop counts
  const { stopsA, stopsB } = normalizeGradients(grad0.stops, grad1.stops);

  // Interpolate each stop
  const blendedStops: GradientStop[] = stopsA.map((sa, i) => {
    const sb = stopsB[i];
    return {
      position: sa.position + (sb.position - sa.position) * t,
      color: interpolateColor(sa.color, sb.color, t, colorSpace, hueMode),
    };
  });

  // Interpolate angle (for linear/conic)
  const angle0 = grad0.angle ?? 180;
  const angle1 = grad1.angle ?? 180;
  const blendedAngle = angle0 + (angle1 - angle0) * t;

  // Use the target gradient's type (or transition at t=0.5)
  const type = t < 0.5 ? grad0.type : grad1.type;

  return {
    type,
    angle: blendedAngle,
    stops: blendedStops,
  };
}

/**
 * Check if a string value looks like a CSS gradient.
 */
export function isGradientValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^(linear|radial|conic)-gradient\(/.test(value);
}

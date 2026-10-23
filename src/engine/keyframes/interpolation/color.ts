/**
 * Perceptually Uniform Color Interpolation
 *
 * Provides colour-space conversions and interpolation routines that produce
 * visually pleasing transitions without the "muddy midpoint" problem of RGB LERP.
 *
 * Supported spaces:
 *   - **Oklab**: Perceptually uniform Cartesian (best for general blending)
 *   - **OkLCH**: Perceptually uniform polar (best for hue-controlled transitions)
 *
 * The hue interpolation supports four modes:
 *   shorter, longer, increasing, decreasing
 */

import type { ColorSpace, HueMode } from './types';

// ─── Internal Color Representations ──────────────────────────────────────────

interface RGB {
  r: number;
  g: number;
  b: number;
}
interface OklabColor {
  L: number;
  a: number;
  b: number;
}
interface OklchColor {
  L: number;
  C: number;
  h: number;
}

// ─── CSS Hex/RGB ↔ Linear RGB ────────────────────────────────────────────────

/**
 * Parse a CSS hex color string (#RGB, #RRGGBB, #RRGGBBAA) to linear [0,1] RGB.
 */
function parseHexToRGB(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  return { r, g, b };
}

/**
 * Convert RGB [0,1] to a CSS hex string.
 */
function rgbToHex(rgb: RGB): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const r = clamp(rgb.r).toString(16).padStart(2, '0');
  const g = clamp(rgb.g).toString(16).padStart(2, '0');
  const b = clamp(rgb.b).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

// ─── sRGB Gamma ──────────────────────────────────────────────────────────────

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// ─── sRGB ↔ Oklab (via LMS) ─────────────────────────────────────────────────
// Reference: https://bottosson.github.io/posts/oklab/

function srgbToOklab(rgb: RGB): OklabColor {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l = Math.cbrt(l_);
  const m = Math.cbrt(m_);
  const s = Math.cbrt(s_);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToSRGB(lab: OklabColor): RGB {
  const l = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;

  const l_ = l * l * l;
  const m_ = m * m * m;
  const s_ = s * s * s;

  return {
    r: linearToSrgb(Math.max(0, +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    g: linearToSrgb(Math.max(0, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    b: linearToSrgb(Math.max(0, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
  };
}

// ─── Oklab ↔ OkLCH ──────────────────────────────────────────────────────────

function oklabToOklch(lab: OklabColor): OklchColor {
  const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let h = Math.atan2(lab.b, lab.a) * (180 / Math.PI);
  if (h < 0) h += 360;
  return { L: lab.L, C, h };
}

function oklchToOklab(lch: OklchColor): OklabColor {
  const hRad = lch.h * (Math.PI / 180);
  return {
    L: lch.L,
    a: lch.C * Math.cos(hRad),
    b: lch.C * Math.sin(hRad),
  };
}

// ─── Hue Interpolation ──────────────────────────────────────────────────────

/**
 * Interpolate between two hue angles (in degrees) using the specified mode.
 */
function interpolateHue(h0: number, h1: number, t: number, mode: HueMode = 'shorter'): number {
  // Normalize to [0, 360)
  h0 = ((h0 % 360) + 360) % 360;
  h1 = ((h1 % 360) + 360) % 360;

  let diff = h1 - h0;

  switch (mode) {
    case 'shorter':
      if (diff > 180) diff -= 360;
      else if (diff < -180) diff += 360;
      break;
    case 'longer':
      if (diff > 0 && diff < 180) diff -= 360;
      else if (diff < 0 && diff > -180) diff += 360;
      break;
    case 'increasing':
      if (diff < 0) diff += 360;
      break;
    case 'decreasing':
      if (diff > 0) diff -= 360;
      break;
  }

  const result = h0 + diff * t;
  return ((result % 360) + 360) % 360;
}

// ─── Color Interpolation ────────────────────────────────────────────────────

/**
 * Interpolate between two CSS hex colors in the specified color space.
 *
 * @param color0 - Start color (CSS hex)
 * @param color1 - End color (CSS hex)
 * @param t - Normalized parameter [0, 1]
 * @param space - Color space for interpolation
 * @param hueMode - How to resolve hue arc direction (only for polar spaces)
 */
export function interpolateColor(
  color0: string,
  color1: string,
  t: number,
  space: ColorSpace = 'oklab',
  hueMode: HueMode = 'shorter',
): string {
  const rgb0 = parseHexToRGB(color0);
  const rgb1 = parseHexToRGB(color1);

  switch (space) {
    case 'rgb':
    case 'srgb': {
      return rgbToHex({
        r: rgb0.r + (rgb1.r - rgb0.r) * t,
        g: rgb0.g + (rgb1.g - rgb0.g) * t,
        b: rgb0.b + (rgb1.b - rgb0.b) * t,
      });
    }

    case 'oklab': {
      const lab0 = srgbToOklab(rgb0);
      const lab1 = srgbToOklab(rgb1);
      const blended: OklabColor = {
        L: lab0.L + (lab1.L - lab0.L) * t,
        a: lab0.a + (lab1.a - lab0.a) * t,
        b: lab0.b + (lab1.b - lab0.b) * t,
      };
      return rgbToHex(oklabToSRGB(blended));
    }

    case 'oklch':
    case 'lch': {
      const lch0 = oklabToOklch(srgbToOklab(rgb0));
      const lch1 = oklabToOklch(srgbToOklab(rgb1));

      // Handle achromatic colors (near-zero chroma = undefined hue)
      const isAchromatic0 = lch0.C < 0.005;
      const isAchromatic1 = lch1.C < 0.005;

      let h: number;
      if (isAchromatic0 && isAchromatic1) {
        h = 0; // Both achromatic — hue doesn't matter
      } else if (isAchromatic0) {
        h = lch1.h; // Inherit hue from the chromatic color
      } else if (isAchromatic1) {
        h = lch0.h;
      } else {
        h = interpolateHue(lch0.h, lch1.h, t, hueMode);
      }

      const blended: OklchColor = {
        L: lch0.L + (lch1.L - lch0.L) * t,
        C: lch0.C + (lch1.C - lch0.C) * t,
        h,
      };
      return rgbToHex(oklabToSRGB(oklchToOklab(blended)));
    }

    default:
      // Fallback to sRGB
      return rgbToHex({
        r: rgb0.r + (rgb1.r - rgb0.r) * t,
        g: rgb0.g + (rgb1.g - rgb0.g) * t,
        b: rgb0.b + (rgb1.b - rgb0.b) * t,
      });
  }
}

/**
 * Check if a string looks like a CSS color value.
 */
export function isColorValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^#([0-9a-fA-F]{3,8})$/.test(value) || /^rgba?\(/.test(value) || /^hsla?\(/.test(value);
}

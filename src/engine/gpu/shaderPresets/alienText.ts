/**
 * Alien Text Field — A thousand alien typists typing into the void.
 * Lines of procedural alien characters appear one-by-one, each character
 * fading in slowly with its own independent lifetime before dissolving.
 * Each strand goes in a different direction at a different depth.
 * p0 = density (number of active strands), p1 = glow brightness.
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const ALIEN_TEXT_PRESET: ShaderPreset = {
  id: 'alienText',
  label: 'Alien Text',
  description: 'Thousands of alien typists writing glowing glyphs into the void',
  palette: 'cyberpunk',
  params: [
    { id: 'density', label: 'Density', slot: 'p0', min: 0.0, max: 1.0, default: 0.5, step: 0.01 },
    {
      id: 'glowBrightness',
      label: 'Glow',
      slot: 'p1',
      min: 0.0,
      max: 1.0,
      default: 0.6,
      step: 0.01,
    },
  ],
  body: /* wgsl */ `
const PI: f32 = 3.14159265;
const MAX_LINES: i32 = 36;      // Maximum concurrent strands
const CHARS_PER_LINE: i32 = 14; // Max characters per strand
const LINE_CYCLE: f32 = 7.0;    // Base cycle duration per strand

// ─── Alien Character SDF ────────────────────────────────────
// Procedural alien glyph built from randomized line segments

fn alienCharSDF(p: vec2f, seed: f32) -> f32 {
  var minD = 999.0;
  let numSegs = 2 + i32(hash11(seed * 7.13) * 2.5);
  for (var i = 0; i < 4; i++) {
    if (i >= numSegs) { break; }
    let fi = f32(i);
    let ax = hash11(seed + fi * 3.7) * 1.4 - 0.7;
    let ay = hash11(seed + fi * 5.1 + 0.3) * 1.4 - 0.7;
    let bx = hash11(seed + fi * 2.3 + 1.1) * 1.4 - 0.7;
    let by = hash11(seed + fi * 4.9 + 2.7) * 1.4 - 0.7;
    let pa = p - vec2f(ax, ay);
    let ba = vec2f(bx, by) - vec2f(ax, ay);
    let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    let d = length(pa - ba * h);
    minD = min(minD, d);
  }
  // Occasional arc or dot accent
  if (hash11(seed + 19.0) > 0.5) {
    let dp = vec2f(hash11(seed + 11.1) * 1.0 - 0.5, hash11(seed + 13.3) * 1.0 - 0.5);
    let radius = 0.08 + hash11(seed + 15.0) * 0.12;
    minD = min(minD, length(p - dp) - radius);
  }
  // Occasional cross-bar
  if (hash11(seed + 22.0) > 0.7) {
    let cy = hash11(seed + 23.0) * 1.0 - 0.5;
    let barD = abs(p.y - cy) - 0.04;
    let barClip = smoothstep(0.6, 0.5, abs(p.x));
    minD = min(minD, max(barD, 1.0 - barClip));
  }
  return minD;
}

// ─── Per-Character Lifetime ─────────────────────────────────
// Each character independently fades in, holds, then fades out

fn charAlpha(t: f32, charBirth: f32, fadeIn: f32, hold: f32, fadeOut: f32) -> f32 {
  let age = t - charBirth;
  if (age < 0.0) { return 0.0; }
  if (age < fadeIn) { return age / fadeIn; }
  if (age < fadeIn + hold) { return 1.0; }
  let fadeAge = age - fadeIn - hold;
  if (fadeAge < fadeOut) { return 1.0 - fadeAge / fadeOut; }
  return 0.0;
}

// ─── Render One Strand ──────────────────────────────────────

fn alienTextLine(uv: vec2f, t: f32, lineId: i32) -> vec3f {
  let fi = f32(lineId);
  let seed = fi * 23.71 + 5.3;

  // Each strand has a staggered start and cycle length
  let linePhase = hash11(seed) * LINE_CYCLE;
  let lineCycle = LINE_CYCLE + hash11(seed + 1.0) * 4.0;
  let lineStart = floor((t + linePhase) / lineCycle) * lineCycle - linePhase;

  // Strand origin position (scattered across screen)
  let lineY = hash11(seed + 2.0) * 0.9 + 0.05;
  let lineX = hash11(seed + 3.0) * 0.9 + 0.05;

  // Per-strand DIRECTION — each types at a unique angle
  let strandAngle = hash11(seed + 20.0) * PI * 2.0;
  let strandDir = vec2f(cos(strandAngle), sin(strandAngle));

  // Per-strand DEPTH — varies character size and brightness
  let depthFactor = 0.5 + hash11(seed + 21.0) * 1.5; // 0.5 (close/big) to 2.0 (far/small)
  let charW = 0.014 / depthFactor;
  let charH = 0.020 / depthFactor;
  let spacing = charW * 1.4;

  // Brightness inverse-square with distance
  let distBrightness = 1.0 / (depthFactor * depthFactor);

  // Per-character timing (varies per strand for organic feel)
  let typeDelay = 0.2 + hash11(seed + 8.0) * 0.2;
  let fadeIn = 0.5 + hash11(seed + 9.0) * 0.5;
  let holdTime = 1.2 + hash11(seed + 10.0) * 2.0;
  let fadeOut = 0.8 + hash11(seed + 11.0) * 1.2;

  var lineBrightness = 0.0;

  for (var c = 0; c < CHARS_PER_LINE; c++) {
    // Character position along strand direction
    let charOffset = strandDir * f32(c) * spacing;
    let charCenter = vec2f(lineX, lineY) + charOffset;
    let toChar = uv - charCenter;

    // Early-out: circular distance check
    let charRadius = max(charW, charH) * 1.5;
    if (length(toChar) > charRadius) { continue; }

    // Birth time for this character
    let charBirth = lineStart + f32(c) * typeDelay;

    // Independent per-character alpha
    let alpha = charAlpha(t, charBirth, fadeIn, holdTime, fadeOut);
    if (alpha < 0.01) { continue; }

    // Rotate pixel into character-local space (aligned to strand direction)
    let cosA = strandDir.x;
    let sinA = strandDir.y;
    let rotated = vec2f(
      toChar.x * cosA + toChar.y * sinA,
      -toChar.x * sinA + toChar.y * cosA
    );
    let localP = rotated / vec2f(charW, charH);

    if (abs(localP.x) > 1.3 || abs(localP.y) > 1.3) { continue; }

    // Unique character shape (regenerates each cycle)
    let charSeed = seed + f32(c) * 11.3 + 200.0 + floor((t + linePhase) / lineCycle) * 77.0;
    let d = alienCharSDF(localP, charSeed);

    // Crisp glyph with soft edge, modulated by per-char lifetime
    let charBright = smoothstep(0.14, 0.04, d) * alpha;

    lineBrightness = max(lineBrightness, charBright);
  }

  // Per-strand color from palette (teal → violet range)
  let hue = 0.45 + hash11(seed + 7.0) * 0.4;
  let lineCol = palette(hue + t * 0.003);

  return lineCol * lineBrightness * distBrightness;
}

// ─── Main Render ────────────────────────────────────────────

fn render(uv: vec2f) -> vec4f {
  let t = u_time();
  let density = u_p0();
  let brightness = 0.4 + u_p1() * 1.2;

  // Number of active strands scales with density param
  let numActive = i32(8.0 + density * f32(MAX_LINES - 8));

  var col = vec3f(0.0);

  for (var g = 0; g < MAX_LINES; g++) {
    if (g >= numActive) { break; }
    col += alienTextLine(uv, t, g);
  }

  col *= brightness;

  // Subtle vignette
  let vignette = 1.0 - length(uv - 0.5) * 0.6;
  col *= vignette;

  let final_col = clamp(col, vec3f(0.0), vec3f(3.0));
  return vec4f(final_col, 1.0);
}
`,
};

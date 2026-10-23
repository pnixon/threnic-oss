/**
 * Snow — falling/rising particle field with wind eddies and audio-reactive behavior.
 * p0: direction (negative = fall down, positive = rise up)
 * p1: particle density
 * Audio: bass → size pulse, mid → eddy intensity + lateral drift, treb → sparkle,
 *        beat → speed burst, energy → eddy turbulence
 * Palette: ice (cool blues/whites)
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const STAR_WARP_PRESET: ShaderPreset = {
  id: 'starWarp',
  label: 'Snow',
  description: 'Audio-reactive snowfall with wind eddies, swirls, and configurable direction',
  palette: 'ice',
  params: [
    {
      id: 'direction',
      label: 'Direction',
      slot: 'p0',
      min: -2.0,
      max: 2.0,
      default: 1.0,
      step: 0.1,
    },
    { id: 'density', label: 'Density', slot: 'p1', min: 4.0, max: 30.0, default: 12.0, step: 1.0 },
  ],
  body: /* wgsl */ `
// ── Curl noise for wind eddies ──────────────────────────────
// Returns a 2D divergence-free displacement (curl of scalar noise field).
// This creates natural swirling patterns — particles follow the flow
// without bunching or spreading.
fn curlNoise(p: vec2f, t: f32) -> vec2f {
  let eps = 0.01;
  // Sample noise field at offsets to compute partial derivatives
  let n_x0 = noise2d(vec2f(p.x - eps, p.y) + t * 0.3);
  let n_x1 = noise2d(vec2f(p.x + eps, p.y) + t * 0.3);
  let n_y0 = noise2d(vec2f(p.x, p.y - eps) + t * 0.3);
  let n_y1 = noise2d(vec2f(p.x, p.y + eps) + t * 0.3);
  // Curl: perpendicular to gradient → divergence-free flow
  let dndx = (n_x1 - n_x0) / (2.0 * eps);
  let dndy = (n_y1 - n_y0) / (2.0 * eps);
  return vec2f(dndy, -dndx);
}

// Multi-octave wind field with eddies at different scales
fn windField(p: vec2f, t: f32, intensity: f32) -> vec2f {
  // Large slow eddies
  let large = curlNoise(p * 0.8, t * 0.15) * 0.6;
  // Medium eddies — faster rotation
  let medium = curlNoise(p * 2.0 + 3.7, t * 0.35) * 0.3;
  // Small turbulent gusts
  let small = curlNoise(p * 4.5 + 7.1, t * 0.7) * 0.1;

  return (large + medium + small) * intensity;
}

// ── Snow particle (unchanged from before) ───────────────────
fn snowParticle(fragUV: vec2f, cellId: vec2f, scale: f32, t: f32, drift: f32, sizeMul: f32) -> f32 {
  let rnd = hash22(cellId);
  let center = cellId + rnd * 0.85 + 0.075;

  // Lateral sway
  let sway = sin(t * (rnd.x * 2.0 + 0.5) + rnd.y * 6.28) * drift;

  let particlePos = vec2f(center.x + sway, center.y);
  let delta = fragUV - particlePos;
  let d = length(delta);

  // Small particle radius
  let baseRadius = (0.008 + rnd.x * 0.012) * (20.0 / scale);
  let radius = baseRadius * sizeMul;

  // Soft circle falloff
  let particle = smoothstep(radius, radius * 0.2, d);

  // Twinkle
  let twinkle = sin(t * (rnd.x * 4.0 + 2.0) + rnd.y * 6.28) * 0.5 + 0.5;
  return particle * (0.7 + twinkle * 0.3);
}

// ── Snow layer with neighbor sampling ───────────────────────
fn snowLayer(uv_in: vec2f, scale: f32, t: f32, drift: f32, sizeMul: f32) -> f32 {
  let uv = uv_in * scale;
  let cellId = floor(uv);

  var acc = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let neighbor = cellId + vec2f(f32(dx), f32(dy));
      acc += snowParticle(uv, neighbor, scale, t, drift, sizeMul);
    }
  }
  return min(acc, 1.0);
}

fn render(uv: vec2f) -> vec4f {
  let res = u_resolution();
  let aspect = res.x / res.y;
  var p = (uv - 0.5) * vec2f(aspect, 1.0);

  let baseTime = u_time();
  let direction = u_p0();
  let density = u_p1();
  let sens = u_sensitivity();

  // Audio inputs
  let bass = u_bass() * sens;
  let mid = u_mid() * sens;
  let treb = u_treb() * sens;
  let beat = u_beat() * sens;
  let energy = u_energy() * sens;

  // Audio-reactive parameters
  let speedMul = 1.0 + beat * 1.2;
  let sizeMul = 1.0 + bass * 0.6;
  let driftAmount = 0.03 + mid * 0.1;
  let sparkleMul = 1.0 + treb * 0.5;

  // Wind eddy intensity — driven by mid + energy for musical swirling
  let eddyIntensity = 0.04 + mid * 0.08 + energy * 0.06;

  let t = baseTime * 0.4 * speedMul;

  // Accumulate snow layers at different depths (parallax)
  var snow = 0.0;
  var colorMix = 0.0;
  for (var i = 0; i < 4; i++) {
    let fi = f32(i);
    let layerScale = density * (0.7 + fi * 0.5);
    let layerSpeed = t * (0.3 + fi * 0.2);

    // Base scroll (gravity direction)
    let scroll = vec2f(
      sin(baseTime * 0.08 * (fi + 1.0)) * 0.03,
      -direction * layerSpeed
    );

    // Apply wind eddies — each layer gets slightly offset wind sampling
    // so eddies don't perfectly align across depths (more realistic)
    let windSamplePos = p * (1.0 + fi * 0.2) + vec2f(fi * 1.3, fi * 0.7);
    let windTime = baseTime * (0.8 + fi * 0.15);
    let wind = windField(windSamplePos, windTime, eddyIntensity * (1.0 + fi * 0.3));

    let finalUV = p + scroll + wind;

    let s = snowLayer(finalUV, layerScale, baseTime, driftAmount, sizeMul);

    // Depth-based brightness (closer layers brighter)
    let depth = 1.0 - fi * 0.18;
    snow += s * depth * sparkleMul;
    colorMix += s * fi * 0.12;
  }

  // Subtle glow
  let glow = snow * 0.1 * (1.0 + energy * 0.2);

  // Palette coloring — mostly white/blue for snow
  let col = palette(colorMix * 0.2 + 0.1);
  let white = vec3f(0.95, 0.97, 1.0);

  // Mix between pure white and palette tint
  let tinted = mix(white, col, 0.25 + treb * 0.15);
  let base = tinted * snow + white * glow;

  // Per-pixel alpha = particle coverage (transparent where no snow)
  let coverage = clamp(snow + glow, 0.0, 1.0);
  return vec4f(base, coverage);
}
`,
};

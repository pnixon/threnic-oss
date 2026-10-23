/**
 * Blizzard — a violent Antarctic whiteout for 'La Tempête / Le Massacre'.
 * Driven snow streaks across the screen at a wind-blown angle, gusts surge with
 * the music, howling turbulence via fbm, near-total white-out at peaks, and a
 * blood tint bleeds in on heavy beats (blood-snow palette).
 * Palette: blood-snow
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const BLIZZARD_PRESET: ShaderPreset = {
  id: 'blizzard',
  label: 'Blizzard',
  description:
    'Violent Antarctic whiteout — wind-driven snow streaks, music-surging gusts, and blood-tinted beats',
  palette: 'blood-snow',
  params: [
    {
      id: 'windSpeed',
      label: 'Wind Speed',
      slot: 'p0',
      min: 0.0,
      max: 2.0,
      default: 0.8,
      step: 0.05,
    },
    {
      id: 'snowDensity',
      label: 'Snow Density',
      slot: 'p1',
      min: 0.0,
      max: 2.0,
      default: 1.0,
      step: 0.05,
    },
  ],
  body: /* wgsl */ `
// ─── Blizzard — driven Antarctic whiteout ───────────────────────────────────

// One layer of hashed snow particles advected by a wind vector.
// cellScale controls flake size/density; parallaxes with depth for layering.
fn snowLayer(uv: vec2f, wind: vec2f, cellScale: f32, seedOffset: f32,
             streakLen: f32, glitter: f32) -> f32 {
  // Advect the sampling space by the wind vector (accumulated flow).
  let p = uv * cellScale + wind;

  let cell = floor(p);
  let f = fract(p);

  var acc = 0.0;

  // Sample a small 3x3 neighborhood so streaks can cross cell borders.
  for (var oy = -1; oy <= 1; oy++) {
    for (var ox = -1; ox <= 1; ox++) {
      let g = vec2f(f32(ox), f32(oy));
      let cellId = cell + g;
      // Per-flake random position + brightness.
      let rnd = hash22(cellId + seedOffset);
      let flakePos = g + rnd;
      let d = f - flakePos;

      // Stretch distance ALONG the wind direction into a streak.
      let wdir = normalize(wind + vec2f(0.0001, 0.0001));
      let along = dot(d, wdir);
      let across = d - wdir * along;
      // Squash across-wind, stretch along-wind.
      let stretched = vec2f(along / max(streakLen, 0.001), dot(across, across) * 40.0);
      let dist = length(vec2f(stretched.x, stretched.y * 0.0 + length(across) * 6.0));

      let bright = hash11(dot(cellId, vec2f(12.9898, 78.233)) + seedOffset * 3.7);
      // Fade in/out to avoid a static grid; twinkle for treble glitter.
      let twinkle = 1.0 + glitter * sin(u_time() * 20.0 + bright * 30.0);
      let flake = smoothstep(0.5, 0.0, dist) * bright * twinkle;
      acc = acc + flake;
    }
  }

  return clamp(acc, 0.0, 1.0);
}

fn render(uv: vec2f) -> vec4f {
  let t = u_time();
  let windSpeed = u_p0();
  let density = u_p1();

  let energy = u_energy();
  let bass = u_bass();
  let mid = u_mid();
  let treb = u_treb();
  let beat = u_beat();

  // ── Wind: a blown-in angle modulated by turbulence + audio gusts ──────────
  // Base wind angle blows down-and-across; fbm turbulence makes it howl.
  let gust = windSpeed * (0.6 + energy * 1.4 + bass * 1.0) + beat * 0.8;
  let turb = fbm(uv * 3.0 + vec2f(t * 0.3, t * 0.15), 4) - 0.5;
  let angle = 0.9 + turb * 0.7 + sin(t * 0.7) * 0.15;
  let windDir = vec2f(cos(angle), sin(angle));
  // Accumulated flow offset (advection) — grows with time * gust.
  let flow = windDir * (t * (0.8 + gust * 2.5));

  // ── Fog base: bright whiteout that surges toward pure white at peaks ──────
  let fogNoise = fbm(uv * 2.5 - vec2f(flow.x * 0.2, flow.y * 0.2), 5);
  let whiteout = clamp(0.35 + energy * 0.9 + bass * 0.5 + beat * 0.6, 0.0, 1.0);
  // Palette base (cold snow end of blood-snow) blended toward pure white.
  let fogCol = mix(palette(0.15) * (0.5 + fogNoise * 0.5), vec3f(1.0), whiteout);
  var col = fogCol;

  // ── Layered streaking snow (near → far, parallax via cellScale) ───────────
  var snow = 0.0;
  // Far layer: small, dense, slow parallax.
  snow = snow + snowLayer(uv, flow * 0.6, 26.0 * (0.5 + density), 3.1, 1.0 + gust, treb * 0.6) * 0.5;
  // Mid layer.
  snow = snow + snowLayer(uv, flow * 1.0, 16.0 * (0.5 + density), 11.7, 1.8 + gust * 1.5, treb * 0.5) * 0.7;
  // Near layer: big, fast, long streaks.
  snow = snow + snowLayer(uv, flow * 1.7, 9.0 * (0.5 + density), 23.4, 2.6 + gust * 2.5, treb * 0.4) * 1.0;

  snow = clamp(snow * (0.6 + density * 0.7), 0.0, 1.4);

  // Snow flakes are bright white, slightly boosted by mid energy.
  let snowCol = vec3f(1.0) * (0.85 + mid * 0.3);
  col = col + snowCol * snow;

  // ── Blood tint bleed on heavy beats (blood-snow palette red end) ──────────
  let bloodPulse = clamp(beat * 1.2 + bass * 0.4 - 0.2, 0.0, 1.0);
  let bloodNoise = fbm(uv * 4.0 + vec2f(-flow.y, flow.x) * 0.3, 3);
  let bloodTint = palette(0.85) * bloodPulse * (0.3 + bloodNoise * 0.7);
  col = col + bloodTint;

  // ── Fine ice glitter (treble) sprinkled over everything ───────────────────
  let glitter = hash21(floor(uv * u_resolution() * 0.5) + vec2f(t * 60.0, t * 37.0));
  let glitterMask = step(0.985 - treb * 0.05, glitter);
  col = col + vec3f(1.0) * glitterMask * treb * 0.8;

  // ── Vignette darkening at edges so the storm reads as enveloping ──────────
  let vig = 1.0 - smoothstep(0.5, 1.1, length(uv - vec2f(0.5, 0.5)));
  col = col * (0.75 + vig * 0.25);

  // Overall beat brightness kick.
  col = col * (1.0 + beat * 0.12);

  // Full-scene background: alpha = 1.0.
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.4)), 1.0);
}
`,
};

/**
 * Antarctic Void — a vast, slow, still Lovecraftian Antarctic vista for a
 * symphonic-metal opera of "At the Mountains of Madness". Slow drifting aurora
 * ribbons across the upper sky, a cold starfield behind them, and low drifting
 * ice-fog near the horizon. Immense and calm — motion is slow and majestic.
 * Palette: antarctic-ice (cold blue/teal cosine palette defined in index.ts).
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const ANTARCTIC_VOID_PRESET: ShaderPreset = {
  id: 'antarcticVoid',
  label: 'Antarctic Void',
  description:
    'Slow drifting aurora ribbons over a cold starfield and low ice-fog — vast, still, and immense',
  palette: 'antarctic-ice',
  params: [
    {
      id: 'auroraSpeed',
      label: 'Aurora Drift Speed',
      slot: 'p0',
      min: 0.0,
      max: 1.0,
      default: 0.15,
      step: 0.01,
    },
    {
      id: 'auroraIntensity',
      label: 'Aurora Intensity',
      slot: 'p1',
      min: 0.0,
      max: 2.0,
      default: 1.0,
      step: 0.05,
    },
  ],
  body: /* wgsl */ `
// ─── Antarctic Void — aurora / starfield / ice-fog ──────────────────────────

const HORIZON: f32 = 0.62;   // sky above, snow plain below

// Cold starfield behind the aurora. Twinkle is slow and subtle.
fn starfield(uv: vec2f, t: f32) -> vec3f {
  // Only stars in the sky region.
  let skyMask = smoothstep(HORIZON + 0.02, HORIZON - 0.35, uv.y);
  if (skyMask < 0.001) {
    return vec3f(0.0);
  }

  // Cell grid; each cell may host one star.
  let scale = 60.0;
  let p = uv * vec2f(scale, scale * 0.6);
  let cell = floor(p);
  let f = fract(p);

  let rnd = hash21(cell);
  // Sparse: only ~18% of cells contain a star.
  let present = step(0.82, rnd);

  let starPos = hash22(cell);
  let d = distance(f, starPos);

  // Slow independent twinkle per star.
  let phase = hash21(cell + vec2f(7.0, 13.0)) * 6.2831853;
  let twinkle = 0.55 + 0.45 * sin(t * 0.5 + phase);

  let core = smoothstep(0.06, 0.0, d) * present * twinkle;
  let brightness = 0.35 + hash21(cell + vec2f(3.0, 1.0)) * 0.65;

  // Cool white with a faint palette tint from the cold end.
  let starCol = mix(vec3f(0.7, 0.8, 1.0), palette(0.05), 0.4);
  return starCol * core * brightness * skyMask;
}

// A single wavering aurora ribbon at a given base height with its own drift.
fn auroraRibbon(uv: vec2f, t: f32, baseY: f32, seed: f32,
                paletteT: f32, speed: f32, intensity: f32) -> vec3f {
  // Horizontal drift of the ribbon's waveform.
  let drift = t * speed * (0.35 + seed * 0.25);

  // Low-frequency vertical sway of the ribbon centreline.
  let sway = sin(uv.x * 2.3 + drift + seed * 6.0) * 0.05
           + sin(uv.x * 5.1 - drift * 0.7 + seed * 2.0) * 0.02
           + fbm(vec2f(uv.x * 1.5 + drift * 0.5, seed * 10.0), 3) * 0.04 - 0.02;

  let centre = baseY + sway;

  // Vertical falloff — a soft glowing band.
  let dist = abs(uv.y - centre);
  let band = exp(-dist * dist * 900.0);

  // Vertical curtain striations that shimmer slowly along the ribbon.
  let curtain = 0.7 + 0.3 * sin(uv.x * 40.0 + drift * 4.0 + seed * 3.0)
                    * sin(uv.x * 13.0 - drift * 2.0);

  // Fade the ribbon edges near the frame sides so it feels boundless.
  let edgeFade = smoothstep(0.0, 0.15, uv.x) * smoothstep(1.0, 0.85, uv.x);

  let col = palette(paletteT) * band * curtain * edgeFade;
  return col * intensity;
}

fn render(uv: vec2f) -> vec4f {
  let t = u_time();
  let speed = u_p0();          // aurora drift speed
  let intensity = u_p1();      // aurora intensity

  let bass = u_bass();
  let mid = u_mid();
  let energy = u_energy();
  let beat = u_beat();

  // ── Cold sky gradient: deep void at top, faint glow toward the horizon ──
  let skyGrad = smoothstep(HORIZON, -0.1, uv.y);
  let voidTop = palette(0.0) * 0.04;
  let voidLow = palette(0.12) * 0.10;
  var col = mix(voidTop, voidLow, skyGrad);

  // ── Starfield behind the aurora ──
  col += starfield(uv, t);

  // ── Aurora ribbons — audio brightens & sways them, but stays slow ──
  // mid drives the shimmer, energy adds a gentle overall lift.
  let auroraGain = intensity * (0.8 + mid * 0.6 + energy * 0.4);
  // beat gives a subtle shimmer pulse.
  let shimmer = 1.0 + beat * 0.12;

  col += auroraRibbon(uv, t, 0.24, 0.0, 0.35, speed, auroraGain * shimmer);
  col += auroraRibbon(uv, t, 0.33, 1.7, 0.55, speed, auroraGain * 0.8 * shimmer);
  col += auroraRibbon(uv, t, 0.42, 3.4, 0.70, speed, auroraGain * 0.6 * shimmer);

  // ── Horizon swell: a slow bass swell brightens the base of the sky ──
  let horizonDist = abs(uv.y - HORIZON);
  let swell = sin(t * 0.12) * 0.5 + 0.5;                // slow breathing
  let horizonGlow = exp(-horizonDist * 10.0)
                  * (0.10 + bass * 0.35 + swell * 0.06);
  col += palette(0.45) * horizonGlow;

  // ── Snow plain below the horizon: cold, dim, faintly lit by the aurora ──
  let plainMask = smoothstep(HORIZON - 0.01, HORIZON + 0.01, uv.y);
  let plainBase = palette(0.15) * 0.06;
  // Very slow undulating snow texture.
  let snow = fbm(vec2f(uv.x * 4.0, uv.y * 8.0 + t * 0.02), 4) * 0.04;
  let plain = (plainBase + palette(0.2) * snow) * plainMask;
  col += plain;

  // ── Low drifting ice-fog / ground haze near the bottom ──
  let fogRegion = smoothstep(1.0, 0.55, uv.y);          // strongest at bottom
  let fogT = t * speed * 0.4;
  let fog = fbm(vec2f(uv.x * 3.0 + fogT, uv.y * 6.0 - fogT * 0.3), 4);
  let fogBand = smoothstep(0.35, 0.75, fog) * fogRegion;
  col += palette(0.28) * fogBand * (0.10 + energy * 0.05);

  // ── Overall calm brightness; keep it dim and vast ──
  col *= 1.0 + beat * 0.05;

  return vec4f(col, 1.0);
}
`,
};

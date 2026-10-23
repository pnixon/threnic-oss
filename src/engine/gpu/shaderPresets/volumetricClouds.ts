/**
 * Volumetric Clouds — fly-through raymarched clouds rushing toward the camera,
 * bass-reactive density, treble lightning flashes, palette-driven sky and clouds.
 * Camera altitude bobs gently. Clouds have clear edges and visible structure.
 * Palette: ice (cool blues/whites)
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const VOLUMETRIC_CLOUDS_PRESET: ShaderPreset = {
  id: 'volumetricClouds',
  label: 'Volumetric Clouds',
  description: 'Fly-through volumetric clouds with palette-tinted sky and lightning',
  palette: 'ice',
  params: [
    { id: 'density', label: 'Density', slot: 'p0', min: 0.0, max: 1.0, default: 0.5, step: 0.05 },
    {
      id: 'windSpeed',
      label: 'Wind Speed',
      slot: 'p1',
      min: 0.0,
      max: 1.0,
      default: 0.4,
      step: 0.05,
    },
  ],
  body: /* wgsl */ `
fn render(uv: vec2f) -> vec4f {
  let res = u_resolution();
  let aspect = res.x / res.y;
  let p = (uv - 0.5) * vec2f(aspect, 1.0);

  let t = u_time();
  let beat = u_beat();
  let bass = u_bass();
  let mid = u_mid();
  let treb = u_treb();
  let energy = u_energy();

  // Speed: slider maps to 0.3..2.5
  let speed = 0.3 + u_p1() * 2.2;

  // Camera flying forward, gentle altitude bob
  let camY = sin(t * 0.15) * 0.4 + cos(t * 0.09) * 0.2;
  let ro = vec3f(sin(t * 0.08) * 0.6, camY, t * speed);
  let rd = normalize(vec3f(p.x, p.y * 0.9 + 0.05, 1.6));

  // Light from above-right, slightly behind camera
  let lightDir = normalize(vec3f(0.4, 0.8, -0.2));

  // Density threshold from p0: higher p0 = more cloud coverage
  // At 0.5 default, threshold = 0.55 (only noise peaks become clouds)
  let threshold = 0.8 - u_p0() * 0.5;

  var transmit = 1.0;
  var lightAccum = 0.0;
  var depthAccum = 0.0;
  var depth = 0.3;

  for (var i = 0; i < 52; i = i + 1) {
    let pos = ro + rd * depth;

    // Two noise slices at different scales/orientations for 3D structure
    // Higher frequencies than before so clouds have visible edges on screen
    let n1 = fbm(pos.xz * 0.25 + vec2f(pos.y * 0.3, t * 0.015), 5);
    let n2 = fbm(pos.xy * 0.2 + vec2f(pos.z * 0.15, t * 0.01), 4);

    // Combine slices with bass reactivity
    let rawN = n1 * 0.6 + n2 * 0.4;
    let boosted = rawN * (1.0 + bass * 0.5);

    // Sharp density cutoff — only peaks form visible clouds
    let d = max(0.0, (boosted - threshold) * 4.0);

    if (d > 0.001) {
      // Light sampling toward sun
      let lPos = pos + lightDir * 1.0;
      let lN = fbm(lPos.xz * 0.25 + vec2f(lPos.y * 0.3, t * 0.015), 3);
      let lightAtten = exp(-lN * 2.5);

      lightAccum = lightAccum + lightAtten * d * transmit * 0.55;
      depthAccum = depthAccum + depth * d * transmit * 0.018;
      transmit = transmit * exp(-d * 0.55);
    }

    // Adaptive stepping
    depth = depth + 0.3 + depth * 0.035;
    if (transmit < 0.015 || depth > 28.0) { break; }
  }

  // Sky: palette gradient — darker at top, lighter toward horizon
  let skyTop = palette(0.7 + energy * 0.05) * 0.35;
  let skyBot = palette(0.45) * 1.0;
  let skyCol = mix(skyBot, skyTop, clamp(p.y + 0.55, 0.0, 1.0));

  // Cloud colors from palette — bright lit side, dark shadow
  let litCol = palette(0.1) * (1.1 + lightAccum * 2.5);
  let shadowCol = palette(0.85) * 0.25;
  let cloudCol = mix(shadowCol, litCol, clamp(lightAccum * 4.0, 0.0, 1.0));

  // Mid-reactive: clouds brighten slightly on mids
  let midLift = mid * 0.15 * (1.0 - transmit);

  // Depth fog — distant clouds fade toward sky color
  let fogFactor = 1.0 - exp(-depthAccum * 0.35);
  let foggedCloud = mix(cloudCol, skyCol * 0.7, fogFactor);

  // Lightning flash on treble peaks
  let flash = treb * smoothstep(0.5, 1.0, treb) * 1.5 * (1.0 - transmit);

  // Composite
  var col = skyCol * transmit + foggedCloud * (1.0 - transmit);
  col = col + vec3f(flash) * palette(0.95) * 0.4;
  col = col + vec3f(midLift);

  // Beat pulse — palette rim glow
  let beatGlow = palette(0.3) * beat * 0.12 * (1.0 - transmit);
  col = col + beatGlow;

  return vec4f(col, 1.0);
}
`,
};

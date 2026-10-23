/**
 * Cloud Flight — forward-flying volumetric cloud flythrough.
 * Camera rushes through layered cloud formations with depth fog,
 * directional lighting, and palette-driven colors.
 * Palette: vaporwave (pink/cyan/purple)
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const CLOUD_FLIGHT_PRESET: ShaderPreset = {
  id: 'cloudFlight',
  label: 'Cloud Flight',
  description: 'Forward-flying volumetric cloud flythrough with depth and lighting',
  palette: 'vaporwave',
  params: [
    {
      id: 'flySpeed',
      label: 'Fly Speed',
      slot: 'p0',
      min: 0.0,
      max: 1.0,
      default: 0.4,
      step: 0.05,
    },
    {
      id: 'coverage',
      label: 'Cloud Coverage',
      slot: 'p1',
      min: 0.0,
      max: 1.0,
      default: 0.5,
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

  // Speed from slider: 0..1 maps to 0.2..2.0
  let speed = 0.2 + u_p0() * 1.8;

  // Camera flying forward through Z
  let camZ = t * speed + bass * 0.3;
  let ro = vec3f(sin(t * 0.1) * 0.5, cos(t * 0.07) * 0.3, camZ);
  let rd = normalize(vec3f(p.x, p.y * 0.8 + 0.1, 1.8));

  // Light direction — from above and slightly ahead
  let lightDir = normalize(vec3f(0.3, 0.7, 0.5));

  // Coverage threshold from p1
  let threshold = 0.9 - u_p1() * 0.6;

  // Raymarch through cloud volume
  var transmit = 1.0;
  var lightAccum = 0.0;
  var colorDepth = 0.0;
  var depth = 0.2;
  let maxDist = 30.0;

  for (var i = 0; i < 56; i = i + 1) {
    let pos = ro + rd * depth;

    // 3D cloud density via two 2D slices at different orientations
    let n1 = fbm(pos.xz * 0.08 + vec2f(pos.y * 0.15, t * 0.02), 5);
    let n2 = fbm(pos.xy * 0.1 + vec2f(pos.z * 0.08, 0.0), 4);
    let rawDensity = n1 * 0.65 + n2 * 0.35;

    // Bass boosts density (clouds swell on hits)
    let boosted = rawDensity * (1.0 + bass * 0.4);
    let d = max(0.0, (boosted - threshold) * 3.0);

    if (d > 0.001) {
      // Light sampling — check density toward light
      let lPos = pos + lightDir * 1.5;
      let lN = fbm(lPos.xz * 0.08 + vec2f(lPos.y * 0.15, t * 0.02), 3);
      let lightAtten = exp(-lN * 1.8);

      lightAccum = lightAccum + lightAtten * d * transmit * 0.6;
      colorDepth = colorDepth + depth * d * transmit * 0.015;
      transmit = transmit * exp(-d * 0.4);
    }

    // Adaptive step size — larger steps in empty space
    depth = depth + 0.35 + depth * 0.025;
    if (transmit < 0.01 || depth > maxDist) { break; }
  }

  // Sky — palette gradient (dark top, lighter bottom)
  let skyTop = palette(0.65 + energy * 0.1) * 0.4;
  let skyBot = palette(0.4) * 0.9;
  let sky = mix(skyBot, skyTop, clamp(p.y + 0.6, 0.0, 1.0));

  // Cloud colors — lit and shadow from palette
  let litCol = palette(0.15 + mid * 0.1) * (1.0 + lightAccum * 2.5);
  let shadowCol = palette(0.75) * 0.3;
  let cloudCol = mix(shadowCol, litCol, clamp(lightAccum * 3.5, 0.0, 1.0));

  // Depth fog — distant clouds blend toward sky
  let fog = 1.0 - exp(-colorDepth * 0.4);
  let foggedCloud = mix(cloudCol, sky * 0.7, fog);

  // Beat pulse — rim glow on clouds
  let rimGlow = palette(0.3 + beat * 0.2) * beat * 0.2 * (1.0 - transmit);

  // Treb sparkle — subtle highlights
  let sparkle = treb * smoothstep(0.4, 0.9, treb) * 0.3 * (1.0 - transmit);

  // Composite: sky shows through where clouds are thin
  var col = sky * transmit + foggedCloud * (1.0 - transmit);
  col = col + rimGlow + vec3f(sparkle) * palette(0.9);

  return vec4f(col, 1.0);
}
`,
};

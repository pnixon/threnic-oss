/**
 * Storm Clouds — dark roiling storm with layered FBM, frequent lightning
 * cracks on beat, and ember-colored underlighting.
 * Palette: ember
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const STORM_CLOUDS_PRESET: ShaderPreset = {
  id: 'stormClouds',
  label: 'Storm Clouds',
  description: 'Dark roiling storm with lightning cracks and ember underlighting',
  palette: 'ember',
  params: [
    {
      id: 'turbulence',
      label: 'Turbulence',
      slot: 'p0',
      min: 0.0,
      max: 1.0,
      default: 0.7,
      step: 0.05,
    },
    {
      id: 'flashRate',
      label: 'Flash rate',
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
  let react = u_reactivity();
  let turb = 1.0 + u_p0() * 3.0;
  let flow = vec2f(t * 0.08, t * 0.03);

  // Dark layered storm clouds
  let q = p * 1.5 + flow;
  let w1 = fbm(q * turb + flow * 0.5, 5);
  let w2 = fbm(q * turb * 0.7 - flow, 5);
  let storm = fbm(q * 2.0 + vec2f(w1, w2) * 1.5, 5);
  let dark = smoothstep(0.3, 0.8, storm);

  // Base dark cloud color
  var col = palette(0.05 + storm * 0.15) * (0.1 + dark * 0.3);

  // Underlighting from below (fire/city glow)
  let underlight = smoothstep(0.0, -0.5, p.y) * (0.3 + u_bass() * 0.5 * react);
  col = col + palette(0.0) * underlight * 0.6;

  // Lightning — triggered by beat + flash rate
  let flashChance = u_p1();
  let lightning = u_beat() * step(hash11(floor(t * 4.0)), flashChance);
  let branch = smoothstep(0.48, 0.5, fbm(p * 8.0 + vec2f(t * 2.0, t * 1.3), 5));
  col = col + vec3f(0.9, 0.85, 1.0) * lightning * branch * 4.0;

  // Ambient treble shimmer in upper clouds
  col = col + palette(0.6) * u_treb() * react * dark * 0.2;

  return vec4f(col, 1.0);
}
`,
};

/**
 * Ice Core Drill — first-person descent down a vertical bore shaft through
 * layered ice/rock strata that scroll upward past the camera as you sink.
 * Horizontal sediment bands of varying color/thickness with noise-perturbed
 * boundaries, a dark pit ahead, and bass-driven drill-pulse shudder plus a
 * beat-driven boring vibration. Cold, industrial, oppressive, deep.
 * Palette: antarctic-ice (cold blues / pale ice).
 *
 * Approach: a 2D layered-strata field. The vertical coordinate is offset by a
 * descent = u_time() * speed so bands scroll upward as the camera sinks. Bands
 * are quantized with floor/fract, their boundaries perturbed by fbm noise, and
 * tinted via palette(). A radial vignette darkens toward a central bore/pit.
 */

import type { ShaderPreset } from '@/types/effects/shader-overlay';

export const ICE_CORE_DRILL_PRESET: ShaderPreset = {
  id: 'iceCoreDrill',
  label: 'Ice Core Drill',
  description: 'A first-person descent down a bore shaft through scrolling ice/rock strata',
  palette: 'antarctic-ice',
  params: [
    {
      id: 'descentSpeed',
      label: 'Descent Speed',
      slot: 'p0',
      min: 0.0,
      max: 1.0,
      default: 0.2,
      step: 0.01,
    },
    {
      id: 'strataDensity',
      label: 'Strata Density',
      slot: 'p1',
      min: 1.0,
      max: 20.0,
      default: 8.0,
      step: 1.0,
    },
  ],
  body: /* wgsl */ `
fn render(uv: vec2f) -> vec4f {
  let res = u_resolution();
  let aspect = res.x / res.y;

  // Centered coords; x scaled by aspect, y positive = up.
  var p = (uv - 0.5) * 2.0;
  p.x *= aspect;
  p.y = -p.y;

  let t = u_time();
  let bass = u_bass();
  let mid = u_mid();
  let treb = u_treb();
  let beat = u_beat();
  let energy = u_energy();

  // ─── Descent: bands scroll UP past the camera as we sink DOWN ───
  let speed = 0.05 + u_p0() * 1.2;
  let descent = t * speed + u_pulsePhase() * 0.15;

  // Bass drives a drill-pulse shudder: a low-frequency vertical wobble that
  // shakes the whole strata column when the bass hits.
  let shudder = sin(t * 9.0) * bass * 0.06 + sin(t * 23.0) * bass * 0.02;

  // Beat drives a sharp boring-vibration jolt (fast, small, decays with beat).
  let jolt = sin(t * 61.0) * beat * 0.025;

  // Sample coordinate down the bore. Perspective-ish squeeze toward center so
  // strata appear to converge into the pit ahead.
  let radius = length(p);
  let converge = 1.0 + radius * 0.6;
  let sampleY = p.y * converge + descent + shudder + jolt;
  let sampleX = p.x * converge;

  // ─── Strata banding ───
  // strataDensity (p1) controls how many bands per unit of depth.
  let density = max(u_p1(), 1.0);

  // Perturb band boundaries with fbm so strata are wavy, not ruler-straight.
  let warp = fbm(vec2f(sampleX * 1.3, sampleY * 0.6), 4) - 0.5;
  let bandCoord = sampleY * density + warp * 1.2;

  let bandIndex = floor(bandCoord);
  let bandFrac = fract(bandCoord);

  // Per-band pseudo-random attributes: color seed and thickness modulation.
  let bandSeed = hash11(bandIndex * 1.37 + 4.2);
  let bandSeed2 = hash11(bandIndex * 2.91 + 11.7);

  // Thickness variation: some bands are thin dark seams, others thick pale ice.
  let thickness = mix(0.15, 0.85, bandSeed2);

  // Soft edge between bands (a thin dark seam line at each boundary).
  let edgeLo = smoothstep(0.0, 0.06, bandFrac);
  let edgeHi = smoothstep(0.0, 0.06, 1.0 - bandFrac);
  let seam = edgeLo * edgeHi;

  // Interior fill amount respecting the band's thickness.
  let fill = smoothstep(0.5 - thickness * 0.5, 0.5, bandFrac)
           * smoothstep(0.5 + thickness * 0.5, 0.5, bandFrac);

  // ─── Color: tint each stratum from the antarctic-ice palette ───
  let tintT = fract(bandSeed * 0.8 + bandIndex * 0.017);
  var strataCol = palette(tintT);

  // Darken thin seams into cold shadow; keep thick bands pale/icy.
  let darkSeam = vec3f(0.02, 0.03, 0.05);
  strataCol = mix(darkSeam, strataCol, 0.25 + 0.75 * fill);
  strataCol = mix(strataCol, darkSeam, (1.0 - seam) * 0.7);

  // Fine grain within strata (crushed-ice texture).
  let grain = noise2d(vec2f(sampleX * 40.0, sampleY * 40.0));
  strataCol = strataCol * (0.85 + grain * 0.3);

  // ─── The dark pit / bore ahead ───
  // A central vignette that plunges to near-black at the shaft's vanishing point.
  let pit = smoothstep(0.05, 0.9, radius);
  var col = mix(vec3f(0.005, 0.008, 0.02), strataCol, pit);

  // ─── Bass: drill-pulse glow flashing across the strata on the beat ───
  let pulse = bass * (0.5 + 0.5 * sin(t * 12.0 + sampleY * 3.0));
  col += palette(0.15) * pulse * fill * 0.3;

  // Mid: overall depth lighting boost as the drill bites in.
  col *= 1.0 + mid * 0.2 + energy * 0.1;

  // ─── Treble: glinting ice specks scattered on the strata faces ───
  let speckCell = floor(vec2f(sampleX * 60.0, sampleY * 60.0));
  let speckRand = hash21(speckCell);
  let glint = step(0.985 - treb * 0.02, speckRand) * treb;
  col += palette(0.85) * glint * 1.2;

  // Cold rim darkening at the frame edges (oppressive shaft walls).
  let vign = smoothstep(1.6, 0.3, radius);
  col *= 0.35 + 0.65 * vign;

  let finalCol = clamp(col, vec3f(0.0), vec3f(1.0));
  return vec4f(finalCol, 1.0);
}
`,
};

/**
 * Pulse node — a minimal "draw" stage so the chain has something to feed back.
 *
 * Milkdrop's shapes and waves stages both do this job: they add fresh light
 * into the buffer that the warp stage then smears, zooms, and fades. Without a
 * draw stage a feedback chain converges to black no matter how good the warp
 * is. This one is deliberately simple — an audio-reactive ring plus a
 * waveform-ish band — and is replaced by real custom shapes/waves nodes.
 */

/**
 * Wrap a custom fragment shader body with the standard fullscreen draw node
 * signature. The body has access to `in.uv`, all `md_*` uniforms and helpers
 * from the prelude (md_time, md_bass, md_centered, md_rand, md_hash_mix, etc.)
 * and must return `md_guard(vec4f(rgb, alpha))`.
 */
export function customDrawNodeWGSL(shaderBody: string): string {
  return /* wgsl */ `
@fragment
fn fs_main(in: MDVertexOut) -> @location(0) vec4f {
${shaderBody}
}
`;
}

export function pulseNodeWGSL(): string {
  return /* wgsl */ `
fn md_palette(t: f32) -> vec3f {
  let a = vec3f(0.5, 0.5, 0.5);
  let b = vec3f(0.5, 0.5, 0.5);
  let c = vec3f(1.0, 1.0, 1.0);
  let d = vec3f(0.0, 0.33, 0.67);
  return a + b * cos(MD_TAU * (c * t + d));
}

@fragment
fn fs_main(in: MDVertexOut) -> @location(0) vec4f {
  let p = md_centered(in.uv);
  let rad = length(p);
  let ang = atan2(p.y, p.x);

  // Ring radius follows the beat; thickness follows the mids.
  let radius = 0.28 + 0.18 * md_bass_att() + 0.10 * md_beat();
  let thickness = 0.012 + 0.02 * md_mid();
  let lobes = 3.0 + floor(md_q1());
  let wobble = 0.03 * sin(ang * lobes + md_time() * 1.7) * (0.5 + md_treb());

  let d = abs(rad - radius - wobble);
  let ring = thickness / max(d, 1.0e-4) * 0.25;

  let hue = fract(md_time() * 0.05 + rad * 0.4 + md_q2() * 0.1);
  let color = md_palette(hue) * ring * (0.2 + 1.2 * md_vol_att());

  return md_guard(vec4f(color, 1.0));
}
`;
}

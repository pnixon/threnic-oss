/**
 * Composite node — the only place output resolution enters the pipeline.
 *
 * The feedback chain runs at a fixed internal size (blur radii and warp
 * displacements are measured in pixels, so a 720p preview and a 4K export of
 * the same preset would otherwise not just differ in sharpness — they would be
 * different presets). Composite is where that fixed buffer is scaled to
 * whatever the canvas or encoder actually wants.
 */

export function compositeNodeWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(2) var md_src: texture_2d<f32>;

fn md_echo_uv(uv: vec2f) -> vec2f {
  let z = max(0.0001, md_echo_zoom());
  var e = (uv - vec2f(0.5)) / z + vec2f(0.5);
  let orient = i32(md_echo_orient() + 0.5);
  if (orient == 1 || orient == 3) { e.x = 1.0 - e.x; }
  if (orient == 2 || orient == 3) { e.y = 1.0 - e.y; }
  return e;
}

@fragment
fn fs_main(in: MDVertexOut) -> @location(0) vec4f {
  var c = textureSample(md_src, md_samp, in.uv).rgb;

  // Video echo: a zoomed, optionally flipped copy blended over the base.
  let echoAlpha = md_echo_alpha();
  if (echoAlpha > 0.001) {
    let e = textureSample(md_src, md_samp, md_echo_uv(in.uv)).rgb;
    c = mix(c, e, clamp(echoAlpha, 0.0, 1.0));
  }

  // Brighten / darken / solarize / invert, in Milkdrop's order.
  if (md_brighten() > 0.5) { c = sqrt(clamp(c, vec3f(0.0), vec3f(1.0))); }
  if (md_darken() > 0.5) { c = c * c; }
  if (md_solarize() > 0.5) { c = clamp(c, vec3f(0.0), vec3f(1.0)); c = c * (vec3f(1.0) - c) * 4.0; }
  if (md_invert() > 0.5) { c = vec3f(1.0) - c; }

  c = c * md_gamma_adj();
  c = clamp(c, vec3f(0.0), vec3f(1.0));

  // The chain works in linear light; encode on the way out, matching the rest
  // of the renderer's manual gamma handling.
  let encoded = pow(c, vec3f(1.0 / 2.2));
  let alpha = clamp(md_opacity(), 0.0, 1.0);
  return vec4f(encoded, alpha);
}
`;
}

/**
 * A node that copies an external texture (the scene the rest of the renderer
 * produced) into the feedback buffer, so the warp chain can eat it. Used when
 * the Milkdrop layer sits on top of existing background content.
 */
export function injectNodeWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(2) var md_src: texture_2d<f32>;

@fragment
fn fs_main(in: MDVertexOut) -> @location(0) vec4f {
  let c = textureSample(md_src, md_samp, in.uv);
  // Decode the incoming sRGB-ish content into the chain's linear space.
  return md_guard(vec4f(pow(max(c.rgb, vec3f(0.0)), vec3f(2.2)), c.a));
}
`;
}

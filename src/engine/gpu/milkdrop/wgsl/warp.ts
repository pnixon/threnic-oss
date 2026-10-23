/**
 * Warp node — the feedback step, and the reason the whole engine is sequential.
 *
 * A cols x rows vertex grid samples the previous frame through a displacement
 * built from zoom / rotation / stretch / translation / sinusoidal warp, fades
 * it by decay, and writes it back. Milkdrop evaluated this displacement on the
 * CPU for every grid vertex every frame; here `warp_uv` runs in the vertex
 * stage, so grid density costs almost nothing.
 *
 * Compiled per-vertex equations are injected as `perVertex`: WGSL statements
 * that may read `grid`, `rad`, `ang`, the uniform block, and write `x`, `y`
 * (the sampled source position) before the fixed transform runs.
 */

interface WarpNodeOptions {
  /** Declarations produced by compileWGSL(), inserted at the top of warp_uv. */
  perVertexDeclarations?: string;
  /** Statement body produced by compileWGSL(). */
  perVertex?: string;
  /** Extra WGSL appended verbatim (helper functions a preset needs). */
  extra?: string;
}

export function warpNodeWGSL(options: WarpNodeOptions = {}): string {
  const decls = options.perVertexDeclarations ?? '';
  const body = options.perVertex ?? '';

  return /* wgsl */ `
@group(0) @binding(2) var md_prev: texture_2d<f32>;

${options.extra ?? ''}

fn warp_uv(grid: vec2f) -> vec2f {
  let center = vec2f(md_cx(), md_cy());
  let aspect = md_aspect();

  // Aspect-corrected offset from the rotation centre.
  var p = (grid - center) * aspect;
  let rad = length(p);
  let ang = atan2(p.y, p.x);

  // Per-vertex equations run first and may move the sample point directly.
  var x: f32 = p.x;
  var y: f32 = p.y;
${decls}
${body}
  p = vec2f(x, y);

  // Radial zoom. zoom_exp bends the zoom by distance from the centre, which
  // is what gives Milkdrop presets their tunnel-versus-bulge character.
  let zoom = max(0.0001, md_zoom());
  let zexp = max(0.0001, md_zoom_exp());
  let zoomFactor = md_pow(zoom, md_pow(zexp, rad * 2.0 - 1.0));
  p = p / max(0.0001, zoomFactor);

  // Rotation about the centre.
  let s = sin(md_rot());
  let c = cos(md_rot());
  p = vec2f(p.x * c - p.y * s, p.x * s + p.y * c);

  // Stretch.
  p = p / vec2f(max(0.0001, md_sx()), max(0.0001, md_sy()));

  // Sinusoidal warp — four terms at different scales, animated by warp_speed.
  let w = md_warp() * 0.0035;
  let t = md_time() * md_warp_speed();
  if (w != 0.0) {
    p.x += w * sin(t * 0.333 + (grid.x * -3.0 + grid.y * 14.0) * MD_PI);
    p.x += w * sin(t * 0.753 + (grid.x * 11.0 - grid.y * 3.0) * MD_PI);
    p.y += w * sin(t * 0.375 + (grid.x * 13.0 + grid.y * 5.0) * MD_PI);
    p.y += w * sin(t * 0.825 + (grid.x * -7.0 + grid.y * 9.0) * MD_PI);
  }

  // Translation, then back out of aspect space.
  p -= vec2f(md_dx(), md_dy());
  let src = p / aspect + center;
  return vec2f(md_finite(src.x), md_finite(src.y));
}

@fragment
fn fs_main(in: MDVertexOut) -> @location(0) vec4f {
  let prev = textureSample(md_prev, md_samp, in.src);
  // Decay is per frame, not per second — another consequence of frame-indexed
  // time. A preset fades at the same rate no matter how the host is running.
  let faded = prev * vec4f(vec3f(md_decay()), 1.0);
  return md_guard(faded);
}
`;
}

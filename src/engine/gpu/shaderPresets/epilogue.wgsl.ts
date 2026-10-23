/**
 * Shader Epilogue — shared WGSL postamble for all shader overlay presets.
 *
 * Provides vertex + fragment entry points. The preset body defines:
 *   fn render(uv: vec2f) -> vec4f
 *     .rgb = rendered color
 *     .a   = per-pixel coverage (0 = transparent, 1 = fully opaque)
 *
 * Particle shaders (snow, dust) return alpha = particle brightness so only
 * rendered elements block the background image. Full-scene shaders (clouds,
 * synthwave) return alpha = 1.0.
 *
 * Epilogue applies gamma correction and multiplies alpha by u_opacity().
 */

export const SHADER_EPILOGUE = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
  // Fullscreen triangle (3 verts, no index buffer)
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var out: VertexOutput;
  out.position = vec4f(pos[idx], 0.0, 1.0);
  out.uv = pos[idx] * 0.5 + 0.5;
  // Flip Y so (0,0) is top-left
  out.uv.y = 1.0 - out.uv.y;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let raw = render(input.uv);

  // Gamma correction (linear -> sRGB)
  let gamma = pow(raw.rgb, vec3f(1.0 / 2.2));

  // Per-pixel alpha from shader * global opacity slider
  let alpha = raw.a * u_opacity();

  return vec4f(gamma, alpha);
}
`;

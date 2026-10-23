// ═══════════════════════════════════════════════════════════════
// SDF Text Rendering Shader
//
// GPU-rendered text from a Signed Distance Field font atlas.
// Supports:
//   - Clean anti-aliased text at any scale
//   - Configurable outlines (width, color)
//   - Glow / emission effect
//   - Drop shadow with offset and blur
//   - Per-character opacity
//   - Karaoke-style sweep (color transition based on progress)
//
// Bind group layout:
//   @group(0) @binding(0) — SDF atlas texture (r8unorm)
//   @group(0) @binding(1) — Sampler
//   @group(0) @binding(2) — Uniform buffer (TextUniforms)
//
// Vertex input:
//   Instance buffer with per-glyph quad data (position, UV, color)
// ═══════════════════════════════════════════════════════════════

struct TextUniforms {
  // Camera / viewport
  viewport_size: vec2f,     // Viewport dimensions in pixels
  sdf_params: vec2f,        // x: smoothing width, y: SDF threshold (0.5 default)

  // Text fill color (inactive base)
  fill_color: vec4f,

  // Outline
  outline_color: vec4f,
  outline_width: f32,       // In SDF distance units (0.0 = no outline)

  // Glow
  glow_color_r: f32,
  glow_color_g: f32,
  glow_color_b: f32,
  glow_intensity: f32,      // 0.0 = no glow
  glow_spread: f32,         // SDF distance spread for glow

  // Shadow
  shadow_color_r: f32,
  shadow_color_g: f32,
  shadow_color_b: f32,
  shadow_color_a: f32,
  shadow_offset_x: f32,     // Pixel offset
  shadow_offset_y: f32,
  shadow_blur: f32,          // SDF spread for shadow blur

  // Global
  opacity: f32,              // Global text opacity
  
  // Karaoke
  karaoke_active_color: vec4f, // Color used for the "active" swept part
  is_msdf: f32,                // 0.0 = single-channel SDF (.r); 1.0 = MSDF median(r,g,b)
}

fn median3(a: f32, b: f32, c: f32) -> f32 {
  return max(min(a, b), min(max(a, b), c));
}

// Recover the signed-distance scalar from an atlas sample, honouring the field
// encoding: single-channel reads .r directly, MSDF takes the median of RGB.
fn field_value(uv: vec2f) -> f32 {
  let s = textureSample(sdf_atlas, sdf_sampler, uv);
  if (u.is_msdf > 0.5) {
    return median3(s.r, s.g, s.b);
  }
  return s.r;
}

// Per-glyph instance data (from vertex buffer)
struct GlyphInstance {
  @location(0) position: vec2f,    // Screen-space quad position (top-left)
  @location(1) size: vec2f,        // Quad size in pixels
  @location(2) uv_origin: vec2f,   // Atlas UV origin
  @location(3) uv_extent: vec2f,   // Atlas UV extent
  @location(4) color: vec4f,       // Per-glyph color override (a=0 means use uniform)
  @location(5) extra_params: vec2f, // x: progress (0-1), y: unused
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,          // Atlas UV for SDF lookup
  @location(1) local_uv: vec2f,    // Local 0-1 UV within the glyph quad
  @location(2) glyph_color: vec4f,
  @location(3) progress: f32,      // Karaoke sweep progress
}

@group(0) @binding(0) var sdf_atlas: texture_2d<f32>;
@group(0) @binding(1) var sdf_sampler: sampler;
@group(0) @binding(2) var<uniform> u: TextUniforms;

// ─── Vertex Shader ──────────────────────────────────────────

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  instance: GlyphInstance,
) -> VertexOutput {
  // Fullscreen-triangle-style quad from 4 vertices (triangle strip)
  // Vertex order: 0=TL, 1=TR, 2=BL, 3=BR
  let quad_uv = vec2f(
    select(0.0, 1.0, (vertex_index & 1u) != 0u),
    select(0.0, 1.0, (vertex_index & 2u) != 0u),
  );

  // Screen-space position
  let pixel_pos = instance.position + quad_uv * instance.size;

  // Convert to NDC [-1, 1]
  let ndc = vec2f(
    (pixel_pos.x / u.viewport_size.x) * 2.0 - 1.0,
    1.0 - (pixel_pos.y / u.viewport_size.y) * 2.0, // Y flipped
  );

  // Atlas UV — linear interpolation within the glyph's rect
  let atlas_uv = instance.uv_origin + quad_uv * instance.uv_extent;

  var out: VertexOutput;
  out.position = vec4f(ndc, 0.0, 1.0);
  out.uv = atlas_uv;
  out.local_uv = quad_uv;
  out.glyph_color = instance.color;
  out.progress = instance.extra_params.x;
  return out;
}

// ─── Fragment Shader ────────────────────────────────────────

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // Sample the SDF atlas
  let sdf_value = field_value(input.uv);

  // Determine base fill color (per-glyph override or uniform)
  var fill_inactive = u.fill_color;
  if (input.glyph_color.a > 0.0) {
    fill_inactive = input.glyph_color;
  }

  // Karaoke sweep logic:
  // Blends fill color horizontally based on progress.
  // We use input.local_uv.x (0..1) to determine if this pixel is "active".
  // A small smoothing window (0.05) prevents harsh aliasing on the sweep line.
  let sweep_width = 0.05;
  let is_active = smoothstep(input.progress - sweep_width, input.progress + sweep_width, input.local_uv.x);
  let fill = mix(u.karaoke_active_color, fill_inactive, is_active);

  // Smoothing width — auto-scaled based on SDF mipmap level
  let smooth = u.sdf_params.x;
  let threshold = u.sdf_params.y;

  // ── Shadow layer ──────────────────────────────────────────
  var shadow_alpha = 0.0;
  if (u.shadow_blur > 0.0 || (u.shadow_offset_x != 0.0 || u.shadow_offset_y != 0.0)) {
    let shadow_offset = vec2f(u.shadow_offset_x, u.shadow_offset_y) / u.viewport_size;
    let shadow_sdf = field_value(input.uv - shadow_offset);
    let shadow_edge = threshold - u.shadow_blur;
    shadow_alpha = smoothstep(shadow_edge - smooth, shadow_edge + smooth, shadow_sdf);
    shadow_alpha *= vec4f(u.shadow_color_r, u.shadow_color_g, u.shadow_color_b, u.shadow_color_a).a;
  }

  // ── Glow layer ────────────────────────────────────────────
  var glow_alpha = 0.0;
  if (u.glow_intensity > 0.0) {
    let glow_edge = threshold - u.glow_spread;
    glow_alpha = smoothstep(glow_edge - smooth * 2.0, threshold, sdf_value);
    
    // Scale glow by progress (optional: could make glow stronger on active part)
    let sweep_glow = mix(1.0, 0.5, is_active); 
    glow_alpha *= u.glow_intensity * sweep_glow;
  }

  // ── Outline layer ─────────────────────────────────────────
  var outline_alpha = 0.0;
  if (u.outline_width > 0.0) {
    let outer_edge = threshold - u.outline_width;
    outline_alpha = smoothstep(outer_edge - smooth, outer_edge + smooth, sdf_value);
  }

  // ── Fill layer ────────────────────────────────────────────
  let fill_alpha = smoothstep(threshold - smooth, threshold + smooth, sdf_value);

  // ── Compositing (back to front) ───────────────────────────
  var result = vec4f(0.0);

  // Shadow
  let shadow_color = vec4f(u.shadow_color_r, u.shadow_color_g, u.shadow_color_b, shadow_alpha);
  result = mix(result, shadow_color, shadow_alpha);

  // Glow
  let glow_color = vec4f(u.glow_color_r, u.glow_color_g, u.glow_color_b, glow_alpha);
  result = mix(result, glow_color, glow_alpha * (1.0 - result.a));

  // Outline
  if (u.outline_width > 0.0) {
    result = mix(result, u.outline_color, outline_alpha * (1.0 - fill_alpha));
  }

  // Fill
  result = mix(result, fill, fill_alpha);

  // Global opacity
  result.a *= u.opacity;

  // Discard fully transparent fragments
  if (result.a < 0.004) {
    discard;
  }

  return result;
}

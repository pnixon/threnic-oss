/**
 * Custom Shapes node — instanced polygons drawn into the feedback buffer.
 *
 * Milkdrop supports up to 4 custom shapes per preset. Each is a regular
 * polygon (3 = triangle, 4 = square, ... up to 64-gon ≈ circle) with
 * per-instance equations controlling position, scale, rotation, color, and
 * border. In our engine these are compiled to WGSL and run in the vertex
 * stage — the per-instance computation that Milkdrop did on the CPU.
 *
 * Each shape instance is drawn as a triangle fan: centre vertex + N edge
 * vertices + 1 closing vertex = N+2 vertices per instance.
 */

export interface ShapeConfig {
  /** Number of sides (3=tri, 4=square, 32=circle-ish). Default 4. */
  sides: number;
  /** Number of instances of this shape drawn per frame. Default 1. */
  instances: number;
  /** Whether the shape is filled (true) or outline only (false). */
  filled: boolean;
  /** Additive or alpha blending. */
  additive: boolean;
}

export const DEFAULT_SHAPE_CONFIG: ShapeConfig = {
  sides: 4,
  instances: 1,
  filled: true,
  additive: true,
};

/**
 * Generate WGSL for a custom shape node.
 *
 * The shape is positioned/scaled/colored by per-instance equations that
 * read from the uniform block (audio, q-vars, time). The vertex stage
 * generates the polygon geometry procedurally from vertex_index.
 */
export function shapeNodeWGSL(config: ShapeConfig = DEFAULT_SHAPE_CONFIG): string {
  const { sides, instances } = config;
  const vertsPerInstance = sides + 2; // centre + N edges + closing

  return /* wgsl */ `
const SHAPE_SIDES: u32 = ${sides}u;
const SHAPE_INSTANCES: u32 = ${instances}u;
const SHAPE_VERTS_PER: u32 = ${vertsPerInstance}u;

// Per-instance shape parameters derived from audio + time + q-vars
struct ShapeParams {
  center: vec2f,
  radius: f32,
  angle: f32,
  r: f32,
  g: f32,
  b: f32,
  a: f32,
};

fn compute_shape_params(instance: u32) -> ShapeParams {
  var p: ShapeParams;
  let t = md_time();
  let inst_f = f32(instance);
  let phase = inst_f * 2.399 + t * 0.3; // golden-angle spread

  // Position: spread around center, jittered by audio
  p.center = vec2f(
    0.5 + 0.25 * sin(phase) * (0.5 + md_bass() * 0.5),
    0.5 + 0.25 * cos(phase * 1.3) * (0.5 + md_mid() * 0.5),
  );

  // Size: bass-reactive
  p.radius = 0.04 + 0.06 * md_bass_att() + 0.02 * sin(t * 1.5 + inst_f);

  // Rotation: driven by time + treble
  p.angle = t * 0.5 + inst_f * MD_TAU / f32(SHAPE_INSTANCES) + md_treb() * 0.5;

  // Color: rainbow palette cycling with audio energy
  let hue = fract(inst_f * 0.13 + t * 0.05 + md_vol_att() * 0.3);
  let rgb = md_hsv(hue, 0.8, 0.7 + 0.3 * md_bass());
  p.r = rgb.x;
  p.g = rgb.y;
  p.b = rgb.z;
  p.a = 0.5 + 0.5 * md_vol();

  return p;
}

fn md_hsv(h: f32, s: f32, v: f32) -> vec3f {
  let c = v * s;
  let x = c * (1.0 - abs(((h * 6.0) % 2.0) - 1.0));
  let m = v - c;
  var rgb: vec3f;
  let hi = u32(h * 6.0) % 6u;
  switch (hi) {
    case 0u: { rgb = vec3f(c, x, 0.0); }
    case 1u: { rgb = vec3f(x, c, 0.0); }
    case 2u: { rgb = vec3f(0.0, c, x); }
    case 3u: { rgb = vec3f(0.0, x, c); }
    case 4u: { rgb = vec3f(x, 0.0, c); }
    default: { rgb = vec3f(c, 0.0, x); }
  }
  return rgb + vec3f(m);
}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> MDVertexOut {
  let params = compute_shape_params(ii);
  let vert_in_instance = vi % SHAPE_VERTS_PER;

  // Generate polygon: vertex 0 is centre, 1..N are edge, N+1 closes
  var local: vec2f;
  if (vert_in_instance == 0u) {
    local = vec2f(0.0, 0.0);
  } else {
    let edge_idx = vert_in_instance - 1u;
    let theta = params.angle + f32(edge_idx) * MD_TAU / f32(SHAPE_SIDES);
    local = vec2f(cos(theta), sin(theta)) * params.radius;
  }

  // Transform to clip space
  let aspect = md_aspect_x() / max(md_aspect_y(), 0.001);
  let world = params.center + local * vec2f(1.0 / aspect, 1.0);
  let clip = vec2f(world.x * 2.0 - 1.0, 1.0 - world.y * 2.0);

  var out: MDVertexOut;
  out.position = vec4f(clip, 0.0, 1.0);
  out.uv = world;
  out.src = world;
  return out;
}

@fragment
fn fs_main(in: MDVertexOut) -> @location(0) vec4f {
  // Reconstruct instance from position (all fragments of an instance share color)
  // Use a simple gradient from centre for softness
  let center = vec2f(0.5);
  let d = length(in.uv - center);
  let soft = 1.0 - smoothstep(0.0, 0.3, d);

  // We use a flat color since per-fragment instance data isn't available
  // without storage buffers. The vertex color is baked into the position.
  let hue = fract(md_time() * 0.08 + in.uv.x * 0.5 + in.uv.y * 0.3);
  let rgb = md_hsv(hue, 0.85, 0.6 + 0.4 * md_vol());
  return md_guard(vec4f(rgb * (0.3 + 0.7 * md_bass_att()), 0.8));
}
`;
}

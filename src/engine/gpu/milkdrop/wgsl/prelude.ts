/**
 * Shared WGSL prelude for every node in the Milkdrop pass graph.
 *
 * Provides the frame uniform block and its accessors, the md_* math helpers
 * the IR's WGSL backend emits, deterministic hashing, and the NaN guard.
 *
 * The guard is not optional hygiene. With feedback, a single NaN is permanent:
 * it lands in the buffer and every subsequent frame samples it. Presets divide
 * by audio values that can be zero and take pow() of negatives, so the warp
 * output is clamped and NaN-scrubbed on the way into the buffer.
 */

import { frameUniformWGSL } from '../uniforms';

/** Bind group 0: frame uniforms (0), linear sampler (1), node inputs (2+). */
export const MD_PRELUDE = /* wgsl */ `
${frameUniformWGSL(0, 0)}
@group(0) @binding(1) var md_samp: sampler;

const MD_PI: f32 = 3.14159265358979;
const MD_TAU: f32 = 6.28318530717959;

// ─── IR runtime helpers ─────────────────────────────────────
// These mirror emitJS exactly. If one side changes, the preview and the
// export stop agreeing, so change both or neither.

fn md_finite(x: f32) -> f32 {
  // x != x is true only for NaN; the clamp catches the infinities.
  let safe = select(x, 0.0, x != x);
  return clamp(safe, -1.0e12, 1.0e12);
}

fn md_div(a: f32, b: f32) -> f32 {
  return select(a / b, 0.0, b == 0.0);
}

fn md_mod(a: f32, b: f32) -> f32 {
  return select(a - b * trunc(a / b), 0.0, b == 0.0);
}

fn md_pow(a: f32, b: f32) -> f32 {
  return md_finite(pow(a, b));
}

fn md_log(x: f32) -> f32 {
  return select(log(x), 0.0, x <= 0.0);
}

fn md_log10(x: f32) -> f32 {
  return select(log(x) * 0.43429448190325176, 0.0, x <= 0.0);
}

fn md_invsqrt(x: f32) -> f32 {
  let r = sqrt(abs(x));
  return select(1.0 / r, 0.0, r == 0.0);
}

fn md_sigmoid(x: f32, k: f32) -> f32 {
  return md_finite(1.0 / (1.0 + exp(-x * k)));
}

// ─── Determinism ────────────────────────────────────────────
// All randomness is a pure hash of (value, frame, seed) or (index, frame,
// seed). Nothing samples a time-varying global, so re-rendering frame N
// always produces the same noise.

fn md_hash_mix(seed_in: u32, frame_bits: u32, extra: u32) -> u32 {
  var h: u32 = (seed_in ^ 0x9e3779b9u) * 0x85ebca6bu;
  h = (h ^ frame_bits) * 0xc2b2ae35u;
  h = (h ^ extra) * 0x27d4eb2fu;
  return h ^ (h >> 15u);
}

/** rand(x) from the equation language — matches hash31() in emitJS. */
fn md_rand(x: f32) -> f32 {
  let h = md_hash_mix(
    bitcast<u32>(i32(x * 1000.0)),
    bitcast<u32>(i32(md_frame())),
    bitcast<u32>(i32(md_seed() * 1000.0)),
  );
  return f32(h) / 4294967296.0;
}

/** Per-element randomness: stable for a given (index, frame, seed). */
fn md_rand_index(index: u32) -> f32 {
  let h = md_hash_mix(index, bitcast<u32>(i32(md_frame())), bitcast<u32>(i32(md_seed() * 1000.0)));
  return f32(h) / 4294967296.0;
}

/** Randomness that does NOT vary per frame — stable grain, fixed star fields. */
fn md_rand_static(index: u32) -> f32 {
  let h = md_hash_mix(index, 0u, bitcast<u32>(i32(md_seed() * 1000.0)));
  return f32(h) / 4294967296.0;
}

// ─── Feedback safety ────────────────────────────────────────

/** Scrub NaN and clamp range on anything about to enter the feedback buffer. */
fn md_guard(c: vec4f) -> vec4f {
  let finite = select(c, vec4f(0.0), c != c);
  return clamp(finite, vec4f(-64.0), vec4f(64.0));
}

// ─── Space helpers ──────────────────────────────────────────

fn md_aspect() -> vec2f { return vec2f(md_aspect_x(), md_aspect_y()); }
fn md_texel() -> vec2f { return vec2f(1.0 / md_internal_w(), 1.0 / md_internal_h()); }

/** UV (0..1, y down) to Milkdrop-style centred coords with aspect applied. */
fn md_centered(uv: vec2f) -> vec2f {
  return (uv - vec2f(0.5)) * md_aspect() * 2.0;
}
`;

/** Vertex output shared by every node type. */
export const MD_VARYINGS = /* wgsl */ `
struct MDVertexOut {
  @builtin(position) position: vec4f,
  /** Destination UV in 0..1, y down. */
  @location(0) uv: vec2f,
  /** Source UV for feedback sampling — nodes that do not warp pass uv through. */
  @location(1) src: vec2f,
};
`;

/** Fullscreen triangle vertex stage; `src` equals `uv`. */
export const MD_FULLSCREEN_VS = /* wgsl */ `
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> MDVertexOut {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: MDVertexOut;
  let p = pos[idx];
  out.position = vec4f(p, 0.0, 1.0);
  var uv = p * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  out.uv = uv;
  out.src = uv;
  return out;
}
`;

/**
 * Grid vertex stage. Generates cols x rows quads from vertex_index alone —
 * no vertex or index buffers. The node body supplies
 * `fn warp_uv(grid: vec2f) -> vec2f`, which maps a grid point to the source
 * UV it should sample. That function is where compiled per-vertex equations land.
 */
export function mdGridVertexWGSL(cols: number, rows: number): string {
  return /* wgsl */ `
const MD_GRID_COLS: u32 = ${cols}u;
const MD_GRID_ROWS: u32 = ${rows}u;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> MDVertexOut {
  // 6 vertices per quad: (0,0) (1,0) (0,1) | (1,0) (1,1) (0,1)
  let quad = vi / 6u;
  let corner = vi % 6u;
  let qx = quad % MD_GRID_COLS;
  let qy = quad / MD_GRID_COLS;

  var offs = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 1u),
  );
  let o = offs[corner];
  let gx = f32(qx + o.x) / f32(MD_GRID_COLS);
  let gy = f32(qy + o.y) / f32(MD_GRID_ROWS);
  let grid = vec2f(gx, gy);

  var out: MDVertexOut;
  out.position = vec4f(grid.x * 2.0 - 1.0, 1.0 - grid.y * 2.0, 0.0, 1.0);
  out.uv = grid;
  out.src = warp_uv(grid);
  return out;
}
`;
}

/**
 * Lyric FX — Stage C post effect WGSL (see `docs/lyric-fx-engine-lld.md` §4).
 *
 * Stage C effects are FULLSCREEN passes over the finished lyric target only —
 * that isolation is why text-only bloom is cheap here and expensive in the main
 * chain. Each runs after the surface stack: it samples the current lyric raster
 * (`src`) and writes a transformed raster, ping-ponging target ↔ pong.
 *
 * Each body is `fn post_effect(uv: vec2f) -> vec4f`, assembled prelude + body +
 * epilogue like the surface family. Strings only — unit-testable without a GPU.
 */

import { LYRIC_FX_POST_TYPES, type LyricFXPostType } from '@/types/effects/lyric-fx';

export { LYRIC_FX_POST_TYPES };
export type { LyricFXPostType };

/**
 * Shared prelude for post passes. Binds the source lyric raster + a feedback
 * texture (for motion trails) + the same LU uniform layout as surface/vertex.
 *
 *   @binding(0) src         — current lyric raster
 *   @binding(1) srcSampler
 *   @binding(2) u           — LU uniform (time/audio/slots + p0..p3)
 *   @binding(3) feedback    — previous frame's post output (motion trails)
 */
export const LYRIC_FX_POST_PRELUDE = /* wgsl */ `
struct LU {
  a: vec4f, b: vec4f, e: vec4f, f: vec4f,
  p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> u: LU;
@group(0) @binding(3) var feedbackTex: texture_2d<f32>;

fn u_energy() -> f32 { return u.b.w; }
fn u_res() -> vec2f  { return u.a.zw; }

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = uv[vi];
  return o;
}
`;

export const LYRIC_FX_POST_BODIES: Record<LyricFXPostType, string> = {
  // Text-only bloom — bright-pass + separable-ish blur of the lyric raster,
  // added back over the original. p0.x = threshold, p0.y = intensity.
  textBloom: /* wgsl */ `
fn post_effect(uv: vec2f) -> vec4f {
  let base = textureSample(src, srcSampler, uv);
  // Resolution-INDEPENDENT spread: step in a fraction of the screen, not raw
  // texels, so the glow is a real, visible halo at any resolution (the old
  // texel*1.5 kernel was a sub-pixel ring, invisible at high res). Strength
  // (p0.y) widens the reach as well as brightening, so the slider reads.
  let spread = 0.006 * (0.5 + u.p0.y);
  let aspect = u_res().x / max(u_res().y, 1.0);
  var bloom = vec3f(0.0);
  var wsum = 0.0;
  for (var i = -4; i <= 4; i = i + 1) {
    for (var j = -4; j <= 4; j = j + 1) {
      let o = vec2f(f32(i) / aspect, f32(j)) * spread;
      let s = textureSample(src, srcSampler, uv + o);
      let bright = max(0.0, max(s.r, max(s.g, s.b)) - u.p0.x) * s.a;
      let w = exp(-f32(i * i + j * j) * 0.18);
      bloom += s.rgb * bright * w;
      wsum += w;
    }
  }
  if (wsum > 0.0) { bloom /= wsum; }
  // Add the coloured halo on top of the crisp base. Strength drives overall gain.
  return vec4f(base.rgb + bloom * (1.5 * u.p0.y), max(base.a, length(bloom) * 0.5));
}`,

  // Motion trails — decayed after-image of the lyric. The feedback holds the
  // previous frame's OUTPUT; blend the current raster over a decayed copy so a
  // pixel the lyric has left fades by `decay` each frame (a soft tail) instead
  // of latching bright forever. Alpha is bounded to the current+trail coverage
  // so the buffer cannot accumulate into an ever-growing solid.
  // p0.x = decay (0..0.95, higher = longer trails).
  motionTrails: /* wgsl */ `
fn post_effect(uv: vec2f) -> vec4f {
  let cur = textureSample(src, srcSampler, uv);
  let prev = textureSample(feedbackTex, srcSampler, uv);
  let decay = clamp(u.p0.x, 0.0, 0.95);
  // Decayed trail from the previous OUTPUT, then the fresh lyric composited on
  // top. Using the current alpha to lead keeps the live glyph crisp while the
  // faded tail sits behind it.
  let trail = prev * decay;
  let a = max(cur.a, trail.a);
  let rgb = cur.rgb * cur.a + trail.rgb * (1.0 - cur.a);
  return vec4f(rgb, a);
}`,

  // Displacement — warp the lyric raster by a flowing noise field.
  // p0.x = amount, p0.y = scale.
  displace: /* wgsl */ `
fn post_effect(uv: vec2f) -> vec4f {
  let t = u.a.x;
  let n = vec2f(
    sin(uv.y * u.p0.y + t) * cos(uv.x * u.p0.y * 0.7 - t),
    cos(uv.x * u.p0.y - t) * sin(uv.y * u.p0.y * 1.3 + t),
  );
  return textureSample(src, srcSampler, uv + n * u.p0.x);
}`,

  // Light rays — radial blur from a source point, masked by text coverage.
  // p0.x = intensity, p0.y = decay.
  lightRays: /* wgsl */ `
fn post_effect(uv: vec2f) -> vec4f {
  let base = textureSample(src, srcSampler, uv);
  let center = vec2f(0.5, 0.5);
  var dir = (uv - center);
  var col = vec4f(0.0);
  var illum = 1.0;
  var coord = uv;
  let steps = 24;
  for (var i = 0; i < steps; i = i + 1) {
    coord -= dir * (1.0 / f32(steps)) * 0.5;
    let s = textureSample(src, srcSampler, coord);
    col += s * illum;
    illum *= clamp(u.p0.y, 0.8, 0.999);
  }
  col /= f32(steps);
  return base + col * u.p0.x;
}`,
};

const LYRIC_FX_POST_EPILOGUE = /* wgsl */ `
@fragment
fn fs_main(in: VOut) -> @location(0) vec4f {
  return post_effect(in.uv);
}
`;

/** Assemble the full WGSL for one post effect: prelude + body + epilogue. */
export function assemblePostShader(type: LyricFXPostType): string {
  return LYRIC_FX_POST_PRELUDE + '\n' + LYRIC_FX_POST_BODIES[type] + '\n' + LYRIC_FX_POST_EPILOGUE;
}

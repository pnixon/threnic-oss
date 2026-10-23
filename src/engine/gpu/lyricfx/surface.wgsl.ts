/**
 * Lyric FX — Stage B surface effect WGSL (see `docs/lyric-fx-engine-lld.md` §4).
 *
 * Stage B effects are per-pixel reads of the MSDF distance field. They share a
 * prelude that recovers the signed distance via `median(r,g,b)` — the same
 * convention as `text_sdf.wgsl` — and turns it into an alpha with `swellMask`.
 * Each effect body is a WGSL function with a fixed signature so the LyricFXGraph
 * can assemble one shader per effect instance, exactly as `shaderPresets`
 * assembles prelude + body + epilogue.
 *
 * The prelude reuses the Stage-1 audio-router slot convention (`u_value1..8`),
 * so an effect drives its signature parameter from a routed band, e.g. swell's
 * `t = -k * u_value1()` thickens letters on the kick.
 *
 * These are strings only — no GPU calls — so the assembly is unit-testable
 * without a device.
 */

import type { LyricFXSurfaceType } from '@/types/effects/lyric-fx';

/**
 * Shared uniform + helpers for every surface pass.
 *
 * Uniform layout (std140, 8 × vec4f = 128 bytes):
 *   a: (time, dt, resX, resY)
 *   b: (bass, mid, high, energy)
 *   e: (value1, value2, value3, value4)   — routed slots
 *   f: (value5, value6, value7, value8)   — routed slots
 *   p0,p1,p2,p3: per-effect params (meaning defined by each body)
 *
 * Bindings:
 *   @binding(0) msdfAtlas  — the glyph MSDF (rgba8unorm, median-of-RGB)
 *   @binding(1) atlasSampler
 *   @binding(2) u           — the uniform above
 *   @binding(3) layerBelow  — background/prior-pass texture (refraction only)
 *   @binding(4) linearSampler
 */
/**
 * The shared LU uniform struct + time/audio/router-slot accessors, WITHOUT any
 * `@group/@binding` declaration. Both the surface fragment prelude and the
 * vertex (transform) stage embed this and add their own binding, so a single
 * uniform buffer feeds both stages.
 */
export const LYRIC_FX_UNIFORM_STRUCT = /* wgsl */ `
struct LU {
  a: vec4f,   // time, dt, resX, resY
  b: vec4f,   // bass, mid, high, energy
  e: vec4f,   // value1..4 (routed slots)
  f: vec4f,   // value5..8 (routed slots)
  p0: vec4f,  // per-effect params
  p1: vec4f,
  p2: vec4f,
  p3: vec4f,
  g: vec4f,   // phaseCode, granularityCode, fadeIn, fadeOut
  cPre: vec4f,    // pre (upcoming) word colour rgba
  cActive: vec4f, // active word colour rgba
  cPost: vec4f,   // post (sung) word colour rgba
  h: vec4f,   // outline r,g,b, outlineWidth (field units; 0 = no outline)
  k: vec4f,   // highlightFadeIn, highlightFadeOut, entryPop (1=scale entry), reverseOnFadeOut (1=reverse entry motion on fade-out)
};

fn u_time() -> f32   { return u.a.x; }
fn u_bass() -> f32   { return u.b.x; }
fn u_mid() -> f32    { return u.b.y; }
fn u_high() -> f32   { return u.b.z; }
fn u_energy() -> f32 { return u.b.w; }
fn u_value1() -> f32 { return u.e.x; }
fn u_value2() -> f32 { return u.e.y; }
fn u_value3() -> f32 { return u.e.z; }
fn u_value4() -> f32 { return u.e.w; }
fn u_value5() -> f32 { return u.f.x; }
fn u_value6() -> f32 { return u.f.y; }
fn u_value7() -> f32 { return u.f.z; }
fn u_value8() -> f32 { return u.f.w; }
fn u_phaseCode() -> f32 { return u.g.x; }
fn u_granularityCode() -> f32 { return u.g.y; }
fn u_fadeIn() -> f32 { return u.g.z; }
fn u_fadeOut() -> f32 { return u.g.w; }
fn u_outlineColor() -> vec3f { return u.h.rgb; }
fn u_outlineWidth() -> f32 { return u.h.w; }
fn u_highlightFadeIn() -> f32 { return u.k.x; }
fn u_highlightFadeOut() -> f32 { return u.k.y; }
fn u_entryPop() -> f32 { return u.k.z; }
fn u_reverse() -> f32 { return u.k.w; }
`;

export const LYRIC_FX_SURFACE_PRELUDE = /* wgsl */ `
struct LU {
  a: vec4f,   // time, dt, resX, resY
  b: vec4f,   // bass, mid, high, energy
  e: vec4f,   // value1..4 (routed slots)
  f: vec4f,   // value5..8 (routed slots)
  p0: vec4f,  // per-effect params
  p1: vec4f,
  p2: vec4f,
  p3: vec4f,
  g: vec4f,   // phaseCode, granularityCode, fadeIn, fadeOut
  cPre: vec4f,    // pre (upcoming) word colour rgba
  cActive: vec4f, // active word colour rgba
  cPost: vec4f,   // post (sung) word colour rgba
  h: vec4f,   // outline r,g,b, outlineWidth (field units; 0 = no outline)
  k: vec4f,   // highlightFadeIn, highlightFadeOut, entryPop (1=scale entry), pad
};

@group(0) @binding(0) var msdfAtlas: texture_2d<f32>;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var<uniform> u: LU;
@group(0) @binding(3) var layerBelow: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;

fn u_time() -> f32   { return u.a.x; }
fn u_bass() -> f32   { return u.b.x; }
fn u_mid() -> f32    { return u.b.y; }
fn u_high() -> f32   { return u.b.z; }
fn u_energy() -> f32 { return u.b.w; }
fn u_value1() -> f32 { return u.e.x; }
fn u_value2() -> f32 { return u.e.y; }
fn u_value3() -> f32 { return u.e.z; }
fn u_value4() -> f32 { return u.e.w; }
fn u_value5() -> f32 { return u.f.x; }
fn u_value6() -> f32 { return u.f.y; }
fn u_value7() -> f32 { return u.f.z; }
fn u_value8() -> f32 { return u.f.w; }
fn u_phaseCode() -> f32 { return u.g.x; }
fn u_granularityCode() -> f32 { return u.g.y; }
fn u_fadeIn() -> f32 { return u.g.z; }
fn u_fadeOut() -> f32 { return u.g.w; }
fn u_outlineColor() -> vec3f { return u.h.rgb; }
fn u_outlineWidth() -> f32 { return u.h.w; }
fn u_highlightFadeIn() -> f32 { return u.k.x; }
fn u_highlightFadeOut() -> f32 { return u.k.y; }
fn u_entryPop() -> f32 { return u.k.z; }

// Phase codes (must match LYRIC_FX_PHASE_CODE in lyric-fx.ts):
//   0 upcoming, 1 fadeIn, 2 active, 3 fadeOut, 4 past
// Given a glyph's active window [cs,ce] and the frame fade windows, return the
// live phase gate in [0,1] for the effect's bound phase: 1 = fully in-phase,
// ramping across the fade windows so an effect eases in/out at its boundaries.
fn phase_gate(cs: f32, ce: f32) -> f32 {
  let t = u_time();
  let fin = max(u_fadeIn(), 1e-4);
  let fout = max(u_fadeOut(), 1e-4);
  let ph = u_phaseCode();
  // upcoming
  if (ph < 0.5) { return select(0.0, 1.0, t < cs - fin); }
  // fadeIn: [cs-fin, cs)
  if (ph < 1.5) { return clamp((t - (cs - fin)) / fin, 0.0, 1.0) * select(0.0, 1.0, t < cs); }
  // active: [cs, ce]
  if (ph < 2.5) { return select(0.0, 1.0, t >= cs && t <= ce); }
  // fadeOut: (ce, ce+fout]
  if (ph < 3.5) { return clamp(1.0 - (t - ce) / fout, 0.0, 1.0) * select(0.0, 1.0, t > ce); }
  // past
  return select(0.0, 1.0, t > ce + fout);
}

// Which lifecycle phase code (0 upcoming .. 4 past) a glyph is in RIGHT NOW,
// from its active window [cs,ce] and the frame fade windows. This is a HARD
// boundary (no ramp) — the base pass and each transform pass share it so the
// hand-off at a phase edge is seamless (one draws exactly where the other stops).
fn current_phase(cs: f32, ce: f32) -> i32 {
  let t = u_time();
  let fin = max(u_fadeIn(), 1e-4);
  let fout = max(u_fadeOut(), 1e-4);
  if (t < cs - fin) { return 0; }        // upcoming
  if (t < cs)       { return 1; }        // fadeIn
  if (t <= ce)      { return 2; }        // active
  if (t <= ce + fout) { return 3; }      // fadeOut
  return 4;                              // past
}

// True when the glyph's CURRENT phase equals the pass's bound phase (u.g.x as a
// phase code). Used by a transform pass to draw ONLY in its own phase, with a
// boundary identical to the base pass's covered-phase discard.
fn in_bound_phase(cs: f32, ce: f32) -> bool {
  return current_phase(cs, ce) == i32(u_phaseCode() + 0.5);
}

// Select the classification window for a lifecycle phase code.
//   fadeIn(1) / fadeOut(3) → the GRANULARITY window (charTiming): at line
//                            granularity the whole line fades in/out as a unit.
//   upcoming(0)/active(2)/past(4) → the per-WORD window (wordTiming): the
//                            karaoke playhead is inherently per word, so an
//                            active-phase effect tracks the SUNG word even when
//                            the fade is per line — it must not treat every
//                            glyph on the line as active and spill onto the
//                            upcoming / past words.
fn phase_window(phaseCode: i32, charTiming: vec2f, wordTiming: vec2f) -> vec2f {
  if (phaseCode == 1 || phaseCode == 3) { return charTiming; }
  return wordTiming;
}

// Transform-pass gate that respects the per-phase window split above: a fade
// transform gates on the granularity window, an active/upcoming/past transform
// on the word window.
fn in_bound_phase_win(charTiming: vec2f, wordTiming: vec2f) -> bool {
  let pc = i32(u_phaseCode() + 0.5);
  let w = phase_window(pc, charTiming, wordTiming);
  return current_phase(w.x, w.y) == pc;
}

// Is the glyph inside a phase OWNED by a transform (base cover-mask discard)?
// Each covered bit is tested against the window that phase classifies on, so a
// fade cover uses the granularity window and an active cover uses the word
// window — mirroring in_bound_phase_win exactly, so base + transform never
// disagree about which glyph a transform owns.
fn covered_by_transform(mask: i32, charTiming: vec2f, wordTiming: vec2f) -> bool {
  let phC = current_phase(charTiming.x, charTiming.y); // fade phases (1,3)
  let phW = current_phase(wordTiming.x, wordTiming.y); // non-fade phases (0,2,4)
  // fadeIn(1) / fadeOut(3) classified on the granularity window.
  if (phC == 1 && (mask & (1 << u32(1))) != 0) { return true; }
  if (phC == 3 && (mask & (1 << u32(3))) != 0) { return true; }
  // upcoming(0) / active(2) / past(4) classified on the word window.
  if (phW == 0 && (mask & (1 << u32(0))) != 0) { return true; }
  if (phW == 2 && (mask & (1 << u32(2))) != 0) { return true; }
  if (phW == 4 && (mask & (1 << u32(4))) != 0) { return true; }
  return false;
}

// Overall lyric visibility envelope for a glyph, INDEPENDENT of any effect
// phase: 0 before fade-in, eases 0..1 across [cs-fadeIn, cs], holds 1 while
// active, eases 1..0 across (ce, ce+fadeOut], 0 after. Smoothstep-eased to
// match the Canvas2D 'fade' animation (which uses smoothstep, not a linear ramp).
fn lyric_envelope(cs: f32, ce: f32) -> f32 {
  let t = u_time();
  let fin = max(u_fadeIn(), 1e-4);
  let fout = max(u_fadeOut(), 1e-4);
  let inA = smoothstep(0.0, 1.0, clamp((t - (cs - fin)) / fin, 0.0, 1.0));
  let outA = 1.0 - smoothstep(0.0, 1.0, clamp((t - ce) / fout, 0.0, 1.0));
  return min(inA, outA);
}

// Per-word colour by karaoke state, matching Canvas2D's eased highlight blend
// (lerpColor(pre|post, active, highlightAlpha)) rather than a hard 3-way step.
// highlightFadeIn/Out (seconds) ease the blend into/out of the active colour;
// 0 fade reproduces the old instant switch. cs/ce are the TRUE word window.
// Per-word colour by karaoke state. The highlight timing is PROPORTIONAL to the
// word's own active duration (not a fixed number of seconds): the word ramps
// pre -> active over the FIRST 20% of its active window and is fully in the
// Active colour for the middle 60%, then ramps active -> post over the LAST 20%,
// reaching the Played colour exactly at the word's end. This keeps a short word
// and a long word looking the same relative to their own length, and fixes the
// old bug where the active colour only completed after the word was already
// over (fade-out keyed off ce, the end, instead of the last 20%). cs/ce are the
// TRUE word window.
fn lyric_color(cs: f32, ce: f32) -> vec4f {
  let t = u_time();
  let dur = max(ce - cs, 1e-4);
  let ramp = 0.2 * dur;                 // 20% of the word's active life
  // Rising edge: pre -> active across [cs, cs + 20%].
  let up = smoothstep(0.0, 1.0, clamp((t - cs) / ramp, 0.0, 1.0));
  // Falling edge: active -> post across [ce - 20%, ce] (fully post AT ce).
  let down = smoothstep(0.0, 1.0, clamp((t - (ce - ramp)) / ramp, 0.0, 1.0));
  let fromPre = mix(u.cPre, u.cActive, up);
  return mix(fromPre, u.cPost, down);
}

// Median of three — recovers the true edge from an MSDF sample.
fn median3(a: f32, b: f32, c: f32) -> f32 {
  return max(min(a, b), min(max(a, b), c));
}

// Signed distance at a UV: >0.5 inside, <0.5 outside (matches text_sdf.wgsl).
fn field_at(uv: vec2f) -> f32 {
  let s = textureSample(msdfAtlas, atlasSampler, uv);
  return median3(s.r, s.g, s.b);
}

// Alpha for a cutoff threshold t with smoothing w.
fn swellMask(d: f32, t: f32, w: f32) -> f32 {
  return smoothstep(t - w, t + w, d);
}

// Analytic screen-space smoothing width from the field's gradient. This runs
// identically in every pass and every phase — the glyph edge is antialiased the
// same way for all glyphs regardless of Lyric FX phase/granularity. Whether
// edges read crisp or smooth is decided UPSTREAM by the atlas field resolution
// (see LyricFXDriver.ensureGraph: 128px field = smooth, 64px = crisp), NOT by a
// per-pass flag — so the AA look is a uniform property of the text, not gated by
// fade timing.
fn edgeSmooth(uv: vec2f) -> f32 {
  let d = field_at(uv);
  let g = max(length(vec2f(dpdx(d), dpdy(d))), 1e-5);
  return g;
}

fn rot2(a: f32) -> mat2x2f {
  let s = sin(a); let c = cos(a);
  return mat2x2f(c, -s, s, c);
}

// The fragment context every surface body receives.
struct FragCtx {
  uv: vec2f,        // atlas UV for this glyph fragment
  localUv: vec2f,   // 0..1 within the glyph quad
  screenUv: vec2f,  // 0..1 across the lyric target (for layerBelow)
  glyphColor: vec4f,
};
`;

/**
 * One surface effect body. Each defines `fn surface_effect(ctx: FragCtx) ->
 * vec4f` returning the composited RGBA for the fragment. The graph picks the
 * body by effect type and appends it to the prelude.
 */
export const LYRIC_FX_SURFACE_BODIES: Record<LyricFXSurfaceType, string> = {
  // Swell / erode — shift the alpha cutoff along the distance ramp.
  swell: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let d = field_at(ctx.uv);
  let w = edgeSmooth(ctx.uv) + u.p0.y;
  // t < 0.5 swells (letters gain weight); driven by a routed slot on p0.x.
  let t = 0.5 - u.p0.x * u_value1();
  let a = swellMask(d, t, w);
  return vec4f(ctx.glyphColor.rgb, ctx.glyphColor.a * a);
}`,

  // Melt — add a downward-biased noise ramp so the field sags below baseline.
  melt: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let sag = u.p0.x * (0.5 + 0.5 * sin(ctx.localUv.x * u.p0.y + u_time()));
  let d = field_at(ctx.uv) - sag * ctx.localUv.y;
  let w = edgeSmooth(ctx.uv);
  let a = swellMask(d, 0.5, w);
  return vec4f(ctx.glyphColor.rgb, ctx.glyphColor.a * a);
}`,

  // Dissolve / burn — threshold d against a noise field; hot edge at the cross.
  dissolve: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let d = field_at(ctx.uv);
  let progress = u.p0.x;              // 0..1 exit progress
  let edge = u.p0.y;                  // hot band width
  let cutoff = mix(0.9, 0.1, progress);
  let a = swellMask(d, cutoff, edgeSmooth(ctx.uv));
  let band = 1.0 - smoothstep(0.0, edge, abs(d - cutoff));
  let burn = u.p1.rgb * band;
  return vec4f(ctx.glyphColor.rgb + burn, ctx.glyphColor.a * a);
}`,

  // Gradient fill — map colour along a glyph- or line-local axis.
  gradientFill: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let d = field_at(ctx.uv);
  let a = swellMask(d, 0.5, edgeSmooth(ctx.uv));
  let dir = normalize(vec2f(cos(u.p0.z), sin(u.p0.z)));
  let axis = ctx.localUv;            // glyph-local; line-local handled by graph
  let t = clamp(dot(axis - 0.5, dir) + 0.5 + u.p0.x, 0.0, 1.0);
  let col = mix(u.p1, u.p2, t);
  return vec4f(col.rgb, col.a * ctx.glyphColor.a * a);
}`,

  // Chromatic split — sample the field three times at RGB-offset coords.
  chromaticSplit: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let off = (u.p0.x * u_value1()) * vec2f(cos(u.p0.y), sin(u.p0.y));
  let w = edgeSmooth(ctx.uv);
  let ar = swellMask(field_at(ctx.uv + off), 0.5, w);
  let ag = swellMask(field_at(ctx.uv),       0.5, w);
  let ab = swellMask(field_at(ctx.uv - off), 0.5, w);
  let a = max(ar, max(ag, ab));
  return vec4f(ctx.glyphColor.r * ar, ctx.glyphColor.g * ag, ctx.glyphColor.b * ab, ctx.glyphColor.a * a);
}`,

  // Marching outline — animated dashed band around d = 0.5.
  marchingOutline: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let d = field_at(ctx.uv);
  let w = edgeSmooth(ctx.uv);
  let band = 1.0 - smoothstep(0.0, u.p0.x, abs(d - 0.5));
  var dash = 1.0;
  if (u.p0.y > 0.0) {
    let phase = ctx.localUv.x * 40.0 + u.p0.z;
    dash = step(0.5, fract(phase / max(u.p0.y, 0.001)));
  }
  let fill = swellMask(d, 0.5, w);
  let outline = band * dash;
  let col = mix(ctx.glyphColor, u.p1, outline * (1.0 - fill));
  return vec4f(col.rgb, max(fill, outline) * ctx.glyphColor.a);
}`,

  // Bevel / emboss — light the field's gradient as a surface normal.
  bevel: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let d = field_at(ctx.uv);
  let n = normalize(vec3f(dpdx(d), dpdy(d), 0.02));
  let lightDir = normalize(vec3f(cos(u.p0.x), sin(u.p0.x), 0.6));
  let lit = clamp(dot(n, lightDir), -1.0, 1.0) * u.p0.y;
  let a = swellMask(d, 0.5, edgeSmooth(ctx.uv));
  let rgb = clamp(ctx.glyphColor.rgb + lit, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, ctx.glyphColor.a * a);
}`,

  // Neon core — a solid bright core (the letter body) PLUS a soft halo that
  // bleeds OUTWARD past the glyph edge, so the word actually glows into the
  // frame around it. The MSDF field is >0.5 inside the glyph and falls below
  // 0.5 outside; the old body only lit d>0.5 (the interior), so no halo was
  // ever visible. Here the halo is driven by how far OUTSIDE the edge the
  // fragment is: distance from the edge = (0.5 - d), positive outside. p0.x =
  // core width, p0.y = halo reach (field units). p1 = core colour, p2 = halo.
  neonCore: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let d = field_at(ctx.uv);
  let w = edgeSmooth(ctx.uv);
  // Core: the crisp letter body (inside the edge), slightly inset by coreWidth.
  let core = swellMask(d, 0.5 + u.p0.x, w);
  // Halo: a smooth glow reaching OUTWARD from the edge. outside = (0.5 - d) > 0
  // just past the edge; falls off across the halo reach p0.y. Also lit inside
  // so the whole letter carries the glow colour, brightest at the rim.
  let reach = max(u.p0.y, 1e-3);
  let outside = 0.5 - d;                 // >0 outside the glyph, <0 inside
  let halo = 1.0 - smoothstep(0.0, reach, max(outside, 0.0));
  let rgb = u.p1.rgb * core + u.p2.rgb * halo * (1.0 - core);
  // Alpha: full where the letter is, plus a soft outward halo alpha so the
  // glow paints the transparent margin around the glyph. Additive-ish blend.
  let a = max(core, halo * 0.7) * ctx.glyphColor.a;
  return vec4f(rgb, a);
}`,

  // Refraction — bend the background sample along the field's gradient.
  refraction: /* wgsl */ `
fn surface_effect(ctx: FragCtx) -> vec4f {
  let d = field_at(ctx.uv);
  let n = normalize(vec2f(dpdx(d), dpdy(d)) + vec2f(1e-6, 0.0));
  let strength = u.p0.x * u_value2();
  let falloff = pow(clamp(1.0 - abs(d - 0.5) * 2.0, 0.0, 1.0), max(u.p0.y, 0.001));
  let bent = ctx.screenUv + n * strength * falloff;
  let behind = textureSample(layerBelow, linearSampler, bent);
  let a = swellMask(d, 0.5, edgeSmooth(ctx.uv));
  return mix(behind, ctx.glyphColor, a);
}`,
};

/** The fixed fragment entry that calls the selected body. Appended last. */
const LYRIC_FX_SURFACE_EPILOGUE = /* wgsl */ `
@fragment
fn fs_main(
  @location(0) uv: vec2f,
  @location(1) localUv: vec2f,
  @location(2) screenUv: vec2f,
  @location(3) glyphColor: vec4f,
  @location(4) charTiming: vec2f,   // (charStart, charEnd) for this glyph
  @location(5) wordTiming: vec2f,   // true (unshifted) word window
) -> @location(0) vec4f {
  var ctx: FragCtx;
  ctx.uv = uv;
  ctx.localUv = localUv;
  ctx.screenUv = screenUv;
  ctx.glyphColor = glyphColor;
  let outc = surface_effect(ctx);
  // Lifecycle-phase gate: the effect contributes only while this glyph is in
  // the effect's bound phase (with fade-in/out ramps). Modulates alpha so the
  // glyph falls back to its plain fill outside the phase.
  let gate = phase_gate(charTiming.x, charTiming.y);
  let a = outc.a * gate;
  if (a < 0.004) { discard; }
  return vec4f(outc.rgb, a);
}
`;

/**
 * Assemble the complete fragment WGSL for one surface effect: prelude + the
 * effect body + epilogue. Mirrors `assembleShaderSource` in shaderPresets.
 */
export function assembleSurfaceShader(type: LyricFXSurfaceType): string {
  return (
    LYRIC_FX_SURFACE_PRELUDE +
    '\n' +
    LYRIC_FX_SURFACE_BODIES[type] +
    '\n' +
    LYRIC_FX_SURFACE_EPILOGUE
  );
}

/**
 * The base "plain" glyph pass — draws each glyph at its fill colour with NO
 * lifecycle-phase gate. It underlies the phase-gated effect passes so a glyph
 * outside every effect's phase still shows its plain fill (rather than vanishing
 * because all its effects gated to zero alpha).
 */
export const LYRIC_FX_PLAIN_SHADER = /* wgsl */ `
${LYRIC_FX_SURFACE_PRELUDE}

@fragment
fn fs_main(
  @location(0) uv: vec2f,
  @location(1) localUv: vec2f,
  @location(2) screenUv: vec2f,
  @location(3) glyphColor: vec4f,
  @location(4) charTiming: vec2f,
  @location(5) wordTiming: vec2f,
) -> @location(0) vec4f {
  // Transform-covered-phase mask (u.g.x, a bitmask 0..31): a bit set for phase P
  // means a transform pass OWNS drawing the glyph in phase P, so the base pass
  // must NOT draw a resting glyph there (it would ghost behind the moved copy).
  // Phases with no transform are drawn here as usual, keeping the plain fade.
  var mask = i32(u_phaseCode() + 0.5);
  // If a transform owns FADE-OUT (bit 3), it also owns PAST (bit 4): an exit
  // transform flings the glyph away and it must NOT reappear once fade-out ends.
  if ((mask & (1 << u32(3))) != 0) { mask = mask | (1 << u32(4)); }
  // Per-bit covered check: fade bits (1,3) classify on the granularity window
  // (charTiming) so a line fade covers the whole line; active/upcoming/past bits
  // (0,2,4) classify on the per-WORD window (wordTiming) so an active transform
  // only owns the SUNG word and does NOT spill onto the upcoming / past words of
  // the same line. Mirrors in_bound_phase_win, so base + transform agree exactly.
  if (covered_by_transform(mask, charTiming, wordTiming)) { discard; }

  let d = field_at(uv);
  // The base pass IS the lyric: apply its own fade-in/out envelope (staggered
  // by granularity via charTiming) and the pre/active/post karaoke colour keyed
  // on the TRUE word window (wordTiming) so exactly one word reads as active.
  let env = lyric_envelope(charTiming.x, charTiming.y);
  let col = lyric_color(wordTiming.x, wordTiming.y);
  let w = edgeSmooth(uv);
  let fillA = swellMask(d, 0.5, w) * col.a;
  // Outline (#10): a stroke that extends OUTSIDE the fill edge, matching
  // Canvas2D's strokeText. outlineWidth (field units) shifts the cutoff below
  // 0.5 so the mask reaches past the glyph edge; the fill sits on top.
  let ow = u_outlineWidth();
  let outlineMask = select(0.0, swellMask(d, 0.5 - ow, w), ow > 0.0);
  // Composite fill over outline: where fill covers, use fill colour; the ring
  // outside the fill shows the outline colour.
  let coverage = max(fillA, outlineMask) * env;
  let rgb = mix(u_outlineColor(), col.rgb, select(0.0, fillA / max(coverage, 1e-4), coverage > 0.0));
  if (coverage < 0.004) { discard; }
  return vec4f(rgb, coverage);
}
`;

/**
 * Phase-GATED plain glyph fill — used for a TRANSFORM effect's pass. The
 * transform (a vertex-stage displacement) needs a fragment to draw; this draws
 * the glyph fill modulated by the lifecycle-phase gate, so a transform bound to
 * fade-in contributes only during fade-in (and the ungated base pass still
 * shows the resting glyph underneath).
 */
export const LYRIC_FX_GATED_PLAIN_SHADER = /* wgsl */ `
${LYRIC_FX_SURFACE_PRELUDE}
@fragment
fn fs_main(
  @location(0) uv: vec2f,
  @location(1) localUv: vec2f,
  @location(2) screenUv: vec2f,
  @location(3) glyphColor: vec4f,
  @location(4) charTiming: vec2f,
  @location(5) wordTiming: vec2f,
) -> @location(0) vec4f {
  // Draw the moved glyph ONLY while it is in this transform's bound phase, with
  // a HARD boundary identical to the base pass's covered check. The window is
  // chosen by phase: a fade-in/out transform gates on the GRANULARITY window
  // (charTiming) — so at line granularity the line moves as one unit — while an
  // active/upcoming/past transform gates on the per-WORD window (wordTiming), so
  // an active effect tracks the SUNG word and never spills onto the upcoming /
  // past words of the same line. The lyric fade envelope is applied so the
  // moving glyph fades in/out just like the resting one.
  if (!in_bound_phase_win(charTiming, wordTiming)) { discard; }
  let d = field_at(uv);
  let env = lyric_envelope(charTiming.x, charTiming.y);
  let col = lyric_color(wordTiming.x, wordTiming.y);
  let a = swellMask(d, 0.5, edgeSmooth(uv)) * col.a * env;
  if (a < 0.004) { discard; }
  return vec4f(col.rgb, a);
}
`;

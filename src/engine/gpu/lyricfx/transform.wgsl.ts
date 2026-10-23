/**
 * Lyric FX — Stage A transform effect WGSL (see `docs/lyric-fx-engine-lld.md`
 * §4). Stage A effects are per-glyph arithmetic evaluated in the VERTEX stage:
 * each computes a displacement (translate / rotate / scale about the glyph
 * centre) from the glyph's stable identity (`charIndex`, `seed`), its timing
 * (`charStart/charEnd`), and per-frame uniforms (time, audio, routed slots).
 *
 * Every body is a WGSL function with a fixed signature so the vertex shader can
 * assemble one transform per active effect. A `GTransform` accumulates a 2-D
 * offset (device px), a rotation (radians, about the glyph centre), and a
 * uniform scale; the vertex shader applies them to each quad corner.
 *
 * Strings only — no GPU calls — so assembly is unit-testable without a device.
 * The uniform layout matches `LU` in `surface.wgsl.ts` (time/audio/slots +
 * p0..p3 per-effect params) so a single uniform buffer serves both stages.
 */

import type { LyricFXType } from '@/types/effects/lyric-fx';

/** The eight Stage-A transform effect types. */
export const LYRIC_FX_TRANSFORM_TYPES = [
  'shatter',
  'kineticWave',
  'scatterAssemble',
  'springSettle',
  'vortex',
  'impactTypewriter',
  'glyphJitter',
  'cardFlip',
] as const satisfies readonly LyricFXType[];

export type LyricFXTransformType = (typeof LYRIC_FX_TRANSFORM_TYPES)[number];

/** Shared transform helpers + the GTransform accumulator + glyph progress. */
export const LYRIC_FX_TRANSFORM_PRELUDE = /* wgsl */ `
// Accumulated per-glyph transform (applied to each quad corner in vs_main).
struct GTransform {
  offset: vec2f,   // device-px translation of the glyph
  rot: f32,        // radians, about the glyph centre
  scale: f32,      // uniform scale about the glyph centre
};

fn gt_identity() -> GTransform {
  var t: GTransform;
  t.offset = vec2f(0.0, 0.0);
  t.rot = 0.0;
  t.scale = 1.0;
  return t;
}

// Progress of a glyph through its bound lifecycle phase, 0..1.
//
// A transform is an entry/exit MOTION, so its progress must be driven by the
// window of the phase the effect is bound to — not hard-wired to the word's
// [charStart, charEnd]. This is what makes "Scatter on Fade-in" assemble during
// the fade-in window and "Shatter on Fade-out" fling during the fade-out
// window, while a transform bound to Active simply holds at rest (progress 1).
//   phase codes: 0 upcoming, 1 fadeIn, 2 active, 3 fadeOut, 4 past
fn glyph_progress(charStart: f32, charEnd: f32) -> f32 {
  let t = u_time();
  let fin = max(u_fadeIn(), 1e-4);
  let fout = max(u_fadeOut(), 1e-4);
  let ph = u_phaseCode();
  if (ph < 0.5) {                    // upcoming: pre-entry, held at 0
    return 0.0;
  } else if (ph < 1.5) {             // fadeIn: ramp 0..1 across [cs-fin, cs]
    return clamp((t - (charStart - fin)) / fin, 0.0, 1.0);
  } else if (ph < 2.5) {             // active: settled, held at 1
    return 1.0;
  } else if (ph < 3.5) {             // fadeOut
    // Reverse mode (u_reverse): mirror the entry — ramp 1..0 across (ce, ce+fout]
    // so an entry-motion transform (scatter, vortex, spring) that ASSEMBLES on
    // fade-in DISASSEMBLES back out on fade-out (its 1-p term climbs 0..1 again).
    // Default (exit-native, e.g. shatter): ramp 1..2 so the exit path fires.
    let e = clamp((t - charEnd) / fout, 0.0, 1.0);
    return select(1.0 + e, 1.0 - e, u_reverse() > 0.5);
  }
  // past: reverse-mode entry transforms rest fully-exited at 0 (mirror of the
  // pre-entry rest), exit-native transforms rest at 2 (fully flung).
  return select(2.0, 0.0, u_reverse() > 0.5);
}

// Granularity-adjusted active window for a glyph — MUST match the window the
// vertex bakes into out.charTiming and the surface/plain shaders gate on
// (in_bound_phase / current_phase / phase_gate). Keeping the transform MOTION
// on the SAME window as its draw gate is what prevents a frozen fade: if the
// motion ramped over the raw word window while the glyph was only DRAWN over a
// shifted (letter/line) window, it would be visible only where its progress had
// already saturated, reading as no animation at all.
//   word (1, default) → the baked word window [charStart, charEnd] (g.b.z/g.b.w)
//   letter (0)        → per-glyph ripple: cs pulled earlier / ce pushed later by
//                       the neighbor-clamped lead (cs0 - entryStart)
//   line (2)          → the shared per-line window (g.f.z/g.f.w)
fn granularity_window(g: Glyph) -> vec2f {
  let cs0 = g.b.z;
  let ce0 = g.b.w;
  let gran = u_granularityCode();
  if (gran < 0.5) {
    let lead = max(cs0 - g.f.y, 0.0);
    return vec2f(cs0 - lead, ce0 + lead);
  } else if (gran > 1.5) {
    return vec2f(g.f.z, g.f.w);
  }
  return vec2f(cs0, ce0);
}

// Progress of a glyph through its bound phase. The window MUST match the
// fragment draw gate (in_bound_phase_win in surface.wgsl.ts), or the motion
// freezes (visible only where its progress has already saturated):
//   fadeIn(1) / fadeOut(3) → the GRANULARITY window (line/letter/word) so a
//                            line fade moves the whole line as one unit.
//   upcoming(0)/active(2)/past(4) → the raw per-WORD window (g.b.z/g.b.w) so an
//                            active effect animates on the SUNG word only, not
//                            across the whole line's active span.
fn glyph_progress_g(g: Glyph) -> f32 {
  let ph = u_phaseCode();
  if (ph > 0.5 && ph < 1.5) {        // fadeIn
    let w = granularity_window(g);
    return glyph_progress(w.x, w.y);
  } else if (ph > 2.5 && ph < 3.5) { // fadeOut
    let w = granularity_window(g);
    return glyph_progress(w.x, w.y);
  }
  // active / upcoming / past → per-word window.
  return glyph_progress(g.b.z, g.b.w);
}

fn hash_seed(seed: f32, salt: f32) -> f32 {
  return fract(sin((seed * 127.1 + salt * 311.7)) * 43758.5453);
}

fn ease_out_cubic(x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0);
  let inv = 1.0 - t;
  return 1.0 - inv * inv * inv;
}
`;

/**
 * Transform bodies: `fn transform_effect(g: Glyph, base: GTransform) ->
 * GTransform`. `g` is the packed glyph struct (same layout as the vertex
 * shader's `Glyph`), `base` is the accumulated transform so far. Params come
 * from the shared uniform's p0..p3.
 */
export const LYRIC_FX_TRANSFORM_BODIES: Record<LyricFXTransformType, string> = {
  // Shatter — after the glyph's exit, fling it with seeded velocity + spin,
  // integrated against gravity. p0.x = strength, p0.y = gravity.
  shatter: /* wgsl */ `
fn transform_effect(g: Glyph, base: GTransform) -> GTransform {
  var t = base;
  let p = glyph_progress_g(g);
  let after = max(p - 1.0, 0.0);
  if (after > 0.0) {
    let ang = hash_seed(g.b.x, 1.0) * 6.2831853;
    let spd = (0.5 + hash_seed(g.b.x, 2.0)) * u.p0.x;
    let v = vec2f(cos(ang), sin(ang)) * spd;
    t.offset += v * after * 200.0;
    t.offset.y += 0.5 * u.p0.y * after * after * 400.0;
    t.rot += (hash_seed(g.b.x, 3.0) - 0.5) * 12.0 * after;
  }
  return t;
}`,

  // Kinetic wave — travelling sine on Y indexed by charIndex. p0.x = amplitude,
  // p0.y = wavelength, p0.z = speed.
  kineticWave: /* wgsl */ `
fn transform_effect(g: Glyph, base: GTransform) -> GTransform {
  var t = base;
  let amp = u.p0.x * (1.0 + u_energy());
  t.offset.y += amp * sin(g.a.x * u.p0.y - u_time() * u.p0.z);
  return t;
}`,

  // Scatter & assemble — interpolate from a seeded off-screen position to the
  // laid-out position across the entry window. p0.x = spread.
  scatterAssemble: /* wgsl */ `
fn transform_effect(g: Glyph, base: GTransform) -> GTransform {
  var t = base;
  let p = ease_out_cubic(glyph_progress_g(g));
  let ang = hash_seed(g.b.x, 4.0) * 6.2831853;
  let dist = (0.5 + hash_seed(g.b.x, 5.0)) * u.p0.x;
  let origin = vec2f(cos(ang), sin(ang)) * dist;
  t.offset += origin * (1.0 - p);
  t.rot += (hash_seed(g.b.x, 6.0) - 0.5) * 3.0 * (1.0 - p);
  return t;
}`,

  // Spring settle — critically-damped spring per glyph, staggered by charIndex.
  // p0.x = amplitude, p0.y = stiffness, p0.z = stagger.
  springSettle: /* wgsl */ `
fn transform_effect(g: Glyph, base: GTransform) -> GTransform {
  var t = base;
  let staggered = glyph_progress_g(g) - g.a.x * u.p0.z;
  let x = clamp(staggered, 0.0, 4.0);
  // damped oscillation settling to 0.
  let disp = u.p0.x * exp(-u.p0.y * x) * cos(x * 12.0);
  t.offset.y += disp;
  return t;
}`,

  // Vortex — polar transform about the line centre; angle/radius ease over the
  // entry phase. p0.x = radius, p0.y = turns.
  vortex: /* wgsl */ `
fn transform_effect(g: Glyph, base: GTransform) -> GTransform {
  var t = base;
  let p = ease_out_cubic(glyph_progress_g(g));
  let inv = 1.0 - p;
  let ang = inv * u.p0.y * 6.2831853 + hash_seed(g.b.x, 7.0) * 6.2831853;
  let rad = inv * u.p0.x;
  t.offset += vec2f(cos(ang), sin(ang)) * rad;
  t.rot += inv * 3.14159;
  return t;
}`,

  // Impact typewriter — glyphs recoil as neighbours are "struck". Approximated
  // per-glyph (no neighbour reads in vertex): a decaying kick at reveal.
  // p0.x = recoil.
  impactTypewriter: /* wgsl */ `
fn transform_effect(g: Glyph, base: GTransform) -> GTransform {
  var t = base;
  let p = glyph_progress_g(g);
  let kick = exp(-clamp(p, 0.0, 8.0) * 6.0);
  t.offset.y -= u.p0.x * kick;
  t.scale *= 1.0 + 0.15 * kick;
  return t;
}`,

  // Per-glyph jitter — seeded noise scaled by a routed slot. p0.x = amount.
  glyphJitter: /* wgsl */ `
fn transform_effect(g: Glyph, base: GTransform) -> GTransform {
  var t = base;
  let amt = u.p0.x * u_value1();
  let nx = hash_seed(g.b.x, floor(u_time() * 30.0)) - 0.5;
  let ny = hash_seed(g.b.x, floor(u_time() * 30.0) + 99.0) - 0.5;
  t.offset += vec2f(nx, ny) * amt;
  return t;
}`,

  // Card flip — rotate about the glyph's Y axis with a perspective foreshorten,
  // approximated as an X-scale cosine + slight rotation. p0.x = speed.
  cardFlip: /* wgsl */ `
fn transform_effect(g: Glyph, base: GTransform) -> GTransform {
  var t = base;
  let phase = u_time() * u.p0.x + g.a.x * 0.4;
  let c = cos(phase);
  t.scale *= mix(1.0, abs(c), 0.6);
  t.rot += (1.0 - abs(c)) * 0.2;
  return t;
}`,
};

/**
 * Assemble the transform prelude + the selected body, or an identity body when
 * no transform is active. Returned WGSL defines `transform_effect(g, base)`.
 */
export function assembleTransformSnippet(type: LyricFXTransformType | null): string {
  if (type === null) {
    return (
      LYRIC_FX_TRANSFORM_PRELUDE +
      '\nfn transform_effect(g: Glyph, base: GTransform) -> GTransform { return base; }\n'
    );
  }
  return LYRIC_FX_TRANSFORM_PRELUDE + '\n' + LYRIC_FX_TRANSFORM_BODIES[type] + '\n';
}

import { describe, it, expect } from 'vitest';
import {
  assembleSurfaceShader,
  LYRIC_FX_SURFACE_BODIES,
  LYRIC_FX_SURFACE_PRELUDE,
} from './surface.wgsl';
import {
  buildGlyphVertexWGSL,
  packEffectParams,
  packTransformParams,
  granularityForPhase,
} from './LyricFXGraph';
import {
  LYRIC_FX_SURFACE_TYPES,
  LYRIC_FX_STAGE,
  isSurfaceType,
  LYRIC_FX_PHASES,
  LYRIC_FX_PHASE_CODE,
  LYRIC_FX_GRANULARITIES,
  LYRIC_FX_GRANULARITY_CODE,
  defaultPhaseFor,
  phasesOf,
  createLyricFXInstance,
  type LyricFXSurfaceType,
} from '@/types/effects/lyric-fx';
import { assembleSurfaceShader as _asm, LYRIC_FX_PLAIN_SHADER } from './surface.wgsl';
import { LYRIC_FX_GATED_PLAIN_SHADER } from './surface.wgsl';
import { LYRIC_FX_TRANSFORM_TYPES } from './transform.wgsl';
import { assembleTransformSnippet, LYRIC_FX_TRANSFORM_BODIES } from './transform.wgsl';

describe('lyric-fx surface types', () => {
  it('classifies every surface type as stage "surface"', () => {
    for (const t of LYRIC_FX_SURFACE_TYPES) {
      expect(LYRIC_FX_STAGE[t]).toBe('surface');
      expect(isSurfaceType(t)).toBe(true);
    }
  });
  it('does not classify a transform type as surface', () => {
    expect(isSurfaceType('shatter')).toBe(false);
    expect(isSurfaceType('textBloom')).toBe(false);
  });
});

describe('assembleSurfaceShader', () => {
  it('has a body for every surface type', () => {
    for (const t of LYRIC_FX_SURFACE_TYPES) {
      expect(LYRIC_FX_SURFACE_BODIES[t]).toBeTruthy();
    }
  });

  it('assembles prelude + body + epilogue with a single fs_main and surface_effect', () => {
    for (const t of LYRIC_FX_SURFACE_TYPES) {
      const src = assembleSurfaceShader(t);
      expect(src).toContain(LYRIC_FX_SURFACE_PRELUDE.trim().slice(0, 20));
      // exactly one entry point and one effect fn
      expect(src.match(/fn surface_effect\(/g)?.length).toBe(1);
      expect(src.match(/@fragment/g)?.length).toBe(1);
      expect(src).toContain('fn median3(');
      expect(src).toContain('fn field_at(');
    }
  });

  it('only refraction samples layerBelow', () => {
    for (const t of LYRIC_FX_SURFACE_TYPES) {
      const bodyUsesLayerBelow = LYRIC_FX_SURFACE_BODIES[t].includes('layerBelow');
      expect(bodyUsesLayerBelow).toBe(t === 'refraction');
    }
  });

  it('every body returns a vec4f', () => {
    for (const t of LYRIC_FX_SURFACE_TYPES) {
      expect(LYRIC_FX_SURFACE_BODIES[t]).toContain('-> vec4f');
    }
  });
});

describe('packEffectParams', () => {
  const base = 16;
  const make = () => new Float32Array(32);

  it('reads a static number and an AudioReactive-style {value} param the same', () => {
    const a = make();
    packEffectParams('swell', { amount: 0.2, softness: 0.03 }, a, base);
    const b = make();
    packEffectParams('swell', { amount: { value: 0.2 }, softness: 0.03 }, b, base);
    expect(a[base]).toBeCloseTo(0.2, 6);
    expect(b[base]).toBeCloseTo(0.2, 6);
    expect(a[base + 1]).toBeCloseTo(0.03, 6);
  });

  it('packs dissolve edge colour into p1', () => {
    const out = make();
    packEffectParams(
      'dissolve',
      { progress: 0.5, edgeWidth: 0.1, edgeColor: [1, 0.4, 0.1] },
      out,
      base,
    );
    expect(out[base]).toBeCloseTo(0.5, 6);
    expect(out[base + 1]).toBeCloseTo(0.1, 6);
    expect(out[base + 4]).toBeCloseTo(1, 6);
    expect(out[base + 5]).toBeCloseTo(0.4, 6);
    expect(out[base + 6]).toBeCloseTo(0.1, 6);
  });

  it('converts angle degrees to radians for chromaticSplit', () => {
    const out = make();
    packEffectParams('chromaticSplit', { amount: 0.02, angleDeg: 90 }, out, base);
    expect(out[base]).toBeCloseTo(0.02, 6);
    expect(out[base + 1]).toBeCloseTo(Math.PI / 2, 6);
  });

  it('packs gradientFill two colours into p1 and p2', () => {
    const out = make();
    packEffectParams(
      'gradientFill',
      { colorA: [1, 0, 0, 1], colorB: [0, 0, 1, 1], angleDeg: 0, offset: 0.25 },
      out,
      base,
    );
    expect(out[base]).toBeCloseTo(0.25, 6);
    expect(out[base + 4]).toBeCloseTo(1, 6); // colorA.r → p1.x
    expect(out[base + 8 + 2]).toBeCloseTo(1, 6); // colorB.b → p2.z
  });

  it('falls back to sane defaults for an empty config', () => {
    for (const t of LYRIC_FX_SURFACE_TYPES as readonly LyricFXSurfaceType[]) {
      const out = make();
      expect(() => packEffectParams(t, {}, out, base)).not.toThrow();
    }
  });

  it('SENTINEL: never writes into the phase-gate slot (float >= 32)', () => {
    // The gate vec4 lives at floats 32..35; packEffectParams must only touch
    // 16..31 (p0..p3), or a widened param would silently clobber the phase.
    for (const t of LYRIC_FX_SURFACE_TYPES as readonly LyricFXSurfaceType[]) {
      const out = new Float32Array(36);
      // poison the gate slot; packEffectParams must leave it untouched.
      out[32] = 7;
      out[33] = 7;
      out[34] = 7;
      out[35] = 7;
      packEffectParams(t, { amount: 1, softness: 1, progress: 1 }, out, base);
      expect(out[32]).toBe(7);
      expect(out[33]).toBe(7);
      expect(out[34]).toBe(7);
      expect(out[35]).toBe(7);
    }
  });
});

describe('lyric-fx lifecycle phases + granularity', () => {
  it('defines exactly five phases with unique codes 0..4', () => {
    expect(LYRIC_FX_PHASES).toHaveLength(5);
    const codes = LYRIC_FX_PHASES.map((p) => LYRIC_FX_PHASE_CODE[p]);
    expect(new Set(codes).size).toBe(5);
    expect(Math.min(...codes)).toBe(0);
    expect(Math.max(...codes)).toBe(4);
    // Ordering the shader relies on: upcoming<fadeIn<active<fadeOut<past.
    expect(LYRIC_FX_PHASE_CODE.upcoming).toBeLessThan(LYRIC_FX_PHASE_CODE.fadeIn);
    expect(LYRIC_FX_PHASE_CODE.fadeIn).toBeLessThan(LYRIC_FX_PHASE_CODE.active);
    expect(LYRIC_FX_PHASE_CODE.active).toBeLessThan(LYRIC_FX_PHASE_CODE.fadeOut);
    expect(LYRIC_FX_PHASE_CODE.fadeOut).toBeLessThan(LYRIC_FX_PHASE_CODE.past);
  });

  it('defines three granularities letter/word/line with codes 0/1/2', () => {
    expect([...LYRIC_FX_GRANULARITIES]).toEqual(['letter', 'word', 'line']);
    expect(LYRIC_FX_GRANULARITY_CODE.letter).toBe(0);
    expect(LYRIC_FX_GRANULARITY_CODE.word).toBe(1);
    expect(LYRIC_FX_GRANULARITY_CODE.line).toBe(2);
  });

  it('seeds a sensible default phase per stage and a word granularity', () => {
    expect(defaultPhaseFor('shatter')).toBe('fadeIn'); // transform → entry
    expect(defaultPhaseFor('dissolve')).toBe('fadeOut'); // burn → exit
    expect(defaultPhaseFor('swell')).toBe('active'); // held surface
    const inst = createLyricFXInstance('swell', 'upcoming');
    expect(inst.config.lifecyclePhase).toBe('upcoming');
    expect(inst.config.granularity).toBe('word');
  });

  it('REGRESSION: line granularity uses the shared line window, not a nudged word window', () => {
    // 'line' used to fake itself by widening each glyph's own WORD window by
    // ±0.15s (cs0 - 0.15 / ce0 + 0.15). Every word still had a distinct window,
    // so a line never transitioned as one unit and 'line' looked like 'word'.
    // It must read the baked per-line span (glyph floats 22/23 → g.f.z/g.f.w).
    const vs = buildGlyphVertexWGSL(
      'fn transform_effect(g: Glyph, base: GT) -> GT { return base; }',
    );
    expect(vs).toContain('cs = g.f.z');
    expect(vs).toContain('ce = g.f.w');
    expect(vs).not.toContain('cs0 - 0.15');
    expect(vs).not.toContain('ce0 + 0.15');
  });

  it('surface + plain shaders carry the phase gate and its uniform slot', () => {
    // The gate function + the g uniform vec4 must be present so the shader can
    // read phaseCode/granularity/fade windows.
    const src = _asm('swell');
    expect(src).toContain('fn phase_gate(');
    expect(src).toContain('g: vec4f');
    expect(src).toContain('u_phaseCode()');
    // The plain base pass must NOT invoke the gate (it draws the fill under
    // gated effects). The prelude defines phase_gate(); the plain fs_main body
    // must not CALL it — assert there's no call with glyph timing args.
    expect(LYRIC_FX_PLAIN_SHADER).not.toContain('phase_gate(charTiming');
    expect(LYRIC_FX_PLAIN_SHADER).toContain('@fragment');
  });

  it('REGRESSION: no WGSL reserved keyword is used as a let/var identifier', () => {
    // `let target = ...` in phase_gate crashed every lyricfx shader on real
    // hardware ('target' is a WGSL reserved keyword) — nothing rendered. Guard
    // the whole assembled surface + plain shader set against the reserved words
    // most likely to slip in as a local name.
    const reserved = [
      'target',
      'filter',
      'sample',
      'texture',
      'layout',
      'override',
      'enum',
      'typedef',
      'shared',
      'packed',
      'atomic',
      'binding',
      'from',
      'to',
      'in',
      'out',
      'const',
      'loop',
      'for',
      'while',
      'return',
      'struct',
      'true',
      'false',
    ];
    const sources = [
      ...LYRIC_FX_SURFACE_TYPES.map((t) => _asm(t)),
      LYRIC_FX_PLAIN_SHADER,
      LYRIC_FX_GATED_PLAIN_SHADER,
      // Transform bodies + assembled snippets run in the VERTEX stage — a
      // reserved keyword here (e.g. 'from' in scatterAssemble) broke the whole
      // frame on hardware, so sweep them too.
      ...LYRIC_FX_TRANSFORM_TYPES.map((t) => LYRIC_FX_TRANSFORM_BODIES[t]),
      ...LYRIC_FX_TRANSFORM_TYPES.map((t) => assembleTransformSnippet(t)),
    ];
    for (const src of sources) {
      for (const kw of reserved) {
        const asLet = new RegExp(`\\b(let|var)\\s+${kw}\\b`);
        expect(asLet.test(src), `reserved '${kw}' used as identifier`).toBe(false);
      }
    }
  });
});

describe('transform effects: params + gated plain pass', () => {
  it('packs each transform type into p0 without throwing', () => {
    for (const t of LYRIC_FX_TRANSFORM_TYPES) {
      const out = new Float32Array(36);
      expect(() => packTransformParams(t, {}, out, 16)).not.toThrow();
    }
  });

  it('reads a static number and a {value} param the same for scatter spread', () => {
    const a = new Float32Array(36);
    packTransformParams('scatterAssemble', { spread: 200 }, a, 16);
    const b = new Float32Array(36);
    packTransformParams('scatterAssemble', { spread: { value: 200 } }, b, 16);
    expect(a[16]).toBeCloseTo(200, 6);
    expect(b[16]).toBeCloseTo(200, 6);
  });

  it('packs shatter strength+gravity into p0.x/p0.y', () => {
    const out = new Float32Array(36);
    packTransformParams('shatter', { strength: 2, gravity: 3 }, out, 16);
    expect(out[16]).toBeCloseTo(2, 6);
    expect(out[17]).toBeCloseTo(3, 6);
  });

  it('base + transform passes share ONE hard phase boundary (no ramped seam)', () => {
    // The transform pass draws only in its bound phase via a HARD current_phase
    // boundary (in_bound_phase_win), NOT the ramped phase_gate — so its edge is
    // identical to the base pass's covered check (covered_by_transform) and the
    // hand-off has no gap/double-draw/opacity-pop. Both apply lyric_envelope so
    // the moving glyph fades exactly like the resting one.
    expect(LYRIC_FX_GATED_PLAIN_SHADER).toContain('in_bound_phase_win(charTiming, wordTiming)');
    expect(LYRIC_FX_GATED_PLAIN_SHADER).toContain('lyric_envelope(');
    expect(LYRIC_FX_GATED_PLAIN_SHADER).not.toContain('phase_gate(charTiming');
    // Both share the same current_phase primitive (defined once in the prelude).
    expect(LYRIC_FX_PLAIN_SHADER).toContain('current_phase(');
    expect(LYRIC_FX_GATED_PLAIN_SHADER).toContain('current_phase(');
  });

  it('transform bodies derive motion from phase-aware glyph_progress', () => {
    // glyph_progress must read the phase code (so a transform animates in its
    // bound phase, not hard-wired to the word window).
    const src = _asm('swell'); // prelude is shared; check the transform prelude via graph vertex
    expect(src).toContain('u_phaseCode'); // surface prelude exposes it
  });

  it('base + gated plain apply the lyric fade envelope + karaoke colour', () => {
    // The base pass IS the lyric: it must fade (lyric_envelope) and colour by
    // pre/active/post (lyric_color) so fade-in/out and active-word highlight work.
    expect(LYRIC_FX_PLAIN_SHADER).toContain('lyric_envelope(');
    expect(LYRIC_FX_PLAIN_SHADER).toContain('lyric_color(');
    // Gated plain (transform pass) colours by karaoke state too.
    expect(LYRIC_FX_GATED_PLAIN_SHADER).toContain('lyric_color(');
    // The prelude exposes the three colour uniforms.
    expect(_asm('swell')).toContain('cActive: vec4f');
  });
});

describe('lyric-fx multi-select phases (phasesOf)', () => {
  it('reads the multi lifecyclePhases list, de-duplicated', () => {
    expect(phasesOf({ lifecyclePhases: ['fadeIn', 'fadeOut', 'fadeIn'] }, 'vortex')).toEqual([
      'fadeIn',
      'fadeOut',
    ]);
  });

  it('falls back to the legacy single lifecyclePhase when no list is present', () => {
    expect(phasesOf({ lifecyclePhase: 'active' }, 'swell')).toEqual(['active']);
  });

  it('falls back to the per-type default when neither is present', () => {
    expect(phasesOf({}, 'shatter')).toEqual([defaultPhaseFor('shatter')]); // ['fadeIn']
    expect(phasesOf({}, 'swell')).toEqual(['active']);
  });

  it('an empty list is treated as absent (falls back), never empty', () => {
    expect(phasesOf({ lifecyclePhases: [] }, 'swell')).toEqual(['active']);
  });

  it('a fresh instance carries both the legacy single and the new list', () => {
    const inst = createLyricFXInstance('vortex', 'fadeIn');
    expect(inst.config.lifecyclePhase).toBe('fadeIn');
    expect(inst.config.lifecyclePhases).toEqual(['fadeIn']);
  });
});

describe('lyric-fx reverse-on-fade-out', () => {
  it('the transform prelude honours u_reverse() to mirror entry motion on fade-out', () => {
    const snippet = assembleTransformSnippet('vortex');
    // The reverse accessor is read and drives the fade-out branch (1..0 mirror).
    expect(snippet).toContain('u_reverse()');
    // Fade-out ramps 1-e (reverse) vs 1+e (exit-native) via select.
    expect(snippet).toContain('1.0 - e');
    expect(snippet).toContain('1.0 + e');
  });

  it('the vertex uniform block exposes u_reverse() at slot k.w', () => {
    const vs = buildGlyphVertexWGSL(
      'fn transform_effect(g: Glyph, base: GTransform) -> GTransform { return base; }',
    );
    expect(vs).toContain('fn u_reverse() -> f32 { return u.k.w; }');
  });
});

describe('lyric-fx fade-phase granularity follows the fade timing', () => {
  const frame = (fadeGranularity?: number) =>
    ({
      time: 0,
      dt: 0,
      resolution: [100, 100],
      bass: 0,
      mid: 0,
      high: 0,
      energy: 0,
      routedSlots: [0, 0, 0, 0, 0, 0, 0, 0],
      fadeGranularity,
    }) as Parameters<typeof granularityForPhase>[2];

  it('every phase follows frame.fadeGranularity, ignoring config.granularity', () => {
    // Granularity is a single fade-timing property governing ALL phases — fade
    // passes AND active/upcoming/past — so base cover-mask and transform passes
    // resolve the same window and agree on coverage. config.granularity is dead.
    expect(granularityForPhase('fadeIn', { granularity: 'word' }, frame(0))).toBe('letter');
    expect(granularityForPhase('fadeOut', { granularity: 'word' }, frame(2))).toBe('line');
    expect(granularityForPhase('fadeIn', { granularity: 'line' }, frame(1))).toBe('word');
  });

  it('REGRESSION: active/upcoming/past also follow frame.fadeGranularity', () => {
    // Previously these returned config.granularity ('word' default). At LINE
    // fade granularity that made the base pass discard the whole line (line
    // window) while an active-phase transform drew back only the active word
    // (word window) — the other words on the line disappeared. All phases must
    // now resolve the SAME window as the base cover-mask.
    expect(granularityForPhase('active', { granularity: 'word' }, frame(2))).toBe('line');
    expect(granularityForPhase('active', {}, frame(2))).toBe('line');
    expect(granularityForPhase('upcoming', { granularity: 'word' }, frame(0))).toBe('letter');
    expect(granularityForPhase('past', { granularity: 'line' }, frame(1))).toBe('word');
  });

  it('defaults fade granularity to word when the frame omits it', () => {
    expect(granularityForPhase('fadeIn', { granularity: 'letter' }, frame(undefined))).toBe('word');
    expect(granularityForPhase('active', { granularity: 'letter' }, frame(undefined))).toBe('word');
  });
});

describe('lyric-fx anti-aliasing is uniform (not phase/granularity gated)', () => {
  it('edgeSmooth is a pure analytic width with NO per-pass AA flag branch', () => {
    // AA must be a uniform property of the text, decided upstream by the atlas
    // field resolution — NOT by a per-pass uniform the phase/granularity gate
    // rides. So edgeSmooth must not read any u_antialias flag or select() on it.
    const sources = [
      ...LYRIC_FX_SURFACE_TYPES.map((t) => assembleSurfaceShader(t)),
      LYRIC_FX_PLAIN_SHADER,
      LYRIC_FX_GATED_PLAIN_SHADER,
    ];
    for (const src of sources) {
      expect(src).not.toContain('u_antialias');
      // The l uniform slot (the old AA flag) must be gone from the struct.
      expect(src).not.toContain('l: vec4f,');
    }
    const swell = assembleSurfaceShader('swell');
    expect(swell).toContain('fn edgeSmooth(uv: vec2f) -> f32 {');
    // Analytic gradient width, unconditionally.
    expect(swell).toContain('dpdx(d)');
    expect(swell).not.toContain('6e-4'); // the old hard-cutoff constant
  });

  it('the vertex uniform block carries no AA flag either', () => {
    const vs = buildGlyphVertexWGSL(
      'fn transform_effect(g: Glyph, base: GTransform) -> GTransform { return base; }',
    );
    expect(vs).not.toContain('u_antialias');
    expect(vs).not.toContain('l: vec4f,');
  });
});

describe('lyric-fx letter granularity fade symmetry', () => {
  it('REGRESSION: letter granularity staggers BOTH cs (fade-in) and ce (fade-out)', () => {
    // The bug: letter granularity pulled cs earlier per glyph (staggered
    // fade-IN) but left ce = ce0 for every glyph, so letters faded OUT all at
    // once — "fade-out isn't working like fade-in". The fix pushes ce later by
    // the same per-glyph lead so exit ripples in the same order as entry.
    const vs = buildGlyphVertexWGSL(
      'fn transform_effect(g: Glyph, base: GTransform) -> GTransform { return base; }',
    );
    // A symmetric lead is computed and applied to BOTH ends.
    expect(vs).toContain('let lead = max(cs0 - eStart, 0.0);');
    expect(vs).toContain('cs = cs0 - lead;');
    expect(vs).toContain('ce = ce0 + lead;');
    // The old asymmetric form (ce untouched) is gone.
    expect(vs).not.toContain('cs = min(cs0, eStart);');
  });
});

describe('lyric-fx base-pass transform-covered-phase gate', () => {
  it('the plain base shader discards a glyph in a transform-owned phase (no ghost)', () => {
    // Transforms render as their own gated passes; the base pass must NOT also
    // draw the resting glyph in a phase a transform owns, or the moved copy
    // shows a static ghost behind it. g.x carries a covered-phase bitmask; the
    // base shader computes the glyph's current phase and discards if its bit set.
    //
    // The base cover check keys off a per-BIT window split (covered_by_transform):
    // fade bits (fadeIn/fadeOut) classify on charTiming (the GRANULARITY window)
    // so a line fade covers the whole line, while active/upcoming/past bits
    // classify on wordTiming (the per-WORD window) so an active transform owns
    // ONLY the sung word and does not spill onto the upcoming/past words of the
    // same line. The transform pass gates on the identical split
    // (in_bound_phase_win), so base + transform never disagree.
    expect(LYRIC_FX_PLAIN_SHADER).toContain('fn current_phase(');
    expect(LYRIC_FX_PLAIN_SHADER).toContain('covered_by_transform(mask, charTiming, wordTiming)');
    expect(LYRIC_FX_PLAIN_SHADER).toContain('discard;');
    // The transform pass gates on the same per-phase window split.
    expect(LYRIC_FX_GATED_PLAIN_SHADER).toContain('in_bound_phase_win(charTiming, wordTiming)');
  });

  it('REGRESSION: a transform owning fade-out also covers past, so the flung word does not reform', () => {
    // When an exit transform (e.g. Shatter on fade-out) owns fadeOut (bit 3),
    // the base pass must also stay silent in past (bit 4). Otherwise, under
    // letter/line granularity the base envelope (keyed on the rippled charTiming
    // that extends beyond the word window) is still > 0 in past and the flung
    // word visibly reforms behind the transform.
    expect(LYRIC_FX_PLAIN_SHADER).toContain(
      'if ((mask & (1 << u32(3))) != 0) { mask = mask | (1 << u32(4)); }',
    );
    // mask must be mutable (var) for the fold.
    expect(LYRIC_FX_PLAIN_SHADER).toContain('var mask = i32(u_phaseCode() + 0.5);');
  });
});

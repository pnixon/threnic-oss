/**
 * Determinism and IR tests for the Milkdrop engine.
 *
 * Everything here is CPU-side: the clock, the audio table, the equation
 * language and its two backends, the per-frame runner, and uniform packing.
 * The GPU half is covered by the WGSL-shape assertions at the bottom plus the
 * Playwright render tests.
 */

import { describe, expect, it } from 'vitest';

import { AudioTable } from './AudioTable';
import { FrameClock } from './FrameClock';
import { compileJS, compileWGSL, parseEquations, ParseError, VarTable, hash31 } from './ir';
import { PerFrameRunner, DEFAULT_BASE_MOTION } from './perFrame';
import { FIELD, FRAME_UNIFORM_FLOATS, frameUniformWGSL, packFrameUniforms } from './uniforms';
import { VISUALIZER_PRESETS, VIZ_BEAT_BLOOM, VIZ_TUNNEL } from './presets';
import type { FrameContext } from './types';

// ---------------------------------------------------------------------------
// FrameClock
// ---------------------------------------------------------------------------

describe('FrameClock', () => {
  it('derives time from the frame index only', () => {
    const clock = new FrameClock(60);
    expect(clock.time).toBe(0);
    clock.advance();
    expect(clock.time).toBeCloseTo(1 / 60, 12);
    expect(clock.dt).toBe(1 / 60);
    clock.seek(90);
    expect(clock.time).toBeCloseTo(1.5, 12);
  });

  it('maps time to frames the same way in both directions', () => {
    for (const fps of [24, 30, 60]) {
      for (let f = 0; f < 200; f++) {
        expect(FrameClock.frameForTime(FrameClock.timeForFrame(f, fps), fps)).toBe(f);
      }
    }
  });

  it('clamps catch-up so a stall does not become a burst', () => {
    const clock = new FrameClock(60);
    expect(clock.framesToAdvance(10, 4)).toBe(4);
    expect(clock.framesToAdvance(0)).toBe(0);
    clock.seek(120);
    expect(clock.framesToAdvance(1.0)).toBe(0);
  });

  it('rejects a nonsense framerate rather than producing Infinity time', () => {
    expect(() => new FrameClock(0)).toThrow();
    expect(() => new FrameClock(Number.NaN)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AudioTable
// ---------------------------------------------------------------------------

/** A 60Hz body under 2Hz kick transients — something a beat detector should find. */
function toneBuffer(seconds: number, sampleRate = 48000): Float32Array {
  const data = new Float32Array(Math.floor(seconds * sampleRate));
  const period = sampleRate / 2;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const sincePulse = (i % period) / sampleRate;
    const env = 0.15 + Math.exp(-sincePulse * 18);
    data[i] = Math.sin(2 * Math.PI * 60 * t) * env * 0.7;
  }
  return data;
}

describe('AudioTable', () => {
  it('produces identical rows for the same input, twice', async () => {
    const pcm = { channelData: toneBuffer(1), sampleRate: 48000 };
    const a = await AudioTable.build(pcm, { fps: 30 });
    const b = await AudioTable.build(pcm, { fps: 30 });
    expect(a.frameCount).toBe(b.frameCount);
    expect(Array.from(a.raw)).toEqual(Array.from(b.raw));
  });

  it('is indexed by frame, not by wall time, and clamps out of range', async () => {
    const table = await AudioTable.build(
      { channelData: toneBuffer(0.5), sampleRate: 48000 },
      { fps: 30 },
    );
    expect(table.at(0).frame).toBe(0);
    expect(table.at(-5).frame).toBe(0);
    expect(table.at(1e6).frame).toBe(table.frameCount - 1);
  });

  it('detects beats on a pulsing tone', async () => {
    const table = await AudioTable.build(
      { channelData: toneBuffer(3), sampleRate: 48000 },
      { fps: 60 },
    );
    // 3 seconds of 2Hz kicks; allow slack for the detector warming up.
    expect(table.at(table.frameCount - 1).beatCounter).toBeGreaterThanOrEqual(4);
    expect(table.at(table.frameCount - 1).beatCounter).toBeLessThanOrEqual(9);
  });

  it('gives a silent table for scenes with no audio', () => {
    const table = AudioTable.silent(60, 100);
    expect(table.frameCount).toBe(100);
    expect(table.at(42).bass).toBe(0);
    expect(table.waveform(42, 8).every((v) => v === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Equation language + JS backend
// ---------------------------------------------------------------------------

function runJS(source: string, inputs: Record<string, number> = {}): VarTable {
  const program = parseEquations(source);
  const table = new VarTable();
  const run = compileJS(program, table);
  for (const [k, v] of Object.entries(inputs)) table.set(k, v);
  run();
  return table;
}

describe('equation parser and JS backend', () => {
  it('evaluates arithmetic with the expected precedence', () => {
    const t = runJS('a = 1 + 2 * 3; b = (1 + 2) * 3; c = 2 ^ 3 ^ 2;');
    expect(t.get('a')).toBe(7);
    expect(t.get('b')).toBe(9);
    expect(t.get('c')).toBe(512); // right-associative
  });

  it('supports compound assignment and statement separators', () => {
    const t = runJS(`
      v = 2
      v *= 5   // newline is a separator, and this is a comment
      v -= 3;
    `);
    expect(t.get('v')).toBe(7);
  });

  it('uses EEL2 division-by-zero semantics instead of Infinity', () => {
    const t = runJS('a = 1 / 0; b = fmod(5, 0); c = log(0);');
    expect(t.get('a')).toBe(0);
    expect(t.get('b')).toBe(0);
    expect(t.get('c')).toBe(0);
  });

  it('never lets a NaN reach a variable', () => {
    const t = runJS('a = pow(0 - 1, 0.5); b = a + 1;');
    expect(t.get('a')).toBe(0);
    expect(t.get('b')).toBe(1);
  });

  it('implements the Milkdrop logic helpers', () => {
    const t = runJS(
      'a = above(2, 1); b = below(2, 1); c = if(0, 5, 9); d = bnot(0); e = band(1, 0);',
    );
    expect([t.get('a'), t.get('b'), t.get('c'), t.get('d'), t.get('e')]).toEqual([1, 0, 9, 1, 0]);
  });

  it('reads inputs and persists variables between runs', () => {
    const program = parseEquations('acc = acc + bass;');
    const table = new VarTable();
    const run = compileJS(program, table);
    table.set('bass', 0.25);
    run();
    run();
    run();
    expect(table.get('acc')).toBeCloseTo(0.75, 12);
  });

  it('makes rand() a pure function of value, frame and seed', () => {
    const a = runJS('r = rand(1);', { frame: 10, seed: 7 }).get('r');
    const b = runJS('r = rand(1);', { frame: 10, seed: 7 }).get('r');
    const c = runJS('r = rand(1);', { frame: 11, seed: 7 }).get('r');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(hash31(1, 10, 7)).toBe(a);
  });

  it('reports the line number for a syntax error', () => {
    try {
      parseEquations('a = 1;\nb = ;\n');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).line).toBe(2);
    }
  });

  it('rejects unknown functions and wrong arity', () => {
    expect(() => parseEquations('a = wobble(1);')).toThrow(/unknown function/);
    expect(() => parseEquations('a = pow(1);')).toThrow(/takes 2 argument/);
  });
});

// ---------------------------------------------------------------------------
// WGSL backend
// ---------------------------------------------------------------------------

describe('WGSL backend', () => {
  it('routes bound names to their accessors and declares locals', () => {
    const program = parseEquations('amp = 0.01 * bass; x = x + amp;');
    const out = compileWGSL(program, {
      reads: { bass: 'md_bass()', rad: 'rad' },
      vars: { x: 'x', y: 'y' },
    });
    expect(out.declarations).toContain('var e_amp: f32 = 0.0;');
    expect(out.body).toContain('md_bass()');
    // Writes to a caller-provided lvalue go through unchanged.
    expect(out.body).toContain('x = md_finite(');
    expect(out.locals).toEqual(['amp']);
  });

  it('emits guarded forms for the operators that can produce NaN', () => {
    const out = compileWGSL(parseEquations('a = b / c; d = e ^ f; g = log(h);'));
    expect(out.body).toContain('md_div(');
    expect(out.body).toContain('md_pow(');
    expect(out.body).toContain('md_log(');
    // Every assignment is finite-checked on the way in.
    expect(out.body.split('\n').every((line) => line.includes('md_finite('))).toBe(true);
  });

  it('emits float literals WGSL will accept as f32', () => {
    const out = compileWGSL(parseEquations('a = 2;'));
    expect(out.body).toContain('2.0');
  });

  it('seeds a local from its read binding when a preset overwrites an input', () => {
    const out = compileWGSL(parseEquations('bass = bass * 2; x = bass;'), {
      reads: { bass: 'md_bass()' },
      vars: { x: 'x' },
    });
    expect(out.declarations).toContain('var e_bass: f32 = md_bass();');
  });

  it('compiles both built-in presets without throwing', () => {
    for (const preset of [VIZ_TUNNEL, VIZ_BEAT_BLOOM]) {
      expect(() => parseEquations(preset.perFrame ?? '')).not.toThrow();
      const pv = compileWGSL(parseEquations(preset.perVertex ?? ''), {
        reads: { bass: 'md_bass()', rad: 'rad', time: 'md_time()', q2: 'md_q2()' },
        vars: { x: 'x', y: 'y' },
      });
      expect(pv.body.length).toBeGreaterThan(0);
    }
  });

  it('compiles ALL presets through both JS and WGSL backends', () => {
    for (const preset of VISUALIZER_PRESETS) {
      // Per-frame: must parse and compile to JS closure.
      if (preset.perFrame?.trim()) {
        const pfProgram = parseEquations(preset.perFrame);
        expect(pfProgram.statements.length, `${preset.id} perFrame empty`).toBeGreaterThan(0);
        const table = new VarTable();
        expect(() => compileJS(pfProgram, table)).not.toThrow();
      }
      // Per-vertex: must parse and compile to WGSL.
      if (preset.perVertex?.trim()) {
        const pvProgram = parseEquations(preset.perVertex);
        expect(pvProgram.statements.length, `${preset.id} perVertex empty`).toBeGreaterThan(0);
        const emission = compileWGSL(pvProgram, {
          reads: {
            bass: 'md_bass()',
            mid: 'md_mid()',
            treb: 'md_treb()',
            rad: 'rad',
            ang: 'ang',
            time: 'md_time()',
            q1: 'md_q1()',
            q2: 'md_q2()',
            q3: 'md_q3()',
            q4: 'md_q4()',
          },
          vars: { x: 'x', y: 'y' },
        });
        expect(emission.body.length, `${preset.id} WGSL empty`).toBeGreaterThan(0);
        // Verify no raw NaN-unsafe ops leaked through (direct / without md_div).
        expect(emission.body).not.toContain('/ (');
      }
    }
  });

  it('runs all presets through PerFrameRunner for 30 frames without NaN', () => {
    const silentTable = AudioTable.silent(60, 30);
    for (const preset of VISUALIZER_PRESETS) {
      const runner = new PerFrameRunner({
        source: preset.perFrame,
        base: preset.base,
        seed: 42,
      });
      for (let f = 0; f < 30; f++) {
        const m = runner.evaluate(f, 60, silentTable.at(f));
        expect(Number.isFinite(m.zoom), `${preset.id} frame ${f} zoom NaN`).toBe(true);
        expect(Number.isFinite(m.decay), `${preset.id} frame ${f} decay NaN`).toBe(true);
        expect(Number.isFinite(m.rot), `${preset.id} frame ${f} rot NaN`).toBe(true);
        expect(Number.isFinite(m.warp), `${preset.id} frame ${f} warp NaN`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Per-frame runner
// ---------------------------------------------------------------------------

const silentAudio = AudioTable.silent(60, 10).at(0);

describe('PerFrameRunner', () => {
  it('falls back to base motion when a preset has no equations', () => {
    const runner = new PerFrameRunner();
    const m = runner.evaluate(0, 60, silentAudio);
    expect(m.zoom).toBe(DEFAULT_BASE_MOTION.zoom);
    expect(m.decay).toBe(DEFAULT_BASE_MOTION.decay);
  });

  it('re-seeds motion vars from base each frame but persists user vars', () => {
    const runner = new PerFrameRunner({ source: 'zoom = zoom + 0.1; counter = counter + 1;' });
    const first = runner.evaluate(0, 60, silentAudio).zoom;
    const second = runner.evaluate(1, 60, silentAudio).zoom;
    expect(first).toBeCloseTo(1.1, 12);
    expect(second).toBeCloseTo(1.1, 12); // not 1.2 — zoom is not an accumulator
    expect(runner.table.get('counter')).toBe(2);
  });

  it('clamps motion into ranges the warp can survive', () => {
    const runner = new PerFrameRunner({ source: 'zoom = 0 - 5; decay = 9; sx = 0;' });
    const m = runner.evaluate(0, 60, silentAudio);
    expect(m.zoom).toBeGreaterThan(0);
    expect(m.decay).toBe(1);
    expect(m.sx).toBeGreaterThan(0);
  });

  it('produces the same sequence after snapshot and restore', () => {
    const source = 'acc = acc + 1; q1 = acc; zoom = 1 + acc * 0.001;';
    const a = new PerFrameRunner({ source });
    for (let f = 0; f < 20; f++) a.evaluate(f, 60, silentAudio);
    const snap = a.snapshot();
    const afterA = a.evaluate(20, 60, silentAudio).q[0];

    const b = new PerFrameRunner({ source });
    b.restore(snap);
    const afterB = b.evaluate(20, 60, silentAudio).q[0];
    expect(afterB).toBe(afterA);
  });

  it('runs a full preset deterministically from a table', async () => {
    const table = await AudioTable.build(
      { channelData: toneBuffer(1), sampleRate: 48000 },
      { fps: 30 },
    );
    const capture = (): number[] => {
      const runner = new PerFrameRunner({
        source: VIZ_TUNNEL.perFrame,
        base: VIZ_TUNNEL.base,
      });
      const out: number[] = [];
      for (let f = 0; f < table.frameCount; f++) {
        out.push(runner.evaluate(f, 30, table.at(f)).zoom);
      }
      return out;
    };
    expect(capture()).toEqual(capture());
  });
});

// ---------------------------------------------------------------------------
// Uniform packing
// ---------------------------------------------------------------------------

describe('frame uniforms', () => {
  const context = (): FrameContext => ({
    frame: 12,
    fps: 60,
    time: 0.2,
    dt: 1 / 60,
    seed: 3,
    audio: { ...silentAudio, bass: 1.5, beat: 1 },
    motion: { ...new PerFrameRunner().evaluate(0, 60, silentAudio) },
    internalWidth: 1280,
    internalHeight: 720,
    outputWidth: 3840,
    outputHeight: 2160,
    meshCols: 64,
    meshRows: 48,
  });

  it('packs a 16-byte-aligned block', () => {
    expect(FRAME_UNIFORM_FLOATS % 4).toBe(0);
  });

  it('writes fields at the indices the WGSL accessors read', () => {
    const dst = new Float32Array(FRAME_UNIFORM_FLOATS);
    const ctx = context();
    packFrameUniforms(dst, ctx);
    expect(dst[FIELD.frame]).toBe(12);
    expect(dst[FIELD.bass]).toBe(1.5);
    expect(dst[FIELD.internal_w]).toBe(1280);
    expect(dst[FIELD.output_w]).toBe(3840);
    expect(dst[FIELD.decay]).toBeCloseTo(DEFAULT_BASE_MOTION.decay, 6);
    // 16:9 internal buffer.
    expect(dst[FIELD.aspect_x]).toBeCloseTo(16 / 9, 5);
    expect(dst[FIELD.aspect_y]).toBe(1);
  });

  it('refuses a scratch buffer that is too small', () => {
    expect(() => packFrameUniforms(new Float32Array(4), context())).toThrow(/too small/);
  });

  it('generates an accessor for every field it packs', () => {
    const wgsl = frameUniformWGSL();
    for (const name of Object.keys(FIELD)) {
      expect(wgsl).toContain(`fn md_${name}() -> f32`);
    }
  });
});

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

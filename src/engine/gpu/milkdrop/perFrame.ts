/**
 * Per-frame equations — the sequential, stateful half of a preset.
 *
 * State is split by cadence. This runs once per frame on the CPU: ~100
 * variables persist frame to frame, q1..q32 propagate downward, and the result
 * is packed into one uniform block that every GPU pass reads. Per-vertex and
 * per-pixel equations are pure functions of that block plus position, so they
 * live in WGSL instead (see ir/emitWGSL.ts).
 *
 * Motion variables are re-seeded from the preset's base values every frame,
 * matching Milkdrop: `zoom = zoom + 0.1*bass` means "base zoom plus bass", not
 * a runaway accumulator. User-defined variables persist.
 */

import { compileJS, parseEquations, VarTable, type Program } from './ir';
import type { AudioFrame, MotionState } from './types';

/** Motion variables, by their equation-language names. */
const MOTION_VARS = [
  'zoom',
  'zoomexp',
  'rot',
  'warp',
  'warp_speed',
  'cx',
  'cy',
  'dx',
  'dy',
  'sx',
  'sy',
  'decay',
  'gamma',
  'echo_zoom',
  'echo_alpha',
  'echo_orient',
  'brighten',
  'darken',
  'solarize',
  'invert',
  'opacity',
  'blend_mode',
] as const;

type MotionVar = (typeof MOTION_VARS)[number];

export type BaseMotion = Record<MotionVar, number>;

export const DEFAULT_BASE_MOTION: BaseMotion = {
  zoom: 1.0,
  zoomexp: 1.0,
  rot: 0.0,
  warp: 1.0,
  warp_speed: 1.0,
  cx: 0.5,
  cy: 0.5,
  dx: 0.0,
  dy: 0.0,
  sx: 1.0,
  sy: 1.0,
  decay: 0.98,
  gamma: 1.0,
  echo_zoom: 2.0,
  echo_alpha: 0.0,
  echo_orient: 0.0,
  brighten: 0.0,
  darken: 0.0,
  solarize: 0.0,
  invert: 0.0,
  opacity: 1.0,
  blend_mode: 0.0,
};

/** Inputs written into the table before each run. Presets may read all of them. */
const FRAME_INPUTS = [
  'time',
  'frame',
  'fps',
  'seed',
  'bass',
  'mid',
  'treb',
  'vol',
  'bass_att',
  'mid_att',
  'treb_att',
  'vol_att',
  'beat',
  'beat_counter',
] as const;

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

interface PerFrameRunnerOptions {
  /** Equation source. Empty means "base values only". */
  source?: string;
  base?: Partial<BaseMotion>;
  /** Deterministic scene seed; feeds rand(). */
  seed?: number;
}

export class PerFrameRunner {
  readonly table = new VarTable();
  readonly base: BaseMotion;
  readonly seed: number;
  readonly program: Program | null;
  private readonly run: () => void;
  private readonly motion: MotionState;

  constructor(options: PerFrameRunnerOptions = {}) {
    this.base = { ...DEFAULT_BASE_MOTION, ...(options.base ?? {}) };
    this.seed = options.seed ?? 0;

    const src = options.source?.trim();
    this.program = src ? parseEquations(src) : null;
    this.run = this.program ? compileJS(this.program, this.table) : () => {};

    // Pre-allocate every slot the engine itself touches so slot indices are
    // stable and snapshots line up across a chunked export.
    for (const name of FRAME_INPUTS) this.table.slot(name);
    for (const name of MOTION_VARS) this.table.slot(name);
    for (let i = 1; i <= 32; i++) this.table.slot('q' + i);

    this.motion = {
      zoom: 1,
      zoomExp: 1,
      rot: 0,
      warp: 1,
      warpAnimSpeed: 1,
      cx: 0.5,
      cy: 0.5,
      dx: 0,
      dy: 0,
      sx: 1,
      sy: 1,
      decay: 0.98,
      gammaAdj: 1,
      echoZoom: 2,
      echoAlpha: 0,
      echoOrient: 0,
      brighten: 0,
      darken: 0,
      solarize: 0,
      invert: 0,
      opacity: 1,
      blendMode: 0,
      q: new Float32Array(32),
    };
  }

  /** Clear all persistent state. Call on preset load and on seek. */
  reset(): void {
    this.table.clear();
  }

  /**
   * Evaluate one frame. Returns the shared MotionState instance — it is
   * overwritten on the next call, so pack it before advancing.
   */
  evaluate(frame: number, fps: number, audio: AudioFrame): MotionState {
    const t = this.table;

    t.set('time', frame / fps);
    t.set('frame', frame);
    t.set('fps', fps);
    t.set('seed', this.seed);
    t.set('bass', audio.bass);
    t.set('mid', audio.mid);
    t.set('treb', audio.treb);
    t.set('vol', audio.vol);
    t.set('bass_att', audio.bassAtt);
    t.set('mid_att', audio.midAtt);
    t.set('treb_att', audio.trebAtt);
    t.set('vol_att', audio.volAtt);
    t.set('beat', audio.beat);
    t.set('beat_counter', audio.beatCounter);

    // Motion vars reset to base each frame; q-vars and user vars persist.
    for (const name of MOTION_VARS) t.set(name, this.base[name]);

    this.run();

    const m = this.motion;
    m.zoom = clamp(t.get('zoom'), 0.001, 100);
    m.zoomExp = clamp(t.get('zoomexp'), 0.01, 100);
    m.rot = clamp(t.get('rot'), -100, 100);
    m.warp = clamp(t.get('warp'), -100, 100);
    m.warpAnimSpeed = clamp(t.get('warp_speed'), 0, 100);
    m.cx = clamp(t.get('cx'), -10, 10);
    m.cy = clamp(t.get('cy'), -10, 10);
    m.dx = clamp(t.get('dx'), -10, 10);
    m.dy = clamp(t.get('dy'), -10, 10);
    m.sx = clamp(t.get('sx'), 0.001, 100);
    m.sy = clamp(t.get('sy'), 0.001, 100);
    m.decay = clamp(t.get('decay'), 0, 1);
    m.gammaAdj = clamp(t.get('gamma'), 0, 8);
    m.echoZoom = clamp(t.get('echo_zoom'), 0.001, 100);
    m.echoAlpha = clamp(t.get('echo_alpha'), 0, 1);
    m.echoOrient = clamp(Math.round(t.get('echo_orient')), 0, 3);
    m.brighten = t.get('brighten') > 0.5 ? 1 : 0;
    m.darken = t.get('darken') > 0.5 ? 1 : 0;
    m.solarize = t.get('solarize') > 0.5 ? 1 : 0;
    m.invert = t.get('invert') > 0.5 ? 1 : 0;
    m.opacity = clamp(t.get('opacity'), 0, 1);
    m.blendMode = t.get('blend_mode') >= 0.5 ? 1 : 0;

    for (let i = 0; i < 32; i++) {
      const v = t.get('q' + (i + 1));
      m.q[i] = Number.isFinite(v) ? v : 0;
    }
    return m;
  }

  /**
   * Copy of the persistent variable space. A long export is chunked into
   * segments to survive GPU watchdog resets, and a segment boundary has to
   * carry this across along with the feedback textures — otherwise the preset
   * restarts mid-track.
   */
  snapshot(): Float64Array {
    return this.table.snapshot();
  }

  restore(snap: Float64Array): void {
    this.table.restore(snap);
  }
}

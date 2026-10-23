/**
 * PerfProfiler — a dev-only, flag-gated frame/phase profiler for the render and
 * export hot paths.
 *
 * HARD GATE (three conditions, all required for any work to happen):
 *   1. `process.env.NODE_ENV === 'development'`  (stripped/false in prod builds)
 *   2. running on localhost / 127.0.0.1            (never on a deployed origin)
 *   3. the UI flag is on (`profilingEnabled` in systemStore)
 *
 * When the gate is closed, every method is a cheap early-return — no timers, no
 * allocations, no console output. This keeps prod and normal dev completely
 * unaffected. The gate is re-checked cheaply on each frame boundary via a
 * setter the store calls (`setEnabled`), so flipping the toggle takes effect on
 * the next frame without a reload.
 *
 * Usage (per frame):
 *   profiler.frameStart('export', frameIndex);
 *   profiler.begin('resolve'); ...; profiler.end('resolve');
 *   profiler.begin('render');  ...; profiler.end('render');
 *   profiler.frameEnd();       // rolls the phase timers into the aggregate
 *
 * Every `AGGREGATE_EVERY` frames it prints a per-phase ms table to the console
 * (min / avg / max / p95 over the window) and, if capturing, keeps the raw
 * per-frame samples for a downloadable JSON trace (`downloadTrace()`).
 */

// ── Config ──

const AGGREGATE_EVERY = 120; // print/roll the phase table every N frames
const MAX_TRACE_FRAMES = 20000; // cap raw sample retention (protects memory)

// ── Types ──

type ProfilerContext = 'export' | 'preview' | string;

interface PhaseAccumulator {
  count: number;
  total: number;
  min: number;
  max: number;
  samples: number[]; // for p95 within the aggregation window
}

interface FrameSample {
  ctx: ProfilerContext;
  frame: number;
  t: number; // wall-clock ms since profiler epoch
  phases: Record<string, number>; // phase -> ms
  total: number; // frame total ms
}

// ── Gate ──

function isLocalhost(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

const IS_DEV = process.env.NODE_ENV === 'development';

// ── Profiler ──

class PerfProfiler {
  /** UI-flag component of the gate. Toggled by systemStore.setProfilingEnabled. */
  private _flag = false;
  /** Cached full-gate result, recomputed on setEnabled and frameStart. */
  private _active = false;

  private _ctx: ProfilerContext = 'export';
  private _frame = 0;
  private _epoch = 0;

  private _frameStartT = 0;
  private _phaseStart = new Map<string, number>();
  private _framePhases: Record<string, number> = {};

  private _accum = new Map<string, PhaseAccumulator>();
  private _windowFrames = 0;

  private _capturing = false;
  private _trace: FrameSample[] = [];

  /** Called by systemStore when the UI toggle flips. Recomputes the gate. */
  setEnabled(on: boolean): void {
    this._flag = on;
    this._active = IS_DEV && isLocalhost() && on;
    if (this._active && this._epoch === 0) {
      this._epoch = performance.now();
    }
    if (!on) {
      // Flush a final table if we have pending window data, then reset live state.
      if (this._windowFrames > 0) this._emitTable();
      this._resetWindow();
      this._phaseStart.clear();
      this._framePhases = {};
    }
  }

  /** True only when dev + localhost + flag. Cheap. */
  get active(): boolean {
    return this._active;
  }

  /** Start capturing raw per-frame samples for a downloadable JSON trace. */
  startCapture(): void {
    if (!this._active) return;
    this._capturing = true;
    this._trace = [];
    console.log('[Profiler] Trace capture started.');
  }

  /** Stop capturing. Samples are retained until downloadTrace()/startCapture(). */
  stopCapture(): void {
    this._capturing = false;
    console.log(`[Profiler] Trace capture stopped. ${this._trace.length} frames captured.`);
  }

  get capturing(): boolean {
    return this._capturing;
  }

  get capturedFrameCount(): number {
    return this._trace.length;
  }

  // ── Per-frame API ──

  frameStart(ctx: ProfilerContext, frame: number): void {
    if (!this._active) return;
    this._ctx = ctx;
    this._frame = frame;
    this._frameStartT = performance.now();
    this._framePhases = {};
    this._phaseStart.clear();
  }

  /** Begin timing a named phase within the current frame. */
  begin(phase: string): void {
    if (!this._active) return;
    this._phaseStart.set(phase, performance.now());
  }

  /** End a named phase; accumulates its elapsed ms into the current frame. */
  end(phase: string): void {
    if (!this._active) return;
    const s = this._phaseStart.get(phase);
    if (s === undefined) return;
    const dt = performance.now() - s;
    this._phaseStart.delete(phase);
    this._framePhases[phase] = (this._framePhases[phase] ?? 0) + dt;
  }

  /** Time a synchronous function as a phase. Returns its result. */
  measure<T>(phase: string, fn: () => T): T {
    if (!this._active) return fn();
    this.begin(phase);
    try {
      return fn();
    } finally {
      this.end(phase);
    }
  }

  /** Time an async function as a phase. Returns its awaited result. */
  async measureAsync<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    if (!this._active) return fn();
    this.begin(phase);
    try {
      return await fn();
    } finally {
      this.end(phase);
    }
  }

  /** Close the current frame: roll phase timings into the aggregate + trace. */
  frameEnd(): void {
    if (!this._active) return;
    const total = performance.now() - this._frameStartT;

    // Accumulate each phase for the rolling window table.
    for (const [phase, ms] of Object.entries(this._framePhases)) {
      let acc = this._accum.get(phase);
      if (!acc) {
        acc = { count: 0, total: 0, min: Infinity, max: -Infinity, samples: [] };
        this._accum.set(phase, acc);
      }
      acc.count++;
      acc.total += ms;
      if (ms < acc.min) acc.min = ms;
      if (ms > acc.max) acc.max = ms;
      acc.samples.push(ms);
    }
    // Track the frame total under a reserved key.
    let totAcc = this._accum.get('_frame');
    if (!totAcc) {
      totAcc = { count: 0, total: 0, min: Infinity, max: -Infinity, samples: [] };
      this._accum.set('_frame', totAcc);
    }
    totAcc.count++;
    totAcc.total += total;
    if (total < totAcc.min) totAcc.min = total;
    if (total > totAcc.max) totAcc.max = total;
    totAcc.samples.push(total);

    if (this._capturing && this._trace.length < MAX_TRACE_FRAMES) {
      this._trace.push({
        ctx: this._ctx,
        frame: this._frame,
        t: performance.now() - this._epoch,
        phases: { ...this._framePhases },
        total,
      });
    }

    this._windowFrames++;
    if (this._windowFrames >= AGGREGATE_EVERY) {
      this._emitTable();
      this._resetWindow();
    }
  }

  // ── Trace download ──

  /**
   * Build the captured trace as a JSON string. Includes a small summary header
   * plus every retained per-frame sample.
   */
  buildTraceJSON(): string {
    const summary = this._summaryFromTrace();
    return JSON.stringify(
      {
        meta: {
          generatedAt: new Date().toISOString(),
          context: this._ctx,
          frameCount: this._trace.length,
          aggregateEvery: AGGREGATE_EVERY,
          note: 'Threnic dev profiler trace. Times in ms.',
        },
        summary,
        frames: this._trace,
      },
      null,
      2,
    );
  }

  /** Trigger a browser download of the captured trace as a .json file. */
  downloadTrace(): void {
    if (typeof window === 'undefined') return;
    if (this._trace.length === 0) {
      console.warn('[Profiler] No trace captured — call startCapture() and run the path first.');
      return;
    }
    const json = this.buildTraceJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `threnic-profile-${this._ctx}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.log(`[Profiler] Downloaded trace (${this._trace.length} frames).`);
  }

  // ── Internals ──

  private _summaryFromTrace(): Record<
    string,
    { avg: number; min: number; max: number; p95: number }
  > {
    const byPhase = new Map<string, number[]>();
    for (const f of this._trace) {
      byPhase.set('_frame', [...(byPhase.get('_frame') ?? []), f.total]);
      for (const [phase, ms] of Object.entries(f.phases)) {
        byPhase.set(phase, [...(byPhase.get(phase) ?? []), ms]);
      }
    }
    const out: Record<string, { avg: number; min: number; max: number; p95: number }> = {};
    for (const [phase, arr] of byPhase) {
      out[phase] = this._stats(arr);
    }
    return out;
  }

  private _stats(arr: number[]): { avg: number; min: number; max: number; p95: number } {
    if (arr.length === 0) return { avg: 0, min: 0, max: 0, p95: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return {
      avg: +(sum / sorted.length).toFixed(3),
      min: +sorted[0].toFixed(3),
      max: +sorted[sorted.length - 1].toFixed(3),
      p95: +p95.toFixed(3),
    };
  }

  private _emitTable(): void {
    const rows: Record<
      string,
      { count: number; avg: string; min: string; max: string; p95: string }
    > = {};
    for (const [phase, acc] of this._accum) {
      const stats = this._stats(acc.samples);
      const label = phase === '_frame' ? 'FRAME TOTAL' : phase;
      rows[label] = {
        count: acc.count,
        avg: stats.avg.toFixed(2),
        min: stats.min.toFixed(2),
        max: stats.max.toFixed(2),
        p95: stats.p95.toFixed(2),
      };
    }
    const fps = rows['FRAME TOTAL'] ? (1000 / parseFloat(rows['FRAME TOTAL'].avg)).toFixed(1) : '?';
    console.log(`[Profiler] ${this._ctx} — ${this._windowFrames} frames, ~${fps} fps (phase ms):`);
    // console.table renders a clean per-phase grid in dev tools.
    console.table(rows);
  }

  private _resetWindow(): void {
    this._accum.clear();
    this._windowFrames = 0;
  }
}

/** Singleton — imported by the render/export hot paths and the UI toggle. */
export const profiler = new PerfProfiler();

// Expose on window in dev for quick console access (window.__threnicProfiler).
if (IS_DEV && typeof window !== 'undefined') {
  (window as unknown as { __threnicProfiler?: PerfProfiler }).__threnicProfiler = profiler;
}

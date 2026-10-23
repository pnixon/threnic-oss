/**
 * Audio-Reactive Contract & Regression Suite
 * ------------------------------------------------------------------------
 * This suite exists because audio-reactivity regressions "keep leaking back":
 * the pipeline has several independent links that must all agree, and each has
 * silently broken in the past —
 *
 *   config.audioReactive  (persisted shape, per-param keyed)
 *        ↓  PASS_DEFS[type].extractState(config)      ← the mapping layer
 *   pass state { <param>, audioReactive: {...} }
 *        ↓  createXUpdater(getState) → createARUpdater ← the envelope layer
 *   uniforms Float32Array                              ← what the shader reads
 *        ↑  EffectPassParams.audioBass/mid/high/energy ← the live band feed
 *
 * Rather than test the envelope math in isolation (already covered elsewhere),
 * these tests drive the SAME production factories the renderer uses
 * (PASS_DEFS + the real updater) with REAL non-zero bands, and assert the
 * uniforms actually move. If a link breaks, exactly one describe-block fails
 * and names the layer.
 *
 * The two live symptoms this guards against:
 *   1. Distortion "doesn't respect the audio-reactive widget" — the widget
 *      persists a per-param-keyed audioReactive map; extractState + the schema
 *      must read that same shape. A drift in either makes the effect inert.
 *   2. Oscilloscope "renders but isn't reactive" — its band inputs
 *      (params.audioBass/mid/high/energy) must reach the uniform buffer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PASS_DEFS } from './EffectsManager';
import type { EffectPassParams } from './RenderGraph';
import type { AudioReactiveConfig } from '@/types/effects/audio-reactive';
import { audioStore } from '@/engine/stores/audioStore';

// ─── Uniform layout indices (must match the WGSL structs) ──────────────────
// Distortion (see createDistortionUpdater in EffectPasses.ts):
const DIST = { time: 0, intensity: 1, distortAmount: 2, rippleSpeed: 3 } as const;
// Oscilloscope (see createOscilloscopeUpdater in OscilloscopePass.ts):
const OSC = { energy: 19, bass: 20, mid: 21, high: 22 } as const;

const UNIFORM_FLOATS = 1600; // comfortably covers every pass's buffer

function makeParams(overrides: Partial<EffectPassParams> = {}): EffectPassParams {
  return {
    time: 0,
    dt: 1 / 60,
    resolution: [1920, 1080],
    audioBass: 0,
    audioMid: 0,
    audioHigh: 0,
    audioEnergy: 0,
    didReset: false,
    ...overrides,
  };
}

/** A fully-specified reactive config that maps a band directly onto [min,max]. */
function reactive(overrides: Partial<AudioReactiveConfig> = {}): AudioReactiveConfig {
  return {
    enabled: true,
    band: 'bass',
    intensity: 1.0,
    min: 0,
    max: 1,
    attack: 0.02,
    decay: 0.05,
    lowerThreshold: 0,
    upperThreshold: 1,
    boxCenter: 0.5,
    boxWidth: 1.0, // wide box → near-linear band→value mapping for easy assertions
    ...overrides,
  };
}

/**
 * Drive an updater to STEADY STATE for a constant band value. The envelope
 * snaps on the first frame then smooths, so a single frame is already at
 * target for an unchanging input — but we run several to be robust to any
 * attack/decay coupling.
 */
function settle(
  update: (u: Float32Array, p: EffectPassParams) => void,
  params: EffectPassParams,
  frames = 30,
): Float32Array {
  const u = new Float32Array(UNIFORM_FLOATS);
  for (let i = 0; i < frames; i++) update(u, { ...params, time: i / 60 });
  return u;
}

// ═══════════════════════════════════════════════════════════════════════════
// Distortion — the "doesn't respect the AR widget" regression
// ═══════════════════════════════════════════════════════════════════════════
describe('Distortion audio-reactivity (production path: extractState → updater → uniforms)', () => {
  const def = PASS_DEFS.distortion;

  it('is a registered pass with a factory and extractState', () => {
    expect(def).toBeTruthy();
    expect(typeof def.createUpdater).toBe('function');
    expect(typeof def.extractState).toBe('function');
  });

  it('leaves intensity at its base value when NO audioReactive config is present', () => {
    // Baseline: a plain distortion with a fixed intensity must render that exact
    // intensity — proves the updater does not zero or mangle a non-reactive param.
    const state = def.extractState({ intensity: 0.7, distortAmount: 2.0 });
    const update = def.createUpdater(() => state);
    const u = settle(update, makeParams({ audioBass: 0.9 })); // audio present but unused
    expect(u[DIST.intensity]).toBeCloseTo(0.7, 4);
    expect(u[DIST.distortAmount]).toBeCloseTo(2.0, 4);
  });

  it('reads the widget-persisted per-param audioReactive shape and REACTS', () => {
    // This is the exact shape DistortionEditor writes:
    //   audioReactive: { intensity: {enabled, band, min, max, ...} }
    const config = {
      intensity: 0.0,
      distortAmount: 1.0,
      audioReactive: {
        intensity: reactive({ band: 'bass', min: 0, max: 1 }),
      },
    };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);

    const quiet = settle(update, makeParams({ audioBass: 0.0 }));
    const loud = settle(update, makeParams({ audioBass: 1.0 }));

    // The whole point: intensity must track the bass band, not sit at base.
    expect(quiet[DIST.intensity]).toBeCloseTo(0.0, 2);
    expect(loud[DIST.intensity]).toBeGreaterThan(0.8);
  });

  it('does NOT react when the AR config is present but disabled', () => {
    const config = {
      intensity: 0.4,
      audioReactive: { intensity: reactive({ enabled: false }) },
    };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);
    const loud = settle(update, makeParams({ audioBass: 1.0 }));
    // Disabled → base value passes through untouched.
    expect(loud[DIST.intensity]).toBeCloseTo(0.4, 4);
  });

  it('respects band selection — a mid-band config ignores bass', () => {
    const config = {
      intensity: 0.0,
      audioReactive: { intensity: reactive({ band: 'mid', min: 0, max: 1 }) },
    };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);

    const bassOnly = settle(update, makeParams({ audioBass: 1.0, audioMid: 0.0 }));
    const midOnly = settle(update, makeParams({ audioBass: 0.0, audioMid: 1.0 }));

    expect(bassOnly[DIST.intensity]).toBeCloseTo(0.0, 2); // bass must not drive a mid config
    expect(midOnly[DIST.intensity]).toBeGreaterThan(0.8);
  });

  it('a param not in the AR map stays fixed even while another param reacts', () => {
    const config = {
      intensity: 0.0,
      distortAmount: 3.0, // NOT reactive
      audioReactive: { intensity: reactive({ band: 'bass', min: 0, max: 1 }) },
    };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);
    const loud = settle(update, makeParams({ audioBass: 1.0 }));
    expect(loud[DIST.intensity]).toBeGreaterThan(0.8);
    expect(loud[DIST.distortAmount]).toBeCloseTo(3.0, 4); // untouched
  });

  it('honours lowerThreshold — a band below the floor produces the min value', () => {
    const config = {
      intensity: 0.0,
      audioReactive: {
        intensity: reactive({ band: 'bass', min: 0, max: 1, lowerThreshold: 0.5 }),
      },
    };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);
    const belowFloor = settle(update, makeParams({ audioBass: 0.3 })); // < 0.5
    expect(belowFloor[DIST.intensity]).toBeCloseTo(0.0, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Box-plot curve fidelity — the "renders below the effect start" regression
// The widget draws a green response curve; the rendered uniform MUST equal that
// curve's output for the same audio input. Screenshot repro: a narrow box on the
// RIGHT with min=0,max=1.5, lowerThreshold≈0.03. An input LEFT of the box must
// return a LOW value (log region), not the peak.
// ═══════════════════════════════════════════════════════════════════════════
describe('Distortion follows the box-plot curve (renders-below-start regression)', () => {
  const def = PASS_DEFS.distortion;

  // Reproduce the on-screen config: peak box pushed to the right, wide-open
  // thresholds, min 0 / max 1.5. This is where the effect should be near-zero
  // for a mid input and only ramp up as the input enters the box.
  const screenshotAR = reactive({
    band: 'bass',
    min: 0,
    max: 1.5,
    intensity: 1.0,
    lowerThreshold: 0.03,
    upperThreshold: 1.0,
    boxCenter: 0.9, // box centered far right
    boxWidth: 0.15, // narrow box
  });

  it('an input LEFT of the box yields a value far below max (log-region, not peak)', () => {
    const config = { intensity: 0.0, audioReactive: { intensity: screenshotAR } };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);

    // Live ≈ 0.6 sits below the box (boxMin ≈ 0.9-0.075 = 0.825). The box-plot's
    // lower log region should keep the value LOW (< ~0.5 of the 1.5 span).
    const belowBox = settle(update, makeParams({ audioBass: 0.6 }));
    expect(belowBox[DIST.intensity]).toBeLessThan(0.75); // < half of max=1.5
  });

  it('an input INSIDE the box yields a near-peak value', () => {
    const config = { intensity: 0.0, audioReactive: { intensity: screenshotAR } };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);
    // audioBass 0.97 is at the box's upper edge → box-plot peak region (0.9-1.0
    // of span), so the value should be near max=1.5.
    const inBox = settle(update, makeParams({ audioBass: 0.97 }));
    expect(inBox[DIST.intensity]).toBeGreaterThan(1.2); // near max=1.5
  });

  it('the value is monotonic: below-box < in-box < above-box-clamped', () => {
    const config = { intensity: 0.0, audioReactive: { intensity: screenshotAR } };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);
    const lo = settle(update, makeParams({ audioBass: 0.4 }))[DIST.intensity];
    const mid = settle(update, makeParams({ audioBass: 0.9 }))[DIST.intensity];
    const hi = settle(update, makeParams({ audioBass: 1.0 }))[DIST.intensity];
    expect(lo).toBeLessThan(mid);
    expect(mid).toBeLessThanOrEqual(hi + 1e-6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Attack / Decay coupling — documents why the widget default matters
// ═══════════════════════════════════════════════════════════════════════════
describe('Distortion attack/decay smoothing (the ~1s lag regression)', () => {
  const def = PASS_DEFS.distortion;

  it('a snappy decay (0.05s) drops fast once the band goes quiet', () => {
    const config = {
      intensity: 0.0,
      audioReactive: { intensity: reactive({ band: 'bass', min: 0, max: 1, decay: 0.05 }) },
    };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);
    const u = new Float32Array(UNIFORM_FLOATS);

    // Ramp up loud, then one frame of silence.
    for (let i = 0; i < 30; i++) update(u, makeParams({ audioBass: 1.0, time: i / 60 }));
    update(u, makeParams({ audioBass: 0.0, time: 31 / 60 })); // ~16ms of a 50ms decay
    // After a single 16ms tick of a 50ms decay it should have fallen noticeably.
    expect(u[DIST.intensity]).toBeLessThan(0.8);
  });

  it('a sluggish decay (1.0s) barely moves in one frame — the bug the widget default caused', () => {
    const config = {
      intensity: 0.0,
      audioReactive: { intensity: reactive({ band: 'bass', min: 0, max: 1, decay: 1.0 }) },
    };
    const state = def.extractState(config);
    const update = def.createUpdater(() => state);
    const u = new Float32Array(UNIFORM_FLOATS);

    for (let i = 0; i < 30; i++) update(u, makeParams({ audioBass: 1.0, time: i / 60 }));
    update(u, makeParams({ audioBass: 0.0, time: 31 / 60 }));
    // With a 1s decay, 16ms barely touches it — this is why the effect "lingered"
    // ~1s after each beat. Kept as a documented contrast, not a desired state.
    expect(u[DIST.intensity]).toBeGreaterThan(0.95);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Oscilloscope — the "renders but isn't reactive" regression
// ═══════════════════════════════════════════════════════════════════════════
describe('Oscilloscope audio-reactivity (band inputs reach the uniform buffer)', () => {
  const def = PASS_DEFS.visualizer;

  beforeEach(() => {
    audioStore.getState().reset();
  });

  it('is registered under the "visualizer" type', () => {
    expect(def).toBeTruthy();
    expect(typeof def.createUpdater).toBe('function');
  });

  it('propagates params.audioBass/mid/high/energy into the reactive uniform slots', () => {
    const state = def.extractState({ type: 'linear' });
    const update = def.createUpdater(() => state);
    const u = new Float32Array(UNIFORM_FLOATS);

    update(u, makeParams({ audioBass: 0.42, audioMid: 0.31, audioHigh: 0.77, audioEnergy: 0.5 }));

    // If these are stuck at 0, the tunnel pulse / brightness never moves — exactly
    // the "shape shows but nothing reacts" symptom.
    expect(u[OSC.energy]).toBeCloseTo(0.5, 4);
    expect(u[OSC.bass]).toBeCloseTo(0.42, 4);
    expect(u[OSC.mid]).toBeCloseTo(0.31, 4);
    expect(u[OSC.high]).toBeCloseTo(0.77, 4);
  });

  it('band uniforms track a changing feed frame-to-frame (no stale latch)', () => {
    const state = def.extractState({ type: 'tunnel' });
    const update = def.createUpdater(() => state);
    const u = new Float32Array(UNIFORM_FLOATS);

    update(u, makeParams({ audioBass: 0.1, time: 0 }));
    expect(u[OSC.bass]).toBeCloseTo(0.1, 4);

    update(u, makeParams({ audioBass: 0.9, time: 1 / 60 }));
    expect(u[OSC.bass]).toBeCloseTo(0.9, 4); // updated, not latched at 0.1
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-effect contract — every AR-capable pass reads its own persisted shape
// ═══════════════════════════════════════════════════════════════════════════
describe('AR contract — extractState preserves the audioReactive map for every pass that declares one', () => {
  // Passes whose editors persist a per-param-keyed audioReactive object and whose
  // extractState must forward it verbatim (the shape the schema then reads).
  const perParamPasses = [
    'distortion',
    'bloom',
    'vhsTracking',
    'oldFilm',
    'starfield',
    'particles',
    'rain',
    'motionBlur',
    'lensFlare',
    'cameraShake',
  ];

  it.each(perParamPasses)('%s forwards config.audioReactive into pass state', (type) => {
    const def = PASS_DEFS[type];
    expect(def, `PASS_DEFS.${type} missing`).toBeTruthy();
    const ar = { intensity: reactive() };
    const state = def.extractState({ audioReactive: ar });
    // The updater looks up state.audioReactive?.<key>; extractState must not drop it.
    expect(state.audioReactive).toBeTruthy();
  });
});

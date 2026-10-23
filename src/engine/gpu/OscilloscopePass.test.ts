import { describe, it, expect, beforeEach } from 'vitest';
import { createOscilloscopeUpdater, type OscilloscopePassState } from './OscilloscopePass';
import { audioStore } from '@/engine/stores/audioStore';
import type { EffectPassParams } from './RenderGraph';

// Uniform layout indices used by the updater (see OscilloscopePass config docs):
//   index 15      → opacity (vec4[3].w)
//   index 28..155 → 128 downsampled waveform samples
const OPACITY_IDX = 15;
const WAVE_OFFSET = 28;
const WAVE_LEN = 128;
const UNIFORM_FLOATS = 1600; // > 28 + 1536, comfortably covers the buffer

function makeState(overrides: Partial<OscilloscopePassState> = {}): OscilloscopePassState {
  return {
    type: 0, // linear
    lineWidth: 1.5,
    sensitivity: 1.0,
    smoothness: 0.85,
    positionX: 50,
    positionY: 50,
    scale: 1.0,
    minColorR: 0.16,
    minColorG: 0.16,
    minColorB: 0.18,
    maxColorR: 0.94,
    maxColorG: 0.27,
    maxColorB: 0.27,
    glowIntensity: 1.5,
    opacity: 1.0,
    ...overrides,
  };
}

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

/** Fill the store's time-domain buffer with a flat DC value (silence baseline = 128). */
function setFlatBuffer(value = 128) {
  audioStore.setState({ timeDomainData: new Uint8Array(2048).fill(value) });
}

/** Fill the store's time-domain buffer with a real varying waveform (a sine). */
function setSineBuffer() {
  const buf = new Uint8Array(2048);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = 128 + Math.round(100 * Math.sin((i / buf.length) * Math.PI * 8));
  }
  audioStore.setState({ timeDomainData: buf });
}

describe('createOscilloscopeUpdater — idle fade & priming', () => {
  beforeEach(() => {
    audioStore.getState().reset();
  });

  it('fades opacity toward 0 on a flat idle buffer (no dead flat line)', () => {
    const update = createOscilloscopeUpdater(() => makeState());
    const u = new Float32Array(UNIFORM_FLOATS);

    // Run several frames of pure silence.
    for (let i = 0; i < 60; i++) update(u, makeParams({ time: i / 60 }));

    // With no signal, the oscilloscope must have faded out (opacity ≈ 0).
    expect(u[OPACITY_IDX]).toBeLessThan(0.05);
  });

  it('does NOT prime the smoothing buffer on a flat idle frame', () => {
    // Idle buffer at the 128 silence baseline decodes to ~0. Even a frozen DC
    // offset (a flat non-zero line) must not count as signal.
    const update = createOscilloscopeUpdater(() => makeState());
    const u = new Float32Array(UNIFORM_FLOATS);

    setFlatBuffer(200); // flat, non-zero — the old bug primed on this
    update(u, makeParams());

    // Every waveform sample should be identical (flat) — a flat frame carries no
    // shape to prime, and the fade keeps it invisible anyway.
    const first = u[WAVE_OFFSET];
    for (let i = 1; i < WAVE_LEN; i++) {
      expect(u[WAVE_OFFSET + i]).toBeCloseTo(first, 5);
    }
  });

  it('snaps to full opacity immediately when real signal arrives (no fade-in pop)', () => {
    const update = createOscilloscopeUpdater(() => makeState({ opacity: 1.0 }));
    const u = new Float32Array(UNIFORM_FLOATS);

    setSineBuffer();
    // FIRST frame with signal must already be at full opacity — the waveform
    // appears in place, it never fades or slides in.
    update(u, makeParams());
    expect(u[OPACITY_IDX]).toBeCloseTo(1.0, 5);
  });

  it('seeds the shape directly on the first signal frame (no EMA ramp from zero)', () => {
    const update = createOscilloscopeUpdater(() => makeState({ smoothness: 0.99 }));
    const u = new Float32Array(UNIFORM_FLOATS);

    setSineBuffer();
    update(u, makeParams());

    // If it had ramped from a zeroed buffer through a 0.99 EMA, the samples would
    // be tiny. Seeded-directly means at least one sample has meaningful magnitude.
    let peak = 0;
    for (let i = 0; i < WAVE_LEN; i++) peak = Math.max(peak, Math.abs(u[WAVE_OFFSET + i]));
    expect(peak).toBeGreaterThan(0.3);
  });

  it('respects the user opacity value while live', () => {
    const update = createOscilloscopeUpdater(() => makeState({ opacity: 0.5 }));
    const u = new Float32Array(UNIFORM_FLOATS);

    setSineBuffer();
    update(u, makeParams());
    expect(u[OPACITY_IDX]).toBeCloseTo(0.5, 5);
  });
});

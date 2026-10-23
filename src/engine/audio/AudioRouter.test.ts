import { describe, it, expect } from 'vitest';
import { createAudioRouter } from './AudioRouter';
import type { AudioBands } from './arParam';
import {
  DEFAULT_AUDIO_ROUTING,
  type AudioRoutingTable,
  type SlotRouting,
} from '@/types/effects/audio-routing';

const SILENCE: AudioBands = { energy: 0, bass: 0, mid: 0, high: 0 };
const LOUD: AudioBands = { energy: 1, bass: 1, mid: 1, high: 1 };

function slot(
  source: SlotRouting['source'],
  shape: Partial<SlotRouting['shape']> = {},
): SlotRouting {
  return {
    source,
    shape: {
      enabled: true,
      band: 'energy',
      intensity: 1,
      min: 0,
      max: 1,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 1,
      attack: 0.02,
      decay: 0.05,
      ...shape,
    },
  };
}

function tableWith(slots: (SlotRouting | null)[]): AudioRoutingTable {
  const padded = [...slots];
  while (padded.length < 8) padded.push(null);
  return { slots: padded, customBands: [] };
}

describe('AudioRouter — slot resolution (Stage 1)', () => {
  it('returns a reused 8-length buffer', () => {
    const r = createAudioRouter();
    const out = r.update(1 / 60, SILENCE, null);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(8);
  });

  it('unrouted slots (default table) are all 0', () => {
    const r = createAudioRouter();
    r.setTable(DEFAULT_AUDIO_ROUTING);
    const out = r.update(1 / 60, LOUD, null);
    for (let i = 0; i < 8; i++) expect(out[i]).toBe(0);
  });

  it('silence resolves a routed slot to 0', () => {
    const r = createAudioRouter();
    r.setTable(tableWith([slot('bass')]));
    const out = r.update(1 / 60, SILENCE, null);
    expect(out[0]).toBeCloseTo(0, 5);
  });

  it('a loud source drives its slot toward 1 (first-frame snap)', () => {
    const r = createAudioRouter();
    r.setTable(tableWith([slot('bass')]));
    const out = r.update(1 / 60, LOUD, null);
    // First frame snaps to target (no stale smoothing), target ~= 1 with full box.
    expect(out[0]).toBeGreaterThan(0.9);
  });

  it('routes each source to the correct slot independently', () => {
    const r = createAudioRouter();
    r.setTable(tableWith([slot('bass'), slot('mid'), slot('high'), slot('energy')]));
    const bands: AudioBands = { bass: 0.9, mid: 0.1, high: 0.5, energy: 0.7 };
    const out = r.update(1 / 60, bands, null);
    // First-frame snap → values track their source ordering.
    expect(out[0]).toBeGreaterThan(out[1]); // bass 0.9 > mid 0.1
    expect(out[2]).toBeGreaterThan(out[1]); // high 0.5 > mid 0.1
    expect(out[3]).toBeGreaterThan(out[1]); // energy 0.7 > mid 0.1
  });

  it('step response respects attack/decay smoothing after the first frame', () => {
    const r = createAudioRouter();
    // Slow attack so a single dt step does NOT reach the target.
    r.setTable(tableWith([slot('bass', { attack: 1.0, decay: 1.0 })]));
    // Frame 1: snaps to silence target (0).
    r.update(1 / 60, SILENCE, null);
    // Frame 2: source jumps to loud; with a 1s attack, one 16ms step stays low.
    const out = r.update(1 / 60, LOUD, null);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeLessThan(0.5); // nowhere near 1 yet
  });

  it('reset() clears smoothing so the next frame snaps again', () => {
    const r = createAudioRouter();
    r.setTable(tableWith([slot('bass', { attack: 1.0, decay: 1.0 })]));
    r.update(1 / 60, SILENCE, null);
    r.reset();
    // After reset, the first frame snaps to the (loud) target instead of easing.
    const out = r.update(1 / 60, LOUD, null);
    expect(out[0]).toBeGreaterThan(0.9);
  });
});

describe('AudioRouter — custom bands', () => {
  it('integrates RMS over the bins for a custom Hz window', () => {
    const r = createAudioRouter();
    r.setSampleRate(44100);
    r.setTable({
      slots: [
        { source: 'band:mids', shape: slot('energy').shape },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      customBands: [{ id: 'mids', label: 'mids', loHz: 1000, hiHz: 3000, normalize: false }],
    });
    // 1024-bin spectrum, energy concentrated in the mid band.
    const spectrum = new Float32Array(1024);
    // bin for 1kHz..3kHz at sr=44100, 1024 bins over 22050Hz nyquist
    const nyquist = 22050;
    const loBin = Math.round((1000 / nyquist) * 1024);
    const hiBin = Math.round((3000 / nyquist) * 1024);
    for (let i = loBin; i <= hiBin; i++) spectrum[i] = 1.0;
    const out = r.update(1 / 60, SILENCE, spectrum);
    expect(out[0]).toBeGreaterThan(0.5);
  });

  it('band edges clamp to Nyquist (a supra-Nyquist window does not throw / read OOB)', () => {
    const r = createAudioRouter();
    r.setSampleRate(44100);
    r.setTable({
      slots: [
        { source: 'band:air', shape: slot('energy').shape },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      customBands: [{ id: 'air', label: 'air', loHz: 20000, hiHz: 999999, normalize: false }],
    });
    const spectrum = new Float32Array(1024).fill(0.2);
    expect(() => r.update(1 / 60, SILENCE, spectrum)).not.toThrow();
    const out = r.update(1 / 60, SILENCE, spectrum);
    expect(Number.isFinite(out[0])).toBe(true);
  });

  it('a custom band with no spectrum resolves to 0', () => {
    const r = createAudioRouter();
    r.setTable({
      slots: [
        { source: 'band:x', shape: slot('energy').shape },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      customBands: [{ id: 'x', label: 'x', loHz: 100, hiHz: 200, normalize: false }],
    });
    const out = r.update(1 / 60, LOUD, null);
    expect(out[0]).toBe(0);
  });
});

describe('AudioRouter — beat source', () => {
  it('fires a beat pulse from a bass transient and shares it across slots', () => {
    const r = createAudioRouter();
    r.setTable(tableWith([slot('beat'), slot('beat')]));
    // The detector's adaptive average updates before the threshold check. Build a
    // LOW steady average from a modest sustained level, then a spike well above
    // 2x that average registers as an onset.
    for (let i = 0; i < 60; i++) r.update(1 / 60, { ...SILENCE, bass: 0.1 }, null);
    let out = r.update(1 / 60, { ...SILENCE, bass: 1.0 }, null);
    // The shared detector fired: both beat slots read the same value.
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeCloseTo(out[1], 5);

    // And it decays over subsequent silent frames (not stuck on).
    const fired = out[0];
    for (let i = 0; i < 20; i++) out = r.update(1 / 60, { ...SILENCE, bass: 0.0 }, null);
    expect(out[0]).toBeLessThan(fired);
  });
});

describe('ShaderSlotDriver — export byte-spectrum path (Stage 2)', () => {
  it('resolves a custom band from a pre-computed byte spectrum (no analyser)', async () => {
    const { ShaderSlotDriver } = await import('./AudioRouter');
    const driver = new ShaderSlotDriver();
    driver.setTable({
      slots: [
        { source: 'band:mids', shape: slot('energy').shape },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      customBands: [{ id: 'mids', label: 'mids', loHz: 1000, hiHz: 3000, normalize: false }],
    });
    // 512-bin byte spectrum (0-255), energy concentrated in the 1-3kHz window.
    const sampleRate = 44100;
    const bins = 512;
    const nyquist = sampleRate / 2;
    const bytes = new Uint8Array(bins);
    const loBin = Math.round((1000 / nyquist) * bins);
    const hiBin = Math.round((3000 / nyquist) * bins);
    for (let i = loBin; i <= hiBin; i++) bytes[i] = 255;
    const out = driver.updateFromBytes(1 / 60, SILENCE, bytes, sampleRate);
    expect(out[0]).toBeGreaterThan(0.5);
  });

  it('a custom band with no export spectrum resolves to 0', async () => {
    const { ShaderSlotDriver } = await import('./AudioRouter');
    const driver = new ShaderSlotDriver();
    driver.setTable({
      slots: [
        { source: 'band:x', shape: slot('energy').shape },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      customBands: [{ id: 'x', label: 'x', loHz: 100, hiHz: 200, normalize: false }],
    });
    const out = driver.updateFromBytes(1 / 60, SILENCE, null, 44100);
    expect(out[0]).toBe(0);
  });
});

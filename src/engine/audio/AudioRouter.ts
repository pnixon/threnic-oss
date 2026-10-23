/**
 * AudioRouter (Stage 1 — Audio router)
 *
 * Resolves an AudioRoutingTable into a packed Float32Array(8) each frame — one
 * value per shader slot (u_value1()..u_value8()). Each slot runs its own
 * attack/decay envelope through the shipped `createARParam()` so response
 * shaping is identical to every other audio-reactive control in the app.
 *
 * Platform-agnostic in the same sense as `arParam.ts`: no React, no Three.js,
 * no audioStore imports. The export path constructs it too.
 *
 * Sources:
 *   - bass/mid/high/energy → straight from AudioBands
 *   - beat                 → shared onset envelope (lifted from ShaderOverlayPass)
 *   - band:<id>            → RMS over FFT bins [loHz..hiHz], optional peak-normalised
 */

import { createARParam, type ARParamEnvelope, type AudioBands } from './arParam';
import type { AudioReactiveConfig } from '@/types/effects/audio-reactive';
import {
  AUDIO_ROUTING_SLOT_COUNT,
  DEFAULT_AUDIO_ROUTING,
  customBandId,
  type AudioRoutingTable,
  type AudioSourceId,
  type CustomBandDef,
} from '@/types/effects/audio-routing';

export interface AudioRouter {
  /** Resolve all eight slots for this frame. Returns a reused buffer (do not mutate). */
  update(dt: number, bands: AudioBands, spectrum: Float32Array | null): Float32Array;
  setTable(table: AudioRoutingTable): void;
  /** Sample rate is needed to map Hz -> FFT bin for custom bands. */
  setSampleRate(hz: number): void;
  /** Peak-normalisation reference for custom bands (per-bin offline peaks). */
  setGlobalPeaks(peaks: Float32Array | null): void;
  reset(): void; // on seek — mirrors ARParamEnvelope.reset()
}

/**
 * Shared onset/beat envelope. Derived from ShaderOverlayPass's bass-triggered
 * detector, but with a fixed SLOW bass-average window (decoupled from any
 * per-slot attack/decay) so it actually lags transients and fires. Every
 * consumer shares one detector instead of each pass running its own.
 * Rising-bass edge past an adaptive threshold fires a decaying [0,1] pulse.
 */
class BeatDetector {
  private bassAvg = 0;
  private beatValue = 0;
  private beatCooldown = 0;

  reset(): void {
    this.bassAvg = 0;
    this.beatValue = 0;
    this.beatCooldown = 0;
  }

  update(dt: number, bass: number): number {
    // Adaptive bass average. Uses a fixed SLOW window (not the per-slot
    // attack/decay) so it lags real transients — otherwise a fast average tracks
    // the spike within one frame and the `bass > 2*avg` onset test never fires.
    // Rising edges track a touch faster than falling so the average recovers.
    const avgTau = bass > this.bassAvg ? 0.15 : 0.4;
    const factor = 1 - Math.exp(-dt / avgTau);
    this.bassAvg += (bass - this.bassAvg) * factor;

    this.beatCooldown -= dt;
    const thresh = this.bassAvg * 2.0;
    if (bass > thresh && bass > 0.05 && this.beatCooldown <= 0) {
      this.beatValue = 1;
      this.beatCooldown = 0.12;
    }

    if (dt > 0) {
      const beatDecayTime = 0.35;
      this.beatValue *= Math.pow(0.001, dt / beatDecayTime);
    }

    return this.beatValue;
  }

  peek(): number {
    return this.beatValue;
  }
}

class AudioRouterImpl implements AudioRouter {
  private table: AudioRoutingTable = DEFAULT_AUDIO_ROUTING;
  private envelopes: ARParamEnvelope[] = [];
  private beat = new BeatDetector();
  private out = new Float32Array(AUDIO_ROUTING_SLOT_COUNT);
  private sampleRate = 44100;
  private fftSize = 2048; // updated from spectrum length each frame
  private globalPeaks: Float32Array | null = null;

  constructor() {
    for (let i = 0; i < AUDIO_ROUTING_SLOT_COUNT; i++) {
      this.envelopes.push(createARParam());
    }
  }

  setTable(table: AudioRoutingTable): void {
    this.table = table;
  }

  setSampleRate(hz: number): void {
    if (Number.isFinite(hz) && hz > 0) this.sampleRate = hz;
  }

  setGlobalPeaks(peaks: Float32Array | null): void {
    this.globalPeaks = peaks;
  }

  reset(): void {
    this.beat.reset();
    for (const env of this.envelopes) env.reset();
  }

  /** Map a frequency (Hz) to an FFT bin index, clamped to [0, binCount-1]. */
  private frequencyToBin(hz: number, binCount: number): number {
    // bins span [0, sampleRate/2] across binCount bins → resolution = (sr/2)/binCount
    const nyquist = this.sampleRate / 2;
    if (nyquist <= 0 || binCount <= 0) return 0;
    const bin = Math.round((hz / nyquist) * binCount);
    return Math.max(0, Math.min(binCount - 1, bin));
  }

  /** Integrate RMS over the bins covered by a custom band, optionally peak-normalised. */
  private customBandValue(def: CustomBandDef, spectrum: Float32Array | null): number {
    if (!spectrum || spectrum.length === 0) return 0;
    const binCount = spectrum.length;
    const lo = this.frequencyToBin(Math.min(def.loHz, def.hiHz), binCount);
    const hi = this.frequencyToBin(Math.max(def.loHz, def.hiHz), binCount);
    const from = Math.min(lo, hi);
    const to = Math.max(lo, hi);

    let sumSq = 0;
    let peakSumSq = 0;
    let n = 0;
    for (let i = from; i <= to; i++) {
      const v = spectrum[i] ?? 0;
      sumSq += v * v;
      n++;
      if (def.normalize && this.globalPeaks) {
        const p = this.globalPeaks[i] ?? 0;
        peakSumSq += p * p;
      }
    }
    if (n === 0) return 0;
    const rms = Math.sqrt(sumSq / n);

    if (def.normalize) {
      if (this.globalPeaks) {
        const peakRms = Math.sqrt(peakSumSq / n);
        return peakRms > 1e-6 ? Math.max(0, Math.min(1, rms / peakRms)) : 0;
      }
      // No peaks yet: pass raw RMS through clamped so the control isn't dead.
      return Math.max(0, Math.min(1, rms));
    }
    return Math.max(0, Math.min(1, rms));
  }

  private rawSourceValue(
    source: AudioSourceId,
    bands: AudioBands,
    spectrum: Float32Array | null,
  ): number {
    switch (source) {
      case 'bass':
        return bands.bass;
      case 'mid':
        return bands.mid;
      case 'high':
        return bands.high;
      case 'energy':
        return bands.energy;
      case 'beat':
        return this.beat.peek();
      default: {
        const id = customBandId(source);
        if (id == null) return 0;
        const def = this.table.customBands.find((b) => b.id === id);
        return def ? this.customBandValue(def, spectrum) : 0;
      }
    }
  }

  update(dt: number, bands: AudioBands, spectrum: Float32Array | null): Float32Array {
    if (spectrum && spectrum.length > 0) this.fftSize = spectrum.length * 2;

    // Beat detector advances once per frame, shared by all slots referencing 'beat'.
    this.beat.update(dt, bands.bass);

    const slots = this.table.slots;
    for (let i = 0; i < AUDIO_ROUTING_SLOT_COUNT; i++) {
      const routing = slots[i] ?? null;
      if (!routing) {
        this.out[i] = 0;
        this.envelopes[i].reset(); // keep an unrouted slot's envelope clean
        continue;
      }

      const raw = this.rawSourceValue(routing.source, bands, spectrum);

      // Reuse the shipped envelope: shape [0,1] output from the raw source.
      // We drive `energy` in a synthetic bands snapshot so the shipped curve +
      // attack/decay apply regardless of which source (incl. custom band) fed it.
      const shape: AudioReactiveConfig = {
        ...routing.shape,
        band: 'energy',
        min: 0,
        max: 1,
        enabled: true,
      };
      const synthetic: AudioBands = { energy: raw, bass: raw, mid: raw, high: raw };
      this.out[i] = this.envelopes[i].compute(0, shape, dt, synthetic);
    }

    return this.out;
  }
}

export function createAudioRouter(): AudioRouter {
  return new AudioRouterImpl();
}

/**
 * Per-renderer driver that owns the byte-frequency scratch buffer and keeps the
 * router's table in sync with the current config. Both WebGPURenderer and
 * OffscreenGPURenderer call this identically, so slot resolution can't drift
 * between preview and export (the §7 parity concern).
 */
export class ShaderSlotDriver {
  private router: AudioRouter = createAudioRouter();
  private freqBytes: Uint8Array<ArrayBuffer> | null = null;
  private freqFloats: Float32Array | null = null;
  private lastTable: import('@/types/effects/audio-routing').AudioRoutingTable | null = null;

  /** Update the routing table (idempotent — only re-sets on reference change). */
  setTable(table: import('@/types/effects/audio-routing').AudioRoutingTable | null): void {
    if (table === this.lastTable) return;
    this.lastTable = table ?? null;
    this.router.setTable(table ?? DEFAULT_AUDIO_ROUTING);
  }

  reset(): void {
    this.router.reset();
  }

  /**
   * Resolve the eight slot values for this frame. Pulls a byte spectrum from the
   * analyser (for custom bands), normalises to [0,1], and runs the envelopes.
   * Returns null when no table is routed (caller passes null slots → zeros).
   */
  update(dt: number, bands: AudioBands, analyser: AnalyserNode | null | undefined): Float32Array {
    let spectrum: Float32Array | null = null;
    if (analyser) {
      const bins = analyser.frequencyBinCount;
      if (!this.freqBytes || this.freqBytes.length !== bins) {
        this.freqBytes = new Uint8Array(new ArrayBuffer(bins));
        this.freqFloats = new Float32Array(bins);
      }
      analyser.getByteFrequencyData(this.freqBytes);
      const floats = this.freqFloats!;
      for (let i = 0; i < bins; i++) floats[i] = this.freqBytes[i] / 255;
      spectrum = floats;
      this.router.setSampleRate(analyser.context.sampleRate);
    }
    return this.router.update(dt, bands, spectrum);
  }

  /**
   * Export variant: resolve slots from a PRE-COMPUTED byte-frequency spectrum
   * (0-255 per bin, the same format getByteFrequencyData produces) rather than a
   * live AnalyserNode. The offline exporter's AudioAnalyzer produces exactly this
   * per frame, so custom-band sources resolve to real values in export too — not
   * the 0 they got before. Pass a null/empty spectrum to fall back to bands-only.
   */
  updateFromBytes(
    dt: number,
    bands: AudioBands,
    byteFreq: Uint8Array | null | undefined,
    sampleRate: number,
  ): Float32Array {
    let spectrum: Float32Array | null = null;
    if (byteFreq && byteFreq.length > 0) {
      const bins = byteFreq.length;
      if (!this.freqFloats || this.freqFloats.length !== bins) {
        this.freqFloats = new Float32Array(bins);
      }
      const floats = this.freqFloats;
      for (let i = 0; i < bins; i++) floats[i] = byteFreq[i] / 255;
      spectrum = floats;
      this.router.setSampleRate(sampleRate);
    }
    return this.router.update(dt, bands, spectrum);
  }
}

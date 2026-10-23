/**
 * AudioTable — the whole track's audio, precomputed once, indexed by frame.
 *
 * This is the single decision that makes the engine deterministic: the track is
 * decoded offline, FFT'd at the render framerate, and flattened into a fixed
 * array. Preview and export read the same rows, so a stuttering preview and a
 * clean export of the same frame index see identical audio. No AnalyserNode,
 * no live graph, no wall clock.
 *
 * Band semantics follow Milkdrop rather than the legacy overlay: values are
 * relative to a rolling long-window average, so ~1.0 means "average loudness
 * for this track" and presets written against Milkdrop's bass behave.
 */

import { AudioAnalyzer } from '../../export/AudioAnalyzer';
import type { AudioFrame, AudioTableLike } from './types';

// Fields per row, in packing order.
const F_BASS = 0;
const F_MID = 1;
const F_TREB = 2;
const F_VOL = 3;
const F_BASS_ATT = 4;
const F_MID_ATT = 5;
const F_TREB_ATT = 6;
const F_VOL_ATT = 7;
const F_BEAT = 8;
const F_BEAT_COUNTER = 9;
const STRIDE = 10;

interface PcmSource {
  /** Mono (or first-channel) PCM in -1..1 */
  channelData: Float32Array;
  sampleRate: number;
}

interface AudioTableOptions {
  /** Render framerate. Must match the FrameClock exactly. */
  fps: number;
  fftSize?: number;
  /** Follower rise time, in frames, for the attenuated values. Default 0.15s worth. */
  attackFrames?: number;
  /** Follower fall time, in frames. Default 0.45s worth. */
  decayFrames?: number;
  /** Window for the loudness normalizer, in frames. Default 3s worth. */
  normalizeFrames?: number;
  /** Set false to keep raw 0..1 bands instead of Milkdrop-relative ones. */
  normalize?: boolean;
  /**
   * Beat sensitivity, in standard deviations of the bass band above its
   * rolling mean. Lower fires more often. Default 1.2.
   */
  beatThreshold?: number;
  /** Window for the beat detector's mean and variance, in frames. Default 1.2s. */
  beatWindowFrames?: number;
  /** Minimum frames between beats. Default 0.12s worth. */
  beatCooldownFrames?: number;
  /** Frames for the beat pulse to decay to ~0. Default 0.25s worth. */
  beatDecayFrames?: number;
  /** Called with 0..1 during long builds. */
  onProgress?: (progress: number) => void;
}

/** Exponential follower coefficient for a time constant expressed in frames. */
function coefficient(frames: number): number {
  return 1 - Math.exp(-1 / Math.max(1e-3, frames));
}

function isAudioBuffer(src: unknown): src is AudioBuffer {
  return (
    typeof src === 'object' &&
    src !== null &&
    typeof (src as AudioBuffer).getChannelData === 'function'
  );
}

export class AudioTable implements AudioTableLike {
  readonly fps: number;
  readonly frameCount: number;
  readonly sampleRate: number;

  private readonly rows: Float32Array;
  private readonly pcm: Float32Array;
  /** Scratch returned by waveform() — callers must copy if they retain it. */
  private waveScratch = new Float32Array(0);

  private constructor(
    rows: Float32Array,
    frameCount: number,
    fps: number,
    pcm: Float32Array,
    sampleRate: number,
  ) {
    this.rows = rows;
    this.frameCount = frameCount;
    this.fps = fps;
    this.pcm = pcm;
    this.sampleRate = sampleRate;
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /**
   * Runs the FFT once per frame and derives followers and beats sequentially.
   * Yields to the event loop periodically so a long track does not freeze the UI.
   */
  static async build(
    source: AudioBuffer | PcmSource,
    options: AudioTableOptions,
  ): Promise<AudioTable> {
    const { fps } = options;
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new Error('[AudioTable] fps must be a positive finite number, got ' + fps);
    }

    const channelData = isAudioBuffer(source) ? source.getChannelData(0) : source.channelData;
    const sampleRate = isAudioBuffer(source) ? source.sampleRate : source.sampleRate;
    const duration = channelData.length / sampleRate;
    const frameCount = Math.max(1, Math.ceil(duration * fps));

    const fftSize = options.fftSize ?? 2048;
    const normalize = options.normalize !== false;
    const attackK = coefficient(options.attackFrames ?? 0.15 * fps);
    const decayK = coefficient(options.decayFrames ?? 0.45 * fps);
    const normK = coefficient(options.normalizeFrames ?? 3 * fps);
    const beatThreshold = options.beatThreshold ?? 1.2;
    const beatWindowK = coefficient(options.beatWindowFrames ?? 1.2 * fps);
    const beatCooldown = Math.max(1, Math.round(options.beatCooldownFrames ?? 0.12 * fps));
    const beatDecayK = Math.pow(0.001, 1 / Math.max(1, options.beatDecayFrames ?? 0.25 * fps));

    // smoothing: 0 — smoothing inside the analyzer would be a second, hidden
    // piece of frame-to-frame state living outside this table.
    const analyzer = new AudioAnalyzer({ fftSize, smoothing: 0 });
    const fftScratch = new Uint8Array(fftSize / 2);
    const timeScratch = new Uint8Array(fftSize);

    const rows = new Float32Array(frameCount * STRIDE);

    // Sequential state
    let bassAtt = 0;
    let midAtt = 0;
    let trebAtt = 0;
    let volAtt = 0;
    let bassNorm = 0;
    let midNorm = 0;
    let trebNorm = 0;
    let beat = 0;
    let beatCounter = 0;
    let cooldown = 0;
    // Beat detection runs against its own slow mean and variance rather than
    // the attenuated follower: a fast follower chases the transient it is
    // supposed to be detecting, which costs every beat after the first.
    let beatMean = 0;
    let beatVar = 0;

    for (let frame = 0; frame < frameCount; frame++) {
      const bands = analyzer.analyzeFrameInto(
        channelData,
        frame,
        fps,
        sampleRate,
        fftScratch,
        timeScratch,
      );

      let bass = bands.bass;
      let mid = bands.mid;
      let treb = bands.high;

      // Rolling loudness normalizer — Milkdrop-relative bands. Frame 0 primes
      // the averages instead of ramping up from silence: a warm-up transient
      // would fire a phantom beat and then suppress real ones while the
      // followers came back down.
      if (frame === 0) {
        bassNorm = bass;
        midNorm = mid;
        trebNorm = treb;
      }
      bassNorm += (bass - bassNorm) * normK;
      midNorm += (mid - midNorm) * normK;
      trebNorm += (treb - trebNorm) * normK;
      if (normalize) {
        bass = bass / Math.max(0.02, bassNorm);
        mid = mid / Math.max(0.02, midNorm);
        treb = treb / Math.max(0.02, trebNorm);
      }

      const vol = (bass + mid + treb) / 3;

      if (frame === 0) {
        bassAtt = bass;
        midAtt = mid;
        trebAtt = treb;
        volAtt = vol;
      }
      bassAtt += (bass - bassAtt) * (bass > bassAtt ? attackK : decayK);
      midAtt += (mid - midAtt) * (mid > midAtt ? attackK : decayK);
      trebAtt += (treb - trebAtt) * (treb > trebAtt ? attackK : decayK);
      volAtt += (vol - volAtt) * (vol > volAtt ? attackK : decayK);

      if (frame === 0) beatMean = bass;
      const excess = bass - beatMean;

      beat *= beatDecayK;
      cooldown -= 1;
      const sigma = Math.sqrt(Math.max(0, beatVar));
      if (cooldown <= 0 && bass > 0.1 && excess > Math.max(beatThreshold * sigma, 0.02)) {
        beat = 1;
        beatCounter += 1;
        cooldown = beatCooldown;
      }

      beatMean += excess * beatWindowK;
      beatVar += (excess * excess - beatVar) * beatWindowK;

      const o = frame * STRIDE;
      rows[o + F_BASS] = bass;
      rows[o + F_MID] = mid;
      rows[o + F_TREB] = treb;
      rows[o + F_VOL] = vol;
      rows[o + F_BASS_ATT] = bassAtt;
      rows[o + F_MID_ATT] = midAtt;
      rows[o + F_TREB_ATT] = trebAtt;
      rows[o + F_VOL_ATT] = volAtt;
      rows[o + F_BEAT] = beat;
      rows[o + F_BEAT_COUNTER] = beatCounter;

      if (frame % 500 === 499) {
        options.onProgress?.((frame + 1) / frameCount);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    options.onProgress?.(1);

    return new AudioTable(rows, frameCount, fps, channelData, sampleRate);
  }

  /** Silent table — used when a scene has no audio, and by tests. */
  static silent(fps: number, frameCount: number): AudioTable {
    const count = Math.max(1, Math.floor(frameCount));
    return new AudioTable(new Float32Array(count * STRIDE), count, fps, new Float32Array(0), 48000);
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  at(frame: number): AudioFrame {
    const f = Math.min(this.frameCount - 1, Math.max(0, Math.floor(frame)));
    const o = f * STRIDE;
    return {
      frame: f,
      bass: this.rows[o + F_BASS],
      mid: this.rows[o + F_MID],
      treb: this.rows[o + F_TREB],
      vol: this.rows[o + F_VOL],
      bassAtt: this.rows[o + F_BASS_ATT],
      midAtt: this.rows[o + F_MID_ATT],
      trebAtt: this.rows[o + F_TREB_ATT],
      volAtt: this.rows[o + F_VOL_ATT],
      beat: this.rows[o + F_BEAT],
      beatCounter: this.rows[o + F_BEAT_COUNTER],
    };
  }

  /**
   * Waveform window for a frame, decimated to `length` samples. Used by
   * custom-wave nodes; returns a reused scratch buffer, so copy to retain it.
   */
  waveform(frame: number, length: number): Float32Array {
    if (this.waveScratch.length !== length) this.waveScratch = new Float32Array(length);
    const out = this.waveScratch;
    if (this.pcm.length === 0) {
      out.fill(0);
      return out;
    }
    const samplesPerFrame = this.sampleRate / this.fps;
    const start = Math.floor(Math.max(0, frame) * samplesPerFrame);
    // Cover ~2 frames of audio so the wave does not look stroboscopic.
    const span = Math.max(length, Math.floor(samplesPerFrame * 2));
    const step = span / length;
    for (let i = 0; i < length; i++) {
      const idx = start + Math.floor(i * step);
      out[i] = idx < this.pcm.length ? this.pcm[idx] : 0;
    }
    return out;
  }

  /** Raw backing rows — for transferring a built table to a worker. */
  get raw(): Float32Array {
    return this.rows;
  }
}

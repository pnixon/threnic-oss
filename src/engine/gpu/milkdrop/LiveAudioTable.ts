/**
 * LiveAudioTable — real-time AudioTableLike for preview mode.
 *
 * Inspired by Butterchurn's approach: takes raw FFT frequency data directly
 * from the AnalyserNode each frame, computes bands without over-smoothing.
 *
 * Key difference from our old approach: NO intermediate audioStore smoothing.
 * The AnalyserNode's own smoothingTimeConstant (typically 0.8) provides the
 * only temporal smoothing. This gives the tight, responsive feel Butterchurn has.
 *
 * Band computation mimics Milkdrop's approach:
 * - Raw values normalized 0-1 from the byte frequency data
 * - Relative bands: divided by a rolling average so ~1.0 = "normal loudness"
 * - Attenuated: one-pole follower with ~0.5s time constant
 */

import type { AudioFrame, AudioTableLike } from './types';

interface LiveAudioInput {
  bass: number;
  mid: number;
  treb: number;
  energy: number;
}

export class LiveAudioTable implements AudioTableLike {
  readonly fps: number;
  readonly frameCount = Number.MAX_SAFE_INTEGER;

  private _bass = 0;
  private _mid = 0;
  private _treb = 0;
  private _vol = 0;
  private _bassAtt = 0;
  private _midAtt = 0;
  private _trebAtt = 0;
  private _volAtt = 0;
  private _beat = 0;
  private _beatCounter = 0;
  private _beatCooldown = 0;
  private _frame = 0;

  // For Milkdrop-relative normalization
  private _bassAvg = 0.5;
  private _midAvg = 0.5;
  private _trebAvg = 0.5;

  // For beat detection
  private _prevBassRaw = 0;

  constructor(fps = 60) {
    this.fps = fps;
  }

  /**
   * Feed raw FFT data directly from the AnalyserNode.
   * This is the Butterchurn-style path — minimal processing, maximum responsiveness.
   */
  pushFFT(fftData: Uint8Array, sampleRate: number): void {
    this._frame++;

    const binCount = fftData.length;
    const nyquist = sampleRate / 2;
    const binHz = nyquist / binCount;

    // Band boundaries (Hz)
    const bassEnd = Math.min(Math.floor(250 / binHz), binCount);
    const midEnd = Math.min(Math.floor(4000 / binHz), binCount);
    const trebEnd = Math.min(Math.floor(16000 / binHz), binCount);

    // Compute RMS for each band from raw byte data (0-255)
    let bassSum = 0,
      bassCount = 0;
    for (let i = 1; i < bassEnd; i++) {
      bassSum += fftData[i] * fftData[i];
      bassCount++;
    }

    let midSum = 0,
      midCount = 0;
    for (let i = bassEnd; i < midEnd; i++) {
      midSum += fftData[i] * fftData[i];
      midCount++;
    }

    let trebSum = 0,
      trebCount = 0;
    for (let i = midEnd; i < trebEnd; i++) {
      trebSum += fftData[i] * fftData[i];
      trebCount++;
    }

    const bassRaw = bassCount > 0 ? Math.sqrt(bassSum / bassCount) / 255 : 0;
    const midRaw = midCount > 0 ? Math.sqrt(midSum / midCount) / 255 : 0;
    const trebRaw = trebCount > 0 ? Math.sqrt(trebSum / trebCount) / 255 : 0;

    // Update rolling averages for Milkdrop-relative normalization
    const avgAlpha = 0.005; // very slow — adapts over ~3 seconds
    this._bassAvg = this._bassAvg * (1 - avgAlpha) + bassRaw * avgAlpha + 0.001;
    this._midAvg = this._midAvg * (1 - avgAlpha) + midRaw * avgAlpha + 0.001;
    this._trebAvg = this._trebAvg * (1 - avgAlpha) + trebRaw * avgAlpha + 0.001;

    // Milkdrop-relative: ~1.0 means average loudness, >1 means above average
    this._bass = bassRaw / this._bassAvg;
    this._mid = midRaw / this._midAvg;
    this._treb = trebRaw / this._trebAvg;
    this._vol = (this._bass + this._mid + this._treb) / 3;

    // Attenuated followers — Milkdrop's _att variables
    // Rise immediately, decay with ~0.5s time constant
    const attDecay = 1 - Math.exp(-(1 / this.fps) / 0.5);
    this._bassAtt = Math.max(
      this._bass,
      this._bassAtt - attDecay * this._bassAtt + attDecay * this._bass,
    );
    this._midAtt = Math.max(
      this._mid,
      this._midAtt - attDecay * this._midAtt + attDecay * this._mid,
    );
    this._trebAtt = Math.max(
      this._treb,
      this._trebAtt - attDecay * this._trebAtt + attDecay * this._treb,
    );
    this._volAtt = (this._bassAtt + this._midAtt + this._trebAtt) / 3;

    // Beat detection — sharp bass transient
    if (this._beatCooldown > 0) this._beatCooldown--;
    const bassRise = bassRaw - this._prevBassRaw;
    if (bassRise > 0.08 && this._bass > 1.4 && this._beatCooldown === 0) {
      this._beat = 1.0;
      this._beatCounter++;
      this._beatCooldown = Math.round(this.fps * 0.2);
    } else {
      this._beat = Math.max(0, this._beat * 0.88); // smooth exponential decay
    }
    this._prevBassRaw = bassRaw;
  }

  /**
   * Fallback: feed pre-computed band values (from audioStore).
   * Used when direct FFT access isn't available.
   */
  push(input: LiveAudioInput): void {
    this._frame++;

    // Treat pre-smoothed values as raw (they're already 0-1)
    // Scale up to Milkdrop-relative range (~1.0 = average)
    this._bass = input.bass * 2;
    this._mid = input.mid * 2;
    this._treb = input.treb * 2;
    this._vol = (this._bass + this._mid + this._treb) / 3;

    const attDecay = 1 - Math.exp(-(1 / this.fps) / 0.5);
    this._bassAtt = Math.max(this._bass, this._bassAtt + attDecay * (this._bass - this._bassAtt));
    this._midAtt = Math.max(this._mid, this._midAtt + attDecay * (this._mid - this._midAtt));
    this._trebAtt = Math.max(this._treb, this._trebAtt + attDecay * (this._treb - this._trebAtt));
    this._volAtt = (this._bassAtt + this._midAtt + this._trebAtt) / 3;

    // Beat detection from pre-smoothed
    if (this._beatCooldown > 0) this._beatCooldown--;
    if (input.bass > 0.6 && this._bass > 1.5 && this._beatCooldown === 0) {
      this._beat = 1.0;
      this._beatCounter++;
      this._beatCooldown = Math.round(this.fps * 0.2);
    } else {
      this._beat = Math.max(0, this._beat * 0.88);
    }
  }

  at(): AudioFrame {
    return {
      frame: this._frame,
      bass: this._bass,
      mid: this._mid,
      treb: this._treb,
      vol: this._vol,
      bassAtt: this._bassAtt,
      midAtt: this._midAtt,
      trebAtt: this._trebAtt,
      volAtt: this._volAtt,
      beat: this._beat,
      beatCounter: this._beatCounter,
    };
  }

  waveform(_frame: number, length: number): Float32Array {
    return new Float32Array(length);
  }

  reset(): void {
    this._frame = 0;
    this._bass = this._mid = this._treb = this._vol = 0;
    this._bassAtt = this._midAtt = this._trebAtt = this._volAtt = 0;
    this._beat = 0;
    this._beatCounter = 0;
    this._beatCooldown = 0;
    this._prevBassRaw = 0;
    this._bassAvg = 0.5;
    this._midAvg = 0.5;
    this._trebAvg = 0.5;
  }
}

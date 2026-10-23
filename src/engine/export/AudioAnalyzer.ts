import { magnitudeToDecibel } from '../audio/AudioConfig';
import { processBandsRMS } from '../audio/AudioProcessor';

/**
 * AudioAnalyzer - Pre-computes FFT data for each frame of video export
 *
 * Uses an optimized radix-2 Cooley-Tukey FFT algorithm for fast analysis.
 * Generates normalized bass/mid/high values for audio-reactive effects.
 */

interface AudioFrameData {
  /** Bass intensity (0-1) */
  bass: number;
  /** Mid intensity (0-1) */
  mid: number;
  /** High intensity (0-1) */
  high: number;
  /** Raw FFT data (optional, for advanced effects) */
  raw?: Uint8Array;
  /** Raw Time Domain data (waveform) for visualizers */
  rawTimeDomain?: Uint8Array;
}

interface AudioAnalyzerOptions {
  /** FFT size (must be power of 2, default 2048) */
  fftSize?: number;
  /** Smoothing time constant (0-1, default 0.3) */
  smoothing?: number;
}

/**
 * Analyzes audio and generates per-frame FFT data
 */
export class AudioAnalyzer {
  private fftSize: number;
  private smoothing: number;

  // Pre-computed values for FFT
  private cosTable: Float32Array;
  private sinTable: Float32Array;
  private hanningWindow: Float32Array;
  private bitReversal: Uint32Array;

  // Reusable buffers to avoid GC pressure
  private real: Float32Array;
  private imag: Float32Array;
  private samples: Float32Array;
  private rawFFT: Uint8Array;
  private rawTimeDomain: Uint8Array;

  constructor(options: AudioAnalyzerOptions = {}) {
    this.fftSize = options.fftSize ?? 2048;
    this.smoothing = options.smoothing ?? 0.3;

    // Pre-compute twiddle factors
    const N = this.fftSize;
    this.cosTable = new Float32Array(N / 2);
    this.sinTable = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) {
      const angle = (2 * Math.PI * i) / N;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    // Pre-compute Hanning window
    this.hanningWindow = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.hanningWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    // Pre-compute bit reversal indices
    this.bitReversal = new Uint32Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) {
      let reversed = 0;
      for (let j = 0; j < bits; j++) {
        reversed = (reversed << 1) | ((i >> j) & 1);
      }
      this.bitReversal[i] = reversed;
    }

    // Initialize reusable buffers
    this.real = new Float32Array(N);
    this.imag = new Float32Array(N);
    this.samples = new Float32Array(N);
    this.rawFFT = new Uint8Array(N / 2);
    this.rawTimeDomain = new Uint8Array(N);
  }

  /**
   * Analyze a single frame of audio
   * @param channelData - Mono audio channel data
   * @param frame - Current frame number
   * @param fps - Frames per second
   * @param sampleRate - Audio sample rate
   * @returns AudioFrameData for the requested frame
   */
  analyzeFrame(
    channelData: Float32Array,
    frame: number,
    fps: number,
    sampleRate: number,
  ): AudioFrameData {
    const samplesPerFrame = sampleRate / fps;
    const startSample = Math.floor(frame * samplesPerFrame);
    const endSample = Math.min(startSample + this.fftSize, channelData.length);
    const windowSize = endSample - startSample;

    // Extract and window samples
    this.samples.fill(0);
    for (let i = 0; i < windowSize; i++) {
      this.samples[i] = channelData[startSample + i] * this.hanningWindow[i];
    }

    // Compute FFT
    this.fft(this.samples, this.real, this.imag);

    // Generate raw FFT magnitude data (0-255 scale, matching Web Audio API)
    for (let i = 0; i < this.fftSize / 2; i++) {
      const magnitude = Math.sqrt(this.real[i] * this.real[i] + this.imag[i] * this.imag[i]);
      const normalizedMagnitude = magnitude / this.fftSize;
      this.rawFFT[i] = magnitudeToDecibel(normalizedMagnitude);
    }

    // Generate time domain data (waveform)
    for (let i = 0; i < this.fftSize; i++) {
      const rawSample = startSample + i < channelData.length ? channelData[startSample + i] : 0;
      this.rawTimeDomain[i] = Math.min(255, Math.max(0, 128 + rawSample * 128));
    }

    const bands = processBandsRMS(this.rawFFT, sampleRate);

    return {
      bass: bands.bass,
      mid: bands.mid,
      high: bands.high,
      // Return copies of the buffers since they are reused
      raw: new Uint8Array(this.rawFFT),
      rawTimeDomain: new Uint8Array(this.rawTimeDomain),
    };
  }

  /**
   * Zero-copy variant: writes FFT and time-domain data directly into the
   * provided destination buffers instead of allocating new Uint8Arrays.
   * Avoids 2× Uint8Array allocations per frame (~4KB at fftSize=2048).
   */
  analyzeFrameInto(
    channelData: Float32Array,
    frame: number,
    fps: number,
    sampleRate: number,
    destFFT: Uint8Array,
    destTimeDomain: Uint8Array,
  ): { bass: number; mid: number; high: number } {
    const samplesPerFrame = sampleRate / fps;
    const startSample = Math.floor(frame * samplesPerFrame);
    const endSample = Math.min(startSample + this.fftSize, channelData.length);
    const windowSize = endSample - startSample;

    // Extract and window samples
    this.samples.fill(0);
    for (let i = 0; i < windowSize; i++) {
      this.samples[i] = channelData[startSample + i] * this.hanningWindow[i];
    }

    // Compute FFT
    this.fft(this.samples, this.real, this.imag);

    // Write raw FFT magnitude data directly to destination
    const fftLen = Math.min(this.fftSize / 2, destFFT.length);
    for (let i = 0; i < fftLen; i++) {
      const magnitude = Math.sqrt(this.real[i] * this.real[i] + this.imag[i] * this.imag[i]);
      const normalizedMagnitude = magnitude / this.fftSize;
      this.rawFFT[i] = magnitudeToDecibel(normalizedMagnitude);
      destFFT[i] = this.rawFFT[i];
    }

    // Write time domain data directly to destination
    const tdLen = Math.min(this.fftSize, destTimeDomain.length);
    for (let i = 0; i < tdLen; i++) {
      const rawSample = startSample + i < channelData.length ? channelData[startSample + i] : 0;
      destTimeDomain[i] = Math.min(255, Math.max(0, 128 + rawSample * 128));
    }

    return processBandsRMS(this.rawFFT, sampleRate);
  }

  /**
   * Legacy method for bulk analysis (use with caution for long tracks)
   */
  async analyze(audioBuffer: AudioBuffer, fps: number): Promise<AudioFrameData[]> {
    const duration = audioBuffer.duration;
    const totalFrames = Math.ceil(duration * fps);
    const frameData: AudioFrameData[] = new Array(totalFrames);
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;

    for (let frame = 0; frame < totalFrames; frame++) {
      frameData[frame] = this.analyzeFrame(channelData, frame, fps, sampleRate);
      if (frame % 500 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    return frameData;
  }

  /**
   * Radix-2 Cooley-Tukey FFT (in-place, decimation-in-time)
   */
  private fft(input: Float32Array, real: Float32Array, imag: Float32Array): void {
    const N = this.fftSize;

    // Bit-reversal permutation
    for (let i = 0; i < N; i++) {
      real[this.bitReversal[i]] = input[i];
    }
    imag.fill(0);

    // Cooley-Tukey iterative FFT
    for (let size = 2; size <= N; size *= 2) {
      const halfSize = size / 2;
      const tableStep = N / size;

      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const k = j * tableStep;
          const cos = this.cosTable[k];
          const sin = this.sinTable[k];

          const evenIdx = i + j;
          const oddIdx = i + j + halfSize;

          const tReal = cos * real[oddIdx] + sin * imag[oddIdx];
          const tImag = cos * imag[oddIdx] - sin * real[oddIdx];

          real[oddIdx] = real[evenIdx] - tReal;
          imag[oddIdx] = imag[evenIdx] - tImag;
          real[evenIdx] = real[evenIdx] + tReal;
          imag[evenIdx] = imag[evenIdx] + tImag;
        }
      }
    }
  }
}

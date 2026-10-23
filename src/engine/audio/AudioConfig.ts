/**
 * Shared Audio Analysis Configuration
 *
 * This configuration is used by both:
 * - AudioManager (real-time Web Audio API analysis)
 * - AudioAnalyzer (offline FFT analysis for export)
 *
 * Keeping these values centralized ensures consistent behavior
 * between preview and export modes.
 */

export const AUDIO_CONFIG = {
  /** FFT size (must be power of 2) */
  fftSize: 2048,

  /** Number of frequency bins (fftSize / 2) */
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  },

  /**
   * Smoothing time constant for real-time analysis (0-1)
   * Professional audio programs use 0.0-0.3 for responsive metering
   * Previous value of 0.8 was too aggressive and caused lag
   */
  smoothingTimeConstant: 0.3,

  /**
   * Per-band lerp smoothing factors for real-time updates
   * Different bands need different smoothing characteristics:
   * - Bass: Can be slower (low frequencies change gradually)
   * - Mid: Moderate smoothing
   * - High: Needs fast response (transients, cymbals)
   */
  realtimeSmoothingFactor: {
    bass: 0.2, // 20% lerp - slower for bass
    mid: 0.15, // 15% lerp - moderate
    high: 0.1, // 10% lerp - faster for high frequencies
  },

  /**
   * Decibel range for FFT magnitude to byte conversion
   *
   * Web Audio API's getByteFrequencyData() uses this formula:
   * byte = 255 * (dB - minDecibels) / (maxDecibels - minDecibels)
   *
   * These defaults match AnalyserNode's default values.
   * @see https://webaudio.github.io/web-audio-api/#dom-analysernode-mindecibels
   */
  decibels: {
    min: -100, // AnalyserNode.minDecibels default
    max: -30, // AnalyserNode.maxDecibels default
  },

  /**
   * Frequency band boundaries (in Hz)
   */
  bands: {
    bass: { min: 20, max: 250 }, // Bass: kick drums, low frequencies
    mid: { min: 250, max: 4000 }, // Mid: vocals, most instruments
    high: { min: 4000, max: 14000 }, // High: cymbals, hi-hats, treble
  },

  /**
   * Pink Noise Compensation Factors
   *
   * Natural audio has more energy in lower frequencies (pink noise).
   * We boost mids and highs to create perceived balance across bands.
   */
  pinkNoiseCompensation: {
    bass: 1.0, // No boost needed
    mid: 1.5, // 50% boost
    high: 2.5, // 150% boost
  },

  /**
   * Energy calculation weights
   * Weighted mix favoring bass for rhythmic punch
   */
  energyWeights: {
    bass: 0.6, // 60% contribution
    mid: 0.3, // 30% contribution
    high: 0.1, // 10% contribution
  },
} as const;

/**
 * Calculate frequency bin indices for a given sample rate
 */
export function getBinIndices(sampleRate: number) {
  const binWidth = sampleRate / AUDIO_CONFIG.fftSize;

  return {
    bassStart: Math.floor(AUDIO_CONFIG.bands.bass.min / binWidth),
    bassEnd: Math.floor(AUDIO_CONFIG.bands.bass.max / binWidth),
    midStart: Math.floor(AUDIO_CONFIG.bands.mid.min / binWidth),
    midEnd: Math.floor(AUDIO_CONFIG.bands.mid.max / binWidth),
    highStart: Math.floor(AUDIO_CONFIG.bands.high.min / binWidth),
    highEnd: Math.min(
      Math.floor(AUDIO_CONFIG.bands.high.max / binWidth),
      AUDIO_CONFIG.frequencyBinCount,
    ),
  };
}

/**
 * Convert FFT magnitude to dB-scaled byte value (0-255)
 *
 * This replicates Web Audio API's getByteFrequencyData() behavior
 * for consistent audio analysis between real-time and export modes.
 *
 * @param magnitude - Raw FFT magnitude value (from sqrt(real² + imag²))
 * @returns Byte value (0-255) matching Web Audio API output
 */
export function magnitudeToDecibel(magnitude: number): number {
  // Convert to dB (add tiny value to avoid log(0))
  const dB = 20 * Math.log10(magnitude + 1e-10);

  // Normalize to 0-1 range using the configured dB range
  const { min: minDecibels, max: maxDecibels } = AUDIO_CONFIG.decibels;
  const normalized = (dB - minDecibels) / (maxDecibels - minDecibels);

  // Clamp and convert to 0-255 byte range
  return Math.max(0, Math.min(255, Math.floor(normalized * 255)));
}

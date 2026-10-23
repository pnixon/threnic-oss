/**
 * Shared Audio Processing Utilities
 *
 * Provides consistent audio frequency band calculations
 * for both real-time (AudioManager) and offline (AudioAnalyzer) analysis.
 */

import { AUDIO_CONFIG, getBinIndices } from './AudioConfig';

interface BandValues {
  bass: number;
  mid: number;
  high: number;
  energy: number;
}

/**
 * Calculate RMS (Root Mean Square) for a band - measures sustained energy
 * RMS is used in professional audio for more perceptually accurate level measurement
 *
 * @param fftData - Uint8Array of frequency magnitudes (0-255 range)
 * @param startBin - Starting frequency bin index
 * @param endBin - Ending frequency bin index
 * @returns RMS value (0-1 range)
 */
export function calculateBandRMS(fftData: Uint8Array, startBin: number, endBin: number): number {
  let sumOfSquares = 0;
  const binCount = endBin - startBin;

  for (let i = startBin; i < endBin; i++) {
    const normalized = fftData[i] / 255; // Normalize to 0-1
    sumOfSquares += normalized * normalized;
  }

  const rms = Math.sqrt(sumOfSquares / binCount);
  return rms;
}

/**
 * Process FFT data with RMS-based measurement for more professional audio metering
 *
 * @param fftData - Uint8Array of frequency magnitudes (0-255 range)
 * @param sampleRate - Audio sample rate in Hz
 * @returns Normalized bass, mid, high, and energy values using RMS
 */
export function processBandsRMS(fftData: Uint8Array, sampleRate: number): BandValues {
  const indices = getBinIndices(sampleRate);

  // Calculate RMS for each band - more accurate than simple averaging
  const bassRMS = calculateBandRMS(fftData, indices.bassStart, indices.bassEnd);
  const midRMS = calculateBandRMS(fftData, indices.midStart, indices.midEnd);
  const highRMS = calculateBandRMS(fftData, indices.highStart, indices.highEnd);

  // Apply pink noise compensation
  const bass = Math.min(bassRMS * AUDIO_CONFIG.pinkNoiseCompensation.bass, 1.0);
  const mid = Math.min(midRMS * AUDIO_CONFIG.pinkNoiseCompensation.mid, 1.0);
  const high = Math.min(highRMS * AUDIO_CONFIG.pinkNoiseCompensation.high, 1.0);

  // Calculate weighted energy
  const energy =
    bass * AUDIO_CONFIG.energyWeights.bass +
    mid * AUDIO_CONFIG.energyWeights.mid +
    high * AUDIO_CONFIG.energyWeights.high;

  return { bass, mid, high, energy };
}

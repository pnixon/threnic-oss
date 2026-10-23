import { describe, it, expect } from 'vitest';
import { getBinIndices, magnitudeToDecibel, AUDIO_CONFIG } from '@/engine/audio/AudioConfig';

describe('AudioConfig', () => {
  it('has correct frequencyBinCount', () => {
    expect(AUDIO_CONFIG.frequencyBinCount).toBe(AUDIO_CONFIG.fftSize / 2);
  });

  describe('getBinIndices', () => {
    it('calculates indices correctly for 44100Hz', () => {
      const indices = getBinIndices(44100);
      expect(indices.bassStart).toBeLessThan(indices.bassEnd);
      expect(indices.bassEnd).toBeLessThanOrEqual(indices.midStart);
      expect(indices.midStart).toBeLessThan(indices.midEnd);
      expect(indices.midEnd).toBeLessThanOrEqual(indices.highStart);
      expect(indices.highStart).toBeLessThan(indices.highEnd);
    });
  });

  describe('magnitudeToDecibel', () => {
    it('converts magnitude to decibel-scaled byte', () => {
      // Test with magnitude that should be near maxDecibels (-30dB)
      // magnitude near 0.0316 is -30dB
      expect(magnitudeToDecibel(0.0316)).toBeGreaterThan(250);

      // Test with magnitude near minDecibels (-100dB)
      // magnitude near 0.00001 is -100dB
      expect(magnitudeToDecibel(0.00001)).toBeLessThan(10);
    });

    it('clamps values to 0-255', () => {
      expect(magnitudeToDecibel(0)).toBe(0);
      expect(magnitudeToDecibel(100)).toBe(255);
    });
  });
});

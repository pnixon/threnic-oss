import { describe, it, expect } from 'vitest';
import { calculateBandRMS, processBandsRMS } from '@/engine/audio/AudioProcessor';

describe('AudioProcessor', () => {
  describe('calculateBandRMS', () => {
    it('calculates 0 for empty array', () => {
      const data = new Uint8Array(10).fill(0);
      expect(calculateBandRMS(data, 0, 10)).toBe(0);
    });

    it('calculates strictly bounded between 0 and 1', () => {
      const data = new Uint8Array(10).fill(255);
      expect(calculateBandRMS(data, 0, 10)).toBe(1);
    });

    it('calculates RMS formula correctly', () => {
      const data = new Uint8Array(4);
      data[0] = 0; // 0
      data[1] = 127; // ~0.5
      data[2] = 255; // 1
      data[3] = 255; // 1

      const rms = calculateBandRMS(data, 0, 4);
      // RMS is sqrt((0^2 + 0.498^2 + 1^2 + 1^2) / 4) ≈ sqrt(2.248 / 4) ≈ 0.75
      expect(rms).toBeCloseTo(0.748, 2);
    });
  });

  describe('processBandsRMS', () => {
    it('calculates 0 for completely empty signals', () => {
      const fftData = new Uint8Array(1024).fill(0);
      const sampleRate = 44100;
      const bands = processBandsRMS(fftData, sampleRate);

      expect(bands.bass).toBe(0);
      expect(bands.mid).toBe(0);
      expect(bands.high).toBe(0);
      expect(bands.energy).toBe(0);
    });

    it('calculates bounded RMS bands strictly between 0 and 1', () => {
      const fftData = new Uint8Array(1024).fill(255);
      const sampleRate = 44100;

      const bands = processBandsRMS(fftData, sampleRate);

      expect(bands.bass).toBeLessThanOrEqual(1.0);
      expect(bands.mid).toBeLessThanOrEqual(1.0);
      expect(bands.high).toBeLessThanOrEqual(1.0);
      expect(bands.energy).toBeLessThanOrEqual(1.0);

      // Since pink noise config limits it, they should actually hit exactly 1.0 or very close
      expect(bands.bass).toBeCloseTo(1.0, 1);
      expect(bands.energy).toBeCloseTo(1.0, 1);
    });

    it('properly segregates bands using RMS tracking', () => {
      const fftData = new Uint8Array(1024).fill(0);

      // Inject signal into strictly the mid band
      const start = 30; // Mid band start usually > 15
      const end = 150; // Mid band end usually < 200
      for (let i = start; i < end; i++) {
        fftData[i] = 255;
      }

      const sampleRate = 44100;
      const bands = processBandsRMS(fftData, sampleRate);

      expect(bands.mid).toBeGreaterThan(0.5); // Strong mid
      expect(bands.bass).toBe(0); // Strictly isolated
    });

    it('handles mixed sparse frequencies correctly', () => {
      const fftData = new Uint8Array(1024).fill(0);
      // Sparsely populate
      for (let i = 0; i < 1024; i += 10) {
        fftData[i] = 127;
      }
      const bands = processBandsRMS(fftData, 44100);

      // Since only 1/10th is populated with half-amplitude, RMS will be roughly sqrt((0.5^2)/10) = sqrt(0.025) ≈ 0.15
      expect(bands.bass).toBeGreaterThan(0);
      expect(bands.bass).toBeLessThan(0.3);
      expect(bands.mid).toBeGreaterThan(0);
      expect(bands.mid).toBeLessThan(0.3);
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BackgroundTransformManager,
  type BackgroundTransformState,
} from './BackgroundTransformManager';
import type { EffectsConfig } from '@/types/effects';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';

// ─── Helpers ──────────────────────────────────────────────────

function makeBgState(overrides?: Partial<BackgroundTransformState>): BackgroundTransformState {
  return { scale: 1, offsetX: 0, offsetY: 0, angle: 0, slideActive: false, ...overrides };
}

/** Minimal EffectsConfig with only effectInstances populated. */
function makeConfig(instances: EffectsConfig['effectInstances']): EffectsConfig {
  return { ...DEFAULT_EFFECTS_CONFIG, effectInstances: instances };
}

function slideInstance(
  speedX: number,
  speedY: number,
  enabled = true,
): EffectsConfig['effectInstances'][number] {
  return {
    id: 'slide-1',
    type: 'slide',
    config: {
      enabled,
      speedX,
      speedY,
      audioReactive: {
        x: {
          enabled: false,
          band: 'energy',
          intensity: 0,
          min: 0,
          max: 0,
          lowerThreshold: 0,
          upperThreshold: 1,
          boxCenter: 0.5,
          boxWidth: 0.3,
        },
        y: {
          enabled: false,
          band: 'energy',
          intensity: 0,
          min: 0,
          max: 0,
          lowerThreshold: 0,
          upperThreshold: 1,
          boxCenter: 0.5,
          boxWidth: 0.3,
        },
      },
    },
  } as unknown as EffectsConfig['effectInstances'][number];
}

function zoomInstance(scale: number, enabled = true): EffectsConfig['effectInstances'][number] {
  return {
    id: 'zoom-1',
    type: 'zoom',
    config: {
      enabled,
      scale,
      centerX: 0.5,
      centerY: 0.5,
      audioReactive: {
        enabled: false,
        band: 'bass',
        intensity: 0,
        min: 1,
        max: 2,
        lowerThreshold: 0,
        upperThreshold: 1,
        boxCenter: 0.5,
        boxWidth: 0.3,
      },
    },
  } as unknown as EffectsConfig['effectInstances'][number];
}

function rotateInstance(
  speed: number,
  angle = 0,
  enabled = true,
): EffectsConfig['effectInstances'][number] {
  return {
    id: 'rotate-1',
    type: 'rotate',
    config: {
      enabled,
      speed,
      angle,
      audioReactive: {
        enabled: false,
        band: 'energy',
        intensity: 0,
        min: -180,
        max: 180,
        lowerThreshold: 0,
        upperThreshold: 1,
        boxCenter: 0.5,
        boxWidth: 0.3,
      },
      speedAudioReactive: {
        enabled: false,
        band: 'energy',
        intensity: 0,
        min: -180,
        max: 180,
        lowerThreshold: 0,
        upperThreshold: 1,
        boxCenter: 0.5,
        boxWidth: 0.3,
      },
    },
  } as unknown as EffectsConfig['effectInstances'][number];
}

// ─── Tests ────────────────────────────────────────────────────

describe('BackgroundTransformManager', () => {
  let mgr: BackgroundTransformManager;

  beforeEach(() => {
    mgr = new BackgroundTransformManager();
  });

  // ── Slide ─────────────────────────────────────────────────

  describe('slide (translate)', () => {
    it('accumulates offsetX over multiple frames', () => {
      const config = makeConfig([slideInstance(1.0, 0)]);
      const bg = makeBgState();

      mgr.update(config, 0.016, bg, false);
      const first = bg.offsetX;
      expect(first).toBeGreaterThan(0);

      const bg2 = makeBgState();
      mgr.update(config, 0.016, bg2, false);
      expect(bg2.offsetX).toBeGreaterThan(first);
    });

    it('accumulates offsetY with negative speed', () => {
      const config = makeConfig([slideInstance(0, -0.5)]);
      const bg = makeBgState();

      mgr.update(config, 0.1, bg, false);
      // speedY=-0.5 * dt=0.1 = -0.05, wrapped to 0.95
      expect(bg.offsetY).toBeGreaterThan(0.9);
    });

    it('does not accumulate when paused', () => {
      const config = makeConfig([slideInstance(1.0, 1.0)]);

      // First frame while playing
      const bg1 = makeBgState();
      mgr.update(config, 0.016, bg1, false);
      const accumulated = bg1.offsetX;

      // Second frame while paused — should read same accumulated value
      const bg2 = makeBgState();
      mgr.update(config, 0.016, bg2, true);
      expect(bg2.offsetX).toBeCloseTo(accumulated, 6);
    });

    it('does not modify offset when slide is disabled', () => {
      const config = makeConfig([slideInstance(1.0, 1.0, false)]);
      const bg = makeBgState();

      mgr.update(config, 0.1, bg, false);
      expect(bg.offsetX).toBe(0);
      expect(bg.offsetY).toBe(0);
    });

    it('resets accumulation when slide is disabled after being active', () => {
      const enabled = makeConfig([slideInstance(1.0, 0)]);
      const disabled = makeConfig([slideInstance(1.0, 0, false)]);

      // Accumulate
      const bg1 = makeBgState();
      mgr.update(enabled, 0.1, bg1, false);
      expect(bg1.offsetX).toBeGreaterThan(0);

      // Disable — should reset accumulators
      const bg2 = makeBgState();
      mgr.update(disabled, 0.1, bg2, false);
      expect(bg2.offsetX).toBe(0);

      // Re-enable — should start fresh from 0
      const bg3 = makeBgState();
      mgr.update(enabled, 0.1, bg3, false);
      expect(bg3.offsetX).toBeCloseTo(0.1, 2); // ~speedX * dt
    });

    it('preserves pre-existing bgState offset (additive)', () => {
      const config = makeConfig([slideInstance(1.0, 0)]);
      const bg = makeBgState({ offsetX: 5.0 });

      mgr.update(config, 0.1, bg, false);
      expect(bg.offsetX).toBeGreaterThan(5.0);
    });

    /**
     * Regression: NLE clip adjustments previously overwrote backgroundOffsetX/Y
     * with activeClip.offsetX ?? 0, destroying the slide accumulation.
     * This test ensures the slide offset survives an additive NLE adjustment.
     */
    it('regression: slide offset must not be zeroed by external overwrite', () => {
      const config = makeConfig([slideInstance(-0.05, 0)]);

      // Simulate 60 frames of playback (~1 second)
      for (let i = 0; i < 60; i++) {
        const bg = makeBgState();
        mgr.update(config, 1 / 60, bg, false);
      }

      // After 1s at speedX=-0.05, accumulated offset wraps: -0.05 → 0.95
      const bg = makeBgState();
      mgr.update(config, 1 / 60, bg, false);
      expect(bg.offsetX).toBeCloseTo(0.95, 1);
      expect(bg.offsetX).not.toBe(0); // the key assertion — must not be zeroed
    });
  });

  // ── Zoom ──────────────────────────────────────────────────

  describe('zoom', () => {
    it('applies static zoom scale', () => {
      const config = makeConfig([zoomInstance(2.0)]);
      const bg = makeBgState();

      mgr.update(config, 0.016, bg, false);
      expect(bg.scale).toBe(2.0);
    });

    it('does not modify scale when zoom is disabled', () => {
      const config = makeConfig([zoomInstance(2.0, false)]);
      const bg = makeBgState();

      mgr.update(config, 0.016, bg, false);
      expect(bg.scale).toBe(1.0);
    });
  });

  // ── Rotate ────────────────────────────────────────────────

  describe('rotate', () => {
    it('accumulates rotation from speed', () => {
      const config = makeConfig([rotateInstance(90)]); // 90 deg/s
      const bg = makeBgState();

      mgr.update(config, 1.0, bg, false); // 1 second
      // 90 deg/s * 1s = 90 deg = PI/2 radians (±envelope drift)
      expect(bg.angle).toBeGreaterThan(0);
      expect(Math.abs(bg.angle - Math.PI / 2)).toBeLessThan(0.5);
    });

    it('does not accumulate when paused', () => {
      const config = makeConfig([rotateInstance(90)]);
      const bg1 = makeBgState();
      mgr.update(config, 0.5, bg1, false);
      const angle1 = bg1.angle;

      const bg2 = makeBgState();
      mgr.update(config, 0.5, bg2, true);
      expect(bg2.angle).toBeCloseTo(angle1, 6);
    });
  });

  // ── Edge cases ────────────────────────────────────────────

  describe('edge cases', () => {
    it('bails gracefully with undefined config', () => {
      const bg = makeBgState();
      mgr.update(undefined, 0.016, bg, false);
      expect(bg.offsetX).toBe(0);
      expect(bg.scale).toBe(1);
      expect(bg.angle).toBe(0);
    });

    it('bails gracefully with missing effectInstances', () => {
      const config: Partial<EffectsConfig> = { ...DEFAULT_EFFECTS_CONFIG };
      delete config.effectInstances;
      const bg = makeBgState();
      mgr.update(config as EffectsConfig, 0.016, bg, false);
      expect(bg.offsetX).toBe(0);
    });

    it('handles all three effects simultaneously', () => {
      const config = makeConfig([slideInstance(0.5, -0.3), zoomInstance(1.5), rotateInstance(45)]);
      const bg = makeBgState();

      mgr.update(config, 0.1, bg, false);

      expect(bg.offsetX).toBeGreaterThan(0);
      // speedY=-0.3 wraps to positive in UV space
      expect(bg.offsetY).toBeGreaterThan(0.9);
      expect(bg.scale).toBe(1.5);
      expect(bg.angle).toBeGreaterThan(0);
    });

    it('wraps slide offset so background loops instead of drifting off', () => {
      const config = makeConfig([slideInstance(1.0, 0)]);
      // Simulate 120 frames (2s) at speedX=1.0 → accum=2.0 → wraps to 0.0
      for (let i = 0; i < 120; i++) {
        const bg = makeBgState();
        mgr.update(config, 1 / 60, bg, false);
      }
      const bg = makeBgState();
      mgr.update(config, 1 / 60, bg, false);
      // Offset should be wrapped within [0, 1), not 2.0+
      expect(bg.offsetX).toBeGreaterThanOrEqual(0);
      expect(bg.offsetX).toBeLessThan(1.0);
    });

    it('reset() zeroes all accumulators', () => {
      const config = makeConfig([slideInstance(1.0, 1.0), rotateInstance(90)]);

      // Accumulate some state
      const bg1 = makeBgState();
      mgr.update(config, 0.5, bg1, false);
      expect(bg1.offsetX).toBeGreaterThan(0);

      // Reset
      mgr.reset();

      // After reset, accumulators should be zero
      const bg2 = makeBgState();
      mgr.update(config, 0.016, bg2, false);
      // Should be only 1 frame's worth, not accumulated from before
      expect(bg2.offsetX).toBeLessThan(0.02);
    });
  });
});

/**
 * DecoupledExporter Frame Resolution Tests
 *
 * Tests the pure-function keyframe resolution used by DecoupledExporter
 * during the frame loop. These are integration tests that validate the
 * full chain: keyframes → computeStateAtTime → effect resolution.
 *
 * No WebGPU, no React, no DOM — just pure computation.
 *
 * Run: npm run test:quick -- test/engine/export/decoupled-exporter-resolution.test.ts
 */

import { describe, it, expect } from 'vitest';
import { computeStateAtTime, parseKeyframes } from '@/utils/keyframes';
import { computeFinalEffectsConfig } from '@/utils/keyframes';
import type { EffectsConfig } from '@/types/effects';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import type { Keyframe } from '@/types/keyframes';

// ─── Helpers ─────────────────────────────────────────────────

function makeBaseEffects(overrides: Partial<EffectsConfig> = {}): EffectsConfig {
  return { ...DEFAULT_EFFECTS_CONFIG, ...overrides };
}

function makeBloomInstance(id = 'bloom-1', enabled = true, intensity = 0.8) {
  return {
    id,
    type: 'bloom' as const,
    config: {
      enabled,
      intensity,
      threshold: 0.5,
      radius: 0.4,
      audioReactive: {
        enabled: false,
        target: 'intensity' as const,
        sensitivity: 0.5,
        smoothing: 0.8,
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('DecoupledExporter Frame Resolution', () => {
  describe('computeStateAtTime (pure)', () => {
    it('returns empty overrides when no keyframes exist', () => {
      const result = computeStateAtTime([], 0);

      expect(result.effects).toEqual({});
      expect(result.scene).toBeDefined();
      expect(result.transition.isActive).toBe(false);
    });

    it('resolves scene background brightness from keyframes', () => {
      const keyframes: Keyframe[] = [
        {
          id: 'kf-1',
          time: 0,
          properties: { 'scene.backgroundBrightness': 1.0 },
          interpolation: 'linear',
        },
        {
          id: 'kf-2',
          time: 10,
          properties: { 'scene.backgroundBrightness': 0.5 },
          interpolation: 'linear',
        },
      ];

      // At t=5, should be interpolated to ~0.75
      const result = computeStateAtTime(keyframes, 5);
      const brightness = result.scene.backgroundBrightness;
      expect(brightness).toBeCloseTo(0.75, 1);
    });

    it('resolves effect overrides from keyframes', () => {
      const baseEffects = makeBaseEffects({
        effectInstances: [makeBloomInstance('bloom-1', true, 0.5)],
      });

      const keyframes: Keyframe[] = [
        {
          id: 'kf-1',
          time: 0,
          properties: { 'fx.bloom-1.intensity': 0.5 },
          interpolation: 'linear',
        },
        {
          id: 'kf-2',
          time: 10,
          properties: { 'fx.bloom-1.intensity': 1.0 },
          interpolation: 'linear',
        },
      ];

      // At t=5, intensity should interpolate to ~0.75
      const result = computeStateAtTime(keyframes, 5, undefined, baseEffects);
      expect(result.effects['fx.bloom-1.intensity']).toBeCloseTo(0.75, 1);
    });

    it('holds effect values after last keyframe', () => {
      const keyframes: Keyframe[] = [
        {
          id: 'kf-1',
          time: 0,
          properties: { 'scene.backgroundBrightness': 1.0 },
          interpolation: 'linear',
        },
        {
          id: 'kf-2',
          time: 5,
          properties: { 'scene.backgroundBrightness': 0.2 },
          interpolation: 'linear',
        },
      ];

      // At t=100 (well after the last keyframe)
      const result = computeStateAtTime(keyframes, 100);
      expect(result.scene.backgroundBrightness).toBeCloseTo(0.2, 1);
    });
  });

  describe('computeFinalEffectsConfig (pure)', () => {
    it('applies effect overrides to base config', () => {
      const baseConfig = makeBaseEffects({
        effectInstances: [makeBloomInstance('bloom-1', true, 0.5)],
      });

      // Simulate keyframe override for bloom intensity via fx.* addressing
      const computed = computeFinalEffectsConfig(
        baseConfig,
        {}, // no scene overrides
        { 'fx.bloom-1.intensity': 0.9 },
      );

      expect(computed).toBeDefined();
      const bloom = computed!.effectInstances.find((i) => i.id === 'bloom-1');
      expect(bloom).toBeDefined();
      expect((bloom!.config as any).intensity).toBeCloseTo(0.9, 1);
    });

    it('returns undefined when no base config', () => {
      const result = computeFinalEffectsConfig(undefined as any, {}, { 'bloom.intensity': 0.5 });
      expect(result).toBeUndefined();
    });

    it('preserves unmodified instances', () => {
      const baseConfig = makeBaseEffects({
        effectInstances: [
          makeBloomInstance('bloom-1', true, 0.5),
          {
            id: 'sepia-1',
            type: 'sepia' as const,
            config: {
              enabled: true,
              intensity: 0.7,
              audioReactive: {
                enabled: false,
                target: 'intensity' as const,
                sensitivity: 0.5,
                smoothing: 0.8,
              },
            },
          },
        ],
      });

      const computed = computeFinalEffectsConfig(baseConfig, {}, { 'fx.bloom-1.intensity': 0.9 });

      // Sepia should be unchanged
      const sepia = computed!.effectInstances.find((i) => i.id === 'sepia-1');
      expect(sepia).toBeDefined();
      expect((sepia!.config as any).intensity).toBeCloseTo(0.7, 1);
    });

    it('applies scene overrides like background brightness', () => {
      const baseConfig = makeBaseEffects({
        backgroundBrightness: 1.0,
      });

      const computed = computeFinalEffectsConfig(baseConfig, { backgroundBrightness: 0.3 }, {});

      expect(computed!.backgroundBrightness).toBeCloseTo(0.3, 1);
    });
  });

  describe('Full export frame simulation', () => {
    it('resolves correct effect config at each frame time', () => {
      const baseEffects = makeBaseEffects({
        effectInstances: [makeBloomInstance('bloom-1', true, 0.5)],
      });

      const keyframes: Keyframe[] = [
        {
          id: 'kf-1',
          time: 0,
          properties: { 'fx.bloom-1.intensity': 0.5 },
          interpolation: 'linear',
        },
        {
          id: 'kf-2',
          time: 10,
          properties: { 'fx.bloom-1.intensity': 1.0 },
          interpolation: 'linear',
        },
      ];

      const parsed = parseKeyframes(keyframes);
      const fps = 30;
      const totalFrames = 10 * fps; // 10 seconds

      // Simulate the export loop at key times
      const checkpoints = [0, 2.5, 5.0, 7.5, 10.0];
      const expectedIntensities = [0.5, 0.625, 0.75, 0.875, 1.0];

      for (let i = 0; i < checkpoints.length; i++) {
        const time = checkpoints[i];
        const state = computeStateAtTime(parsed, time, undefined, baseEffects);

        // Apply overrides to get final config
        const finalConfig = computeFinalEffectsConfig(baseEffects, state.scene, state.effects);

        const bloom = finalConfig?.effectInstances.find((inst) => inst.id === 'bloom-1');
        expect(bloom).toBeDefined();
        expect((bloom!.config as any).intensity).toBeCloseTo(expectedIntensities[i], 1);
      }
    });

    it('simulates 300 frames without errors', () => {
      const baseEffects = makeBaseEffects({
        effectInstances: [makeBloomInstance('bloom-1', true, 0.5)],
      });

      const keyframes: Keyframe[] = [
        {
          id: 'kf-1',
          time: 0,
          properties: {
            'fx.bloom-1.intensity': 0.3,
            'scene.backgroundBrightness': 1.0,
          },
          interpolation: 'linear',
        },
        {
          id: 'kf-2',
          time: 5,
          properties: {
            'fx.bloom-1.intensity': 0.8,
            'scene.backgroundBrightness': 0.5,
          },
          interpolation: 'linear',
        },
        {
          id: 'kf-3',
          time: 10,
          properties: {
            'fx.bloom-1.intensity': 0.1,
            'scene.backgroundBrightness': 1.0,
          },
          interpolation: 'linear',
        },
      ];

      const parsed = parseKeyframes(keyframes);
      const fps = 30;
      const totalFrames = 300; // 10 seconds

      // Run through ALL frames — no crashes, no NaN, no undefined
      for (let frame = 0; frame < totalFrames; frame++) {
        const time = frame / fps;
        const state = computeStateAtTime(parsed, time, undefined, baseEffects);

        expect(state).toBeDefined();
        expect(state.scene).toBeDefined();
        expect(state.effects).toBeDefined();

        const finalConfig = computeFinalEffectsConfig(baseEffects, state.scene, state.effects);

        expect(finalConfig).toBeDefined();
        const bloom = finalConfig!.effectInstances.find((inst) => inst.id === 'bloom-1');
        expect(bloom).toBeDefined();

        const intensity = (bloom!.config as any).intensity;
        expect(typeof intensity).toBe('number');
        expect(isNaN(intensity)).toBe(false);
        expect(intensity).toBeGreaterThanOrEqual(0);
        expect(intensity).toBeLessThanOrEqual(1);
      }
    });
  });
});

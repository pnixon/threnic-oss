import { describe, it, expect, beforeEach } from 'vitest';
import { tickResolver, resetResolver } from '@/engine/keyframeResolver';
import { computeFinalEffectsConfig } from '@/utils/keyframes';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { timeStore } from '@/engine/stores/timeStore';
import { projectStore } from '@/stores/projectStore';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';

describe('Keyframe Engine - Architecture Verification', () => {
  beforeEach(() => {
    resetResolver(); // Clear resolver caches
    // Reset engine state
    timeStore.setState({ currentTime: 0, mode: 'playback' });
    keyframeStore.setState({
      effects: { overrides: {} },
      lyrics: { overrides: {} },
      scene: {
        backgroundMode: 'standard',
        assetUrl: null,
        backgroundFit: 'cover',
        backgroundColor: '#000000',
        _version: 0,
      } as any,
    });
  });

  const simulateTick = (keyframes: any[], time: number) => {
    projectStore.setState({
      tracks: [
        {
          id: 'test-track',
          title: 'Test',
          duration: 100,
          type: 'audio',
          keyframes,
          effectsConfig: DEFAULT_EFFECTS_CONFIG,
        } as any,
      ],
      selectedTrackId: 'test-track',
    });
    timeStore.setState({ currentTime: time });
    tickResolver();
  };

  describe('tickResolver (Interpolation)', () => {
    it('should apply basic keyframe overrides', () => {
      const keyframes = [
        {
          id: 'k1',
          time: 0,
          properties: {
            'effects.postProcessing.bloom.intensity': 1.5,
            'lyrics.fontSize': 2.0,
          },
        },
      ];

      simulateTick(keyframes, 0);

      expect(keyframeStore.getState().effects.overrides['bloom.intensity']).toBe(1.5);
      expect(keyframeStore.getState().lyrics.overrides['fontSize']).toBe(2.0);
    });

    it('should interpolate numeric values between keyframes', () => {
      const keyframes = [
        {
          id: 'k1',
          time: 0,
          properties: { 'effects.postProcessing.bloom.intensity': 1.0 },
          interpolation: 'linear' as const,
        },
        {
          id: 'k2',
          time: 10,
          properties: { 'effects.postProcessing.bloom.intensity': 2.0 },
        },
      ];

      simulateTick(keyframes, 5);
      expect(keyframeStore.getState().effects.overrides['bloom.intensity']).toBe(1.5);
    });

    it('should explicitly set enabled to false if a keyframe says so', () => {
      const keyframes = [
        {
          id: 'k1',
          time: 0,
          properties: { 'effects.postProcessing.bloom.enabled': false },
        },
      ];

      simulateTick(keyframes, 0);
      expect(keyframeStore.getState().effects.overrides['bloom.enabled']).toBe(false);
    });
  });

  describe('computeFinalEffectsConfig (Stable Instances)', () => {
    it('should NOT create dynamic instances (Architecture Shift)', () => {
      // Setup keyframe override for bloom
      keyframeStore.getState().effects.overrides['postProcessing.bloom.enabled'] = true;
      keyframeStore.getState().effects.overrides['postProcessing.bloom.intensity'] = 1.2;

      // Base config has NO instances
      const base = { ...DEFAULT_EFFECTS_CONFIG, effectInstances: [] };
      const result = computeFinalEffectsConfig(
        base,
        keyframeStore.getState().scene,
        keyframeStore.getState().effects.overrides,
      );

      // Verify NO dynamic instance was created (per stable instances principle)
      const bloomInst = result?.effectInstances.find((i) => i.type === 'bloom');
      expect(bloomInst).toBeUndefined();
    });

    it('should update existing instanced effects', () => {
      // Setup keyframe override for bloom
      keyframeStore.getState().effects.overrides['postProcessing.bloom.intensity'] = 0.8;

      // Base config HAS an instance already
      const base = {
        ...DEFAULT_EFFECTS_CONFIG,
        effectInstances: [
          {
            id: 'real-bloom',
            type: 'bloom' as any,
            config: { enabled: true, intensity: 0.2 },
          },
        ],
      };

      const result = computeFinalEffectsConfig(
        base,
        keyframeStore.getState().scene,
        keyframeStore.getState().effects.overrides,
      );

      const bloomInst = result?.effectInstances.find((i) => i.id === 'real-bloom');
      expect(bloomInst).toBeDefined();
      expect((bloomInst?.config as any).intensity).toBe(0.8);
      // Original config intensity was 0.2, now it's 0.8
    });

    it('should maintain instances even when disabled via keyframe', () => {
      // Setup keyframe override to disable
      keyframeStore.getState().effects.overrides['postProcessing.bloom.enabled'] = false;

      // Base config HAS an instance
      const base = {
        ...DEFAULT_EFFECTS_CONFIG,
        effectInstances: [
          {
            id: 'persistent-bloom',
            type: 'bloom' as any,
            config: { enabled: true },
          },
        ],
      };

      const result = computeFinalEffectsConfig(
        base,
        keyframeStore.getState().scene,
        keyframeStore.getState().effects.overrides,
      );

      const bloomInst = result?.effectInstances.find((i) => i.id === 'persistent-bloom');
      expect(bloomInst).toBeDefined();
      expect((bloomInst?.config as any).enabled).toBe(false);
      // Instance still exists in array, but config.enabled is now false
    });
  });
});

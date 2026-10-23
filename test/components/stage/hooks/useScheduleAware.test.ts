import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScheduleAwareEffectsConfig } from '@/components/stage/hooks/useScheduleAware';
import { computeFinalEffectsConfig } from '@/utils/keyframes';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { exportStore } from '@/engine/stores/exportStore';
import { timeStore } from '@/engine/stores/timeStore';

// Mock react-three-fiber hooks
vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
}));

describe('useScheduleAware Hooks', () => {
  beforeEach(() => {
    // Reset engine states
    timeStore.setState({ currentTime: 0 });

    exportStore.setState({
      mode: 'preview',
      effectsConfigSchedule: [],
    });

    keyframeStore.setState({
      effects: {
        overrides: {},
        computedConfig: null,
        _version: 0,
      },
      scene: {
        backgroundMode: 'standard',
        assetUrl: null,
        backgroundFit: 'cover',
        backgroundColor: '#000000',
        backgroundBrightness: undefined,
        backgroundScale: undefined,
        backgroundOffsetX: undefined,
        backgroundOffsetY: undefined,
        backgroundTileOffsetX: undefined,
        backgroundTileOffsetY: undefined,
        _version: 0,
      } as any,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('computeFinalEffectsConfig', () => {
    it('returns undefined when baseConfig is undefined', () => {
      const state = keyframeStore.getState();
      expect(
        computeFinalEffectsConfig(undefined, state.scene, state.effects.overrides),
      ).toBeUndefined();
    });

    it('returns a cloned version of base config when no overrides', () => {
      const state = keyframeStore.getState();
      const baseConfig = { ...DEFAULT_EFFECTS_CONFIG };
      const result = computeFinalEffectsConfig(baseConfig, state.scene, state.effects.overrides);

      expect(result).toEqual(baseConfig);
      expect(result).not.toBe(baseConfig); // Ensure it's cloned, not referenced
    });

    it('applies scene overrides correctly', () => {
      keyframeStore.setState((state) => ({
        scene: {
          ...state.scene,
          backgroundMode: 'video',
          backgroundBrightness: 2.0,
        },
      }));

      const state = keyframeStore.getState();
      const baseConfig = { ...DEFAULT_EFFECTS_CONFIG, backgroundMode: 'standard' as const };

      const result = computeFinalEffectsConfig(baseConfig, state.scene, state.effects.overrides);

      expect(result?.backgroundMode).toBe('video');
      expect(result?.backgroundBrightness).toBe(2.0);
    });

    it('applies effect configuration overrides to existing instances', () => {
      keyframeStore.setState((state) => ({
        effects: {
          ...state.effects,
          overrides: {
            'postProcessing.bloom.intensity': 5.0,
          },
        },
      }));

      const state = keyframeStore.getState();

      const effectInst: EffectInstance = {
        id: 'test-bloom',
        type: 'bloom',
        config: { enabled: true, intensity: 1.0 },
      };
      const baseConfig = { ...DEFAULT_EFFECTS_CONFIG, effectInstances: [effectInst] };

      const result = computeFinalEffectsConfig(baseConfig, state.scene, state.effects.overrides);
      const modifiedInst = result?.effectInstances.find(
        (i: EffectInstance) => i.id === 'test-bloom',
      );
      expect((modifiedInst?.config as any).intensity).toBe(5.0);
    });

    it('applies top-level flat overrides for backward compatibility', () => {
      keyframeStore.setState((state) => ({
        effects: {
          ...state.effects,
          overrides: {
            backgroundScale: 3.0,
          },
        },
      }));

      const state = keyframeStore.getState();
      const baseConfig = { ...DEFAULT_EFFECTS_CONFIG, backgroundScale: 1.0 };

      const result = computeFinalEffectsConfig(baseConfig, state.scene, state.effects.overrides);

      expect(result?.backgroundScale).toBe(3.0);
    });

    it('handles nested effect overrides such as visuals', () => {
      keyframeStore.setState((state) => ({
        effects: {
          ...state.effects,
          overrides: {
            'visualizer.type': 'circle',
          },
        },
      }));

      const state = keyframeStore.getState();

      const effectInst: EffectInstance = {
        id: 'test-vis',
        type: 'visualizer',
        config: { enabled: true, type: 'bars' },
      };
      const baseConfig = { ...DEFAULT_EFFECTS_CONFIG, effectInstances: [effectInst] };

      const result = computeFinalEffectsConfig(baseConfig, state.scene, state.effects.overrides);

      const modifiedInst = result?.effectInstances.find((i: EffectInstance) => i.id === 'test-vis');
      expect((modifiedInst?.config as any).type).toBe('circle');
    });
  });

  describe('useScheduleAwareEffectsConfig', () => {
    it('returns default config when not in export mode and no schedule exists', () => {
      exportStore.setState({ mode: 'preview' });
      const defaultConfig = { ...DEFAULT_EFFECTS_CONFIG };

      const { result } = renderHook(() => useScheduleAwareEffectsConfig(defaultConfig));

      expect(result.current).toEqual(defaultConfig);
    });

    it('applies overrides directly to the config hook', () => {
      exportStore.setState({ mode: 'preview' });
      const defaultConfig = { ...DEFAULT_EFFECTS_CONFIG, backgroundMode: 'solid' as const };

      keyframeStore.setState((state) => ({
        scene: {
          ...state.scene,
          backgroundMode: 'video',
        },
      }));
      keyframeStore.setState((state) => ({
        effects: {
          ...state.effects,
          computedConfig:
            computeFinalEffectsConfig(defaultConfig, state.scene, state.effects.overrides) || null,
        },
      }));

      const { result } = renderHook(() => useScheduleAwareEffectsConfig(defaultConfig));

      expect(result.current?.backgroundMode).toBe('video');
    });
  });
});

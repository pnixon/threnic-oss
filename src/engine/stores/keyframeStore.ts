import { createStore } from 'zustand/vanilla';
import type { EffectsConfig } from '@/types/effects';
import type { SceneTransitionType } from '@/types/keyframes';

export interface KeyframeState {
  transition: {
    isActive: boolean;
    type: SceneTransitionType;
    progress: number;
    easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
    fromTrackIndex: number;
    toTrackIndex: number;
    duration: number;
    startTime: number;
    endTime: number;
    _version: number;
  };
  scene: {
    backgroundMode: 'standard' | 'video' | 'pixi' | 'space' | 'solid' | null;
    assetUrl: string | null;
    backgroundFit: string | null;
    backgroundTiling?: boolean;
    backgroundColor: string | null;
    backgroundBrightness?: number;
    backgroundOpacity?: number;
    backgroundScale?: number;
    backgroundOffsetX?: number;
    backgroundOffsetY?: number;
    backgroundAngle?: number;
    backgroundTileOffsetX?: number;
    backgroundTileOffsetY?: number;
    backgroundMediaIndex?: number;
    backgroundContrast?: number;
    backgroundBlur?: number;
    _version: number;
  };
  scenePrev: {
    backgroundMode: 'standard' | 'video' | 'pixi' | 'space' | 'solid' | null;
    assetUrl: string | null;
    backgroundFit: string | null;
    backgroundTiling?: boolean;
    backgroundColor: string | null;
    backgroundBrightness?: number;
    backgroundOpacity?: number;
    backgroundScale?: number;
    backgroundOffsetX?: number;
    backgroundOffsetY?: number;
    backgroundAngle?: number;
    backgroundTileOffsetX?: number;
    backgroundTileOffsetY?: number;
    backgroundMediaIndex?: number;
    backgroundContrast?: number;
    backgroundBlur?: number;
    _version: number;
  };
  lyrics: {
    overrides: Record<string, number | string | boolean>;
    _version: number;
  };
  effects: {
    overrides: Record<string, unknown>;
    computedConfig: EffectsConfig | null;
    _version: number;
  };

  // Actions
  updateTransition: (data: Partial<KeyframeState['transition']>) => void;
  updateScene: (data: Partial<KeyframeState['scene']>) => void;
  updateScenePrev: (data: Partial<KeyframeState['scenePrev']>) => void;
  updateLyrics: (overrides: Record<string, number | string | boolean>) => void;
  updateEffects: (overrides: Record<string, unknown>, computedConfig: EffectsConfig | null) => void;
  reset: () => void;
}

export const keyframeStore = createStore<KeyframeState>((set) => ({
  transition: {
    isActive: false,
    type: 'crossfade',
    progress: 0,
    easing: 'ease-in-out',
    fromTrackIndex: -1,
    toTrackIndex: -1,
    duration: 2.0,
    startTime: 0,
    endTime: 0,
    _version: 0,
  },
  scene: {
    backgroundMode: null,
    assetUrl: null,
    backgroundFit: null,
    backgroundColor: null,
    _version: 0,
  },
  scenePrev: {
    backgroundMode: null,
    assetUrl: null,
    backgroundFit: null,
    backgroundColor: null,
    _version: 0,
  },
  lyrics: {
    overrides: {},
    _version: 0,
  },
  effects: {
    overrides: {},
    computedConfig: null,
    _version: 0,
  },

  updateTransition: (data) =>
    set((state) => ({
      transition: { ...state.transition, ...data, _version: state.transition._version + 1 },
    })),

  updateScene: (data) =>
    set((state) => ({
      scene: { ...state.scene, ...data, _version: state.scene._version + 1 },
    })),

  updateScenePrev: (data) =>
    set((state) => ({
      scenePrev: { ...state.scenePrev, ...data, _version: state.scenePrev._version + 1 },
    })),

  updateLyrics: (overrides) =>
    set((state) => ({
      lyrics: { overrides, _version: state.lyrics._version + 1 },
    })),

  updateEffects: (overrides, computedConfig) =>
    set((state) => ({
      effects: { overrides, computedConfig, _version: state.effects._version + 1 },
    })),

  reset: () =>
    set({
      transition: {
        isActive: false,
        type: 'crossfade',
        progress: 0,
        easing: 'ease-in-out',
        fromTrackIndex: -1,
        toTrackIndex: -1,
        duration: 2.0,
        startTime: 0,
        endTime: 0,
        _version: 0,
      },
      scene: {
        backgroundMode: null,
        assetUrl: null,
        backgroundFit: null,
        backgroundColor: null,
        _version: 0,
      },
      scenePrev: {
        backgroundMode: null,
        assetUrl: null,
        backgroundFit: null,
        backgroundColor: null,
        _version: 0,
      },
      lyrics: { overrides: {}, _version: 0 },
      effects: { overrides: {}, computedConfig: null, _version: 0 },
    }),
}));

if (typeof window !== 'undefined') {
  (window as unknown as { keyframeStore: typeof keyframeStore }).keyframeStore = keyframeStore;
}

/**
 * trackStore — Imperative state bridge tests.
 *
 * trackStore is the critical bridge between React (AppContent) and the
 * GPU rendering pipeline (GPUCanvas reads it directly). These tests
 * lock down the exact contract so refactoring AppContent doesn't
 * silently break the rendering pipeline.
 *
 * Run: npm run test:quick -- test/engine/stores/trackStore.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { trackStore, type TrackStoreState } from '@/engine/stores/trackStore';
import { DEFAULT_EFFECTS_CONFIG, type EffectsConfig } from '@/types/effects';
import type { VideoClip } from '@/types/video-clips';

// ─── Helpers ─────────────────────────────────────────────────

function makeEffectsConfig(overrides: Partial<EffectsConfig> = {}): EffectsConfig {
  return { ...DEFAULT_EFFECTS_CONFIG, ...overrides };
}

function makeVideoClip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    id: 'clip-1',
    name: 'Test Clip',
    url: 'blob:http://localhost/test-video',
    startTime: 0,
    endTime: 30,
    inPoint: 0,
    outPoint: 30,
    sourceDuration: 30,
    speed: 1.0,
    behavior: 'loop',
    opacity: 1.0,
    scale: 1.0,
    brightness: 1.0,
    offsetX: 0,
    offsetY: 0,
    ...overrides,
  } as VideoClip;
}

// ─── Tests ───────────────────────────────────────────────────

describe('trackStore', () => {
  beforeEach(() => {
    // Reset to initial state before each test
    trackStore.setState({
      trackId: null,
      backgroundImageUrl: null,
      effectsConfig: null,
      videoClips: [],
      isExporting: false,
    });
  });

  describe('initial state', () => {
    it('starts with null trackId', () => {
      expect(trackStore.getState().trackId).toBeNull();
    });

    it('starts with null backgroundImageUrl', () => {
      expect(trackStore.getState().backgroundImageUrl).toBeNull();
    });

    it('starts with null effectsConfig', () => {
      expect(trackStore.getState().effectsConfig).toBeNull();
    });

    it('starts with empty videoClips', () => {
      expect(trackStore.getState().videoClips).toEqual([]);
    });

    it('starts with isExporting=false', () => {
      expect(trackStore.getState().isExporting).toBe(false);
    });
  });

  describe('setTrack', () => {
    it('sets trackId and backgroundImageUrl', () => {
      trackStore.getState().setTrack('track-1', 'blob:http://localhost/bg.jpg');
      const state = trackStore.getState();

      expect(state.trackId).toBe('track-1');
      expect(state.backgroundImageUrl).toBe('blob:http://localhost/bg.jpg');
    });

    it('sets trackId to null (deselect)', () => {
      trackStore.getState().setTrack('track-1', 'bg.jpg');
      trackStore.getState().setTrack(null, null);

      expect(trackStore.getState().trackId).toBeNull();
      expect(trackStore.getState().backgroundImageUrl).toBeNull();
    });

    it('sets videoClips when provided', () => {
      const clips = [makeVideoClip()];
      trackStore.getState().setTrack('track-1', null, clips);

      expect(trackStore.getState().videoClips).toEqual(clips);
    });

    it('defaults videoClips to empty array when not provided', () => {
      trackStore.getState().setTrack('track-1', null);

      expect(trackStore.getState().videoClips).toEqual([]);
    });
  });

  describe('setEffectsConfig', () => {
    it('stores effectsConfig for GPU consumption', () => {
      const config = makeEffectsConfig({ backgroundBrightness: 0.5 });
      trackStore.getState().setEffectsConfig(config);

      expect(trackStore.getState().effectsConfig).toBe(config);
      expect(trackStore.getState().effectsConfig!.backgroundBrightness).toBe(0.5);
    });

    it('accepts null to clear config', () => {
      trackStore.getState().setEffectsConfig(makeEffectsConfig());
      trackStore.getState().setEffectsConfig(null);

      expect(trackStore.getState().effectsConfig).toBeNull();
    });

    it('preserves effectInstances through the store', () => {
      const config = makeEffectsConfig({
        effectInstances: [
          {
            id: 'bloom-1',
            type: 'bloom',
            config: {
              enabled: true,
              intensity: 0.8,
              threshold: 0.5,
              radius: 0.4,
              audioReactive: {
                enabled: false,
                target: 'intensity',
                sensitivity: 0.5,
                smoothing: 0.8,
              },
            },
          },
        ],
      });

      trackStore.getState().setEffectsConfig(config);

      const stored = trackStore.getState().effectsConfig!;
      expect(stored.effectInstances).toHaveLength(1);
      expect(stored.effectInstances[0].type).toBe('bloom');
      expect((stored.effectInstances[0].config as any).intensity).toBe(0.8);
    });
  });

  describe('setVideoClips', () => {
    it('stores video clips for timeline playback', () => {
      const clips = [
        makeVideoClip({ id: 'clip-1', startTime: 0, endTime: 15 }),
        makeVideoClip({ id: 'clip-2', startTime: 15, endTime: 30 }),
      ];
      trackStore.getState().setVideoClips(clips);

      expect(trackStore.getState().videoClips).toHaveLength(2);
      expect(trackStore.getState().videoClips[0].id).toBe('clip-1');
      expect(trackStore.getState().videoClips[1].id).toBe('clip-2');
    });

    it('replaces existing clips', () => {
      trackStore.getState().setVideoClips([makeVideoClip({ id: 'old' })]);
      trackStore.getState().setVideoClips([makeVideoClip({ id: 'new' })]);

      expect(trackStore.getState().videoClips).toHaveLength(1);
      expect(trackStore.getState().videoClips[0].id).toBe('new');
    });
  });

  describe('setIsExporting', () => {
    it('sets export flag for GPU to skip preview rendering', () => {
      trackStore.getState().setIsExporting(true);
      expect(trackStore.getState().isExporting).toBe(true);

      trackStore.getState().setIsExporting(false);
      expect(trackStore.getState().isExporting).toBe(false);
    });
  });

  describe('subscription contract (GPUCanvas pattern)', () => {
    it('notifies subscribers on effectsConfig change', () => {
      const configs: (EffectsConfig | null)[] = [];
      const unsub = trackStore.subscribe((state) => {
        configs.push(state.effectsConfig);
      });

      trackStore.getState().setEffectsConfig(makeEffectsConfig({ backgroundBrightness: 0.3 }));
      trackStore.getState().setEffectsConfig(makeEffectsConfig({ backgroundBrightness: 0.7 }));

      expect(configs).toHaveLength(2);
      expect(configs[0]!.backgroundBrightness).toBe(0.3);
      expect(configs[1]!.backgroundBrightness).toBe(0.7);

      unsub();
    });

    it('notifies subscribers on track switch', () => {
      const trackIds: (string | null)[] = [];
      const unsub = trackStore.subscribe((state) => {
        trackIds.push(state.trackId);
      });

      trackStore.getState().setTrack('track-1', null);
      trackStore.getState().setTrack('track-2', null);

      expect(trackIds).toEqual(['track-1', 'track-2']);

      unsub();
    });

    it('notifies subscribers on videoClips change', () => {
      const clipCounts: number[] = [];
      const unsub = trackStore.subscribe((state) => {
        clipCounts.push(state.videoClips.length);
      });

      trackStore.getState().setVideoClips([makeVideoClip()]);
      trackStore.getState().setVideoClips([makeVideoClip(), makeVideoClip({ id: 'clip-2' })]);

      expect(clipCounts).toEqual([1, 2]);

      unsub();
    });
  });
});

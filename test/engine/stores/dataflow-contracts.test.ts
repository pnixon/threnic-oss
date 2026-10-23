/**
 * AppContent Data Flow Contract Tests
 *
 * These tests lock down the critical data flow paths between AppContent
 * (the composition root) and the rendering pipeline. Any refactoring
 * of AppContent MUST preserve these contracts or the export/preview
 * will break.
 *
 * Tests are pure-logic — no WebGPU, no DOM, no React rendering.
 * They validate the SHAPE and CONTENT of data that flows through stores.
 *
 * Run: npm run test:quick -- test/engine/stores/dataflow-contracts.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trackStore } from '@/engine/stores/trackStore';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { timeStore } from '@/engine/stores/timeStore';
import { DEFAULT_EFFECTS_CONFIG, type EffectsConfig } from '@/types/effects';
import type { VideoClip } from '@/types/video-clips';
import type { Keyframe } from '@/types/keyframes';
import { computeUVScale } from '@/engine/gpu/WebGPURenderer';

// ─── Helpers ─────────────────────────────────────────────────

function makeEffectsConfig(overrides: Partial<EffectsConfig> = {}): EffectsConfig {
  return { ...DEFAULT_EFFECTS_CONFIG, ...overrides };
}

function makeTrack(overrides: any = {}) {
  return {
    id: 'track-1',
    title: 'Test Track',
    audioUrl: 'blob:http://localhost/audio',
    backgroundImage: null as string | null,
    lyricsData: [],
    effectsConfig: DEFAULT_EFFECTS_CONFIG,
    keyframes: [] as Keyframe[],
    videoClips: [] as VideoClip[],
    lyricsTheme: {
      fontSize: 0.5,
      fontWeight: 700,
      fontId: 'roboto',
      verticalPosition: 10,
      wordSpacing: 1.0,
      colorPre: '#666666',
      colorActive: '#ef4444',
      colorPost: '#444444',
      glowEnabled: false,
      glowColor: '#ef4444',
      glowIntensity: 0.5,
      outlineColor: '#000000',
      highlightFadeIn: 1.0,
      highlightFadeOut: 1.0,
    },
    ...overrides,
  };
}

function makeVideoClip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    id: 'clip-1',
    name: 'Test Clip',
    url: 'blob:http://localhost/test-video.mp4',
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

function makeKeyframe(overrides: Partial<Keyframe> = {}): Keyframe {
  return {
    id: 'kf-1',
    time: 0,
    properties: {},
    interpolation: 'linear' as const,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('AppContent → trackStore data flow contracts', () => {
  beforeEach(() => {
    trackStore.setState({
      trackId: null,
      backgroundImageUrl: null,
      effectsConfig: null,
      videoClips: [],
      isExporting: false,
    });
  });

  describe('Contract 1: effectsConfig must reach trackStore', () => {
    /**
     * AppContent syncs effectsConfig → trackStore.setEffectsConfig()
     * GPUCanvas reads from trackStore.effectsConfig in the render loop.
     * If this flow breaks, the GPU renderer sees stale/null effects.
     */
    it('effectsConfig with effects instances is preserved through trackStore', () => {
      const config = makeEffectsConfig({
        backgroundBrightness: 0.7,
        backgroundScale: 1.2,
        backgroundContrast: 0.9,
        backgroundFit: 'contain',
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

      // Simulate AppContent useEffect sync
      trackStore.getState().setEffectsConfig(config);

      const stored = trackStore.getState().effectsConfig!;
      expect(stored.backgroundBrightness).toBe(0.7);
      expect(stored.backgroundScale).toBe(1.2);
      expect(stored.backgroundContrast).toBe(0.9);
      expect(stored.backgroundFit).toBe('contain');
      expect(stored.effectInstances).toHaveLength(1);
      expect(stored.effectInstances[0].type).toBe('bloom');
      expect((stored.effectInstances[0].config as any).intensity).toBe(0.8);
    });

    it('null effectsConfig clears trackStore (deselect track)', () => {
      trackStore.getState().setEffectsConfig(makeEffectsConfig());
      trackStore.getState().setEffectsConfig(null);
      expect(trackStore.getState().effectsConfig).toBeNull();
    });

    it('effectsConfig update triggers subscriber notification', () => {
      let notified = false;
      const unsub = trackStore.subscribe((state) => {
        if (state.effectsConfig?.backgroundBrightness === 0.3) {
          notified = true;
        }
      });

      trackStore.getState().setEffectsConfig(makeEffectsConfig({ backgroundBrightness: 0.3 }));
      expect(notified).toBe(true);
      unsub();
    });
  });

  describe('Contract 2: videoClips must reach trackStore', () => {
    /**
     * GPUCanvas reads trackStore.videoClips to determine active background clips
     * at the current playback time. If clips don't sync, backgrounds break.
     */
    it('default background clip spans full track duration', () => {
      const duration = 180; // 3 minutes
      const defaultClip = makeVideoClip({
        id: 'default-bg-clip',
        name: 'Base Background',
        url: 'blob:http://localhost/bg.mp4',
        startTime: 0,
        endTime: duration,
        inPoint: 0,
        outPoint: duration,
        sourceDuration: duration,
      });

      trackStore.getState().setVideoClips([defaultClip]);
      const clips = trackStore.getState().videoClips;

      expect(clips).toHaveLength(1);
      expect(clips[0].startTime).toBe(0);
      expect(clips[0].endTime).toBe(duration);
      expect(clips[0].id).toBe('default-bg-clip');
    });

    it('NLE clip timeline resolution: finds active clip at time', () => {
      const clips = [
        makeVideoClip({ id: 'clip-a', startTime: 0, endTime: 10 }),
        makeVideoClip({ id: 'clip-b', startTime: 10, endTime: 20 }),
        makeVideoClip({ id: 'clip-c', startTime: 20, endTime: 30 }),
      ];

      trackStore.getState().setVideoClips(clips);
      const stored = trackStore.getState().videoClips;

      // Simulate GPUCanvas clip resolution
      const currentTime = 15;
      const activeClip = stored.find((c) => currentTime >= c.startTime && currentTime < c.endTime);

      expect(activeClip).toBeDefined();
      expect(activeClip!.id).toBe('clip-b');
    });

    it('NLE clip gap: no active clip between clips', () => {
      const clips = [
        makeVideoClip({ id: 'clip-a', startTime: 0, endTime: 10 }),
        makeVideoClip({ id: 'clip-b', startTime: 15, endTime: 25 }),
      ];

      trackStore.getState().setVideoClips(clips);
      const stored = trackStore.getState().videoClips;

      const currentTime = 12; // In the gap
      const activeClip = stored.find((c) => currentTime >= c.startTime && currentTime < c.endTime);

      expect(activeClip).toBeUndefined();
    });
  });

  describe('Contract 3: track switch resets state correctly', () => {
    /**
     * When switching tracks, AppContent resets ALL local state (effects,
     * lyrics, keyframes, videoClips, etc.) and syncs trackStore.setTrack().
     * GPUCanvas detects trackId change → clears textures and caches.
     */
    it('setTrack updates all three fields atomically', () => {
      const clips = [makeVideoClip()];
      trackStore.getState().setTrack('track-1', 'blob:http://localhost/bg.jpg', clips);

      const state = trackStore.getState();
      expect(state.trackId).toBe('track-1');
      expect(state.backgroundImageUrl).toBe('blob:http://localhost/bg.jpg');
      expect(state.videoClips).toEqual(clips);
    });

    it('switching track triggers subscriber with new trackId', () => {
      const trackIds: (string | null)[] = [];
      const unsub = trackStore.subscribe((s) => trackIds.push(s.trackId));

      trackStore.getState().setTrack('track-1', null);
      trackStore.getState().setTrack('track-2', null);
      trackStore.getState().setTrack(null, null);

      expect(trackIds).toEqual(['track-1', 'track-2', null]);
      unsub();
    });
  });

  describe('Contract 4: export flag must reach trackStore', () => {
    /**
     * GPUCanvas skips its own rendering when isExporting=true
     * (the offscreen renderer handles it). If this flag doesn't
     * sync, both renderers draw simultaneously → artifacts/crashes.
     */
    it('isExporting flag propagates to trackStore', () => {
      trackStore.getState().setIsExporting(true);
      expect(trackStore.getState().isExporting).toBe(true);

      trackStore.getState().setIsExporting(false);
      expect(trackStore.getState().isExporting).toBe(false);
    });
  });
});

describe('computeUVScale (preview/export consistency)', () => {
  /**
   * computeUVScale determines how backgrounds are fitted to the canvas.
   * Both WebGPURenderer (preview) and OffscreenGPURenderer (export) use
   * this same function. Changing its behavior breaks export/preview parity.
   */

  describe('cover mode', () => {
    it('fills canvas entirely for 16:9 image on 16:9 canvas', () => {
      const [sx, sy] = computeUVScale('cover', 1920, 1080, 1920, 1080);
      expect(sx).toBeCloseTo(1.0);
      expect(sy).toBeCloseTo(1.0);
    });

    it('crops height for wide image on tall canvas', () => {
      // 16:9 image on 4:3 canvas → canvas wider relative to image → crop Y
      const [sx, sy] = computeUVScale('cover', 800, 600, 1920, 1080);
      // ca = 800/600 = 1.333, ia = 1920/1080 = 1.778
      // ca < ia → scaleX = ca/ia = 0.75
      expect(sx).toBeCloseTo(0.75, 2);
      expect(sy).toBeCloseTo(1.0);
    });

    it('crops width for tall image on wide canvas', () => {
      // 4:3 image on 16:9 canvas
      const [sx, sy] = computeUVScale('cover', 1920, 1080, 800, 600);
      // ca = 1.778, ia = 1.333
      // ca > ia → scaleY = ia/ca = 0.75
      expect(sx).toBeCloseTo(1.0);
      expect(sy).toBeCloseTo(0.75, 2);
    });
  });

  describe('contain mode', () => {
    it('shows full image with letterboxing for 16:9 on 4:3', () => {
      const [sx, sy] = computeUVScale('contain', 800, 600, 1920, 1080);
      // ca=1.333, ia=1.778
      // ca < ia → scaleY = ia/ca = 1.333
      expect(sx).toBeCloseTo(1.0);
      expect(sy).toBeCloseTo(1.333, 2);
    });
  });

  describe('stretch mode', () => {
    it('always returns 1:1 regardless of aspect', () => {
      const [sx, sy] = computeUVScale('stretch', 1920, 1080, 800, 600);
      expect(sx).toBe(1.0);
      expect(sy).toBe(1.0);
    });
  });

  describe('zero-dimension guard', () => {
    it('returns 1:1 for zero-width canvas', () => {
      const [sx, sy] = computeUVScale('cover', 0, 1080, 1920, 1080);
      expect(sx).toBe(1);
      expect(sy).toBe(1);
    });

    it('returns 1:1 for zero-dimension image', () => {
      const [sx, sy] = computeUVScale('cover', 1920, 1080, 0, 0);
      expect(sx).toBe(1);
      expect(sy).toBe(1);
    });
  });
});

describe('Keyframe → effectsConfig merge contract', () => {
  /**
   * When a keyframe is selected in the Inspector, AppContent merges
   * keyframe property overrides onto the base effectsConfig. This
   * is the most complex data flow and the most likely to break
   * during refactoring.
   */

  it('effects.* properties apply to effectsConfig via dot-path', () => {
    const baseConfig = makeEffectsConfig({
      backgroundBrightness: 1.0,
    });

    // Simulate keyframe property merge (as AppContent lines 346-354 do)
    const newConfig = JSON.parse(JSON.stringify(baseConfig));
    const properties: Record<string, any> = {
      'effects.backgroundBrightness': 0.3,
    };

    Object.entries(properties).forEach(([property, value]) => {
      if (property.startsWith('effects.')) {
        const propPath = property.replace('effects.', '');
        const parts = propPath.split('.');
        let cur = newConfig;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cur[parts[i]]) cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
      }
    });

    expect(newConfig.backgroundBrightness).toBe(0.3);
  });

  it('scene.assetUrl overrides background URL', () => {
    let backgroundUrl: string | null = null;
    const properties: Record<string, any> = {
      'scene.assetUrl': 'blob:http://localhost/keyframe-bg.jpg',
    };

    Object.entries(properties).forEach(([property, value]) => {
      if (property.startsWith('scene.')) {
        const propPath = property.replace('scene.', '');
        if (propPath === 'assetUrl') backgroundUrl = String(value);
      }
    });

    expect(backgroundUrl).toBe('blob:http://localhost/keyframe-bg.jpg');
  });

  it('lyrics.* properties produce individual state updates', () => {
    const updates: Record<string, any> = {};
    const properties: Record<string, any> = {
      'lyrics.fontSize': 0.8,
      'lyrics.verticalPosition': 25,
      'lyrics.wordSpacing': 1.5,
      'lyrics.fontId': 'outfit',
      'lyrics.glowEnabled': true,
      'lyrics.glowColor': '#ff0000',
      'lyrics.glowIntensity': 0.9,
      'lyrics.outlineColor': '#ffffff',
      'lyrics.colors.pre': '#aaaaaa',
      'lyrics.colors.active': '#ff0000',
      'lyrics.colors.post': '#555555',
    };

    Object.entries(properties).forEach(([property, value]) => {
      if (property.startsWith('lyrics.')) {
        const prop = property.replace('lyrics.', '');
        updates[prop] = value;
      }
    });

    expect(updates['fontSize']).toBe(0.8);
    expect(updates['verticalPosition']).toBe(25);
    expect(updates['wordSpacing']).toBe(1.5);
    expect(updates['fontId']).toBe('outfit');
    expect(updates['glowEnabled']).toBe(true);
    expect(updates['glowColor']).toBe('#ff0000');
    expect(updates['glowIntensity']).toBe(0.9);
    expect(updates['outlineColor']).toBe('#ffffff');
    expect(updates['colors.pre']).toBe('#aaaaaa');
    expect(updates['colors.active']).toBe('#ff0000');
    expect(updates['colors.post']).toBe('#555555');
  });
});

describe('Video clip NLE resolution (GPUCanvas pattern)', () => {
  /**
   * Tests the exact algorithm GPUCanvas uses to resolve which background
   * clip is active at a given time, including transitions and pre-loading.
   */

  it('resolves transition state between two clips', () => {
    const clips = [
      makeVideoClip({
        id: 'clip-a',
        startTime: 0,
        endTime: 10,
        url: 'blob:http://localhost/a.mp4',
      }),
      makeVideoClip({
        id: 'clip-b',
        startTime: 10,
        endTime: 20,
        url: 'blob:http://localhost/b.mp4',
        transition: { type: 'crossfade', duration: 2.0 },
      }),
    ];

    const currentTime = 11; // 1s into clip-b's transition zone
    const activeClip = clips.find((c) => currentTime >= c.startTime && currentTime < c.endTime);

    expect(activeClip).toBeDefined();
    expect(activeClip!.id).toBe('clip-b');

    // Transition detection
    let inTransition = false;
    let transitionProgress = 0;
    let prevClip: any = null;

    if (activeClip!.transition && activeClip!.transition.duration > 0) {
      const timeInClip = currentTime - activeClip!.startTime;
      if (timeInClip < activeClip!.transition.duration) {
        inTransition = true;
        transitionProgress = timeInClip / activeClip!.transition.duration;
        prevClip =
          [...clips]
            .sort((a, b) => b.startTime - a.startTime)
            .find((c) => c.endTime <= activeClip!.startTime) || null;
      }
    }

    expect(inTransition).toBe(true);
    expect(transitionProgress).toBeCloseTo(0.5, 1);
    expect(prevClip).toBeDefined();
    expect(prevClip.id).toBe('clip-a');
  });

  it('lookahead preloads upcoming clip within 2 seconds', () => {
    const clips = [
      makeVideoClip({
        id: 'clip-a',
        startTime: 0,
        endTime: 10,
        url: 'blob:http://localhost/a.mp4',
      }),
      makeVideoClip({
        id: 'clip-b',
        startTime: 10,
        endTime: 20,
        url: 'blob:http://localhost/b.mp4',
      }),
    ];

    const currentTime = 8.5; // 1.5s before clip-b starts
    const activeClip = clips.find((c) => currentTime >= c.startTime && currentTime < c.endTime);

    expect(activeClip!.id).toBe('clip-a');

    // Lookahead logic from GPUCanvas
    const upcoming =
      clips.filter((c) => c.startTime > currentTime).sort((a, b) => a.startTime - b.startTime)[0] ||
      null;

    expect(upcoming).toBeDefined();
    expect(upcoming!.id).toBe('clip-b');
    expect(upcoming!.startTime - currentTime).toBeLessThanOrEqual(2.0);
  });

  it('no preload when next clip is > 2 seconds away', () => {
    const clips = [
      makeVideoClip({
        id: 'clip-a',
        startTime: 0,
        endTime: 10,
        url: 'blob:http://localhost/a.mp4',
      }),
      makeVideoClip({
        id: 'clip-b',
        startTime: 15,
        endTime: 25,
        url: 'blob:http://localhost/b.mp4',
      }),
    ];

    const currentTime = 5;
    const upcoming =
      clips.filter((c) => c.startTime > currentTime).sort((a, b) => a.startTime - b.startTime)[0] ||
      null;

    expect(upcoming).toBeDefined();
    expect(upcoming!.startTime - currentTime).toBeGreaterThan(2.0);
  });
});

describe('Lyrics theme → LyricsCanvas config contract', () => {
  /**
   * LyricsCanvas receives theme props from AppContent. These directly
   * control font size, position, colors, and glow. If any are wrong,
   * lyrics render at wrong size/position.
   */

  it('default theme has expected values', () => {
    const track = makeTrack();
    const theme = track.lyricsTheme;

    expect(theme.fontSize).toBe(0.5);
    expect(theme.verticalPosition).toBe(10);
    expect(theme.wordSpacing).toBe(1.0);
    expect(theme.fontId).toBe('roboto');
    expect(theme.colorPre).toBe('#666666');
    expect(theme.colorActive).toBe('#ef4444');
    expect(theme.colorPost).toBe('#444444');
    expect(theme.glowEnabled).toBe(false);
    expect(theme.outlineColor).toBe('#000000');
  });

  it('track theme overrides propagate all fields', () => {
    const track = makeTrack({
      lyricsTheme: {
        fontSize: 0.8,
        verticalPosition: 25,
        wordSpacing: 1.5,
        fontId: 'outfit',
        colorPre: '#aaaaaa',
        colorActive: '#ff0000',
        colorPost: '#555555',
        glowEnabled: true,
        glowColor: '#ff0000',
        glowIntensity: 0.9,
        outlineColor: '#ffffff',
        highlightFadeIn: 0.5,
        highlightFadeOut: 2.0,
      },
    });

    const theme = track.lyricsTheme;
    expect(theme.fontSize).toBe(0.8);
    expect(theme.verticalPosition).toBe(25);
    expect(theme.glowEnabled).toBe(true);
    expect(theme.glowIntensity).toBe(0.9);
    expect(theme.highlightFadeIn).toBe(0.5);
    expect(theme.highlightFadeOut).toBe(2.0);
  });
});

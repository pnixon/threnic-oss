/**
 * useTrackEffectsState — Zustand-backed effects/keyframes/videoClips/background.
 *
 * Reads directly from projectStore via useSyncExternalStore.
 * Applies migrations on read. Setters write imperatively to projectStore.
 * Syncs rendering-relevant state to trackStore (engine) via subscription.
 */

import { useCallback, useMemo, useSyncExternalStore, useEffect, useRef } from 'react';
import { projectStore } from '@/stores/projectStore';
import { trackStore } from '@/engine/stores/trackStore';
import type { EffectsConfig } from '@/types/effects';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import type { Keyframe } from '@/types/keyframes';
import { migrateKeyframes } from '@/types/keyframes';
import type { VideoClip } from '@/types/video-clips';
import { migrateLegacyEffects } from '@/utils/effects-migration';
import { safeStringify } from '@/utils';
import { useKeyframeSelection } from '@/contexts';

// ── Store subscription ──
const subscribe = projectStore.subscribe;

function getEffectsConfigSnapshot(): EffectsConfig | undefined {
  const s = projectStore.getState();
  const track = s.tracks.find((t) => t.id === s.selectedTrackId);
  return track?.effectsConfig;
}

function getKeyframesSnapshot(): Keyframe[] | undefined {
  const s = projectStore.getState();
  const track = s.tracks.find((t) => t.id === s.selectedTrackId);
  return track?.keyframes;
}

function getVideoClipsSnapshot(): VideoClip[] | undefined {
  const s = projectStore.getState();
  const track = s.tracks.find((t) => t.id === s.selectedTrackId);
  return track?.videoClips;
}

function getBackgroundSnapshot(): string | undefined {
  const s = projectStore.getState();
  const track = s.tracks.find((t) => t.id === s.selectedTrackId);
  return track?.backgroundImage;
}

function getTrackIdSnapshot(): string | null {
  return projectStore.getState().selectedTrackId;
}

// ── Sentinel for empty arrays (stable references) ──
const EMPTY_KEYFRAMES: Keyframe[] = [];
const EMPTY_CLIPS: VideoClip[] = [];

interface TrackEffectsState {
  // ── Values (from store, migrated) ──
  /** Base effects config (migrated, no keyframe overrides) */
  baseEffectsConfig: EffectsConfig;
  /** Effective effects config (base + selected keyframe overrides for UI display) */
  effectsConfig: EffectsConfig;
  /** Migrated keyframes */
  keyframes: Keyframe[];
  /** Video clips */
  videoClips: VideoClip[];
  /** Background image URL */
  backgroundImage: string | null;
  /** Effective background (may be overridden by selected keyframe) */
  effectiveBackground: string | null;
  /** Base track config for renderer (migrated base + background merged) */
  baseTrackConfig: EffectsConfig & { backgroundImage: string | null };

  // ── Setters ──
  setEffectsConfig: (config: EffectsConfig) => void;
  handleEffectsChange: (config: EffectsConfig, clearKeyframes?: boolean) => void;
  handleBackgroundChange: (url: string | null, path?: string, forceGlobal?: boolean) => void;
  handleVideoClipsUpdate: (clips: VideoClip[] | ((prev: VideoClip[]) => VideoClip[])) => void;
  setKeyframes: React.Dispatch<React.SetStateAction<Keyframe[]>>;
  setLocalBackgroundUrl: (url: string | null) => void;
  setVideoClips: React.Dispatch<React.SetStateAction<VideoClip[]>>;
  setLocalEffectsConfig: React.Dispatch<React.SetStateAction<EffectsConfig>>;
}

interface UseTrackEffectsOptions {
  /** Current audio duration (for video clip auto-creation) */
  duration: number;
}

export function useTrackEffectsState({ duration }: UseTrackEffectsOptions): TrackEffectsState {
  // ── Read raw data from store ──
  const rawEffectsConfig = useSyncExternalStore(
    subscribe,
    getEffectsConfigSnapshot,
    getEffectsConfigSnapshot,
  );
  const rawKeyframes = useSyncExternalStore(subscribe, getKeyframesSnapshot, getKeyframesSnapshot);
  const rawVideoClips = useSyncExternalStore(
    subscribe,
    getVideoClipsSnapshot,
    getVideoClipsSnapshot,
  );
  const rawBackground = useSyncExternalStore(
    subscribe,
    getBackgroundSnapshot,
    getBackgroundSnapshot,
  );
  const trackId = useSyncExternalStore(subscribe, getTrackIdSnapshot, getTrackIdSnapshot);

  const { selectedKeyframeId } = useKeyframeSelection();

  // ── Migrate on read (idempotent) ──
  const { baseEffectsConfig, migratedKeyframes } = useMemo(() => {
    const raw = rawEffectsConfig
      ? {
          ...DEFAULT_EFFECTS_CONFIG,
          ...rawEffectsConfig,
          trackTitle: {
            ...DEFAULT_EFFECTS_CONFIG.trackTitle,
            ...(rawEffectsConfig.trackTitle || {}),
          },
        }
      : DEFAULT_EFFECTS_CONFIG;

    const { config, keyframes: kfs } = migrateLegacyEffects(raw, rawKeyframes ?? undefined);
    return {
      baseEffectsConfig: config,
      migratedKeyframes: kfs.length > 0 ? migrateKeyframes(kfs) : EMPTY_KEYFRAMES,
    };
  }, [rawEffectsConfig, rawKeyframes]);

  const videoClips = rawVideoClips ?? EMPTY_CLIPS;
  const backgroundImage = rawBackground ?? null;

  // ── Effective config: base + selected keyframe overrides (for Inspector UI) ──
  const effectsConfig = useMemo(() => {
    if (!selectedKeyframeId || selectedKeyframeId === 'default') {
      return baseEffectsConfig;
    }
    const kf = migratedKeyframes.find((k) => k.id === selectedKeyframeId);
    if (!kf) return baseEffectsConfig;

    const computed = JSON.parse(safeStringify(baseEffectsConfig));
    for (const [key, value] of Object.entries(kf.properties)) {
      if (key.startsWith('effects.')) {
        const propPath = key.replace('effects.', '');
        const parts = propPath.split('.');
        let cur = computed;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cur[parts[i]]) cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
      } else if (key.startsWith('scene.') && key !== 'scene.assetUrl') {
        const propPath = key.replace('scene.', '');
        computed[propPath] = value;
      }
    }
    return computed;
  }, [baseEffectsConfig, selectedKeyframeId, migratedKeyframes]);

  // ── Effective background (may be overridden by selected keyframe) ──
  const effectiveBackground = useMemo(() => {
    if (!selectedKeyframeId || selectedKeyframeId === 'default') {
      return backgroundImage;
    }
    const kf = migratedKeyframes.find((k) => k.id === selectedKeyframeId);
    if (!kf) return backgroundImage;
    const assetUrl = kf.properties['scene.assetUrl'];
    return assetUrl !== undefined ? String(assetUrl) : backgroundImage;
  }, [backgroundImage, selectedKeyframeId, migratedKeyframes]);

  // ── Base track config for renderer ──
  const baseTrackConfig = useMemo(
    () =>
      ({
        ...baseEffectsConfig,
        backgroundImage,
      }) as EffectsConfig & { backgroundImage: string | null },
    [baseEffectsConfig, backgroundImage],
  );

  // ── Sync to trackStore (engine) ──
  // Sync track identity + background + videoClips
  useEffect(() => {
    trackStore.getState().setTrack(trackId, backgroundImage, videoClips);
  }, [trackId, backgroundImage, videoClips]);

  // Sync effective effects config to trackStore for rendering
  useEffect(() => {
    trackStore.getState().setEffectsConfig(effectsConfig);
  }, [effectsConfig]);

  // ── Video clip auto-creation ──
  const firstSlideshowUrl = baseEffectsConfig?.slideshow?.items?.[0]?.url;
  const videoBgUrl =
    baseEffectsConfig?.video?.enabled && baseEffectsConfig?.video?.url
      ? baseEffectsConfig.video.url
      : null;
  const bgUrl = backgroundImage || firstSlideshowUrl || videoBgUrl || '';
  const bgName = backgroundImage
    ? 'Base Background'
    : firstSlideshowUrl || videoBgUrl
      ? 'Track Background'
      : '';

  const tracksRef = useRef(projectStore.getState().tracks);
  useEffect(() => {
    tracksRef.current = projectStore.getState().tracks;
  });

  useEffect(() => {
    if (duration <= 0 || !trackId) return;
    const state = projectStore.getState();
    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) return;

    if (track.videoClips === undefined || track.videoClips.length === 0) {
      // Only create a default clip if there's an actual background URL
      if (bgUrl) {
        const defaultClip: VideoClip = {
          id: 'default-bg-clip',
          name: bgName,
          url: bgUrl,
          startTime: 0,
          endTime: duration,
          inPoint: 0,
          outPoint: duration,
          sourceDuration: duration,
          speed: 1.0,
          behavior: 'loop',
          opacity: 1.0,
          scale: 1.0,
          brightness: 1.0,
          offsetX: 0,
          offsetY: 0,
        };
        state.updateTrackVideoClips(trackId, [defaultClip]);
        trackStore.getState().setVideoClips([defaultClip]);
      }
    } else if (track.videoClips.length === 1) {
      const existing = track.videoClips[0];
      // If the existing clip has a dead URL, remove it entirely
      if (
        existing.id === 'default-bg-clip' &&
        (!existing.url || existing.url.includes('gtv-videos-bucket'))
      ) {
        state.updateTrackVideoClips(trackId, []);
        trackStore.getState().setVideoClips([]);
      } else if (
        bgUrl &&
        existing.startTime === 0 &&
        (existing.url !== bgUrl || Math.abs(existing.endTime - duration) > 0.1)
      ) {
        const updatedClip = {
          ...existing,
          name: existing.id === 'default-bg-clip' ? bgName : existing.name,
          url: bgUrl,
          endTime: duration,
          outPoint: duration,
          sourceDuration: duration,
        };
        state.updateTrackVideoClips(trackId, [updatedClip]);
        trackStore.getState().setVideoClips([updatedClip]);
      }
    }
  }, [duration, trackId, bgUrl, bgName]);

  // ── Setters ──

  /** Write full effects config to store (default keyframe mode) */
  const setEffectsConfig = useCallback(
    (config: EffectsConfig) => {
      if (!trackId) return;
      projectStore.getState().updateTrackEffects(trackId, config);
    },
    [trackId],
  );

  /** Keyframe-aware effects change handler */
  const handleEffectsChange = useCallback(
    (newConfig: EffectsConfig, clearKeyframes?: boolean) => {
      if (!trackId) return;
      const state = projectStore.getState();
      const isKeyframeMode = selectedKeyframeId && selectedKeyframeId !== 'default';

      if (isKeyframeMode && !clearKeyframes) {
        // In keyframe mode: only update effectInstances on base config,
        // preserving base 'enabled' state
        const track = state.tracks.find((t) => t.id === trackId);
        const baseConfig = track?.effectsConfig ?? DEFAULT_EFFECTS_CONFIG;
        const baseInstances = baseConfig.effectInstances || [];

        const mergedInstances = (newConfig.effectInstances || []).map((incoming) => {
          const baseInstance = baseInstances.find((b) => b.id === incoming.id);
          if (baseInstance) {
            return {
              ...incoming,
              config: {
                ...incoming.config,
                enabled: baseInstance.config.enabled,
              },
            };
          }
          return incoming;
        });

        const safeUpdate: EffectsConfig = {
          ...baseConfig,
          effectInstances: mergedInstances as EffectsConfig['effectInstances'],
        };
        state.updateTrackEffects(trackId, safeUpdate);
      } else {
        // Default keyframe: update the full base config
        state.updateTrackEffects(trackId, newConfig);

        if (clearKeyframes) {
          const track = state.tracks.find((t) => t.id === trackId);
          const currentKfs = track?.keyframes ?? [];
          const nextKfs = currentKfs.map((kf) => {
            if (!kf.properties) return kf;
            const nextProps = { ...kf.properties };
            Object.keys(nextProps).forEach((key) => {
              if (key.startsWith('effects.')) {
                delete nextProps[key];
              }
            });
            return { ...kf, properties: nextProps };
          });
          state.updateTrackKeyframes(trackId, nextKfs);
        }
      }
    },
    [trackId, selectedKeyframeId],
  );

  /** Background change handler */
  const handleBackgroundChange = useCallback(
    (url: string | null, path?: string, forceGlobal?: boolean) => {
      if (!trackId) return;
      const state = projectStore.getState();

      if (selectedKeyframeId === 'default' || forceGlobal) {
        state.updateTrackBackground(trackId, url, path);

        if (forceGlobal) {
          // Clear video clips
          state.updateTrackVideoClips(trackId, []);
          trackStore.getState().setVideoClips([]);

          // Clear keyframe-level background URLs
          const track = state.tracks.find((t) => t.id === trackId);
          const currentKfs = track?.keyframes ?? [];
          const nextKfs = currentKfs.map((kf) => {
            if (!kf.properties) return kf;
            const nextProps = { ...kf.properties };
            delete nextProps['scene.assetUrl'];
            return { ...kf, properties: nextProps };
          });
          state.updateTrackKeyframes(trackId, nextKfs);
        }
      } else {
        // Non-default keyframe: write to keyframe properties
        const track = state.tracks.find((t) => t.id === trackId);
        const currentKfs = track?.keyframes ?? [];
        const nextKfs = currentKfs.map((kf) => {
          if (kf.id !== selectedKeyframeId) return kf;
          return {
            ...kf,
            properties: {
              ...kf.properties,
              'scene.assetUrl': url || '',
            },
          };
        });
        state.updateTrackKeyframes(trackId, nextKfs);
      }
    },
    [trackId, selectedKeyframeId],
  );

  /** Video clips update handler */
  const handleVideoClipsUpdate = useCallback(
    (newClips: VideoClip[] | ((prev: VideoClip[]) => VideoClip[])) => {
      if (!trackId) return;
      const state = projectStore.getState();
      const track = state.tracks.find((t) => t.id === trackId);
      const current = track?.videoClips ?? [];
      const next = typeof newClips === 'function' ? newClips(current) : newClips;
      state.updateTrackVideoClips(trackId, next);
      trackStore.getState().setVideoClips(next);

      if (next.length === 0) {
        state.updateTrackBackground(trackId, null);
        if (track?.effectsConfig) {
          const updatedEffects = {
            ...track.effectsConfig,
            slideshow: {
              ...track.effectsConfig.slideshow,
              items: [],
            },
            video: {
              ...track.effectsConfig.video,
              enabled: false,
              url: '',
            },
          };
          state.updateTrackEffects(trackId, updatedEffects);
        }
      }
    },
    [trackId],
  );

  // ── Compat setters (for components that still use React dispatch signature) ──
  const setKeyframes = useCallback(
    (action: Keyframe[] | ((prev: Keyframe[]) => Keyframe[])) => {
      if (!trackId) return;
      const state = projectStore.getState();
      const track = state.tracks.find((t) => t.id === trackId);
      const current = track?.keyframes ?? [];
      const next = typeof action === 'function' ? action(current) : action;
      state.updateTrackKeyframes(trackId, next);
    },
    [trackId],
  );

  const setVideoClips = useCallback(
    (action: VideoClip[] | ((prev: VideoClip[]) => VideoClip[])) => {
      if (!trackId) return;
      const state = projectStore.getState();
      const track = state.tracks.find((t) => t.id === trackId);
      const current = track?.videoClips ?? [];
      const next = typeof action === 'function' ? action(current) : action;
      state.updateTrackVideoClips(trackId, next);
      trackStore.getState().setVideoClips(next);

      if (next.length === 0) {
        state.updateTrackBackground(trackId, null);
        if (track?.effectsConfig) {
          const updatedEffects = {
            ...track.effectsConfig,
            slideshow: {
              ...track.effectsConfig.slideshow,
              items: [],
            },
            video: {
              ...track.effectsConfig.video,
              enabled: false,
              url: '',
            },
          };
          state.updateTrackEffects(trackId, updatedEffects);
        }
      }
    },
    [trackId],
  );

  const setLocalBackgroundUrl = useCallback(
    (url: string | null) => {
      if (!trackId) return;
      projectStore.getState().updateTrackBackground(trackId, url);
    },
    [trackId],
  );

  const setLocalEffectsConfig = useCallback(
    (action: EffectsConfig | ((prev: EffectsConfig) => EffectsConfig)) => {
      if (!trackId) return;
      const state = projectStore.getState();
      const track = state.tracks.find((t) => t.id === trackId);
      const current = track?.effectsConfig ?? DEFAULT_EFFECTS_CONFIG;
      const next = typeof action === 'function' ? action(current) : action;
      state.updateTrackEffects(trackId, next);
    },
    [trackId],
  );

  return {
    baseEffectsConfig,
    effectsConfig,
    keyframes: migratedKeyframes,
    videoClips,
    backgroundImage,
    effectiveBackground,
    baseTrackConfig,

    setEffectsConfig,
    handleEffectsChange,
    handleBackgroundChange,
    handleVideoClipsUpdate,
    setKeyframes,
    setLocalBackgroundUrl,
    setVideoClips,
    setLocalEffectsConfig,
  };
}

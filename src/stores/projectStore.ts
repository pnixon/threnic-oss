/**
 * projectStore — Zustand vanilla store for all project/playlist state.
 *
 * This is the single source of truth for tracks, selection, and settings.
 * Accessible from both React (via useStore) and the engine loop (via getState).
 *
 * Replaces: PlaylistContext useState, useTrackManagement, useTrackConfig,
 *           usePlaylistSettings (pure-sync parts only).
 */

import { createStore } from 'zustand/vanilla';
import type { Track } from '@/contexts/types';
import type { PlaylistSettings } from '@/types/project';
import type { LyricLineData, LyricTheme } from '@/types/lyrics';
import type { EffectsConfig, TrackTitleConfig } from '@/types/effects';
import type { Keyframe } from '@/types/keyframes';
import type { VideoClip } from '@/types/video-clips';
import { sortKeyframes } from '@/types/keyframes';
import { resolveWritableKeyframeId, resolveWritableKeyframeIdMulti } from '@/utils/keyframes';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import { DEFAULT_LYRICS_THEME } from '@/types/lyrics';
import { migrateLegacyEffects } from '@/utils/effects-migration';
import { syncBaseProperty, syncBaseEffectInstance } from '@/contexts/PlaylistHooks/utils';
import {
  generateTrackId,
  getTrackNameFromFile,
  getAudioDuration,
  revokeBlobUrl,
  shuffleArray,
} from '@/contexts/utils';
import { createLogger } from '@/utils/logger';
import { timeStore } from '@/engine/stores/timeStore';

const logger = createLogger({ enabled: true, prefix: 'ProjectStore' });
const SWITCH_COOLDOWN = 1000;

// ── State ────────────────────────────────────────────────────────────

export interface ProjectState {
  // Data
  tracks: Track[];
  selectedTrackId: string | null;
  isLoading: boolean;
  settings: PlaylistSettings;

  // ── Selectors ──
  getSelectedTrack: () => Track | null;
  getTrackById: (id: string) => Track | undefined;
  getPlaylistDuration: () => number;

  // ── Track Management ──
  addTrack: (file: File) => Promise<void>;
  addTrackFromUrl: (url: string, name: string) => Promise<void>;
  replaceTrackAudio: (id: string, file: File) => Promise<void>;
  removeTrack: (id: string) => void;
  selectTrack: (id: string | null) => void;
  selectNextTrack: (loop?: boolean) => void;
  selectPreviousTrack: (loop?: boolean) => void;
  renameTrack: (id: string, name: string) => void;
  reorderTracks: (fromIndex: number, toIndex: number) => void;
  shufflePlaylist: () => void;
  clearPlaylist: () => void;
  restorePlaylist: (tracks: Track[]) => void;

  // ── Track Config ──
  updateTrackLyrics: (id: string, lyrics: LyricLineData[], filePath?: string) => void;
  updateTrackBackground: (id: string, imageUrl: string | null, filePath?: string) => void;
  updateTrackEffects: (id: string, config: EffectsConfig) => void;
  updateTrackLyricsTheme: (id: string, theme: LyricTheme) => void;
  updateTrackKeyframes: (id: string, keyframes: Keyframe[]) => void;
  updateTrackVideoClips: (id: string, videoClips: VideoClip[]) => void;
  addTrackKeyframe: (trackId: string, kf: Keyframe) => void;
  removeTrackKeyframe: (trackId: string, kfId: string) => void;
  updateTrackProperty: (
    trackId: string,
    propertyPath: string,
    value: unknown,
    keyframeId?: string,
  ) => void;
  updateTrackEffectInstance: (
    trackId: string,
    instanceId: string,
    config: unknown,
    keyframeId?: string,
  ) => void;
  updateTrackFilePath: (id: string, type: 'audio' | 'lyrics' | 'background', path: string) => void;
  applyPresetLook: (
    trackId: string,
    params: {
      effectsConfig?: EffectsConfig;
      backgroundImageUrl?: string | null;
      backgroundImageFilePath?: string;
      lyricTheme?: Partial<LyricTheme>;
      clearEffectsKeyframes?: boolean;
      clearBackgroundKeyframes?: boolean;
      clearVideoClips?: boolean;
    },
  ) => void;

  // ── Playlist Settings / Bulk Ops ──
  updateSettings: (settings: Partial<PlaylistSettings>) => void;
  applyEffectsToAll: (config: EffectsConfig) => void;
  applyBackgroundToAll: (
    imageUrl: string | null,
    config?: EffectsConfig,
    filePath?: string,
  ) => void;
  applyThemeToAll: (theme: LyricTheme) => void;
  applyTrackTitleToAll: (config: TrackTitleConfig) => void;

  // ── Internal ──
  setIsLoading: (loading: boolean) => void;
  setSelectedTrackId: (id: string | null) => void;
}

// ── Cooldown tracker (module-scoped, not in store state) ──
let lastSwitchTime = 0;
function checkSwitchCooldown(): boolean {
  const now = Date.now();
  if (now - lastSwitchTime < SWITCH_COOLDOWN) {
    logger.debug('Track switch blocked by cooldown');
    return false;
  }
  lastSwitchTime = now;
  return true;
}
export function resetSwitchCooldownForTesting() {
  lastSwitchTime = 0;
}

// ── Helper: map a single track by ID ──
function mapTrack(tracks: Track[], id: string, fn: (t: Track) => Track): Track[] {
  return tracks.map((t) => (t.id === id ? fn(t) : t));
}

// ── Store ────────────────────────────────────────────────────────────

export const projectStore = createStore<ProjectState>((set, get) => ({
  // ── Initial state ──
  tracks: [],
  selectedTrackId: null,
  isLoading: false,
  settings: { autoNext: true },

  // ── Selectors ──
  getSelectedTrack: () => {
    const { tracks, selectedTrackId } = get();
    return tracks.find((t) => t.id === selectedTrackId) ?? null;
  },

  getTrackById: (id: string) => get().tracks.find((t) => t.id === id),

  getPlaylistDuration: () => get().tracks.reduce((acc, t) => acc + t.duration, 0),

  // ── Internal setters (exposed for useProjectIO compatibility) ──
  setIsLoading: (loading) => set({ isLoading: loading }),
  setSelectedTrackId: (id) => set({ selectedTrackId: id }),

  // ═══════════════════════════════════════════════════════════════════
  // Track Management (from useTrackManagement)
  // ═══════════════════════════════════════════════════════════════════

  addTrack: async (file: File) => {
    set({ isLoading: true });
    try {
      const audioUrl = URL.createObjectURL(file);
      const duration = await getAudioDuration(audioUrl);

      const newTrack: Track = {
        id: generateTrackId(),
        name: getTrackNameFromFile(file),
        duration,
        audioUrl,
        audioFile: file,
        audioFilePath: (file as unknown as { path: string }).path || file.name,
        keyframes: [],
        effectsConfig: { ...DEFAULT_EFFECTS_CONFIG },
        lyricsTheme: { ...DEFAULT_LYRICS_THEME },
      };

      set((state) => ({
        tracks: [...state.tracks, newTrack],
        selectedTrackId: state.selectedTrackId ?? newTrack.id,
      }));
    } catch (error) {
      logger.error('Failed to add track:', error as Error);
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  addTrackFromUrl: async (url: string, name: string) => {
    set({ isLoading: true });
    try {
      const duration = await getAudioDuration(url);

      const newTrack: Track = {
        id: generateTrackId(),
        name,
        duration,
        audioUrl: url,
        keyframes: [],
        effectsConfig: { ...DEFAULT_EFFECTS_CONFIG },
        lyricsTheme: { ...DEFAULT_LYRICS_THEME },
      };

      set((state) => ({
        tracks: [...state.tracks, newTrack],
        selectedTrackId: state.selectedTrackId ?? newTrack.id,
      }));
    } catch (error) {
      logger.error('Failed to add track from URL:', error as Error);
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  replaceTrackAudio: async (id: string, file: File) => {
    set({ isLoading: true });
    try {
      const audioUrl = URL.createObjectURL(file);
      const duration = await getAudioDuration(audioUrl);

      set((state) => ({
        tracks: mapTrack(state.tracks, id, (track) => {
          revokeBlobUrl(track.audioUrl);
          return {
            ...track,
            name: getTrackNameFromFile(file),
            duration,
            audioUrl,
            audioFile: file,
            audioFilePath: (file as unknown as { path: string }).path || file.name,
          };
        }),
      }));
    } catch (error) {
      logger.error('Failed to replace track audio:', error as Error);
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  removeTrack: (id: string) => {
    const { tracks, selectedTrackId } = get();
    const index = tracks.findIndex((t) => t.id === id);
    if (index === -1) return;

    let newSelectedId = selectedTrackId;
    if (selectedTrackId === id) {
      if (tracks.length <= 1) {
        newSelectedId = null;
      } else if (index < tracks.length - 1) {
        newSelectedId = tracks[index + 1].id;
      } else {
        newSelectedId = tracks[index - 1].id;
      }
    }

    const track = tracks[index];
    revokeBlobUrl(track.audioUrl);
    revokeBlobUrl(track.backgroundImage);

    // Revoke slideshow item blobs
    track.effectsConfig?.slideshow?.items?.forEach((item) => {
      if (item.url?.startsWith('blob:')) {
        revokeBlobUrl(item.url);
      }
    });

    // Revoke video clip blobs
    track.videoClips?.forEach((clip) => {
      if (clip.url?.startsWith('blob:')) {
        revokeBlobUrl(clip.url);
      }
    });

    set({
      tracks: tracks.filter((t) => t.id !== id),
      selectedTrackId: newSelectedId,
    });
  },

  selectTrack: (id: string | null) => {
    if (id === get().selectedTrackId) return;
    if (!checkSwitchCooldown()) return;
    set({ selectedTrackId: id });
  },

  selectNextTrack: (loop = true) => {
    if (!checkSwitchCooldown()) return;
    const { tracks, selectedTrackId } = get();
    if (tracks.length === 0) return;
    const currentIndex = tracks.findIndex((t) => t.id === selectedTrackId);
    if (!loop && currentIndex === tracks.length - 1) return;
    const nextIndex = (currentIndex + 1) % tracks.length;
    set({ selectedTrackId: tracks[nextIndex].id });
  },

  selectPreviousTrack: (loop = true) => {
    if (!checkSwitchCooldown()) return;
    const { tracks, selectedTrackId } = get();
    if (tracks.length === 0) return;
    const currentIndex = tracks.findIndex((t) => t.id === selectedTrackId);
    if (!loop && currentIndex === 0) return;
    const prevIndex = currentIndex <= 0 ? tracks.length - 1 : currentIndex - 1;
    set({ selectedTrackId: tracks[prevIndex].id });
  },

  renameTrack: (id: string, name: string) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => ({ ...t, name })),
    }));
  },

  reorderTracks: (fromIndex: number, toIndex: number) => {
    set((state) => {
      const result = [...state.tracks];
      const [removed] = result.splice(fromIndex, 1);
      result.splice(toIndex, 0, removed);
      return { tracks: result };
    });
  },

  shufflePlaylist: () => {
    set((state) => ({ tracks: shuffleArray(state.tracks) }));
  },

  clearPlaylist: () => {
    get().tracks.forEach((track) => {
      revokeBlobUrl(track.audioUrl);
      revokeBlobUrl(track.backgroundImage);
      track.effectsConfig?.slideshow?.items?.forEach((item) => {
        if (item.url?.startsWith('blob:')) revokeBlobUrl(item.url);
      });
      track.videoClips?.forEach((clip) => {
        if (clip.url?.startsWith('blob:')) revokeBlobUrl(clip.url);
      });
    });
    set({ tracks: [], selectedTrackId: null });
  },

  restorePlaylist: (newTracks: Track[]) => {
    const { tracks: oldTracks } = get();
    oldTracks.forEach((t) => {
      revokeBlobUrl(t.audioUrl);
      revokeBlobUrl(t.backgroundImage);
      t.effectsConfig?.slideshow?.items?.forEach((item) => {
        if (item.url?.startsWith('blob:')) revokeBlobUrl(item.url);
      });
      t.videoClips?.forEach((clip) => {
        if (clip.url?.startsWith('blob:')) revokeBlobUrl(clip.url);
      });
    });
    set({
      tracks: newTracks,
      selectedTrackId: newTracks.length > 0 ? newTracks[0].id : null,
    });
  },

  // ═══════════════════════════════════════════════════════════════════
  // Track Config (from useTrackConfig)
  // ═══════════════════════════════════════════════════════════════════

  updateTrackLyrics: (id, lyrics, filePath?) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => ({
        ...t,
        lyricsData: lyrics,
        lyricsFilePath: filePath,
      })),
    }));
  },

  updateTrackBackground: (id, imageUrl, filePath?) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => {
        if (t.backgroundImage !== imageUrl) {
          revokeBlobUrl(t.backgroundImage);
        }
        return {
          ...t,
          backgroundImage: imageUrl ?? undefined,
          backgroundImageFilePath: filePath,
        };
      }),
    }));
  },

  updateTrackEffects: (id, config) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => {
        const sanitizedConfig = {
          ...config,
          effectInstances: config.effectInstances?.filter((i) => i != null) || [],
        };
        const { config: migratedConfig, keyframes: migratedKeyframes } = migrateLegacyEffects(
          sanitizedConfig,
          t.keyframes,
        );
        return { ...t, effectsConfig: migratedConfig, keyframes: migratedKeyframes };
      }),
    }));
  },

  updateTrackLyricsTheme: (id, theme) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => ({ ...t, lyricsTheme: theme })),
    }));
  },

  updateTrackKeyframes: (id, keyframes) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => ({ ...t, keyframes })),
    }));
  },

  updateTrackVideoClips: (id, videoClips) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => ({ ...t, videoClips })),
    }));
  },

  addTrackKeyframe: (trackId, kf) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, trackId, (t) => ({
        ...t,
        keyframes: sortKeyframes([...(t.keyframes || []), kf]),
      })),
    }));
  },

  removeTrackKeyframe: (trackId, kfId) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, trackId, (t) => ({
        ...t,
        keyframes: (t.keyframes || []).filter((k) => k.id !== kfId),
      })),
    }));
  },

  updateTrackProperty: (trackId, propertyPath, value, keyframeId?) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, trackId, (t) => {
        const currentTime = timeStore.getState().currentTime;

        // Which keyframe should this edit alter? Editing an active value NEVER
        // creates a keyframe — the selected keyframe (dropdown) wins, else the
        // active keyframe governing the render, else null (property not animated
        // → write base). See resolveWritableKeyframeId.
        const targetId = resolveWritableKeyframeId(
          t.keyframes,
          propertyPath,
          currentTime,
          keyframeId,
        );

        if (targetId) {
          const targetKf = (t.keyframes || []).find((kf) => kf.id === targetId);
          const kfs = (t.keyframes || []).map((kf) => {
            if (kf.id !== targetId) return kf;
            return {
              ...kf,
              properties: { ...kf.properties, [propertyPath]: value },
            };
          });
          const updated = { ...t, keyframes: kfs };
          // If we altered the base (time-0) keyframe, mirror it into base config
          // so the pre-first-keyframe render matches.
          if (targetKf && targetKf.time < 0.01) {
            syncBaseProperty(updated, propertyPath, value);
          }
          return updated;
        }

        // Property is not animated — write base state ("set the look").
        const updated = { ...t };
        syncBaseProperty(updated, propertyPath, value);
        return updated;
      }),
    }));
  },

  updateTrackEffectInstance: (trackId, instanceId, instanceConfig, keyframeId?) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, trackId, (t) => {
        // Verify instance exists
        const instance = t.effectsConfig?.effectInstances?.find((inst) => inst.id === instanceId);
        if (!instance) return t;

        // Build dot-path properties
        const prefix = `fx.${instanceId}`;
        const dotPathProperties: Record<string, unknown> = {};
        for (const [prop, val] of Object.entries(instanceConfig as object)) {
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            for (const [subProp, subVal] of Object.entries(val as Record<string, unknown>)) {
              dotPathProperties[`${prefix}.${prop}.${subProp}`] = subVal;
            }
          } else {
            dotPathProperties[`${prefix}.${prop}`] = val;
          }
        }

        const currentTime = timeStore.getState().currentTime;
        const fxKeys = Object.keys(dotPathProperties);

        // Which keyframe should this edit alter? Never auto-create — selected
        // keyframe wins, else the active keyframe carrying any of these fx paths,
        // else null (not animated → base).
        const targetId = resolveWritableKeyframeIdMulti(
          t.keyframes,
          fxKeys,
          currentTime,
          keyframeId,
        );

        if (targetId) {
          const targetKf = (t.keyframes || []).find((kf) => kf.id === targetId);
          const kfs = (t.keyframes || []).map((kf) => {
            if (kf.id !== targetId) return kf;
            return {
              ...kf,
              properties: { ...kf.properties, ...dotPathProperties },
            };
          });
          const updated = { ...t, keyframes: kfs };
          if (targetKf && targetKf.time < 0.01) {
            syncBaseEffectInstance(updated, instanceId, instanceConfig);
          }
          return updated;
        }

        // Not animated — write base state.
        const updated = { ...t };
        syncBaseEffectInstance(updated, instanceId, instanceConfig);
        return updated;
      }),
    }));
  },

  updateTrackFilePath: (id, type, path) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => {
        switch (type) {
          case 'audio':
            return { ...t, audioFilePath: path };
          case 'lyrics':
            return { ...t, lyricsFilePath: path };
          case 'background':
            return { ...t, backgroundImageFilePath: path };
          default:
            return t;
        }
      }),
    }));
  },

  applyPresetLook: (id, params) => {
    set((state) => ({
      tracks: mapTrack(state.tracks, id, (t) => {
        const updated = { ...t };

        // 1. Update background url if provided
        if (params.backgroundImageUrl !== undefined) {
          if (updated.backgroundImage !== params.backgroundImageUrl) {
            revokeBlobUrl(updated.backgroundImage);
          }
          updated.backgroundImage = params.backgroundImageUrl ?? undefined;
          if (params.backgroundImageFilePath !== undefined) {
            updated.backgroundImageFilePath = params.backgroundImageFilePath;
          }
        }

        // 2. Update effectsConfig if provided
        if (params.effectsConfig !== undefined) {
          const sanitizedConfig = {
            ...params.effectsConfig,
            effectInstances: params.effectsConfig.effectInstances?.filter((i) => i != null) || [],
          };
          const { config: migratedConfig, keyframes: migratedKeyframes } = migrateLegacyEffects(
            sanitizedConfig,
            updated.keyframes || [],
          );
          updated.effectsConfig = migratedConfig;
          updated.keyframes = migratedKeyframes;
        }

        // 3. Update lyricTheme if provided
        if (params.lyricTheme !== undefined) {
          updated.lyricsTheme = {
            ...(updated.lyricsTheme || {}),
            ...params.lyricTheme,
          } as LyricTheme;
        }

        // 4. Clear videoClips if requested
        if (params.clearVideoClips) {
          updated.videoClips = [];
        }

        // 5. Clear keyframes if requested
        if (params.clearEffectsKeyframes || params.clearBackgroundKeyframes) {
          const nextKfs = (updated.keyframes || []).map((kf) => {
            if (!kf.properties) return kf;
            const nextProps = { ...kf.properties };

            if (params.clearEffectsKeyframes) {
              Object.keys(nextProps).forEach((key) => {
                if (key.startsWith('effects.')) {
                  delete nextProps[key];
                }
              });
            }

            if (params.clearBackgroundKeyframes) {
              delete nextProps['scene.assetUrl'];
            }

            return {
              ...kf,
              properties: nextProps,
            };
          });
          updated.keyframes = nextKfs;
        }

        return updated;
      }),
    }));
  },

  // ═══════════════════════════════════════════════════════════════════
  // Playlist Settings / Bulk Ops (from usePlaylistSettings)
  // ═══════════════════════════════════════════════════════════════════

  updateSettings: (newSettings) => {
    set((state) => ({ settings: { ...state.settings, ...newSettings } }));
  },

  applyEffectsToAll: (config) => {
    const { config: migratedConfig } = migrateLegacyEffects(config);
    set((state) => ({
      tracks: state.tracks.map((t) => ({
        ...t,
        effectsConfig: JSON.parse(JSON.stringify(migratedConfig)),
      })),
    }));
  },

  applyBackgroundToAll: (imageUrl, config?, filePath?) => {
    set((state) => ({
      tracks: state.tracks.map((t) => {
        const updated: Track = {
          ...t,
          backgroundImage: imageUrl ?? undefined,
          backgroundImageFilePath: filePath ?? t.backgroundImageFilePath,
        };
        if (config) {
          updated.effectsConfig = {
            ...(t.effectsConfig || DEFAULT_EFFECTS_CONFIG),
            // Transform & display settings
            backgroundFit: config.backgroundFit,
            backgroundScale: config.backgroundScale,
            backgroundOffsetX: config.backgroundOffsetX,
            backgroundOffsetY: config.backgroundOffsetY,
            backgroundTileOffsetX: config.backgroundTileOffsetX,
            backgroundTileOffsetY: config.backgroundTileOffsetY,
            backgroundOpacity: config.backgroundOpacity,
            backgroundBrightness: config.backgroundBrightness,
            backgroundContrast: config.backgroundContrast,
            backgroundTiling: config.backgroundTiling,
            backgroundColor: config.backgroundColor,
            // Full slideshow config (all media items, timing, transitions)
            slideshow: config.slideshow
              ? JSON.parse(JSON.stringify(config.slideshow))
              : (t.effectsConfig || DEFAULT_EFFECTS_CONFIG).slideshow,
          };
        }
        return updated;
      }),
    }));
  },

  applyThemeToAll: (theme) => {
    set((state) => ({
      tracks: state.tracks.map((t) => {
        // Preserve per-track lane overrides — they are voice-specific
        const existing = t.lyricsTheme;
        return {
          ...t,
          lyricsTheme: {
            ...theme,
            laneStyles: existing?.laneStyles,
            laneCount: existing?.laneCount,
          },
        };
      }),
    }));
  },

  applyTrackTitleToAll: (config) => {
    set((state) => ({
      tracks: state.tracks.map((t) => ({
        ...t,
        effectsConfig: {
          ...(t.effectsConfig || DEFAULT_EFFECTS_CONFIG),
          trackTitle: config,
        },
      })),
    }));
  },
}));

if (typeof window !== 'undefined') {
  (window as unknown as { projectStore: typeof projectStore }).projectStore = projectStore;
}

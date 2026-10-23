/**
 * Project serialization utilities
 *
 * Save/load project files with .thren extension (JSON format).
 * Handles file path storage for media reload.
 */

import type { ThrenicProject, ProjectLoadResult } from '@/types/project';
import type { EffectsConfig } from '@/types/effects';
import type { LyricLineData } from '@/types/lyrics';
import type { CodecKey, FpsKey } from '@/types/export';
import { PROJECT_VERSION, PROJECT_EXTENSIONS, PROJECT_MIME_TYPE } from '@/types/project';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import type { Track } from '@/contexts/types';
import { migrateLegacyEffects } from './effects-migration';
import { validateProject } from './schema_validator';

/**
 * Default project configurations for initialization and migration fallback
 */
export const DEFAULT_THEME_CONFIG = {
  fontSize: 0.8,
  fontId: 'roboto',
  colors: {
    pre: '#666666',
    active: '#d946ef',
    post: '#444444',
  },
  verticalPosition: 10,
  effectScope: 'word' as const,
  wordSpacing: 1.0,
  glowEnabled: false,
  glowColor: '#d946ef',
  glowIntensity: 0.5,
  outlineColor: '#000000',
  fadeInDuration: 1.0,
  fadeOutDuration: 1.0,
};

export const DEFAULT_ANIMATION_CONFIG = {
  type: 'none' as const,
  stagger: 'word' as const,
  activeScale: false,
};

/**
 * Input state for collecting a project (matches page.tsx state shape)
 */
export interface ProjectStateInput {
  // Track info
  trackName: string;
  artist?: string;
  audioFilePath: string | null;
  currentTrackId?: string;

  // Background
  backgroundImagePath: string | null;

  // Lyrics
  lyrics: LyricLineData[];
  lyricsFilePath?: string | null;

  // Theme
  fontSize: number;
  fontId: string;
  lyricColors: { pre: string; active: string; post: string };
  verticalPosition: number;
  effectScope: 'word' | 'line' | 'background';
  wordSpacing: number;

  // Glow settings
  glowEnabled?: boolean;
  glowColor?: string;
  glowIntensity?: number;
  outlineColor?: string;

  // Timing
  fadeInDuration?: number;
  fadeOutDuration?: number;

  // Animation
  animationType: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
  animationStagger: 'letter' | 'word' | 'line';
  activeScaleEnabled: boolean;

  // Full tracks for serialization
  tracks?: Track[];

  // Effects
  effectsConfig: EffectsConfig;

  // Export (optional)
  exportSettings?: {
    width?: number;
    height?: number;
    fps?: FpsKey;
    quality?: string;
    aspect?: string;
    codec?: CodecKey;
    mode?: 'single' | 'batch' | 'selection';
    selectionRange?: { start: number; end: number };
    bitrate?: string;
  };

  // Playlist Settings
  playlistSettings?: {
    autoNext: boolean;
  };
}

/**
 * Collect current state into a ThrenicProject object
 */
export function collectProjectState(state: ProjectStateInput): ThrenicProject {
  const now = new Date().toISOString();

  return {
    version: PROJECT_VERSION,
    meta: {
      name: state.trackName || 'Untitled Project',
      artist: state.artist,
      createdAt: now,
      modifiedAt: now,
      currentTrackId: state.currentTrackId,
    },
    audio: {
      filePath: state.audioFilePath,
      name: state.trackName || 'Untitled',
    },
    backgroundImage: {
      filePath: state.backgroundImagePath,
    },
    lyrics: {
      lines: state.lyrics,
      filePath: state.lyricsFilePath,
    },
    theme: {
      fontSize: state.fontSize,
      fontId: state.fontId,
      colors: { ...state.lyricColors },
      verticalPosition: state.verticalPosition,
      effectScope: state.effectScope,
      wordSpacing: state.wordSpacing,
      glowEnabled: state.glowEnabled,
      glowColor: state.glowColor,
      glowIntensity: state.glowIntensity,
      outlineColor: state.outlineColor,
      fadeInDuration: state.fadeInDuration,
      fadeOutDuration: state.fadeOutDuration,
    },
    animation: {
      type: state.animationType,
      stagger: state.animationStagger,
      activeScale: state.activeScaleEnabled,
    },
    effects: state.effectsConfig,
    exportSettings: state.exportSettings,
    playlistSettings: state.playlistSettings,
    // Map internal Track[] to serializable TrackProjectData[]
    playlist: state.tracks?.map((t) => ({
      id: t.id,
      name: t.name,
      artist: t.artist,
      duration: t.duration,
      audioFilePath: t.audioFilePath || null,
      backgroundImageFilePath: t.backgroundImageFilePath || null,
      lyrics: t.lyricsData || [],
      lyricsFilePath: t.lyricsFilePath || null,
      effectsConfig: t.effectsConfig,
      lyricsTheme: t.lyricsTheme,
      keyframes: t.keyframes || [],
      videoClips: t.videoClips || [],
    })),
  };
}

/**
 * Serialize project to JSON string
 */
export function serializeProject(project: ThrenicProject): string {
  // Update modified timestamp
  project.meta.modifiedAt = new Date().toISOString();

  // structuredClone preserves shared references (if two fields point to
  // the same object, the clone keeps them shared), which causes safeStringify
  // to emit "[Circular]".  A JSON round-trip fully breaks all shared refs.
  const cloned = JSON.parse(JSON.stringify(project));
  return JSON.stringify(cloned, null, 2);
}

/**
 * Parse JSON and validate basic structure
 * Returns the project and any warnings encountered
 */
export function deserializeProject(json: string): ProjectLoadResult {
  const warnings: string[] = [];

  let data: ThrenicProject & { autoNext?: boolean };
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : 'Parse error'}`);
  }

  // Run schema validation for structural warnings
  const validation = validateProject(data);
  if (validation.errors.length > 0) {
    warnings.push(...validation.errors.map((e) => `Schema: ${e}`));
  }
  warnings.push(...validation.warnings.map((w) => `Schema: ${w}`));

  // Validate version
  if (!data.version) {
    warnings.push('Project file has no version, assuming v1.0');
    data.version = PROJECT_VERSION;
  }

  // Ensure required sections exist with defaults
  const project: ThrenicProject = {
    version: data.version || PROJECT_VERSION,
    meta: {
      name: data.meta?.name || 'Imported Project',
      artist: data.meta?.artist,
      createdAt: data.meta?.createdAt || new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      currentTrackId: data.meta?.currentTrackId,
    },
    audio: {
      filePath: data.audio?.filePath || null,
      name: data.audio?.name || data.meta?.name || 'Untitled',
    },
    backgroundImage: {
      filePath: data.backgroundImage?.filePath || null,
    },
    lyrics: {
      lines: Array.isArray(data.lyrics?.lines) ? data.lyrics.lines : [],
      filePath: data.lyrics?.filePath || null,
    },
    theme: {
      ...DEFAULT_THEME_CONFIG,
      fontSize: data.theme?.fontSize ?? DEFAULT_THEME_CONFIG.fontSize,
      fontId: data.theme?.fontId || DEFAULT_THEME_CONFIG.fontId,
      colors: {
        ...DEFAULT_THEME_CONFIG.colors,
        ...data.theme?.colors,
      },
      verticalPosition: data.theme?.verticalPosition ?? DEFAULT_THEME_CONFIG.verticalPosition,
      effectScope: data.theme?.effectScope || DEFAULT_THEME_CONFIG.effectScope,
      wordSpacing: data.theme?.wordSpacing ?? DEFAULT_THEME_CONFIG.wordSpacing,
      glowEnabled: data.theme?.glowEnabled ?? DEFAULT_THEME_CONFIG.glowEnabled,
      glowColor: data.theme?.glowColor || DEFAULT_THEME_CONFIG.glowColor,
      glowIntensity: data.theme?.glowIntensity ?? DEFAULT_THEME_CONFIG.glowIntensity,
      outlineColor: data.theme?.outlineColor || DEFAULT_THEME_CONFIG.outlineColor,
      fadeInDuration: data.theme?.fadeInDuration ?? DEFAULT_THEME_CONFIG.fadeInDuration,
      fadeOutDuration: data.theme?.fadeOutDuration ?? DEFAULT_THEME_CONFIG.fadeOutDuration,
    },
    animation: {
      ...DEFAULT_ANIMATION_CONFIG,
      type: data.animation?.type || DEFAULT_ANIMATION_CONFIG.type,
      stagger: data.animation?.stagger || DEFAULT_ANIMATION_CONFIG.stagger,
      activeScale: data.animation?.activeScale ?? DEFAULT_ANIMATION_CONFIG.activeScale,
    },
    effects: migrateLegacyEffects(data.effects || DEFAULT_EFFECTS_CONFIG).config,
    exportSettings: {
      width: data.exportSettings?.width,
      height: data.exportSettings?.height,
      fps: data.exportSettings?.fps as FpsKey | undefined,
      quality: data.exportSettings?.quality,
      aspect: data.exportSettings?.aspect,
      codec: data.exportSettings?.codec as CodecKey | undefined,
      mode: data.exportSettings?.mode,
      selectionRange: data.exportSettings?.selectionRange,
      bitrate: data.exportSettings?.bitrate,
    },
    playlistSettings: data.playlistSettings || {
      autoNext: data.autoNext ?? true,
    },
    // Accept both "playlist" (legacy/IDB format) and "tracks" (newer JSON format)
    playlist: (() => {
      const rawList = Array.isArray(data.playlist)
        ? data.playlist
        : Array.isArray((data as { tracks?: unknown }).tracks)
          ? (data as { tracks?: NonNullable<ThrenicProject['playlist']> }).tracks
          : undefined;
      if (!rawList) return undefined;
      return rawList.map((t) => {
        const { config, keyframes } = migrateLegacyEffects(t.effectsConfig, t.keyframes);
        return {
          ...t,
          effectsConfig: config,
          keyframes: keyframes || t.keyframes,
        };
      });
    })(),
  };

  return { project, warnings };
}

/**
 * Load project from a file
 * Returns project data and warnings, or null if cancelled
 */
export async function loadProject(): Promise<ProjectLoadResult | null> {
  // Try File System Access API first
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (
        window as unknown as {
          showOpenFilePicker: (options: unknown) => Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker({
        types: [
          {
            description: 'Threnic Project',
            accept: { [PROJECT_MIME_TYPE]: PROJECT_EXTENSIONS },
          },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      const json = await file.text();
      return deserializeProject(json);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return null;
      throw e;
    }
  }

  // Fallback: use file input
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = PROJECT_EXTENSIONS.join(',');

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      try {
        const json = await file.text();
        resolve(deserializeProject(json));
      } catch (e) {
        reject(e);
      }
    };

    input.click();
  });
}

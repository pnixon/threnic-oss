/**
 * Project file types for save/load functionality
 *
 * ThrenicProject captures all serializable state for a project.
 * Files loaded from disk store their full filepath for reload.
 */

import type { LyricLineData, LyricTheme } from './lyrics';
import type { EffectsConfig } from './effects';
import type { Keyframe } from './keyframes';
import type { CodecKey, FpsKey } from './export';
import type { VideoClip } from './video-clips';

export interface PlaylistSettings {
  autoNext: boolean;
}

interface TrackProjectData {
  id: string;
  name: string;
  artist?: string;
  duration: number;
  audioFilePath: string | null;
  backgroundImageFilePath: string | null;
  lyrics: LyricLineData[];
  lyricsFilePath?: string | null;
  effectsConfig?: EffectsConfig;
  lyricsTheme?: LyricTheme;
  keyframes?: Keyframe[];
  videoClips?: VideoClip[];
}

/** Current schema version for migrations */
export const PROJECT_VERSION = '2.0' as const;

/** Supported file extensions */
export const PROJECT_EXTENSIONS = ['.thren', '.json'] as const;
export const PROJECT_MIME_TYPE = 'application/json';

/**
 * Complete project state for serialization
 */
export interface ThrenicProject {
  /** Schema version for future migrations */
  version: typeof PROJECT_VERSION;

  /** Project metadata */
  meta: {
    name: string;
    artist?: string;
    createdAt: string;
    modifiedAt: string;
    currentTrackId?: string;
  };

  /** Playlist settings */
  playlistSettings?: {
    autoNext: boolean;
  };

  /** Full playlist */
  playlist?: TrackProjectData[];

  /** Audio/media file paths for reload */
  audio: {
    /** Absolute path to audio file (null if not loaded from file) */
    filePath: string | null;
    /** Display name */
    name: string;
  };

  /** Background image */
  backgroundImage: {
    /** Absolute path to image file */
    filePath: string | null;
  };

  /** Lyrics data */
  lyrics: {
    lines: LyricLineData[];
    /** Absolute path to lyrics file */
    filePath?: string | null;
  };

  /** Absolute path to project file */
  filePath?: string | null;

  /** Theme/visual settings */
  theme: {
    fontSize: number;
    fontId: string;
    colors: {
      pre: string;
      active: string;
      post: string;
    };
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
    highlightFadeIn?: number;
    highlightFadeOut?: number;
  };

  /** Animation settings */
  animation: {
    type: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
    stagger: 'letter' | 'word' | 'line';
    activeScale: boolean;
  };

  /** Effects configuration (uses existing EffectsConfig type) */
  effects: EffectsConfig;

  /** Export settings (optional) */
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
}

/**
 * Result of loading a project
 */
export interface ProjectLoadResult {
  project: ThrenicProject;
  warnings: string[];
}

/**
 * Track manifest for export/import (lightweight reference format)
 */
export interface TrackManifest {
  id: string;
  name: string;
  artist?: string;
  duration: number;
  /** Path to audio file (relative to project or absolute URL) */
  audioFilePath: string;
  /** Path to lyrics file (relative to project or absolute URL) */
  lyricsFilePath?: string | null;
  /** Inline lyric data */
  lyrics?: LyricLineData[];
  /** Path to background image (relative to project or absolute URL) */
  backgroundImageFilePath?: string | null;
  /** Per-track effects configuration */
  effectsConfig?: EffectsConfig;
  /** Per-track lyric theme */
  lyricsTheme?: LyricTheme;
  /** Automation keyframes for this track */
  keyframes?: Keyframe[];
  /** NLE video clips timeline data */
  videoClips?: VideoClip[];
}

/**
 * Project export manifest (JSON format for .threnic files)
 */
export interface ProjectExportManifest {
  /** Schema version */
  version: string;

  /** Project metadata */
  meta: {
    name: string;
    artist?: string;
    created: string;
    modified?: string;
    description?: string;
  };

  /** Visual theme settings */
  theme: {
    fontSize: number;
    fontId: string;
    colors: {
      pre: string;
      active: string;
      post: string;
    };
    verticalPosition: number;
    effectScope: 'word' | 'line' | 'background';
    wordSpacing: number;
    glowEnabled: boolean;
    glowColor: string;
    glowIntensity: number;
    outlineColor: string;
    fadeInDuration: number;
    fadeOutDuration: number;
    highlightFadeIn: number;
    highlightFadeOut: number;
  };

  /** Animation settings */
  animation: {
    type: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
    stagger: 'letter' | 'word' | 'line';
    activeScale: boolean;
  };

  /** Global effects configuration */
  effects: EffectsConfig;

  /** Track list with file references */
  tracks: TrackManifest[];

  /** Export settings */
  exportSettings?: {
    quality?: string;
    aspect?: string;
    codec?: CodecKey;
    fps?: FpsKey;
    mode?: 'single' | 'batch' | 'selection';
    selectionRange?: { start: number; end: number };
    bitrate?: string;
  };

  /** Playlist settings */
  playlistSettings?: PlaylistSettings;
}

/**
 * Validation result for project files
 */
export interface ProjectValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest?: ProjectExportManifest;
}

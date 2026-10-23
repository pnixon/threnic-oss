import type { LyricLineData, LyricTheme } from '@/types/lyrics';
import type { EffectsConfig, TrackTitleConfig } from '@/types/effects';
import type { PlaylistSettings, ProjectExportManifest } from '@/types/project';
import type { Keyframe } from '@/types/keyframes';
import type { VideoClip } from '@/types/video-clips';

/**
 * Track data structure
 */
export interface Track {
  id: string;
  name: string;
  artist?: string;
  duration: number;
  audioUrl: string;
  audioFile?: File | Blob;
  /** Absolute file path for project serialization (if loaded from file) */
  audioFilePath?: string;
  lyricsData?: LyricLineData[];
  lyricsFilePath?: string;
  backgroundImage?: string;
  /** File/Blob ref for persistence */
  backgroundImageFile?: File | Blob;
  /** Absolute file path for background image (if loaded from file) */
  backgroundImageFilePath?: string;
  /** Per-track effects configuration */
  effectsConfig?: EffectsConfig;
  /** Per-track lyric theme configuration */
  lyricsTheme?: LyricTheme;
  /** Automation keyframes for this track */
  keyframes?: Keyframe[];
  /** NLE video clips timeline data */
  videoClips?: VideoClip[];
}

export interface TrackExportData {
  trackId: string;
  audioBuffer: AudioBuffer;
  duration: number;
  lyrics: LyricLineData[];
  backgroundImage?: string;
  effectsConfig?: EffectsConfig;
  lyricsTheme?: LyricTheme;
  keyframes?: Keyframe[];
  videoClips?: VideoClip[];
  name: string;
}

/**
 * Playlist context value
 */
export interface PlaylistContextValue {
  tracks: Track[];
  selectedTrackId: string | null;
  isLoading: boolean;
  addTrack: (file: File) => Promise<void>;
  addTrackFromUrl: (url: string, name: string) => Promise<void>;
  removeTrack: (id: string) => void;
  selectTrack: (id: string | null) => void;
  selectNextTrack: (loop?: boolean) => void;
  selectPreviousTrack: (loop?: boolean) => void;
  renameTrack: (id: string, name: string) => void;
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
  reorderTracks: (fromIndex: number, toIndex: number) => void;
  getSelectedTrack: () => Track | null;
  clearPlaylist: () => void;
  getTracksForExport: (trackIds: string[]) => Promise<TrackExportData[]>;
  getPlaylistDuration: () => number;
  applyEffectsToAll: (config: EffectsConfig) => void;
  applyBackgroundToAll: (
    imageUrl: string | null,
    config?: EffectsConfig,
    filePath?: string,
  ) => void;
  applyThemeToAll: (theme: LyricTheme) => void;
  applyTrackTitleToAll: (config: TrackTitleConfig) => void;
  updateTrackFilePath: (id: string, type: 'audio' | 'lyrics' | 'background', path: string) => void;
  restorePlaylist: (tracks: Track[]) => void;
  settings: PlaylistSettings;
  updateSettings: (settings: Partial<PlaylistSettings>) => void;
  replaceTrackAudio: (id: string, file: File) => Promise<void>;
  shufflePlaylist: () => void;
  loadProjectFromManifest: (
    manifest: ProjectExportManifest,
    assets?: Map<string, Blob>,
  ) => Promise<void>;
  importProject: () => Promise<void>;
  exportCurrentProject: () => { tracks: Track[]; settings: PlaylistSettings };
}

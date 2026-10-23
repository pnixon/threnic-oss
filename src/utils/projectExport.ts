/**
 * Project Export Utilities
 *
 * Handles exporting Threnic projects as JSON manifests with file references.
 */

import type { Track } from '@/contexts/types';
import type { ProjectExportManifest, TrackManifest } from '@/types/project';
import type { EffectsConfig } from '@/types/effects';
import { PROJECT_VERSION } from '@/types/project';

interface ExportOptions {
  /** Project name (defaults to first track name or "Untitled Project") */
  projectName?: string;
  /** Project artist */
  artist?: string;
  /** Project description */
  description?: string;
}

/**
 * Create a project export manifest from current application state
 */
function createProjectManifest(
  tracks: Track[],
  effectsConfig: EffectsConfig,
  theme: {
    fontSize: number;
    fontId: string;
    colors: { pre: string; active: string; post: string };
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
  },
  animation: {
    type: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
    stagger: 'letter' | 'word' | 'line';
    activeScale: boolean;
  },
  playlistSettings: {
    autoNext: boolean;
  },
  exportSettings: {
    quality?: string;
    aspect?: string;
    bitrate?: string;
  },
  options: ExportOptions = {},
): ProjectExportManifest {
  const now = new Date().toISOString();

  // Convert tracks to manifest format
  const trackManifests: TrackManifest[] = tracks.map((track) => ({
    id: track.id,
    name: track.name,
    artist: track.artist,
    duration: track.duration,
    audioFilePath: track.audioFilePath || '',
    lyricsFilePath: track.lyricsFilePath,
    backgroundImageFilePath: track.backgroundImageFilePath,
    effectsConfig: track.effectsConfig,
    lyricsTheme: track.lyricsTheme,
    keyframes: track.keyframes,
  }));

  return {
    version: PROJECT_VERSION,
    meta: {
      name: options.projectName || tracks[0]?.name || 'Untitled Project',
      artist: options.artist,
      created: now,
      modified: now,
      description: options.description,
    },
    theme,
    animation,
    effects: effectsConfig,
    tracks: trackManifests,
    exportSettings,
    playlistSettings,
  };
}

/**
 * Export project as JSON string
 */
function exportProjectToJSON(manifest: ProjectExportManifest): string {
  return JSON.stringify(manifest, null, 2);
}

/**
 * Download project file to user's computer
 */
function downloadProjectFile(jsonContent: string, filename: string): void {
  // Ensure filename has .json extension
  const finalFilename = filename.endsWith('.json') ? filename : `${filename}.json`;

  const blob = new Blob([jsonContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = finalFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Clean up
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * Complete export workflow: create manifest, convert to JSON, and download
 */
export function exportProject(
  tracks: Track[],
  effectsConfig: EffectsConfig,
  theme: Parameters<typeof createProjectManifest>[2],
  animation: Parameters<typeof createProjectManifest>[3],
  playlistSettings: Parameters<typeof createProjectManifest>[4],
  exportSettings: Parameters<typeof createProjectManifest>[5],
  options: ExportOptions = {},
): void {
  const manifest = createProjectManifest(
    tracks,
    effectsConfig,
    theme,
    animation,
    playlistSettings,
    exportSettings,
    options,
  );

  const json = exportProjectToJSON(manifest);
  const filename = options.projectName || tracks[0]?.name || 'project';

  downloadProjectFile(json, filename);
}

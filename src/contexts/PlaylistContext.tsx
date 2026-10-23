'use client';

/**
 * PlaylistContext — Minimal compatibility shim.
 *
 * The four granular hooks (usePlaylistState, useTrackManagementAPI,
 * useTrackConfigAPI, usePlaylistSettingsAPI) now read directly from
 * projectStore via Zustand — no Context needed.
 *
 * The PlaylistProvider is retained only for:
 *   1. useProjectIOAPI — wraps useProjectIO, which handles project
 *      import/export.
 *   2. Legacy usePlaylist() — deprecated, will be removed.
 */

import React, { createContext, useContext, ReactNode } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { projectStore, type ProjectState } from '@/stores/projectStore';
import type { PlaylistContextValue } from './types';
import type { PlaylistSettings } from '@/types/project';
import { useProjectIO } from './PlaylistHooks/useProjectIO';

// ── Granular context types (kept for type-compat with consumers) ──
type TrackManagementValue = Pick<
  ProjectState,
  | 'addTrack'
  | 'addTrackFromUrl'
  | 'replaceTrackAudio'
  | 'removeTrack'
  | 'selectTrack'
  | 'selectNextTrack'
  | 'selectPreviousTrack'
  | 'renameTrack'
  | 'reorderTracks'
  | 'shufflePlaylist'
  | 'clearPlaylist'
  | 'restorePlaylist'
  | 'getSelectedTrack'
>;

type TrackConfigValue = Pick<
  ProjectState,
  | 'updateTrackLyrics'
  | 'updateTrackBackground'
  | 'updateTrackEffects'
  | 'updateTrackLyricsTheme'
  | 'updateTrackKeyframes'
  | 'updateTrackVideoClips'
  | 'addTrackKeyframe'
  | 'removeTrackKeyframe'
  | 'updateTrackProperty'
  | 'updateTrackEffectInstance'
  | 'updateTrackFilePath'
  | 'applyPresetLook'
>;

type PlaylistSettingsValue = Pick<
  ProjectState,
  | 'updateSettings'
  | 'applyEffectsToAll'
  | 'applyBackgroundToAll'
  | 'applyThemeToAll'
  | 'applyTrackTitleToAll'
  | 'getPlaylistDuration'
> & {
  settings: PlaylistSettings;
};

type ProjectIOValue = ReturnType<typeof useProjectIO>;

// Only ProjectIOContext remains as a true React Context
const ProjectIOContext = createContext<ProjectIOValue | null>(null);

// Keeping the legacy context for backward compatibility
const PlaylistContext = createContext<PlaylistContextValue | null>(null);

interface PlaylistProviderProps {
  children: ReactNode;
}

export function PlaylistProvider({ children }: PlaylistProviderProps): React.ReactElement {
  // useProjectIO reads/writes projectStore directly
  const projectIO = useProjectIO();

  // Legacy PlaylistContext value (deprecated)
  const actions = useStore(projectStore, (s) => s);

  const value: PlaylistContextValue = {
    ...actions,
    ...projectIO,
  };

  return (
    <ProjectIOContext.Provider value={projectIO}>
      <PlaylistContext.Provider value={value}>{children}</PlaylistContext.Provider>
    </ProjectIOContext.Provider>
  );
}

// ── Hooks — all read from projectStore directly (no Context) ──

export function usePlaylistState() {
  return useStore(
    projectStore,
    useShallow((s) => ({
      tracks: s.tracks,
      selectedTrackId: s.selectedTrackId,
      isLoading: s.isLoading,
      settings: s.settings,
    })),
  );
}

export function useTrackManagementAPI(): TrackManagementValue {
  return useStore(
    projectStore,
    useShallow((s) => ({
      addTrack: s.addTrack,
      addTrackFromUrl: s.addTrackFromUrl,
      replaceTrackAudio: s.replaceTrackAudio,
      removeTrack: s.removeTrack,
      selectTrack: s.selectTrack,
      selectNextTrack: s.selectNextTrack,
      selectPreviousTrack: s.selectPreviousTrack,
      renameTrack: s.renameTrack,
      reorderTracks: s.reorderTracks,
      shufflePlaylist: s.shufflePlaylist,
      clearPlaylist: s.clearPlaylist,
      restorePlaylist: s.restorePlaylist,
      getSelectedTrack: s.getSelectedTrack,
    })),
  );
}

export function useTrackConfigAPI(): TrackConfigValue {
  return useStore(
    projectStore,
    useShallow((s) => ({
      updateTrackLyrics: s.updateTrackLyrics,
      updateTrackBackground: s.updateTrackBackground,
      updateTrackEffects: s.updateTrackEffects,
      updateTrackLyricsTheme: s.updateTrackLyricsTheme,
      updateTrackKeyframes: s.updateTrackKeyframes,
      updateTrackVideoClips: s.updateTrackVideoClips,
      addTrackKeyframe: s.addTrackKeyframe,
      removeTrackKeyframe: s.removeTrackKeyframe,
      updateTrackProperty: s.updateTrackProperty,
      updateTrackEffectInstance: s.updateTrackEffectInstance,
      updateTrackFilePath: s.updateTrackFilePath,
      applyPresetLook: s.applyPresetLook,
    })),
  );
}

export function usePlaylistSettingsAPI(): PlaylistSettingsValue {
  const settings = useStore(projectStore, (s) => s.settings);
  const actions = useStore(
    projectStore,
    useShallow((s) => ({
      updateSettings: s.updateSettings,
      applyEffectsToAll: s.applyEffectsToAll,
      applyBackgroundToAll: s.applyBackgroundToAll,
      applyThemeToAll: s.applyThemeToAll,
      applyTrackTitleToAll: s.applyTrackTitleToAll,
      getPlaylistDuration: s.getPlaylistDuration,
    })),
  );
  return { ...actions, settings };
}

export function useProjectIOAPI() {
  const context = useContext(ProjectIOContext);
  if (!context) throw new Error('useProjectIOAPI must be used within PlaylistProvider');
  return context;
}

/**
 * @deprecated Use specific granular playlist contexts to prevent unnecessary re-renders.
 */
export function usePlaylist(): PlaylistContextValue {
  const context = useContext(PlaylistContext);
  if (!context) {
    throw new Error('usePlaylist must be used within a PlaylistProvider');
  }
  return context;
}

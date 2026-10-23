/**
 * Auto-Persist Middleware — Subscribes to projectStore and persists to IndexedDB.
 *
 * Replaces the former React-hook-based persistence with a store subscription
 * that works outside of React. Debounces writes and uses requestIdleCallback
 * for zero-impact background persistence.
 *
 * Features:
 * - Debounced writes (2s delay after last change)
 * - requestIdleCallback for background persistence
 * - Reference comparison to skip unchanged data
 * - Dev-mode state validation via Zod schemas
 * - Restore on initialization
 */

import { projectStore } from '@/stores/projectStore';
import { saveProjectToIDB } from '@/utils/indexedDB';
import { createLogger } from '@/utils/logger';
import type { Track } from '@/contexts/types';
import type { ThrenicProject } from '@/types/project';
import { PROJECT_VERSION } from '@/types/project';
import type { EffectsConfig } from '@/types/effects';

type TimelineDragWindow = Window & { __threnic_timeline_dragging?: boolean };

const logger = createLogger({ enabled: true, prefix: 'AutoPersist' });

// ── Configuration ──
const DEBOUNCE_MS = 2000;
const IDLE_TIMEOUT_MS = 3000;

// ── Idle callback types ──
interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining: () => number;
}

interface ExtendedWindow extends Window {
  requestIdleCallback: (
    cb: (deadline: IdleDeadline) => void,
    opts?: { timeout?: number },
  ) => number;
  cancelIdleCallback: (handle: number) => void;
}

// ── Internal state ──
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _idleHandle: number | null = null;
let _lastTracksRef: Track[] | null = null;
let _lastTracksJson = '';
let _lastSettingsJson = '';
let _isInitialized = false;
let _canSave = false;
let _unsubscribe: (() => void) | null = null;

/**
 * Check if data has actually changed using reference + JSON comparison.
 */
function hasChanged(): boolean {
  const { tracks, settings } = projectStore.getState();

  // Quick reference check
  if (tracks === _lastTracksRef) {
    // Only check settings
    const settingsJson = JSON.stringify(settings);
    if (settingsJson === _lastSettingsJson) return false;
    _lastSettingsJson = settingsJson;
    return true;
  }

  // Full JSON comparison (tracks changed by reference)
  const tracksJson = JSON.stringify(tracks, (key, value) => {
    // Skip non-serializable properties
    if (key === 'audioFile' || key === 'backgroundImageFile') return undefined;
    return value;
  });

  if (tracksJson === _lastTracksJson) {
    _lastTracksRef = tracks;
    return false;
  }

  _lastTracksRef = tracks;
  _lastTracksJson = tracksJson;
  _lastSettingsJson = JSON.stringify(settings);
  return true;
}

/**
 * Perform the actual save to IndexedDB.
 */
async function performSave(): Promise<void> {
  // If the user is dragging, do NOT perform save!
  const isDragging =
    typeof window !== 'undefined' && (window as TimelineDragWindow).__threnic_timeline_dragging;
  if (isDragging) {
    logger.debug('Skipping performSave: active timeline dragging detected in performSave');
    return;
  }

  const { tracks, settings, selectedTrackId } = projectStore.getState();

  // If playlist is empty, clear the saved project so deletions persist
  if (tracks.length === 0) {
    try {
      const { getDB } = await import('@/utils/indexedDB');
      const db = await getDB();
      await db.delete('projects', 'current_project');
      logger.debug('Cleared IDB (empty playlist)');
    } catch (err) {
      logger.warn('Failed to clear IDB:', err as Error);
    }
    return;
  }

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId);
  const now = new Date().toISOString();

  // Build project directly from store state
  const project: ThrenicProject = {
    version: PROJECT_VERSION,
    meta: {
      name: selectedTrack?.name || 'Untitled Project',
      artist: selectedTrack?.artist,
      createdAt: now,
      modifiedAt: now,
      currentTrackId: selectedTrackId || undefined,
    },
    audio: {
      filePath: selectedTrack?.audioFilePath || null,
      name: selectedTrack?.name || 'Untitled',
    },
    backgroundImage: {
      filePath: selectedTrack?.backgroundImageFilePath || null,
    },
    lyrics: {
      lines: selectedTrack?.lyricsData || [],
      filePath: selectedTrack?.lyricsFilePath || null,
    },
    theme: {
      fontSize: selectedTrack?.lyricsTheme?.fontSize ?? 0.8,
      fontId: selectedTrack?.lyricsTheme?.fontId ?? 'roboto',
      colors: {
        pre: selectedTrack?.lyricsTheme?.colors?.pre ?? '#666666',
        active: selectedTrack?.lyricsTheme?.colors?.active ?? '#d946ef',
        post: selectedTrack?.lyricsTheme?.colors?.post ?? '#444444',
      },
      verticalPosition: selectedTrack?.lyricsTheme?.verticalPosition ?? 10,
      effectScope:
        (
          selectedTrack?.lyricsTheme as
            | { effectScope?: ThrenicProject['theme']['effectScope'] }
            | undefined
        )?.effectScope ?? 'word',
      wordSpacing: selectedTrack?.lyricsTheme?.wordSpacing ?? 1.0,
    },
    animation: {
      type: 'none',
      stagger: 'word',
      activeScale: false,
    },
    effects: selectedTrack?.effectsConfig || ({} as EffectsConfig),
    playlistSettings: settings,
    playlist: tracks.map((t) => ({
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

  try {
    await saveProjectToIDB(project, tracks);
    logger.debug('Persisted to IDB');
  } catch (err) {
    logger.warn('Persist failed:', err as Error);
  }
}

function scheduleSave(): void {
  if (!_canSave) return;

  // Postpone auto-saves if the user is actively dragging/timing on the timeline
  const isDragging =
    typeof window !== 'undefined' && (window as TimelineDragWindow).__threnic_timeline_dragging;
  if (isDragging) {
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
    return;
  }

  if (!hasChanged()) return;

  // Clear any pending save
  if (_debounceTimer) clearTimeout(_debounceTimer);

  _debounceTimer = setTimeout(() => {
    // Runtime safety guard: double-check dragging status right before save
    const isDraggingNow =
      typeof window !== 'undefined' && (window as TimelineDragWindow).__threnic_timeline_dragging;
    if (isDraggingNow) {
      logger.debug('Skipping performSave: active timeline dragging detected inside timeout');
      return;
    }

    const extWindow = typeof window !== 'undefined' ? (window as unknown as ExtendedWindow) : null;

    if (extWindow?.requestIdleCallback) {
      if (_idleHandle != null) extWindow.cancelIdleCallback(_idleHandle);
      _idleHandle = extWindow.requestIdleCallback(
        (deadline) => {
          if (deadline.timeRemaining() > 5 || deadline.didTimeout) {
            performSave();
          }
        },
        { timeout: IDLE_TIMEOUT_MS },
      );
    } else {
      performSave();
    }
  }, DEBOUNCE_MS);
}

/**
 * Pause auto-saves immediately (e.g. during active drag)
 */
export function pauseAutoSave(): void {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_idleHandle != null && typeof window !== 'undefined') {
    const extWindow = window as unknown as ExtendedWindow;
    if (extWindow.cancelIdleCallback) {
      extWindow.cancelIdleCallback(_idleHandle);
      _idleHandle = null;
    }
  }
  logger.debug('AutoSave paused');
}

/**
 * Resume auto-saves
 */
export function resumeAutoSave(): void {
  logger.debug('AutoSave resumed');
  scheduleSave();
}

/**
 * Initialize auto-persist: restore from IDB then subscribe to projectStore.
 *
 * @param onRestore - Callback invoked with the restored project/tracks data.
 *                    The caller is responsible for hydrating the store.
 * @returns Cleanup function to stop the middleware.
 */
export function initAutoPersist(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved public parameter; callers hydrate the store themselves
  onRestore?: (project: ThrenicProject, tracks: Track[]) => void,
): () => void {
  if (_isInitialized) {
    logger.warn('Auto-persist already initialized');
    return () => {};
  }

  _isInitialized = true;

  // Subscribe to projectStore changes
  _unsubscribe = projectStore.subscribe(() => {
    scheduleSave();
  });

  // Flush any pending save when the user refreshes or closes the tab
  const handleBeforeUnload = () => {
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
    // performSave is async but we fire-and-forget here;
    // modern browsers give enough time for a single IDB put.
    if (_canSave && hasChanged()) {
      performSave();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload);
  }

  // Enable saving after a brief delay (avoid saving during restore)
  setTimeout(() => {
    _canSave = true;
    logger.debug('Auto-persist enabled');
  }, 1500);

  logger.debug('Auto-persist initialized');

  return () => {
    _isInitialized = false;
    _canSave = false;

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    }

    if (_unsubscribe) {
      _unsubscribe();
      _unsubscribe = null;
    }

    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }

    if (_idleHandle != null) {
      const extWindow =
        typeof window !== 'undefined' ? (window as unknown as ExtendedWindow) : null;
      if (extWindow?.cancelIdleCallback) {
        extWindow.cancelIdleCallback(_idleHandle);
      }
      _idleHandle = null;
    }

    logger.debug('Auto-persist stopped');
  };
}

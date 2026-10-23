/**
 * useTrackLyricsState — Zustand-backed lyrics editing state.
 *
 * Reads `selectedTrack.lyricsData` from projectStore via useSyncExternalStore.
 * Maintains an internal draft (`ThrenicWord[]`) for editing to avoid cursor
 * jumps from immediate store writes. Debounces draft → store commits (500ms).
 * Auto-resets draft on track switch.
 */

import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';
import { projectStore } from '@/stores/projectStore';
import type { ThrenicWord, LyricLineData } from '@/types/lyrics';
import { lyricLinesToThrenicWords, threnicWordsToLyricLines } from '@/types/lyrics';
import { useDebounce } from '@/hooks/useDebounce';
import { safeStringify } from '@/utils';

type TimelineDragWindow = Window & { __threnic_timeline_dragging?: boolean };

// ── Store subscriptions ──

const subscribe = projectStore.subscribe;

function getLyricsDataSnapshot(): LyricLineData[] | undefined {
  const state = projectStore.getState();
  const track = state.tracks.find((t) => t.id === state.selectedTrackId);
  return track?.lyricsData;
}

function getTrackIdSnapshot(): string | null {
  return projectStore.getState().selectedTrackId;
}

// ── Public interface ──

interface TrackLyricsState {
  /** Current editing words (draft — may be ahead of store) */
  words: ThrenicWord[];
  /** Update words draft. Commits to store after 500ms debounce. */
  setWords: (w: ThrenicWord[] | ((prev: ThrenicWord[]) => ThrenicWord[])) => void;
  /** Ref for synchronous access (always up-to-date) */
  wordsRef: React.RefObject<ThrenicWord[]>;
}

// ── Hook ──

export function useTrackLyricsState(): TrackLyricsState {
  // Read source of truth from store
  const lyricsData = useSyncExternalStore(subscribe, getLyricsDataSnapshot, getLyricsDataSnapshot);
  const trackId = useSyncExternalStore(subscribe, getTrackIdSnapshot, getTrackIdSnapshot);

  // Internal draft state for editing
  const [words, setWordsRaw] = useState<ThrenicWord[]>(() =>
    lyricsData ? lyricLinesToThrenicWords(lyricsData) : [],
  );

  const wordsRef = useRef<ThrenicWord[]>(words);

  // Keep ref in sync
  useEffect(() => {
    wordsRef.current = words;
  }, [words]);

  // Track the previous trackId to detect switches
  const prevTrackIdRef = useRef<string | null>(trackId);

  // Reset draft when track changes or external lyricsData updates
  useEffect(() => {
    if (trackId !== prevTrackIdRef.current) {
      prevTrackIdRef.current = trackId;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWordsRaw(lyricsData ? lyricLinesToThrenicWords(lyricsData) : []);
      return;
    }

    // External change (e.g. undo/redo or sync completion)
    if (lyricsData) {
      const isDragging =
        typeof window !== 'undefined' && (window as TimelineDragWindow).__threnic_timeline_dragging;
      if (isDragging) return;

      const currentDraftLines = threnicWordsToLyricLines(wordsRef.current);
      if (safeStringify(currentDraftLines) !== safeStringify(lyricsData)) {
        setWordsRaw(lyricLinesToThrenicWords(lyricsData));
      }
    } else if (wordsRef.current.length > 0) {
      const isDragging =
        typeof window !== 'undefined' && (window as TimelineDragWindow).__threnic_timeline_dragging;
      if (isDragging) return;

      setWordsRaw([]);
    }
  }, [trackId, lyricsData]);

  // Stable setter
  const setWords = useCallback(
    (newWords: ThrenicWord[] | ((prev: ThrenicWord[]) => ThrenicWord[])) => {
      setWordsRaw((prev) => (typeof newWords === 'function' ? newWords(prev) : newWords));
    },
    [],
  );

  // Debounced commit: draft → projectStore
  const debouncedWords = useDebounce(words, 500);
  const trackIdRef = useRef(trackId);
  useEffect(() => {
    trackIdRef.current = trackId;
  }, [trackId]);

  useEffect(() => {
    const currentTrackId = trackIdRef.current;
    if (!currentTrackId) return;

    const lines = threnicWordsToLyricLines(debouncedWords);
    const state = projectStore.getState();
    const currentTrack = state.tracks.find((t) => t.id === currentTrackId);
    const currentTrackLyrics = currentTrack?.lyricsData || [];

    if (safeStringify(lines) !== safeStringify(currentTrackLyrics)) {
      state.updateTrackLyrics(currentTrackId, lines);
    }
  }, [debouncedWords]);

  return { words, setWords, wordsRef };
}

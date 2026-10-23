/**
 * useLyricSync - Interactive lyric synchronization hook
 *
 * Core engine for the "Space for Word, Enter for Line" sync flow.
 * Handles latency compensation and gapless end-time filling.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { ThrenicWord } from '@/types/lyrics';
import { timeStore } from '@/engine/stores/timeStore';

// Undo event tracking
interface SyncEvent {
  type: 'WORD' | 'LINE';
  wordIndex: number;
  previousStartTime: number;
  previousEndTime: number;
  previousIsLineStart: boolean;
  newStartTime: number;
  newEndTime: number;
  newIsLineStart: boolean;
  prevWordPreviousEndTime?: number; // For gap-filling undo
  /** Number of words stamped (LINE events stamp multiple words) */
  lineWordCount?: number;
}

interface UseLyricSyncReturn {
  /** Current word array with timing data */
  words: ThrenicWord[];
  /** Index of the currently focused word */
  currentIndex: number;
  /** Whether sync mode is active */
  isSyncing: boolean;
  /** Whether audio is currently playing */
  isPlaying: boolean;
  /** Whether all words have been synced (waiting for user to confirm end) */
  isComplete: boolean;
  /** Start the sync session (plays audio from beginning) */
  startSync: () => void;
  /** Stop the sync session (exits sync mode) */
  stopSync: () => void;
  /** Toggle play/pause without exiting sync mode */
  togglePause: () => void;
  /** Register a keyboard hit (WORD = space, LINE = enter) */
  registerHit: (type: 'WORD' | 'LINE') => void;
  /** Reset sync to beginning without stopping */
  resetSync: () => void;
  /** Update words (e.g., after re-parsing) */
  setWords: (words: ThrenicWord[]) => void;
  /** Replace words mid-sync, recalculating cursor from timing data */
  replaceWords: (newWords: ThrenicWord[]) => void;
  /** Undo last timing change */
  undo: () => void;
  /** Whether undo is available */
  canUndo: boolean;
  /** Seek back and clear timings in range */
  seekBackAndClear: (seconds: number) => void;
  /** Finalize sync: stops sync and fires onComplete */
  finalizeSync: () => void;
}

interface UseLyricSyncOptions {
  /** Latency compensation in seconds (default: 0.15 for 150ms human reaction time) */
  latencyCompensation?: number;
  /** Maximum duration (seconds) a word stays highlighted before auto-closing (default: 1.0) */
  maxHighlightDuration?: number;
  /** Callback when sync completes */
  onComplete?: (words: ThrenicWord[]) => void;
}

/**
 * Hook for interactive lyric synchronization
 *
 * @param initialWords - ThrenicWord array from parser (usually with startTime: 0)
 * @param audioRef - Ref to the HTMLAudioElement for timing
 * @param options - Configuration options
 */
export function useLyricSync(
  initialWords: ThrenicWord[],
  audioRef: React.RefObject<HTMLAudioElement | null>,
  options: UseLyricSyncOptions = {},
): UseLyricSyncReturn {
  const {
    latencyCompensation = 0.15, // 150ms default
    maxHighlightDuration = 1.0,
    onComplete,
  } = options;

  const [words, setWords] = useState<ThrenicWord[]>(initialWords);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [undoStack, setUndoStack] = useState<SyncEvent[]>([]);

  // Track the last hit time for cases where we need to reference it
  const lastHitTimeRef = useRef<number>(0);
  const MAX_UNDO_STACK = 100;

  // Sync isPlaying state with audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => {
      setIsPlaying(true);
      timeStore.getState().setIsPlaying(true);
    };
    const handlePause = () => {
      setIsPlaying(false);
      timeStore.getState().setIsPlaying(false);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      timeStore.getState().setIsPlaying(false);
    };

    // Initialize state
    setIsPlaying(!audio.paused);

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [audioRef]);

  /**
   * Start sync session - plays audio from the beginning
   */
  const startSync = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Reset state
    setIsSyncing(true);
    setUndoStack([]);
    lastHitTimeRef.current = 0;
    setCurrentIndex(0);

    // Start playback
    audio.play().catch((err) => {
      console.warn('Audio playback failed:', err);
      setIsSyncing(false);
    });
  }, [audioRef]);

  /**
   * togglePause - toggles play/pause without exiting sync mode
   */
  const togglePause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      audio.play().catch((e) => console.error('Toggle play failed:', e));
    } else {
      audio.pause();
    }
  }, [audioRef]);

  /**
   * Stop sync session - pauses audio and EXITs sync mode
   */
  const stopSync = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
    }
    setIsSyncing(false);
  }, [audioRef]);

  /**
   * Reset sync to beginning without stopping
   * NOTE: This DOES wipe everything for a "fresh start" within the session
   */
  const resetSync = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    setCurrentIndex(0);
    setUndoStack([]);
    lastHitTimeRef.current = 0;
    audio.currentTime = 0;

    // Reset all words
    setWords((prev) =>
      prev.map((w) => ({
        ...w,
        startTime: 0,
        endTime: 0,
      })),
    );
  }, [audioRef]);

  /**
   * Passive playback tracker
   * Auto-advances cursor through ALREADY SYNCED words
   */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      const time = audio.currentTime;

      // Access current word from closure state
      const currentWord = words[currentIndex];

      // If we are at end or word is not synced, do nothing (wait for input)
      if (!currentWord || currentWord.startTime === 0) return;

      // If we have a next word
      if (currentIndex < words.length - 1) {
        const nextWord = words[currentIndex + 1];

        // Logic:
        // If we are playing and pass the start time of the NEXT word, advance tracking.
        if (nextWord.startTime > 0 && time >= nextWord.startTime - 0.1) {
          setCurrentIndex((prev) => prev + 1);
        }
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    return () => audio.removeEventListener('timeupdate', handleTimeUpdate);
  }, [audioRef, words, currentIndex]);

  /**
   * Register a hit - core sync logic
   *
   * WORD hit: stamps a single word and advances by one.
   * LINE hit: stamps ALL remaining words in the current line at once
   *           (evenly distributed timing) and jumps to the next line.
   */
  const registerHit = useCallback(
    (type: 'WORD' | 'LINE') => {
      if (!isSyncing) return;

      const audio = audioRef.current;
      if (!audio) return;

      // Calculate hit time with latency compensation
      const rawTime = audio.currentTime;
      const hitTime = Math.max(0, rawTime - latencyCompensation);

      if (type === 'WORD') {
        // ── Single-word advance (unchanged behaviour) ──
        const prevWord = words[currentIndex];
        const prevPrevWord = currentIndex > 0 ? words[currentIndex - 1] : null;

        const newWords = [...words];
        const targetWord = { ...newWords[currentIndex] };
        newWords[currentIndex] = targetWord;

        targetWord.startTime = hitTime;

        // Auto-close previous word
        if (currentIndex > 0) {
          const prevMovedWord = { ...newWords[currentIndex - 1] };
          prevMovedWord.endTime = Math.min(prevMovedWord.startTime + maxHighlightDuration, hitTime);
          newWords[currentIndex - 1] = prevMovedWord;
        }

        setWords(newWords);

        const event: SyncEvent = {
          type,
          wordIndex: currentIndex,
          previousStartTime: prevWord?.startTime ?? 0,
          previousEndTime: prevWord?.endTime ?? 0,
          previousIsLineStart: prevWord?.isLineStart ?? false,
          newStartTime: hitTime,
          newEndTime: 0,
          newIsLineStart: prevWord?.isLineStart ?? false,
          prevWordPreviousEndTime: prevPrevWord?.endTime,
        };

        setUndoStack((prev) => {
          const next = [...prev, event];
          return next.length > MAX_UNDO_STACK ? next.slice(next.length - MAX_UNDO_STACK) : next;
        });

        lastHitTimeRef.current = hitTime;

        if (currentIndex < words.length - 1) {
          setCurrentIndex((i) => i + 1);
        } else {
          // Last word — close it out and mark complete
          const finalWords = [...newWords];
          const lastWord = { ...finalWords[finalWords.length - 1] };
          if (lastWord.endTime === 0) {
            lastWord.endTime = hitTime + maxHighlightDuration;
            finalWords[finalWords.length - 1] = lastWord;
            setWords(finalWords);
          }
          setCurrentIndex(words.length);
        }
      } else {
        // ── LINE hit: stamp entire current line at once ──

        // Find the span of words in this line (from currentIndex to the word
        // before the next isLineStart, or end of array).
        let lineEndExclusive = currentIndex + 1;
        while (lineEndExclusive < words.length && !words[lineEndExclusive].isLineStart) {
          lineEndExclusive++;
        }

        const lineWordCount = lineEndExclusive - currentIndex;
        const lineDuration = maxHighlightDuration * lineWordCount;
        const perWordDuration = lineDuration / lineWordCount;

        const newWords = [...words];

        // Snapshot for undo (we record a single LINE event covering the whole span)
        const firstWord = words[currentIndex];
        const prevPrevWord = currentIndex > 0 ? words[currentIndex - 1] : null;

        // Auto-close the word *before* this line
        if (currentIndex > 0) {
          const prevMovedWord = { ...newWords[currentIndex - 1] };
          prevMovedWord.endTime = Math.min(prevMovedWord.startTime + maxHighlightDuration, hitTime);
          newWords[currentIndex - 1] = prevMovedWord;
        }

        // Stamp every word in the line with evenly distributed timing
        for (let i = currentIndex; i < lineEndExclusive; i++) {
          const offset = i - currentIndex;
          const wordStart = hitTime + offset * perWordDuration;
          const wordEnd = wordStart + perWordDuration;
          newWords[i] = {
            ...newWords[i],
            startTime: wordStart,
            endTime: wordEnd,
          };
        }

        setWords(newWords);

        // Push a single undo event for the whole line
        const event: SyncEvent = {
          type: 'LINE',
          wordIndex: currentIndex,
          previousStartTime: firstWord?.startTime ?? 0,
          previousEndTime: firstWord?.endTime ?? 0,
          previousIsLineStart: firstWord?.isLineStart ?? false,
          newStartTime: hitTime,
          newEndTime: hitTime + lineDuration,
          newIsLineStart: firstWord?.isLineStart ?? false,
          prevWordPreviousEndTime: prevPrevWord?.endTime,
          lineWordCount: lineWordCount,
        };

        setUndoStack((prev) => {
          const next = [...prev, event];
          return next.length > MAX_UNDO_STACK ? next.slice(next.length - MAX_UNDO_STACK) : next;
        });

        lastHitTimeRef.current = hitTime;

        if (lineEndExclusive < words.length) {
          // Jump to first word of next line
          setCurrentIndex(lineEndExclusive);
        } else {
          // That was the last line — mark complete
          setCurrentIndex(words.length);
        }
      }
    },
    [audioRef, currentIndex, isSyncing, latencyCompensation, maxHighlightDuration, words],
  );

  /**
   * Auto-complete when song ends
   */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isSyncing) return;

    const handleEnded = () => {
      // Only auto-complete if we've reached the end of the lyrics
      if (currentIndex >= words.length) {
        stopSync();
        onComplete?.(words);
      }
    };

    audio.addEventListener('ended', handleEnded);
    return () => audio.removeEventListener('ended', handleEnded);
  }, [audioRef, isSyncing, currentIndex, words, onComplete, stopSync]);

  /**
   * Undo last timing change
   */
  const undo = useCallback(() => {
    if (undoStack.length === 0) return;

    const lastEvent = undoStack[undoStack.length - 1];

    setWords((prev) => {
      const next = [...prev];
      const word = next[lastEvent.wordIndex];
      if (!word) return prev;

      if (lastEvent.type === 'LINE' && lastEvent.lineWordCount && lastEvent.lineWordCount > 1) {
        // LINE undo: reset ALL words that were stamped in the line
        for (
          let i = lastEvent.wordIndex;
          i < lastEvent.wordIndex + lastEvent.lineWordCount && i < next.length;
          i++
        ) {
          next[i] = { ...next[i], startTime: 0, endTime: 0 };
        }
      } else {
        // WORD undo: reset single word
        word.startTime = lastEvent.previousStartTime;
        word.endTime = lastEvent.previousEndTime;
        word.isLineStart = lastEvent.previousIsLineStart;
      }

      if (lastEvent.wordIndex > 0 && lastEvent.prevWordPreviousEndTime !== undefined) {
        next[lastEvent.wordIndex - 1].endTime = lastEvent.prevWordPreviousEndTime;
      }
      return next;
    });

    setCurrentIndex(lastEvent.wordIndex);
    setUndoStack((prev) => prev.slice(0, -1));
  }, [undoStack]);

  /**
   * Jump-back handler - reset words after seek position
   */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleSeeked = () => {
      const newTime = audio.currentTime;
      let newIndex = words.findIndex(
        (w) => (w.startTime > 0 && w.startTime > newTime) || w.startTime === 0,
      );

      if (newIndex === -1) {
        newIndex = words.length - 1;
      } else {
        // If we found a word that starts AFTER newTime, the active word is the one before it
        // unless that word also starts AFTER newTime... actually let's just find the first word whose startTime > newTime
        const searchIndex = words.findIndex((w) => w.startTime > newTime);
        if (searchIndex !== -1) {
          newIndex = searchIndex;
        }
      }

      setCurrentIndex(newIndex);
      if (isSyncing) {
        setUndoStack([]);
      }
    };

    audio.addEventListener('seeked', handleSeeked);
    return () => audio.removeEventListener('seeked', handleSeeked);
  }, [audioRef, words, isSyncing]);

  const seekBackAndClear = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio) return;

      const currentTime = audio.currentTime;
      const targetTime = Math.max(0, currentTime - seconds);

      const updatedWords = words.map((w, i) => {
        if (w.startTime > 0 && w.startTime >= targetTime) {
          return {
            ...w,
            startTime: 0,
            endTime: 0,
            isLineStart: initialWords[i]?.isLineStart ?? false,
          };
        }
        if (w.endTime > 0 && w.endTime >= targetTime) {
          return { ...w, endTime: 0 };
        }
        return w;
      });

      setWords(updatedWords);

      let newIndex = updatedWords.findIndex((w) => w.startTime === 0);
      if (newIndex === -1) {
        newIndex = updatedWords.length;
      }

      audio.currentTime = targetTime;
      setCurrentIndex(newIndex);
      setUndoStack([]);
    },
    [audioRef, words, initialWords],
  );

  /**
   * Replace the word array mid-sync.
   * Recalculates currentIndex to the first unsynced word.
   */
  const replaceWords = useCallback((newWords: ThrenicWord[]) => {
    setWords(newWords);
    const firstUnsynced = newWords.findIndex((w) => w.startTime === 0);
    setCurrentIndex(firstUnsynced === -1 ? newWords.length : firstUnsynced);
    setUndoStack([]);
  }, []);

  const isComplete = isSyncing && currentIndex >= words.length && words.length > 0;

  /**
   * Finalize sync: stops sync mode and fires onComplete.
   * Called by the UI's "End Lyric Sync" element.
   */
  const finalizeSync = useCallback(() => {
    stopSync();
    onComplete?.(words);
  }, [stopSync, onComplete, words]);

  return {
    words,
    currentIndex,
    isSyncing,
    isPlaying,
    isComplete,
    startSync,
    stopSync,
    togglePause,
    registerHit,
    resetSync,
    seekBackAndClear,
    setWords,
    replaceWords,
    undo,
    canUndo: undoStack.length > 0,
    finalizeSync,
  };
}

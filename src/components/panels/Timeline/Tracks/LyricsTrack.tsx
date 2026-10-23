'use client';

import React, { useRef, useEffect, memo } from 'react';
import type { ThrenicWord } from '@/types/lyrics';
import { usePlaylist } from '@/contexts';
import { pauseAutoSave, resumeAutoSave } from '@/stores';
import styles from './Tracks.module.css';

type TimelineDragWindow = Window & { __threnic_timeline_dragging?: boolean };

interface LyricsTrackProps {
  words: ThrenicWord[];
  setWords: React.Dispatch<React.SetStateAction<ThrenicWord[]>>;
  zoom: number;
  viewOffsetRef: React.MutableRefObject<number>;
  height: number;
  onAddLyricAt?: (time: number) => void;
  topPadding?: number;
  isVisible?: boolean;
}

function LyricsTrackComponent({
  words,
  setWords,
  zoom,
  viewOffsetRef,
  height,
  onAddLyricAt,
  topPadding = 0,
  isVisible = true,
}: LyricsTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  /**
   * Normalize word array to enforce the line-grouping invariant:
   *   "Every word must belong to a line."
   *
   * This preserves document order — it does NOT re-sort by startTime.
   * Sorting by time would interleave overlapping lines and corrupt
   * line membership when dragging one line across another.
   *
   * Instead it ensures each lineId group's first word has isLineStart: true,
   * and that at least the very first word in the array is a line start.
   */
  const normalizeWords = React.useCallback((words: ThrenicWord[]): ThrenicWord[] => {
    if (words.length === 0) return words;

    // 1. Assign lineIds if missing (same logic as threnicWordsToLyricLines/groups)
    const wordsWithLineId = words.map((w) => ({ ...w }));
    let currentLineId = '';
    for (const w of wordsWithLineId) {
      if (w.lineId) {
        currentLineId = w.lineId;
      } else {
        if (w.isLineStart || !currentLineId) {
          currentLineId = w.id;
        }
        w.lineId = currentLineId;
      }
    }

    // 2. Track which lineIds we've already seen
    const seenLineIds = new Set<string>();
    let anyChange = false;

    const result = wordsWithLineId.map((w, i) => {
      // First word in the entire array must always be a line start
      if (i === 0 && !w.isLineStart) {
        anyChange = true;
        const updated = { ...w, isLineStart: true };
        seenLineIds.add(w.lineId!);
        return updated;
      }

      // For words with a lineId, ensure the first occurrence has isLineStart
      const lid = w.lineId!;
      if (!seenLineIds.has(lid)) {
        seenLineIds.add(lid);
        if (!w.isLineStart) {
          anyChange = true;
          return { ...w, isLineStart: true };
        }
      } else {
        // Subsequent words in the same lineId group must NOT have isLineStart: true
        if (w.isLineStart) {
          anyChange = true;
          return { ...w, isLineStart: false };
        }
      }

      return w;
    });

    return anyChange ? result : words;
  }, []);

  /**
   * Wrapped setWords that normalizes line groupings after every mutation.
   * This is the ONLY setWords reference used within this component.
   */
  const setWordsNormalized: React.Dispatch<React.SetStateAction<ThrenicWord[]>> = React.useCallback(
    (action) => {
      setWords((prev) => {
        const next = typeof action === 'function' ? action(prev) : action;
        return normalizeWords(next);
      });
    },
    [setWords, normalizeWords],
  );

  // Sync scroll via event listener
  useEffect(() => {
    if (!isVisible) return;
    const handleOffset = (e: CustomEvent) => {
      if (trackRef.current) {
        trackRef.current.style.transform = `translate3d(${-e.detail}px, 0, 0)`;
      }
    };
    // Init
    if (trackRef.current) {
      trackRef.current.style.transform = `translate3d(${-viewOffsetRef.current}px, 0, 0)`;
    }
    window.addEventListener('threnicViewOffset', handleOffset as EventListener);
    return () => {
      window.removeEventListener('threnicViewOffset', handleOffset as EventListener);
    };
  }, [viewOffsetRef, isVisible]);

  // --- Interaction State ---
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Mobile check for touch interaction handles
  const [isMobile, setIsMobile] = React.useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Drag State
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = React.useState<string | null>(null);
  const [clipboard, setClipboard] = React.useState<ThrenicWord[]>([]);

  // Refs for stable keyboard handler — avoids re-registering the keydown
  // listener on every words / selection change.
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const lastClickedIdRef = useRef(lastClickedId);
  lastClickedIdRef.current = lastClickedId;
  type DragType =
    | 'word-move'
    | 'word-resize-start'
    | 'word-resize-end'
    | 'line-start'
    | 'line-end'
    | 'line-move';

  /**
   * Snapshot-based drag state.
   *
   * For line-move and line-start drags, we capture the original times of every
   * word in the group at drag-start. Every pointer-move frame derives new positions
   * purely from that snapshot, making the operation idempotent.
   *
   * For line-end drags, we adjust the last word's endTime directly.
   */
  interface DragStateType {
    type: DragType;
    targetId: string;
    startX: number;
    originalTime: number;
    originalEndTime?: number;
    groupWords?: string[];
    /** Snapshot of original times for all words in a group (for line-move / line-start) */
    snapshotWordTimes?: Map<string, { startTime: number; endTime: number }>;
  }

  const [dragState, setDragState] = React.useState<DragStateType | null>(null);

  // Synchronize timeline drag state to global window flag to prevent auto-saves/store jumps
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (dragState) {
      (window as TimelineDragWindow).__threnic_timeline_dragging = true;
    } else {
      (window as TimelineDragWindow).__threnic_timeline_dragging = false;
    }
    return () => {
      if (typeof window !== 'undefined') {
        (window as TimelineDragWindow).__threnic_timeline_dragging = false;
      }
    };
  }, [dragState]);

  /** Number of user-configured lanes — persisted via lyricsTheme.laneCount */
  const { selectedTrackId, tracks } = usePlaylist();
  const currentTrack = tracks.find((t) => t.id === selectedTrackId);
  const laneCount = currentTrack?.lyricsTheme?.laneCount ?? 1;
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const commitEdit = () => {
    if (editingId) {
      setWordsNormalized((prev) =>
        prev.map((w) => (w.id === editingId ? { ...w, text: editValue } : w)),
      );
      setEditingId(null);
    }
  };

  // 1. Compute Groups (Memoized)
  // Groups are computed by lineId, NOT by sorting + splitting at isLineStart.
  // This ensures line membership is independent of time order (overlapping lines stay separate).
  const groups = React.useMemo(() => {
    // Step 1: Assign lineIds if missing (legacy data migration)
    // Walk through words in their stored order; each isLineStart word starts a new line
    const wordsWithLineId = words.map((w) => ({ ...w }));
    let currentLineId = '';
    for (const w of wordsWithLineId) {
      if (w.lineId) {
        currentLineId = w.lineId;
      } else {
        if (w.isLineStart || !currentLineId) {
          currentLineId = w.id;
        }
        w.lineId = currentLineId;
      }
    }

    // Step 2: Group by lineId
    const lineMap = new Map<string, ThrenicWord[]>();
    for (const w of wordsWithLineId) {
      const lid = w.lineId!;
      if (!lineMap.has(lid)) lineMap.set(lid, []);
      lineMap.get(lid)!.push(w);
    }

    // Step 3: Build group descriptors from each line
    const res: {
      id: string;
      words: ThrenicWord[];
      startTime: number;
      endTime: number;
      laneIndex: number;
      startIndex: number;
    }[] = [];

    lineMap.forEach((lineWords, lineId) => {
      // Sort words within the line by startTime for display
      lineWords.sort((a, b) => a.startTime - b.startTime);
      const start = Math.min(...lineWords.map((w) => w.startTime));
      const end = Math.max(...lineWords.map((w) => w.endTime));
      const firstWord = lineWords[0];

      res.push({
        id: lineId,
        words: lineWords,
        startTime: start,
        endTime: end,
        laneIndex: 0,
        startIndex: words.findIndex((w) => w.id === firstWord.id),
      });
    });

    // Sort groups by startTime for consistent rendering order
    res.sort((a, b) => a.startTime - b.startTime);

    // Simple Lane Packing for Overlaps (Visual only)
    // Use user-assigned laneIndex if available, otherwise force to lane 0 for single lane
    if (laneCount > 1) {
      // User-managed lanes: use laneIndex from line-start word, clamped to laneCount
      res.forEach((g) => {
        const firstWord = g.words[0];
        g.laneIndex = Math.min(firstWord?.laneIndex ?? 0, laneCount - 1);
      });
    } else {
      // Force all groups to lane 0 when laneCount is 1 (single lane)
      res.forEach((g) => {
        g.laneIndex = 0;
      });
    }

    const totalLanes = laneCount > 1 ? laneCount : 1;
    return { groups: res, totalLanes };
  }, [words, laneCount]);

  // ── Drag Helpers ──

  const handlePointerDown = (
    e: React.PointerEvent,
    id: string,
    type: DragType,
    originalTime: number,
    originalEndTime?: number,
    groupWords?: string[],
  ) => {
    if (editingId) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    // Synchronously lock dragging state and pause autosave to prevent main-thread lag spikes
    if (typeof window !== 'undefined') {
      (window as TimelineDragWindow).__threnic_timeline_dragging = true;
    }
    pauseAutoSave();

    // Build snapshot of word times for line-move/line-start so each frame is idempotent
    let snapshotWordTimes: Map<string, { startTime: number; endTime: number }> | undefined;
    if ((type === 'line-move' || type === 'line-start') && groupWords) {
      snapshotWordTimes = new Map(
        words
          .filter((w) => groupWords.includes(w.id))
          .map((w) => [w.id, { startTime: w.startTime, endTime: w.endTime }]),
      );
    }

    setDragState({
      type,
      targetId: id,
      startX: e.clientX,
      originalTime,
      originalEndTime,
      groupWords,
      snapshotWordTimes,
    });
  };

  // Dynamic global event tracking for seamless touch dragging/pulling on mobile and desktop
  useEffect(() => {
    if (!dragState) return;

    const onPointerMove = (e: PointerEvent) => {
      e.preventDefault();

      const deltaPixels = e.clientX - dragState.startX;
      const deltaTime = deltaPixels / zoom;
      const minDuration = 0.1;

      setWordsNormalized((prev) => {
        const current = prev;

        // ── Word Dragging (Time Adjustment) ──
        if (dragState.type.startsWith('word')) {
          return current.map((w) => {
            if (w.id !== dragState.targetId) return w;

            let newStart = w.startTime;
            let newEnd = w.endTime;

            if (dragState.type === 'word-move') {
              const duration = (dragState.originalEndTime || 0) - dragState.originalTime;
              newStart = Math.max(0, dragState.originalTime + deltaTime);
              newEnd = newStart + duration;
            } else if (dragState.type === 'word-resize-start') {
              newStart = Math.max(
                0,
                Math.min(
                  dragState.originalTime + deltaTime,
                  (dragState.originalEndTime || 0) - minDuration,
                ),
              );
            } else if (dragState.type === 'word-resize-end') {
              newEnd = Math.max(
                dragState.originalTime + minDuration,
                (dragState.originalEndTime || 0) + deltaTime,
              );
            }
            return { ...w, startTime: newStart, endTime: newEnd };
          });
        }

        // ── Line Move ──
        if (dragState.type === 'line-move' && dragState.snapshotWordTimes) {
          const snapshot = dragState.snapshotWordTimes;
          return current.map((w) => {
            const original = snapshot.get(w.id);
            if (!original) return w;
            const newStart = Math.max(0, original.startTime + deltaTime);
            const duration = original.endTime - original.startTime;
            return { ...w, startTime: newStart, endTime: newStart + duration };
          });
        }

        // ── Line Handle Dragging ──
        if (dragState.type === 'line-start' && dragState.snapshotWordTimes) {
          const snapshot = dragState.snapshotWordTimes;
          return current.map((w) => {
            const original = snapshot.get(w.id);
            if (!original) return w;
            const newStart = Math.max(0, original.startTime + deltaTime);
            const duration = original.endTime - original.startTime;
            return { ...w, startTime: newStart, endTime: newStart + duration };
          });
        }

        if (dragState.type === 'line-end') {
          const targetTime = Math.max(0, dragState.originalTime + deltaTime);
          return current.map((w) => {
            if (w.id === dragState.targetId) {
              return { ...w, endTime: Math.max(w.startTime + 0.05, targetTime) };
            }
            return w;
          });
        }

        return prev;
      });
    };

    const onPointerUp = () => {
      if (typeof window !== 'undefined') {
        (window as TimelineDragWindow).__threnic_timeline_dragging = false;
      }
      resumeAutoSave();
      setDragState(null);
      setWordsNormalized((prev) => prev);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [dragState, zoom, setWordsNormalized]);

  // Keyboard Listeners — uses refs so the listener is registered once.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA'
      )
        return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIdsRef.current.size > 0) {
          handleDeleteSelected();
        } else if (lastClickedIdRef.current) {
          handleDeleteWord(lastClickedIdRef.current);
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (selectedIdsRef.current.size > 0) handleCopy();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        // Paste at playhead? Or just use context menu for now.
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context Menu
  const [contextMenu, setContextMenu] = React.useState<{
    x: number;
    y: number;
    type: 'word' | 'track' | 'line';
    wordId?: string;
    wordText?: string;
    time?: number;
    lineId?: string;
  } | null>(null);

  const lastTapRef = React.useRef<{ time: number; id: string }>({ time: 0, id: '' });

  useEffect(() => {
    const handleClose = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(`.${styles.contextMenu}`)) return;
      setContextMenu(null);
    };
    const handleScroll = () => setContextMenu(null);

    // Use capture phase for reliable closing across track boundaries
    window.addEventListener('pointerdown', handleClose, { capture: true });
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', handleClose, { capture: true });
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const handleWordContextMenu = (e: React.MouseEvent, word: ThrenicWord) => {
    e.preventDefault();
    e.stopPropagation();

    // If word is not already selected, select only it
    if (!selectedIds.has(word.id)) {
      setSelectedIds(new Set([word.id]));
    }

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: 'word',
      wordId: word.id,
      wordText: word.text,
    });
    setLastClickedId(word.id);
  };

  const handleLineContextMenu = (e: React.MouseEvent, group: { id: string }) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: 'line',
      lineId: group.id,
    });
  };

  const handleTrackContextMenu = (e: React.MouseEvent) => {
    // Safety: if the click was actually on a word block or child, ignore it here
    // to prevent potential racing with handleWordContextMenu stopPropagation
    if ((e.target as HTMLElement).closest(`.${styles.wordBlock}`)) return;

    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const absoluteX = clickX + viewOffsetRef.current;
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'track', time: absoluteX / zoom });
  };

  const handleClearAll = () => {
    if (window.confirm('Are you sure you want to remove ALL lyrics from this track?')) {
      setWordsNormalized([]);
    }
  };

  // Bulk Operations
  const handleCopy = () => {
    const currentWords = wordsRef.current;
    const currentSelectedIds = selectedIdsRef.current;
    const selectedWords = currentWords
      .filter((w) => currentSelectedIds.has(w.id))
      .sort((a, b) => a.startTime - b.startTime);
    if (selectedWords.length === 0) return;

    const baseTime = selectedWords[0].startTime;
    const copyBuffer = selectedWords.map((w) => ({
      ...w,
      startTime: w.startTime - baseTime,
      endTime: w.endTime - baseTime,
    }));

    setClipboard(copyBuffer);
  };

  /** Copy all words in the line containing the given word. */
  const handleCopyLine = (wordId: string) => {
    const sorted = [...wordsRef.current].sort((a, b) => a.startTime - b.startTime);
    const wordIdx = sorted.findIndex((w) => w.id === wordId);
    if (wordIdx === -1) return;

    // Walk backward to line start
    let start = wordIdx;
    while (start > 0 && !sorted[start].isLineStart) start--;

    // Walk forward to next line start
    let end = wordIdx + 1;
    while (end < sorted.length && !sorted[end].isLineStart) end++;

    const lineWords = sorted.slice(start, end);
    if (lineWords.length === 0) return;

    const baseTime = lineWords[0].startTime;
    const copyBuffer = lineWords.map((w, i) => ({
      ...w,
      startTime: w.startTime - baseTime,
      endTime: w.endTime - baseTime,
      isLineStart: i === 0, // First word of copied line is always a line start
    }));

    setClipboard(copyBuffer);
  };

  const handlePaste = (time: number) => {
    if (clipboard.length === 0) return;

    const newWords = clipboard.map((w) => ({
      ...w,
      id: crypto.randomUUID(),
      startTime: w.startTime + time,
      endTime: w.endTime + time,
    }));

    setWordsNormalized((prev) => [...prev, ...newWords].sort((a, b) => a.startTime - b.startTime));
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    setWordsNormalized((prev) => prev.filter((w) => !selectedIds.has(w.id)));
    setSelectedIds(new Set());
    setLastClickedId(null);
  };

  const handleDeleteWord = (id: string) => {
    setWordsNormalized((prev) => {
      const index = prev.findIndex((w) => w.id === id);
      if (index === -1) return prev;
      const wordToDelete = prev[index];
      const newWords = [...prev];
      if (wordToDelete.isLineStart && index + 1 < newWords.length) {
        newWords[index + 1] = {
          ...newWords[index + 1],
          isLineStart: true,
          lineId: wordToDelete.lineId,
          laneIndex: wordToDelete.laneIndex,
        };
      }
      newWords.splice(index, 1);
      return newWords;
    });
    if (lastClickedId === id) setLastClickedId(null);
  };

  const handleDeleteLine = (id: string) => {
    setWordsNormalized((prev) => {
      const targetIndex = prev.findIndex((w) => w.id === id);
      if (targetIndex === -1) return prev;

      let start = targetIndex;
      while (start > 0 && !prev[start].isLineStart) {
        start--;
      }

      let end = targetIndex + 1;
      while (end < prev.length && !prev[end].isLineStart) {
        end++;
      }

      return prev.filter((_, i) => i < start || i >= end);
    });
    setLastClickedId(null);
  };

  /** Assign a line (identified by any word in it) to a specific lane */
  const handleSetLane = (wordId: string, lane: number) => {
    const sorted = [...words].sort((a, b) => a.startTime - b.startTime);
    const wordIdx = sorted.findIndex((w) => w.id === wordId);
    if (wordIdx === -1) return;

    // Find the line-start word for this line
    let startIdx = wordIdx;
    while (startIdx > 0 && !sorted[startIdx].isLineStart) startIdx--;

    const lineStartWord = sorted[startIdx];
    setWordsNormalized((prev) =>
      prev.map((w) => (w.id === lineStartWord.id ? { ...w, laneIndex: lane } : w)),
    );
  };

  const handleAddLineStart = (wordId: string) => {
    setWordsNormalized((prev) => {
      const targetIndex = prev.findIndex((w) => w.id === wordId);
      if (targetIndex === -1) return prev;
      const targetWord = prev[targetIndex];

      const originalLineId = targetWord.lineId || targetWord.id;
      const lineWords = prev.filter((w) => (w.lineId || w.id) === originalLineId);

      const sortedLineWords = [...lineWords].sort((a, b) => a.startTime - b.startTime);
      const targetInSortedIdx = sortedLineWords.findIndex((w) => w.id === wordId);
      if (targetInSortedIdx === -1) return prev;

      const splitWordIds = new Set(sortedLineWords.slice(targetInSortedIdx).map((w) => w.id));
      const newLineId = targetWord.id;

      return prev.map((w) => {
        if (splitWordIds.has(w.id)) {
          return {
            ...w,
            isLineStart: w.id === wordId ? true : w.isLineStart,
            lineId: newLineId,
          };
        }
        return w;
      });
    });
  };

  const handleRemoveLineStart = (lineId: string) => {
    setWordsNormalized((prev) => {
      const sortedGroups = groups.groups;
      const groupIdx = sortedGroups.findIndex((g) => g.id === lineId);
      if (groupIdx <= 0) return prev;

      const prevGroup = sortedGroups[groupIdx - 1];
      const currentGroup = sortedGroups[groupIdx];

      const currentWordIds = new Set(currentGroup.words.map((w) => w.id));
      const prevLineId = prevGroup.id;

      return prev.map((w) => {
        if (currentWordIds.has(w.id)) {
          return {
            ...w,
            isLineStart: false,
            lineId: prevLineId,
          };
        }
        return w;
      });
    });
  };

  const handleRemoveLineEnd = (lineId: string) => {
    setWordsNormalized((prev) => {
      const sortedGroups = groups.groups;
      const groupIdx = sortedGroups.findIndex((g) => g.id === lineId);
      if (groupIdx === -1 || groupIdx >= sortedGroups.length - 1) return prev;

      const currentGroup = sortedGroups[groupIdx];
      const nextGroup = sortedGroups[groupIdx + 1];

      const nextWordIds = new Set(nextGroup.words.map((w) => w.id));
      const currentLineId = currentGroup.id;

      return prev.map((w) => {
        if (nextWordIds.has(w.id)) {
          return {
            ...w,
            isLineStart: false,
            lineId: currentLineId,
          };
        }
        return w;
      });
    });
  };

  // Render Calc
  const effectiveHeight = height - topPadding;
  // Single lane: use full height. Multi-lane: divide evenly with minimal padding.
  const laneHeight = groups.totalLanes <= 1 ? effectiveHeight : effectiveHeight / groups.totalLanes;

  return (
    <div
      className={styles.lyricsTrackContainer}
      ref={containerRef}
      style={{ height, width: '100%', overflow: 'hidden', position: 'relative' }}
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        if (
          target === e.currentTarget ||
          target.classList.contains(styles.lyricsTrackContent) ||
          target.classList.contains(styles.laneDivider)
        ) {
          setSelectedIds(new Set());
          setLastClickedId(null);
        }
      }}
      onTouchStart={(e) => {
        const target = e.target as HTMLElement;
        if (
          target === e.currentTarget ||
          target.classList.contains(styles.lyricsTrackContent) ||
          target.classList.contains(styles.laneDivider)
        ) {
          const now = Date.now();
          const DOUBLE_PRESS_DELAY = 300;
          if (
            now - lastTapRef.current.time < DOUBLE_PRESS_DELAY &&
            lastTapRef.current.id === 'track'
          ) {
            e.preventDefault();
            const touch = e.touches[0] || e.changedTouches[0];
            if (touch) {
              const rect = e.currentTarget.getBoundingClientRect();
              const clickX = touch.clientX - rect.left;
              const absoluteX = clickX + viewOffsetRef.current;
              setContextMenu({
                x: touch.clientX,
                y: touch.clientY,
                type: 'track',
                time: absoluteX / zoom,
              });
            }
          }
          lastTapRef.current = { time: now, id: 'track' };
        }
      }}
      onContextMenu={handleTrackContextMenu}
    >
      {/* Lane Count Control moved to TrackWidget header */}

      {/* Lane Dividers (visible when multi-lane) */}
      {laneCount > 1 &&
        Array.from({ length: laneCount }).map((_, i) => (
          <div
            key={`lane-divider-${i}`}
            className={styles.laneDivider}
            style={{
              top: topPadding + i * laneHeight,
              height: laneHeight,
              borderBottom: i < laneCount - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
            }}
          >
            <span className={styles.laneNumber}>{i + 1}</span>
          </div>
        ))}
      <div
        ref={trackRef}
        className={styles.lyricsTrackContent}
        style={{ height: '100%', position: 'absolute', top: 0, left: 0, width: 'max-content' }}
      >
        {/* Render Groups and Handles */}
        {groups.groups.map((group) => {
          const top = topPadding + group.laneIndex * laneHeight;
          const h = laneHeight * 0.7;
          const y = top + (laneHeight - h) / 2;

          const isLineDragging =
            dragState?.type === 'line-move' && dragState?.targetId === group.id;

          return (
            <React.Fragment key={'group-viz-' + group.id}>
              {/* Line Box (Draggable — moves entire line) */}
              <div
                className={`${styles.lineBox} ${isLineDragging ? styles.lineBoxDragging : ''}`}
                style={{
                  left: group.startTime * zoom,
                  width: (group.endTime - group.startTime) * zoom,
                  top: top,
                  height: laneHeight,
                }}
                onPointerDown={(e) =>
                  handlePointerDown(
                    e,
                    group.id,
                    'line-move',
                    group.startTime,
                    undefined,
                    group.words.map((w) => w.id),
                  )
                }
                onClick={(e) => e.stopPropagation()}
                onTouchStart={(e) => {
                  const now = Date.now();
                  const DOUBLE_PRESS_DELAY = 300;
                  if (
                    now - lastTapRef.current.time < DOUBLE_PRESS_DELAY &&
                    lastTapRef.current.id === `line-${group.id}`
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    const touch = e.touches[0] || e.changedTouches[0];
                    if (touch) {
                      setContextMenu({
                        x: touch.clientX,
                        y: touch.clientY,
                        type: 'line',
                        lineId: group.id,
                      });
                    }
                  }
                  lastTapRef.current = { time: now, id: `line-${group.id}` };
                }}
                onContextMenu={(e) => handleLineContextMenu(e, group)}
              >
                <div className={styles.lineGrip}>
                  <div className={styles.lineGripDot} />
                  <div className={styles.lineGripDot} />
                </div>
              </div>

              {/* START HANDLE */}
              <div
                className={`${styles.lineHandle} ${styles.lineHandleStart}`}
                style={{
                  left: group.startTime * zoom - 5,
                  top: top,
                  height: laneHeight,
                }}
                onPointerDown={(e) =>
                  handlePointerDown(
                    e,
                    group.id,
                    'line-start',
                    group.startTime,
                    undefined,
                    group.words.map((w) => w.id),
                  )
                }
                onClick={(e) => e.stopPropagation()}
              >
                <div className={styles.lineHandleBar}></div>
              </div>

              {/* END HANDLE */}
              <div
                className={`${styles.lineHandle} ${styles.lineHandleEnd}`}
                style={{
                  left: group.endTime * zoom - 5,
                  top: top,
                  height: laneHeight,
                }}
                onPointerDown={(e) =>
                  handlePointerDown(
                    e,
                    group.words[group.words.length - 1].id,
                    'line-end',
                    group.endTime,
                    undefined,
                    group.words.map((w) => w.id),
                  )
                }
                onClick={(e) => e.stopPropagation()}
              >
                <div className={styles.lineHandleBar}></div>
              </div>

              {/* WORDS */}
              {group.words.map((word) => {
                const isDragging =
                  dragState?.targetId === word.id && dragState.type.startsWith('word');
                return (
                  <div
                    key={word.id}
                    className={`${styles.wordBlock} ${selectedIds.has(word.id) ? styles.selectedWord : ''}`}
                    style={{
                      left: word.startTime * zoom,
                      width: Math.max(2, (word.endTime - word.startTime) * zoom),
                      top: y,
                      height: h,
                      backgroundColor: isDragging
                        ? 'var(--crucible-red)'
                        : selectedIds.has(word.id)
                          ? isMobile
                            ? 'rgba(16, 185, 129, 0.25)'
                            : 'rgba(239, 68, 68, 0.5)'
                          : undefined,
                      border:
                        isMobile && selectedIds.has(word.id) ? '1.5px solid #10b981' : undefined,
                      boxShadow:
                        isMobile && selectedIds.has(word.id)
                          ? '0 0 10px rgba(16, 185, 129, 0.6)'
                          : undefined,
                      zIndex: isDragging || selectedIds.has(word.id) ? 25 : 10,
                      overflow: isMobile && selectedIds.has(word.id) ? 'visible' : undefined,
                    }}
                    onPointerDown={(e) => {
                      handlePointerDown(e, word.id, 'word-move', word.startTime, word.endTime);

                      if (e.shiftKey) {
                        const newIds = new Set(selectedIds);
                        if (newIds.has(word.id)) newIds.delete(word.id);
                        else newIds.add(word.id);
                        setSelectedIds(newIds);
                      } else {
                        setSelectedIds(new Set([word.id]));
                      }

                      setLastClickedId(word.id);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onTouchStart={(e) => {
                      const now = Date.now();
                      const DOUBLE_PRESS_DELAY = 300;
                      if (
                        now - lastTapRef.current.time < DOUBLE_PRESS_DELAY &&
                        lastTapRef.current.id === `word-${word.id}`
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        const touch = e.touches[0] || e.changedTouches[0];
                        if (touch) {
                          if (!selectedIds.has(word.id)) {
                            setSelectedIds(new Set([word.id]));
                          }
                          setContextMenu({
                            x: touch.clientX,
                            y: touch.clientY,
                            type: 'word',
                            wordId: word.id,
                            wordText: word.text,
                          });
                          setLastClickedId(word.id);
                        }
                      }
                      lastTapRef.current = { time: now, id: `word-${word.id}` };
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingId(word.id);
                      setEditValue(word.text);
                    }}
                    onContextMenu={(e) => handleWordContextMenu(e, word)}
                  >
                    {!isDragging && editingId === word.id ? (
                      <input
                        ref={editInputRef}
                        className={styles.wordInput}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit();
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        {/* Mobile left resize touch handle */}
                        {isMobile && selectedIds.has(word.id) && (
                          <div
                            style={{
                              position: 'absolute',
                              left: -16,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              width: 32,
                              height: 32,
                              zIndex: 100,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'col-resize',
                              touchAction: 'none',
                            }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              handlePointerDown(
                                e,
                                word.id,
                                'word-resize-start',
                                word.startTime,
                                word.endTime,
                              );
                            }}
                          >
                            <div
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: '50%',
                                backgroundColor: '#10b981',
                                border: '2px solid #ffffff',
                                boxShadow: '0 0 8px #10b981',
                              }}
                            />
                          </div>
                        )}

                        <div
                          className={`${styles.resizeHandle} ${styles.resizeHandleLeft}`}
                          onPointerDown={(e) =>
                            handlePointerDown(
                              e,
                              word.id,
                              'word-resize-start',
                              word.startTime,
                              word.endTime,
                            )
                          }
                        />
                        <span className={styles.wordText}>{word.text}</span>
                        <div
                          className={`${styles.resizeHandle} ${styles.resizeHandleRight}`}
                          onPointerDown={(e) =>
                            handlePointerDown(
                              e,
                              word.id,
                              'word-resize-end',
                              word.startTime,
                              word.endTime,
                            )
                          }
                        />

                        {/* Mobile right resize touch handle */}
                        {isMobile && selectedIds.has(word.id) && (
                          <div
                            style={{
                              position: 'absolute',
                              right: -16,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              width: 32,
                              height: 32,
                              zIndex: 100,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'col-resize',
                              touchAction: 'none',
                            }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              handlePointerDown(
                                e,
                                word.id,
                                'word-resize-end',
                                word.startTime,
                                word.endTime,
                              );
                            }}
                          >
                            <div
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: '50%',
                                backgroundColor: '#10b981',
                                border: '2px solid #ffffff',
                                boxShadow: '0 0 8px #10b981',
                              }}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
      {/* Context Menu */}
      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'word' && contextMenu.wordId && (
            <>
              {(() => {
                const wordGroup = groups.groups.find((g) =>
                  g.words.some((w) => w.id === contextMenu.wordId),
                );
                if (!wordGroup) return null;
                const groupIdx = groups.groups.indexOf(wordGroup);
                const isFirstWord = wordGroup.words[0]?.id === contextMenu.wordId;
                const isLastWord =
                  wordGroup.words[wordGroup.words.length - 1]?.id === contextMenu.wordId;

                return (
                  <>
                    <button
                      className={styles.contextMenuBtn}
                      onClick={() => {
                        setEditingId(contextMenu.wordId!);
                        setEditValue(contextMenu.wordText || '');
                        setContextMenu(null);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className={styles.contextMenuBtn}
                      onClick={() => {
                        handleCopy();
                        setContextMenu(null);
                      }}
                    >
                      Copy Selection
                    </button>
                    <button
                      className={styles.contextMenuBtn}
                      onClick={() => {
                        handleCopyLine(contextMenu.wordId!);
                        setContextMenu(null);
                      }}
                    >
                      Copy Entire Line
                    </button>

                    {isFirstWord && groupIdx > 0 && (
                      <button
                        className={styles.contextMenuBtn}
                        onClick={() => {
                          handleRemoveLineStart(wordGroup.id);
                          setContextMenu(null);
                        }}
                      >
                        Remove Line Start
                      </button>
                    )}
                    {isLastWord && groupIdx < groups.groups.length - 1 && (
                      <button
                        className={styles.contextMenuBtn}
                        onClick={() => {
                          handleRemoveLineEnd(wordGroup.id);
                          setContextMenu(null);
                        }}
                      >
                        Remove Line End
                      </button>
                    )}
                    {!isFirstWord && (
                      <button
                        className={styles.contextMenuBtn}
                        onClick={() => {
                          handleAddLineStart(contextMenu.wordId!);
                          setContextMenu(null);
                        }}
                      >
                        Add Line Start Here
                      </button>
                    )}

                    {laneCount > 1 && (
                      <>
                        <div className={styles.divider} />
                        <div className={styles.laneSelector}>
                          <span className={styles.laneSelectorLabel}>Lane:</span>
                          {Array.from({ length: laneCount }).map((_, i) => (
                            <button
                              key={`lane-${i}`}
                              className={styles.contextMenuBtn}
                              style={{
                                minWidth: 22,
                                padding: '2px 4px',
                                textAlign: 'center',
                                background: (() => {
                                  const sorted = [...words].sort(
                                    (a, b) => a.startTime - b.startTime,
                                  );
                                  const wIdx = sorted.findIndex((w) => w.id === contextMenu.wordId);
                                  if (wIdx === -1) return 'transparent';
                                  let sIdx = wIdx;
                                  while (sIdx > 0 && !sorted[sIdx].isLineStart) sIdx--;
                                  return (sorted[sIdx].laneIndex ?? 0) === i
                                    ? 'rgba(239, 68, 68, 0.3)'
                                    : 'transparent';
                                })(),
                              }}
                              onClick={() => {
                                handleSetLane(contextMenu.wordId!, i);
                                setContextMenu(null);
                              }}
                            >
                              {i + 1}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    <button
                      className={styles.contextMenuBtn}
                      style={{ color: '#ef4444' }}
                      onClick={() => {
                        handleDeleteSelected();
                        setContextMenu(null);
                      }}
                    >
                      Remove Selected
                    </button>
                    <div className={styles.divider} />
                    <button
                      className={styles.contextMenuBtn}
                      style={{ color: '#ef4444' }}
                      onClick={() => {
                        handleDeleteWord(contextMenu.wordId!);
                        setContextMenu(null);
                      }}
                    >
                      Remove Word
                    </button>
                    <button
                      className={styles.contextMenuBtn}
                      style={{ color: '#ef4444' }}
                      onClick={() => {
                        handleDeleteLine(contextMenu.wordId!);
                        setContextMenu(null);
                      }}
                    >
                      Remove Entire Line
                    </button>
                  </>
                );
              })()}
            </>
          )}
          {contextMenu.type === 'line' && contextMenu.lineId && (
            <>
              {(() => {
                const groupIdx = groups.groups.findIndex((g) => g.id === contextMenu.lineId);
                const hasPrev = groupIdx > 0;
                const hasNext = groupIdx !== -1 && groupIdx < groups.groups.length - 1;
                const group = groups.groups[groupIdx];
                const firstWordId = group?.words[0]?.id;

                return (
                  <>
                    {hasPrev && (
                      <button
                        className={styles.contextMenuBtn}
                        onClick={() => {
                          handleRemoveLineStart(contextMenu.lineId!);
                          setContextMenu(null);
                        }}
                      >
                        Remove Line Start
                      </button>
                    )}
                    {hasNext && (
                      <button
                        className={styles.contextMenuBtn}
                        onClick={() => {
                          handleRemoveLineEnd(contextMenu.lineId!);
                          setContextMenu(null);
                        }}
                      >
                        Remove Line End
                      </button>
                    )}
                    {firstWordId && (
                      <button
                        className={styles.contextMenuBtn}
                        onClick={() => {
                          handleCopyLine(firstWordId);
                          setContextMenu(null);
                        }}
                      >
                        Copy Entire Line
                      </button>
                    )}
                    {firstWordId && (
                      <button
                        className={styles.contextMenuBtn}
                        style={{ color: '#ef4444' }}
                        onClick={() => {
                          handleDeleteLine(firstWordId);
                          setContextMenu(null);
                        }}
                      >
                        Remove Entire Line
                      </button>
                    )}
                  </>
                );
              })()}
            </>
          )}
          {contextMenu.type === 'track' && (
            <>
              <button
                className={styles.contextMenuBtn}
                onClick={() => {
                  if (onAddLyricAt && contextMenu.time !== undefined) {
                    onAddLyricAt(contextMenu.time);
                  }
                  setContextMenu(null);
                }}
              >
                Add Lyric
              </button>
              {clipboard.length > 0 && (
                <button
                  className={styles.contextMenuBtn}
                  onClick={() => {
                    if (contextMenu.time !== undefined) handlePaste(contextMenu.time);
                    setContextMenu(null);
                  }}
                >
                  Paste Here
                </button>
              )}
              <div className={styles.divider} />
              <button
                className={styles.contextMenuBtn}
                style={{ color: '#ef4444' }}
                onClick={() => {
                  handleClearAll();
                  setContextMenu(null);
                }}
              >
                Clear All Lyrics
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Memoize to prevent re-renders when parent timeline updates (unless essential props change)
export const LyricsTrack = memo(LyricsTrackComponent);

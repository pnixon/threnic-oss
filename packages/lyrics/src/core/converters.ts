/**
 * Lyric Format Conversion Utilities
 * Functions to convert between different lyric data structures.
 * Moved from the Threnic app (src/engine/lyrics/converters.ts).
 */

import type { LyricLineData, Word } from '../types/core';
import type { ThrenicWord } from '../types/threnic-schema';

/**
 * Convert LyricLineData array to ThrenicWord array.
 * Preserves word-level timing if available, otherwise creates from line timing.
 */
export function lyricLinesToThrenicWords(lines: LyricLineData[]): ThrenicWord[] {
  const words: ThrenicWord[] = [];

  for (const line of lines) {
    const lineId = crypto.randomUUID(); // Persistent line identifier

    if (line.words && line.words.length > 0) {
      const lastWord = line.words[line.words.length - 1];

      for (let i = 0; i < line.words.length; i++) {
        const word = line.words[i];
        const isFirst = i === 0;

        words.push({
          id: crypto.randomUUID(),
          text: word.text,
          startTime: word.start,
          endTime: word.end,
          isLineStart: isFirst,
          lineId,
          lineStartX: isFirst && line.start < word.start - 0.001 ? line.start : undefined,
          lineEndX: isFirst && line.end > lastWord.end + 0.001 ? line.end : undefined,
          ...(isFirst && line.laneIndex !== undefined ? { laneIndex: line.laneIndex } : {}),
        });
      }
    } else {
      const lineWords = (line.text || '')
        .trim()
        .split(/\s+/)
        .filter((w) => w);
      const wordDuration = (line.end - line.start) / lineWords.length;

      for (let i = 0; i < lineWords.length; i++) {
        words.push({
          id: crypto.randomUUID(),
          text: lineWords[i],
          startTime: line.start + i * wordDuration,
          endTime: line.start + (i + 1) * wordDuration,
          isLineStart: i === 0,
          lineId,
          ...(i === 0 && line.laneIndex !== undefined ? { laneIndex: line.laneIndex } : {}),
        });
      }
    }
  }

  return words;
}

/**
 * Convert ThrenicWord array back to LyricLineData array.
 * Groups words by lineId (falls back to isLineStart markers for legacy data).
 */
export function threnicWordsToLyricLines(words: ThrenicWord[]): LyricLineData[] {
  if (words.length === 0) return [];

  // Assign lineIds if missing (same logic as LyricsTrack)
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

  // Group by lineId
  const lineMap = new Map<string, ThrenicWord[]>();
  for (const w of wordsWithLineId) {
    const lid = w.lineId!;
    if (!lineMap.has(lid)) lineMap.set(lid, []);
    lineMap.get(lid)!.push(w);
  }

  // Build lines sorted by earliest word startTime
  const lines: LyricLineData[] = [];
  const entries = [...lineMap.entries()].sort((a, b) => {
    const aStart = Math.min(
      ...a[1].map((w) => (w.startTime === 0 && w.endTime === 0 ? Infinity : w.startTime)),
    );
    const bStart = Math.min(
      ...b[1].map((w) => (w.startTime === 0 && w.endTime === 0 ? Infinity : w.startTime)),
    );
    return aStart - bStart;
  });

  for (const [lineId, lineWords] of entries) {
    lineWords.sort((a, b) => {
      const aTime = a.startTime === 0 && a.endTime === 0 ? Infinity : a.startTime;
      const bTime = b.startTime === 0 && b.endTime === 0 ? Infinity : b.startTime;
      return aTime - bTime;
    });
    const id = `line-${lineId}`;
    lines.push(createLineFromWords(lineWords, id));
  }

  return lines;
}

/**
 * Automatically assign lanes to lyric lines to prevent temporal overlaps.
 * Uses a greedy "lowest available lane" algorithm.
 */
export function autoAssignLanes(lines: LyricLineData[], maxLanes = 6): LyricLineData[] {
  if (lines.length <= 1) return lines;

  // Sort lines by start time
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  const laneEndTimes = new Array(maxLanes).fill(-1);

  return sorted.map((line) => {
    // If it already has a manually assigned lane (from a source that supports it), respect it
    if (line.laneIndex !== undefined && line.laneIndex < maxLanes) {
      laneEndTimes[line.laneIndex] = line.end;
      return line;
    }

    // Find the first lane that is free at line.start
    let assignedLane = 0;
    for (let i = 0; i < maxLanes; i++) {
      if (laneEndTimes[i] <= line.start) {
        assignedLane = i;
        break;
      }
      // If we've checked all lanes and they're all busy, wrap back to lane 0
      // (Visual collision is unavoidable if more lines overlap than maxLanes)
      if (i === maxLanes - 1) {
        assignedLane = 0;
      }
    }

    laneEndTimes[assignedLane] = line.end;
    return { ...line, laneIndex: assignedLane };
  });
}

function createLineFromWords(words: ThrenicWord[], id: string): LyricLineData {
  const startWord = words[0];
  const lastWord = words[words.length - 1];

  // Derive line boundaries from word times, but honor explicit
  // lineStartX/lineEndX overrides if they widen the range.
  let lineStart = startWord.startTime;
  let lineEnd = lastWord.endTime;

  if (startWord.lineStartX !== undefined && startWord.lineStartX < lineStart) {
    lineStart = startWord.lineStartX;
  }
  if (lastWord.lineEndX !== undefined && lastWord.lineEndX > lineEnd) {
    lineEnd = lastWord.lineEndX;
  }

  return {
    id,
    text: words.map((w) => w.text).join(' '),
    start: lineStart,
    end: lineEnd,
    words: words.map(
      (w): Word => ({
        text: w.text,
        start: w.startTime,
        end: w.endTime,
      }),
    ),
    laneIndex: startWord.laneIndex,
  };
}

/**
 * Smartly reconcile timings between an old list of words and a new list of words.
 * Handles insertions and deletions by looking ahead giving priority to matching text.
 */
export function reconcileWordTimings(
  sourceWords: ThrenicWord[],
  newWords: ThrenicWord[],
): ThrenicWord[] {
  if (sourceWords.length === 0) return newWords;

  const result = [...newWords];
  let sourceIndex = 0;
  const LOOKAHEAD = 5; // How far to look ahead for a match

  for (let i = 0; i < result.length; i++) {
    const newWord = result[i];
    if (sourceIndex >= sourceWords.length) break;

    // 1. Direct match
    if (newWord.text === sourceWords[sourceIndex].text) {
      copyTiming(result[i], sourceWords[sourceIndex]);
      sourceIndex++;
      continue;
    }

    // 2. Search ahead in source (Handling Deletions from Source)
    let foundMatchInSource = -1;
    for (let offset = 1; offset <= LOOKAHEAD; offset++) {
      if (sourceIndex + offset < sourceWords.length) {
        if (newWord.text === sourceWords[sourceIndex + offset].text) {
          foundMatchInSource = sourceIndex + offset;
          break;
        }
      }
    }

    if (foundMatchInSource !== -1) {
      // Found a match later in source -> words between sourceIndex and match were deleted
      copyTiming(result[i], sourceWords[foundMatchInSource]);
      sourceIndex = foundMatchInSource + 1;
      continue;
    }

    // 3. No match found in lookahead -> Insertion in New Text
    // The current new word is likely new. Leave it untimed.
    // Do NOT advance sourceIndex, so the NEXT new word has a chance to match the current source word.
  }

  return result;
}

function copyTiming(target: ThrenicWord, source: ThrenicWord): void {
  target.id = source.id;
  target.startTime = source.startTime;
  target.endTime = source.endTime;
  target.isLineStart = source.isLineStart;
  if (source.lineId) target.lineId = source.lineId;
  if (source.lineStartX !== undefined) target.lineStartX = source.lineStartX;
  if (source.lineEndX !== undefined) target.lineEndX = source.lineEndX;
  if (source.isStanzaStart !== undefined) target.isStanzaStart = source.isStanzaStart;
  if (source.laneIndex !== undefined) target.laneIndex = source.laneIndex;
}

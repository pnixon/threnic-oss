/**
 * LyricParsers - Unified format detection and parsing utilities
 *
 * Takes messy inputs (LRC, SRT, Raw Text) and normalizes them to ThrenicWord[].
 * Moved from the Threnic app (src/engine/lyrics/parsers.ts).
 */

import type { ThrenicWord } from '../types/threnic-schema';

// ============================================================================
// Internal Helpers
// ============================================================================

/** Remove content within square brackets, e.g., "[Chorus]", "[Verse 1]" */
function stripBrackets(text: string): string {
  return text.replace(/\[[^\]]*\]/g, '').trim();
}

/** Normalize line endings to LF (\n) and handle other pre-processing */
function preprocessRaw(raw: string): string {
  return raw.replace(/\r\n/g, '\n');
}

/**
 * Time Parsing Utilities
 * Handles: MM:SS.ms, MM:SS,ms, HH:MM:SS,ms, HH:MM:SS.ms, MM:SS
 */
export function parseTime(str: string): number {
  const cleaned = str.trim().replace(',', '.');
  const parts = cleaned.split(':');

  if (parts.length === 1) {
    return parseFloat(parts[0]) || 0;
  }
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }
  return 0;
}

// ============================================================================
// Parsers
// ============================================================================

/**
 * Parse raw text (poem/plain text) into ThrenicWord array.
 * All words get startTime: 0 (pending sync). Line breaks preserved via
 * isLineStart markers. Double newlines mark isStanzaStart.
 */
export function fromText(raw: string): ThrenicWord[] {
  const words: ThrenicWord[] = [];
  const normalized = preprocessRaw(raw);
  const lines = normalized.split('\n');

  let isNextWordStanzaStart = false;

  for (const line of lines) {
    const content = stripBrackets(line);

    if (!content) {
      if (words.length > 0) {
        isNextWordStanzaStart = true;
      }
      continue;
    }

    const lineWords = content.split(/\s+/).filter((w) => w);

    for (let j = 0; j < lineWords.length; j++) {
      const isFirstWord = j === 0;

      words.push({
        id: crypto.randomUUID(),
        text: lineWords[j],
        startTime: 0,
        endTime: 0,
        isLineStart: isFirstWord,
        isStanzaStart: isFirstWord && isNextWordStanzaStart,
      });

      if (isFirstWord) {
        isNextWordStanzaStart = false;
      }
    }
  }

  return words;
}

/**
 * Parse LRC format lyrics into ThrenicWord array.
 * LRC format: [MM:SS.ms]Line of lyrics or [MM:SS]Line
 */
export function fromLRC(raw: string): ThrenicWord[] {
  const words: ThrenicWord[] = [];
  const normalized = preprocessRaw(raw);
  const regex = /\[(\d{1,2}:\d{1,2}(?::\d{1,2})?[.,]?\d*)\](.*)/g;
  let match;

  while ((match = regex.exec(normalized)) !== null) {
    const time = parseTime(match[1]);
    const content = stripBrackets(match[2]);

    if (!content) {
      continue;
    }

    const lineWords = content.split(/\s+/).filter((w) => w);
    const staggerMs = 0.1;

    for (let j = 0; j < lineWords.length; j++) {
      const isFirstWord = j === 0;

      words.push({
        id: crypto.randomUUID(),
        text: lineWords[j],
        startTime: isFirstWord ? time : time + j * staggerMs,
        endTime: 0,
        isLineStart: isFirstWord,
      });
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    words[i].endTime = words[i + 1].startTime;
  }

  if (words.length > 0) {
    const lastWord = words[words.length - 1];
    lastWord.endTime = lastWord.startTime + 0.5;
  }

  return words;
}

/** Parse SRT format subtitles into ThrenicWord array */
export function fromSRT(raw: string): ThrenicWord[] {
  const words: ThrenicWord[] = [];
  const normalized = preprocessRaw(raw);
  const blocks = normalized.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split('\n');

    if (lines.length < 3) {
      continue;
    }

    const timeMatch = lines[1].match(/(\d+:\d+:\d+[,.]?\d+)\s*-->\s*(\d+:\d+:\d+[,.]?\d+)/);
    if (!timeMatch) {
      continue;
    }

    const blockStart = parseTime(timeMatch[1]);
    const blockEnd = parseTime(timeMatch[2]);

    const content = stripBrackets(
      lines
        .slice(2)
        .join(' ')
        .replace(/<[^>]+>/g, ''),
    ).trim();

    if (!content) {
      continue;
    }

    const blockWords = content.split(/\s+/).filter((w) => w);
    const blockDuration = blockEnd - blockStart;
    const wordDuration = blockDuration / blockWords.length;

    for (let i = 0; i < blockWords.length; i++) {
      words.push({
        id: crypto.randomUUID(),
        text: blockWords[i],
        startTime: blockStart + i * wordDuration,
        endTime: blockStart + (i + 1) * wordDuration,
        isLineStart: i === 0,
      });
    }
  }

  return words;
}

// ============================================================================
// Format Detection
// ============================================================================

export type LyricInputFormat = 'text' | 'lrc' | 'srt';

export function detectFormat(content: string): LyricInputFormat {
  const trimmed = content.trim();
  if (/^\[\d+:\d+/.test(trimmed)) return 'lrc';
  if (/^\d+\s*\n.*-->/.test(trimmed)) return 'srt';
  return 'text';
}

/** Parse any supported format into ThrenicWord array */
export function parse(content: string): ThrenicWord[] {
  const format = detectFormat(content);

  switch (format) {
    case 'lrc':
      return fromLRC(content);
    case 'srt':
      return fromSRT(content);
    default:
      return fromText(content);
  }
}

// Namespace export for cleaner imports
export const LyricParsers = {
  fromText,
  fromLRC,
  fromSRT,
  detectFormat,
  parse,
  parseTime,
};

export default LyricParsers;

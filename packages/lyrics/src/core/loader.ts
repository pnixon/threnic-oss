/**
 * Lyrics file/URL loader — detects format and parses to LyricLineData[].
 * Moved from the Threnic app (src/engine/lyrics/loader.ts); logger now sourced
 * from the package's own logger module.
 */
import type { LyricLineData } from '../types/core';
import { threnicWordsToLyricLines } from './converters';
import { LyricParsers } from './parsers';
import { createLogger } from '../logger';

const logger = createLogger({ enabled: true, prefix: 'LyricsLoader' });

export type LyricsFormat = 'json' | 'lrc' | 'srt' | 'txt';

export function detectLyricsFormat(filename: string): LyricsFormat | null {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'json':
      return 'json';
    case 'lrc':
      return 'lrc';
    case 'srt':
      return 'srt';
    case 'txt':
      return 'txt';
    default:
      return null;
  }
}

export function parseTxt(content: string): LyricLineData[] {
  return threnicWordsToLyricLines(LyricParsers.fromText(content));
}

export function parseLrc(content: string): LyricLineData[] {
  return threnicWordsToLyricLines(LyricParsers.fromLRC(content));
}

export function parseSrt(content: string): LyricLineData[] {
  return threnicWordsToLyricLines(LyricParsers.fromSRT(content));
}

interface JsonWord {
  text?: string;
  word?: string;
  start?: number;
  startTime?: number;
  end?: number;
  endTime?: number;
}

interface JsonLine {
  id?: string;
  text?: string;
  start?: number;
  startTime?: number;
  end?: number;
  endTime?: number;
  words?: JsonWord[];
}

export function parseJson(content: string): LyricLineData[] {
  try {
    const data = JSON.parse(content) as unknown;
    let lyricsArray = data;

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const dataObj = data as { lyrics?: unknown };
      if (Array.isArray(dataObj.lyrics)) {
        lyricsArray = dataObj.lyrics;
      }
    }

    if (!Array.isArray(lyricsArray)) {
      return [];
    }

    if (lyricsArray.length > 0 && Array.isArray(lyricsArray[0])) {
      return (lyricsArray as JsonWord[][]).map(function (lineWords, i): LyricLineData {
        const words = lineWords.map(function (w) {
          let start = 0;
          if (typeof w.start === 'number') {
            start = w.start;
          } else if (typeof w.startTime === 'number') {
            start = w.startTime;
          }

          let end = 0;
          if (typeof w.end === 'number') {
            end = w.end;
          } else if (typeof w.endTime === 'number') {
            end = w.endTime;
          }

          return {
            text: String(w.text ?? ''),
            start,
            end,
          };
        });
        return {
          id: String(i + 1),
          text: words
            .map(function (w) {
              return w.text;
            })
            .join(' '),
          start: words[0]?.start ?? 0,
          end: words[words.length - 1]?.end ?? words[0]?.start ?? 0,
          words: words,
        };
      });
    }

    return (lyricsArray as JsonLine[]).map(function (line, i): LyricLineData {
      const words = Array.isArray(line.words)
        ? line.words.map(function (w) {
            let start = 0;
            if (typeof w.start === 'number') {
              start = w.start;
            } else if (typeof w.startTime === 'number') {
              start = w.startTime;
            }

            let end = 0;
            if (typeof w.end === 'number') {
              end = w.end;
            } else if (typeof w.endTime === 'number') {
              end = w.endTime;
            }

            return {
              text: String(w.text ?? w.word ?? ''),
              start,
              end,
            };
          })
        : undefined;

      let lineStart = 0;
      if (typeof line.start === 'number') {
        lineStart = line.start;
      } else if (typeof line.startTime === 'number') {
        lineStart = line.startTime;
      }

      let lineEnd = 0;
      if (typeof line.end === 'number') {
        lineEnd = line.end;
      } else if (typeof line.endTime === 'number') {
        lineEnd = line.endTime;
      } else if (typeof line.start === 'number') {
        lineEnd = line.start;
      }

      return {
        id: line.id ?? String(i + 1),
        text: String(line.text ?? ''),
        start: lineStart,
        end: lineEnd,
        words,
      };
    });
  } catch (error) {
    logger.error('JSON Parse Error Details:', error as Error);
    throw new Error(`Failed to parse JSON lyrics: ${error}`);
  }
}

function detectFormatFromContent(content: string): LyricsFormat {
  const trimmed = content.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      JSON.parse(content);
      return 'json';
    } catch {
      /* Fall through */
    }
  }
  if (/[\[]\d+:\d+/.test(trimmed) || /^[\[]\w+:/.test(trimmed)) return 'lrc';
  if (/^\d+\s*\n.*-->/.test(trimmed)) return 'srt';
  return 'txt';
}

export function parseLyrics(content: string, format: LyricsFormat): LyricLineData[] {
  switch (format) {
    case 'json':
      return parseJson(content);
    case 'lrc':
      return parseLrc(content);
    case 'srt':
      return parseSrt(content);
    case 'txt':
    default:
      return parseTxt(content);
  }
}

export async function loadLyricsFromFile(file: File): Promise<LyricLineData[]> {
  const content = await file.text();
  let format = detectLyricsFormat(file.name);
  if (!format) format = detectFormatFromContent(content);
  return parseLyrics(content, format);
}

export async function loadLyricsFromUrl(url: string): Promise<LyricLineData[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch lyrics: ${response.statusText}`);
  const content = await response.text();
  let format = detectLyricsFormat(url);
  if (!format) format = detectFormatFromContent(content);
  return parseLyrics(content, format);
}

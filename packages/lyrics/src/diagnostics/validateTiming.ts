/**
 * Timing diagnostics — a linter for lyric timing data.
 *
 * Pure, dependency-free analysis over LyricLineData[]. Surfaces the timing
 * problems that make synced lyrics look wrong at playback/export time:
 * negative or zero durations, words out of chronological order, words outside
 * their line's bounds, overlapping lines in the same lane, and large silent
 * gaps. This is the "diagnostics on the timing" surface of @threnic/lyrics.
 */
import type { LyricLineData, Word } from '../types/core';

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'line-negative-duration'
  | 'line-zero-duration'
  | 'word-negative-duration'
  | 'word-zero-duration'
  | 'word-out-of-order'
  | 'word-before-line-start'
  | 'word-after-line-end'
  | 'lines-overlap-same-lane'
  | 'large-gap'
  | 'empty-line';

export interface TimingIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  /** Index into the lines array this issue concerns (if applicable). */
  lineIndex?: number;
  /** Line id this issue concerns (if applicable). */
  lineId?: string;
  /** Index into the line's words array (if applicable). */
  wordIndex?: number;
  /** Relevant time value(s) in seconds. */
  at?: number;
}

export interface ValidateTimingOptions {
  /** Gap (seconds) between consecutive lines above which a 'large-gap' info is emitted. Default 10. */
  largeGapThreshold?: number;
  /** Epsilon (seconds) tolerance for boundary comparisons. Default 0.001. */
  epsilon?: number;
}

export interface TimingReport {
  issues: TimingIssue[];
  counts: Record<IssueSeverity, number>;
  /** True if there are zero 'error'-severity issues. */
  ok: boolean;
}

function laneOf(line: LyricLineData): number {
  return line.laneIndex ?? 0;
}

/**
 * Validate the timing of a set of lyric lines and return a structured report.
 */
export function validateTiming(
  lines: LyricLineData[],
  options: ValidateTimingOptions = {},
): TimingReport {
  const largeGapThreshold = options.largeGapThreshold ?? 10;
  const eps = options.epsilon ?? 0.001;
  const issues: TimingIssue[] = [];

  const push = (issue: TimingIssue) => issues.push(issue);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const dur = line.end - line.start;

    if (dur < -eps) {
      push({
        code: 'line-negative-duration',
        severity: 'error',
        message: `Line "${line.text}" ends (${line.end.toFixed(3)}s) before it starts (${line.start.toFixed(3)}s).`,
        lineIndex: li,
        lineId: line.id,
        at: line.start,
      });
    } else if (Math.abs(dur) <= eps) {
      push({
        code: 'line-zero-duration',
        severity: 'warning',
        message: `Line "${line.text}" has zero duration at ${line.start.toFixed(3)}s.`,
        lineIndex: li,
        lineId: line.id,
        at: line.start,
      });
    }

    const words: Word[] = line.words ?? [];
    if (line.text.trim() === '' && words.length === 0) {
      push({
        code: 'empty-line',
        severity: 'warning',
        message: `Line at index ${li} has no text and no words.`,
        lineIndex: li,
        lineId: line.id,
        at: line.start,
      });
    }

    let prevWordStart = -Infinity;
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      const wdur = w.end - w.start;

      if (wdur < -eps) {
        push({
          code: 'word-negative-duration',
          severity: 'error',
          message: `Word "${w.text}" ends (${w.end.toFixed(3)}s) before it starts (${w.start.toFixed(3)}s).`,
          lineIndex: li,
          lineId: line.id,
          wordIndex: wi,
          at: w.start,
        });
      } else if (Math.abs(wdur) <= eps) {
        push({
          code: 'word-zero-duration',
          severity: 'info',
          message: `Word "${w.text}" has zero duration at ${w.start.toFixed(3)}s.`,
          lineIndex: li,
          lineId: line.id,
          wordIndex: wi,
          at: w.start,
        });
      }

      if (w.start + eps < prevWordStart) {
        push({
          code: 'word-out-of-order',
          severity: 'error',
          message: `Word "${w.text}" starts (${w.start.toFixed(3)}s) before the previous word (${prevWordStart.toFixed(3)}s).`,
          lineIndex: li,
          lineId: line.id,
          wordIndex: wi,
          at: w.start,
        });
      }

      if (w.start + eps < line.start) {
        push({
          code: 'word-before-line-start',
          severity: 'warning',
          message: `Word "${w.text}" starts (${w.start.toFixed(3)}s) before its line starts (${line.start.toFixed(3)}s).`,
          lineIndex: li,
          lineId: line.id,
          wordIndex: wi,
          at: w.start,
        });
      }
      if (w.end - eps > line.end) {
        push({
          code: 'word-after-line-end',
          severity: 'warning',
          message: `Word "${w.text}" ends (${w.end.toFixed(3)}s) after its line ends (${line.end.toFixed(3)}s).`,
          lineIndex: li,
          lineId: line.id,
          wordIndex: wi,
          at: w.end,
        });
      }

      prevWordStart = w.start;
    }
  }

  // Cross-line checks within the same lane, ordered by start time.
  const byLane = new Map<number, { line: LyricLineData; index: number }[]>();
  for (let li = 0; li < lines.length; li++) {
    const lane = laneOf(lines[li]);
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane)!.push({ line: lines[li], index: li });
  }

  for (const [lane, group] of byLane) {
    const sorted = [...group].sort((a, b) => a.line.start - b.line.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];

      if (cur.line.start + eps < prev.line.end) {
        push({
          code: 'lines-overlap-same-lane',
          severity: 'warning',
          message: `Line "${cur.line.text}" (lane ${lane}) starts at ${cur.line.start.toFixed(3)}s, overlapping the previous line which ends at ${prev.line.end.toFixed(3)}s.`,
          lineIndex: cur.index,
          lineId: cur.line.id,
          at: cur.line.start,
        });
      } else {
        const gap = cur.line.start - prev.line.end;
        if (gap >= largeGapThreshold) {
          push({
            code: 'large-gap',
            severity: 'info',
            message: `Silent gap of ${gap.toFixed(1)}s (lane ${lane}) between "${prev.line.text}" and "${cur.line.text}".`,
            lineIndex: cur.index,
            lineId: cur.line.id,
            at: prev.line.end,
          });
        }
      }
    }
  }

  const counts: Record<IssueSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;

  return { issues, counts, ok: counts.error === 0 };
}

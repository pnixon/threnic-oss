import { describe, it, expect } from 'vitest';
import { validateTiming } from './validateTiming';
import type { LyricLineData } from '../types/core';

function line(partial: Partial<LyricLineData> & { id: string }): LyricLineData {
  return { text: '', start: 0, end: 1, ...partial };
}

describe('validateTiming', () => {
  it('reports a clean report for well-formed lines', () => {
    const lines: LyricLineData[] = [
      line({
        id: 'a',
        text: 'hello world',
        start: 0,
        end: 2,
        words: [
          { text: 'hello', start: 0, end: 1 },
          { text: 'world', start: 1, end: 2 },
        ],
      }),
      line({
        id: 'b',
        text: 'next line',
        start: 2.5,
        end: 4,
        words: [
          { text: 'next', start: 2.5, end: 3 },
          { text: 'line', start: 3, end: 4 },
        ],
      }),
    ];
    const report = validateTiming(lines);
    expect(report.ok).toBe(true);
    expect(report.counts.error).toBe(0);
  });

  it('flags a line that ends before it starts', () => {
    const report = validateTiming([line({ id: 'a', text: 'x', start: 5, end: 3 })]);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'line-negative-duration')).toBe(true);
  });

  it('flags a zero-duration line as a warning', () => {
    const report = validateTiming([line({ id: 'a', text: 'x', start: 5, end: 5 })]);
    expect(report.counts.warning).toBeGreaterThan(0);
    expect(report.issues.some((i) => i.code === 'line-zero-duration')).toBe(true);
  });

  it('flags a word that ends before it starts', () => {
    const report = validateTiming([
      line({
        id: 'a',
        text: 'bad',
        start: 0,
        end: 2,
        words: [{ text: 'bad', start: 1.5, end: 1.0 }],
      }),
    ]);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'word-negative-duration')).toBe(true);
  });

  it('flags words out of chronological order', () => {
    const report = validateTiming([
      line({
        id: 'a',
        text: 'a b',
        start: 0,
        end: 3,
        words: [
          { text: 'a', start: 2, end: 3 },
          { text: 'b', start: 0, end: 1 },
        ],
      }),
    ]);
    expect(report.issues.some((i) => i.code === 'word-out-of-order')).toBe(true);
  });

  it('flags words outside line bounds', () => {
    const report = validateTiming([
      line({
        id: 'a',
        text: 'a b',
        start: 1,
        end: 2,
        words: [
          { text: 'a', start: 0.5, end: 1.2 },
          { text: 'b', start: 1.2, end: 3.0 },
        ],
      }),
    ]);
    expect(report.issues.some((i) => i.code === 'word-before-line-start')).toBe(true);
    expect(report.issues.some((i) => i.code === 'word-after-line-end')).toBe(true);
  });

  it('flags overlapping lines in the same lane', () => {
    const report = validateTiming([
      line({ id: 'a', text: 'first', start: 0, end: 3 }),
      line({ id: 'b', text: 'second', start: 2, end: 5 }),
    ]);
    expect(report.issues.some((i) => i.code === 'lines-overlap-same-lane')).toBe(true);
  });

  it('does NOT flag overlapping lines in different lanes', () => {
    const report = validateTiming([
      line({ id: 'a', text: 'first', start: 0, end: 3, laneIndex: 0 }),
      line({ id: 'b', text: 'second', start: 2, end: 5, laneIndex: 1 }),
    ]);
    expect(report.issues.some((i) => i.code === 'lines-overlap-same-lane')).toBe(false);
  });

  it('emits an info for a large silent gap', () => {
    const report = validateTiming(
      [
        line({ id: 'a', text: 'first', start: 0, end: 3 }),
        line({ id: 'b', text: 'second', start: 20, end: 22 }),
      ],
      { largeGapThreshold: 10 },
    );
    expect(report.issues.some((i) => i.code === 'large-gap')).toBe(true);
  });
});

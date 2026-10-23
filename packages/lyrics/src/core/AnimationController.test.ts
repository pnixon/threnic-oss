/**
 * Word/char entry-animation timing invariants.
 *
 * Ported from the Threnic app (test/engine/lyrics/AnimationController.timing.test.ts)
 * with imports repointed to @threnic/lyrics package-relative paths.
 */

import { describe, it, expect } from 'vitest';
import { calculateWordAnimation } from './AnimationController';
import type { LyricAnimationConfig } from '../types/core';

const IN: LyricAnimationConfig = {
  type: 'fade',
  granularity: 'word',
  duration: 0.5,
  stagger: 0.05,
};
const OUT: LyricAnimationConfig = {
  type: 'fade',
  granularity: 'word',
  duration: 0.5,
  stagger: 0.05,
};

/** Mixed gaps: back-to-back, tiny gap, and a wide gap — all in one line. */
const WORDS = [
  { text: 'On', start: 10.0, end: 10.25 },
  { text: 'every', start: 10.25, end: 10.7 }, // gap 0
  { text: 'single', start: 10.73, end: 11.1 }, // gap 0.03
  { text: 'cathedral', start: 11.1, end: 11.8 }, // gap 0
  { text: 'door', start: 11.85, end: 12.3 }, // gap 0.05
];
const LINE_START = 10.0;
const LINE_END = 12.3;

function opacityAt(
  wordIndex: number,
  t: number,
  animIn: LyricAnimationConfig = IN,
  charIndex = 0,
  charCount = 1,
): number {
  const w = WORDS[wordIndex];
  const prev = WORDS[wordIndex - 1];
  const a = calculateWordAnimation({
    currentTime: t,
    wordStart: w.start,
    wordEnd: w.end,
    prevWordStart: prev?.start,
    prevWordEnd: prev?.end,
    lineStart: LINE_START,
    lineEnd: LINE_END,
    animationIn: animIn,
    animationOut: OUT,
    staggerIndex: animIn.granularity === 'char' ? charIndex : wordIndex,
    totalItems: animIn.granularity === 'char' ? charCount : WORDS.length,
  });
  return a.isVisible ? a.opacity : 0;
}

/** First time (10ms resolution) at which a word becomes visible at all. */
function onset(wordIndex: number, animIn: LyricAnimationConfig = IN, charCount = 1): number {
  const w = WORDS[wordIndex];
  for (let t = w.start - 2; t <= w.start; t += 0.01) {
    for (let c = 0; c < charCount; c++) {
      if (opacityAt(wordIndex, t, animIn, c, charCount) > 0) return t;
    }
  }
  return w.start;
}

describe('lyric entry timing — reveal order', () => {
  it('reveals words strictly in reading order regardless of gap size (word granularity)', () => {
    for (let i = 1; i < WORDS.length; i++) {
      expect(onset(i)).toBeGreaterThan(onset(i - 1));
    }
  });

  it('never shows a later word while an earlier word is still invisible', () => {
    for (let t = 9.0; t <= 12.5; t += 0.02) {
      let seenInvisible = -1;
      for (let i = 0; i < WORDS.length; i++) {
        const vis = opacityAt(i, t) > 0;
        const isFuture = t < WORDS[i].start;
        if (!vis && isFuture && seenInvisible < 0) seenInvisible = i;
        if (vis && isFuture && seenInvisible >= 0) {
          throw new Error(
            `t=${t.toFixed(2)}: "${WORDS[i].text}" is visible but earlier ` +
              `"${WORDS[seenInvisible].text}" is not`,
          );
        }
      }
    }
  });
});

describe('lyric entry timing — window length', () => {
  it('is fully opaque by its own start time', () => {
    for (let i = 0; i < WORDS.length; i++) {
      expect(opacityAt(i, WORDS[i].start)).toBeGreaterThan(0.99);
    }
  });

  it('gives every word a perceptible fade, never a sub-frame flash', () => {
    for (let i = 0; i < WORDS.length; i++) {
      const window = WORDS[i].start - onset(i);
      expect(window).toBeGreaterThanOrEqual(0.1);
    }
  });

  it('does not let a tiny inter-word gap shorten the fade more than the word spacing', () => {
    const window = WORDS[2].start - onset(2);
    expect(window).toBeGreaterThan(0.4);
  });
});

describe('lyric entry timing — char granularity', () => {
  const charIn: LyricAnimationConfig = { ...IN, granularity: 'char' };

  it('does not make long words appear earlier than short ones', () => {
    const leadShort = WORDS[3].start - onset(3, charIn, 3);
    const leadLong = WORDS[3].start - onset(3, charIn, 14);
    expect(Math.abs(leadLong - leadShort)).toBeLessThan(0.02);
  });

  it('finishes the last character exactly at the word start', () => {
    const text = 'cathedral';
    const last = text.length - 1;
    expect(opacityAt(3, WORDS[3].start, charIn, last, text.length)).toBeGreaterThan(0.99);
    expect(opacityAt(3, WORDS[3].start - 0.05, charIn, last, text.length)).toBeLessThan(0.99);
  });

  it('staggers characters within the word', () => {
    const text = 'cathedral';
    const t = WORDS[3].start - 0.1;
    const first = opacityAt(3, t, charIn, 0, text.length);
    const last = opacityAt(3, t, charIn, text.length - 1, text.length);
    expect(first).toBeGreaterThan(last);
  });
});

describe('lyric entry timing — cross-line boundary', () => {
  const LINE_A_END = 5.0;
  const LINE_B_START = 5.1;
  const LINE_B_WORD_START = 5.2;

  function nextLineOpacity(t: number): number {
    const a = calculateWordAnimation({
      currentTime: t,
      wordStart: LINE_B_WORD_START,
      wordEnd: 5.8,
      prevWordStart: undefined,
      prevWordEnd: undefined,
      prevLineEnd: LINE_A_END,
      lineStart: LINE_B_START,
      lineEnd: 5.8,
      animationIn: IN,
      animationOut: OUT,
      staggerIndex: 0,
      totalItems: 3,
    });
    return a.isVisible ? a.opacity : 0;
  }

  it('first word of next line is NOT visible before previous line ends', () => {
    expect(nextLineOpacity(4.9)).toBe(0);
    expect(nextLineOpacity(LINE_A_END)).toBeLessThan(0.1);
  });

  it('first word of next line IS fully visible by its own start time', () => {
    expect(nextLineOpacity(LINE_B_WORD_START)).toBeGreaterThan(0.99);
  });

  it('without prevLineEnd, lead-in extends further back (baseline proof)', () => {
    const unclamped = calculateWordAnimation({
      currentTime: 4.75,
      wordStart: LINE_B_WORD_START,
      wordEnd: 5.8,
      prevWordStart: undefined,
      prevWordEnd: undefined,
      lineStart: LINE_B_START,
      lineEnd: 5.8,
      animationIn: IN,
      animationOut: OUT,
      staggerIndex: 0,
      totalItems: 3,
    });
    expect(unclamped.isVisible ? unclamped.opacity : 0).toBeGreaterThan(0);
  });
});

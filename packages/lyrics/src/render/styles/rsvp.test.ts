import { describe, it, expect } from 'vitest';
import {
  pickActiveWord,
  drawRsvp,
  rsvpStyle,
  RSVP_SCALE,
  RSVP_ENERGY_PULSE,
  RSVP_FILL,
} from './rsvp';
import type { StyleCanvasContext, StyleFrameContext, StyleLaidOutWord } from '../StyleRegistry';

function word(text: string, start: number, end: number, globalIndex: number): StyleLaidOutWord {
  return {
    text,
    start,
    end,
    globalIndex,
    lineIndex: 0,
    wordIndex: globalIndex,
  };
}

// Three words with gaps between them:
//   the   [0, 1]
//   quick [2, 3]
//   fox   [4, 5]
const words: StyleLaidOutWord[] = [
  word('the', 0, 1, 0),
  word('quick', 2, 3, 1),
  word('fox', 4, 5, 2),
];

function frameCtx(time: number, energy = 0): StyleFrameContext {
  return {
    time,
    audio: { bass: 0, mid: 0, high: 0, energy },
    width: 1920,
    height: 1080,
    renderScale: 2,
    fontSizePx: 48,
  };
}

/** A minimal fake 2D context that records the calls RSVP makes. */
function fakeCtx() {
  const calls: string[] = [];
  const fills: Array<{ text: string; x: number; y: number }> = [];
  const rec: Record<string, unknown> = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    fillText: (text: string, x: number, y: number) => {
      calls.push('fillText');
      fills.push({ text, x, y });
    },
  };
  return { ctx: rec as unknown as StyleCanvasContext, state: rec, calls, fills };
}

describe('pickActiveWord', () => {
  it('returns null before the first word starts', () => {
    expect(pickActiveWord(words, -0.5)).toBeNull();
  });

  it('returns null for an empty word list', () => {
    expect(pickActiveWord([], 10)).toBeNull();
  });

  it('selects the word active at the given time (during word 0)', () => {
    expect(pickActiveWord(words, 0.5)?.text).toBe('the');
  });

  it('selects word N when time is within its window', () => {
    expect(pickActiveWord(words, 2.5)?.text).toBe('quick');
    expect(pickActiveWord(words, 4.5)?.text).toBe('fox');
  });

  it('includes the exact start and end boundaries as active', () => {
    expect(pickActiveWord(words, 0)?.text).toBe('the'); // start
    expect(pickActiveWord(words, 1)?.text).toBe('the'); // end
    expect(pickActiveWord(words, 4)?.text).toBe('fox');
    expect(pickActiveWord(words, 5)?.text).toBe('fox');
  });

  it('holds the most recent started word during a gap', () => {
    // gap between "the" [0,1] and "quick" [2,3]
    expect(pickActiveWord(words, 1.5)?.text).toBe('the');
    // gap between "quick" [2,3] and "fox" [4,5]
    expect(pickActiveWord(words, 3.5)?.text).toBe('quick');
  });

  it('holds the last word after the final word ends', () => {
    expect(pickActiveWord(words, 100)?.text).toBe('fox');
  });
});

describe('drawRsvp', () => {
  it('draws nothing before the first word', () => {
    const { ctx, calls } = fakeCtx();
    drawRsvp(ctx, words, frameCtx(-1));
    expect(calls).toEqual([]);
  });

  it('draws exactly one word, centred, white', () => {
    const { ctx, calls, fills } = fakeCtx();
    drawRsvp(ctx, words, frameCtx(2.5));
    expect(calls).toContain('fillText');
    expect(fills).toHaveLength(1);
    expect(fills[0].text).toBe('quick');
    expect(fills[0].x).toBe(1920 / 2);
    expect(fills[0].y).toBe(1080 / 2);
  });

  it('sets centred alignment, middle baseline, and white fill', () => {
    const { ctx, state } = fakeCtx();
    drawRsvp(ctx, words, frameCtx(0.5));
    expect(state.textAlign).toBe('center');
    expect(state.textBaseline).toBe('middle');
    expect(state.fillStyle).toBe(RSVP_FILL);
  });

  it('save/restore wrap the draw', () => {
    const { ctx, calls } = fakeCtx();
    drawRsvp(ctx, words, frameCtx(0.5));
    expect(calls[0]).toBe('save');
    expect(calls[calls.length - 1]).toBe('restore');
  });

  it('font size is fontSizePx * RSVP_SCALE at zero energy', () => {
    const { ctx, state } = fakeCtx();
    drawRsvp(ctx, words, frameCtx(0.5, 0));
    expect(state.font).toBe(`${48 * RSVP_SCALE}px sans-serif`);
  });

  it('energy adds RSVP_ENERGY_PULSE to the scale', () => {
    const { ctx, state } = fakeCtx();
    drawRsvp(ctx, words, frameCtx(0.5, 1));
    expect(state.font).toBe(`${48 * (RSVP_SCALE + RSVP_ENERGY_PULSE)}px sans-serif`);
  });
});

describe('rsvpStyle', () => {
  it('registers id/name and the layout hook', () => {
    expect(rsvpStyle.id).toBe('rsvp');
    expect(rsvpStyle.name).toBe('RSVP');
    expect(typeof rsvpStyle.layout).toBe('function');
  });

  it('modifyWord is the identity modifier', () => {
    expect(rsvpStyle.modifyWord({} as never)).toEqual({});
  });
});

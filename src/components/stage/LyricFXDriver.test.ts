import { describe, it, expect } from 'vitest';
import { layoutVisibleLines } from './LyricFXDriver';
import type { GlyphAtlasMetrics } from '@threnic/lyrics';
import type { LyricLineData, LyricTheme } from '@/types/lyrics';

// Uniform fake atlas: every glyph advances 30 units at renderSize 60.
function atlas(): Map<number, GlyphAtlasMetrics> {
  const m = new Map<number, GlyphAtlasMetrics>();
  for (let cp = 32; cp <= 126; cp++) {
    m.set(cp, {
      advance: 30,
      bearingX: 0,
      bearingY: 50,
      atlasWidth: cp === 32 ? 0 : 40,
      atlasHeight: cp === 32 ? 0 : 50,
      uv: { u0: 0, v0: 0, u1: 0.1, v1: 0.1 },
    });
  }
  return m;
}

const theme: LyricTheme = {
  fontSize: 0.5,
  effect: 'none',
  audioReactive: false,
  colorActive: '#ff8000',
  verticalPosition: 50,
};

const line = (id: string, text: string, words?: LyricLineData['words']): LyricLineData => ({
  id,
  text,
  start: 0,
  end: 2,
  words,
});

describe('layoutVisibleLines', () => {
  const W = 1000;
  const H = 600;
  const RENDER = 60;
  const LH = 70;

  it('centres a line horizontally using atlas advances', () => {
    const out = layoutVisibleLines([line('1', 'ab')], theme, atlas(), RENDER, LH, W, H);
    // fontSizePx = 0.5 * (600/10) = 30; scale = 30/60 = 0.5; advance px = 15.
    // "ab" width = 2 * 15 = 30; originX = (1000 - 30)/2 = 485.
    expect(out).toHaveLength(1);
    expect(out[0].originX).toBeCloseTo(485, 4);
    expect(out[0].fontSizePx).toBeCloseTo(30, 6);
  });

  it('maps word timing onto character spans by text position', () => {
    const l = line('1', 'hi you', [
      { text: 'hi', start: 0, end: 1 },
      { text: 'you', start: 1, end: 2 },
    ]);
    const out = layoutVisibleLines([l], theme, atlas(), RENDER, LH, W, H);
    const words = out[0].words;
    expect(words[0]).toMatchObject({ charStartIndex: 0, charEndIndex: 2, start: 0, end: 1 });
    // "you" begins at index 3 in "hi you".
    expect(words[1]).toMatchObject({ charStartIndex: 3, charEndIndex: 6, start: 1, end: 2 });
  });

  it('synthesizes a single whole-line word when none are given', () => {
    const out = layoutVisibleLines([line('1', 'abc')], theme, atlas(), RENDER, LH, W, H);
    expect(out[0].words).toHaveLength(1);
    expect(out[0].words[0]).toMatchObject({ charStartIndex: 0, charEndIndex: 3 });
  });

  it('parses the active colour to normalized rgba', () => {
    const out = layoutVisibleLines([line('1', 'a')], theme, atlas(), RENDER, LH, W, H);
    // #ff8000 → [1, 0.502, 0, 1]
    expect(out[0].color[0]).toBeCloseTo(1, 3);
    expect(out[0].color[1]).toBeCloseTo(128 / 255, 3);
    expect(out[0].color[2]).toBeCloseTo(0, 3);
    expect(out[0].color[3]).toBe(1);
  });

  it('stacks multiple lines by line height around the vertical position', () => {
    const out = layoutVisibleLines(
      [line('1', 'a'), line('2', 'b')],
      theme,
      atlas(),
      RENDER,
      LH,
      W,
      H,
    );
    // Two lines: baselines differ by one lineHeight (70 * 0.5 * 1.3 = 45.5).
    expect(out[1].baselineY - out[0].baselineY).toBeCloseTo(45.5, 4);
  });
});

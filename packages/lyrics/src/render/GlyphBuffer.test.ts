import { describe, it, expect } from 'vitest';
import {
  buildGlyphInstances,
  packGlyphInstances,
  glyphSeed,
  GLYPH_INSTANCE_FLOATS,
  GLYPH_ROLE_ACTIVE,
  type GlyphAtlasMetrics,
  type GlyphFontMetrics,
  type LaidOutGlyphLine,
} from './GlyphBuffer';

// A tiny fake atlas: every ASCII letter is a 40x50 box with advance 30.
// Space (32) has an advance but no bitmap. renderSize 64.
function fakeAtlas(): Map<number, GlyphAtlasMetrics> {
  const m = new Map<number, GlyphAtlasMetrics>();
  const add = (cp: number, hasBitmap: boolean) => {
    m.set(cp, {
      advance: 30,
      bearingX: 2,
      bearingY: 48,
      atlasWidth: hasBitmap ? 40 : 0,
      atlasHeight: hasBitmap ? 50 : 0,
      uv: { u0: cp / 128, v0: 0, u1: cp / 128 + 0.1, v1: 0.1 },
    });
  };
  for (let cp = 33; cp <= 126; cp++) add(cp, true);
  add(32, false); // space
  return m;
}

const fontMetrics: GlyphFontMetrics = { renderSize: 64, sdfPadding: 8, ascent: 48 };

function line(text: string, words: LaidOutGlyphLine['words']): LaidOutGlyphLine {
  return {
    text,
    lineIndex: 0,
    laneIndex: 0,
    originX: 100,
    baselineY: 200,
    words,
    fontSizePx: 64, // scale == 1 for easy pixel math
    color: [1, 1, 1, 1],
  };
}

describe('glyphSeed', () => {
  it('is deterministic for the same inputs', () => {
    expect(glyphSeed(3, 65)).toBe(glyphSeed(3, 65));
  });
  it('is in [0,1)', () => {
    for (let i = 0; i < 100; i++) {
      const s = glyphSeed(i, 65 + (i % 26));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });
  it('differs across glyph index and code point', () => {
    expect(glyphSeed(1, 65)).not.toBe(glyphSeed(2, 65));
    expect(glyphSeed(1, 65)).not.toBe(glyphSeed(1, 66));
  });
});

describe('buildGlyphInstances', () => {
  const atlas = fakeAtlas();

  it('emits one instance per visible glyph, skipping spaces', () => {
    const words = [
      { wordIndex: 0, start: 0, end: 1, charStartIndex: 0, charEndIndex: 2 }, // "hi"
      { wordIndex: 1, start: 1, end: 2, charStartIndex: 3, charEndIndex: 6 }, // "you"
    ];
    const instances = buildGlyphInstances({ lines: [line('hi you', words)], atlas, fontMetrics });
    // "hi you" = 5 letters + 1 space → 5 visible glyphs
    expect(instances).toHaveLength(5);
  });

  it('attributes each glyph to the right word and timing', () => {
    const words = [
      { wordIndex: 0, start: 0, end: 1, charStartIndex: 0, charEndIndex: 2 },
      { wordIndex: 1, start: 1, end: 2, charStartIndex: 3, charEndIndex: 6 },
    ];
    const g = buildGlyphInstances({ lines: [line('hi you', words)], atlas, fontMetrics });
    expect(g[0].wordIndex).toBe(0);
    expect(g[0].charStart).toBe(0);
    expect(g[0].charEnd).toBe(1);
    // 'y' is charIndex 3 → word 1
    const y = g.find((x) => x.charIndex === 3)!;
    expect(y.wordIndex).toBe(1);
    expect(y.charStart).toBe(1);
    expect(y.charEnd).toBe(2);
  });

  it('advances the pen by advance*scale for each character including spaces', () => {
    const words = [{ wordIndex: 0, start: 0, end: 1, charStartIndex: 0, charEndIndex: 2 }];
    const g = buildGlyphInstances({ lines: [line('a b', words)], atlas, fontMetrics });
    // scale 1: 'a' at originX + bearingX(2) - pad(8) = 100+2-8 = 94.
    expect(g[0].pos[0]).toBeCloseTo(94, 6);
    // 'b' is at charIndex 2: pen advanced by 'a'(30) + ' '(30) = 60 → 160+2-8 = 154.
    const b = g.find((x) => x.charIndex === 2)!;
    expect(b.pos[0]).toBeCloseTo(154, 6);
  });

  it('places the quad using bearing, padding and ascent', () => {
    const words = [{ wordIndex: 0, start: 0, end: 1, charStartIndex: 0, charEndIndex: 1 }];
    const g = buildGlyphInstances({ lines: [line('A', words)], atlas, fontMetrics });
    const a = g[0];
    // quadY = baseline(200) - bearingY(48) - pad(8) + ascent(48) = 192
    expect(a.pos[1]).toBeCloseTo(192, 6);
    expect(a.size).toEqual([40, 50]);
    expect(a.baseline).toBe(200);
  });

  it('carries the atlas UV rect and base colour', () => {
    const words = [{ wordIndex: 0, start: 0, end: 1, charStartIndex: 0, charEndIndex: 1 }];
    const g = buildGlyphInstances({ lines: [line('A', words)], atlas, fontMetrics });
    const cp = 'A'.codePointAt(0)!;
    expect(g[0].atlasRect).toEqual([cp / 128, 0, cp / 128 + 0.1, 0.1]);
    expect(g[0].color).toEqual([1, 1, 1, 1]);
    expect(g[0].role).toBe(GLYPH_ROLE_ACTIVE);
  });

  it('skips unknown glyphs but still advances', () => {
    const sparse = new Map(atlas);
    sparse.delete('Z'.codePointAt(0)!);
    const words = [{ wordIndex: 0, start: 0, end: 1, charStartIndex: 0, charEndIndex: 2 }];
    const g = buildGlyphInstances({ lines: [line('ZA', words)], atlas: sparse, fontMetrics });
    // Z unknown → skipped; A emitted, but its pen advanced past the default Z width.
    expect(g).toHaveLength(1);
    expect(g[0].charIndex).toBe(1);
  });

  it('is fully deterministic — same input, identical output', () => {
    const words = [{ wordIndex: 0, start: 0, end: 1, charStartIndex: 0, charEndIndex: 5 }];
    const a = buildGlyphInstances({ lines: [line('hello', words)], atlas, fontMetrics });
    const b = buildGlyphInstances({ lines: [line('hello', words)], atlas, fontMetrics });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('assigns distinct seeds across glyphs of a line', () => {
    const words = [{ wordIndex: 0, start: 0, end: 1, charStartIndex: 0, charEndIndex: 5 }];
    const g = buildGlyphInstances({ lines: [line('hello', words)], atlas, fontMetrics });
    const seeds = new Set(g.map((x) => x.seed));
    expect(seeds.size).toBe(g.length);
  });
});

describe('packGlyphInstances', () => {
  const atlas = fakeAtlas();
  const words = [{ wordIndex: 0, start: 0.25, end: 0.75, charStartIndex: 0, charEndIndex: 2 }];
  const instances = buildGlyphInstances({ lines: [line('AB', words)], atlas, fontMetrics });

  it('produces GLYPH_INSTANCE_FLOATS per instance', () => {
    const packed = packGlyphInstances(instances);
    expect(packed.length).toBe(instances.length * GLYPH_INSTANCE_FLOATS);
  });

  it('round-trips the documented field layout for instance 0', () => {
    const packed = packGlyphInstances(instances);
    const g = instances[0];
    expect(packed[0]).toBe(g.charIndex);
    expect(packed[4]).toBeCloseTo(g.seed, 6);
    expect(packed[6]).toBeCloseTo(g.charStart, 6); // 0.25
    expect(packed[7]).toBeCloseTo(g.charEnd, 6); // 0.75
    expect(packed[8]).toBeCloseTo(g.pos[0], 6);
    expect(packed[13]).toBeCloseTo(g.atlasRect[0], 6);
    expect(packed[17]).toBe(g.color[0]);
    expect(packed[20]).toBe(g.color[3]);
    // float 21 carries the effective entry-animation start (fallback: start - 0.5).
    expect(packed[21]).toBeCloseTo(g.entryStart, 6);
    expect(packed[22]).toBeCloseTo(g.lineStart, 6); // 0.25
    expect(packed[23]).toBeCloseTo(g.lineEnd, 6); // 0.75
  });
});

describe('line-granularity timing', () => {
  const atlas = fakeAtlas();

  it('gives every glyph on a line the same line window, spanning all its words', () => {
    const words = [
      { wordIndex: 0, start: 1, end: 2, charStartIndex: 0, charEndIndex: 2 },
      { wordIndex: 1, start: 5, end: 9, charStartIndex: 3, charEndIndex: 5 },
    ];
    const g = buildGlyphInstances({ lines: [line('AB CD', words)], atlas, fontMetrics });

    // Per-word windows still differ (word granularity keeps working)...
    expect(new Set(g.map((x) => x.charStart)).size).toBe(2);
    // ...but the line window is one shared span from first word to last.
    expect(new Set(g.map((x) => x.lineStart))).toEqual(new Set([1]));
    expect(new Set(g.map((x) => x.lineEnd))).toEqual(new Set([9]));
  });
});

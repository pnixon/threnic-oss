import { describe, it, expect } from 'vitest';
import {
  computeOpen,
  computePullQuote,
  pullQuoteStyle,
  SUSTAIN_REF_SEC,
  WDTH_MIN,
  WDTH_MAX,
  HOLD_BOOST,
  OFFSET_X_MAX_EM,
  SCALE_LIFT,
} from './pullQuote';
import type { StyleWordContext } from '../StyleRegistry';

function ctx(
  opts: Partial<StyleWordContext> & { wordStart: number; wordEnd: number },
): StyleWordContext {
  return {
    time: opts.time ?? opts.wordStart,
    audio: opts.audio,
    wordStart: opts.wordStart,
    wordEnd: opts.wordEnd,
    wordIndex: opts.wordIndex ?? 0,
    wordCount: opts.wordCount ?? 1,
    isActive: opts.isActive ?? false,
  };
}

function parseAxis(fvs: string, axis: 'wght' | 'wdth'): number {
  const m = new RegExp(`"${axis}"\\s+([\\d.]+)`).exec(fvs);
  if (!m) throw new Error(`axis ${axis} not found in "${fvs}"`);
  return parseFloat(m[1]);
}

function wdthOf(c: StyleWordContext): number {
  return parseAxis(computePullQuote(c).fontVariationSettings!, 'wdth');
}

describe('pullQuote', () => {
  it('has the registered id/name', () => {
    expect(pullQuoteStyle.id).toBe('pull-quote');
    expect(pullQuoteStyle.name).toBe('Pull-Quote');
  });

  it('a zero-sustain (unheld) word sits at the width minimum and neutral geometry', () => {
    // sustain = 0 → open = 0
    const m = computePullQuote(ctx({ wordStart: 1, wordEnd: 1, isActive: false }));
    expect(parseAxis(m.fontVariationSettings!, 'wdth')).toBe(WDTH_MIN);
    expect(m.offsetXEm).toBeCloseTo(0, 6);
    expect(m.scaleMul).toBeCloseTo(1, 6);
  });

  it('a fully-sustained, fully-held word reaches the width maximum and full geometry', () => {
    // sustain >= SUSTAIN_REF_SEC and held to the end → open = 1
    const c = ctx({
      wordStart: 0,
      wordEnd: SUSTAIN_REF_SEC,
      time: SUSTAIN_REF_SEC,
      isActive: true,
    });
    const m = computePullQuote(c);
    expect(parseAxis(m.fontVariationSettings!, 'wdth')).toBe(WDTH_MAX);
    expect(m.offsetXEm).toBeCloseTo(OFFSET_X_MAX_EM, 6);
    expect(m.scaleMul).toBeCloseTo(1 + SCALE_LIFT, 6);
  });

  it('longer sustain => wider wdth (monotonic in word length, at word start / inactive)', () => {
    let prev = -Infinity;
    for (let s = 0; s <= SUSTAIN_REF_SEC + 0.4; s += 0.1) {
      const w = wdthOf(ctx({ wordStart: 0, wordEnd: s, time: 0, isActive: false }));
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it('wdth is always bounded within [WDTH_MIN, WDTH_MAX]', () => {
    const samples: StyleWordContext[] = [
      ctx({ wordStart: 0, wordEnd: 0, isActive: false }),
      ctx({ wordStart: 0, wordEnd: 0.3, time: 0.1, isActive: true }),
      ctx({ wordStart: 0, wordEnd: SUSTAIN_REF_SEC, time: SUSTAIN_REF_SEC, isActive: true }),
      // pathological over-range: huge sustain, held way past the end
      ctx({ wordStart: 0, wordEnd: 100, time: 500, isActive: true }),
    ];
    for (const c of samples) {
      const w = wdthOf(c);
      expect(w).toBeGreaterThanOrEqual(WDTH_MIN);
      expect(w).toBeLessThanOrEqual(WDTH_MAX);
    }
  });

  it('actively holding through a long word opens it wider than the same word at rest', () => {
    // Same long word: inactive (open = sustain01 only) vs held to the end (+HOLD_BOOST).
    const rest = wdthOf(ctx({ wordStart: 0, wordEnd: 0.6, time: 0, isActive: false }));
    const held = wdthOf(ctx({ wordStart: 0, wordEnd: 0.6, time: 0.6, isActive: true }));
    expect(held).toBeGreaterThan(rest);
  });

  it('hold only counts while active — an inactive word ignores time progression', () => {
    const early = wdthOf(ctx({ wordStart: 0, wordEnd: 0.6, time: 0, isActive: false }));
    const late = wdthOf(ctx({ wordStart: 0, wordEnd: 0.6, time: 0.6, isActive: false }));
    expect(late).toBe(early);
  });

  it('computeOpen is bounded [0,1] and reflects the HOLD_BOOST ceiling', () => {
    // short sustain, fully held: open = sustain01 * (1 + HOLD_BOOST), still clamped ≤ 1
    const partial = computeOpen(ctx({ wordStart: 0, wordEnd: 0.3, time: 0.3, isActive: true }));
    const sustain01 = 0.3 / SUSTAIN_REF_SEC;
    expect(partial).toBeCloseTo(sustain01 * (1 + HOLD_BOOST), 6);
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(partial).toBeLessThanOrEqual(1);
  });

  it('is deterministic — identical context yields identical output', () => {
    const c = ctx({ wordStart: 0.5, wordEnd: 1.4, time: 1.0, isActive: true });
    expect(computePullQuote(c)).toEqual(computePullQuote(c));
  });

  it('does not depend on audio (sustain-driven, audio optional)', () => {
    const withAudio = computePullQuote(
      ctx({
        wordStart: 0,
        wordEnd: 0.8,
        time: 0.4,
        isActive: true,
        audio: { bass: 1, mid: 1, high: 1, energy: 1 },
      }),
    );
    const withoutAudio = computePullQuote(
      ctx({ wordStart: 0, wordEnd: 0.8, time: 0.4, isActive: true }),
    );
    expect(withAudio).toEqual(withoutAudio);
  });
});

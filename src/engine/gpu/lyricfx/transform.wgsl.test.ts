import { describe, it, expect } from 'vitest';
import {
  assembleTransformSnippet,
  LYRIC_FX_TRANSFORM_BODIES,
  LYRIC_FX_TRANSFORM_TYPES,
  LYRIC_FX_TRANSFORM_PRELUDE,
} from './transform.wgsl';
import { LYRIC_FX_STAGE } from '@/types/effects/lyric-fx';

describe('lyric-fx transform WGSL', () => {
  it('lists exactly the transform-stage types', () => {
    for (const t of LYRIC_FX_TRANSFORM_TYPES) {
      expect(LYRIC_FX_STAGE[t]).toBe('transform');
    }
    expect(LYRIC_FX_TRANSFORM_TYPES.length).toBe(8);
  });

  it('has a body for every transform type', () => {
    for (const t of LYRIC_FX_TRANSFORM_TYPES) {
      expect(LYRIC_FX_TRANSFORM_BODIES[t]).toContain('fn transform_effect(');
      expect(LYRIC_FX_TRANSFORM_BODIES[t]).toContain('-> GTransform');
    }
  });

  it('assembles prelude + a single transform_effect for a chosen type', () => {
    for (const t of LYRIC_FX_TRANSFORM_TYPES) {
      const src = assembleTransformSnippet(t);
      expect(src).toContain(LYRIC_FX_TRANSFORM_PRELUDE.trim().slice(0, 20));
      expect(src.match(/fn transform_effect\(/g)?.length).toBe(1);
      expect(src).toContain('struct GTransform');
      expect(src).toContain('fn glyph_progress(');
    }
  });

  it('assembles an identity transform when type is null', () => {
    const src = assembleTransformSnippet(null);
    expect(src.match(/fn transform_effect\(/g)?.length).toBe(1);
    expect(src).toContain('return base;');
  });
});

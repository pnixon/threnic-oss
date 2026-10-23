import { describe, it, expect } from 'vitest';
import {
  assemblePostShader,
  LYRIC_FX_POST_BODIES,
  LYRIC_FX_POST_TYPES,
  LYRIC_FX_POST_PRELUDE,
} from './post.wgsl';
import { packPostParams } from './LyricFXGraph';
import { LYRIC_FX_STAGE } from '@/types/effects/lyric-fx';

describe('lyric-fx post WGSL', () => {
  it('lists exactly the post-stage types', () => {
    for (const t of LYRIC_FX_POST_TYPES) {
      expect(LYRIC_FX_STAGE[t]).toBe('post');
    }
    expect(LYRIC_FX_POST_TYPES.length).toBe(4);
  });

  it('has a body for every post type and assembles one fs_main/vs_main', () => {
    for (const t of LYRIC_FX_POST_TYPES) {
      expect(LYRIC_FX_POST_BODIES[t]).toContain('fn post_effect(');
      const src = assemblePostShader(t);
      expect(src).toContain(LYRIC_FX_POST_PRELUDE.trim().slice(0, 15));
      expect(src.match(/@fragment/g)?.length).toBe(1);
      expect(src.match(/@vertex/g)?.length).toBe(1);
      expect(src.match(/fn post_effect\(/g)?.length).toBe(1);
    }
  });

  it('only motionTrails samples the feedback texture', () => {
    for (const t of LYRIC_FX_POST_TYPES) {
      expect(LYRIC_FX_POST_BODIES[t].includes('feedbackTex')).toBe(t === 'motionTrails');
    }
  });
});

describe('packPostParams', () => {
  const base = 16;
  const make = () => new Float32Array(32);

  it('reads a static number and a {value} param the same', () => {
    const a = make();
    packPostParams('textBloom', { threshold: 0.3, intensity: 2 }, a, base);
    const b = make();
    packPostParams('textBloom', { threshold: 0.3, intensity: { value: 2 } }, b, base);
    expect(a[base]).toBeCloseTo(0.3, 6);
    expect(a[base + 1]).toBeCloseTo(2, 6);
    expect(b[base + 1]).toBeCloseTo(2, 6);
  });

  it('falls back to defaults for empty config on every post type', () => {
    for (const t of LYRIC_FX_POST_TYPES) {
      const out = make();
      expect(() => packPostParams(t, {}, out, base)).not.toThrow();
    }
  });
});

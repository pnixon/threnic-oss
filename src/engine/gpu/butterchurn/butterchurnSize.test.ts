import { describe, it, expect } from 'vitest';
import { computeButterchurnRenderSize, BUTTERCHURN_MAX_DIM } from './butterchurnSize';

describe('computeButterchurnRenderSize', () => {
  it('passes sizes within the cap through unchanged', () => {
    expect(computeButterchurnRenderSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(computeButterchurnRenderSize(2048, 1152)).toEqual({ width: 2048, height: 1152 });
  });

  it('caps the longest side at 2048, preserving aspect (landscape 4K)', () => {
    expect(computeButterchurnRenderSize(3840, 2160)).toEqual({ width: 2048, height: 1152 });
  });

  it('caps portrait sizes on the height', () => {
    const { width, height } = computeButterchurnRenderSize(2160, 3840);
    expect(height).toBe(BUTTERCHURN_MAX_DIM);
    expect(width).toBe(1152);
  });

  it('never approaches the old DPR-tripled 5760x3240 preview size', () => {
    const { width, height } = computeButterchurnRenderSize(5760, 3240);
    expect(Math.max(width, height)).toBeLessThanOrEqual(2048);
  });

  it('clamps to the WebGL MAX_TEXTURE_SIZE / MAX_RENDERBUFFER_SIZE when lower', () => {
    expect(
      computeButterchurnRenderSize(1920, 1080, { maxTextureSize: 4096, maxRenderbufferSize: 1024 }),
    ).toEqual({ width: 1024, height: 576 });
    expect(computeButterchurnRenderSize(1920, 1080, { maxTextureSize: 1600 })).toEqual({
      width: 1600,
      height: 900,
    });
  });

  it('ignores bogus GL limits and degenerate input', () => {
    expect(computeButterchurnRenderSize(1920, 1080, { maxTextureSize: 0 })).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(computeButterchurnRenderSize(0, NaN)).toEqual({ width: 1, height: 1 });
  });
});

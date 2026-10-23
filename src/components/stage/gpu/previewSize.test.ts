import { describe, it, expect } from 'vitest';
import { computePreviewRenderSize } from './previewSize';

const layout = { layoutWidth: 1920, layoutHeight: 1080 };

describe('computePreviewRenderSize', () => {
  it('sizes a CSS-scaled phone stage to displayed size × capped DPR (not 5760x3240)', () => {
    // 1920x1080 stage shown 390 px wide on a DPR-3 phone → 390 × 2 = 780 px.
    expect(
      computePreviewRenderSize({
        ...layout,
        displayWidth: 390,
        displayHeight: 219.375,
        devicePixelRatio: 3,
      }),
    ).toEqual({ width: 780, height: 439 });
  });

  it('never exceeds the project resolution', () => {
    // Fullscreen on a 4K DPR-2 display.
    expect(
      computePreviewRenderSize({
        ...layout,
        displayWidth: 3840,
        displayHeight: 2160,
        devicePixelRatio: 2,
      }),
    ).toEqual({ width: 1920, height: 1080 });
  });

  it('uses DPR 1 as-is and keeps the project aspect ratio', () => {
    const size = computePreviewRenderSize({
      ...layout,
      displayWidth: 960,
      displayHeight: 540,
      devicePixelRatio: 1,
    });
    expect(size).toEqual({ width: 960, height: 540 });
  });

  it('follows zoom: a larger displayed size yields a larger render', () => {
    const small = computePreviewRenderSize({
      ...layout,
      displayWidth: 480,
      displayHeight: 270,
      devicePixelRatio: 2,
    })!;
    const zoomed = computePreviewRenderSize({
      ...layout,
      displayWidth: 720,
      displayHeight: 405,
      devicePixelRatio: 2,
    })!;
    expect(small).toEqual({ width: 960, height: 540 });
    expect(zoomed).toEqual({ width: 1440, height: 810 });
  });

  it('treats sub-1 / invalid DPR as 1', () => {
    expect(
      computePreviewRenderSize({
        ...layout,
        displayWidth: 960,
        displayHeight: 540,
        devicePixelRatio: NaN,
      }),
    ).toEqual({ width: 960, height: 540 });
  });

  it('returns null when not laid out or not displayed', () => {
    expect(
      computePreviewRenderSize({
        layoutWidth: 0,
        layoutHeight: 0,
        displayWidth: 100,
        displayHeight: 100,
        devicePixelRatio: 1,
      }),
    ).toBeNull();
    expect(
      computePreviewRenderSize({
        ...layout,
        displayWidth: 0,
        displayHeight: 0,
        devicePixelRatio: 2,
      }),
    ).toBeNull();
  });
});

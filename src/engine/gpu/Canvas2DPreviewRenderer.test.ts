import { describe, it, expect } from 'vitest';
import { Canvas2DPreviewRenderer, PREVIEW_ONLY_METHODS } from './Canvas2DPreviewRenderer';

describe('Canvas2DPreviewRenderer', () => {
  // Every WebGPURenderer method the GPUCanvas loop / effects bridge calls must
  // exist, or the first preview frame throws and the stage freezes.
  const LOOP_METHODS = [
    ...PREVIEW_ONLY_METHODS,
    'getPrimaryVideoElement',
    'setBackgroundImage',
    'setBgTransitionState',
    'clearBackgroundTexture',
    'renderFrame',
    'resize',
    'getDevice',
    'setLyricBitmap',
    'updateLyricGlow',
    'init',
    'destroy',
  ] as const;

  it('implements every method the preview loop calls', () => {
    const r = new Canvas2DPreviewRenderer(document.createElement('canvas'));
    for (const name of LOOP_METHODS) {
      expect(typeof (r as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('GPU-only stubs are harmless no-ops', async () => {
    const r = new Canvas2DPreviewRenderer(document.createElement('canvas'));
    expect(r.getSecondaryVideoElement()).toBeNull();
    expect(r.getGLSLHost()).toBeNull();
    expect(r.getDevice()).toBeNull();
    expect(() => {
      r.syncShaderLayers();
      r.syncGLSLGuests();
      r.setMilkdropConfig();
      r.setGameSceneParams();
      r.setGameSceneAssets();
      r.setGameSceneLyrics();
      r.setLayerOrder();
      r.syncOverlayImage();
      r.setLyricFXGraph();
    }).not.toThrow();
    await expect(r.setButterchurnConfig()).resolves.toBeUndefined();
    await expect(r.setLittleJSConfig()).resolves.toBeUndefined();
  });
});

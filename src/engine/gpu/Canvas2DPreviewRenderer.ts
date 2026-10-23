/**
 * Canvas2DPreviewRenderer — the Canvas2D software renderer, adapted for the
 * live preview stage.
 *
 * GPUCanvas swaps this in when the WebGPU probe passed but WebGPURenderer.init()
 * failed. Its render loop (and the effects/lyrics bridges) call the full
 * WebGPURenderer surface every frame; Canvas2DExportRenderer only implements
 * the export contract, so the first frame used to throw on e.g.
 * getSecondaryVideoElement() and the preview froze. Everything GPU-only is a
 * no-op here: the background, its transforms/transitions and the lyric bitmap
 * still render; effects, shader layers and visualizers simply don't.
 *
 * `implements` keeps the stubs signature-compatible with WebGPURenderer, so a
 * new method the loop starts calling shows up as a type error here.
 */

import { Canvas2DExportRenderer } from './Canvas2DExportRenderer';
import type { WebGPURenderer } from './WebGPURenderer';

/** WebGPURenderer methods the preview stage calls that the export renderer lacks. */
export const PREVIEW_ONLY_METHODS = [
  'getSecondaryVideoElement',
  'syncShaderLayers',
  'syncGLSLGuests',
  'getGLSLHost',
  'setMilkdropConfig',
  'setButterchurnConfig',
  'setLittleJSConfig',
  'setGameSceneParams',
  'setGameSceneAssets',
  'setGameSceneLyrics',
  'setLayerOrder',
  'syncOverlayImage',
  'setLyricFXGraph',
] as const;

type PreviewOnlySurface = Pick<WebGPURenderer, (typeof PREVIEW_ONLY_METHODS)[number]>;

export class Canvas2DPreviewRenderer extends Canvas2DExportRenderer implements PreviewOnlySurface {
  getSecondaryVideoElement(): HTMLVideoElement | null {
    return null;
  }

  syncShaderLayers(): void {}

  syncGLSLGuests(): void {}

  getGLSLHost(): null {
    return null;
  }

  setMilkdropConfig(): void {}

  async setButterchurnConfig(): Promise<void> {}

  async setLittleJSConfig(): Promise<void> {}

  setGameSceneParams(): void {}

  setGameSceneAssets(): void {}

  setGameSceneLyrics(): void {}

  setLayerOrder(): void {}

  syncOverlayImage(): void {}

  setLyricFXGraph(): void {}
}

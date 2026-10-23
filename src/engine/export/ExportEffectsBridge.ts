/**
 * ExportEffectsBridge — Sets up GPU effect passes on the OffscreenGPURenderer
 * for headless export.
 *
 * This is a thin wrapper around the shared EffectsManager class.
 * All pass definitions, state merging, and registration logic live in
 * EffectsManager to ensure parity between preview and export pipelines.
 *
 * Usage:
 *   const bridge = new ExportEffectsBridge(offscreenRenderer);
 *   await bridge.init(effectsConfig);
 *   // In the frame loop:
 *   bridge.syncFrame(resolvedEffectsConfig);
 *   // After export:
 *   bridge.dispose();
 */

import type { IExportRenderer } from '../gpu/IExportRenderer';
import type { EffectsConfig } from '@/types/effects';
import { EffectsManager } from '../gpu/EffectsManager';

export class ExportEffectsBridge {
  private renderer: IExportRenderer;
  private manager: EffectsManager | null = null;

  constructor(renderer: IExportRenderer) {
    this.renderer = renderer;
  }

  /**
   * Initialize: create the RenderGraph on the offscreen renderer and
   * pre-register all effect passes from the base config.
   */
  async init(baseConfig?: EffectsConfig): Promise<void> {
    const renderGraph = await this.renderer.getRenderGraph();
    if (!renderGraph) {
      // Software renderer — no GPU effects pipeline available
      return;
    }
    this.manager = new EffectsManager(renderGraph);
    // Thread the GPU device in so per-instance customShader passes can compile
    // in export exactly as in preview (shared manager, one code path).
    this.manager.setDevice(this.renderer.getDevice());

    if (baseConfig?.effectInstances?.length) {
      await this.manager.preRegister(baseConfig);
    }
  }

  /**
   * Sync effect state for the current frame (synchronous — for preview-like usage).
   * Delegates directly to the shared EffectsManager.
   */
  syncFrame(effectsConfig: EffectsConfig | undefined): void {
    this.manager?.syncFrame(effectsConfig);
  }

  /**
   * Async version: awaits shader compilation for newly-needed passes.
   * Use this in the export loop to ensure effects are ready before rendering.
   */
  async syncFrameAsync(effectsConfig: EffectsConfig | undefined): Promise<void> {
    await this.manager?.syncFrameAsync(effectsConfig);
  }

  /**
   * Clean up — unregister all passes.
   */
  dispose(): void {
    this.manager?.dispose();
    this.manager = null;
  }
}

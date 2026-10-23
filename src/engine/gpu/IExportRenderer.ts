/**
 * IExportRenderer — Shared interface for export renderers.
 *
 * Both OffscreenGPURenderer (WebGPU) and Canvas2DExportRenderer (software)
 * implement this contract so DecoupledExporter can use either transparently.
 */

import type { RenderGraph } from './RenderGraph';
import type { TextureLoader } from './TextureLoader';

export interface FrameState {
  time: number;
  backgroundColor: [number, number, number];
  backgroundBrightness: number;
  backgroundScale: number;
  backgroundOffsetX: number;
  backgroundOffsetY: number;
  backgroundAngle: number;
  backgroundTiling: boolean;
  backgroundFit?: string;
  backgroundContrast?: number;
  backgroundBlur?: number;
  backgroundBlurType?: number;
  backgroundOpacity?: number;
  audioBass: number;
  audioMid: number;
  audioHigh: number;
  audioEnergy: number;
}

export interface BgTransitionOpts {
  opacity1: number;
  scale1: number;
  offsetX1: number;
  offsetY1: number;
  opacity2: number;
  scale2: number;
  offsetX2: number;
  offsetY2: number;
  blendMode: number;
}

export interface IExportRenderer {
  /** Public texture loader for pre-loading URLs (used by DecoupledExporter for slideshows). */
  textureLoader: TextureLoader | null;

  /** Whether this renderer uses a software (Canvas2D) fallback. */
  readonly isSoftware: boolean;

  /**
   * Whether this renderer supports pipelined readback (submitFrame + readSubmittedFrame).
   * When true, the export loop can overlap GPU rendering with CPU readback for higher throughput.
   */
  readonly supportsPipelining: boolean;

  /** Initialize the renderer. Returns false if initialization fails. */
  init(): Promise<boolean>;

  /**
   * Render one frame and return a VideoFrame.
   * @param state - Current frame parameters (background, audio, etc.)
   * @param timestampMicros - Presentation timestamp in microseconds
   * @param durationMicros - Frame duration in microseconds
   */
  renderAndReadVideoFrame(
    state: FrameState,
    timestampMicros: number,
    durationMicros: number,
  ): Promise<VideoFrame>;

  /** Generate a snapshot blob for UI progress preview. */
  createSnapshotBlob(state?: FrameState): Promise<Blob | null>;

  /**
   * Load a background image or video from a URL.
   * @param url - URL to load (null to clear)
   * @param targetIndex - Texture slot (1 = primary, 2 = transition target)
   */
  setBackgroundFromUrl(url: string | null, targetIndex?: 1 | 2): Promise<boolean>;

  /**
   * Set a pre-decoded ImageBitmap as the background.
   * @param bitmap - The bitmap to use
   * @param targetIndex - Texture slot (1 or 2)
   */
  setBackgroundFromBitmap(bitmap: ImageBitmap, targetIndex?: 1 | 2): void;

  /** Seek a loaded video background to a specific time. */
  seekVideoToTime(time: number, targetIndex?: 1 | 2): Promise<void>;

  /** Clear all background textures. */
  clearBackgroundTexture(): void;

  /** Set slideshow transition state (per-slot opacity, scale, offset). */
  setBgTransitionState(opts: BgTransitionOpts): void;

  /**
   * Synchronously promote slot 2's texture into slot 1 and clear slot 2.
   * Used on transition completion to avoid async re-loading of the same image.
   * Optional — falls back to setBackgroundFromUrl if not available.
   */
  promoteSlot2ToSlot1?(): void;

  /** Set the crossfade mix ratio between texture slots (legacy). */
  setBgMixRatio(ratio: number): void;

  /** Set the lyric overlay bitmap for the next frame. */
  setLyricBitmap(bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null): void;

  /**
   * Set the compositing layer split for the next frame so the lyric layer can
   * be repositioned relative to the post-FX passes (parity with the live
   * renderer). Pass null for legacy behavior (lyrics composite last). Optional —
   * software renderers may omit it.
   */
  setLayerOrder?(split: { below: string[]; above: string[]; anyAbove: boolean } | null): void;

  /** Update the glow intensity of the lyric overlay. */
  updateLyricGlow(intensity: number): void;

  /** Seed the internal frame-time tracker for non-zero start offsets. */
  seedFrameTime(startTime: number): void;

  /**
   * Get or create the RenderGraph for post-processing effects.
   * Returns null for software renderers that don't support GPU effects.
   */
  getRenderGraph(): Promise<RenderGraph | null>;

  /** Get the existing render graph (sync, returns null if not created). */
  getRenderGraphSync(): RenderGraph | null;

  /** Get the GPU device (null for software renderers). */
  getDevice(): GPUDevice | null;

  /** Get the texture format. */
  getFormat(): GPUTextureFormat | string;

  /** Clean up all resources. */
  destroy(): void;

  // ── Shader Overlay (optional) ───────────────────────────────────────

  /**
   * Configure the shader overlay pass for export.
   * Only available on GPU renderers (OffscreenGPURenderer).
   */
  setShaderOverlayConfig?(config: import('./ShaderOverlayPass').ShaderOverlayConfig | null): void;

  /**
   * Sync the full set of enabled shader-mode layers to composite (N instanced
   * shaderFx layers), in front-to-back order. Only available on GPU renderers.
   * Preferred over setShaderOverlayConfig, which is the legacy single-layer path.
   */
  syncShaderLayers?(layers: import('./ShaderLayerRegistry').ShaderLayerInput[]): void;

  /**
   * Sync the ordered set of enabled GLSL guest layers (Stage 3a) to composite.
   * Each guest is a single-pass GLSL-guest fragment shader hosted in a
   * shared WebGL2 context and composited at its stack position. Only GPU
   * renderers implement it; the exporter guards the call.
   */
  syncGLSLGuests?(layers: import('./glsl/types').GLSLGuestSource[]): void;
  /** Expose the GLSL guest host for uploading per-channel image/cubemap textures. */
  getGLSLHost?(): import('./glsl/GLSLGuestRenderer').GLSLGuestRenderer | null;

  /**
   * Provide the current export frame's byte-frequency spectrum (0-255/bin) so
   * shader-layer custom bands resolve from real FFT data in export. Only GPU
   * renderers implement it; the exporter guards the call.
   */
  setExportSpectrum?(byteFreq: Uint8Array | null, sampleRate: number): void;

  /**
   * Ensure the shader overlay pipeline is compiled and ready.
   * Must be awaited before rendering frames with shader overlay.
   */
  ensureShaderOverlayReady?(): Promise<boolean>;

  // ── Secondary Background Image Overlay (optional) ──────────────────

  /**
   * Resolve + decode the bgImageOverlay effect's secondary image from its
   * persisted imageAssetId and bind it (texture @3 + sampler @4) on the pass.
   * Must be awaited before rendering frames so frame 0 isn't blank. Only
   * available on GPU renderers (OffscreenGPURenderer). Returns true when a real
   * image was bound; false (placeholder) otherwise.
   */
  ensureBgImageOverlayReady?(
    effectsConfig: import('@/types/effects').EffectsConfig | undefined,
  ): Promise<boolean>;

  // ── Butterchurn (optional) ─────────────────────────────────────────

  /**
   * Configure the Butterchurn visualizer for export.
   * Initializes lazily on first call. Renders are driven per-frame.
   */
  setButterchurnConfig?(
    config: import('@/types/effects/butterchurn').ButterchurnConfig | null,
    audioContext?: AudioContext | OfflineAudioContext,
    audioNode?: AudioNode,
  ): Promise<void>;

  /**
   * Render one frame of the Butterchurn visualizer and copy to the target.
   * Called during export frame loop when butterchurn mode is active.
   *
   * @param timeDomain Optional per-frame time-domain waveform bytes so the
   *   visualizer reacts to the exact audio for this frame (frame-accurate
   *   reactivity). When omitted, falls back to the connected AnalyserNode.
   * @param fps Export framerate for cycle timing and Butterchurn elapsedTime.
   */
  renderButterchurnFrame?(timeDomain?: Uint8Array, fps?: number): void;

  // ── Game Scene (optional) ──────────────────────────────────────────

  /**
   * Configure the Canvas2D game scene renderer for export.
   * Initializes lazily on first call. Renders are driven per-frame.
   */
  setGameSceneConfig?(
    config: import('@/engine/gpu/littlejs/types').GameSceneConfig | null,
  ): Promise<void>;

  /**
   * Give the game scene the track's lyric line timings. Without these the
   * scene believes it is permanently in a lyric gap and holds the wide shot,
   * so per-line character focus never happens.
   */
  setGameSceneLyrics?(lines: Array<{ start: number; end: number }>): void;

  /**
   * Give the game scene its user-uploaded sprite/background URLs (resolved from
   * IndexedDB). Without this the scene falls back to the bundled defaults, so an
   * export would not match what the user sees in the preview.
   */
  setGameSceneAssets?(urls: { left?: string; right?: string; background?: string }): void;

  /**
   * Give the game scene its user-configured params (attack band, threshold and
   * cooldown per character, idle-hover toggles). Without this the scene runs on
   * its hardcoded defaults.
   */
  setGameSceneParams?(params: Record<string, number | string | boolean>): void;

  /**
   * Render one frame of the game scene and copy to the target.
   * Called during export frame loop when game scene mode is active.
   * @param time - Current playback time in seconds
   * @param audioBass - Bass band energy (0-1)
   * @param audioMid - Mid band energy (0-1)
   * @param audioHigh - Treble band energy (0-1)
   * @param audioEnergy - Overall energy (0-1)
   */
  renderGameSceneFrame?(
    time: number,
    audioBass: number,
    audioMid: number,
    audioHigh: number,
    audioEnergy: number,
    duration?: number,
  ): void;

  // ── Pipelined readback (optional) ──────────────────────────────────

  /**
   * Submit GPU rendering for one frame without waiting for readback.
   * Returns the buffer index that will hold the result.
   * Only available when supportsPipelining is true.
   */
  submitFrame?(state: FrameState): number;

  /**
   * Read back a previously submitted frame's buffer and return a VideoFrame.
   * @param bufferIndex — The index returned by submitFrame()
   * @param timestampMicros — Presentation timestamp
   * @param durationMicros — Frame duration
   */
  readSubmittedFrame?(
    bufferIndex: number,
    timestampMicros: number,
    durationMicros: number,
  ): Promise<VideoFrame>;
}

/**
 * DecoupledExporter — Client-side export completely decoupled from the preview UI.
 *
 * This module owns the entire export lifecycle:
 *   1. Takes project configuration directly (keyframes, effects, background, audio)
 *   2. Resolves keyframe state at each frame time using pure functions
 *   3. Drives an IExportRenderer (WebGPU or Canvas2D software fallback)
 *   4. Feeds frames to StreamableExportController (WebCodecs encoder → MP4)
 *   5. Encodes audio in bulk
 *
 * Zero dependency on legacy state proxies, or any
 * React component tree. Can be called from a button click handler or even a Worker.
 *
 * Renderer Selection:
 *   - Prefers OffscreenGPURenderer (WebGPU) for maximum speed (5-10x real-time)
 *   - Falls back to Canvas2DExportRenderer (Canvas2D) when WebGPU is unavailable
 *   - GPU post-processing effects are skipped in Canvas2D mode
 *
 * Architecture:
 *   config → KeyframeResolver → FrameState → IExportRenderer → VideoFrame
 *                                                                   ↓
 *   audioBuffer → AudioAnalyzer → AudioData → StreamableExportController → MP4
 */

import { OffscreenGPURenderer } from '../gpu/OffscreenGPURenderer';
import { Canvas2DExportRenderer } from '../gpu/Canvas2DExportRenderer';
import type { IExportRenderer, FrameState } from '../gpu/IExportRenderer';
import { checkWebGPUSupport } from '../gpu/webgpu-support';
import { ExportEffectsBridge } from './ExportEffectsBridge';
import { StreamableExportController } from './StreamableExportController';
import { AudioAnalyzer } from './AudioAnalyzer';
import { VideoFrameExtractor } from './VideoFrameExtractor';
import { audioStore } from '@/engine/stores/audioStore';
import { timeStore } from '@/engine/stores/timeStore';
import {
  BackgroundTransformManager,
  type BackgroundTransformState,
} from '../gpu/BackgroundTransformManager';
import { computeStateAtTime, parseKeyframes, type ParsedKeyframes } from '@/utils/keyframes';
import { resolveVisualFrameState, FrameResolverCache } from '@/engine/FrameStateResolver';
import type { Keyframe } from '@/types/keyframes';
import type {
  EffectsConfig,
  SlideshowConfig,
  ButterchurnConfig,
  ShaderFxInstanceConfig,
} from '@/types/effects';
import type { GameSceneConfig } from '@/engine/gpu/littlejs/types';
import type { VirtualAudioBuffer } from './VirtualAudioBuffer';
import { resolveRenderPlan } from '@/engine/gpu/resolveRenderPlan';
import { profiler } from '@/utils/profiler';
import { resolveInstancePassId } from '@/engine/gpu/EffectsManager';
import type { VideoClip } from '@/types/video-clips';
import type { LyricLineData, LyricTheme } from '@/types/lyrics';
import { CanvasLyricRenderer, type LyricRenderConfig } from '../lyrics/CanvasLyricRenderer';
import { defaultStyleRegistry } from '@threnic/lyrics';
import type { TickSignals } from '@/engine/SlideshowStateMachine';
import { SlideshowDriver } from '@/engine/slideshow/SlideshowDriver';
import { isVideoUrl, hasVideoMagicBytes } from '../gpu/TextureLoader';
import { getFontUrl, threnicFontRegistry } from '@/constants/fonts';
import { WatermarkCompositor } from './WatermarkCompositor';
import { resolveBackgroundBlur, resolveBackgroundOpacity } from '@/utils/resolveBgEffects';
import { resolveNLEClips } from '@/components/stage/gpu/resolveNLEClips';
import { computeVisuals, type ConcreteTransition } from '@/engine/slideshow/core';

type LegacyThemeFields = LyricTheme & {
  fontUrl?: string;
  fadeInDuration?: number;
  fadeOutDuration?: number;
};

const BLUR_TYPE_MAP: Record<string, number> = {
  box: 0,
  gaussian: 1,
  radial: 2,
  directional: 3,
};

// ─── Public API ────────────────────────────────────────────

export interface DecoupledExportConfig {
  /** Output dimensions */
  width: number;
  height: number;
  /** Frames per second */
  fps: number;
  /** Total duration in seconds */
  duration: number;
  /** Start time offset in seconds. If provided, export begins here instead of 0. */
  startTime?: number;
  /** Video bitrate (auto-computed if omitted) */
  videoBitrate?: number;

  /** Background image URL (or blob URL / data URL) */
  backgroundUrl?: string | null;
  /** Background solid color as hex (#rrggbb) */
  backgroundColor?: string;
  /** Base effects config (provides defaults for keyframe interpolation) */
  effectsConfig?: EffectsConfig;
  /** Keyframes array */
  keyframes?: Keyframe[];
  /** Background media clips */
  videoClips?: VideoClip[];

  /** Decoded audio buffer for audio-reactive analysis + muxing */
  audioBuffer?: AudioBuffer | null;
  /** Suggested filename */
  suggestedName?: string;

  /** Lyric lines for lyric rendering in export */
  lyrics?: LyricLineData[];
  /** Lyric theme configuration */
  lyricTheme?: LyricTheme;
  /** Vertical position for lyrics (0-100) */
  lyricVerticalPosition?: number;
  /** Font URL for lyrics */
  lyricFontUrl?: string;
  /** Lyric fade-in duration */
  lyricFadeInDuration?: number;
  /** Lyric fade-out duration */
  lyricFadeOutDuration?: number;

  /** Track Title string */
  trackTitle?: string;
  /** Track Title Config */
  trackTitleConfig?: import('@/types/effects').TrackTitleConfig;
  /** Track Title Font URL */
  trackTitleFontUrl?: string;

  // ── Multi-track schedule support (for single merged export) ──

  /** Background URLs to switch at track boundaries (sorted by startTime) */
  backgroundSchedule?: Array<{ startTime: number; url: string }>;
  /** Effects configs to switch at track boundaries (sorted by startTime) */
  effectsSchedule?: Array<{ startTime: number; config: EffectsConfig }>;
  /** Lyric themes to switch at track boundaries (sorted by startTime) */
  themeSchedule?: Array<{ startTime: number; theme: LyricTheme }>;
  /** Track titles to switch at track boundaries (sorted by startTime) */
  titleSchedule?: Array<{ startTime: number; title: string }>;

  /** Whether to render the Threnic watermark on exported frames (opt-in) */
  watermark?: boolean;
}

export interface ExportProgress {
  /** Current frame (1-indexed) */
  currentFrame: number;
  /** Total frames */
  totalFrames: number;
  /** Percent complete (0-100) */
  percent: number;
  /** Current encoding fps */
  fps: number;
  /** Realtime multiplier (e.g. 5.0 = 5x faster than real-time) */
  realtimeX: number;
  /** Estimated remaining seconds */
  etaSeconds: number;
  /** Current phase */
  phase: 'init' | 'rendering' | 'audio' | 'finalizing' | 'done' | 'error';
  /** Object URL of a periodic snapshot for UI preview */
  snapshotUrl?: string;
}

type ProgressCallback = (progress: ExportProgress) => void;

interface DecoupledExportResult {
  success: boolean;
  totalFrames: number;
  elapsedMs: number;
  averageFps: number;
  realtimeX: number;
  error?: string;
}

// ─── Core ──────────────────────────────────────────────────

export class DecoupledExporter {
  private config: Required<Pick<DecoupledExportConfig, 'width' | 'height' | 'fps' | 'duration'>> &
    DecoupledExportConfig;

  private renderer: IExportRenderer | null = null;

  /**
   * Load each GLSL guest's image/cubemap channels from LOCAL IndexedDB and
   * upload them into the export renderer's guest host, so the exported frames
   * bind the same customer assets the preview does. Audio/none channels need no
   * upload. Best-effort: a missing/undecodable asset clears that channel.
   */
  private async _loadGLSLGuestChannels(
    glslLayers: import('@/engine/gpu/glsl/types').GLSLGuestSource[],
  ): Promise<void> {
    const host = this.renderer?.getGLSLHost?.();
    if (!host || glslLayers.length === 0) return;
    const { loadGuestImage2D, loadGuestCubemap, loadGuestAssetUrl, videoSlot } =
      await import('@/engine/gpu/glsl/glslGuestAssets');
    const loadChannels = async (
      layerId: string,
      channels: import('@/engine/gpu/glsl/types').GuestChannel[] | undefined,
      pass?: import('@/engine/gpu/glsl/types').GuestBufferId,
    ) => {
      const chs = channels ?? [];
      const keyBase = pass ? 100 + ['a', 'b', 'c', 'd'].indexOf(pass) * 4 : 0;
      for (let i = 0; i < chs.length; i++) {
        const c = chs[i];
        if (c.kind === 'image2d') {
          const bmp = await loadGuestImage2D(layerId, keyBase + i, c.vflip);
          if (bmp) host.setChannelImage2D(layerId, i, bmp, pass);
          else host.clearChannel(layerId, i, pass);
        } else if (c.kind === 'cubemap') {
          const faces = await loadGuestCubemap(layerId, keyBase + i, c.vflip);
          host.setChannelCubemap(layerId, i, faces, pass);
        } else if (c.kind === 'video') {
          if (c.videoSource === 'upload') {
            const url = await loadGuestAssetUrl(layerId, videoSlot(i));
            host.setChannelVideo(layerId, i, 'upload', url ?? null, pass);
          } else {
            host.setChannelVideo(layerId, i, 'background', null, pass);
          }
        } else if (c.kind !== 'buffer') {
          host.clearChannel(layerId, i, pass);
        }
      }
    };
    for (const l of glslLayers) {
      await loadChannels(l.id, l.channels);
      for (const b of ['a', 'b', 'c', 'd'] as const) {
        if (l.buffers?.[b]) await loadChannels(l.id, l.buffers[b]!.channels, b);
      }
    }
  }

  private effectsBridge: ExportEffectsBridge | null = null;
  private controller: StreamableExportController | null = null;
  private audioAnalyzer: AudioAnalyzer | null = null;
  private _butterchurnAudioCtx: AudioContext | null = null;
  /** Blob URLs minted for custom game-scene assets; revoked in _cleanup(). */
  private _gameSceneBlobUrls: string[] = [];
  private parsedKeyframes: ParsedKeyframes | null = null;
  private lyricRenderer: CanvasLyricRenderer | null = null;
  private watermarkCompositor: WatermarkCompositor | null = null;
  /** Standalone canvas for watermark-only frames (no lyrics) */
  private _watermarkCanvas: OffscreenCanvas | null = null;
  private _watermarkCtx: OffscreenCanvasRenderingContext2D | null = null;
  private slideshowDriver: SlideshowDriver | null = null;
  private slideshowConfig: SlideshowConfig | null = null;
  /** Shared resolver cache for unified frame state resolution */
  private _frameResolverCache = new FrameResolverCache();
  /** The last background URL that was loaded into the renderer */
  private _currentLoadedBgUrl: string | null = null;
  private _currentLoadedNextUrl: string | null = null;

  /**
   * Pre-decoded video frame atlases keyed by URL.
   * Each VideoFrameExtractor holds ALL decoded frames for one video file
   * as GPU-backed ImageBitmaps, enabling zero-latency frame lookup.
   * Supports multiple videos simultaneously (e.g. slideshow with mixed media).
   */
  private _videoExtractors: Map<string, VideoFrameExtractor> = new Map();
  /** The extractor for the single background video (non-slideshow path) */
  private _bgExtractor: VideoFrameExtractor | null = null;
  /** Pre-decoded video extractors for scheduled backgrounds (multi-track combined export) */
  private _scheduledVideoExtractors: Map<string, VideoFrameExtractor> = new Map();
  /** The currently active scheduled video extractor (if background is a video) */
  private _activeScheduledExtractor: VideoFrameExtractor | null = null;

  private _cancelled = false;
  private _running = false;
  private _encoderReady = false;

  private bgTransformManager = new BackgroundTransformManager();

  /** One-shot guard for the zoom export diagnostic (remove after debugging). */

  // ── Multi-track schedule tracking ──
  private _activeScheduleBgUrl: string | null = null;
  /** The absolute export time at which the current scheduled background started */
  private _activeScheduleBgStartTime: number = 0;
  private _activeScheduleEffects: { startTime: number; config: EffectsConfig } | null = null;
  private _activeScheduleTheme: { startTime: number; theme: LyricTheme } | null = null;
  private _activeScheduleTitle: { startTime: number; title: string } | null = null;

  constructor(config: DecoupledExportConfig) {
    this.config = {
      ...config,
      width: Math.round(config.width / 2) * 2, // Ensure even
      height: Math.round(config.height / 2) * 2,
    };
  }

  get isRunning(): boolean {
    return this._running;
  }

  /**
   * Cancel a running export.
   */
  cancel(): void {
    this._cancelled = true;
  }

  /**
   * Run the full export pipeline.
   *
   * This is the single entry point. It:
   *   1. Initializes the GPU renderer
   *   2. Initializes the WebCodecs encoder + muxer
   *   3. Pre-parses keyframes
   *   4. Renders every frame at maximum speed
   *   5. Encodes audio
   *   6. Finalizes the MP4
   *
   * @param writableStream - A WritableStream to write the MP4 to (from showSaveFilePicker)
   * @param onProgress - Optional progress callback
   */
  async run(
    writableStream: WritableStream,
    onProgress?: ProgressCallback,
  ): Promise<DecoupledExportResult> {
    if (this._running) throw new Error('Export already in progress');
    this._running = true;
    this._cancelled = false;

    const { width, height, fps, duration } = this.config;
    const totalFrames = Math.ceil(duration * fps);
    const startTime = performance.now();

    // Set export mode in time store
    timeStore.getState().setMode('export');
    timeStore.getState().setDuration(duration);

    const report = (frame: number, phase: ExportProgress['phase'], snapshotUrl?: string) => {
      if (!onProgress) return;
      const elapsed = (performance.now() - startTime) / 1000;
      const currentFps = elapsed > 0 ? frame / elapsed : 0;
      const realtimeX = currentFps / fps;
      const remaining = currentFps > 0 ? (totalFrames - frame) / currentFps : 0;
      onProgress({
        currentFrame: frame,
        totalFrames,
        percent: (frame / totalFrames) * 100,
        fps: currentFps,
        realtimeX,
        etaSeconds: remaining,
        phase,
        snapshotUrl,
      });
    };

    // Snapshot tracking for preview frames
    let lastSnapshotWallTime = 0;
    let currentSnapshotUrl: string | undefined;

    try {
      // ── 1. Init Renderer (WebGPU → Canvas2D fallback) ────
      report(0, 'init');

      const webgpuAvailable = await checkWebGPUSupport();
      if (webgpuAvailable) {
        const gpuRenderer = new OffscreenGPURenderer(width, height);
        const gpuOk = await gpuRenderer.init();
        if (gpuOk) {
          this.renderer = gpuRenderer;
        }
      }
      // Fallback to Canvas2D if WebGPU is unavailable or failed
      if (!this.renderer) {
        const softRenderer = new Canvas2DExportRenderer(width, height);
        const softOk = await softRenderer.init();
        if (!softOk) throw new Error('Both WebGPU and Canvas2D initialization failed');
        this.renderer = softRenderer;
        console.warn(
          '[DecoupledExporter] WebGPU unavailable — using Canvas2D software renderer ' +
            '(GPU effects will be skipped).',
        );
      }

      // ── Load & pre-decode background media ──
      // Priority (must match preview renderer GPUCanvas.tsx):
      //   1. NLE videoClips (explicit start/end timing from timeline)
      //   2. Slideshow state machine from effectsConfig.slideshow
      //   3. Explicit backgroundUrl (single static/video background)
      const hasNLEClips = (this.config.videoClips?.length ?? 0) > 0;
      const slideshowCfg = this.config.effectsConfig?.slideshow;
      const validItems =
        !hasNLEClips && slideshowCfg?.items
          ? slideshowCfg.items.filter((item) => !item.failed && !!item.url)
          : [];
      const hasSlideshow = validItems.length > 0;

      if (hasSlideshow) {
        // Initialize slideshow state machine for cycling through media items.
        //
        // When NLE videoClips also exist, they encode the user's intended
        // slide duration from the Create Slideshow dialog. The stored
        // effectsConfig.slideshow.staticDuration may be stale, so we
        // derive the actual duration from the clip lengths.
        let effectiveStaticDuration = slideshowCfg!.staticDuration;
        let effectiveTransitionDuration = slideshowCfg!.transitionDuration;
        const nleClips = this.config.videoClips;
        if (nleClips && nleClips.length >= 2) {
          // Compute median clip duration (more robust than average)
          const clipDurations = nleClips.map((c) => c.endTime - c.startTime).sort((a, b) => a - b);
          const medianDuration = clipDurations[Math.floor(clipDurations.length / 2)];
          // Derive transition duration from the first clip that has one
          const firstTrans = nleClips.find((c) => c.transition && c.transition.duration > 0);
          const clipTransDuration = firstTrans?.transition?.duration ?? effectiveTransitionDuration;

          if (Math.abs(medianDuration - effectiveStaticDuration) > 0.5) {
            effectiveStaticDuration = medianDuration;
            effectiveTransitionDuration = clipTransDuration;
          }
        }

        this.slideshowConfig = {
          ...slideshowCfg!,
          staticDuration: effectiveStaticDuration,
          transitionDuration: effectiveTransitionDuration,
          items: validItems,
        };
        this.slideshowDriver = new SlideshowDriver();

        // Pre-decode all video items + load all image items
        const workingItems = [];
        for (const item of this.slideshowConfig.items) {
          if (!item.url) {
            console.warn('[DecoupledExporter] Skipping slideshow item with empty URL');
            continue;
          }
          try {
            if (await this._isVideoUrl(item.url, item.label)) {
              const extractor = new VideoFrameExtractor();
              const ok = await extractor.init(item.url);
              if (ok) {
                this._videoExtractors.set(item.url, extractor);
                workingItems.push(item);
              } else {
                console.warn(
                  `[DecoupledExporter] Failed to pre-decode video, skipping: ${item.url.substring(0, 60)}`,
                );
              }
            } else {
              const loaded = await this.renderer.textureLoader?.loadFromUrl(item.url);
              if (loaded) {
                workingItems.push(item);
              } else {
                console.warn(
                  `[DecoupledExporter] Image load failed, skipping: ${item.url.substring(0, 60)}`,
                );
              }
            }
          } catch (err) {
            console.warn(
              `[DecoupledExporter] Failed to load slideshow item ${item.url.substring(0, 60)}:`,
              err,
            );
          }
        }

        if (workingItems.length === 0) {
          console.warn('[DecoupledExporter] No working items in slideshow, disabling slideshow.');
          this.slideshowConfig = null;
          this.slideshowDriver = null;
        } else {
          this.slideshowConfig.items = workingItems;
          this.slideshowDriver.init(workingItems, this.slideshowConfig);

          // Load the first item as the initial background
          const firstUrl = workingItems[0].url;
          const firstExtractor = this._videoExtractors.get(firstUrl);
          if (firstExtractor) {
            const bitmap = firstExtractor.getFrameAtTime(0);
            if (bitmap) this.renderer.setBackgroundFromBitmap(bitmap);
          } else {
            await this.renderer.setBackgroundFromUrl(firstUrl);
          }
          this._currentLoadedBgUrl = firstUrl;
        }
      } else if (this.config.backgroundUrl) {
        // Single background — check if it's a video
        if (await this._isVideoUrl(this.config.backgroundUrl)) {
          this._bgExtractor = new VideoFrameExtractor();
          const ok = await this._bgExtractor.init(this.config.backgroundUrl);
          if (ok) {
            const bitmap = this._bgExtractor.getFrameAtTime(0);
            if (bitmap) this.renderer.setBackgroundFromBitmap(bitmap);
          } else {
            // Fallback to HTMLVideoElement path
            console.warn(
              '[DecoupledExporter] Video pre-decode failed, falling back to HTMLVideoElement',
            );
            this._bgExtractor = null;
            await this.renderer.setBackgroundFromUrl(this.config.backgroundUrl);
          }
        } else {
          await this.renderer.setBackgroundFromUrl(this.config.backgroundUrl);
        }
        this._currentLoadedBgUrl = this.config.backgroundUrl;
      }

      // Pre-decode all video clips
      if (this.config.videoClips?.length) {
        for (const clip of this.config.videoClips) {
          if (!clip.url) continue;
          if (this._videoExtractors.has(clip.url)) continue;

          try {
            if (await this._isVideoUrl(clip.url, clip.name)) {
              const extractor = new VideoFrameExtractor();
              const ok = await extractor.init(clip.url);
              if (ok) {
                this._videoExtractors.set(clip.url, extractor);
              } else {
                console.warn(
                  `[DecoupledExporter] Failed to pre-decode video clip, skipping: ${clip.url.substring(0, 60)}`,
                );
              }
            } else {
              await this.renderer.textureLoader?.loadFromUrl(clip.url);
            }
          } catch (err) {
            console.warn(
              `[DecoupledExporter] Failed to load clip ${clip.url.substring(0, 60)}:`,
              err,
            );
          }
        }
      }

      // Init effects bridge (uses shared EffectsManager for parity with preview)
      // Only initialize for GPU renderers — Canvas2D skips GPU effects
      if (!this.renderer.isSoftware) {
        this.effectsBridge = new ExportEffectsBridge(this.renderer);
        await this.effectsBridge.init(this.config.effectsConfig);

        // Pre-warm the secondary background-image overlay: decode the persisted
        // image (headless, from imageAssetId) and bind it BEFORE the first frame
        // so frame 0 isn't blank. Guarded by an internal timeout so a dead asset
        // can't hang the export.
        if (this.renderer.ensureBgImageOverlayReady) {
          await this.renderer.ensureBgImageOverlayReady(this.config.effectsConfig);
        }

        // Init shader layers (must await pipeline compilation before rendering).
        // Collect ALL enabled shaderFx instances in shader mode (Stage 2 — N
        // layers), ordered by layerOrder position, plus the legacy top-level
        // config as a fallback. Shared registry with preview → no drift.
        const collectShaderLayers = () => {
          const instances = this.config.effectsConfig?.effectInstances;
          const orderIndex = new Map<string, number>();
          (this.config.effectsConfig?.layerOrder ?? []).forEach((t, i) => {
            if (t?.kind === 'effect' && t.id) orderIndex.set(t.id, i);
          });
          const layers = (instances ?? [])
            .filter(
              (inst) =>
                inst?.type === 'shaderFx' &&
                inst.config?.mode === 'shader' &&
                inst.config?.enabled &&
                inst.config?.shader,
            )
            .map((inst) => ({
              id: inst.id,
              config: (inst.config as ShaderFxInstanceConfig).shader,
            }))
            .sort(
              (a, b) =>
                (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
            );
          if (layers.length > 0) return layers;
          const legacy = this.config.effectsConfig?.shaderOverlay;
          return legacy?.enabled ? [{ id: '__legacy_shader_overlay__', config: legacy }] : [];
        };

        const shaderLayers = collectShaderLayers();
        if (shaderLayers.length > 0 && this.renderer.syncShaderLayers) {
          this.renderer.syncShaderLayers(shaderLayers);
          if (this.renderer.ensureShaderOverlayReady) {
            const ready = await this.renderer.ensureShaderOverlayReady();
            if (!ready) {
              console.warn(
                '[DecoupledExporter] One or more shader layers failed to compile — will be skipped.',
              );
            }
          }
        }

        // GLSL guest layers (Stage 3a) — collect all enabled 'glsl'-mode shaderFx
        // instances ordered by layerOrder and sync them to the export renderer.
        if (this.renderer.syncGLSLGuests) {
          const gi = this.config.effectsConfig?.effectInstances;
          const goi = new Map<string, number>();
          (this.config.effectsConfig?.layerOrder ?? []).forEach((t, i) => {
            if (t?.kind === 'effect' && t.id) goi.set(t.id, i);
          });
          const glslLayers = (gi ?? [])
            .filter(
              (inst) =>
                inst?.type === 'shaderFx' &&
                inst.config?.mode === 'glsl' &&
                inst.config?.enabled &&
                inst.config?.glsl?.enabled &&
                inst.config?.glsl?.source,
            )
            .map((inst) => {
              const glsl = (inst.config as ShaderFxInstanceConfig).glsl!;
              return {
                id: inst.id,
                source: glsl.source,
                composite: {
                  opacity: glsl.opacity ?? 1,
                  blendMode: glsl.blendMode ?? 'alpha',
                  preserveAlpha: false,
                },
                channels: glsl.channels,
                buffers: glsl.buffers,
                opacityReactive: glsl.audioReactive?.opacity,
                audioRouting: glsl.audioRouting,
              };
            })
            .sort(
              (a, b) =>
                (goi.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                (goi.get(b.id) ?? Number.MAX_SAFE_INTEGER),
            );
          this.renderer.syncGLSLGuests(glslLayers);
          await this._loadGLSLGuestChannels(glslLayers);
        }

        // Init Butterchurn visualizer if configured.
        // Priority: standalone 'butterchurn' effect instance (the list effect) →
        // shaderFx instance in butterchurn mode (legacy sub-mode) → top-level
        // effectsConfig.butterchurn (legacy singleton).
        const instances = this.config.effectsConfig?.effectInstances;
        const bcStandalone = instances?.find(
          (inst) => inst.type === 'butterchurn' && inst.config?.enabled,
        );
        let bcConfig: ButterchurnConfig | undefined = bcStandalone
          ? (bcStandalone.config as ButterchurnConfig)
          : this.config.effectsConfig?.butterchurn;
        if (!bcConfig?.enabled) {
          // Look in effectInstances for a shaderFx instance in butterchurn mode
          const bcInstance = instances?.find(
            (inst) =>
              inst.type === 'shaderFx' &&
              inst.config?.mode === 'butterchurn' &&
              inst.config?.enabled,
          );
          if (bcInstance) {
            bcConfig =
              (bcInstance.config as ShaderFxInstanceConfig).butterchurn ??
              ({ enabled: true, presetName: '' } as ButterchurnConfig);
            bcConfig.enabled = true;
          }
        }
        if (bcConfig?.enabled && this.renderer.setButterchurnConfig) {
          // Butterchurn needs an AudioContext to construct its visualizer, but
          // for export we drive reactivity per-frame via renderButterchurnFrame(
          // timeDomain, fps) instead of a connected AnalyserNode. A real-time
          // AudioBufferSourceNode would play on the AudioContext clock, which is
          // decoupled from the frame loop (export runs faster/slower than 1x),
          // so the visualizer would react to the wrong moment of audio and drift
          // out of sync with the rendered frames. We therefore pass NO audioNode
          // — the frame loop feeds the exact waveform bytes for each frame.
          try {
            const bcAudioCtx = new AudioContext({ sampleRate: 48000 });
            this._butterchurnAudioCtx = bcAudioCtx;
            await this.renderer.setButterchurnConfig(bcConfig, bcAudioCtx, undefined);
          } catch (err) {
            console.warn('[DecoupledExporter] Butterchurn init failed:', err);
          }
        }

        // Init Game Scene renderer if configured
        let gsConfig: GameSceneConfig | null = null;
        const gsInstances = this.config.effectsConfig?.effectInstances;
        const gsInstance = gsInstances?.find(
          (inst) =>
            inst.type === 'shaderFx' && inst.config?.mode === 'littlejs' && inst.config?.enabled,
        );
        if (gsInstance) {
          gsConfig =
            (gsInstance.config as ShaderFxInstanceConfig).littlejs ??
            ({ enabled: true, sceneId: 'rpgCombat' } as GameSceneConfig);
          gsConfig.enabled = true;
        }
        if (gsConfig?.enabled && this.renderer.setGameSceneConfig) {
          try {
            // Send lyrics/params/assets BEFORE init so they are flushed into the
            // scene the moment it exists.
            //
            // Lyrics drive per-line character focus — with an empty list the
            // scene holds the wide shot for the whole video.
            if (this.renderer.setGameSceneLyrics) {
              this.renderer.setGameSceneLyrics(
                (this.config.lyrics ?? []).map((l) => ({ start: l.start, end: l.end })),
              );
            }
            // Params carry the per-character attack band/threshold/cooldown the
            // user set in the trigger widget; without them the scene runs its
            // hardcoded defaults and the exported combat does not match preview.
            if (gsConfig.params && this.renderer.setGameSceneParams) {
              this.renderer.setGameSceneParams(
                gsConfig.params as Record<string, number | string | boolean>,
              );
            }
            // Custom sprites live in IndexedDB, keyed by scene id. Resolving
            // them mints blob URLs, tracked here so cleanup() can revoke them.
            if (this.renderer.setGameSceneAssets) {
              const { loadAllGameSceneAssets } =
                await import('@/engine/gpu/littlejs/gameSceneAssets');
              const urls = await loadAllGameSceneAssets(gsConfig.sceneId || 'rpgCombat');
              this._gameSceneBlobUrls = Object.values(urls).filter((u) => u.startsWith('blob:'));
              this.renderer.setGameSceneAssets(urls);
            }
            await this.renderer.setGameSceneConfig(gsConfig);
          } catch (err) {
            console.warn('[DecoupledExporter] Game scene init failed:', err);
          }
        }
      }

      // Init lyric renderer if lyrics are provided OR track title is configured
      const hasLyrics = !!(this.config.lyrics?.length && this.config.lyricTheme);
      const hasTrackTitle = !!(this.config.trackTitle && this.config.trackTitleConfig?.enabled);
      if (hasLyrics || hasTrackTitle) {
        // Provide a minimal fallback theme when only track title is configured (no lyrics)
        const fallbackTheme: LyricTheme = {
          fontSize: 0.5,
          colorPre: '#666666',
          colorActive: '#ffffff',
          colorPost: '#444444',
          effect: 'none',
          audioReactive: false,
        };
        const lyricConfig: LyricRenderConfig = {
          lyrics: this.config.lyrics ?? [],
          theme: this.config.lyricTheme ?? fallbackTheme,
          verticalPosition: this.config.lyricVerticalPosition,
          fontUrl: this.config.lyricFontUrl,
          fadeInDuration: this.config.lyricFadeInDuration,
          fadeOutDuration: this.config.lyricFadeOutDuration,
          trackTitle: this.config.trackTitle,
          trackTitleConfig: this.config.trackTitleConfig,
          trackTitleFontUrl: this.config.trackTitleFontUrl,
          trackStartTime: 0,
        };
        this.lyricRenderer = new CanvasLyricRenderer(lyricConfig, {
          fontRegistry: threnicFontRegistry,
          styleRegistry: defaultStyleRegistry,
        });
        await this.lyricRenderer.waitForFonts();
      }

      // ── 1b. Init Watermark (if enabled) ──────────────────
      if (this.config.watermark) {
        this.watermarkCompositor = new WatermarkCompositor();
        await this.watermarkCompositor.init();
      }

      // ── 2. Init Encoder ──────────────────────────────────
      const hasAudio = !!this.config.audioBuffer;
      this.controller = new StreamableExportController({
        width,
        height,
        fps,
        videoBitrate: this.config.videoBitrate,
        audioSampleRate: this.config.audioBuffer?.sampleRate ?? 48000,
        audioChannels: this.config.audioBuffer?.numberOfChannels ?? 2,
        suggestedName: this.config.suggestedName,
      });

      const encoderOk = await this.controller.start(hasAudio, writableStream);
      if (!encoderOk) throw new Error('WebCodecs encoder initialization failed');

      // ── 3. Parse Keyframes ───────────────────────────────
      if (this.config.keyframes?.length) {
        this.parsedKeyframes = parseKeyframes(this.config.keyframes);
      }

      // ── 4. Setup Audio Analyzer ──────────────────────────
      let channelData: Float32Array | null = null;
      let audioSampleRate = 48000;
      const isVirtualBuffer =
        this.config.audioBuffer && 'getChannelSlice' in this.config.audioBuffer;
      if (this.config.audioBuffer) {
        this.audioAnalyzer = new AudioAnalyzer({ fftSize: 2048, smoothing: 0 });
        // For VirtualAudioBuffer (large merges), skip getChannelData(0) to avoid
        // allocating a 2+ GB Float32Array. We'll use per-frame slicing instead.
        if (!isVirtualBuffer) {
          channelData = this.config.audioBuffer.getChannelData(0);
        }
        audioSampleRate = this.config.audioBuffer.sampleRate;
      }

      // ── 5. Frame Loop ────────────────────────────────────
      const frameDurationMicros = 1_000_000 / fps;
      const startTimeOffset = this.config.startTime ?? 0;

      // Pipelined readback: submit GPU work for frame N while reading frame N-1
      const usePipeline =
        this.renderer.supportsPipelining &&
        !!this.renderer.submitFrame &&
        !!this.renderer.readSubmittedFrame;
      let pendingRead: {
        bufferIndex: number;
        timestampMicros: number;
        durationMicros: number;
        frameIndex: number;
      } | null = null;

      for (let frame = 0; frame < totalFrames; frame++) {
        if (this._cancelled) break;

        const time = startTimeOffset + frame / fps;
        const timestampMicros = frame * frameDurationMicros;

        profiler.frameStart('export', frame);

        // ── Multi-track schedule resolution ──
        profiler.begin('schedules');
        await this._applySchedules(time);
        profiler.end('schedules');

        // Resolve keyframe state at this time
        profiler.begin('resolveFrameState');
        const frameState = this._resolveFrameState(
          time,
          frame,
          channelData,
          audioSampleRate,
          isVirtualBuffer ? this.config.audioBuffer : null,
        );
        profiler.end('resolveFrameState');

        // Feed this frame's byte-frequency spectrum to the shader-layer registry
        // so custom-band sources resolve from real FFT data in export (parity
        // with preview's live AnalyserNode). audioStore.fftData was just written
        // by the AudioAnalyzer inside _resolveFrameState.
        if (this.renderer.setExportSpectrum) {
          this.renderer.setExportSpectrum(audioStore.getState().fftData, audioSampleRate);
        }

        // ── Slideshow: advance the state machine and swap backgrounds ──
        // NOTE: Skip the existing slideshow/bgExtractor/seekVideo logic when
        // background schedules are active — _applySchedules handles it.
        const hasScheduledBg = !!this.config.backgroundSchedule?.length;
        if (!hasScheduledBg && this.slideshowDriver && this.slideshowConfig) {
          // Build video signals for the current item
          let signals: TickSignals | undefined;
          const currentIdx = this.slideshowDriver.currentIndex;
          const currentItem = this.slideshowConfig.items[currentIdx];
          if (currentItem?.type === 'video') {
            const extractor = this._videoExtractors.get(currentItem.url);
            if (extractor && extractor.ready) {
              // Use the driver's time tracking for consistent video-relative time
              const prevRenderState = this.slideshowDriver.time;
              const relTime = prevRenderState > 0 ? time - (time - prevRenderState) : 0;
              signals = {
                videoDuration: extractor.duration,
                videoCurrentTime: relTime,
                videoEnded: relTime >= extractor.duration,
              };
            }
          }

          // Tick the unified driver with absolute time (no FP drift)
          const relativeTime = time - startTimeOffset;
          const ssState = this.slideshowDriver.tickAt(relativeTime, this.slideshowConfig, signals);

          // ── Transition completion: promote slot 2 → slot 1 (SYNC) ──
          // When a transition completes, the driver signals slot1.urlChanged
          // (new current = old next) and slot2Cleared. Instead of async-loading
          // the image into slot 1 (which causes flicker), we synchronously
          // swap the GPU texture reference — same pattern as the preview renderer.
          if (ssState.slot2Cleared && ssState.slot1.urlChanged) {
            if (this.renderer.promoteSlot2ToSlot1) {
              // Synchronous swap — no async gap, no flicker
              this.renderer.promoteSlot2ToSlot1();
            } else {
              // Fallback: async load + clear (for software renderers)
              await this.renderer.setBackgroundFromUrl(ssState.slot1.url, 1);
              await this.renderer.setBackgroundFromUrl(null, 2);
            }
            this._currentLoadedBgUrl = ssState.slot1.url;
            this._currentLoadedNextUrl = null;
          } else {
            // ── Apply slot 1 (current) ──
            if (ssState.slot1.urlChanged && ssState.slot1.url) {
              const extractor = this._videoExtractors.get(ssState.slot1.url);
              if (extractor) {
                const bitmap = extractor.getFrameAtTime(ssState.slot1.videoRelativeTime);
                if (bitmap) this.renderer.setBackgroundFromBitmap(bitmap, 1);
              } else {
                await this.renderer.setBackgroundFromUrl(ssState.slot1.url, 1);
              }
              this._currentLoadedBgUrl = ssState.slot1.url;
            }

            // ── Apply slot 2 (next) ──
            if (ssState.slot2.urlChanged && ssState.slot2.url) {
              const extractorNext = this._videoExtractors.get(ssState.slot2.url);
              if (extractorNext) {
                const bitmapNext = extractorNext.getFrameAtTime(ssState.slot2.videoRelativeTime);
                if (bitmapNext) this.renderer.setBackgroundFromBitmap(bitmapNext, 2);
              } else {
                await this.renderer.setBackgroundFromUrl(ssState.slot2.url, 2);
              }
              this._currentLoadedNextUrl = ssState.slot2.url;
            }

            // ── Cleanup slot 2 (non-promotion case) ──
            if (ssState.slot2Cleared) {
              await this.renderer.setBackgroundFromUrl(null, 2);
              this._currentLoadedNextUrl = null;
            }
          }

          // ── GPU Transition State ──
          this.renderer.setBgTransitionState({
            opacity1: ssState.slot1.visuals.opacity,
            scale1: ssState.slot1.visuals.scale,
            offsetX1: ssState.slot1.visuals.offsetX,
            offsetY1: ssState.slot1.visuals.offsetY,
            opacity2: ssState.slot2.visuals.opacity,
            scale2: ssState.slot2.visuals.scale,
            offsetX2: ssState.slot2.visuals.offsetX,
            offsetY2: ssState.slot2.visuals.offsetY,
            blendMode: ssState.blendMode,
          });

          // ── Per-frame video extraction (update bitmaps for animated video) ──
          if (ssState.slot1.url && !ssState.slot1.urlChanged) {
            const extractor1 = this._videoExtractors.get(ssState.slot1.url);
            if (extractor1) {
              const bitmap1 = extractor1.getFrameAtTime(ssState.slot1.videoRelativeTime);
              if (bitmap1) this.renderer.setBackgroundFromBitmap(bitmap1, 1);
            }
          }
          if (ssState.transitioning && ssState.slot2.url && !ssState.slot2.urlChanged) {
            const extractor2 = this._videoExtractors.get(ssState.slot2.url);
            if (extractor2) {
              const bitmap2 = extractor2.getFrameAtTime(ssState.slot2.videoRelativeTime);
              if (bitmap2) this.renderer.setBackgroundFromBitmap(bitmap2, 2);
            }
          }
        } else if (this.config.videoClips?.length) {
          // Dedicated videoClips (NLE) pathway using unified resolveNLEClips logic
          const dummySmState = {
            currentUrl: null,
            nextUrl: null,
            mixRatio: 0,
            currentType: 'image',
            nextType: 'image',
          };
          const resolved = resolveNLEClips(this.config.videoClips, time, dummySmState, null);

          const activeClip = resolved.activeClip;
          const prevClip = resolved.prevClip;
          const inTransition = resolved.inTransition;

          // Slot 1 Background resolution
          if (resolved.url) {
            const extractor1 = this._videoExtractors.get(resolved.url);
            if (extractor1) {
              const targetClip = inTransition ? prevClip : activeClip;
              if (targetClip) {
                const localTime = time - targetClip.startTime;
                let sourceTime = 0;
                // A single background clip has no successor scene, so a lone
                // clip loops by default instead of freezing on its last frame
                // (parity with the live preview in syncVideoElement).
                const isSoleClip = this.config.videoClips.length === 1;
                const effectiveBehavior =
                  isSoleClip &&
                  (targetClip.behavior === 'pause' || targetClip.behavior === undefined)
                    ? 'loop'
                    : targetClip.behavior;
                if (effectiveBehavior === 'speed') {
                  const clipDuration = targetClip.endTime - targetClip.startTime;
                  const sourceDur = targetClip.outPoint - targetClip.inPoint;
                  const speed = sourceDur / clipDuration;
                  sourceTime = targetClip.inPoint + localTime * speed;
                } else if (effectiveBehavior === 'loop') {
                  const sourceDur = targetClip.outPoint - targetClip.inPoint;
                  sourceTime =
                    targetClip.inPoint + ((localTime * (targetClip.speed ?? 1.0)) % sourceDur);
                } else if (effectiveBehavior === 'pause') {
                  sourceTime = Math.min(
                    targetClip.outPoint,
                    targetClip.inPoint + localTime * (targetClip.speed ?? 1.0),
                  );
                } else {
                  sourceTime = targetClip.inPoint + localTime * (targetClip.speed ?? 1.0);
                }
                sourceTime = Math.max(
                  targetClip.inPoint,
                  Math.min(targetClip.outPoint, sourceTime),
                );
                const bitmap1 = extractor1.getFrameAtTime(sourceTime);
                if (bitmap1) this.renderer.setBackgroundFromBitmap(bitmap1, 1);
              }
            } else {
              if (this._currentLoadedBgUrl !== resolved.url) {
                await this.renderer.setBackgroundFromUrl(resolved.url, 1);
                this._currentLoadedBgUrl = resolved.url;
              }
            }
          } else {
            if (this._currentLoadedBgUrl !== null) {
              await this.renderer.setBackgroundFromUrl(null, 1);
              this._currentLoadedBgUrl = null;
            }
          }

          // Slot 2 Background resolution
          if (resolved.nextUrl) {
            const extractor2 = this._videoExtractors.get(resolved.nextUrl);
            if (extractor2) {
              if (inTransition && activeClip) {
                const localTime = time - activeClip.startTime;
                let sourceTime = 0;
                if (activeClip.behavior === 'speed') {
                  const clipDuration = activeClip.endTime - activeClip.startTime;
                  const sourceDur = activeClip.outPoint - activeClip.inPoint;
                  const speed = sourceDur / clipDuration;
                  sourceTime = activeClip.inPoint + localTime * speed;
                } else if (activeClip.behavior === 'loop') {
                  const sourceDur = activeClip.outPoint - activeClip.inPoint;
                  sourceTime =
                    activeClip.inPoint + ((localTime * (activeClip.speed ?? 1.0)) % sourceDur);
                } else if (activeClip.behavior === 'pause') {
                  sourceTime = Math.min(
                    activeClip.outPoint,
                    activeClip.inPoint + localTime * (activeClip.speed ?? 1.0),
                  );
                } else {
                  sourceTime = activeClip.inPoint + localTime * (activeClip.speed ?? 1.0);
                }
                sourceTime = Math.max(
                  activeClip.inPoint,
                  Math.min(activeClip.outPoint, sourceTime),
                );
                const bitmap2 = extractor2.getFrameAtTime(sourceTime);
                if (bitmap2) this.renderer.setBackgroundFromBitmap(bitmap2, 2);
              } else {
                // Not in transition: pre-sync / preload upcoming clip (only if we have lookahead)
                const upcoming = this.config.videoClips
                  .filter((c) => c.startTime > time)
                  .sort((a, b) => a.startTime - b.startTime)[0];
                if (upcoming && upcoming.startTime - time <= 2.0) {
                  const bitmap2 = extractor2.getFrameAtTime(upcoming.inPoint);
                  if (bitmap2) this.renderer.setBackgroundFromBitmap(bitmap2, 2);
                }
              }
            } else {
              if (this._currentLoadedNextUrl !== resolved.nextUrl) {
                await this.renderer.setBackgroundFromUrl(resolved.nextUrl, 2);
                this._currentLoadedNextUrl = resolved.nextUrl;
              }
            }
          } else {
            if (this._currentLoadedNextUrl !== null) {
              await this.renderer.setBackgroundFromUrl(null, 2);
              this._currentLoadedNextUrl = null;
            }
          }

          // Transitions state setting
          if (inTransition && resolved.mixRatio > 0) {
            const clipTransType = activeClip?.transition?.type ?? 'crossfade';
            let coreType: ConcreteTransition = 'crossfade';
            if (clipTransType === 'fade-black' || clipTransType === 'bloom-flash')
              coreType = 'fadeBlack';
            else if (clipTransType === 'wipe-left') coreType = 'slideLeft';
            else if (clipTransType === 'wipe-right') coreType = 'slideRight';
            else if (clipTransType === 'zoom-in' || clipTransType === 'zoom-out') coreType = 'zoom';
            else if (clipTransType === 'cut') coreType = 'cut';
            else if (clipTransType === 'crossfade') coreType = 'crossfade';

            const visuals = computeVisuals(coreType, resolved.transitionProgress);
            this.renderer.setBgTransitionState({
              opacity1: visuals.current.opacity,
              scale1: visuals.current.scale,
              offsetX1: visuals.current.offsetX,
              offsetY1: visuals.current.offsetY,
              opacity2: visuals.next.opacity,
              scale2: visuals.next.scale,
              offsetX2: visuals.next.offsetX,
              offsetY2: visuals.next.offsetY,
              blendMode: 1.0,
            });
          } else {
            this.renderer.setBgTransitionState({
              opacity1: 1.0,
              scale1: activeClip ? (activeClip.scale ?? 1.0) : 1.0,
              offsetX1: activeClip ? (activeClip.offsetX ?? 0) : 0,
              offsetY1: activeClip ? (activeClip.offsetY ?? 0) : 0,
              opacity2: 0.0,
              scale2: 1.0,
              offsetX2: 0,
              offsetY2: 0,
              blendMode: 0.0,
            });
          }
        } else if (!hasScheduledBg && this._bgExtractor) {
          // Single video background: use pre-decoded atlas
          const bitmap = this._bgExtractor.getFrameAtTime(time);
          if (bitmap) this.renderer.setBackgroundFromBitmap(bitmap, 1);
        } else if (hasScheduledBg && this._activeScheduledExtractor) {
          // Scheduled video background: use time relative to when this background
          // segment started so the video plays from 0 at each scene boundary,
          // continuing naturally regardless of transition length.
          const relativeTime = time - this._activeScheduleBgStartTime;
          const bitmap = this._activeScheduledExtractor.getFrameAtTime(relativeTime);
          if (bitmap) this.renderer.setBackgroundFromBitmap(bitmap, 1);
        } else if (!hasScheduledBg) {
          // Legacy fallback: HTMLVideoElement seek (only if no extractor)
          await this.renderer.seekVideoToTime(time, 1);
        }

        // Sync effect passes for this frame via the Unified FrameStateResolver.
        // This guarantees the same interpolation + active-range logic as the preview.
        if (this.effectsBridge) {
          let resolvedEffects = this.config.effectsConfig;
          if (this.config.keyframes?.length || this.config.videoClips?.length) {
            const resolved = resolveVisualFrameState(
              {
                keyframes: this.config.keyframes || [],
                time,
                defaultEffects: this.config.effectsConfig,
                videoClips: this.config.videoClips,
              },
              this._frameResolverCache,
            );
            if (resolved.computedEffectsConfig) {
              resolvedEffects = resolved.computedEffectsConfig;
            }
          }
          profiler.begin('effectsSync');
          await this.effectsBridge.syncFrameAsync(resolvedEffects);
          profiler.end('effectsSync');

          // Layer ordering (parity with live GPUCanvas): derived target-driven
          // via the SAME shared resolveRenderPlan() the preview path uses, so the
          // two render paths cannot drift. Null when nothing sits above lyrics.
          if (this.renderer.setLayerOrder) {
            profiler.begin('layerPlan');
            const plan = resolveRenderPlan(resolvedEffects, resolveInstancePassId);
            this.renderer.setLayerOrder(plan.split);
            profiler.end('layerPlan');
          }
        }

        // Render lyrics and pass bitmap to GPU
        if (this.lyricRenderer) {
          profiler.begin('lyricRender');
          // Reuse audio values already computed in _resolveFrameState
          // instead of running a redundant FFT analysis
          const audioForLyrics =
            frameState.audioEnergy > 0
              ? {
                  bass: frameState.audioBass,
                  mid: frameState.audioMid,
                  high: frameState.audioHigh,
                  energy: frameState.audioEnergy,
                }
              : undefined;
          let lyricBitmap = this.lyricRenderer.render(time, width, height, audioForLyrics);

          // Composite watermark onto the lyric canvas (same overlay layer)
          if (this.watermarkCompositor) {
            if (lyricBitmap) {
              // Lyrics visible — draw watermark onto the same canvas
              const wmCanvas = lyricBitmap as OffscreenCanvas | HTMLCanvasElement;
              const wmCtx = wmCanvas.getContext('2d') as
                | OffscreenCanvasRenderingContext2D
                | CanvasRenderingContext2D;
              if (wmCtx) {
                this.watermarkCompositor.compositeSync(wmCtx, wmCanvas.width, wmCanvas.height);
              }
            } else {
              // No lyrics this frame — use standalone watermark canvas at the
              // export resolution (1×). It must never exceed the selected export
              // quality; the lyrics-present path above already composites at the
              // lyric canvas's native (1×) size.
              if (!this._watermarkCanvas || this._watermarkCanvas.width !== width) {
                this._watermarkCanvas = new OffscreenCanvas(width, height);
                this._watermarkCtx = this._watermarkCanvas.getContext(
                  '2d',
                ) as OffscreenCanvasRenderingContext2D;
              }
              this._watermarkCtx!.clearRect(0, 0, width, height);
              this.watermarkCompositor.compositeSync(this._watermarkCtx!, width, height);
              lyricBitmap = this._watermarkCanvas;
            }
          }

          // Pass glow intensity to renderer
          const glowIntensity = this.config.lyricTheme?.glowEnabled
            ? (this.config.lyricTheme.glowIntensity ?? 0.5)
            : 0;
          this.renderer.updateLyricGlow(glowIntensity);

          this.renderer.setLyricBitmap(lyricBitmap);
          profiler.end('lyricRender');
        } else if (this.watermarkCompositor) {
          profiler.begin('lyricRender');
          // No lyric renderer at all — render watermark on standalone transparent
          // canvas at the export resolution (1×), never above the selected quality.
          if (!this._watermarkCanvas || this._watermarkCanvas.width !== width) {
            this._watermarkCanvas = new OffscreenCanvas(width, height);
            this._watermarkCtx = this._watermarkCanvas.getContext(
              '2d',
            ) as OffscreenCanvasRenderingContext2D;
          }
          this._watermarkCtx!.clearRect(0, 0, width, height);
          this.watermarkCompositor.compositeSync(this._watermarkCtx!, width, height);
          this.renderer.setLyricBitmap(this._watermarkCanvas);
          profiler.end('lyricRender');
        }

        // ── GPU Render + Readback + Encode ──────────────────────
        // Render Butterchurn frame if active (composites into render target).
        // Feed the exact per-frame waveform so the visualizer stays audio-
        // reactive in lock-step with the frame — the export AudioContext clock
        // is decoupled from this loop, so a live analyser would drift.
        if (this.renderer.renderButterchurnFrame) {
          this.renderer.renderButterchurnFrame(
            audioStore.getState().timeDomainData,
            this.config.fps,
          );
        }

        // Render Game Scene frame if active (composites into render target)
        if (this.renderer.renderGameSceneFrame) {
          this.renderer.renderGameSceneFrame(
            frameState.time,
            frameState.audioBass,
            frameState.audioMid,
            frameState.audioHigh,
            frameState.audioEnergy,
            this.config.duration,
          );
        }

        if (usePipeline) {
          // PIPELINED PATH: submit current frame, read+encode previous frame
          profiler.begin('gpuSubmit');
          const bufIdx = this.renderer.submitFrame!(frameState);
          profiler.end('gpuSubmit');

          // Read+encode the previously submitted frame (if any)
          if (pendingRead) {
            profiler.begin('readbackEncode');
            const videoFrame = await this.renderer.readSubmittedFrame!(
              pendingRead.bufferIndex,
              pendingRead.timestampMicros,
              pendingRead.durationMicros,
            );
            await this.controller.encodeVideoFrame(videoFrame);
            profiler.end('readbackEncode');
          }

          // Queue this frame for reading on the next iteration
          pendingRead = {
            bufferIndex: bufIdx,
            timestampMicros,
            durationMicros: frameDurationMicros,
            frameIndex: frame,
          };
        } else {
          // SERIALIZED PATH: render → readback → encode (Canvas2D fallback)
          profiler.begin('readbackEncode');
          const videoFrame = await this.renderer.renderAndReadVideoFrame(
            frameState,
            timestampMicros,
            frameDurationMicros,
          );
          await this.controller.encodeVideoFrame(videoFrame);
          profiler.end('readbackEncode');
        }

        profiler.frameEnd();

        // Progress (every 30 frames to avoid callback overhead)
        if (frame % 30 === 0 || frame === totalFrames - 1) {
          // Generate snapshot every ~3 seconds of wall-clock time
          const wallElapsed = (performance.now() - startTime) / 1000;
          if (wallElapsed - lastSnapshotWallTime >= 3.0 || frame === 0) {
            lastSnapshotWallTime = wallElapsed;
            try {
              const blob = await this.renderer!.createSnapshotBlob(frameState);
              if (blob) {
                const newUrl = URL.createObjectURL(blob);
                if (currentSnapshotUrl) URL.revokeObjectURL(currentSnapshotUrl);
                currentSnapshotUrl = newUrl;
              }
            } catch {
              /* snapshot is optional */
            }
          }
          report(frame + 1, 'rendering', currentSnapshotUrl);
        }
      }

      // ── Drain pipeline: read+encode the last submitted frame ──
      if (usePipeline && pendingRead) {
        const videoFrame = await this.renderer.readSubmittedFrame!(
          pendingRead.bufferIndex,
          pendingRead.timestampMicros,
          pendingRead.durationMicros,
        );
        await this.controller.encodeVideoFrame(videoFrame);
      }

      if (this._cancelled) {
        await this.controller.stop();
        return this._result(startTime, totalFrames, false, 'Cancelled by user');
      }

      // ── 6. Encode Audio ──────────────────────────────────
      if (hasAudio && this.config.audioBuffer && this.controller.audioEncoder) {
        report(totalFrames, 'audio');
        await this._encodeAudio(this.config.audioBuffer, startTimeOffset, duration);
      }

      // ── 7. Finalize ──────────────────────────────────────
      report(totalFrames, 'finalizing');
      await this.controller.stop();
      report(totalFrames, 'done');

      return this._result(startTime, totalFrames, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[DecoupledExporter] Error:', msg);
      try {
        await this.controller?.stop();
      } catch {}
      return this._result(startTime, totalFrames, false, msg);
    } finally {
      this._cleanup();
      this._running = false;
    }
  }

  // ─── Private: Multi-track schedule helpers ─────────────

  /**
   * Find the active entry in a time-sorted schedule for the given time.
   */
  private _resolveScheduleEntry<T extends { startTime: number }>(
    schedule: T[],
    time: number,
  ): T | undefined {
    let active: T | undefined;
    for (const entry of schedule) {
      if (entry.startTime <= time) active = entry;
      else break;
    }
    return active;
  }

  /**
   * Apply multi-track schedule switches (background, effects, theme, title)
   * for a given frame time. Only performs work when the active entry changes.
   */
  private async _applySchedules(time: number): Promise<void> {
    // ── Background schedule ──
    if (this.config.backgroundSchedule?.length) {
      const activeBg = this._resolveScheduleEntry(this.config.backgroundSchedule, time);
      if (activeBg && activeBg.url !== this._activeScheduleBgUrl) {
        this._activeScheduleBgStartTime = activeBg.startTime;
        this._activeScheduleBgUrl = activeBg.url;
        // Update the base backgroundUrl so _resolveFrameState uses the
        // correct fallback when keyframes reset assetUrl to null
        this.config.backgroundUrl = activeBg.url;
        if (this.renderer) {
          // Check if this background is a video — if so, pre-decode it
          // (or reuse a cached extractor) for per-frame animation
          if (
            await this._isVideoUrl(
              activeBg.url,
              (activeBg as { name?: string; label?: string }).name ||
                (activeBg as { name?: string; label?: string }).label,
            )
          ) {
            let extractor = this._scheduledVideoExtractors.get(activeBg.url);
            if (!extractor) {
              extractor = new VideoFrameExtractor();
              const ok = await extractor.init(activeBg.url);
              if (ok) {
                this._scheduledVideoExtractors.set(activeBg.url, extractor);
              } else {
                console.warn(
                  '[DecoupledExporter] Failed to pre-decode scheduled video, falling back to static',
                );
                extractor = undefined;
              }
            }
            this._activeScheduledExtractor = extractor ?? null;
            // Load first frame immediately (use relative time so video starts from beginning)
            if (this._activeScheduledExtractor) {
              const relativeTime = time - this._activeScheduleBgStartTime;
              const bitmap = this._activeScheduledExtractor.getFrameAtTime(relativeTime);
              if (bitmap) this.renderer.setBackgroundFromBitmap(bitmap);
            } else {
              await this.renderer.setBackgroundFromUrl(activeBg.url);
            }
          } else {
            // Static image background
            this._activeScheduledExtractor = null;
            await this.renderer.setBackgroundFromUrl(activeBg.url);
          }
          this._currentLoadedBgUrl = activeBg.url;
        }
      }
    }

    // ── Effects schedule ──
    if (this.config.effectsSchedule?.length) {
      const activeEff = this._resolveScheduleEntry(this.config.effectsSchedule, time);
      if (activeEff && activeEff !== this._activeScheduleEffects) {
        this._activeScheduleEffects = activeEff;
        this.config.effectsConfig = activeEff.config;

        // Re-initialize effects bridge with new config
        if (this.effectsBridge && this.renderer) {
          this.effectsBridge.dispose();
          this.effectsBridge = new ExportEffectsBridge(this.renderer);
          await this.effectsBridge.init(activeEff.config);

          // Re-init shader layers for the new active effects config (Stage 2 —
          // N layers). Collect all enabled shader-mode instances ordered by
          // layerOrder, with the legacy top-level config as fallback.
          if (this.renderer.syncShaderLayers) {
            const instances = activeEff.config?.effectInstances;
            const orderIndex = new Map<string, number>();
            (activeEff.config?.layerOrder ?? []).forEach((t, i) => {
              if (t?.kind === 'effect' && t.id) orderIndex.set(t.id, i);
            });
            let layers = (instances ?? [])
              .filter(
                (inst) =>
                  inst?.type === 'shaderFx' &&
                  inst.config?.mode === 'shader' &&
                  inst.config?.enabled &&
                  inst.config?.shader,
              )
              .map((inst) => ({
                id: inst.id,
                config: (inst.config as ShaderFxInstanceConfig).shader,
              }))
              .sort(
                (a, b) =>
                  (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                  (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
              );
            if (layers.length === 0) {
              const legacy = activeEff.config?.shaderOverlay;
              layers = legacy?.enabled ? [{ id: '__legacy_shader_overlay__', config: legacy }] : [];
            }
            this.renderer.syncShaderLayers(layers);
            if (layers.length > 0 && this.renderer.ensureShaderOverlayReady) {
              await this.renderer.ensureShaderOverlayReady();
            }
          }

          // Re-init GLSL guest layers for the new active effects config (Stage 3a).
          if (this.renderer.syncGLSLGuests) {
            const gi = activeEff.config?.effectInstances;
            const goi = new Map<string, number>();
            (activeEff.config?.layerOrder ?? []).forEach((t, i) => {
              if (t?.kind === 'effect' && t.id) goi.set(t.id, i);
            });
            const glslLayers = (gi ?? [])
              .filter(
                (inst) =>
                  inst?.type === 'shaderFx' &&
                  inst.config?.mode === 'glsl' &&
                  inst.config?.enabled &&
                  inst.config?.glsl?.enabled &&
                  inst.config?.glsl?.source,
              )
              .map((inst) => {
                const glsl = (inst.config as ShaderFxInstanceConfig).glsl!;
                return {
                  id: inst.id,
                  source: glsl.source,
                  composite: {
                    opacity: glsl.opacity ?? 1,
                    blendMode: glsl.blendMode ?? 'alpha',
                    preserveAlpha: false,
                  },
                  channels: glsl.channels,
                  buffers: glsl.buffers,
                  opacityReactive: glsl.audioReactive?.opacity,
                  audioRouting: glsl.audioRouting,
                };
              })
              .sort(
                (a, b) =>
                  (goi.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                  (goi.get(b.id) ?? Number.MAX_SAFE_INTEGER),
              );
            this.renderer.syncGLSLGuests(glslLayers);
            await this._loadGLSLGuestChannels(glslLayers);
          }
        }

        // Reset background transform accumulators so slide/zoom/rotate
        // from the previous track don't bleed into the new one
        this.bgTransformManager.reset();

        // Re-parse keyframes with the new base config — keyframes resolve
        // relative to whichever effects config is currently active
        if (this.config.keyframes?.length) {
          this.parsedKeyframes = parseKeyframes(this.config.keyframes);
        }
      }
    }

    // ── Theme + Title schedule ──
    const activeTheme =
      (this.config.themeSchedule?.length
        ? this._resolveScheduleEntry(this.config.themeSchedule, time)
        : null) || null;
    const activeTitle =
      (this.config.titleSchedule?.length
        ? this._resolveScheduleEntry(this.config.titleSchedule, time)
        : null) || null;

    const themeChanged = activeTheme !== this._activeScheduleTheme;
    const titleChanged = activeTitle !== this._activeScheduleTitle;

    if (themeChanged || titleChanged) {
      this._activeScheduleTheme = activeTheme;
      this._activeScheduleTitle = activeTitle;

      const theme = this._activeScheduleTheme?.theme ?? this.config.lyricTheme;
      const title = this._activeScheduleTitle?.title ?? this.config.trackTitle;

      // Update config references for glow resolution in frame loop
      if (theme) this.config.lyricTheme = theme;
      this.config.trackTitle = title;

      // Rebuild lyric renderer with new theme / title
      const hasScheduleLyrics = !!(this.config.lyrics?.length && theme);
      const hasScheduleTitle = !!(
        title &&
        (this.config.effectsConfig?.trackTitle?.enabled ?? this.config.trackTitleConfig?.enabled)
      );
      if (hasScheduleLyrics || hasScheduleTitle) {
        const titleCfg = this.config.effectsConfig?.trackTitle ?? this.config.trackTitleConfig;
        const fallbackTheme: LyricTheme = {
          fontSize: 0.5,
          colorPre: '#666666',
          colorActive: '#ffffff',
          colorPost: '#444444',
          effect: 'none',
          audioReactive: false,
        };
        const effectiveTheme = theme ?? fallbackTheme;
        const lyricConfig: LyricRenderConfig = {
          lyrics: this.config.lyrics ?? [],
          theme: effectiveTheme,
          verticalPosition: effectiveTheme.verticalPosition ?? this.config.lyricVerticalPosition,
          fontUrl: effectiveTheme.fontId
            ? getFontUrl(effectiveTheme.fontId)
            : ((effectiveTheme as LegacyThemeFields).fontUrl ?? this.config.lyricFontUrl),
          fadeInDuration:
            (effectiveTheme as LegacyThemeFields).fadeInDuration ?? this.config.lyricFadeInDuration,
          fadeOutDuration:
            (effectiveTheme as LegacyThemeFields).fadeOutDuration ??
            this.config.lyricFadeOutDuration,
          trackTitle: title,
          trackTitleConfig: titleCfg,
          trackTitleFontUrl: titleCfg?.fontId
            ? getFontUrl(titleCfg.fontId)
            : this.config.trackTitleFontUrl,
          trackStartTime: this._activeScheduleTitle?.startTime ?? 0,
        };
        this.lyricRenderer = new CanvasLyricRenderer(lyricConfig, {
          fontRegistry: threnicFontRegistry,
          styleRegistry: defaultStyleRegistry,
        });
        await this.lyricRenderer.waitForFonts();
      } else {
        this.lyricRenderer = null;
      }
    }
  }

  // ─── Private: Resolve frame state ──────────────────────

  private _resolveFrameState(
    time: number,
    frame: number,
    channelData: Float32Array | null,
    sampleRate: number,
    virtualBuffer?: AudioBuffer | null,
  ): FrameState {
    // Base state
    const bgColor = hexToRgb(this.config.backgroundColor || '#000000');
    let brightness = this.config.effectsConfig?.backgroundBrightness ?? 1.0;
    let scale = this.config.effectsConfig?.backgroundScale ?? 1.0;
    let offsetX = (this.config.effectsConfig?.backgroundOffsetX ?? 0) / 100;
    let offsetY = (this.config.effectsConfig?.backgroundOffsetY ?? 0) / 100;
    let angle = 0;
    let tiling = this.config.effectsConfig?.backgroundTiling ?? false;
    const fit = this.config.effectsConfig?.backgroundFit ?? 'cover';
    let contrast = this.config.effectsConfig?.backgroundContrast ?? 1.0;
    let sceneBlur: number | undefined = undefined;
    let sceneOpacity: number | undefined = undefined;

    // Apply keyframe overrides
    if (this.parsedKeyframes) {
      const state = computeStateAtTime(
        this.parsedKeyframes,
        time,
        undefined, // no theme needed for background-only
        this.config.effectsConfig,
      );
      const scene = state.scene;

      if (scene.backgroundBrightness !== undefined) {
        brightness = scene.backgroundBrightness;
      }
      if (scene.backgroundScale !== undefined) {
        scale = scene.backgroundScale;
      }
      if (scene.backgroundOffsetX !== undefined) {
        offsetX = scene.backgroundOffsetX / 100;
      }
      if (scene.backgroundOffsetY !== undefined) {
        offsetY = scene.backgroundOffsetY / 100;
      }
      if (scene.backgroundAngle !== undefined) {
        angle = scene.backgroundAngle;
      }
      if (scene.backgroundTiling !== undefined) {
        tiling = scene.backgroundTiling;
      }
      if (scene.backgroundContrast !== undefined) {
        contrast = scene.backgroundContrast;
      }
      if (scene.backgroundBlur !== undefined) {
        sceneBlur = scene.backgroundBlur;
      }
      if (scene.backgroundOpacity !== undefined) {
        sceneOpacity = scene.backgroundOpacity;
      }
      if (scene.backgroundColor) {
        const [r, g, b] = hexToRgb(scene.backgroundColor);
        bgColor[0] = r;
        bgColor[1] = g;
        bgColor[2] = b;
      }

      // Handle dynamic background image changes
      // Skip when NLE videoClips handle the background — they manage
      // slot 1/2 textures and transitions via resolveNLEClips.
      // Keyframes also set scene.assetUrl for each clip, which would
      // race with the NLE path and overwrite slot 1 mid-crossfade.
      const nleHandlesBackground = (this.config.videoClips?.length ?? 0) > 0;
      if (!nleHandlesBackground && scene.assetUrl && scene.assetUrl !== this._lastAssetUrl) {
        this._lastAssetUrl = scene.assetUrl;
        // Note: setBackgroundFromUrl is async — for maximum speed we could
        // pre-load all keyframed images during init. For now this works.
        this.renderer?.setBackgroundFromUrl(scene.assetUrl);
      } else if (!nleHandlesBackground && !scene.assetUrl && this._lastAssetUrl) {
        this._lastAssetUrl = null;
        if (this.config.backgroundUrl) {
          this.renderer?.setBackgroundFromUrl(this.config.backgroundUrl);
        } else {
          this.renderer?.clearBackgroundTexture();
        }
      }
    }

    // Audio analysis
    let bass = 0,
      mid = 0,
      high = 0,
      energy = 0;

    if (this.audioAnalyzer && (channelData || virtualBuffer)) {
      const absoluteFrame = time * this.config.fps;
      const aState = audioStore.getState();

      let analysisData: Float32Array;
      let analysisFrame: number;

      if (channelData) {
        // Standard path: full channel data available (real AudioBuffer, <5 min)
        analysisData = channelData;
        analysisFrame = absoluteFrame;
      } else {
        // Virtual buffer path: extract just the FFT window (2048 + padding)
        const fftSize = 2048;
        const samplesPerFrame = sampleRate / this.config.fps;
        const startSample = Math.floor(absoluteFrame * samplesPerFrame);
        // Grab fftSize samples starting at startSample
        const sliceLen = Math.min(fftSize, (virtualBuffer!.length ?? 0) - startSample);
        analysisData = (virtualBuffer as unknown as VirtualAudioBuffer).getChannelSlice(
          0,
          startSample,
          Math.max(0, sliceLen),
        );
        // Pass frame=0 since the data starts at the correct position already
        analysisFrame = 0;
      }

      const bands = this.audioAnalyzer.analyzeFrameInto(
        analysisData,
        analysisFrame,
        this.config.fps,
        sampleRate,
        aState.fftData,
        aState.timeDomainData,
      );
      bass = bands.bass;
      mid = bands.mid;
      high = bands.high;
      energy = (bass + mid + high) / 3;

      // Update audio store
      audioStore.setState({
        bass,
        mid,
        high,
        energy,
      });
    }

    // Apply Background Transforms
    const bgState: BackgroundTransformState = {
      scale,
      offsetX,
      offsetY,
      angle,
      slideActive: false,
    };

    // dt = 1 / fps
    this.bgTransformManager.update(this.config.effectsConfig, 1 / this.config.fps, bgState, false);

    scale = bgState.scale;
    offsetX = bgState.offsetX;
    offsetY = bgState.offsetY;
    let finalAngle = bgState.angle;
    let finalTiling = bgState.slideActive || tiling;
    let finalFit = fit;

    // Resolve audio-reactive dynamic blur and opacity
    const audio = { bass, mid, high, energy };
    const blurResult = resolveBackgroundBlur(this.config.effectsConfig, audio, sceneBlur);
    let resolvedOpacity = resolveBackgroundOpacity(this.config.effectsConfig, audio, sceneOpacity);
    let blurAmount = blurResult.amount;
    const blurType = BLUR_TYPE_MAP[blurResult.blurType] ?? 1;

    // Apply NLE adjustments from active background clip
    const activeClip = this.config.videoClips?.find((c) => time >= c.startTime && time < c.endTime);
    if (activeClip) {
      resolvedOpacity = (activeClip.opacity ?? 1.0) * resolvedOpacity;
      if (activeClip.scale !== undefined) {
        scale = activeClip.scale;
      }
      if (activeClip.offsetX !== undefined) {
        offsetX += activeClip.offsetX;
      }
      if (activeClip.offsetY !== undefined) {
        offsetY += activeClip.offsetY;
      }
      if (activeClip.brightness !== undefined) {
        brightness = activeClip.brightness;
      }
      if (activeClip.angle !== undefined) {
        finalAngle = activeClip.angle;
      }
      if (activeClip.contrast !== undefined) {
        contrast = activeClip.contrast;
      }
      if (activeClip.blur !== undefined) {
        blurAmount = activeClip.blur;
      }
      if (activeClip.fit !== undefined) {
        finalFit = activeClip.fit;
      }
      if (activeClip.tiling !== undefined) {
        finalTiling = finalTiling || activeClip.tiling;
      }
      if (activeClip.backgroundColor !== undefined) {
        const [r, g, b] = hexToRgb(activeClip.backgroundColor);
        bgColor[0] = r;
        bgColor[1] = g;
        bgColor[2] = b;
      }
    }

    return {
      time,
      backgroundColor: bgColor,
      backgroundBrightness: brightness,
      backgroundScale: scale,
      backgroundOffsetX: offsetX,
      backgroundOffsetY: offsetY,
      backgroundAngle: finalAngle,
      backgroundTiling: finalTiling,
      backgroundFit: finalFit,
      backgroundContrast: contrast,
      backgroundBlur: blurAmount,
      backgroundBlurType: blurType,
      backgroundOpacity: resolvedOpacity,
      audioBass: bass,
      audioMid: mid,
      audioHigh: high,
      audioEnergy: energy,
    };
  }

  private _lastAssetUrl: string | null = null;

  // ─── Private: Audio Encoding ───────────────────────────

  private async _encodeAudio(
    audioBuffer: AudioBuffer,
    startSec: number,
    maxDuration: number,
  ): Promise<void> {
    if (!this.controller) return;

    const sampleRate = audioBuffer.sampleRate;
    const channels = audioBuffer.numberOfChannels;
    const maxSamples = Math.min(
      Math.ceil((startSec + maxDuration) * sampleRate),
      audioBuffer.length,
    );
    const startSamples = Math.floor(startSec * sampleRate);

    // Encode in chunks to avoid massive allocations
    const CHUNK_SAMPLES = sampleRate; // 1 second per chunk
    let offset = startSamples;

    while (offset < maxSamples) {
      if (this._cancelled) break;

      const chunkSize = Math.min(CHUNK_SAMPLES, maxSamples - offset);

      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: chunkSize,
        numberOfChannels: channels,
        timestamp: ((offset - startSamples) / sampleRate) * 1_000_000,
        data: this._deinterleaveToPlaynar(audioBuffer, offset, chunkSize).buffer as ArrayBuffer,
      });

      await this.controller.encodeAudio(audioData);
      audioData.close();
      offset += chunkSize;
    }
  }

  /**
   * Extract planar audio data from an AudioBuffer for AudioData constructor.
   * Supports VirtualAudioBuffer's getChannelSlice for memory-efficient chunked reads.
   */
  private _deinterleaveToPlaynar(
    buffer: AudioBuffer,
    offset: number,
    length: number,
  ): Float32Array {
    const channels = buffer.numberOfChannels;
    const result = new Float32Array(length * channels);

    for (let ch = 0; ch < channels; ch++) {
      const destOffset = ch * length;

      // Use getChannelSlice if available (VirtualAudioBuffer) to avoid
      // allocating the entire channel — only reads the requested window.
      if (
        'getChannelSlice' in buffer &&
        typeof (buffer as unknown as VirtualAudioBuffer).getChannelSlice === 'function'
      ) {
        const slice = (buffer as unknown as VirtualAudioBuffer).getChannelSlice(
          ch,
          offset,
          length,
        ) as Float32Array;
        result.set(slice, destOffset);
      } else {
        const channelData = buffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          result[destOffset + i] = channelData[offset + i];
        }
      }
    }
    return result;
  }

  // ─── Private: Helpers ──────────────────────────────────

  private _result(
    startTime: number,
    totalFrames: number,
    success: boolean,
    error?: string,
  ): DecoupledExportResult {
    const elapsedMs = performance.now() - startTime;
    const averageFps = elapsedMs > 0 ? (totalFrames / elapsedMs) * 1000 : 0;
    return {
      success,
      totalFrames,
      elapsedMs,
      averageFps,
      realtimeX: averageFps / this.config.fps,
      error,
    };
  }

  private _cleanup(): void {
    // ── Reset time store back to preview mode ──
    // This MUST happen before destroying GPU resources so the preview
    // render loop (GPUCanvas) resumes normal time sync and mode-gated
    // components (effects, atmosphere, visualizers) return to their
    // preview behaviour.
    timeStore.getState().setMode('preview');
    timeStore.getState().setCurrentTime(0);

    this.effectsBridge?.dispose();
    this.effectsBridge = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.controller = null;
    this.audioAnalyzer = null;
    // Close the Butterchurn audio context (stops the background audio)
    if (this._butterchurnAudioCtx) {
      this._butterchurnAudioCtx.close().catch(() => {});
      this._butterchurnAudioCtx = null;
    }
    // Release the blob URLs minted for custom game-scene sprites. The renderer
    // is already destroyed above, so nothing is still reading them.
    for (const url of this._gameSceneBlobUrls) {
      URL.revokeObjectURL(url);
    }
    this._gameSceneBlobUrls = [];
    this.parsedKeyframes = null;
    this._lastAssetUrl = null;
    this.slideshowDriver = null;
    this.slideshowConfig = null;
    this._currentLoadedBgUrl = null;
    this.watermarkCompositor?.dispose();
    this.watermarkCompositor = null;
    this._watermarkCanvas = null;
    this._watermarkCtx = null;

    // Destroy all pre-decoded video atlases
    for (const extractor of this._videoExtractors.values()) {
      extractor.destroy();
    }
    this._videoExtractors.clear();
    for (const extractor of this._scheduledVideoExtractors.values()) {
      extractor.destroy();
    }
    this._scheduledVideoExtractors.clear();
    this._activeScheduledExtractor = null;
    this._bgExtractor?.destroy();
    this._bgExtractor = null;

    // Dispose VirtualAudioBuffer to release channel data memory
    if (this.config.audioBuffer && 'dispose' in this.config.audioBuffer) {
      (this.config.audioBuffer as unknown as VirtualAudioBuffer).dispose();
    }
  }

  /**
   * Detect whether a URL points to a video file.
   * Handles both extension-based detection and blob URL MIME checking.
   */
  private async _isVideoUrl(url: string, name?: string): Promise<boolean> {
    if (name) {
      const lowerName = name.toLowerCase();
      const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogg', '.ogv'];
      if (videoExts.some((ext) => lowerName.includes(ext))) return true;
      const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
      if (imgExts.some((ext) => lowerName.includes(ext))) return false;
    }
    if (isVideoUrl(url)) return true;
    if (url.startsWith('blob:')) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        if (blob.type.startsWith('video/')) return true;
        // Blob URLs often have empty or generic MIME types — probe magic bytes
        if (blob.type === '' || blob.type === 'application/octet-stream') {
          const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
          if (hasVideoMagicBytes(header)) return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ─── Utilities ─────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length < 6) return [0, 0, 0];
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ];
}

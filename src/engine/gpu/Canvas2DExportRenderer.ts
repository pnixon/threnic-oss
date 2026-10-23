/**
 * Canvas2DExportRenderer — Software fallback renderer for export.
 *
 * Implements the IExportRenderer interface using OffscreenCanvas + Canvas2D,
 * providing the same rendering contract as OffscreenGPURenderer but without
 * any WebGPU dependency. This enables exports on machines/browsers without
 * hardware graphics acceleration.
 *
 * Capabilities:
 *   - Solid color backgrounds with brightness
 *   - Image backgrounds with cover/contain/stretch/etc. fitting
 *   - Background scale, offset, rotation, and tiling
 *   - Dual-texture crossfade transitions (slideshow)
 *   - Video backgrounds via pre-decoded ImageBitmap frames
 *   - Lyric overlay compositing
 *   - Snapshot generation for progress preview
 *
 * Limitations:
 *   - No GPU post-processing effects (bloom, color grade, etc. are skipped)
 *   - Slower than WebGPU (~1-3x real-time vs 5-10x)
 *   - No RenderGraph support
 */

import type { IExportRenderer, FrameState, BgTransitionOpts } from './IExportRenderer';
import type { RenderGraph } from './RenderGraph';

// ---------------------------------------------------------------------------
// Canvas2DExportRenderer
// ---------------------------------------------------------------------------

export class Canvas2DExportRenderer implements IExportRenderer {
  // Public interface
  textureLoader = null; // No GPU texture loader needed

  readonly isSoftware = true;
  readonly supportsPipelining = false;

  // Core canvas
  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  // Dimensions
  private width: number;
  private height: number;
  private _initialized = false;

  // Background images (slots 1 and 2 for transitions)
  private _bgImage1: ImageBitmap | HTMLImageElement | null = null;
  private _bgImage2: ImageBitmap | HTMLImageElement | null = null;
  private _bgMixRatio = 0;

  // Transition state
  private _transitionState: BgTransitionOpts & { active: boolean } = {
    opacity1: 1,
    scale1: 1,
    offsetX1: 0,
    offsetY1: 0,
    opacity2: 0,
    scale2: 1,
    offsetX2: 0,
    offsetY2: 0,
    blendMode: 1.0,
    active: false,
  };

  // Video backgrounds (HTMLVideoElement for legacy seek path)
  private _bgVideo1: HTMLVideoElement | null = null;
  private _bgVideo2: HTMLVideoElement | null = null;
  private _lastBgUrl1: string | null = null;
  private _lastBgUrl2: string | null = null;
  private _failedUrls = new Set<string>();

  // Lyric overlay
  private _pendingLyricBitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null = null;

  // Frame time tracking
  private _lastFrameTime = 0;
  private _lastDt = 0;

  // Filter cache to avoid string reallocation per frame
  private _lastFilterState = { brightness: 1, contrast: 1, blur: 0, filterStr: 'none' };

  constructor(canvasOrWidth: OffscreenCanvas | HTMLCanvasElement | number, height?: number) {
    if (typeof canvasOrWidth === 'number') {
      this.width = canvasOrWidth;
      this.height = height || canvasOrWidth;
      this.canvas = new OffscreenCanvas(this.width, this.height);
    } else {
      this.canvas = canvasOrWidth;
      this.width = this.canvas.width;
      this.height = this.canvas.height;
    }
  }

  // -------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------

  async init(): Promise<boolean> {
    if (this._initialized) return true;

    try {
      this.ctx = this.canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

      if (!this.ctx) {
        console.error('[Canvas2DExportRenderer] Failed to get 2D context.');
        return false;
      }

      this._initialized = true;
      return true;
    } catch (e) {
      console.error('[Canvas2DExportRenderer] Init failed:', e);
      return false;
    }
  }

  // -------------------------------------------------------------------
  // Frame Time
  // -------------------------------------------------------------------

  seedFrameTime(startTime: number): void {
    this._lastFrameTime = startTime;
    this._lastDt = 0;
  }

  // -------------------------------------------------------------------
  // Background
  // -------------------------------------------------------------------

  async setBackgroundFromUrl(url: string | null, targetIndex: 1 | 2 = 1): Promise<boolean> {
    if (!this._initialized) return false;

    const lastUrl = targetIndex === 1 ? this._lastBgUrl1 : this._lastBgUrl2;
    if (url === lastUrl) return true;

    if (url === null || url === '') {
      if (targetIndex === 1) {
        this._bgImage1 = null;
        this._bgVideo1 = null;
        this._lastBgUrl1 = null;
      } else {
        this._bgImage2 = null;
        this._bgVideo2 = null;
        this._lastBgUrl2 = null;
      }
      return true;
    }

    if (this._failedUrls.has(url)) return false;

    try {
      // Try loading as image first
      const response = await fetch(url);
      const blob = await response.blob();

      if (blob.type.startsWith('video/')) {
        // Video — create HTMLVideoElement for seeking
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        video.muted = true;
        video.src = url;
        await new Promise<void>((resolve, reject) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => reject(new Error('Video load failed'));
          setTimeout(() => reject(new Error('Video load timeout')), 10000);
        });

        if (targetIndex === 1) {
          this._bgVideo1 = video;
          this._bgImage1 = null;
          this._lastBgUrl1 = url;
        } else {
          this._bgVideo2 = video;
          this._bgImage2 = null;
          this._lastBgUrl2 = url;
        }
      } else {
        // Image — create ImageBitmap
        const bitmap = await createImageBitmap(blob);
        if (targetIndex === 1) {
          this._bgImage1 = bitmap;
          this._bgVideo1 = null;
          this._lastBgUrl1 = url;
        } else {
          this._bgImage2 = bitmap;
          this._bgVideo2 = null;
          this._lastBgUrl2 = url;
        }
      }
      return true;
    } catch (e) {
      console.warn(`[Canvas2DExportRenderer] Failed to load: ${url}`, e);
      this._failedUrls.add(url);
      return false;
    }
  }

  setBackgroundFromBitmap(bitmap: ImageBitmap, targetIndex: 1 | 2 = 1): void {
    if (!this._initialized || bitmap.width === 0 || bitmap.height === 0) return;
    if (targetIndex === 1) {
      this._bgImage1 = bitmap;
      this._bgVideo1 = null;
    } else {
      this._bgImage2 = bitmap;
      this._bgVideo2 = null;
    }
  }

  async seekVideoToTime(time: number, targetIndex: 1 | 2 = 1): Promise<void> {
    const video = targetIndex === 1 ? this._bgVideo1 : this._bgVideo2;
    if (!video) return;
    const duration = video.duration || 1;
    if (!isFinite(duration)) return;
    const targetTime = time % duration;

    if (Math.abs(video.currentTime - targetTime) < 1 / 60) return;

    video.currentTime = targetTime;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (Math.abs(video.currentTime - targetTime) < 1 / 30) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  clearBackgroundTexture(): void {
    this._bgImage1 = null;
    this._bgImage2 = null;
    this._bgVideo1 = null;
    this._bgVideo2 = null;
    this._bgMixRatio = 0;
    this._lastBgUrl1 = null;
    this._lastBgUrl2 = null;
    this._failedUrls.clear();
    this._transitionState.active = false;
  }

  setBgTransitionState(opts: BgTransitionOpts): void {
    this._transitionState = { ...opts, active: true };
  }

  setBgMixRatio(ratio: number): void {
    this._bgMixRatio = ratio;
    if (this._transitionState.active) {
      this._transitionState.active = false;
    }
  }

  // Preview-specific methods that mimic WebGPURenderer
  setBackgroundImage(currentUrl: string | null, nextUrl: string | null, mixRatio: number): void {
    this.setBackgroundFromUrl(currentUrl, 1);
    // Only load next if mixRatio is relevant to preserve memory, or load eagerly
    if (mixRatio > 0 && nextUrl) {
      this.setBackgroundFromUrl(nextUrl, 2);
    }
    this._bgMixRatio = mixRatio;
  }

  getPrimaryVideoElement(): HTMLVideoElement | null {
    return this._bgVideo1;
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    // Force the canvas backing store to match — critical for the 2D context
    this.canvas.width = w;
    this.canvas.height = h;
  }

  // -------------------------------------------------------------------
  // Lyric Overlay
  // -------------------------------------------------------------------

  setLyricBitmap(bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null): void {
    if (this._pendingLyricBitmap && 'close' in this._pendingLyricBitmap) {
      this._pendingLyricBitmap.close();
    }
    this._pendingLyricBitmap = bitmap;
  }

  updateLyricGlow(): void {
    // Not supported in Canvas2D fallback renderer
  }

  // -------------------------------------------------------------------
  // Render + Readback
  // -------------------------------------------------------------------

  async renderAndReadVideoFrame(
    state: FrameState,
    timestampMicros: number,
    durationMicros: number,
  ): Promise<VideoFrame> {
    if (!this._initialized || !this.ctx) {
      throw new Error('Renderer not initialized');
    }

    const ctx = this.ctx;
    // Always read live canvas dimensions — this.width may be stale if canvas
    // was resized by the ResizeObserver before renderFrame was called.
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Nothing to draw into yet (canvas not sized by ResizeObserver)
    if (w === 0 || h === 0) return null as unknown as VideoFrame;

    // Delta time
    const now = state.time;
    this._lastDt = now - this._lastFrameTime;
    this._lastFrameTime = now;

    // 1. Clear with background color
    const [r, g, b] = state.backgroundColor;
    const brightness = state.backgroundBrightness;

    // Convert to CSS color (apply brightness to base)
    const baseR = Math.min(255, Math.max(0, Math.round(r * brightness * 255)));
    const baseG = Math.min(255, Math.max(0, Math.round(g * brightness * 255)));
    const baseB = Math.min(255, Math.max(0, Math.round(b * brightness * 255)));

    ctx.save();
    ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // 2. Draw background textures
    const hasImage1 = !!(this._bgImage1 || this._bgVideo1);
    const hasImage2 = !!(this._bgImage2 || this._bgVideo2);

    if (hasImage1 || hasImage2) {
      const fit = state.backgroundFit || 'cover';

      if (this._transitionState.active) {
        // Slideshow transition mode
        if (hasImage1) {
          const src1 = this._bgImage1 || this._bgVideo1;
          if (src1) {
            this._drawBackground(
              ctx,
              src1,
              fit,
              state,
              this._transitionState.opacity1,
              this._transitionState.scale1,
              this._transitionState.offsetX1,
              this._transitionState.offsetY1,
            );
          }
        }
        if (hasImage2) {
          const src2 = this._bgImage2 || this._bgVideo2;
          if (src2) {
            this._drawBackground(
              ctx,
              src2,
              fit,
              state,
              this._transitionState.opacity2,
              this._transitionState.scale2,
              this._transitionState.offsetX2,
              this._transitionState.offsetY2,
            );
          }
        }
      } else {
        // Single / legacy crossfade
        if (hasImage1) {
          const src1 = this._bgImage1 || this._bgVideo1;
          if (src1) {
            this._drawBackground(ctx, src1, fit, state, 1.0 - this._bgMixRatio, 1.0, 0, 0);
          }
        }
        if (hasImage2 && this._bgMixRatio > 0) {
          const src2 = this._bgImage2 || this._bgVideo2;
          if (src2) {
            this._drawBackground(ctx, src2, fit, state, this._bgMixRatio, 1.0, 0, 0);
          }
        }
      }
    }

    // 3. Lyric overlay (alpha-blended)
    if (this._pendingLyricBitmap) {
      ctx.save();
      ctx.drawImage(this._pendingLyricBitmap as CanvasImageSource, 0, 0, w, h);
      ctx.restore();

      if ('close' in this._pendingLyricBitmap) {
        this._pendingLyricBitmap.close();
      }
      this._pendingLyricBitmap = null;
    }

    if (this.canvas instanceof HTMLCanvasElement) {
      // In preview mode (HTMLCanvasElement), we don't return a VideoFrame
      return null as unknown as VideoFrame;
    }

    const videoFrame = new VideoFrame(this.canvas, {
      timestamp: Math.round(timestampMicros),
      duration: Math.round(durationMicros),
    });

    return videoFrame;
  }

  // -------------------------------------------------------------------
  // Background Drawing
  // -------------------------------------------------------------------

  // Preview alias for GPUCanvas compatibility
  renderFrame(state: FrameState): void {
    // We pass dummy values for timestamp and duration, which are safely ignored in preview mode
    this.renderAndReadVideoFrame(state, 0, 0).catch(console.error);
  }

  private _drawBackground(
    ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    source: ImageBitmap | HTMLImageElement | HTMLVideoElement,
    fit: string,
    state: FrameState,
    opacity: number,
    slotScale: number,
    slotOffsetX: number,
    slotOffsetY: number,
  ): void {
    if (opacity <= 0) return;

    const w = this.width;
    const h = this.height;
    const srcW =
      'videoWidth' in source
        ? (source as HTMLVideoElement).videoWidth || source.width
        : source.width;
    const srcH =
      'videoHeight' in source
        ? (source as HTMLVideoElement).videoHeight || source.height
        : source.height;

    if (srcW === 0 || srcH === 0) return;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Compute filters (cache string to avoid reallocation)
    const brightness = state.backgroundBrightness ?? 1.0;
    const contrast = state.backgroundContrast ?? 1.0;
    const blur = state.backgroundBlur ?? 0;

    if (
      this._lastFilterState.brightness === brightness &&
      this._lastFilterState.contrast === contrast &&
      this._lastFilterState.blur === blur
    ) {
      ctx.filter = this._lastFilterState.filterStr;
    } else {
      const filters: string[] = [];
      if (brightness !== 1.0) filters.push(`brightness(${brightness})`);
      if (contrast !== 1.0) filters.push(`contrast(${contrast})`);
      if (blur > 0) filters.push(`blur(${blur}px)`);

      const filterStr = filters.length > 0 ? filters.join(' ') : 'none';

      this._lastFilterState.brightness = brightness;
      this._lastFilterState.contrast = contrast;
      this._lastFilterState.blur = blur;
      this._lastFilterState.filterStr = filterStr;

      ctx.filter = filterStr;
    }

    // Compute draw rect based on fit mode
    const { dx, dy, dw, dh } = this._computeFitRect(fit, w, h, srcW, srcH);

    // Apply global transforms (scale, offset, rotation)
    const globalScale = state.backgroundScale * slotScale;
    const globalOffsetX = (state.backgroundOffsetX + slotOffsetX) * w;
    const globalOffsetY = (state.backgroundOffsetY + slotOffsetY) * h;
    const angle = state.backgroundAngle || 0;

    ctx.translate(w / 2 + globalOffsetX, h / 2 + globalOffsetY);
    if (angle !== 0) {
      ctx.rotate((angle * Math.PI) / 180);
    }
    ctx.scale(globalScale, globalScale);
    ctx.translate(-w / 2, -h / 2);

    if (state.backgroundTiling) {
      // Tiling mode — create pattern
      try {
        const pattern = ctx.createPattern(source as CanvasImageSource, 'repeat');
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, w, h);
        }
      } catch {
        // Fallback: just draw once
        ctx.drawImage(source as CanvasImageSource, dx, dy, dw, dh);
      }
    } else {
      ctx.drawImage(source as CanvasImageSource, dx, dy, dw, dh);
    }

    ctx.restore();
  }

  /**
   * Compute the destination rectangle for a background image,
   * replicating the WGSL shader's UV fitting logic in Canvas2D.
   */
  private _computeFitRect(
    fit: string,
    cw: number,
    ch: number,
    iw: number,
    ih: number,
  ): { dx: number; dy: number; dw: number; dh: number } {
    const ca = cw / ch;
    const ia = iw / ih;

    let dw: number, dh: number;

    switch (fit) {
      case 'cover':
        if (ca > ia) {
          dw = cw;
          dh = cw / ia;
        } else {
          dh = ch;
          dw = ch * ia;
        }
        break;
      case 'contain':
        if (ca > ia) {
          dh = ch;
          dw = ch * ia;
        } else {
          dw = cw;
          dh = cw / ia;
        }
        break;
      case 'fitWidth':
        dw = cw;
        dh = cw / ia;
        break;
      case 'fitHeight':
        dh = ch;
        dw = ch * ia;
        break;
      case 'original':
        dw = iw;
        dh = ih;
        break;
      case 'stretch':
      case 'manual':
      default:
        dw = cw;
        dh = ch;
        break;
    }

    // Center the image
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    return { dx, dy, dw, dh };
  }

  // -------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------

  async createSnapshotBlob(): Promise<Blob | null> {
    try {
      const thumbW = Math.min(this.width, 854);
      const thumbH = Math.min(this.height, 480);

      const sourceCanvas = this.canvas;

      if (thumbW < this.width) {
        const thumbCanvas = new OffscreenCanvas(thumbW, thumbH);
        const thumbCtx = thumbCanvas.getContext('2d');
        if (!thumbCtx) return null;
        // Optimization: draw directly from sourceCanvas avoids readback overhead
        thumbCtx.drawImage(sourceCanvas as CanvasImageSource, 0, 0, thumbW, thumbH);
        return await thumbCanvas.convertToBlob({
          type: 'image/jpeg',
          quality: 0.7,
        });
      }

      if (sourceCanvas instanceof OffscreenCanvas) {
        return await sourceCanvas.convertToBlob({
          type: 'image/jpeg',
          quality: 0.7,
        });
      } else {
        return new Promise<Blob | null>((resolve) => {
          (sourceCanvas as HTMLCanvasElement).toBlob((blob) => resolve(blob), 'image/jpeg', 0.7);
        });
      }
    } catch (e) {
      console.error('[Canvas2DExportRenderer] Snapshot failed:', e);
      return null;
    }
  }

  // -------------------------------------------------------------------
  // RenderGraph / GPU stubs (not supported in software mode)
  // -------------------------------------------------------------------

  async getRenderGraph(): Promise<RenderGraph | null> {
    // Software renderer has no GPU effects pipeline
    return null;
  }

  getRenderGraphSync(): RenderGraph | null {
    return null;
  }

  getDevice(): GPUDevice | null {
    return null;
  }

  getFormat(): string {
    return 'rgba8unorm'; // Matches the pixel format we produce
  }

  // -------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------

  destroy(): void {
    this._bgImage1 = null;
    this._bgImage2 = null;
    this._bgVideo1 = null;
    this._bgVideo2 = null;
    this._pendingLyricBitmap = null;
    this._lastFilterState = { brightness: 1, contrast: 1, blur: 0, filterStr: 'none' };
    this._initialized = false;
    this._failedUrls.clear();
  }
}

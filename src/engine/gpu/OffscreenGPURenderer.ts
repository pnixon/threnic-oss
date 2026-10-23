/**
 * OffscreenGPURenderer — WebGPU renderer for export (no vsync).
 *
 * CRITICAL for speed: This renderer does NOT use the canvas swapchain at all
 * for frame-by-frame rendering. Instead it renders to a private GPUTexture
 * and reads pixels back via copyTextureToBuffer + mapAsync. This completely
 * bypasses any vsync or swapchain rate-limiting.
 *
 * A staging OffscreenCanvas is created only for snapshot generation (user
 * preview every ~3 seconds), which is the only time the swapchain is used.
 *
 * Architecture:
 *   - Renders to a private GPUTexture (rgba8unorm)
 *   - copyTextureToBuffer → mapped buffer → VideoFrame from raw pixels
 *   - Fully async — no per-frame GPU sync, uses double-buffered readback
 *   - waitForGPU() only needed before finalization
 *
 * RenderGraph integration:
 *   - When effects are registered, background renders to bgIntermediateTexture
 *   - RenderGraph chains effect passes (bloom, color grade, etc.)
 *   - Final output goes to renderTarget for readback
 *
 * Video Background Export:
 *   - Uses requestVideoFrameCallback (RVFC) for frame-accurate video seeking
 *   - RVFC guarantees the decoded frame is presentation-ready before GPU copy
 *   - Falls back to seeked + extra delay when RVFC is unavailable
 */

import {
  TextureLoader,
  type LoadedTexture,
  type LoadedVideoTexture,
  isVideoUrl,
  hasVideoMagicBytes,
} from './TextureLoader';
import { RenderGraph, type EffectPassParams } from './RenderGraph';
import { LyricCompositePass } from './LyricCompositePass';
import { LyricFXGraph } from './lyricfx/LyricFXGraph';
import type { LyricFXFrameParams } from '@/types/effects/lyric-fx';
import { BackgroundBlurPass } from './BackgroundBlurPass';
import type { ShaderOverlayConfig } from './ShaderOverlayPass';
import { ShaderLayerRegistry, type ShaderLayerInput } from './ShaderLayerRegistry';
import { GLSLGuestManager } from './glsl/GLSLGuestManager';
import { guestAudioFromStore } from './glsl/audioTexture';
import type { GLSLGuestSource } from './glsl/types';
import { computeUVScale } from './WebGPURenderer';
import { BG_IMAGE_OVERLAY_PASS_ID, setOverlayImageMeta } from './BgImageOverlayPass';
import { loadEffectImageBlob } from '@/engine/gpu/effectImageAssets';
import type { EffectsConfig } from '@/types/effects';
import type { IExportRenderer, FrameState } from './IExportRenderer';

// ---------------------------------------------------------------------------
// WGSL shader — identical to preview renderer
// ---------------------------------------------------------------------------

const BACKGROUND_WGSL = /* wgsl */ `
struct Uniforms {
  bgColor: vec4f,        // 16 bytes (offset 0)
  brightness: f32,       // 4 bytes (offset 16)
  globalScale: f32,      // 4 bytes (offset 20)
  globalOffsetX: f32,    // 4 bytes (offset 24)
  globalOffsetY: f32,    // 4 bytes (offset 28)
  hasTexture: f32,       // 4 bytes (offset 32)
  blendMode: f32,        // 4 bytes (offset 36) (0 = Over, 1 = Additive/Crossfade)
  angle: f32,            // 4 bytes (offset 40)
  tiling: f32,           // 4 bytes (offset 44)
  uvScale1: vec2f,       // 8 bytes (offset 48)
  uvScale2: vec2f,       // 8 bytes (offset 56)
  opacity1: f32,         // 4 bytes (offset 64)
  scale1: f32,           // 4 bytes (offset 68)
  offsetX1: f32,         // 4 bytes (offset 72)
  offsetY1: f32,         // 4 bytes (offset 76)
  opacity2: f32,         // 4 bytes (offset 80)
  scale2: f32,           // 4 bytes (offset 84)
  offsetX2: f32,         // 4 bytes (offset 88)
  offsetY2: f32,         // 4 bytes (offset 92)
  contrast: f32,         // 4 bytes (offset 96)
  blur: f32,             // 4 bytes (offset 100)
  padding1: f32,         // 4 bytes (offset 104) -> ensure it aligns to 16 bytes. Structure is 112 bytes total.
  padding2: f32,         // 4 bytes (offset 108)
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var bgTexture1: texture_2d<f32>;
@group(0) @binding(2) var bgTexture2: texture_2d<f32>;
@group(0) @binding(3) var bgSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var out: VertexOutput;
  out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  out.uv = uv[vertexIndex];
  return out;
}

fn sampleBlurred(tex: texture_2d<f32>, samp: sampler, uv: vec2f, blur: f32) -> vec4f {
  if (blur <= 0.0) { return textureSampleLevel(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0); }
  let o = 0.005 * blur;
  var c = textureSampleLevel(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
  c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o, 0.0), vec2f(0.0), vec2f(1.0)), 0.0);
  c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o, 0.0), vec2f(0.0), vec2f(1.0)), 0.0);
  c += textureSampleLevel(tex, samp, clamp(uv + vec2f(0.0, o), vec2f(0.0), vec2f(1.0)), 0.0);
  c += textureSampleLevel(tex, samp, clamp(uv + vec2f(0.0, -o), vec2f(0.0), vec2f(1.0)), 0.0);
  return c * 0.2;
}

fn sampleBlurredWrap(tex: texture_2d<f32>, samp: sampler, uv: vec2f, blur: f32) -> vec4f {
  if (blur <= 0.0) { return textureSampleLevel(tex, samp, fract(uv), 0.0); }
  let o = 0.005 * blur;
  var c = textureSampleLevel(tex, samp, fract(uv), 0.0);
  c += textureSampleLevel(tex, samp, fract(uv + vec2f(o, 0.0)), 0.0);
  c += textureSampleLevel(tex, samp, fract(uv + vec2f(-o, 0.0)), 0.0);
  c += textureSampleLevel(tex, samp, fract(uv + vec2f(0.0, o)), 0.0);
  c += textureSampleLevel(tex, samp, fract(uv + vec2f(0.0, -o)), 0.0);
  return c * 0.2;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  if (u.hasTexture < 0.5) {
    let bg = u.bgColor.rgb * u.brightness;
    let contrastAdjusted = (bg - 0.5) * u.contrast + 0.5;
    return vec4f(clamp(contrastAdjusted, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  var uv = input.uv;
  uv = uv - vec2f(0.5);
  let c = cos(u.angle);
  let s = sin(u.angle);
  uv = vec2f(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
  let safeGlobalScale = max(u.globalScale, 0.001);
  uv = uv / safeGlobalScale;

  let safeScale1 = max(u.scale1, 0.001);
  var uv1 = (uv / safeScale1) * u.uvScale1 + vec2f(0.5) + vec2f(u.globalOffsetX - u.offsetX1, u.globalOffsetY - u.offsetY1);
  let safeScale2 = max(u.scale2, 0.001);
  var uv2 = (uv / safeScale2) * u.uvScale2 + vec2f(0.5) + vec2f(u.globalOffsetX - u.offsetX2, u.globalOffsetY - u.offsetY2);

  var finalColor: vec3f;

  if (u.tiling > 0.5) {
    // Tiling mode: image wraps — always fully covers the canvas.
    let c1 = sampleBlurredWrap(bgTexture1, bgSampler, uv1, u.blur).rgb;
    let c2 = sampleBlurredWrap(bgTexture2, bgSampler, uv2, u.blur).rgb;
    if (u.blendMode > 0.5) {
      finalColor = clamp(c1 * u.opacity1 + c2 * u.opacity2, vec3f(0.0), vec3f(1.0));
      let totalOp = clamp(u.opacity1 + u.opacity2, 0.0, 1.0);
      finalColor = mix(u.bgColor.rgb, finalColor, totalOp);
    } else {
      let behind = mix(u.bgColor.rgb, c1, clamp(u.opacity1, 0.0, 1.0));
      finalColor = mix(behind, c2, clamp(u.opacity2, 0.0, 1.0));
    }
  } else {
    // Non-tiling: per-pixel coverage keeps bgColor strictly behind the image.
    // coverage = inBounds * userOpacity — bgColor shows only in letterbox areas
    // or when the user explicitly fades the image (opacity < 1).
    let inBounds1 = step(0.0, uv1.x) * step(uv1.x, 1.0) * step(0.0, uv1.y) * step(uv1.y, 1.0);
    let inBounds2 = step(0.0, uv2.x) * step(uv2.x, 1.0) * step(0.0, uv2.y) * step(uv2.y, 1.0);

    let img1 = sampleBlurred(bgTexture1, bgSampler, uv1, u.blur).rgb;
    let img2 = sampleBlurred(bgTexture2, bgSampler, uv2, u.blur).rgb;

    let cov1 = inBounds1 * clamp(u.opacity1, 0.0, 1.0);
    let cov2 = inBounds2 * clamp(u.opacity2, 0.0, 1.0);

    if (u.blendMode > 0.5) {
      let summed = clamp(img1 * cov1 + img2 * cov2, vec3f(0.0), vec3f(1.0));
      let totalCov = clamp(cov1 + cov2, 0.0, 1.0);
      finalColor = mix(u.bgColor.rgb, summed, totalCov);
    } else {
      let behind = mix(u.bgColor.rgb, img1, cov1);
      finalColor = mix(behind, img2, cov2);
    }
  }

  let rgb = finalColor * u.brightness;
  let contrastAdjusted = (rgb - 0.5) * u.contrast + 0.5;
  return vec4f(clamp(contrastAdjusted, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// OffscreenGPURenderer
// ---------------------------------------------------------------------------

/**
 * Bytes-per-row must be aligned to 256 bytes for WebGPU buffer copies.
 */
function alignTo256(value: number): number {
  return Math.ceil(value / 256) * 256;
}

export class OffscreenGPURenderer implements IExportRenderer {
  // IExportRenderer contract
  readonly isSoftware = false;
  readonly supportsPipelining = true;

  // Core WebGPU objects
  private device!: GPUDevice;
  private format: GPUTextureFormat = 'rgba8unorm'; // NOT bgra8 — we want consistent byte order

  // Pipeline
  private bgPipeline!: GPURenderPipeline;
  private bgUniformBuffer!: GPUBuffer;
  private bgBindGroupLayout!: GPUBindGroupLayout;
  private sampler!: GPUSampler;

  // Render target (Private texture for readback)
  private renderTarget!: GPUTexture;
  private renderTargetView!: GPUTextureView;

  // Intermediate background texture (used when RenderGraph effects are active)
  private bgIntermediateTexture!: GPUTexture;
  private bgIntermediateView!: GPUTextureView;

  // RenderGraph for post-processing effects
  private _renderGraph: RenderGraph | null = null;
  private _lastDt = 0;
  private _lastFrameTime = 0;

  // Universal background blur pass — blurs the composited background layer
  // (image/video/butterchurn/game-scene/shader) uniformly for export, mirroring
  // the live renderer. The per-image blur in the bg shader is neutralised when
  // this runs to avoid double-blurring.
  private _bgBlurPass: BackgroundBlurPass | null = null;

  /**
   * Seed the internal frame-time tracker so the first frame's delta-time (dt)
   * is a normal frame interval instead of a huge spike.
   *
   * Call this **before** the first `renderAndReadVideoFrame()` when the
   * export starts at a non-zero time offset (e.g. selection exports).
   *
   * @param startTime — The absolute time (seconds) of the first frame.
   */
  seedFrameTime(startTime: number): void {
    this._lastFrameTime = startTime;
    this._lastDt = 0;
  }

  // Cached pixel data from last renderAndReadVideoFrame (used for zero-GPU snapshots)
  private _lastFramePixels: Uint8Array | null = null;

  // Readback pipelining
  private readonly MAX_PENDING_BUFFERS = 3;
  private readbackBuffers: GPUBuffer[] = [];
  private currentBufferIndex = 0;
  private bytesPerRow!: number;
  private bufferSize!: number;

  // Snapshot canvas
  private _snapshotCanvas: OffscreenCanvas | null = null;
  private _snapshotCtx: OffscreenCanvasRenderingContext2D | null = null;

  // State
  private width: number;
  private height: number;
  private _initialized = false;

  // Texture management
  textureLoader!: TextureLoader;
  private placeholderTexture!: LoadedTexture;
  private _bgTexture1: LoadedTexture | null = null;
  private _bgTexture2: LoadedTexture | null = null;
  private _bgMixRatio: number = 0;

  // Slideshow transition state overrides
  private _transitionState = {
    blendMode: 0,
    opacity1: 1,
    scale1: 1,
    offsetX1: 0,
    offsetY1: 0,
    opacity2: 0,
    scale2: 1,
    offsetX2: 0,
    offsetY2: 0,
    active: false,
  };
  private _bgBindGroup: GPUBindGroup | null = null;
  private _bgBindGroupDirty = true;
  private _backgroundVideo: LoadedVideoTexture | null = null;
  private _backgroundVideo2: LoadedVideoTexture | null = null;

  // Lyric compositing
  private _lyricCompositePass: LyricCompositePass | null = null;
  private _pendingLyricBitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null = null;

  // Lyric FX (Stage 3) — GPU per-glyph lyric effect chain, mirror of
  // WebGPURenderer for preview==export parity. Null unless the app opts into
  // GPU lyric mode. Inert by default.
  private _lyricFXGraph: LyricFXGraph | null = null;
  private _lyricFXFrame: LyricFXFrameParams | null = null;
  private _lyricFXActive = false;

  // Layer ordering — mirror of WebGPURenderer for preview==export parity. When
  // set with anyAbove=true, the lyric layer composites into the intermediate
  // between the below-lyrics and above-lyrics effect passes. Null = legacy
  // (lyrics last).
  private _layerPassSplit: {
    below: string[];
    above: string[];
    anyAbove: boolean;
  } | null = null;

  // Shader layers (renders between background and post-processing). N instanced
  // shaderFx layers owned by a shared registry (also used by the preview
  // renderer) so preview/export can't drift. `_shaderLayers` is the ordered set
  // of enabled layers to composite this frame.
  private _shaderLayerRegistry: ShaderLayerRegistry | null = null;
  private _shaderLayers: ShaderLayerInput[] = [];

  // ── GLSL guest layers (Stage 3a) ──
  // One manager owns the shared WebGL2 host + per-guest GPU textures +
  // compositor, identical to the preview renderer so export cannot drift.
  private _glslGuestManager: GLSLGuestManager | null = null;
  private _glslLayers: GLSLGuestSource[] = [];

  // Secondary background image overlay (bgImageOverlay effect). The overlay
  // texture is bound at @binding(3) + its sampler at @binding(4) on the pass
  // via renderGraph.setPassExtraBindings. The pass's frame bind group is only
  // valid when BOTH are bound, so we always keep a texture+sampler attached —
  // a 1x1 placeholder until (and if) a real decoded image is available. The
  // decode happens once at export setup (ensureBgImageOverlayReady), resolved
  // headlessly from the persisted imageAssetId, before frame 0.
  private _overlayImageAssetId: string | null = null;
  private _overlayImageTexture: LoadedTexture | null = null; // real decoded image (owned)
  private _overlaySampler: GPUSampler | null = null;
  private _overlayBindings: GPUBindGroupEntry[] | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /**
   * Initialize the offscreen renderer. Requests its own GPU adapter/device.
   */
  async init(): Promise<boolean> {
    if (this._initialized) return true;

    const gpu = navigator.gpu;
    if (!gpu) {
      console.error('[OffscreenGPURenderer] WebGPU not supported.');
      return false;
    }

    const { requestHighPerformanceAdapter } = await import('./webgpu-support');
    const adapter = await requestHighPerformanceAdapter('OffscreenGPURenderer');

    if (!adapter) {
      console.error('[OffscreenGPURenderer] No WebGPU adapter found.');
      return false;
    }

    this.device = await adapter.requestDevice();
    this.device.lost.then((info) => {
      console.error('[OffscreenGPURenderer] Device lost:', info.message);
    });

    this.format = 'rgba8unorm'; // Consistent byte order for readback

    // Set up render target
    this.renderTarget = this.device.createTexture({
      size: [this.width, this.height, 1],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    this.renderTargetView = this.renderTarget.createView();

    // Intermediate texture for background (used when RenderGraph effects are active)
    this.bgIntermediateTexture = this.device.createTexture({
      size: [this.width, this.height, 1],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    this.bgIntermediateView = this.bgIntermediateTexture.createView();

    // Owned texture the game-scene Canvas2D frame is copied into before it is
    // alpha-blended over the background. The scene composites ON TOP of the
    // background rather than replacing it (parity with the live renderer).
    this._gameSceneTexture = this.device.createTexture({
      label: 'game-scene-frame',
      size: [this.width, this.height, 1],
      format: this.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Prepare readback buffers
    this.bytesPerRow = alignTo256(this.width * 4);
    this.bufferSize = this.bytesPerRow * this.height;

    for (let i = 0; i < this.MAX_PENDING_BUFFERS; i++) {
      this.readbackBuffers.push(
        this.device.createBuffer({
          size: this.bufferSize,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    // Initialize texture loader
    this.textureLoader = new TextureLoader(this.device);
    this.placeholderTexture = this.textureLoader.createPlaceholder(0, 0, 0, 255);

    // Build pipeline
    const ok = await this._buildPipeline();
    if (!ok) return false;

    // Detect requestVideoFrameCallback support
    this._supportsRVFC =
      typeof HTMLVideoElement !== 'undefined' &&
      'requestVideoFrameCallback' in HTMLVideoElement.prototype;

    this._initialized = true;
    console.log(
      `[OffscreenGPURenderer] Initialized. ${this.width}x${this.height}, ` +
        `bytesPerRow: ${this.bytesPerRow}, bufferSize: ${this.bufferSize}, ` +
        `RVFC: ${this._supportsRVFC ? 'yes' : 'no (fallback)'}`,
    );
    return true;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /** Wait for all submitted GPU work to complete. */
  async waitForGPU(): Promise<void> {
    if (!this._initialized) return;
    await this.device.queue.onSubmittedWorkDone();
  }

  /** Get the GPU device (needed for RenderGraph effect pass registration). */
  getDevice(): GPUDevice | null {
    return this._initialized ? this.device : null;
  }

  /** Get the texture format. */
  getFormat(): GPUTextureFormat {
    return this.format;
  }

  /**
   * Get or create the RenderGraph for post-processing effects.
   * The graph is lazily created and initialized on first access.
   */
  async getRenderGraph(): Promise<RenderGraph> {
    if (this._renderGraph) return this._renderGraph;
    this._renderGraph = new RenderGraph(this.device, this.format);
    await this._renderGraph.init(this.width, this.height);
    console.log('[OffscreenGPURenderer] RenderGraph initialized for export.');
    return this._renderGraph;
  }

  /** Get the existing render graph (non-async, returns null if not created). */
  getRenderGraphSync(): RenderGraph | null {
    return this._renderGraph;
  }

  // -------------------------------------------------------------------
  // Secondary background image overlay (bgImageOverlay effect)
  // -------------------------------------------------------------------

  /** Lazily create (once) the shared sampler for the overlay texture. */
  private _getOverlaySampler(): GPUSampler {
    if (!this._overlaySampler) {
      this._overlaySampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
    }
    return this._overlaySampler;
  }

  /**
   * Build the extra-binding entries (texture @3 + sampler @4) from the given
   * texture view. Reuses a cached array shape to avoid per-frame allocation
   * when the view is unchanged.
   */
  private _setOverlayBindings(view: GPUTextureView): void {
    this._overlayBindings = [
      { binding: 3, resource: view },
      { binding: 4, resource: this._getOverlaySampler() },
    ];
    this._renderGraph?.setPassExtraBindings(BG_IMAGE_OVERLAY_PASS_ID, this._overlayBindings);
  }

  /**
   * Idempotent per-frame guard: if the overlay pass is registered, make sure a
   * texture+sampler is bound at 3/4 (otherwise the pass's frame bind group is
   * invalid). Called from BOTH submission paths. Attaches a placeholder if no
   * decode has happened yet. No allocation on the steady-state path — the
   * cached bindings array is reused; only builds when nothing is bound yet.
   */
  private _ensureOverlayBindings(): void {
    if (!this._renderGraph || !this._renderGraph.hasPass(BG_IMAGE_OVERLAY_PASS_ID)) return;
    if (this._overlayBindings) {
      // Re-assert the cached bindings (cheap; guards against a pass that was
      // (re)registered after our last attach, which would drop extraBindings).
      this._renderGraph.setPassExtraBindings(BG_IMAGE_OVERLAY_PASS_ID, this._overlayBindings);
      return;
    }
    // Nothing bound yet — attach a 1x1 placeholder so the layout is satisfied.
    this._setOverlayBindings(this.placeholderTexture.texture.createView());
  }

  /**
   * Ensure the secondary background-image overlay is ready for export.
   *
   * Called by the export bridge/orchestrator BEFORE the first frame is
   * rendered. If an enabled `bgImageOverlay` instance exists, this:
   *   1. attaches a 1x1 placeholder texture+sampler at 3/4 immediately (so the
   *      pass's bind group is valid even if the decode fails/times out), then
   *   2. resolves the image headlessly from the persisted `imageAssetId`
   *      (NOT a live blob URL), decodes it via the TextureLoader, and swaps in
   *      the real texture view + publishes {ready,w,h} via setOverlayImageMeta.
   *
   * A dead/missing asset can't hang the export: the decode races a ~10s
   * timeout; on timeout we proceed with the placeholder (hasImage stays 0).
   *
   * Safe to call when no overlay instance exists / on the software renderer.
   */
  async ensureBgImageOverlayReady(effectsConfig: EffectsConfig | undefined): Promise<boolean> {
    if (!this._renderGraph) return false;

    const inst = effectsConfig?.effectInstances?.find(
      (i) => i.type === 'bgImageOverlay' && i.config?.enabled,
    );
    if (!inst) return false;

    const cfg = inst.config as { imageAssetId?: string };
    const assetId = cfg.imageAssetId;
    this._overlayImageAssetId = assetId ?? null;

    // Always bind a valid texture+sampler first so the pass never has a broken
    // bind group, even before (or without) a real image.
    this._ensureOverlayBindings();

    if (!assetId) {
      // Layer enabled but no image chosen — placeholder stays, hasImage = 0.
      setOverlayImageMeta(assetId ?? '', null);
      return false;
    }

    // Resolve + decode the persisted asset, guarded by a timeout so a dead
    // asset can't wedge the headless export.
    const TIMEOUT_MS = 10000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS);
    });

    const decode = (async (): Promise<LoadedTexture | null> => {
      const blob = await loadEffectImageBlob(assetId);
      if (!blob) return null;
      return this.textureLoader.loadFromBlob(blob, `effectImage:${assetId}`);
    })();

    let loaded: LoadedTexture | null = null;
    try {
      const result = await Promise.race([decode, timeout]);
      if (result === 'timeout') {
        console.warn(
          `[OffscreenGPURenderer] bgImageOverlay decode timed out (${TIMEOUT_MS}ms) for asset ${assetId} — exporting with placeholder (no overlay image).`,
        );
      } else {
        loaded = result;
      }
    } catch (e) {
      console.warn('[OffscreenGPURenderer] bgImageOverlay decode failed:', e);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (loaded) {
      this._overlayImageTexture = loaded;
      this._setOverlayBindings(loaded.texture.createView());
      setOverlayImageMeta(assetId, { ready: true, width: loaded.width, height: loaded.height });
      console.log(
        `[OffscreenGPURenderer] bgImageOverlay image ready (${loaded.width}x${loaded.height}) for asset ${assetId}.`,
      );
      return true;
    }

    // Decode failed/timed out — keep the placeholder bound, hasImage = 0.
    setOverlayImageMeta(assetId, { ready: false, width: 1, height: 1 });
    return false;
  }

  // -------------------------------------------------------------------
  // Background texture
  // -------------------------------------------------------------------

  // Video seeking state — tracks whether RVFC is available at runtime
  private _supportsRVFC = false;
  private _lastSeekedVideoTime = -1;
  private _lastSeekedVideoTime2 = -1;
  private _failedBgUrls = new Set<string>();
  private _lastBgUrl1: string | null = null;
  private _lastBgUrl2: string | null = null;

  setBgMixRatio(ratio: number): void {
    if (this._bgMixRatio !== ratio) {
      this._bgMixRatio = ratio;
      this._bgBindGroupDirty = true;
      if (this._transitionState.active) {
        this._transitionState.active = false;
      }
    }
  }

  setBgTransitionState(opts: {
    opacity1: number;
    scale1: number;
    offsetX1: number;
    offsetY1: number;
    opacity2: number;
    scale2: number;
    offsetX2: number;
    offsetY2: number;
    blendMode: number;
  }): void {
    this._transitionState = { ...opts, active: true };
    this._bgBindGroupDirty = true;
  }

  /**
   * Promote slot 2's texture into slot 1 and clear slot 2.
   * This is a SYNCHRONOUS operation — no fetch, no decode.
   * Used when a crossfade transition completes and the "next" image
   * should become the "current" image without any async gap.
   */
  promoteSlot2ToSlot1(): void {
    if (this._bgTexture2) {
      this._bgTexture1 = this._bgTexture2;
      this._bgTexture2 = null;
      this._lastBgUrl1 = this._lastBgUrl2;
      this._lastBgUrl2 = null;
      this._backgroundVideo = this._backgroundVideo2;
      this._backgroundVideo2 = null;
      this._lastSeekedVideoTime = this._lastSeekedVideoTime2;
      this._lastSeekedVideoTime2 = -1;
      this._bgBindGroupDirty = true;
    }
  }

  async setBackgroundFromUrl(url: string | null, targetIndex: 1 | 2 = 1): Promise<boolean> {
    if (!this._initialized) return false;

    const lastUrl = targetIndex === 1 ? this._lastBgUrl1 : this._lastBgUrl2;
    if (url === lastUrl) return true;

    if (url === null || url === '') {
      if (targetIndex === 1) {
        this._bgTexture1 = null;
        this._backgroundVideo = null;
        this._lastBgUrl1 = null;
        this._lastSeekedVideoTime = -1;
      } else {
        this._bgTexture2 = null;
        this._backgroundVideo2 = null;
        this._lastBgUrl2 = null;
        this._lastSeekedVideoTime2 = -1;
      }
      this._bgBindGroupDirty = true;
      return true;
    }

    if (this._failedBgUrls.has(url)) return false;

    let urlIsVideo = isVideoUrl(url);
    if (!urlIsVideo && url.startsWith('blob:')) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        if (blob.type.startsWith('video/')) {
          urlIsVideo = true;
        } else if (blob.type === '' || blob.type === 'application/octet-stream') {
          // Blob URLs often have empty or generic MIME — probe magic bytes
          const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
          if (hasVideoMagicBytes(header)) urlIsVideo = true;
        }
      } catch {
        this._failedBgUrls.add(url);
        return false;
      }
    }

    let loadedVideo: LoadedVideoTexture | null = null;
    let loadedImage: LoadedTexture | null = null;

    if (urlIsVideo) {
      try {
        const loaded = await this.textureLoader.loadVideoFromUrl(url);
        if (loaded) {
          loadedVideo = loaded;
          loaded.video.pause();
        }
      } catch {}
    }

    if (!loadedVideo) {
      loadedImage = await this.textureLoader.loadFromUrl(url);
      if (!loadedImage) {
        this._failedBgUrls.add(url);
        return false;
      }
    }

    if (targetIndex === 1) {
      this._bgTexture1 = loadedVideo || loadedImage;
      this._backgroundVideo = loadedVideo;
      this._lastBgUrl1 = url;
      this._lastSeekedVideoTime = -1;
    } else {
      this._bgTexture2 = loadedVideo || loadedImage;
      this._backgroundVideo2 = loadedVideo;
      this._lastBgUrl2 = url;
      this._lastSeekedVideoTime2 = -1;
    }

    this._bgBindGroupDirty = true;
    return true;
  }

  async seekVideoToTime(time: number, targetIndex: 1 | 2 = 1): Promise<void> {
    const vt = targetIndex === 1 ? this._backgroundVideo : this._backgroundVideo2;
    if (!vt || !vt.video) return;

    const video = vt.video;
    const duration = video.duration || 1;
    if (!isFinite(duration)) return;
    const targetTime = time % duration;

    const lastSeeked = targetIndex === 1 ? this._lastSeekedVideoTime : this._lastSeekedVideoTime2;
    const frameTolerance = 1 / 60;
    const delta = Math.abs(video.currentTime - targetTime);

    if (delta < frameTolerance && lastSeeked >= 0) {
      this.textureLoader.updateVideoFrame(vt);
      return;
    }

    if (this._supportsRVFC && !video.paused) {
      await this._seekWithRVFC(video, targetTime);
    } else {
      await this._seekWithPolling(video, targetTime);
    }

    this.textureLoader.updateVideoFrame(vt);
    if (targetIndex === 1) {
      this._lastSeekedVideoTime = targetTime;
    } else {
      this._lastSeekedVideoTime2 = targetTime;
    }
  }

  clearBackgroundTexture(): void {
    this._bgTexture1 = null;
    this._bgTexture2 = null;
    this._backgroundVideo = null;
    this._backgroundVideo2 = null;
    this._bgMixRatio = 0.0;
    this._lastBgUrl1 = null;
    this._lastBgUrl2 = null;
    this._lastSeekedVideoTime = -1;
    this._lastSeekedVideoTime2 = -1;
    this._bgBindGroupDirty = true;
    this._failedBgUrls.clear();
  }

  setBackgroundFromBitmap(bitmap: ImageBitmap, targetIndex: 1 | 2 = 1): void {
    if (!this._initialized || bitmap.width === 0 || bitmap.height === 0) return;

    const existing = targetIndex === 1 ? this._bgTexture1 : this._bgTexture2;
    let targetTex = existing;

    if (
      !targetTex ||
      targetTex.width !== bitmap.width ||
      targetTex.height !== bitmap.height ||
      'video' in targetTex
    ) {
      if (existing && !('video' in existing)) existing.texture.destroy();

      const texture = this.device.createTexture({
        label: 'export-bg-bitmap-' + targetIndex,
        size: { width: bitmap.width, height: bitmap.height },
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      targetTex = { texture, width: bitmap.width, height: bitmap.height };
      if (targetIndex === 1) {
        this._bgTexture1 = targetTex;
      } else {
        this._bgTexture2 = targetTex;
      }
    }

    try {
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: targetTex.texture },
        { width: bitmap.width, height: bitmap.height },
      );
    } catch (e) {
      console.warn(
        `[OffscreenGPURenderer] setBackgroundFromBitmap failed for slot ${targetIndex} ` +
          `(bitmap ${bitmap.width}x${bitmap.height}):`,
        e instanceof Error ? e.message : e,
      );
      return;
    }

    this._bgBindGroupDirty = true;
    if (targetIndex === 1) {
      this._backgroundVideo = null;
      this._lastSeekedVideoTime = -1;
    } else {
      this._backgroundVideo2 = null;
      this._lastSeekedVideoTime2 = -1;
    }
  }

  // -------------------------------------------------------------------
  // Lyric Overlay
  // -------------------------------------------------------------------

  /**
   * Set the lyric overlay bitmap for the next rendered frame.
   * Pass null to render without lyrics.
   */
  setLyricBitmap(bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null): void {
    // Close any pending bitmap that was never rendered
    if (this._pendingLyricBitmap && 'close' in this._pendingLyricBitmap) {
      this._pendingLyricBitmap.close();
    }
    this._pendingLyricBitmap = bitmap;
  }

  /**
   * Set the compositing layer split for export frames (parity with the live
   * WebGPURenderer). Pass null for legacy behavior (lyrics composite last).
   */
  setLayerOrder(split: { below: string[]; above: string[]; anyAbove: boolean } | null): void {
    this._layerPassSplit = split;
  }

  /**
   * Layer-ordered lyric interleave for the effects path (parity with the live
   * WebGPURenderer). When the user placed lyrics below one or more effects,
   * re-run the effect chain as below→lyrics→above so the above-lyrics passes
   * distort the lyrics, and consume the pending bitmap. Returns true if it
   * handled (and consumed) the lyric bitmap, so the caller skips the trailing
   * legacy composite. No-op (returns false) when there's no split, no
   * above-lyrics effect, or no pending bitmap.
   *
   * NOTE: the caller has already run the full execute() before this; when this
   * fires, the split re-composites the correct result onto renderTarget.
   */
  private _maybeInterleaveLyrics(
    effectParams: EffectPassParams,
    encoder: GPUCommandEncoder,
  ): boolean {
    const split = this._layerPassSplit;
    if (
      !split?.anyAbove ||
      (!this._pendingLyricBitmap && !this._lyricFXActive) ||
      !this._renderGraph
    )
      return false;

    if (split.below.length > 0) {
      this._renderGraph.executeSubset(
        split.below,
        this.bgIntermediateView,
        this.bgIntermediateView,
        effectParams,
        encoder,
      );
    }
    if (!this._lyricCompositePass) {
      this._lyricCompositePass = new LyricCompositePass(this.device, this.format);
    }
    if (this._tryCompositeLyricFX(this.bgIntermediateView, this.bgIntermediateView, encoder)) {
      // handled by GPU Lyric FX
    } else if (
      this._pendingLyricBitmap &&
      this._lyricCompositePass.uploadBitmap(this._pendingLyricBitmap)
    ) {
      this._lyricCompositePass.execute(this.bgIntermediateView, encoder);
    }
    this._renderGraph.executeSubset(
      split.above,
      this.bgIntermediateView,
      this.renderTargetView,
      effectParams,
      encoder,
    );
    if (this._pendingLyricBitmap && 'close' in this._pendingLyricBitmap) {
      this._pendingLyricBitmap.close();
    }
    this._pendingLyricBitmap = null;
    return true;
  }

  /** Update the glow intensity of the lyric overlay. */
  updateLyricGlow(intensity: number): void {
    if (!this._lyricCompositePass) {
      this._lyricCompositePass = new LyricCompositePass(
        this.device,
        this.format as GPUTextureFormat,
      );
    }
    this._lyricCompositePass.updateGlow(intensity);
  }

  /** Supply (or clear) the GPU Lyric FX chain (mirror of WebGPURenderer). */
  setLyricFXGraph(graph: LyricFXGraph | null): void {
    this._lyricFXGraph = graph;
    this._lyricFXActive = graph !== null;
  }

  /** Per-frame Lyric FX inputs: packed glyph instances (optional) + effect stack. */
  updateLyricFX(
    packedGlyphs: Float32Array | null,
    effects: Parameters<LyricFXGraph['setEffects']>[0],
    frame: LyricFXFrameParams,
  ): void {
    if (!this._lyricFXGraph) return;
    if (packedGlyphs) this._lyricFXGraph.setGlyphs(packedGlyphs);
    this._lyricFXGraph.setEffects(effects);
    this._lyricFXFrame = frame;
  }

  /**
   * If GPU lyric mode is active, render the FX graph and alpha-composite its
   * output over `targetView`, using `layerBelowView` for refraction. Returns
   * true when it handled the lyric layer. Inert unless a graph + frame are set.
   */
  private _tryCompositeLyricFX(
    targetView: GPUTextureView,
    layerBelowView: GPUTextureView | null,
    encoder: GPUCommandEncoder,
  ): boolean {
    if (!this._lyricFXActive || !this._lyricFXGraph || !this._lyricFXFrame) return false;
    if (!this._lyricCompositePass) {
      this._lyricCompositePass = new LyricCompositePass(
        this.device,
        this.format as GPUTextureFormat,
      );
    }
    this._lyricFXGraph.resize(this.width, this.height);
    const view = this._lyricFXGraph.render(encoder, this._lyricFXFrame, layerBelowView);
    if (!view) return false;
    this._lyricCompositePass.executeFromView(view, targetView, encoder);
    return true;
  }

  /**
   * Set the shader overlay config for export frames.
   * Pass null to disable. Automatically loads/reloads preset and palette.
   */
  setShaderOverlayConfig(config: ShaderOverlayConfig | null): void {
    // Legacy single-overlay entry point; bridged onto the N-layer path.
    this.syncShaderLayers(config?.enabled ? [{ id: '__legacy_shader_overlay__', config }] : []);
  }

  /**
   * Sync the full set of enabled shader-mode layers to composite (export path),
   * in front-to-back order. Idempotent per layer; prunes removed instances.
   */
  syncShaderLayers(layers: ShaderLayerInput[]): void {
    this._shaderLayers = layers;
    if (layers.length === 0) {
      this._shaderLayerRegistry?.prune(new Set());
      return;
    }
    if (!this._shaderLayerRegistry) {
      this._shaderLayerRegistry = new ShaderLayerRegistry(this.device, this.format);
    }
    const live = new Set<string>();
    for (const layer of layers) {
      live.add(layer.id);
      this._shaderLayerRegistry.sync(layer.id, layer.config);
    }
    this._shaderLayerRegistry.prune(live);
  }

  /**
   * Sync the ordered enabled GLSL guest layers for export (Stage 3a). Pass [] to
   * disable. Uses the same manager type as the preview renderer so preview and
   * export composite identically.
   */
  syncGLSLGuests(layers: GLSLGuestSource[]): void {
    this._glslLayers = layers;
    if (layers.length === 0) {
      this._glslGuestManager?.sync([]);
      return;
    }
    if (!this._glslGuestManager) {
      this._glslGuestManager = new GLSLGuestManager(
        this.device,
        this.format,
        this.width,
        this.height,
      );
    }
    this._glslGuestManager.sync(layers);
  }

  /** Expose the GLSL guest host so the exporter can upload channel textures. */
  getGLSLHost(): import('./glsl/GLSLGuestRenderer').GLSLGuestRenderer | null {
    return this._glslGuestManager?.getHost() ?? null;
  }

  /**
   * Composite every enabled GLSL guest into `view`, deterministically at the
   * current export frame index + media time (no wall clock). Audio is pulled
   * from the store, where the offline AudioAnalyzer has already written this
   * frame's bytes. Signature-light so all four render-path call sites hold.
   */
  private _renderGLSLGuests(
    view: GPUTextureView,
    encoder: GPUCommandEncoder,
    timeSec: number,
    bands?: { bass: number; mid: number; high: number; energy: number },
  ): void {
    if (!this._glslGuestManager?.hasGuests() || this._glslLayers.length === 0) return;
    const dt = Math.max(this._lastDt, 0.001);
    const audio = guestAudioFromStore();
    this._glslGuestManager.uploadAudio(audio.fft, audio.wave);
    this._glslGuestManager.setBackgroundVideo(this._backgroundVideo?.video ?? null);
    // Offline slot resolution: feed the per-frame byte FFT so per-guest routing
    // (custom bands) resolves to real values in export, mirroring shaderFx.
    this._glslGuestManager.setAnalyser(null);
    this._glslGuestManager.setExportSpectrum(audio.fft ?? null, 48000);
    for (const layer of this._glslLayers) {
      this._glslGuestManager.renderAtAndComposite(
        layer.id,
        this._frameCounter,
        timeSec,
        dt,
        null,
        view,
        encoder,
        bands ?? null,
      );
    }
  }

  /**
   * Composite every enabled shader layer into `view`, resolving each layer's
   * audio-router slots first. Shared registry with the preview renderer so slot
   * resolution is identical (parity). Export has no live AnalyserNode, so
   * custom-band sources resolve to 0 while shipped bands + beat work fully.
   * Signature unchanged from the single-overlay version so all call sites hold.
   */
  private _renderShaderOverlay(
    view: GPUTextureView,
    encoder: GPUCommandEncoder,
    bands: { bass: number; mid: number; high: number; energy: number },
  ): void {
    if (!this._shaderLayerRegistry?.hasRenderable() || this._shaderLayers.length === 0) return;
    const overlayDt = Math.max(this._lastDt, 0.001);
    for (const layer of this._shaderLayers) {
      this._shaderLayerRegistry.render(
        layer.id,
        view,
        encoder,
        overlayDt,
        bands,
        [this.width, this.height],
        null, // no live analyser in export → custom bands resolve to 0
      );
    }
  }

  /**
   * Ensure the shader overlay pipeline is compiled and ready for rendering.
   * Awaits preset compilation (which setShaderOverlayConfig fires asynchronously).
   */
  /**
   * Provide the current export frame's byte-frequency spectrum so shader-layer
   * custom bands resolve from real FFT data in export (no live AnalyserNode).
   * The exporter computes this via its AudioAnalyzer each frame.
   */
  setExportSpectrum(byteFreq: Uint8Array | null, sampleRate: number): void {
    this._shaderLayerRegistry?.setExportSpectrum(byteFreq, sampleRate);
  }

  async ensureShaderOverlayReady(): Promise<boolean> {
    if (this._shaderLayers.length === 0) return true;
    if (!this._shaderLayerRegistry) return false;
    return this._shaderLayerRegistry.ensureAllReady();
  }

  // ── Butterchurn (export) ──────────────────────────────────────────

  private _butterchurnRenderer:
    | import('./butterchurn/ButterchurnRenderer').ButterchurnRenderer
    | null = null;
  private _butterchurnConfig: import('@/types/effects/butterchurn').ButterchurnConfig | null = null;
  // Butterchurn composites ON TOP of the background (fixed order:
  // background → butterchurn → shaderFx → …), mirroring the live renderer. Its
  // frame is copied into this owned texture and alpha-blended over the drawn
  // background with the configured opacity — it never replaces the background.
  private _butterchurnTexture: GPUTexture | null = null;
  private _bcCompositePipeline: GPURenderPipeline | null = null;
  private _bcCompositeBindGroupLayout: GPUBindGroupLayout | null = null;
  private _bcCompositeUniformBuffer: GPUBuffer | null = null;
  private _bcCompositeSampler: GPUSampler | null = null;

  /**
   * Configure Butterchurn for export. Lazily creates the renderer.
   * For export, an OfflineAudioContext is expected.
   */
  async setButterchurnConfig(
    config: import('@/types/effects/butterchurn').ButterchurnConfig | null,
    audioContext?: AudioContext | OfflineAudioContext,
    audioNode?: AudioNode,
  ): Promise<void> {
    if (!config?.enabled) {
      if (this._butterchurnRenderer) {
        this._butterchurnRenderer.destroy();
        this._butterchurnRenderer = null;
      }
      this._butterchurnConfig = config;
      return;
    }
    this._butterchurnConfig = config;

    if (!this._butterchurnRenderer && audioContext) {
      const { ButterchurnRenderer } = await import('./butterchurn/ButterchurnRenderer');
      const renderer = new ButterchurnRenderer({
        width: this.width,
        height: this.height,
        audioContext,
        audioNode,
      });
      const ok = await renderer.init();
      if (ok) {
        this._butterchurnRenderer = renderer;
        renderer.setCycleConfig(config.cycleMode, config.cycleInterval);
        // Always start on a concrete preset — the selected one, or (when none is
        // chosen) a random one in 'random' cycle mode / the first one otherwise —
        // never the default blank visualizer.
        renderer.loadInitialPreset(config.presetName, config.cycleMode, 0);
      } else {
        // Release the hidden canvas + WebGL context; export continues without
        // the visualizer rather than failing outright.
        renderer.destroy();
        console.warn('[OffscreenGPURenderer] Butterchurn init failed — exporting without it');
        import('./butterchurn/butterchurnStatus').then((m) => m.notifyButterchurnUnavailable());
      }
    }

    if (this._butterchurnRenderer && config.presetName) {
      if (config.presetName !== this._butterchurnRenderer.getCurrentPreset()) {
        this._butterchurnRenderer.loadPreset(config.presetName, config.blendTime ?? 0);
      }
      this._butterchurnRenderer.setCycleConfig(config.cycleMode, config.cycleInterval);
    }
  }

  /**
   * Render one Butterchurn frame and copy it into the intermediate texture.
   * Called during the export frame loop BEFORE the encoder's render graph.
   * Uses queue.copyExternalImageToTexture which executes before the encoder.
   *
   * @param timeDomain Per-frame time-domain waveform bytes for the frame being
   *   rendered (from AudioAnalyzer). When provided, Butterchurn reacts to this
   *   exact slice instead of a live AnalyserNode — the only way to keep export
   *   audio-reactive in lock-step with the frame, since the AudioContext clock
   *   is decoupled from the frame loop. Falls back to the live analyser path
   *   when omitted (e.g. no audio buffer).
   * @param fps Export framerate (drives cycle timing + Butterchurn elapsedTime).
   */
  renderButterchurnFrame(timeDomain?: Uint8Array, fps = 60): void {
    if (!this._butterchurnRenderer?.ready || !this._butterchurnConfig?.enabled) return;

    if (timeDomain && timeDomain.length > 0) {
      this._butterchurnRenderer.renderWithAudio(timeDomain, fps);
    } else {
      this._butterchurnRenderer.render(fps);
    }

    // Copy the WebGL canvas into butterchurn's OWN texture (created lazily at
    // the butterchurn canvas size — capped at 2048 on the long side, so it may
    // be smaller than the export). It is alpha-composited (and upscaled by the
    // linear sampler) over the drawn background later (never replaces it),
    // mirroring the live renderer's on-top compositing.
    const bcCanvas = this._butterchurnRenderer.getCanvas();
    if (
      !this._butterchurnTexture ||
      this._butterchurnTexture.width !== bcCanvas.width ||
      this._butterchurnTexture.height !== bcCanvas.height
    ) {
      this._butterchurnTexture?.destroy();
      this._butterchurnTexture = this.device.createTexture({
        label: 'export-butterchurn-frame',
        size: [bcCanvas.width, bcCanvas.height],
        format: this.format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    const copyW = Math.min(bcCanvas.width, this._butterchurnTexture.width);
    const copyH = Math.min(bcCanvas.height, this._butterchurnTexture.height);
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: bcCanvas },
        { texture: this._butterchurnTexture, origin: [0, 0, 0] },
        [copyW, copyH],
      );
    } catch {
      // Silently skip if copy fails
    }
  }

  /** Lazily create the butterchurn composite pipeline (opacity as alpha). */
  private _ensureBcCompositePipeline(): void {
    if (this._bcCompositePipeline) return;
    const shaderCode = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var srcSamp: sampler;
      @group(0) @binding(2) var<uniform> opacity: f32;
      struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
      @vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
        var positions = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
        var uvs = array<vec2f, 3>(vec2f(0,1), vec2f(2,1), vec2f(0,-1));
        var o: VSOut; o.pos = vec4f(positions[vi], 0, 1); o.uv = uvs[vi]; return o;
      }
      @fragment fn fs(in: VSOut) -> @location(0) vec4f {
        let color = textureSample(srcTex, srcSamp, in.uv);
        return vec4f(color.rgb, opacity);
      }
    `;
    const shaderModule = this.device.createShaderModule({
      label: 'export-bc-composite',
      code: shaderCode,
    });
    this._bcCompositeBindGroupLayout = this.device.createBindGroupLayout({
      label: 'export-bc-composite-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const pipelineLayout = this.device.createPipelineLayout({
      label: 'export-bc-composite-pl',
      bindGroupLayouts: [this._bcCompositeBindGroupLayout],
    });
    this._bcCompositePipeline = this.device.createRenderPipeline({
      label: 'export-bc-composite-pipeline',
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this._bcCompositeUniformBuffer = this.device.createBuffer({
      label: 'export-bc-composite-opacity',
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._bcCompositeSampler = this.device.createSampler({
      label: 'export-bc-composite-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  /** Alpha-blend the butterchurn texture over the given target view. */
  private _compositeButterchurn(targetView: GPUTextureView, encoder: GPUCommandEncoder): void {
    if (!this._butterchurnTexture) return;
    this._ensureBcCompositePipeline();
    if (!this._bcCompositePipeline || !this._bcCompositeUniformBuffer) return;
    const opacity = Math.max(0, Math.min(1, this._butterchurnConfig?.opacity ?? 1.0));
    this.device.queue.writeBuffer(this._bcCompositeUniformBuffer, 0, new Float32Array([opacity]));
    const bindGroup = this.device.createBindGroup({
      label: 'export-bc-composite-bg',
      layout: this._bcCompositeBindGroupLayout!,
      entries: [
        { binding: 0, resource: this._butterchurnTexture.createView() },
        { binding: 1, resource: this._bcCompositeSampler! },
        { binding: 2, resource: { buffer: this._bcCompositeUniformBuffer } },
      ],
    });
    const pass = encoder.beginRenderPass({
      label: 'export-butterchurn-composite',
      colorAttachments: [{ view: targetView, loadOp: 'load' as const, storeOp: 'store' as const }],
    });
    pass.setPipeline(this._bcCompositePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  // -------------------------------------------------------------------
  // Game Scene (Canvas2D)
  // -------------------------------------------------------------------

  private _gameSceneRenderer: import('./littlejs/LittleJSRenderer').GameSceneRenderer | null = null;
  private _gameSceneConfig: import('./littlejs/types').GameSceneConfig | null = null;
  /**
   * GPU texture the game-scene frame is copied into before it is alpha-blended
   * over the background, plus the composite pipeline that does the blend
   * honouring per-pixel alpha × opacity. Mirrors the live WebGPURenderer.
   */
  private _gameSceneTexture!: GPUTexture;
  private _gsCompositePipeline: GPURenderPipeline | null = null;
  private _gsCompositeBindGroupLayout: GPUBindGroupLayout | null = null;
  private _gsCompositeUniformBuffer: GPUBuffer | null = null;
  private _gsCompositeSampler: GPUSampler | null = null;
  /** Lyrics handed over before the scene renderer finished async init. */
  private _pendingGameSceneLyrics: Array<{ start: number; end: number }> | null = null;
  /** Assets handed over before the scene renderer finished async init. */
  private _pendingGameSceneAssets: {
    left?: string;
    right?: string;
    background?: string;
  } | null = null;
  /** Params handed over before the scene renderer finished async init. */
  private _pendingGameSceneParams: Record<string, number | string | boolean> | null = null;

  /**
   * Forward lyric line timings to the scene so it can do per-line character
   * focus. Cached unconditionally: setGameSceneConfig() is async, so a caller
   * can legitimately reach here before _gameSceneRenderer exists, and dropping
   * the call would strand the scene in permanent wide shot.
   */
  setGameSceneLyrics(lines: Array<{ start: number; end: number }>): void {
    this._pendingGameSceneLyrics = lines;
    this._gameSceneRenderer?.setLyrics(lines);
  }

  /** Forward user-uploaded asset URLs. Cached like lyrics — see above. */
  setGameSceneAssets(urls: { left?: string; right?: string; background?: string }): void {
    this._pendingGameSceneAssets = urls;
    this._gameSceneRenderer?.setAssetUrls(urls);
  }

  /** Forward user-configured scene params. Cached like lyrics — see above. */
  setGameSceneParams(params: Record<string, number | string | boolean>): void {
    this._pendingGameSceneParams = params;
    this._gameSceneRenderer?.setParams(params);
  }

  async setGameSceneConfig(
    config: import('./littlejs/types').GameSceneConfig | null,
  ): Promise<void> {
    if (!config?.enabled) {
      if (this._gameSceneRenderer) {
        this._gameSceneRenderer.destroy();
        this._gameSceneRenderer = null;
      }
      this._gameSceneConfig = config;
      return;
    }
    this._gameSceneConfig = config;

    if (!this._gameSceneRenderer) {
      const { GameSceneRenderer } = await import('./littlejs/LittleJSRenderer');
      const renderer = new GameSceneRenderer({
        width: this.width,
        height: this.height,
      });
      const ok = await renderer.init();
      if (ok) {
        this._gameSceneRenderer = renderer;
        // Offline BEFORE loadScene so the scene is born in export mode and never
        // samples the (idle) live audio store or the encoder's wall clock.
        renderer.setOffline(true);
        if (config.sceneId) {
          await renderer.loadScene(config.sceneId);
        }
        // Scene instance only exists after loadScene — flush everything now.
        if (this._pendingGameSceneLyrics) {
          renderer.setLyrics(this._pendingGameSceneLyrics);
        }
        if (this._pendingGameSceneAssets) {
          renderer.setAssetUrls(this._pendingGameSceneAssets);
        }
        if (this._pendingGameSceneParams) {
          renderer.setParams(this._pendingGameSceneParams);
        }
        // Custom assets replace the defaults and reload asynchronously; wait so
        // the export does not encode sprite-less opening frames.
        await renderer.whenAssetsReady();
        console.log(`[OffscreenGPURenderer] Game scene initialized: "${config.sceneId}"`);
      }
    } else if (config.sceneId && config.sceneId !== this._gameSceneRenderer.getCurrentScene()) {
      // GameSceneRenderer re-applies its stored lyrics/assets/params itself.
      await this._gameSceneRenderer.loadScene(config.sceneId);
    }
  }

  renderGameSceneFrame(
    time: number,
    audioBass: number,
    audioMid: number,
    audioHigh: number,
    audioEnergy: number,
    duration?: number,
  ): void {
    if (!this._gameSceneRenderer?.ready || !this._gameSceneConfig?.enabled) return;

    this._gameSceneRenderer.setAudioData({
      bass: audioBass,
      mid: audioMid,
      treb: audioHigh,
      beat: audioBass > 0.7,
      amplitude: audioEnergy,
      bpm: 120,
      time,
      duration: duration ?? 0,
    });
    this._gameSceneRenderer.render();

    // Copy the Canvas2D output into the OWNED game-scene texture. It is
    // composited over the background later (see _compositeGameScene), so the
    // background shows through the scene's transparent regions instead of being
    // replaced by it.
    const gsCanvas = this._gameSceneRenderer.getCanvas();
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: gsCanvas },
        { texture: this._gameSceneTexture, origin: [0, 0, 0] },
        [this.width, this.height],
      );
    } catch {
      // Silently skip if copy fails
    }
  }

  /**
   * Lazily create the game-scene composite pipeline (alpha-blend the scene
   * texture over a target honouring per-pixel source alpha × opacity).
   */
  private _ensureGsCompositePipeline(): void {
    if (this._gsCompositePipeline) return;

    const shaderCode = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var srcSamp: sampler;
      @group(0) @binding(2) var<uniform> opacity: f32;

      struct VSOut {
        @builtin(position) pos: vec4f,
        @location(0) uv: vec2f,
      }

      @vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
        var positions = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
        var uvs = array<vec2f, 3>(vec2f(0,1), vec2f(2,1), vec2f(0,-1));
        var o: VSOut;
        o.pos = vec4f(positions[vi], 0, 1);
        o.uv = uvs[vi];
        return o;
      }

      @fragment fn fs(in: VSOut) -> @location(0) vec4f {
        let color = textureSample(srcTex, srcSamp, in.uv);
        return vec4f(color.rgb, color.a * opacity);
      }
    `;

    const shaderModule = this.device.createShaderModule({
      label: 'gs-composite-shader',
      code: shaderCode,
    });

    this._gsCompositeBindGroupLayout = this.device.createBindGroupLayout({
      label: 'gs-composite-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'gs-composite-pl',
      bindGroupLayouts: [this._gsCompositeBindGroupLayout],
    });

    this._gsCompositePipeline = this.device.createRenderPipeline({
      label: 'gs-composite-pipeline',
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });

    this._gsCompositeUniformBuffer = this.device.createBuffer({
      label: 'gs-composite-opacity',
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._gsCompositeSampler = this.device.createSampler({
      label: 'gs-composite-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  /** Alpha-blend the game-scene texture over the given target view. */
  private _compositeGameScene(targetView: GPUTextureView, encoder: GPUCommandEncoder): void {
    this._ensureGsCompositePipeline();
    if (!this._gsCompositePipeline || !this._gsCompositeUniformBuffer) return;

    const opacity = this._gameSceneConfig?.opacity ?? 1.0;
    this.device.queue.writeBuffer(
      this._gsCompositeUniformBuffer,
      0,
      new Float32Array([Math.max(0, Math.min(1, opacity))]),
    );

    const bindGroup = this.device.createBindGroup({
      label: 'gs-composite-bg',
      layout: this._gsCompositeBindGroupLayout!,
      entries: [
        { binding: 0, resource: this._gameSceneTexture.createView() },
        { binding: 1, resource: this._gsCompositeSampler! },
        { binding: 2, resource: { buffer: this._gsCompositeUniformBuffer } },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: 'export-game-scene-composite',
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'load' as const,
          storeOp: 'store' as const,
        },
      ],
    });
    pass.setPipeline(this._gsCompositePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  // -------------------------------------------------------------------
  // Render + Readback
  // -------------------------------------------------------------------

  /**
   * Render one frame and return a Promise that resolves to a VideoFrame.
   * Internally uses a pool of readback buffers to allow pipelining calls
   * without waiting for the GPU to finish each frame synchronously.
   */
  private _frameCounter = 0;

  /**
   * Whether the universal background blur pass will run for this frame.
   * True when a positive blur amount is set and the render graph exists (the
   * blur samples the composited bgIntermediateTexture and blits it back). When
   * true, the per-image blur baked into the bg shader is neutralised to avoid
   * double-blurring.
   */
  private _universalBlurWillRun(state: FrameState): boolean {
    return (state.backgroundBlur ?? 0) > 0 && this._renderGraph !== null;
  }

  /**
   * Run the universal background blur on the intermediate texture in place.
   * No-op when blur <= 0. Lazily creates the blur pass.
   */
  private _applyBackgroundBlur(state: FrameState, encoder: GPUCommandEncoder): void {
    if (!this._universalBlurWillRun(state)) return;
    if (!this._bgBlurPass) {
      this._bgBlurPass = new BackgroundBlurPass(this.device, this.format);
    }
    this._bgBlurPass.execute(
      this.bgIntermediateTexture,
      this.bgIntermediateView,
      encoder,
      this.width,
      this.height,
      state.backgroundBlur ?? 0,
      state.backgroundBlurType ?? 1,
    );
  }

  async renderAndReadVideoFrame(
    state: FrameState,
    timestampMicros: number,
    durationMicros: number,
  ): Promise<VideoFrame> {
    if (!this._initialized) throw new Error('Renderer not initialized');
    this._frameCounter++;
    // Determine active buffer slot (double/triple buffering)
    const buffer = this.readbackBuffers[this.currentBufferIndex];
    this.currentBufferIndex = (this.currentBufferIndex + 1) % this.MAX_PENDING_BUFFERS;

    if (this._bgBindGroupDirty) {
      this._rebuildBgBindGroup();
      this._bgBindGroupDirty = false;
    }

    const hasTexture = this._bgTexture1 !== null || this._bgTexture2 !== null ? 1.0 : 0.0;

    const fit = state.backgroundFit || 'cover';
    const cw = this.width;
    const ch = this.height;
    const tw1 = this._bgTexture1?.width || 1;
    const th1 = this._bgTexture1?.height || 1;
    const [sc1X, sc1Y] = computeUVScale(fit, cw, ch, tw1, th1);

    const tw2 = this._bgTexture2?.width || 1;
    const th2 = this._bgTexture2?.height || 1;
    const [sc2X, sc2Y] = computeUVScale(fit, cw, ch, tw2, th2);

    const hasTransition = this._transitionState.active;
    const blendMode = hasTransition ? this._transitionState.blendMode : 1.0; // 1.0 = Crossfade
    const t1Opacity = hasTransition ? this._transitionState.opacity1 : 1.0 - this._bgMixRatio;
    const t1Scale = hasTransition ? this._transitionState.scale1 : 1.0;
    const t1OffsetX = hasTransition ? this._transitionState.offsetX1 : 0.0;
    const t1OffsetY = hasTransition ? this._transitionState.offsetY1 : 0.0;

    // In legacy mode, crossfade only uses slot 2 if mixRatio > 0
    const t2Opacity = hasTransition ? this._transitionState.opacity2 : this._bgMixRatio;
    const t2Scale = hasTransition ? this._transitionState.scale2 : 1.0;
    const t2OffsetX = hasTransition ? this._transitionState.offsetX2 : 0.0;
    const t2OffsetY = hasTransition ? this._transitionState.offsetY2 : 0.0;

    const uniforms = new Float32Array([
      state.backgroundColor[0], // 0
      state.backgroundColor[1], // 1
      state.backgroundColor[2], // 2
      1.0, // 3
      state.backgroundBrightness, // 4
      state.backgroundScale, // 5
      state.backgroundOffsetX, // 6
      state.backgroundOffsetY, // 7
      hasTexture, // 8
      blendMode, // 9
      state.backgroundAngle || 0, // 10
      state.backgroundTiling ? 1.0 : 0.0, // 11
      sc1X, // 12
      sc1Y, // 13
      sc2X, // 14
      sc2Y, // 15
      t1Opacity, // 16
      t1Scale, // 17
      t1OffsetX, // 18
      t1OffsetY, // 19
      t2Opacity, // 20
      t2Scale, // 21
      t2OffsetX, // 22
      t2OffsetY, // 23
      state.backgroundContrast !== undefined ? state.backgroundContrast : 1.0, // 24
      this._universalBlurWillRun(state) ? 0.0 : state.backgroundBlur || 0.0, // 25 (0 when universal blur pass owns it)
      0.0, // 26 (padding)
      0.0, // 27 (padding)
    ]);
    this.device.queue.writeBuffer(this.bgUniformBuffer, 0, uniforms);

    // Keep the bgImageOverlay pass's secondary texture (@3) + sampler (@4)
    // bound so its per-frame bind group stays valid on this (serialized) path.
    this._ensureOverlayBindings();

    // Delta time for effects
    const now = state.time;
    this._lastDt = now - this._lastFrameTime;
    const didReset = state.time === 0 && this._lastFrameTime > 0;
    this._lastFrameTime = now;

    const hasEffects = this._renderGraph?.hasEnabledPasses() ?? false;
    const blurActive = this._universalBlurWillRun(state);
    // External-canvas sources (butterchurn, game scene) render into the
    // intermediate texture before the encoder. They MUST route through the
    // intermediate branch so their pixels are preserved (loadOp:'load' + skip
    // bg draw) and then composited into renderTarget by the render graph — even
    // when no effect/blur pass is enabled. Without this, a butterchurn-only
    // export takes the no-effects branch, which clears renderTarget and draws
    // the (empty) background pipeline, ignoring the intermediate → BLANK export.
    const bcActive = !!(this._butterchurnRenderer?.ready && this._butterchurnConfig?.enabled);
    const gsActive = !!(this._gameSceneRenderer?.ready && this._gameSceneConfig?.enabled);
    const shaderLayersActive = !!(
      this._shaderLayerRegistry?.hasRenderable() && this._shaderLayers.length > 0
    );
    const glslGuestsActive = !!(this._glslGuestManager?.hasGuests() && this._glslLayers.length > 0);
    // Route through the intermediate texture when effects OR blur OR an external
    // canvas source need it.
    const routeToIntermediate =
      hasEffects || blurActive || bcActive || gsActive || shaderLayersActive || glslGuestsActive;

    const encoder = this.device.createCommandEncoder({ label: 'export-frame' });

    if (routeToIntermediate) {
      // ── With effects/blur: background → intermediate → RenderGraph → renderTarget ──

      // Step 1: Render the background into the intermediate. Butterchurn NEVER
      // replaces the background — it composites on top (below), mirroring the
      // live renderer's fixed order: background → butterchurn → shaderFx → …
      const bgPass = encoder.beginRenderPass({
        label: 'export-bg-pass',
        colorAttachments: [
          {
            view: this.bgIntermediateView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      bgPass.setPipeline(this.bgPipeline);
      bgPass.setBindGroup(0, this._bgBindGroup!);
      bgPass.draw(3);
      bgPass.end();

      // Butterchurn composites ON TOP of the background (before shaderFx).
      if (bcActive) {
        this._compositeButterchurn(this.bgIntermediateView, encoder);
      }

      // Shader overlay (between background/butterchurn and effects)
      this._renderShaderOverlay(this.bgIntermediateView, encoder, {
        bass: state.audioBass,
        mid: state.audioMid,
        high: state.audioHigh,
        energy: state.audioEnergy,
      });
      // GLSL guests composite after the shader overlay, at their stack position.
      this._renderGLSLGuests(this.bgIntermediateView, encoder, state.time, {
        bass: state.audioBass ?? 0,
        mid: state.audioMid ?? 0,
        high: state.audioHigh ?? 0,
        energy: state.audioEnergy ?? 0,
      });

      // Composite the game scene ON TOP of the background (image / video /
      // shader) before blur + effects, so the background shows through the
      // scene's transparent regions and post-processing treats the result as one
      // background. Parity with the live WebGPURenderer.
      if (gsActive) {
        this._compositeGameScene(this.bgIntermediateView, encoder);
      }

      // Universal background blur on the composited intermediate (before effects).
      this._applyBackgroundBlur(state, encoder);

      // Step 2: Execute RenderGraph (chains effect passes, writes to renderTarget).
      // When no passes are enabled (blur-only), this passthrough-composites the
      // blurred intermediate into renderTarget.
      const effectParams: EffectPassParams = {
        time: state.time,
        dt: Math.max(this._lastDt, 0.001),
        resolution: [this.width, this.height],
        audioBass: state.audioBass,
        audioMid: state.audioMid,
        audioHigh: state.audioHigh,
        audioEnergy: state.audioEnergy,
        didReset,
      };

      this._renderGraph!.execute(
        this.bgIntermediateView,
        this.renderTargetView,
        effectParams,
        encoder,
      );

      // Reposition lyrics below above-lyrics effects when the layer order asks.
      this._maybeInterleaveLyrics(effectParams, encoder);
    } else {
      // ── No effects: background renders directly to renderTarget ──
      const gsActiveNoFx = !!(this._gameSceneRenderer?.ready && this._gameSceneConfig?.enabled);

      // Draw the background into renderTarget first, then composite the game
      // scene over it. Previously the scene was copied straight to renderTarget
      // (replacing the background); now it sits on top and lets the background
      // show through its transparent regions.
      const bgPass = encoder.beginRenderPass({
        label: 'export-bg-pass',
        colorAttachments: [
          {
            view: this.renderTargetView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      bgPass.setPipeline(this.bgPipeline);
      bgPass.setBindGroup(0, this._bgBindGroup!);
      bgPass.draw(3);
      bgPass.end();

      if (gsActiveNoFx) {
        this._compositeGameScene(this.renderTargetView, encoder);
      }

      // Shader overlay (between background and effects — no effects path)
      this._renderShaderOverlay(this.renderTargetView, encoder, {
        bass: state.audioBass,
        mid: state.audioMid,
        high: state.audioHigh,
        energy: state.audioEnergy,
      });
      // GLSL guests composite after the shader overlay, at their stack position.
      this._renderGLSLGuests(this.renderTargetView, encoder, state.time, {
        bass: state.audioBass ?? 0,
        mid: state.audioMid ?? 0,
        high: state.audioHigh ?? 0,
        energy: state.audioEnergy ?? 0,
      });
    }

    // Lyric composite pass — alpha-blend lyric over the render target. Prefer
    // the GPU Lyric FX chain when active; else the Canvas2D bitmap.
    if (this._lyricFXActive || this._pendingLyricBitmap) {
      if (!this._lyricCompositePass) {
        this._lyricCompositePass = new LyricCompositePass(this.device, this.format);
      }
      if (this._tryCompositeLyricFX(this.renderTargetView, null, encoder)) {
        // handled by GPU Lyric FX
      } else if (this._pendingLyricBitmap) {
        const uploadOk = this._lyricCompositePass.uploadBitmap(this._pendingLyricBitmap);
        if (uploadOk) {
          this._lyricCompositePass.execute(this.renderTargetView, encoder);
        }
      }

      if (this._pendingLyricBitmap && 'close' in this._pendingLyricBitmap) {
        this._pendingLyricBitmap.close();
      }
      this._pendingLyricBitmap = null;
    }

    // Copy render target → readback buffer
    encoder.copyTextureToBuffer(
      { texture: this.renderTarget },
      { buffer: buffer, bytesPerRow: this.bytesPerRow },
      { width: this.width, height: this.height },
    );

    this.device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);

    const mapped = buffer.getMappedRange();
    const pixelBytesPerRow = this.width * 4;

    // Build the data to pass to VideoFrame.
    // At 1920×1080, bytesPerRow (7680) == pixelBytesPerRow, so no stripping needed.
    let frameData: BufferSource;
    if (this.bytesPerRow === pixelBytesPerRow) {
      // Fast path: aligned — create a typed view directly, VideoFrame copies it.
      frameData = new Uint8Array(mapped);
    } else {
      // Slow path: bytesPerRow has padding, strip it row by row
      const stripped = new Uint8Array(pixelBytesPerRow * this.height);
      const src = new Uint8Array(mapped);
      for (let y = 0; y < this.height; y++) {
        stripped.set(
          src.subarray(y * this.bytesPerRow, y * this.bytesPerRow + pixelBytesPerRow),
          y * pixelBytesPerRow,
        );
      }
      frameData = stripped;
    }

    const videoFrame = new VideoFrame(frameData, {
      format: 'RGBA',
      codedWidth: this.width,
      codedHeight: this.height,
      timestamp: Math.round(timestampMicros),
      duration: Math.round(durationMicros),
    });

    // Cache stripped pixel data for zero-GPU snapshot generation (only every N frames).
    // Must copy (slice) since the fast-path frameData is a view into the mapped GPU buffer
    // which becomes invalid after unmap().
    if (this._frameCounter % 72 === 0) {
      const src =
        frameData instanceof Uint8Array
          ? frameData
          : new Uint8Array(frameData as unknown as ArrayBuffer);
      this._lastFramePixels = src.slice(0);
    }

    buffer.unmap();

    return videoFrame;
  }

  // ── Pipelined readback ───────────────────────────────────────────────
  // submitFrame() records GPU commands + copy-to-buffer and submits
  // WITHOUT blocking on mapAsync. readSubmittedFrame() awaits mapAsync
  // on a previously submitted buffer.  This lets the GPU work on frame N
  // while the CPU reads frame N-2's result.
  //
  // Pipeline depth = MAX_PENDING_BUFFERS - 1 = 2 frames of latency.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Submit GPU rendering for one frame. Returns the readback buffer index
   * that will hold the result once the GPU finishes.
   * Does NOT block — call readSubmittedFrame() later to get the pixels.
   */
  submitFrame(state: FrameState): number {
    if (!this._initialized) throw new Error('Renderer not initialized');
    this._frameCounter++;

    const bufferIndex = this.currentBufferIndex;
    const buffer = this.readbackBuffers[bufferIndex];
    this.currentBufferIndex = (this.currentBufferIndex + 1) % this.MAX_PENDING_BUFFERS;

    if (this._bgBindGroupDirty) {
      this._rebuildBgBindGroup();
      this._bgBindGroupDirty = false;
    }

    const hasTexture = this._bgTexture1 !== null || this._bgTexture2 !== null ? 1.0 : 0.0;

    const fit = state.backgroundFit || 'cover';
    const cw = this.width;
    const ch = this.height;
    const tw1 = this._bgTexture1?.width || 1;
    const th1 = this._bgTexture1?.height || 1;
    const [sc1X, sc1Y] = computeUVScale(fit, cw, ch, tw1, th1);

    const tw2 = this._bgTexture2?.width || 1;
    const th2 = this._bgTexture2?.height || 1;
    const [sc2X, sc2Y] = computeUVScale(fit, cw, ch, tw2, th2);

    const hasTransition = this._transitionState.active;
    const blendMode = hasTransition ? this._transitionState.blendMode : 1.0;
    const t1Opacity = hasTransition ? this._transitionState.opacity1 : 1.0 - this._bgMixRatio;
    const t1Scale = hasTransition ? this._transitionState.scale1 : 1.0;
    const t1OffsetX = hasTransition ? this._transitionState.offsetX1 : 0.0;
    const t1OffsetY = hasTransition ? this._transitionState.offsetY1 : 0.0;
    const t2Opacity = hasTransition ? this._transitionState.opacity2 : this._bgMixRatio;
    const t2Scale = hasTransition ? this._transitionState.scale2 : 1.0;
    const t2OffsetX = hasTransition ? this._transitionState.offsetX2 : 0.0;
    const t2OffsetY = hasTransition ? this._transitionState.offsetY2 : 0.0;

    const uniforms = new Float32Array([
      state.backgroundColor[0],
      state.backgroundColor[1],
      state.backgroundColor[2],
      1.0,
      state.backgroundBrightness,
      state.backgroundScale,
      state.backgroundOffsetX,
      state.backgroundOffsetY,
      hasTexture,
      blendMode,
      state.backgroundAngle || 0,
      state.backgroundTiling ? 1.0 : 0.0,
      sc1X,
      sc1Y,
      sc2X,
      sc2Y,
      t1Opacity,
      t1Scale,
      t1OffsetX,
      t1OffsetY,
      t2Opacity,
      t2Scale,
      t2OffsetX,
      t2OffsetY,
      state.backgroundContrast !== undefined ? state.backgroundContrast : 1.0,
      this._universalBlurWillRun(state) ? 0.0 : state.backgroundBlur || 0.0,
      0.0,
      0.0,
    ]);
    this.device.queue.writeBuffer(this.bgUniformBuffer, 0, uniforms);

    // Keep the bgImageOverlay pass's secondary texture (@3) + sampler (@4)
    // bound so its per-frame bind group stays valid on this (pipelined) path.
    this._ensureOverlayBindings();

    const now = state.time;
    this._lastDt = now - this._lastFrameTime;
    this._lastFrameTime = now;

    const hasEffects = this._renderGraph?.hasEnabledPasses() ?? false;
    const blurActive = this._universalBlurWillRun(state);
    // External-canvas sources (butterchurn, game scene) pre-write the
    // intermediate texture, so they MUST route through the intermediate branch
    // (loadOp:'load' + skip bg draw + render-graph passthrough into
    // renderTarget) even with no effect/blur pass. Otherwise a butterchurn-only
    // export falls into the no-effects branch, which clears renderTarget and
    // draws the empty background pipeline — a BLANK export. This is the
    // pipelined path the export loop actually uses.
    const bcActive = !!(this._butterchurnRenderer?.ready && this._butterchurnConfig?.enabled);
    const gsActive = !!(this._gameSceneRenderer?.ready && this._gameSceneConfig?.enabled);
    const shaderLayersActive = !!(
      this._shaderLayerRegistry?.hasRenderable() && this._shaderLayers.length > 0
    );
    const glslGuestsActive = !!(this._glslGuestManager?.hasGuests() && this._glslLayers.length > 0);
    const routeToIntermediate =
      hasEffects || blurActive || bcActive || gsActive || shaderLayersActive || glslGuestsActive;
    const encoder = this.device.createCommandEncoder({ label: 'export-frame-pipeline' });

    if (routeToIntermediate) {
      // Draw the background into the intermediate. Butterchurn and the game
      // scene both composite ON TOP of the drawn background (they never replace
      // it), mirroring the live renderer's fixed order:
      //   background → butterchurn → shaderFx → game scene → blur → effects.
      // NOTE: butterchurn's frame lives in its OWN texture (_butterchurnTexture,
      // written by renderButterchurnFrame → copyExternalImageToTexture); it is
      // NOT pre-written into bgIntermediateTexture. It must therefore be
      // alpha-composited here via _compositeButterchurn, exactly like the
      // serialized renderAndReadVideoFrame path. Skipping that composite (the
      // prior loadOp:'load' + skip-draw approach) left the intermediate empty
      // and produced a BLANK butterchurn export on this pipelined path.
      const bgPass = encoder.beginRenderPass({
        label: 'export-bg-pass',
        colorAttachments: [
          {
            view: this.bgIntermediateView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear' as const,
            storeOp: 'store' as const,
          },
        ],
      });
      bgPass.setPipeline(this.bgPipeline);
      bgPass.setBindGroup(0, this._bgBindGroup!);
      bgPass.draw(3);
      bgPass.end();

      // Butterchurn composites ON TOP of the background (before shaderFx).
      if (bcActive) {
        this._compositeButterchurn(this.bgIntermediateView, encoder);
      }

      // Shader overlay (between background/butterchurn and effects)
      this._renderShaderOverlay(this.bgIntermediateView, encoder, {
        bass: state.audioBass,
        mid: state.audioMid,
        high: state.audioHigh,
        energy: state.audioEnergy,
      });
      // GLSL guests composite after the shader overlay, at their stack position.
      this._renderGLSLGuests(this.bgIntermediateView, encoder, state.time, {
        bass: state.audioBass ?? 0,
        mid: state.audioMid ?? 0,
        high: state.audioHigh ?? 0,
        energy: state.audioEnergy ?? 0,
      });

      // Composite the game scene ON TOP of the background before blur + effects.
      if (gsActive) {
        this._compositeGameScene(this.bgIntermediateView, encoder);
      }

      // Universal background blur on the composited intermediate (before effects).
      this._applyBackgroundBlur(state, encoder);

      const effectParams: EffectPassParams = {
        time: state.time,
        dt: Math.max(this._lastDt, 0.001),
        resolution: [this.width, this.height],
        audioBass: state.audioBass,
        audioMid: state.audioMid,
        audioHigh: state.audioHigh,
        audioEnergy: state.audioEnergy,
        didReset: state.time === 0 && this._lastFrameTime > 0,
      };

      this._renderGraph!.execute(
        this.bgIntermediateView,
        this.renderTargetView,
        effectParams,
        encoder,
      );

      // Reposition lyrics below above-lyrics effects when the layer order asks.
      this._maybeInterleaveLyrics(effectParams, encoder);
    } else {
      // No effects: the render graph never runs. Draw the background into
      // renderTarget, then composite the game scene on top so the background
      // shows through the scene's transparent regions.
      const gsActiveNoFx = !!(this._gameSceneRenderer?.ready && this._gameSceneConfig?.enabled);

      const bgPass = encoder.beginRenderPass({
        label: 'export-bg-pass',
        colorAttachments: [
          {
            view: this.renderTargetView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear' as const,
            storeOp: 'store' as const,
          },
        ],
      });
      bgPass.setPipeline(this.bgPipeline);
      bgPass.setBindGroup(0, this._bgBindGroup!);
      bgPass.draw(3);
      bgPass.end();

      if (gsActiveNoFx) {
        this._compositeGameScene(this.renderTargetView, encoder);
      }

      // Shader overlay (no effects path)
      this._renderShaderOverlay(this.renderTargetView, encoder, {
        bass: state.audioBass,
        mid: state.audioMid,
        high: state.audioHigh,
        energy: state.audioEnergy,
      });
      // GLSL guests composite after the shader overlay, at their stack position.
      this._renderGLSLGuests(this.renderTargetView, encoder, state.time, {
        bass: state.audioBass ?? 0,
        mid: state.audioMid ?? 0,
        high: state.audioHigh ?? 0,
        energy: state.audioEnergy ?? 0,
      });
    }

    // Lyric composite
    if (this._pendingLyricBitmap) {
      if (!this._lyricCompositePass) {
        this._lyricCompositePass = new LyricCompositePass(this.device, this.format);
      }
      const uploadOk = this._lyricCompositePass.uploadBitmap(this._pendingLyricBitmap);
      if (uploadOk) {
        this._lyricCompositePass.execute(this.renderTargetView, encoder);
      }
      if ('close' in this._pendingLyricBitmap) {
        this._pendingLyricBitmap.close();
      }
      this._pendingLyricBitmap = null;
    }

    // Copy render target → readback buffer
    encoder.copyTextureToBuffer(
      { texture: this.renderTarget },
      { buffer, bytesPerRow: this.bytesPerRow },
      { width: this.width, height: this.height },
    );

    this.device.queue.submit([encoder.finish()]);

    return bufferIndex;
  }

  /**
   * Read back a previously submitted frame's readback buffer.
   * Awaits mapAsync (blocks until GPU finishes that buffer's work).
   */
  async readSubmittedFrame(
    bufferIndex: number,
    timestampMicros: number,
    durationMicros: number,
  ): Promise<VideoFrame> {
    const buffer = this.readbackBuffers[bufferIndex];
    await buffer.mapAsync(GPUMapMode.READ);

    const mapped = buffer.getMappedRange();
    const pixelBytesPerRow = this.width * 4;

    let frameData: BufferSource;
    if (this.bytesPerRow === pixelBytesPerRow) {
      frameData = new Uint8Array(mapped);
    } else {
      const stripped = new Uint8Array(pixelBytesPerRow * this.height);
      const src = new Uint8Array(mapped);
      for (let y = 0; y < this.height; y++) {
        stripped.set(
          src.subarray(y * this.bytesPerRow, y * this.bytesPerRow + pixelBytesPerRow),
          y * pixelBytesPerRow,
        );
      }
      frameData = stripped;
    }

    const videoFrame = new VideoFrame(frameData, {
      format: 'RGBA',
      codedWidth: this.width,
      codedHeight: this.height,
      timestamp: Math.round(timestampMicros),
      duration: Math.round(durationMicros),
    });

    // Cache stripped pixel data for snapshots (infrequently).
    // Must copy since fast-path frameData is a view into the mapped GPU buffer.
    if (this._frameCounter % 72 === 0) {
      const src =
        frameData instanceof Uint8Array
          ? frameData
          : new Uint8Array(frameData as unknown as ArrayBuffer);
      this._lastFramePixels = src.slice(0);
    }

    buffer.unmap();
    return videoFrame;
  }

  /**
   * Generate a snapshot blob for UI preview.
   * Uses cached pixel data from the last renderAndReadVideoFrame call —
   * ZERO additional GPU work needed.
   */
  async createSnapshotBlob(): Promise<Blob | null> {
    try {
      if (!this._lastFramePixels) return null;

      // Use a small canvas for the thumbnail (480p) to avoid
      // huge putImageData + convertToBlob overhead at 4K
      const thumbW = Math.min(this.width, 854);
      const thumbH = Math.min(this.height, 480);

      // Full-res source canvas (lazy, reused)
      if (!this._snapshotCanvas || this._snapshotCanvas.width !== this.width) {
        this._snapshotCanvas = new OffscreenCanvas(this.width, this.height);
        this._snapshotCtx = this._snapshotCanvas.getContext('2d');
      }
      const srcCtx = this._snapshotCtx;
      if (!srcCtx) return null;

      // Write cached pixels to source canvas
      const imageData = srcCtx.createImageData(this.width, this.height);
      imageData.data.set(this._lastFramePixels);
      srcCtx.putImageData(imageData, 0, 0);

      // Downscale to thumbnail canvas for efficient JPEG encoding
      if (thumbW < this.width) {
        const thumbCanvas = new OffscreenCanvas(thumbW, thumbH);
        const thumbCtx = thumbCanvas.getContext('2d');
        if (!thumbCtx) return null;
        thumbCtx.drawImage(this._snapshotCanvas, 0, 0, thumbW, thumbH);
        return await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
      }

      return await this._snapshotCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    } catch (e) {
      console.error('[OffscreenGPURenderer] Snapshot creation failed:', e);
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Pipeline construction
  // -------------------------------------------------------------------

  private async _buildPipeline(): Promise<boolean> {
    const shaderModule = this.device.createShaderModule({
      label: 'export-bg-shader',
      code: BACKGROUND_WGSL,
    });

    const compilationInfo = await shaderModule.getCompilationInfo();
    for (const msg of compilationInfo.messages) {
      if (msg.type === 'error') {
        console.error(`[OffscreenGPURenderer] Shader error: ${msg.message}`);
        return false;
      }
    }

    this.bgBindGroupLayout = this.device.createBindGroupLayout({
      label: 'export-bg-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'export-bg-pl',
      bindGroupLayouts: [this.bgBindGroupLayout],
    });

    try {
      this.bgPipeline = await this.device.createRenderPipelineAsync({
        label: 'export-bg-pipeline',
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main' },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.format }],
        },
        primitive: { topology: 'triangle-list' },
      });
    } catch (err) {
      console.error('[OffscreenGPURenderer] Pipeline creation failed:', err);
      return false;
    }

    this.bgUniformBuffer = this.device.createBuffer({
      label: 'export-bg-uniforms',
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler = this.device.createSampler({
      label: 'export-bg-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    return true;
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private _seekWithRVFC(video: HTMLVideoElement, targetTime: number): Promise<void> {
    return new Promise((resolve) => {
      const onFrame = () => {
        const delta = Math.abs(video.currentTime - targetTime);
        if (delta < 1 / 30) {
          resolve();
        } else {
          // If still not there, keep waiting (RVFC is more efficient than polling)
          video.requestVideoFrameCallback(onFrame);
        }
      };

      video.requestVideoFrameCallback(onFrame);
      video.currentTime = targetTime;
    });
  }

  private _seekWithPolling(video: HTMLVideoElement, targetTime: number): Promise<void> {
    return new Promise((resolve) => {
      video.currentTime = targetTime;
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

  private _rebuildBgBindGroup(): void {
    const t1 = this._bgTexture1 ?? this.placeholderTexture;
    const t2 = this._bgTexture2 ?? this.placeholderTexture;
    this._bgBindGroup = this.device.createBindGroup({
      label: 'export-bg-bg',
      layout: this.bgBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bgUniformBuffer } },
        { binding: 1, resource: t1.texture.createView() },
        { binding: 2, resource: t2.texture.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
  }

  // -------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------

  destroy(): void {
    this._shaderLayerRegistry?.destroy();
    this._shaderLayerRegistry = null;
    this._shaderLayers = [];
    this._glslGuestManager?.destroy();
    this._glslGuestManager = null;
    this._glslLayers = [];
    this._overlayImageTexture?.texture.destroy();
    this._overlayImageTexture = null;
    this._overlayBindings = null;
    this._overlayImageAssetId = null;
    this._renderGraph?.destroy();
    this._renderGraph = null;
    this._bgBlurPass?.destroy();
    this._bgBlurPass = null;
    this._butterchurnRenderer?.destroy();
    this._butterchurnRenderer = null;
    this._butterchurnTexture?.destroy();
    this._butterchurnTexture = null;
    this._bcCompositeUniformBuffer?.destroy();
    this._bcCompositeUniformBuffer = null;
    this.textureLoader?.destroy();
    this.bgUniformBuffer?.destroy();
    this.placeholderTexture?.texture.destroy();
    this.renderTarget?.destroy();
    this.bgIntermediateTexture?.destroy();
    for (const buffer of this.readbackBuffers) {
      if (buffer) buffer.destroy();
    }
    this.readbackBuffers = [];
    this._lastFramePixels = null;
    this._initialized = false;
    this._lastSeekedVideoTime = -1;
    this._failedBgUrls.clear();
    console.log('[OffscreenGPURenderer] Destroyed.');
  }
}

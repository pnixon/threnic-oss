/**
 * ButterchurnRenderer — WebGL-based Milkdrop visualizer using the Butterchurn library.
 *
 * Creates its own offscreen WebGL canvas, renders per-frame, and exposes
 * the pixels as an ImageBitmap or copies directly into a WebGPU texture.
 *
 * Handles:
 * - Preset loading from butterchurn-presets catalog
 * - Preset cycling (sequential or random, configurable interval)
 * - Audio feed via AnalyserNode or manual push
 * - Frame-accurate rendering for both live preview and export
 */

import type { ButterchurnCycleMode } from '@/types/effects/butterchurn';
import { computeButterchurnRenderSize, type ButterchurnSizeLimits } from './butterchurnSize';

// Butterchurn is a CJS module with a default export
type ButterchurnStatic = (typeof import('butterchurn'))['default'];
type ButterchurnPresetsStatic = (typeof import('butterchurn-presets'))['default'];
type ButterchurnVisualizer = ReturnType<ButterchurnStatic['createVisualizer']>;
type ButterchurnVisualizerInternals = ButterchurnVisualizer & {
  audio?: { timeByteArray?: Uint8Array };
};

let butterchurnModule: ButterchurnStatic | null = null;
let butterchurnPresetsModule: ButterchurnPresetsStatic | null = null;

async function loadButterchurn() {
  if (!butterchurnModule) {
    butterchurnModule = (await import('butterchurn')).default;
  }
  if (!butterchurnPresetsModule) {
    butterchurnPresetsModule = (await import('butterchurn-presets')).default;
  }
  return { butterchurn: butterchurnModule, presets: butterchurnPresetsModule };
}

interface ButterchurnRendererOptions {
  width: number;
  height: number;
  audioContext: AudioContext | OfflineAudioContext;
  audioNode?: AudioNode;
  /** Called when the WebGL context is lost (renderer stops drawing until restored). */
  onContextLost?: () => void;
  /** Called after a lost context was restored and the visualizer rebuilt (ok=false: rebuild failed). */
  onContextRestored?: (ok: boolean) => void;
}

// Butterchurn multiplies its size by pixelRatio (defaulting to
// window.devicePixelRatio) and textureRatio. We pass an already-capped pixel
// size, so both must be pinned to 1 or a DPR-3 phone triples it again.
const BC_RATIO_OPTS = { pixelRatio: 1, textureRatio: 1 } as const;

export class ButterchurnRenderer {
  private canvas: HTMLCanvasElement;
  private visualizer: ButterchurnVisualizer | null = null;
  private presetMap: Record<string, unknown> = {};
  private presetNames: string[] = [];
  private currentPresetIndex = 0;
  private currentPresetId: string | null = null;
  private cycleMode: ButterchurnCycleMode = 'off';
  private cycleInterval = 15; // seconds
  private lastCycleTime = 0;
  private frameCount = 0;
  private audioContext: AudioContext | OfflineAudioContext;
  private audioNode: AudioNode | null = null;
  /** Requested output size (what the consumer composites at). */
  private width: number;
  private height: number;
  /** Actual internal render size — capped, see computeButterchurnRenderSize. */
  private renderWidth: number;
  private renderHeight: number;
  private sizeLimits: ButterchurnSizeLimits = {};
  private gl: WebGL2RenderingContext | null = null;
  private _ready = false;
  private _destroyed = false;
  private _contextLost = false;
  private onContextLost: (() => void) | null;
  private onContextRestored: ((ok: boolean) => void) | null;

  constructor(options: ButterchurnRendererOptions) {
    this.width = options.width;
    this.height = options.height;
    this.audioContext = options.audioContext;
    this.audioNode = options.audioNode ?? null;
    this.onContextLost = options.onContextLost ?? null;
    this.onContextRestored = options.onContextRestored ?? null;

    const size = computeButterchurnRenderSize(this.width, this.height);
    this.renderWidth = size.width;
    this.renderHeight = size.height;

    // Butterchurn requires a real HTMLCanvasElement (it accesses DOM-specific
    // properties internally). Use a hidden element, never OffscreenCanvas.
    const el = document.createElement('canvas');
    el.width = this.renderWidth;
    el.height = this.renderHeight;
    el.style.display = 'none';
    el.addEventListener('webglcontextlost', this._handleContextLost);
    el.addEventListener('webglcontextrestored', this._handleContextRestored);
    document.body.appendChild(el);
    this.canvas = el;
  }

  get ready(): boolean {
    return this._ready;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Initialize Butterchurn — must be called before render().
   * Returns false if WebGL2 is unavailable.
   */
  async init(): Promise<boolean> {
    if (this._destroyed) return false;

    try {
      const { butterchurn, presets } = await loadButterchurn();

      // Pre-create WebGL2 context with preserveDrawingBuffer: true.
      // This is critical: WebGPU's copyExternalImageToTexture reads the canvas
      // content AFTER the frame, so the buffer must not be cleared on present.
      // Butterchurn's createVisualizer will call getContext() on the same canvas
      // and receive this pre-existing context (per spec, you get the same one).
      const gl = (this.canvas as HTMLCanvasElement).getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl || gl.isContextLost()) {
        console.error('[ButterchurnRenderer] WebGL2 not available');
        return false;
      }
      this.gl = gl;

      // Clamp the internal size to what this context can actually allocate.
      this.sizeLimits = {
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      };
      this._applyRenderSize();

      // Load all presets
      this.presetMap = presets.getPresets();
      this.presetNames = Object.keys(this.presetMap).sort();

      this._createVisualizer(butterchurn);

      console.log(`[ButterchurnRenderer] Initialized with ${this.presetNames.length} presets`);
      this._ready = true;
      return true;
    } catch (err) {
      console.error('[ButterchurnRenderer] Init failed:', err);
      return false;
    }
  }

  /**
   * (Re)create the visualizer on the current WebGL2 context at the capped size.
   * Used on init and after a lost context is restored.
   */
  private _createVisualizer(butterchurn: ButterchurnStatic): void {
    this.visualizer = butterchurn.createVisualizer(this.audioContext, this.canvas, {
      width: this.renderWidth,
      height: this.renderHeight,
      ...BC_RATIO_OPTS,
    });
    if (this.audioNode) {
      this.visualizer.connectAudio(this.audioNode);
    }
  }

  /**
   * Recompute the capped internal size from the requested size and resize the
   * canvas + visualizer if it changed. Returns true when the size changed.
   */
  private _applyRenderSize(): boolean {
    const size = computeButterchurnRenderSize(this.width, this.height, this.sizeLimits);
    if (size.width === this.renderWidth && size.height === this.renderHeight) return false;
    this.renderWidth = size.width;
    this.renderHeight = size.height;
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.visualizer?.setRendererSize(size.width, size.height, BC_RATIO_OPTS);
    return true;
  }

  private _handleContextLost = (e: Event): void => {
    // preventDefault() tells the browser we want a webglcontextrestored event.
    e.preventDefault();
    if (this._destroyed) return;
    console.warn('[ButterchurnRenderer] WebGL context lost');
    this._contextLost = true;
    this._ready = false;
    this.visualizer = null;
    this.onContextLost?.();
  };

  private _handleContextRestored = (): void => {
    if (this._destroyed || !butterchurnModule) return;
    let ok = false;
    try {
      this._contextLost = false;
      this._createVisualizer(butterchurnModule);
      const preset = this.currentPresetId;
      this.currentPresetId = null;
      if (preset) this.loadPreset(preset, 0);
      this._ready = true;
      ok = true;
    } catch (err) {
      console.error('[ButterchurnRenderer] Rebuild after context restore failed:', err);
    }
    this.onContextRestored?.(ok);
  };

  /** True while the WebGL context is lost and not yet restored. */
  get contextLost(): boolean {
    return this._contextLost;
  }

  /**
   * Connect/reconnect the audio source node.
   */
  connectAudio(node: AudioNode): void {
    if (node === this.audioNode) return; // already connected
    this.audioNode = node;
    if (this.visualizer) {
      this.visualizer.connectAudio(node);
    }
  }

  /**
   * Resize the renderer output.
   */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    // The canvas (and so getCanvas()) only changes when the CAPPED size does;
    // consumers size their GPU texture from the canvas, not from width/height.
    this._applyRenderSize();
  }

  /**
   * Load a preset by name (from butterchurn-presets catalog).
   * @param name Exact preset name
   * @param blendTime Crossfade duration in seconds (0 = instant)
   */
  loadPreset(name: string, blendTime = 0): boolean {
    const preset = this.presetMap[name];
    if (!preset || !this.visualizer) return false;
    this.visualizer.loadPreset(preset, blendTime);
    this.currentPresetId = name;
    this.currentPresetIndex = this.presetNames.indexOf(name);
    this.lastCycleTime = this.frameCount;
    return true;
  }

  /**
   * Load a preset by index in the sorted preset list.
   */
  loadPresetByIndex(index: number, blendTime = 0): boolean {
    const clamped =
      ((index % this.presetNames.length) + this.presetNames.length) % this.presetNames.length;
    return this.loadPreset(this.presetNames[clamped], blendTime);
  }

  /**
   * Load the correct STARTING preset given the config, so the visualizer never
   * begins on the default blank preset.
   *
   * Resolution order:
   *  - An explicit `presetName` always wins (load it verbatim).
   *  - Otherwise, in 'random' cycle mode, start on a random preset.
   *  - Otherwise (off / sequential with no name), start on the first preset.
   *
   * @param presetName Selected preset name, or '' / undefined for auto-pick.
   * @param cycleMode  Cycle mode driving the auto-pick when no name is set.
   * @param blendTime  Crossfade duration in seconds (0 = instant for a cold start).
   * @returns true if a preset was loaded.
   */
  loadInitialPreset(
    presetName: string | undefined,
    cycleMode: ButterchurnCycleMode,
    blendTime = 0,
  ): boolean {
    if (!this._ready || this.presetNames.length === 0) return false;
    if (presetName) {
      return this.loadPreset(presetName, blendTime);
    }
    if (cycleMode === 'random') {
      const index = Math.floor(Math.random() * this.presetNames.length);
      return this.loadPresetByIndex(index, blendTime);
    }
    return this.loadPresetByIndex(0, blendTime);
  }

  /**
   * Configure the preset cycling behavior.
   */
  setCycleConfig(mode: ButterchurnCycleMode, intervalSeconds: number): void {
    this.cycleMode = mode;
    this.cycleInterval = Math.max(1, intervalSeconds);
  }

  /**
   * Get all available preset names.
   */
  getPresetNames(): string[] {
    return [...this.presetNames];
  }

  /**
   * Get the current preset name.
   */
  getCurrentPreset(): string | null {
    return this.currentPresetId;
  }

  /**
   * Render one frame. Call this every animation frame.
   * Handles preset cycling internally based on frame count and fps.
   *
   * @param fps Current framerate (used for cycle timing)
   */
  render(fps = 60): void {
    if (!this.visualizer || !this._ready || this._destroyed) return;

    // Handle preset cycling
    if (this.cycleMode !== 'off' && this.presetNames.length > 1) {
      const elapsedFrames = this.frameCount - this.lastCycleTime;
      const elapsedSeconds = elapsedFrames / fps;

      if (elapsedSeconds >= this.cycleInterval) {
        this.advancePreset();
      }
    }

    // Live path: pull FFT from the connected AnalyserNode (real-time).
    this.visualizer.render();
    this.frameCount++;
  }

  /** Butterchurn's internal time-domain buffer size (numSamps * 2). */
  private _bcTimeArray: Uint8Array | null = null;

  /**
   * Render one frame from an explicitly supplied time-domain waveform slice
   * instead of pulling from a live AnalyserNode.
   *
   * This is the EXPORT path. During a frame-accurate export the AudioContext
   * clock is decoupled from the frame-stepping loop, so a real-time-playing
   * source node would leave Butterchurn reacting to the wrong moment of audio
   * (or barely reacting at all). By passing the exact waveform bytes for the
   * frame being rendered — and a fixed elapsedTime of 1/fps — the visualizer
   * reacts to precisely the audio that frame corresponds to, matching (and
   * improving on) the live preview's reactivity.
   *
   * @param timeByteArray Unsigned 8-bit time-domain samples (128 = silence),
   *   as produced by AudioAnalyzer.rawTimeDomain / AnalyserNode.getByteTimeDomainData.
   *   Any length is accepted; it is copied into Butterchurn's internal buffer size.
   * @param fps Current framerate (drives preset-cycle timing and elapsedTime).
   */
  renderWithAudio(timeByteArray: Uint8Array, fps = 60): void {
    if (!this.visualizer || !this._ready || this._destroyed) return;

    // Handle preset cycling (frame-count based, same as live).
    if (this.cycleMode !== 'off' && this.presetNames.length > 1) {
      const elapsedFrames = this.frameCount - this.lastCycleTime;
      const elapsedSeconds = elapsedFrames / fps;
      if (elapsedSeconds >= this.cycleInterval) {
        this.advancePreset();
      }
    }

    // Butterchurn's updateAudio() does `target.set(source)`, which throws if the
    // source is longer than its internal buffer. Copy into a correctly-sized
    // scratch buffer (Butterchurn uses numSamps*2, typically 1024). We infer the
    // size from the visualizer's audio processor and cache the buffer.
    const bcSize: number =
      (this.visualizer as ButterchurnVisualizerInternals | null)?.audio?.timeByteArray?.length ??
      timeByteArray.length;
    if (!this._bcTimeArray || this._bcTimeArray.length !== bcSize) {
      this._bcTimeArray = new Uint8Array(bcSize);
    }
    const dst = this._bcTimeArray;
    const n = Math.min(bcSize, timeByteArray.length);
    dst.set(timeByteArray.subarray(0, n));
    // Zero-pad (128 = silence in unsigned time-domain) if the source was shorter.
    if (n < bcSize) dst.fill(128, n);

    // Mono: feed the same waveform to L and R.
    this.visualizer.render({
      audioLevels: {
        timeByteArray: dst,
        timeByteArrayL: dst,
        timeByteArrayR: dst,
      },
      elapsedTime: 1 / fps,
    });
    this.frameCount++;
  }

  /**
   * Advance to the next preset based on cycle mode.
   */
  private advancePreset(): void {
    const blendTime = 2.0; // smooth crossfade on cycle
    if (this.cycleMode === 'sequential') {
      this.loadPresetByIndex(this.currentPresetIndex + 1, blendTime);
    } else if (this.cycleMode === 'random') {
      let newIndex: number;
      do {
        newIndex = Math.floor(Math.random() * this.presetNames.length);
      } while (newIndex === this.currentPresetIndex && this.presetNames.length > 1);
      this.loadPresetByIndex(newIndex, blendTime);
    }
  }

  /**
   * Get the current frame as an ImageBitmap.
   * Used by the WebGPU renderer to copy into its texture.
   */
  async getFrameBitmap(): Promise<ImageBitmap | null> {
    if (!this._ready || this._destroyed) return null;
    try {
      return await createImageBitmap(this.canvas);
    } catch {
      return null;
    }
  }

  /**
   * Get the raw canvas for direct texture upload (copyExternalImageToTexture).
   * Its size is the capped internal render size, which may be smaller than the
   * requested output size — consumers must sample/upscale, not copy 1:1.
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Reset the frame counter (e.g., on seek).
   */
  reset(): void {
    this.frameCount = 0;
    this.lastCycleTime = 0;
  }

  /**
   * Destroy all resources.
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._ready = false;
    if (this.visualizer && this.audioNode) {
      try {
        this.visualizer.disconnectAudio(this.audioNode);
      } catch {
        /* node already disconnected / context closed */
      }
    }
    this.visualizer = null;
    this.canvas.removeEventListener('webglcontextlost', this._handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._handleContextRestored);
    // Release the WebGL context eagerly. Browsers cap live WebGL contexts
    // (~16); waiting for GC on a discarded canvas leaks them, which matters
    // when init fails or the effect is toggled repeatedly.
    try {
      this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* best effort */
    }
    this.gl = null;
    // Remove the hidden canvas from DOM
    if (this.canvas instanceof HTMLCanvasElement && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}

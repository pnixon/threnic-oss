/**
 * GameSceneRenderer — Offscreen Canvas2D game engine for audio-reactive pixel art scenes.
 *
 * Integration pattern mirrors ButterchurnRenderer:
 * - Creates its own hidden HTMLCanvasElement
 * - Renders game frames driven by audio data from Threnic's EngineState
 * - Exposes canvas for WebGPU copyExternalImageToTexture into bgRenderTarget
 *
 * Pure Canvas2D — no framework dependencies. Scenes receive ctx directly.
 */

import type { AudioReactiveData, GameScene, LyricLineTiming } from './types';

interface GameSceneRendererOptions {
  width: number;
  height: number;
}

export class GameSceneRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private _ready = false;
  private _destroyed = false;
  private _scene: GameScene | null = null;
  private _sceneId: string | null = null;
  private _frameCount = 0;
  private _lyrics: LyricLineTiming[] = [];
  private _offline = false;
  private _assetUrls: { left?: string; right?: string; background?: string } | null = null;
  private _params: Record<string, number | string | boolean> | null = null;

  // Audio data fed in from Threnic each frame
  private _audioData: AudioReactiveData = {
    bass: 0,
    mid: 0,
    treb: 0,
    beat: false,
    amplitude: 0,
    bpm: 120,
    time: 0,
    duration: 0,
  };

  constructor(options: GameSceneRendererOptions) {
    this.width = options.width;
    this.height = options.height;

    // Create hidden canvas — same pattern as ButterchurnRenderer
    const el = document.createElement('canvas');
    el.width = this.width;
    el.height = this.height;
    el.style.display = 'none';
    document.body.appendChild(el);
    this.canvas = el;
    this.ctx = el.getContext('2d')!;
  }

  get ready(): boolean {
    return this._ready;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Initialize the renderer. Canvas2D needs no async framework init —
   * ready immediately.
   */
  async init(): Promise<boolean> {
    if (this._destroyed) return false;
    this._ready = true;
    console.log('[GameSceneRenderer] Initialized');
    return true;
  }

  /**
   * Load a game scene by ID.
   */
  async loadScene(sceneId: string): Promise<boolean> {
    if (!this._ready || this._destroyed) return false;

    try {
      // Dynamic import of scene modules
      const sceneModule = await import(`./scenes/${sceneId}`);
      const SceneClass = sceneModule.default || sceneModule[Object.keys(sceneModule)[0]];

      // Destroy previous scene
      if (this._scene) {
        this._scene.destroy?.();
      }

      // Instantiate the new scene
      this._scene = new SceneClass(this.width, this.height);
      this._sceneId = sceneId;

      // Initialize the scene
      if (this._scene) {
        this._scene.init?.(this.width, this.height);
        // Re-apply everything configured before this scene existed. Without
        // this, anything set while a previous scene was loaded (or before the
        // first load finished) is silently lost on scene switch.
        this._scene.setOffline?.(this._offline);
        if (this._lyrics.length > 0 && this._scene.setLyrics) {
          this._scene.setLyrics(this._lyrics);
        }
        if (this._assetUrls) {
          this._scene.setAssetUrls?.(this._assetUrls);
        }
        if (this._params) {
          this._scene.setParams?.(this._params);
        }
      }

      console.log(`[GameSceneRenderer] Loaded scene: ${sceneId}`);
      return true;
    } catch (err) {
      console.error(`[GameSceneRenderer] Failed to load scene ${sceneId}:`, err);
      return false;
    }
  }

  /**
   * Feed audio data from Threnic's EngineState into the game scene.
   * Call this every frame BEFORE render().
   */
  setAudioData(data: AudioReactiveData): void {
    this._audioData = data;
  }

  /**
   * Pass lyric line timings to the active scene for camera/event sync.
   * Call when track changes or lyrics are edited.
   */
  setLyrics(lines: LyricLineTiming[]): void {
    this._lyrics = lines;
    if (this._scene?.setLyrics) {
      this._scene.setLyrics(lines);
    }
  }

  /**
   * Set custom asset URLs on the active scene.
   * Call after loading blob URLs from IDB.
   */
  setAssetUrls(urls: { left?: string; right?: string; background?: string }): void {
    this._assetUrls = urls;
    if (this._scene?.setAssetUrls) {
      this._scene.setAssetUrls(urls);
    }
  }

  /**
   * Mark this renderer as driving an offline export rather than live playback.
   * Scenes use it to pick their trigger signal and cooldown clock.
   */
  setOffline(offline: boolean): void {
    this._offline = offline;
    this._scene?.setOffline?.(offline);
  }

  /** Resolves once the active scene's assets are loaded (see GameScene). */
  whenAssetsReady(timeoutMs?: number): Promise<void> {
    return this._scene?.whenAssetsReady?.(timeoutMs) ?? Promise.resolve();
  }

  /**
   * Pass scene-specific params (e.g., leftHover, rightHover).
   * Called when config changes.
   */
  setParams(params: Record<string, number | string | boolean>): void {
    this._params = params;
    if (this._scene?.setParams) {
      this._scene.setParams(params);
    }
  }

  /**
   * Advance one game frame. Call this from Threnic's render loop.
   */
  render(): void {
    if (!this._ready || this._destroyed || !this._scene) return;
    this._scene.update(this._audioData);
    this._scene.render(this._audioData, this.ctx);
    this._frameCount++;
  }

  /**
   * Resize the renderer output.
   */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    // Re-acquire context after resize (canvas resize resets context)
    this.ctx = this.canvas.getContext('2d')!;
    // Propagate to the scene — without this the scene keeps its init()
    // dimensions and renders off-centre at the new resolution.
    this._scene?.setSize?.(width, height);
  }

  /**
   * Get the raw canvas for WebGPU copyExternalImageToTexture.
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Get the current scene ID.
   */
  getCurrentScene(): string | null {
    return this._sceneId;
  }

  /**
   * Get available scene names.
   */
  getSceneNames(): string[] {
    return ['rpgCombat', 'fetch', 'carRacing']; // Expand as more scenes are added
  }

  /**
   * Reset frame counter (e.g., on seek).
   */
  reset(): void {
    this._frameCount = 0;
    if (this._scene) {
      this._scene.reset?.();
    }
  }

  /**
   * Destroy all resources.
   */
  destroy(): void {
    this._destroyed = true;
    this._ready = false;
    if (this._scene) {
      this._scene.destroy?.();
      this._scene = null;
    }
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}

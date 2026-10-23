/**
 * Types for Canvas2D game scene integration with Threnic.
 */

/** Minimal lyric line timing for scene camera sync. */
export interface LyricLineTiming {
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
}

/** Audio data fed from Threnic's EngineState each frame. */
export interface AudioReactiveData {
  /** Bass frequency band energy (0–1) */
  bass: number;
  /** Mid frequency band energy (0–1) */
  mid: number;
  /** Treble frequency band energy (0–1) */
  treb: number;
  /** Whether a beat was detected this frame */
  beat: boolean;
  /** Overall amplitude (0–1) */
  amplitude: number;
  /** Estimated BPM */
  bpm: number;
  /** Playback time in seconds */
  time: number;
  /** Total song duration in seconds (0 if unknown). */
  duration: number;
}

/** Interface that all game scenes must implement. */
export interface GameScene {
  /** Called once when the scene is loaded. */
  init?(width: number, height: number): void;

  /**
   * Called when the output resolution changes (e.g. preview 720p → 4K export).
   * Scenes should re-derive any layout that depends on canvas size and rescale
   * their art constants. If omitted, the scene keeps its init() dimensions and
   * will render incorrectly after a resize.
   */
  setSize?(width: number, height: number): void;

  /** Called every frame for game logic. */
  update(audio: AudioReactiveData): void;

  /** Called every frame for rendering. */
  render(audio: AudioReactiveData, ctx: CanvasRenderingContext2D): void;

  /**
   * Pass lyric line timings for camera/event sync.
   * Called when lyrics change (track switch, edit).
   * Scenes use this to switch focus on line starts.
   */
  setLyrics?(lines: LyricLineTiming[]): void;

  /**
   * Set custom asset URLs (user-uploaded sprites/backgrounds).
   * Called after scene init when IDB assets are resolved.
   */
  setAssetUrls?(urls: { left?: string; right?: string; background?: string }): void;

  /**
   * Set scene-specific params (e.g., leftHover, rightHover booleans).
   * Called when config changes.
   */
  setParams?(params: Record<string, number | string | boolean>): void;

  /**
   * Switch the scene to offline (export) mode.
   *
   * Live playback and offline export differ in two ways that matter to any
   * scene doing its own event triggering:
   *  - there is no live audio store to sample, only the per-frame audio the
   *    renderer hands to update()
   *  - wall-clock time runs at whatever rate the encoder achieves (often ~2x
   *    real time), so it cannot be used to time anything musical
   *
   * Scenes that ignore this will still render, but any wall-clock or live-store
   * behaviour will be wrong in the exported video.
   */
  setOffline?(offline: boolean): void;

  /**
   * Resolves once the scene's assets are loaded and it can draw a complete
   * frame. Exports await this before encoding so the opening frames are not
   * missing sprites. Scenes with no async assets can omit it.
   */
  whenAssetsReady?(timeoutMs?: number): Promise<void>;

  /** Reset scene state (e.g., on seek). */
  reset?(): void;

  /** Cleanup when switching scenes. */
  destroy?(): void;
}

/** Config for the game scene mode in ShaderFx. */
export interface GameSceneConfig {
  enabled: boolean;
  sceneId: string;
  /** Scene-specific parameters (palette, speed, density, etc.) */
  params?: Record<string, number | string | boolean>;
  /**
   * Compositing opacity of the game scene over the background (0–1, default 1).
   * The scene is always drawn ON TOP of whatever background is active
   * (image / video / shader / solid), alpha-blended per-pixel so transparent
   * regions of the scene canvas reveal the background beneath. This scalar
   * multiplies the scene's per-pixel alpha, so 0.5 makes the whole scene
   * half-transparent while still respecting its own empty regions.
   */
  opacity?: number;
}

/** @deprecated Use GameSceneConfig. Kept for config compatibility. */
export type LittleJSSceneConfig = GameSceneConfig;

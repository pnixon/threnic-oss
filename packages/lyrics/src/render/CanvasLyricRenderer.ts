/**
 * CanvasLyricRenderer — Unified lyric renderer for preview AND export.
 *
 * Uses Canvas2D to rasterize lyrics onto a transparent bitmap that is
 * composited into a downstream pipeline (e.g. Threnic's WebGPU LyricCompositePass).
 *
 * Architecture:
 *   render(time, width, height) → HTMLCanvasElement | OffscreenCanvas (transparent RGBA)
 *   The caller uploads this to a GPUTexture and alpha-blends it over the scene.
 *
 * Extraction note (@threnic/lyrics): two seams were broken vs. the in-app
 * original:
 *   1. Fonts — the hardcoded `@/constants/fonts` FONTS table is replaced by an
 *      injected `FontRegistry` (2nd constructor arg). No registry ⇒ per-lane
 *      `fontId` overrides fall back to the global font.
 *   2. TrackTitleConfig — now the package's own minimal type.
 * All rendering/layout logic is otherwise verbatim.
 */

import type {
  LyricLineData,
  LyricTheme,
  LyricAnimationConfig,
  Word,
  LineStyleOverride,
} from '../types/core';
import type { TrackTitleConfig } from '../types/track-title';
import { calculateWordAnimation } from '../core/AnimationController';
import { autoAssignLanes } from '../core/converters';
import type { FontRegistry } from './FontRegistry';
import { EMPTY_FONT_REGISTRY } from './FontRegistry';
import type {
  LyricStyle,
  StyleRegistry,
  StyleWordModifier,
  StyleLaidOutWord,
} from './StyleRegistry';
import { EMPTY_STYLE_REGISTRY } from './StyleRegistry';

// ─── Color Utilities ─────────────────────────────────────────

/** Parse a hex color (#RGB or #RRGGBB) into [r, g, b] (0-255). */
function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/** Linearly interpolate between two hex colors. t ∈ [0,1]. */
function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const ct = Math.max(0, Math.min(1, t));
  const r = Math.round(ar + (br - ar) * ct);
  const g = Math.round(ag + (bg - ag) * ct);
  const bl = Math.round(ab + (bb - ab) * ct);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

// ─── Types ───────────────────────────────────────────────────

export interface LyricRenderConfig {
  lyrics: LyricLineData[];
  theme: LyricTheme;
  /** Vertical position as percentage 0–100 (default: 50 = center, 0 = bottom, 100 = top) */
  verticalPosition?: number;
  /** Horizontal anchor for wrapped rows within the wrap column (default: 'center') */
  horizontalPosition?: 'left' | 'center' | 'right';
  /** Auto-wrap column width as a percentage of canvas width (10–100, default: 90) */
  wrapWidth?: number;
  /** Font URL or family name */
  fontUrl?: string;
  /** Effect scope for audio-reactive effects */
  effectScope?: 'word' | 'line' | 'background';
  /** Fade-in duration in seconds before line start */
  fadeInDuration?: number;
  /** Fade-out duration in seconds after line end */
  fadeOutDuration?: number;
  trackTitle?: string;
  trackTitleConfig?: TrackTitleConfig;
  trackTitleFontUrl?: string;
  /** Start time of the track within the global timeline (in seconds) */
  trackStartTime?: number;
  /** Number of vertical lanes for multi-singer display (default: 1 = auto) */
  laneCount?: number;
}

/** Options for constructing a renderer. */
export interface CanvasLyricRendererOptions {
  /** Resolves per-lane `fontId` overrides to loadable font URLs. */
  fontRegistry?: FontRegistry;
  /** Resolves `theme.styleId` to a named lyric style (audio-reactive modifier). */
  styleRegistry?: StyleRegistry;
}

/** Per-word layout computed by measureText(). */
interface MeasuredWord {
  text: string;
  width: number;
  start: number;
  end: number;
  /** Row index after word-wrap */
  row: number;
  /** X position in pixels (centered) */
  px: number;
  /** Y position in pixels */
  py: number;
  /** Word index in the line */
  wordIndex: number;
  /** Global char start index (for char-level animations) */
  globalCharStart: number;
  /** Scale factor if word is too wide */
  scale: number;
}

interface VisibleLine {
  line: LyricLineData;
  lineIndex: number;
  words: MeasuredWord[];
  /** Centre-Y position in pixels */
  cy: number;
  /** Total row count for this line */
  rowCount: number;
  /** Lane assignment (0-based) */
  laneIndex: number;
  /** Effective font size in pixels (after lane override resolution) */
  effectiveFontSizePx: number;
}

// ─── Audio state bridge ──────────────────────────────────────
// FrameAudioMetrics lives in ./FrameAudio (shared with the style seam).
import type { FrameAudioMetrics } from './FrameAudio';

/** One word positioned by the shared layout (for the GPU Lyric FX path). */
export interface PositionedLyricWord {
  text: string;
  start: number;
  end: number;
  wordIndex: number;
  globalCharStart: number;
  /** Absolute pixel position of the word's left edge. */
  x: number;
  /** Absolute baseline Y of the word. */
  y: number;
  /** Per-word scale (shrunk when a word is too wide for the line). */
  scale: number;
}

/** One visible line's positioned words (for the GPU Lyric FX path). */
export interface PositionedLyricLine {
  lineIndex: number;
  laneIndex: number;
  fontSizePx: number;
  words: PositionedLyricWord[];
}

/**
 * The deterministic canvas rectangle every layout derives its edges from.
 * `width`/`height` are the logical canvas size (pre-supersample); the safe-area
 * `margin*` fields are the buffered content box edges in the same space, so a
 * consumer computes an edge as e.g. `marginLeft` … `width - marginRight`
 * without re-deriving the inset. `aspect = width / height`.
 */
export interface CanvasRect {
  width: number;
  height: number;
  aspect: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
}

// ─── Constants ───────────────────────────────────────────────

const LAYOUT_BUFFER_SECONDS = 3.0; // extra seconds lines stay mounted for smooth transitions
const DEFAULT_FONT = 'Inter, Roboto, system-ui, sans-serif';
// Default safe-area inset (percent of canvas W/H) kept clear on every edge so
// text never renders flush against the frame. The wrap column and anchoring
// operate INSIDE this buffered box; wrapWidth=100 fills it edge-to-edge.
const EDGE_MARGIN_PCT = 10;
// Aspect-ratio change is only acted on past this relative delta, so sub-pixel
// resize jitter (a 1px layout reflow) does not spuriously reset scroll state.
const ASPECT_EPSILON = 0.01;

// ─── CanvasLyricRenderer ─────────────────────────────────────

export class CanvasLyricRenderer {
  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private config: LyricRenderConfig;
  private fontRegistry: FontRegistry;
  private styleRegistry: StyleRegistry;
  /** Style resolved from theme.styleId, or null when none. */
  private activeStyle: LyricStyle | null = null;

  // Resolved animation configs
  private animIn: LyricAnimationConfig;
  private animOut: LyricAnimationConfig;
  private fadeInDuration: number;
  private fadeOutDuration: number;

  // Font state
  private fontFamily: string = DEFAULT_FONT;
  private trackTitleFontFamily: string = DEFAULT_FONT;
  private fontLoaded = false;
  private fontLoadPromise: Promise<void> | null = null;
  private trackTitleFontLoadPromise: Promise<void> | null = null;

  // Cached layout (invalidated on resize or config change)
  private lastWidth = 0;
  private lastHeight = 0;
  private lastFontSize = 0;

  // Deterministic canvas rect + aspect-change tracking. `_canvasRect` is the
  // single source of edge geometry all layout reads; `_aspectChanged` latches
  // true for one read after the aspect ratio crosses ASPECT_EPSILON so callers
  // (and our own scroll reset) can react to an orientation/format change.
  private _canvasRect: CanvasRect | null = null;
  private _lastAspect = 0;
  private _aspectChanged = false;

  // Smooth scroll state — prevents downward bounce when lines exit
  private _scrollOffset = 0; // current smoothed scroll offset (px)
  private _targetScrollOffset = 0; // target scroll offset (px)
  private _lastAnchorLineIndex = -1; // global lyrics[] index of the previous anchor
  private _lastRenderTime = -1; // timestamp of last render for dt calc

  // Per-lane font cache: laneIndex → fontFamily string
  private laneFontCache: Map<number, string> = new Map();
  private laneFontLoadPromises: Map<number, Promise<void>> = new Map();

  constructor(config: LyricRenderConfig, options?: CanvasLyricRendererOptions) {
    this.config = config;
    this.fontRegistry = options?.fontRegistry ?? EMPTY_FONT_REGISTRY;
    this.styleRegistry = options?.styleRegistry ?? EMPTY_STYLE_REGISTRY;
    this.activeStyle = config.theme.styleId
      ? (this.styleRegistry.getById(config.theme.styleId) ?? null)
      : null;
    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 1;
      this.canvas.height = 1;
      this.ctx = this.canvas.getContext('2d', {
        willReadFrequently: false,
      }) as CanvasRenderingContext2D;
    } else {
      this.canvas = new OffscreenCanvas(1, 1);
      this.ctx = this.canvas.getContext('2d', {
        willReadFrequently: false,
      }) as OffscreenCanvasRenderingContext2D;
    }

    // Resolve animation configs
    this.animIn = config.theme.animationIn ?? { type: 'pop', granularity: 'word' };
    this.animOut = config.theme.animationOut ?? { type: 'fade', granularity: 'word' };
    this.fadeInDuration = config.fadeInDuration ?? config.theme.animationIn?.duration ?? 1.0;
    this.fadeOutDuration = config.fadeOutDuration ?? config.theme.animationOut?.duration ?? 1.0;

    // Start font loading
    if (config.fontUrl || config.theme.fontUrl) {
      this._loadFont(config.fontUrl || config.theme.fontUrl!);
    } else {
      this.fontLoaded = true;
    }

    if (config.trackTitleFontUrl) {
      this._loadTrackTitleFont(config.trackTitleFontUrl);
    }
  }

  /** Update config (e.g. when theme changes). */
  updateConfig(config: Partial<LyricRenderConfig>): void {
    const oldFontUrl = this.config.fontUrl || this.config.theme?.fontUrl;
    const oldTitleFontUrl = this.config.trackTitleFontUrl;

    // Reset scroll state when lyrics change (e.g. track switch)
    if (config.lyrics && config.lyrics !== this.config.lyrics) {
      this._scrollOffset = 0;
      this._targetScrollOffset = 0;
      this._lastAnchorLineIndex = -1;
      this._lastRenderTime = -1;
    }

    Object.assign(this.config, config);
    if (config.theme) {
      this.animIn = config.theme.animationIn ?? this.animIn;
      this.animOut = config.theme.animationOut ?? this.animOut;
      // Clear per-lane font caches so overrides are re-evaluated
      this.laneFontCache.clear();
      this.laneFontLoadPromises.clear();
      // Re-resolve the active style from the (possibly new) styleId.
      this.activeStyle = this.config.theme.styleId
        ? (this.styleRegistry.getById(this.config.theme.styleId) ?? null)
        : null;
    }
    this.fadeInDuration =
      this.config.fadeInDuration ?? this.config.theme?.animationIn?.duration ?? 1.0;
    this.fadeOutDuration =
      this.config.fadeOutDuration ?? this.config.theme?.animationOut?.duration ?? 1.0;

    const newFontUrl = config.fontUrl || config.theme?.fontUrl;
    if (newFontUrl) {
      if (newFontUrl !== oldFontUrl) {
        this.fontLoadPromise = null;
      }
      this._loadFont(newFontUrl);
    }

    if (config.trackTitleFontUrl) {
      if (config.trackTitleFontUrl !== oldTitleFontUrl) {
        this.trackTitleFontLoadPromise = null;
      }
      this._loadTrackTitleFont(config.trackTitleFontUrl);
    }
    // Invalidate layout cache
    this.lastWidth = 0;
  }

  /** Wait for all pending fonts to load */
  async waitForFonts(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.fontLoadPromise) promises.push(this.fontLoadPromise);
    if (this.trackTitleFontLoadPromise) promises.push(this.trackTitleFontLoadPromise);
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Render lyrics at the given time and resolution.
   * Returns a canvas source suitable for GPU upload.
   */
  render(
    time: number,
    width: number,
    height: number,
    audio?: FrameAudioMetrics,
  ): HTMLCanvasElement | OffscreenCanvas | null {
    const { lyrics, theme, trackTitle, trackTitleConfig } = this.config;
    const hasLyrics = lyrics && lyrics.length > 0;
    const hasTrackTitle = trackTitle && trackTitleConfig && trackTitleConfig.enabled;

    if (!hasLyrics && !hasTrackTitle) return null;
    if (width <= 0 || height <= 0) return null;

    // Deterministic canvas rect + aspect-change detection (scale-independent).
    this._syncCanvasRect(width, height);

    // --- High DPI / Super-sampling ---
    const renderScale = 2;
    const renderW = width * renderScale;
    const renderH = height * renderScale;

    // Resize canvas if needed
    if (this.canvas.width !== renderW || this.canvas.height !== renderH) {
      this.canvas.width = renderW;
      this.canvas.height = renderH;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, renderW, renderH);

    const baseFontSizePx = (theme.fontSize ?? 0.5) * (height / 10) * renderScale;

    const frameCtx = {
      time,
      audio,
      width: renderW,
      height: renderH,
      renderScale,
      fontSizePx: baseFontSizePx,
    };

    // Find visible lines
    let hasVisibleContent = false;
    if (hasLyrics) {
      if (this.activeStyle?.layout) {
        // LAYOUT-OVERRIDE: the style owns the entire lyric draw. Skip the
        // renderer's normal per-line/per-word path.
        const words = this._buildLaidOutWords();
        this.activeStyle.layout(ctx, words, frameCtx);
        hasVisibleContent = true;
      } else {
        const visibleLines = this._resolveVisibleLines(time, renderW, renderH, baseFontSizePx);

        for (const vl of visibleLines) {
          hasVisibleContent = true;
          // Find the previous line's end time (in the same lane) to prevent
          // the first word of this line from fading in too early.
          let prevLineEnd: number | undefined;
          const prevGlobalIdx = vl.lineIndex - 1;
          if (prevGlobalIdx >= 0) {
            const prevLine = lyrics[prevGlobalIdx];
            if ((prevLine.laneIndex ?? 0) === vl.laneIndex) {
              prevLineEnd = prevLine.end;
            }
          }
          this._drawLine(ctx, vl, time, renderW, renderH, baseFontSizePx, audio, prevLineEnd);
        }
      }
    }

    // Attempt to Draw Track Title
    if (hasTrackTitle) {
      const didDraw = this._drawTrackTitle(ctx, time, renderW, renderH);
      if (didDraw) {
        hasVisibleContent = true;
      }
    }

    if (!hasVisibleContent) {
      return null;
    }

    // Full-frame overlay hook (letterbox bars, grain, scanlines) — drawn on top
    // of all lyric/title content.
    if (this.activeStyle?.drawOverlay) {
      ctx.save();
      this.activeStyle.drawOverlay(ctx, frameCtx);
      ctx.restore();
      hasVisibleContent = true;
    }

    // Full-frame post-process hook (dither / ASCII) — re-samples the finished
    // raster in place. Runs last.
    if (this.activeStyle?.postProcess) {
      ctx.save();
      this.activeStyle.postProcess(ctx, frameCtx);
      ctx.restore();
    }

    return this.canvas;
  }

  /**
   * Flatten all lyrics into a positioned word list for a layout-override style.
   * Timing/text/index only — placement is the style's responsibility.
   */
  private _buildLaidOutWords(): StyleLaidOutWord[] {
    const out: StyleLaidOutWord[] = [];
    const lyrics = this.config.lyrics ?? [];
    let globalIndex = 0;
    for (let lineIndex = 0; lineIndex < lyrics.length; lineIndex++) {
      const line = lyrics[lineIndex];
      const words = line.words ?? [];
      for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
        const w = words[wordIndex];
        out.push({
          text: w.text,
          start: w.start,
          end: w.end,
          globalIndex: globalIndex++,
          lineIndex,
          wordIndex,
        });
      }
    }
    return out;
  }

  /**
   * Public layout snapshot for the GPU Lyric FX path (Lyric FX Engine). Runs
   * the SAME `_resolveVisibleLines` layout the Canvas2D draw uses and returns
   * the visible lines with absolute per-word pixel positions, so the GPU path
   * shares one layout result instead of forking its own (LLD §7). Positions are
   * in the given backing-store pixel space (pass the same width/height used for
   * the GPU target). Word `px`/`py` are converted to absolute coords here.
   */
  getPositionedLines(time: number, width: number, height: number): PositionedLyricLine[] {
    this._syncCanvasRect(width, height);
    const visible = this._resolveVisibleLines(
      time,
      width,
      height,
      (this.config.theme.fontSize ?? 0.5) * (height / 10),
    );
    const centerX = width / 2;
    return visible.map((vl) => ({
      lineIndex: vl.lineIndex,
      laneIndex: vl.laneIndex,
      fontSizePx: vl.effectiveFontSizePx,
      words: vl.words.map((w) => ({
        text: w.text,
        start: w.start,
        end: w.end,
        wordIndex: w.wordIndex,
        globalCharStart: w.globalCharStart,
        /** Absolute pixel position of the word's left edge. */
        x: centerX + w.px,
        /** Absolute baseline Y of the word. */
        y: vl.cy + w.py,
        scale: w.scale,
      })),
    }));
  }

  /** Reset internal scroll state (useful after seeking) */
  resetScroll(): void {
    this._scrollOffset = 0;
    this._targetScrollOffset = 0;
    this._lastAnchorLineIndex = -1;
    this._lastRenderTime = -1;
  }

  /**
   * Recompute the deterministic canvas rect from the logical (pre-supersample)
   * width/height, detect an aspect-ratio change, and — on a real change —
   * invalidate the layout cache and reset scroll state (its offsets are in
   * old-space pixels, so carrying them across an orientation/format change
   * causes a visible jump). Called once per frame at the top of the layout
   * pass. `width`/`height` here are LOGICAL px (renderScale already divided out).
   */
  private _syncCanvasRect(width: number, height: number): CanvasRect {
    const aspect = height > 0 ? width / height : 0;
    const marginX = width * (EDGE_MARGIN_PCT / 100);
    const marginY = height * (EDGE_MARGIN_PCT / 100);
    this._canvasRect = {
      width,
      height,
      aspect,
      marginLeft: marginX,
      marginRight: marginX,
      marginTop: marginY,
      marginBottom: marginY,
    };

    // Relative aspect delta so the epsilon is orientation-agnostic.
    const changed =
      this._lastAspect > 0 &&
      aspect > 0 &&
      Math.abs(aspect - this._lastAspect) / this._lastAspect > ASPECT_EPSILON;
    if (changed) {
      this._aspectChanged = true;
      this.lastWidth = 0; // invalidate cached layout
      this.resetScroll(); // stale offsets are in the old aspect's pixel space
    }
    if (aspect > 0) this._lastAspect = aspect;
    return this._canvasRect;
  }

  /**
   * The last computed canvas rect (edges + aspect). Null until the first
   * render/getPositionedLines call. Consumers should treat this as the single
   * source of truth for canvas edges rather than re-deriving from width/height.
   */
  getCanvasRect(): CanvasRect | null {
    return this._canvasRect;
  }

  /**
   * Whether the aspect ratio changed since the last time this was read. Reading
   * it CLEARS the latch (read-once), so a caller polling each frame sees `true`
   * exactly on the frame after a resize that changed the aspect — e.g. the GPU
   * driver can force a glyph-buffer rebuild, or the app can re-fit UI.
   */
  didAspectChange(): boolean {
    const v = this._aspectChanged;
    this._aspectChanged = false;
    return v;
  }

  /** Destroy resources. */
  destroy(): void {
    // Nothing to explicitly destroy — OffscreenCanvas is GC'd
  }

  // ─── Private: Font Loading ─────────────────────────────────

  private async _loadFont(url: string): Promise<void> {
    if (this.fontLoadPromise) return;

    const familyName = `ThreniCustomFont_${Math.random().toString(36).substring(7)}`;
    this.fontLoadPromise = (async () => {
      try {
        const font = new FontFace(familyName, `url(${url})`);
        const loadedFont = await font.load();
        if (typeof document !== 'undefined' && 'fonts' in document) {
          document.fonts.add(loadedFont);
        } else if ('fonts' in self) {
          (self as unknown as { fonts: FontFaceSet }).fonts.add(loadedFont);
        }
        this.fontFamily = `"${familyName}", ${DEFAULT_FONT}`;
        this.fontLoaded = true;
        this.lastWidth = 0;
      } catch (err) {
        console.warn('[CanvasLyricRenderer] Font load failed, using fallback:', err);
        this.fontLoaded = true;
      }
    })();
  }

  private async _loadTrackTitleFont(url: string): Promise<void> {
    if (this.trackTitleFontLoadPromise) return;

    const familyName = `ThreniTrackTitleCustomFont_${Math.random().toString(36).substring(7)}`;
    this.trackTitleFontLoadPromise = (async () => {
      try {
        const font = new FontFace(familyName, `url(${url})`);
        const loadedFont = await font.load();
        if (typeof document !== 'undefined' && 'fonts' in document) {
          document.fonts.add(loadedFont);
        } else if ('fonts' in self) {
          (self as unknown as { fonts: FontFaceSet }).fonts.add(loadedFont);
        }
        this.trackTitleFontFamily = `"${familyName}", ${DEFAULT_FONT}`;
        this.lastWidth = 0;
      } catch (err) {
        console.warn('[CanvasLyricRenderer] Track Title Font load failed, using fallback:', err);
      }
    })();
  }

  // ─── Private: Per-lane font loading ────────────────────────

  /**
   * Returns the font family string for a given lane, loading if needed.
   * Falls back to the global font if no lane override or not yet loaded.
   */
  private _getLaneFontFamily(laneIndex: number): string {
    const laneStyle = this.config.theme.laneStyles?.[laneIndex];
    if (!laneStyle?.fontId) return this.fontFamily;

    const cached = this.laneFontCache.get(laneIndex);
    if (cached) return cached;

    if (!this.laneFontLoadPromises.has(laneIndex)) {
      const fontDef = this.fontRegistry.getById(laneStyle.fontId);
      if (!fontDef) return this.fontFamily;

      const familyName = `ThreniLaneFont_${laneIndex}_${Math.random().toString(36).substring(7)}`;
      const promise = (async () => {
        try {
          const font = new FontFace(familyName, `url(${fontDef.url})`);
          const loaded = await font.load();
          if (typeof document !== 'undefined' && 'fonts' in document) {
            document.fonts.add(loaded);
          } else if ('fonts' in self) {
            (self as unknown as { fonts: FontFaceSet }).fonts.add(loaded);
          }
          this.laneFontCache.set(laneIndex, `"${familyName}", ${DEFAULT_FONT}`);
          this.lastWidth = 0; // invalidate layout
        } catch (err) {
          console.warn(`[CanvasLyricRenderer] Lane ${laneIndex} font load failed:`, err);
        }
      })();
      this.laneFontLoadPromises.set(laneIndex, promise);
    }

    return this.fontFamily; // fallback until loaded
  }

  /**
   * Resolve the effective style for a given lane by merging lane overrides
   * on top of the global theme defaults.
   */
  private _resolveLaneStyle(laneIndex: number): {
    colorPre: string;
    colorActive: string;
    colorPost: string;
    outlineColor: string;
    glowEnabled: boolean;
    glowColor: string;
    glowIntensity: number;
    fontFamily: string;
    fontSize?: number;
    letterSpacing: number;
    animIn: LyricAnimationConfig;
    animOut: LyricAnimationConfig;
    highlightFadeIn?: number;
    highlightFadeOut?: number;
  } {
    const { theme } = this.config;
    const lane: LineStyleOverride | undefined = theme.laneStyles?.[laneIndex];

    const colorPre =
      lane?.colorPre ?? lane?.colors?.pre ?? theme.colorPre ?? theme.colors?.pre ?? '#555555';
    const colorActive =
      lane?.colorActive ??
      lane?.colors?.active ??
      theme.colorActive ??
      theme.colors?.active ??
      '#ffffff';
    const colorPost =
      lane?.colorPost ?? lane?.colors?.post ?? theme.colorPost ?? theme.colors?.post ?? '#999999';
    const outlineColor = lane?.outlineColor ?? theme.outlineColor ?? '#000000';
    const glowEnabled = lane?.glowEnabled ?? theme.glowEnabled ?? false;
    const glowColor = lane?.glowColor ?? theme.glowColor ?? '#ffffff';
    const glowIntensity = lane?.glowIntensity ?? theme.glowIntensity ?? 0.3;
    const fontFamily = lane?.fontId ? this._getLaneFontFamily(laneIndex) : this.fontFamily;
    const fontSize = lane?.fontSize;
    const letterSpacing = lane?.letterSpacing ?? theme.letterSpacing ?? 0;
    const animIn = lane?.animationIn ?? this.animIn;
    const animOut = lane?.animationOut ?? this.animOut;
    const highlightFadeIn = lane?.highlightFadeIn ?? theme.highlightFadeIn;
    const highlightFadeOut = lane?.highlightFadeOut ?? theme.highlightFadeOut;

    return {
      colorPre,
      colorActive,
      colorPost,
      outlineColor,
      glowEnabled,
      glowColor,
      glowIntensity,
      fontFamily,
      fontSize,
      letterSpacing,
      animIn,
      animOut,
      highlightFadeIn,
      highlightFadeOut,
    };
  }

  // ─── Private: Resolve visible lines + layout ───────────────

  private _resolveVisibleLines(
    time: number,
    canvasW: number,
    canvasH: number,
    fontSizePx: number,
  ): VisibleLine[] {
    const { lyrics, theme } = this.config;
    const vertPos = this.config.verticalPosition ?? theme.verticalPosition ?? 10;
    const userLaneCount = this.config.laneCount ?? theme.laneCount ?? 1;

    const result: VisibleLine[] = [];
    // Wrap column width as a fraction of canvas width (clamped 10–100%). Text
    // auto-wraps to fit this column at any aspect ratio. Per-lane overrides can
    // widen/narrow it below.
    const baseWrapPct = Math.max(10, Math.min(100, this.config.wrapWidth ?? theme.wrapWidth ?? 90));

    for (let i = 0; i < lyrics.length; i++) {
      const line = lyrics[i];
      const firstWordStart = line.words?.[0]?.start ?? line.start;
      const fadeStart = firstWordStart - this.fadeInDuration - LAYOUT_BUFFER_SECONDS;
      const fadeEnd = line.end + this.fadeOutDuration + LAYOUT_BUFFER_SECONDS;

      if (time >= fadeStart && time <= fadeEnd) {
        const laneIdx = line.laneIndex ?? 0;
        const laneStyle = this._resolveLaneStyle(laneIdx);
        const laneOverride = theme.laneStyles?.[laneIdx];
        const effectiveFontSizePx =
          laneStyle.fontSize != null ? laneStyle.fontSize * (canvasH / 10) : fontSizePx;

        // Per-line wrap column (lane override → theme/config default) and
        // horizontal anchor. The column lives INSIDE a buffered content box
        // (EDGE_MARGIN_PCT clear on each side); wrapWidth is the fraction of
        // that usable width the column occupies, so 100 reaches the buffer edge.
        const wrapPct = Math.max(10, Math.min(100, laneOverride?.wrapWidth ?? baseWrapPct));
        const marginPx = canvasW * (EDGE_MARGIN_PCT / 100);
        const usableWidth = canvasW - marginPx * 2;
        const maxTextWidth = usableWidth * (wrapPct / 100);
        const hAnchor =
          laneOverride?.horizontalPosition ??
          this.config.horizontalPosition ??
          theme.horizontalPosition ??
          'center';

        const words = this._layoutLine(
          line,
          effectiveFontSizePx,
          maxTextWidth,
          laneStyle.fontFamily,
          laneStyle.letterSpacing,
          hAnchor,
          canvasW,
          marginPx,
        );
        const rowCount = words.length > 0 ? Math.max(...words.map((w) => w.row)) + 1 : 1;

        result.push({
          line,
          lineIndex: i,
          words,
          cy: 0,
          rowCount,
          laneIndex: laneIdx,
          effectiveFontSizePx,
        });
      }
    }

    if (result.length === 0) return result;

    const lineSpacing = theme.lineSpacing ?? 1.35;
    const lineGapFor = (vl: VisibleLine) => vl.effectiveFontSizePx * lineSpacing;

    if (userLaneCount > 1) {
      const normalizedPos = Math.max(0, Math.min(100, vertPos)) / 100;
      const regionTop = canvasH * (0.15 + (1 - normalizedPos) * 0.35);
      const regionBottom = canvasH * (0.85 - normalizedPos * 0.35);
      const regionHeight = regionBottom - regionTop;
      const laneGap = regionHeight / userLaneCount;

      for (let lane = 0; lane < userLaneCount; lane++) {
        const laneLines = result.filter((vl) => vl.laneIndex === lane);
        if (laneLines.length === 0) continue;

        const laneVertOverride = this.config.theme.laneStyles?.[lane]?.verticalPosition;
        let laneCenterY: number;
        if (laneVertOverride != null) {
          const normV = Math.max(0, Math.min(100, laneVertOverride)) / 100;
          laneCenterY = canvasH * (0.85 - normV * 0.7);
        } else {
          laneCenterY = regionTop + (lane + 0.5) * laneGap;
        }

        let anchorIdx = -1;
        for (let i = laneLines.length - 1; i >= 0; i--) {
          const line = laneLines[i].line;
          const fadeStart = line.start - this.fadeInDuration;
          if (time >= fadeStart && time <= line.end) {
            anchorIdx = i;
            break;
          }
        }

        if (anchorIdx < 0) {
          let bestIdx = 0;
          let bestEnd = -Infinity;
          for (let i = 0; i < laneLines.length; i++) {
            if (laneLines[i].line.end <= time && laneLines[i].line.end > bestEnd) {
              bestEnd = laneLines[i].line.end;
              bestIdx = i;
            }
          }
          anchorIdx = bestIdx;
        }

        const anchorBlock = laneLines[anchorIdx];
        const anchorLineGap = lineGapFor(anchorBlock);
        anchorBlock.cy = laneCenterY - ((anchorBlock.rowCount - 1) * anchorLineGap) / 2;

        const blockH = (vl: VisibleLine) => vl.rowCount * lineGapFor(vl);

        for (let i = anchorIdx - 1; i >= 0; i--) {
          laneLines[i].cy = laneLines[i + 1].cy - blockH(laneLines[i]);
        }
        for (let i = anchorIdx + 1; i < laneLines.length; i++) {
          laneLines[i].cy = laneLines[i - 1].cy + blockH(laneLines[i - 1]);
        }
      }

      return result;
    }

    // ── Single-Lane Layout (smooth upward-only scroll) ──

    const autoLanes = autoAssignLanes(
      result.map((vl) => vl.line),
      4,
    );
    for (let i = 0; i < result.length; i++) {
      const assigned = autoLanes.find((l) => l.id === result[i].line.id);
      if (assigned) {
        result[i].laneIndex = assigned.laneIndex ?? 0;
      }
    }

    const blockH = (vl: VisibleLine) => vl.rowCount * lineGapFor(vl);

    let anchorIdx = -1;

    for (let i = result.length - 1; i >= 0; i--) {
      const line = result[i].line;
      const fadeStart = line.start - this.fadeInDuration;
      if (time >= fadeStart && time <= line.end) {
        anchorIdx = i;
        break;
      }
    }

    if (anchorIdx < 0) {
      let bestIdx = 0;
      let bestEnd = -Infinity;
      for (let i = 0; i < result.length; i++) {
        if (result[i].line.end <= time && result[i].line.end > bestEnd) {
          bestEnd = result[i].line.end;
          bestIdx = i;
        }
      }
      anchorIdx = bestIdx;
    }

    // Hold the scroll while the OUTGOING line is still fading out. When a new
    // line's fade-in overlaps the previous line's fade-out, the anchor would
    // jump forward and displace the whole stack upward mid-fade — the previous
    // line slides away before it has finished fading. Instead, keep the anchor
    // on the previous (still-fading-out) line until its fade-out window closes
    // (time > prevLine.end + fadeOutDuration), so nothing displaces until the
    // outgoing line is fully gone. Walk back across any chain of consecutive
    // still-fading-out predecessors so a fast run of short lines does not leak a
    // one-line displacement per step.
    while (anchorIdx > 0) {
      const prev = result[anchorIdx - 1];
      if (time <= prev.line.end + this.fadeOutDuration) {
        anchorIdx -= 1;
      } else {
        break;
      }
    }

    const anchorBlock = result[anchorIdx];
    const currentAnchorGlobalIdx = anchorBlock.lineIndex;

    // Position Y interpolates the anchor block ACROSS THE FULL SAFE AREA by its
    // own extent, not by centring on a fixed fraction — otherwise pos=0 ("bottom")
    // only reached ~85% and the lower ~15-40% of the canvas went unused. The
    // safe area is [marginY, canvasH - marginY] (10% inset each side). pos=0 pins
    // the block's BOTTOM baseline to the bottom edge; pos=100 pins its TOP to the
    // top edge; pos=50 centres. `cy` is the block's top-row baseline.
    const normalizedPos = Math.max(0, Math.min(100, vertPos)) / 100;
    const marginYAnchor = canvasH * (EDGE_MARGIN_PCT / 100);
    const anchorGap = lineGapFor(anchorBlock);
    const blockHeight = (anchorBlock.rowCount - 1) * anchorGap; // top baseline → bottom baseline
    const cyAtBottom = canvasH - marginYAnchor - blockHeight; // block bottom baseline at safe bottom
    const cyAtTop = marginYAnchor + anchorGap; // block top (one ascent below safe top)
    // pos 0 → bottom, pos 1 → top (invert since higher pos = higher on screen).
    const baseAnchorCy = cyAtBottom + (cyAtTop - cyAtBottom) * normalizedPos;

    let cumulativeHeightToAnchor = 0;
    for (let i = 0; i < currentAnchorGlobalIdx; i++) {
      const matchingVl = result.find((vl) => vl.lineIndex === i);
      if (matchingVl) {
        cumulativeHeightToAnchor += blockH(matchingVl);
      } else {
        const approxGap = anchorBlock.effectiveFontSizePx * lineSpacing;
        const lineText = lyrics[i]?.text ?? '';
        const estimatedRows = Math.max(1, Math.ceil(lineText.length / 40));
        cumulativeHeightToAnchor += estimatedRows * approxGap;
      }
    }

    this._targetScrollOffset = Math.max(this._targetScrollOffset, cumulativeHeightToAnchor);

    const dt = this._lastRenderTime >= 0 ? Math.max(0, time - this._lastRenderTime) : 0;
    const isSeekBack = this._lastRenderTime >= 0 && time < this._lastRenderTime - 0.1;
    this._lastRenderTime = time;

    if (this._lastAnchorLineIndex < 0 || isSeekBack || dt > 2.0) {
      this._scrollOffset = this._targetScrollOffset;
    } else {
      const lerpSpeed = 8.0; // higher = snappier
      const alpha = 1 - Math.exp(-lerpSpeed * Math.max(dt, 1 / 60));
      const interpolated =
        this._scrollOffset + (this._targetScrollOffset - this._scrollOffset) * alpha;
      this._scrollOffset = Math.max(this._scrollOffset, interpolated);
    }

    this._lastAnchorLineIndex = currentAnchorGlobalIdx;

    const scrollDelta = this._targetScrollOffset - this._scrollOffset;
    anchorBlock.cy = baseAnchorCy + scrollDelta;

    for (let i = anchorIdx - 1; i >= 0; i--) {
      result[i].cy = result[i + 1].cy - blockH(result[i]);
    }

    for (let i = anchorIdx + 1; i < result.length; i++) {
      result[i].cy = result[i - 1].cy + blockH(result[i - 1]);
    }

    // ── Vertical safe-area clamp (anchor block only) ──
    // `cy` is a block's TOP-row baseline. A wrapped (multi-row) ANCHOR block can
    // push its bottom row past the canvas — unacceptable, so keep the anchor
    // inside [marginY, canvasH - marginY] and shift every line by the same delta
    // to preserve relative stacking. Scope this to the ANCHOR block ONLY: past
    // and future lines are MEANT to scroll off the top/bottom edges, so including
    // them here would drag the current line toward centre and defeat Position Y
    // at the extremes (Y=0 bottom / Y=100 top). Bottom wins; a block taller than
    // the safe area pins its top.
    const marginY = canvasH * (EDGE_MARGIN_PCT / 100);
    const gap = lineGapFor(anchorBlock);
    const anchorLast = anchorBlock.cy + (anchorBlock.rowCount - 1) * gap;
    const anchorTop = anchorBlock.cy - gap; // one ascent above the first baseline
    let clampDelta = 0;
    if (anchorLast > canvasH - marginY) {
      clampDelta = canvasH - marginY - anchorLast; // move up so the lowest baseline fits
    }
    if (anchorTop + clampDelta < marginY) {
      clampDelta = marginY - anchorTop; // taller than safe area → pin top
    }
    if (clampDelta !== 0) {
      for (const vl of result) vl.cy += clampDelta;
    }

    return result;
  }

  /** Measure words using Canvas2D and perform word wrapping. */
  private _layoutLine(
    line: LyricLineData,
    fontSizePx: number,
    maxWidth: number,
    fontFamily?: string,
    letterSpacing?: number,
    hAnchor: 'left' | 'center' | 'right' = 'center',
    canvasW = 0,
    marginPx = 0,
  ): MeasuredWord[] {
    const ctx = this.ctx;
    const theme = this.config.theme;
    const fontWeight = theme.fontWeight ?? 700;
    const effectiveFont = fontFamily ?? this.fontFamily;
    ctx.font = `${fontWeight} ${fontSizePx}px ${effectiveFont}`;

    const lsPx = (letterSpacing ?? 0) * fontSizePx;
    if ('letterSpacing' in ctx) {
      (ctx as CanvasRenderingContext2D).letterSpacing = `${lsPx}px`;
    }
    if ('fontKerning' in ctx) {
      (ctx as CanvasRenderingContext2D).fontKerning = 'none';
    }

    const wordList = this._getWordList(line);
    if (wordList.length === 0) return [];

    const baseSpaceWidth = Math.max(ctx.measureText('m').width * 0.4, fontSizePx * 0.25);
    const spaceWidth = baseSpaceWidth * (theme.wordSpacing ?? 1.0);
    const measured: MeasuredWord[] = [];

    let globalCharIdx = 0;
    for (let i = 0; i < wordList.length; i++) {
      const w = wordList[i];
      const metrics = ctx.measureText(w.text);
      measured.push({
        text: w.text,
        width: metrics.width,
        start: w.start,
        end: w.end,
        row: 0,
        px: 0,
        py: 0,
        wordIndex: i,
        globalCharStart: globalCharIdx,
        scale: 1,
      });
      globalCharIdx += w.text.length;
    }

    let currentX = 0;
    let currentRow = 0;
    let rowStartIdx = 0;
    // Wrap at the full column width. The 10% edge buffer is already applied by
    // the caller (marginPx), so no extra shrink here — that inset was the source
    // of the "unused 25% on the side" the anchor could never reach.
    const safeMax = maxWidth;

    for (let i = 0; i < measured.length; i++) {
      let wordW = measured[i].width;

      if (currentX > 0 && currentX + wordW > safeMax && i > rowStartIdx) {
        currentRow++;
        currentX = 0;
        rowStartIdx = i;
      }

      if (wordW > safeMax) {
        measured[i].scale = safeMax / wordW;
        wordW = safeMax;
      }

      measured[i].row = currentRow;
      measured[i].px = currentX + wordW / 2; // center of word
      currentX += wordW + spaceWidth;
    }

    const totalRows = currentRow + 1;
    // Anchor rows inside the buffered content box, in the centre-relative space
    // `px` lives in (draw does canvasCentre + px). The usable box spans
    // [-usableHalf, +usableHalf]; the 10% edge margin is `marginPx`. Left/right
    // align rows to the box edge (so they reach the buffer, not a stale inset),
    // centre keeps them centred. Falls back to symmetric centring when the
    // caller did not pass canvas geometry (canvasW=0).
    const usableHalf = canvasW > 0 ? canvasW / 2 - marginPx : maxWidth / 2;
    for (let row = 0; row < totalRows; row++) {
      const rowWords = measured.filter((w) => w.row === row);
      if (rowWords.length === 0) continue;

      const lastWord = rowWords[rowWords.length - 1];
      const rowWidth = lastWord.px + (lastWord.width * lastWord.scale) / 2;
      let offset: number;
      if (hAnchor === 'left') {
        offset = -usableHalf;
      } else if (hAnchor === 'right') {
        offset = usableHalf - rowWidth;
      } else {
        offset = -rowWidth / 2;
      }

      for (const w of rowWords) {
        w.px += offset;
      }
    }

    const lineGap = fontSizePx * (this.config.theme.lineSpacing ?? 1.35);
    for (const w of measured) {
      w.py = w.row * lineGap;
    }

    return measured;
  }

  private _getWordList(line: LyricLineData): Word[] {
    if (line.words && line.words.length > 0) return line.words;
    const splits = line.text.split(/\s+/).filter((w) => w);
    if (splits.length === 0) return [];
    const wordDuration = (line.end - line.start) / splits.length;
    return splits.map((text, i) => ({
      text,
      start: line.start + i * wordDuration,
      end: line.start + (i + 1) * wordDuration,
    }));
  }

  // ─── Private: Draw a line ──────────────────────────────────

  private _drawLine(
    ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    vl: VisibleLine,
    time: number,
    canvasW: number,
    canvasH: number,
    fontSizePx: number,
    audio?: FrameAudioMetrics,
    prevLineEnd?: number,
  ): void {
    const { theme } = this.config;
    const fontWeight = theme.fontWeight ?? 700;
    const centerX = canvasW / 2;

    const laneStyle = this._resolveLaneStyle(vl.laneIndex);
    const effectiveFontSizePx = vl.effectiveFontSizePx;

    const lsPx = laneStyle.letterSpacing * effectiveFontSizePx;
    if ('letterSpacing' in ctx) {
      (ctx as CanvasRenderingContext2D).letterSpacing = `${lsPx}px`;
    }
    if ('fontKerning' in ctx) {
      (ctx as CanvasRenderingContext2D).fontKerning = 'none';
    }

    const blockTopY = vl.cy;

    // ─── Line-level style modifier (e.g. depth-stack DOF) ───
    // Applied as an outer transform+blur around the whole line's draw; its
    // opacity multiplies into each word's alpha (lineOpacityMul). Uses a media-
    // clock role + signed offset from the current anchor line, so it is
    // export-parity by construction.
    let lineOpacityMul = 1;
    let lineModApplied = false;
    if (this.activeStyle?.modifyLine) {
      const role: 'past' | 'current' | 'future' =
        time > vl.line.end ? 'past' : time < vl.line.start ? 'future' : 'current';
      const lineMod = this.activeStyle.modifyLine({
        time,
        audio,
        lineStart: vl.line.start,
        lineEnd: vl.line.end,
        role,
        lineOffset: vl.lineIndex - this._lastAnchorLineIndex,
      });
      const lScale = lineMod.scale ?? 1;
      const lBlur = lineMod.blurPx ?? 0;
      lineOpacityMul = lineMod.opacityMul ?? 1;
      if (lScale !== 1 || lBlur > 0) {
        ctx.save();
        lineModApplied = true;
        if (lBlur > 0 && 'filter' in ctx) {
          (ctx as CanvasRenderingContext2D).filter = `blur(${lBlur}px)`;
        }
        if (lScale !== 1) {
          // Scale about the line's centre (centerX, blockTopY at row 0).
          const cx = centerX;
          const cy = blockTopY;
          ctx.translate(cx, cy);
          ctx.scale(lScale, lScale);
          ctx.translate(-cx, -cy);
        }
      } else if (lineOpacityMul !== 1) {
        lineModApplied = false; // opacity-only: folded into word alphas, no save
      }
    }

    const useCharMode =
      laneStyle.animIn.granularity === 'char' || laneStyle.animOut.granularity === 'char';

    const totalChars = vl.words.reduce((sum, w) => sum + w.text.length, 0);
    const totalWords = vl.words.length;

    const {
      colorPre,
      colorActive,
      colorPost,
      outlineColor,
      glowEnabled,
      glowColor,
      glowIntensity,
      highlightFadeIn,
      highlightFadeOut,
    } = laneStyle;

    for (let wi = 0; wi < vl.words.length; wi++) {
      const word = vl.words[wi];
      const prevWord = wi > 0 ? vl.words[wi - 1] : undefined;

      if (useCharMode) {
        this._drawWordCharByChar(
          ctx,
          word,
          vl.line,
          time,
          centerX,
          blockTopY,
          effectiveFontSizePx,
          fontWeight,
          colorPre,
          colorActive,
          colorPost,
          outlineColor,
          glowEnabled,
          glowColor,
          glowIntensity,
          totalChars,
          totalWords,
          laneStyle.fontFamily,
          laneStyle.animIn,
          laneStyle.animOut,
          laneStyle.letterSpacing,
          audio,
          highlightFadeIn,
          highlightFadeOut,
          prevWord?.end,
          prevWord?.start,
          wi === 0 ? prevLineEnd : undefined,
        );
      } else {
        const anim = calculateWordAnimation({
          currentTime: time,
          wordStart: word.start,
          wordEnd: word.end,
          prevWordEnd: prevWord?.end,
          prevWordStart: prevWord?.start,
          prevLineEnd: wi === 0 ? prevLineEnd : undefined,
          lineStart: vl.line.start,
          lineEnd: vl.line.end,
          animationIn: laneStyle.animIn,
          animationOut: laneStyle.animOut,
          staggerIndex: word.wordIndex,
          totalItems: totalWords,
          highlightFadeIn,
          highlightFadeOut,
        });

        if (!anim.isVisible) continue;

        const ha = anim.highlightAlpha;
        const isPast = time >= word.end;
        let wordColor: string;
        if (ha > 0 && !isPast) {
          wordColor = lerpColor(colorPre, colorActive, ha);
        } else if (isPast && ha > 0) {
          wordColor = lerpColor(colorPost, colorActive, ha);
        } else {
          wordColor = isPast ? colorPost : colorPre;
        }

        const isActive = time >= word.start && time < word.end;
        let audioScale = 1.0;
        if (isActive && theme.wordAudioReactive && audio) {
          audioScale = 1.0 + audio.energy * 0.15;
        }

        // ─── Style modifier (audio-reactive, per-word) ───
        // Resolved from theme.styleId; identity when no style is active.
        const styleMod: StyleWordModifier = this.activeStyle
          ? this.activeStyle.modifyWord({
              time,
              audio,
              wordStart: word.start,
              wordEnd: word.end,
              wordIndex: word.wordIndex,
              wordCount: totalWords,
              isActive,
            })
          : {};
        const styleScale = styleMod.scaleMul ?? 1;
        const styleOpacity = (styleMod.opacityMul ?? 1) * lineOpacityMul;

        const x =
          centerX +
          word.px +
          anim.offsetX * effectiveFontSizePx +
          (styleMod.offsetXEm ?? 0) * effectiveFontSizePx;
        const y =
          blockTopY +
          word.py +
          effectiveFontSizePx * 0.5 +
          anim.offsetY * effectiveFontSizePx +
          (styleMod.offsetYEm ?? 0) * effectiveFontSizePx;

        const wDur = word.end - word.start;
        const wordProgress = wDur > 0 ? Math.max(0, Math.min(1, (time - word.start) / wDur)) : 0;
        if (glowEnabled && wordProgress > 0 && wordProgress <= 1 && isActive) {
          const glowProgress = Math.sin(wordProgress * Math.PI); // 0→1→0 bell curve
          ctx.save();
          ctx.font = `${fontWeight} ${effectiveFontSizePx * anim.scale * audioScale * styleScale * word.scale}px ${laneStyle.fontFamily}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const offset = 10000;
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = effectiveFontSizePx * (0.15 + glowIntensity * 0.6) * glowProgress;
          ctx.shadowOffsetY = -offset;
          ctx.shadowOffsetX = 0;
          ctx.globalAlpha = anim.opacity * styleOpacity * glowProgress * 0.7;
          ctx.fillStyle = glowColor;
          ctx.fillText(word.text, x, y + offset);
          ctx.restore();
        }

        ctx.save();
        ctx.globalAlpha = anim.opacity * styleOpacity;
        ctx.font = `${fontWeight} ${effectiveFontSizePx * anim.scale * audioScale * styleScale * word.scale}px ${laneStyle.fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (styleMod.fontVariationSettings && 'fontVariationSettings' in ctx) {
          (ctx as unknown as { fontVariationSettings: string }).fontVariationSettings =
            styleMod.fontVariationSettings;
        }
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = effectiveFontSizePx * 0.05;
        ctx.lineJoin = 'round';
        ctx.strokeText(word.text, x, y);
        ctx.fillStyle = wordColor;
        ctx.fillText(word.text, x, y);
        ctx.restore();
      }
    }

    // Close the outer line-modifier save (scale/blur), if opened.
    if (lineModApplied) {
      ctx.restore();
    }
  }

  /** Draw a word character by character (for char-level stagger animations). */
  private _drawWordCharByChar(
    ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    word: MeasuredWord,
    line: LyricLineData,
    time: number,
    centerX: number,
    blockTopY: number,
    fontSizePx: number,
    fontWeight: number,
    colorPre: string,
    colorActive: string,
    colorPost: string,
    outlineColor: string,
    glowEnabled: boolean,
    glowColor: string,
    glowIntensity: number,
    totalChars: number,
    totalWords: number,
    laneFontFamily: string,
    laneAnimIn: LyricAnimationConfig,
    laneAnimOut: LyricAnimationConfig,
    letterSpacingEm: number,
    _audio?: FrameAudioMetrics,
    highlightFadeIn?: number,
    highlightFadeOut?: number,
    prevWordEnd?: number,
    prevWordStart?: number,
    prevLineEnd?: number,
  ): void {
    const text = word.text;
    if (text.length === 0) return;

    ctx.font = `${fontWeight} ${fontSizePx * word.scale}px ${laneFontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lsExtra = letterSpacingEm * fontSizePx;

    const charWidths: number[] = [];
    for (const ch of text) {
      charWidths.push(ctx.measureText(ch).width * word.scale);
    }
    const totalWidth =
      charWidths.reduce((a, b) => a + b, 0) + lsExtra * Math.max(0, text.length - 1);
    const startX = centerX + word.px - totalWidth / 2;
    const baseY = blockTopY + word.py + fontSizePx * 0.5;
    const isWordPast = time >= word.end;

    let charX = startX;
    for (let i = 0; i < text.length; i++) {
      const anim = calculateWordAnimation({
        currentTime: time,
        wordStart: word.start,
        wordEnd: word.end,
        prevWordEnd,
        prevWordStart,
        prevLineEnd,
        lineStart: line.start,
        lineEnd: line.end,
        animationIn: laneAnimIn,
        animationOut: laneAnimOut,
        staggerIndex:
          laneAnimIn.granularity === 'char' || laneAnimOut.granularity === 'char'
            ? i
            : word.wordIndex,
        totalItems:
          laneAnimIn.granularity === 'char' || laneAnimOut.granularity === 'char'
            ? text.length
            : totalWords,
        highlightFadeIn,
        highlightFadeOut,
      });

      if (!anim.isVisible) {
        charX += charWidths[i] + lsExtra;
        continue;
      }

      const cx = charX + charWidths[i] / 2 + anim.offsetX * fontSizePx;
      const cy = baseY + anim.offsetY * fontSizePx;

      const ha = anim.highlightAlpha;
      let charColor: string;
      if (ha > 0 && !isWordPast) {
        charColor = lerpColor(colorPre, colorActive, ha);
      } else if (isWordPast && ha > 0) {
        charColor = lerpColor(colorPost, colorActive, ha);
      } else {
        charColor = isWordPast ? colorPost : colorPre;
      }

      const wDur = word.end - word.start;
      const wordProgress = wDur > 0 ? Math.max(0, Math.min(1, (time - word.start) / wDur)) : 0;
      const isCharWordActive = time >= word.start && time < word.end;
      if (glowEnabled && wordProgress > 0 && isCharWordActive) {
        const glowProgress = Math.sin(wordProgress * Math.PI);
        ctx.save();
        ctx.font = `${fontWeight} ${fontSizePx * word.scale}px ${laneFontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const offset = 10000;
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = fontSizePx * (0.15 + glowIntensity * 0.6) * glowProgress;
        ctx.shadowOffsetY = -offset;
        ctx.shadowOffsetX = 0;
        ctx.globalAlpha = anim.opacity * glowProgress * 0.7;
        ctx.fillStyle = glowColor;
        ctx.fillText(text[i], cx, cy + offset);
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = anim.opacity;

      if (anim.scale !== 1) {
        ctx.translate(cx, cy);
        ctx.scale(anim.scale, anim.scale);
        ctx.translate(-cx, -cy);
      }

      ctx.font = `${fontWeight} ${fontSizePx * word.scale}px ${laneFontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = outlineColor;
      ctx.lineWidth = fontSizePx * 0.05;
      ctx.lineJoin = 'round';
      ctx.strokeText(text[i], cx, cy);
      ctx.fillStyle = charColor;
      ctx.fillText(text[i], cx, cy);

      ctx.restore();

      charX += charWidths[i] + lsExtra;
    }
  }

  // ─── Private: Draw Track Title ───────────────────────────────

  private _drawTrackTitle(
    ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    time: number,
    canvasW: number,
    canvasH: number,
  ): boolean {
    const { trackTitle, trackTitleConfig, trackStartTime = 0 } = this.config;
    if (!trackTitle || !trackTitleConfig) return false;

    const { delay = 0.5, duration = 3.0 } = trackTitleConfig;
    const fadeDuration = 0.5;

    const relativeTime = time - trackStartTime;

    if (relativeTime < delay || relativeTime > delay + duration + fadeDuration) return false;

    let opacity = 1.0;
    if (relativeTime < delay + fadeDuration) {
      opacity = (relativeTime - delay) / fadeDuration;
    } else if (relativeTime > delay + duration) {
      opacity = 1.0 - (relativeTime - (delay + duration)) / fadeDuration;
    }
    opacity = Math.max(0, Math.min(1, opacity));

    if (opacity <= 0.01) return false;

    const { positionX = 50, positionY = 10, fontSize = 0.4, color = '#ffffff' } = trackTitleConfig;

    const px = (positionX / 100) * canvasW;
    const py = (positionY / 100) * canvasH;

    const fontSizePx = fontSize * (canvasH / 10);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.font = `600 ${fontSizePx}px ${this.trackTitleFontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = color;
    ctx.fillText(trackTitle, px, py);

    ctx.restore();
    return true;
  }
}

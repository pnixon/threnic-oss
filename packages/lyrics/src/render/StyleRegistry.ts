/**
 * Lyric style seam.
 *
 * A "style" is a named, audio-reactive modifier applied on top of the base
 * per-word animation the renderer already computes. It does NOT replace layout
 * or timing — it contributes an additive/multiplicative visual delta per word
 * (extra scale, pixel offset, opacity multiplier, and optional CSS
 * `font-variation-settings` for variable fonts). This keeps styles small,
 * unit-testable, and export-parity by construction (they read only the
 * per-frame audio/time contract, never a wall clock).
 *
 * Styles are registered in a StyleRegistry (mirroring the FontRegistry seam)
 * and selected via `LyricTheme.styleId`. Absent/unknown id ⇒ no modifier
 * (today's behavior preserved exactly).
 */
import type { FrameAudioMetrics } from './FrameAudio';

/** Inputs a style sees for one word on one frame. Pure data, no DOM. */
export interface StyleWordContext {
  /** Media clock, seconds. The only clock a style may read. */
  time: number;
  /** Per-frame audio metrics (0..1-ish), or undefined when unavailable. */
  audio?: FrameAudioMetrics;
  /** Word start/end in seconds. */
  wordStart: number;
  wordEnd: number;
  /** Index of this word within its line. */
  wordIndex: number;
  /** Number of words in the line. */
  wordCount: number;
  /** True while `time` is within [wordStart, wordEnd]. */
  isActive: boolean;
}

/** The visual delta a style contributes for one word. All fields optional. */
export interface StyleWordModifier {
  /** Multiplicative scale applied on top of the base word scale (default 1). */
  scaleMul?: number;
  /** Additional X offset in em units (multiplied by font size). */
  offsetXEm?: number;
  /** Additional Y offset in em units (multiplied by font size). */
  offsetYEm?: number;
  /** Multiplicative opacity applied on top of base opacity (default 1). */
  opacityMul?: number;
  /**
   * CSS font-variation-settings string (e.g. `"wght" 720, "wdth" 110`) applied
   * to this word's draw. Requires a variable font; ignored otherwise.
   */
  fontVariationSettings?: string;
}

/** Temporal role of a line relative to the current playback time. */
export type LineRole = 'past' | 'current' | 'future';

/** Inputs a style sees for one line on one frame. */
export interface StyleLineContext {
  /** Media clock, seconds. */
  time: number;
  /** Per-frame audio metrics (0..1-ish), or undefined when unavailable. */
  audio?: FrameAudioMetrics;
  /** Line start/end in seconds. */
  lineStart: number;
  lineEnd: number;
  /** 'current' while time ∈ [start,end]; 'past' after; 'future' before. */
  role: LineRole;
  /**
   * Signed temporal distance from the current line, in "line steps": 0 for the
   * current line, +1 for the next visible line, -1 for the previous, etc.
   * Derived by the renderer from the visible line ordering in the same lane.
   */
  lineOffset: number;
}

/** The visual delta a style contributes for one whole line. All fields optional. */
export interface StyleLineModifier {
  /** Uniform scale about the line's centre (default 1). */
  scale?: number;
  /** Multiplicative opacity for the whole line (default 1). */
  opacityMul?: number;
  /** Gaussian blur radius in pixels applied to the line (default 0 = sharp). */
  blurPx?: number;
}

/** A word positioned by the renderer's layout, given to a layout-override style. */
export interface StyleLaidOutWord {
  /** The word text. */
  text: string;
  /** Word start/end in seconds. */
  start: number;
  end: number;
  /** Global index of the word across all lyrics. */
  globalIndex: number;
  /** Index of the line this word belongs to. */
  lineIndex: number;
  /** Index of the word within its line. */
  wordIndex: number;
}

/** Frame context for a full-frame hook (layout / overlay / post-process). */
export interface StyleFrameContext {
  /** Media clock, seconds. */
  time: number;
  /** Per-frame audio metrics (0..1-ish), or undefined when unavailable. */
  audio?: FrameAudioMetrics;
  /** Backing-store width in device pixels (already super-sampled). */
  width: number;
  /** Backing-store height in device pixels. */
  height: number;
  /** Super-sampling factor the renderer applied (art constants scale by this). */
  renderScale: number;
  /** Base font size in device pixels the renderer computed for this frame. */
  fontSizePx: number;
}

/**
 * Minimal 2D context surface a style may draw with. Structurally satisfied by
 * both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D, so
 * styles stay DOM-agnostic and testable with a fake context.
 */
export type StyleCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface LyricStyle {
  /** Stable identifier referenced by LyricTheme.styleId. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Compute the per-word visual delta for the given frame context. */
  modifyWord(ctx: StyleWordContext): StyleWordModifier;
  /**
   * Optional per-line visual delta, applied by the renderer around the whole
   * line's draw (scale about the line centre, blur, opacity). Styles that only
   * need per-word behaviour omit this. Used by e.g. depth-stack, which focuses
   * the current line and blurs/dims past & future lines.
   */
  modifyLine?(ctx: StyleLineContext): StyleLineModifier;

  /**
   * Optional LAYOUT-OVERRIDE hook. When present, the renderer SKIPS its normal
   * per-line/per-word drawing entirely and hands the style the full word list
   * plus the canvas. The style is responsible for the complete lyric draw —
   * absolute placement, which words are visible, sizing. Used by e.g. RSVP
   * (one huge word, dead centre, only the current word visible).
   *
   * Return value is ignored; draw directly onto `ctx`.
   */
  layout?(
    ctx: StyleCanvasContext,
    words: readonly StyleLaidOutWord[],
    frame: StyleFrameContext,
  ): void;

  /**
   * Optional FULL-FRAME OVERLAY hook, called AFTER lyrics + track title are
   * drawn (and after any layout override). Draws across the whole canvas,
   * independent of any word/line. Used by e.g. cinema-subtitle (letterbox bars
   * + film grain) and terminal-boot-log (scanlines / phosphor).
   */
  drawOverlay?(ctx: StyleCanvasContext, frame: StyleFrameContext): void;

  /**
   * Optional FULL-FRAME POST-PROCESS hook, called LAST. Re-samples / rewrites
   * the finished raster in place (the style reads pixels via getImageData and
   * writes via putImageData / redraw). Used by e.g. dither / ASCII, which
   * re-rasterize the entire finished bitmap. Heaviest hook — only styles that
   * genuinely transform the whole raster should implement it.
   */
  postProcess?(ctx: StyleCanvasContext, frame: StyleFrameContext): void;
}

export interface StyleRegistry {
  getById(id: string): LyricStyle | undefined;
}

/** Build a StyleRegistry from a list of styles. */
export function createStyleRegistry(styles: readonly LyricStyle[]): StyleRegistry {
  const byId = new Map(styles.map((s) => [s.id, s]));
  return { getById: (id: string) => byId.get(id) };
}

/** An empty registry — resolves nothing (renderer applies no modifier). */
export const EMPTY_STYLE_REGISTRY: StyleRegistry = { getById: () => undefined };

/** Identity modifier — no visual change. Returned when a style opts out. */
export const IDENTITY_MODIFIER: StyleWordModifier = {};

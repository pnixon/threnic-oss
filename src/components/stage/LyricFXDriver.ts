/**
 * LyricFXDriver — the app-side glue that renders the GPU Lyric FX layer
 * (Lyric FX Engine, docs/lyric-fx-engine-lld.md).
 *
 * The GPU per-glyph MSDF path is the default lyric renderer whenever the WebGPU
 * renderer is live; the caller (LyricsCanvas) drives this only in that case and
 * falls back to the Canvas2D bitmap path when WebGPU is unavailable. This driver
 * builds an MSDF atlas from the track font, constructs a `LyricFXGraph`, hands it
 * to the WebGPU renderer once, and each frame emits the per-glyph instance buffer
 * + the effect stack via `renderer.updateLyricFX`.
 *
 * Layout note (honest scope): the CanvasLyricRenderer owns the production text
 * layout (wrapping, lanes, scroll) and does not yet expose positioned lines, so
 * this driver does a SELF-CONTAINED centred layout of the currently-visible
 * lines using the atlas metrics. It renders real GPU glyphs synced to word
 * timing, but does NOT yet match the Canvas2D path's exact wrapping/scroll —
 * sharing one layout result is the remaining refinement (LLD §7).
 */

import {
  buildGlyphInstances,
  packGlyphInstances,
  type GlyphAtlasMetrics,
  type GlyphFontMetrics,
  type LaidOutGlyphLine,
  type PositionedLyricLine,
  type PositionedLyricWord,
} from '@threnic/lyrics';
import { SDFAtlasGenerator, type SDFFontAtlas } from '@/engine/gpu/sdf/SDFAtlasGenerator';
import { LyricFXGraph } from '@/engine/gpu/lyricfx/LyricFXGraph';
import { createAudioRouter, type AudioRouter } from '@/engine/audio/AudioRouter';
import { DEFAULT_AUDIO_REACTIVE } from '@/types/effects/audio-reactive';
import type { AudioRoutingTable } from '@/types/effects/audio-routing';
import type { LyricEffectInstance, LyricFXFrameParams } from '@/types/effects/lyric-fx';
import type { LyricLineData, LyricTheme } from '@/types/lyrics';

/** Minimal renderer surface the driver needs (both WebGPU + Offscreen satisfy). */
interface LyricFXCapableRenderer {
  device?: GPUDevice;
  getDevice?: () => GPUDevice | null;
  setLyricFXGraph?: (graph: LyricFXGraph | null) => void;
  updateLyricFX?: (
    packed: Float32Array | null,
    effects: LyricEffectInstance[],
    frame: LyricFXFrameParams,
  ) => void;
}

interface LyricFXFrameInputs {
  time: number;
  dt: number;
  width: number;
  height: number;
  bass: number;
  mid: number;
  high: number;
  energy: number;
  /** Live byte-frequency spectrum (0–255/bin) for the router's custom bands. */
  fft?: Uint8Array | null;
  /** Fade-in window length in seconds (phase-gate transition). */
  fadeInDuration?: number;
  /** Fade-out window length in seconds (phase-gate transition). */
  fadeOutDuration?: number;
  /** Resolved URL of the active font file, so the driver can load it under a
   *  deterministic family and rasterize the MSDF atlas against that font. */
  fontUrl?: string;
}

/**
 * Default Lyric FX routing table: slots 1..5 map to bass / mid / high / energy /
 * beat with the shipped default envelope, so `u_value1..5` react out of the box.
 * Slots 6..8 are unrouted (0) until a custom table is supplied.
 */
function defaultLyricFXRouting(): AudioRoutingTable {
  const slot = (source: 'bass' | 'mid' | 'high' | 'energy' | 'beat') => ({
    source,
    shape: { ...DEFAULT_AUDIO_REACTIVE, enabled: true },
  });
  return {
    slots: [
      slot('bass'),
      slot('mid'),
      slot('high'),
      slot('energy'),
      slot('beat'),
      null,
      null,
      null,
    ],
    customBands: [],
  };
}

// Safe-area inset (percent of canvas W/H) kept clear on each edge. MUST match
// EDGE_MARGIN_PCT in @threnic/lyrics CanvasLyricRenderer so the GPU path frames
// text identically to the Canvas2D path.
const LYRIC_EDGE_MARGIN_PCT = 10;

export class LyricFXDriver {
  private device: GPUDevice;
  private atlas: SDFFontAtlas | null = null;
  private atlasTexture: GPUTexture | null = null;
  private graph: LyricFXGraph | null = null;
  private atlasFontFamily = '';
  private lastGlyphKey = '';
  private router: AudioRouter;
  /** Reused normalized spectrum buffer (byte fft → 0..1 floats) for the router. */
  private spectrumBuf: Float32Array | null = null;
  /**
   * Fonts THIS driver has registered as FontFaces, keyed by url → the
   * deterministic family name it registered them under. The atlas is rasterized
   * with Canvas2D fillText, which needs the font available under a family name
   * the generator asks for. The Canvas2D lyric renderer registers each font
   * under a RANDOM private family (`ThreniCustomFont_<rand>`), so we cannot reuse
   * it — the driver loads its own copy under a stable, generator-visible name.
   */
  private fontFamilyByUrl = new Map<string, string>();
  private fontLoadInFlight = new Set<string>();

  constructor(device: GPUDevice) {
    this.device = device;
    this.router = createAudioRouter();
    this.router.setTable(defaultLyricFXRouting());
    this.router.setSampleRate(48000);
  }

  /** The graph, or null before the first build. */
  get lyricFXGraph(): LyricFXGraph | null {
    return this.graph;
  }

  /**
   * Ensure the font at `fontUrl` is registered as a FontFace under a stable
   * family name the atlas generator can rasterize with. Returns that family name
   * once the face is loaded, or null while it is still loading (caller defers).
   */
  private ensureFontFamily(fontUrl: string | undefined): string | null {
    if (!fontUrl) return null;
    const known = this.fontFamilyByUrl.get(fontUrl);
    const fontset = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
    if (!fontset) return null; // SSR/worker: no atlas here
    // Deterministic family per url so the atlas key is stable across frames.
    const family = known ?? `LyricFXFont_${this.hashUrl(fontUrl)}`;
    if (known && fontset.check(`64px "${family}"`)) return family;
    if (!this.fontLoadInFlight.has(fontUrl)) {
      this.fontLoadInFlight.add(fontUrl);
      const face = new FontFace(family, `url(${fontUrl})`);
      face
        .load()
        .then((loaded) => {
          fontset.add(loaded);
          this.fontFamilyByUrl.set(fontUrl, family);
        })
        .catch((e) => console.warn('[LyricFXDriver] font load failed:', fontUrl, e))
        .finally(() => this.fontLoadInFlight.delete(fontUrl));
    }
    // Ready only once registered AND the browser confirms it.
    if (this.fontFamilyByUrl.get(fontUrl) && fontset.check(`64px "${family}"`)) return family;
    return null;
  }

  private hashUrl(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /**
   * Ensure the atlas + graph exist for the given font family. Rebuilds the
   * atlas (an expensive CPU pass) only when the family OR weight changes.
   */
  /**
   * Ensure the atlas + graph exist for the given (already-loaded) font family.
   * `family` is the driver-registered family name from ensureFontFamily — the
   * font is guaranteed available under it. Rebuilds the atlas (an expensive CPU
   * pass) only when the family OR weight changes.
   */
  private ensureGraph(family: string, fontWeight = 700, antialias = true): LyricFXGraph | null {
    // Render size drives the MSDF field grid resolution. The field is computed
    // from a rasterised glyph, so a coarse grid bakes the rasteriser's own
    // staircase INTO the field — which the fragment-stage analytic smoothing
    // cannot remove (it only smooths across the field's existing gradient). At
    // large lyric sizes a 64px field is magnified 5–10×, so its steps show as
    // aliasing even with edge AA on. Bake a finer field (128px) when AA is on;
    // keep the coarse 64px field when AA is off (the intended crisp/pixel look).
    const renderSize = antialias ? 128 : 64;
    const atlasKey = `${family}/${fontWeight}/${renderSize}`;
    if (this.graph && this.atlasFontFamily === atlasKey) return this.graph;

    // (Re)build the MSDF atlas for this font + weight (#12: bold themes bake
    // bold glyphs — the generator takes a CSS weight string).
    try {
      this.atlas = SDFAtlasGenerator.generate({
        fontFamily: family,
        fontWeight: String(fontWeight),
        mode: 'msdf',
        renderSize,
        // Spread scales with render size so the normalised field ramp keeps the
        // same relative width (8px at 64 → 16px at 128), preserving edge softness.
        sdfSpread: Math.round(renderSize / 8),
      });
    } catch (e) {
      console.warn('[LyricFXDriver] atlas generation failed:', e);
      return null;
    }
    this.atlasTexture?.destroy();
    this.atlasTexture = SDFAtlasGenerator.uploadToGPU(this.device, this.atlas);
    this.atlasFontFamily = atlasKey;

    const atlasSampler = this.device.createSampler({
      label: 'lyricfx-atlas-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Preferred swapchain format for the composite target.
    const format = navigator.gpu?.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
    this.graph?.destroy();
    this.graph = new LyricFXGraph(
      this.device,
      format,
      this.atlasTexture.createView(),
      atlasSampler,
    );
    this.lastGlyphKey = ''; // force a glyph rebuild
    return this.graph;
  }

  /**
   * Drive one frame of GPU lyric rendering. Returns true when GPU mode handled
   * the frame (the caller then skips the Canvas2D bitmap path).
   *
   * `positionedLines` (from `CanvasLyricRenderer.getPositionedLines`) is the
   * shared layout — when provided, glyphs are placed to match the Canvas2D
   * path's wrapping/scroll. When omitted, an interim centred layout is used.
   */
  frame(
    renderer: LyricFXCapableRenderer,
    lyrics: LyricLineData[],
    theme: LyricTheme,
    fontFamily: string,
    inputs: LyricFXFrameInputs,
    positionedLines?: PositionedLyricLine[],
  ): boolean {
    // Register/verify the font under a driver-owned family the atlas generator
    // can rasterize with. The Canvas2D renderer registers fonts under a random
    // private family we cannot target, so the driver loads its own copy. While
    // the face is still loading this returns null → we skip GPU this frame and
    // the Canvas2D bitmap path renders until the font is ready.
    const family = this.ensureFontFamily(inputs.fontUrl) ?? fontFamily;
    const graph = this.ensureGraph(family, theme.fontWeight ?? 700, theme.antialiasing !== false);
    if (!graph || !this.atlas) return false;

    renderer.setLyricFXGraph?.(graph);

    // Resolve the 8 router slots for this frame (attack/decay envelopes).
    const bands = { bass: inputs.bass, mid: inputs.mid, high: inputs.high, energy: inputs.energy };
    const spectrum = this.normalizedSpectrum(inputs.fft);
    const slots = this.router.update(inputs.dt, bands, spectrum);
    const routedSlots: LyricFXFrameParams['routedSlots'] = [
      slots[0] ?? 0,
      slots[1] ?? 0,
      slots[2] ?? 0,
      slots[3] ?? 0,
      slots[4] ?? 0,
      slots[5] ?? 0,
      slots[6] ?? 0,
      slots[7] ?? 0,
    ];

    // Drop lines still entirely in their pre-roll buffer. `getPositionedLines`
    // returns a line up to LAYOUT_BUFFER_SECONDS (~3s) + fadeIn before its first
    // word (a Canvas2D layout lead the Canvas2D path hides via its animation
    // alpha). The GPU base pass draws glyphs at full opacity, so without this a
    // line pops in ~4s early. Keep a line only once time has reached its
    // fade-in window; the in-shader phase gate handles the rest.
    const fadeIn = inputs.fadeInDuration ?? 1.0;
    const fadeOut = inputs.fadeOutDuration ?? 1.0;
    const visiblePositioned = positionedLines?.filter((l) => {
      const firstStart = l.words[0]?.start ?? Infinity;
      const lastEnd = l.words.length ? l.words[l.words.length - 1].end : -Infinity;
      return inputs.time >= firstStart - fadeIn && inputs.time <= lastEnd + fadeOut;
    });

    // Build the glyph buffer only when the visible text/layout changes.
    const glyphKey = this.glyphKey(visiblePositioned, lyrics, theme, inputs);
    let packed: Float32Array | null = null;
    if (glyphKey !== this.lastGlyphKey) {
      const lines = visiblePositioned
        ? this.glyphLinesFromPositioned(
            visiblePositioned,
            theme,
            this.atlasMetricsMap(),
            this.atlas.fontMetrics.renderSize,
            inputs.width,
            inputs.height,
          )
        : layoutVisibleLines(
            this.visibleLines(lyrics, inputs.time),
            theme,
            this.atlasMetricsMap(),
            this.atlas.fontMetrics.renderSize,
            this.atlas.fontMetrics.lineHeight,
            inputs.width,
            inputs.height,
          );
      const instances = buildGlyphInstances({
        lines,
        atlas: this.atlasMetricsMap(),
        fontMetrics: this.fontMetrics(),
      });
      packed = packGlyphInstances(instances);
      this.lastGlyphKey = glyphKey;
    }

    const effects = (theme.lyricFX as LyricEffectInstance[] | undefined) ?? [];
    // Prefer the FLAT colorPre/active/post (the live values useAppTheme derives
    // from the styling panel's lyricColors) over the nested `colors` object,
    // which can be stale persisted data and would otherwise shadow the user's
    // choice.
    const themeColors = {
      pre: theme.colorPre ?? theme.colors?.pre ?? '#ffffff',
      active: theme.colorActive ?? theme.colors?.active ?? '#ffffff',
      post: theme.colorPost ?? theme.colors?.post ?? '#ffffff',
    };
    renderer.updateLyricFX?.(packed, effects, {
      time: inputs.time,
      dt: inputs.dt,
      resolution: [inputs.width, inputs.height],
      bass: inputs.bass,
      mid: inputs.mid,
      high: inputs.high,
      energy: inputs.energy,
      routedSlots,
      fadeInDuration: inputs.fadeInDuration,
      fadeOutDuration: inputs.fadeOutDuration,
      colorPre: hexToRgba(themeColors.pre),
      colorActive: hexToRgba(themeColors.active),
      colorPost: hexToRgba(themeColors.post),
      fadeGranularity:
        theme.animationIn?.granularity === 'char'
          ? 0
          : theme.animationIn?.granularity === 'line'
            ? 2
            : 1,
      // Outline/stroke (#10): Canvas2D strokes every glyph at lineWidth =
      // fontSize*0.05; in MSDF field units ~0.08 gives a comparable ring. Only
      // when the theme sets an outline colour.
      outlineColor: theme.outlineColor ? hexToRgb01(theme.outlineColor) : undefined,
      outlineWidth: theme.outlineColor ? 0.08 : 0,
      // Karaoke highlight blend easing (#5): Canvas2D lerps pre/active/post.
      // Default fade-out 0.5s (matches CanvasLyricRenderer); fade-in defaults to
      // a short ease when unset so the switch is not instant.
      highlightFadeIn: theme.highlightFadeIn ?? 0.15,
      highlightFadeOut: theme.highlightFadeOut ?? 0.5,
      // Entry pop (#1): Canvas2D's default in-animation is 'pop' (scale ease).
      entryPop: (theme.animationIn?.type ?? 'pop') === 'pop',
    });
    return true;
  }

  /** Set a custom routing table (else the sensible default is used). */
  setRoutingTable(table: AudioRoutingTable): void {
    this.router.setTable(table);
  }

  /** Reset router envelopes on seek. */
  resetRouter(): void {
    this.router.reset();
  }

  /** Byte fft (0–255) → reused normalized Float32Array (0..1), or null. */
  private normalizedSpectrum(fft?: Uint8Array | null): Float32Array | null {
    if (!fft || fft.length === 0) return null;
    if (!this.spectrumBuf || this.spectrumBuf.length !== fft.length) {
      this.spectrumBuf = new Float32Array(fft.length);
    }
    const buf = this.spectrumBuf;
    for (let i = 0; i < fft.length; i++) buf[i] = fft[i] / 255;
    return buf;
  }

  /**
   * Convert shared positioned lines → glyph lines the buffer builder consumes.
   *
   * CRITICAL: wrapping and horizontal anchoring are redone here in ATLAS-METRIC
   * space, not carried over from the Canvas2D layout. The Canvas2D renderer
   * wraps using its own `measureText`; the GPU glyph builder re-flows each row
   * from an originX using the MSDF atlas advances. Those two metric systems
   * disagree, so a line Canvas2D thinks fits (one row) overruns the right edge
   * on the GPU. Re-measuring with the exact advances we DRAW with makes the GPU
   * path self-consistent: it wraps to the same buffered column and keeps equal
   * left/right margins. We keep only the line's vertical anchor (its first
   * row's y) and word timing from the shared layout.
   */
  private glyphLinesFromPositioned(
    lines: PositionedLyricLine[],
    theme: LyricTheme,
    atlasMetrics: Map<number, GlyphAtlasMetrics>,
    renderSize: number,
    canvasW: number,
    canvasH: number,
  ): LaidOutGlyphLine[] {
    const colors = {
      pre: theme.colorPre ?? theme.colors?.pre ?? '#ffffff',
      active: theme.colorActive ?? theme.colors?.active ?? '#ffffff',
      post: theme.colorPost ?? theme.colors?.post ?? '#ffffff',
    };
    const color = hexToRgba(colors.active);
    const MIN_ENTRY_LEAD_IN = 0.12;
    const fadeInDur = theme.animationIn?.duration ?? 0.5;
    const lsMul = theme.letterSpacing ?? 1;

    // Buffered content box, identical basis to the Canvas2D path.
    const marginPx = canvasW * (LYRIC_EDGE_MARGIN_PCT / 100);
    const usableWidth = canvasW - marginPx * 2;
    const wrapPct = Math.max(10, Math.min(100, theme.wrapWidth ?? 90));
    const columnWidth = usableWidth * (wrapPct / 100);
    const hAnchor = theme.horizontalPosition ?? 'center';

    // Atlas advance for one code point, in device px at this line's scale.
    const advanceOf = (cp: number, scale: number): number => {
      const gm = atlasMetrics.get(cp);
      return (gm ? gm.advance : renderSize * 0.5) * scale;
    };
    const wordWidth = (text: string, scale: number, lsPx: number): number => {
      let w = 0;
      for (const ch of text) w += advanceOf(ch.codePointAt(0)!, scale) + lsPx;
      return w;
    };

    let prevLineEnd: number | undefined;
    let prevWordStart: number | undefined;
    const out: LaidOutGlyphLine[] = [];

    for (const line of lines) {
      if (line.words.length === 0) continue;
      const lineEnd = line.words[line.words.length - 1].end;
      const fontSizePx = line.fontSizePx;
      const scale = fontSizePx / renderSize;
      const lsPx = (lsMul - 1) * fontSizePx * 0.05;
      const spaceW = advanceOf(32, scale) + lsPx;
      const lineHeight = fontSizePx * (theme.lineSpacing ?? 1.35);
      // Vertical anchor: the top row's y from the shared layout (Canvas2D placed
      // the line here). Re-wrapped rows stack downward from it.
      const topY = Math.min(...line.words.map((w) => w.y));

      // Wrap words into rows that fit the column, measured in atlas px.
      const rows: PositionedLyricWord[][] = [];
      let cur: PositionedLyricWord[] = [];
      let curW = 0;
      for (const w of line.words) {
        const ww = wordWidth(w.text, scale, lsPx);
        const add = cur.length === 0 ? ww : curW + spaceW + ww;
        if (cur.length > 0 && add > columnWidth) {
          rows.push(cur);
          cur = [w];
          curW = ww;
        } else {
          cur.push(w);
          curW = add;
        }
      }
      if (cur.length > 0) rows.push(cur);

      // Vertical safe-area clamp: atlas re-wrapping may add MORE rows than the
      // shared layout counted, pushing an on-screen line's lower rows past the
      // bottom. Nudge only such a line up so its stack fits. Do NOT touch lines
      // that are already scrolled off (top below the canvas, or bottom above it):
      // past/future lines are MEANT to sit off the edges, and dragging them into
      // the safe band is what pinned everything to mid-screen at Position Y
      // extremes.
      const marginY = canvasH * (LYRIC_EDGE_MARGIN_PCT / 100);
      let blockTopY = topY;
      const stackBottom = blockTopY + (rows.length - 1) * lineHeight + lineHeight * 0.3;
      const onScreen = topY < canvasH && stackBottom > 0;
      if (onScreen && stackBottom > canvasH - marginY) {
        blockTopY -= stackBottom - (canvasH - marginY);
        if (blockTopY - lineHeight < marginY) blockTopY = marginY + lineHeight; // taller than safe area → pin top
      }

      rows.forEach((rowWords, rowIdx) => {
        // Row width in atlas px (no trailing space).
        let rowW = 0;
        rowWords.forEach((w, i) => {
          rowW += (i === 0 ? 0 : spaceW) + wordWidth(w.text, scale, lsPx);
        });
        // Anchor the row's LEFT edge inside the buffered box.
        let originX: number;
        if (hAnchor === 'left') {
          originX = marginPx;
        } else if (hAnchor === 'right') {
          originX = canvasW - marginPx - rowW;
        } else {
          originX = (canvasW - rowW) / 2;
        }
        const baselineY = blockTopY + rowIdx * lineHeight;

        let text = '';
        const words = rowWords.map((w, wi) => {
          const charStartIndex = [...text].length;
          text += w.text + ' ';
          let leadIn = fadeInDur;
          if (prevWordStart !== undefined) {
            const spacing = w.start - prevWordStart;
            if (spacing > 0) leadIn = Math.min(leadIn, Math.max(MIN_ENTRY_LEAD_IN, spacing));
          } else if (wi === 0 && prevLineEnd !== undefined) {
            const gap = w.start - prevLineEnd;
            leadIn =
              gap > 0 ? Math.min(leadIn, Math.max(MIN_ENTRY_LEAD_IN, gap)) : MIN_ENTRY_LEAD_IN;
          }
          prevWordStart = w.start;
          return {
            wordIndex: w.wordIndex,
            start: w.start,
            end: w.end,
            entryStart: w.start - leadIn,
            charStartIndex,
            charEndIndex: charStartIndex + [...w.text].length,
          };
        });
        text = text.trimEnd();
        out.push({
          text,
          lineIndex: line.lineIndex,
          laneIndex: line.laneIndex,
          originX,
          baselineY,
          words,
          fontSizePx: line.fontSizePx,
          letterSpacingPx: (lsMul - 1) * line.fontSizePx * 0.05,
          color,
        } satisfies LaidOutGlyphLine);
      });
      prevLineEnd = lineEnd;
    }
    return out;
  }

  // ── Atlas metric adapters (structural, no GPU coupling for @threnic/lyrics) ──

  private atlasMetricsMap(): Map<number, GlyphAtlasMetrics> {
    const map = new Map<number, GlyphAtlasMetrics>();
    if (!this.atlas) return map;
    for (const [cp, g] of this.atlas.glyphs) {
      map.set(cp, {
        advance: g.advance,
        bearingX: g.bearingX,
        bearingY: g.bearingY,
        atlasWidth: g.atlasWidth,
        atlasHeight: g.atlasHeight,
        uv: g.uv,
      });
    }
    return map;
  }

  private fontMetrics(): GlyphFontMetrics {
    const fm = this.atlas!.fontMetrics;
    return {
      renderSize: fm.renderSize,
      sdfPadding: this.atlas!.sdfPadding,
      ascent: fm.ascent,
    };
  }

  // ── Self-contained centred layout (interim; not Canvas2D-parity yet) ──

  /** Lines whose [start,end] window contains `time`, plus a small lead/tail. */
  private visibleLines(lyrics: LyricLineData[], time: number): LyricLineData[] {
    const LEAD = 0.5;
    return lyrics.filter((l) => time >= l.start - LEAD && time <= l.end + LEAD);
  }

  private glyphKey(
    positioned: PositionedLyricLine[] | undefined,
    lyrics: LyricLineData[],
    theme: LyricTheme,
    inputs: LyricFXFrameInputs,
  ): string {
    // Colors are baked into the glyph buffer, so a styling-color change must
    // invalidate the cached buffer — fold them into the key.
    const c = theme.colorActive ?? theme.colors?.active ?? '#ffffff';
    const cp = theme.colorPre ?? theme.colors?.pre ?? '';
    const cpo = theme.colorPost ?? theme.colors?.post ?? '';
    const colorSig = `${c}/${cp}/${cpo}/w${theme.fontWeight ?? 700}/ls${theme.letterSpacing ?? 1}`;
    // Full-lyrics content signature: the cached glyph buffer must invalidate on
    // ANY line add/delete/edit, not only when the change happens to fall inside
    // the current-time visible window. Keying solely off `positioned`/`visible`
    // lines left a deleted OFF-SCREEN line (or an index/position collision after
    // a delete) rendering stale until a reload. Count + per-line id/text is cheap
    // and collision-proof.
    const contentSig = `n${lyrics.length}:${lyrics
      .map((l) => `${l.id ?? ''}#${l.text ?? l.words?.map((w) => w.text).join(' ') ?? ''}`)
      .join('|')}`;
    if (positioned) {
      // Position-sensitive key (layout scrolls vertically as lines displace).
      // X is whole-pixel quantised (it does not scroll), but Y is quantised at
      // SUB-PIXEL granularity: the smooth upward scroll moves a line by <1px per
      // frame as its lerp asymptotes, and rounding Y to whole pixels coalesced
      // all those frames to one key so the glyph buffer never re-baked — the
      // line froze short of its target, then hopped a whole pixel at once (the
      // reported "teleports up in one frame"). The vertical position is baked
      // into the glyph buffer (the shader applies no scroll offset), so the
      // slide only advances when the buffer re-bakes; quantising Y to 1/4 px
      // lets every sub-pixel scroll step re-bake while still coalescing frames
      // that are genuinely identical.
      const sig = positioned
        .map(
          (l) =>
            `${l.lineIndex}:${Math.round(l.words[0]?.x ?? 0)},${Math.round((l.words[0]?.y ?? 0) * 4)}:${l.words.length}`,
        )
        .join('|');
      return `pos|${inputs.width}x${inputs.height}|${colorSig}|${contentSig}|${sig}`;
    }
    const vis = this.visibleLines(lyrics, inputs.time);
    return `${inputs.width}x${inputs.height}|${theme.fontSize}|${colorSig}|${contentSig}|${vis.map((l) => l.id).join(',')}`;
  }

  destroy(): void {
    this.graph?.destroy();
    this.atlasTexture?.destroy();
    this.graph = null;
    this.atlasTexture = null;
    this.atlas = null;
  }
}

/** '#rrggbb' → [r,g,b,a] in 0..1. */
function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [Number.isFinite(r) ? r : 1, Number.isFinite(g) ? g : 1, Number.isFinite(b) ? b : 1, 1];
}

/** '#rrggbb' → [r,g,b] in 0..1 (outline colour). */
function hexToRgb01(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgba(hex);
  return [r, g, b];
}

/**
 * Pure interim layout: centre each visible line horizontally using the atlas
 * advances, stack them about the theme's vertical position, and map word timing
 * onto per-word character spans. Exported for unit testing. NOT Canvas2D-parity
 * (no wrapping/scroll) — see the file header.
 */
export function layoutVisibleLines(
  lines: LyricLineData[],
  theme: LyricTheme,
  atlasMetrics: Map<number, GlyphAtlasMetrics>,
  renderSize: number,
  lineHeightUnits: number,
  width: number,
  height: number,
): LaidOutGlyphLine[] {
  const fontSizePx = (theme.fontSize ?? 0.5) * (height / 10);
  const scale = fontSizePx / renderSize;
  const lineHeight = lineHeightUnits * scale * 1.3;

  const colors = {
    pre: theme.colorPre ?? theme.colors?.pre ?? '#ffffff',
    active: theme.colorActive ?? theme.colors?.active ?? '#ffffff',
    post: theme.colorPost ?? theme.colors?.post ?? '#ffffff',
  };
  const color = hexToRgba(colors.active);

  const n = lines.length;
  const blockH = n * lineHeight;
  const startY = height * ((theme.verticalPosition ?? 50) / 100) - blockH / 2 + lineHeight * 0.75;

  return lines.map((line, i) => {
    const text = line.text;
    let lineW = 0;
    for (const ch of text) {
      const gm = atlasMetrics.get(ch.codePointAt(0)!);
      lineW += (gm?.advance ?? fontSizePx * 0.5) * scale;
    }
    const originX =
      theme.horizontalPosition === 'left'
        ? (width - width * ((theme.wrapWidth ?? 90) / 100)) / 2
        : theme.horizontalPosition === 'right'
          ? width - (width - width * ((theme.wrapWidth ?? 90) / 100)) / 2 - lineW
          : (width - lineW) / 2;
    const baselineY = startY + i * lineHeight;

    const words = (line.words ?? []).map((w, wi) => {
      const at = text.indexOf(w.text, 0);
      const charStartIndex = at >= 0 ? [...text.slice(0, at)].length : 0;
      return {
        wordIndex: wi,
        start: w.start,
        end: w.end,
        charStartIndex,
        charEndIndex: charStartIndex + [...w.text].length,
      };
    });

    return {
      text,
      lineIndex: i,
      laneIndex: line.laneIndex ?? 0,
      originX,
      baselineY,
      words:
        words.length > 0
          ? words
          : [
              {
                wordIndex: 0,
                start: line.start,
                end: line.end,
                charStartIndex: 0,
                charEndIndex: [...text].length,
              },
            ],
      fontSizePx,
      color,
    } satisfies LaidOutGlyphLine;
  });
}

/**
 * GlyphBuffer — Stage 2 of the Lyric FX Engine (see
 * `docs/lyric-fx-engine-lld.md`).
 *
 * The Canvas2D path flattens the lyric layer to a single bitmap, destroying
 * per-glyph identity at the GPU boundary. This module is the substrate change
 * that keeps that identity: it emits one {@link GlyphInstance} per visible
 * glyph — packed for a GPU storage buffer — so every downstream effect can
 * index by `charIndex`, derive its own timing from `charStart/charEnd`, and
 * jitter deterministically from `seed`.
 *
 * Design constraints (all enforced here):
 *   - **No GPU types.** This lives in the framework-agnostic `@threnic/lyrics`
 *     package. Atlas metrics arrive through the local {@link GlyphAtlasMetrics}
 *     shape, which the engine's `SDFFontAtlas` glyph map satisfies structurally
 *     — no import from `src/engine/gpu`.
 *   - **Pure & deterministic.** No wall clock, no `Math.random()`; `seed` is a
 *     stable hash so live preview and offline export produce byte-identical
 *     buffers. This is the export-parity rule the StyleRegistry already states.
 *   - **Rebuilt only on text / layout / theme change** — never per frame.
 *     Per-frame inputs (time, audio, routed slots) ride in a uniform, and the
 *     shader derives per-glyph progress from `charStart/charEnd`.
 *   - **Layout is the caller's job.** Wrapping, lane assignment, and line
 *     placement stay in the renderer. This module consumes positioned lines
 *     ({@link LaidOutGlyphLine}) and walks their glyphs; it does not measure or
 *     wrap text.
 */

// ─── The GPU-facing instance ────────────────────────────────────────────────

/** Temporal role baked into the instance. Live role is re-derived in-shader. */
export const GLYPH_ROLE_PRE = 0;
export const GLYPH_ROLE_ACTIVE = 1;
export const GLYPH_ROLE_POST = 2;

/** One visible glyph, as the GPU sees it. Packed into a storage buffer. */
export interface GlyphInstance {
  // ── identity: what every effect indexes by ──
  /** Position of this glyph within its line (0-based). */
  charIndex: number;
  /** Index of the word this glyph belongs to, within its line. */
  wordIndex: number;
  /** Index of the line this glyph belongs to. */
  lineIndex: number;
  /** Lane assignment for multi-voice layouts (0-based). */
  laneIndex: number;
  /** Stable per-glyph pseudo-random in [0,1). Deterministic — preview == export. */
  seed: number;

  // ── atlas ──
  /** UV rect in the atlas as [u0, v0, u1, v1]. */
  atlasRect: [number, number, number, number];

  // ── layout, from the CPU pass (device pixels) ──
  /** Top-left of the glyph quad, device pixels. */
  pos: [number, number];
  /** Glyph quad size, device pixels. */
  size: [number, number];
  /** Baseline Y for this glyph's line, device pixels. */
  baseline: number;

  // ── timing: lets the shader derive its own progress ──
  /** Seconds; when this glyph becomes active. */
  charStart: number;
  /** Seconds; when this glyph stops being active. */
  charEnd: number;
  /** Seconds; effective entry-animation start (neighbor-bounded lead-in). */
  entryStart: number;
  /** Seconds; start of the whole line (its first word). Shared by every glyph
   * on the line so 'line' granularity can transition them as one unit. */
  lineStart: number;
  /** Seconds; end of the whole line (its last word). */
  lineEnd: number;

  // ── resolved style ──
  /** Base fill colour [r,g,b,a] in 0..1. */
  color: [number, number, number, number];
  /** Baked temporal role (PRE/ACTIVE/POST); live role is re-derived in-shader. */
  role: number;
}

// ─── Inputs (no GPU coupling) ───────────────────────────────────────────────

/**
 * The atlas facts a glyph needs, keyed by code point. Structurally satisfied by
 * the engine's `SDFFontAtlas.glyphs` value type, so the renderer can pass its
 * atlas glyph map directly without this package importing GPU code.
 */
export interface GlyphAtlasMetrics {
  /** Advance width (horizontal pen movement) in atlas render-size units. */
  advance: number;
  /** Bearing from the pen position to the glyph origin, atlas units. */
  bearingX: number;
  bearingY: number;
  /** Glyph bitmap size in the atlas (pixels). 0 for whitespace. */
  atlasWidth: number;
  atlasHeight: number;
  /** UV rect [0,1] within the atlas. */
  uv: { u0: number; v0: number; u1: number; v1: number };
}

/** Font metrics from the atlas needed to scale atlas units to device pixels. */
export interface GlyphFontMetrics {
  /** Render size the atlas was rasterised at (atlas units == this many px). */
  renderSize: number;
  /** Padding baked around each glyph in the atlas (atlas units). */
  sdfPadding: number;
  /** Ascent above baseline, atlas units. */
  ascent: number;
}

/** A single laid-out line, positioned by the renderer, ready to emit glyphs. */
export interface LaidOutGlyphLine {
  /** The line's text (may contain multiple words, already ordered). */
  text: string;
  /** Global line index across all lyrics. */
  lineIndex: number;
  /** Lane assignment (0-based). */
  laneIndex: number;
  /** Pen origin X for the first glyph of the line, device pixels. */
  originX: number;
  /** Baseline Y for the line, device pixels. */
  baselineY: number;
  /**
   * Per-word timing + boundaries within this line, in text order. The character
   * ranges are [charStartIndex, charEndIndex) into `text`; whitespace between
   * words is attributed to the preceding word's advance and carries no glyph.
   */
  words: LaidOutGlyphWord[];
  /** Font size in device pixels for this line. */
  fontSizePx: number;
  /** Base fill colour [r,g,b,a] in 0..1 for glyphs of this line. */
  color: [number, number, number, number];
  /** Extra tracking between glyphs in device pixels (default 0). */
  letterSpacingPx?: number;
}

/** One word's timing and character span within its line. */
export interface LaidOutGlyphWord {
  /** Word index within the line (0-based). */
  wordIndex: number;
  /** Start time, seconds. */
  start: number;
  /** End time, seconds. */
  end: number;
  /**
   * Effective entry-animation START time, seconds — the neighbor-bounded
   * lead-in the Canvas2D AnimationController computes (clamped against the
   * previous word/line start so reveal order matches reading order). The base
   * entry fades/pops across [entryStart, start]. Falls back to start - default
   * fade when unset.
   */
  entryStart?: number;
  /** Inclusive start / exclusive end character indices into the line text. */
  charStartIndex: number;
  charEndIndex: number;
}

/** Inputs to {@link buildGlyphInstances}. */
export interface BuildGlyphBufferInput {
  /** Positioned lines to emit glyphs for. */
  lines: LaidOutGlyphLine[];
  /** Atlas glyph metrics keyed by code point. */
  atlas: Map<number, GlyphAtlasMetrics>;
  /** Atlas font metrics for unit → pixel scaling. */
  fontMetrics: GlyphFontMetrics;
}

// ─── Deterministic seeding ──────────────────────────────────────────────────

/**
 * A tiny, stable integer hash (xmur3-style) → [0,1). Deterministic across
 * runs and platforms, so a glyph's `seed` is identical in preview and export.
 */
export function glyphSeed(globalGlyphIndex: number, codePoint: number): number {
  let h = 0x9e3779b1 ^ Math.imul(globalGlyphIndex + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  h ^= Math.imul(codePoint + 1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 13), 0x165667b1);
  h ^= h >>> 16;
  // Map to [0,1) using the top 24 bits for a clean float.
  return ((h >>> 8) & 0xffffff) / 0x1000000;
}

// ─── The emit pass ──────────────────────────────────────────────────────────

/**
 * Emit one {@link GlyphInstance} per visible glyph across all lines.
 *
 * Whitespace and glyphs missing from the atlas advance the pen but emit no
 * instance (they have no bitmap). `charIndex` counts *visible position within
 * the line* and increments for every character walked (including spaces) so it
 * stays a faithful positional index for kinetic-wave-style effects; the emitted
 * instance list is dense (visible glyphs only).
 */
export function buildGlyphInstances(input: BuildGlyphBufferInput): GlyphInstance[] {
  const { lines, atlas, fontMetrics } = input;
  const out: GlyphInstance[] = [];
  let globalGlyphIndex = 0;

  for (const line of lines) {
    const scale = line.fontSizePx / fontMetrics.renderSize;
    const letterSpacing = line.letterSpacingPx ?? 0;
    const padPx = fontMetrics.sdfPadding * scale;
    const ascentPx = fontMetrics.ascent * scale;

    // The line's own word extent. Doubles as the timing fallback for characters
    // not covered by any word span (e.g. leading whitespace).
    const firstWord = line.words[0];
    const lastWord = line.words[line.words.length - 1];
    const lineStart = firstWord ? firstWord.start : 0;
    const lineEnd = lastWord ? lastWord.end : 0;

    let penX = line.originX;
    const chars = [...line.text]; // code-point aware

    for (let charIndex = 0; charIndex < chars.length; charIndex++) {
      const ch = chars[charIndex];
      const cp = ch.codePointAt(0)!;
      const gm = atlas.get(cp);

      // Which word owns this character (for wordIndex + timing)?
      const word = wordForChar(line.words, charIndex);
      const charStart = word ? word.start : lineStart;
      const charEnd = word ? word.end : lineEnd;
      const charEntry = word?.entryStart ?? charStart - 0.5;
      const wordIndex = word ? word.wordIndex : 0;

      if (!gm) {
        // Unknown glyph: advance a default and move on (no instance).
        penX += line.fontSizePx * 0.5 + letterSpacing;
        continue;
      }

      if (gm.atlasWidth > 0 && gm.atlasHeight > 0) {
        // Glyph quad placement mirrors SDFTextRenderer.drawText.
        const quadX = penX + gm.bearingX * scale - padPx;
        const quadY = line.baselineY - gm.bearingY * scale - padPx + ascentPx;
        const quadW = gm.atlasWidth * scale;
        const quadH = gm.atlasHeight * scale;

        out.push({
          charIndex,
          wordIndex,
          lineIndex: line.lineIndex,
          laneIndex: line.laneIndex,
          seed: glyphSeed(globalGlyphIndex, cp),
          atlasRect: [gm.uv.u0, gm.uv.v0, gm.uv.u1, gm.uv.v1],
          pos: [quadX, quadY],
          size: [quadW, quadH],
          baseline: line.baselineY,
          charStart,
          charEnd,
          entryStart: charEntry,
          lineStart,
          lineEnd,
          color: line.color,
          role: GLYPH_ROLE_ACTIVE,
        });
        globalGlyphIndex++;
      }

      penX += gm.advance * scale + letterSpacing;
    }
  }

  return out;
}

/** Find the word whose character span contains `charIndex`, or null. */
function wordForChar(words: LaidOutGlyphWord[], charIndex: number): LaidOutGlyphWord | null {
  for (const w of words) {
    if (charIndex >= w.charStartIndex && charIndex < w.charEndIndex) return w;
  }
  return null;
}

// ─── Storage-buffer packing ─────────────────────────────────────────────────

/**
 * Float count per packed glyph instance. Layout (all f32):
 *   [0]  charIndex        [1]  wordIndex     [2]  lineIndex    [3]  laneIndex
 *   [4]  seed             [5]  role          [6]  charStart    [7]  charEnd
 *   [8]  posX             [9]  posY          [10] sizeW        [11] sizeH
 *   [12] baseline         [13] u0            [14] v0           [15] u1
 *   [16] v1               [17] r             [18] g            [19] b
 *   [20] a                [21] entryStart    [22] lineStart    [23] lineEnd
 *
 * 24 floats = 96 bytes keeps the stride 16-byte aligned for std430 storage.
 */
export const GLYPH_INSTANCE_FLOATS = 24;

/** Pack instances into a Float32Array for upload as a storage buffer. */
export function packGlyphInstances(instances: GlyphInstance[]): Float32Array {
  const buf = new Float32Array(instances.length * GLYPH_INSTANCE_FLOATS);
  for (let i = 0; i < instances.length; i++) {
    const g = instances[i];
    const o = i * GLYPH_INSTANCE_FLOATS;
    buf[o + 0] = g.charIndex;
    buf[o + 1] = g.wordIndex;
    buf[o + 2] = g.lineIndex;
    buf[o + 3] = g.laneIndex;
    buf[o + 4] = g.seed;
    buf[o + 5] = g.role;
    buf[o + 6] = g.charStart;
    buf[o + 7] = g.charEnd;
    buf[o + 8] = g.pos[0];
    buf[o + 9] = g.pos[1];
    buf[o + 10] = g.size[0];
    buf[o + 11] = g.size[1];
    buf[o + 12] = g.baseline;
    buf[o + 13] = g.atlasRect[0];
    buf[o + 14] = g.atlasRect[1];
    buf[o + 15] = g.atlasRect[2];
    buf[o + 16] = g.atlasRect[3];
    buf[o + 17] = g.color[0];
    buf[o + 18] = g.color[1];
    buf[o + 19] = g.color[2];
    buf[o + 20] = g.color[3];
    buf[o + 21] = g.entryStart;
    buf[o + 22] = g.lineStart;
    buf[o + 23] = g.lineEnd;
  }
  return buf;
}

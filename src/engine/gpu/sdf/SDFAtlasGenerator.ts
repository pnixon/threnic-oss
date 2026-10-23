/**
 * SDF Font Atlas Generator
 *
 * Generates Signed Distance Field (SDF) font atlases from TrueType/OpenType
 * fonts loaded via the browser's Canvas2D API. The resulting atlas texture
 * enables resolution-independent text rendering with GPU-powered anti-aliasing,
 * outlines, glow, and shadow effects.
 *
 * Pipeline:
 *   1. Rasterize each glyph at high resolution via CanvasRenderingContext2D
 *   2. Compute the signed distance field for each glyph via dead reckoning
 *   3. Pack glyphs into a power-of-two atlas texture
 *   4. Upload to a GPUTexture for use with the SDF text rendering shader
 *
 * The SDF approach allows:
 *   - Clean scaling from 8px to 200px+ with a single atlas
 *   - GPU-side outline, glow, and drop shadow effects
 *   - Sub-pixel anti-aliasing via smoothstep in the fragment shader
 *   - Memory-efficient text rendering (single atlas per font)
 *
 * Based on the technique from Valve's 2007 SIGGRAPH paper:
 * "Improved Alpha-Tested Magnification for Vector Textures and Special Effects"
 */

import { computeMSDF } from './MSDFGenerator';

// ─── Types ──────────────────────────────────────────────────

interface GlyphMetrics {
  /** Unicode code point */
  codePoint: number;
  /** Character string */
  char: string;
  /** Position in the atlas (pixels) */
  atlasX: number;
  atlasY: number;
  /** Size of the glyph bitmap in the atlas (pixels) */
  atlasWidth: number;
  atlasHeight: number;
  /** Bearing (offset from the pen position to the glyph origin) */
  bearingX: number;
  bearingY: number;
  /** Advance width (horizontal spacing) */
  advance: number;
  /** UV coordinates in the atlas [0, 1] */
  uv: {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
  };
}

/** Field encoding of an atlas. `sdf` = single-channel r8unorm; `msdf` = 3-channel rgba8unorm (median-of-RGB). */
type AtlasFieldMode = 'sdf' | 'msdf';

export interface SDFFontAtlas {
  /** Atlas dimensions (always power of 2) */
  width: number;
  height: number;
  /**
   * Field pixel data.
   * - `mode === 'sdf'`: single channel, `width*height` bytes (upload as `r8unorm`).
   * - `mode === 'msdf'`: RGBA interleaved, `width*height*4` bytes (upload as `rgba8unorm`);
   *   the shader recovers the edge as `median(r,g,b)`.
   */
  data: Uint8Array;
  /** Which field encoding `data` holds. Determines GPU texture format and shader sampling. */
  mode: AtlasFieldMode;
  /** Per-glyph metrics and atlas coordinates */
  glyphs: Map<number, GlyphMetrics>;
  /** Font metrics */
  fontMetrics: {
    /** Font family name */
    family: string;
    /** Rendered size used for SDF generation */
    renderSize: number;
    /** Line height in renderSize units */
    lineHeight: number;
    /** Ascent above baseline */
    ascent: number;
    /** Descent below baseline */
    descent: number;
  };
  /** Padding around each glyph for SDF spread */
  sdfPadding: number;
  /** Maximum SDF spread distance (pixels at render resolution) */
  sdfSpread: number;
}

interface AtlasOptions {
  /** Font family (CSS font-family, e.g. 'Inter', 'Roboto') */
  fontFamily: string;
  /** Font weight (CSS, e.g. '400', '700', 'bold') */
  fontWeight?: string;
  /** Resolution for SDF rasterization (higher = more detail, default: 64) */
  renderSize?: number;
  /** SDF spread in pixels at renderSize (default: 8) */
  sdfSpread?: number;
  /** Character set to include (default: printable ASCII 32-126 + common symbols) */
  charset?: string;
  /** Maximum atlas dimension (default: 2048) */
  maxAtlasSize?: number;
  /**
   * Field encoding to generate (default: `'msdf'`).
   * - `'msdf'`: corner-preserving multi-channel field, recommended for large lyric type.
   * - `'sdf'`: legacy single-channel field (rounds corners as size grows).
   */
  mode?: AtlasFieldMode;
}

// ─── Default character set ──────────────────────────────────

const DEFAULT_CHARSET = (() => {
  let chars = '';
  // ASCII printable range
  for (let i = 32; i <= 126; i++) {
    chars += String.fromCodePoint(i);
  }
  // Common symbols and accented characters
  chars += '©®™°±×÷àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ';
  chars += 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß';
  chars +=
    '\u201C\u201D\u2018\u2019\u2039\u203A\u00AB\u00BB\u2014\u2013\u2026\u2022\u00B7\u00A1\u00BF\u00A2\u00A3\u00A5\u20AC\u00A4\u00A7\u00B6\u2020\u2021';
  return chars;
})();

// ─── SDF Atlas Generator ────────────────────────────────────

export class SDFAtlasGenerator {
  /**
   * Generate a full SDF font atlas.
   *
   * @param options - Configuration for atlas generation
   * @returns The generated SDF font atlas with glyph metrics
   */
  static generate(options: AtlasOptions): SDFFontAtlas {
    const {
      fontFamily,
      fontWeight = '400',
      renderSize = 64,
      sdfSpread = 8,
      charset = DEFAULT_CHARSET,
      maxAtlasSize = 2048,
      mode = 'msdf',
    } = options;

    const padding = sdfSpread;
    const cssFont = `${fontWeight} ${renderSize}px "${fontFamily}", sans-serif`;

    // ── Step 1: Measure all glyphs ──────────────────────────
    const measureCanvas = new OffscreenCanvas(1, 1);
    const measureCtx = measureCanvas.getContext('2d')!;
    measureCtx.font = cssFont;
    measureCtx.textBaseline = 'alphabetic';

    // Determine font metrics from the measurement canvas
    const mMetrics = measureCtx.measureText('Hg|ÅÿM');
    const ascent = Math.ceil(mMetrics.actualBoundingBoxAscent);
    const descent = Math.ceil(mMetrics.actualBoundingBoxDescent);
    const lineHeight = ascent + descent;

    // Unique code points
    const codePoints = [...new Set([...charset].map((c) => c.codePointAt(0)!))];

    // Measure each glyph
    interface GlyphMeasure {
      codePoint: number;
      char: string;
      width: number;
      height: number;
      bearingX: number;
      bearingY: number;
      advance: number;
    }

    const glyphMeasures: GlyphMeasure[] = [];
    for (const cp of codePoints) {
      const char = String.fromCodePoint(cp);
      const m = measureCtx.measureText(char);

      const bboxLeft = Math.ceil(m.actualBoundingBoxLeft);
      const bboxRight = Math.ceil(m.actualBoundingBoxRight);
      const bboxAscent = Math.ceil(m.actualBoundingBoxAscent);
      const bboxDescent = Math.ceil(m.actualBoundingBoxDescent);

      const width = bboxLeft + bboxRight;
      const height = bboxAscent + bboxDescent;

      if (width <= 0 || height <= 0) continue; // Skip zero-size glyphs (e.g. space has advance but no bitmap)

      glyphMeasures.push({
        codePoint: cp,
        char,
        width: width + padding * 2,
        height: height + padding * 2,
        bearingX: -bboxLeft,
        bearingY: bboxAscent,
        advance: m.width,
      });
    }

    // Also add space as a special case (no bitmap but has advance)
    const spaceMeasure = measureCtx.measureText(' ');

    // ── Step 2: Pack glyphs into atlas ──────────────────────
    // Simple shelf packing algorithm
    const { atlasWidth, atlasHeight, positions } = this.packGlyphs(glyphMeasures, maxAtlasSize);

    // ── Step 3: Rasterize each glyph to get binary bitmaps ─
    const channels = mode === 'msdf' ? 4 : 1;
    const atlasData = new Uint8Array(atlasWidth * atlasHeight * channels);
    const glyphMap = new Map<number, GlyphMetrics>();

    // Rasterize canvas — one glyph at a time
    const rasterCanvas = new OffscreenCanvas(
      renderSize * 2 + padding * 4,
      renderSize * 2 + padding * 4,
    );
    const rasterCtx = rasterCanvas.getContext('2d', { willReadFrequently: true })!;

    for (let i = 0; i < glyphMeasures.length; i++) {
      const gm = glyphMeasures[i];
      const pos = positions[i];

      // Rasterize the glyph
      rasterCanvas.width = gm.width;
      rasterCanvas.height = gm.height;
      rasterCtx.clearRect(0, 0, gm.width, gm.height);
      rasterCtx.font = cssFont;
      rasterCtx.textBaseline = 'alphabetic';
      rasterCtx.fillStyle = 'white';

      // Draw the glyph centered in the padded area
      rasterCtx.fillText(gm.char, padding - gm.bearingX, padding + gm.bearingY);

      // Get the rasterized image data
      const imageData = rasterCtx.getImageData(0, 0, gm.width, gm.height);
      const binaryBitmap = new Uint8Array(gm.width * gm.height);
      for (let j = 0; j < binaryBitmap.length; j++) {
        binaryBitmap[j] = imageData.data[j * 4 + 3] > 127 ? 1 : 0;
      }

      // ── Step 4: Compute the field (SDF or MSDF) ───────────
      if (mode === 'msdf') {
        const { data: msdf } = computeMSDF(binaryBitmap, gm.width, gm.height, sdfSpread);
        // ── Step 5: Blit RGBA into atlas ────────────────────
        for (let y = 0; y < gm.height; y++) {
          for (let x = 0; x < gm.width; x++) {
            const src = (y * gm.width + x) * 4;
            const dst = ((pos.y + y) * atlasWidth + (pos.x + x)) * 4;
            atlasData[dst + 0] = msdf[src + 0];
            atlasData[dst + 1] = msdf[src + 1];
            atlasData[dst + 2] = msdf[src + 2];
            atlasData[dst + 3] = msdf[src + 3];
          }
        }
      } else {
        const sdfBitmap = this.computeSDF(binaryBitmap, gm.width, gm.height, sdfSpread);
        // ── Step 5: Blit single channel into atlas ──────────
        for (let y = 0; y < gm.height; y++) {
          for (let x = 0; x < gm.width; x++) {
            const atlasIdx = (pos.y + y) * atlasWidth + (pos.x + x);
            atlasData[atlasIdx] = sdfBitmap[y * gm.width + x];
          }
        }
      }

      // Store glyph metrics
      glyphMap.set(gm.codePoint, {
        codePoint: gm.codePoint,
        char: gm.char,
        atlasX: pos.x,
        atlasY: pos.y,
        atlasWidth: gm.width,
        atlasHeight: gm.height,
        bearingX: gm.bearingX,
        bearingY: gm.bearingY,
        advance: gm.advance,
        uv: {
          u0: pos.x / atlasWidth,
          v0: pos.y / atlasHeight,
          u1: (pos.x + gm.width) / atlasWidth,
          v1: (pos.y + gm.height) / atlasHeight,
        },
      });
    }

    // Add space glyph (no bitmap)
    glyphMap.set(32, {
      codePoint: 32,
      char: ' ',
      atlasX: 0,
      atlasY: 0,
      atlasWidth: 0,
      atlasHeight: 0,
      bearingX: 0,
      bearingY: 0,
      advance: spaceMeasure.width,
      uv: { u0: 0, v0: 0, u1: 0, v1: 0 },
    });

    return {
      width: atlasWidth,
      height: atlasHeight,
      data: atlasData,
      mode,
      glyphs: glyphMap,
      fontMetrics: {
        family: fontFamily,
        renderSize,
        lineHeight,
        ascent,
        descent,
      },
      sdfPadding: padding,
      sdfSpread,
    };
  }

  /**
   * Upload an SDF atlas to a GPUTexture for use in shaders.
   */
  static uploadToGPU(device: GPUDevice, atlas: SDFFontAtlas): GPUTexture {
    const isMsdf = atlas.mode === 'msdf';
    const format: GPUTextureFormat = isMsdf ? 'rgba8unorm' : 'r8unorm';
    const bytesPerPixel = isMsdf ? 4 : 1;

    const texture = device.createTexture({
      label: `${atlas.mode}-atlas-${atlas.fontMetrics.family}`,
      size: { width: atlas.width, height: atlas.height },
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.writeTexture(
      { texture },
      atlas.data.buffer,
      {
        offset: atlas.data.byteOffset,
        bytesPerRow: atlas.width * bytesPerPixel,
        rowsPerImage: atlas.height,
      },
      { width: atlas.width, height: atlas.height },
    );

    return texture;
  }

  // ─── Private: Glyph Packing ───────────────────────────────

  private static packGlyphs(
    glyphs: { width: number; height: number }[],
    maxSize: number,
  ): { atlasWidth: number; atlasHeight: number; positions: { x: number; y: number }[] } {
    // Sort glyphs by height (descending) for shelf packing
    const sorted = glyphs
      .map((g, i) => ({ ...g, originalIndex: i }))
      .sort((a, b) => b.height - a.height);

    // Try progressively larger atlas sizes
    for (let size = 256; size <= maxSize; size *= 2) {
      const result = this.tryPack(sorted, size, size);
      if (result) {
        // Reorder positions to match input order
        const orderedPositions = new Array<{ x: number; y: number }>(glyphs.length);
        for (let i = 0; i < sorted.length; i++) {
          orderedPositions[sorted[i].originalIndex] = result[i];
        }
        return { atlasWidth: size, atlasHeight: size, positions: orderedPositions };
      }
    }

    // If nothing fits, use maxSize and pack what we can
    const result = this.tryPack(sorted, maxSize, maxSize) || sorted.map(() => ({ x: 0, y: 0 }));
    const orderedPositions = new Array<{ x: number; y: number }>(glyphs.length);
    for (let i = 0; i < sorted.length; i++) {
      orderedPositions[sorted[i].originalIndex] = result[i];
    }
    return { atlasWidth: maxSize, atlasHeight: maxSize, positions: orderedPositions };
  }

  private static tryPack(
    sorted: { width: number; height: number }[],
    atlasW: number,
    atlasH: number,
  ): { x: number; y: number }[] | null {
    const positions: { x: number; y: number }[] = [];
    let shelfX = 0;
    let shelfY = 0;
    let shelfHeight = 0;
    const gap = 2; // 2px gap between glyphs

    for (const g of sorted) {
      if (shelfX + g.width > atlasW) {
        // Next shelf
        shelfX = 0;
        shelfY += shelfHeight + gap;
        shelfHeight = 0;
      }

      if (shelfY + g.height > atlasH) {
        return null; // Doesn't fit
      }

      positions.push({ x: shelfX, y: shelfY });
      shelfX += g.width + gap;
      shelfHeight = Math.max(shelfHeight, g.height);
    }

    return positions;
  }

  // ─── Private: SDF Computation ─────────────────────────────

  /**
   * Compute a signed distance field from a binary bitmap using
   * the dead reckoning algorithm (fast approximation).
   *
   * Inside the glyph: positive distance (toward 1.0)
   * Outside the glyph: negative distance (toward 0.0)
   *
   * Output is quantized to 0-255 where 128 is the glyph boundary.
   */
  private static computeSDF(
    bitmap: Uint8Array,
    width: number,
    height: number,
    spread: number,
  ): Uint8Array {
    const INF = 1e10;
    const size = width * height;

    // Distance inside (from edge to interior)
    const distInside = new Float32Array(size);
    // Distance outside (from edge to exterior)
    const distOutside = new Float32Array(size);

    // Initialize distances
    for (let i = 0; i < size; i++) {
      distInside[i] = bitmap[i] === 1 ? INF : 0;
      distOutside[i] = bitmap[i] === 0 ? INF : 0;
    }

    // 2D distance transform (Meijster's algorithm / 2-pass EDT)
    this.distanceTransform2D(distInside, width, height);
    this.distanceTransform2D(distOutside, width, height);

    // Combine into SDF and quantize
    const result = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const inside = Math.sqrt(distInside[i]);
      const outside = Math.sqrt(distOutside[i]);
      // Signed distance: positive inside, negative outside
      const sd = inside - outside;
      // Normalize to [0, 1] range where 0.5 = boundary
      const normalized = sd / (2 * spread) + 0.5;
      result[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
    }

    return result;
  }

  /**
   * 2D squared Euclidean distance transform.
   * Modifies the input array in place.
   *
   * Uses Felzenszwalb & Huttenlocher's fast algorithm.
   */
  private static distanceTransform2D(grid: Float32Array, width: number, height: number): void {
    const maxDim = Math.max(width, height);
    const f = new Float32Array(maxDim);
    const d = new Float32Array(maxDim);
    const z = new Float32Array(maxDim + 1);
    const v = new Int32Array(maxDim);

    // Transform columns
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        f[y] = grid[y * width + x];
      }
      this.distanceTransform1D(f, d, v, z, height);
      for (let y = 0; y < height; y++) {
        grid[y * width + x] = d[y];
      }
    }

    // Transform rows
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        f[x] = grid[y * width + x];
      }
      this.distanceTransform1D(f, d, v, z, width);
      for (let x = 0; x < width; x++) {
        grid[y * width + x] = d[x];
      }
    }
  }

  /**
   * 1D squared Euclidean distance transform.
   * Based on Felzenszwalb & Huttenlocher (2012).
   */
  private static distanceTransform1D(
    f: Float32Array,
    d: Float32Array,
    v: Int32Array,
    z: Float32Array,
    n: number,
  ): void {
    const INF = 1e10;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    let k = 0;

    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }

    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }
}

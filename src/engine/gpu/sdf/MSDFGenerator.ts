/**
 * MSDF (Multi-channel Signed Distance Field) generation from a binary glyph
 * bitmap.
 *
 * Plain single-channel SDF rounds off sharp corners as the glyph is magnified,
 * because a single distance value cannot represent two edges meeting at a
 * point — the isocontour of a lone scalar is always smooth. MSDF stores three
 * distances (in R, G, B) to differently-coloured edge segments and recovers the
 * true edge in the shader as the **median** of the three. Where two edges meet
 * at a corner they are assigned different channel colours, so the median keeps
 * the crease sharp instead of rounding it.
 *
 * A textbook MSDF is built from the font's vector outline (Bézier segments),
 * which the browser Canvas2D API does not expose. This module reconstructs an
 * approximate polyline contour from the rasterised glyph via marching-squares,
 * detects corners by turn angle, edge-colours the contour, and computes a
 * per-channel Euclidean distance to the segments of each colour. The result is
 * corner-preserving and, crucially, produces a valid MSDF whose median equals a
 * conventional SDF away from corners — so every downstream threshold constant
 * behaves identically to the single-channel path except that corners stay
 * crisp.
 *
 * Output layout matches the SDF convention used across the engine:
 *   value in [0,1], 0.5 == the glyph boundary, > 0.5 inside, < 0.5 outside.
 * Each of R/G/B independently follows that convention.
 */

// ─── Contour extraction (marching squares on the binary bitmap) ─────────────

interface Point {
  x: number;
  y: number;
}

interface Segment {
  a: Point;
  b: Point;
  /** Edge colour as a 3-bit mask over (R,G,B); at least two bits are always set. */
  channels: number;
}

const CH_R = 0b100;
const CH_G = 0b010;
const CH_B = 0b001;

/** Sample the binary bitmap with out-of-bounds treated as "outside" (0). */
function sample(bitmap: Uint8Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return bitmap[y * w + x];
}

/**
 * Trace closed contours of a binary bitmap with marching squares. Returns one
 * or more closed loops of points on the pixel-corner grid ((w+1) x (h+1)).
 *
 * We walk the boundary edges between inside/outside pixels. Each unit cell
 * (2x2 sample) contributes 0, 1, or 2 boundary segments; we stitch shared
 * endpoints into ordered loops.
 */
function traceContours(bitmap: Uint8Array, w: number, h: number): Point[][] {
  // Collect midpoint-free, corner-grid segments per cell using the classic
  // 16-case marching-squares table. We place vertices at edge midpoints of the
  // cell so segments always connect, then simplify collinear runs afterwards.
  const rawSegments: [Point, Point][] = [];

  const top = (cx: number, cy: number): Point => ({ x: cx + 0.5, y: cy });
  const bottom = (cx: number, cy: number): Point => ({ x: cx + 0.5, y: cy + 1 });
  const left = (cx: number, cy: number): Point => ({ x: cx, y: cy + 0.5 });
  const right = (cx: number, cy: number): Point => ({ x: cx + 1, y: cy + 0.5 });

  for (let cy = -1; cy < h; cy++) {
    for (let cx = -1; cx < w; cx++) {
      const tl = sample(bitmap, w, h, cx, cy);
      const tr = sample(bitmap, w, h, cx + 1, cy);
      const bl = sample(bitmap, w, h, cx, cy + 1);
      const br = sample(bitmap, w, h, cx + 1, cy + 1);
      const code = (tl << 3) | (tr << 2) | (bl << 1) | br;

      switch (code) {
        case 1: // br
        case 14: // all but br
          rawSegments.push([bottom(cx, cy), right(cx, cy)]);
          break;
        case 2: // bl
        case 13:
          rawSegments.push([left(cx, cy), bottom(cx, cy)]);
          break;
        case 3: // bl,br
        case 12:
          rawSegments.push([left(cx, cy), right(cx, cy)]);
          break;
        case 4: // tr
        case 11:
          rawSegments.push([top(cx, cy), right(cx, cy)]);
          break;
        case 5: // tr,br
        case 10:
          rawSegments.push([top(cx, cy), bottom(cx, cy)]);
          break;
        case 6: // tr,bl (saddle)
          rawSegments.push([top(cx, cy), left(cx, cy)]);
          rawSegments.push([bottom(cx, cy), right(cx, cy)]);
          break;
        case 9: // tl,br (saddle)
          rawSegments.push([top(cx, cy), right(cx, cy)]);
          rawSegments.push([left(cx, cy), bottom(cx, cy)]);
          break;
        case 7: // tl,bl,br  (only tr outside)
        case 8: // tl
          rawSegments.push([top(cx, cy), left(cx, cy)]);
          break;
        default:
          // 0 (all outside) and 15 (all inside): no boundary
          break;
      }
    }
  }

  return stitchLoops(rawSegments);
}

/** Key a point on the half-integer grid for exact stitching. */
function keyOf(p: Point): string {
  return `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
}

/** Stitch unordered boundary segments into ordered closed loops. */
function stitchLoops(segments: [Point, Point][]): Point[][] {
  const adjacency = new Map<string, Point[]>();
  const push = (p: Point, q: Point) => {
    const k = keyOf(p);
    const list = adjacency.get(k);
    if (list) list.push(q);
    else adjacency.set(k, [q]);
  };
  for (const [a, b] of segments) {
    push(a, b);
    push(b, a);
  }

  const visited = new Set<string>();
  const loops: Point[][] = [];

  for (const [a, b] of segments) {
    const startKey = `${keyOf(a)}->${keyOf(b)}`;
    if (visited.has(startKey)) continue;

    const loop: Point[] = [a];
    let prev = a;
    let curr = b;
    let guard = 0;
    const maxSteps = segments.length * 2 + 8;

    while (guard++ < maxSteps) {
      loop.push(curr);
      visited.add(`${keyOf(prev)}->${keyOf(curr)}`);
      visited.add(`${keyOf(curr)}->${keyOf(prev)}`);

      const neighbours = adjacency.get(keyOf(curr)) ?? [];
      let next: Point | null = null;
      for (const n of neighbours) {
        if (keyOf(n) === keyOf(prev)) continue;
        if (visited.has(`${keyOf(curr)}->${keyOf(n)}`)) continue;
        next = n;
        break;
      }
      if (!next || keyOf(next) === keyOf(a)) break;
      prev = curr;
      curr = next;
    }

    if (loop.length >= 3) loops.push(simplifyCollinear(loop));
  }

  return loops;
}

/** Drop points that lie on a straight run so corners survive turn detection. */
function simplifyCollinear(loop: Point[]): Point[] {
  if (loop.length < 3) return loop;
  const out: Point[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];
    const d1x = curr.x - prev.x;
    const d1y = curr.y - prev.y;
    const d2x = next.x - curr.x;
    const d2y = next.y - curr.y;
    const cross = d1x * d2y - d1y * d2x;
    // Keep the point only if the direction changes (non-collinear).
    if (Math.abs(cross) > 1e-6) out.push(curr);
  }
  return out.length >= 3 ? out : loop;
}

// ─── Edge colouring ─────────────────────────────────────────────────────────

/** Angle between incoming and outgoing edge at a vertex, in radians. */
function turnAngle(prev: Point, curr: Point, next: Point): number {
  const ax = curr.x - prev.x;
  const ay = curr.y - prev.y;
  const bx = next.x - curr.x;
  const by = next.y - curr.y;
  const la = Math.hypot(ax, ay) || 1;
  const lb = Math.hypot(bx, by) || 1;
  const dot = (ax * bx + ay * by) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/**
 * Assign each contour segment a two-channel colour, switching the colour at
 * corners (sharp turns). Adjacent segments sharing a smooth join keep the same
 * colour so their distances agree; at a corner the colour flips so the two
 * incident edges live in different channels and the median keeps the corner.
 *
 * Colours cycle through the three "two-bit" masks {RG, GB, RB} — every mask has
 * exactly two channels set, guaranteeing the median-of-three recovers a real
 * edge everywhere.
 */
const TWO_BIT_COLOURS = [CH_R | CH_G, CH_G | CH_B, CH_R | CH_B];
const CORNER_THRESHOLD = Math.PI / 6; // ~30° turn counts as a corner

function colourLoop(loop: Point[]): Segment[] {
  const n = loop.length;
  const segments: Segment[] = [];
  if (n < 2) return segments;

  // Find corner indices.
  const isCorner: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];
    isCorner[i] = turnAngle(prev, curr, next) > CORNER_THRESHOLD;
  }

  // A glyph with no detected corners (a smooth blob) still needs two colours so
  // the median is well-defined; alternate on a coarse schedule in that case.
  const anyCorner = isCorner.some(Boolean);

  let colourIdx = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    if (isCorner[i] || (!anyCorner && i > 0 && i % Math.max(2, Math.floor(n / 3)) === 0)) {
      colourIdx = (colourIdx + 1) % TWO_BIT_COLOURS.length;
    }
    segments.push({ a, b, channels: TWO_BIT_COLOURS[colourIdx] });
  }

  // Ensure the loop's first and last colours differ if it closed on a corner,
  // otherwise the seam becomes a false smooth join.
  if (segments.length >= 2 && isCorner[0]) {
    const last = segments[segments.length - 1];
    if (last.channels === segments[0].channels) {
      last.channels = TWO_BIT_COLOURS[(TWO_BIT_COLOURS.indexOf(last.channels) + 1) % 3];
    }
  }

  return segments;
}

// ─── Distance field assembly ────────────────────────────────────────────────

/** Squared distance from point p to segment [a,b]. */
function distToSegmentSq(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    const ex = px - a.x;
    const ey = py - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

interface MSDFResult {
  /** RGBA interleaved, 4 bytes/pixel; A is 255 (opaque). width*height*4 long. */
  data: Uint8Array;
}

/**
 * Generate an MSDF for a single glyph bitmap.
 *
 * @param bitmap  binary bitmap (1 = inside glyph, 0 = outside), row-major
 * @param width   bitmap width in pixels
 * @param height  bitmap height in pixels
 * @param spread  SDF spread in pixels; distances are normalised by 2*spread
 *                so 0.5 == boundary, matching the single-channel path.
 */
export function computeMSDF(
  bitmap: Uint8Array,
  width: number,
  height: number,
  spread: number,
): MSDFResult {
  const loops = traceContours(bitmap, width, height);
  const segments: Segment[] = [];
  for (const loop of loops) segments.push(...colourLoop(loop));

  const data = new Uint8Array(width * height * 4);

  // Fallback: a glyph with no traceable contour (degenerate) yields a flat
  // "fully outside" field so the shader simply renders nothing there.
  if (segments.length === 0) {
    for (let i = 0; i < width * height; i++) {
      data[i * 4 + 0] = 0;
      data[i * 4 + 1] = 0;
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
    return { data };
  }

  const norm = 2 * spread;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Nearest distance per channel.
      let dR = Infinity;
      let dG = Infinity;
      let dB = Infinity;
      for (const seg of segments) {
        const dSq = distToSegmentSq(px, py, seg.a, seg.b);
        if (seg.channels & CH_R && dSq < dR) dR = dSq;
        if (seg.channels & CH_G && dSq < dG) dG = dSq;
        if (seg.channels & CH_B && dSq < dB) dB = dSq;
      }

      // Sign: inside the glyph the distance is positive (toward 1).
      const inside = bitmap[y * width + x] === 1 ? 1 : -1;

      const rr = encodeChannel(dR, inside, norm);
      const gg = encodeChannel(dG, inside, norm);
      const bb = encodeChannel(dB, inside, norm);

      const idx = (y * width + x) * 4;
      data[idx + 0] = rr;
      data[idx + 1] = gg;
      data[idx + 2] = bb;
      data[idx + 3] = 255;
    }
  }

  return { data };
}

/**
 * Encode one channel's signed distance to a 0-255 byte where 128 == boundary.
 * `dSq` is a squared pixel distance; `inside` is +1 or -1.
 */
function encodeChannel(dSq: number, inside: number, norm: number): number {
  const d = dSq === Infinity ? norm : Math.sqrt(dSq);
  const signed = inside * d; // positive inside, negative outside
  const normalized = signed / norm + 0.5;
  return Math.max(0, Math.min(255, Math.round(normalized * 255)));
}

/** The shader-side median-of-three, exposed for tests and parity checks. */
export function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

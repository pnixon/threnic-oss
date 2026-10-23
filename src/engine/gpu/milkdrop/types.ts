/**
 * Milkdrop Engine — core types.
 *
 * The engine is built on one hard constraint: every frame samples the previous
 * frame, so rendering is strictly sequential. Frame N is a function of frame
 * N-1 all the way back to zero. Nothing here may read a wall clock, a live
 * AnalyserNode, or an accumulated delta — all time is `frame / fps` and all
 * audio comes from a precomputed table indexed by frame.
 *
 * See docs/architecture/milkdrop-engine.md.
 */

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/** One row of the precomputed audio table. All values are frame-deterministic. */
export interface AudioFrame {
  /** Frame index this row was computed for */
  frame: number;
  /** Bands relative to the track's rolling average — ~1.0 is average loudness */
  bass: number;
  mid: number;
  treb: number;
  /** Overall volume (mean of the three bands) */
  vol: number;
  /** Attenuated (slow-follower) variants — Milkdrop's bass_att / mid_att / treb_att */
  bassAtt: number;
  midAtt: number;
  trebAtt: number;
  volAtt: number;
  /** 1 on the frame a beat was detected, decaying to 0 over following frames */
  beat: number;
  /** Monotonic count of detected beats since frame 0 */
  beatCounter: number;
}

/** Immutable, frame-indexed audio for a whole track. Preview and export read this. */
export interface AudioTableLike {
  readonly fps: number;
  readonly frameCount: number;
  /** Clamped lookup — out-of-range frames return the nearest edge row. */
  at(frame: number): AudioFrame;
  /** Waveform window for `frame`, `length` samples, each in -1..1. */
  waveform(frame: number, length: number): Float32Array;
}

// ---------------------------------------------------------------------------
// Per-frame motion state (the CPU-sequential half of a preset)
// ---------------------------------------------------------------------------

/**
 * The output of the per-frame equations: everything the GPU passes need for
 * this frame. Packed into a single uniform block; every node reads the same one.
 */
export interface MotionState {
  /** Radial zoom per frame. 1 = no zoom, >1 = zoom in */
  zoom: number;
  /** Radial zoom exponent — bends zoom by distance from centre */
  zoomExp: number;
  /** Rotation in radians per frame */
  rot: number;
  /** Warp amount (sinusoidal mesh distortion) */
  warp: number;
  /** Warp animation speed multiplier */
  warpAnimSpeed: number;
  /** Rotation / zoom centre in UV space */
  cx: number;
  cy: number;
  /** Translation per frame in UV space */
  dx: number;
  dy: number;
  /** Stretch */
  sx: number;
  sy: number;
  /** Feedback decay per frame (1 = no fade) */
  decay: number;
  /** Composite gamma adjust */
  gammaAdj: number;
  /** Video echo */
  echoZoom: number;
  echoAlpha: number;
  /** 0..3 — flip x, flip y, flip both */
  echoOrient: number;
  /** Composite flags */
  brighten: number;
  darken: number;
  solarize: number;
  invert: number;
  /** Composite opacity over whatever the layer is drawn on top of */
  opacity: number;
  /** 0 = alpha over, 1 = additive */
  blendMode: number;
  /** q1..q32 — propagate from per-frame equations down to per-vertex/per-pixel */
  q: Float32Array;
}

// ---------------------------------------------------------------------------
// Frame context — the single argument every pass update takes
// ---------------------------------------------------------------------------

export interface FrameContext {
  /** Integer frame index since the start of the render (never a timestamp) */
  frame: number;
  /** frames per second — identical in preview and export */
  fps: number;
  /** frame / fps */
  time: number;
  /** Always exactly 1 / fps */
  dt: number;
  /** Deterministic per-scene seed; all randomness derives from it */
  seed: number;
  audio: AudioFrame;
  motion: MotionState;
  /** Fixed internal feedback-buffer size, independent of output resolution */
  internalWidth: number;
  internalHeight: number;
  /** Output (canvas / export) size — used only by the composite node */
  outputWidth: number;
  outputHeight: number;
  /** Warp mesh density */
  meshCols: number;
  meshRows: number;
}

// ---------------------------------------------------------------------------
// Pass graph
// ---------------------------------------------------------------------------

/** How a node's geometry is generated. No vertex buffers anywhere. */
type NodeDraw =
  | { kind: 'fullscreen' }
  /** Warp-style vertex grid: cols × rows quads, 6 verts each, generated from vertex_index */
  | { kind: 'grid'; cols: number; rows: number }
  /** Instanced geometry (custom shapes, the 3D city layer, …) */
  | {
      kind: 'instanced';
      verticesPerInstance: number;
      instances: number;
      topology?: GPUPrimitiveTopology;
    };

export interface GraphNodeDef {
  /** Unique node id */
  id: string;
  /**
   * WGSL body. The graph prepends the shared prelude (uniform block, accessors,
   * hash, NaN guards) and appends entry points appropriate to `draw`.
   */
  wgsl: string;
  draw: NodeDraw;
  /**
   * Buffer names to bind as sampled textures, in order, starting at binding 2.
   * Reading the same buffer this node writes to means "read the previous frame"
   * — the graph ping-pongs it automatically.
   */
  inputs?: string[];
  /** Buffer name this node renders into. */
  output: string;
  /** Defaults to alpha blending off (replace). */
  blend?: GPUBlendState;
  /** Defaults to 'load' so nodes composite onto what came before. */
  loadOp?: GPULoadOp;
  clearValue?: GPUColor;
  /** Nodes run in ascending order; ties broken by insertion order. Default 100. */
  order?: number;
  enabled?: boolean;
}

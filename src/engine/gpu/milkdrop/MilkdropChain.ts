/**
 * MilkdropChain — the standard preset shape, assembled out of graph nodes.
 *
 * inject (optional) -> warp -> [custom nodes] -> composite
 *
 * Milkdrop parity is a preset shape here, not the architecture: the chain just
 * registers nodes in the PassGraph, and callers can register their own between
 * warp and composite (custom shapes, waves, an instanced 3D scene, a lyric
 * composite) with `graph.addNode`.
 */

import { AudioTable } from './AudioTable';
import { FrameClock } from './FrameClock';
import { compileWGSL, parseEquations } from './ir';
import { PerFrameRunner, type BaseMotion } from './perFrame';
import { PassGraph, PRESENT, type PassGraphOptions } from './PassGraph';
import { FRAME_SLOTS } from './uniforms';
import { compositeNodeWGSL, injectNodeWGSL } from './wgsl/composite';
import { customDrawNodeWGSL, pulseNodeWGSL } from './wgsl/pulse';
import { warpNodeWGSL } from './wgsl/warp';
import { shapeNodeWGSL, type ShapeConfig, DEFAULT_SHAPE_CONFIG } from './wgsl/shapes';
import { waveNodeWGSL, type WaveConfig, DEFAULT_WAVE_CONFIG } from './wgsl/waves';
import type { AudioTableLike, FrameContext, GraphNodeDef } from './types';

const FEEDBACK = 'feedback';
const SCENE_INPUT = 'scene';

const NODE_ORDER = {
  inject: 10,
  warp: 20,
  /** Shapes, waves, 3D layers, anything drawing into the feedback buffer. */
  draw: 50,
  composite: 900,
} as const;

export interface MilkdropPreset {
  id: string;
  label?: string;
  /** Base motion values, applied before the per-frame equations each frame. */
  base?: Partial<BaseMotion>;
  /** Per-frame equation source (CPU, sequential). */
  perFrame?: string;
  /** Per-vertex equation source (compiled to WGSL, runs in the warp mesh). */
  perVertex?: string;
  /** Warp mesh density. Defaults to 64x48 — Milkdrop shipped 48x36 on the CPU. */
  meshCols?: number;
  meshRows?: number;
  /** Composite blend against whatever the layer is drawn over. */
  blendMode?: 'alpha' | 'additive';
  /**
   * Built-in draw stage. A feedback chain with nothing drawing into it
   * converges to black, so the default adds the pulse node. Set 'none' when
   * registering your own draw nodes.
   */
  source?: 'pulse' | 'none';
  /**
   * Custom fullscreen draw shader body (raw WGSL). When set and source !== 'none',
   * replaces the generic pulse with a per-preset fragment shader. The body has
   * access to `in.uv`, all md_* uniforms/helpers from the prelude, and must
   * return `md_guard(vec4f(rgb, alpha))`.
   */
  drawShader?: string;
  /** Custom shapes drawn into the feedback buffer (up to 4). */
  shapes?: ShapeConfig[];
  /** Custom waves (audio waveform line-strips) drawn into the feedback buffer (up to 4). */
  waves?: WaveConfig[];
}

interface MilkdropChainOptions extends PassGraphOptions {
  fps: number;
  seed?: number;
  audio?: AudioTableLike;
  meshCols?: number;
  meshRows?: number;
  /**
   * When true, an inject node pulls the `scene` external texture into the
   * feedback buffer each frame, so the chain warps existing content.
   */
  consumeScene?: boolean;
}

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const ADDITIVE_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** Every uniform field is readable by name from per-vertex equations. */
function uniformReads(): Record<string, string> {
  const reads: Record<string, string> = {};
  for (const slot of FRAME_SLOTS) {
    for (const c of slot.components) {
      if (c !== '_') reads[c] = `md_${c}()`;
    }
  }
  // Equation-language spellings that differ from uniform field names.
  reads.zoomexp = 'md_zoom_exp()';
  reads.gamma = 'md_gamma_adj()';
  reads.warp_speed = 'md_warp_speed()';
  // Per-vertex locals supplied by the warp vertex stage.
  reads.rad = 'rad';
  reads.ang = 'ang';
  return reads;
}

const ALL_NODE_IDS = ['md-inject', 'md-pulse', 'md-warp', 'md-composite'] as const;
const DYNAMIC_NODE_PREFIX = ['md-shape-', 'md-wave-'];

interface MilkdropNodeOptions {
  consumeScene?: boolean;
  meshCols?: number;
  meshRows?: number;
}

/**
 * The node defs for a preset — pure, so shader validation can compile exactly
 * what the chain would without a GPU in the room.
 */
function buildMilkdropNodes(
  preset: MilkdropPreset,
  options: MilkdropNodeOptions = {},
): GraphNodeDef[] {
  const consumeScene = options.consumeScene ?? false;
  const cols = preset.meshCols ?? options.meshCols ?? 64;
  const rows = preset.meshRows ?? options.meshRows ?? 48;
  const defs: GraphNodeDef[] = [];

  if (consumeScene) {
    defs.push({
      id: 'md-inject',
      wgsl: injectNodeWGSL(),
      draw: { kind: 'fullscreen' },
      inputs: [SCENE_INPUT],
      output: FEEDBACK,
      loadOp: 'clear',
      order: NODE_ORDER.inject,
    });
  }

  if (!consumeScene && preset.source !== 'none') {
    const drawWGSL = preset.drawShader ? customDrawNodeWGSL(preset.drawShader) : pulseNodeWGSL();
    defs.push({
      id: 'md-pulse',
      wgsl: drawWGSL,
      draw: { kind: 'fullscreen' },
      output: FEEDBACK,
      blend: ADDITIVE_BLEND,
      loadOp: 'load',
      order: NODE_ORDER.draw,
    });
  }

  let perVertexDeclarations = '';
  let perVertex = '';
  if (preset.perVertex?.trim()) {
    const emitted = compileWGSL(parseEquations(preset.perVertex), {
      reads: uniformReads(),
      vars: { x: 'x', y: 'y' },
    });
    perVertexDeclarations = emitted.declarations;
    perVertex = emitted.body;
  }

  defs.push({
    id: 'md-warp',
    wgsl: warpNodeWGSL({ perVertexDeclarations, perVertex }),
    draw: { kind: 'grid', cols, rows },
    inputs: [FEEDBACK],
    output: FEEDBACK,
    order: NODE_ORDER.warp,
  });

  // Custom shapes (drawn after warp, into the feedback buffer)
  if (preset.shapes && preset.shapes.length > 0) {
    preset.shapes.forEach((shapeCfg, i) => {
      const cfg = { ...DEFAULT_SHAPE_CONFIG, ...shapeCfg };
      defs.push({
        id: `md-shape-${i}`,
        wgsl: shapeNodeWGSL(cfg),
        draw: {
          kind: 'instanced',
          verticesPerInstance: cfg.sides + 2,
          instances: cfg.instances,
          topology: cfg.filled ? 'triangle-strip' : 'line-strip',
        },
        output: FEEDBACK,
        blend: cfg.additive ? ADDITIVE_BLEND : ALPHA_BLEND,
        loadOp: 'load',
        order: NODE_ORDER.draw + 1 + i,
      });
    });
  }

  // Custom waves (drawn after shapes, into the feedback buffer)
  if (preset.waves && preset.waves.length > 0) {
    preset.waves.forEach((waveCfg, i) => {
      const cfg = { ...DEFAULT_WAVE_CONFIG, ...waveCfg };
      defs.push({
        id: `md-wave-${i}`,
        wgsl: waveNodeWGSL(cfg),
        draw: {
          kind: 'instanced',
          verticesPerInstance: cfg.samples,
          instances: cfg.instances,
          topology: 'line-strip',
        },
        output: FEEDBACK,
        blend: cfg.additive ? ADDITIVE_BLEND : ALPHA_BLEND,
        loadOp: 'load',
        order: NODE_ORDER.draw + 10 + i,
      });
    });
  }

  defs.push({
    id: 'md-composite',
    wgsl: compositeNodeWGSL(),
    draw: { kind: 'fullscreen' },
    inputs: [FEEDBACK],
    output: PRESENT,
    blend: preset.blendMode === 'additive' ? ADDITIVE_BLEND : ALPHA_BLEND,
    order: NODE_ORDER.composite,
  });

  return defs;
}

export class MilkdropChain {
  readonly graph: PassGraph;
  readonly clock: FrameClock;

  private runner: PerFrameRunner;
  private audio: AudioTableLike;
  private preset: MilkdropPreset;
  private seed: number;
  private meshCols: number;
  private meshRows: number;
  private consumeScene: boolean;
  private needsClear = true;

  constructor(options: MilkdropChainOptions) {
    this.graph = new PassGraph(options);
    this.clock = new FrameClock(options.fps);
    this.seed = options.seed ?? 0;
    this.meshCols = options.meshCols ?? 64;
    this.meshRows = options.meshRows ?? 48;
    this.consumeScene = options.consumeScene ?? false;
    this.audio = options.audio ?? AudioTable.silent(options.fps, 1);
    this.preset = { id: 'empty' };
    this.runner = new PerFrameRunner({ seed: this.seed });
    this.buildNodes();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Load a preset. Compiles per-frame equations to closures and per-vertex
   * equations to WGSL, then rebuilds the warp node. Throws ParseError with a
   * line number if the equations do not parse.
   */
  loadPreset(preset: MilkdropPreset): void {
    this.preset = preset;
    this.meshCols = preset.meshCols ?? this.meshCols;
    this.meshRows = preset.meshRows ?? this.meshRows;
    this.runner = new PerFrameRunner({
      source: preset.perFrame,
      base: preset.base,
      seed: this.seed,
    });
    this.buildNodes();
    this.needsClear = true;
  }

  setAudioTable(table: AudioTableLike): void {
    if (table.fps !== this.clock.fps) {
      throw new Error(
        `[milkdrop] audio table is ${table.fps}fps but the chain runs at ${this.clock.fps}fps; ` +
          'rebuild the table at the render framerate',
      );
    }
    this.audio = table;
  }

  /** Bind the texture the chain should ingest when `consumeScene` is set. */
  setSceneTexture(view: GPUTextureView | null): void {
    this.graph.setExternalTexture(SCENE_INPUT, view);
  }

  /** Queue a full reset of the feedback chain — call on seek or preset change. */
  invalidate(): void {
    this.needsClear = true;
    this.runner.reset();
  }

  private buildNodes(): void {
    const defs = buildMilkdropNodes(this.preset, {
      consumeScene: this.consumeScene,
      meshCols: this.meshCols,
      meshRows: this.meshRows,
    });
    const wanted = new Set(defs.map((d) => d.id));
    // Remove static nodes not in the new set
    for (const id of ALL_NODE_IDS) {
      if (!wanted.has(id)) this.graph.removeNode(id);
    }
    // Remove any old dynamic shape/wave nodes
    for (const prefix of DYNAMIC_NODE_PREFIX) {
      for (let i = 0; i < 8; i++) {
        const id = prefix + i;
        if (!wanted.has(id)) this.graph.removeNode(id);
      }
    }
    for (const def of defs) this.graph.addNode(def);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * Render one frame at an explicit frame index.
   *
   * The index is the caller's — export drives it from the encoder, preview
   * from FrameClock.framesToAdvance(). Frames must be rendered in order and
   * without gaps; a gap is a different image, not a dropped one.
   */
  renderFrame(
    encoder: GPUCommandEncoder,
    frame: number,
    presentView: GPUTextureView,
    outputWidth: number,
    outputHeight: number,
  ): FrameContext {
    if (this.needsClear) {
      this.graph.clearBuffers(encoder);
      this.needsClear = false;
    }

    this.clock.seek(frame);
    const audio = this.audio.at(frame);
    const motion = this.runner.evaluate(frame, this.clock.fps, audio);

    const ctx: FrameContext = {
      frame,
      fps: this.clock.fps,
      time: frame / this.clock.fps,
      dt: 1 / this.clock.fps,
      seed: this.seed,
      audio,
      motion,
      internalWidth: this.graph.internalWidth,
      internalHeight: this.graph.internalHeight,
      outputWidth,
      outputHeight,
      meshCols: this.meshCols,
      meshRows: this.meshRows,
    };

    this.graph.execute(encoder, ctx, presentView);
    return ctx;
  }

  // -------------------------------------------------------------------------
  // Segmented exports
  // -------------------------------------------------------------------------

  /** CPU-side variable state; pair with graph.saveBuffer for the GPU side. */
  saveState(): Float64Array {
    return this.runner.snapshot();
  }

  restoreState(state: Float64Array): void {
    this.runner.restore(state);
    // The caller restored (or will restore) the feedback texture too, so do
    // not clear it out from under them.
    this.needsClear = false;
  }

  destroy(): void {
    this.graph.destroy();
  }
}

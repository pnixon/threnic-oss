/**
 * PassGraph — Milkdrop's fixed pipeline, generalized.
 *
 * warp -> shapes -> waves -> composite is one instance of a node graph, not
 * the architecture. Nodes declare their inputs, their output buffer, and a
 * WGSL body; the graph owns the textures, the ping-pong, and the single frame
 * uniform block every node reads. An instanced 3D scene node or a lyric
 * composite node slots in exactly like the built-in ones do.
 *
 * Buffers live at a fixed internal resolution regardless of output size, so
 * blur radii and warp displacements mean the same thing in a preview and in a
 * 4K export.
 *
 * Binding convention (group 0), which node WGSL must follow:
 *   0  frame uniform block (vertex + fragment)
 *   1  linear sampler
 *   2+ this node's `inputs`, in order, as texture_2d<f32>
 */

import { FRAME_UNIFORM_FLOATS, FRAME_UNIFORM_SIZE, packFrameUniforms } from './uniforms';
import { MD_FULLSCREEN_VS, MD_PRELUDE, MD_VARYINGS, mdGridVertexWGSL } from './wgsl/prelude';
import type { FrameContext, GraphNodeDef } from './types';

/** Name of the pseudo-buffer that means "the caller's render target". */
export const PRESENT = 'present';

const DEFAULT_INTERNAL_WIDTH = 1280;
const DEFAULT_INTERNAL_HEIGHT = 720;

/** Feedback needs headroom and cannot afford 8-bit banding across generations. */
const INTERNAL_FORMAT: GPUTextureFormat = 'rgba16float';

interface DoubleBuffer {
  name: string;
  textures: [GPUTexture, GPUTexture];
  views: [GPUTextureView, GPUTextureView];
  /** Index of the readable (most recently written) texture. */
  front: 0 | 1;
}

interface CompiledNode {
  def: GraphNodeDef;
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
  vertexCount: number;
  instanceCount: number;
  bindGroups: Map<string, GPUBindGroup>;
}

export interface PassGraphOptions {
  device: GPUDevice;
  /** Format of the caller's render target — the composite node's output. */
  presentFormat: GPUTextureFormat;
  internalWidth?: number;
  internalHeight?: number;
}

/**
 * Assemble a node's full shader module: shared prelude, varyings, the node
 * body, and the vertex stage its draw mode implies. Exported so shader
 * validation (scripts/validate-milkdrop-wgsl.mjs) compiles exactly what the
 * graph would.
 */
function composeNodeWGSL(def: GraphNodeDef): string {
  // Instanced nodes bring their own vertex stage in `wgsl`.
  if (def.draw.kind === 'instanced') {
    return `${MD_PRELUDE}
${MD_VARYINGS}
${def.wgsl}`;
  }
  const vertexStage =
    def.draw.kind === 'grid' ? mdGridVertexWGSL(def.draw.cols, def.draw.rows) : MD_FULLSCREEN_VS;
  return `${MD_PRELUDE}
${MD_VARYINGS}
${def.wgsl}
${vertexStage}`;
}

export class PassGraph {
  readonly device: GPUDevice;
  readonly presentFormat: GPUTextureFormat;
  readonly internalWidth: number;
  readonly internalHeight: number;

  private buffers = new Map<string, DoubleBuffer>();
  private externals = new Map<string, GPUTextureView>();
  private externalGeneration = 0;
  private nodes: CompiledNode[] = [];

  private uniformBuffer: GPUBuffer;
  private uniformScratch = new Float32Array(FRAME_UNIFORM_FLOATS);
  private sampler: GPUSampler;

  constructor(options: PassGraphOptions) {
    this.device = options.device;
    this.presentFormat = options.presentFormat;
    this.internalWidth = options.internalWidth ?? DEFAULT_INTERNAL_WIDTH;
    this.internalHeight = options.internalHeight ?? DEFAULT_INTERNAL_HEIGHT;

    this.uniformBuffer = this.device.createBuffer({
      label: 'milkdrop-frame-uniforms',
      size: FRAME_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Milkdrop wraps at the edges; mirroring would fold the feedback back on
    // itself and kill the tunnel effect.
    this.sampler = this.device.createSampler({
      label: 'milkdrop-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
  }

  // -------------------------------------------------------------------------
  // Buffers
  // -------------------------------------------------------------------------

  /** Allocate (or return) a double-buffered internal target. */
  ensureBuffer(name: string): DoubleBuffer {
    const existing = this.buffers.get(name);
    if (existing) return existing;

    const make = (suffix: string): GPUTexture =>
      this.device.createTexture({
        label: `milkdrop-${name}-${suffix}`,
        size: { width: this.internalWidth, height: this.internalHeight },
        format: INTERNAL_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });

    const a = make('a');
    const b = make('b');
    const buf: DoubleBuffer = {
      name,
      textures: [a, b],
      views: [a.createView(), b.createView()],
      front: 0,
    };
    this.buffers.set(name, buf);
    return buf;
  }

  /** Texture a node would read for `name` this frame. */
  readView(name: string): GPUTextureView | null {
    const ext = this.externals.get(name);
    if (ext) return ext;
    const buf = this.buffers.get(name);
    return buf ? buf.views[buf.front] : null;
  }

  /** Bind a caller-owned texture under `name` (e.g. the scene behind us). */
  setExternalTexture(name: string, view: GPUTextureView | null): void {
    if (view) this.externals.set(name, view);
    else this.externals.delete(name);
    this.externalGeneration++;
    // External views change identity between frames; bind groups referencing
    // them must be rebuilt.
    for (const node of this.nodes) node.bindGroups.clear();
  }

  /** Zero every internal buffer. Call on seek, preset load, or scene start. */
  clearBuffers(encoder: GPUCommandEncoder): void {
    for (const buf of this.buffers.values()) {
      for (const view of buf.views) {
        encoder
          .beginRenderPass({
            colorAttachments: [
              {
                view,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          })
          .end();
      }
      buf.front = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  /** Compile and register a node. Replaces any node with the same id. */
  addNode(def: GraphNodeDef): void {
    this.removeNode(def.id);

    const inputs = def.inputs ?? [];
    for (const name of inputs) {
      if (!this.externals.has(name)) this.ensureBuffer(name);
    }
    if (def.output !== PRESENT) this.ensureBuffer(def.output);

    const entries: GPUBindGroupLayoutEntry[] = [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' as const },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' as const } },
    ];
    inputs.forEach((_name, i) => {
      entries.push({
        binding: 2 + i,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' as const },
      });
    });

    const layout = this.device.createBindGroupLayout({
      label: `milkdrop-${def.id}-bgl`,
      entries,
    });

    const shader = this.device.createShaderModule({
      label: `milkdrop-${def.id}`,
      code: composeNodeWGSL(def),
    });

    const pipeline = this.device.createRenderPipeline({
      label: `milkdrop-${def.id}-pipeline`,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [
          {
            format: def.output === PRESENT ? this.presentFormat : INTERNAL_FORMAT,
            blend: def.blend,
          },
        ],
      },
      primitive: {
        topology:
          def.draw.kind === 'instanced' ? (def.draw.topology ?? 'triangle-list') : 'triangle-list',
      },
    });

    let vertexCount = 3;
    let instanceCount = 1;
    if (def.draw.kind === 'grid') vertexCount = def.draw.cols * def.draw.rows * 6;
    if (def.draw.kind === 'instanced') {
      vertexCount = def.draw.verticesPerInstance;
      instanceCount = def.draw.instances;
    }

    this.nodes.push({ def, pipeline, layout, vertexCount, instanceCount, bindGroups: new Map() });
    this.nodes.sort((a, b) => (a.def.order ?? 100) - (b.def.order ?? 100));
  }

  removeNode(id: string): void {
    this.nodes = this.nodes.filter((n) => n.def.id !== id);
  }

  hasNode(id: string): boolean {
    return this.nodes.some((n) => n.def.id === id);
  }

  setNodeEnabled(id: string, enabled: boolean): void {
    const node = this.nodes.find((n) => n.def.id === id);
    if (node) node.def.enabled = enabled;
  }

  // -------------------------------------------------------------------------
  // Execute
  // -------------------------------------------------------------------------

  /**
   * Record one frame. Strictly sequential: the caller must not skip frames or
   * reorder them, because every node that reads its own output reads frame N-1.
   */
  execute(encoder: GPUCommandEncoder, ctx: FrameContext, presentView: GPUTextureView | null): void {
    packFrameUniforms(this.uniformScratch, ctx);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformScratch);

    for (const node of this.nodes) {
      if (node.def.enabled === false) continue;
      const { def } = node;

      const inputs = def.inputs ?? [];
      const readsOwnOutput = inputs.includes(def.output);

      let targetView: GPUTextureView | null;
      let outBuf: DoubleBuffer | undefined;
      if (def.output === PRESENT) {
        targetView = presentView;
      } else {
        outBuf = this.ensureBuffer(def.output);
        // Reading your own output means reading the previous frame: render
        // into the back texture and swap. Otherwise draw in place, on top of
        // what earlier nodes put there.
        targetView = readsOwnOutput ? outBuf.views[outBuf.front ^ 1] : outBuf.views[outBuf.front];
      }
      if (!targetView) continue;

      const inputViews: GPUTextureView[] = [];
      let missing = false;
      for (const name of inputs) {
        const view = this.readView(name);
        if (!view) {
          missing = true;
          break;
        }
        inputViews.push(view);
      }
      if (missing) continue;

      const key =
        inputs.map((n) => this.buffers.get(n)?.front ?? 'x').join(',') +
        '|' +
        (outBuf ? outBuf.front : 'p') +
        '|' +
        this.externalGeneration;

      let bindGroup = node.bindGroups.get(key);
      if (!bindGroup) {
        bindGroup = this.device.createBindGroup({
          label: `milkdrop-${def.id}-bg`,
          layout: node.layout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer } },
            { binding: 1, resource: this.sampler },
            ...inputViews.map((view, i) => ({ binding: 2 + i, resource: view })),
          ],
        });
        node.bindGroups.set(key, bindGroup);
      }

      const pass = encoder.beginRenderPass({
        label: `milkdrop-${def.id}-pass`,
        colorAttachments: [
          {
            view: targetView,
            clearValue: def.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
            loadOp: def.loadOp ?? (readsOwnOutput ? 'clear' : 'load'),
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(node.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(node.vertexCount, node.instanceCount);
      pass.end();

      if (outBuf && readsOwnOutput) outBuf.front = (outBuf.front ^ 1) as 0 | 1;
    }
  }

  // -------------------------------------------------------------------------
  // Segment boundaries
  // -------------------------------------------------------------------------

  /**
   * Copy a feedback buffer into a caller-owned texture so a long export can be
   * chunked. Segment boundaries must carry the buffer across — restarting the
   * chain at each chunk would restart the visuals with it.
   */
  saveBuffer(encoder: GPUCommandEncoder, name: string, destination: GPUTexture): void {
    const buf = this.buffers.get(name);
    if (!buf) return;
    encoder.copyTextureToTexture(
      { texture: buf.textures[buf.front] },
      { texture: destination },
      { width: this.internalWidth, height: this.internalHeight },
    );
  }

  restoreBuffer(encoder: GPUCommandEncoder, name: string, source: GPUTexture): void {
    const buf = this.ensureBuffer(name);
    encoder.copyTextureToTexture(
      { texture: source },
      { texture: buf.textures[buf.front] },
      { width: this.internalWidth, height: this.internalHeight },
    );
  }

  /** Allocate a texture suitable for save/restore of an internal buffer. */
  createSnapshotTexture(label = 'milkdrop-snapshot'): GPUTexture {
    return this.device.createTexture({
      label,
      size: { width: this.internalWidth, height: this.internalHeight },
      format: INTERNAL_FORMAT,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  destroy(): void {
    for (const buf of this.buffers.values()) {
      buf.textures[0].destroy();
      buf.textures[1].destroy();
    }
    this.buffers.clear();
    this.nodes = [];
    this.uniformBuffer.destroy();
  }
}

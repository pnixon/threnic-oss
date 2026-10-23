/**
 * RenderGraph — Multi-pass GPU render pipeline.
 *
 * Orchestrates chained render passes:
 *   background → [effect passes] → composite → present
 *
 * Each pass reads from the previous pass's output texture and writes to its
 * own render target. The final composite pass writes to the canvas swapchain
 * (or the offscreen render target for export).
 *
 * Design:
 * - Fullscreen-triangle based (no vertex buffers)
 * - Double-buffered intermediate textures (ping-pong)
 * - Effect passes are registered dynamically and can be enabled/disabled per-frame
 * - Each effect pass owns its own pipeline + uniform buffer + bind group
 * - The render graph manages texture allocation and pass ordering
 */

import { profiler } from '@/utils/profiler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters passed to each effect pass every frame. */
export interface EffectPassParams {
  /** Current playback time in seconds */
  time: number;
  /** Frame delta time */
  dt: number;
  /** Canvas resolution [width, height] */
  resolution: [number, number];
  /** Audio-reactive band values */
  audioBass: number;
  audioMid: number;
  audioHigh: number;
  audioEnergy: number;
  /** Whether playback was reset/seeked to zero */
  didReset: boolean;
}

/** Configuration for registering an effect pass. */
export interface EffectPassConfig {
  /** Unique identifier for this effect pass */
  id: string;
  /** Display name for debugging */
  label: string;
  /** WGSL shader source for the fragment effect (or entire shader if overriding) */
  shaderSource: string;
  /** Size of the uniform buffer in bytes (must be multiple of 16) */
  uniformBufferSize: number;
  /** Priority — lower values run first. Default: 100 */
  priority?: number;
  /**
   * Optional: additional bind group layout entries beyond the standard
   * input texture + sampler + uniforms. These are appended after binding 3+.
   */
  additionalBindings?: GPUBindGroupLayoutEntry[];

  /** Support for procedural geometry rather than just fullscreen quads: */
  customVertexShader?: string;
  topology?: GPUPrimitiveTopology;
  vertexCount?: number;
  instanceCount?: number;
  blend?: GPUBlendState; // Allow additive blending
  copyBeforePass?: boolean; // Copy inputTexture to outputTarget before executing the pass
  noStandardBindings?: boolean; // If true, omits standard input texture and sampler at bindings 0 and 1
}

/** An instantiated effect pass with GPU resources. */
interface EffectPass {
  config: EffectPassConfig;
  pipeline: GPURenderPipeline;
  uniformBuffer: GPUBuffer;
  bindGroupLayout: GPUBindGroupLayout;
  /** Whether this pass is currently enabled */
  enabled: boolean;
  /**
   * Callback to update uniforms each frame.
   * Must write to the provided Float32Array (which will be uploaded to GPU).
   */
  updateUniforms?: (uniforms: Float32Array, params: EffectPassParams) => void;
  /**
   * Extra bind-group entries (beyond the standard input texture / sampler /
   * uniforms) that satisfy the pass's `config.additionalBindings` layout —
   * e.g. a secondary image texture + its sampler for an overlay pass. Supplied
   * by the renderer via setPassExtraBindings() and merged into the per-frame
   * bind group in _runPassChain. Kept as GPUBindGroupEntry[] (the resource is
   * a persistent GPUTextureView / GPUSampler owned by the caller), so no
   * per-frame allocation is needed here. Undefined ⇒ no extra bindings.
   */
  extraBindings?: GPUBindGroupEntry[];
}

// ---------------------------------------------------------------------------
// Shared fullscreen vertex shader
// ---------------------------------------------------------------------------

const FULLSCREEN_VERTEX_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle covering [-1,1] in clip space
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var out: VertexOutput;
  out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  out.uv = uv[vertexIndex];
  return out;
}
`;

// ---------------------------------------------------------------------------
// Composite pass — simple passthrough
// ---------------------------------------------------------------------------

const COMPOSITE_WGSL = /* wgsl */ `
${FULLSCREEN_VERTEX_WGSL}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
}
`;

// ---------------------------------------------------------------------------
// RenderGraph
// ---------------------------------------------------------------------------

export class RenderGraph {
  private static _nextId = 1;
  /** Unique instance ID for lifecycle debugging */
  readonly instanceId: number;

  private device: GPUDevice;
  private format: GPUTextureFormat;

  // Ping-pong intermediate textures
  private pingTexture!: GPUTexture;
  private pongTexture!: GPUTexture;
  private pingView!: GPUTextureView;
  private pongView!: GPUTextureView;

  // Composite (final) pass
  private compositePipeline!: GPURenderPipeline;
  private compositeBindGroupLayout!: GPUBindGroupLayout;
  private compositeSampler!: GPUSampler;

  // Registered effect passes
  private passes: Map<string, EffectPass> = new Map();
  private sortedPassIds: string[] = [];
  /**
   * Explicit pass-execution order (by pass id), supplied by the caller
   * (EffectsManager) to make layer ordering data-driven from the user's
   * effect-instance list instead of the hardcoded per-pass `priority`.
   * When null, passes fall back to `priority`-based sorting.
   */
  private _orderOverride: string[] | null = null;

  // Dimensions
  private width = 0;
  private height = 0;

  private _initialized = false;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.instanceId = RenderGraph._nextId++;
    this.device = device;
    this.format = format;
  }

  // ─────────────────────────────────────────────────────────────
  // Init / Resize
  // ─────────────────────────────────────────────────────────────

  async init(width: number, height: number): Promise<boolean> {
    if (this._initialized) return true;

    this.width = width;
    this.height = height;

    // Create intermediate textures
    this._createIntermediateTextures();

    // Create shared sampler
    this.compositeSampler = this.device.createSampler({
      label: 'render-graph-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Build composite pass
    const ok = await this._buildCompositePipeline();
    if (!ok) return false;

    this._initialized = true;
    console.log(
      `[RenderGraph#${this.instanceId}] Initialized. ${width}x${height}, format: ${this.format}`,
    );
    return true;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0) return;

    this.width = width;
    this.height = height;

    // Recreate intermediate textures at new size
    this._destroyIntermediateTextures();
    this._createIntermediateTextures();

    console.log(`[RenderGraph#${this.instanceId}] Resized to ${width}x${height}`);
  }

  // ─────────────────────────────────────────────────────────────
  // Effect pass registration
  // ─────────────────────────────────────────────────────────────

  /**
   * Register a new post-processing effect pass.
   * Returns false if the pipeline fails to compile.
   */
  async registerPass(config: EffectPassConfig): Promise<boolean> {
    if (this.passes.has(config.id)) {
      console.warn(
        `[RenderGraph#${this.instanceId}] Pass "${config.id}" already registered, skipping.`,
      );
      return true;
    }

    // Prepend the fullscreen vertex shader to the effect's fragment shader if no custom vertex shader is passed
    const fullShader = config.customVertexShader
      ? `${config.customVertexShader}\n${config.shaderSource}`
      : `${FULLSCREEN_VERTEX_WGSL}\n${config.shaderSource}`;

    const shaderModule = this.device.createShaderModule({
      label: `${config.id}-shader`,
      code: fullShader,
    });

    // Check for compilation errors
    const info = await shaderModule.getCompilationInfo();
    for (const msg of info.messages) {
      if (msg.type === 'error') {
        console.error(
          `[RenderGraph] Shader error in "${config.id}": ${msg.message} (line ${msg.lineNum})`,
        );
        return false;
      }
    }

    // Standard bind group layout: input texture + sampler + uniforms
    const entries: GPUBindGroupLayoutEntry[] = config.noStandardBindings
      ? [
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' },
          },
        ]
      : [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'float' },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: { type: 'filtering' },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' },
          },
        ];

    // Append any additional bindings
    if (config.additionalBindings) {
      entries.push(...config.additionalBindings);
    }

    const bindGroupLayout = this.device.createBindGroupLayout({
      label: `${config.id}-bgl`,
      entries,
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: `${config.id}-pl`,
      bindGroupLayouts: [bindGroupLayout],
    });

    let pipeline: GPURenderPipeline;
    try {
      pipeline = await this.device.createRenderPipelineAsync({
        label: `${config.id}-pipeline`,
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: config.customVertexShader ? 'vs_main' : 'vs_main', // Assuming custom shaders also use 'vs_main'
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [
            {
              format: this.format,
              blend: config.blend,
            },
          ],
        },
        primitive: { topology: config.topology ?? 'triangle-list' },
      });
    } catch (err) {
      console.error(`[RenderGraph] Pipeline creation failed for "${config.id}":`, err);
      return false;
    }

    // Create uniform buffer
    const uniformBuffer = this.device.createBuffer({
      label: `${config.id}-uniforms`,
      size: Math.max(config.uniformBufferSize, 16), // Minimum 16 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const pass: EffectPass = {
      config,
      pipeline,
      uniformBuffer,
      bindGroupLayout,
      enabled: false,
    };

    this.passes.set(config.id, pass);
    this._rebuildSortedPasses();

    console.log(
      `[RenderGraph] Registered pass "${config.id}" (priority: ${config.priority ?? 100})`,
    );
    return true;
  }

  /**
   * Unregister an effect pass and free its GPU resources.
   */
  unregisterPass(id: string): void {
    const pass = this.passes.get(id);
    if (pass) {
      pass.uniformBuffer.destroy();
      this.passes.delete(id);
      this._rebuildSortedPasses();
      console.log(`[RenderGraph] Unregistered pass "${id}"`);
    }
  }

  /**
   * Enable or disable an effect pass.
   */
  setPassEnabled(id: string, enabled: boolean): void {
    const pass = this.passes.get(id);
    if (pass) {
      pass.enabled = enabled;
    }
  }

  /**
   * Set the uniform update callback for a pass.
   */
  setPassUniformUpdater(
    id: string,
    updater: (uniforms: Float32Array, params: EffectPassParams) => void,
  ): void {
    const pass = this.passes.get(id);
    if (pass) {
      pass.updateUniforms = updater;
    }
  }

  /**
   * Attach extra bind-group entries for a pass, satisfying the extra layout
   * slots declared via `config.additionalBindings` (e.g. a secondary image
   * texture + sampler for an overlay pass). The entries' `binding` numbers
   * must match the layout (i.e. start at 3+), and their `resource` must be a
   * persistent GPUTextureView / GPUSampler owned by the caller — the render
   * graph merges these into the per-frame bind group but does not own or
   * destroy them. Pass `null`/`undefined` to clear. No-op if the pass is not
   * registered (the caller re-attaches after the pass is registered).
   */
  setPassExtraBindings(id: string, entries: GPUBindGroupEntry[] | null | undefined): void {
    const pass = this.passes.get(id);
    if (pass) {
      pass.extraBindings = entries ?? undefined;
    }
  }

  /**
   * Check if a pass is registered.
   */
  hasPass(id: string): boolean {
    return this.passes.has(id);
  }

  /**
   * Check if any registered passes are currently enabled.
   * The renderer uses this to decide whether to route through the render graph.
   */
  hasEnabledPasses(): boolean {
    for (const [, pass] of this.passes) {
      if (pass.enabled) return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Execute render graph
  // ─────────────────────────────────────────────────────────────

  /**
   * Execute all enabled effect passes in order, reading from the background
   * texture and writing to the output target.
   *
   * @param backgroundView - The texture view of the background render (input)
   * @param outputView - The final output texture view (canvas swapchain or offscreen target)
   * @param params - Per-frame parameters
   * @param encoder - The command encoder to record into
   */
  execute(
    backgroundView: GPUTextureView,
    outputView: GPUTextureView,
    params: EffectPassParams,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this._initialized) {
      console.error('[RenderGraph] execute() called before initialization — skipping all passes.');
      return;
    }

    if (!this.pingView || !this.pongView) {
      console.error('[RenderGraph] Intermediate textures not ready — call resize() first.');
      return;
    }

    profiler.begin('passChain:full');

    // Collect enabled passes in sorted (data-driven or priority) order
    const activePasses: EffectPass[] = [];
    for (const id of this.sortedPassIds) {
      const pass = this.passes.get(id)!;
      if (pass.enabled) {
        if (!pass.pipeline || !pass.bindGroupLayout || !pass.uniformBuffer) {
          console.error(
            `[RenderGraph] Pass "${id}" is enabled but missing critical resources (pipeline/layout/uniform). Skipping.`,
          );
          continue;
        }
        activePasses.push(pass);
      }
    }

    this._runPassChain(activePasses, backgroundView, outputView, params, encoder);
    profiler.end('passChain:full');
  }

  /**
   * Public: run ONLY a specified subset of enabled passes, in the given order,
   * from `inputView` to `outputView`. Additive API used by the renderer to split
   * the effect chain around the lyric layer (effects below lyrics run into an
   * intermediate, lyrics composite in, then effects above lyrics run to output).
   * Passes not currently enabled or not registered are skipped. When the subset
   * is empty, does a direct passthrough composite so `outputView` still receives
   * `inputView`.
   */
  executeSubset(
    passIds: string[],
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    params: EffectPassParams,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this._initialized || !this.pingView || !this.pongView) return;
    profiler.begin('passChain:subset');
    const subset: EffectPass[] = [];
    for (const id of passIds) {
      const pass = this.passes.get(id);
      if (!pass || !pass.enabled) continue;
      if (!pass.pipeline || !pass.bindGroupLayout || !pass.uniformBuffer) continue;
      subset.push(pass);
    }
    this._runPassChain(subset, inputView, outputView, params, encoder);
    profiler.end('passChain:subset');
  }

  /**
   * Public: the ids of currently-enabled passes in their effective execution
   * order (respecting setPassOrder / priority). The renderer uses this to figure
   * out which passes fall above vs. below the lyric layer.
   */
  getEnabledPassIdsInOrder(): string[] {
    const ids: string[] = [];
    for (const id of this.sortedPassIds) {
      if (this.passes.get(id)?.enabled) ids.push(id);
    }
    return ids;
  }

  /**
   * Private: chain a concrete ordered list of passes from inputView to
   * outputView using the ping-pong intermediates. Shared by execute() and
   * executeSubset() so both paths behave identically. When `passes` is empty,
   * a direct passthrough composite copies inputView → outputView.
   */
  private _runPassChain(
    passes: EffectPass[],
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    params: EffectPassParams,
    encoder: GPUCommandEncoder,
  ): void {
    // If no effect passes are active, just do a direct composite.
    // (When input===output there is nothing to do — the content is already in
    // place — and a same-view composite would itself be a read==write hazard.)
    if (passes.length === 0) {
      if (inputView !== outputView) {
        this._executeComposite(inputView, outputView, encoder);
      }
      return;
    }

    // Chain passes: input → pass[0] → pass[1] → ... → output
    let currentInput = inputView;
    let writeToIndex = 0; // Alternates between ping (0) and pong (1)

    // Read==write hazard guard: WebGPU forbids a texture being sampled AND used
    // as a render attachment in the same pass. If the caller passes the SAME
    // view for input and output (e.g. an in-place subset run on the background
    // target), the single/last pass would read and write it simultaneously and
    // invalidate the whole command buffer. Bounce the input through ping first
    // so the chain's live input is never the same object as `outputView`.
    if (inputView === outputView) {
      this._executeComposite(inputView, this.pingView, encoder);
      currentInput = this.pingView;
      writeToIndex = 1; // next intermediate write goes to pong, leaving ping intact
    }

    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i];
      const isLast = i === passes.length - 1;

      // Output target: if last pass, write directly to output (skip composite)
      // Otherwise write to the next ping-pong texture
      let outputTarget: GPUTextureView;
      if (isLast) {
        outputTarget = outputView;
      } else {
        outputTarget = writeToIndex === 0 ? this.pingView : this.pongView;
      }

      // If the pass needs to preserve the background (e.g. for geometry primitives), blit it first
      if (pass.config.copyBeforePass) {
        this._executeComposite(currentInput, outputTarget, encoder);
      }

      // Update uniforms
      if (pass.updateUniforms) {
        const uniformData = new Float32Array(pass.config.uniformBufferSize / 4);
        pass.updateUniforms(uniformData, params);
        this.device.queue.writeBuffer(pass.uniformBuffer, 0, uniformData);
      }

      // A pass that declares additionalBindings (e.g. a secondary overlay
      // texture + sampler) REQUIRES matching extraBindings to be attached, or
      // the frame bind group's entry count won't match the layout and WebGPU
      // rejects it — invalidating the whole command buffer and blanking the
      // canvas. If the caller hasn't attached them yet (registration/attach
      // race, or the resource simply isn't ready), skip this pass for the
      // frame rather than emit an invalid bind group. The input passes through
      // untouched so the rest of the chain still renders.
      const extraNeeded = pass.config.additionalBindings?.length ?? 0;
      const extraHave = pass.extraBindings?.length ?? 0;
      if (extraNeeded > 0 && extraHave < extraNeeded) {
        // Forward the current input to this pass's output target so the chain
        // stays intact — critical when this is the LAST pass (its target is the
        // final outputView; skipping without a blit would leave it unwritten
        // and blank the frame). Then advance as a normal (identity) pass.
        this._executeComposite(currentInput, outputTarget, encoder);
        if (!isLast) {
          currentInput = outputTarget;
          writeToIndex = 1 - writeToIndex;
        }
        continue;
      }

      // Create bind group with current input texture
      const bgEntries: GPUBindGroupEntry[] = [
        { binding: 2, resource: { buffer: pass.uniformBuffer } },
      ];
      if (!pass.config.noStandardBindings) {
        bgEntries.push(
          { binding: 0, resource: currentInput },
          { binding: 1, resource: this.compositeSampler },
        );
      }
      // Merge any extra bindings (e.g. secondary overlay image texture +
      // sampler at bindings 3+). These satisfy config.additionalBindings; the
      // resources are persistent and owned by the caller (setPassExtraBindings).
      if (pass.extraBindings) {
        bgEntries.push(...pass.extraBindings);
      }

      const bindGroup = this.device.createBindGroup({
        label: `${pass.config.id}-frame-bg`,
        layout: pass.bindGroupLayout,
        entries: bgEntries,
      });

      // Execute the pass
      const renderPass = encoder.beginRenderPass({
        label: `${pass.config.id}-pass`,
        colorAttachments: [
          {
            view: outputTarget,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: pass.config.copyBeforePass ? 'load' : 'clear',
            storeOp: 'store',
          },
        ],
      });

      renderPass.setPipeline(pass.pipeline);
      renderPass.setBindGroup(0, bindGroup);

      const vertexCount = pass.config.vertexCount ?? 3;
      const instanceCount = pass.config.instanceCount ?? 1;

      renderPass.draw(vertexCount, instanceCount);

      renderPass.end();

      // Next pass reads from what we just wrote (unless this is the last)
      if (!isLast) {
        currentInput = outputTarget;
        writeToIndex = 1 - writeToIndex;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Composite pass (direct passthrough)
  // ─────────────────────────────────────────────────────────────

  private _executeComposite(
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    encoder: GPUCommandEncoder,
  ): void {
    const bindGroup = this.device.createBindGroup({
      label: 'composite-frame-bg',
      layout: this.compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.compositeSampler },
      ],
    });

    const renderPass = encoder.beginRenderPass({
      label: 'composite-pass',
      colorAttachments: [
        {
          view: outputView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    renderPass.setPipeline(this.compositePipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(3);
    renderPass.end();
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Pipeline / Texture management
  // ─────────────────────────────────────────────────────────────

  private async _buildCompositePipeline(): Promise<boolean> {
    const shaderModule = this.device.createShaderModule({
      label: 'composite-shader',
      code: COMPOSITE_WGSL,
    });

    const info = await shaderModule.getCompilationInfo();
    for (const msg of info.messages) {
      if (msg.type === 'error') {
        console.error(`[RenderGraph] Composite shader error: ${msg.message}`);
        return false;
      }
    }

    this.compositeBindGroupLayout = this.device.createBindGroupLayout({
      label: 'composite-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'composite-pl',
      bindGroupLayouts: [this.compositeBindGroupLayout],
    });

    try {
      this.compositePipeline = await this.device.createRenderPipelineAsync({
        label: 'composite-pipeline',
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_main',
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.format }],
        },
        primitive: { topology: 'triangle-list' },
      });
    } catch (err) {
      console.error('[RenderGraph] Composite pipeline creation failed:', err);
      return false;
    }

    return true;
  }

  private _createIntermediateTextures(): void {
    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC;

    const { width: texW, height: texH } = this._clampToDeviceLimit(this.width, this.height);

    this.pingTexture = this.device.createTexture({
      label: 'render-graph-ping',
      size: [Math.max(texW, 1), Math.max(texH, 1), 1],
      format: this.format,
      usage,
    });

    this.pongTexture = this.device.createTexture({
      label: 'render-graph-pong',
      size: [Math.max(texW, 1), Math.max(texH, 1), 1],
      format: this.format,
      usage,
    });

    this.pingView = this.pingTexture.createView({ label: 'render-graph-ping-view' });
    this.pongView = this.pongTexture.createView({ label: 'render-graph-pong-view' });
  }

  /**
   * Clamp a requested texture size to the device's maxTextureDimension2D,
   * preserving aspect ratio. WebGPU refuses to create a texture whose width or
   * height exceeds maxTextureDimension2D (commonly 8192; some mobile GPUs
   * lower), which would invalidate every render target and blank the canvas.
   * Downscaling the intermediate ping/pong targets is visually acceptable for
   * live preview — the frame-accurate export path uses its own offscreen
   * renderer and is unaffected.
   */
  private _clampToDeviceLimit(width: number, height: number): { width: number; height: number } {
    const max = this.device.limits?.maxTextureDimension2D || 8192;
    const largest = Math.max(width, height);
    if (largest <= max) return { width, height };
    const scale = max / largest;
    return {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
    };
  }

  private _destroyIntermediateTextures(): void {
    this.pingTexture?.destroy();
    this.pongTexture?.destroy();
  }

  private _rebuildSortedPasses(): void {
    const ids = [...this.passes.keys()];
    if (this._orderOverride) {
      // Data-driven ordering: sort by the caller-supplied order (user's effect
      // list). Passes present in the override rank by their index; any pass NOT
      // in the override (e.g. mid-registration, before the next sync) is parked
      // after all ordered ones, keeping its relative priority order so nothing
      // ever drops out of the chain.
      const rank = new Map<string, number>();
      this._orderOverride.forEach((id, i) => rank.set(id, i));
      this.sortedPassIds = ids.sort((a, b) => {
        const ra = rank.has(a) ? rank.get(a)! : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b) ? rank.get(b)! : Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        // Tie-break unordered passes by their static priority for determinism.
        const pa = this.passes.get(a)!.config.priority ?? 100;
        const pb = this.passes.get(b)!.config.priority ?? 100;
        return pa - pb;
      });
      return;
    }
    this.sortedPassIds = ids.sort((a, b) => {
      const pa = this.passes.get(a)!.config.priority ?? 100;
      const pb = this.passes.get(b)!.config.priority ?? 100;
      return pa - pb;
    });
  }

  /**
   * Supply an explicit pass-execution order (list of pass ids, front-to-back).
   * This makes the render-graph layer order data-driven from the user's effect
   * list rather than the hardcoded per-pass `priority`. Pass null to revert to
   * priority-based ordering. Idempotent — a no-op when the order is unchanged.
   */
  setPassOrder(orderedPassIds: string[] | null): void {
    const same =
      (orderedPassIds === null && this._orderOverride === null) ||
      (orderedPassIds !== null &&
        this._orderOverride !== null &&
        orderedPassIds.length === this._orderOverride.length &&
        orderedPassIds.every((id, i) => id === this._orderOverride![i]));
    if (same) return;
    this._orderOverride = orderedPassIds ? [...orderedPassIds] : null;
    this._rebuildSortedPasses();
  }

  // ─────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────

  destroy(): void {
    this._destroyIntermediateTextures();
    for (const [, pass] of this.passes) {
      pass.uniformBuffer.destroy();
    }
    this.passes.clear();
    this.sortedPassIds = [];
    this._initialized = false;
    console.log(`[RenderGraph#${this.instanceId}] Destroyed.`);
  }
}

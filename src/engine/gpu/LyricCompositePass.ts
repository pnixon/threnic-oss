/**
 * LyricCompositePass — WGSL alpha-blend overlay for lyric textures.
 *
 * Receives an ImageBitmap (from CanvasLyricRenderer) and composites it
 * over the scene render target using standard alpha blending.
 *
 * Note: High-quality glow is now pre-rendered into the bitmap by
 * CanvasLyricRenderer using a double-pass approach for better color
 * and edge fidelity.
 */

// ─── WGSL Shader ─────────────────────────────────────────────

const COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var lyricTexture: texture_2d<f32>;
@group(0) @binding(1) var lyricSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Full-screen triangle
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

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(lyricTexture, lyricSampler, in.uv);
}
`;

// ─── LyricCompositePass ──────────────────────────────────────

export class LyricCompositePass {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler;
  private bindGroupLayout: GPUBindGroupLayout;

  // Current lyric texture
  private lyricTexture: GPUTexture | null = null;
  private lyricTextureView: GPUTextureView | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private textureWidth = 0;
  private textureHeight = 0;

  constructor(device: GPUDevice, targetFormat: GPUTextureFormat = 'rgba8unorm') {
    this.device = device;

    this.sampler = device.createSampler({
      label: 'lyric-composite-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'lyric-composite-bgl',
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

    this._initPipeline(targetFormat);
  }

  private _initPipeline(targetFormat: GPUTextureFormat): void {
    const shaderModule = this.device.createShaderModule({
      label: 'lyric-composite-shader',
      code: COMPOSITE_WGSL,
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'lyric-composite-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      label: 'lyric-composite-pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: targetFormat,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }

  /** (No-op) Maintained for interface compatibility */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- no-op kept so both renderers can keep passing the intensity
  updateGlow(_intensity: number): void {
    // Glow now pre-rendered into bitmap
  }

  /**
   * Upload an ImageBitmap as the lyric texture.
   * Call this each frame before execute().
   */
  uploadBitmap(bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): boolean {
    const w = bitmap.width;
    const h = bitmap.height;

    // Guard: skip upload if bitmap has zero dimensions (would cause InvalidStateError)
    if (w === 0 || h === 0) return false;

    // Re-create texture if size changed
    if (!this.lyricTexture || this.textureWidth !== w || this.textureHeight !== h) {
      this.lyricTexture?.destroy();
      this.lyricTexture = this.device.createTexture({
        label: 'lyric-overlay-texture',
        size: { width: w, height: h },
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.lyricTextureView = this.lyricTexture.createView();
      this.textureWidth = w;
      this.textureHeight = h;

      // Rebuild bind group
      this.bindGroup = this.device.createBindGroup({
        label: 'lyric-composite-bg',
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: this.lyricTextureView! },
          { binding: 1, resource: this.sampler },
        ],
      });
    }

    // Upload bitmap to texture
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap, flipY: false },
        { texture: this.lyricTexture! },
        { width: w, height: h },
      );
      return true;
    } catch (e) {
      console.warn('[LyricCompositePass] Failed to upload bitmap:', e);
      return false;
    }
  }

  /**
   * Execute the composite pass — alpha-blends the lyric texture over the target.
   * Must be called after uploadBitmap().
   *
   * @param targetView — The render target view to composite onto (load existing content).
   * @param encoder — The command encoder to record into.
   */
  execute(targetView: GPUTextureView, encoder: GPUCommandEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;

    const pass = encoder.beginRenderPass({
      label: 'lyric-composite-pass',
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'load', // preserve existing scene content
          storeOp: 'store',
        },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
  }

  /**
   * Execute the composite pass from an existing lyric texture VIEW (e.g. the
   * output of LyricFXGraph), rather than an uploaded ImageBitmap. Alpha-blends
   * `sourceView` over `targetView` using the same pipeline. A per-source bind
   * group is built each call (the view may change frame to frame); the pipeline
   * and sampler are shared. This is the Stage-3 seam from the Lyric FX LLD:
   * the composite accepts a texture view as well as a bitmap.
   */
  executeFromView(
    sourceView: GPUTextureView,
    targetView: GPUTextureView,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this.pipeline) return;

    const bindGroup = this.device.createBindGroup({
      label: 'lyric-composite-bg-view',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: this.sampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: 'lyric-composite-pass-view',
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'load', // preserve existing scene content
          storeOp: 'store',
        },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Whether a bitmap has been uploaded. */
  get hasLyrics(): boolean {
    return this.bindGroup !== null;
  }

  /** Release GPU resources. */
  destroy(): void {
    this.lyricTexture?.destroy();
    this.lyricTexture = null;
    this.lyricTextureView = null;
    this.bindGroup = null;
    this.pipeline = null;
  }
}

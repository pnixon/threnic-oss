/**
 * BackgroundBlurPass — universal background blur for the composited background layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Background Blur used to be baked into the background-image fragment shader
 * (the `bgPipeline` fullscreen triangle in WebGPURenderer / OffscreenGPURenderer).
 * That pipeline is the ONLY place the per-image `sampleBlurred` runs — and it is
 * SKIPPED whenever an external canvas source (Butterchurn, the RPG game scene)
 * pre-writes the background target, or when the zero-copy video path overwrites
 * it. As a result the Background Blur slider had no effect on game-scene /
 * butterchurn / video backgrounds — only on static images.
 *
 * This pass fixes that by blurring the ALREADY-COMPOSITED background target,
 * after every source (image, video, butterchurn, game scene, shader overlay,
 * milkdrop) has landed in it, but BEFORE the render-graph effects and lyric
 * overlay. Because it operates on the composited result, it is source-agnostic:
 * one code path blurs every background type identically in both preview and
 * export.
 *
 * DOUBLE-BLUR AVOIDANCE
 * ---------------------
 * When this pass runs, the caller MUST neutralise the per-image blur in the
 * background pipeline (pass blur=0 to the bg uniform), otherwise static images
 * would be blurred twice. This pass is the single source of truth for blur.
 *
 * READ-WRITE HAZARD
 * -----------------
 * WebGPU cannot sample and render to the same texture in one pass, so we blur
 * `target → scratch` then copy `scratch → target`. The scratch texture is
 * created lazily and resized on demand.
 */

// blurType: 0=box, 1=gaussian, 2=radial, 3=directional-H
const BLUR_WGSL = /* wgsl */ `
struct BlurUniforms {
  blur: f32,
  blurType: u32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> u: BlurUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
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

fn sampleBlurred(uv: vec2f, blur: f32, blurType: u32) -> vec4f {
  if (blur <= 0.0) {
    return textureSampleLevel(srcTexture, srcSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
  }
  let o = 0.005 * blur;
  if (blurType == 1u) {
    // Gaussian: weighted 9-tap
    let w0 = 0.204; let w1 = 0.180; let w2 = 0.102;
    var c = textureSampleLevel(srcTexture, srcSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0) * w0;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(o, 0.0),   vec2f(0.0), vec2f(1.0)), 0.0) * w1;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(-o, 0.0),  vec2f(0.0), vec2f(1.0)), 0.0) * w1;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(0.0, o),   vec2f(0.0), vec2f(1.0)), 0.0) * w1;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(0.0, -o),  vec2f(0.0), vec2f(1.0)), 0.0) * w1;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(o, o),     vec2f(0.0), vec2f(1.0)), 0.0) * w2;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(-o, o),    vec2f(0.0), vec2f(1.0)), 0.0) * w2;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(o, -o),    vec2f(0.0), vec2f(1.0)), 0.0) * w2;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(-o, -o),   vec2f(0.0), vec2f(1.0)), 0.0) * w2;
    return c;
  } else if (blurType == 2u) {
    // Radial: 8 taps in a circle + center, averaged
    var c = textureSampleLevel(srcTexture, srcSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
    let sqrt2_inv = 0.7071;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(o, 0.0),              vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(-o, 0.0),             vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(0.0, o),              vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(0.0, -o),             vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(o*sqrt2_inv, o*sqrt2_inv),   vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(-o*sqrt2_inv, o*sqrt2_inv),  vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(o*sqrt2_inv, -o*sqrt2_inv),  vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(-o*sqrt2_inv, -o*sqrt2_inv), vec2f(0.0), vec2f(1.0)), 0.0);
    return c * 0.111;
  } else if (blurType == 3u) {
    // Directional-H: horizontal smear
    var c = textureSampleLevel(srcTexture, srcSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0) * 0.4;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(o, 0.0),   vec2f(0.0), vec2f(1.0)), 0.0) * 0.3;
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(-o, 0.0),  vec2f(0.0), vec2f(1.0)), 0.0) * 0.3;
    return c;
  } else {
    // Box (default): uniform 5-tap
    var c = textureSampleLevel(srcTexture, srcSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(o, 0.0),  vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(-o, 0.0), vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(0.0, o),  vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(srcTexture, srcSampler, clamp(uv + vec2f(0.0, -o), vec2f(0.0), vec2f(1.0)), 0.0);
    return c * 0.2;
  }
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let c = sampleBlurred(in.uv, u.blur, u.blurType);
  return vec4f(c.rgb, 1.0);
}
`;

export class BackgroundBlurPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler;
  private bindGroupLayout: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;

  // Scratch (ping) texture the blur renders into before copy-back
  private scratchTexture: GPUTexture | null = null;
  private scratchView: GPUTextureView | null = null;
  private scratchW = 0;
  private scratchH = 0;

  constructor(device: GPUDevice, targetFormat: GPUTextureFormat = 'rgba8unorm') {
    this.device = device;
    this.format = targetFormat;

    this.sampler = device.createSampler({
      label: 'bg-blur-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.uniformBuffer = device.createBuffer({
      label: 'bg-blur-uniforms',
      size: 16, // blur(f32) + blurType(u32) + 2 pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'bg-blur-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this._initPipeline();
  }

  private _initPipeline(): void {
    const shaderModule = this.device.createShaderModule({
      label: 'bg-blur-shader',
      code: BLUR_WGSL,
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'bg-blur-pl',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      label: 'bg-blur-pipeline',
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  private _ensureScratch(width: number, height: number): void {
    if (this.scratchTexture && this.scratchW === width && this.scratchH === height) return;
    this.scratchTexture?.destroy();
    this.scratchTexture = this.device.createTexture({
      label: 'bg-blur-scratch',
      size: [width, height, 1],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this.scratchView = this.scratchTexture.createView();
    this.scratchW = width;
    this.scratchH = height;
  }

  /**
   * Blur the composited background in `targetTexture` in place.
   *
   * Renders targetView → scratch (blur applied), then copies scratch back into
   * targetTexture so downstream passes (render graph, lyrics) read the blurred
   * result. No-op when `blur <= 0`.
   *
   * @param targetTexture   The composited background texture (RENDER_ATTACHMENT + TEXTURE_BINDING + COPY_DST).
   * @param targetView      A view of `targetTexture` used as the blur source.
   * @param encoder         Command encoder to record into.
   * @param width           Target width in pixels.
   * @param height          Target height in pixels.
   * @param blur            Blur amount (> 0 to run).
   * @param blurType        0=box, 1=gaussian, 2=radial, 3=directional-H.
   */
  execute(
    targetTexture: GPUTexture,
    targetView: GPUTextureView,
    encoder: GPUCommandEncoder,
    width: number,
    height: number,
    blur: number,
    blurType: number,
  ): void {
    if (!this.pipeline || blur <= 0 || width <= 0 || height <= 0) return;

    this._ensureScratch(width, height);
    if (!this.scratchTexture || !this.scratchView) return;

    // Uniforms: blur (f32) then blurType (u32) reinterpreted from the same buffer.
    const uBuf = new ArrayBuffer(16);
    new Float32Array(uBuf, 0, 1)[0] = blur;
    new Uint32Array(uBuf, 4, 1)[0] = (blurType ?? 1) >>> 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uBuf);

    // Per-frame bind group — the target view is the source of the blur.
    const bindGroup = this.device.createBindGroup({
      label: 'bg-blur-bg',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: targetView },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    // Pass 1: sample target → write blurred pixels to scratch.
    const pass = encoder.beginRenderPass({
      label: 'bg-blur-pass',
      colorAttachments: [
        {
          view: this.scratchView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    // Pass 2: copy blurred scratch back into the target so downstream reads it.
    encoder.copyTextureToTexture(
      { texture: this.scratchTexture, origin: [0, 0, 0] },
      { texture: targetTexture, origin: [0, 0, 0] },
      [width, height, 1],
    );
  }

  destroy(): void {
    this.scratchTexture?.destroy();
    this.scratchTexture = null;
    this.scratchView = null;
    this.uniformBuffer?.destroy();
    this.pipeline = null;
  }
}

/**
 * guestComposite — a shared, parameterized WebGPU pass that blends a guest
 * texture over a target view (Stage 3a, vertical slice).
 *
 * This is the GENERALIZED form of the butterchurn/game-scene composite that was
 * previously copy-pasted inline in each renderer with a hardcoded src-alpha blend
 * and a single-f32 opacity uniform. It adds:
 *   - per-guest blend mode (alpha / additive / screen / multiply / replace),
 *   - optional per-pixel alpha preservation (game-scene style vs butterchurn
 *     alpha-discard style),
 * and lives in ONE module so preview (WebGPURenderer) and export
 * (OffscreenGPURenderer) cannot drift — the §7 anti-drift point applied to the
 * guest-composite surface.
 *
 * Scope note: the shipped butterchurn/game-scene composites are intentionally
 * left untouched (regressing shipped guests is not worth the churn in the
 * vertical slice); this pass is used by the GLSL guest, and the older two can be
 * migrated onto it as a follow-up once it has proven out.
 */

import type { GuestBlendMode, GuestCompositeParams } from './types';

/** GPU blend descriptor for a guest blend mode. */
function blendFor(mode: GuestBlendMode): GPUBlendState | undefined {
  switch (mode) {
    case 'additive':
      return {
        color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      };
    case 'screen':
      // result = src + dst - src*dst  ≈  dst*(1-src) + src
      return {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
      };
    case 'multiply':
      return {
        color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
        alpha: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
      };
    case 'replace':
      // No blend — source overwrites target.
      return undefined;
    case 'alpha':
    default:
      return {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
  }
}

const WGSL = /* wgsl */ `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;
// params: x = opacity, y = preserveAlpha (0/1)
@group(0) @binding(2) var<uniform> params: vec4f;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  var uvs = array<vec2f, 3>(vec2f(0,1), vec2f(2,1), vec2f(0,-1));
  var o: VSOut;
  o.pos = vec4f(positions[vi], 0, 1);
  o.uv = uvs[vi];
  return o;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let color = textureSample(srcTex, srcSamp, in.uv);
  let opacity = params.x;
  let preserveAlpha = params.y;
  // preserveAlpha=1 → honor the guest's own alpha (scaled by opacity);
  // preserveAlpha=0 → treat the guest as opaque, opacity is the only gate.
  let a = mix(opacity, color.a * opacity, preserveAlpha);
  return vec4f(color.rgb, a);
}
`;

/** Cache key for a pipeline: format + blend mode. */
type PipelineKey = string;

/**
 * Owns the guest-composite pipelines (one per blend mode) plus the shared
 * bind-group layout, sampler, and a per-call uniform buffer. Instantiated once
 * per renderer, lazily creating pipelines on first use of each blend mode.
 */
export class GuestCompositor {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private module: GPUShaderModule | null = null;
  private bgl: GPUBindGroupLayout | null = null;
  private layout: GPUPipelineLayout | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private pipelines = new Map<PipelineKey, GPURenderPipeline>();

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  private ensureBase(): void {
    if (this.module) return;
    this.module = this.device.createShaderModule({ label: 'guest-composite-shader', code: WGSL });
    this.bgl = this.device.createBindGroupLayout({
      label: 'guest-composite-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.layout = this.device.createPipelineLayout({
      label: 'guest-composite-pl',
      bindGroupLayouts: [this.bgl],
    });
    this.sampler = this.device.createSampler({
      label: 'guest-composite-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.uniformBuffer = this.device.createBuffer({
      label: 'guest-composite-params',
      size: 16, // vec4f
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private pipelineFor(mode: GuestBlendMode): GPURenderPipeline {
    this.ensureBase();
    const key = `${this.format}:${mode}`;
    const cached = this.pipelines.get(key);
    if (cached) return cached;
    const pipeline = this.device.createRenderPipeline({
      label: `guest-composite-${mode}`,
      layout: this.layout!,
      vertex: { module: this.module!, entryPoint: 'vs' },
      fragment: {
        module: this.module!,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendFor(mode) }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * Blend `srcTexture` over `targetView` (loadOp:'load') per `params`. The caller
   * owns the source texture (typically populated via copyExternalImageToTexture
   * earlier in the same submit).
   */
  composite(
    srcTexture: GPUTexture,
    targetView: GPUTextureView,
    encoder: GPUCommandEncoder,
    params: GuestCompositeParams,
  ): void {
    const pipeline = this.pipelineFor(params.blendMode);
    const opacity = Math.max(0, Math.min(1, params.opacity));
    this.device.queue.writeBuffer(
      this.uniformBuffer!,
      0,
      new Float32Array([opacity, params.preserveAlpha ? 1 : 0, 0, 0]),
    );
    const bindGroup = this.device.createBindGroup({
      label: 'guest-composite-bg',
      layout: this.bgl!,
      entries: [
        { binding: 0, resource: srcTexture.createView() },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: { buffer: this.uniformBuffer! } },
      ],
    });
    const pass = encoder.beginRenderPass({
      label: 'guest-composite-pass',
      colorAttachments: [{ view: targetView, loadOp: 'load' as const, storeOp: 'store' as const }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.pipelines.clear();
    this.module = null;
    this.bgl = null;
    this.layout = null;
    this.sampler = null;
  }
}

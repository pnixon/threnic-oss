/**
 * Small WebGPU scenes used to check that the WebGL2 compatibility backend
 * renders the same pixels as real WebGPU.
 *
 * `runGpuScenes` is passed to `page.evaluate`, so it is serialised and runs in
 * the browser: it must stay self-contained (no imports, no outer variables).
 * Each scene renders into a 64×64 rgba8unorm texture and reads it back; the
 * result is the raw pixels, base64-encoded.
 *
 * Every scene is deliberately asymmetric (top ≠ bottom, left ≠ right) so that a
 * flipped or mirrored result cannot pass.
 */

export interface SceneResult {
  name: string;
  /** base64 of 64*64*4 RGBA bytes, row 0 = top; absent when the scene threw. */
  pixels?: string;
  error?: string;
}

export const SCENE_SIZE = 64;

export async function runGpuScenes(which: 'native' | 'compat'): Promise<SceneResult[]> {
  const SIZE = 64;
  const hook = (
    window as unknown as { __threnicGPU?: { getCompatGPU(): GPU; installGPUConstants(): void } }
  ).__threnicGPU;
  hook?.installGPUConstants();
  const gpu = which === 'native' ? navigator.gpu : hook?.getCompatGPU();
  if (!gpu) return [{ name: '*', error: `${which} GPU is not available` }];
  const adapter = await gpu.requestAdapter();
  if (!adapter) return [{ name: '*', error: `${which}: no adapter` }];
  const device = await adapter.requestDevice();

  const FULLSCREEN = /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}
`;

  const target = (format: GPUTextureFormat = 'rgba8unorm', size = SIZE) =>
    device.createTexture({
      size: [size, size],
      format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING,
    });

  const readback = async (tex: GPUTexture): Promise<Uint8Array> => {
    const bytesPerRow = 256; // SIZE * 4, already a multiple of 256
    const buffer = device.createBuffer({
      size: bytesPerRow * SIZE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow }, [SIZE, SIZE]);
    device.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    return out;
  };

  interface DrawOpts {
    code: string;
    target: GPUTexture;
    format?: GPUTextureFormat;
    groups?: GPUBindGroupEntry[][];
    layouts?: GPUBindGroupLayoutEntry[][];
    blend?: GPUBlendState;
    topology?: GPUPrimitiveTopology;
    clear?: GPUColor | null;
    vertexCount?: number;
    instanceCount?: number;
    setup?: (pass: GPURenderPassEncoder) => void;
    encoder?: GPUCommandEncoder;
  }

  /** One pass, one pipeline, one draw. Submits unless an encoder is supplied. */
  const draw = (o: DrawOpts): void => {
    const shader = device.createShaderModule({ code: o.code });
    const bgls = (o.layouts ?? []).map((entries) => device.createBindGroupLayout({ entries }));
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
      vertex: { module: shader, entryPoint: 'vs' },
      fragment: {
        module: shader,
        entryPoint: 'fs',
        targets: [{ format: o.format ?? 'rgba8unorm', blend: o.blend }],
      },
      primitive: { topology: o.topology ?? 'triangle-list' },
    });
    const enc = o.encoder ?? device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: o.target.createView(),
          loadOp: o.clear === null ? 'load' : 'clear',
          clearValue: o.clear ?? { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    (o.groups ?? []).forEach((entries, i) =>
      pass.setBindGroup(i, device.createBindGroup({ layout: bgls[i], entries })),
    );
    o.setup?.(pass);
    pass.draw(o.vertexCount ?? 3, o.instanceCount ?? 1);
    pass.end();
    if (!o.encoder) device.queue.submit([enc.finish()]);
  };

  const uniformLayout = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    buffer: { type: 'uniform' },
  });
  const textureLayout = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType: 'float' },
  });
  const samplerLayout = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    sampler: { type: 'filtering' },
  });
  const uniform = (data: Float32Array): GPUBuffer => {
    const b = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    return b;
  };

  /** 8×8 rgba8 pattern, different in every quadrant and along both axes. */
  const pattern = (): Uint8Array => {
    const d = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        d[i] = x * 32 + 15;
        d[i + 1] = y * 32 + 15;
        d[i + 2] = x < 4 !== y < 4 ? 220 : 40;
        d[i + 3] = 255;
      }
    }
    return d;
  };
  const patternTexture = (format: GPUTextureFormat = 'rgba8unorm'): GPUTexture => {
    const t = device.createTexture({
      size: [8, 8],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: t }, pattern().buffer, { bytesPerRow: 32 }, [8, 8]);
    return t;
  };
  const SAMPLE = /* wgsl */ `
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(i: VO) -> @location(0) vec4f { return textureSample(tex, smp, i.uv); }
`;
  const sampleLayouts = [[textureLayout(0), samplerLayout(1)]];
  const linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const nearest = device.createSampler({});

  /** A canvas with a translucent, asymmetric drawing on a transparent ground. */
  const sourceCanvas = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(255, 0, 0, 1)';
    ctx.fillRect(0, 0, 8, 4);
    ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
    ctx.fillRect(8, 0, 8, 8);
    ctx.fillStyle = 'rgba(0, 0, 255, 0.25)';
    ctx.fillRect(0, 8, 12, 8);
    return c;
  };
  const externalScene = async (
    source: GPUCopyExternalImageSource,
    flipY: boolean,
    premultipliedAlpha: boolean,
  ): Promise<Uint8Array> => {
    const tex = device.createTexture({
      size: [16, 16],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source, flipY },
      { texture: tex, premultipliedAlpha },
      [16, 16],
    );
    const t = target();
    draw({
      code: FULLSCREEN + SAMPLE,
      target: t,
      layouts: sampleLayouts,
      groups: [
        [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: nearest },
        ],
      ],
    });
    return readback(t);
  };

  const scenes: Record<string, () => Promise<Uint8Array>> = {
    // Clip space, UVs and @builtin(position) all point the same way as WebGPU.
    orientation: async () => {
      const t = target();
      draw({
        code:
          FULLSCREEN +
          /* wgsl */ `
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let top = step(i.pos.y, 16.0);
  return vec4f(i.uv.x, i.uv.y, top, 1.0);
}`,
        target: t,
      });
      return readback(t);
    },

    writeTextureNearest: async () => {
      const t = target();
      draw({
        code: FULLSCREEN + SAMPLE,
        target: t,
        layouts: sampleLayouts,
        groups: [
          [
            { binding: 0, resource: patternTexture().createView() },
            { binding: 1, resource: nearest },
          ],
        ],
      });
      return readback(t);
    },

    writeTextureLinear: async () => {
      const t = target();
      draw({
        code: FULLSCREEN + SAMPLE,
        target: t,
        layouts: sampleLayouts,
        groups: [
          [
            { binding: 0, resource: patternTexture().createView() },
            { binding: 1, resource: linear },
          ],
        ],
      });
      return readback(t);
    },

    // Same texture through two samplers in one shader: clamp vs repeat.
    twoSamplers: async () => {
      const t = target();
      draw({
        code:
          FULLSCREEN +
          /* wgsl */ `
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var clampS: sampler;
@group(1) @binding(0) var repeatS: sampler;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let uv = i.uv * 2.5 - vec2f(0.5);
  let a = textureSample(tex, clampS, uv);
  let b = textureSample(tex, repeatS, uv);
  return select(b, a, i.uv.x < 0.5);
}`,
        target: t,
        layouts: [[textureLayout(0), samplerLayout(1)], [samplerLayout(0)]],
        groups: [
          [
            { binding: 0, resource: patternTexture().createView() },
            { binding: 1, resource: nearest },
          ],
          [
            {
              binding: 0,
              resource: device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat' }),
            },
          ],
        ],
      });
      return readback(t);
    },

    textureLoad: async () => {
      const t = target();
      draw({
        code:
          FULLSCREEN +
          /* wgsl */ `
@group(0) @binding(0) var tex: texture_2d<f32>;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let d = textureDimensions(tex);
  let p = vec2i(i.pos.xy) / 8;
  return textureLoad(tex, clamp(p, vec2i(0), vec2i(d) - vec2i(1)), 0);
}`,
        target: t,
        layouts: [[textureLayout(0)]],
        groups: [[{ binding: 0, resource: patternTexture().createView() }]],
      });
      return readback(t);
    },

    bgraTexture: async () => {
      const t = target();
      draw({
        code: FULLSCREEN + SAMPLE,
        target: t,
        layouts: sampleLayouts,
        groups: [
          [
            { binding: 0, resource: patternTexture('bgra8unorm').createView() },
            { binding: 1, resource: nearest },
          ],
        ],
      });
      return readback(t);
    },

    // Struct layout: vec3 + f32 packing, a mat3x3, an array of vec4, ints.
    uniformLayout: async () => {
      const t = target();
      const data = new Float32Array(48);
      data.set([0.9, 0.1, 0.2], 0); // a: vec3f
      data[3] = 0.5; // b: f32 (packs after the vec3)
      data.set([1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.25, 0], 4); // m: mat3x3f (3 padded columns)
      data.set([0.2, 0.4, 0.6, 1.0, 0.8, 0.6, 0.4, 1.0, 0.1, 0.9, 0.5, 1.0], 16); // c: array<vec4f, 3>
      new Uint32Array(data.buffer, 28 * 4, 1)[0] = 2; // idx: u32
      data.set([0.3, 0.7], 30); // d: vec2f
      draw({
        code:
          FULLSCREEN +
          /* wgsl */ `
struct U { a: vec3f, b: f32, m: mat3x3f, c: array<vec4f, 3>, idx: u32, d: vec2f }
@group(0) @binding(0) var<uniform> u: U;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let band = u32(i.uv.y * 4.0);
  if (band == 0u) { return vec4f(u.a, 1.0); }
  if (band == 1u) { return vec4f(u.m * vec3f(u.b, 1.0, 1.0), 1.0); }
  if (band == 2u) { return u.c[u32(i.uv.x * 3.0)]; }
  return vec4f(u.c[u.idx].rg, u.d.x * u.d.y * 4.0, 1.0);
}`,
        target: t,
        layouts: [[uniformLayout(0)]],
        groups: [[{ binding: 0, resource: { buffer: uniform(data) } }]],
      });
      return readback(t);
    },

    // A buffer written after the pass is encoded, before submit, must be seen.
    writeBufferBeforeSubmit: async () => {
      const t = target();
      const buf = uniform(new Float32Array([1, 0, 0, 1]));
      const enc = device.createCommandEncoder();
      draw({
        code:
          FULLSCREEN +
          /* wgsl */ `
@group(0) @binding(0) var<uniform> color: vec4f;
@fragment fn fs(i: VO) -> @location(0) vec4f { return color * vec4f(i.uv.x, 1.0, 1.0, 1.0); }`,
        target: t,
        layouts: [[uniformLayout(0)]],
        groups: [[{ binding: 0, resource: { buffer: buf } }]],
        encoder: enc,
      });
      device.queue.writeBuffer(buf, 0, new Float32Array([0, 1, 0.5, 1]));
      device.queue.submit([enc.finish()]);
      return readback(t);
    },

    alphaBlendOverLoad: async () => {
      const t = target();
      draw({
        code:
          FULLSCREEN +
          `@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.uv.x, 0.2, 0.6, 1.0); }`,
        target: t,
      });
      draw({
        code:
          FULLSCREEN +
          `@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(1.0, 1.0, 0.0, i.uv.y); }`,
        target: t,
        clear: null,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      });
      return readback(t);
    },

    additiveAndMultiplyBlend: async () => {
      const t = target();
      draw({
        code:
          FULLSCREEN +
          `@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(0.5, i.uv.y, 0.25, 1.0); }`,
        target: t,
      });
      draw({
        code:
          FULLSCREEN +
          `@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.uv.x * 0.6, 0.1, 0.3, 1.0); }`,
        target: t,
        clear: null,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
        setup: (pass) => pass.setScissorRect(0, 0, 64, 32),
      });
      draw({
        code:
          FULLSCREEN +
          `@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.uv.x, 0.5, 1.0, 1.0); }`,
        target: t,
        clear: null,
        blend: {
          color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
        },
        setup: (pass) => pass.setViewport(8, 36, 40, 20, 0, 1),
      });
      return readback(t);
    },

    // Instanced quads as a triangle strip, positioned from instance_index.
    instancedStrip: async () => {
      const t = target();
      draw({
        code: /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) c: vec3f }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let cell = vec2f(f32(ii % 3u), f32(ii / 3u));
  let p = (cell + corner * 0.7) / 3.0;
  var o: VO;
  o.pos = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  o.c = vec3f(f32(ii) / 6.0, corner.x, corner.y);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.c, 1.0); }`,
        target: t,
        topology: 'triangle-strip',
        vertexCount: 4,
        instanceCount: 6,
      });
      return readback(t);
    },

    // A read-only storage array of structs, indexed per instance.
    storageArray: async () => {
      const t = target();
      const N = 5;
      const data = new Float32Array(N * 8);
      for (let i = 0; i < N; i++) {
        data.set([i / N, 0.15 + i * 0.12, 0.18, 0.1 + i * 0.05], i * 8); // rect: x, y, w, h
        data.set([1 - i / N, i / N, 0.5, 1], i * 8 + 4); // color
      }
      const buf = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, data.buffer, 0, data.byteLength);
      draw({
        code: /* wgsl */ `
struct Item { rect: vec4f, color: vec4f };
@group(0) @binding(0) var<storage, read> items: array<Item>;
struct VO { @builtin(position) pos: vec4f, @location(0) c: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let it = items[ii];
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let p = it.rect.xy + corner * it.rect.zw;
  var o: VO;
  o.pos = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  o.c = items[ii].color;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f { return i.c; }`,
        target: t,
        topology: 'triangle-strip',
        vertexCount: 4,
        instanceCount: N,
        layouts: [
          [
            {
              binding: 0,
              visibility: GPUShaderStage.VERTEX,
              buffer: { type: 'read-only-storage' },
            },
          ],
        ],
        groups: [[{ binding: 0, resource: { buffer: buf } }]],
      });
      return readback(t);
    },

    // Values above 1 survive a float target, then get scaled back down.
    floatTargetAndCopy: async () => {
      const hdr = target('rgba16float');
      draw({
        code:
          FULLSCREEN +
          `@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.uv.x * 4.0, i.uv.y * 2.0, 3.0, 1.0); }`,
        target: hdr,
        format: 'rgba16float',
      });
      const copy = target('rgba16float');
      const enc = device.createCommandEncoder();
      enc.copyTextureToTexture({ texture: hdr }, { texture: copy }, [SIZE, SIZE]);
      device.queue.submit([enc.finish()]);
      const t = target();
      draw({
        code:
          FULLSCREEN +
          /* wgsl */ `
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(tex, smp, i.uv, 0.0).rgb * 0.25, 1.0);
}`,
        target: t,
        layouts: sampleLayouts,
        groups: [
          [
            { binding: 0, resource: copy.createView() },
            { binding: 1, resource: linear },
          ],
        ],
      });
      return readback(t);
    },

    // A sub-rectangle copy between textures, at an offset.
    copyTextureRegion: async () => {
      const src = target();
      draw({
        code:
          FULLSCREEN +
          `@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.uv, 0.5, 1.0); }`,
        target: src,
      });
      const t = target();
      draw({
        code:
          FULLSCREEN +
          `@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(0.1, 0.1, 0.1, 1.0); }`,
        target: t,
      });
      const enc = device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: src, origin: [4, 40] },
        { texture: t, origin: [30, 6] },
        [24, 16],
      );
      device.queue.submit([enc.finish()]);
      return readback(t);
    },

    externalCanvas: () => externalScene(sourceCanvas(), false, false),
    externalCanvasFlipY: () => externalScene(sourceCanvas(), true, false),
    externalCanvasPremultiplied: () => externalScene(sourceCanvas(), false, true),
    externalImageBitmap: async () =>
      externalScene(await createImageBitmap(sourceCanvas()), false, false),
    externalImageBitmapPremultiplied: async () =>
      externalScene(await createImageBitmap(sourceCanvas()), false, true),

    // discard, derivatives and integer maths in the fragment stage.
    fragmentFeatures: async () => {
      const t = target();
      draw({
        code:
          FULLSCREEN +
          /* wgsl */ `
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let cell = vec2u(i.pos.xy) / 8u;
  if (((cell.x + cell.y) & 1u) == 0u && i.uv.y > 0.5) { discard; }
  let edge = fwidth(i.uv.x) * 32.0;
  let bits = f32((cell.x * 3u + cell.y * 5u) % 7u) / 7.0;
  return vec4f(edge, bits, dpdy(i.uv.y) * 32.0, 1.0);
}`,
        target: t,
        clear: { r: 0.2, g: 0, b: 0.4, a: 1 },
      });
      return readback(t);
    },
  };

  const toBase64 = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  const results: SceneResult[] = [];
  for (const [name, run] of Object.entries(scenes)) {
    try {
      device.pushErrorScope('validation');
      const pixels = await run();
      const err = await device.popErrorScope();
      if (err) results.push({ name, error: `validation error: ${err.message}` });
      else results.push({ name, pixels: toBase64(pixels) });
    } catch (e) {
      results.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  device.destroy();
  return results;
}

/**
 * A WebGPU device implemented on WebGL2 — the compatibility backend.
 *
 * WHY: Threnic's renderers, effects and visualizers are all written against
 * WebGPU. Rather than keep a second, feature-poor renderer for browsers that
 * lack it, this implements the part of the WebGPU API Threnic uses on top of
 * WebGL2, so the very same render graph runs there. Shaders are translated
 * from WGSL by naga (see wgslTranslator.ts).
 *
 * Scope is deliberately the subset Threnic needs: 2D textures, uniform
 * buffers, samplers, render pipelines without vertex buffers or depth,
 * render passes, texture copies and CPU readback. Anything outside it throws
 * or reports a validation error instead of rendering wrongly.
 *
 * Conventions that keep results identical to WebGPU:
 *  - Framebuffer row 0 holds the TOP row of a texture. naga flips clip-space Y
 *    in every vertex shader, so texel addressing, `@builtin(position)`,
 *    uploads and readbacks all agree with WebGPU without per-call fix-ups.
 *    Only presentation to a canvas flips back.
 *  - Commands are recorded and run at `queue.submit`, as in WebGPU, so a
 *    `writeBuffer` issued after a pass is encoded still affects that pass.
 */

import {
  rewriteWgslForWebGL2,
  STORAGE_ELEMENTS_PER_ROW,
  type StorageTextureBinding,
  type TextureAlias,
} from './wgslRewrite';
import { translateWgsl, type TranslatedStage } from './wgslTranslator';

type GL = WebGL2RenderingContext;

// ── WebGPU flag values (identical to the spec's) ─────────────────────────────
const TEX_RENDER_ATTACHMENT = 0x10;
const BUF_MAP_READ = 0x0001;
const BUF_UNIFORM = 0x0040;
const BUF_STORAGE = 0x0080;

interface FormatInfo {
  internal: number;
  format: number;
  type: number;
  bytesPerPixel: number;
  float: boolean;
  /** Stored as RGBA; uploads and readbacks swap red and blue. */
  bgra?: boolean;
}

function formatInfo(gl: GL, format: string): FormatInfo {
  switch (format) {
    case 'rgba8unorm':
      return f(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4, false);
    case 'rgba8unorm-srgb':
      return f(gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, 4, false);
    case 'bgra8unorm':
      return { ...f(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4, false), bgra: true };
    case 'bgra8unorm-srgb':
      return { ...f(gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, 4, false), bgra: true };
    case 'r8unorm':
      return f(gl.R8, gl.RED, gl.UNSIGNED_BYTE, 1, false);
    case 'rg8unorm':
      return f(gl.RG8, gl.RG, gl.UNSIGNED_BYTE, 2, false);
    case 'r16float':
      return f(gl.R16F, gl.RED, gl.HALF_FLOAT, 2, true);
    case 'rg16float':
      return f(gl.RG16F, gl.RG, gl.HALF_FLOAT, 4, true);
    case 'rgba16float':
      return f(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, 8, true);
    case 'r32float':
      return f(gl.R32F, gl.RED, gl.FLOAT, 4, true);
    case 'rgba32float':
      return f(gl.RGBA32F, gl.RGBA, gl.FLOAT, 16, true);
    default:
      throw new Error(`[compat] unsupported texture format: ${format}`);
  }
}
/**
 * Capabilities to pretend are missing, from `localStorage.threnic_gl_disable`
 * (comma separated: float32, float16). Lets the tests exercise the fallbacks
 * that older Mac GPUs take.
 */
function disabledCapabilities(): Set<string> {
  try {
    const raw =
      typeof localStorage === 'undefined' ? null : localStorage.getItem('threnic_gl_disable');
    return new Set(
      (raw ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export interface FloatTargetCaps {
  float32: boolean;
  float16: boolean;
}

/**
 * Which float formats can be rendered into. Meant for a throwaway context: the
 * probe leaves driver state behind that has broken float rendering on some
 * drivers, so the live context never runs it.
 */
export function probeFloatTargets(gl: GL): FloatTargetCaps {
  const disabled = disabledCapabilities();
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_color_buffer_half_float');
  const float32 = !disabled.has('float32') && probeRenderable(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT);
  const float16 =
    !disabled.has('float16') &&
    (float32 || probeRenderable(gl, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT));
  return { float32, float16 };
}

/** True if a texture of this format can be the colour attachment of a complete framebuffer. */
function probeRenderable(gl: GL, internal: number, format: number, type: number): boolean {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  let ok = false;
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    ok =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
      gl.getError() === gl.NO_ERROR;
  } catch {
    ok = false;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain */
    }
  }
  return ok;
}

function f(
  internal: number,
  format: number,
  type: number,
  bytesPerPixel: number,
  float: boolean,
): FormatInfo {
  return { internal, format, type, bytesPerPixel, float };
}

/** Normalise GPUExtent3D / GPUOrigin3D to numbers. */
function extent(size: GPUExtent3D | undefined, fallbackW = 0, fallbackH = 0): [number, number] {
  if (!size) return [fallbackW, fallbackH];
  if (Array.isArray(size) || ArrayBuffer.isView(size)) {
    const a = size as ArrayLike<number>;
    return [a[0] ?? fallbackW, a[1] ?? 1];
  }
  const d = size as GPUExtent3DDict;
  return [d.width, d.height ?? 1];
}
function origin(o: GPUOrigin3D | GPUOrigin2D | undefined): [number, number] {
  if (!o) return [0, 0];
  if (Array.isArray(o) || ArrayBuffer.isView(o)) {
    const a = o as ArrayLike<number>;
    return [a[0] ?? 0, a[1] ?? 0];
  }
  const d = o as GPUOrigin3DDict;
  return [d.x ?? 0, d.y ?? 0];
}

export class GLCompatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GPUValidationError';
  }
}

// ── Resources ────────────────────────────────────────────────────────────────

export class GLTexture {
  readonly dimension = '2d';
  readonly mipLevelCount = 1;
  readonly sampleCount = 1;
  readonly depthOrArrayLayers = 1;
  label: string;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly usage: number;
  /** @internal */ handle: WebGLTexture | null;
  /** @internal */ info: FormatInfo;
  /** @internal */ fbo: WebGLFramebuffer | null = null;
  /** @internal The canvas context this texture is the current image of. */
  canvasContext: GLCanvasContext | null = null;

  constructor(
    readonly device: GLDevice,
    desc: GPUTextureDescriptor,
  ) {
    const gl = device.gl;
    const [w, h] = extent(desc.size);
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    this.format = desc.format;
    this.usage = desc.usage;
    this.label = desc.label ?? '';
    let info = formatInfo(gl, desc.format);
    // Float render targets are an extension in WebGL2. Without it, fall back to
    // 8-bit so the effect still runs (with less precision) instead of failing.
    if (info.float && desc.usage & TEX_RENDER_ATTACHMENT) {
      if (info.type === gl.FLOAT && !device.canRenderFloat) {
        info = formatInfo(gl, device.canRenderHalf ? 'rgba16float' : 'rgba8unorm');
      } else if (info.type === gl.HALF_FLOAT && !device.canRenderHalf) {
        info = formatInfo(gl, 'rgba8unorm');
      }
    }
    this.info = info;
    this.handle = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.texStorage2D(gl.TEXTURE_2D, 1, info.internal, this.width, this.height);
    // No mip chain: the texture's own filter must not need one, for the
    // sampler-less (textureLoad) case where no sampler object overrides it.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    device.track(this);
  }

  createView(): GLTextureView {
    return new GLTextureView(this);
  }

  /** @internal Framebuffer with this texture as its only colour attachment. */
  framebuffer(): WebGLFramebuffer {
    const gl = this.device.gl;
    if (!this.fbo) {
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.handle, 0);
    }
    return this.fbo!;
  }

  destroy(): void {
    if (!this.handle) return;
    const gl = this.device.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    gl.deleteTexture(this.handle);
    this.fbo = null;
    this.handle = null;
    this.device.untrack(this);
  }
}

export class GLTextureView {
  label = '';
  constructor(readonly texture: GLTexture) {}
}

/** A video frame imported with `importExternalTexture`: a plain texture here. */
export class GLExternalTexture {
  label = '';
  constructor(readonly texture: GLTexture) {}
}

export class GLSampler {
  label: string;
  /** @internal */ handle: WebGLSampler | null;
  constructor(device: GLDevice, desc: GPUSamplerDescriptor = {}) {
    const gl = device.gl;
    this.label = desc.label ?? '';
    this.handle = gl.createSampler();
    const s = this.handle!;
    const wrap = (m: GPUAddressMode | undefined) =>
      m === 'repeat' ? gl.REPEAT : m === 'mirror-repeat' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    const filter = (m: GPUFilterMode | undefined) => (m === 'linear' ? gl.LINEAR : gl.NEAREST);
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap(desc.addressModeU));
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap(desc.addressModeV));
    gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, filter(desc.magFilter));
    // Textures have a single mip level, so the mipmap filter never applies.
    gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, filter(desc.minFilter));
  }
}

export class GLBuffer {
  label: string;
  readonly size: number;
  readonly usage: number;
  mapState: GPUBufferMapState = 'unmapped';
  /** @internal GL buffer, for uniform buffers. */
  handle: WebGLBuffer | null = null;
  /** @internal CPU copy, for readback and storage buffers. */
  data: ArrayBuffer | null = null;
  /** @internal Float texture mirror of a storage buffer. */
  storageTexture: GLTexture | null = null;
  /** @internal */ storageDirty = true;

  constructor(
    readonly device: GLDevice,
    desc: GPUBufferDescriptor,
  ) {
    const gl = device.gl;
    this.label = desc.label ?? '';
    this.size = desc.size;
    this.usage = desc.usage;
    if (desc.usage & BUF_UNIFORM) {
      this.handle = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.handle);
      gl.bufferData(gl.UNIFORM_BUFFER, Math.max(16, desc.size), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    }
    if (desc.usage & (BUF_MAP_READ | BUF_STORAGE) || desc.mappedAtCreation) {
      this.data = new ArrayBuffer(desc.size);
    }
    if (desc.mappedAtCreation) this.mapState = 'mapped';
    device.track(this);
  }

  /** @internal */
  write(offset: number, bytes: Uint8Array): void {
    const gl = this.device.gl;
    if (this.handle) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.handle);
      gl.bufferSubData(gl.UNIFORM_BUFFER, offset, bytes);
      gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    }
    if (this.data) {
      new Uint8Array(this.data).set(bytes, offset);
      this.storageDirty = true;
    }
  }

  /** @internal Texture holding this storage buffer's vec4 elements. */
  syncStorageTexture(texelsPerElement: number): GLTexture {
    const device = this.device;
    const gl = device.gl;
    const rowTexels = STORAGE_ELEMENTS_PER_ROW * texelsPerElement;
    const floats = new Float32Array(this.data!);
    const elements = Math.max(1, Math.floor(floats.length / (4 * texelsPerElement)));
    const rows = Math.ceil(elements / STORAGE_ELEMENTS_PER_ROW);
    if (
      !this.storageTexture ||
      this.storageTexture.width !== rowTexels ||
      this.storageTexture.height < rows
    ) {
      this.storageTexture?.destroy();
      this.storageTexture = new GLTexture(device, {
        size: [rowTexels, rows],
        format: 'rgba32float',
        usage: 0x04 | 0x02,
      });
      this.storageDirty = true;
    }
    if (this.storageDirty) {
      const padded = new Float32Array(rowTexels * rows * 4);
      padded.set(floats.subarray(0, Math.min(floats.length, padded.length)));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.storageTexture.handle);
      device.resetUnpack();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rowTexels, rows, gl.RGBA, gl.FLOAT, padded);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.storageDirty = false;
    }
    return this.storageTexture;
  }

  mapAsync(): Promise<undefined> {
    if (!this.data) return Promise.reject(new GLCompatError('buffer is not mappable'));
    this.mapState = 'mapped';
    return Promise.resolve(undefined);
  }

  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    if (!this.data) throw new GLCompatError('buffer is not mapped');
    if (offset === 0 && (size === undefined || size === this.data.byteLength)) return this.data;
    // A sub-range has to be a copy; callers here only read mapped ranges.
    return this.data.slice(offset, size === undefined ? undefined : offset + size);
  }

  unmap(): void {
    if (this.mapState === 'mapped' && this.handle && this.data) {
      // Contents written while mapped at creation reach the GL buffer here.
      this.write(0, new Uint8Array(this.data));
    }
    this.mapState = 'unmapped';
  }

  destroy(): void {
    const gl = this.device.gl;
    if (this.handle) gl.deleteBuffer(this.handle);
    this.storageTexture?.destroy();
    this.handle = null;
    this.data = null;
    this.storageTexture = null;
    this.device.untrack(this);
  }
}

export class GLBindGroupLayout {
  label: string;
  constructor(readonly desc: GPUBindGroupLayoutDescriptor | null) {
    this.label = desc?.label ?? '';
  }
}

export class GLPipelineLayout {
  label: string;
  constructor(readonly desc: GPUPipelineLayoutDescriptor) {
    this.label = desc.label ?? '';
  }
}

type BoundResource =
  | { kind: 'buffer'; buffer: GLBuffer; offset: number; size: number | undefined }
  | { kind: 'texture'; texture: GLTexture }
  | { kind: 'sampler'; sampler: GLSampler };

export class GLBindGroup {
  label: string;
  /** @internal */ readonly entries = new Map<number, BoundResource>();
  constructor(desc: GPUBindGroupDescriptor) {
    this.label = desc.label ?? '';
    for (const e of desc.entries) {
      const r = e.resource as unknown;
      if (r instanceof GLTextureView || r instanceof GLExternalTexture) {
        this.entries.set(e.binding, { kind: 'texture', texture: r.texture });
      } else if (r instanceof GLSampler) {
        this.entries.set(e.binding, { kind: 'sampler', sampler: r });
      } else if (r instanceof GLBuffer) {
        this.entries.set(e.binding, { kind: 'buffer', buffer: r, offset: 0, size: undefined });
      } else if (r && (r as GPUBufferBinding).buffer instanceof GLBuffer) {
        const b = r as GPUBufferBinding;
        this.entries.set(e.binding, {
          kind: 'buffer',
          buffer: b.buffer as unknown as GLBuffer,
          offset: b.offset ?? 0,
          size: b.size,
        });
      } else {
        throw new GLCompatError(`[compat] unsupported bind group resource at binding ${e.binding}`);
      }
    }
  }
}

export class GLShaderModule {
  label: string;
  /** @internal WGSL after the WebGL2 rewrites. */
  readonly code: string;
  /** @internal */ readonly storage: StorageTextureBinding[];
  /** @internal */ readonly aliases: TextureAlias[];
  private info: GPUCompilationInfo | null = null;

  constructor(desc: GPUShaderModuleDescriptor) {
    this.label = desc.label ?? '';
    const rewritten = rewriteWgslForWebGL2(desc.code);
    this.code = rewritten.code;
    this.storage = rewritten.storage;
    this.aliases = rewritten.aliases;
  }

  getCompilationInfo(): Promise<GPUCompilationInfo> {
    if (!this.info) {
      const res = translateWgsl({ code: this.code });
      const messages: GPUCompilationMessage[] = res.ok
        ? []
        : [
            {
              type: 'error',
              message: res.message,
              lineNum: res.line ?? 0,
              linePos: res.column ?? 0,
              offset: 0,
              length: 0,
            } as unknown as GPUCompilationMessage,
          ];
      this.info = { messages } as unknown as GPUCompilationInfo;
    }
    return Promise.resolve(this.info);
  }
}

interface ProgramTexture {
  location: WebGLUniformLocation;
  unit: number;
  group: number;
  binding: number;
  samplerGroup: number | null;
  samplerBinding: number | null;
  /** Set when the binding is a storage buffer rewritten to a texture. */
  storageTexels: number | null;
}

interface ProgramUniformBlock {
  slot: number;
  group: number;
  binding: number;
}

const BLEND_FACTOR: Record<string, keyof GL> = {
  zero: 'ZERO',
  one: 'ONE',
  src: 'SRC_COLOR',
  'one-minus-src': 'ONE_MINUS_SRC_COLOR',
  'src-alpha': 'SRC_ALPHA',
  'one-minus-src-alpha': 'ONE_MINUS_SRC_ALPHA',
  dst: 'DST_COLOR',
  'one-minus-dst': 'ONE_MINUS_DST_COLOR',
  'dst-alpha': 'DST_ALPHA',
  'one-minus-dst-alpha': 'ONE_MINUS_DST_ALPHA',
  'src-alpha-saturated': 'SRC_ALPHA_SATURATE',
  constant: 'CONSTANT_COLOR',
  'one-minus-constant': 'ONE_MINUS_CONSTANT_COLOR',
};
const BLEND_OP: Record<string, keyof GL> = {
  add: 'FUNC_ADD',
  subtract: 'FUNC_SUBTRACT',
  'reverse-subtract': 'FUNC_REVERSE_SUBTRACT',
  min: 'MIN',
  max: 'MAX',
};
const TOPOLOGY: Record<string, keyof GL> = {
  'point-list': 'POINTS',
  'line-list': 'LINES',
  'line-strip': 'LINE_STRIP',
  'triangle-list': 'TRIANGLES',
  'triangle-strip': 'TRIANGLE_STRIP',
};

export class GLRenderPipeline {
  label: string;
  /** @internal */ program: WebGLProgram | null = null;
  /** @internal */ textures: ProgramTexture[] = [];
  /** @internal */ blocks: ProgramUniformBlock[] = [];
  /** @internal */ firstInstance: WebGLUniformLocation | null = null;
  /** @internal */ mode: number;
  /** @internal */ targets: (GPUColorTargetState | null)[];
  /** @internal Why the pipeline cannot draw, if it cannot. */
  error: string | null = null;
  private readonly layout: GLPipelineLayout | null;

  constructor(
    readonly device: GLDevice,
    desc: GPURenderPipelineDescriptor,
  ) {
    const gl = device.gl;
    this.label = desc.label ?? '';
    this.layout = desc.layout === 'auto' ? null : (desc.layout as unknown as GLPipelineLayout);
    const topology = desc.primitive?.topology ?? 'triangle-list';
    this.mode = gl[TOPOLOGY[topology]] as number;
    this.targets = [...(desc.fragment?.targets ?? [])].map((t) => t ?? null);
    try {
      this.build(desc);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    device.track(this);
  }

  private build(desc: GPURenderPipelineDescriptor): void {
    const gl = this.device.gl;
    const vsModule = desc.vertex.module as unknown as GLShaderModule;
    const fsModule = desc.fragment?.module as unknown as GLShaderModule | undefined;
    if (!fsModule) throw new Error('pipelines without a fragment stage are not supported');
    if (desc.vertex.buffers && [...desc.vertex.buffers].length > 0) {
      throw new Error('vertex buffers are not supported by the compatibility backend');
    }
    if (desc.depthStencil) {
      throw new Error('depth/stencil is not supported by the compatibility backend');
    }

    const stage = (
      module: GLShaderModule,
      which: 'vertex' | 'fragment',
      entryPoint: string | undefined,
      constants: Record<string, number> | undefined,
    ): TranslatedStage => {
      const res = translateWgsl({
        code: module.code,
        [which]: entryPoint ?? defaultEntryPoint(module.code, which),
        constants,
      });
      if (!res.ok) {
        const where = res.line ? ` (line ${res.line}:${res.column ?? 0})` : '';
        throw new Error(`WGSL ${res.stage} error${where}: ${res.message}`);
      }
      return res[which]!;
    };
    const vs = stage(vsModule, 'vertex', desc.vertex.entryPoint, desc.vertex.constants);
    const fs = stage(fsModule, 'fragment', desc.fragment!.entryPoint, desc.fragment!.constants);

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const vsh = compile(gl.VERTEX_SHADER, vs.glsl);
    const fsh = compile(gl.FRAGMENT_SHADER, fs.glsl);
    const program = gl.createProgram()!;
    gl.attachShader(program, vsh);
    gl.attachShader(program, fsh);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log =
        gl.getShaderInfoLog(vsh) || gl.getShaderInfoLog(fsh) || gl.getProgramInfoLog(program);
      gl.deleteShader(vsh);
      gl.deleteShader(fsh);
      gl.deleteProgram(program);
      throw new Error(`GLSL link failed: ${log ?? 'unknown error'}`);
    }
    gl.deleteShader(vsh);
    gl.deleteShader(fsh);
    this.program = program;

    // Uniform blocks: the two stages name the same binding differently, so
    // both names are pointed at one binding slot per (group, binding).
    const slots = new Map<string, number>();
    for (const st of [vs, fs]) {
      for (const u of st.uniforms) {
        const key = `${u.group}:${u.binding}`;
        let slot = slots.get(key);
        if (slot === undefined) {
          slot = slots.size;
          slots.set(key, slot);
          this.blocks.push({ slot, group: u.group, binding: u.binding });
        }
        const index = gl.getUniformBlockIndex(program, u.name);
        if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, index, slot);
      }
    }

    gl.useProgram(program);
    const storage = new Map<string, number>();
    // Alias bindings (one texture, several samplers) resolve to the real one.
    const aliasOf = new Map<string, number>();
    for (const m of [vsModule, fsModule]) {
      for (const s of m.storage) storage.set(`${s.group}:${s.binding}`, s.texelsPerElement);
      for (const a of m.aliases) aliasOf.set(`${a.group}:${a.binding}`, a.sourceBinding);
    }
    let unit = 0;
    for (const st of [vs, fs]) {
      for (const t of st.textures) {
        const location = gl.getUniformLocation(program, t.name);
        if (!location) continue; // optimised out
        gl.uniform1i(location, unit);
        this.textures.push({
          location,
          unit: unit++,
          group: t.group,
          binding: aliasOf.get(`${t.group}:${t.binding}`) ?? t.binding,
          samplerGroup: t.samplerGroup,
          samplerBinding: t.samplerBinding,
          storageTexels: storage.get(`${t.group}:${t.binding}`) ?? null,
        });
      }
    }
    if (vs.firstInstance) {
      this.firstInstance = gl.getUniformLocation(program, 'naga_vs_first_instance');
    }
    gl.useProgram(null);
  }

  getBindGroupLayout(index: number): GLBindGroupLayout {
    const explicit = this.layout
      ? ([...this.layout.desc.bindGroupLayouts][index] as unknown as GLBindGroupLayout | undefined)
      : undefined;
    return explicit ?? new GLBindGroupLayout(null);
  }

  /** @internal */
  destroy(): void {
    if (this.program) this.device.gl.deleteProgram(this.program);
    this.program = null;
    this.device.untrack(this);
  }
}

/** First `@vertex` / `@fragment` function, for descriptors that omit one. */
function defaultEntryPoint(code: string, stage: 'vertex' | 'fragment'): string {
  const m = new RegExp(`@${stage}\\s+fn\\s+(\\w+)`).exec(code);
  if (!m) throw new Error(`shader module has no @${stage} entry point`);
  return m[1];
}

// ── Command encoding ─────────────────────────────────────────────────────────

type Command = () => void;

interface PassState {
  pipeline: GLRenderPipeline | null;
  groups: (GLBindGroup | undefined)[];
  width: number;
  height: number;
}

export class GLRenderPass {
  label: string;
  private readonly cmds: ((s: PassState) => void)[] = [];
  private ended = false;

  constructor(
    private readonly device: GLDevice,
    private readonly encoder: GLCommandEncoder,
    private readonly desc: GPURenderPassDescriptor,
  ) {
    this.label = desc.label ?? '';
  }

  setPipeline(pipeline: GPURenderPipeline): void {
    this.cmds.push((s) => {
      s.pipeline = pipeline as unknown as GLRenderPipeline;
    });
  }

  setBindGroup(index: number, group: GPUBindGroup | null): void {
    this.cmds.push((s) => {
      s.groups[index] = (group as unknown as GLBindGroup | null) ?? undefined;
    });
  }

  setViewport(x: number, y: number, w: number, h: number): void {
    // Row 0 is the top row (see file header), so WebGPU's top-left origin maps
    // straight onto GL's.
    this.cmds.push(() => this.device.gl.viewport(x, y, w, h));
  }

  setScissorRect(x: number, y: number, w: number, h: number): void {
    const gl = this.device.gl;
    this.cmds.push(() => {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, y, w, h);
    });
  }

  setBlendConstant(color: GPUColor): void {
    const c = colorOf(color);
    this.cmds.push(() => this.device.gl.blendColor(c[0], c[1], c[2], c[3]));
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.cmds.push((s) =>
      this.device.draw(s, vertexCount, instanceCount, firstVertex, firstInstance),
    );
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const { device, desc, cmds } = this;
    this.encoder.push(() => device.runPass(desc, cmds));
  }
}

export class GLCommandEncoder {
  label: string;
  private readonly cmds: Command[] = [];
  constructor(
    private readonly device: GLDevice,
    desc?: GPUCommandEncoderDescriptor,
  ) {
    this.label = desc?.label ?? '';
  }

  /** @internal */
  push(cmd: Command): void {
    this.cmds.push(cmd);
  }

  beginRenderPass(desc: GPURenderPassDescriptor): GLRenderPass {
    return new GLRenderPass(this.device, this, desc);
  }

  copyTextureToTexture(
    src: GPUTexelCopyTextureInfo,
    dst: GPUTexelCopyTextureInfo,
    size: GPUExtent3D,
  ): void {
    this.cmds.push(() => this.device.copyTextureToTexture(src, dst, size));
  }

  copyTextureToBuffer(
    src: GPUTexelCopyTextureInfo,
    dst: GPUTexelCopyBufferInfo,
    size: GPUExtent3D,
  ): void {
    this.cmds.push(() => this.device.copyTextureToBuffer(src, dst, size));
  }

  finish(): GLCommandBuffer {
    return new GLCommandBuffer(this.cmds);
  }
}

export class GLCommandBuffer {
  label = '';
  constructor(readonly cmds: Command[]) {}
}

function colorOf(c: GPUColor | undefined): [number, number, number, number] {
  if (!c) return [0, 0, 0, 0];
  if (Array.isArray(c) || ArrayBuffer.isView(c)) {
    const a = c as ArrayLike<number>;
    return [a[0], a[1], a[2], a[3]];
  }
  const d = c as GPUColorDict;
  return [d.r, d.g, d.b, d.a];
}

// ── Queue ────────────────────────────────────────────────────────────────────

export class GLQueue {
  label = '';
  constructor(private readonly device: GLDevice) {}

  submit(buffers: Iterable<GPUCommandBuffer>): void {
    const device = this.device;
    if (device.isLost) return;
    for (const b of buffers) {
      for (const cmd of (b as unknown as GLCommandBuffer).cmds) cmd();
    }
    device.presentPending();
  }

  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: BufferSource,
    dataOffset = 0,
    size?: number,
  ): void {
    if (this.device.isLost) return;
    // For typed arrays, dataOffset and size are in elements (per the spec).
    let bytes: Uint8Array;
    if (ArrayBuffer.isView(data)) {
      const el = (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
      const start = data.byteOffset + dataOffset * el;
      const len = size === undefined ? data.byteLength - dataOffset * el : size * el;
      bytes = new Uint8Array(data.buffer as ArrayBuffer, start, len);
    } else {
      bytes = new Uint8Array(
        data as ArrayBuffer,
        dataOffset,
        size === undefined ? (data as ArrayBuffer).byteLength - dataOffset : size,
      );
    }
    (buffer as unknown as GLBuffer).write(bufferOffset, bytes);
  }

  writeTexture(
    destination: GPUTexelCopyTextureInfo,
    data: BufferSource,
    layout: GPUTexelCopyBufferLayout,
    size: GPUExtent3D,
  ): void {
    const device = this.device;
    if (device.isLost) return;
    const gl = device.gl;
    const tex = destination.texture as unknown as GLTexture;
    const [w, h] = extent(size, tex.width, tex.height);
    const [x, y] = origin(destination.origin);
    const info = tex.info;
    const offset = layout.offset ?? 0;
    const bytesPerRow = layout.bytesPerRow ?? w * info.bytesPerPixel;
    const base = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset + offset)
      : new Uint8Array(data as ArrayBuffer, offset);
    let view: ArrayBufferView = base;
    if (info.bgra) {
      const swapped = new Uint8Array(base.subarray(0, bytesPerRow * (h - 1) + w * 4));
      for (let i = 0; i + 3 < swapped.length; i += 4) {
        const r = swapped[i];
        swapped[i] = swapped[i + 2];
        swapped[i + 2] = r;
      }
      view = swapped;
    } else if (info.type === gl.HALF_FLOAT) {
      view = new Uint16Array(base.slice().buffer);
    } else if (info.type === gl.FLOAT) {
      view = new Float32Array(base.slice().buffer);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.handle);
    device.resetUnpack();
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, Math.floor(bytesPerRow / info.bytesPerPixel));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, info.format, info.type, view);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  copyExternalImageToTexture(
    source: GPUCopyExternalImageSourceInfo,
    destination: GPUCopyExternalImageDestInfo,
    size: GPUExtent3D,
  ): void {
    const device = this.device;
    if (device.isLost) return;
    const gl = device.gl;
    const tex = destination.texture as unknown as GLTexture;
    const [w, h] = extent(size, tex.width, tex.height);
    const [dx, dy] = origin(destination.origin);
    const [sx, sy] = origin(source.origin);
    // WebGL uploads an ImageBitmap exactly as it is stored and ignores the
    // premultiply setting, and browsers differ in how they store one. Going
    // through a 2D canvas gives the well-defined canvas behaviour instead.
    let image = source.source as TexImageSource;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
      image = device.bitmapToCanvas(image);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.handle);
    device.resetUnpack();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, source.flipY === true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, destination.premultipliedAlpha === true);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, sx);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, sy);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, dx, dy, w, h, tex.info.format, tex.info.type, image);
    device.resetUnpack();
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  onSubmittedWorkDone(): Promise<undefined> {
    if (!this.device.isLost) this.device.gl.flush();
    return Promise.resolve(undefined);
  }
}

// ── Canvas context ───────────────────────────────────────────────────────────

/**
 * Stand-in for GPUCanvasContext. The device renders into an ordinary texture,
 * and after each submit that drew to it the image is copied to the canvas
 * through its 2D context.
 */
export class GLCanvasContext {
  private device: GLDevice | null = null;
  private format: GPUTextureFormat = 'rgba8unorm';
  private alphaMode: GPUCanvasAlphaMode = 'opaque';
  private texture: GLTexture | null = null;
  private ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {}

  configure(config: GPUCanvasConfiguration): void {
    this.unconfigure();
    this.device = config.device as unknown as GLDevice;
    this.format = config.format;
    this.alphaMode = config.alphaMode ?? 'opaque';
    if (!this.ctx2d) {
      this.ctx2d = (this.canvas as HTMLCanvasElement).getContext('2d', {
        alpha: true,
      }) as CanvasRenderingContext2D | null;
      if (!this.ctx2d) {
        throw new GLCompatError('[compat] the canvas is already in use by another context type');
      }
    }
  }

  unconfigure(): void {
    this.texture?.destroy();
    this.texture = null;
    this.device = null;
  }

  getConfiguration(): GPUCanvasConfiguration | null {
    if (!this.device) return null;
    return {
      device: this.device as unknown as GPUDevice,
      format: this.format,
      alphaMode: this.alphaMode,
    };
  }

  getCurrentTexture(): GPUTexture {
    const device = this.device;
    if (!device) throw new GLCompatError('[compat] canvas context is not configured');
    const w = Math.max(1, this.canvas.width);
    const h = Math.max(1, this.canvas.height);
    if (
      !this.texture ||
      !this.texture.handle ||
      this.texture.width !== w ||
      this.texture.height !== h
    ) {
      this.texture?.destroy();
      this.texture = new GLTexture(device, {
        size: [w, h],
        format: this.format,
        usage: TEX_RENDER_ATTACHMENT | 0x01 | 0x04,
      });
      this.texture.canvasContext = this;
    }
    return this.texture as unknown as GPUTexture;
  }

  /** @internal Copy the current texture to the canvas. */
  present(): void {
    const device = this.device;
    const tex = this.texture;
    if (!device || !tex || !tex.handle || !this.ctx2d) return;
    if (this.canvas.width !== tex.width || this.canvas.height !== tex.height) return;
    const source = device.blitToDrawingBuffer(tex, this.alphaMode === 'opaque');
    const ctx = this.ctx2d;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(source as CanvasImageSource, 0, 0);
  }
}

// ── Device ───────────────────────────────────────────────────────────────────

interface Destroyable {
  destroy(): void;
}

export interface GLDeviceLimits {
  maxTextureDimension2D: number;
  maxBindGroups: number;
  maxUniformBufferBindingSize: number;
  maxColorAttachments: number;
  [key: string]: number;
}

export class GLDevice extends EventTarget {
  label = '';
  readonly queue: GLQueue;
  readonly features: ReadonlySet<string> = new Set<string>();
  readonly limits: GLDeviceLimits;
  readonly lost: Promise<GPUDeviceLostInfo>;
  readonly adapterInfo: GPUAdapterInfo;
  onuncapturederror: ((ev: Event) => void) | null = null;
  /** Marks this as the WebGL2 compatibility backend. */
  readonly isCompatDevice = true;
  /** @internal */ isLost = false;
  /** @internal 32-bit float textures can be rendered into. */ readonly canRenderFloat: boolean;
  /** @internal 16-bit float textures can be rendered into. */ readonly canRenderHalf: boolean;
  /** @internal */ readonly canvas: OffscreenCanvas | HTMLCanvasElement;

  private resolveLost!: (info: GPUDeviceLostInfo) => void;
  private readonly resources = new Set<Destroyable>();
  private readonly pending = new Set<GLCanvasContext>();
  private readonly errorScopes: (GLCompatError | null)[] = [];
  private readonly vao: WebGLVertexArrayObject | null;
  private readonly warned = new Set<string>();
  private readonly onContextLost: (e: Event) => void;

  constructor(
    readonly gl: GL,
    canvas: OffscreenCanvas | HTMLCanvasElement,
    adapterInfo: GPUAdapterInfo,
    caps: FloatTargetCaps,
  ) {
    super();
    this.canvas = canvas;
    this.adapterInfo = adapterInfo;
    this.queue = new GLQueue(this);
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    this.canRenderFloat = caps.float32;
    this.canRenderHalf = caps.float16;
    console.info(
      `[WebGL2-Compat] float render targets: 32-bit ${this.canRenderFloat ? 'yes' : 'no'}, 16-bit ${this.canRenderHalf ? 'yes' : 'no'}`,
    );
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_float_blend');
    this.limits = {
      maxTextureDimension2D: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxBindGroups: 4,
      maxUniformBufferBindingSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number,
      maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number,
    };
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    this.lost = new Promise((resolve) => {
      this.resolveLost = resolve;
    });
    this.onContextLost = (e) => {
      e.preventDefault();
      this.markLost('unknown', 'The WebGL context backing this device was lost.');
    };
    canvas.addEventListener('webglcontextlost', this.onContextLost as EventListener);
  }

  /** @internal */
  track(r: Destroyable): void {
    this.resources.add(r);
  }
  /** @internal */
  untrack(r: Destroyable): void {
    this.resources.delete(r);
  }

  private markLost(reason: 'unknown' | 'destroyed', message: string): void {
    if (this.isLost) return;
    this.isLost = true;
    this.resolveLost({ reason, message } as unknown as GPUDeviceLostInfo);
  }

  /** @internal Report a validation error the way WebGPU would. */
  reportError(message: string): void {
    const err = new GLCompatError(message);
    if (this.errorScopes.length > 0) {
      const top = this.errorScopes.length - 1;
      if (!this.errorScopes[top]) this.errorScopes[top] = err;
      return;
    }
    const ev = new Event('uncapturederror') as Event & { error: GLCompatError };
    ev.error = err;
    this.onuncapturederror?.(ev);
    this.dispatchEvent(ev);
    if (!this.warned.has(message)) {
      this.warned.add(message);
      console.error(`[compat] ${message}`);
    }
  }

  pushErrorScope(): void {
    this.errorScopes.push(null);
  }

  popErrorScope(): Promise<GPUError | null> {
    if (this.errorScopes.length === 0) {
      return Promise.reject(new GLCompatError('popErrorScope called with no error scope'));
    }
    return Promise.resolve(this.errorScopes.pop() as unknown as GPUError | null);
  }

  createTexture(desc: GPUTextureDescriptor): GPUTexture {
    return new GLTexture(this, desc) as unknown as GPUTexture;
  }

  createSampler(desc?: GPUSamplerDescriptor): GPUSampler {
    return new GLSampler(this, desc) as unknown as GPUSampler;
  }

  createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
    return new GLBuffer(this, desc) as unknown as GPUBuffer;
  }

  createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout {
    return new GLBindGroupLayout(desc) as unknown as GPUBindGroupLayout;
  }

  createPipelineLayout(desc: GPUPipelineLayoutDescriptor): GPUPipelineLayout {
    return new GLPipelineLayout(desc) as unknown as GPUPipelineLayout;
  }

  createBindGroup(desc: GPUBindGroupDescriptor): GPUBindGroup {
    return new GLBindGroup(desc) as unknown as GPUBindGroup;
  }

  createShaderModule(desc: GPUShaderModuleDescriptor): GPUShaderModule {
    return new GLShaderModule(desc) as unknown as GPUShaderModule;
  }

  createRenderPipeline(desc: GPURenderPipelineDescriptor): GPURenderPipeline {
    const pipeline = new GLRenderPipeline(this, desc);
    if (pipeline.error) {
      this.reportError(`render pipeline "${pipeline.label}" is invalid: ${pipeline.error}`);
    }
    return pipeline as unknown as GPURenderPipeline;
  }

  createRenderPipelineAsync(desc: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
    const pipeline = new GLRenderPipeline(this, desc);
    if (pipeline.error) {
      return Promise.reject(
        new GLCompatError(`render pipeline "${pipeline.label}" is invalid: ${pipeline.error}`),
      );
    }
    return Promise.resolve(pipeline as unknown as GPURenderPipeline);
  }

  createCommandEncoder(desc?: GPUCommandEncoderDescriptor): GPUCommandEncoder {
    return new GLCommandEncoder(this, desc) as unknown as GPUCommandEncoder;
  }

  /**
   * A video frame as a texture. WebGPU shares the decoder's buffer; here the
   * current frame is copied into a texture that lives until the next import
   * of the same video.
   */
  importExternalTexture(desc: GPUExternalTextureDescriptor): GPUExternalTexture {
    const source = desc.source as HTMLVideoElement | VideoFrame;
    const w = (source as HTMLVideoElement).videoWidth || (source as VideoFrame).displayWidth || 1;
    const h = (source as HTMLVideoElement).videoHeight || (source as VideoFrame).displayHeight || 1;
    let tex = this.externalTextures.get(source);
    if (!tex || !tex.handle || tex.width !== w || tex.height !== h) {
      tex?.destroy();
      tex = new GLTexture(this, { size: [w, h], format: 'rgba8unorm', usage: 0x04 | 0x02 });
      this.externalTextures.set(source, tex);
    }
    this.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource },
      { texture: tex as unknown as GPUTexture },
      [w, h],
    );
    return new GLExternalTexture(tex) as unknown as GPUExternalTexture;
  }
  private readonly externalTextures = new WeakMap<object, GLTexture>();

  private scratch: OffscreenCanvas | HTMLCanvasElement | null = null;
  private scratchCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  /** @internal Draw a bitmap into a reusable 2D canvas (see copyExternalImageToTexture). */
  bitmapToCanvas(bitmap: ImageBitmap): TexImageSource {
    if (!this.scratch) {
      this.scratch =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(bitmap.width, bitmap.height)
          : document.createElement('canvas');
      this.scratchCtx = (this.scratch as HTMLCanvasElement).getContext('2d', {
        willReadFrequently: false,
      }) as CanvasRenderingContext2D | null;
    }
    const c = this.scratch;
    const ctx = this.scratchCtx;
    if (!ctx) return bitmap;
    if (c.width !== bitmap.width || c.height !== bitmap.height) {
      c.width = bitmap.width;
      c.height = bitmap.height;
    } else {
      ctx.clearRect(0, 0, c.width, c.height);
    }
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(bitmap, 0, 0);
    return c as TexImageSource;
  }

  /** @internal Default pixel-store state for uploads. */
  resetUnpack(): void {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  /** @internal */
  runPass(desc: GPURenderPassDescriptor, cmds: ((s: PassState) => void)[]): void {
    const gl = this.gl;
    const attachments = [...desc.colorAttachments].filter(
      (a): a is GPURenderPassColorAttachment => !!a,
    );
    if (attachments.length !== 1) {
      this.reportError('render passes must have exactly one colour attachment');
      return;
    }
    const att = attachments[0];
    const view = att.view as unknown as GLTextureView | GLTexture;
    const target = view instanceof GLTextureView ? view.texture : view;
    if (!target.handle) {
      this.reportError('render pass targets a destroyed texture');
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer());
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.SCISSOR_TEST);
    if (att.loadOp === 'clear') {
      const c = colorOf(att.clearValue);
      gl.colorMask(true, true, true, true);
      gl.clearColor(c[0], c[1], c[2], c[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (target.canvasContext) this.pending.add(target.canvasContext);
    const state: PassState = {
      pipeline: null,
      groups: [],
      width: target.width,
      height: target.height,
    };
    for (const cmd of cmds) cmd(state);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** @internal */
  draw(
    s: PassState,
    vertexCount: number,
    instanceCount: number,
    firstVertex: number,
    firstInstance: number,
  ): void {
    const gl = this.gl;
    const p = s.pipeline;
    if (!p || !p.program) return; // invalid pipeline: already reported
    gl.useProgram(p.program);

    const target = p.targets[0];
    const blend = target?.blend;
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendEquationSeparate(
        gl[BLEND_OP[blend.color.operation ?? 'add']] as number,
        gl[BLEND_OP[blend.alpha.operation ?? 'add']] as number,
      );
      gl.blendFuncSeparate(
        gl[BLEND_FACTOR[blend.color.srcFactor ?? 'one']] as number,
        gl[BLEND_FACTOR[blend.color.dstFactor ?? 'zero']] as number,
        gl[BLEND_FACTOR[blend.alpha.srcFactor ?? 'one']] as number,
        gl[BLEND_FACTOR[blend.alpha.dstFactor ?? 'zero']] as number,
      );
    } else {
      gl.disable(gl.BLEND);
    }
    const mask = target?.writeMask ?? 0xf;
    gl.colorMask(!!(mask & 1), !!(mask & 2), !!(mask & 4), !!(mask & 8));

    for (const b of p.blocks) {
      const r = s.groups[b.group]?.entries.get(b.binding);
      if (!r || r.kind !== 'buffer' || !r.buffer.handle) {
        this.reportError(
          `draw with pipeline "${p.label}": no uniform buffer bound at group ${b.group} binding ${b.binding}`,
        );
        return;
      }
      if (r.offset === 0 && r.size === undefined) {
        gl.bindBufferBase(gl.UNIFORM_BUFFER, b.slot, r.buffer.handle);
      } else {
        gl.bindBufferRange(
          gl.UNIFORM_BUFFER,
          b.slot,
          r.buffer.handle,
          r.offset,
          r.size ?? r.buffer.size - r.offset,
        );
      }
    }

    for (const t of p.textures) {
      const r = s.groups[t.group]?.entries.get(t.binding);
      let tex: GLTexture | null = null;
      if (r?.kind === 'texture') tex = r.texture;
      else if (r?.kind === 'buffer' && t.storageTexels !== null && r.buffer.data) {
        tex = r.buffer.syncStorageTexture(t.storageTexels);
      }
      if (!tex || !tex.handle) {
        this.reportError(
          `draw with pipeline "${p.label}": no texture bound at group ${t.group} binding ${t.binding}`,
        );
        return;
      }
      gl.activeTexture(gl.TEXTURE0 + t.unit);
      gl.bindTexture(gl.TEXTURE_2D, tex.handle);
      let sampler: WebGLSampler | null = null;
      if (t.samplerGroup !== null && t.samplerBinding !== null) {
        const sr = s.groups[t.samplerGroup]?.entries.get(t.samplerBinding);
        if (sr?.kind === 'sampler') sampler = sr.sampler.handle;
      }
      gl.bindSampler(t.unit, sampler);
    }
    // useProgram above may have been displaced by a storage-texture upload.
    gl.useProgram(p.program);
    if (p.firstInstance) gl.uniform1ui(p.firstInstance, firstInstance);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(p.mode, firstVertex, vertexCount, instanceCount);
  }

  /** @internal */
  copyTextureToTexture(
    src: GPUTexelCopyTextureInfo,
    dst: GPUTexelCopyTextureInfo,
    size: GPUExtent3D,
  ): void {
    const gl = this.gl;
    const s = src.texture as unknown as GLTexture;
    const d = dst.texture as unknown as GLTexture;
    if (!s.handle || !d.handle) return;
    const [w, h] = extent(size, s.width, s.height);
    const [sx, sy] = origin(src.origin);
    const [dx, dy] = origin(dst.origin);
    // Fetch both first: creating a framebuffer rebinds READ and DRAW.
    const readFbo = s.framebuffer();
    const drawFbo = d.framebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.blitFramebuffer(
      sx,
      sy,
      sx + w,
      sy + h,
      dx,
      dy,
      dx + w,
      dy + h,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    if (d.canvasContext) this.pending.add(d.canvasContext);
  }

  /** @internal */
  copyTextureToBuffer(
    src: GPUTexelCopyTextureInfo,
    dst: GPUTexelCopyBufferInfo,
    size: GPUExtent3D,
  ): void {
    const gl = this.gl;
    const tex = src.texture as unknown as GLTexture;
    const buf = dst.buffer as unknown as GLBuffer;
    if (!tex.handle || !buf.data) return;
    if (tex.info.bytesPerPixel !== 4 || tex.info.float) {
      this.reportError('copyTextureToBuffer supports 8-bit RGBA textures only');
      return;
    }
    const [w, h] = extent(size, tex.width, tex.height);
    const [x, y] = origin(src.origin);
    const offset = dst.offset ?? 0;
    const bytesPerRow = dst.bytesPerRow ?? w * 4;
    const out = new Uint8Array(buf.data, offset);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tex.framebuffer());
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, Math.floor(bytesPerRow / 4));
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    if (tex.info.bgra) {
      for (let row = 0; row < h; row++) {
        const start = row * bytesPerRow;
        for (let i = start; i < start + w * 4; i += 4) {
          const r = out[i];
          out[i] = out[i + 2];
          out[i + 2] = r;
        }
      }
    }
  }

  /**
   * @internal Draw a texture into this device's drawing buffer, upright, and
   * return the canvas so a 2D context can copy it out.
   */
  blitToDrawingBuffer(tex: GLTexture, opaque: boolean): OffscreenCanvas | HTMLCanvasElement {
    const gl = this.gl;
    const canvas = this.canvas;
    if (canvas.width !== tex.width || canvas.height !== tex.height) {
      canvas.width = tex.width;
      canvas.height = tex.height;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tex.framebuffer());
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    // Flip: texture row 0 is the top of the image, the drawing buffer's is the bottom.
    gl.blitFramebuffer(
      0,
      0,
      tex.width,
      tex.height,
      0,
      tex.height,
      tex.width,
      0,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    if (opaque) {
      gl.colorMask(false, false, false, true);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.colorMask(true, true, true, true);
    }
    return canvas;
  }

  /** @internal */
  presentPending(): void {
    if (this.pending.size === 0) return;
    const contexts = [...this.pending];
    this.pending.clear();
    for (const c of contexts) c.present();
  }

  destroy(): void {
    if (this.isLost && this.resources.size === 0) return;
    for (const r of [...this.resources]) {
      try {
        r.destroy();
      } catch {
        /* context already gone */
      }
    }
    this.resources.clear();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost as EventListener);
    // Browsers cap live WebGL contexts; release this one now rather than at GC.
    try {
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* ignore */
    }
    this.markLost('destroyed', 'Device was destroyed.');
  }
}

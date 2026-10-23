/**
 * GLSLGuestRenderer — a shared WebGL2 host for single-pass GLSL guest layers
 * (Stage 3a, vertical slice).
 *
 * Owns ONE hidden <canvas> + WebGL2 context that hosts N guest programs, each
 * rendering into the same canvas in turn (the host renders one guest per call to
 * an offscreen framebuffer, then the WebGPU compositor copies the canvas). This
 * coexists with butterchurn's WebGL2 context and the game scene's 2D context, so
 * it is deliberately ONE context for all GLSL guests (browsers cap live contexts
 * at ~8–16 and evict the oldest).
 *
 * Modeled on ButterchurnRenderer's lifecycle (own hidden canvas, preserveDrawing-
 * Buffer, _ready/_destroyed, getCanvas()), but FIXES its two gaps the audit
 * flagged: it (1) handles webglcontextlost/restored and rebuilds programs, and
 * (2) force-loses the context on destroy so repeated create/destroy cycles do
 * not exhaust the browser's context pool.
 *
 * GLSL-guest compatibility (single pass): the guest supplies a GLSL ES 3.00
 * `mainImage(out vec4 fragColor, in vec2 fragCoord)` body; this host wraps it
 * with the standard uniform surface (iResolution, iTime, iTimeDelta, iFrame,
 * iChannel0 = 512×2 audio texture) plus the Threnic-native uValue1..8 slots.
 */

import {
  GUEST_AUDIO_TEX_WIDTH,
  GUEST_AUDIO_TEX_HEIGHT,
  GUEST_CHANNEL_COUNT,
  GUEST_BUFFER_IDS,
  validateGlslSourceSize,
  type GLSLCompileResult,
  type GuestChannelKind,
  type GuestBufferId,
} from './types';

const FULLSCREEN_VS = `#version 300 es
precision highp float;
const vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0); }
`;

/** The GLSL sampler type a channel kind binds to. `none` still declares a
 * sampler2D placeholder so the shader compiles even when unbound. */
function samplerTypeFor(kind: GuestChannelKind): 'sampler2D' | 'samplerCube' {
  return kind === 'cubemap' ? 'samplerCube' : 'sampler2D';
}

/**
 * Wrap a GLSL-guest mainImage body into a complete GLSL ES 3.00 fragment
 * shader. `channelKinds` gives the sampler type for each of iChannel0..3 (the
 * sampler type is baked into GLSL, so the host must recompile when a channel's
 * KIND changes between sampler2D and samplerCube). When omitted, all four
 * channels default to `audio` (sampler2D) — the vertical-slice behaviour.
 */
export function wrapGuestSource(body: string, channelKinds?: GuestChannelKind[]): string {
  const kinds: GuestChannelKind[] = [];
  for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
    kinds.push(channelKinds?.[i] ?? 'none');
  }
  const channelDecls = kinds.map((k, i) => `uniform ${samplerTypeFor(k)} iChannel${i};`).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec3 iResolution;   // viewport resolution (pixels), z = 1.0
uniform float iTime;        // shader playback time (seconds)
uniform float iTimeDelta;   // render time (seconds)
uniform int iFrame;         // shader playback frame
uniform vec4 iMouse;        // unused in slice; kept for source compatibility
${channelDecls}
uniform vec3 iChannelResolution[${GUEST_CHANNEL_COUNT}]; // per-channel resolution
uniform float iChannelIntensity[${GUEST_CHANNEL_COUNT}]; // per-channel 0..1 scalar (AR-drivable)
uniform float uValue1;
uniform float uValue2;
uniform float uValue3;
uniform float uValue4;
uniform float uValue5;
uniform float uValue6;
uniform float uValue7;
uniform float uValue8;

${body}

void main() {
  vec4 c = vec4(0.0);
  mainImage(c, gl_FragCoord.xy);
  // A generative guest is conceptually OPAQUE: many generative Image shaders write
  // a stray alpha < 1 (sky/cloud fades), and a non-premultiplied WebGL canvas then
  // has its RGB attenuated by that alpha when copyExternalImageToTexture transfers
  // it into the WebGPU frame — washing the guest out over the background. Force
  // alpha to 1 so RGB survives the copy intact; the composite's opacity uniform
  // (preserveAlpha=false → a = opacity) is what gates the layer, not the shader's
  // own alpha. A guest that genuinely needs per-pixel alpha opts in via preserveAlpha.
  outColor = vec4(c.rgb, 1.0);
}
`;
}

interface GuestChannelState {
  kind: GuestChannelKind;
  /** GL texture for image2d (TEXTURE_2D) / cubemap (TEXTURE_CUBE_MAP); null for none/audio/buffer. */
  texture: WebGLTexture | null;
  /** Which buffer this channel samples when kind==='buffer'. */
  bufferId: GuestBufferId | null;
  /** [w,h] of the bound image (for iChannelResolution); [0,0] when none/audio. */
  resolution: [number, number];
  wrap: 'repeat' | 'clamp';
  filter: 'linear' | 'nearest' | 'mipmap';
  /** 0..1 scalar exposed as iChannelIntensity[N]. */
  intensity: number;
  /** For kind==='video': the source of frames. */
  videoSource?: 'upload' | 'background';
  /** For an uploaded video channel: its own hidden looping <video> element. */
  videoEl?: HTMLVideoElement | null;
  /** For an uploaded video channel: the object URL to revoke on teardown. */
  videoUrl?: string | null;
}

/**
 * One multipass buffer pass: its program, the channel kinds it was compiled
 * against, its 4 channel states, and a ping-pong pair of RGBA16F (or RGBA8
 * fallback) framebuffers — `read` is last frame (safe to sample, incl. by this
 * pass for feedback), `write` is this frame's target; they swap after the draw.
 */
interface BufferPassState {
  source: string;
  program: WebGLProgram | null;
  uniforms: Record<string, WebGLUniformLocation | null>;
  channels: GuestChannelState[];
  compiledKinds: GuestChannelKind[];
  fbos: [WebGLFramebuffer | null, WebGLFramebuffer | null];
  textures: [WebGLTexture | null, WebGLTexture | null];
  /** Index into fbos/textures that is currently the READ (last-frame) side. */
  readIndex: 0 | 1;
  width: number;
  height: number;
}

interface GuestProgram {
  source: string;
  program: WebGLProgram | null;
  uniforms: Record<string, WebGLUniformLocation | null>;
  frame: number;
  startTime: number;
  lastTime: number;
  /** iChannel0..3 state for the Image pass, index-aligned. */
  channels: GuestChannelState[];
  /** The channel KINDS the Image pass `program` was compiled against. */
  compiledKinds: GuestChannelKind[];
  /** Enabled multipass buffers (Buffer A–D), keyed by id. */
  buffers: Partial<Record<GuestBufferId, BufferPassState>>;
}

function defaultChannelState(kind: GuestChannelKind = 'none'): GuestChannelState {
  return {
    kind,
    texture: null,
    bufferId: null,
    resolution: [0, 0],
    wrap: 'repeat',
    filter: 'linear',
    intensity: 1,
  };
}

export class GLSLGuestRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private loseCtxExt: WEBGL_lose_context | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private audioTex: WebGLTexture | null = null;
  private _blackCube: WebGLTexture | null = null;
  /** 1×1 opaque-black 2D texture bound to a `none` channel so `texture()` reads 0. */
  private _blackTex2D: WebGLTexture | null = null;
  /** RGBA16F color-buffer support (EXT_color_buffer_(half_)float). RGBA8 fallback when false. */
  private _floatBuffers = false;
  /** Whether float textures can be LINEAR-filtered (OES_texture_float_linear). */
  private _floatLinear = false;
  /** The track background video element, for channels bound to videoSource:'background'. */
  private _backgroundVideo: HTMLVideoElement | null = null;
  private audioPixels: Uint8Array; // width*height*4 RGBA scratch
  private programs = new Map<string, GuestProgram>();
  private width: number;
  private height: number;
  private _ready = false;
  private _destroyed = false;
  private _contextLost = false;

  private readonly onLost = (e: Event) => {
    e.preventDefault(); // allow restore
    this._contextLost = true;
    this._ready = false;
  };
  private readonly onRestored = () => {
    this._contextLost = false;
    this._blackCube = null;
    this._blackTex2D = null;
    this.initGL();
    // Rebuild every guest program against the fresh context. Channel textures
    // are lost with the context — null them so the next GPUCanvas re-sync
    // re-uploads image/cubemap channels from IndexedDB.
    for (const [, p] of this.programs) {
      p.program = null;
      p.uniforms = {};
      for (const c of p.channels) c.texture = null;
      this.compileInto(p);
      // Buffer passes: FBOs + textures are gone with the context — recreate and
      // recompile so feedback resumes from a clean (opaque-black) state.
      for (const bid of GUEST_BUFFER_IDS) {
        const bp = p.buffers[bid];
        if (!bp) continue;
        bp.program = null;
        bp.uniforms = {};
        bp.textures = [null, null];
        bp.fbos = [null, null];
        for (const c of bp.channels) c.texture = null;
        this.ensureBufferTargets(bp);
        this.compileBufferPass(bp);
      }
    }
  };

  constructor(width = 1920, height = 1080) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.audioPixels = new Uint8Array(GUEST_AUDIO_TEX_WIDTH * GUEST_AUDIO_TEX_HEIGHT * 4);
  }

  get ready(): boolean {
    return this._ready && !this._contextLost;
  }
  get destroyed(): boolean {
    return this._destroyed;
  }

  /** Create the hidden canvas + WebGL2 context. Returns false if WebGL2 is unavailable. */
  init(): boolean {
    if (this._destroyed) return false;
    if (typeof document === 'undefined') return false; // SSR / headless without DOM
    const el = document.createElement('canvas');
    el.width = this.width;
    el.height = this.height;
    el.style.display = 'none';
    document.body.appendChild(el);
    this.canvas = el;
    el.addEventListener('webglcontextlost', this.onLost, false);
    el.addEventListener('webglcontextrestored', this.onRestored, false);
    return this.initGL();
  }

  private initGL(): boolean {
    if (!this.canvas) return false;
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // required: WebGPU copies the canvas after present
    });
    if (!gl) {
      console.error('[GLSLGuestRenderer] WebGL2 not available');
      return false;
    }
    this.gl = gl;
    this.loseCtxExt = gl.getExtension('WEBGL_lose_context');
    // Float color buffers for multipass Buffer A–D (feedback precision). Fall
    // back to RGBA8 when unsupported. half_float is the wider-supported one on
    // WebGL2; color_buffer_float covers full float.
    this._floatBuffers =
      !!gl.getExtension('EXT_color_buffer_half_float') ||
      !!gl.getExtension('EXT_color_buffer_float');
    this._floatLinear =
      !!gl.getExtension('OES_texture_float_linear') ||
      !!gl.getExtension('OES_texture_half_float_linear');
    this.vao = gl.createVertexArray();
    this.audioTex = this.createAudioTexture(gl);
    this._ready = true;
    return true;
  }

  private createAudioTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      GUEST_AUDIO_TEX_WIDTH,
      GUEST_AUDIO_TEX_HEIGHT,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * Register (or update) a guest program by id. Compiles lazily. `channelKinds`
   * gives the sampler type for the Image pass iChannel0..3 (baked into GLSL, so
   * a kind change forces a recompile). `buffers` gives the enabled multipass
   * buffer passes (Buffer A–D), each with its own source + channel kinds. Omit
   * both for the single-audio-channel, single-pass default.
   */
  setGuest(
    id: string,
    source: string,
    channelKinds?: GuestChannelKind[],
    buffers?: Partial<Record<GuestBufferId, { source: string; channelKinds: GuestChannelKind[] }>>,
  ): GLSLCompileResult {
    const kinds: GuestChannelKind[] = [];
    for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
      kinds.push(channelKinds?.[i] ?? 'none');
    }
    const existing = this.programs.get(id);
    const kindsSame =
      existing &&
      existing.compiledKinds.length === kinds.length &&
      existing.compiledKinds.every((k, i) => k === kinds[i]);
    const p: GuestProgram =
      existing ??
      ({
        source,
        program: null,
        uniforms: {},
        frame: 0,
        startTime: performance.now(),
        lastTime: performance.now(),
        channels: Array.from({ length: GUEST_CHANNEL_COUNT }, () => defaultChannelState()),
        compiledKinds: [],
        buffers: {},
      } as GuestProgram);

    // Reconcile the Image pass program.
    let imageResult: GLSLCompileResult = { ok: true, log: '' };
    if (!existing || existing.source !== source || !existing.program || !kindsSame) {
      p.source = source;
      p.program = null;
      p.uniforms = {};
      for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
        if (!p.channels[i]) p.channels[i] = defaultChannelState();
        p.channels[i].kind = kinds[i];
      }
      p.compiledKinds = kinds.slice();
      this.programs.set(id, p);
      imageResult = this.compileInto(p);
    } else {
      for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) p.channels[i].kind = kinds[i];
      this.programs.set(id, p);
    }

    // Reconcile buffer passes (add / update / prune).
    const wanted = buffers ?? {};
    for (const bid of GUEST_BUFFER_IDS) {
      const spec = wanted[bid];
      const cur = p.buffers[bid];
      if (!spec) {
        if (cur) {
          this.destroyBufferPass(cur);
          delete p.buffers[bid];
        }
        continue;
      }
      const bKinds: GuestChannelKind[] = [];
      for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
        bKinds.push(spec.channelKinds?.[i] ?? 'none');
      }
      const bKindsSame =
        cur &&
        cur.compiledKinds.length === bKinds.length &&
        cur.compiledKinds.every((k, i) => k === bKinds[i]);
      if (cur && cur.source === spec.source && cur.program && bKindsSame) {
        for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) cur.channels[i].kind = bKinds[i];
        continue;
      }
      const bp: BufferPassState =
        cur ??
        ({
          source: spec.source,
          program: null,
          uniforms: {},
          channels: Array.from({ length: GUEST_CHANNEL_COUNT }, () => defaultChannelState()),
          compiledKinds: [],
          fbos: [null, null],
          textures: [null, null],
          readIndex: 0,
          width: this.width,
          height: this.height,
        } as BufferPassState);
      bp.source = spec.source;
      bp.program = null;
      bp.uniforms = {};
      for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
        if (!bp.channels[i]) bp.channels[i] = defaultChannelState();
        bp.channels[i].kind = bKinds[i];
      }
      bp.compiledKinds = bKinds.slice();
      this.ensureBufferTargets(bp);
      const r = this.compileBufferPass(bp);
      if (!r.ok)
        imageResult = imageResult.ok
          ? { ok: false, log: `Buffer ${bid.toUpperCase()}: ${r.log}` }
          : imageResult;
      p.buffers[bid] = bp;
    }

    return imageResult;
  }

  /** Set which buffer a channel samples (for kind==='buffer'). Applies to the
   * Image pass channel by default, or a buffer pass channel when `bufferId` names one. */
  setChannelBuffer(
    id: string,
    channel: number,
    srcBuffer: GuestBufferId | null,
    pass?: GuestBufferId,
  ): void {
    const p = this.programs.get(id);
    if (!p || channel < 0 || channel >= GUEST_CHANNEL_COUNT) return;
    const ch = pass ? p.buffers[pass]?.channels[channel] : p.channels[channel];
    if (ch) ch.bufferId = srcBuffer;
  }

  /**
   * Update one channel's per-frame parameters (wrap/filter/intensity/bufferId).
   * `pass` targets a buffer pass's channel; omit for the Image pass. Does not
   * change the sampler kind (use setGuest for that).
   */
  setChannelParams(
    id: string,
    channel: number,
    params: {
      wrap?: 'repeat' | 'clamp';
      filter?: 'linear' | 'nearest' | 'mipmap';
      intensity?: number;
      bufferId?: GuestBufferId | null;
    },
    pass?: GuestBufferId,
  ): void {
    const c = this.channelState(id, channel, pass);
    if (!c) return;
    if (params.wrap !== undefined) c.wrap = params.wrap;
    if (params.filter !== undefined) c.filter = params.filter;
    if (params.intensity !== undefined) c.intensity = params.intensity;
    if (params.bufferId !== undefined) c.bufferId = params.bufferId;
  }

  /** Resolve a channel state for the Image pass (pass omitted) or a buffer pass. */
  private channelState(
    id: string,
    channel: number,
    pass?: GuestBufferId,
  ): GuestChannelState | null {
    const p = this.programs.get(id);
    if (!p || channel < 0 || channel >= GUEST_CHANNEL_COUNT) return null;
    const arr = pass ? p.buffers[pass]?.channels : p.channels;
    return arr?.[channel] ?? null;
  }

  /** Upload a 2D image into a channel's texture (creating it if needed). `pass` targets a buffer pass. */
  setChannelImage2D(id: string, channel: number, bitmap: ImageBitmap, pass?: GuestBufferId): void {
    const gl = this.gl;
    const c = this.channelState(id, channel, pass);
    if (!gl || !this.ready || !c) return;
    if (c.texture && c.kind !== 'image2d') {
      gl.deleteTexture(c.texture);
      c.texture = null;
    }
    let tex = c.kind === 'image2d' ? c.texture : null;
    if (!tex) tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    this.applyTexParams2D(gl, c);
    if (c.filter === 'mipmap') gl.generateMipmap(gl.TEXTURE_2D);
    c.texture = tex;
    c.kind = 'image2d';
    c.resolution = [bitmap.width, bitmap.height];
  }

  /**
   * Upload six cubemap faces into a channel's cubemap texture. `faces` is GL
   * face order (+X,-X,+Y,-Y,+Z,-Z); null faces are uploaded as 1x1 black so the
   * cube is complete and samples cleanly. `pass` targets a buffer pass.
   */
  setChannelCubemap(
    id: string,
    channel: number,
    faces: (ImageBitmap | null)[],
    pass?: GuestBufferId,
  ): void {
    const gl = this.gl;
    const c = this.channelState(id, channel, pass);
    if (!gl || !this.ready || !c) return;
    if (c.texture && c.kind !== 'cubemap') {
      gl.deleteTexture(c.texture);
      c.texture = null;
    }
    let tex = c.kind === 'cubemap' ? c.texture : null;
    if (!tex) tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    const targets = [
      gl.TEXTURE_CUBE_MAP_POSITIVE_X,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
    ];
    let res: [number, number] = [1, 1];
    for (let f = 0; f < 6; f++) {
      const bmp = faces[f];
      if (bmp) {
        gl.texImage2D(targets[f], 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        res = [bmp.width, bmp.height];
      } else {
        gl.texImage2D(
          targets[f],
          0,
          gl.RGBA,
          1,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array([0, 0, 0, 255]),
        );
      }
    }
    const wrap = gl.CLAMP_TO_EDGE; // cubemaps clamp regardless of wrap setting
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, wrap);
    const minF = c.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, minF);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, minF);
    c.texture = tex;
    c.kind = 'cubemap';
    c.resolution = res;
  }

  /** Clear a channel back to `none` (frees its texture). `pass` targets a buffer pass. */
  clearChannel(id: string, channel: number, pass?: GuestBufferId): void {
    const gl = this.gl;
    const c = this.channelState(id, channel, pass);
    if (!c) return;
    if (c.texture && gl) gl.deleteTexture(c.texture);
    c.texture = null;
    c.resolution = [0, 0];
    this.teardownChannelVideo(c);
  }

  /** Set the track background video element used by videoSource:'background' channels. */
  setBackgroundVideo(video: HTMLVideoElement | null): void {
    this._backgroundVideo = video;
  }

  /**
   * Configure a channel as a video source. `source==='background'` binds the
   * shared background video (set via setBackgroundVideo); `source==='upload'`
   * with a blob `url` creates a hidden looping muted <video>. The per-frame
   * texture upload happens in drawPass. `pass` targets a buffer pass.
   */
  setChannelVideo(
    id: string,
    channel: number,
    source: 'upload' | 'background',
    url: string | null,
    pass?: GuestBufferId,
  ): void {
    const c = this.channelState(id, channel, pass);
    if (!c) return;
    c.kind = 'video';
    c.videoSource = source;
    if (source === 'upload') {
      if (url && c.videoUrl !== url) {
        this.teardownChannelVideo(c);
        if (typeof document !== 'undefined') {
          const v = document.createElement('video');
          v.src = url;
          v.loop = true;
          v.muted = true;
          v.playsInline = true;
          v.crossOrigin = 'anonymous';
          v.play().catch(() => {});
          c.videoEl = v;
          c.videoUrl = url;
        }
      }
    } else {
      // background: uses the shared element; drop any per-channel upload element.
      this.teardownChannelVideo(c);
    }
  }

  private teardownChannelVideo(c: GuestChannelState): void {
    if (c.videoEl) {
      try {
        c.videoEl.pause();
        c.videoEl.removeAttribute('src');
        c.videoEl.load();
      } catch {
        /* ignore */
      }
    }
    if (c.videoUrl) {
      try {
        URL.revokeObjectURL(c.videoUrl);
      } catch {
        /* ignore */
      }
    }
    c.videoEl = null;
    c.videoUrl = null;
  }

  /** The video element a channel should sample this frame, or null. */
  private channelVideoEl(c: GuestChannelState): HTMLVideoElement | null {
    if (c.kind !== 'video') return null;
    return c.videoSource === 'background' ? this._backgroundVideo : (c.videoEl ?? null);
  }

  private applyTexParams2D(gl: WebGL2RenderingContext, c: GuestChannelState): void {
    const wrap = c.wrap === 'clamp' ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    const mag = c.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    const min =
      c.filter === 'nearest'
        ? gl.NEAREST
        : c.filter === 'mipmap'
          ? gl.LINEAR_MIPMAP_LINEAR
          : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  }

  /** A 1x1 opaque-black cubemap, lazily created, bound when a cubemap channel
   * has no uploaded texture yet so the samplerCube is never left dangling. */
  private blackCube(gl: WebGL2RenderingContext): WebGLTexture | null {
    if (this._blackCube) return this._blackCube;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    const black = new Uint8Array([0, 0, 0, 255]);
    const faces = [
      gl.TEXTURE_CUBE_MAP_POSITIVE_X,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
    ];
    for (const f of faces) {
      gl.texImage2D(f, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, black);
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this._blackCube = tex;
    return tex;
  }

  /**
   * A cached 1×1 opaque-black 2D texture. Bound to a `none` channel (and used as
   * the placeholder for a not-yet-ready video / missing buffer) so the sampler
   * is never dangling AND `texture(iChannelN, …)` returns vec4(0,0,0,1) — i.e. a
   * `none` channel contributes NOTHING (previously this bound the audio texture,
   * which made a channel set to "None" still feed live FFT into the shader).
   */
  private blackTex2D(gl: WebGL2RenderingContext): WebGLTexture | null {
    if (this._blackTex2D) return this._blackTex2D;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this._blackTex2D = tex;
    return tex;
  }

  /** Remove a guest program and free its GL program + channel textures + buffers. */
  removeGuest(id: string): void {
    const p = this.programs.get(id);
    if (p && this.gl) {
      if (p.program) this.gl.deleteProgram(p.program);
      for (const c of p.channels) {
        if (c.texture) this.gl.deleteTexture(c.texture);
        c.texture = null;
        this.teardownChannelVideo(c);
      }
      for (const bid of GUEST_BUFFER_IDS) {
        const bp = p.buffers[bid];
        if (bp) {
          for (const c of bp.channels) {
            if (c.texture) this.gl.deleteTexture(c.texture);
            this.teardownChannelVideo(c);
          }
          this.destroyBufferPass(bp);
        }
      }
    }
    this.programs.delete(id);
  }

  private compileInto(p: GuestProgram): GLSLCompileResult {
    const gl = this.gl;
    if (!gl) return { ok: false, log: 'no GL context' };
    const built = this.buildProgram(gl, p.source, p.compiledKinds);
    if (!built.program) return { ok: false, log: built.log };
    if (p.program) gl.deleteProgram(p.program);
    p.program = built.program;
    p.uniforms = this.resolveUniforms(gl, built.program);
    return { ok: true, log: '' };
  }

  /** Compile + link a fullscreen program for `source` wrapped with `kinds`. */
  private buildProgram(
    gl: WebGL2RenderingContext,
    source: string,
    kinds: GuestChannelKind[],
  ): { program: WebGLProgram | null; log: string } {
    // S13 safety cap: reject a pathologically large source before it reaches the
    // GL compiler. Applies to the Image pass and every Buffer A–D pass, since
    // both build through here.
    const sizeError = validateGlslSourceSize(source);
    if (sizeError) {
      return { program: null, log: sizeError };
    }
    const vs = this.compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, wrapGuestSource(source, kinds));
    if (!vs.shader || !fs.shader) {
      if (vs.shader) gl.deleteShader(vs.shader);
      if (fs.shader) gl.deleteShader(fs.shader);
      return { program: null, log: [vs.log, fs.log].filter(Boolean).join('\n') };
    }
    const program = gl.createProgram()!;
    gl.attachShader(program, vs.shader);
    gl.attachShader(program, fs.shader);
    gl.linkProgram(program);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? 'link failed';
      gl.deleteProgram(program);
      return { program: null, log };
    }
    return { program, log: '' };
  }

  /** Resolve the shared uniform-location table for a linked guest program. */
  private resolveUniforms(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
  ): Record<string, WebGLUniformLocation | null> {
    const u: Record<string, WebGLUniformLocation | null> = {};
    const names = [
      'iResolution',
      'iTime',
      'iTimeDelta',
      'iFrame',
      'iMouse',
      'iChannel0',
      'iChannel1',
      'iChannel2',
      'iChannel3',
      'uValue1',
      'uValue2',
      'uValue3',
      'uValue4',
      'uValue5',
      'uValue6',
      'uValue7',
      'uValue8',
    ];
    for (const n of names) u[n] = gl.getUniformLocation(program, n);
    for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
      u[`iChannelResolution[${i}]`] = gl.getUniformLocation(program, `iChannelResolution[${i}]`);
      u[`iChannelIntensity[${i}]`] = gl.getUniformLocation(program, `iChannelIntensity[${i}]`);
    }
    return u;
  }

  /** Compile a buffer pass's program (same wrapper as the Image pass). */
  private compileBufferPass(bp: BufferPassState): GLSLCompileResult {
    const gl = this.gl;
    if (!gl) return { ok: false, log: 'no GL context' };
    const built = this.buildProgram(gl, bp.source, bp.compiledKinds);
    if (!built.program) return { ok: false, log: built.log };
    if (bp.program) gl.deleteProgram(bp.program);
    bp.program = built.program;
    bp.uniforms = this.resolveUniforms(gl, built.program);
    return { ok: true, log: '' };
  }

  /** Create or resize a buffer pass's ping-pong FBO+texture pair (RGBA16F, RGBA8 fallback). */
  private ensureBufferTargets(bp: BufferPassState): void {
    const gl = this.gl;
    if (!gl) return;
    if (bp.textures[0] && bp.textures[1] && bp.width === this.width && bp.height === this.height) {
      return;
    }
    this.destroyBufferTargets(bp);
    bp.width = this.width;
    bp.height = this.height;
    const useFloat = this._floatBuffers;
    const internalFormat = useFloat ? gl.RGBA16F : gl.RGBA8;
    const type = useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    // Float textures can only be LINEAR-filtered when the linear ext is present.
    const filter = useFloat && !this._floatLinear ? gl.NEAREST : gl.LINEAR;
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        this.width,
        this.height,
        0,
        gl.RGBA,
        type,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      // Clear to opaque black so the first feedback read is defined, not garbage.
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      bp.textures[i] = tex;
      bp.fbos[i] = fbo;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    bp.readIndex = 0;
  }

  private destroyBufferTargets(bp: BufferPassState): void {
    const gl = this.gl;
    if (!gl) return;
    for (let i = 0; i < 2; i++) {
      if (bp.textures[i]) gl.deleteTexture(bp.textures[i]);
      if (bp.fbos[i]) gl.deleteFramebuffer(bp.fbos[i]);
      bp.textures[i] = null;
      bp.fbos[i] = null;
    }
  }

  private destroyBufferPass(bp: BufferPassState): void {
    const gl = this.gl;
    if (gl && bp.program) gl.deleteProgram(bp.program);
    bp.program = null;
    this.destroyBufferTargets(bp);
  }

  private compileShader(
    gl: WebGL2RenderingContext,
    type: number,
    src: string,
  ): { shader: WebGLShader | null; log: string } {
    const shader = gl.createShader(type);
    if (!shader) return { shader: null, log: 'createShader failed' };
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'compile failed';
      gl.deleteShader(shader);
      return { shader: null, log };
    }
    return { shader, log: '' };
  }

  /**
   * Upload the current-frame audio bytes. `fftBytes`/`waveBytes` are 0-255 (the
   * audioStore fftData / timeDomainData format), downsampled/expanded to 512 wide.
   */
  uploadAudio(fftBytes: Uint8Array | null, waveBytes: Uint8Array | null): void {
    const gl = this.gl;
    if (!gl || !this.audioTex || !this.ready) return;
    const px = this.audioPixels;
    const W = GUEST_AUDIO_TEX_WIDTH;
    // Row 0: FFT magnitudes; Row 1: waveform. Nearest-resample source→512.
    const fill = (row: number, src: Uint8Array | null) => {
      for (let x = 0; x < W; x++) {
        let v = 0;
        if (src && src.length > 0) {
          const si = Math.min(src.length - 1, Math.floor((x / W) * src.length));
          v = src[si];
        }
        const o = (row * W + x) * 4;
        px[o] = v;
        px[o + 1] = v;
        px[o + 2] = v;
        px[o + 3] = 255;
      }
    };
    fill(0, fftBytes);
    fill(1, waveBytes);
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      W,
      GUEST_AUDIO_TEX_HEIGHT,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      px,
    );
  }

  /**
   * Render one guest into the canvas: first every enabled buffer pass (Buffer
   * A–D in order, each to its ping-pong write target), then the Image pass to
   * the canvas. The WebGPU compositor then copies `getCanvas()`. `slotValues`
   * are the Stage-1 uValue1..8.
   */
  render(id: string, dt: number, slotValues: Float32Array | null): void {
    const gl = this.gl;
    const p = this.programs.get(id);
    if (!gl || !this.ready || !p || !p.program) return;

    const now = performance.now();
    p.lastTime = now;
    const iTime = (now - p.startTime) / 1000;

    // ── Buffer passes (A→B→C→D) render to offscreen targets first. ──
    // A buffer channel resolves to the READ (last-frame) texture of the named
    // buffer — including this pass's own buffer, which is the ping-pong feedback
    // case (read last frame while writing this frame). After the draw we swap so
    // the just-written texture becomes next frame's read side.
    for (const bid of GUEST_BUFFER_IDS) {
      const bp = p.buffers[bid];
      if (!bp || !bp.program) continue;
      this.ensureBufferTargets(bp);
      const writeIndex = (bp.readIndex ^ 1) as 0 | 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, bp.fbos[writeIndex]);
      gl.viewport(0, 0, bp.width, bp.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawPass(gl, bp.program, bp.uniforms, bp.channels, p, iTime, dt, slotValues);
      bp.readIndex = writeIndex; // just-written texture is next frame's read side
    }

    // ── Image pass → the canvas. ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    // Opaque black clear (see note: guarantees "nothing to draw" reads as black,
    // not feedback garbage, through the non-premultiplied WebGPU copy).
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawPass(gl, p.program, p.uniforms, p.channels, p, iTime, dt, slotValues);

    // Force GL completion before the WebGPU compositor copies this canvas in the
    // SAME frame (otherwise the copy can grab a stale/unflushed drawing buffer —
    // the "swirl only on play" class of bug).
    gl.flush();
    p.frame++;
  }

  /**
   * Bind channels + set all uniforms for one pass, then draw the fullscreen
   * triangle. `channels` are THIS pass's iChannel bindings; buffer channels
   * resolve against `guest.buffers` read textures.
   */
  private drawPass(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    u: Record<string, WebGLUniformLocation | null>,
    channels: GuestChannelState[],
    guest: GuestProgram,
    iTime: number,
    dt: number,
    slotValues: Float32Array | null,
  ): void {
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);

    if (u.iResolution) gl.uniform3f(u.iResolution, this.width, this.height, 1);
    if (u.iTime) gl.uniform1f(u.iTime, iTime);
    if (u.iTimeDelta) gl.uniform1f(u.iTimeDelta, dt);
    if (u.iFrame) gl.uniform1i(u.iFrame, guest.frame);
    if (u.iMouse) gl.uniform4f(u.iMouse, 0, 0, 0, 0);

    for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
      const c = channels[i];
      const loc = u[`iChannel${i}`];
      gl.activeTexture(gl.TEXTURE0 + i);
      let res: [number, number] = [0, 0];
      if (c.kind === 'cubemap') {
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, c.texture ?? this.blackCube(gl));
        res = c.resolution;
      } else if (c.kind === 'image2d' && c.texture) {
        gl.bindTexture(gl.TEXTURE_2D, c.texture);
        res = c.resolution;
      } else if (c.kind === 'buffer' && c.bufferId) {
        const src = guest.buffers[c.bufferId];
        const tex = src?.textures[src.readIndex] ?? null;
        gl.bindTexture(gl.TEXTURE_2D, tex ?? this.blackTex2D(gl));
        res = tex ? [src!.width, src!.height] : [0, 0];
      } else if (c.kind === 'video') {
        const vid = this.channelVideoEl(c);
        if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
          if (!c.texture) c.texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, c.texture);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
            this.applyTexParams2D(gl, c);
            c.resolution = [vid.videoWidth, vid.videoHeight];
          } catch {
            // A not-yet-decodable frame can throw; keep last frame.
          }
          res = c.resolution;
        } else {
          // No frame yet → black placeholder (not audio).
          gl.bindTexture(gl.TEXTURE_2D, this.blackTex2D(gl));
        }
      } else if (c.kind === 'audio') {
        gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
        res = [GUEST_AUDIO_TEX_WIDTH, GUEST_AUDIO_TEX_HEIGHT];
      } else {
        // none → black placeholder so the sampler is never dangling AND reads
        // as vec4(0): a channel set to "None" contributes nothing (it must NOT
        // leak the audio texture, or "None" would still drive audio reactivity).
        gl.bindTexture(gl.TEXTURE_2D, this.blackTex2D(gl));
      }
      if (loc) gl.uniform1i(loc, i);
      const resLoc = u[`iChannelResolution[${i}]`];
      if (resLoc) gl.uniform3f(resLoc, res[0], res[1], 1);
      const intLoc = u[`iChannelIntensity[${i}]`];
      if (intLoc) gl.uniform1f(intLoc, c.intensity);
    }

    for (let i = 0; i < 8; i++) {
      const loc = u[`uValue${i + 1}`];
      if (loc) gl.uniform1f(loc, slotValues && i < slotValues.length ? slotValues[i] : 0);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Render one guest with an explicit frame index + time (deterministic export). */
  renderAt(
    id: string,
    frame: number,
    timeSec: number,
    dt: number,
    slotValues: Float32Array | null,
  ): void {
    const p = this.programs.get(id);
    if (!p) return;
    p.frame = frame;
    p.startTime = performance.now() - timeSec * 1000;
    this.render(id, dt, slotValues);
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (this.canvas) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  /** Whether any guest program is registered and compiled. */
  hasGuests(): boolean {
    for (const p of this.programs.values()) if (p.program) return true;
    return false;
  }

  destroy(): void {
    this._destroyed = true;
    this._ready = false;
    const gl = this.gl;
    if (gl) {
      for (const p of this.programs.values()) {
        if (p.program) gl.deleteProgram(p.program);
        for (const c of p.channels) {
          if (c.texture) gl.deleteTexture(c.texture);
          this.teardownChannelVideo(c);
        }
        for (const bid of GUEST_BUFFER_IDS) {
          const bp = p.buffers[bid];
          if (bp) {
            for (const c of bp.channels) {
              if (c.texture) gl.deleteTexture(c.texture);
              this.teardownChannelVideo(c);
            }
            this.destroyBufferPass(bp);
          }
        }
      }
      if (this.audioTex) gl.deleteTexture(this.audioTex);
      if (this._blackCube) gl.deleteTexture(this._blackCube);
      if (this.vao) gl.deleteVertexArray(this.vao);
      // Force-lose the context so repeated create/destroy cycles do not exhaust
      // the browser's ~16-context pool (the gap ButterchurnRenderer left open).
      this.loseCtxExt?.loseContext();
    }
    this.programs.clear();
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.onLost);
      this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
      if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    }
    this.gl = null;
    this.canvas = null;
    this.audioTex = null;
    this.vao = null;
  }
}

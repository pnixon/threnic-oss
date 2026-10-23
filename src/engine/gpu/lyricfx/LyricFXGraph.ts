/**
 * LyricFXGraph — the nested Lyric FX render chain (Stage 3, see
 * `docs/lyric-fx-engine-lld.md` §6).
 *
 * Owns a lyric-sized render target and draws the glyph instances (from the
 * Stage-2 GlyphBuffer, packed as a Float32Array) as instanced MSDF quads,
 * applying the active Stage-B *surface* effect's fragment shader. The glyph
 * data survives all the way to the pixel, so every effect can index by
 * `charIndex`, derive its own timing from `charStart/charEnd`, and jitter from
 * `seed`.
 *
 * Stage 3 scope: instanced glyph rendering + a single active surface effect
 * into the lyric target, with `layerBelow` plumbed so refraction can sample the
 * background. Multi-pass stacking (several surface effects) and the Stage-C
 * fullscreen post family (bloom, trails) are layered on later by wrapping a
 * second `RenderGraph` around this target — deliberately not built yet.
 *
 * The vertex stage mirrors `SDFTextRenderer`: a per-glyph quad expanded from
 * the packed instance record. The packed layout MUST match
 * `packGlyphInstances` in `@threnic/lyrics` (24 floats / 96-byte stride).
 */

import { GLYPH_INSTANCE_FLOATS } from '@threnic/lyrics';
import type {
  LyricEffectInstance,
  LyricFXFrameParams,
  LyricFXSurfaceType,
  LyricFXPhase,
  LyricFXType,
  LyricFXGranularity,
} from '@/types/effects/lyric-fx';
import {
  isSurfaceType,
  LYRIC_FX_PHASE_CODE,
  LYRIC_FX_GRANULARITY_CODE,
  phasesOf,
} from '@/types/effects/lyric-fx';
import {
  assembleSurfaceShader,
  LYRIC_FX_UNIFORM_STRUCT,
  LYRIC_FX_PLAIN_SHADER,
  LYRIC_FX_GATED_PLAIN_SHADER,
} from './surface.wgsl';
import {
  assembleTransformSnippet,
  LYRIC_FX_TRANSFORM_TYPES,
  type LyricFXTransformType,
} from './transform.wgsl';
import { assemblePostShader, LYRIC_FX_POST_TYPES, type LyricFXPostType } from './post.wgsl';

/** Uniform buffer: 14 × vec4f = 224 bytes (LU + phase gate + pre/active/post
 * colours + outline (h) + highlightFade/entryPop (k)). */
const LU_FLOATS = 56;
const LU_BYTES = LU_FLOATS * 4;

/** Vertex shader assembler: embeds the shared uniform + a transform snippet,
 * expands each packed glyph instance into a quad, and applies the accumulated
 * per-glyph GTransform (Stage A) about the glyph centre. `transformSnippet`
 * defines `transform_effect(g, base)` (identity when no transform is active). */
export function buildGlyphVertexWGSL(transformSnippet: string): string {
  return /* wgsl */ `
${LYRIC_FX_UNIFORM_STRUCT}

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) localUv: vec2f,
  @location(2) screenUv: vec2f,
  @location(3) glyphColor: vec4f,
  @location(4) charTiming: vec2f,
  @location(5) wordTiming: vec2f,
};

struct Viewport { size: vec2f, _pad: vec2f };
@group(1) @binding(0) var<uniform> viewport: Viewport;

// Packed glyph instances (storage), 24 f32 per instance — see packGlyphInstances.
struct Glyph {
  a: vec4f,  // charIndex, wordIndex, lineIndex, laneIndex
  b: vec4f,  // seed, role, charStart, charEnd
  c: vec4f,  // posX, posY, sizeW, sizeH
  d: vec4f,  // baseline, u0, v0, u1
  e: vec4f,  // v1, r, g, b
  f: vec4f,  // a, entryStart, lineStart, lineEnd
};
@group(1) @binding(1) var<storage, read> glyphs: array<Glyph>;
@group(1) @binding(2) var<uniform> u: LU;

fn rot2gt(a: f32) -> mat2x2f {
  let s = sin(a); let c = cos(a);
  return mat2x2f(c, -s, s, c);
}

${transformSnippet}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let g = glyphs[ii];
  let corner = vec2f(f32((vi & 1u)), f32((vi >> 1u) & 1u)); // 0=TL,1=TR,2=BL,3=BR

  // Base quad position (device px) and the glyph centre for rotate/scale.
  var pos = g.c.xy + corner * g.c.zw;
  let centre = g.c.xy + 0.5 * g.c.zw;

  // Accumulated Stage-A transform, gated to the effect's bound phase so glyphs
  // outside that phase stay at rest (prevents past-phase glyphs from being
  // flung and accumulating into a growing blob), and clamped so no transform
  // can push a glyph unboundedly off-screen.
  let tr = transform_effect(g, gt_identity());
  let ph = u_phaseCode();
  // Moving only during fadeIn(1)/active(2)/fadeOut(3); at rest in upcoming/past.
  let moving = select(0.0, 1.0, ph > 0.5 && ph < 3.5);
  let maxOff = max(viewport.size.x, viewport.size.y);
  let off = clamp(tr.offset * moving, vec2f(-maxOff), vec2f(maxOff));

  // Base entry POP (#1) with neighbor-bounded lead-in (#3): match Canvas2D's
  // default 'pop' in-animation. The entry window is [entryStart, wordStart]
  // where entryStart (g.f.y) is the AnimationController's neighbor-clamped
  // lead-in baked per glyph, so reveal order matches reading order. The glyph
  // scales up with easeBackOut across that window, then holds at 1. Gated by
  // u_entryPop so a plain 'fade' theme keeps scale 1.
  let wStart = g.b.z;
  let eStart = g.f.y;
  let entryWin = max(wStart - eStart, 1e-4);
  let entryP = clamp((u_time() - eStart) / entryWin, 0.0, 1.0);
  let c1 = 1.70158;
  let c3 = c1 + 1.0;
  let inv = entryP - 1.0;
  let backOut = 1.0 + c3 * inv * inv * inv + c1 * inv * inv; // easeBackOut(entryP)
  let popScale = select(1.0, backOut, u_entryPop() > 0.5);

  var local = pos - centre;
  local = rot2gt(tr.rot * moving) * (local * mix(1.0, tr.scale, moving) * popScale);
  pos = centre + local + off;

  let ndc = vec2f(
    (pos.x / viewport.size.x) * 2.0 - 1.0,
    1.0 - (pos.y / viewport.size.y) * 2.0,
  );

  let u0 = g.d.y; let v0 = g.d.z; let u1 = g.d.w; let v1 = g.e.x;
  let atlasUv = vec2f(mix(u0, u1, corner.x), mix(v0, v1, corner.y));

  var out: VSOut;
  out.position = vec4f(ndc, 0.0, 1.0);
  out.uv = atlasUv;
  out.localUv = corner;
  out.screenUv = pos / viewport.size;
  out.glyphColor = vec4f(g.e.y, g.e.z, g.e.w, g.f.x);

  // Granularity-adjusted active window for the lifecycle phase gate.
  //   word (1, default) → the baked word window [charStart, charEnd]
  //   letter (0)        → per-glyph fade-IN stagger ONLY, using the baked
  //                       per-glyph entryStart (neighbor-clamped, in reading
  //                       order). The letter's fade-in completes AT the true
  //                       word start (cs0); its onset ripples earlier by glyph.
  //                       The active start (cs) and the whole active span +
  //                       fade-out stay anchored to the TRUE word window, so
  //                       the word is fully lit across its entire timed span
  //                       [cs0, ce0] and the letter stagger never delays a
  //                       letter's activation nor eats into the timing.
  //   line (2)          → the baked line window, IDENTICAL for every glyph on
  //                       the line, so the line enters and leaves as one unit
  let cs0 = g.b.z;
  let ce0 = g.b.w;
  let gran = u_granularityCode();
  var cs = cs0;
  var ce = ce0;
  if (gran < 0.5) {
    // letter: ripple BOTH the fade-in onset and the fade-out end per glyph so
    // exit mirrors entry (previously only cs moved, so letters faded out all at
    // once while they faded IN one-by-one — the reported asymmetry).
    //
    // Fade-in: pull cs EARLIER, bounded to the neighbor-clamped entryStart, so
    // the per-letter ripple lands entirely BEFORE the word activates. The lead
    // is (cs0 - entryStart), ordered in reading order.
    //
    // Fade-out: push ce LATER by that SAME per-glyph lead, so each letter's
    // fade-out window (ce, ce+fout] opens in the same staggered order. The word
    // stays fully lit across [cs0, ce0]; only the ramps ripple.
    let eStart = g.f.y;
    let lead = max(cs0 - eStart, 0.0);
    cs = cs0 - lead;
    ce = ce0 + lead;
  } else if (gran > 1.5) {
    cs = g.f.z;
    ce = g.f.w;
  }
  out.charTiming = vec2f(cs, ce);
  // The TRUE (unshifted) word window — karaoke colouring keys off this so the
  // active-word highlight stays a single contiguous word regardless of the
  // fade granularity stagger applied to charTiming above.
  out.wordTiming = vec2f(cs0, ce0);
  return out;
}
`;
}

export class LyricFXGraph {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  private atlasView: GPUTextureView;
  private atlasSampler: GPUSampler;
  private linearSampler: GPUSampler;

  private width = 1;
  private height = 1;
  private target: GPUTexture | null = null;
  private targetView: GPUTextureView | null = null;

  private uniformBuffer: GPUBuffer;
  /** Per-pass uniform buffers (one per surface pass) — each pass needs its own
   * phase/params, and a single shared buffer would let the last write win for
   * every pass in the same encoder. Grown on demand, reused across frames. */
  private passUniformBuffers: GPUBuffer[] = [];
  /** Base "plain fill" pipelines keyed by folded transform (or '__none__'). */
  private plainPipelines = new Map<string, GPURenderPipeline>();
  private viewportBuffer: GPUBuffer;
  private glyphBuffer: GPUBuffer | null = null;
  private glyphCount = 0;

  private effects: LyricEffectInstance[] = [];
  /** Enabled surface effect instances, in stack order (each carries its phase/config). */
  private surfaceInstances: LyricEffectInstance<LyricFXSurfaceType>[] = [];
  /** Ordered enabled transform + surface instances — one gated pass each. */
  private renderInstances: LyricEffectInstance[] = [];
  /** All enabled surface effects, in stack order (first is applied — see render). */
  private surfaceStack: LyricFXSurfaceType[] = [];
  /** All enabled post effects, in stack order (Stage C fullscreen passes). */
  private postStack: LyricFXPostType[] = [];
  /** The single active transform (first enabled), or null. */
  private activeTransform: LyricFXTransformType | null = null;
  /** The instance backing the active transform (for its phase/params). */
  private activeTransformInstance: LyricEffectInstance | null = null;
  /** All enabled transform instances — each renders as its own gated pass so
   * different transforms can occupy different phases. */
  private transformInstances: LyricEffectInstance[] = [];
  // Ping-pong pong target + a persistent feedback texture (motion trails).
  private pongTarget: GPUTexture | null = null;
  private pongView: GPUTextureView | null = null;
  private feedbackTarget: GPUTexture | null = null;
  private feedbackView: GPUTextureView | null = null;
  private postUniformBuffer: GPUBuffer | null = null;
  private postBindGroupLayout: GPUBindGroupLayout | null = null;
  private postPipelines = new Map<LyricFXPostType, GPURenderPipeline>();
  // Pipelines keyed by "transform|surface" (vertex module depends on transform).
  private pipelines = new Map<string, GPURenderPipeline>();
  // Transform-effect pass pipelines: vertex = that transform, fragment = gated plain fill.
  private transformPipelines = new Map<LyricFXTransformType, GPURenderPipeline>();
  private surfaceBindGroupLayout: GPUBindGroupLayout;
  private glyphBindGroupLayout: GPUBindGroupLayout;
  private vsModuleCache = new Map<string, GPUShaderModule>();
  private fsModuleCache = new Map<LyricFXSurfaceType, GPUShaderModule>();

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    atlasView: GPUTextureView,
    atlasSampler: GPUSampler,
  ) {
    this.device = device;
    this.format = format;
    this.atlasView = atlasView;
    this.atlasSampler = atlasSampler;

    this.linearSampler = device.createSampler({
      label: 'lyricfx-linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.uniformBuffer = device.createBuffer({
      label: 'lyricfx-uniforms',
      size: LU_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.viewportBuffer = device.createBuffer({
      label: 'lyricfx-viewport',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // group(0): atlas + sampler + uniforms + layerBelow + linearSampler
    this.surfaceBindGroupLayout = device.createBindGroupLayout({
      label: 'lyricfx-surface-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    // group(1): viewport + glyph storage buffer + LU uniform (vertex transform)
    this.glyphBindGroupLayout = device.createBindGroupLayout({
      label: 'lyricfx-glyph-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });

    // Stage C post: src + sampler + uniform + feedback texture.
    this.postUniformBuffer = device.createBuffer({
      label: 'lyricfx-post-uniforms',
      size: LU_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.postBindGroupLayout = device.createBindGroupLayout({
      label: 'lyricfx-post-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
  }

  /** Build/replace the render target. */
  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    if (width === this.width && height === this.height && this.target) return;
    this.width = width;
    this.height = height;
    this.target?.destroy();
    this.target = this.device.createTexture({
      label: 'lyricfx-target',
      size: { width, height },
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this.targetView = this.target.createView();

    const postUsage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC;
    this.pongTarget?.destroy();
    this.pongTarget = this.device.createTexture({
      label: 'lyricfx-pong',
      size: { width, height },
      format: this.format,
      usage: postUsage,
    });
    this.pongView = this.pongTarget.createView();
    this.feedbackTarget?.destroy();
    this.feedbackTarget = this.device.createTexture({
      label: 'lyricfx-feedback',
      size: { width, height },
      format: this.format,
      usage: postUsage | GPUTextureUsage.COPY_DST,
    });
    this.feedbackView = this.feedbackTarget.createView();

    this.device.queue.writeBuffer(this.viewportBuffer, 0, new Float32Array([width, height, 0, 0]));
  }

  /**
   * Upload packed glyph instances (from `packGlyphInstances`). Rebuilds the
   * storage buffer only when the instance count grows; otherwise reuses it.
   */
  setGlyphs(packed: Float32Array): void {
    const count = Math.floor(packed.length / GLYPH_INSTANCE_FLOATS);
    const byteLength = Math.max(GLYPH_INSTANCE_FLOATS * 4, packed.byteLength);
    if (!this.glyphBuffer || this.glyphBuffer.size < byteLength) {
      this.glyphBuffer?.destroy();
      this.glyphBuffer = this.device.createBuffer({
        label: 'lyricfx-glyphs',
        size: byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    if (packed.length > 0) {
      this.device.queue.writeBuffer(
        this.glyphBuffer,
        0,
        packed.buffer,
        packed.byteOffset,
        packed.byteLength,
      );
    }
    this.glyphCount = count;
  }

  /**
   * Set the effect stack. Tracks the active transform (first enabled Stage-A
   * effect) and the ordered list of enabled surface effects. The first surface
   * effect is currently applied; multi-pass stacking is a follow-up.
   */
  setEffects(instances: LyricEffectInstance[]): void {
    this.effects = instances;
    this.surfaceInstances = instances.filter(
      (e) => e.config.enabled && isSurfaceType(e.type),
    ) as LyricEffectInstance<LyricFXSurfaceType>[];
    this.surfaceStack = this.surfaceInstances.map((e) => e.type as LyricFXSurfaceType);
    // Ordered list of enabled transform + surface instances — one gated pass
    // each (post effects are fullscreen passes handled separately).
    this.renderInstances = instances.filter(
      (e) =>
        e.config.enabled &&
        (isSurfaceType(e.type) || (LYRIC_FX_TRANSFORM_TYPES as readonly string[]).includes(e.type)),
    );
    this.postStack = instances
      .filter(
        (e) => e.config.enabled && (LYRIC_FX_POST_TYPES as readonly string[]).includes(e.type),
      )
      .map((e) => e.type as LyricFXPostType);
    const tfm = instances.find(
      (e) => e.config.enabled && (LYRIC_FX_TRANSFORM_TYPES as readonly string[]).includes(e.type),
    );
    const nextTransform = tfm ? (tfm.type as LyricFXTransformType) : null;
    this.activeTransform = nextTransform;
    this.activeTransformInstance = tfm ?? null;
    // ALL enabled transforms, each rendered as its own gated pass so different
    // transforms can occupy different phases (e.g. Vortex fade-in, Card Flip
    // active, Shatter fade-out) instead of only the first-enabled one showing.
    this.transformInstances = instances.filter(
      (e) => e.config.enabled && (LYRIC_FX_TRANSFORM_TYPES as readonly string[]).includes(e.type),
    );
  }

  /** The surface effect currently rendered (first enabled, or 'swell' default). */
  private vsModuleFor(transform: LyricFXTransformType | null): GPUShaderModule {
    const key = transform ?? '__none__';
    let mod = this.vsModuleCache.get(key);
    if (!mod) {
      mod = this.device.createShaderModule({
        label: `lyricfx-vs-${key}`,
        code: buildGlyphVertexWGSL(assembleTransformSnippet(transform)),
      });
      this.vsModuleCache.set(key, mod);
    }
    return mod;
  }

  private fsModuleFor(surface: LyricFXSurfaceType): GPUShaderModule {
    let mod = this.fsModuleCache.get(surface);
    if (!mod) {
      mod = this.device.createShaderModule({
        label: `lyricfx-fs-${surface}`,
        code: assembleSurfaceShader(surface),
      });
      this.fsModuleCache.set(surface, mod);
    }
    return mod;
  }

  private pipelineFor(
    transform: LyricFXTransformType | null,
    surface: LyricFXSurfaceType,
  ): GPURenderPipeline {
    const key = `${transform ?? '__none__'}|${surface}`;
    const existing = this.pipelines.get(key);
    if (existing) return existing;

    const layout = this.device.createPipelineLayout({
      label: `lyricfx-layout-${key}`,
      bindGroupLayouts: [this.surfaceBindGroupLayout, this.glyphBindGroupLayout],
    });

    const pipeline = this.device.createRenderPipeline({
      label: `lyricfx-pipeline-${key}`,
      layout,
      vertex: { module: this.vsModuleFor(transform), entryPoint: 'vs_main' },
      fragment: {
        module: this.fsModuleFor(surface),
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private postPipelineFor(type: LyricFXPostType): GPURenderPipeline {
    const existing = this.postPipelines.get(type);
    if (existing) return existing;
    const shaderModule = this.device.createShaderModule({
      label: `lyricfx-post-${type}`,
      code: assemblePostShader(type),
    });
    const layout = this.device.createPipelineLayout({
      label: `lyricfx-post-layout-${type}`,
      bindGroupLayouts: [this.postBindGroupLayout!],
    });
    const pipeline = this.device.createRenderPipeline({
      label: `lyricfx-post-pipeline-${type}`,
      layout,
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.postPipelines.set(type, pipeline);
    return pipeline;
  }

  private writePostUniforms(frame: LyricFXFrameParams, post: LyricFXPostType): void {
    const u = new Float32Array(LU_FLOATS);
    u[0] = frame.time;
    u[1] = frame.dt;
    u[2] = frame.resolution[0];
    u[3] = frame.resolution[1];
    u[4] = frame.bass;
    u[5] = frame.mid;
    u[6] = frame.high;
    u[7] = frame.energy;
    for (let i = 0; i < 8; i++) u[8 + i] = frame.routedSlots[i] ?? 0;
    const active = this.effects.find((e) => e.config.enabled && e.type === post);
    packPostParams(post, active?.config ?? {}, u, 16);
    this.device.queue.writeBuffer(this.postUniformBuffer!, 0, u);
  }

  /** Write the uniform for a TRANSFORM effect pass: frame + phase gate + params. */
  private writeTransformUniforms(
    frame: LyricFXFrameParams,
    inst: LyricEffectInstance,
    buffer: GPUBuffer,
    phase?: LyricFXPhase,
  ): void {
    const u = new Float32Array(LU_FLOATS);
    u[0] = frame.time;
    u[1] = frame.dt;
    u[2] = frame.resolution[0];
    u[3] = frame.resolution[1];
    u[4] = frame.bass;
    u[5] = frame.mid;
    u[6] = frame.high;
    u[7] = frame.energy;
    for (let i = 0; i < 8; i++) u[8 + i] = frame.routedSlots[i] ?? 0;
    packTransformParams(inst.type as LyricFXTransformType, inst.config, u, 16);
    const boundPhase = phase ?? phasesOf(inst.config, inst.type as LyricFXType)[0];
    const gran = granularityForPhase(boundPhase, inst.config, frame);
    u[32] = LYRIC_FX_PHASE_CODE[boundPhase];
    u[33] = LYRIC_FX_GRANULARITY_CODE[gran];
    u[34] = frame.fadeInDuration ?? 1.0;
    u[35] = frame.fadeOutDuration ?? 1.0;
    writeLyricColors(u, frame);
    // k.w (u[55]) = reverse-on-fade-out flag for this transform.
    u[55] = inst.config.reverseOnFadeOut ? 1 : 0;
    this.device.queue.writeBuffer(buffer, 0, u);
  }

  /**
   * Base-pass uniform: frame + the fade granularity + karaoke colours. g.x
   * carries the TRANSFORM-COVERED-PHASE bitmask (not a phase code): bit P set ⇒
   * a transform pass owns phase P, so the base plain shader discards the resting
   * glyph there (no ghost under the moved copy). Phases with no transform still
   * draw here, keeping the plain fade for words with no transform.
   */
  private writeBaseUniforms(
    frame: LyricFXFrameParams,
    buffer: GPUBuffer,
    coveredPhaseMask = 0,
  ): void {
    const u = new Float32Array(LU_FLOATS);
    u[0] = frame.time;
    u[1] = frame.dt;
    u[2] = frame.resolution[0];
    u[3] = frame.resolution[1];
    u[4] = frame.bass;
    u[5] = frame.mid;
    u[6] = frame.high;
    u[7] = frame.energy;
    for (let i = 0; i < 8; i++) u[8 + i] = frame.routedSlots[i] ?? 0;
    // g.x = transform-covered-phase bitmask (read by current_phase gate).
    u[32] = coveredPhaseMask;
    u[33] = frame.fadeGranularity ?? 1;
    u[34] = frame.fadeInDuration ?? 1.0;
    u[35] = frame.fadeOutDuration ?? 1.0;
    writeLyricColors(u, frame);
    this.device.queue.writeBuffer(buffer, 0, u);
  }

  private writeUniformsFor(
    frame: LyricFXFrameParams,
    surface: LyricFXSurfaceType,
    buffer: GPUBuffer,
    inst?: LyricEffectInstance,
    phase?: LyricFXPhase,
  ): void {
    const u = new Float32Array(LU_FLOATS);
    u[0] = frame.time;
    u[1] = frame.dt;
    u[2] = frame.resolution[0];
    u[3] = frame.resolution[1];
    u[4] = frame.bass;
    u[5] = frame.mid;
    u[6] = frame.high;
    u[7] = frame.energy;
    for (let i = 0; i < 8; i++) u[8 + i] = frame.routedSlots[i] ?? 0;
    const active = inst ?? this.effects.find((e) => e.config.enabled && e.type === surface);
    packEffectParams(surface, active?.config ?? {}, u, 16);
    // Phase-gate vec4 (slot g at float 32): phaseCode, granularityCode, fadeIn, fadeOut.
    // Caller may pass an explicit phase (per-phase pass); else first bound phase.
    const boundPhase =
      phase ?? (active ? phasesOf(active.config, active.type as LyricFXType)[0] : 'active');
    const gran = granularityForPhase(boundPhase, active?.config ?? {}, frame);
    u[32] = LYRIC_FX_PHASE_CODE[boundPhase];
    u[33] = LYRIC_FX_GRANULARITY_CODE[gran];
    u[34] = frame.fadeInDuration ?? 1.0;
    u[35] = frame.fadeOutDuration ?? 1.0;
    writeLyricColors(u, frame);
    this.device.queue.writeBuffer(buffer, 0, u);
  }

  /** A dedicated uniform buffer for surface pass `index` (grown on demand). */
  private passUniform(index: number): GPUBuffer {
    let buf = this.passUniformBuffers[index];
    if (!buf) {
      buf = this.device.createBuffer({
        label: `lyricfx-uniforms-pass-${index}`,
        size: LU_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.passUniformBuffers[index] = buf;
    }
    return buf;
  }

  /** The ungated base "plain fill" pipeline (glyph fill under phase-gated effects). */
  /**
   * The base "plain fill" pass — draws each glyph with the lyric fade envelope
   * + karaoke colour, and applies the given transform (so a moved glyph doesn't
   * leave a static ghost underneath). Keyed per folded transform.
   */
  private plainPipelineFor(transform: LyricFXTransformType | null): GPURenderPipeline {
    const key = transform ?? '__none__';
    const existing = this.plainPipelines.get(key);
    if (existing) return existing;
    const shaderModule = this.device.createShaderModule({
      label: `lyricfx-plain-${key}`,
      code: LYRIC_FX_PLAIN_SHADER,
    });
    const layout = this.device.createPipelineLayout({
      label: `lyricfx-plain-layout-${key}`,
      bindGroupLayouts: [this.surfaceBindGroupLayout, this.glyphBindGroupLayout],
    });
    const pipeline = this.device.createRenderPipeline({
      label: `lyricfx-plain-pipeline-${key}`,
      layout,
      vertex: { module: this.vsModuleFor(transform), entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    this.plainPipelines.set(key, pipeline);
    return pipeline;
  }

  /** A transform-effect pass: its transform in the vertex, gated plain fill fragment. */
  private transformPipelineFor(transform: LyricFXTransformType): GPURenderPipeline {
    const existing = this.transformPipelines.get(transform);
    if (existing) return existing;
    const shaderModule = this.device.createShaderModule({
      label: `lyricfx-gated-plain-${transform}`,
      code: LYRIC_FX_GATED_PLAIN_SHADER,
    });
    const layout = this.device.createPipelineLayout({
      label: `lyricfx-transform-layout-${transform}`,
      bindGroupLayouts: [this.surfaceBindGroupLayout, this.glyphBindGroupLayout],
    });
    const pipeline = this.device.createRenderPipeline({
      label: `lyricfx-transform-pipeline-${transform}`,
      layout,
      vertex: { module: this.vsModuleFor(transform), entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    this.transformPipelines.set(transform, pipeline);
    return pipeline;
  }

  /**
   * Render the glyph chain into the lyric target and return its view.
   * `layerBelow` enables refraction; pass the target itself if unused.
   *
   * Multi-effect surface stacking: each enabled surface effect renders the
   * glyphs into the SAME target — the first clears, each subsequent one
   * loads + alpha-composites on top, with its own params written per pass.
   * (Stage-B effects read the MSDF field per glyph, so they compose by
   * re-rendering the glyph layer per effect rather than ping-ponging a raster.)
   */
  render(
    encoder: GPUCommandEncoder,
    frame: LyricFXFrameParams,
    layerBelow: GPUTextureView | null,
  ): GPUTextureView | null {
    if (!this.targetView || !this.glyphBuffer || this.glyphCount === 0) return this.targetView;

    // `layerBelow` (refraction source) MUST be a sampleable view. Callers pass
    // the bindable background intermediate; when absent, fall back to the pong
    // target (bindable, and NOT the surface pass's render target — avoids a
    // read==write hazard if refraction samples it). pong is cleared/unused here.
    const belowView = layerBelow ?? this.pongView ?? this.targetView;

    // Surface passes: a base "plain fill" pass (clears, no phase gate) then one
    // phase-gated pass per enabled surface effect (load + composite). Each pass
    // gets its OWN uniform buffer so its phase/params survive to draw time —
    // a shared buffer would let the last write win for every pass in the encoder.
    const drawPass = (
      index: number,
      pipeline: GPURenderPipeline,
      uniform: GPUBuffer,
      clear: boolean,
    ) => {
      const glyphBind = this.device.createBindGroup({
        label: `lyricfx-glyph-bind-${index}`,
        layout: this.glyphBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.viewportBuffer } },
          { binding: 1, resource: { buffer: this.glyphBuffer! } },
          { binding: 2, resource: { buffer: uniform } },
        ],
      });
      const surfaceBind = this.device.createBindGroup({
        label: `lyricfx-surface-bind-${index}`,
        layout: this.surfaceBindGroupLayout,
        entries: [
          { binding: 0, resource: this.atlasView },
          { binding: 1, resource: this.atlasSampler },
          { binding: 2, resource: { buffer: uniform } },
          { binding: 3, resource: belowView },
          { binding: 4, resource: this.linearSampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: `lyricfx-pass-${index}`,
        colorAttachments: [
          {
            view: this.targetView!,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: clear ? 'clear' : 'load',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, surfaceBind);
      pass.setBindGroup(1, glyphBind);
      pass.draw(4, this.glyphCount);
      pass.end();
    };

    // Base pass: the RESTING glyph, faded by the lyric envelope and coloured by
    // karaoke state — the stable text layer. It DISCARDS glyphs in any phase a
    // transform owns (the covered-phase mask), so the moved copy from the
    // transform pass has no static ghost behind it. Phases with no transform
    // still draw here, so plain words keep their fade.
    let coveredPhaseMask = 0;
    for (const inst of this.transformInstances) {
      for (const ph of phasesOf(inst.config, inst.type as LyricFXType)) {
        coveredPhaseMask |= 1 << LYRIC_FX_PHASE_CODE[ph];
      }
    }
    const baseUniform = this.passUniform(0);
    this.writeBaseUniforms(frame, baseUniform, coveredPhaseMask);
    drawPass(0, this.plainPipelineFor(null), baseUniform, true);

    let passIdx = 1;

    // One gated transform pass per enabled transform, per bound phase. Each uses
    // that transform's own vertex module (its motion) with the gated-plain
    // fragment, so the moved glyph is drawn only while it is in the bound phase.
    for (const inst of this.transformInstances) {
      const type = inst.type as LyricFXTransformType;
      const phases = phasesOf(inst.config, inst.type as LyricFXType);
      for (const ph of phases) {
        const uniform = this.passUniform(passIdx);
        this.writeTransformUniforms(frame, inst, uniform, ph);
        drawPass(passIdx, this.transformPipelineFor(type), uniform, false);
        passIdx++;
      }
    }

    // One phase-gated pass per enabled SURFACE effect PER bound phase, each with
    // its own uniform carrying its phase/params. A surface effect bound to
    // several phases fires in each.
    for (const inst of this.surfaceInstances) {
      const phases = phasesOf(inst.config, inst.type as LyricFXType);
      for (const ph of phases) {
        const uniform = this.passUniform(passIdx);
        this.writeUniformsFor(frame, inst.type as LyricFXSurfaceType, uniform, inst, ph);
        drawPass(passIdx, this.pipelineFor(null, inst.type as LyricFXSurfaceType), uniform, false);
        passIdx++;
      }
    }

    // ── Stage C: fullscreen post passes, ping-ponging target ↔ pong ──
    let srcView = this.targetView;
    let dstTex = this.pongTarget;
    let dstView = this.pongView;
    let srcTex = this.target;
    for (let i = 0; i < this.postStack.length; i++) {
      const post = this.postStack[i];
      if (!dstView || !this.postBindGroupLayout || !this.feedbackView) break;
      this.writePostUniforms(frame, post);
      const pipeline = this.postPipelineFor(post);
      const bind = this.device.createBindGroup({
        label: `lyricfx-post-bind-${i}`,
        layout: this.postBindGroupLayout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.linearSampler },
          { binding: 2, resource: { buffer: this.postUniformBuffer! } },
          { binding: 3, resource: this.feedbackView },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: `lyricfx-post-pass-${i}`,
        colorAttachments: [
          {
            view: dstView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();

      // Swap: dst becomes the new src for the next post pass.
      [srcView, dstView] = [dstView, srcView];
      [srcTex, dstTex] = [dstTex, srcTex];
    }

    // Persist the final raster into the feedback texture for motion trails.
    if (this.postStack.includes('motionTrails') && srcTex && this.feedbackTarget) {
      encoder.copyTextureToTexture(
        { texture: srcTex },
        { texture: this.feedbackTarget },
        { width: this.width, height: this.height },
      );
    }

    return srcView;
  }

  destroy(): void {
    this.target?.destroy();
    this.glyphBuffer?.destroy();
    this.uniformBuffer.destroy();
    for (const b of this.passUniformBuffers) b.destroy();
    this.passUniformBuffers = [];
    this.viewportBuffer.destroy();
    this.pongTarget?.destroy();
    this.feedbackTarget?.destroy();
    this.postUniformBuffer?.destroy();
    this.target = null;
    this.targetView = null;
    this.glyphBuffer = null;
    this.pongTarget = null;
    this.pongView = null;
    this.feedbackTarget = null;
    this.feedbackView = null;
  }
}

/**
 * Resolve the granularity code for a pass. Granularity is a SINGLE fade-timing
 * property (`frame.fadeGranularity`, set on fade-in/fade-out in the Lyric FX
 * panel) and governs EVERY phase and every pass — base cover-mask, transform,
 * and surface — so they all resolve the same [cs,ce] window and agree on which
 * glyphs are covered. `phase`/`config` are retained for signature stability but
 * no longer branch the result (the per-effect granularity control was removed).
 */
export function granularityForPhase(
  phase: LyricFXPhase,
  config: Record<string, unknown>,
  frame: LyricFXFrameParams,
): LyricFXGranularity {
  // Granularity is a SINGLE fade-timing property (set on fade-in/fade-out in the
  // Lyric FX panel) that governs EVERY phase — there is no longer a per-effect
  // granularity control. Every pass (base cover-mask + all transform/surface
  // passes, all phases) must resolve the SAME window, or they disagree: at line
  // granularity the base discards the whole line (line window) while an
  // active-phase transform reading config.granularity='word' would draw back
  // only the active word, making the other words on the line vanish.
  void config;
  const code = frame.fadeGranularity ?? 1;
  return code === 0 ? 'letter' : code === 2 ? 'line' : 'word';
}

/**
 * Write the pre/active/post word colours into the uniform (floats 36..47:
 * cPre, cActive, cPost). Defaults to white when the frame omits them.
 */
function writeLyricColors(u: Float32Array, frame: LyricFXFrameParams): void {
  const pre = frame.colorPre ?? [1, 1, 1, 1];
  const act = frame.colorActive ?? [1, 1, 1, 1];
  const post = frame.colorPost ?? [1, 1, 1, 1];
  for (let i = 0; i < 4; i++) u[36 + i] = pre[i] ?? 1;
  for (let i = 0; i < 4; i++) u[40 + i] = act[i] ?? 1;
  for (let i = 0; i < 4; i++) u[44 + i] = post[i] ?? 1;
  // h (48..51): outline rgb + width (field units). Width 0 = no outline.
  const outline = frame.outlineColor ?? [0, 0, 0];
  u[48] = outline[0] ?? 0;
  u[49] = outline[1] ?? 0;
  u[50] = outline[2] ?? 0;
  u[51] = frame.outlineWidth ?? 0;
  // k (52..55): highlightFadeIn, highlightFadeOut, entryPop flag, pad.
  u[52] = frame.highlightFadeIn ?? 0.0001;
  u[53] = frame.highlightFadeOut ?? 0.0001;
  u[54] = frame.entryPop ? 1 : 0;
  u[55] = 0;
}

/**
 * Pack a transform effect's config into the uniform's p0 slot (u[base..]).
 * Mirrors the p0.x/y/z the transform bodies read. Pure/testable.
 */
export function packTransformParams(
  type: LyricFXTransformType,
  config: Record<string, unknown>,
  out: Float32Array,
  base: number,
): void {
  const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
  const param = (v: unknown, d = 0): number =>
    v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)
      ? num((v as { value: unknown }).value, d)
      : num(v, d);
  switch (type) {
    case 'shatter':
      out[base] = param(config.strength, 1);
      out[base + 1] = num(config.gravity, 1);
      break;
    case 'kineticWave':
      out[base] = param(config.amplitude, 8);
      out[base + 1] = num(config.wavelength, 0.6);
      out[base + 2] = num(config.speed, 4);
      break;
    case 'scatterAssemble':
      out[base] = param(config.spread, 120);
      break;
    case 'springSettle':
      out[base] = param(config.amplitude, 40);
      out[base + 1] = num(config.stiffness, 3);
      out[base + 2] = num(config.stagger, 0.03);
      break;
    case 'vortex':
      out[base] = param(config.radius, 120);
      out[base + 1] = num(config.turns, 1.5);
      break;
    case 'impactTypewriter':
      out[base] = param(config.recoil, 12);
      break;
    case 'glyphJitter':
      out[base] = param(config.amount, 6);
      break;
    case 'cardFlip':
      out[base] = param(config.speed, 3);
      break;
  }
}

/** Pack a post effect's config into the uniform's p0..p3 slots. Pure/testable. */
export function packPostParams(
  type: LyricFXPostType,
  config: Record<string, unknown>,
  out: Float32Array,
  base: number,
): void {
  const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
  const param = (v: unknown, d = 0): number =>
    v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)
      ? num((v as { value: unknown }).value, d)
      : num(v, d);
  switch (type) {
    case 'textBloom':
      out[base] = num(config.threshold, 0.3);
      out[base + 1] = param(config.intensity, 1);
      break;
    case 'motionTrails':
      out[base] = num(config.decay, 0.85);
      break;
    case 'displace':
      out[base] = param(config.amount, 0.02);
      out[base + 1] = num(config.scale, 6);
      break;
    case 'lightRays':
      out[base] = param(config.intensity, 0.5);
      out[base + 1] = num(config.decay, 0.96);
      break;
  }
}

/**
 * Pack the active effect's config into the uniform's p0..p3 slots (u[base..]).
 * Kept pure and exported for unit testing.
 */
export function packEffectParams(
  type: LyricFXSurfaceType,
  config: Record<string, unknown>,
  out: Float32Array,
  base: number,
): void {
  const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
  const param = (v: unknown, d = 0): number => {
    if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
      return num((v as { value: unknown }).value, d);
    }
    return num(v, d);
  };
  const rgb = (v: unknown): [number, number, number] =>
    Array.isArray(v) && v.length >= 3 ? [num(v[0]), num(v[1]), num(v[2])] : [1, 1, 1];
  const deg2rad = (d: number) => (d * Math.PI) / 180;

  // p0 = out[base..base+3], p1 = base+4.., p2 = base+8.., p3 = base+12..
  switch (type) {
    case 'swell':
      out[base] = param(config.amount, 0.15);
      out[base + 1] = num(config.softness, 0.05);
      break;
    case 'melt':
      out[base] = param(config.amount, 0.3);
      out[base + 1] = num(config.noiseScale, 6);
      break;
    case 'dissolve': {
      out[base] = param(config.progress, 0);
      out[base + 1] = num(config.edgeWidth, 0.08);
      const c = rgb(config.edgeColor);
      out[base + 4] = c[0];
      out[base + 5] = c[1];
      out[base + 6] = c[2];
      break;
    }
    case 'gradientFill': {
      out[base] = param(config.offset, 0);
      out[base + 2] = deg2rad(num(config.angleDeg, 0));
      const a = Array.isArray(config.colorA) ? config.colorA : [1, 1, 1, 1];
      const b = Array.isArray(config.colorB) ? config.colorB : [1, 1, 1, 1];
      for (let i = 0; i < 4; i++) out[base + 4 + i] = num(a[i], 1);
      for (let i = 0; i < 4; i++) out[base + 8 + i] = num(b[i], 1);
      break;
    }
    case 'chromaticSplit':
      out[base] = param(config.amount, 0.01);
      out[base + 1] = deg2rad(num(config.angleDeg, 0));
      break;
    case 'marchingOutline': {
      out[base] = num(config.width, 0.06);
      out[base + 1] = num(config.dash, 0);
      out[base + 2] = param(config.phase, 0);
      const c = Array.isArray(config.color) ? config.color : [1, 1, 1, 1];
      for (let i = 0; i < 4; i++) out[base + 4 + i] = num(c[i], 1);
      break;
    }
    case 'bevel':
      out[base] = deg2rad(param(config.lightAngleDeg, 45));
      out[base + 1] = num(config.strength, 0.5);
      break;
    case 'neonCore': {
      out[base] = num(config.coreWidth, 0.05);
      out[base + 1] = param(config.haloWidth, 0.2);
      const core = rgb(config.coreColor);
      const halo = rgb(config.haloColor);
      out[base + 4] = core[0];
      out[base + 5] = core[1];
      out[base + 6] = core[2];
      out[base + 8] = halo[0];
      out[base + 9] = halo[1];
      out[base + 10] = halo[2];
      break;
    }
    case 'refraction':
      out[base] = param(config.strength, 0.05);
      out[base + 1] = num(config.edgeFalloff, 2);
      break;
  }
}

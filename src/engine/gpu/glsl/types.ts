/**
 * GLSL Guest Layer — shared contract (Stage 3a, vertical slice)
 *
 * A "guest" is a foreign renderer that draws into its own canvas each frame; the
 * host WebGPU renderer copies that canvas into a GPUTexture and composites it at
 * a chosen layer position. Butterchurn (WebGL2) and the game scene (Canvas2D)
 * are the two shipped guests; a GLSL guest layer is a third of the same
 * shape. This module is the TYPE + CONSTANT contract shared by the glsl/
 * subsystem and BOTH renderers (preview + export) so they cannot drift.
 *
 * Vertical slice scope: single-pass fragment shaders only. Multipass Buffer A–D
 * chains, cubemaps, video channels, and the background channel are deferred.
 */

/** GLSL-guest audio texture: row 0 = FFT magnitudes, row 1 = waveform. */
export const GUEST_AUDIO_TEX_WIDTH = 512;
export const GUEST_AUDIO_TEX_HEIGHT = 2;

/** How a guest layer's texture is blended over the target beneath it. */
export type GuestBlendMode = 'alpha' | 'additive' | 'screen' | 'multiply' | 'replace';

/**
 * Parameters for compositing one guest texture over the current target. Shared
 * by the generalized guest-composite pass in both renderers.
 */
export interface GuestCompositeParams {
  /** 0..1 layer opacity, multiplied into the source alpha. */
  opacity: number;
  /** Blend mode selecting the GPU blend state. */
  blendMode: GuestBlendMode;
  /**
   * When true the guest's own per-pixel alpha is honored (multiplied by
   * opacity); when false the guest is treated as fully opaque and only `opacity`
   * gates it (butterchurn's historical behavior). Generative guests are opaque
   * (their Image pass returns rgb), so default false.
   */
  preserveAlpha: boolean;
}

/**
 * Number of input channels a guest exposes (iChannel0..3) — the fixed
 * four-channel count of the GLSL guest ABI.
 */
export const GUEST_CHANNEL_COUNT = 4;

/** What a single iChannelN slot is bound to. */
export type GuestChannelKind = 'none' | 'audio' | 'image2d' | 'cubemap' | 'buffer' | 'video';

/** Where a `video` channel sources its frames. */
type GuestVideoSource = 'upload' | 'background';

/** Which multipass buffer a channel samples (Buffer A–D). */
export type GuestBufferId = 'a' | 'b' | 'c' | 'd';

/** The four multipass buffer ids, in render order. */
export const GUEST_BUFFER_IDS: GuestBufferId[] = ['a', 'b', 'c', 'd'];

/** Texture wrap mode for an image/cubemap channel (repeat | clamp). */
type GuestChannelWrap = 'repeat' | 'clamp';

/** Texture filter for an image/cubemap channel (linear | nearest | mipmap). */
type GuestChannelFilter = 'linear' | 'nearest' | 'mipmap';

/**
 * One iChannelN input binding. `audio` binds the shared 512x2 audio texture;
 * `image2d`/`cubemap` bind a customer-uploaded asset stored LOCALLY in
 * IndexedDB (never uploaded — customer assets stay on the customer's
 * machine). `assetId` is the IndexedDB key discriminator (the channel index,
 * and per-face for cubemaps); the blob itself lives under
 * `glslGuest.<guestId>.<assetId>`.
 *
 * `intensity` is a 0..1 scalar exposed to the shader as `iChannelIntensity[N]`
 * so a shader author can multiply it into their sample; when `intensityReactive`
 * is enabled it is driven per frame by the audio-reactive envelope (same
 * AudioReactiveConfig system as opacity). It does NOT force intensity onto an
 * arbitrary shader's texture reads — the author opts in by using the uniform.
 */
export interface GuestChannel {
  kind: GuestChannelKind;
  /** IndexedDB asset discriminator for image2d/cubemap; undefined for none/audio. */
  assetId?: string;
  /** Which buffer this channel samples when kind==='buffer' (Buffer A–D). */
  bufferId?: GuestBufferId;
  /** Where a `video` channel sources frames: an uploaded file (local) or the track background video. */
  videoSource?: GuestVideoSource;
  wrap: GuestChannelWrap;
  filter: GuestChannelFilter;
  /** Flip the image vertically on upload (the GLSL-guest default is flipped). */
  vflip: boolean;
  /** 0..1 scalar exposed as iChannelIntensity[N]; base value when reactive off. */
  intensity: number;
  /** When set + enabled, drives `intensity` from an audio band per frame. */
  intensityReactive?: import('@/types/effects/audio-reactive').AudioReactiveConfig;
}

export const DEFAULT_GUEST_CHANNEL: GuestChannel = {
  kind: 'none',
  wrap: 'repeat',
  filter: 'linear',
  vflip: false,
  intensity: 1,
};

/**
 * One multipass buffer pass (Buffer A–D). Renders its `source`
 * (a `mainImage` body) to an offscreen RGBA16F texture; its `channels` bind
 * iChannel0..3 for THIS pass (including sampling another buffer, or itself for
 * ping-pong feedback). Buffers render in order a→b→c→d before the Image pass.
 */
export interface GuestBufferPass {
  source: string;
  channels: GuestChannel[];
}

/** A single-pass GLSL guest layer's source + config. */
export interface GLSLGuestSource {
  /** Stable id (the shaderFx instance id). */
  id: string;
  /** GLSL ES 3.0 fragment body implementing `mainImage(out vec4, in vec2)` (Image pass). */
  source: string;
  /** Composite settings for this layer. */
  composite: GuestCompositeParams;
  /**
   * iChannel0..3 bindings for the IMAGE pass, index-aligned to iChannelN. When
   * absent (older projects), the renderer treats every channel as `audio` on
   * iChannel0 for backward compatibility with the vertical-slice guest.
   */
  channels?: GuestChannel[];
  /**
   * Multipass buffer passes (Buffer A–D). Only enabled buffers are
   * present. Each renders to its own RGBA16F double-buffered target and can be
   * sampled by any pass (including the Image pass) via a `kind:'buffer'` channel.
   */
  buffers?: Partial<Record<GuestBufferId, GuestBufferPass>>;
  /**
   * When set + enabled, drives the composite opacity from an audio band per
   * frame via the shared AudioReactiveConfig envelope (live + export symmetric).
   * `composite.opacity` is the base value.
   */
  opacityReactive?: import('@/types/effects/audio-reactive').AudioReactiveConfig;
  /**
   * Per-guest audio routing table: maps analyser sources (bands / beat / custom
   * Hz windows) to the eight uValue1..8 slots the shader reads, each through its
   * own attack/decay envelope. Absent/undefined → all slots resolve to 0. Same
   * table shape the shaderFx overlay uses, resolved per-guest by its own driver.
   */
  audioRouting?: import('@/types/effects/audio-routing').AudioRoutingTable;
}

/** Result of compiling a guest's GLSL program. */
export interface GLSLCompileResult {
  ok: boolean;
  /** Compiler log lines (errors + warnings), empty when ok. */
  log: string;
}

/**
 * Maximum accepted GLSL guest source size, in bytes (S13 safety cap). Mirrors
 * the WGSL cap (`MAX_WGSL_SOURCE_BYTES`, 64 KiB): far above any hand- or
 * template-authored fragment body, so anything larger is paste garbage or an
 * attempt to wedge the compiler / bloat a shared `.thren` project. Enforced at
 * the single compile choke point in the GLSL guest renderer and applied per
 * pass (Image + each Buffer A–D pass).
 */
const MAX_GLSL_SOURCE_BYTES = 64 * 1024;

/**
 * Pure size guard for a single GLSL guest source string. Returns an error
 * message when the source exceeds `MAX_GLSL_SOURCE_BYTES`, else null. Kept in
 * the shared contract module so both renderers (and tests) enforce the same
 * limit without importing the WebGL renderer.
 */
export function validateGlslSourceSize(source: string): string | null {
  const bytes = source.length;
  if (bytes > MAX_GLSL_SOURCE_BYTES) {
    return `GLSL shader source is too large (${bytes} bytes; limit ${MAX_GLSL_SOURCE_BYTES}). Trim the source.`;
  }
  return null;
}

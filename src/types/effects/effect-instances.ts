/**
 * Instanced Effects System
 *
 * Each "effect" the user adds is an EffectInstance with a unique id,
 * a type string, and a typed config blob.  Multiple instances of the
 * same type are fully independent.
 */

import type { AudioReactiveConfig } from './audio-reactive';
import type { ParticlesConfig, RainConfig } from './particles';
import type { VisualizerConfig } from './visualizer';
import type { MilkdropConfig } from './milkdrop';
import type { ShaderOverlayConfig } from './shader-overlay';
import type { ButterchurnConfig } from './butterchurn';
import type { LittleJSSceneConfig } from '@/engine/gpu/littlejs/types';

import type { PostProcessingConfig } from './post-processing';

/**
 * GLSL guest layer config (Stage 3a). A GLSL-compatible single-pass
 * fragment shader hosted in a shared WebGL2 context and composited over the
 * layer beneath it. `source` is the GLSL ES 3.00 `mainImage(...)` body.
 */
export type GLSLGuestConfig = {
  enabled: boolean;
  source: string;
  opacity: number;
  blendMode: 'alpha' | 'additive' | 'screen' | 'multiply' | 'replace';
  /**
   * iChannel0..3 bindings (GLSL-guest ABI). Optional for backward compat
   * with pre-multichannel projects — absent means "iChannel0 = audio, rest
   * none". Each channel binds none/audio/image2d/cubemap; image/cubemap assets
   * live LOCALLY in IndexedDB (customer assets stay local).
   */
  channels?: import('@/engine/gpu/glsl/types').GuestChannel[];
  /**
   * Multipass buffer passes (Buffer A–D). Only enabled buffers are
   * present; each has its own mainImage source + 4 iChannel bindings and renders
   * to an RGBA16F double-buffered target before the Image pass.
   */
  buffers?: Partial<
    Record<
      import('@/engine/gpu/glsl/types').GuestBufferId,
      import('@/engine/gpu/glsl/types').GuestBufferPass
    >
  >;
  /**
   * Per-parameter audio-reactive configs (same widget system as other effects).
   * `opacity` drives the layer composite opacity from an audio band.
   */
  audioReactive?: {
    opacity?: AudioReactiveConfig;
  };
  /**
   * Per-guest audio routing table: maps analyser sources to the eight
   * uValue1..8 slots the guest shader reads. Absent → all slots resolve to 0.
   */
  audioRouting?: import('@/types/effects/audio-routing').AudioRoutingTable;
};

/**
 * Default GLSL guest: a small audio-reactive GLSL body so a fresh 'glsl'
 * instance renders something immediately. `iChannel0` row 0 is the FFT, so this
 * pulses with the low end. Users replace the body via the GLSL source editor.
 */
export const DEFAULT_GLSL_GUEST_CONFIG: GLSLGuestConfig = {
  enabled: true,
  opacity: 1,
  blendMode: 'alpha',
  source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
  fragColor = vec4(col, 1.0);
}`,
  // All iChannel0..3 default to 'none' (unbound → reads vec4(0), no effect). The
  // default body is self-contained and NOT audio-reactive out of the box; bind
  // iChannel0 = Audio (or route a uValue slot) to opt into reactivity. Image /
  // cubemap channels are bound + uploaded (to local IndexedDB) via the editor.
  channels: [
    { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
    { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
    { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
    { kind: 'none', wrap: 'repeat', filter: 'linear', vflip: false, intensity: 1 },
  ],
};

/**
 * Shader FX instance config — unified shader overlay + feedback chain + Butterchurn + LittleJS.
 * mode 'shader' = WGSL fragment shader (ShaderOverlayConfig)
 * mode 'feedback' = feedback-chain visualizer (MilkdropConfig)
 * mode 'butterchurn' = Butterchurn WebGL Milkdrop emulator (ButterchurnConfig)
 * mode 'littlejs' = LittleJS 2D game engine scenes (LittleJSSceneConfig)
 * mode 'glsl' = GLSL-compatible WebGL2 guest layer (GLSLGuestConfig)
 */
export type ShaderFxInstanceConfig = {
  enabled: boolean;
  mode: 'shader' | 'feedback' | 'butterchurn' | 'littlejs' | 'glsl';
  shader: ShaderOverlayConfig;
  feedback: MilkdropConfig;
  butterchurn: ButterchurnConfig;
  littlejs: LittleJSSceneConfig;
  /** GLSL guest layer (Stage 3a). Optional — absent on pre-3a projects. */
  glsl?: GLSLGuestConfig;
};

// ─────────────────────────────────────────────
// Effect type identifiers
// ─────────────────────────────────────────────

/** Scene (3-D) effect types */
export type SceneEffectType =
  | 'particles'
  | 'rain'
  | 'visualizer'
  | 'starfield'
  | 'shaderFx'
  | 'butterchurn';

/** Post-processing (2-D) effect types */
export type PostProcessingEffectType =
  | 'bloom'
  | 'chromaticAberration'
  | 'glitch'
  | 'vhsTracking'
  | 'oldFilm'
  | 'bulbFlicker'
  | 'gateJitter'
  | 'sepia'
  | 'distortion'
  | 'zoom'
  | 'tiling'
  | 'pixelation'
  | 'noiseOverlay'
  | 'slide'
  | 'rotate'
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'hueShift'
  | 'chainLightning'
  | 'lut'
  | 'motionBlur'
  | 'lensFlare'
  | 'cameraShake'
  | 'bgOpacity'
  | 'bgBlur'
  | 'bgImageOverlay'
  | 'customShader';

export type EffectType = SceneEffectType | PostProcessingEffectType;

/**
 * Custom user WGSL shader (LLD §5, "transform half"). A post-processing pass
 * whose fragment shader SAMPLES the layer beneath it (inputTexture /
 * inputSampler at bindings 0/1, its uniform buffer at binding 2) and returns a
 * transformed colour — NOT a generative overlay and NOT a shaderFx scene mode.
 * Each instance compiles its OWN `source` into a per-instance RenderGraph pass
 * (`customShader:<instanceId>`), so two instances are fully independent.
 *
 * `params` are the user-tunable scalar uniforms, packed (in declaration order,
 * after the built-in `time`/`resolution`/audio slots handled by
 * ShaderInjector) into the pass's uniform Float32Array. Persisted verbatim.
 */
export type CustomShaderConfig = {
  enabled: boolean;
  /** WGSL fragment source. Must declare `fn fs_main(...) -> @location(0) vec4f`. */
  source: string;
  /**
   * User scalar params, mapped 1:1 into the uniform buffer as f32 values.
   *   - `value` is the base value (used when AR is off, or as the AR envelope's
   *     floor when on).
   *   - `min`/`max` bound the editor slider AND the AR envelope's output range
   *     (default 0..1 when absent).
   *   - `audioReactive` optionally drives the value from an audio band through
   *     the shared attack/decay envelope, exactly like every other effect. The
   *     modulated value is written into the uniform each frame — the shader body
   *     just reads its param uniform and never calls a band accessor directly.
   */
  params: {
    name: string;
    value: number;
    min?: number;
    max?: number;
    audioReactive?: import('./audio-reactive').AudioReactiveConfig;
  }[];
  /**
   * Optional ordered uniform-buffer layout, in the EXACT order the WGSL struct
   * declares its fields. Present when the source came from a built-in template
   * whose struct interleaves engine built-ins (`time`, `resolution_x`,
   * `resolution_y`, `_padN`) with user params. The engine packs strictly in
   * this order — filling built-ins from frame params (resolution/time) and user
   * params by name — so the packed floats line up with the struct field offsets.
   * Absent for hand-written shaders, where the engine falls back to
   * [user params…, time, pad] (the starter-template layout).
   */
  uniformLayout?: { name: string; builtIn?: boolean }[];
};

/** One user-tunable scalar param on a custom shader. */
export type CustomShaderParam = CustomShaderConfig['params'][number];

// ─────────────────────────────────────────────
// Concrete per-effect config types (typed slice)
// ─────────────────────────────────────────────

type BloomInstanceConfig = PostProcessingConfig['bloom'];
type ChromaticAberrationInstanceConfig = PostProcessingConfig['chromaticAberration'];
type GlitchInstanceConfig = PostProcessingConfig['glitch'];
type VHSTrackingInstanceConfig = PostProcessingConfig['vhsTracking'];
type OldFilmInstanceConfig = PostProcessingConfig['oldFilm'];
type BulbFlickerInstanceConfig = PostProcessingConfig['bulbFlicker'];
type GateJitterInstanceConfig = PostProcessingConfig['gateJitter'];
type SepiaInstanceConfig = PostProcessingConfig['sepia'];
type ChainLightningInstanceConfig = PostProcessingConfig['chainLightning'];
type DistortionInstanceConfig = PostProcessingConfig['distortion'];
type StarfieldInstanceConfig = PostProcessingConfig['starfield'];
type ZoomInstanceConfig = PostProcessingConfig['zoom'];
type TilingInstanceConfig = PostProcessingConfig['tiling'];
type PixelationInstanceConfig = PostProcessingConfig['pixelation'];
type NoiseOverlayInstanceConfig = PostProcessingConfig['noiseOverlay'];
type SlideInstanceConfig = PostProcessingConfig['slide'];
type RotateInstanceConfig = PostProcessingConfig['rotate'];
type BrightnessInstanceConfig = PostProcessingConfig['brightness'];
type ContrastInstanceConfig = PostProcessingConfig['contrast'];
type SaturationInstanceConfig = PostProcessingConfig['saturation'];
type HueShiftInstanceConfig = PostProcessingConfig['hueShift'];
type LutInstanceConfig = PostProcessingConfig['lut'];
type MotionBlurInstanceConfig = PostProcessingConfig['motionBlur'];
type LensFlareInstanceConfig = PostProcessingConfig['lensFlare'];
type CameraShakeInstanceConfig = PostProcessingConfig['cameraShake'];
type BgOpacityInstanceConfig = PostProcessingConfig['bgOpacity'];
type BgBlurInstanceConfig = PostProcessingConfig['bgBlur'];
type BgImageOverlayInstanceConfig = PostProcessingConfig['bgImageOverlay'];

// ─────────────────────────────────────────────
// Discriminated union for EffectInstance
// ─────────────────────────────────────────────

type EffectInstanceConfig =
  | { type: 'particles'; config: ParticlesConfig }
  | { type: 'rain'; config: RainConfig }
  | { type: 'visualizer'; config: VisualizerConfig }
  | { type: 'shaderFx'; config: ShaderFxInstanceConfig }
  | { type: 'butterchurn'; config: ButterchurnConfig }
  | { type: 'bloom'; config: BloomInstanceConfig }
  | { type: 'chromaticAberration'; config: ChromaticAberrationInstanceConfig }
  | { type: 'glitch'; config: GlitchInstanceConfig }
  | { type: 'vhsTracking'; config: VHSTrackingInstanceConfig }
  | { type: 'oldFilm'; config: OldFilmInstanceConfig }
  | { type: 'bulbFlicker'; config: BulbFlickerInstanceConfig }
  | { type: 'gateJitter'; config: GateJitterInstanceConfig }
  | { type: 'sepia'; config: SepiaInstanceConfig }
  | { type: 'chainLightning'; config: ChainLightningInstanceConfig }
  | { type: 'distortion'; config: DistortionInstanceConfig }
  | { type: 'starfield'; config: StarfieldInstanceConfig }
  | { type: 'zoom'; config: ZoomInstanceConfig }
  | { type: 'tiling'; config: TilingInstanceConfig }
  | { type: 'pixelation'; config: PixelationInstanceConfig }
  | { type: 'noiseOverlay'; config: NoiseOverlayInstanceConfig }
  | { type: 'slide'; config: SlideInstanceConfig }
  | { type: 'rotate'; config: RotateInstanceConfig }
  | { type: 'brightness'; config: BrightnessInstanceConfig }
  | { type: 'contrast'; config: ContrastInstanceConfig }
  | { type: 'saturation'; config: SaturationInstanceConfig }
  | { type: 'hueShift'; config: HueShiftInstanceConfig }
  | { type: 'lut'; config: LutInstanceConfig }
  | { type: 'motionBlur'; config: MotionBlurInstanceConfig }
  | { type: 'lensFlare'; config: LensFlareInstanceConfig }
  | { type: 'cameraShake'; config: CameraShakeInstanceConfig }
  | { type: 'bgOpacity'; config: BgOpacityInstanceConfig }
  | { type: 'bgBlur'; config: BgBlurInstanceConfig }
  | { type: 'bgImageOverlay'; config: BgImageOverlayInstanceConfig }
  | { type: 'customShader'; config: CustomShaderConfig };

/** A single effect instance — identified by a unique id */
export type EffectInstance = EffectInstanceConfig & {
  id: string;
  /**
   * Optional time range (in seconds) during which this effect is active.
   * Outside this range, the effect is cleanly disabled (enabled = false).
   * If omitted, the effect is active for the entire track duration.
   */
  activeRange?: { start: number; end: number };
  /**
   * Which compositing layer this effect targets:
   *   - 'background' — composites into the background layer only (below the
   *     lyrics), so it warps the background/scene but NOT the text.
   *   - 'lyrics'     — composites onto the lyric layer (above the background),
   *     so it warps the text.
   * Absent ⇒ 'background' (matches legacy behavior where post-FX sat under the
   * lyric overlay). Scene sources (shaderFx / butterchurn / visualizer /
   * particles / rain / starfield) are inherently background-only and are always
   * treated as 'background' regardless of this field.
   */
  target?: EffectLayerTarget;
};

/** The compositing layer an effect can be assigned to. */
type EffectLayerTarget = 'background' | 'lyrics';

/**
 * Scene-source effect types that ARE the background (or a background-class
 * overlay) and therefore can never target the lyric layer. The UI locks these
 * to the Background bucket and the renderer treats them as 'background'.
 */
export const BACKGROUND_ONLY_EFFECT_TYPES: ReadonlySet<string> = new Set<string>([
  'shaderFx',
  'butterchurn',
  'visualizer',
  'particles',
  'rain',
  'starfield',
  // Background-scalar effects: resolved into state.backgroundBlur / opacity and
  // applied to the composited BACKGROUND target by dedicated passes, not the
  // render graph — so they structurally cannot affect the lyric layer. Lock
  // them to the Background bucket so the UI never shows a dead "lyrics blur".
  'bgBlur',
  'bgOpacity',
  // Secondary background image overlay: composites a second image on the
  // BACKGROUND target (below the lyrics) via a dedicated overlay pass. Locked
  // to Background so the UI never offers a meaningless "lyrics image overlay".
  'bgImageOverlay',
]);

/**
 * The effective layer target for an instance: forced to 'background' for
 * background-only scene sources, otherwise the instance's `target` (defaulting
 * to 'background'). SINGLE SOURCE OF TRUTH used by both UI and renderer.
 */
export function effectLayerTarget(inst: {
  type: string;
  target?: EffectLayerTarget;
}): EffectLayerTarget {
  if (BACKGROUND_ONLY_EFFECT_TYPES.has(inst.type)) return 'background';
  return inst.target ?? 'background';
}

// ─────────────────────────────────────────────
// Human-readable labels
// ─────────────────────────────────────────────

export const EFFECT_LABELS: Record<EffectType, string> = {
  particles: 'Particles',
  rain: 'Rain (3D)',
  visualizer: 'Oscilloscope',
  shaderFx: 'Shader FX',
  butterchurn: 'Butterchurn',

  bloom: 'Bloom',
  chromaticAberration: 'Chromatic Aberration',
  glitch: 'Glitch',
  vhsTracking: 'VHS Tracking',
  oldFilm: 'Old Film',
  bulbFlicker: 'Bulb Flicker',
  gateJitter: 'Gate Jitter',
  sepia: 'Sepia',
  chainLightning: 'Chain Lightning',
  distortion: 'Distortion',

  starfield: 'Starfield',
  zoom: 'Zoom',
  tiling: 'Tiling',
  pixelation: 'Pixelation',
  noiseOverlay: 'Noise Overlay',
  slide: 'Slide (Translate)',
  rotate: 'Rotate',
  hueShift: 'Hue Shift',
  contrast: 'Contrast',
  saturation: 'Saturation',
  brightness: 'Brightness',
  lut: 'LUT Color Grading',
  motionBlur: 'Motion Blur / Echo',
  lensFlare: 'Lens Flare',
  cameraShake: 'Camera Shake',
  bgOpacity: 'Image Opacity',
  bgBlur: 'Background Blur',
  bgImageOverlay: 'Secondary Image',
  customShader: 'Custom Shader (WGSL)',
};

export const SCENE_EFFECT_TYPES: SceneEffectType[] = [
  'shaderFx',
  'butterchurn',
  'visualizer',
  'particles',
  'rain',
  'starfield',
];

export const POST_PROCESSING_EFFECT_TYPES: PostProcessingEffectType[] = [
  'bgBlur',
  'bgOpacity',
  'bgImageOverlay',
  'bloom',
  'brightness',
  'bulbFlicker',
  'cameraShake',
  'chromaticAberration',
  'contrast',
  'distortion',
  'gateJitter',
  'glitch',
  'hueShift',
  'lensFlare',
  'lut',
  'motionBlur',
  'noiseOverlay',
  'oldFilm',
  'pixelation',
  'saturation',
  'sepia',
  'slide',
  'vhsTracking',
  'zoom',
  'tiling',
  'chainLightning',
  'rotate',
  'customShader',
];

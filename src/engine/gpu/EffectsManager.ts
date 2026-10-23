/**
 * EffectsManager — Shared core for GPU effect pass management.
 *
 * This module is used by BOTH:
 *   - useGPUEffects (preview/React)
 *   - ExportEffectsBridge (headless export)
 *
 * It owns the pass definitions, state merging, pass registration on a
 * RenderGraph, and per-frame enable/disable + uniform state sync.
 *
 * **IMPORTANT**: Any changes to effect pass behavior, pass definitions,
 * or state extraction MUST be made here — not duplicated in consumers.
 *
 * Architecture:
 *   ┌─────────────────┐     ┌──────────────────┐
 *   │  useGPUEffects   │────▶│                  │
 *   │  (React hook)    │     │  EffectsManager  │──▶ RenderGraph
 *   └─────────────────┘     │  (this module)   │
 *   ┌─────────────────┐     │                  │
 *   │ ExportEffects    │────▶│                  │
 *   │ Bridge (export)  │     └──────────────────┘
 *   └─────────────────┘
 */

import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';
import type { CustomShaderConfig } from '@/types/effects/effect-instances';
import type { RenderGraph, EffectPassConfig, EffectPassParams } from './RenderGraph';
import { ShaderInjector, type ShaderParameter } from './ShaderInjector';
import {
  BLOOM_PASS_ID,
  bloomPassConfig,
  createBloomUpdater,
  COLOR_GRADE_PASS_ID,
  colorGradePassConfig,
  createColorGradeUpdater,
  type ColorGradePassState,
  CHROMATIC_ABERRATION_PASS_ID,
  chromaticAberrationPassConfig,
  createChromaticAberrationUpdater,
  DISTORTION_PASS_ID,
  distortionPassConfig,
  createDistortionUpdater,
  SEPIA_PASS_ID,
  sepiaPassConfig,
  createSepiaUpdater,
  VHS_TRACKING_PASS_ID,
  vhsTrackingPassConfig,
  createVHSTrackingUpdater,
  NOISE_OVERLAY_PASS_ID,
  noiseOverlayPassConfig,
  createNoiseOverlayUpdater,
  PIXELATION_PASS_ID,
  pixelationPassConfig,
  createPixelationUpdater,
  OLD_FILM_PASS_ID,
  oldFilmPassConfig,
  createOldFilmUpdater,
  GLITCH_PASS_ID,
  glitchPassConfig,
  createGlitchUpdater,
  GATE_JITTER_PASS_ID,
  gateJitterPassConfig,
  createGateJitterUpdater,
  BULB_FLICKER_PASS_ID,
  bulbFlickerPassConfig,
  createBulbFlickerUpdater,
  CHAIN_LIGHTNING_PASS_ID,
  chainLightningPassConfig,
  createChainLightningUpdater,
  LUT_PASS_ID,
  lutPassConfig,
  createLutUpdater,
  MOTION_BLUR_PASS_ID,
  motionBlurPassConfig,
  createMotionBlurUpdater,
  LENS_FLARE_PASS_ID,
  lensFlarePassConfig,
  createLensFlareUpdater,
  CAMERA_SHAKE_PASS_ID,
  cameraShakePassConfig,
  createCameraShakeUpdater,
  createARParam,
  type ARParamEnvelope,
} from './EffectPasses';
import {
  STARFIELD_PASS_ID,
  starfieldPassConfig,
  createStarfieldUpdater,
  PARTICLES_PASS_ID,
  particlesPassConfig,
  createParticlesUpdater,
  RAIN_PASS_ID,
  rainPassConfig,
  createRainUpdater,
} from './SceneEffectPasses';
import {
  OSCILLOSCOPE_PASS_ID,
  oscilloscopePassConfig,
  createOscilloscopeUpdater,
} from './OscilloscopePass';
import {
  BG_IMAGE_OVERLAY_PASS_ID,
  bgImageOverlayPassConfig,
  createBgImageOverlayUpdater,
  getOverlayImageMeta,
} from './BgImageOverlayPass';

// ---------------------------------------------------------------------------
// GPU pass mapping — the single source of truth for effect → pass mapping
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pass state / effect config shapes differ per effect type; each updater and extractor narrows its own
type PassStateValue = any;

interface GPUPassDef {
  passId: string;
  passConfig: EffectPassConfig;
  createUpdater: (getState: () => PassStateValue) => (u: Float32Array, p: EffectPassParams) => void;
  /** Extract uniform state from an effect instance config */
  extractState: (cfg: PassStateValue) => Record<string, PassStateValue>;
}

/** Effect types that share the merged color-grade pass */
const COLOR_GRADE_TYPES = new Set(['brightness', 'contrast', 'saturation', 'hueShift']);

/**
 * The `customShader` effect is the one type that does NOT map to a single
 * static pass id: each instance compiles its own `source` into its OWN pass, so
 * the pass id is derived from the INSTANCE id, not the type. This helper is the
 * single source of truth for that id, shared by EffectsManager (register /
 * enable / prune) and resolveRenderPlan (layer split), so the two can't drift.
 */
export const CUSTOM_SHADER_TYPE = 'customShader';
export function customShaderPassId(instanceId: string): string {
  return `customShader:${instanceId}`;
}

/**
 * Frame-watchdog tuning (§5/3b safety). After a customShader pass compiles, the
 * PREVIEW renderer is watched for `CUSTOM_SHADER_WATCH_FRAMES` frames; if the
 * frame time stays above `CUSTOM_SHADER_FRAME_BUDGET_MS` for
 * `CUSTOM_SHADER_SUSTAINED_FRAMES` consecutive frames the pass is auto-disabled.
 * ~120ms is well past a dropped 60fps frame but short of the browser's
 * unresponsive-tab threshold; requiring several in a row ignores one-off hitches.
 */
export const CUSTOM_SHADER_FRAME_BUDGET_MS = 120;
export const CUSTOM_SHADER_SUSTAINED_FRAMES = 8;
const CUSTOM_SHADER_WATCH_FRAMES = 240;

/**
 * Map a single effect instance (by its type) to the render-graph pass id it
 * drives, or null if it has no GPU pass. Color-grade types (brightness /
 * contrast / saturation / hueShift) all collapse to the single merged
 * COLOR_GRADE pass. This is the SINGLE SOURCE OF TRUTH for the instance→pass
 * mapping, reused by the renderer to split the effect chain around the lyric
 * layer without duplicating the collapse logic.
 *
 * NOTE: `customShader` returns null here because a per-instance pass id cannot
 * be derived from the type alone — callers with the instance in hand must use
 * `customShaderPassId(instance.id)` (resolveRenderPlan does exactly this).
 */
export function resolveInstancePassId(type: string): string | null {
  if (COLOR_GRADE_TYPES.has(type)) return COLOR_GRADE_PASS_ID;
  if (type === CUSTOM_SHADER_TYPE) return null;
  return PASS_DEFS[type]?.passId ?? null;
}

export const PASS_DEFS: Record<string, GPUPassDef> = {
  bloom: {
    passId: BLOOM_PASS_ID,
    passConfig: bloomPassConfig,
    createUpdater: createBloomUpdater,
    extractState: (c) => ({
      intensity: c.intensity ?? 0.5,
      threshold: c.threshold ?? 0.8,
      softThreshold: c.softThreshold ?? 0.3,
      radius: c.radius ?? 4,
      mode: c.mode ?? 'continuous',
      randomInterval: c.randomInterval,
      randomDuration: c.randomDuration,
      attack: c.attack,
      decay: c.decay,
      audioReactive: c.audioReactive,
    }),
  },
  chromaticAberration: {
    passId: CHROMATIC_ABERRATION_PASS_ID,
    passConfig: chromaticAberrationPassConfig,
    createUpdater: createChromaticAberrationUpdater,
    extractState: (c) => ({
      intensity: c.offset ?? 0.005,
      centerX: c.centerX ?? 0.5,
      centerY: c.centerY ?? 0.5,
      distortion: c.distortion ?? 0,
      redOffset: c.redOffset ?? 1.0,
      blueOffset: c.blueOffset ?? 1.0,
      mode: c.mode ?? 'continuous',
      randomInterval: c.randomInterval,
      randomDuration: c.randomDuration,
      attack: c.attack,
      decay: c.decay,
      audioReactive: { intensity: c.audioReactive },
    }),
  },
  distortion: {
    passId: DISTORTION_PASS_ID,
    passConfig: distortionPassConfig,
    createUpdater: createDistortionUpdater,
    extractState: (c) => {
      // Map distortionType string to numeric enum
      const typeMap: Record<string, number> = { radial: 0, horizontal: 1, vertical: 2, box: 3 };
      const dtype = typeMap[c.distortionType ?? 'radial'] ?? 0;
      // Parse tint color hex → RGB floats
      const hex = (c.color ?? '#ffffff').replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      return {
        time: 0, // Filled by params.time in updater
        intensity: c.intensity ?? 0.5,
        distortAmount: c.distortAmount ?? 1.0,
        rippleSpeed: c.rippleSpeed ?? 2.0,
        rippleFrequency: c.rippleFrequency ?? 15.0,
        distortionType: dtype,
        tintR: r,
        tintG: g,
        tintB: b,
        tintOpacity: c.opacity ?? 0.0,
        audioReactive: c.audioReactive,
      };
    },
  },
  sepia: {
    passId: SEPIA_PASS_ID,
    passConfig: sepiaPassConfig,
    createUpdater: createSepiaUpdater,
    extractState: (c) => ({
      intensity: c.intensity ?? 0.5,
      audioReactive: { intensity: c.audioReactive },
    }),
  },
  vhsTracking: {
    passId: VHS_TRACKING_PASS_ID,
    passConfig: vhsTrackingPassConfig,
    createUpdater: createVHSTrackingUpdater,
    extractState: (c) => ({
      time: 0,
      intensity: c.intensity ?? 0.5,
      trackingSpeed: c.trackingSpeed ?? 0.2,
      distortionAmount: c.distortionAmount ?? 0.5,
      chromaticSplit: c.chromaticSplit ?? 0.3,
      scanlineOffset: 0,
      loopTracking: c.mode === 'random' ? 0.0 : 1.0,
      mode: c.mode ?? 'continuous',
      randomInterval: c.randomInterval,
      randomDuration: c.randomDuration,
      attack: c.attack,
      decay: c.decay,
      audioReactive: c.audioReactive,
    }),
  },
  noiseOverlay: {
    passId: NOISE_OVERLAY_PASS_ID,
    passConfig: noiseOverlayPassConfig,
    createUpdater: createNoiseOverlayUpdater,
    extractState: (c) => ({
      grainSize: c.grainSize ?? 3.0,
      vSyncSpeed: c.vSyncSpeed ?? 1.0,
      intensity: c.opacity ?? 0.15,
      audioReactive: c.audioReactive,
    }),
  },
  pixelation: {
    passId: PIXELATION_PASS_ID,
    passConfig: pixelationPassConfig,
    createUpdater: createPixelationUpdater,
    extractState: (c) => ({
      pixelSize: c.pixelSize ?? 8,
      audioReactive: { pixelSize: c.audioReactive },
    }),
  },
  oldFilm: {
    passId: OLD_FILM_PASS_ID,
    passConfig: oldFilmPassConfig,
    createUpdater: createOldFilmUpdater,
    extractState: (c) => ({
      intensity: c.intensity ?? 0.5,
      grainAmount: c.grainAmount ?? 0.5,
      scratchAmount: c.scratchAmount ?? 0.3,
      dirtAmount: c.dirtAmount ?? 0.3,
      grainScale: 4.0, // fixed — control removed from UI (always showed internal structure)
      grainType: c.grainType,
      mode: c.mode ?? 'continuous',
      randomInterval: c.randomInterval,
      randomDuration: c.randomDuration,
      attack: c.attack,
      decay: c.decay,
      audioReactive: c.audioReactive,
    }),
  },
  glitch: {
    passId: GLITCH_PASS_ID,
    passConfig: glitchPassConfig,
    createUpdater: createGlitchUpdater,
    extractState: (c) => ({
      strength: c.strength ?? 0.3,
      blocks: c.columns ?? 0.05,
      glitchActive: 1.0,
      mode: c.mode ?? 'continuous',
      randomInterval: c.randomInterval,
      randomDuration: c.randomDuration,
      attack: c.attack,
      decay: c.decay,
      audioReactive: { strength: c.audioReactive },
    }),
  },
  gateJitter: {
    passId: GATE_JITTER_PASS_ID,
    passConfig: gateJitterPassConfig,
    createUpdater: createGateJitterUpdater,
    extractState: (c) => ({
      intensity: c.intensity ?? 0.5,
      speed: c.speed ?? 1.0,
      jitterActive: 1.0,
      audioReactive: { intensity: c.audioReactive },
    }),
  },
  bulbFlicker: {
    passId: BULB_FLICKER_PASS_ID,
    passConfig: bulbFlickerPassConfig,
    createUpdater: createBulbFlickerUpdater,
    extractState: (c) => ({
      intensity: c.intensity ?? 0.5,
      speed: c.speed ?? 1.0,
      flickerActive: 1.0,
      audioReactive: { intensity: c.audioReactive },
    }),
  },
  starfield: {
    passId: STARFIELD_PASS_ID,
    passConfig: starfieldPassConfig,
    createUpdater: createStarfieldUpdater,
    extractState: (c) => ({
      count: c.count ?? 500,
      speed: c.speed ?? 4.5,
      brightness: c.brightness ?? 1.0,
      audioReactive: c.audioReactive,
    }),
  },
  particles: {
    passId: PARTICLES_PASS_ID,
    passConfig: particlesPassConfig,
    createUpdater: createParticlesUpdater,
    extractState: (c) => {
      // Parse hex color → RGB floats
      const hex = (c.color ?? '#ffffff').replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      const state = {
        count: c.count ?? 500,
        gravity: c.gravity ?? 0.2,
        opacity: c.opacity ?? 0.5,
        windX: c.windX ?? 0.0,
        turbulence: c.turbulence ?? 0.0,
        size: c.size ?? 1.5,
        blending: c.blending === 'normal' ? 1.0 : 0.0,
        style: 0.0,
        colorR: r,
        colorG: g,
        colorB: b,
        audioReactive: c.audioReactive,
      };

      return state;
    },
  },
  rain: {
    passId: RAIN_PASS_ID,
    passConfig: rainPassConfig,
    createUpdater: createRainUpdater,
    extractState: (c) => ({
      count: c.count ?? 10000,
      speed: c.speed ?? 2.0,
      opacity: c.opacity ?? 0.4,
      windX: c.windX ?? 0.2,
      size: c.size ?? 1.0,
      audioReactive: c.audioReactive,
    }),
  },
  chainLightning: {
    passId: CHAIN_LIGHTNING_PASS_ID,
    passConfig: chainLightningPassConfig,
    createUpdater: createChainLightningUpdater,
    extractState: (c) => {
      // Parse hex color → RGB floats
      const hex = (c.lightningColor ?? '#4fc3f7').replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      return {
        glowIntensity: c.glowIntensity ?? 1.5,
        arcWidth: c.arcWidth ?? 2.0,
        nodeCount: c.nodeCount ?? 5,
        duration: c.duration ?? 0.3,
        cooldown: c.cooldown ?? 1.0,
        colorR: r,
        colorG: g,
        colorB: b,
        audioReactive: c.audioReactive?.enabled
          ? {
              glowIntensity: c.audioReactive,
              arcWidth: c.audioReactive?.arcWidth,
            }
          : undefined,
      };
    },
  },
  lut: {
    passId: LUT_PASS_ID,
    passConfig: lutPassConfig,
    createUpdater: createLutUpdater,
    extractState: (c) => ({
      preset: c.preset ?? 'none',
      intensity: c.intensity ?? 1.0,
      audioReactive: { intensity: c.audioReactive },
    }),
  },
  motionBlur: {
    passId: MOTION_BLUR_PASS_ID,
    passConfig: motionBlurPassConfig,
    createUpdater: createMotionBlurUpdater,
    extractState: (c) => ({
      intensity: c.intensity ?? 0.5,
      decay: c.decay ?? 0.8,
      trailCount: c.trailCount ?? 4,
      audioReactive: c.audioReactive,
    }),
  },
  lensFlare: {
    passId: LENS_FLARE_PASS_ID,
    passConfig: lensFlarePassConfig,
    createUpdater: createLensFlareUpdater,
    extractState: (c) => {
      const hex = (c.tintColor ?? '#ffffff').replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      return {
        intensity: c.intensity ?? 1.0,
        threshold: c.threshold ?? 0.7,
        streakLength: c.streakLength ?? 0.3,
        ghostCount: c.ghostCount ?? 3,
        ghostSpacing: c.ghostSpacing ?? 0.25,
        tintR: r,
        tintG: g,
        tintB: b,
        anamorphic: c.anamorphic ? 1.0 : 0.0,
        audioReactive: c.audioReactive,
      };
    },
  },
  cameraShake: {
    passId: CAMERA_SHAKE_PASS_ID,
    passConfig: cameraShakePassConfig,
    createUpdater: createCameraShakeUpdater,
    extractState: (c) => ({
      intensity: c.intensity ?? 0.01,
      frequency: c.frequency ?? 15,
      damping: c.damping ?? 0.5,
      rotational: c.rotational ? 1.0 : 0.0,
      maxRotation: c.maxRotation ?? 2.0,
      audioReactive: c.audioReactive,
    }),
  },
  visualizer: {
    passId: OSCILLOSCOPE_PASS_ID,
    passConfig: oscilloscopePassConfig,
    createUpdater: createOscilloscopeUpdater,
    extractState: (c) => {
      // Parse hex colors → RGB floats
      const parseHex = (hex: string) => {
        const clean = (hex ?? '#ffffff').replace('#', '');
        return [
          parseInt(clean.substring(0, 2), 16) / 255,
          parseInt(clean.substring(2, 4), 16) / 255,
          parseInt(clean.substring(4, 6), 16) / 255,
        ];
      };
      const typeMap: Record<string, number> = { linear: 0, circle: 1, bars: 2, tunnel: 3 };
      const [minR, minG, minB] = parseHex(c.minColor ?? '#2a2a2e');
      const [maxR, maxG, maxB] = parseHex(c.maxColor ?? '#ef4444');
      return {
        type: typeMap[c.type ?? 'linear'] ?? 0,
        lineWidth: c.lineWidth ?? 1.5,
        sensitivity: c.sensitivity ?? 1.0,
        smoothness: c.smoothness ?? 0.85,
        positionX: c.positionX ?? 50,
        positionY: c.positionY ?? 50,
        scale: c.scale ?? 1.0,
        minColorR: minR,
        minColorG: minG,
        minColorB: minB,
        maxColorR: maxR,
        maxColorG: maxG,
        maxColorB: maxB,
        // Glow range was reduced to 0.0–0.2; clamp so pre-existing projects that
        // stored a larger value (old 0–5 range) render at the new subtle maximum.
        glowIntensity: Math.min(0.2, c.glowIntensity ?? 0.1),
        opacity: c.opacity ?? 1.0,
      };
    },
  },
  bgImageOverlay: {
    passId: BG_IMAGE_OVERLAY_PASS_ID,
    passConfig: bgImageOverlayPassConfig,
    createUpdater: createBgImageOverlayUpdater,
    extractState: (c) => {
      // hasImage / imageW / imageH come from the renderer-owned decode registry
      // (keyed by imageAssetId), so the uniforms reflect the actual bound
      // texture rather than stale config. Undefined asset ⇒ not ready.
      const meta = getOverlayImageMeta(c.imageAssetId);
      return {
        imageAssetId: c.imageAssetId,
        opacity: c.opacity ?? 1.0,
        fit: c.fit ?? 'cover',
        blendMode: c.blendMode ?? 'normal',
        hasImage: meta.ready ? 1 : 0,
        imageW: meta.width,
        imageH: meta.height,
        gate: c.gate,
        gateFadeIn: c.gateFadeIn ?? true,
        gateAttack: c.gateAttack ?? 0.3,
        audioReactive: { opacity: c.audioReactive },
      };
    },
  },
};

/**
 * Merge multiple color-grade effect instances into a single pass state.
 * Brightness/contrast/saturation multiply; hue shift adds.
 */
export function mergeColorGradeState(instances: EffectInstance[]): ColorGradePassState {
  const audioReactive: NonNullable<ColorGradePassState['audioReactive']> = {};
  const state: ColorGradePassState = {
    brightness: 1.0,
    contrast: 1.0,
    saturation: 1.0,
    hueShift: 0,
    temperature: 0,
    gamma: 1.0,
    shadows: [0, 0, 0],
    highlights: [0, 0, 0],
    audioReactive,
  };

  for (const inst of instances) {
    if (!inst.config.enabled) continue;
    switch (inst.type) {
      case 'brightness':
        state.brightness *= inst.config.brightness ?? 1.0;
        if (inst.config.audioReactive?.enabled)
          audioReactive.brightness = inst.config.audioReactive;
        break;
      case 'contrast':
        state.contrast *= inst.config.contrast ?? 1.0;
        if (inst.config.audioReactive?.enabled) audioReactive.contrast = inst.config.audioReactive;
        break;
      case 'saturation':
        state.saturation *= inst.config.saturation ?? 1.0;
        if (inst.config.audioReactive?.enabled)
          audioReactive.saturation = inst.config.audioReactive;
        break;
      case 'hueShift':
        state.hueShift += inst.config.hue ?? 0;
        if (inst.config.audioReactive?.enabled) audioReactive.hueShift = inst.config.audioReactive;
        break;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// EffectsManager — framework-agnostic effect pass orchestrator
// ---------------------------------------------------------------------------

export class EffectsManager {
  private renderGraph: RenderGraph;
  private registeredPassIds = new Set<string>();
  private stateMap = new Map<string, Record<string, PassStateValue>>();
  private prevPassKey = '';

  // ── Custom-shader (per-instance dynamic passes) ──────────────────────────
  /** GPU device, threaded in by the consumer (setDevice). Needed to build the
   *  ShaderInjector; absent on software renderers (customShader then no-ops). */
  private device: GPUDevice | null = null;
  /** Lazily-constructed ShaderInjector — reuses its validate/inject/hot-reload
   *  and, critically, its updateUniformsFromParameters uniform packing. */
  private shaderInjector: ShaderInjector | null = null;
  /**
   * Per customShader instance id → the source last compiled into its pass, so a
   * source edit is detected and hot-reloaded, and the ShaderParameter[] derived
   * from its params (built once per source, reused every frame by the updater).
   * `envelopes` holds one attack/decay AR follower per param NAME, reused across
   * frames so smoothing state persists; rebuilt only when the param set changes.
   */
  private customShaders = new Map<
    string,
    {
      source: string;
      parameters: ShaderParameter[];
      envelopes: Map<string, ARParamEnvelope>;
      /** Live config, refreshed every sync so the updater reads current params. */
      cfg: CustomShaderConfig;
      /**
       * Frame-watchdog state (§5/3b safety). `watchUntilFrame` is the preview
       * frame index up to which a freshly (re)compiled pass is watched for a
       * sustained frame-time spike; `overCount` counts consecutive over-budget
       * frames inside that window; `disabled` is set once the watchdog trips.
       */
      watchUntilFrame: number;
      overCount: number;
      disabled: boolean;
    }
  >();

  /**
   * Preview frame counter (advanced by {@link feedFrameTime}). Used only to
   * bound the watchdog window; export never feeds it.
   */
  private _watchFrame = 0;
  /**
   * Auto-disable events the UI has not yet consumed. The renderer/consumer polls
   * {@link consumeWatchdogEvents} to surface "layer X was disabled because …".
   */
  private _watchdogEvents: { instanceId: string; reason: string }[] = [];

  constructor(renderGraph: RenderGraph) {
    this.renderGraph = renderGraph;
  }

  /**
   * Supply the GPU device (from the renderer) so per-instance customShader
   * passes can be compiled. Idempotent; a null device leaves customShader
   * inert (software renderers). Safe to call before or after the first sync.
   */
  setDevice(device: GPUDevice | null): void {
    if (device && device !== this.device) {
      this.device = device;
      this.shaderInjector = new ShaderInjector(device, this.renderGraph);
    } else if (device) {
      this.device = device;
    }
  }

  /**
   * Build the ShaderParameter[] layout for a customShader instance: the user's
   * scalar params (declaration order) as f32, then a built-in `time` slot, then
   * padding to a multiple of 4 f32s (16 bytes) so the uniform buffer is aligned.
   * ShaderInjector.updateUniformsFromParameters packs from this every frame.
   */
  private buildCustomShaderParameters(cfg: CustomShaderConfig): ShaderParameter[] {
    // Template-sourced shaders carry the struct's EXACT field order (built-ins
    // like resolution_x/y interleaved). Honor it verbatim so the packed floats
    // line up with the WGSL struct offsets.
    if (cfg.uniformLayout && cfg.uniformLayout.length > 0) {
      const byName = new Map((cfg.params ?? []).map((p) => [p.name, p.value]));
      const params: ShaderParameter[] = cfg.uniformLayout.map((f) => ({
        name: f.name,
        type: 'f32',
        defaultValue: f.builtIn ? 0 : (byName.get(f.name) ?? 0),
        builtIn: f.builtIn,
      }));
      while (params.length % 4 !== 0) {
        params.push({ name: `_pad${params.length}`, type: 'f32', defaultValue: 0, builtIn: true });
      }
      return params;
    }
    const params: ShaderParameter[] = (cfg.params ?? []).map((p) => ({
      name: p.name,
      type: 'f32',
      defaultValue: p.value,
    }));
    // Built-in time slot (matches the starter template's `time` field).
    params.push({ name: 'time', type: 'f32', defaultValue: 0, builtIn: true });
    // Pad to a multiple of 4 f32s (16 bytes).
    while (params.length % 4 !== 0) {
      params.push({ name: `_pad${params.length}`, type: 'f32', defaultValue: 0, builtIn: true });
    }
    return params;
  }

  /**
   * Resolve which pass IDs are needed for the given effect instances.
   */
  resolveNeededPasses(instances: EffectInstance[]): Set<string> {
    const needed = new Set<string>();

    const colorInstances = instances.filter(
      (i) => COLOR_GRADE_TYPES.has(i.type) && i.config.enabled,
    );
    if (colorInstances.length > 0) needed.add(COLOR_GRADE_PASS_ID);

    for (const inst of instances) {
      if (!inst.config.enabled) continue;
      if (COLOR_GRADE_TYPES.has(inst.type)) continue;
      if (inst.type === CUSTOM_SHADER_TYPE) {
        needed.add(customShaderPassId(inst.id));
        continue;
      }
      const def = PASS_DEFS[inst.type];
      if (def) needed.add(def.passId);
    }

    return needed;
  }

  /**
   * Reconcile per-instance customShader passes against the live enabled set:
   *   - a NEW enabled instance → inject its source as pass `customShader:<id>`
   *   - a source CHANGE on an existing instance → hot-reload in place
   *   - an instance that vanished / was disabled → remove its pass
   *   - keep the injector's stored param values in sync each call (cheap), so a
   *     slider edit takes effect without a recompile.
   *
   * Async because compilation is async. No-op (and prunes nothing new) on a
   * software renderer where no device was supplied. Registration/removal is
   * additive-safe: it only ever touches `customShader:*` passes it owns.
   */
  private async syncCustomShaders(instances: EffectInstance[]): Promise<void> {
    const injector = this.shaderInjector;
    // Enabled customShader instances this frame (id → config).
    const live = new Map<string, CustomShaderConfig>();
    for (const inst of instances) {
      if (inst.type !== CUSTOM_SHADER_TYPE || !inst.config.enabled) continue;
      live.set(inst.id, inst.config as CustomShaderConfig);
    }

    // Prune passes whose instance is gone/disabled (do this even with no
    // injector, so a device that appears later starts from a clean slate).
    for (const id of [...this.customShaders.keys()]) {
      if (!live.has(id)) {
        injector?.remove(customShaderPassId(id));
        this.customShaders.delete(id);
        this.registeredPassIds.delete(customShaderPassId(id));
      }
    }

    if (!injector) return; // software renderer / no device yet

    for (const [id, cfg] of live) {
      const passId = customShaderPassId(id);
      const existing = this.customShaders.get(id);
      const parameters = this.buildCustomShaderParameters(cfg);

      if (!existing) {
        // New instance — inject its source as a fresh pass. inject() installs
        // ShaderInjector's own static packer; we immediately REPLACE it with our
        // AR-aware updater (below) so params can follow audio.
        const result = await injector.inject({
          id: passId,
          label: `Custom Shader ${id.slice(0, 8)}`,
          source: cfg.source,
          uniformSize: parameters.length * 4,
          parameters,
          enableOnInject: false, // enable/disable is driven by syncFrame below
        });
        if (result.success) {
          const entry = {
            source: cfg.source,
            parameters,
            envelopes: new Map<string, ARParamEnvelope>(),
            cfg,
            // Arm the frame-watchdog window from now (preview only; export never
            // feeds it).
            watchUntilFrame: this._watchFrame + CUSTOM_SHADER_WATCH_FRAMES,
            overCount: 0,
            disabled: false,
          };
          this.customShaders.set(id, entry);
          this.registeredPassIds.add(passId);
          this.installCustomShaderUpdater(id, passId);
        }
        continue;
      }

      // Refresh the live config the updater reads (param values, AR configs).
      existing.cfg = cfg;
      existing.parameters = parameters;

      // Source change → hot-reload in place. hotReload re-injects, which resets
      // the updater to the static packer, so re-install ours afterwards.
      if (existing.source !== cfg.source) {
        const result = await injector.hotReload(passId, cfg.source);
        if (result.success) {
          existing.source = cfg.source;
          this.installCustomShaderUpdater(id, passId);
          // A source edit gets a fresh watchdog window and clears any prior
          // auto-disable — the user is actively fixing the shader.
          existing.watchUntilFrame = this._watchFrame + CUSTOM_SHADER_WATCH_FRAMES;
          existing.overCount = 0;
          existing.disabled = false;
        }
      }
    }
  }

  /**
   * Frame-watchdog feed (§5/3b safety). The PREVIEW renderer calls this once per
   * frame with the last frame's wall-clock delta in milliseconds. Export never
   * calls it — offline frame timing is meaningless (it runs at encoder speed),
   * and a false-positive disable would corrupt the output.
   *
   * For each live, not-yet-disabled customShader pass still inside its post-
   * compile watch window, a sustained run of over-budget frames
   * (`CUSTOM_SHADER_FRAME_BUDGET_MS` for `CUSTOM_SHADER_SUSTAINED_FRAMES` in a
   * row) auto-disables that pass and records why — converting a probable GPU
   * hang into a recoverable, surfaced error. A single spike (GC, a resize hitch)
   * does not trip it.
   */
  feedFrameTime(dtMs: number): void {
    this._watchFrame++;
    if (this.customShaders.size === 0) return;
    for (const [id, entry] of this.customShaders) {
      if (entry.disabled) continue;
      if (this._watchFrame > entry.watchUntilFrame) continue; // window elapsed
      if (dtMs > CUSTOM_SHADER_FRAME_BUDGET_MS) {
        entry.overCount++;
        if (entry.overCount >= CUSTOM_SHADER_SUSTAINED_FRAMES) {
          entry.disabled = true;
          this.renderGraph.setPassEnabled(customShaderPassId(id), false);
          const reason = `Auto-disabled: this custom shader sustained > ${CUSTOM_SHADER_FRAME_BUDGET_MS}ms/frame for ${CUSTOM_SHADER_SUSTAINED_FRAMES} frames after compiling (likely a heavy or pathological loop).`;
          this._watchdogEvents.push({ instanceId: id, reason });
        }
      } else {
        entry.overCount = 0; // reset on any healthy frame — must be SUSTAINED
      }
    }
  }

  /**
   * Drain and return watchdog auto-disable events since the last call, so the
   * UI can surface which layer was disabled and why. Non-destructive read would
   * re-report; this clears the queue.
   */
  consumeWatchdogEvents(): { instanceId: string; reason: string }[] {
    if (this._watchdogEvents.length === 0) return [];
    const out = this._watchdogEvents;
    this._watchdogEvents = [];
    return out;
  }

  /**
   * Install the AR-aware uniform updater for a customShader pass, replacing the
   * static packer ShaderInjector.inject wired up. Runs EVERY frame with the
   * pass's `EffectPassParams` (dt + audio bands), so each param either passes
   * through its base `value` or, when `audioReactive.enabled`, is driven by a
   * per-param attack/decay envelope (the SAME `createARParam` primitive every
   * other effect uses — export-safe, reads bands from params not the store).
   *
   * Uniform layout MUST match `buildCustomShaderParameters`: user params in
   * declaration order as f32, then a built-in `time`, then f32 padding.
   */
  private installCustomShaderUpdater(instanceId: string, passId: string): void {
    this.renderGraph.setPassUniformUpdater(passId, (uniforms, params) => {
      const entry = this.customShaders.get(instanceId);
      if (!entry) return;
      const userByName = new Map((entry.cfg.params ?? []).map((p) => [p.name, p]));
      // Pack strictly in the parameter/struct order. Built-ins are filled from
      // the live frame params (resolution + time); user params pass through
      // their base value or an AR envelope. This honors any template's struct
      // layout (e.g. Edge Detection's resolution_x/y interleaved between params).
      for (let i = 0; i < entry.parameters.length; i++) {
        const decl = entry.parameters[i];
        if (decl.builtIn) {
          switch (decl.name) {
            case 'time':
              uniforms[i] = params.time;
              break;
            case 'resolution_x':
              uniforms[i] = params.resolution[0];
              break;
            case 'resolution_y':
              uniforms[i] = params.resolution[1];
              break;
            default:
              uniforms[i] = 0; // _padN and any unrecognized built-in
          }
          continue;
        }
        const p = userByName.get(decl.name);
        if (!p) {
          uniforms[i] = 0;
          continue;
        }
        let env = entry.envelopes.get(p.name);
        if (!env) {
          env = createARParam();
          entry.envelopes.set(p.name, env);
        }
        const arCfg = p.audioReactive
          ? {
              ...p.audioReactive,
              min: p.audioReactive.min ?? p.min ?? 0,
              max: p.audioReactive.max ?? p.max ?? 1,
            }
          : undefined;
        uniforms[i] = env.compute(p.value, arCfg, params);
      }
    });
  }

  /**
   * Build the ordered list of pass ids from the effect-instance array order,
   * so the render graph composites layers in exactly the order the user has
   * them in the effect list. Multiple color-grade instances collapse to the
   * single merged COLOR_GRADE pass, ranked at the position of the FIRST
   * color-grade instance encountered. Disabled instances are skipped.
   */
  private buildPassOrder(instances: EffectInstance[]): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    for (const inst of instances) {
      if (!inst.config.enabled) continue;
      let passId: string | undefined;
      if (COLOR_GRADE_TYPES.has(inst.type)) {
        passId = COLOR_GRADE_PASS_ID;
      } else if (inst.type === CUSTOM_SHADER_TYPE) {
        passId = customShaderPassId(inst.id);
      } else {
        passId = PASS_DEFS[inst.type]?.passId;
      }
      if (!passId || seen.has(passId)) continue;
      seen.add(passId);
      order.push(passId);
    }
    return order;
  }

  /**
   * Register effect passes on the RenderGraph. Async because shader compilation
   * is async. Only registers passes not yet registered.
   */
  async ensurePassesRegistered(neededPassIds: Set<string>): Promise<void> {
    for (const passId of neededPassIds) {
      if (this.registeredPassIds.has(passId)) continue;
      if (this.renderGraph.hasPass(passId)) {
        this.registeredPassIds.add(passId);
        continue;
      }

      // Find the pass config
      let passConfig: EffectPassConfig | null = null;
      let updaterFactory: GPUPassDef['createUpdater'] | null = null;

      if (passId === COLOR_GRADE_PASS_ID) {
        passConfig = colorGradePassConfig;
        updaterFactory = createColorGradeUpdater;
      } else {
        for (const def of Object.values(PASS_DEFS)) {
          if (def.passId === passId) {
            passConfig = def.passConfig;
            updaterFactory = def.createUpdater;
            break;
          }
        }
      }

      if (!passConfig || !updaterFactory) continue;

      const ok = await this.renderGraph.registerPass(passConfig);
      if (ok) {
        this.registeredPassIds.add(passId);
        const pid = passId;
        const factory = updaterFactory;
        this.renderGraph.setPassUniformUpdater(
          pid,
          factory(() => this.stateMap.get(pid) ?? {}),
        );
      }
    }
  }

  /**
   * Sync effect state for the current frame. Call this per-frame.
   * Updates the state map and enables/disables passes accordingly.
   *
   * @returns true if the set of needed passes changed (shape change)
   */
  syncFrame(effectsConfig: EffectsConfig | undefined): boolean {
    const instances = effectsConfig?.effectInstances ?? [];

    // Determine which passes should be active
    const colorInstances = instances.filter(
      (i) => COLOR_GRADE_TYPES.has(i.type) && i.config.enabled,
    );
    const neededPassIds = new Set<string>();

    if (colorInstances.length > 0) {
      neededPassIds.add(COLOR_GRADE_PASS_ID);
      this.stateMap.set(COLOR_GRADE_PASS_ID, mergeColorGradeState(colorInstances));
    }

    for (const inst of instances) {
      if (!inst.config.enabled) continue;
      if (COLOR_GRADE_TYPES.has(inst.type)) continue;
      if (inst.type === CUSTOM_SHADER_TYPE) {
        // Per-instance dynamic pass; state is driven by the injector's own
        // updater (not the stateMap), so we only track the needed id here.
        neededPassIds.add(customShaderPassId(inst.id));
        continue;
      }
      const def = PASS_DEFS[inst.type];
      if (def) {
        neededPassIds.add(def.passId);
        const extracted = def.extractState(inst.config);
        this.stateMap.set(def.passId, extracted);
      }
    }

    // Reconcile per-instance customShader passes (register/hot-reload/prune).
    // Preview fires-and-forgets, mirroring ensurePassesRegistered below.
    void this.syncCustomShaders(instances);

    // Check if the set of needed passes changed
    const key = [...neededPassIds].sort().join(',');
    const shapeChanged = key !== this.prevPassKey;
    if (shapeChanged) {
      this.prevPassKey = key;
      // Trigger async registration — the caller is responsible for awaiting
      // if needed (export does; preview fires-and-forgets)
      this.ensurePassesRegistered(neededPassIds);
    }

    // Enable/disable registered passes
    for (const passId of this.registeredPassIds) {
      this.renderGraph.setPassEnabled(passId, neededPassIds.has(passId));
    }

    // Push data-driven layer order (effect-list order → render-graph order).
    this.renderGraph.setPassOrder(this.buildPassOrder(instances));

    return shapeChanged;
  }

  /**
   * Async version of syncFrame for export use.
   * Unlike syncFrame which fire-and-forgets pass registration, this version
   * awaits ensurePassesRegistered so shader compilation completes before
   * the frame renders. This prevents the first frame with new effects
   * from rendering without them.
   */
  async syncFrameAsync(effectsConfig: EffectsConfig | undefined): Promise<boolean> {
    const instances = effectsConfig?.effectInstances ?? [];

    // Determine which passes should be active
    const colorInstances = instances.filter(
      (i) => COLOR_GRADE_TYPES.has(i.type) && i.config.enabled,
    );
    const neededPassIds = new Set<string>();

    if (colorInstances.length > 0) {
      neededPassIds.add(COLOR_GRADE_PASS_ID);
      this.stateMap.set(COLOR_GRADE_PASS_ID, mergeColorGradeState(colorInstances));
    }

    for (const inst of instances) {
      if (!inst.config.enabled) continue;
      if (COLOR_GRADE_TYPES.has(inst.type)) continue;
      if (inst.type === CUSTOM_SHADER_TYPE) {
        neededPassIds.add(customShaderPassId(inst.id));
        continue;
      }
      const def = PASS_DEFS[inst.type];
      if (def) {
        neededPassIds.add(def.passId);
        this.stateMap.set(def.passId, def.extractState(inst.config));
      }
    }

    // Reconcile per-instance customShader passes and AWAIT compilation so they
    // are ready for this export frame (parity with ensurePassesRegistered).
    await this.syncCustomShaders(instances);

    // Check if the set of needed passes changed
    const key = [...neededPassIds].sort().join(',');
    const shapeChanged = key !== this.prevPassKey;

    if (shapeChanged) {
      this.prevPassKey = key;
      // Await registration so passes are ready for this frame
      await this.ensurePassesRegistered(neededPassIds);
    }

    // Enable/disable registered passes
    for (const passId of this.registeredPassIds) {
      this.renderGraph.setPassEnabled(passId, neededPassIds.has(passId));
    }

    // Push data-driven layer order (effect-list order → render-graph order).
    this.renderGraph.setPassOrder(this.buildPassOrder(instances));

    return shapeChanged;
  }

  /**
   * Pre-register all effect passes for a base config (used at export start).
   * Awaits all registrations so they're ready for the first frame.
   */
  async preRegister(baseConfig: EffectsConfig): Promise<void> {
    if (!baseConfig.effectInstances?.length) return;
    const neededPassIds = this.resolveNeededPasses(baseConfig.effectInstances);
    await this.ensurePassesRegistered(neededPassIds);
    // Also sync state so passes are enabled
    this.syncFrame(baseConfig);
  }

  /**
   * Cleanup — unregister all passes from the RenderGraph.
   */
  dispose(): void {
    for (const passId of this.registeredPassIds) {
      this.renderGraph.unregisterPass(passId);
    }
    this.registeredPassIds.clear();
    this.stateMap.clear();
    this.prevPassKey = '';
  }
}

/**
 * BgImageOverlayPass — a secondary background image composited over the primary
 * background (below the lyrics), with:
 *   - audio-reactive opacity (via the shared createARParam envelope),
 *   - an OPTIONAL gate (band > threshold, honoring a cooldown), and
 *   - a choice of fade-in vs pop-to-full when the gate turns the layer on.
 *
 * The overlay image is a SECONDARY texture bound at @binding(3) (+ its sampler
 * at @binding(4)) via the RenderGraph additionalBindings seam. The renderer
 * decodes the user's uploaded image (TextureLoader) and attaches it through
 * renderGraph.setPassExtraBindings(); this pass only declares the layout and
 * fills the uniforms.
 *
 * Determinism: the gate/fade timing uses `params.time` (the media clock) for
 * both live and export, so the gate opens/closes at identical song positions
 * in preview and exported video. `params.didReset` clears the latch on seek.
 */

import type { EffectPassConfig, EffectPassParams } from './RenderGraph';
import { createARParam, type ARParamEnvelope, type AudioReactivePassState } from './EffectPasses';
import type { AudioReactiveConfig } from '@/types/effects/audio-reactive';

export const BG_IMAGE_OVERLAY_PASS_ID = 'gpu-bg-image-overlay';

/**
 * `GPUShaderStage.FRAGMENT` as a plain numeric literal.
 *
 * `GPUShaderStage` is a browser-runtime WebGPU global that does NOT exist at
 * module-evaluation time (SSR / Turbopack evaluates the module graph on the
 * server, where `window`/WebGPU globals are absent). Every other pass in the
 * engine references `GPUShaderStage.*` only INSIDE functions that run in the
 * browser, so they're lazy; this pass declares its bindings in a module-level
 * `const` object, so it must use the spec constant instead of the global to
 * avoid a "GPUShaderStage is not defined" ReferenceError on import.
 * Per the WebGPU spec, GPUShaderStage.FRAGMENT === 0x2.
 */
const SHADER_STAGE_FRAGMENT = 0x2;

/**
 * Shared registry of decoded overlay-image metadata, keyed by the config's
 * `imageAssetId` (the IndexedDB asset key — stable and present in the effect
 * config, unlike the instance id which extractState does not receive). The
 * RENDERER owns decoding (TextureLoader) and writes {ready, w, h} here after
 * the image loads; EffectsManager.extractState reads it so the pass's
 * hasImage/imageW/imageH uniforms reflect the actual bound texture. The
 * texture VIEW itself is attached separately via renderGraph.setPassExtraBindings.
 */
interface OverlayImageMeta {
  ready: boolean;
  width: number;
  height: number;
}
const overlayImageMeta = new Map<string, OverlayImageMeta>();

/** Renderer → pass: publish decoded overlay image metadata for an asset key. */
export function setOverlayImageMeta(assetId: string, meta: OverlayImageMeta | null): void {
  if (meta) overlayImageMeta.set(assetId, meta);
  else overlayImageMeta.delete(assetId);
}

/** Read overlay image metadata for an asset key (defaults to not-ready). */
export function getOverlayImageMeta(assetId: string | undefined): OverlayImageMeta {
  if (!assetId) return { ready: false, width: 1, height: 1 };
  return overlayImageMeta.get(assetId) ?? { ready: false, width: 1, height: 1 };
}

// ─── Fit / blend enum encoding (CPU → uniform) ──────────────────────────────
const FIT_MAP: Record<string, number> = { cover: 0, contain: 1, stretch: 2 };
const BLEND_MAP: Record<string, number> = { normal: 0, additive: 1, screen: 2, multiply: 3 };
const GATE_BAND_TO_AR: Record<string, 'bass' | 'mid' | 'high'> = {
  bass: 'bass',
  mid: 'mid',
  treb: 'high',
};

// ─── Fragment shader ─────────────────────────────────────────────────────────
// binding 0/1/2 = input (background) texture / sampler / uniforms (standard).
// binding 3/4   = overlay image texture / its sampler (additionalBindings).
const BG_IMAGE_OVERLAY_FRAGMENT = /* wgsl */ `
struct Uniforms {
  opacity: f32,        // effective opacity (base * AR * gate/fade), 0..1
  fit: f32,            // 0 cover, 1 contain, 2 stretch
  blendMode: f32,      // 0 normal, 1 additive, 2 screen, 3 multiply
  hasImage: f32,       // 1 if an overlay texture is bound, else 0
  resolution_x: f32,
  resolution_y: f32,
  image_w: f32,        // overlay image pixel size (for aspect-correct fit)
  image_h: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;
@group(0) @binding(3) var overlayTexture: texture_2d<f32>;
@group(0) @binding(4) var overlaySampler: sampler;

fn blendOver(base: vec3f, over: vec3f, mode: f32) -> vec3f {
  if (mode < 0.5) { return over; }                        // normal (src replaces, alpha handles mix)
  else if (mode < 1.5) { return base + over; }            // additive
  else if (mode < 2.5) { return 1.0 - (1.0 - base) * (1.0 - over); } // screen
  else { return base * over; }                            // multiply
}

// Map the fullscreen UV to the overlay image UV honoring the fit mode.
// Returns uv (may be outside [0,1] → treated as no-draw) for cover/contain.
fn fitUV(uv: vec2f) -> vec2f {
  if (u.fit > 1.5) { return uv; } // stretch: fill the frame
  let frameAspect = u.resolution_x / max(u.resolution_y, 1.0);
  let imgAspect = u.image_w / max(u.image_h, 1.0);
  var scale = vec2f(1.0, 1.0);
  // We sample ouv = (uv - 0.5) / scale + 0.5:
  //   scale > 1 on an axis COMPRESSES the sampled range toward center => crop
  //     (the image fills that axis and overflow is cropped) => COVER.
  //   scale < 1 EXPANDS the sampled range past [0,1] => the image shrinks with
  //     empty margins on that axis => letterbox => CONTAIN.
  if (u.fit < 0.5) {
    // cover: fill the frame, cropping the longer axis.
    if (frameAspect > imgAspect) {
      // Frame is wider than the image: match width, crop height (scale.y > 1).
      scale = vec2f(1.0, frameAspect / imgAspect);
    } else {
      // Frame is taller/narrower: match height, crop width (scale.x > 1).
      scale = vec2f(imgAspect / frameAspect, 1.0);
    }
  } else {
    // contain: fit the whole image inside, letterboxing the shorter axis.
    if (frameAspect > imgAspect) {
      // Frame is wider: letterbox left/right (scale.x < 1).
      scale = vec2f(imgAspect / frameAspect, 1.0);
    } else {
      // Frame is taller/narrower: letterbox top/bottom (scale.y < 1).
      scale = vec2f(1.0, frameAspect / imgAspect);
    }
  }
  // Scale around the center.
  return (uv - 0.5) / scale + 0.5;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  if (u.hasImage < 0.5 || u.opacity <= 0.0) {
    return base;
  }
  let ouv = fitUV(input.uv);
  // Outside the image (contain letterbox / cover crop edges) → no overlay.
  if (ouv.x < 0.0 || ouv.x > 1.0 || ouv.y < 0.0 || ouv.y > 1.0) {
    return base;
  }
  let over = textureSampleLevel(overlayTexture, overlaySampler, ouv, 0.0);
  let a = over.a * u.opacity;
  let blended = blendOver(base.rgb, over.rgb, u.blendMode);
  let outRgb = mix(base.rgb, blended, a);
  return vec4f(outRgb, base.a);
}
`;

export const bgImageOverlayPassConfig: EffectPassConfig = {
  id: BG_IMAGE_OVERLAY_PASS_ID,
  label: 'Secondary Image',
  shaderSource: BG_IMAGE_OVERLAY_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 40, // early — a background-layer overlay sits under most post-FX
  additionalBindings: [
    { binding: 3, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 4, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

export interface BgImageOverlayPassState extends AudioReactivePassState {
  opacity: number;
  fit: string;
  blendMode: string;
  /** 1 when the renderer has bound an overlay texture, else 0. */
  hasImage: number;
  /** Overlay image pixel dimensions (for aspect-correct fit). */
  imageW: number;
  imageH: number;
  /** Optional gate. undefined / enabled:false ⇒ always on. */
  gate?: {
    enabled: boolean;
    band: 'bass' | 'mid' | 'treb';
    threshold: number;
    cooldown: number;
    duration: number;
    flash: boolean;
  };
  gateFadeIn: boolean;
  gateAttack: number;
}

/**
 * Gate + fade/flash envelope. Edge-triggered "strike" model:
 *   - A rising edge of the band past `threshold` FIRES the layer, but only if
 *     the cooldown since the last fire has elapsed (cooldown is a re-trigger
 *     LOCK, it does not keep the layer visible).
 *   - Once fired, the layer stays on for `duration` seconds, then turns off.
 *   - While on, opacity is either a steady value (fade-in over gateAttack, or
 *     pop-to-full) or a lightning-style FLASH strobe.
 * Kept stateful (like the AR envelope) so live and export each hold their own
 * latch; timing uses the media clock (params.time) for determinism.
 */
function createGateEnvelope() {
  let firing = false;
  let fireStart = -Infinity; // media-clock seconds when the current strike began
  let lastFireTime = -Infinity; // media-clock seconds of the last fire (for cooldown)
  let prevAbove = false; // band-above-threshold on the previous frame (edge detect)

  return {
    reset() {
      firing = false;
      fireStart = -Infinity;
      lastFireTime = -Infinity;
      prevAbove = false;
    },
    /** Returns a 0..1 gate/fade/flash multiplier for this frame. */
    compute(
      s: BgImageOverlayPassState,
      params: EffectPassParams,
      bandLevel: (b: 'bass' | 'mid' | 'treb') => number,
    ): number {
      if (params.didReset) this.reset();
      const now = params.time;

      // No gate ⇒ always fully on (no fade/flash envelope).
      if (!s.gate || !s.gate.enabled) {
        return 1;
      }

      const level = bandLevel(s.gate.band);
      const above = level >= s.gate.threshold;
      const rising = above && !prevAbove;
      prevAbove = above;

      const duration = Math.max(0.01, s.gate.duration ?? 0.5);
      const cooldown = Math.max(0, s.gate.cooldown ?? 0);

      // End the current strike once its duration has elapsed.
      if (firing && now - fireStart >= duration) {
        firing = false;
      }

      // Fire on a rising edge, gated by the cooldown LOCK (time since last fire).
      // Backward seeks (now < lastFireTime) can't be blocked by a stale lock.
      if (rising && !firing) {
        const lockElapsed = now < lastFireTime || now - lastFireTime >= cooldown;
        if (lockElapsed) {
          firing = true;
          fireStart = now;
          lastFireTime = now;
        }
      }

      if (!firing) return 0;

      const t = now - fireStart;

      // Lightning FLASH: a fast strobe across the strike, brightest at the start
      // and decaying, with a few flickers — reads as a lightning flash rather
      // than a steady image.
      if (s.gate.flash) {
        const phase = duration > 0 ? t / duration : 1;
        // Envelope: sharp attack, exponential-ish decay over the strike.
        const decay = Math.max(0, 1 - phase);
        // Flicker: a couple of hard on/off strobes within the window.
        const strobe = Math.sin(phase * Math.PI * 6) >= -0.2 ? 1 : 0.25;
        return Math.max(0, Math.min(1, decay * strobe));
      }

      // Steady show: fade in over gateAttack, or pop to full.
      if (!s.gateFadeIn || s.gateAttack <= 0) {
        return 1;
      }
      return Math.max(0, Math.min(1, t / s.gateAttack));
    },
  };
}

export function createBgImageOverlayUpdater(getState: () => BgImageOverlayPassState) {
  const opacityEnv: ARParamEnvelope = createARParam();
  const gateEnv = createGateEnvelope();

  return (uniforms: Float32Array, params: EffectPassParams) => {
    const s = getState();

    const arCfg = s.audioReactive?.opacity as AudioReactiveConfig | undefined;
    const arOpacity = opacityEnv.compute(s.opacity ?? 1, arCfg, params);

    const bandLevel = (b: 'bass' | 'mid' | 'treb'): number => {
      const key = GATE_BAND_TO_AR[b] ?? 'bass';
      if (key === 'bass') return params.audioBass;
      if (key === 'mid') return params.audioMid;
      return params.audioHigh;
    };
    const gateMul = gateEnv.compute(s, params, bandLevel);

    const effectiveOpacity = Math.max(0, Math.min(1, arOpacity * gateMul));

    uniforms[0] = effectiveOpacity;
    uniforms[1] = FIT_MAP[s.fit] ?? 0;
    uniforms[2] = BLEND_MAP[s.blendMode] ?? 0;
    uniforms[3] = s.hasImage ? 1 : 0;
    uniforms[4] = params.resolution[0];
    uniforms[5] = params.resolution[1];
    uniforms[6] = s.imageW || 1;
    uniforms[7] = s.imageH || 1;
  };
}

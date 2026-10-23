/**
 * Effect Instance Factory Functions
 * Creates new EffectInstance objects with sensible defaults.
 */

import type { EffectInstance, EffectType } from './effect-instances';
import { DEFAULT_GLSL_GUEST_CONFIG } from './effect-instances';
import {
  DEFAULT_PARTICLES_CONFIG,
  DEFAULT_RAIN_CONFIG,
  DEFAULT_POST_PROCESSING_CONFIG,
  DEFAULT_VISUALIZER_CONFIG,
  DEFAULT_SHADER_OVERLAY_CONFIG,
} from './defaults';
import { DEFAULT_MILKDROP_CONFIG } from './milkdrop';
import { DEFAULT_BUTTERCHURN_CONFIG } from './butterchurn';

function makeId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Create a new enabled EffectInstance with defaults for the given type */
export function createDefaultInstance(type: EffectType): EffectInstance {
  const id = makeId();

  switch (type) {
    case 'particles':
      return { id, type, config: { ...DEFAULT_PARTICLES_CONFIG, enabled: true } };

    case 'rain':
      return { id, type, config: { ...DEFAULT_RAIN_CONFIG, enabled: true } };

    case 'visualizer':
      return { id, type, config: { ...DEFAULT_VISUALIZER_CONFIG, enabled: true } };

    case 'shaderFx':
      return {
        id,
        type,
        config: {
          enabled: true,
          mode: 'shader' as const,
          shader: { ...DEFAULT_SHADER_OVERLAY_CONFIG, enabled: true },
          feedback: { ...DEFAULT_MILKDROP_CONFIG, enabled: true },
          butterchurn: { ...DEFAULT_BUTTERCHURN_CONFIG, enabled: true },
          littlejs: { enabled: true, sceneId: 'rpgCombat' },
          glsl: { ...DEFAULT_GLSL_GUEST_CONFIG },
        },
      };

    case 'butterchurn':
      return { id, type, config: { ...DEFAULT_BUTTERCHURN_CONFIG, enabled: true } };

    case 'bloom':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.bloom, enabled: true } };

    case 'chromaticAberration':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.chromaticAberration, enabled: true },
      };

    case 'glitch':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.glitch, enabled: true } };

    case 'vhsTracking':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.vhsTracking, enabled: true },
      };

    case 'oldFilm':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.oldFilm, enabled: true } };

    case 'bulbFlicker':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.bulbFlicker, enabled: true },
      };

    case 'gateJitter':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.gateJitter, enabled: true },
      };

    case 'sepia':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.sepia, enabled: true } };

    case 'chainLightning':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.chainLightning, enabled: true },
      };

    case 'distortion':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.distortion, enabled: true },
      };

    case 'starfield':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.starfield, enabled: true },
      };

    case 'zoom':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.zoom, enabled: true } };

    case 'tiling':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.tiling, enabled: true } };

    case 'pixelation':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.pixelation, enabled: true },
      };

    case 'noiseOverlay':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.noiseOverlay, enabled: true },
      };

    case 'slide':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.slide, enabled: true } };

    case 'rotate':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.rotate, enabled: true } };

    case 'brightness':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.brightness, enabled: true },
      };

    case 'contrast':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.contrast, enabled: true },
      };

    case 'saturation':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.saturation, enabled: true },
      };

    case 'hueShift':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.hueShift, enabled: true },
      };

    case 'lut':
      return { id, type, config: { ...DEFAULT_POST_PROCESSING_CONFIG.lut, enabled: true } };

    case 'motionBlur':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.motionBlur, enabled: true },
      };

    case 'lensFlare':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.lensFlare, enabled: true },
      };

    case 'cameraShake':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.cameraShake, enabled: true },
      };

    case 'bgOpacity':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.bgOpacity, enabled: true },
      };

    case 'bgBlur':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.bgBlur, enabled: true },
      };

    case 'bgImageOverlay':
      return {
        id,
        type,
        config: { ...DEFAULT_POST_PROCESSING_CONFIG.bgImageOverlay, enabled: true },
      };

    case 'customShader':
      return {
        id,
        type,
        config: {
          enabled: true,
          // Working starter transform: a color-tint that samples the layer
          // beneath (inputTexture/inputSampler) and multiplies by the params.
          // Mirrors the tpl-color-tint body in ShaderInjector's SHADER_TEMPLATES.
          // The uniform struct's leading fields match `params` (declaration
          // order); ShaderInjector packs `time` after them and pads to 16 bytes.
          source: `struct Uniforms {
  tint_r: f32,
  tint_g: f32,
  tint_b: f32,
  intensity: f32,
  time: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: Uniforms;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let tint = vec3f(params.tint_r, params.tint_g, params.tint_b);
  let tinted = mix(color.rgb, color.rgb * tint, params.intensity);
  return vec4f(tinted, color.a);
}`,
          params: [
            { name: 'tint_r', value: 1.0, min: 0, max: 2 },
            { name: 'tint_g', value: 0.6, min: 0, max: 2 },
            { name: 'tint_b', value: 0.9, min: 0, max: 2 },
            { name: 'intensity', value: 1.0, min: 0, max: 1 },
          ],
        },
      };

    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown effect type: ${_exhaustive}`);
    }
  }
}

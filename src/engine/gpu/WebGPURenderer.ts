/**
 * WebGPURenderer — Native WebGPU rendering engine.
 *
 * Replaces R3F/Three.js. Provides a clean, deterministic render pipeline:
 *   clear → background (solid/image) → present
 *
 * Mirrors the Python renderer's SceneRenderer architecture.
 * No React dependency — pure TypeScript class.
 */

import {
  TextureLoader,
  type LoadedTexture,
  type LoadedVideoTexture,
  isVideoUrl,
} from './TextureLoader';
import { RenderGraph, type EffectPassParams } from './RenderGraph';
import { LyricCompositePass } from './LyricCompositePass';
import { LyricFXGraph } from './lyricfx/LyricFXGraph';
import type { LyricFXFrameParams } from '@/types/effects/lyric-fx';
import { BackgroundBlurPass } from './BackgroundBlurPass';
import type { ShaderOverlayConfig } from './ShaderOverlayPass';
import { ShaderLayerRegistry, type ShaderLayerInput } from './ShaderLayerRegistry';
import { GLSLGuestManager } from './glsl/GLSLGuestManager';
import { guestAudioFromStore } from './glsl/audioTexture';
import type { GLSLGuestSource } from './glsl/types';
import { MilkdropChain } from './milkdrop/MilkdropChain';
import { VISUALIZER_PRESETS } from './milkdrop/presets';
import { LiveAudioTable } from './milkdrop/LiveAudioTable';
import type { MilkdropConfig } from '@/types/effects/milkdrop';
import { BG_IMAGE_OVERLAY_PASS_ID, setOverlayImageMeta } from './BgImageOverlayPass';
import { loadEffectImageBlob } from '@/engine/gpu/effectImageAssets';
import type { EffectsConfig } from '@/types/effects';

// ---------------------------------------------------------------------------
// Inline WGSL shader (avoids bundler config for .wgsl imports)
// ---------------------------------------------------------------------------
const BACKGROUND_WGSL = /* wgsl */ `
struct Uniforms {
  bgColor: vec4f,        // 16 bytes (offset 0)
  brightness: f32,       // 4 bytes (offset 16)
  globalScale: f32,      // 4 bytes (offset 20)
  globalOffsetX: f32,    // 4 bytes (offset 24)
  globalOffsetY: f32,    // 4 bytes (offset 28)
  hasTexture: f32,       // 4 bytes (offset 32)
  blendMode: f32,        // 4 bytes (offset 36) (0 = Over, 1 = Additive/Crossfade)
  angle: f32,            // 4 bytes (offset 40)
  tiling: f32,           // 4 bytes (offset 44)
  uvScale1: vec2f,       // 8 bytes (offset 48)
  uvScale2: vec2f,       // 8 bytes (offset 56)
  opacity1: f32,         // 4 bytes (offset 64)
  scale1: f32,           // 4 bytes (offset 68)
  offsetX1: f32,         // 4 bytes (offset 72)
  offsetY1: f32,         // 4 bytes (offset 76)
  opacity2: f32,         // 4 bytes (offset 80)
  scale2: f32,           // 4 bytes (offset 84)
  offsetX2: f32,         // 4 bytes (offset 88)
  offsetY2: f32,         // 4 bytes (offset 92)
  contrast: f32,         // 4 bytes (offset 96)
  blur: f32,             // 4 bytes (offset 100)
  blurType: u32,         // 4 bytes (offset 104) 0=box 1=gaussian 2=radial 3=directional
  padding2: f32,         // 4 bytes (offset 108)
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var bgTexture1: texture_2d<f32>;
@group(0) @binding(2) var bgTexture2: texture_2d<f32>;
@group(0) @binding(3) var bgSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var out: VertexOutput;
  out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  out.uv = uv[vertexIndex];
  return out;
}

// blurType: 0=box, 1=gaussian, 2=radial, 3=directional-H
fn sampleBlurred(tex: texture_2d<f32>, samp: sampler, uv: vec2f, blur: f32, blurType: u32) -> vec4f {
  if (blur <= 0.0) { return textureSampleLevel(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0); }
  let o = 0.005 * blur;
  if (blurType == 1u) {
    // Gaussian: weighted 9-tap
    let w0 = 0.204; let w1 = 0.180; let w2 = 0.102;
    var c = textureSampleLevel(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0) * w0;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o, 0.0),   vec2f(0.0), vec2f(1.0)), 0.0) * w1;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o, 0.0),  vec2f(0.0), vec2f(1.0)), 0.0) * w1;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(0.0, o),   vec2f(0.0), vec2f(1.0)), 0.0) * w1;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(0.0, -o),  vec2f(0.0), vec2f(1.0)), 0.0) * w1;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o, o),     vec2f(0.0), vec2f(1.0)), 0.0) * w2;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o, o),    vec2f(0.0), vec2f(1.0)), 0.0) * w2;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o, -o),    vec2f(0.0), vec2f(1.0)), 0.0) * w2;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o, -o),   vec2f(0.0), vec2f(1.0)), 0.0) * w2;
    return c;
  } else if (blurType == 2u) {
    // Radial: 8 taps in a circle
    var c = textureSampleLevel(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
    let sqrt2_inv = 0.7071;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o, 0.0),              vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o, 0.0),             vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(0.0, o),              vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(0.0, -o),             vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o*sqrt2_inv, o*sqrt2_inv),   vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o*sqrt2_inv, o*sqrt2_inv),  vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o*sqrt2_inv, -o*sqrt2_inv),  vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o*sqrt2_inv, -o*sqrt2_inv), vec2f(0.0), vec2f(1.0)), 0.0);
    return c * 0.111;
  } else if (blurType == 3u) {
    // Directional-H: horizontal only
    var c = textureSampleLevel(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0) * 0.4;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o, 0.0),   vec2f(0.0), vec2f(1.0)), 0.0) * 0.3;
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o, 0.0),  vec2f(0.0), vec2f(1.0)), 0.0) * 0.3;
    return c;
  } else {
    // Box (default): uniform 5-tap
    var c = textureSampleLevel(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(o, 0.0),  vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(-o, 0.0), vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(0.0, o),  vec2f(0.0), vec2f(1.0)), 0.0);
    c += textureSampleLevel(tex, samp, clamp(uv + vec2f(0.0, -o), vec2f(0.0), vec2f(1.0)), 0.0);
    return c * 0.2;
  }
}

fn sampleBlurredWrap(tex: texture_2d<f32>, samp: sampler, uv: vec2f, blur: f32, blurType: u32) -> vec4f {
  if (blur <= 0.0) { return textureSampleLevel(tex, samp, fract(uv), 0.0); }
  let o = 0.005 * blur;
  var c = textureSampleLevel(tex, samp, fract(uv), 0.0);
  c += textureSampleLevel(tex, samp, fract(uv + vec2f(o, 0.0)),  0.0);
  c += textureSampleLevel(tex, samp, fract(uv + vec2f(-o, 0.0)), 0.0);
  c += textureSampleLevel(tex, samp, fract(uv + vec2f(0.0, o)),  0.0);
  c += textureSampleLevel(tex, samp, fract(uv + vec2f(0.0, -o)), 0.0);
  return c * 0.2;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  if (u.hasTexture < 0.5) {
    let bg = u.bgColor.rgb * u.brightness;
    let contrastAdjusted = (bg - 0.5) * u.contrast + 0.5;
    return vec4f(clamp(contrastAdjusted, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  var uv = input.uv;
  uv = uv - vec2f(0.5);
  let c = cos(u.angle);
  let s = sin(u.angle);
  uv = vec2f(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
  let safeGlobalScale = max(u.globalScale, 0.001);
  uv = uv / safeGlobalScale;

  let safeScale1 = max(u.scale1, 0.001);
  var uv1 = (uv / safeScale1) * u.uvScale1 + vec2f(0.5) + vec2f(u.globalOffsetX - u.offsetX1, u.globalOffsetY - u.offsetY1);
  let safeScale2 = max(u.scale2, 0.001);
  var uv2 = (uv / safeScale2) * u.uvScale2 + vec2f(0.5) + vec2f(u.globalOffsetX - u.offsetX2, u.globalOffsetY - u.offsetY2);

  var finalColor: vec3f;

  if (u.tiling > 0.5) {
    // Tiling mode: image wraps — always fully covers the canvas.
    let c1 = sampleBlurredWrap(bgTexture1, bgSampler, uv1, u.blur, u.blurType).rgb;
    let c2 = sampleBlurredWrap(bgTexture2, bgSampler, uv2, u.blur, u.blurType).rgb;
    if (u.blendMode > 0.5) {
      // Additive/Crossfade: sum of weighted images, blended against bgColor for the unfilled fraction
      finalColor = clamp(c1 * u.opacity1 + c2 * u.opacity2, vec3f(0.0), vec3f(1.0));
      let totalOp = clamp(u.opacity1 + u.opacity2, 0.0, 1.0);
      finalColor = mix(u.bgColor.rgb, finalColor, totalOp);
    } else {
      // Over: layer2 on top of layer1, both on top of bgColor.
      // bgColor is the backdrop; it shows only where opacity is < 1.
      let behind = mix(u.bgColor.rgb, c1, clamp(u.opacity1, 0.0, 1.0));
      finalColor = mix(behind, c2, clamp(u.opacity2, 0.0, 1.0));
    }
  } else {
    // Non-tiling: compute per-pixel coverage.
    // inBounds is 1.0 inside the image footprint, 0.0 outside (letterbox areas).
    let inBounds1 = step(0.0, uv1.x) * step(uv1.x, 1.0) * step(0.0, uv1.y) * step(uv1.y, 1.0);
    let inBounds2 = step(0.0, uv2.x) * step(uv2.x, 1.0) * step(0.0, uv2.y) * step(uv2.y, 1.0);

    let img1 = sampleBlurred(bgTexture1, bgSampler, uv1, u.blur, u.blurType).rgb;
    let img2 = sampleBlurred(bgTexture2, bgSampler, uv2, u.blur, u.blurType).rgb;

    // coverage = inBounds * userOpacity.
    // bgColor is the backdrop; it shows wherever coverage < 1 (letterbox OR faded image).
    // This keeps bgColor strictly BEHIND the image — it never tints in-bounds pixels
    // when userOpacity = 1 (inBounds * 1.0 = 1.0 → pure image).
    let cov1 = inBounds1 * clamp(u.opacity1, 0.0, 1.0);
    let cov2 = inBounds2 * clamp(u.opacity2, 0.0, 1.0);

    if (u.blendMode > 0.5) {
      // Additive/Crossfade blend on top of bgColor
      let summed = clamp(img1 * cov1 + img2 * cov2, vec3f(0.0), vec3f(1.0));
      let totalCov = clamp(cov1 + cov2, 0.0, 1.0);
      finalColor = mix(u.bgColor.rgb, summed, totalCov);
    } else {
      // Over blend: image1 as base, image2 on top, bgColor as backdrop.
      let behind = mix(u.bgColor.rgb, img1, cov1);
      finalColor = mix(behind, img2, cov2);
    }
  }

  let rgb = finalColor * u.brightness;
  let contrastAdjusted = (rgb - 0.5) * u.contrast + 0.5;
  return vec4f(clamp(contrastAdjusted, vec3f(0.0), vec3f(1.0)), 1.0);
}

`;

// ---------------------------------------------------------------------------
// Zero-copy video shader — uses texture_external binding type
// When supported, importExternalTexture() lets the browser share the video
// decoder's output buffer directly with WebGPU (no pixel copy).
// ---------------------------------------------------------------------------

const BACKGROUND_EXTERNAL_VIDEO_WGSL = /* wgsl */ `
struct Uniforms {
  bgColor: vec4f,        // 16 bytes (offset 0)
  brightness: f32,       // 4 bytes (offset 16)
  globalScale: f32,      // 4 bytes (offset 20)
  globalOffsetX: f32,    // 4 bytes (offset 24)
  globalOffsetY: f32,    // 4 bytes (offset 28)
  hasTexture: f32,       // 4 bytes (offset 32)
  blendMode: f32,        // 4 bytes (offset 36) (0 = Over, 1 = Additive/Crossfade)
  angle: f32,            // 4 bytes (offset 40)
  tiling: f32,           // 4 bytes (offset 44)
  uvScale1: vec2f,       // 8 bytes (offset 48)
  uvScale2: vec2f,       // 8 bytes (offset 56)
  opacity1: f32,         // 4 bytes (offset 64)
  scale1: f32,           // 4 bytes (offset 68)
  offsetX1: f32,         // 4 bytes (offset 72)
  offsetY1: f32,         // 4 bytes (offset 76)
  opacity2: f32,         // 4 bytes (offset 80)
  scale2: f32,           // 4 bytes (offset 84)
  offsetX2: f32,         // 4 bytes (offset 88)
  offsetY2: f32,         // 4 bytes (offset 92)
  contrast: f32,         // 4 bytes (offset 96)
  blur: f32,             // 4 bytes (offset 100)
  padding1: f32,         // 4 bytes (offset 104) -> ensure it aligns to 16 bytes. Structure is 112 bytes total.
  padding2: f32,         // 4 bytes (offset 108)
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var bgVideo: texture_external;
@group(0) @binding(2) var bgSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var out: VertexOutput;
  out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  out.uv = uv[vertexIndex];
  return out;
}

fn sampleBlurredVideo(tex: texture_external, samp: sampler, uv: vec2f, blur: f32) -> vec4f {
  if (blur <= 0.0) { return textureSampleBaseClampToEdge(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0))); }
  let o = 0.005 * blur;
  var c = textureSampleBaseClampToEdge(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)));
  c += textureSampleBaseClampToEdge(tex, samp, clamp(uv + vec2f(o, 0.0), vec2f(0.0), vec2f(1.0)));
  c += textureSampleBaseClampToEdge(tex, samp, clamp(uv + vec2f(-o, 0.0), vec2f(0.0), vec2f(1.0)));
  c += textureSampleBaseClampToEdge(tex, samp, clamp(uv + vec2f(0.0, o), vec2f(0.0), vec2f(1.0)));
  c += textureSampleBaseClampToEdge(tex, samp, clamp(uv + vec2f(0.0, -o), vec2f(0.0), vec2f(1.0)));
  return c * 0.2;
}

fn sampleBlurredVideoWrap(tex: texture_external, samp: sampler, uv: vec2f, blur: f32) -> vec4f {
  if (blur <= 0.0) { return textureSampleBaseClampToEdge(tex, samp, fract(uv)); }
  let o = 0.005 * blur;
  var c = textureSampleBaseClampToEdge(tex, samp, fract(uv));
  c += textureSampleBaseClampToEdge(tex, samp, fract(uv + vec2f(o, 0.0)));
  c += textureSampleBaseClampToEdge(tex, samp, fract(uv + vec2f(-o, 0.0)));
  c += textureSampleBaseClampToEdge(tex, samp, fract(uv + vec2f(0.0, o)));
  c += textureSampleBaseClampToEdge(tex, samp, fract(uv + vec2f(0.0, -o)));
  return c * 0.2;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  if (u.hasTexture < 0.5) {
    let bg = u.bgColor.rgb * u.brightness;
    let contrastAdjusted = (bg - 0.5) * u.contrast + 0.5;
    return vec4f(clamp(contrastAdjusted, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  var uv = input.uv;
  uv = uv - vec2f(0.5);
  let c = cos(u.angle);
  let s = sin(u.angle);
  uv = vec2f(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
  let safeGlobalScale = max(u.globalScale, 0.001);
  uv = uv / safeGlobalScale;

  let safeScale1 = max(u.scale1, 0.001);
  var uv1 = (uv / safeScale1) * u.uvScale1 + vec2f(0.5) + vec2f(u.globalOffsetX - u.offsetX1, u.globalOffsetY - u.offsetY1);

  // External video implies no secondary texture/transition (hasTexture=1, mixRatio=0)
  var color1: vec4f;
  if (u.tiling > 0.5) {
    color1 = sampleBlurredVideoWrap(bgVideo, bgSampler, uv1, u.blur);
  } else {
    let inBounds1 = step(0.0, uv1.x) * step(uv1.x, 1.0) * step(0.0, uv1.y) * step(uv1.y, 1.0);
    let sample = sampleBlurredVideo(bgVideo, bgSampler, uv1, u.blur);
    color1 = vec4f(mix(u.bgColor.rgb, sample.rgb, inBounds1), 1.0);
  }
  
  let rgb = color1.rgb * u.opacity1 * u.brightness;
  let contrastAdjusted = (rgb - 0.5) * u.contrast + 0.5;
  return vec4f(clamp(contrastAdjusted, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrameState {
  time: number;
  /** Total song duration in seconds (used by game scenes for song-progress effects). */
  duration?: number;
  backgroundColor: [number, number, number]; // RGB 0-1
  backgroundBrightness: number;
  backgroundScale: number;
  backgroundOffsetX: number;
  backgroundOffsetY: number;
  backgroundAngle: number;
  backgroundTiling: boolean;
  backgroundFit?: string;
  backgroundContrast?: number;
  backgroundBlur?: number;
  /** 0=box, 1=gaussian, 2=radial, 3=directional */
  backgroundBlurType?: number;
  /** Overall image opacity (0–1). Applied to opacity1 when not in crossfade mode. */
  backgroundOpacity?: number;
  // Audio data (for future audio-reactive features)
  audioBass: number;
  audioMid: number;
  audioHigh: number;
  audioEnergy: number;
  /** Direct analyser reference for Butterchurn-style raw FFT access */
  audioAnalyser?: AnalyserNode | null;
}

interface WebGPURendererOptions {
  powerPreference?: GPUPowerPreference;
}

// ---------------------------------------------------------------------------
// WebGPURenderer
// ---------------------------------------------------------------------------

export function computeUVScale(
  fit: string,
  cw: number,
  ch: number,
  iw: number,
  ih: number,
): [number, number] {
  if (iw === 0 || ih === 0 || cw === 0 || ch === 0) return [1, 1];
  const ca = cw / ch;
  const ia = iw / ih;
  let scaleX = 1.0;
  let scaleY = 1.0;

  switch (fit) {
    case 'cover':
      if (ca > ia) {
        scaleY = ia / ca;
      } else {
        scaleX = ca / ia;
      }
      break;
    case 'contain':
      if (ca > ia) {
        scaleX = ca / ia;
      } else {
        scaleY = ia / ca;
      }
      break;
    case 'fitWidth':
      scaleY = ia / ca;
      break;
    case 'fitHeight':
      scaleX = ca / ia;
      break;
    case 'original':
      scaleX = cw / iw;
      scaleY = ch / ih;
      break;
    case 'stretch':
    case 'manual':
    default:
      scaleX = 1.0;
      scaleY = 1.0;
      break;
  }
  return [scaleX, scaleY];
}

export class WebGPURenderer {
  // Core WebGPU objects
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;

  // Pipeline
  private bgPipeline!: GPURenderPipeline;
  private bgUniformBuffer!: GPUBuffer;
  private bgBindGroupLayout!: GPUBindGroupLayout;
  private sampler!: GPUSampler;

  // Multi-pass render graph
  private _renderGraph: RenderGraph | null = null;
  private _bgRenderTarget: GPUTexture | null = null;
  private _bgRenderTargetView: GPUTextureView | null = null;

  // Zero-copy external video pipeline
  private _externalVideoPipeline: GPURenderPipeline | null = null;
  private _externalVideoBindGroupLayout: GPUBindGroupLayout | null = null;
  private _supportsExternalTexture = false;

  // State
  private canvas: HTMLCanvasElement;
  private width = 0;
  private height = 0;
  private _initialized = false;
  private _lastDt = 0;
  private _lastFrameTime = 0;
  private _lastSmoothedTime?: number;
  /** Tracks the previous frame's state.time to detect pause (no change). */
  private _lastInputTime?: number;
  /**
   * Wall-clock (performance.now) timestamp of the last frame at which state.time
   * actually changed. isTimeFrozen debounces off this so the coarse media-clock
   * update rate does not flap the freeze flag during playback (see renderFrame).
   */
  private _lastTimeChangeAt?: number;

  // Lyric compositing
  private _lyricCompositePass: LyricCompositePass | null = null;
  private _pendingLyricBitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null = null;

  // Lyric FX (Stage 3) — GPU per-glyph lyric effect chain. Null unless the app
  // opts into GPU lyric mode by supplying a built graph; when present it
  // renders the glyph buffer + active surface effect into its own target and
  // the composite blends that view instead of the Canvas2D bitmap. Inert by
  // default, so the shipped Canvas2D path is unchanged.
  private _lyricFXGraph: LyricFXGraph | null = null;
  private _lyricFXFrame: LyricFXFrameParams | null = null;
  private _lyricFXActive = false;

  // Layer ordering — when set, the lyric layer can be repositioned relative to
  // the post-FX passes (effects below lyrics distort the background only;
  // effects above lyrics distort background+lyrics). Null = legacy behavior
  // (lyrics composite last, over everything).
  private _layerPassSplit: {
    below: string[];
    above: string[];
    anyAbove: boolean;
  } | null = null;

  // Shader layers (renders between background and post-processing). N instanced
  // shaderFx layers, each with its own preset/palette/audio-routing, owned by a
  // shared registry (also used by the export renderer) so preview/export can't
  // drift. `_shaderLayers` is the ordered set of enabled layers to composite
  // this frame (front-to-back == array order).
  private _shaderLayerRegistry: ShaderLayerRegistry | null = null;
  private _shaderLayers: ShaderLayerInput[] = [];

  // ── GLSL guest layers (Stage 3a) ──
  // One manager owns the shared WebGL2 host + per-guest GPU textures + compositor.
  // `_glslLayers` is the ordered set of enabled GLSL guests to composite this
  // frame (composited after the shader overlay, at their stack position).
  private _glslGuestManager: GLSLGuestManager | null = null;
  private _glslLayers: GLSLGuestSource[] = [];

  // ── Milkdrop chain ──
  private _milkdropChain: MilkdropChain | null = null;
  private _milkdropConfig: MilkdropConfig | null = null;
  private _milkdropPresetId: string | null = null;
  private _milkdropFrame = 0;
  private _milkdropAudio: LiveAudioTable | null = null;
  private _milkdropFFTBuffer: Uint8Array<ArrayBuffer> | null = null;

  // ── Butterchurn ──
  private _butterchurnRenderer:
    | import('./butterchurn/ButterchurnRenderer').ButterchurnRenderer
    | null = null;
  private _butterchurnConfig: import('@/types/effects/butterchurn').ButterchurnConfig | null = null;
  private _butterchurnTexture: GPUTexture | null = null;

  // Universal background blur pass — blurs the composited background layer
  // (image/video/butterchurn/game-scene/shader/milkdrop) uniformly, since the
  // per-image blur in bgPipeline is skipped for external-canvas sources.
  private _bgBlurPass: BackgroundBlurPass | null = null;
  private _butterchurnInitializing = false;
  // Set when Butterchurn init failed (no WebGL2, context limit, OOM). Stops the
  // render loop retrying — and leaking a hidden canvas + WebGL context — every
  // frame. Cleared when the effect is disabled so re-enabling it retries.
  private _butterchurnFailed = false;
  private _butterchurnLastRenderTime = 0;
  // Warn-once guard so a per-frame butterchurn copy failure surfaces in the
  // console instead of silently blanking the visualizer forever.
  private _bcCopyWarned = false;
  private _bcOpacityCanvas: OffscreenCanvas | null = null;
  // Butterchurn composite pipeline — blends butterchurn texture over background with opacity
  private _bcCompositePipeline: GPURenderPipeline | null = null;
  private _bcCompositeBindGroupLayout: GPUBindGroupLayout | null = null;
  private _bcCompositeUniformBuffer: GPUBuffer | null = null;
  private _bcCompositeSampler: GPUSampler | null = null;

  // ── Secondary background image overlay (bgImageOverlay effect) ──
  // The overlay pass declares texture(3)+sampler(4) additionalBindings; the
  // renderer decodes the user's IndexedDB image and attaches it via
  // renderGraph.setPassExtraBindings. A 1x1 placeholder is bound whenever the
  // pass is present so the bind group is always valid (the shader ignores it
  // via hasImage=0 until a real image is ready).
  private _overlayAssetId: string | null = null;
  private _overlayLoadedTexture: LoadedTexture | null = null;
  private _overlaySampler: GPUSampler | null = null;
  private _overlayPlaceholder: LoadedTexture | null = null;
  private _overlayPlaceholderAttached = false;
  /**
   * The RenderGraph the overlay texture/placeholder bindings are currently
   * attached to. On an aspect change the renderer (and its graph) is rebuilt;
   * if this doesn't match the live `_renderGraph`, the bindings must be
   * re-applied to the new graph even when the asset id is unchanged.
   */
  private _overlayBoundGraph: RenderGraph | null = null;
  /** Monotonic token so a stale in-flight decode can't clobber a newer one. */
  private _overlayDecodeToken = 0;

  /** Get the underlying canvas element (needed for export frame capture). */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Wait for all submitted GPU work to complete. Call before reading pixels/capturing. */
  async waitForGPU(): Promise<void> {
    if (!this._initialized) return;
    await this.device.queue.onSubmittedWorkDone();
  }

  /**
   * Called when the GPU device is lost for any reason other than our own
   * destroy(). The renderer is unusable afterwards; the owner (GPUCanvas)
   * re-creates it or demotes to the fallback stage.
   */
  onDeviceLost: ((info: GPUDeviceLostInfo) => void) | null = null;
  private _disposed = false;

  /** Get the render graph for registering GPU effect passes. */
  getRenderGraph(): RenderGraph | null {
    return this._renderGraph;
  }

  /** Get the GPU device (for external use, e.g. render graph pass registration). */
  getDevice(): GPUDevice | null {
    return this._initialized ? this.device : null;
  }

  /** Get the texture format. */
  getFormat(): GPUTextureFormat {
    return this.format;
  }

  /** Get the primary video element (if any) for reading playback state. */
  getPrimaryVideoElement(): HTMLVideoElement | null {
    return this._backgroundVideo?.video ?? null;
  }

  /** Get the secondary video element (if any) for reading playback state during transitions. */
  getSecondaryVideoElement(): HTMLVideoElement | null {
    return this._backgroundVideo2?.video ?? null;
  }

  // Texture management
  textureLoader!: TextureLoader;
  private placeholderTexture!: LoadedTexture;
  private _backgroundTexture1: LoadedTexture | null = null;
  private _backgroundTexture2: LoadedTexture | null = null;
  private _backgroundUrl1: string | null = null;
  private _backgroundUrl2: string | null = null;
  private _backgroundType1: 'image' | 'video' = 'image';
  private _backgroundType2: 'image' | 'video' = 'image';
  private _backgroundVideo: LoadedVideoTexture | null = null;
  private _backgroundVideo2: LoadedVideoTexture | null = null;
  private _bgMixRatio: number = 0;

  // Transition visuals pushed per-frame by Exporter/StateMachine
  private _bgOpacity1: number = 1.0;
  private _bgScale1: number = 1.0;
  private _bgOffsetX1: number = 0.0;
  private _bgOffsetY1: number = 0.0;
  private _bgOpacity2: number = 0.0;
  private _bgScale2: number = 1.0;
  private _bgOffsetX2: number = 0.0;
  private _bgOffsetY2: number = 0.0;
  private _bgBlendMode: number = 0; // 0 = Over, 1 = Additive

  private _bgBindGroup: GPUBindGroup | null = null;
  private _bgBindGroupDirty = true;
  private _options: WebGPURendererOptions;

  constructor(canvas: HTMLCanvasElement, options: WebGPURendererOptions = {}) {
    this.canvas = canvas;
    this._options = options;
  }

  /**
   * Initialize the renderer. Must be called before rendering.
   * Requests adapter/device, configures context, builds pipelines.
   */
  async init(): Promise<boolean> {
    if (this._initialized) return true;

    // This specific renderer is Native WebGPU ONLY.

    const gpu = navigator.gpu;
    if (!gpu) {
      console.error('[WebGPURenderer] WebGPU not supported in this browser.');
      return false;
    }

    const { requestHighPerformanceAdapter } = await import('./webgpu-support');
    const adapter = await requestHighPerformanceAdapter('WebGPURenderer');

    if (!adapter) {
      console.error('[WebGPURenderer] No WebGPU adapter found.');
      return false;
    }

    // Request the adapter's max 2D texture dimension so large export
    // resolutions (notably portrait 4K = 7560×13440) fit. The default device
    // limit is 8192, which a 13440-tall portrait target exceeds, causing every
    // render-target texture to fail creation and the canvas to render black.
    // Most desktop adapters advertise 16384; fall back to the default if not.
    const maxDim = adapter.limits?.maxTextureDimension2D ?? 8192;
    this.device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: maxDim },
    });
    this.device.lost.then((info) => {
      // 'destroyed' = we tore it down on purpose. Anything else (driver reset,
      // GPU process crash, mobile memory pressure) lets the owner recover.
      if (info.reason === 'destroyed' || this._disposed) return;
      console.error('[WebGPURenderer] Device lost:', info.reason, info.message);
      this.onDeviceLost?.(info);
    });

    // Configure canvas context
    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });

    // Initialize texture loader
    this.textureLoader = new TextureLoader(this.device);
    this.placeholderTexture = this.textureLoader.createPlaceholder(0, 0, 0, 255);

    // Build rendering pipelines (async to await shader compilation)
    const ok = await this._buildBackgroundPipeline();
    if (!ok) {
      console.error('[WebGPURenderer] Failed to build background pipeline.');
      return false;
    }

    // Set initial size from canvas
    this.resize(this.canvas.width, this.canvas.height);

    // Initialize the multi-pass render graph
    this._renderGraph = new RenderGraph(this.device, this.format);
    // A fresh graph has no passes and no extra bindings. Any prior overlay
    // attach-state belonged to the OLD graph, so reset it — otherwise
    // syncOverlayImage would early-return (assetId unchanged, placeholder
    // "already attached") and never attach the overlay texture/placeholder to
    // this new graph, silently dropping the secondary image on reload.
    this._overlayPlaceholderAttached = false;
    this._overlayAssetId = null;
    this._overlayLoadedTexture = null;
    const graphOk = await this._renderGraph.init(Math.max(this.width, 1), Math.max(this.height, 1));
    if (!graphOk) {
      console.warn('[WebGPURenderer] RenderGraph init failed — effects will be unavailable.');
      this._renderGraph = null;
    }

    this._initialized = true;
    this._lastFrameTime = performance.now();

    // Attempt to build the zero-copy external video pipeline
    this._supportsExternalTexture = this.textureLoader.supportsExternalTexture();
    if (this._supportsExternalTexture) {
      const extOk = await this._buildExternalVideoPipeline();
      if (!extOk) {
        console.warn(
          '[WebGPURenderer] External video pipeline compilation failed — using copy-based fallback.',
        );
        this._supportsExternalTexture = false;
      }
    }

    return true;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  // ───────────────────────────────────────────────────────────
  // Pipeline construction
  // ───────────────────────────────────────────────────────────

  private async _buildBackgroundPipeline(): Promise<boolean> {
    const shaderModule = this.device.createShaderModule({
      label: 'background-shader',
      code: BACKGROUND_WGSL,
    });

    // Await shader compilation to catch errors early
    const compilationInfo = await shaderModule.getCompilationInfo();
    let hasErrors = false;
    for (const msg of compilationInfo.messages) {
      const logFn = msg.type === 'error' ? console.error : console.warn;
      logFn(
        `[WebGPURenderer] Shader ${msg.type}: ${msg.message} (line ${msg.lineNum}:${msg.linePos})`,
      );
      if (msg.type === 'error') hasErrors = true;
    }
    if (hasErrors) {
      console.error('[WebGPURenderer] Shader has compilation errors, aborting pipeline creation.');
      return false;
    }

    // Bind group layout: uniform buffer + texture + sampler
    this.bgBindGroupLayout = this.device.createBindGroupLayout({
      label: 'bg-bind-group-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'bg-pipeline-layout',
      bindGroupLayouts: [this.bgBindGroupLayout],
    });

    try {
      this.bgPipeline = await this.device.createRenderPipelineAsync({
        label: 'background-pipeline',
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_main',
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.format }],
        },
        primitive: {
          topology: 'triangle-list',
        },
      });
    } catch (err) {
      console.error('[WebGPURenderer] Pipeline creation failed:', err);
      return false;
    }

    // Uniform buffer — 112 bytes (28 x f32):
    // Documented in BACKGROUND_WGSL struct Uniforms description
    this.bgUniformBuffer = this.device.createBuffer({
      label: 'bg-uniforms',
      size: 112, // 28 * 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Sampler
    this.sampler = this.device.createSampler({
      label: 'bg-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    return true;
  }

  // ───────────────────────────────────────────────────────────
  // Background texture
  // ───────────────────────────────────────────────────────────
  /**
   * Set the primary background, and optionally a secondary one with a mix ratio.
   * Passing null falls back to the solid background color.
   *
   * @param type1 - Media type of url1 ('image' or 'video')
   * @param type2 - Media type of url2 ('image' or 'video')
   */
  async setBackgroundImage(
    url1: string | null,
    url2: string | null = null,
    mixRatio: number = 0,
    type1: 'image' | 'video' = 'image',
    type2: 'image' | 'video' = 'image',
  ): Promise<void> {
    if (!this._initialized || !this.device) return;

    // Immediately update mix ratio so the shader receives it synchronously per-frame.
    this._bgMixRatio = mixRatio;
    this._bgBindGroupDirty = true;

    // ── Texture 1 ─────────────────────────────────────────────────────
    if (url1) {
      if (url1 !== this._backgroundUrl1 || type1 !== this._backgroundType1) {
        // Fast-path: if the new primary was the old secondary, swap textures
        // directly instead of re-loading. This avoids a 1-frame flash when a
        // slideshow transition completes and the URLs swap roles.
        if (url1 === this._backgroundUrl2 && this._backgroundTexture2) {
          this._backgroundTexture1 = this._backgroundTexture2;
          this._backgroundTexture2 = null;
          this._backgroundUrl1 = url1;
          this._backgroundUrl2 = null;
          this._backgroundType1 = type1;
          this._backgroundType2 = 'image';
          // Swap video references too: if texture2 was a video, promote it
          this._backgroundVideo = this._backgroundVideo2;
          this._backgroundVideo2 = null;
          this._bgBindGroupDirty = true;
          // Ensure the promoted video is playing (it was already playing
          // in slot 2 during the transition — do NOT reset currentTime
          // to 0 or the crossfaded portion will replay)
          if (this._backgroundVideo?.video && this._backgroundVideo.video.paused) {
            this._backgroundVideo.video.play().catch(() => {});
          }
        } else {
          this._backgroundUrl1 = url1;
          this._backgroundType1 = type1;
          if (type1 === 'video' || isVideoUrl(url1)) {
            // It's a video
            const v = await this.textureLoader.loadVideoFromUrl(url1);
            if (v && this._backgroundUrl1 === url1) {
              this._backgroundTexture1 = v;
              this._backgroundVideo = v;
              this._bgBindGroupDirty = true;
            } else if (!v) {
              // Load failed — clear URL so next frame can retry
              this._backgroundUrl1 = null;
            }
          } else {
            // It's an image (or unknown — loadFromUrl auto-redirects video blobs)
            this._backgroundVideo = null;
            const tex = await this.textureLoader.loadFromUrl(url1);
            if (tex && this._backgroundUrl1 === url1) {
              this._backgroundTexture1 = tex;
              this._bgBindGroupDirty = true;
              // If loadFromUrl auto-detected a video blob, also track as video for per-frame updates
              if ('video' in tex && tex.video instanceof HTMLVideoElement) {
                this._backgroundVideo = tex as import('./TextureLoader').LoadedVideoTexture;
              }
            } else if (!tex) {
              this._backgroundUrl1 = null;
            }
          }
        }
      }
    } else {
      this._backgroundTexture1 = null;
      this._backgroundVideo = null;
      this._backgroundUrl1 = null;
      this._backgroundType1 = 'image';
    }

    // ── Texture 2 ─────────────────────────────────────────────────────
    if (url2) {
      if (url2 !== this._backgroundUrl2 || type2 !== this._backgroundType2) {
        this._backgroundUrl2 = url2;
        this._backgroundType2 = type2;
        if (type2 === 'video' || isVideoUrl(url2)) {
          // It's a video — load via video pipeline
          const v = await this.textureLoader.loadVideoFromUrl(url2);
          if (v && this._backgroundUrl2 === url2) {
            this._backgroundTexture2 = v;
            this._backgroundVideo2 = v;
            this._bgBindGroupDirty = true;
          } else if (!v) {
            // Load failed — clear URL so next frame can retry
            this._backgroundUrl2 = null;
          }
        } else {
          // It's an image (or unknown — loadFromUrl auto-redirects video blobs)
          this._backgroundVideo2 = null;
          const tex = await this.textureLoader.loadFromUrl(url2);
          if (tex && this._backgroundUrl2 === url2) {
            this._backgroundTexture2 = tex;
            this._bgBindGroupDirty = true;
            // If loadFromUrl auto-detected a video blob, also track as video for per-frame updates
            if ('video' in tex && tex.video instanceof HTMLVideoElement) {
              this._backgroundVideo2 = tex as import('./TextureLoader').LoadedVideoTexture;
            }
          } else if (!tex) {
            this._backgroundUrl2 = null;
          }
        }
      }
    } else {
      this._backgroundTexture2 = null;
      this._backgroundVideo2 = null;
      this._backgroundUrl2 = null;
      this._backgroundType2 = 'image';
    }
  }

  /**
   * Set the background texture from a loaded texture object.
   */
  setBackgroundTexture(texture: LoadedTexture | null): void {
    this._backgroundTexture1 = texture;
    this._bgBindGroupDirty = true;
  }

  /**
   * Clear the background texture (returns to solid color).
   */
  clearBackgroundTexture(): void {
    this._backgroundTexture1 = null;
    this._backgroundTexture2 = null;
    this._backgroundUrl1 = null;
    this._backgroundUrl2 = null;
    this._backgroundType1 = 'image';
    this._backgroundType2 = 'image';
    this._backgroundVideo = null;
    this._backgroundVideo2 = null;
    this._bgBindGroupDirty = true;
  }

  /**
   * Pushes per-slot visual state from the SlideshowStateMachine to the renderer.
   */
  setBgTransitionState(opts: {
    opacity1: number;
    scale1: number;
    offsetX1: number;
    offsetY1: number;
    opacity2: number;
    scale2: number;
    offsetX2: number;
    offsetY2: number;
    blendMode: number;
  }): void {
    this._bgOpacity1 = opts.opacity1;
    this._bgScale1 = opts.scale1;
    this._bgOffsetX1 = opts.offsetX1;
    this._bgOffsetY1 = opts.offsetY1;
    this._bgOpacity2 = opts.opacity2;
    this._bgScale2 = opts.scale2;
    this._bgOffsetX2 = opts.offsetX2;
    this._bgOffsetY2 = opts.offsetY2;
    this._bgBlendMode = opts.blendMode;
  }

  // ───────────────────────────────────────────────────────────
  // Resize
  // ───────────────────────────────────────────────────────────

  /**
   * Handle canvas resize. Updates internal dimensions.
   * No depth buffer issues — we don't create one until needed.
   */
  resize(width: number, height: number): void {
    // Clamp to the device's max 2D texture dimension (aspect-preserving).
    // The canvas swapchain and bg-render-target are textures too, so a size
    // above maxTextureDimension2D (e.g. portrait 4K = 13440 tall on an
    // 8192-limited GPU) fails to allocate and renders black. Downscaling the
    // live preview target is acceptable — export uses its own offscreen path.
    if (this.device) {
      const max = this.device.limits?.maxTextureDimension2D || 8192;
      const largest = Math.max(width, height);
      if (largest > max) {
        const scale = max / largest;
        width = Math.max(1, Math.floor(width * scale));
        height = Math.max(1, Math.floor(height * scale));
      }
    }

    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0) return;

    this.width = width;
    this.height = height;

    // Canvas pixel dimensions
    this.canvas.width = width;
    this.canvas.height = height;

    // Resize render graph intermediate textures
    this._renderGraph?.resize(width, height);

    // Recreate background render target for effect pass routing
    this._destroyBgRenderTarget();
    this._createBgRenderTarget();

    // Butterchurn copies [width,height] from its (now-resized) WebGL canvas into
    // this texture every frame. Keep it in lockstep with the new dimensions or
    // the copy throws (and was previously swallowed, blanking butterchurn).
    if (this._butterchurnRenderer) {
      this._butterchurnRenderer.setSize(width, height);
      this._createButterchurnTexture();
    }
    // Keep the GLSL guest host + owned textures in lockstep with the new size.
    this._glslGuestManager?.setSize(width, height);
  }

  /**
   * Set the lyric overlay bitmap for this frame.
   * The bitmap is composited over the scene during renderFrame().
   * Pass null to clear.
   */
  setLyricBitmap(bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null): void {
    // Close any pending bitmap that was never rendered
    if (this._pendingLyricBitmap && 'close' in this._pendingLyricBitmap) {
      this._pendingLyricBitmap.close();
    }
    this._pendingLyricBitmap = bitmap;
  }

  // ───────────────────────────────────────────────────────────
  // Secondary background image overlay (bgImageOverlay effect)
  // ───────────────────────────────────────────────────────────

  /**
   * Inspect the effect instances for an ENABLED `bgImageOverlay` instance and
   * keep the overlay pass's secondary-image bindings (texture @3 + sampler @4)
   * in sync with its `imageAssetId`. Cheap on the steady state: decode/attach
   * work only happens when the asset id actually changes.
   *
   * Called per-frame by the live driver (useGPUEffects). The frozen overlay
   * pass requires BOTH bindings to always be present, so a 1x1 placeholder is
   * bound as soon as the pass appears (the shader ignores it via hasImage=0
   * until a real texture is ready).
   */
  syncOverlayImage(effectsConfig: EffectsConfig | undefined): void {
    if (!this._initialized || !this._renderGraph) return;

    // Find the first enabled bgImageOverlay instance and its asset id.
    let assetId: string | null = null;
    const instances = effectsConfig?.effectInstances;
    if (instances) {
      for (const inst of instances) {
        if (inst.type === 'bgImageOverlay' && inst.config.enabled) {
          assetId = inst.config.imageAssetId ?? null;
          break;
        }
      }
    }

    const passPresent = this._renderGraph.hasPass(BG_IMAGE_OVERLAY_PASS_ID);

    // ── Re-attach after a graph rebuild (e.g. aspect-ratio change) ──
    // The renderer + RenderGraph are rebuilt when the canvas remounts on an
    // aspect switch. Our overlay bindings live on the OLD graph; the new graph
    // has none. `setPassExtraBindings` silently no-ops until the pass is
    // registered, so a decode that finished before the pass appeared would be
    // dropped and never retried (the asset id is unchanged, so the fast-path
    // return below skips it) — the image renders only if you re-add it. Detect
    // the stale bound-graph and re-apply the CURRENT texture (or placeholder)
    // to the live graph, independent of the asset-id change check.
    if (passPresent && this._overlayBoundGraph !== this._renderGraph) {
      if (this._overlayLoadedTexture) {
        this._attachOverlayRealTexture(this._overlayLoadedTexture);
      } else {
        this._attachOverlayPlaceholderBindings();
      }
    }

    // When the pass is present, make sure a valid texture+sampler is bound.
    // The placeholder keeps the frame bind group valid even with no image.
    if (passPresent && !this._overlayPlaceholderAttached) {
      this._attachOverlayPlaceholderBindings();
    }

    // No change → nothing to do (avoids per-frame allocation / re-decode).
    // (Graph-rebuild re-attach already handled above.)
    if (assetId === this._overlayAssetId) return;

    const prevId = this._overlayAssetId;
    this._overlayAssetId = assetId;

    // Invalidate any in-flight decode for the previous asset.
    this._overlayDecodeToken++;

    // Clear meta for the previous asset so its uniforms report not-ready.
    if (prevId) setOverlayImageMeta(prevId, null);

    // Dispose the previously decoded texture (if any) and revert to placeholder.
    // NOTE: the decoded overlay texture is OWNED by the TextureLoader cache
    // (loadFromBlob caches it under `effectImage:<assetId>`), so we must NOT
    // destroy it here — destroying a cached texture leaves a dangling cache
    // entry that later hands out a destroyed resource, invalidating the bind
    // group that samples it and blanking the background. Just drop our
    // reference; the loader owns the lifetime.
    if (this._overlayLoadedTexture) {
      this._overlayLoadedTexture = null;
    }
    this._attachOverlayPlaceholderBindings();

    // Removed / cleared → placeholder only, meta already cleared.
    if (!assetId) return;

    // New non-null asset → kick off an async decode (timeout-guarded).
    void this._decodeOverlayImage(assetId, this._overlayDecodeToken);
  }

  /** Ensure a linear-clamp sampler + 1x1 placeholder are bound at 3/4. */
  private _attachOverlayPlaceholderBindings(): void {
    if (!this._renderGraph) return;
    if (!this._overlaySampler) {
      this._overlaySampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
    }
    if (!this._overlayPlaceholder) {
      this._overlayPlaceholder = this.textureLoader.createPlaceholder(0, 0, 0, 0);
    }
    this._renderGraph.setPassExtraBindings(BG_IMAGE_OVERLAY_PASS_ID, [
      { binding: 3, resource: this._overlayPlaceholder.texture.createView() },
      { binding: 4, resource: this._overlaySampler },
    ]);
    // setPassExtraBindings silently no-ops until the pass is registered, so
    // only record the attach as effective once the pass actually exists — else
    // a graph rebuild (aspect change) can't detect that a re-attach is needed.
    if (this._renderGraph.hasPass(BG_IMAGE_OVERLAY_PASS_ID)) {
      this._overlayPlaceholderAttached = true;
      this._overlayBoundGraph = this._renderGraph;
    }
  }

  /**
   * Decode an overlay image from IndexedDB and attach it as the real texture.
   * Guarded by a Promise.race timeout so a dead/revoked blob can't hang, and
   * by a decode token so a stale result can't clobber a newer asset switch.
   */
  private async _decodeOverlayImage(assetId: string, token: number): Promise<void> {
    const TIMEOUT_MS = 10000;
    const cacheKey = `effectImage:${assetId}`;
    try {
      // Reuse an already-decoded texture for this asset if the loader still
      // has it cached — reselecting or reloading the same image must NOT
      // re-decode (which would orphan/duplicate GPU textures) and must reuse
      // the loader-owned resource so nothing dangles.
      const cachedTex = this.textureLoader.getCachedTexture(cacheKey);
      if (cachedTex) {
        if (token !== this._overlayDecodeToken || !this._renderGraph) return;
        this._attachOverlayRealTexture(cachedTex);
        setOverlayImageMeta(assetId, {
          ready: true,
          width: cachedTex.width,
          height: cachedTex.height,
        });
        return;
      }

      const blob = await loadEffectImageBlob(assetId);
      if (token !== this._overlayDecodeToken) return; // superseded
      if (!blob) {
        setOverlayImageMeta(assetId, { ready: false, width: 1, height: 1 });
        return;
      }

      const loaded = await Promise.race([
        this.textureLoader.loadFromBlob(blob, cacheKey),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
      ]);

      // A newer asset switch happened while decoding → discard this result.
      // Do NOT destroy `loaded`: loadFromBlob cached it under `cacheKey`, so
      // the TextureLoader owns it. Destroying it here would leave a dangling
      // cache entry that later blanks the frame.
      if (token !== this._overlayDecodeToken) {
        return;
      }

      if (!loaded || !this._renderGraph) {
        setOverlayImageMeta(assetId, { ready: false, width: 1, height: 1 });
        return;
      }

      this._attachOverlayRealTexture(loaded);
      setOverlayImageMeta(assetId, {
        ready: true,
        width: loaded.width,
        height: loaded.height,
      });
    } catch {
      if (token === this._overlayDecodeToken) {
        setOverlayImageMeta(assetId, { ready: false, width: 1, height: 1 });
      }
    }
  }

  /** Attach a decoded overlay texture (+ shared sampler) at bind slots 3/4. */
  private _attachOverlayRealTexture(loaded: LoadedTexture): void {
    if (!this._renderGraph) return;
    if (!this._overlaySampler) {
      this._overlaySampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
    }
    this._overlayLoadedTexture = loaded;
    this._renderGraph.setPassExtraBindings(BG_IMAGE_OVERLAY_PASS_ID, [
      { binding: 3, resource: loaded.texture.createView() },
      { binding: 4, resource: this._overlaySampler },
    ]);
    // Only mark the binding as effective when the pass is actually registered
    // (setPassExtraBindings no-ops otherwise). Keeping _overlayBoundGraph stale
    // until then lets syncOverlayImage retry the attach once the pass appears
    // on a freshly-rebuilt graph (aspect change).
    if (this._renderGraph.hasPass(BG_IMAGE_OVERLAY_PASS_ID)) {
      this._overlayPlaceholderAttached = true;
      this._overlayBoundGraph = this._renderGraph;
    }
  }

  /**
   * Set the compositing layer order for this frame. The renderer uses it to
   * decide whether the lyric layer must be composited BEFORE some effect passes
   * (so those effects distort the lyrics). Pass null to restore legacy behavior
   * (lyrics composite last, over all effects).
   *
   * The split (which enabled pass ids run below vs. above lyrics) is computed by
   * the caller via splitPassesAroundLyrics() so this renderer stays free of the
   * instance→pass mapping. Only the { below, above, anyAbove } result is stored.
   */
  setLayerOrder(split: { below: string[]; above: string[]; anyAbove: boolean } | null): void {
    this._layerPassSplit = split;
  }

  /**
   * Update the glow intensity of the lyric overlay.
   * @param intensity - Glow intensity (0.0 to 1.0+)
   */
  updateLyricGlow(intensity: number): void {
    if (!this._initialized || !this.device) return;
    if (!this._lyricCompositePass) {
      this._lyricCompositePass = new LyricCompositePass(this.device, this.format);
    }
    this._lyricCompositePass.updateGlow(intensity);
  }

  /**
   * Supply (or clear) the GPU Lyric FX chain. The app owns atlas + graph
   * construction; passing a graph opts this renderer into GPU lyric mode. Null
   * reverts to the Canvas2D bitmap path. Inert until a graph is set.
   */
  setLyricFXGraph(graph: LyricFXGraph | null): void {
    this._lyricFXGraph = graph;
    this._lyricFXActive = graph !== null;
  }

  /** Per-frame Lyric FX inputs: packed glyph instances (optional) + effect stack. */
  updateLyricFX(
    packedGlyphs: Float32Array | null,
    effects: Parameters<LyricFXGraph['setEffects']>[0],
    frame: LyricFXFrameParams,
  ): void {
    if (!this._lyricFXGraph) return;
    if (packedGlyphs) this._lyricFXGraph.setGlyphs(packedGlyphs);
    this._lyricFXGraph.setEffects(effects);
    this._lyricFXFrame = frame;
  }

  /**
   * If GPU lyric mode is active, render the FX graph and alpha-composite its
   * output over `targetView`, using `layerBelowView` as the background source
   * for refraction. Returns true when it handled the lyric layer (so the caller
   * skips the bitmap path). Inert (returns false) unless a graph + frame are set.
   */
  private _tryCompositeLyricFX(
    targetView: GPUTextureView,
    layerBelowView: GPUTextureView | null,
    encoder: GPUCommandEncoder,
  ): boolean {
    if (!this._lyricFXActive || !this._lyricFXGraph || !this._lyricFXFrame) return false;
    if (!this._lyricCompositePass) {
      this._lyricCompositePass = new LyricCompositePass(this.device, this.format);
    }
    this._lyricFXGraph.resize(this.width, this.height);
    const view = this._lyricFXGraph.render(encoder, this._lyricFXFrame, layerBelowView);
    if (!view) return false;
    this._lyricCompositePass.executeFromView(view, targetView, encoder);
    return true;
  }

  /**
   * Set the shader overlay config for this frame.
   * Pass null to disable. The pass renders between background and post-processing.
   * Automatically loads/reloads preset and palette when they change.
   */
  setShaderOverlayConfig(config: ShaderOverlayConfig | null): void {
    // Legacy single-overlay entry point (top-level shaderOverlay config, older
    // projects). Bridged onto the N-layer path as a single well-known id.
    this.syncShaderLayers(config?.enabled ? [{ id: '__legacy_shader_overlay__', config }] : []);
  }

  /**
   * Sync the full set of enabled shader-mode layers to composite, in
   * front-to-back order. Idempotent per layer (create/reuse/reload) and prunes
   * any layer whose instance is no longer present. Replaces the old
   * single-`_shaderOverlayConfig` path — the renderer now composites every
   * enabled shader layer at its own stack position.
   */
  syncShaderLayers(layers: ShaderLayerInput[]): void {
    this._shaderLayers = layers;
    if (layers.length === 0) {
      // Nothing enabled — prune everything but keep the registry instance.
      this._shaderLayerRegistry?.prune(new Set());
      return;
    }
    if (!this._shaderLayerRegistry) {
      this._shaderLayerRegistry = new ShaderLayerRegistry(this.device, this.format);
    }
    const live = new Set<string>();
    for (const layer of layers) {
      live.add(layer.id);
      this._shaderLayerRegistry.sync(layer.id, layer.config);
    }
    this._shaderLayerRegistry.prune(live);
  }

  /**
   * Set the ordered enabled GLSL guest layers (Stage 3a). Pass [] to disable.
   * The manager reconciles programs, prunes removed guests, and owns the shared
   * WebGL2 context. Lazily created on first non-empty sync.
   */
  syncGLSLGuests(layers: GLSLGuestSource[]): void {
    this._glslLayers = layers;
    if (layers.length === 0) {
      this._glslGuestManager?.sync([]);
      return;
    }
    if (!this._glslGuestManager) {
      this._glslGuestManager = new GLSLGuestManager(
        this.device,
        this.format,
        this.width,
        this.height,
      );
    }
    this._glslGuestManager.sync(layers);
  }

  /**
   * Expose the GLSL guest host so GPUCanvas can upload per-channel image/cubemap
   * textures loaded from local IndexedDB. Null until a guest exists.
   */
  getGLSLHost(): import('./glsl/GLSLGuestRenderer').GLSLGuestRenderer | null {
    return this._glslGuestManager?.getHost() ?? null;
  }

  /**
   * Set the milkdrop visualizer config. Pass null to disable.
   * Automatically creates/destroys the chain and loads presets.
   */
  setMilkdropConfig(config: MilkdropConfig | null): void {
    if (!config?.enabled) {
      if (this._milkdropChain) {
        this._milkdropChain.destroy();
        this._milkdropChain = null;
        this._milkdropPresetId = null;
        this._milkdropFrame = 0;
        this._milkdropAudio = null;
      }
      this._milkdropConfig = config;
      return;
    }
    this._milkdropConfig = config;

    // Lazy-create the chain ONCE (not every frame!)
    if (!this._milkdropChain) {
      if (this.width <= 0 || this.height <= 0) return;
      const fps = 60;
      this._milkdropChain = new MilkdropChain({
        device: this.device,
        presentFormat: this.format,
        fps,
        internalWidth: Math.max(this.width, 64),
        internalHeight: Math.max(this.height, 64),
        consumeScene: false,
        seed: this._hashPresetId(config.presetId),
      });
      this._milkdropAudio = new LiveAudioTable(fps);
      this._milkdropFFTBuffer = new Uint8Array(2048);
      this._milkdropChain.setAudioTable(this._milkdropAudio);
    }

    // Load preset only when it actually changes
    if (config.presetId !== this._milkdropPresetId) {
      const preset = VISUALIZER_PRESETS.find((p) => p.id === config.presetId);
      if (preset) {
        this._milkdropPresetId = config.presetId;
        this._milkdropChain.loadPreset(preset);
        this._milkdropFrame = 0;
      }
    }
  }

  /** Get the MilkdropChain instance if active. */
  getMilkdropChain(): MilkdropChain | null {
    return this._milkdropChain;
  }

  /**
   * Set the Butterchurn visualizer config. Pass null to disable.
   * Lazy-loads the ButterchurnRenderer on first use.
   */
  async setButterchurnConfig(
    config: import('@/types/effects/butterchurn').ButterchurnConfig | null,
    audioContext?: AudioContext,
    audioNode?: AudioNode,
  ): Promise<void> {
    if (!config?.enabled) {
      if (this._butterchurnRenderer) {
        this._butterchurnRenderer.destroy();
        this._butterchurnRenderer = null;
      }
      if (this._butterchurnTexture) {
        this._butterchurnTexture.destroy();
        this._butterchurnTexture = null;
      }
      this._butterchurnConfig = config;
      // Toggling the effect off/on is the user's "try again".
      this._butterchurnFailed = false;
      return;
    }
    this._butterchurnConfig = config;

    // Lazy-init the renderer (once — a failure is remembered, see _butterchurnFailed)
    if (
      !this._butterchurnRenderer &&
      !this._butterchurnInitializing &&
      !this._butterchurnFailed &&
      audioContext
    ) {
      this._butterchurnInitializing = true;
      console.log('[WebGPURenderer] Butterchurn: starting init...');
      let renderer: import('./butterchurn/ButterchurnRenderer').ButterchurnRenderer | null = null;
      let ok = false;
      try {
        const { ButterchurnRenderer } = await import('./butterchurn/ButterchurnRenderer');
        renderer = new ButterchurnRenderer({
          width: this.width,
          height: this.height,
          audioContext,
          audioNode,
          onContextRestored: (restored) => {
            if (restored) {
              this._createButterchurnTexture();
            } else {
              this._failButterchurn();
            }
          },
        });
        ok = await renderer.init();
      } catch (err) {
        console.error('[WebGPURenderer] Failed to load Butterchurn:', err);
      }
      this._butterchurnInitializing = false;
      if (ok && renderer && !this._butterchurnConfig?.enabled) {
        // Disabled while we were initialising — don't keep a stray context.
        renderer.destroy();
        return;
      }
      if (ok && renderer) {
        this._butterchurnRenderer = renderer;
        // Create GPU texture for copying Butterchurn frames
        this._createButterchurnTexture();
      } else {
        console.warn('[WebGPURenderer] Butterchurn init failed (no usable WebGL2)');
        // Tear down the half-built renderer: removes the hidden canvas and
        // force-loses its WebGL context instead of leaking one per attempt.
        renderer?.destroy();
        this._failButterchurn();
        return;
      }
    }

    if (!this._butterchurnRenderer) return;

    // Update size if needed
    this._butterchurnRenderer.setSize(this.width, this.height);

    // Connect audio source if it wasn't available at init time
    if (audioNode) {
      this._butterchurnRenderer.connectAudio(audioNode);
    }

    // Load preset if changed (or auto-pick a starting preset if none specified)
    if (config.presetName && config.presetName !== this._butterchurnRenderer.getCurrentPreset()) {
      this._butterchurnRenderer.loadPreset(config.presetName, config.blendTime ?? 0);
    } else if (!config.presetName && !this._butterchurnRenderer.getCurrentPreset()) {
      // No preset specified — start on a random one in 'random' cycle mode, else
      // the first one, so SOMETHING renders (never the default blank visualizer).
      this._butterchurnRenderer.loadInitialPreset('', config.cycleMode, 0);
    }

    // Update cycling config
    this._butterchurnRenderer.setCycleConfig(config.cycleMode, config.cycleInterval);
  }

  /** Give up on Butterchurn until the effect is toggled; tell the user once. */
  private _failButterchurn(): void {
    this._butterchurnFailed = true;
    if (this._butterchurnRenderer) {
      this._butterchurnRenderer.destroy();
      this._butterchurnRenderer = null;
    }
    if (this._butterchurnTexture) {
      this._butterchurnTexture.destroy();
      this._butterchurnTexture = null;
    }
    import('./butterchurn/butterchurnStatus').then((m) => m.notifyButterchurnUnavailable());
  }

  /** Get the ButterchurnRenderer instance if active. */
  getButterchurnRenderer(): import('./butterchurn/ButterchurnRenderer').ButterchurnRenderer | null {
    return this._butterchurnRenderer;
  }

  /**
   * (Re)create the GPU texture that receives copied Butterchurn frames, sized to
   * Butterchurn's CANVAS (its capped internal render size, ≤ 2048 on the long
   * side) — not the renderer size. The composite pass samples it full-screen
   * with a linear sampler, so a smaller texture is simply upscaled. Must be
   * called on init and on every resize; the per-frame copy also re-creates it
   * if the canvas size drifted, since a mismatched copy throws and blanks out.
   */
  private _createButterchurnTexture(): void {
    if (this._butterchurnTexture) {
      this._butterchurnTexture.destroy();
      this._butterchurnTexture = null;
    }
    const bcCanvas = this._butterchurnRenderer?.getCanvas();
    this._butterchurnTexture = this.device.createTexture({
      label: 'butterchurn-frame',
      size: [
        Math.max(1, bcCanvas?.width ?? this.width),
        Math.max(1, bcCanvas?.height ?? this.height),
      ],
      format: this.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /**
   * Lazily create the butterchurn composite pipeline (alpha-blend a texture over the target).
   * Uses standard src-alpha / one-minus-src-alpha blending with a uniform opacity.
   */
  private _ensureBcCompositePipeline(): void {
    if (this._bcCompositePipeline) return;

    const shaderCode = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var srcSamp: sampler;
      @group(0) @binding(2) var<uniform> opacity: f32;

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
        return vec4f(color.rgb, opacity);
      }
    `;

    const shaderModule = this.device.createShaderModule({
      label: 'bc-composite-shader',
      code: shaderCode,
    });

    this._bcCompositeBindGroupLayout = this.device.createBindGroupLayout({
      label: 'bc-composite-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'bc-composite-pl',
      bindGroupLayouts: [this._bcCompositeBindGroupLayout],
    });

    this._bcCompositePipeline = this.device.createRenderPipeline({
      label: 'bc-composite-pipeline',
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
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
      primitive: { topology: 'triangle-list' },
    });

    this._bcCompositeUniformBuffer = this.device.createBuffer({
      label: 'bc-composite-opacity',
      size: 4, // single f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._bcCompositeSampler = this.device.createSampler({
      label: 'bc-composite-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  /**
   * Lazily create the game-scene composite pipeline. Alpha-blends the scene
   * texture over the target honouring per-pixel source alpha multiplied by a
   * uniform opacity, so transparent regions of the scene reveal the background.
   */
  private _ensureGsCompositePipeline(): void {
    if (this._gsCompositePipeline) return;

    const shaderCode = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var srcSamp: sampler;
      @group(0) @binding(2) var<uniform> opacity: f32;

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
        // Preserve the scene's per-pixel alpha; the uniform opacity scales it so
        // empty regions (alpha 0) stay fully transparent and reveal the bg.
        return vec4f(color.rgb, color.a * opacity);
      }
    `;

    const shaderModule = this.device.createShaderModule({
      label: 'gs-composite-shader',
      code: shaderCode,
    });

    this._gsCompositeBindGroupLayout = this.device.createBindGroupLayout({
      label: 'gs-composite-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'gs-composite-pl',
      bindGroupLayouts: [this._gsCompositeBindGroupLayout],
    });

    this._gsCompositePipeline = this.device.createRenderPipeline({
      label: 'gs-composite-pipeline',
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
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
      primitive: { topology: 'triangle-list' },
    });

    this._gsCompositeUniformBuffer = this.device.createBuffer({
      label: 'gs-composite-opacity',
      size: 4, // single f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._gsCompositeSampler = this.device.createSampler({
      label: 'gs-composite-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  /** Lazily (re)create the game-scene frame texture at the current size. */
  private _ensureGameSceneTexture(): GPUTexture {
    if (
      this._gameSceneTexture &&
      this._gameSceneTexture.width === this.width &&
      this._gameSceneTexture.height === this.height
    ) {
      return this._gameSceneTexture;
    }
    this._gameSceneTexture?.destroy();
    this._gameSceneTexture = this.device.createTexture({
      label: 'game-scene-frame',
      size: [this.width, this.height],
      format: this.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return this._gameSceneTexture;
  }

  /**
   * Render the current game-scene frame (throttled) and copy the Canvas2D
   * output into the owned game-scene texture. Shared by both live paths.
   */
  private _renderGameSceneToTexture(state: FrameState): void {
    const now = performance.now();
    if (now - this._littlejsLastRenderTime >= 15) {
      this._littlejsRenderer!.setAudioData({
        bass: state.audioBass ?? 0,
        mid: state.audioMid ?? 0,
        treb: state.audioHigh ?? 0,
        beat: (state.audioBass ?? 0) > 0.7,
        amplitude: state.audioEnergy ?? 0,
        bpm: 120,
        time: state.time,
        duration: state.duration ?? 0,
      });
      this._littlejsRenderer!.render();
      this._littlejsLastRenderTime = now;
    }
    const tex = this._ensureGameSceneTexture();
    const ljCanvas = this._littlejsRenderer!.getCanvas();
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: ljCanvas },
        { texture: tex, origin: [0, 0, 0] },
        [this.width, this.height],
      );
    } catch {
      // Silently continue — frame just won't have the game scene
    }
  }

  /** Alpha-blend the game-scene texture over the given target view. */
  private _compositeGameScene(targetView: GPUTextureView, encoder: GPUCommandEncoder): void {
    if (!this._gameSceneTexture) return;
    this._ensureGsCompositePipeline();
    if (!this._gsCompositePipeline || !this._gsCompositeUniformBuffer) return;

    const opacity = this._littlejsConfig?.opacity ?? 1.0;
    this.device.queue.writeBuffer(
      this._gsCompositeUniformBuffer,
      0,
      new Float32Array([Math.max(0, Math.min(1, opacity))]),
    );

    const bindGroup = this.device.createBindGroup({
      label: 'gs-composite-bg',
      layout: this._gsCompositeBindGroupLayout!,
      entries: [
        { binding: 0, resource: this._gameSceneTexture.createView() },
        { binding: 1, resource: this._gsCompositeSampler! },
        { binding: 2, resource: { buffer: this._gsCompositeUniformBuffer } },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: 'game-scene-composite-pass',
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'load' as const,
          storeOp: 'store' as const,
        },
      ],
    });
    pass.setPipeline(this._gsCompositePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  // ── Game Scene (Canvas2D) ──
  private _littlejsRenderer: import('./littlejs/LittleJSRenderer').GameSceneRenderer | null = null;
  private _littlejsConfig: import('./littlejs/types').GameSceneConfig | null = null;
  private _littlejsInitializing = false;
  /** Lyrics received before the game-scene renderer finished async init. */
  private _pendingGameSceneLyrics: Array<{ start: number; end: number }> | null = null;
  private _littlejsLastRenderTime = 0;
  /**
   * GPU texture the game-scene Canvas2D frame is copied into before it is
   * alpha-blended over the background. The scene composites ON TOP of the
   * background (image/video/shader/solid), so — unlike the old behaviour where
   * the scene canvas was copied straight over bgRenderTarget and replaced the
   * background — we copy to this owned texture and blend it with source-alpha.
   */
  private _gameSceneTexture: GPUTexture | null = null;
  // Game-scene composite pipeline — alpha-blends the scene texture over the
  // background honouring per-pixel alpha × opacity (distinct from the
  // butterchurn composite, which discards source alpha).
  private _gsCompositePipeline: GPURenderPipeline | null = null;
  private _gsCompositeBindGroupLayout: GPUBindGroupLayout | null = null;
  private _gsCompositeUniformBuffer: GPUBuffer | null = null;
  private _gsCompositeSampler: GPUSampler | null = null;

  /**
   * Set the game scene config. Pass null to disable.
   * Lazy-loads the GameSceneRenderer on first use.
   */
  async setLittleJSConfig(
    config: import('./littlejs/types').GameSceneConfig | null,
  ): Promise<void> {
    if (!config?.enabled) {
      if (this._littlejsRenderer) {
        this._littlejsRenderer.destroy();
        this._littlejsRenderer = null;
      }
      this._littlejsConfig = config;
      return;
    }
    this._littlejsConfig = config;

    // Lazy-init the renderer
    if (!this._littlejsRenderer && !this._littlejsInitializing) {
      this._littlejsInitializing = true;
      console.log('[WebGPURenderer] GameScene: starting init...');
      try {
        const { GameSceneRenderer } = await import('./littlejs/LittleJSRenderer');
        const renderer = new GameSceneRenderer({
          width: this.width,
          height: this.height,
        });
        await renderer.init();
        this._littlejsRenderer = renderer;
        // Flush any lyrics that arrived while we were initializing — otherwise the
        // scene never learns its lyric timings and the camera stays in wide shot.
        if (this._pendingGameSceneLyrics) {
          renderer.setLyrics(this._pendingGameSceneLyrics);
        }
      } catch (err) {
        console.error('[WebGPURenderer] Failed to load GameSceneRenderer:', err);
      }
      this._littlejsInitializing = false;
    }

    if (!this._littlejsRenderer) return;

    // Update size if needed
    this._littlejsRenderer.setSize(this.width, this.height);

    // Load scene if changed
    if (config.sceneId && config.sceneId !== this._littlejsRenderer.getCurrentScene()) {
      await this._littlejsRenderer.loadScene(config.sceneId);
    }
  }

  /** Get the GameSceneRenderer instance if active. */
  getLittleJSRenderer(): import('./littlejs/LittleJSRenderer').GameSceneRenderer | null {
    return this._littlejsRenderer;
  }

  /**
   * Pass lyric line timings to the game scene for camera sync.
   * Call when the selected track or its lyrics change.
   */
  setGameSceneLyrics(lines: Array<{ start: number; end: number }>): void {
    // Cache unconditionally — setLittleJSConfig() is async, so the caller
    // (GPUCanvas) commonly reaches here before _littlejsRenderer exists.
    // Dropping the call would strand the scene with zero lyrics forever,
    // because GPUCanvas only re-sends when the lyric COUNT changes.
    this._pendingGameSceneLyrics = lines;
    if (this._littlejsRenderer) {
      this._littlejsRenderer.setLyrics(lines);
    }
  }

  /**
   * Pass custom asset URLs to the game scene.
   * Call after resolving blob URLs from IDB.
   */
  setGameSceneAssets(urls: { left?: string; right?: string; background?: string }): void {
    if (this._littlejsRenderer) {
      this._littlejsRenderer.setAssetUrls(urls);
    }
  }

  /**
   * Pass scene-specific params (e.g., leftHover, rightHover) to the game scene.
   */
  setGameSceneParams(params: Record<string, number | string | boolean>): void {
    if (this._littlejsRenderer) {
      this._littlejsRenderer.setParams(params);
    }
  }

  // ───────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────

  /**
   * Render one complete frame.
   *
   * This is the main render method called every animation frame.
   * When GPU effect passes are active:
   *   background → intermediate texture → [effect passes] → swapchain
   * When no effects:
   *   background → swapchain (direct, zero overhead)
   */
  renderFrame(state: FrameState): void {
    if (!this._initialized) {
      console.error('[WebGPURenderer] renderFrame called before initialization!');
      return;
    }

    // Compute delta time
    const now = performance.now();
    this._lastDt = (now - this._lastFrameTime) / 1000;
    this._lastFrameTime = now;

    // Apply time smoothing to prevent judder
    // We smooth the input state's time to reduce precision jitter from the audio element.
    // When paused, state.time doesn't change — hold smoothedTime steady so
    // shader-driven animations (starfield, particles, rain, etc.) freeze.
    if (this._lastSmoothedTime === undefined) {
      this._lastSmoothedTime = state.time;
    }

    // If the state time jumped significantly (e.g. user seeked), snap to the new time
    if (Math.abs(state.time - this._lastSmoothedTime) > 0.5) {
      this._lastSmoothedTime = state.time;
    } else if (Math.abs(state.time - (this._lastInputTime ?? state.time)) > 0.0001) {
      // Time is actually advancing (playing) — apply smoothing
      this._lastSmoothedTime = this._lastSmoothedTime + this._lastDt;
      // Pull smoothed time towards actual state time
      const smoothingFactor = 0.2;
      this._lastSmoothedTime += (state.time - this._lastSmoothedTime) * smoothingFactor;
    } else {
      // Paused — snap to the exact state time (no drift)
      this._lastSmoothedTime = state.time;
    }
    // Detect whether time is advancing (playing) vs frozen (paused).
    // Must be computed BEFORE updating _lastInputTime.
    //
    // A per-frame equality check is WRONG here: state.time is sourced from an
    // HTMLMediaElement's currentTime, which only advances a few times per
    // second, so during NORMAL PLAYBACK many rAF frames see an unchanged time
    // and a naive check flaps isTimeFrozen true→false→true at the audio clock's
    // coarse rate. The pause/resume block below then paused() + played() the
    // background <video> several times a second — which Firefox answers with a
    // full resource-selection cycle each time (waiting → readyState 1 → canplay
    // → playing), i.e. the reported flicker. So treat time as frozen only after
    // it has been unchanged for longer than one audio-clock tick (debounce),
    // which stays false through the gaps between real currentTime updates and
    // only latches true on a genuine pause/seek-hold.
    const timeChanged = Math.abs(state.time - (this._lastInputTime ?? state.time)) >= 0.0001;
    if (timeChanged) {
      this._lastTimeChangeAt = now;
    } else if (this._lastTimeChangeAt === undefined) {
      // First frame with no prior change recorded — seed so we don't instantly
      // declare frozen before any playback signal has arrived.
      this._lastTimeChangeAt = now;
    }
    const FREEZE_DEBOUNCE_MS = 250; // > one media-element currentTime tick
    const isTimeFrozen = now - (this._lastTimeChangeAt ?? now) > FREEZE_DEBOUNCE_MS;
    const didReset = state.time === 0 && (this._lastInputTime ?? 0) > 0;
    this._lastInputTime = state.time;

    // Pass the smoothed time along instead of raw time
    const smoothedTime = this._lastSmoothedTime;

    // ── Pause/resume background video elements in sync with timeline ──
    // The <video> element plays independently of the timeline. When the user
    // pauses, we must also pause the video element so its frames freeze.
    if (this._backgroundVideo?.video) {
      if (isTimeFrozen && !this._backgroundVideo.video.paused) {
        this._backgroundVideo.video.pause();
      } else if (!isTimeFrozen && this._backgroundVideo.video.paused) {
        this._backgroundVideo.video.play().catch(() => {});
      }
    }
    if (this._backgroundVideo2?.video) {
      if (isTimeFrozen && !this._backgroundVideo2.video.paused) {
        this._backgroundVideo2.video.pause();
      } else if (!isTimeFrozen && this._backgroundVideo2.video.paused) {
        this._backgroundVideo2.video.play().catch(() => {});
      }
    }

    // Update video frame (copy latest decoded pixels to GPU texture)
    // Zero-copy external video is only usable for single-video display
    // (no crossfade). When crossfading (mixRatio > 0 or two videos loaded),
    // we MUST use the copy-based path so both textures are blended by the
    // standard background shader.
    const isCrossfading = this._bgMixRatio > 0 || this._backgroundVideo2 !== null;
    const useZeroCopyVideo =
      this._supportsExternalTexture &&
      this._backgroundVideo !== null &&
      !isCrossfading &&
      this._externalVideoPipeline !== null &&
      this._externalVideoBindGroupLayout !== null;

    // Zero-copy external video is only valid for the CURRENT compositor frame,
    // and importExternalTexture() returns null transiently on loop wrap-around
    // and on the currentTime seeks syncVideoElement issues to correct drift.
    // Chrome almost never returns null during steady playback, but Firefox does
    // so aggressively — and when the later zero-copy pass is skipped on a null
    // import, the background target (cleared to black by the background-pass)
    // is left black for that frame → the "flicker related to video playback"
    // reported on Firefox. So we import HERE, once: if it succeeds we keep the
    // Chrome fast path (skip the copy); if it fails we fall back to the copy
    // path for THIS frame so the persistent copy texture holds the current /
    // last-good decoded frame and the background triangle draws it instead of
    // black. The import result is reused by the draw pass below (importing twice
    // in one frame is wasteful and can disagree).
    let externalVideoTex: GPUExternalTexture | null = null;
    if (this._backgroundVideo && useZeroCopyVideo) {
      externalVideoTex = this.textureLoader.importExternalVideo(this._backgroundVideo.video);
    }
    const zeroCopyThisFrame = useZeroCopyVideo && externalVideoTex !== null;

    // Update video frames via copy when not using the zero-copy path THIS frame
    // (covers the copy-based renderer AND the Firefox null-import fallback).
    if (this._backgroundVideo && !zeroCopyThisFrame) {
      this.textureLoader.updateVideoFrame(this._backgroundVideo);
    }
    if (this._backgroundVideo2) {
      this.textureLoader.updateVideoFrame(this._backgroundVideo2);
    }

    // Rebuild bind group if texture changed
    if (this._bgBindGroupDirty) {
      this._rebuildBgBindGroup();
      this._bgBindGroupDirty = false;
    }

    // Guard: bind group must exist
    if (!this._bgBindGroup) {
      console.error('[WebGPURenderer] Background bind group is null — cannot render frame.');
      return;
    }

    // Update uniforms — layout matches the struct (112 bytes total)
    const bgData = new Float32Array(28);
    bgData[0] = state.backgroundColor[0];
    bgData[1] = state.backgroundColor[1];
    bgData[2] = state.backgroundColor[2];
    bgData[3] = 1.0; // padding
    bgData[4] = state.backgroundBrightness;
    bgData[5] = state.backgroundScale;
    bgData[6] = state.backgroundOffsetX;
    bgData[7] = state.backgroundOffsetY;
    bgData[8] = this._backgroundTexture1 ? 1.0 : 0.0;
    bgData[10] = state.backgroundAngle || 0;
    bgData[11] = state.backgroundTiling ? 1.0 : 0.0;
    bgData[24] = state.backgroundContrast ?? 1.0;
    // Background blur: applied by the universal BackgroundBlurPass on the
    // COMPOSITED target (works for every source) whenever the render graph is
    // available. Zero out the per-image blur here to avoid double-blurring
    // static images; only fall back to the in-shader per-image blur when the
    // render graph isn't available (blur can't run without the intermediate).
    const _universalBlurWillRun =
      (state.backgroundBlur ?? 0) > 0 &&
      this._renderGraph !== null &&
      this._renderGraph.initialized &&
      this._bgRenderTargetView !== null;
    bgData[25] = _universalBlurWillRun ? 0.0 : (state.backgroundBlur ?? 0.0);
    // blurType as float bits reinterpreted as u32 in shader — write as Uint32
    new Uint32Array(bgData.buffer, 104, 1)[0] = (state.backgroundBlurType ?? 1) >>> 0;

    // Per-slot transition visuals
    // When _bgMixRatio > 0, use the per-slot visuals if they've been set
    // (slide/zoom transitions set offsets/scale via setSlotVisuals).
    // If no per-slot visuals were explicitly set, fall back to simple
    // crossfade (opacity only) for backward compatibility.
    const resolvedOpacity = state.backgroundOpacity ?? 1.0;
    if (this._bgMixRatio > 0) {
      bgData[9] = 1.0; // Additive/Crossfade mode
      bgData[16] = this._bgOpacity1 * resolvedOpacity;
      bgData[17] = this._bgScale1;
      bgData[18] = this._bgOffsetX1;
      bgData[19] = this._bgOffsetY1;
      bgData[20] = this._bgOpacity2 * resolvedOpacity;
      bgData[21] = this._bgScale2;
      bgData[22] = this._bgOffsetX2;
      bgData[23] = this._bgOffsetY2;
    } else {
      bgData[9] = this._bgBlendMode;
      bgData[16] = this._bgOpacity1 * resolvedOpacity;
      bgData[17] = this._bgScale1;
      bgData[18] = this._bgOffsetX1;
      bgData[19] = this._bgOffsetY1;
      bgData[20] = this._bgOpacity2 * resolvedOpacity;
      bgData[21] = this._bgScale2;
      bgData[22] = this._bgOffsetX2;
      bgData[23] = this._bgOffsetY2;
    }

    const fit = state.backgroundFit || 'cover';
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    // UV scale for texture 1
    const t1w = this._backgroundTexture1?.width || 1;
    const t1h = this._backgroundTexture1?.height || 1;
    const [sc1x, sc1y] = computeUVScale(fit, cw, ch, t1w, t1h);
    bgData[12] = sc1x;
    bgData[13] = sc1y;

    // UV scale for texture 2
    const t2w = this._backgroundTexture2?.width || 1;
    const t2h = this._backgroundTexture2?.height || 1;
    const [sc2x, sc2y] = computeUVScale(fit, cw, ch, t2w, t2h);
    bgData[14] = sc2x;
    bgData[15] = sc2y;

    this.device.queue.writeBuffer(this.bgUniformBuffer, 0, bgData);

    // Get current swap chain texture
    let currentTexture: GPUTexture;
    try {
      currentTexture = this.context.getCurrentTexture();
    } catch (err) {
      console.error('[WebGPURenderer] Failed to get current swapchain texture:', err);
      return;
    }
    const swapchainView = currentTexture.createView();

    // ONLY route through render graph when there are actually enabled effect passes.
    // This is critical — when no effects are active, we render directly to the
    // swapchain with zero overhead. This prevents the regression where background
    // rendering appeared blank because it was going to an intermediate texture
    // without a composite pass to bring it back to screen.
    const useRenderGraph =
      this._renderGraph !== null &&
      this._renderGraph.initialized &&
      this._renderGraph.hasEnabledPasses() &&
      this._bgRenderTargetView !== null;

    // Background blur is applied by a dedicated pass on the COMPOSITED background
    // target (not the per-image bgPipeline), so it works for every source
    // (image/video/butterchurn/game-scene/shader/milkdrop). It requires the
    // intermediate render target even when no effect passes are enabled, so it
    // can sample the composited result and blit it back to the swapchain via the
    // render graph's passthrough composite.
    const blurAmount = state.backgroundBlur ?? 0;
    const blurActive =
      blurAmount > 0 &&
      this._renderGraph !== null &&
      this._renderGraph.initialized &&
      this._bgRenderTargetView !== null;

    // Determine if butterchurn is active this frame (need to know before background pass).
    // NOTE: this is NOT gated on !isTimeFrozen. When paused we still want butterchurn
    // to keep compositing its last (preserved) frame — freezing is done by skipping
    // only the render() advance call below, not by dropping it from the pipeline. If
    // this were gated on !isTimeFrozen, the whole copy+composite block would be
    // skipped on pause and butterchurn would vanish instead of holding its frame.
    const butterchurnActive = !!(
      this._butterchurnRenderer?.ready && this._butterchurnConfig?.enabled
    );

    // Determine if LittleJS game scene is active this frame
    const littlejsActive = !!(this._littlejsRenderer?.ready && this._littlejsConfig?.enabled);

    // Scene sources (butterchurn / shader overlay / milkdrop / game scene) all
    // composite ON TOP of the drawn background, so they need the intermediate
    // target as the base to composite over. Fixed layer order:
    // background → butterchurn → shaderFx → (milkdrop / game scene) → everything
    // else. Route through the intermediate whenever any is active so the
    // background is drawn first and each source layers over it in order.
    const sceneSourceActive =
      butterchurnActive ||
      littlejsActive ||
      !!(this._shaderLayerRegistry?.hasRenderable() && this._shaderLayers.length > 0) ||
      !!(this._glslGuestManager?.hasGuests() && this._glslLayers.length > 0) ||
      !!(this._milkdropChain && this._milkdropConfig?.enabled && !isTimeFrozen);

    // Route the background through the intermediate texture when real effect
    // passes are active, blur needs the composited target, OR a scene source
    // must composite on top of the background.
    const routeToIntermediate =
      (useRenderGraph || blurActive || sceneSourceActive) && this._bgRenderTargetView !== null;

    // Build command buffer
    const encoder = this.device.createCommandEncoder({ label: 'frame-encoder' });

    // Background pass — render to intermediate texture if effects active
    // (or blur needs the composited target), otherwise render directly to
    // the swapchain.
    const bgTargetView = routeToIntermediate ? this._bgRenderTargetView! : swapchainView;

    // Butterchurn effective opacity is simply the user-configured opacity. (A
    // previous "fade-in" opacity cap lived ONLY on this intermediate/effects
    // path and could stick at 0 — which made butterchurn vanish the moment ANY
    // post-processing effect or blur routed it through the intermediate target,
    // while it rendered fine on the direct-to-swapchain path with no fade. The
    // two paths must behave identically, so the fade cap is gone.)
    const bcUserOpacity = this._butterchurnConfig?.opacity ?? 1.0;
    const bcOpacity = bcUserOpacity;
    // Butterchurn ALWAYS composites ON TOP of the background (fixed layer order:
    // background → butterchurn → shaderFx → everything else). It never replaces
    // the background — the background is drawn first as the base, then
    // butterchurn is alpha-composited over it (at opacity 1 it fully covers,
    // which looks identical to the old replace path but keeps the background
    // correctly underneath). This mirrors how the game scene composites.
    const butterchurnReplacesBackground = false;
    // The game scene always composites ON TOP of the background (it no longer
    // fills bgRenderTarget), so it never forces the background draw to be
    // skipped. Butterchurn now behaves the same way.
    const externalCanvasActive = false;

    // When butterchurn is active, copy its canvas to bgRenderTarget FIRST (queue op).
    // Queue ops execute in order, so this happens before the encoder's passes.
    // We then use loadOp:'load' to preserve the butterchurn pixels and skip
    // the background triangle draw.
    if (butterchurnActive && routeToIntermediate && this._bgRenderTarget) {
      // Render the butterchurn frame NOW (before copy) so current frame is captured.
      // When paused (isTimeFrozen) we DON'T advance butterchurn — we skip render()
      // but still copy+composite below. Butterchurn's WebGL canvas was created with
      // preserveDrawingBuffer:true, so it retains its last-drawn frame; the copy
      // keeps pushing that frozen frame into the texture. Net effect: butterchurn
      // stays visible on screen but stops animating while paused (instead of being
      // hidden/torn down). Same pattern as the background <video> pause above.
      if (!isTimeFrozen) {
        const now = performance.now();
        if (now - this._butterchurnLastRenderTime >= 15) {
          this._butterchurnRenderer!.render(60);
          this._butterchurnLastRenderTime = now;
        }
      }

      const bcCanvas = this._butterchurnRenderer!.getCanvas();

      // Butterchurn always composites ON TOP of the background: copy its frame
      // into its OWN texture, then alpha-blend it over the drawn background in
      // the composite pass below (which upscales it — the canvas is capped).
      // Keep the texture matched to the canvas, and clamp the copy extent to
      // what BOTH can satisfy — copyExternalImageToTexture throws if the extent
      // exceeds either, and a thrown copy leaves the dest cleared/black.
      if (
        !this._butterchurnTexture ||
        this._butterchurnTexture.width !== bcCanvas.width ||
        this._butterchurnTexture.height !== bcCanvas.height
      ) {
        this._createButterchurnTexture();
      }
      const dstW = this._butterchurnTexture!.width;
      const dstH = this._butterchurnTexture!.height;
      const copyW = Math.min(bcCanvas.width, dstW);
      const copyH = Math.min(bcCanvas.height, dstH);

      try {
        this.device.queue.copyExternalImageToTexture(
          { source: bcCanvas },
          { texture: this._butterchurnTexture!, origin: [0, 0, 0] },
          [copyW, copyH],
        );
        this._bcCopyWarned = false;
      } catch (e) {
        // Frame just won't have butterchurn. Warn ONCE so it isn't invisible (the
        // old silent catch made "butterchurn stops rendering, no console error" a
        // ghost bug).
        if (!this._bcCopyWarned) {
          this._bcCopyWarned = true;
          console.warn(
            '[WebGPURenderer] Butterchurn frame copy failed (size desync ' +
              `canvas ${bcCanvas.width}x${bcCanvas.height}, dst ${dstW}x${dstH}, ` +
              `renderer ${this.width}x${this.height}). Skipping butterchurn this frame.`,
            e,
          );
        }
      }
    }

    // When the game scene is active, render its frame and copy it into the owned
    // game-scene texture (NOT bgRenderTarget). It is composited on top of the
    // background after the background pass below, so the background shows through
    // the scene's transparent regions.
    if (littlejsActive && routeToIntermediate && this._bgRenderTarget) {
      this._renderGameSceneToTexture(state);
    }

    const renderPass = encoder.beginRenderPass({
      label: 'background-pass',
      colorAttachments: [
        {
          view: bgTargetView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          // When butterchurn/littlejs wrote to this texture via queue copy, load it
          loadOp: externalCanvasActive ? 'load' : 'clear',
          storeOp: 'store',
        },
      ],
    });

    // Skip background triangle only when a fully-opaque butterchurn replaced the
    // background. The game scene composites on top later, so the background must
    // still be drawn underneath it here.
    if (!butterchurnReplacesBackground) {
      renderPass.setPipeline(this.bgPipeline);
      renderPass.setBindGroup(0, this._bgBindGroup);
      renderPass.draw(3); // Fullscreen triangle
    }
    renderPass.end();

    // Zero-copy video path: if we have an external video, re-render the
    // background using importExternalTexture to overwrite with zero-copy video.
    //
    // MUST be skipped when a fully-opaque butterchurn has already populated the
    // background target. This pass uses loadOp:'clear' on the SAME bgTargetView,
    // so running it after the butterchurn copy would wipe the butterchurn pixels
    // and the video would win — which is exactly why "video + butterchurn +
    // effects" made butterchurn stop rendering (butterchurn is copied into
    // _bgRenderTarget at full opacity, then this pass cleared it away). A fully
    // opaque butterchurn hides the video entirely anyway, so there is nothing to
    // lose by skipping. For partial-opacity butterchurn the video is still drawn
    // here (as the backdrop) and butterchurn composites on top afterwards.
    if (zeroCopyThisFrame && this._backgroundVideo && !butterchurnReplacesBackground) {
      const externalTex = externalVideoTex;
      if (externalTex) {
        // Create a temporary bind group with the external texture
        const extBindGroup = this.device.createBindGroup({
          label: 'bg-external-video-bg',
          layout: this._externalVideoBindGroupLayout!,
          entries: [
            { binding: 0, resource: { buffer: this.bgUniformBuffer } },
            { binding: 1, resource: externalTex },
            { binding: 2, resource: this.sampler },
          ],
        });

        // Overwrite the background target — load existing content isn't needed
        // since we're replacing it entirely
        const extPass = encoder.beginRenderPass({
          label: 'background-external-video-pass',
          colorAttachments: [
            {
              view: bgTargetView,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });

        extPass.setPipeline(this._externalVideoPipeline!);
        extPass.setBindGroup(0, extBindGroup);
        extPass.draw(3);
        extPass.end();
      }
    }

    // ── Butterchurn composite: blend butterchurn texture over background with opacity ──
    // When opacity < 1, butterchurn was copied to _butterchurnTexture (not bgRenderTarget),
    // and the background was drawn normally. Now blend butterchurn on top.
    if (
      butterchurnActive &&
      !butterchurnReplacesBackground &&
      this._butterchurnTexture &&
      routeToIntermediate
    ) {
      this._ensureBcCompositePipeline();
      if (this._bcCompositePipeline && this._bcCompositeUniformBuffer) {
        // Write opacity uniform
        const opData = new Float32Array([bcOpacity]);
        this.device.queue.writeBuffer(this._bcCompositeUniformBuffer, 0, opData);

        // Create bind group for this frame's texture view
        const bcBindGroup = this.device.createBindGroup({
          label: 'bc-composite-bg',
          layout: this._bcCompositeBindGroupLayout!,
          entries: [
            { binding: 0, resource: this._butterchurnTexture.createView() },
            { binding: 1, resource: this._bcCompositeSampler! },
            { binding: 2, resource: { buffer: this._bcCompositeUniformBuffer } },
          ],
        });

        const bcPass = encoder.beginRenderPass({
          label: 'butterchurn-composite-pass',
          colorAttachments: [
            {
              view: bgTargetView,
              loadOp: 'load' as const,
              storeOp: 'store' as const,
            },
          ],
        });
        bcPass.setPipeline(this._bcCompositePipeline);
        bcPass.setBindGroup(0, bcBindGroup);
        bcPass.draw(3);
        bcPass.end();
      }
    }

    // Execute shader layers (between background and post-processing effects).
    // Each enabled shader-mode instance composites in turn at its stack position.
    // Zero-cost when none are renderable.
    if (this._shaderLayerRegistry?.hasRenderable() && this._shaderLayers.length > 0) {
      const overlayDt = isTimeFrozen ? 0 : this._lastDt;
      const bands = {
        bass: state.audioBass,
        mid: state.audioMid,
        high: state.audioHigh,
        energy: state.audioEnergy,
      };
      for (const layer of this._shaderLayers) {
        this._shaderLayerRegistry.render(
          layer.id,
          bgTargetView,
          encoder,
          overlayDt,
          bands,
          [this.width, this.height],
          state.audioAnalyser,
        );
      }
    }

    // ── GLSL guest layers (Stage 3a) ──────────────────────────────────
    // Composite after the shader overlay, at each guest's stack position. Each
    // guest renders into the shared WebGL2 host canvas, is copied into its owned
    // GPUTexture, then blended over the background target per its blend mode.
    // Zero-cost when none are renderable.
    if (this._glslGuestManager?.hasGuests() && this._glslLayers.length > 0 && routeToIntermediate) {
      const guestDt = isTimeFrozen ? 0 : this._lastDt;
      const audio = guestAudioFromStore();
      this._glslGuestManager.uploadAudio(audio.fft, audio.wave);
      this._glslGuestManager.setBackgroundVideo(this._backgroundVideo?.video ?? null);
      // Feed the live analyser so per-guest slot drivers resolve uValue1..8 from
      // each layer's audioRouting table (custom bands need the byte spectrum).
      this._glslGuestManager.setAnalyser(state.audioAnalyser ?? null);
      const guestBands = {
        bass: state.audioBass ?? 0,
        mid: state.audioMid ?? 0,
        high: state.audioHigh ?? 0,
        energy: state.audioEnergy ?? 0,
      };
      for (const layer of this._glslLayers) {
        this._glslGuestManager.renderAndComposite(
          layer.id,
          bgTargetView,
          encoder,
          guestDt,
          null, // slotValues resolved internally from the guest's audioRouting
          guestBands,
        );
      }
    }

    // Execute milkdrop feedback chain (between background and post-processing)
    // Zero-cost when disabled: chain is null when not active.
    // Pauses when audio is not playing (isTimeFrozen).
    if (this._milkdropChain && this._milkdropConfig?.enabled && !isTimeFrozen) {
      // Feed audio directly from the AnalyserNode (Butterchurn-style: raw FFT,
      // no intermediate smoothing layers). Falls back to audioStore values if
      // no analyser is available.
      if (this._milkdropAudio) {
        if (this._milkdropFFTBuffer && state.audioAnalyser) {
          state.audioAnalyser.getByteFrequencyData(this._milkdropFFTBuffer);
          this._milkdropAudio.pushFFT(
            this._milkdropFFTBuffer,
            state.audioAnalyser.context.sampleRate,
          );
        } else {
          // Fallback to audioStore values (pre-smoothed)
          this._milkdropAudio.push({
            bass: state.audioBass ?? 0,
            mid: state.audioMid ?? 0,
            treb: state.audioHigh ?? 0,
            energy: state.audioEnergy ?? 0,
          });
        }
      }

      // Render one frame of the feedback chain
      this._milkdropChain.renderFrame(
        encoder,
        this._milkdropFrame,
        bgTargetView,
        this.width,
        this.height,
      );
      this._milkdropFrame++;
    }

    // Butterchurn render for non-render-graph path (direct to swapchain)
    // When useRenderGraph is true, butterchurn was already rendered before the background pass.
    // (routeToIntermediate also covers the blur-only case, where butterchurn was
    // already rendered + copied into the intermediate target above.)
    if (butterchurnActive && !routeToIntermediate) {
      // Skip advancing butterchurn while paused (see the routeToIntermediate
      // branch above) — the preserved WebGL frame stays visible, just frozen.
      if (!isTimeFrozen) {
        const now = performance.now();
        if (now - this._butterchurnLastRenderTime >= 15) {
          this._butterchurnRenderer!.render(60);
          this._butterchurnLastRenderTime = now;
        }
      }
    }

    // ── Game-scene composite ──────────────────────────────────────────
    // Alpha-blend the game scene ON TOP of the fully-composited background
    // (image / video / shader overlay / milkdrop), so it sits above every
    // background type while its transparent regions reveal what is beneath.
    // Runs before blur + render graph so post-processing treats the composited
    // result as a single background.
    if (littlejsActive && routeToIntermediate && this._bgRenderTargetView) {
      this._compositeGameScene(this._bgRenderTargetView, encoder);
    }

    // ── Universal background blur ─────────────────────────────────────
    // Blur the COMPOSITED background target in place (after image/video/
    // butterchurn/game-scene/shader/milkdrop have landed in it), before the
    // render graph and lyric overlay. Source-agnostic — one path blurs every
    // background type. Runs only when routed through the intermediate target.
    if (blurActive && this._bgRenderTarget && this._bgRenderTargetView) {
      if (!this._bgBlurPass) {
        this._bgBlurPass = new BackgroundBlurPass(this.device, this.format);
      }
      this._bgBlurPass.execute(
        this._bgRenderTarget,
        this._bgRenderTargetView,
        encoder,
        this.width,
        this.height,
        blurAmount,
        state.backgroundBlurType ?? 1,
      );
    }

    // ── Layer-ordered path: lyrics interleaved with effect passes ──────
    // When the user has placed the lyric layer BELOW one or more effects,
    // composite the lyrics into the intermediate target between the
    // below-lyrics and above-lyrics effect groups, so only the above-lyrics
    // effects distort the lyrics. This requires routing through the
    // intermediate. Falls back to the legacy path below when there is no
    // split (anyAbove false), no pending lyrics, or the graph isn't routed.
    const layerSplit = this._layerPassSplit;
    const wantsLyricInterleave = !!(
      layerSplit?.anyAbove &&
      (this._pendingLyricBitmap || this._lyricFXActive) &&
      this._renderGraph !== null &&
      this._renderGraph.initialized &&
      this._bgRenderTargetView !== null
    );

    let lyricsComposited = false;

    if (wantsLyricInterleave) {
      const effectParams: EffectPassParams = {
        time: smoothedTime,
        dt: isTimeFrozen ? 0 : this._lastDt,
        resolution: [this.width, this.height],
        audioBass: state.audioBass,
        audioMid: state.audioMid,
        audioHigh: state.audioHigh,
        audioEnergy: state.audioEnergy,
        didReset,
      };

      // 1. Run the below-lyrics effect passes into the intermediate target.
      //    Skip when empty — a passthrough composite reading and writing the
      //    same view is unsafe; the composited background is already there.
      if (layerSplit!.below.length > 0) {
        this._renderGraph!.executeSubset(
          layerSplit!.below,
          this._bgRenderTargetView!,
          this._bgRenderTargetView!,
          effectParams,
          encoder,
        );
      }

      // 2. Composite the lyric layer INTO the intermediate target so the
      //    above-lyrics passes treat it as part of the scene. Prefer the GPU
      //    Lyric FX chain when active; else fall back to the Canvas2D bitmap.
      if (!this._lyricCompositePass) {
        this._lyricCompositePass = new LyricCompositePass(this.device, this.format);
      }
      if (
        this._tryCompositeLyricFX(this._bgRenderTargetView!, this._bgRenderTargetView!, encoder)
      ) {
        lyricsComposited = true;
      } else if (this._pendingLyricBitmap) {
        const lyricUploadOk = this._lyricCompositePass.uploadBitmap(this._pendingLyricBitmap);
        if (lyricUploadOk) {
          this._lyricCompositePass.execute(this._bgRenderTargetView!, encoder);
          lyricsComposited = true;
        }
      }

      // 3. Run the above-lyrics effect passes from the intermediate to the
      //    swapchain. If empty (shouldn't happen when anyAbove), passthrough.
      this._renderGraph!.executeSubset(
        layerSplit!.above,
        this._bgRenderTargetView!,
        swapchainView,
        effectParams,
        encoder,
      );

      if (this._pendingLyricBitmap && 'close' in this._pendingLyricBitmap) {
        this._pendingLyricBitmap.close();
      }
      this._pendingLyricBitmap = null;
    } else {
      // ── Legacy path: all effects, then lyrics over everything ──────────
      // Execute render graph effect passes (only when passes are actually enabled)
      if (useRenderGraph) {
        // Zero dt when paused so AR envelopes freeze alongside time
        const effectParams: EffectPassParams = {
          time: smoothedTime, // Frozen when paused (see smoothing logic above)
          dt: isTimeFrozen ? 0 : this._lastDt,
          resolution: [this.width, this.height],
          audioBass: state.audioBass,
          audioMid: state.audioMid,
          audioHigh: state.audioHigh,
          audioEnergy: state.audioEnergy,
          didReset,
        };

        this._renderGraph!.execute(this._bgRenderTargetView!, swapchainView, effectParams, encoder);
      } else if ((blurActive || sceneSourceActive) && this._bgRenderTargetView) {
        // The composited background (image + butterchurn/shaderFx/milkdrop/game
        // scene, optionally blurred) lives in the intermediate target but no
        // effect passes are enabled. Use the render graph's passthrough
        // composite (zero active passes) to blit it to the swapchain — otherwise
        // the screen would show nothing.
        const effectParams: EffectPassParams = {
          time: smoothedTime,
          dt: isTimeFrozen ? 0 : this._lastDt,
          resolution: [this.width, this.height],
          audioBass: state.audioBass,
          audioMid: state.audioMid,
          audioHigh: state.audioHigh,
          audioEnergy: state.audioEnergy,
          didReset,
        };
        this._renderGraph!.execute(this._bgRenderTargetView!, swapchainView, effectParams, encoder);
      }

      // Lyric composite pass — alpha-blend lyric over the scene. Prefer the
      // GPU Lyric FX chain when active; else the Canvas2D bitmap.
      if (this._lyricFXActive || this._pendingLyricBitmap) {
        if (!this._lyricCompositePass) {
          this._lyricCompositePass = new LyricCompositePass(this.device, this.format);
        }
        // layerBelow MUST be a sampleable (TEXTURE_BINDING) view — never the
        // swapchain (COPY_DST|RENDER_ATTACHMENT only). Use the bindable
        // background intermediate; pass null when it's unavailable so the graph
        // falls back to its own bindable target.
        const layerBelow = this._bgRenderTargetView ?? null;
        if (this._tryCompositeLyricFX(swapchainView, layerBelow, encoder)) {
          lyricsComposited = true;
        } else if (this._pendingLyricBitmap) {
          const lyricUploadOk = this._lyricCompositePass.uploadBitmap(this._pendingLyricBitmap);
          if (lyricUploadOk) {
            this._lyricCompositePass.execute(swapchainView, encoder);
            lyricsComposited = true;
          }
        }

        if (this._pendingLyricBitmap && 'close' in this._pendingLyricBitmap) {
          this._pendingLyricBitmap.close();
        }
        this._pendingLyricBitmap = null;
      }
    }

    this.device.queue.submit([encoder.finish()]);

    // When butterchurn is active but NO render graph (direct to swapchain path),
    // copy butterchurn directly to the swapchain after submit.
    // (routeToIntermediate covers the blur-only case, where butterchurn was
    // already composited + blurred into the swapchain via the passthrough.)
    if (butterchurnActive && !routeToIntermediate) {
      const bcCanvas = this._butterchurnRenderer!.getCanvas();
      try {
        // Rare fallback (no intermediate target): a 1:1 copy, clamped because
        // the butterchurn canvas is capped and may be smaller than the swapchain.
        this.device.queue.copyExternalImageToTexture(
          { source: bcCanvas },
          { texture: currentTexture, origin: [0, 0, 0] },
          [Math.min(this.width, bcCanvas.width), Math.min(this.height, bcCanvas.height)],
        );
      } catch {
        // Silently continue
      }

      // Re-composite lyrics on top if they were rendered this frame
      if (lyricsComposited && this._lyricCompositePass) {
        const encoder2 = this.device.createCommandEncoder({ label: 'lyric-over-bc' });
        this._lyricCompositePass.execute(swapchainView, encoder2);
        this.device.queue.submit([encoder2.finish()]);
      }
    }

    // When game scene is active but NO render graph (direct to swapchain path),
    // composite the scene ON TOP of the background already drawn into the
    // swapchain by the background pass. We render the scene into its owned
    // texture, then alpha-blend it over the swapchain (honouring per-pixel alpha
    // × opacity) so the background shows through the scene's empty regions.
    if (littlejsActive && !routeToIntermediate) {
      this._renderGameSceneToTexture(state);
      const encoderGs = this.device.createCommandEncoder({ label: 'game-scene-over-swapchain' });
      this._compositeGameScene(swapchainView, encoderGs);
      this.device.queue.submit([encoderGs.finish()]);

      // Re-composite lyrics on top if they were rendered this frame
      if (lyricsComposited && this._lyricCompositePass) {
        const encoder2 = this.device.createCommandEncoder({ label: 'lyric-over-ljs' });
        this._lyricCompositePass.execute(swapchainView, encoder2);
        this.device.queue.submit([encoder2.finish()]);
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  // Internal
  // ───────────────────────────────────────────────────────────

  private _rebuildBgBindGroup(): void {
    const tex1 = this._backgroundTexture1 ?? this.placeholderTexture;
    const tex2 = this._backgroundTexture2 ?? tex1;

    this._bgBindGroup = this.device.createBindGroup({
      label: 'bg-bind-group',
      layout: this.bgBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bgUniformBuffer } },
        { binding: 1, resource: tex1.texture.createView() },
        { binding: 2, resource: tex2.texture.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
  }

  // ───────────────────────────────────────────────────────────
  // Background render target (for effect pass routing)
  // ───────────────────────────────────────────────────────────

  private _createBgRenderTarget(): void {
    if (!this.device || this.width <= 0 || this.height <= 0) return;

    this._bgRenderTarget = this.device.createTexture({
      label: 'bg-render-target',
      size: [this.width, this.height, 1],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    this._bgRenderTargetView = this._bgRenderTarget.createView({
      label: 'bg-render-target-view',
    });
  }

  private _destroyBgRenderTarget(): void {
    this._bgRenderTarget?.destroy();
    this._bgRenderTarget = null;
    this._bgRenderTargetView = null;
  }

  // ───────────────────────────────────────────────────────────
  // External video pipeline (zero-copy)
  // ───────────────────────────────────────────────────────────

  private async _buildExternalVideoPipeline(): Promise<boolean> {
    const shaderModule = this.device.createShaderModule({
      label: 'background-external-video-shader',
      code: BACKGROUND_EXTERNAL_VIDEO_WGSL,
    });

    const info = await shaderModule.getCompilationInfo();
    for (const msg of info.messages) {
      if (msg.type === 'error') {
        console.error(`[WebGPURenderer] External video shader error: ${msg.message}`);
        return false;
      }
    }

    this._externalVideoBindGroupLayout = this.device.createBindGroupLayout({
      label: 'bg-external-video-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      label: 'bg-external-video-pl',
      bindGroupLayouts: [this._externalVideoBindGroupLayout],
    });

    try {
      this._externalVideoPipeline = await this.device.createRenderPipelineAsync({
        label: 'background-external-video-pipeline',
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_main',
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.format }],
        },
        primitive: { topology: 'triangle-list' },
      });
    } catch (err) {
      console.error('[WebGPURenderer] External video pipeline creation failed:', err);
      return false;
    }

    return true;
  }

  // ───────────────────────────────────────────────────────────
  // Cleanup
  // ───────────────────────────────────────────────────────────

  /** Derive a unique seed from a preset id string. */
  private _hashPresetId(id: string): number {
    let h = 0x811c9dc5; // FNV-1a offset basis
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  destroy(): void {
    // Idempotent: device-loss recovery destroys the lost renderer, and the
    // GPUCanvas unmount cleanup may destroy it again.
    if (this._disposed) return;
    this._disposed = true;
    this.onDeviceLost = null;
    this._butterchurnRenderer?.destroy();
    this._butterchurnRenderer = null;
    this._butterchurnTexture?.destroy();
    this._butterchurnTexture = null;
    this._shaderLayerRegistry?.destroy();
    this._shaderLayerRegistry = null;
    this._shaderLayers = [];
    this._glslGuestManager?.destroy();
    this._glslGuestManager = null;
    this._glslLayers = [];
    this._milkdropChain?.destroy();
    this._milkdropChain = null;
    this._renderGraph?.destroy();
    this._renderGraph = null;
    this._bgBlurPass?.destroy();
    this._bgBlurPass = null;
    this._gameSceneTexture?.destroy();
    this._gameSceneTexture = null;
    this._overlayLoadedTexture?.texture.destroy();
    this._overlayLoadedTexture = null;
    this._overlayPlaceholder?.texture.destroy();
    this._overlayPlaceholder = null;
    this._destroyBgRenderTarget();
    this.textureLoader?.destroy();
    this.bgUniformBuffer?.destroy();
    this.placeholderTexture?.texture.destroy();
    this._initialized = false;
  }
}

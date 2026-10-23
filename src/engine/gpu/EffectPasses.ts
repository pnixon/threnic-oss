/**
 * GPU Post-Processing Effect Pass Definitions
 *
 * Each effect exports a config (EffectPassConfig) and a createXxxUpdater
 * factory that returns a per-frame uniform update callback.
 *
 * Audio reactivity: createARUpdater() wires stateful attack/decay envelopes
 * for ALL declared numeric params — no per-param boilerplate needed.
 */

import type { EffectPassConfig, EffectPassParams } from './RenderGraph';
import type { AudioReactiveConfig } from '@/types/effects/audio-reactive';
import { RandomParamManager } from '@/components/effects/shared/useRandomInterval';

// ─── AudioReactivePassState ──────────────────────────────────────────────────

/** All effect pass states extend this to declare per-param AR configs. */
export interface AudioReactivePassState {
  audioReactive?: Record<string, AudioReactiveConfig | undefined>;
}

// ─── Box-plot curve ──────────────────────────────────────────────────────────

function applyBoxPlotCurve(raw: number, lo: number, hi: number, cx: number, bw: number): number {
  const bMin = Math.max(lo, cx - bw / 2);
  const bMax = Math.min(hi, cx + bw / 2);
  if (raw <= lo) return 0;
  if (raw >= hi) return 1;
  const n = (raw - lo) / (hi - lo);
  const lN = (bMin - lo) / (hi - lo);
  const hN = (bMax - lo) / (hi - lo);
  if (n < lN) return 0.1 * Math.log10(1 + 9 * (n / Math.max(lN, 0.0001)));
  if (n <= hN) return 0.1 + 0.8 * ((n - lN) / Math.max(hN - lN, 0.0001));
  return 0.9 + 0.1 * Math.log10(1 + 9 * ((n - hN) / Math.max(1 - hN, 0.0001)));
}

// ─── ARParamEnvelope ─────────────────────────────────────────────────────────

export interface ARParamEnvelope {
  compute(
    baseValue: number,
    config: AudioReactiveConfig | undefined,
    params: EffectPassParams,
  ): number;
  reset(): void;
}

export function createARParam(): ARParamEnvelope {
  let s = NaN;
  return {
    reset() {
      s = NaN;
    },
    compute(base, config, params) {
      if (!config?.enabled) return base;
      const raw =
        (
          { bass: params.audioBass, mid: params.audioMid, high: params.audioHigh } as Record<
            string,
            number
          >
        )[config.band] ?? params.audioEnergy;
      const lo = config.lowerThreshold ?? 0,
        hi = config.upperThreshold ?? 1;
      const bMin = Number.isFinite(config.min) ? config.min : base;
      const bMax = Number.isFinite(config.max) ? config.max : base;
      const aMin = Math.min(bMin, bMax),
        aMax = Math.max(bMin, bMax);
      let target: number;
      if (!config.invert && raw <= lo) {
        target = aMin;
      } else if (config.invert && raw >= hi) {
        target = aMin;
      } else {
        const curve = applyBoxPlotCurve(
          raw,
          lo,
          hi,
          config.boxCenter ?? 0.5,
          config.boxWidth ?? 0.3,
        );
        const [st, en] = config.invert ? [bMax, bMin] : [bMin, bMax];
        target = Math.max(aMin, Math.min(aMax, st + curve * (en - st) * (config.intensity ?? 1)));
      }
      if (!Number.isFinite(s)) {
        s = target;
        return s;
      }
      const sm = target > s ? (config.attack ?? 0.02) : (config.decay ?? 0.05);
      s += (target - s) * (1 - Math.exp(-params.dt / Math.max(0.001, sm)));
      s = Number.isFinite(s) ? Math.max(aMin, Math.min(aMax, s)) : aMin;
      return s;
    },
  };
}

// ─── createARUpdater ─────────────────────────────────────────────────────────

/**
 * Declares which numeric params of a pass state are audio-reactive.
 * null  → audioReactive key = param name
 * string → explicit override (key differs from param name)
 */
type ARSchema<TState> = Partial<Record<keyof TState, string | null>>;

/**
 * Unified GPU updater factory.
 *
 * One ARParamEnvelope per schema key is created once in the closure and
 * reused every frame. `fill` receives the resolved (smoothed) AR values
 * plus the raw state, and writes them into the uniforms Float32Array.
 *
 * To make every numeric param AR-capable: just add it to the schema.
 */
export function createARUpdater<TState extends AudioReactivePassState>(
  schema: ARSchema<TState>,
  fill: (
    uniforms: Float32Array,
    ar: Record<string, number>,
    s: TState,
    params: EffectPassParams,
  ) => void,
  getState: () => TState,
): (uniforms: Float32Array, params: EffectPassParams) => void {
  const envelopes: Record<string, ARParamEnvelope> = {};
  for (const key of Object.keys(schema)) envelopes[key] = createARParam();

  return (uniforms, params) => {
    const s = getState();
    const ar: Record<string, number> = {};
    for (const [pk, ak] of Object.entries(schema)) {
      ar[pk] = envelopes[pk].compute(
        (s as Record<string, unknown>)[pk] as number,
        s.audioReactive?.[(ak ?? pk) as string],
        params,
      );
    }
    fill(uniforms, ar, s, params);
  };
}

// ---------------------------------------------------------------------------
// Shader sources (inline — avoids bundler config for .wgsl imports)
// Note: The vertex shader is prepended automatically by the RenderGraph.
// These only contain the fragment shader + any shared structs.
// ---------------------------------------------------------------------------

// ─── Bloom ──────────────────────────────────────────────────────────────────

const BLOOM_FRAGMENT = /* wgsl */ `
struct Uniforms {
  intensity: f32,
  threshold: f32,
  softThreshold: f32,
  radius: f32,
  resolution_x: f32,
  resolution_y: f32,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn softThresholdFn(color: vec3f, threshold: f32, softKnee: f32) -> vec3f {
  let brightness = luminance(color);
  let knee = threshold * softKnee;
  let softCutoff = brightness - threshold + knee;
  let contribution = clamp(softCutoff / (2.0 * knee + 0.00001), 0.0, 1.0);
  let contribution2 = contribution * contribution;
  return color * max(contribution2, select(0.0, 1.0, brightness > threshold + knee));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let texelSize = vec2f(1.0 / u.resolution_x, 1.0 / u.resolution_y);
  let uv = input.uv;
  let originalColor = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let r = u.radius;
  var bloom = vec3f(0.0);
  let center = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  bloom += softThresholdFn(center, u.threshold, u.softThreshold) * 4.0;
  let s1 = textureSampleLevel(inputTexture, inputSampler, uv + vec2f(r, 0.0) * texelSize, 0.0).rgb;
  let s2 = textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-r, 0.0) * texelSize, 0.0).rgb;
  let s3 = textureSampleLevel(inputTexture, inputSampler, uv + vec2f(0.0, r) * texelSize, 0.0).rgb;
  let s4 = textureSampleLevel(inputTexture, inputSampler, uv + vec2f(0.0, -r) * texelSize, 0.0).rgb;
  bloom += softThresholdFn(s1, u.threshold, u.softThreshold) * 2.0;
  bloom += softThresholdFn(s2, u.threshold, u.softThreshold) * 2.0;
  bloom += softThresholdFn(s3, u.threshold, u.softThreshold) * 2.0;
  bloom += softThresholdFn(s4, u.threshold, u.softThreshold) * 2.0;
  let s5 = textureSampleLevel(inputTexture, inputSampler, uv + vec2f(r, r) * texelSize, 0.0).rgb;
  let s6 = textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-r, r) * texelSize, 0.0).rgb;
  let s7 = textureSampleLevel(inputTexture, inputSampler, uv + vec2f(r, -r) * texelSize, 0.0).rgb;
  let s8 = textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-r, -r) * texelSize, 0.0).rgb;
  bloom += softThresholdFn(s5, u.threshold, u.softThreshold) * 1.0;
  bloom += softThresholdFn(s6, u.threshold, u.softThreshold) * 1.0;
  bloom += softThresholdFn(s7, u.threshold, u.softThreshold) * 1.0;
  bloom += softThresholdFn(s8, u.threshold, u.softThreshold) * 1.0;
  bloom = bloom / 16.0;
  let result = originalColor.rgb + bloom * u.intensity;
  return vec4f(result, 1.0);
}
`;

export const BLOOM_PASS_ID = 'gpu-bloom';

export const bloomPassConfig: EffectPassConfig = {
  id: BLOOM_PASS_ID,
  label: 'Bloom',
  shaderSource: BLOOM_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 200,
};

interface BloomPassState extends AudioReactivePassState {
  intensity: number;
  threshold: number;
  softThreshold: number;
  radius: number;
  mode?: 'continuous' | 'random';
  randomInterval?: { min: number; max: number };
  randomDuration?: { min: number; max: number };
  attack?: number;
  decay?: number;
}

export function createBloomUpdater(getState: () => BloomPassState) {
  const rpmIntensity = new RandomParamManager('bloom', 1.0, 5.0, 0.15);

  return createARUpdater(
    { intensity: null, threshold: null, softThreshold: null, radius: null },
    (uniforms, ar, s, params) => {
      const finalIntensity = rpmIntensity.update(
        s.mode ?? 'continuous',
        ar.intensity,
        {
          randomInterval: s.randomInterval,
          randomDuration: s.randomDuration,
          attack: s.attack,
          decay: s.decay,
        },
        { time: params.time, dt: params.dt, didReset: params.didReset },
      );
      uniforms[0] = finalIntensity;
      uniforms[1] = ar.threshold;
      uniforms[2] = ar.softThreshold;
      uniforms[3] = ar.radius;
      uniforms[4] = params.resolution[0];
      uniforms[5] = params.resolution[1];
      uniforms[6] = params.time;
      uniforms[7] = 0;
    },
    getState,
  );
}

// ─── Color Grading ──────────────────────────────────────────────────────────

const COLOR_GRADE_FRAGMENT = /* wgsl */ `
struct Uniforms {
  brightness: f32,
  contrast: f32,
  saturation: f32,
  hueShift: f32,
  temperature: f32,
  gamma: f32,
  resolution_x: f32,
  resolution_y: f32,
  shadowR: f32,
  shadowG: f32,
  shadowB: f32,
  highlightR: f32,
  highlightG: f32,
  highlightB: f32,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn rgb2hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

fn applyTemperature(c: vec3f, temp: f32) -> vec3f {
  let warm = vec3f(1.0 + temp * 0.15, 1.0 + temp * 0.05, 1.0 - temp * 0.15);
  return c * warm;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  var color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  color = color * u.brightness;
  color = (color - 0.5) * u.contrast + 0.5;
  let lum = luminance(color);
  color = mix(vec3f(lum), color, u.saturation);
  if (abs(u.hueShift) > 0.001) {
    var hsv = rgb2hsv(color);
    hsv.x = fract(hsv.x + u.hueShift / 6.283185);
    color = hsv2rgb(hsv);
  }
  if (abs(u.temperature) > 0.001) {
    color = applyTemperature(color, u.temperature);
  }
  let shadowLift = vec3f(u.shadowR, u.shadowG, u.shadowB);
  let highlightGain = vec3f(u.highlightR, u.highlightG, u.highlightB);
  let lumFactor = luminance(color);
  color = color + shadowLift * (1.0 - lumFactor) + highlightGain * lumFactor;
  let safeGamma = max(u.gamma, 0.01);
  color = pow(max(color, vec3f(0.0)), vec3f(1.0 / safeGamma));
  color = clamp(color, vec3f(0.0), vec3f(1.0));
  return vec4f(color, 1.0);
}
`;

export const COLOR_GRADE_PASS_ID = 'gpu-color-grade';

export const colorGradePassConfig: EffectPassConfig = {
  id: COLOR_GRADE_PASS_ID,
  label: 'Color Grading',
  shaderSource: COLOR_GRADE_FRAGMENT,
  uniformBufferSize: 64, // 16 x f32
  priority: 300,
};

export interface ColorGradePassState extends AudioReactivePassState {
  brightness: number;
  contrast: number;
  saturation: number;
  hueShift: number;
  temperature: number;
  gamma: number;
  shadows: [number, number, number];
  highlights: [number, number, number];
}

export function createColorGradeUpdater(getState: () => ColorGradePassState) {
  const arBrightness = createARParam();
  const arContrast = createARParam();
  const arSaturation = createARParam();
  const arHueShift = createARParam();
  return (uniforms: Float32Array, params: EffectPassParams): void => {
    const s = getState();
    uniforms[0] = arBrightness.compute(s.brightness, s.audioReactive?.brightness, params);
    uniforms[1] = arContrast.compute(s.contrast, s.audioReactive?.contrast, params);
    uniforms[2] = arSaturation.compute(s.saturation, s.audioReactive?.saturation, params);
    uniforms[3] = arHueShift.compute(s.hueShift, s.audioReactive?.hueShift, params);
    uniforms[4] = s.temperature;
    uniforms[5] = s.gamma;
    uniforms[6] = params.resolution[0];
    uniforms[7] = params.resolution[1];
    uniforms[8] = s.shadows[0];
    uniforms[9] = s.shadows[1];
    uniforms[10] = s.shadows[2];
    uniforms[11] = s.highlights[0];
    uniforms[12] = s.highlights[1];
    uniforms[13] = s.highlights[2];
    uniforms[14] = params.time;
    uniforms[15] = 0; // pad
  };
}

// ─── Chromatic Aberration ───────────────────────────────────────────────────

const CHROMATIC_ABERRATION_FRAGMENT = /* wgsl */ `
struct Uniforms {
  intensity: f32,
  centerX: f32,
  centerY: f32,
  distortion: f32,
  resolution_x: f32,
  resolution_y: f32,
  redOffset: f32,
  blueOffset: f32,
  time: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn distortUV(uv: vec2f, center: vec2f, k: f32) -> vec2f {
  let delta = uv - center;
  let r2 = dot(delta, delta);
  return center + delta * (1.0 + k * r2);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  let center = vec2f(u.centerX, u.centerY);
  let delta = uv - center;
  let dist = length(delta);
  let dir = select(vec2f(0.0), delta / dist, dist > 0.001);
  let radialScale = dist * 2.0;
  let offset = u.intensity * radialScale;
  let redUV = uv + dir * offset * u.redOffset;
  let greenUV = uv;
  let blueUV = uv - dir * offset * u.blueOffset;
  var finalRedUV = redUV;
  var finalGreenUV = greenUV;
  var finalBlueUV = blueUV;
  if (abs(u.distortion) > 0.001) {
    finalRedUV = distortUV(redUV, center, u.distortion);
    finalGreenUV = distortUV(greenUV, center, u.distortion);
    finalBlueUV = distortUV(blueUV, center, u.distortion);
  }
  // Sample each channel — if offset UV is out of bounds, use center UV
  // to avoid stretching/smearing edge pixels into colored streaks.
  let safeRedUV = select(uv, finalRedUV, all(finalRedUV >= vec2f(0.0)) && all(finalRedUV <= vec2f(1.0)));
  let safeBlueUV = select(uv, finalBlueUV, all(finalBlueUV >= vec2f(0.0)) && all(finalBlueUV <= vec2f(1.0)));
  let r = textureSampleLevel(inputTexture, inputSampler, safeRedUV, 0.0).r;
  let g = textureSampleLevel(inputTexture, inputSampler, clamp(finalGreenUV, vec2f(0.0), vec2f(1.0)), 0.0).g;
  let b = textureSampleLevel(inputTexture, inputSampler, safeBlueUV, 0.0).b;
  return vec4f(r, g, b, 1.0);
}
`;

export const CHROMATIC_ABERRATION_PASS_ID = 'gpu-chromatic-aberration';

export const chromaticAberrationPassConfig: EffectPassConfig = {
  id: CHROMATIC_ABERRATION_PASS_ID,
  label: 'Chromatic Aberration',
  shaderSource: CHROMATIC_ABERRATION_FRAGMENT,
  uniformBufferSize: 48, // 12 x f32
  priority: 250,
};

interface ChromaticAberrationPassState extends AudioReactivePassState {
  intensity: number;
  centerX: number;
  centerY: number;
  distortion: number;
  redOffset: number;
  blueOffset: number;
  mode?: 'continuous' | 'random';
  randomInterval?: { min: number; max: number };
  randomDuration?: { min: number; max: number };
  attack?: number;
  decay?: number;
}

export function createChromaticAberrationUpdater(getState: () => ChromaticAberrationPassState) {
  const rpmIntensity = new RandomParamManager('chromaticAberration', 1.0, 5.0, 0.15);

  return createARUpdater(
    {
      intensity: null,
      centerX: null,
      centerY: null,
      distortion: null,
      redOffset: null,
      blueOffset: null,
    },
    (uniforms, ar, s, params) => {
      const finalIntensity = rpmIntensity.update(
        s.mode ?? 'continuous',
        ar.intensity,
        {
          randomInterval: s.randomInterval,
          randomDuration: s.randomDuration,
          attack: s.attack,
          decay: s.decay,
        },
        { time: params.time, dt: params.dt, didReset: params.didReset },
      );

      uniforms[0] = Math.max(-0.1, Math.min(0.1, finalIntensity));
      uniforms[1] = ar.centerX;
      uniforms[2] = ar.centerY;
      uniforms[3] = ar.distortion;
      uniforms[4] = params.resolution[0];
      uniforms[5] = params.resolution[1];
      uniforms[6] = ar.redOffset;
      uniforms[7] = ar.blueOffset;
      uniforms[8] = params.time;
      uniforms[9] = 0;
      uniforms[10] = 0;
      uniforms[11] = 0;
    },
    getState,
  );
}

// ─── Sepia ─────────────────────────────────────────────────────────────────

const SEPIA_FRAGMENT = /* wgsl */ `
struct Uniforms {
  intensity: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let sepia = vec3f(1.2, 1.0, 0.8);
  let result = mix(color.rgb, color.rgb * sepia, u.intensity);
  return vec4f(result, color.a);
}
`;

export const SEPIA_PASS_ID = 'gpu-sepia';

export const sepiaPassConfig: EffectPassConfig = {
  id: SEPIA_PASS_ID,
  label: 'Sepia',
  shaderSource: SEPIA_FRAGMENT,
  uniformBufferSize: 16, // 4 x f32
  priority: 310,
};

interface SepiaPassState extends AudioReactivePassState {
  intensity: number;
}

export function createSepiaUpdater(getState: () => SepiaPassState) {
  return createARUpdater(
    { intensity: null },
    (uniforms, ar) => {
      uniforms[0] = ar.intensity;
      uniforms[1] = 0;
      uniforms[2] = 0;
      uniforms[3] = 0;
    },
    getState,
  );
}

// ─── VHS Tracking ──────────────────────────────────────────────────────────

const VHS_TRACKING_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  intensity: f32,
  trackingSpeed: f32,
  distortionAmount: f32,
  chromaticSplit: f32,
  scanlineOffset: f32,
  loopTracking: f32,
  _pad: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hashVHS(p: vec2f) -> f32 {
  var q = fract(p * vec2f(233.34, 851.73));
  q += dot(q, q + 23.45);
  return fract(q.x * q.y);
}

fn hash2VHS(p: vec2f) -> vec2f {
  return vec2f(hashVHS(p), hashVHS(p + vec2f(127.1, 311.7)));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let p = input.uv;
  let texSize = vec2f(textureDimensions(inputTexture, 0));
  let intensity = u.intensity;

  // ── Tracking band position ──
  let effectiveTime = u.time + u.scanlineOffset;
  let linearPos = effectiveTime * u.trackingSpeed;
  let trackingPos = mix(linearPos, fract(linearPos), u.loopTracking);

  // Wider tracking band: 20-50% of screen depending on intensity
  let trackingSize = 0.15 + (intensity * 0.2);

  // Continuous mode (loopTracking = 1) loops: use fract() position and
  // wrap-around distance so the band re-enters from the opposite edge.
  // Single-streak mode (loopTracking = 0) must NOT wrap: use the raw
  // position and plain distance so exactly one streak travels off screen
  // and never comes back around.
  let loopingDist = p.y - fract(trackingPos);
  let wrappedDist = min(abs(loopingDist), min(abs(loopingDist + 1.0), abs(loopingDist - 1.0)));
  let singleDist = abs(p.y - trackingPos);
  let bandDist = mix(singleDist, wrappedDist, u.loopTracking);
  let trackingMask = 1.0 - smoothstep(0.0, trackingSize, bandDist);

  // ── Per-line noise (always slightly active, strong in tracking band) ──
  let lineNoise = hashVHS(vec2f(floor(p.y * 300.0), floor(u.time * 15.0)));
  let lineNoise2 = hashVHS(vec2f(floor(p.y * 150.0), floor(u.time * 8.0)));

  // Global subtle line distortion + strong tracking-band distortion
  let globalDistort = (lineNoise2 - 0.5) * 0.003 * intensity;
  let trackDistort = (lineNoise - 0.5) * u.distortionAmount * trackingMask * intensity * 0.5;
  let totalDistort = globalDistort + trackDistort;

  // Frame shake 
  let shake = (hashVHS(vec2f(u.time * 3.0, 0.0)) - 0.5) * 0.005 * intensity;
  let vertShake = (hashVHS(vec2f(0.0, u.time * 2.5)) - 0.5) * 0.002 * intensity;

  var distortedUV = p;
  distortedUV.x = distortedUV.x + totalDistort + shake;
  distortedUV.y = distortedUV.y + vertShake;

  // ── Chromatic aberration (global + tracking-enhanced) ──
  let globalSplit = 0.002 * intensity * u.chromaticSplit;
  let trackSplit = totalDistort * u.chromaticSplit * 2.0;
  let rgbSplit = globalSplit + trackSplit;

  let uvR = clamp(distortedUV + vec2f(rgbSplit, 0.0), vec2f(0.0), vec2f(1.0));
  let uvG = clamp(distortedUV, vec2f(0.0), vec2f(1.0));
  let uvB = clamp(distortedUV - vec2f(rgbSplit, 0.0), vec2f(0.0), vec2f(1.0));

  var r = textureSampleLevel(inputTexture, inputSampler, uvR, 0.0).r;
  var g = textureSampleLevel(inputTexture, inputSampler, uvG, 0.0).g;
  var b = textureSampleLevel(inputTexture, inputSampler, uvB, 0.0).b;
  let a = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0).a;

  // ── Scanlines (always visible) ──
  let scanlineFreq = texSize.y * 0.5; // One scanline per 2 pixels
  let scanline = sin(p.y * scanlineFreq * 3.14159) * 0.5 + 0.5;
  let scanlineStrength = 0.08 * intensity; // Subtle darkening between lines
  let scanlineMult = 1.0 - (scanlineStrength * (1.0 - scanline));

  r = r * scanlineMult;
  g = g * scanlineMult;
  b = b * scanlineMult;

  // ── Static noise (VHS grain) ──
  let noise = hashVHS(vec2f(p.x * texSize.x + u.time * 1000.0, p.y * texSize.y + u.time * 700.0));
  let noiseAmount = 0.03 * intensity + 0.06 * intensity * trackingMask;
  r = r + (noise - 0.5) * noiseAmount;
  g = g + (noise - 0.5) * noiseAmount;
  b = b + (noise - 0.5) * noiseAmount;

  // ── Tracking band brightness flash ──
  let flashAmount = trackingMask * intensity * 0.15;
  r = r + flashAmount;
  g = g + flashAmount;
  b = b + flashAmount;

  // ── Slight VHS color warmth/desaturation ──
  let lum = r * 0.299 + g * 0.587 + b * 0.114;
  let desatAmount = 0.1 * intensity;
  r = mix(r, lum, desatAmount);
  g = mix(g, lum, desatAmount);
  b = mix(b, lum, desatAmount);

  // Slight warm tint (VHS look)
  r = r + 0.01 * intensity;
  b = b - 0.008 * intensity;

  return vec4f(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0), a);
}
`;

export const VHS_TRACKING_PASS_ID = 'gpu-vhs-tracking';

export const vhsTrackingPassConfig: EffectPassConfig = {
  id: VHS_TRACKING_PASS_ID,
  label: 'VHS Tracking',
  shaderSource: VHS_TRACKING_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 260,
};

interface VHSTrackingPassState extends AudioReactivePassState {
  time: number;
  intensity: number;
  trackingSpeed: number;
  distortionAmount: number;
  chromaticSplit: number;
  scanlineOffset: number;
  loopTracking: number;
  mode?: 'continuous' | 'random';
  randomInterval?: { min: number; max: number };
  randomDuration?: { min: number; max: number };
  attack?: number;
  decay?: number;
}

export function createVHSTrackingUpdater(getState: () => VHSTrackingPassState) {
  const rpmIntensity = new RandomParamManager('vhsTracking', 1.0, 5.0, 0.2);
  let wasActive = false;
  let scanlineOffset = 0;
  // Start Y position (0..1) chosen for the next activation. computeDuration
  // picks it so the travel-time duration and the scanlineOffset agree on the
  // same starting position (single source of truth).
  let pendingStartY = 0;

  return createARUpdater(
    {
      intensity: null,
      trackingSpeed: null,
      distortionAmount: 'distortion',
      chromaticSplit: null,
      scanlineOffset: null,
    },
    (uniforms, ar, s, params) => {
      const speed = s.trackingSpeed || 0.2;
      const safeSpeed = Math.abs(speed) < 0.01 ? 0.01 : Math.abs(speed);

      const finalIntensity = rpmIntensity.update(
        s.mode ?? 'continuous',
        ar.intensity,
        {
          randomInterval: s.randomInterval,
          // No randomDuration / attack / decay for VHS tracking: the streak
          // runs until it scrolls fully off screen (computeDuration below),
          // with no fade-in/out envelope — a single hard streak per trigger.
          computeDuration: () => {
            pendingStartY = Math.random() * 0.7;
            const trackingSize = 0.15 + Math.min(Math.max(ar.intensity, 0), 2) * 0.2;
            const travel = 1.0 + trackingSize + 0.05 - pendingStartY;
            return travel / safeSpeed;
          },
        },
        { time: params.time, dt: params.dt, didReset: params.didReset },
      );

      const isActive = finalIntensity > 0.001;
      const isRandom = (s.mode ?? 'continuous') === 'random';

      if (isRandom) {
        // On activation edge, anchor the scanline offset to the start position
        // computeDuration chose, so band travel and duration stay in sync.
        if (isActive && !wasActive) {
          scanlineOffset = pendingStartY / safeSpeed - params.time;
        }
        if (params.didReset) {
          scanlineOffset = 0;
          wasActive = false;
        }
        wasActive = isActive;
      }

      uniforms[0] = params.time;
      uniforms[1] = isRandom ? finalIntensity : ar.intensity;
      uniforms[2] = ar.trackingSpeed;
      uniforms[3] = isRandom ? (isActive ? ar.distortionAmount : 0) : ar.distortionAmount;
      uniforms[4] = ar.chromaticSplit;
      uniforms[5] = isRandom ? scanlineOffset : ar.scanlineOffset;
      uniforms[6] = isRandom ? 0.0 : s.loopTracking;
      uniforms[7] = 0;
    },
    getState,
  );
}

// ─── Distortion ────────────────────────────────────────────────────────────

const DISTORTION_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  intensity: f32,
  distortAmount: f32,
  rippleSpeed: f32,
  rippleFrequency: f32,
  distortionType: f32,   // 0=radial, 1=horizontal, 2=vertical, 3=box
  tintR: f32,
  tintG: f32,
  tintB: f32,
  tintOpacity: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let p = input.uv;
  let center = vec2f(0.5, 0.5);
  let diff = p - center;

  // Distance metric depends on distortion type
  var dist: f32;
  let dtype = u.distortionType;
  if (dtype < 0.5) {
    // Radial
    dist = length(diff);
  } else if (dtype < 1.5) {
    // Horizontal
    dist = abs(diff.y);
  } else if (dtype < 2.5) {
    // Vertical
    dist = abs(diff.x);
  } else {
    // Box — Chebyshev distance
    dist = max(abs(diff.x), abs(diff.y));
  }

  // Animated ripple wave
  let phase = dist * u.rippleFrequency - u.time * u.rippleSpeed;
  let wave = sin(phase);

  // Displacement magnitude
  let displacement = wave * u.distortAmount * u.intensity * 0.02;

  // Direction of displacement
  var direction: vec2f;
  if (dtype < 0.5) {
    // Radial — push outward from center
    let safeDist = max(dist, 0.001);
    direction = diff / safeDist;
  } else if (dtype < 1.5) {
    // Horizontal — displace horizontally
    direction = vec2f(1.0, 0.0);
  } else if (dtype < 2.5) {
    // Vertical — displace vertically
    direction = vec2f(0.0, 1.0);
  } else {
    // Box — displace in both axes independently
    let waveX = sin(abs(diff.x) * u.rippleFrequency - u.time * u.rippleSpeed);
    let waveY = sin(abs(diff.y) * u.rippleFrequency - u.time * u.rippleSpeed * 0.8);
    direction = vec2f(sign(diff.x) * waveX, sign(diff.y) * waveY);
    // Re-normalize displacement for box mode
    let boxDisp = u.distortAmount * u.intensity * 0.02;
    let distortedUV = clamp(p + direction * boxDisp, vec2f(0.0), vec2f(1.0));
    let color = textureSampleLevel(inputTexture, inputSampler, distortedUV, 0.0);
    let tint = vec3f(u.tintR, u.tintG, u.tintB);
    let finalRGB = mix(color.rgb, color.rgb * tint, u.tintOpacity);
    return vec4f(finalRGB, color.a);
  }

  let distortedUV = clamp(p + direction * displacement, vec2f(0.0), vec2f(1.0));
  let color = textureSampleLevel(inputTexture, inputSampler, distortedUV, 0.0);

  // Apply optional tint
  let tint = vec3f(u.tintR, u.tintG, u.tintB);
  let finalRGB = mix(color.rgb, color.rgb * tint, u.tintOpacity);

  return vec4f(finalRGB, color.a);
}
`;

export const DISTORTION_PASS_ID = 'gpu-distortion';

export const distortionPassConfig: EffectPassConfig = {
  id: DISTORTION_PASS_ID,
  label: 'Distortion',
  shaderSource: DISTORTION_FRAGMENT,
  uniformBufferSize: 48, // 12 x f32
  priority: 200,
};

interface DistortionPassState extends AudioReactivePassState {
  time: number;
  intensity: number;
  distortAmount: number;
  rippleSpeed: number;
  rippleFrequency: number;
  distortionType: number; // 0=radial, 1=horizontal, 2=vertical, 3=box
  tintR: number;
  tintG: number;
  tintB: number;
  tintOpacity: number;
}

export function createDistortionUpdater(getState: () => DistortionPassState) {
  return createARUpdater(
    {
      intensity: null,
      distortAmount: null,
      rippleSpeed: null,
      rippleFrequency: null,
      tintOpacity: 'opacity',
      tintR: null,
      tintG: null,
      tintB: null,
    },
    (uniforms, ar, s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.intensity;
      uniforms[2] = ar.distortAmount;
      uniforms[3] = ar.rippleSpeed;
      uniforms[4] = ar.rippleFrequency;
      uniforms[5] = s.distortionType;
      uniforms[6] = ar.tintR;
      uniforms[7] = ar.tintG;
      uniforms[8] = ar.tintB;
      uniforms[9] = ar.tintOpacity;
      uniforms[10] = 0;
      uniforms[11] = 0;
    },
    getState,
  );
}

// ─── Noise Overlay ─────────────────────────────────────────────────────────

const NOISE_OVERLAY_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  grainSize: f32,
  vSyncSpeed: f32,
  intensity: f32,
  resolution_x: f32,
  resolution_y: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn randomNoise(st: vec2f) -> f32 {
  return fract(sin(dot(st, vec2f(12.9898, 78.233))) * 43758.5453123);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  let fragCoord = uv * vec2f(u.resolution_x, u.resolution_y);
  let originalColor = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);

  // Base noise grid
  let pos = floor(fragCoord / max(1.0, u.grainSize));

  // RGB phosphor separation
  let seedR = pos + vec2f(fract(u.time * 133.7) * 1000.0, fract(u.time * -214.3) * 1000.0);
  let seedG = pos + vec2f(fract(u.time * 143.2) * 1000.0, fract(u.time * -194.1) * 1000.0);
  let seedB = pos + vec2f(fract(u.time * 153.8) * 1000.0, fract(u.time * -234.5) * 1000.0);

  let r = randomNoise(seedR);
  let g = randomNoise(seedG);
  let b = randomNoise(seedB);

  // Mix colorful grains with monochrome
  var noiseColor = mix(vec3f(r, g, b), vec3f((r + g + b) / 3.0), 0.82);

  // V-Sync roll & interference
  let band = sin(uv.y * 5.0 + u.time * 4.0 * u.vSyncSpeed) * 0.5 + 0.5;
  let jitter = randomNoise(vec2f(u.time, uv.y)) * 0.05;
  noiseColor += (band * 0.12) + jitter;

  // CRT scanlines
  let scanline = sin(fragCoord.y * 1.5) * 0.12;
  noiseColor -= scanline;

  // Tube vignette
  let vignette = uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y);
  let vigClamp = clamp(pow(16.0 * vignette, 0.2), 0.0, 1.0);
  noiseColor *= vigClamp;

  // Blend with original image
  let result = mix(originalColor.rgb, noiseColor, u.intensity);
  return vec4f(result, originalColor.a);
}
`;

export const NOISE_OVERLAY_PASS_ID = 'gpu-noise-overlay';

export const noiseOverlayPassConfig: EffectPassConfig = {
  id: NOISE_OVERLAY_PASS_ID,
  label: 'Noise Overlay',
  shaderSource: NOISE_OVERLAY_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 270,
};

interface NoiseOverlayPassState extends AudioReactivePassState {
  grainSize: number;
  vSyncSpeed: number;
  intensity: number;
}

export function createNoiseOverlayUpdater(getState: () => NoiseOverlayPassState) {
  return createARUpdater(
    { grainSize: null, vSyncSpeed: null, intensity: 'opacity' },
    (uniforms, ar, _s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.grainSize;
      uniforms[2] = ar.vSyncSpeed;
      uniforms[3] = ar.intensity;
      uniforms[4] = params.resolution[0];
      uniforms[5] = params.resolution[1];
      uniforms[6] = 0;
      uniforms[7] = 0;
    },
    getState,
  );
}

// ─── Pixelation ────────────────────────────────────────────────────────────

const PIXELATION_FRAGMENT = /* wgsl */ `
struct Uniforms {
  pixelSize: f32,
  time: f32,
  resolution_x: f32,
  resolution_y: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  let resolution = vec2f(u.resolution_x, u.resolution_y);

  if (u.pixelSize <= 1.0) {
    return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  }

  // Calculate pixel grid
  let pixelUV = floor(uv * resolution / u.pixelSize) * u.pixelSize / resolution;
  return textureSampleLevel(inputTexture, inputSampler, pixelUV, 0.0);
}
`;

export const PIXELATION_PASS_ID = 'gpu-pixelation';

export const pixelationPassConfig: EffectPassConfig = {
  id: PIXELATION_PASS_ID,
  label: 'Pixelation',
  shaderSource: PIXELATION_FRAGMENT,
  uniformBufferSize: 16, // 4 x f32
  priority: 280,
};

interface PixelationPassState extends AudioReactivePassState {
  pixelSize: number;
}

export function createPixelationUpdater(getState: () => PixelationPassState) {
  return createARUpdater(
    { pixelSize: null },
    (uniforms, ar, _s, params) => {
      uniforms[0] = ar.pixelSize;
      uniforms[1] = params.time;
      uniforms[2] = params.resolution[0];
      uniforms[3] = params.resolution[1];
    },
    getState,
  );
}

// ─── Old Film ──────────────────────────────────────────────────────────────

/**
 * Grain type index mapping (must match GRAIN_TYPE_INDEX in JS).
 * Each algorithm is grounded in film emulsion science:
 * crystal morphology, RMS granularity, Callier Q, and magnification physics.
 *
 * Struct is 12 × f32 = 48 bytes (16-byte aligned).
 */
const OLD_FILM_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time:         f32,  // 0
  intensity:    f32,  // 4
  grainAmount:  f32,  // 8
  scratchAmount:f32,  // 12
  dirtAmount:   f32,  // 16
  grainScale:   f32,  // 20
  resolution_x: f32,  // 24
  resolution_y: f32,  // 28
  grainType:    f32,  // 32  — 0-14 index (see GRAIN_TYPE_INDEX)
  _pad1:        f32,  // 36
  _pad2:        f32,  // 40
  _pad3:        f32,  // 44
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

// IQ-style 2D hash — no large-multiplier fract() pre-wrap, so no integer-boundary
// lattice artifacts. Pure vec2f: avoids vec3f swizzle and vec3f += f32 ambiguity
// that cause WGSL compilation failures in some Dawn/Chrome builds.
fn hashFilm(p: vec2f) -> f32 {
  var q = fract(p * vec2f(0.1031, 0.1030));
  q = q + vec2f(dot(q, q.yx + vec2f(33.33)));
  return fract((q.x + q.y) * q.x);
}

// Derive a pseudo-random 2D UV offset from the discrete frame index.
// Using different seeds per sample breaks the repeated structure that
// linear (t * constant) offsets produce — those constants have rational
// relationships with the hash lattice period.
fn frameOffset(t: f32, seed: f32) -> vec2f {
  return vec2f(
    hashFilm(vec2f(t * 127.1 + seed * 311.7, seed * 74.7 + 13.0)),
    hashFilm(vec2f(t * 269.5 + seed * 183.3, seed * 246.1 + 7.0))
  );
}

fn organicNoise(uv: vec2f, seed: f32, time: f32) -> f32 {
  let t = floor(time * 8.0);
  return hashFilm(uv * 4.0 + frameOffset(t, seed));
}

fn luminanceFilm(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// Gaussian approximation via Central Limit Theorem: average of 4 uniform
// samples → near-triangular → centred near-Gaussian in [-1, 1].
fn gaussianGrain(uv: vec2f, scale: f32, t: f32) -> f32 {
  let h1 = hashFilm(uv * scale        + frameOffset(t, 1.0));
  let h2 = hashFilm(uv * scale * 1.07 + frameOffset(t, 2.0));
  let h3 = hashFilm(uv * scale * 0.93 + frameOffset(t, 3.0));
  let h4 = hashFilm(uv * scale * 1.13 + frameOffset(t, 4.0));
  return ((h1 + h2 + h3 + h4) * 0.25 - 0.5) * 2.0;
}

// Per-grain-type noise kernel. Returns a value in roughly [-1, 1].
fn computeGrain(uv: vec2f, gt: i32, scale: f32, time: f32) -> f32 {
  let ns = scale * 120.0;
  var result = 0.0;

  if (gt == 0) {
    // procedural — multi-octave, discretised to 24 fps
    let t  = floor(time * 24.0);
    let g1 = hashFilm(uv * ns        + frameOffset(t, 1.0));
    let g2 = hashFilm(uv * (ns * 0.5) + frameOffset(t, 2.0));
    result = (g1 * 0.70 + g2 * 0.30) * 2.0 - 1.0;

  } else if (gt == 1) {
    // gilded_fine — ISO 25-100, CLT-Gaussian, very fine (RMS 3-7)
    let t = floor(time * 24.0);
    result = gaussianGrain(uv, ns * 1.83, t);

  } else if (gt == 2) {
    // foundry_medium — ISO 200-400, smoothstep soft edges
    let t    = floor(time * 20.0);
    let raw  = hashFilm(uv * (ns * 1.08) + frameOffset(t, 1.0));
    let soft = smoothstep(0.20, 0.80, raw);
    let g2   = hashFilm(uv * (ns * 0.71) + frameOffset(t, 2.0));
    result = (soft * 0.60 + g2 * 0.40) * 2.0 - 1.0;

  } else if (gt == 3) {
    // elongated_halide — anisotropic lath crystals (~4:1 aspect ratio)
    let t   = floor(time * 18.0);
    let uvH = vec2f(uv.x * 3.70, uv.y * 0.80);
    let uvV = vec2f(uv.x * 0.80, uv.y * 3.70);
    let g1  = hashFilm(uvH * (ns * 1.25) + frameOffset(t, 1.0));
    let g2  = hashFilm(uvV * (ns * 1.25) + frameOffset(t, 2.0));
    let g3  = hashFilm(uv  * (ns * 0.60) + frameOffset(t, 3.0));
    result = (g1 * 0.40 + g2 * 0.40 + g3 * 0.20) * 2.0 - 1.0;

  } else if (gt == 4) {
    // majestic_coarse — ISO 1600-3200, hard step() blobs (log-normal heavy tail)
    let t    = floor(time * 12.0);
    let blob = step(0.55, hashFilm(uv * (ns * 0.33) + frameOffset(t, 1.0)));
    let fine = hashFilm(uv * (ns * 1.10) + frameOffset(t, 2.0));
    result = (blob * 0.65 + fine * 0.35) * 2.0 - 1.0;

  } else if (gt == 5) {
    // raw_emulsion — undeveloped: near-uniform micro-texture + coating swirl
    let t     = floor(time * 48.0);
    let micro = hashFilm(uv * (ns * 2.50) + frameOffset(t, 1.0));
    let swirl = hashFilm(uv * (ns * 0.07) + frameOffset(t, 2.0));
    result = ((micro * 0.70 + swirl * 0.30) * 2.0 - 1.0) * 0.35;

  } else if (gt == 6) {
    // refined_intensifier — pow(<1) amplifies grain peaks (intensification physics)
    let t   = floor(time * 20.0);
    let amp = pow(hashFilm(uv * (ns * 1.08) + frameOffset(t, 1.0)), 0.45);
    let den = hashFilm(uv * (ns * 1.60) + frameOffset(t, 2.0));
    result = (amp * 0.70 + den * 0.30) * 2.0 - 1.0;

  } else if (gt == 7) {
    // studio_35mm — Kodak Vision3 dye clouds, CLT-Gaussian, isotropic
    let t = floor(time * 24.0);
    result = gaussianGrain(uv, ns * 1.50, t);

  } else if (gt == 8) {
    // reporter_16mm — ~2.5x magnification + horizontal gate weave
    let t     = floor(time * 18.0);
    let weave = sin(time * 12.566) * 0.003;
    let wUV   = vec2f(uv.x + weave, uv.y);
    let g1    = hashFilm(wUV * (ns * 0.72) + frameOffset(t, 1.0));
    let g2    = hashFilm(wUV * (ns * 0.44) + frameOffset(t, 2.0));
    result = (g1 * 0.60 + g2 * 0.40) * 2.0 - 1.0;

  } else if (gt == 9) {
    // amateur_8mm — huge blobs + per-frame projector lamp flicker
    let t       = floor(time * 10.0);
    let blob    = smoothstep(0.35, 0.65, hashFilm(uv * (ns * 0.18) + frameOffset(t, 1.0)));
    let detail  = hashFilm(uv * (ns * 0.55) + frameOffset(t, 2.0));
    let flicker = (hashFilm(vec2f(t * 127.1, 1.0)) - 0.5) * 0.07;
    result = (blob * 0.70 + detail * 0.30) * 2.0 - 1.0 + flicker;

  } else if (gt == 10) {
    // panchromatic_noir — Tri-X 400: bimodal (fine base + hard-edged clusters)
    let t       = floor(time * 20.0);
    let fine    = hashFilm(uv * (ns * 0.92) + frameOffset(t, 1.0));
    let cluster = step(0.80, hashFilm(uv * (ns * 0.23) + frameOffset(t, 2.0)));
    result = (fine * 0.70 + cluster * 0.30) * 2.0 - 1.0;

  } else if (gt == 11) {
    // tabular_contrast — Kodak T-MAX 100: hexagonal flat-plate crystals
    // Very uniform (low polydispersity), near-perfect Gaussian, very soft Callier Q
    let t = floor(time * 30.0);
    result = gaussianGrain(uv, ns * 2.17, t) * 0.70;

  } else if (gt == 12) {
    // dusty_academy — worn 16mm classroom print: fine base + Poisson dust spots + gate weave
    let t        = floor(time * 18.0);
    let weave    = sin(time * 7.854) * 0.004;
    let wUV      = vec2f(uv.x + weave, uv.y);
    let base     = hashFilm(wUV * (ns * 0.83) + vec2f(t * 0.10, t * 0.17));
    let dust     = step(0.94, hashFilm(uv * (ns * 0.12) + vec2f(t * 0.03, t * 0.05)));
    result = (base * 0.70 + dust * 0.30) * 2.0 - 1.0;

  } else if (gt == 13) {
    // theatrical_gate — 35mm print stock (Kodak 2383), very fine dye clouds, near-Gaussian
    // Print stock emulsion is finer than camera negative
    let t = floor(time * 24.0);
    result = gaussianGrain(uv, ns * 1.58, t) * 0.80;

  } else {
    // underground_grit (14) — grindhouse: 3-generation accumulated grain
    // Variance adds per generation: σ_total ≈ √(σ₁² + σ₂² + σ₃²)
    let t    = floor(time * 14.0);
    let gen1 = smoothstep(0.40, 0.60, hashFilm(uv * (ns * 0.46) + vec2f(t * 0.11, t * 0.21)));
    let gen2 = hashFilm(uv * (ns * 0.83) + vec2f(t * 0.17, t * 0.09));
    let gen3 = hashFilm(uv * (ns * 1.25) + vec2f(t * 0.23, t * 0.15));
    result = (gen1 * 0.45 + gen2 * 0.35 + gen3 * 0.20) * 2.0 - 1.0;
  }

  return result;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  var color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);

  let gt = i32(round(u.grainType));
  var grain = computeGrain(uv, gt, u.grainScale, u.time);

  // Grit power maps crystal morphology → Callier Q contrast factor.
  // Dense silver cubic/pushed grain (high Callier) → harder contrast impact.
  // Dye clouds or undeveloped halide (low Callier) → softer.
  var gritPower: f32;
  if (gt == 4 || gt == 9 || gt == 14) {
    gritPower = 7.5; // majestic_coarse, amateur_8mm, underground_grit
  } else if (gt == 10 || gt == 6) {
    gritPower = 6.5; // panchromatic_noir (Tri-X), refined_intensifier
  } else if (gt == 5 || gt == 11 || gt == 13 || gt == 1 || gt == 7) {
    gritPower = 3.2; // raw_emulsion, tabular (T-MAX), theatrical, gilded_fine, studio_35mm
  } else {
    gritPower = 4.8;
  }
  grain *= gritPower;

  let lum = luminanceFilm(color.rgb);

  // Grain lives in midtones (negative film: peaks at ~50% luminance).
  // Reversal (8mm Kodachrome): grain in highlights — shift mask for type 9.
  var grainMask: f32;
  if (gt == 9) {
    grainMask = clamp(pow(lum, 0.30) * (1.0 - pow(lum, 4.0)), 0.0, 1.0);
  } else {
    grainMask = clamp(pow(lum, 0.50) * (1.0 - pow(lum, 8.0)), 0.0, 1.0);
  }

  let grainEffect = 1.0 + (grain * u.grainAmount * u.intensity * grainMask);
  color = vec4f(color.rgb * grainEffect, color.a);

  // Procedural scratches (vertical lines)
  let scratchX = uv.x * 2.0 + hashFilm(vec2f(floor(u.time * 20.0), 0.0));
  let scratchN = hashFilm(vec2f(scratchX, floor(u.time * 5.0)));
  let scratch  = step(0.992, scratchN) * u.intensity * u.scratchAmount;
  color = vec4f(color.rgb + vec3f(scratch * 0.7), color.a);

  // Organic dirt spots
  let dirt1     = organicNoise(uv, 12.34, u.time);
  let spot1     = smoothstep(0.96, 0.99, dirt1);
  let extraDirt = spot1 * u.intensity * u.dirtAmount;
  color = vec4f(color.rgb * (1.0 - extraDirt * 0.9), color.a);

  return color;
}
`;

export const OLD_FILM_PASS_ID = 'gpu-old-film';

export const oldFilmPassConfig: EffectPassConfig = {
  id: OLD_FILM_PASS_ID,
  label: 'Old Film',
  shaderSource: OLD_FILM_FRAGMENT,
  uniformBufferSize: 48, // 12 × f32 (8 payload + grainType + 3 pad for 16-byte alignment)
  priority: 290,
};

interface OldFilmPassState extends AudioReactivePassState {
  intensity: number;
  grainAmount: number;
  scratchAmount: number;
  dirtAmount: number;
  grainScale: number;
  grainType?: string; // maps to GRAIN_TYPE_INDEX; undefined → 0 (procedural)
  mode?: 'continuous' | 'random';
  randomInterval?: { min: number; max: number };
  randomDuration?: { min: number; max: number };
  attack?: number;
  decay?: number;
}

/** Maps grain type name → integer index for WGSL i32(round(u.grainType)) */
const GRAIN_TYPE_INDEX: Record<string, number> = {
  procedural: 0,
  gilded_fine: 1,
  foundry_medium: 2,
  elongated_halide: 3,
  majestic_coarse: 4,
  raw_emulsion: 5,
  refined_intensifier: 6,
  studio_35mm: 7,
  reporter_16mm: 8,
  amateur_8mm: 9,
  panchromatic_noir: 10,
  tabular_contrast: 11,
  dusty_academy: 12,
  theatrical_gate: 13,
  underground_grit: 14,
};

export function createOldFilmUpdater(getState: () => OldFilmPassState) {
  const rpmIntensity = new RandomParamManager('oldFilm', 2.0, 8.0, 0.3);

  return createARUpdater(
    { intensity: null, grainAmount: null, scratchAmount: null, dirtAmount: null, grainScale: null },
    (uniforms, ar, s, params) => {
      const finalIntensity = rpmIntensity.update(
        s.mode ?? 'continuous',
        ar.intensity,
        {
          randomInterval: s.randomInterval,
          randomDuration: s.randomDuration,
          attack: s.attack,
          decay: s.decay,
        },
        { time: params.time, dt: params.dt, didReset: params.didReset },
      );
      uniforms[0] = params.time;
      uniforms[1] = finalIntensity;
      uniforms[2] = ar.grainAmount;
      uniforms[3] = ar.scratchAmount;
      uniforms[4] = ar.dirtAmount;
      uniforms[5] = ar.grainScale;
      uniforms[6] = params.resolution[0];
      uniforms[7] = params.resolution[1];
      uniforms[8] = GRAIN_TYPE_INDEX[s.grainType ?? 'procedural'] ?? 0;
      // uniforms[9..11] = _pad — Float32Array defaults to 0, no write needed
    },
    getState,
  );
}

// ─── Glitch ────────────────────────────────────────────────────────────────

const GLITCH_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  strength: f32,
  blocks: f32,
  glitchActive: f32,
  resolution_x: f32,
  resolution_y: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hashGlitch(p: vec2f) -> f32 {
  var q = fract(p * vec2f(233.34, 851.73));
  q += dot(q, q + 23.45);
  return fract(q.x * q.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;

  if (u.glitchActive < 0.5 || u.strength < 0.001) {
    return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  }

  // Block-based glitch distortion
  let blockY = floor(uv.y * (10.0 + u.blocks * 50.0));
  let blockSeed = vec2f(blockY, floor(u.time * 20.0));
  let blockNoise = hashGlitch(blockSeed);

  // Only affect some blocks
  var distortedUV = uv;
  if (blockNoise > 0.7) {
    let shift = (hashGlitch(blockSeed + 0.5) - 0.5) * u.strength * 0.3;
    distortedUV.x += shift;
  }

  // Horizontal line tearing
  let lineNoise = hashGlitch(vec2f(floor(uv.y * 200.0), floor(u.time * 15.0)));
  if (lineNoise > 0.95) {
    distortedUV.x += (hashGlitch(vec2f(u.time, uv.y)) - 0.5) * u.strength * 0.1;
  }

  // RGB split (chromatic)
  let rgbOffset = u.strength * 0.015;
  let rUV = clamp(distortedUV + vec2f(rgbOffset, 0.0), vec2f(0.0), vec2f(1.0));
  let gUV = clamp(distortedUV, vec2f(0.0), vec2f(1.0));
  let bUV = clamp(distortedUV - vec2f(rgbOffset, 0.0), vec2f(0.0), vec2f(1.0));

  let r = textureSampleLevel(inputTexture, inputSampler, rUV, 0.0).r;
  let g = textureSampleLevel(inputTexture, inputSampler, gUV, 0.0).g;
  let b = textureSampleLevel(inputTexture, inputSampler, bUV, 0.0).b;

  // Color corruption on some blocks
  var result = vec3f(r, g, b);
  if (blockNoise > 0.85) {
    let corruption = hashGlitch(blockSeed + 1.0);
    result = mix(result, vec3f(corruption, 1.0 - corruption, corruption * 0.5), u.strength * 0.3);
  }

  return vec4f(result, 1.0);
}
`;

export const GLITCH_PASS_ID = 'gpu-glitch';

export const glitchPassConfig: EffectPassConfig = {
  id: GLITCH_PASS_ID,
  label: 'Glitch',
  shaderSource: GLITCH_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 255,
};

interface GlitchPassState extends AudioReactivePassState {
  strength: number;
  blocks: number;
  glitchActive: number;
  mode?: 'continuous' | 'random';
  randomInterval?: { min: number; max: number };
  randomDuration?: { min: number; max: number };
  attack?: number;
  decay?: number;
}

export function createGlitchUpdater(getState: () => GlitchPassState) {
  const rpmStrength = new RandomParamManager('glitch', 1.0, 5.0, 0.15);

  return createARUpdater(
    { strength: null, blocks: null },
    (uniforms, ar, s, params) => {
      const finalStrength = rpmStrength.update(
        s.mode ?? 'continuous',
        ar.strength,
        {
          randomInterval: s.randomInterval,
          randomDuration: s.randomDuration,
          attack: s.attack,
          decay: s.decay,
        },
        { time: params.time, dt: params.dt, didReset: params.didReset },
      );
      uniforms[0] = params.time;
      uniforms[1] = finalStrength;
      uniforms[2] = ar.blocks;
      uniforms[3] = finalStrength > 0.001 ? 1.0 : 0.0;
      uniforms[4] = params.resolution[0];
      uniforms[5] = params.resolution[1];
      uniforms[6] = 0;
      uniforms[7] = 0;
    },
    getState,
  );
}

// ─── Gate Jitter ───────────────────────────────────────────────────────────

const GATE_JITTER_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  intensity: f32,
  speed: f32,
  jitterActive: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hashGate(p: vec2f) -> f32 {
  var q = fract(p * vec2f(233.34, 851.73));
  q += dot(q, q + 23.45);
  return fract(q.x * q.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  var uv = input.uv;

  if (u.jitterActive < 0.5 || u.intensity < 0.001) {
    return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  }

  // Frame gate jitter — simulates film projector instability
  let frameTime = floor(u.time * u.speed * 24.0);
  let jitterX = (hashGate(vec2f(frameTime, 0.0)) - 0.5) * u.intensity * 0.02;
  let jitterY = (hashGate(vec2f(0.0, frameTime)) - 0.5) * u.intensity * 0.03;

  uv.x += jitterX;
  uv.y += jitterY;

  // Occasional vertical jump (film splice)
  let spliceNoise = hashGate(vec2f(frameTime * 0.1, 42.0));
  if (spliceNoise > 0.95) {
    uv.y += (hashGate(vec2f(frameTime, 99.0)) - 0.5) * u.intensity * 0.15;
  }

  let clamped = clamp(uv, vec2f(0.0), vec2f(1.0));
  return textureSampleLevel(inputTexture, inputSampler, clamped, 0.0);
}
`;

export const GATE_JITTER_PASS_ID = 'gpu-gate-jitter';

export const gateJitterPassConfig: EffectPassConfig = {
  id: GATE_JITTER_PASS_ID,
  label: 'Gate Jitter',
  shaderSource: GATE_JITTER_FRAGMENT,
  uniformBufferSize: 16, // 4 x f32
  priority: 265,
};

interface GateJitterPassState extends AudioReactivePassState {
  intensity: number;
  speed: number;
  jitterActive: number;
}

export function createGateJitterUpdater(getState: () => GateJitterPassState) {
  return createARUpdater(
    { intensity: null, speed: null },
    (uniforms, ar, s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.intensity;
      uniforms[2] = ar.speed;
      uniforms[3] = s.jitterActive;
    },
    getState,
  );
}

// ─── Bulb Flicker ──────────────────────────────────────────────────────────

const BULB_FLICKER_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  intensity: f32,
  speed: f32,
  flickerActive: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);

  if (u.flickerActive < 0.5 || u.intensity < 0.001) {
    return color;
  }

  // Simulate incandescent bulb flicker (mains frequency variation)
  let t = u.time * u.speed;
  let flicker1 = sin(t * 120.0 * 3.14159) * 0.5 + 0.5; // 60Hz ripple
  let flicker2 = sin(t * 7.3) * 0.5 + 0.5; // Low-frequency variation
  let flicker3 = sin(t * 23.7 + 1.3) * 0.5 + 0.5; // Medium variation

  // Combine flicker components with different weights
  let flickerAmount = flicker1 * 0.3 + flicker2 * 0.5 + flicker3 * 0.2;
  let brightness = 1.0 - (flickerAmount * u.intensity * 0.4);

  return vec4f(color.rgb * brightness, color.a);
}
`;

export const BULB_FLICKER_PASS_ID = 'gpu-bulb-flicker';

export const bulbFlickerPassConfig: EffectPassConfig = {
  id: BULB_FLICKER_PASS_ID,
  label: 'Bulb Flicker',
  shaderSource: BULB_FLICKER_FRAGMENT,
  uniformBufferSize: 16, // 4 x f32
  priority: 295,
};

interface BulbFlickerPassState extends AudioReactivePassState {
  intensity: number;
  speed: number;
  flickerActive: number;
}

export function createBulbFlickerUpdater(getState: () => BulbFlickerPassState) {
  return createARUpdater(
    { intensity: null, speed: null },
    (uniforms, ar, s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.intensity;
      uniforms[2] = ar.speed;
      uniforms[3] = s.flickerActive;
    },
    getState,
  );
}

// ─── Chain Lightning ───────────────────────────────────────────────────────

const CHAIN_LIGHTNING_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  glowIntensity: f32,
  arcWidth: f32,
  nodeCount: f32,
  duration: f32,
  cooldown: f32,
  resolution_x: f32,
  resolution_y: f32,
  colorR: f32,
  colorG: f32,
  colorB: f32,
  _pad: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hashLN(p: vec2f) -> f32 {
  var q = fract(p * vec2f(127.1, 311.7));
  q += dot(q, q + 43.73);
  return fract(q.x * q.y);
}

fn noise1D(x: f32) -> f32 {
  let i = floor(x);
  let f = fract(x);
  return mix(hashLN(vec2f(i, 0.0)), hashLN(vec2f(i + 1.0, 0.0)), f * f * (3.0 - 2.0 * f));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let originalColor = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let uv = input.uv;
  let aspect = u.resolution_x / u.resolution_y;

  // Strike timing
  let cycle = u.duration + u.cooldown;
  let phase = u.time % cycle;
  let isActive = step(phase, u.duration);

  if (isActive < 0.5) {
    return originalColor;
  }

  // Normalized phase within the strike
  let strikeT = phase / u.duration;
  let fadeIn = smoothstep(0.0, 0.1, strikeT);
  let fadeOut = smoothstep(1.0, 0.7, strikeT);
  let fade = fadeIn * fadeOut;

  // Generate arc path between procedural nodes
  let nodes = u.nodeCount;
  let arcUV = vec2f(uv.x * aspect, uv.y);

  var lightning = 0.0;
  let seed = floor(u.time / cycle);

  for (var seg = 0.0; seg < 7.0; seg += 1.0) {
    if (seg >= nodes - 1.0) { break; }

    // Node positions
    let t0 = seg / (nodes - 1.0);
    let t1 = (seg + 1.0) / (nodes - 1.0);

    let p0y = hashLN(vec2f(seed + seg, 0.0));
    let p0x = t0;
    let p1y = hashLN(vec2f(seed + seg + 1.0, 0.0));
    let p1x = t1;

    // Interpolation along segment
    let segStart = p0x;
    let segEnd = p1x;

    if (uv.x >= segStart && uv.x <= segEnd) {
      let localT = (uv.x - segStart) / max(segEnd - segStart, 0.001);
      let baseY = mix(p0y, p1y, localT);

      // Add noise jitter for jagged appearance
      let jitter = noise1D(uv.x * 30.0 + seed * 7.0 + u.time * 20.0) * 0.1;
      let arcY = baseY + jitter;

      let dist = abs(uv.y - arcY);
      let width = u.arcWidth * 0.005;

      // Core line
      lightning += exp(-dist * dist / (width * width)) * fade;

      // Glow
      let glowWidth = width * 6.0;
      lightning += exp(-dist * dist / (glowWidth * glowWidth)) * fade * 0.3;
    }
  }

  let lightningColor = vec3f(u.colorR, u.colorG, u.colorB);
  let result = originalColor.rgb + lightningColor * lightning * u.glowIntensity;
  return vec4f(result, originalColor.a);
}
`;

export const CHAIN_LIGHTNING_PASS_ID = 'gpu-chain-lightning';

export const chainLightningPassConfig: EffectPassConfig = {
  id: CHAIN_LIGHTNING_PASS_ID,
  label: 'Chain Lightning',
  shaderSource: CHAIN_LIGHTNING_FRAGMENT,
  uniformBufferSize: 48, // 12 x f32
  priority: 230,
};

interface ChainLightningPassState extends AudioReactivePassState {
  glowIntensity: number;
  arcWidth: number;
  nodeCount: number;
  duration: number;
  cooldown: number;
  colorR: number;
  colorG: number;
  colorB: number;
}

export function createChainLightningUpdater(getState: () => ChainLightningPassState) {
  return createARUpdater(
    { glowIntensity: null, arcWidth: null, nodeCount: null, duration: null, cooldown: null },
    (uniforms, ar, s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.glowIntensity;
      uniforms[2] = ar.arcWidth;
      uniforms[3] = ar.nodeCount;
      uniforms[4] = ar.duration;
      uniforms[5] = ar.cooldown;
      uniforms[6] = params.resolution[0];
      uniforms[7] = params.resolution[1];
      uniforms[8] = s.colorR;
      uniforms[9] = s.colorG;
      uniforms[10] = s.colorB;
      uniforms[11] = 0;
    },
    getState,
  );
}

// ─── LUT Color Grading ────────────────────────────────────────────────────

const LUT_FRAGMENT = /* wgsl */ `
struct Uniforms {
  intensity: f32,
  preset: f32,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn luminanceLUT(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn applyTealOrange(c: vec3f) -> vec3f {
  let lum = luminanceLUT(c);
  let warm = vec3f(1.15, 0.95, 0.75);   // highlights → orange
  let cool = vec3f(0.65, 0.9, 1.05);     // shadows → teal
  let toned = c * mix(cool, warm, lum);
  return mix(c, toned, 0.8);
}

fn applyNoir(c: vec3f) -> vec3f {
  let lum = luminanceLUT(c);
  // Desaturate + boost contrast
  let desat = vec3f(lum);
  let contrasted = (desat - 0.5) * 1.4 + 0.5;
  return clamp(contrasted, vec3f(0.0), vec3f(1.0));
}

fn applyCineVibrant(c: vec3f) -> vec3f {
  let lum = luminanceLUT(c);
  // Boost saturation + slight warm shift
  let sat = mix(vec3f(lum), c, 1.6);
  return clamp(sat * vec3f(1.05, 1.0, 0.95), vec3f(0.0), vec3f(1.0));
}

fn applyCrushedBlacks(c: vec3f) -> vec3f {
  // Lift shadows, crush low end
  let lifted = max(c - 0.05, vec3f(0.0));
  return pow(lifted, vec3f(1.3)) * 1.1;
}

fn applyColdShadows(c: vec3f) -> vec3f {
  let lum = luminanceLUT(c);
  let shadowTint = vec3f(0.85, 0.92, 1.15);
  return c * mix(shadowTint, vec3f(1.0), smoothstep(0.0, 0.5, lum));
}

fn applyWarmHighlights(c: vec3f) -> vec3f {
  let lum = luminanceLUT(c);
  let highlightTint = vec3f(1.15, 1.05, 0.85);
  return c * mix(vec3f(1.0), highlightTint, smoothstep(0.3, 0.8, lum));
}

fn applyBleachBypass(c: vec3f) -> vec3f {
  let lum = luminanceLUT(c);
  let desat = mix(c, vec3f(lum), 0.5);
  return clamp((desat - 0.5) * 1.5 + 0.5, vec3f(0.0), vec3f(1.0));
}

fn applyCrossProcess(c: vec3f) -> vec3f {
  // Green shadows, magenta highlights
  var result = c;
  result.r = c.r * 0.9 + 0.1 * c.b;
  result.g = c.g * 1.1;
  result.b = c.b * 0.8 + 0.2 * c.r;
  return clamp(result, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let presetId = i32(u.preset + 0.5);

  var graded = color.rgb;

  // 0 = none, 1 = tealOrange, 2 = noir, 3 = cineVibrant,
  // 4 = crushedBlacks, 5 = coldShadows, 6 = warmHighlights,
  // 7 = bleachBypass, 8 = crossProcess
  if (presetId == 1) { graded = applyTealOrange(color.rgb); }
  else if (presetId == 2) { graded = applyNoir(color.rgb); }
  else if (presetId == 3) { graded = applyCineVibrant(color.rgb); }
  else if (presetId == 4) { graded = applyCrushedBlacks(color.rgb); }
  else if (presetId == 5) { graded = applyColdShadows(color.rgb); }
  else if (presetId == 6) { graded = applyWarmHighlights(color.rgb); }
  else if (presetId == 7) { graded = applyBleachBypass(color.rgb); }
  else if (presetId == 8) { graded = applyCrossProcess(color.rgb); }

  let result = mix(color.rgb, graded, u.intensity);
  return vec4f(clamp(result, vec3f(0.0), vec3f(1.0)), color.a);
}
`;

export const LUT_PASS_ID = 'gpu-lut';

export const lutPassConfig: EffectPassConfig = {
  id: LUT_PASS_ID,
  label: 'LUT Color Grading',
  shaderSource: LUT_FRAGMENT,
  uniformBufferSize: 16, // 4 x f32
  priority: 305,
};

const LUT_PRESET_MAP: Record<string, number> = {
  none: 0,
  tealOrange: 1,
  noir: 2,
  cineVibrant: 3,
  crushedBlacks: 4,
  coldShadows: 5,
  warmHighlights: 6,
  bleachBypass: 7,
  crossProcess: 8,
};

interface LutPassState extends AudioReactivePassState {
  preset: string;
  intensity: number;
}

export function createLutUpdater(getState: () => LutPassState) {
  return createARUpdater(
    { intensity: null },
    (uniforms, ar, s, params) => {
      uniforms[0] = ar.intensity;
      uniforms[1] = LUT_PRESET_MAP[s.preset] ?? 0;
      uniforms[2] = params.time;
      uniforms[3] = 0;
    },
    getState,
  );
}

// ─── Motion Blur / Echo ───────────────────────────────────────────────────

const MOTION_BLUR_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  intensity: f32,
  decay: f32,
  trailCount: f32,
  resolution_x: f32,
  resolution_y: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hashMB(p: vec2f) -> f32 {
  var q = fract(p * vec2f(127.1, 311.7));
  q += dot(q, q + 43.73);
  return fract(q.x * q.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  let originalColor = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);

  if (u.intensity < 0.001 || u.trailCount < 1.5) {
    return originalColor;
  }

  // Simulate echo/ghosting by sampling at slightly offset UVs
  // Each "trail" uses a time-varying offset to create temporal smear
  var accumulated = originalColor.rgb;
  var weight = 1.0;
  let trails = i32(u.trailCount + 0.5);

  for (var i = 1; i < 16; i++) {
    if (i >= trails) { break; }

    let fi = f32(i);
    let decayFactor = pow(u.decay, fi);

    // Create directional offset based on time (simulates motion direction)
    let angle = u.time * 2.0 + fi * 0.7;
    let offset = vec2f(
      sin(angle) * fi * 0.003 * u.intensity,
      cos(angle * 0.7) * fi * 0.002 * u.intensity
    );

    let sampleUV = clamp(uv + offset, vec2f(0.0), vec2f(1.0));
    let trailColor = textureSampleLevel(inputTexture, inputSampler, sampleUV, 0.0).rgb;

    accumulated += trailColor * decayFactor;
    weight += decayFactor;
  }

  let result = mix(originalColor.rgb, accumulated / weight, u.intensity);
  return vec4f(result, originalColor.a);
}
`;

export const MOTION_BLUR_PASS_ID = 'gpu-motion-blur';

export const motionBlurPassConfig: EffectPassConfig = {
  id: MOTION_BLUR_PASS_ID,
  label: 'Motion Blur / Echo',
  shaderSource: MOTION_BLUR_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 240,
};

interface MotionBlurPassState extends AudioReactivePassState {
  intensity: number;
  decay: number;
  trailCount: number;
}

export function createMotionBlurUpdater(getState: () => MotionBlurPassState) {
  return createARUpdater(
    { intensity: null, decay: null, trailCount: null },
    (uniforms, ar, _s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.intensity;
      uniforms[2] = ar.decay;
      uniforms[3] = ar.trailCount;
      uniforms[4] = params.resolution[0];
      uniforms[5] = params.resolution[1];
      uniforms[6] = 0;
      uniforms[7] = 0;
    },
    getState,
  );
}

// ─── Lens Flare ───────────────────────────────────────────────────────────

const LENS_FLARE_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  intensity: f32,
  threshold: f32,
  streakLength: f32,
  ghostCount: f32,
  ghostSpacing: f32,
  tintR: f32,
  tintG: f32,
  tintB: f32,
  anamorphic: f32,
  resolution_x: f32,
  resolution_y: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn luminanceLF(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn sampleBright(sampleUV: vec2f) -> vec3f {
  let c = textureSampleLevel(inputTexture, inputSampler, clamp(sampleUV, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  let lum = luminanceLF(c);
  let bright = max(lum - u.threshold, 0.0) / max(1.0 - u.threshold, 0.001);
  return c * bright;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  let originalColor = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let center = vec2f(0.5, 0.5);
  let texelSize = vec2f(1.0 / u.resolution_x, 1.0 / u.resolution_y);

  var flare = vec3f(0.0);

  // 1. Anamorphic streaks (horizontal blur of bright areas)
  if (u.anamorphic > 0.5 && u.streakLength > 0.01) {
    let samples = 12;
    let spread = u.streakLength * 0.15;
    for (var i = -12; i <= 12; i++) {
      if (abs(i) > samples) { continue; }
      let fi = f32(i);
      let weight = exp(-abs(fi) / 4.0);
      let offsetUV = uv + vec2f(fi * spread * texelSize.x * 8.0, 0.0);
      flare += sampleBright(offsetUV) * weight;
    }
    flare /= 8.0;
  }

  // 2. Ghost reflections
  let ghosts = i32(u.ghostCount + 0.5);
  
  // Add organic sway to the lens flare ghosts so it feels alive and animated
  let sway = vec2f(sin(u.time * 0.5), cos(u.time * 0.3)) * 0.02;
  let dir = center - uv + sway;
  
  for (var g = 0; g < 8; g++) {
    if (g >= ghosts) { break; }
    let fg = f32(g + 1);
    let ghostPos = uv + dir * fg * u.ghostSpacing;
    let bright = sampleBright(ghostPos);
    let falloff = 1.0 / (1.0 + fg * 0.5);
    flare += bright * falloff * 0.15;
  }

  // 3. Central starburst (procedural)
  let sampleAtCenter = sampleBright(uv);
  let centerBright = luminanceLF(sampleAtCenter);
  // Slowly rotate the starburst over time
  let starAngle = atan2(uv.y - 0.5, uv.x - 0.5) + u.time * 0.15;
  let starDist = length(uv - 0.5);
  let star = pow(abs(cos(starAngle * 3.0)), 32.0) * centerBright * 0.3;
  flare += vec3f(star) * smoothstep(0.3, 0.0, starDist);

  let tintColor = vec3f(u.tintR, u.tintG, u.tintB);
  let result = originalColor.rgb + flare * tintColor * u.intensity;
  return vec4f(clamp(result, vec3f(0.0), vec3f(2.0)), originalColor.a);
}
`;

export const LENS_FLARE_PASS_ID = 'gpu-lens-flare';

export const lensFlarePassConfig: EffectPassConfig = {
  id: LENS_FLARE_PASS_ID,
  label: 'Lens Flare',
  shaderSource: LENS_FLARE_FRAGMENT,
  uniformBufferSize: 48, // 12 x f32
  priority: 210,
};

interface LensFlarePassState extends AudioReactivePassState {
  intensity: number;
  threshold: number;
  streakLength: number;
  ghostCount: number;
  ghostSpacing: number;
  tintR: number;
  tintG: number;
  tintB: number;
  anamorphic: number;
}

export function createLensFlareUpdater(getState: () => LensFlarePassState) {
  return createARUpdater(
    {
      intensity: null,
      threshold: null,
      streakLength: null,
      ghostCount: null,
      ghostSpacing: null,
      anamorphic: null,
    },
    (uniforms, ar, s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.intensity;
      uniforms[2] = ar.threshold;
      uniforms[3] = ar.streakLength;
      uniforms[4] = ar.ghostCount;
      uniforms[5] = ar.ghostSpacing;
      uniforms[6] = s.tintR;
      uniforms[7] = s.tintG;
      uniforms[8] = s.tintB;
      uniforms[9] = ar.anamorphic;
      uniforms[10] = params.resolution[0];
      uniforms[11] = params.resolution[1];
    },
    getState,
  );
}

// ─── Camera Shake ─────────────────────────────────────────────────────────

const CAMERA_SHAKE_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  intensity: f32,
  frequency: f32,
  damping: f32,
  rotational: f32,
  maxRotation: f32,
  resolution_x: f32,
  resolution_y: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hashShake(p: vec2f) -> f32 {
  var q = fract(p * vec2f(127.1, 311.7));
  q += dot(q, q + 43.73);
  return fract(q.x * q.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  var uv = input.uv;

  if (u.intensity < 0.0001) {
    return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  }

  let t = u.time * u.frequency;

  // Multi-frequency shake for organic feel
  let shakeX = sin(t * 6.283) * 0.6
             + sin(t * 2.7 * 6.283 + 1.3) * 0.3
             + sin(t * 5.1 * 6.283 + 2.7) * 0.1;
  let shakeY = cos(t * 6.283 + 0.5) * 0.6
             + cos(t * 3.1 * 6.283 + 0.7) * 0.3
             + cos(t * 4.3 * 6.283 + 1.9) * 0.1;

  // Apply displacement
  let offset = vec2f(shakeX, shakeY) * u.intensity;
  uv += offset;

  // Optional rotation
  if (u.rotational > 0.5 && u.maxRotation > 0.01) {
    let rotAngle = sin(t * 6.283 * 0.7 + 0.3) * u.maxRotation * 0.01745329;
    let center = vec2f(0.5, 0.5);
    let centeredUV = uv - center;
    let cosA = cos(rotAngle);
    let sinA = sin(rotAngle);
    uv = vec2f(
      centeredUV.x * cosA - centeredUV.y * sinA,
      centeredUV.x * sinA + centeredUV.y * cosA
    ) + center;
  }

  let finalUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  return textureSampleLevel(inputTexture, inputSampler, finalUV, 0.0);
}
`;

export const CAMERA_SHAKE_PASS_ID = 'gpu-camera-shake';

export const cameraShakePassConfig: EffectPassConfig = {
  id: CAMERA_SHAKE_PASS_ID,
  label: 'Camera Shake',
  shaderSource: CAMERA_SHAKE_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 100, // Early in pipeline (before color grading)
};

interface CameraShakePassState extends AudioReactivePassState {
  intensity: number;
  frequency: number;
  damping: number;
  rotational: number;
  maxRotation: number;
}

export function createCameraShakeUpdater(getState: () => CameraShakePassState) {
  return createARUpdater(
    { intensity: null, frequency: null, damping: null, maxRotation: null },
    (uniforms, ar, s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.intensity;
      uniforms[2] = ar.frequency;
      uniforms[3] = ar.damping;
      uniforms[4] = s.rotational;
      uniforms[5] = ar.maxRotation;
      uniforms[6] = params.resolution[0];
      uniforms[7] = params.resolution[1];
    },
    getState,
  );
}

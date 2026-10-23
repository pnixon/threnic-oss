/**
 * TSL Effect implementations for WebGPU post-processing.
 *
 * Each effect is a function component that registers a TSL transformation
 * with the NodeEffectComposer via useNodeEffect.
 *
 * The TSL function receives:
 * - color: current accumulated color (vec4 node)
 * - u: the effect's uniform map
 * - sceneTexture: original scene pass texture (for UV re-sampling effects)
 *
 * Uniforms are created via Three.js TSL `uniform()` and updated every frame.
 * All effects preserve audio-reactivity support.
 */

'use client';

import React from 'react';
import { Vector2, Vector3 } from 'three';
import {
  uniform,
  vec3,
  vec4,
  float,
  clamp,
  mix,
  abs,
  sin,
  cos,
  floor,
  dot,
  pow,
  screenUV,
  smoothstep,
  length,
  exp,
  vec2,
  fract,
  texture,
} from 'three/tsl';
import * as THREE from 'three';
import type { Node, TextureNode } from 'three/webgpu';
import { useNodeEffect, type TSLEffectFn } from './NodeEffectComposer';
import { useAudioReactiveEnvelope } from '@/hooks/useAudioReactive';
import { useRandomInterval } from './useRandomInterval';
import { useEffectFrame } from './useEffectFrame';

import type { PostProcessingConfig } from '@/types/effects';

// ═══════════════════════════════════════════════════════════════════════════
// BRIGHTNESS (Priority: 10)
// ═══════════════════════════════════════════════════════════════════════════

const brightnessFn: TSLEffectFn = (color, u) => {
  return vec4(color.rgb.mul(u.brightness), color.a);
};

interface BrightnessProps {
  enabled: boolean;
  config: PostProcessingConfig['brightness'];
}

export function TSLBrightnessEffect({ enabled, config }: BrightnessProps) {
  const u = React.useMemo(() => ({ brightness: uniform(1.0) }), []);
  useNodeEffect('brightness', 10, brightnessFn, u, enabled);

  const audioEnvelope = useAudioReactiveEnvelope(
    0,
    config.audioReactive ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    let val = config.brightness ?? 1.0;
    if (config.audioReactive?.enabled) {
      audioEnvelope.update(ctx.dt);
      val = audioEnvelope.current;
    }
    u.brightness.value = val;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTRAST (Priority: 20)
// ═══════════════════════════════════════════════════════════════════════════

const contrastFn: TSLEffectFn = (color, u) => {
  const mid = vec3(u.midpoint, u.midpoint, u.midpoint);
  const contrasted = color.rgb.sub(mid).mul(u.contrast).add(mid);
  return vec4(clamp(contrasted, 0.0, 10.0), color.a);
};

interface ContrastProps {
  enabled: boolean;
  config: PostProcessingConfig['contrast'];
}

export function TSLContrastEffect({ enabled, config }: ContrastProps) {
  const u = React.useMemo(() => ({ contrast: uniform(1.0), midpoint: uniform(0.5) }), []);
  useNodeEffect('contrast', 20, contrastFn, u, enabled);

  const audioEnvelope = useAudioReactiveEnvelope(
    0,
    config.audioReactive ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 1.0,
      max: 1.5,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    let val = config.contrast ?? 1.0;
    if (config.audioReactive?.enabled) {
      audioEnvelope.update(ctx.dt);
      val = audioEnvelope.current;
    }
    u.contrast.value = val;
    u.midpoint.value = config.midpoint ?? 0.5;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SATURATION (Priority: 30)
// ═══════════════════════════════════════════════════════════════════════════

const saturationFn: TSLEffectFn = (color, u) => {
  const luminanceWeights = vec3(0.2126, 0.7152, 0.0722);
  const lum = dot(color.rgb, luminanceWeights);
  const grey = vec3(lum, lum, lum);
  const saturated = mix(grey, color.rgb, u.saturation);
  return vec4(clamp(saturated, 0.0, 10.0), color.a);
};

interface SaturationProps {
  enabled: boolean;
  config: PostProcessingConfig['saturation'];
}

export function TSLSaturationEffect({ enabled, config }: SaturationProps) {
  const u = React.useMemo(() => ({ saturation: uniform(1.0) }), []);
  useNodeEffect('saturation', 30, saturationFn, u, enabled);

  const audioEnvelope = useAudioReactiveEnvelope(
    0,
    config.audioReactive ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 2.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    let val = config.saturation ?? 1.0;
    if (config.audioReactive?.enabled) {
      audioEnvelope.update(ctx.dt);
      val = audioEnvelope.current;
    }
    u.saturation.value = val;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HUE SHIFT (Priority: 25)
// Config field: config.hue (degrees)
// ═══════════════════════════════════════════════════════════════════════════

const hueShiftFn: TSLEffectFn = (color, u) => {
  const cosA = cos(u.hueRad);
  const sinA = sin(u.hueRad);
  const r = color.r
    .mul(float(0.299).add(float(0.701).mul(cosA)).add(float(0.168).mul(sinA)))
    .add(color.g.mul(float(0.587).sub(float(0.587).mul(cosA)).add(float(0.33).mul(sinA))))
    .add(color.b.mul(float(0.114).sub(float(0.114).mul(cosA)).sub(float(0.497).mul(sinA))));
  const g = color.r
    .mul(float(0.299).sub(float(0.299).mul(cosA)).sub(float(0.328).mul(sinA)))
    .add(color.g.mul(float(0.587).add(float(0.413).mul(cosA)).add(float(0.035).mul(sinA))))
    .add(color.b.mul(float(0.114).sub(float(0.114).mul(cosA)).add(float(0.292).mul(sinA))));
  const b = color.r
    .mul(float(0.299).sub(float(0.3).mul(cosA)).add(float(1.25).mul(sinA)))
    .add(color.g.mul(float(0.587).sub(float(0.588).mul(cosA)).sub(float(1.05).mul(sinA))))
    .add(color.b.mul(float(0.114).add(float(0.886).mul(cosA)).sub(float(0.203).mul(sinA))));
  return vec4(clamp(vec3(r, g, b), 0.0, 10.0), color.a);
};

interface HueShiftProps {
  enabled: boolean;
  config: PostProcessingConfig['hueShift'];
}

export function TSLHueShiftEffect({ enabled, config }: HueShiftProps) {
  const u = React.useMemo(() => ({ hueRad: uniform(0.0) }), []);
  useNodeEffect('hueShift', 25, hueShiftFn, u, enabled);

  const audioEnvelope = useAudioReactiveEnvelope(
    0,
    config.audioReactive ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 6.28,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    let val = config.hue ?? 0.0;
    if (config.audioReactive?.enabled) {
      audioEnvelope.update(ctx.dt);
      val = audioEnvelope.current;
    }
    u.hueRad.value = (val * Math.PI) / 180;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEPIA (Priority: 40)
// ═══════════════════════════════════════════════════════════════════════════

const sepiaFn: TSLEffectFn = (color, u) => {
  const r = dot(color.rgb, vec3(0.393, 0.769, 0.189));
  const g = dot(color.rgb, vec3(0.349, 0.686, 0.168));
  const b = dot(color.rgb, vec3(0.272, 0.534, 0.131));
  const sepia = vec3(r, g, b);
  const result = mix(color.rgb, sepia, u.intensity);
  return vec4(clamp(result, 0.0, 1.0), color.a);
};

interface SepiaProps {
  enabled: boolean;
  config: PostProcessingConfig['sepia'];
}

export function TSLSepiaEffect({ enabled, config }: SepiaProps) {
  const u = React.useMemo(() => ({ intensity: uniform(1.0) }), []);
  useNodeEffect('sepia', 40, sepiaFn, u, enabled);

  const audioEnvelope = useAudioReactiveEnvelope(
    0,
    config.audioReactive ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    let val = config.intensity ?? 1.0;
    if (config.audioReactive?.enabled) {
      audioEnvelope.update(ctx.dt);
      val = audioEnvelope.current;
    }
    u.intensity.value = val;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BULB FLICKER (Priority: 15)
// Config: config.intensity (no "speed" field — uses intensity for amplitude)
// ═══════════════════════════════════════════════════════════════════════════

const bulbFlickerFn: TSLEffectFn = (color, u) => {
  return vec4(color.rgb.mul(u.flickerValue), color.a);
};

interface BulbFlickerProps {
  enabled: boolean;
  config: PostProcessingConfig['bulbFlicker'];
}

export function TSLBulbFlickerEffect({ enabled, config }: BulbFlickerProps) {
  const u = React.useMemo(() => ({ flickerValue: uniform(1.0) }), []);
  useNodeEffect('bulbFlicker', 15, bulbFlickerFn, u, enabled);

  const audioEnvelope = useAudioReactiveEnvelope(
    0,
    config.audioReactive ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.8,
      max: 1.2,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    let val = 1.0;
    const intensity = config.intensity ?? 0.3;
    if (config.audioReactive?.enabled) {
      audioEnvelope.update(ctx.dt);
      val = audioEnvelope.current;
    } else {
      const t = ctx.time * 8.0;
      const flicker = Math.sin(t * 13.37) * Math.sin(t * 7.13) * Math.sin(t * 3.97);
      val = 1.0 + flicker * intensity;
    }
    u.flickerValue.value = Math.max(0, val);
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BLOOM (Priority: 5)
// Config: intensity, threshold, mode, audioReactive.intensity, audioReactive.threshold
// ═══════════════════════════════════════════════════════════════════════════

const bloomFn: TSLEffectFn = (color, u) => {
  const luminanceWeights = vec3(0.2126, 0.7152, 0.0722);
  const lum = dot(color.rgb, luminanceWeights);
  const threshold = u.threshold;
  // Extract bright pixels above threshold (soft knee)
  const bright = color.rgb.mul(smoothstep(threshold, threshold.add(0.1), lum));
  // Add bright contribution scaled by intensity
  const result = color.rgb.add(bright.mul(u.intensity));
  return vec4(result, color.a);
};

interface BloomProps {
  enabled: boolean;
  config: PostProcessingConfig['bloom'];
}

export function TSLBloomEffect({ enabled, config }: BloomProps) {
  const u = React.useMemo(
    () => ({
      intensity: uniform(0.5),
      threshold: uniform(0.2),
    }),
    [],
  );
  useNodeEffect('bloom', 5, bloomFn, u, enabled);

  const intensityEnvelope = useAudioReactiveEnvelope(
    config.intensity ?? 0.5,
    config.audioReactive?.intensity ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.5,
      min: 0.0,
      max: 2.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );
  const thresholdEnvelope = useAudioReactiveEnvelope(
    config.threshold ?? 0.2,
    config.audioReactive?.threshold ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  const randomState = useRandomInterval({
    minInterval: config.randomInterval?.min ?? 1,
    maxInterval: config.randomInterval?.max ?? 5,
    activeDuration: 0.15,
    targetValue: config.intensity ?? 0.5,
    baseValue: 0,
    lerpSpeed: 0.1,
    minDuration: config.randomDuration?.min,
    maxDuration: config.randomDuration?.max,
    attack: config.attack,
    decay: config.decay,
    effectId: 'bloom',
  });

  useEffectFrame((ctx) => {
    intensityEnvelope.update(ctx.dt);
    thresholdEnvelope.update(ctx.dt);
    let finalIntensity = 0;
    let finalThreshold = 0.2;
    if (config.mode === 'random') {
      finalIntensity = randomState.update({ time: ctx.time, dt: ctx.dt, didReset: ctx.didReset });
      finalThreshold = config.threshold ?? 0.2;
    } else {
      finalIntensity = intensityEnvelope.current;
      finalThreshold = thresholdEnvelope.current;
    }
    u.intensity.value = finalIntensity;
    u.threshold.value = finalThreshold;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHROMATIC ABERRATION (Priority: 60)
// Config: offset, mode, audioReactive (flat AudioReactiveConfig)
//
// Samples R channel at UV+offset, G at UV (center), B at UV-offset.
// All three channels are explicitly sampled from sceneTexture to avoid
// issues when `color` is a raw texture node (first effect in chain).
// ═══════════════════════════════════════════════════════════════════════════

const chromaticAberrationFn: TSLEffectFn = (color, u, sceneTexture) => {
  const uv = screenUV;
  const offset = u.offset;
  // Apply dynamic overscan zoom based on offset to prevent out-of-bound edge clamping
  const zoomedUV = uv
    .sub(vec2(0.5))
    .mul(float(1.0).sub(offset.mul(float(2.0))))
    .add(vec2(0.5));
  // Create directional offset vectors (horizontal split)
  const offsetVec = vec3(offset, float(0.0), float(0.0));
  const rUV = zoomedUV.add(offsetVec.xy);
  const gUV = zoomedUV; // Green stays centered
  const bUV = zoomedUV.sub(offsetVec.xy);
  // Explicitly sample all channels from the scene texture
  const rSample = sceneTexture.sample(rUV);
  const gSample = sceneTexture.sample(gUV);
  const bSample = sceneTexture.sample(bUV);
  return vec4(rSample.r, gSample.g, bSample.b, gSample.a);
};

interface ChromaticAberrationProps {
  enabled: boolean;
  config: PostProcessingConfig['chromaticAberration'];
}

export function TSLChromaticAberrationEffect({ enabled, config }: ChromaticAberrationProps) {
  const u = React.useMemo(() => ({ offset: uniform(0.001) }), []);
  useNodeEffect('chromaticAberration', 60, chromaticAberrationFn, u, enabled);

  const offsetEnvelope = useAudioReactiveEnvelope(0, config.audioReactive);

  const randomState = useRandomInterval({
    minInterval: config.randomInterval?.min ?? 1,
    maxInterval: config.randomInterval?.max ?? 5,
    activeDuration: 0.15,
    targetValue: config.offset ?? 0.001,
    baseValue: 0,
    lerpSpeed: 0.25,
    minDuration: config.randomDuration?.min,
    maxDuration: config.randomDuration?.max,
    attack: config.attack,
    decay: config.decay,
    effectId: 'chromaticAberration',
  });

  useEffectFrame((ctx) => {
    offsetEnvelope.update(ctx.dt);
    let finalOffset = 0.001;
    if (config.mode === 'random') {
      finalOffset = randomState.update({ time: ctx.time, dt: ctx.dt, didReset: ctx.didReset });
    } else if (config.audioReactive?.enabled) {
      finalOffset = (config.offset ?? 0.001) + offsetEnvelope.current;
    } else {
      finalOffset = config.offset ?? 0.001;
    }
    u.offset.value = finalOffset;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GLITCH (Priority: 55)
// Config: strength (not "intensity"), mode, audioReactive
// ═══════════════════════════════════════════════════════════════════════════

const glitchFn: TSLEffectFn = (color, u) => {
  const shift = u.glitchShift;
  const r = color.r.add(shift);
  const g = color.g;
  const b = color.b.sub(shift);
  return vec4(clamp(vec3(r, g, b), 0.0, 1.0), color.a);
};

interface GlitchProps {
  enabled: boolean;
  config: PostProcessingConfig['glitch'];
}

export function TSLGlitchEffect({ enabled, config }: GlitchProps) {
  const u = React.useMemo(() => ({ glitchShift: uniform(0.0) }), []);
  useNodeEffect('glitch', 55, glitchFn, u, enabled);

  const randomState = useRandomInterval({
    minInterval: config.randomInterval?.min ?? 1,
    maxInterval: config.randomInterval?.max ?? 5,
    activeDuration: config.duration ?? 0.15,
    targetValue: config.strength ?? 0.5,
    baseValue: 0,
    lerpSpeed: 0.15,
    minDuration: config.randomDuration?.min,
    maxDuration: config.randomDuration?.max,
    attack: config.attack,
    decay: config.decay,
    effectId: 'glitch',
  });

  useEffectFrame((ctx) => {
    if (config.mode === 'random') {
      const intensity = randomState.update({ time: ctx.time, dt: ctx.dt, didReset: ctx.didReset });
      if (intensity > 0.01) {
        u.glitchShift.value = (Math.random() - 0.5) * intensity * 0.1;
      } else {
        u.glitchShift.value *= 0.9;
      }
    } else {
      // Continuous mode
      const strength = config.strength ?? 0.5;
      const glitchChance = Math.random();
      if (glitchChance > 0.95) {
        u.glitchShift.value = (Math.random() - 0.5) * strength * 0.1;
      } else {
        u.glitchShift.value *= 0.9;
      }
    }
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE JITTER (Priority: 45)
// Config: intensity, audioReactive (flat AudioReactiveConfig)
// ═══════════════════════════════════════════════════════════════════════════

const gateJitterFn: TSLEffectFn = (color, u, sceneTexture) => {
  const jitteredUV = screenUV.add(u.jitter);
  return sceneTexture.sample(jitteredUV);
};

interface GateJitterProps {
  enabled: boolean;
  config: PostProcessingConfig['gateJitter'];
}

export function TSLGateJitterEffect({ enabled, config }: GateJitterProps) {
  const u = React.useMemo(
    () => ({
      // Must use THREE.Vector2 — TSL infers GLSL type from value constructor.
      // Plain JS arrays resolve to type "null" at compile time → runtime crash.
      jitter: uniform(new Vector2(0, 0)),
    }),
    [],
  );
  useNodeEffect('gateJitter', 45, gateJitterFn, u, enabled);

  const audioEnvelope = useAudioReactiveEnvelope(
    0,
    config.audioReactive ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 0.01,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame(() => {
    const intensity = config.intensity ?? 0.005;
    let jx: number, jy: number;
    if (config.audioReactive?.enabled) {
      audioEnvelope.update(0.016);
      const k = audioEnvelope.current;
      jx = (Math.random() - 0.5) * k * 2;
      jy = (Math.random() - 0.5) * k * 2;
    } else {
      jx = (Math.random() - 0.5) * intensity * 2;
      jy = (Math.random() - 0.5) * intensity * 2;
    }
    // Mutate in-place — reassigning to a new array would invalidate the TSL reference.
    (u.jitter.value as Vector2).set(jx, jy);
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// NOISE OVERLAY (Priority: 70)
// Config: opacity (not "intensity"), animated, audioReactive.opacity
// ═══════════════════════════════════════════════════════════════════════════

const noiseOverlayFn: TSLEffectFn = (color, u) => {
  // Generate per-pixel noise based on UV and animated time
  const p = screenUV.add(vec2(u.time.mul(123.4), u.time.mul(567.8)));
  const noiseR = fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
  const noiseG = fract(sin(dot(p.add(vec2(1.0, 1.0)), vec2(39.346, 11.135))).mul(43758.5453));
  const noiseB = fract(sin(dot(p.add(vec2(2.0, 2.0)), vec2(73.156, 52.235))).mul(43758.5453));

  const noiseColor = vec3(noiseR, noiseG, noiseB);

  // Subtle vignette
  const uv = screenUV;
  const vignette = uv.x.mul(uv.y).mul(float(1.0).sub(uv.x)).mul(float(1.0).sub(uv.y));
  const vigClamp = clamp(pow(vignette.mul(16.0), float(0.2)), 0.0, 1.0);

  // Blend with original using a mix
  const blended = mix(color.rgb, noiseColor.mul(vigClamp), u.opacity);
  return vec4(blended, color.a);
};

interface NoiseOverlayProps {
  enabled: boolean;
  config: PostProcessingConfig['noiseOverlay'];
}

export function TSLNoiseOverlayEffect({ enabled, config }: NoiseOverlayProps) {
  const u = React.useMemo(
    () => ({
      opacity: uniform(0.0),
      time: uniform(0.0),
    }),
    [],
  );
  useNodeEffect('noiseOverlay', 70, noiseOverlayFn, u, enabled);

  const opacityEnvelope = useAudioReactiveEnvelope(
    config.opacity ?? 0.3,
    config.audioReactive?.opacity ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    opacityEnvelope.update(ctx.dt);
    u.opacity.value = config.audioReactive?.opacity?.enabled
      ? opacityEnvelope.current
      : (config.opacity ?? 0.3);

    if (config.animated !== false) {
      u.time.value = ctx.time;
    }
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// OLD FILM (Priority: 50)
// Config: intensity, grainAmount, scratchAmount, dirtAmount,
//   audioReactive: { intensity, grainScale, grainAmount?, scratchAmount?, dirtAmount? }
// ═══════════════════════════════════════════════════════════════════════════

const GRAIN_TEXTURES_TSL: Record<string, string> = {
  gilded_fine: '/effects/old-film/grains/grain_seed27_gilt.png',
  foundry_medium: '/effects/old-film/grains/grain_hammer_special.png',
  elongated_halide: '/effects/old-film/grains/grain_cramer_inst.png',
  majestic_coarse: '/effects/old-film/grains/grain_cramer_crown.png',
  raw_emulsion: '/effects/old-film/grains/grain_seed27_before.png',
  refined_intensifier: '/effects/old-film/grains/grain_seed27_after.png',
  studio_35mm: '/effects/old-film/grains/grain_film_35mm.png',
  reporter_16mm: '/effects/old-film/grains/grain_film_16mm.png',
  amateur_8mm: '/effects/old-film/grains/grain_film_8mm.png',
  panchromatic_noir: '/effects/old-film/grains/grain_kodak_tri_x.png',
  tabular_contrast: '/effects/old-film/grains/grain_kodak_tmax.png',
  dusty_academy: '/effects/old-film/grains/grain_projector_classroom.png',
  theatrical_gate: '/effects/old-film/grains/grain_projector_cinema.png',
  underground_grit: '/effects/old-film/grains/grain_grindhouse.png',
};

// Rotate 2D UV around origin (0,0). Callers should center->rotate->uncenter themselves.
const rotateUV2D = (uv: Node, angle: Node) => {
  const c = cos(angle);
  const s = sin(angle);
  return vec2(c.mul(uv.x).sub(s.mul(uv.y)), s.mul(uv.x).add(c.mul(uv.y)));
};

// Lazy 1×1 neutral-gray placeholder so the grainTex uniform always has a valid
// texture at pipeline build time (avoids null binding on first build).
let _grainPlaceholder: THREE.Texture | null = null;
function getGrainPlaceholder(): THREE.Texture {
  if (!_grainPlaceholder) {
    const data = new Uint8Array([128, 128, 128, 255]);
    const dt = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    dt.wrapS = dt.wrapT = THREE.RepeatWrapping;
    dt.needsUpdate = true;
    _grainPlaceholder = dt;
  }
  return _grainPlaceholder;
}

// Module-level stable TSL function — no closure, no rebuild needed.
// u.grainTex and u.useGrainTex are UniformNodes; their .value can be hot-swapped
// at runtime and the GPU picks up the new texture on the next render.
const oldFilmFn: TSLEffectFn = (color, u) => {
  const uv = screenUV;

  // ── Texture grain path (always compiled into WGSL) ─────────────────
  const scale = u.grainScale;
  const off = u.grainOffset;
  const grainTex = u.grainTex as TextureNode;
  const centered = uv.sub(vec2(0.5, 0.5));

  const r1 = rotateUV2D(centered, float(0.22)).add(vec2(0.5, 0.5));
  const uv1 = fract(r1.mul(scale).add(off));
  const g1 = texture(grainTex, uv1).rgb.mul(float(2.0)).sub(float(1.0));

  const r2 = rotateUV2D(centered, float(0.82)).add(vec2(0.5, 0.5));
  const uv2 = fract(r2.mul(scale.mul(float(1.618))).add(off.mul(float(1.41))));
  const g2 = texture(grainTex, uv2).rgb.mul(float(2.0)).sub(float(1.0));

  const r3 = rotateUV2D(centered, float(1.95)).add(vec2(0.5, 0.5));
  const uv3 = fract(r3.mul(scale.mul(float(2.37))).sub(off.mul(float(0.73))));
  const g3 = texture(grainTex, uv3).rgb.mul(float(2.0)).sub(float(1.0));

  const texGrainVec = g1
    .mul(float(0.45))
    .add(g2.mul(float(0.35)))
    .add(g3.mul(float(0.2)));

  // ── Procedural fallback path (also always compiled) ─────────────────
  const procGrainVec = vec3(u.grain, u.grain, u.grain);

  // Runtime select — u.useGrainTex.value controls which path is active,
  // no pipeline rebuild required when swapping textures or switching modes.
  let grainVec: Node = u.useGrainTex.greaterThan(float(0.5)).select(texGrainVec, procGrainVec);

  // Grit power — high-contrast stocks punch harder
  const gritPower = u.isHighContrast.greaterThan(float(0.5)).select(float(6.5), float(4.8));
  grainVec = grainVec.mul(gritPower);

  // Luminance mask: grain strongest in midtones
  const luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  const grainMask = clamp(
    pow(luminance, float(0.5)).mul(float(1.0).sub(pow(luminance, float(8.0)))),
    0.0,
    1.0,
  );

  const grainEffect = float(1.0).add(grainVec.mul(u.grainAmount).mul(u.intensity).mul(grainMask));
  let result = color.rgb.mul(grainEffect);

  result = result.add(vec3(u.scratch, u.scratch, u.scratch));

  const vignette = uv.x.mul(uv.y).mul(float(1.0).sub(uv.x)).mul(float(1.0).sub(uv.y));
  const vignetteSmooth = clamp(pow(vignette.mul(16.0), float(0.2)), 0.0, 1.0);
  result = result.mul(vignetteSmooth);

  return vec4(clamp(result, 0.0, 1.0), color.a);
};

interface OldFilmProps {
  enabled: boolean;
  config: PostProcessingConfig['oldFilm'];
}

export function TSLOldFilmEffect({ enabled, config }: OldFilmProps) {
  const loadedTexRef = React.useRef<THREE.Texture | null>(null);

  const u = React.useMemo(
    () => ({
      intensity: uniform(1.0),
      grainAmount: uniform(0.5),
      grain: uniform(0.0),
      scratch: uniform(0.0),
      grainScale: uniform(4.0),
      grainOffset: uniform(new THREE.Vector2(0, 0)),
      isHighContrast: uniform(0.0),
      // Persistent texture uniform — hot-swappable at runtime, no rebuild needed.
      grainTex: uniform(getGrainPlaceholder()),
      useGrainTex: uniform(0.0),
    }),
    [],
  );

  // Swap grain texture when grainType changes — plain uniform mutation, no rebuild.
  React.useEffect(() => {
    const grainType = config.grainType;

    if (!grainType || grainType === 'procedural') {
      if (loadedTexRef.current) {
        loadedTexRef.current.dispose();
        loadedTexRef.current = null;
      }
      u.grainTex.value = getGrainPlaceholder();
      u.useGrainTex.value = 0.0;
      return;
    }

    const url = GRAIN_TEXTURES_TSL[grainType];
    if (!url) return;

    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        if (loadedTexRef.current) loadedTexRef.current.dispose();
        loadedTexRef.current = tex;
        // Hot-swap the texture uniform — GPU picks it up on the next render
        u.grainTex.value = tex;
        u.useGrainTex.value = 1.0;
      },
      undefined,
      (err) => console.error('[OldFilm TSL] Failed to load grain texture:', err),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.grainType]);

  // oldFilmFn is a stable module-level constant — no fn dep needed in useNodeEffect.
  useNodeEffect('oldFilm', 50, oldFilmFn, u, enabled);

  const intensityEnvelope = useAudioReactiveEnvelope(
    config.intensity ?? 1.0,
    config.audioReactive?.intensity ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  const randomState = useRandomInterval({
    minInterval: config.randomInterval?.min ?? 2,
    maxInterval: config.randomInterval?.max ?? 8,
    activeDuration: 0.3,
    targetValue: config.intensity ?? 1.0,
    baseValue: 0,
    lerpSpeed: 0.15,
    minDuration: config.randomDuration?.min,
    maxDuration: config.randomDuration?.max,
    attack: config.attack,
    decay: config.decay,
    effectId: 'oldFilm',
  });

  useEffectFrame((ctx) => {
    intensityEnvelope.update(ctx.dt);
    let finalIntensity: number;
    if (config.mode === 'random') {
      finalIntensity = randomState.update({ time: ctx.time, dt: ctx.dt, didReset: ctx.didReset });
    } else if (config.audioReactive?.intensity?.enabled) {
      finalIntensity = intensityEnvelope.current;
    } else {
      finalIntensity = config.intensity ?? 1.0;
    }
    u.intensity.value = finalIntensity;
    u.grainAmount.value = config.grainAmount ?? 0.5;
    u.grainScale.value = config.grainScale ?? 4.0;
    u.grain.value = (Math.random() * 2 - 1) * 4.8;
    const scratchChance = Math.random();
    u.scratch.value =
      scratchChance > 0.992 ? (config.scratchAmount ?? 0.5) * finalIntensity * 0.7 : 0;
    // High-contrast stocks get extra grit punch
    const gt = config.grainType;
    u.isHighContrast.value = gt === 'panchromatic_noir' || gt === 'tabular_contrast' ? 1.0 : 0.0;
    // Jitter grain texture UV offset each frame for animation (only when using a texture)
    if (u.useGrainTex.value > 0.5 && !ctx.isPaused) {
      (u.grainOffset.value as THREE.Vector2).set(
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
      );
    }
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// VHS TRACKING (Priority: 65)
// Config: intensity, trackingSpeed, distortionAmount, chromaticSplit,
//   audioReactive: { intensity, distortion, trackingSpeed?, chromaticSplit? }
// ═══════════════════════════════════════════════════════════════════════════

const vhsTrackingFn: TSLEffectFn = (color, u, sceneTexture) => {
  const uv = screenUV;
  const rgbSplit = u.rgbSplit;
  const rUV = uv.add(vec3(rgbSplit, 0.0, 0.0).xy);
  const bUV = uv.sub(vec3(rgbSplit, 0.0, 0.0).xy);
  const rSample = sceneTexture.sample(rUV);
  const bSample = sceneTexture.sample(bUV);
  const result = vec3(rSample.r, color.g, bSample.b).mul(u.trackBrightness);
  return vec4(result, color.a);
};

interface VHSTrackingProps {
  enabled: boolean;
  config: PostProcessingConfig['vhsTracking'];
}

export function TSLVHSTrackingEffect({ enabled, config }: VHSTrackingProps) {
  const u = React.useMemo(
    () => ({
      rgbSplit: uniform(0.0),
      trackBrightness: uniform(1.0),
    }),
    [],
  );
  useNodeEffect('vhsTracking', 65, vhsTrackingFn, u, enabled);

  const intensityEnvelope = useAudioReactiveEnvelope(
    config.intensity ?? 0.5,
    config.audioReactive?.intensity ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  const randomState = useRandomInterval({
    minInterval: config.randomInterval?.min ?? 1,
    maxInterval: config.randomInterval?.max ?? 5,
    activeDuration: 0.2,
    targetValue: config.intensity ?? 0.5,
    baseValue: 0,
    lerpSpeed: 0.15,
    minDuration: config.randomDuration?.min,
    maxDuration: config.randomDuration?.max,
    attack: config.attack,
    decay: config.decay,
    effectId: 'vhsTracking',
  });

  useEffectFrame((ctx) => {
    intensityEnvelope.update(ctx.dt);
    let intensity: number;
    if (config.mode === 'random') {
      intensity = randomState.update({ time: ctx.time, dt: ctx.dt, didReset: ctx.didReset });
    } else if (config.audioReactive?.intensity?.enabled) {
      intensity = intensityEnvelope.current;
    } else {
      intensity = config.intensity ?? 0.5;
    }
    const chromaticSplit = config.chromaticSplit ?? 0.5;
    const distortionAmount = config.distortionAmount ?? 0.3;
    const lineNoise = (Math.random() - 0.5) * distortionAmount * intensity;
    u.rgbSplit.value = lineNoise * chromaticSplit;
    u.trackBrightness.value = 1.0 - Math.abs(lineNoise) * 0.5;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISTORTION (Priority: 35)
// Config: intensity, distortAmount, rippleSpeed, rippleFrequency, color, opacity,
//   audioReactive: { intensity, distortAmount, rippleSpeed, rippleFrequency, opacity }
// ═══════════════════════════════════════════════════════════════════════════

const distortionFn: TSLEffectFn = (color, u, sceneTexture) => {
  const uv = screenUV;
  const center = vec3(0.5, 0.5, 0.0).xy;
  const p = uv.sub(center);
  const d = length(p);
  const ripple = sin(d.mul(u.rippleFrequency).sub(u.time.mul(u.rippleSpeed)));
  const distortion = ripple
    .mul(u.distortAmount)
    .mul(u.intensity)
    .mul(exp(d.mul(-3.0)));
  const distortedUV = center.add(p.mul(float(1.0).add(distortion)));
  const clamped = clamp(distortedUV, 0.01, 0.99);
  const sampled = sceneTexture.sample(clamped);
  const tintStrength = smoothstep(float(0.0), float(1.0), abs(distortion).mul(5.0))
    .mul(u.opacity)
    .mul(u.intensity);
  const result = mix(sampled.rgb, u.tintColor, tintStrength);
  return vec4(result, sampled.a);
};

interface DistortionProps {
  enabled: boolean;
  config: PostProcessingConfig['distortion'];
}

export function TSLDistortionEffect({ enabled, config }: DistortionProps) {
  const u = React.useMemo(
    () => ({
      intensity: uniform(0.5),
      distortAmount: uniform(1.0),
      time: uniform(0.0),
      rippleSpeed: uniform(2.0),
      rippleFrequency: uniform(15.0),
      tintColor: uniform(new Vector3(1, 1, 1)),
      opacity: uniform(1.0),
    }),
    [],
  );
  useNodeEffect('distortion', 35, distortionFn, u, enabled);

  const intensityEnvelope = useAudioReactiveEnvelope(
    config.intensity ?? 0.5,
    config.audioReactive?.intensity ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.2,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    intensityEnvelope.update(ctx.dt);
    u.intensity.value = config.audioReactive?.intensity?.enabled
      ? intensityEnvelope.current
      : (config.intensity ?? 0.5);
    u.distortAmount.value = config.distortAmount ?? 1.0;
    u.time.value = ctx.time;
    u.rippleSpeed.value = config.rippleSpeed ?? 2.0;
    u.rippleFrequency.value = config.rippleFrequency ?? 15.0;
    u.opacity.value = config.opacity ?? 1.0;
    const c = config.color ?? '#ffffff';
    const r = parseInt(c.slice(1, 3), 16) / 255;
    const g = parseInt(c.slice(3, 5), 16) / 255;
    const b = parseInt(c.slice(5, 7), 16) / 255;
    (u.tintColor.value as Vector3).set(r, g, b);
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PIXELATION (Priority: 75)
// Config: pixelSize
// ═══════════════════════════════════════════════════════════════════════════

const pixelationFn: TSLEffectFn = (color, u, sceneTexture) => {
  const uv = screenUV;
  const pixelCount = u.pixelSize;
  const quantized = floor(uv.mul(pixelCount)).div(pixelCount);
  return sceneTexture.sample(quantized);
};

interface PixelationProps {
  enabled: boolean;
  config: PostProcessingConfig['pixelation'];
}

export function TSLPixelationEffect({ enabled, config }: PixelationProps) {
  const u = React.useMemo(() => ({ pixelSize: uniform(256.0) }), []);
  useNodeEffect('pixelation', 75, pixelationFn, u, enabled);

  useEffectFrame(() => {
    u.pixelSize.value = config.pixelSize ?? 256;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHAIN LIGHTNING (Priority: 80)
// Config: lightningColor, glowIntensity, duration, cooldown, audioThreshold
//   (no alpha, progress, or color fields — those were GLSL internal)
// ═══════════════════════════════════════════════════════════════════════════

const chainLightningFn: TSLEffectFn = (color, u) => {
  const result = color.rgb.add(u.lightningColor.mul(u.lightningIntensity));
  return vec4(result, color.a);
};

interface ChainLightningProps {
  enabled: boolean;
  config: PostProcessingConfig['chainLightning'];
}

export function TSLChainLightningEffect({ enabled, config }: ChainLightningProps) {
  const u = React.useMemo(
    () => ({
      lightningColor: uniform(new Vector3(0.5, 0.5, 1.0)),
      lightningIntensity: uniform(0.0),
    }),
    [],
  );
  useNodeEffect('chainLightning', 80, chainLightningFn, u, enabled);

  // Simple strike timer state
  const stateRef = React.useRef({ lastStrike: 0, isStriking: false });

  useEffectFrame((ctx) => {
    const state = stateRef.current;
    const duration = config.duration ?? 0.15;
    const cooldown = config.cooldown ?? 1.0;

    if (state.isStriking) {
      if (ctx.time - state.lastStrike > duration) {
        state.isStriking = false;
        u.lightningIntensity.value = 0;
      } else {
        const t = (ctx.time - state.lastStrike) / duration;
        u.lightningIntensity.value = config.glowIntensity * (1 - t);
      }
    } else if (ctx.time - state.lastStrike > cooldown) {
      // Trigger new strike (random chance per frame)
      if (Math.random() > 0.95) {
        state.isStriking = true;
        state.lastStrike = ctx.time;
        u.lightningIntensity.value = config.glowIntensity;
      }
    }

    const c = config.lightningColor ?? '#8888ff';
    const r = parseInt(c.slice(1, 3), 16) / 255;
    const g = parseInt(c.slice(3, 5), 16) / 255;
    const b = parseInt(c.slice(5, 7), 16) / 255;
    (u.lightningColor.value as Vector3).set(r, g, b);
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// LUT COLOR GRADING (Priority: 8)
// Applies parametric color grading via matrix transforms per preset.
// ═══════════════════════════════════════════════════════════════════════════

const lutFn: TSLEffectFn = (color, u) => {
  // Apply color matrix: result = color * matrix + offset, then mix with original
  const r = dot(color.rgb, u.matR).add(u.offR);
  const g = dot(color.rgb, u.matG).add(u.offG);
  const b = dot(color.rgb, u.matB).add(u.offB);
  const graded = vec3(r, g, b);
  const result = mix(color.rgb, clamp(graded, 0.0, 1.0), u.intensity);
  return vec4(result, color.a);
};

// Preset color matrices: [matR, matG, matB] rows + offset
const LUT_PRESETS: Record<
  string,
  { matR: number[]; matG: number[]; matB: number[]; offR: number; offG: number; offB: number }
> = {
  none: {
    matR: [1, 0, 0],
    matG: [0, 1, 0],
    matB: [0, 0, 1],
    offR: 0,
    offG: 0,
    offB: 0,
  },
  tealOrange: {
    matR: [1.2, -0.1, -0.1],
    matG: [-0.1, 1.1, 0.0],
    matB: [-0.15, 0.15, 1.1],
    offR: 0.04,
    offG: -0.02,
    offB: 0.02,
  },
  noir: {
    matR: [0.4, 0.3, 0.2],
    matG: [0.35, 0.4, 0.2],
    matB: [0.3, 0.25, 0.35],
    offR: -0.05,
    offG: -0.05,
    offB: -0.02,
  },
  cineVibrant: {
    matR: [1.3, 0.0, -0.05],
    matG: [-0.05, 1.25, -0.05],
    matB: [0.0, -0.1, 1.35],
    offR: 0.02,
    offG: 0.01,
    offB: 0.03,
  },
  crushedBlacks: {
    matR: [1.15, 0.0, 0.0],
    matG: [0.0, 1.15, 0.0],
    matB: [0.0, 0.0, 1.15],
    offR: 0.04,
    offG: 0.04,
    offB: 0.04,
  },
  coldShadows: {
    matR: [0.95, 0.0, 0.0],
    matG: [0.0, 1.0, 0.05],
    matB: [0.05, 0.1, 1.15],
    offR: -0.02,
    offG: 0.0,
    offB: 0.04,
  },
  warmHighlights: {
    matR: [1.15, 0.05, 0.0],
    matG: [0.03, 1.05, 0.0],
    matB: [0.0, -0.05, 0.95],
    offR: 0.03,
    offG: 0.02,
    offB: -0.02,
  },
  bleachBypass: {
    matR: [1.0, 0.2, 0.15],
    matG: [0.15, 1.0, 0.15],
    matB: [0.1, 0.15, 1.0],
    offR: -0.05,
    offG: -0.05,
    offB: -0.05,
  },
  crossProcess: {
    matR: [1.3, -0.15, 0.0],
    matG: [0.0, 1.0, 0.15],
    matB: [-0.1, 0.2, 1.2],
    offR: 0.05,
    offG: -0.03,
    offB: 0.05,
  },
};

interface LutProps {
  enabled: boolean;
  config: PostProcessingConfig['lut'];
}

export function TSLLutEffect({ enabled, config }: LutProps) {
  const u = React.useMemo(
    () => ({
      matR: uniform(new Vector3(1, 0, 0)),
      matG: uniform(new Vector3(0, 1, 0)),
      matB: uniform(new Vector3(0, 0, 1)),
      offR: uniform(0.0),
      offG: uniform(0.0),
      offB: uniform(0.0),
      intensity: uniform(1.0),
    }),
    [],
  );
  useNodeEffect('lut', 8, lutFn, u, enabled);

  const audioEnvelope = useAudioReactiveEnvelope(
    config.intensity ?? 1.0,
    config.audioReactive ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.3,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    audioEnvelope.update(ctx.dt);
    const preset = LUT_PRESETS[config.preset ?? 'tealOrange'] ?? LUT_PRESETS.none;
    (u.matR.value as Vector3).set(...(preset.matR as [number, number, number]));
    (u.matG.value as Vector3).set(...(preset.matG as [number, number, number]));
    (u.matB.value as Vector3).set(...(preset.matB as [number, number, number]));
    u.offR.value = preset.offR;
    u.offG.value = preset.offG;
    u.offB.value = preset.offB;
    u.intensity.value = config.audioReactive?.enabled
      ? audioEnvelope.current
      : (config.intensity ?? 1.0);
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// MOTION BLUR / ECHO (Priority: 75)
// Blends current color with a running average to create trailing/ghosting.
// ═══════════════════════════════════════════════════════════════════════════

const motionBlurFn: TSLEffectFn = (color, u) => {
  // Mix current frame with the accumulated "previous" value
  const blended = mix(color.rgb, u.prevColor, u.decay.mul(u.intensity));
  return vec4(blended, color.a);
};

interface MotionBlurProps {
  enabled: boolean;
  config: PostProcessingConfig['motionBlur'];
}

export function TSLMotionBlurEffect({ enabled, config }: MotionBlurProps) {
  const u = React.useMemo(
    () => ({
      prevColor: uniform(new Vector3(0.0, 0.0, 0.0)),
      decay: uniform(0.7),
      intensity: uniform(0.5),
    }),
    [],
  );
  useNodeEffect('motionBlur', 75, motionBlurFn, u, enabled);

  const accumRef = React.useRef({ r: 0, g: 0, b: 0 });
  const intensityEnvelope = useAudioReactiveEnvelope(
    config.intensity ?? 0.5,
    config.audioReactive?.intensity ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.3,
      min: 0.0,
      max: 1.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );
  const decayEnvelope = useAudioReactiveEnvelope(
    config.decay ?? 0.7,
    config.audioReactive?.decay ?? {
      enabled: false,
      band: 'bass',
      intensity: 0.3,
      min: 0.3,
      max: 0.95,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    intensityEnvelope.update(ctx.dt);
    decayEnvelope.update(ctx.dt);
    const finalIntensity = config.audioReactive?.intensity?.enabled
      ? intensityEnvelope.current
      : (config.intensity ?? 0.5);
    const finalDecay = config.audioReactive?.decay?.enabled
      ? decayEnvelope.current
      : (config.decay ?? 0.7);
    // Exponential moving average simulation on CPU
    const acc = accumRef.current;
    acc.r = acc.r * finalDecay + (1 - finalDecay) * 0.5;
    acc.g = acc.g * finalDecay + (1 - finalDecay) * 0.5;
    acc.b = acc.b * finalDecay + (1 - finalDecay) * 0.5;
    (u.prevColor.value as Vector3).set(acc.r, acc.g, acc.b);
    u.decay.value = finalDecay;
    u.intensity.value = finalIntensity;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// LENS FLARE (Priority: 6)
// Extracts bright areas above threshold, applies anamorphic-style horizontal
// streaks and ghost reflections.
// ═══════════════════════════════════════════════════════════════════════════

const lensFlareFn: TSLEffectFn = (color, u) => {
  const luminanceWeights = vec3(0.2126, 0.7152, 0.0722);
  const lum = dot(color.rgb, luminanceWeights);
  // Extract bright pixels
  const bright = smoothstep(u.threshold, u.threshold.add(0.1), lum);
  // Horizontal anamorphic streak (add subtle rotation or offset if desired, but keep anamorphic mostly horizontal)
  const uv = screenUV;
  const yDist = abs(uv.y.sub(0.5));
  const streak = exp(yDist.mul(-8.0).div(u.streakLength.add(0.01)));
  // Ghost effect: sample at mirrored positions with sway!
  const sway = vec2(sin(u.time.mul(0.5)), cos(u.time.mul(0.3))).mul(0.02);
  const ghostUV = float(1.0).sub(uv.x).add(sway.x); // Simple sway x
  const ghostFade = smoothstep(float(0.0), float(0.5), ghostUV);
  const ghostContrib = bright.mul(ghostFade).mul(u.ghostIntensity).mul(0.3);
  // Combine: original + (bright * streak * intensity) + ghost
  const flare = bright.mul(streak).mul(u.intensity);
  const result = color.rgb.add(u.tintColor.mul(flare.add(ghostContrib)));
  return vec4(result, color.a);
};

interface LensFlareProps {
  enabled: boolean;
  config: PostProcessingConfig['lensFlare'];
}

export function TSLLensFlareEffect({ enabled, config }: LensFlareProps) {
  const u = React.useMemo(
    () => ({
      intensity: uniform(1.0),
      threshold: uniform(0.6),
      streakLength: uniform(0.5),
      ghostIntensity: uniform(0.3),
      tintColor: uniform(new Vector3(1.0, 0.7, 0.3)),
      time: uniform(0.0),
    }),
    [],
  );
  useNodeEffect('lensFlare', 6, lensFlareFn, u, enabled);

  const intensityEnvelope = useAudioReactiveEnvelope(
    config.intensity ?? 1.0,
    config.audioReactive?.intensity ?? {
      enabled: false,
      band: 'energy',
      intensity: 0.5,
      min: 0.0,
      max: 3.0,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );
  const thresholdEnvelope = useAudioReactiveEnvelope(
    config.threshold ?? 0.6,
    config.audioReactive?.threshold ?? {
      enabled: false,
      band: 'bass',
      intensity: 0.3,
      min: 0.2,
      max: 0.8,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    intensityEnvelope.update(ctx.dt);
    thresholdEnvelope.update(ctx.dt);
    u.intensity.value = config.audioReactive?.intensity?.enabled
      ? intensityEnvelope.current
      : (config.intensity ?? 1.0);
    u.threshold.value = config.audioReactive?.threshold?.enabled
      ? thresholdEnvelope.current
      : (config.threshold ?? 0.6);
    u.streakLength.value = config.streakLength ?? 0.5;
    u.ghostIntensity.value = ((config.ghostCount ?? 4) / 8) * (config.ghostSpacing ?? 0.3);
    // Parse tint color
    const c = config.tintColor ?? '#ffaa44';
    const r = parseInt(c.slice(1, 3), 16) / 255;
    const g = parseInt(c.slice(3, 5), 16) / 255;
    const b = parseInt(c.slice(5, 7), 16) / 255;
    (u.tintColor.value as Vector3).set(r, g, b);
    u.time.value = ctx.time;
  }, enabled);

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CAMERA SHAKE (Priority: 90)
// Audio-reactive UV displacement + optional rotation wobble.
// ═══════════════════════════════════════════════════════════════════════════

const cameraShakeFn: TSLEffectFn = (color, u, sceneTexture) => {
  const shakenUV = screenUV.add(u.shakeOffset);
  const clamped = clamp(shakenUV, 0.0, 1.0);
  return sceneTexture.sample(clamped);
};

interface CameraShakeProps {
  enabled: boolean;
  config: PostProcessingConfig['cameraShake'];
}

export function TSLCameraShakeEffect({ enabled, config }: CameraShakeProps) {
  const u = React.useMemo(
    () => ({
      shakeOffset: uniform(new Vector2(0, 0)),
    }),
    [],
  );
  useNodeEffect('cameraShake', 90, cameraShakeFn, u, enabled);

  const intensityEnvelope = useAudioReactiveEnvelope(
    config.intensity ?? 0.01,
    config.audioReactive?.intensity ?? {
      enabled: true,
      band: 'bass',
      intensity: 0.5,
      min: 0.0,
      max: 0.03,
      lowerThreshold: 0,
      upperThreshold: 1,
      boxCenter: 0.5,
      boxWidth: 0.3,
    },
  );

  useEffectFrame((ctx) => {
    intensityEnvelope.update(ctx.dt);
    const finalIntensity = config.audioReactive?.intensity?.enabled
      ? intensityEnvelope.current
      : (config.intensity ?? 0.01);
    const freq = config.frequency ?? 15;
    const damping = config.damping ?? 0.5;
    // Generate perlin-like shake using layered sin waves
    const t = ctx.time * freq;
    const rawX = Math.sin(t * 1.0) * 0.5 + Math.sin(t * 2.7) * 0.3 + Math.sin(t * 5.1) * 0.2;
    const rawY = Math.cos(t * 1.3) * 0.5 + Math.cos(t * 3.1) * 0.3 + Math.cos(t * 4.7) * 0.2;
    const dampedX = rawX * finalIntensity * (1 - damping * 0.5);
    const dampedY = rawY * finalIntensity * (1 - damping * 0.5);
    (u.shakeOffset.value as Vector2).set(dampedX, dampedY);
  }, enabled);

  return null;
}

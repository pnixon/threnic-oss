/**
 * GPU Scene Effect Pass Definitions
 *
 * Replaces the legacy R3F-based <Atmosphere> and <StarfieldEffect>.
 * These are processed directly in the WebGPU RenderGraph.
 */

import type { EffectPassConfig } from './RenderGraph';
import { createARUpdater, type AudioReactivePassState } from './EffectPasses';

// ─── Starfield ─────────────────────────────────────────────────────────────

const STARFIELD_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  count: f32,
  speed: f32,
  brightness: f32,
  resolution_x: f32,
  resolution_y: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let originalColor = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let aspect = u.resolution_x / u.resolution_y;
  var uv = input.uv - 0.5;
  uv.x *= aspect;
  
  var stars = 0.0;
  let t = u.time * u.speed * 0.1;
  
  for (var i = 0.0; i < 5.0; i += 1.0) {
    let layerDepth = fract(i * 0.2 + t); // Plus t to zoom in correctly
    let scale = mix(15.0, 0.1, layerDepth);
    let fade = smoothstep(1.0, 0.8, layerDepth) * smoothstep(0.0, 0.2, layerDepth);
    
    let p = uv * scale;
    let cellId = floor(p);
    let localP = fract(p) - 0.5;
    
    let densityClamp = clamp(u.count / 3000.0, 0.01, 1.0);
    let size = mix(0.1, 0.02, layerDepth);

    // Check 3x3 neighborhood to prevent cell-boundary clipping
    for (var ox = -1.0; ox <= 1.0; ox += 1.0) {
      for (var oy = -1.0; oy <= 1.0; oy += 1.0) {
        let nId = cellId + vec2f(ox, oy);
        let h = hash21(nId + i * 13.7);
        if (h < densityClamp) {
           let starPos = vec2f(hash21(nId + 1.1) - 0.5, hash21(nId + 2.2) - 0.5);
           let dist = length(localP - vec2f(ox, oy) - starPos);
           let brightnessMod = hash21(nId + 3.3) * 0.5 + 0.5;
           stars += (1.0 - smoothstep(0.0, size, dist)) * fade * u.brightness * brightnessMod;
        }
      }
    }
  }
  
  let finalColor = originalColor.rgb + vec3f(stars);
  return vec4f(finalColor, originalColor.a);
}
`;

export const STARFIELD_PASS_ID = 'gpu-starfield';

export const starfieldPassConfig: EffectPassConfig = {
  id: STARFIELD_PASS_ID,
  label: 'Starfield',
  shaderSource: STARFIELD_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 50, // High priority (before bloom)
};

interface StarfieldPassState extends AudioReactivePassState {
  count: number;
  speed: number;
  brightness: number;
}

export function createStarfieldUpdater(getState: () => StarfieldPassState) {
  return createARUpdater(
    { count: null, speed: null, brightness: null },
    (uniforms, ar, _s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.count;
      uniforms[2] = ar.speed;
      uniforms[3] = ar.brightness;
      uniforms[4] = params.resolution[0];
      uniforms[5] = params.resolution[1];
      uniforms[6] = 0;
      uniforms[7] = 0;
    },
    getState,
  );
}

// ─── Particles ─────────────────────────────────────────────────────────────

const PARTICLES_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  count: f32,
  gravity: f32,
  opacity: f32,
  resolution_x: f32,
  resolution_y: f32,
  windX: f32,
  turbulence: f32,
  size: f32,
  blending: f32,
  style: f32,
  color_r: f32,
  color_g: f32,
  color_b: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hash21p(p: vec2f) -> f32 {
  var q = fract(p * vec2f(231.34, 381.21));
  q += dot(q, q + 51.32);
  return fract(q.x * q.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let originalColor = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let aspect = u.resolution_x / max(u.resolution_y, 1.0);
  var uv = input.uv;
  uv.x *= aspect;
  
  var parts = 0.0;
  let t = u.time * u.gravity * 0.5;
  // If snow (1.0), drift in -y meaning particles move DOWN
  // If dust (0.0), drift in +y meaning particles move UP
  let driftY = mix(t, -t, u.style);
  
  var drift = vec2f(u.windX * u.time * 0.1, driftY);
  
  for (var i = 0.0; i < 3.0; i += 1.0) {
    let scale = 10.0 + i * 5.0;
    // Add turbulence jitter
    let layerTurbulence = sin(u.time * 0.5 + i) * u.turbulence * 0.05;
    
    let p = uv * scale + drift * (1.0 + i * 0.5) + vec2f(layerTurbulence);
    let cellId = floor(p);
    let localP = fract(p) - 0.5;
    
    let densityClamp = clamp(u.count / 30000.0, 0.001, 1.0);
    let sizeThreshold = 0.05 * u.size * mix(1.0, 0.5, i/3.0);

    // Check 3x3 neighborhood to prevent cell-boundary clipping
    for (var ox = -1.0; ox <= 1.0; ox += 1.0) {
      for (var oy = -1.0; oy <= 1.0; oy += 1.0) {
        let nId = cellId + vec2f(ox, oy);
        let h = hash21p(nId + i * 4.4);
        if (h < densityClamp * 2.0) {
           let pPos = vec2f(hash21p(nId + 1.1) - 0.5, hash21p(nId + 2.2) - 0.5);
           let dist = length(localP - vec2f(ox, oy) - pPos);
           let brightnessMod = hash21p(nId + 3.3) * 0.5 + 0.5;
           parts += (1.0 - smoothstep(0.0, sizeThreshold, dist)) * u.opacity * brightnessMod;
        }
      }
    }
  }
  
  let pColor = vec3f(u.color_r, u.color_g, u.color_b) * parts;
  
  var finalColor: vec3f;
  if (u.blending < 0.5) {
     // Additive
     finalColor = originalColor.rgb + pColor;
  } else {
     // Normal
     finalColor = mix(originalColor.rgb, vec3f(u.color_r, u.color_g, u.color_b), clamp(parts, 0.0, 1.0));
  }
  
  return vec4f(finalColor, originalColor.a);
}
`;

export const PARTICLES_PASS_ID = 'gpu-particles';

export const particlesPassConfig: EffectPassConfig = {
  id: PARTICLES_PASS_ID,
  label: 'Particles',
  shaderSource: PARTICLES_FRAGMENT,
  uniformBufferSize: 64, // 16 x f32
  priority: 60,
};

interface ParticlesPassState extends AudioReactivePassState {
  count: number;
  gravity: number;
  opacity: number;
  windX: number;
  turbulence: number;
  size: number;
  blending: number;
  style: number;
  colorR: number;
  colorG: number;
  colorB: number;
}

export function createParticlesUpdater(getState: () => ParticlesPassState) {
  return createARUpdater(
    { count: null, gravity: null, opacity: null, windX: null, turbulence: null, size: null },
    (uniforms, ar, s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.count;
      uniforms[2] = ar.gravity;
      uniforms[3] = ar.opacity;
      uniforms[4] = params.resolution[0];
      uniforms[5] = params.resolution[1];
      uniforms[6] = ar.windX;
      uniforms[7] = ar.turbulence;
      uniforms[8] = ar.size;
      uniforms[9] = s.blending ?? 0.0;
      uniforms[10] = s.style ?? 0.0;
      uniforms[11] = s.colorR ?? 1.0;
      uniforms[12] = s.colorG ?? 1.0;
      uniforms[13] = s.colorB ?? 1.0;
      uniforms[14] = 0;
      uniforms[15] = 0;
    },
    getState,
  );
}

// ─── Rain ──────────────────────────────────────────────────────────────────

const RAIN_FRAGMENT = /* wgsl */ `
struct Uniforms {
  time: f32,
  count: f32,
  speed: f32,
  opacity: f32,
  resolution_x: f32,
  resolution_y: f32,
  windX: f32,
  size: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hash21r(p: vec2f) -> f32 {
  var q = fract(p * vec2f(432.12, 123.54));
  q += dot(q, q + 13.56);
  return fract(q.x * q.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let originalColor = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let aspect = u.resolution_x / max(u.resolution_y, 1.0);
  var uv = input.uv;
  uv.x *= aspect;
  
  var rain = 0.0;
  let t = u.time * u.speed;
  
  // Angle of the rain based on wind
  // If wind = 0, rain is vertical.
  var dropAngle = atan2(-1.0, u.windX);
  let dropDir = vec2f(cos(dropAngle), sin(dropAngle));
  let orthoDir = vec2f(-dropDir.y, dropDir.x);
  
  for (var i = 0.0; i < 3.0; i += 1.0) {
    let scale = 20.0 + i * 10.0;
    
    // Transform coordinates so that 'y' aligns with drop direction
    let p = vec2f(dot(uv, orthoDir), dot(uv, dropDir)) * scale + vec2f(0.0, t * (1.0 + i * 0.2));
    
    let cellId = vec2f(floor(p.x), floor(p.y));
    let localP = fract(p) - 0.5;
    
    let densityClamp = clamp(u.count / 30000.0, 0.001, 1.0);

    for (var ox = -1.0; ox <= 1.0; ox += 1.0) {
      // Instead of checking all neighbors along the drop path, we only really
      // need to check Y-neighbors since drops are thin and tall
      for (var oy = -1.0; oy <= 1.0; oy += 1.0) {
        let nId = cellId + vec2f(ox, oy);
        let h = hash21r(nId + i * 6.2);
        
        if (h < densityClamp) {
           let rPos = vec2f(hash21r(nId + 0.1) - 0.5, hash21r(nId + 0.2) - 0.5);
           let diff = localP - vec2f(ox, oy) - rPos;
           
           // Make drops tall and narrow
           var dropShape = 1.0 - smoothstep(0.0, 0.02 * u.size, abs(diff.x));
           dropShape *= 1.0 - smoothstep(0.0, 0.4 * u.size, abs(diff.y));
           
           let brightnessMod = hash21r(nId + 0.3) * 0.5 + 0.5;
           rain += dropShape * u.opacity * brightnessMod * mix(1.0, 0.4, i/3.0);
        }
      }
    }
  }
  
  let finalColor = originalColor.rgb + vec3f(rain * 0.8, rain * 0.9, rain);
  return vec4f(finalColor, originalColor.a);
}
`;

export const RAIN_PASS_ID = 'gpu-rain';

export const rainPassConfig: EffectPassConfig = {
  id: RAIN_PASS_ID,
  label: 'Rain',
  shaderSource: RAIN_FRAGMENT,
  uniformBufferSize: 32, // 8 x f32
  priority: 55, // Between starfield and particles
};

interface RainPassState extends AudioReactivePassState {
  count: number;
  speed: number;
  opacity: number;
  windX: number;
  size?: number;
}

export function createRainUpdater(getState: () => RainPassState) {
  return createARUpdater(
    { count: null, speed: null, opacity: null, windX: null, size: null },
    (uniforms, ar, _s, params) => {
      uniforms[0] = params.time;
      uniforms[1] = ar.count;
      uniforms[2] = ar.speed;
      uniforms[3] = ar.opacity;
      uniforms[4] = params.resolution[0];
      uniforms[5] = params.resolution[1];
      uniforms[6] = ar.windX;
      uniforms[7] = ar.size;
    },
    getState,
  );
}

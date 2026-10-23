/**
 * WGSL customShader transform presets.
 *
 * A curated "pick from a list, or write your own" dropdown for the `customShader`
 * post-processing effect — the WGSL TRANSFORM half (LLD §5). Unlike the GLSL
 * guest (which is GENERATIVE and produces colour from scratch), a customShader
 * SAMPLES THE LAYER BENEATH it via `inputTexture` / `inputSampler` (bindings
 * 0/1) with its uniforms at binding 2, and returns the transformed pixel. The
 * two engines are intentionally separate, so each has its own preset list.
 *
 * Each preset carries:
 *   - `source`  — a full WGSL fragment shader declaring
 *       `fn fs_main(input: VertexOutput) -> @location(0) vec4f`. The RenderGraph
 *       prepends the shared fullscreen vertex shader (providing `VertexOutput`
 *       with `.uv`) automatically.
 *   - `parameters` — the uniform struct's fields IN ORDER, including engine
 *       built-ins (`time`, `resolution_x`, `resolution_y`, `_padN`). This order
 *       becomes the config's `uniformLayout`, so the engine packs the uniform
 *       buffer at the correct offsets (built-ins filled from frame params, user
 *       params by name). Getting this order right is what avoids the struct
 *       mis-pack that manifested as full-scanline "tearing".
 *
 * The struct MUST be padded to a multiple of 4 f32s (16 bytes). `uniformSize`
 * is that byte count.
 *
 * The `custom` sentinel keeps whatever the user has authored (never overwrites).
 *
 * ─── LICENSING RULE (mandatory) ─────────────────────────────────────────────
 * Every preset added here MUST document, in a comment directly above its
 * definition, its ORIGINAL source (URL/author) and its LICENSE. Do not ship a
 * preset whose license is unknown or does not permit redistribution — write an
 * original implementation instead. Third-party code that ships must also be
 * listed in LEGAL/THIRD_PARTY_NOTICES.md. The presets below are original to
 * Threnic (public-domain-equivalent) unless a per-preset comment says otherwise.
 */

import type { ShaderParameter } from './ShaderInjector';

interface WgslPreset {
  /** Stable id used as the dropdown value. `custom` = keep current source. */
  id: string;
  /** Display name in the dropdown. */
  label: string;
  /** One-line description. */
  description: string;
  /** WGSL fragment source declaring `fs_main(input) -> @location(0) vec4f`. */
  source: string;
  /** Uniform-buffer byte size (fields * 4, padded to a multiple of 16). */
  uniformSize: number;
  /** Struct fields IN ORDER (incl. built-ins). Becomes the config uniformLayout. */
  parameters: ShaderParameter[];
}

/** Sentinel id for the "write your own" option — never overwrites the source. */
export const WGSL_CUSTOM_ID = 'custom';

// ── Shared binding preamble every transform declares. ──
const BIND = `@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: Uniforms;`;

const GRAYSCALE: WgslPreset = {
  id: 'grayscale',
  label: 'Grayscale',
  description: 'Desaturate toward luminance; mix controls the amount.',
  uniformSize: 16,
  parameters: [
    {
      name: 'mix_amount',
      type: 'f32',
      defaultValue: 1.0,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Amount',
    },
    { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
    { name: '_pad1', type: 'f32', defaultValue: 0, builtIn: true },
    { name: '_pad2', type: 'f32', defaultValue: 0, builtIn: true },
  ],
  source: `
struct Uniforms {
  mix_amount: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

${BIND}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let c = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let l = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(mix(c.rgb, vec3f(l), params.mix_amount), c.a);
}
`,
};

const INVERT: WgslPreset = {
  id: 'invert',
  label: 'Invert',
  description: 'Invert RGB; amount blends between original and inverted.',
  uniformSize: 16,
  parameters: [
    { name: 'amount', type: 'f32', defaultValue: 1.0, min: 0, max: 1, step: 0.01, label: 'Amount' },
    { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
    { name: '_pad1', type: 'f32', defaultValue: 0, builtIn: true },
    { name: '_pad2', type: 'f32', defaultValue: 0, builtIn: true },
  ],
  source: `
struct Uniforms {
  amount: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

${BIND}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let c = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  return vec4f(mix(c.rgb, vec3f(1.0) - c.rgb, params.amount), c.a);
}
`,
};

const VIGNETTE: WgslPreset = {
  id: 'vignette',
  label: 'Vignette',
  description: 'Darken the frame edges toward the corners.',
  uniformSize: 16,
  parameters: [
    {
      name: 'radius',
      type: 'f32',
      defaultValue: 0.75,
      min: 0.1,
      max: 1.5,
      step: 0.01,
      label: 'Radius',
    },
    {
      name: 'softness',
      type: 'f32',
      defaultValue: 0.45,
      min: 0.01,
      max: 1,
      step: 0.01,
      label: 'Softness',
    },
    {
      name: 'intensity',
      type: 'f32',
      defaultValue: 1.0,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Intensity',
    },
    { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
  ],
  source: `
struct Uniforms {
  radius: f32,
  softness: f32,
  intensity: f32,
  _pad0: f32,
}

${BIND}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let c = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let d = distance(input.uv, vec2f(0.5));
  // Ascending-range smoothstep only: smoothstep(edge0, edge1, x) is UNDEFINED
  // when edge0 >= edge1 in the WebGPU/WGSL spec. Firefox honors that and steps
  // hard (no feather); Chrome's Dawn tolerates the inverted range. Compute the
  // edge falloff ascending (radius-softness → radius) and invert so v is 1 in
  // the center and 0 past the radius on BOTH browsers.
  let v = 1.0 - smoothstep(params.radius - params.softness, params.radius, d);
  let darken = mix(1.0, v, params.intensity);
  return vec4f(c.rgb * darken, c.a);
}
`,
};

const PIXELATE: WgslPreset = {
  id: 'pixelate',
  label: 'Pixelate',
  description: 'Snap UVs to a grid for a blocky, mosaic look.',
  uniformSize: 16,
  parameters: [
    { name: 'cells', type: 'f32', defaultValue: 64.0, min: 4, max: 512, step: 1, label: 'Cells' },
    { name: 'resolution_x', type: 'f32', defaultValue: 1920, builtIn: true },
    { name: 'resolution_y', type: 'f32', defaultValue: 1080, builtIn: true },
    { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
  ],
  source: `
struct Uniforms {
  cells: f32,
  resolution_x: f32,
  resolution_y: f32,
  _pad0: f32,
}

${BIND}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // Aspect-correct the grid so cells stay square regardless of frame ratio.
  let aspect = params.resolution_x / max(params.resolution_y, 1.0);
  let grid = vec2f(params.cells, params.cells / aspect);
  let snapped = (floor(input.uv * grid) + 0.5) / grid;
  return textureSampleLevel(inputTexture, inputSampler, snapped, 0.0);
}
`,
};

const CHROMATIC_SPLIT: WgslPreset = {
  id: 'chromatic-split',
  label: 'Chromatic Split',
  description: 'Offset the R and B channels radially for an RGB fringe.',
  uniformSize: 16,
  parameters: [
    {
      name: 'amount',
      type: 'f32',
      defaultValue: 0.004,
      min: 0,
      max: 0.03,
      step: 0.0005,
      label: 'Amount',
    },
    { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
    { name: '_pad1', type: 'f32', defaultValue: 0, builtIn: true },
    { name: '_pad2', type: 'f32', defaultValue: 0, builtIn: true },
  ],
  source: `
struct Uniforms {
  amount: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

${BIND}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let dir = normalize(input.uv - vec2f(0.5)) * params.amount;
  let r = textureSampleLevel(inputTexture, inputSampler, input.uv + dir, 0.0).r;
  let g = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0).g;
  let b = textureSampleLevel(inputTexture, inputSampler, input.uv - dir, 0.0).b;
  let a = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0).a;
  return vec4f(r, g, b, a);
}
`,
};

const EDGE_DETECT: WgslPreset = {
  id: 'edge-detect',
  label: 'Edge Detection',
  description: 'Sobel edge detection; mix blends edges back over the original.',
  uniformSize: 32,
  parameters: [
    {
      name: 'intensity',
      type: 'f32',
      defaultValue: 1.0,
      min: 0,
      max: 3,
      step: 0.01,
      label: 'Intensity',
    },
    {
      name: 'threshold',
      type: 'f32',
      defaultValue: 0.1,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Threshold',
    },
    { name: 'resolution_x', type: 'f32', defaultValue: 1920, builtIn: true },
    { name: 'resolution_y', type: 'f32', defaultValue: 1080, builtIn: true },
    {
      name: 'mix_original',
      type: 'f32',
      defaultValue: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Mix Original',
    },
    { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
    { name: '_pad1', type: 'f32', defaultValue: 0, builtIn: true },
    { name: '_pad2', type: 'f32', defaultValue: 0, builtIn: true },
  ],
  source: `
struct Uniforms {
  intensity: f32,
  threshold: f32,
  resolution_x: f32,
  resolution_y: f32,
  mix_original: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

${BIND}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let texel = vec2f(1.0 / params.resolution_x, 1.0 / params.resolution_y);
  let uv = input.uv;

  // 3x3 Sobel kernel over luminance.
  let tl = luminance(textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-texel.x, -texel.y), 0.0).rgb);
  let tc = luminance(textureSampleLevel(inputTexture, inputSampler, uv + vec2f(0.0, -texel.y), 0.0).rgb);
  let tr = luminance(textureSampleLevel(inputTexture, inputSampler, uv + vec2f(texel.x, -texel.y), 0.0).rgb);
  let ml = luminance(textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-texel.x, 0.0), 0.0).rgb);
  let mr = luminance(textureSampleLevel(inputTexture, inputSampler, uv + vec2f(texel.x, 0.0), 0.0).rgb);
  let bl = luminance(textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-texel.x, texel.y), 0.0).rgb);
  let bc = luminance(textureSampleLevel(inputTexture, inputSampler, uv + vec2f(0.0, texel.y), 0.0).rgb);
  let br = luminance(textureSampleLevel(inputTexture, inputSampler, uv + vec2f(texel.x, texel.y), 0.0).rgb);

  let gx = tl * -1.0 + tr * 1.0 + ml * -2.0 + mr * 2.0 + bl * -1.0 + br * 1.0;
  let gy = tl * -1.0 + tc * -2.0 + tr * -1.0 + bl * 1.0 + bc * 2.0 + br * 1.0;
  var edge = sqrt(gx * gx + gy * gy) * params.intensity;
  edge = step(params.threshold, edge);

  let original = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let edgeColor = vec4f(vec3f(edge), 1.0);
  return mix(edgeColor, original, params.mix_original);
}
`,
};

const SCANLINES: WgslPreset = {
  id: 'scanlines',
  label: 'Scanlines',
  description: 'CRT-style horizontal scanline darkening, scrolling over time.',
  uniformSize: 16,
  parameters: [
    {
      name: 'count',
      type: 'f32',
      defaultValue: 240.0,
      min: 20,
      max: 1080,
      step: 1,
      label: 'Lines',
    },
    {
      name: 'intensity',
      type: 'f32',
      defaultValue: 0.4,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Intensity',
    },
    { name: 'time', type: 'f32', defaultValue: 0, builtIn: true, label: 'Time' },
    { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
  ],
  source: `
struct Uniforms {
  count: f32,
  intensity: f32,
  time: f32,
  _pad0: f32,
}

${BIND}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let c = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
  let s = sin((input.uv.y * params.count + params.time * 2.0) * 3.14159265);
  let line = 1.0 - params.intensity * (0.5 + 0.5 * s);
  return vec4f(c.rgb * line, c.a);
}
`,
};

/**
 * The curated preset list. `custom` is first so the dropdown defaults to
 * "Custom" whenever the user's source doesn't match a preset.
 */
export const WGSL_PRESETS: WgslPreset[] = [
  {
    id: WGSL_CUSTOM_ID,
    label: 'Custom…',
    description: 'Keep your own hand-written WGSL transform.',
    source: '',
    uniformSize: 0,
    parameters: [],
  },
  GRAYSCALE,
  INVERT,
  VIGNETTE,
  PIXELATE,
  CHROMATIC_SPLIT,
  EDGE_DETECT,
  SCANLINES,
];

/** Look up a preset by id (returns undefined for `custom` / unknown). */
export function getWgslPreset(id: string): WgslPreset | undefined {
  if (id === WGSL_CUSTOM_ID) return undefined;
  return WGSL_PRESETS.find((p) => p.id === id);
}

/** Which preset (if any) a given source string matches, else `custom`. */
export function matchWgslPresetId(source: string): string {
  const norm = (s: string) => s.trim();
  const hit = WGSL_PRESETS.find((p) => p.id !== WGSL_CUSTOM_ID && norm(p.source) === norm(source));
  return hit ? hit.id : WGSL_CUSTOM_ID;
}

/**
 * ShaderInjector — Runtime WGSL compilation for user-defined effects.
 *
 * Allows users to write custom WGSL fragment shaders that are validated,
 * compiled, and injected into the RenderGraph as effect passes at runtime.
 *
 * Features:
 *   - WGSL source validation (syntax + semantic checks)
 *   - Automatic uniform buffer layout generation
 *   - Hot-reload: replace a running effect's shader without teardown
 *   - Sandboxed execution: user shaders cannot access GPU resources outside
 *     their bind group (input texture, sampler, uniforms)
 *   - Built-in uniform injections (time, resolution, audio, etc.)
 *   - Shader template system for quick effect creation
 *
 * Usage:
 *   const injector = new ShaderInjector(device, renderGraph);
 *
 *   // Inject a custom effect
 *   const result = await injector.inject({
 *     id: 'my-custom-effect',
 *     label: 'Custom Color Shift',
 *     source: `
 *       @group(0) @binding(0) var inputTexture: texture_2d<f32>;
 *       @group(0) @binding(1) var inputSampler: sampler;
 *       @group(0) @binding(2) var<uniform> params: Uniforms;
 *       struct Uniforms { time: f32, intensity: f32, _pad0: f32, _pad1: f32 }
 *       @fragment
 *       fn fs_main(input: VertexOutput) -> @location(0) vec4f {
 *         var c = textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0);
 *         c.r = c.r + sin(params.time) * params.intensity;
 *         return c;
 *       }
 *     `,
 *     uniformSize: 16,
 *     priority: 50,
 *   });
 */

import type { RenderGraph, EffectPassConfig, EffectPassParams } from './RenderGraph';

// ─── Types ──────────────────────────────────────────────────

interface ShaderInjectionRequest {
  /** Unique ID for this effect (used as the pass ID in the render graph) */
  id: string;
  /** Human-readable display name */
  label: string;
  /** WGSL fragment shader source (without vertex shader — it's prepended automatically) */
  source: string;
  /** Uniform buffer size in bytes (must be multiple of 16). Default: 32 */
  uniformSize?: number;
  /** Priority in the render pipeline (lower = earlier). Default: 100 */
  priority?: number;
  /**
   * Uniform parameter descriptors — describes the layout of the uniform buffer.
   * Used for automatic UI generation and serialization.
   */
  parameters?: ShaderParameter[];
  /** Whether to enable the pass immediately. Default: true */
  enableOnInject?: boolean;
}

export interface ShaderParameter {
  /** Parameter name (for UI and serialization) */
  name: string;
  /** Parameter type */
  type: 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f' | 'bool';
  /** Default value */
  defaultValue: number | number[];
  /** Minimum value (for numeric types) */
  min?: number;
  /** Maximum value (for numeric types) */
  max?: number;
  /** Step size for UI sliders */
  step?: number;
  /** Human-readable label for UI */
  label?: string;
  /** Whether this is a built-in injected uniform (time, resolution, etc.) */
  builtIn?: boolean;
}

interface ShaderValidationResult {
  /** Whether the shader compiled successfully */
  valid: boolean;
  /** Compilation error messages */
  errors: ShaderCompilationMessage[];
  /** Compilation warning messages */
  warnings: ShaderCompilationMessage[];
}

export interface ShaderCompilationMessage {
  /** Message text */
  message: string;
  /** Line number (1-indexed) */
  line: number;
  /** Column offset */
  column: number;
  /** Severity */
  type: 'error' | 'warning' | 'info';
}

interface InjectionResult {
  /** Whether the injection succeeded */
  success: boolean;
  /** The pass ID (same as request.id) */
  passId: string;
  /** Validation details */
  validation: ShaderValidationResult;
  /** Error message if injection failed */
  error?: string;
}

interface InjectedShader {
  /** Original injection request */
  request: ShaderInjectionRequest;
  /** Current parameter values */
  parameterValues: Map<string, number | number[]>;
  /** Whether the effect is currently enabled */
  enabled: boolean;
  /** Timestamp of injection */
  injectedAt: number;
  /** Number of times this shader has been hot-reloaded */
  reloadCount: number;
}

// ─── Shader Templates ──────────────────────────────────────

interface ShaderTemplate {
  id: string;
  name: string;
  description: string;
  source: string;
  parameters: ShaderParameter[];
  uniformSize: number;
}

/**
 * Hard cap on user WGSL source size (§5/3b safety). 64 KiB is far above any
 * legitimate hand- or template-authored transform; a larger source is rejected
 * by `validate()` before it reaches a pipeline or a project document.
 */
export const MAX_WGSL_SOURCE_BYTES = 64 * 1024;

/**
 * Built-in shader templates for quick effect creation.
 */
const SHADER_TEMPLATES: ShaderTemplate[] = [
  {
    id: 'tpl-color-tint',
    name: 'Color Tint',
    description: 'Apply a uniform color tint to the image',
    uniformSize: 32,
    parameters: [
      { name: 'tint_r', type: 'f32', defaultValue: 1.0, min: 0, max: 2, step: 0.01, label: 'Red' },
      {
        name: 'tint_g',
        type: 'f32',
        defaultValue: 1.0,
        min: 0,
        max: 2,
        step: 0.01,
        label: 'Green',
      },
      { name: 'tint_b', type: 'f32', defaultValue: 1.0, min: 0, max: 2, step: 0.01, label: 'Blue' },
      {
        name: 'intensity',
        type: 'f32',
        defaultValue: 1.0,
        min: 0,
        max: 1,
        step: 0.01,
        label: 'Intensity',
      },
      { name: 'time', type: 'f32', defaultValue: 0, builtIn: true, label: 'Time' },
      { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
      { name: '_pad1', type: 'f32', defaultValue: 0, builtIn: true },
      { name: '_pad2', type: 'f32', defaultValue: 0, builtIn: true },
    ],
    source: `
struct Uniforms {
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
}
`,
  },
  {
    id: 'tpl-edge-detect',
    name: 'Edge Detection',
    description: 'Sobel edge detection filter',
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

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: Uniforms;

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let texel = vec2f(1.0 / params.resolution_x, 1.0 / params.resolution_y);
  let uv = input.uv;

  // 3x3 Sobel kernel
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
  },
  {
    id: 'tpl-wave-distortion',
    name: 'Wave Distortion',
    description: 'Animated wave distortion effect',
    uniformSize: 32,
    parameters: [
      { name: 'time', type: 'f32', defaultValue: 0, builtIn: true, label: 'Time' },
      {
        name: 'amplitude',
        type: 'f32',
        defaultValue: 0.02,
        min: 0,
        max: 0.1,
        step: 0.001,
        label: 'Amplitude',
      },
      {
        name: 'frequency',
        type: 'f32',
        defaultValue: 10.0,
        min: 1,
        max: 50,
        step: 0.5,
        label: 'Frequency',
      },
      { name: 'speed', type: 'f32', defaultValue: 2.0, min: 0, max: 10, step: 0.1, label: 'Speed' },
      {
        name: 'direction_x',
        type: 'f32',
        defaultValue: 0.0,
        min: -1,
        max: 1,
        step: 0.1,
        label: 'Direction X',
      },
      {
        name: 'direction_y',
        type: 'f32',
        defaultValue: 1.0,
        min: -1,
        max: 1,
        step: 0.1,
        label: 'Direction Y',
      },
      { name: '_pad0', type: 'f32', defaultValue: 0, builtIn: true },
      { name: '_pad1', type: 'f32', defaultValue: 0, builtIn: true },
    ],
    source: `
struct Uniforms {
  time: f32,
  amplitude: f32,
  frequency: f32,
  speed: f32,
  direction_x: f32,
  direction_y: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: Uniforms;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let dir = normalize(vec2f(params.direction_x, params.direction_y) + vec2f(0.001));
  let d = dot(input.uv, dir);
  let wave = sin(d * params.frequency + params.time * params.speed) * params.amplitude;
  let perpDir = vec2f(-dir.y, dir.x);
  let distortedUv = clamp(input.uv + perpDir * wave, vec2f(0.0), vec2f(1.0));
  return textureSampleLevel(inputTexture, inputSampler, distortedUv, 0.0);
}
`,
  },
];

// ─── ShaderInjector Class ──────────────────────────────────

export class ShaderInjector {
  private device: GPUDevice;
  /**
   * The render graph injected passes are registered on. Nullable so a
   * validate-ONLY caller (e.g. the inspector's CustomShaderEditor, which just
   * wants compile diagnostics) can construct an injector without a graph.
   * `validate()` never touches it; every mutating path (inject / hotReload /
   * remove / destroy) does, so those require a non-null graph by construction.
   */
  private renderGraph: RenderGraph | null;
  private injectedShaders: Map<string, InjectedShader> = new Map();

  constructor(device: GPUDevice, renderGraph: RenderGraph | null) {
    this.device = device;
    this.renderGraph = renderGraph;
  }

  /**
   * The render graph, asserted non-null. Every mutating path (inject /
   * hotReload / remove / setEnabled / destroy) goes through this, so a
   * validate-only injector that touches one fails loudly instead of silently
   * no-op'ing. `validate()` deliberately does NOT use it.
   */
  private graph(): RenderGraph {
    if (!this.renderGraph) {
      throw new Error(
        '[ShaderInjector] This injector was constructed without a RenderGraph (validate-only); ' +
          'inject/hotReload/remove/setEnabled/destroy are unavailable.',
      );
    }
    return this.renderGraph;
  }

  /**
   * Validate a WGSL shader source without injecting it.
   * Compiles the shader module and collects diagnostics.
   */
  async validate(source: string): Promise<ShaderValidationResult> {
    // Size cap (§5/3b safety): reject a pathologically large source before it
    // reaches a pipeline or a project document. 64 KB is far above any hand- or
    // template-authored transform; anything larger is almost certainly paste
    // garbage or an attempt to wedge the compiler.
    if (source.length > MAX_WGSL_SOURCE_BYTES) {
      return {
        valid: false,
        errors: [
          {
            message: `Shader source is too large (${source.length} bytes; limit ${MAX_WGSL_SOURCE_BYTES}). Trim the source.`,
            line: 0,
            column: 0,
            type: 'error',
          },
        ],
        warnings: [],
      };
    }
    // Prepend the fullscreen vertex shader for validation context
    const fullSource = this.buildFullShaderSource(source);

    try {
      const shaderModule = this.device.createShaderModule({
        label: 'validation-module',
        code: fullSource,
      });

      const info = await shaderModule.getCompilationInfo();
      const errors: ShaderCompilationMessage[] = [];
      const warnings: ShaderCompilationMessage[] = [];

      for (const msg of info.messages) {
        const entry: ShaderCompilationMessage = {
          message: msg.message,
          line: msg.lineNum,
          column: msg.linePos,
          type: msg.type as 'error' | 'warning' | 'info',
        };

        if (msg.type === 'error') {
          errors.push(entry);
        } else if (msg.type === 'warning') {
          warnings.push(entry);
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    } catch (err) {
      return {
        valid: false,
        errors: [
          {
            message: err instanceof Error ? err.message : String(err),
            line: 0,
            column: 0,
            type: 'error',
          },
        ],
        warnings: [],
      };
    }
  }

  /**
   * Inject a custom user shader into the render graph.
   * Validates, compiles, and registers as a new effect pass.
   */
  async inject(request: ShaderInjectionRequest): Promise<InjectionResult> {
    // Step 1: Validate
    const validation = await this.validate(request.source);
    if (!validation.valid) {
      return {
        success: false,
        passId: request.id,
        validation,
        error: `Shader compilation failed with ${validation.errors.length} error(s)`,
      };
    }

    // Step 2: Build effect pass config
    const uniformSize = Math.max(request.uniformSize ?? 32, 16);
    // Ensure multiple of 16
    const alignedSize = Math.ceil(uniformSize / 16) * 16;

    const config: EffectPassConfig = {
      id: request.id,
      label: request.label,
      shaderSource: request.source,
      uniformBufferSize: alignedSize,
      priority: request.priority ?? 100,
    };

    // Step 3: Register in the render graph
    const registered = await this.graph().registerPass(config);
    if (!registered) {
      return {
        success: false,
        passId: request.id,
        validation,
        error: 'Failed to register shader pass in the render graph',
      };
    }

    // Step 4: Set up uniform updater with parameter mapping
    if (request.parameters) {
      const paramValues = new Map<string, number | number[]>();
      for (const param of request.parameters) {
        paramValues.set(param.name, param.defaultValue);
      }

      this.graph().setPassUniformUpdater(
        request.id,
        (uniforms: Float32Array, frameParams: EffectPassParams) => {
          this.updateUniformsFromParameters(
            uniforms,
            request.parameters!,
            paramValues,
            frameParams,
          );
        },
      );

      // Store for later modification
      this.injectedShaders.set(request.id, {
        request,
        parameterValues: paramValues,
        enabled: request.enableOnInject !== false,
        injectedAt: Date.now(),
        reloadCount: 0,
      });
    }

    // Step 5: Enable if requested
    if (request.enableOnInject !== false) {
      this.graph().setPassEnabled(request.id, true);
    }

    console.log(`[ShaderInjector] Injected "${request.id}" (${request.label})`);

    return {
      success: true,
      passId: request.id,
      validation,
    };
  }

  /**
   * Hot-reload an injected shader with new WGSL source.
   * Unregisters the old pass and registers the new one, preserving parameter values.
   */
  async hotReload(id: string, newSource: string): Promise<InjectionResult> {
    const existing = this.injectedShaders.get(id);
    if (!existing) {
      return {
        success: false,
        passId: id,
        validation: { valid: false, errors: [], warnings: [] },
        error: `No injected shader with ID "${id}" found`,
      };
    }

    // Validate new source first (before tearing down old one)
    const validation = await this.validate(newSource);
    if (!validation.valid) {
      return {
        success: false,
        passId: id,
        validation,
        error: 'Hot-reload validation failed — existing shader preserved',
      };
    }

    // Preserve state
    const wasEnabled = existing.enabled;
    const preservedValues = new Map(existing.parameterValues);

    // Unregister old pass
    this.graph().unregisterPass(id);

    // Re-inject with new source
    const result = await this.inject({
      ...existing.request,
      source: newSource,
      enableOnInject: wasEnabled,
    });

    if (result.success) {
      // Restore parameter values
      const updated = this.injectedShaders.get(id);
      if (updated) {
        updated.parameterValues = preservedValues;
        updated.reloadCount = existing.reloadCount + 1;
      }
      console.log(`[ShaderInjector] Hot-reloaded "${id}" (reload #${existing.reloadCount + 1})`);
    }

    return result;
  }

  /**
   * Remove an injected shader from the render graph.
   */
  remove(id: string): boolean {
    const existing = this.injectedShaders.get(id);
    if (!existing) return false;

    this.graph().unregisterPass(id);
    this.injectedShaders.delete(id);
    console.log(`[ShaderInjector] Removed "${id}"`);
    return true;
  }

  /**
   * Update a parameter value for an injected shader.
   */
  setParameter(id: string, paramName: string, value: number | number[]): boolean {
    const shader = this.injectedShaders.get(id);
    if (!shader) return false;

    shader.parameterValues.set(paramName, value);
    return true;
  }

  /**
   * Get current parameter values for an injected shader.
   */
  getParameters(id: string): Map<string, number | number[]> | null {
    return this.injectedShaders.get(id)?.parameterValues ?? null;
  }

  /**
   * Enable or disable an injected shader.
   */
  setEnabled(id: string, enabled: boolean): void {
    const shader = this.injectedShaders.get(id);
    if (shader) {
      shader.enabled = enabled;
      this.graph().setPassEnabled(id, enabled);
    }
  }

  /**
   * Get all injected shader IDs.
   */
  getInjectedIds(): string[] {
    return [...this.injectedShaders.keys()];
  }

  /**
   * Get metadata for an injected shader.
   */
  getShaderInfo(id: string): InjectedShader | null {
    return this.injectedShaders.get(id) ?? null;
  }

  /**
   * Inject a shader from a built-in template.
   */
  async injectFromTemplate(
    templateId: string,
    effectId: string,
    label?: string,
  ): Promise<InjectionResult> {
    const template = SHADER_TEMPLATES.find((t) => t.id === templateId);
    if (!template) {
      return {
        success: false,
        passId: effectId,
        validation: { valid: false, errors: [], warnings: [] },
        error: `Unknown template ID "${templateId}"`,
      };
    }

    return this.inject({
      id: effectId,
      label: label || template.name,
      source: template.source,
      uniformSize: template.uniformSize,
      parameters: template.parameters,
    });
  }

  /**
   * Get available shader templates.
   */
  getTemplates(): ShaderTemplate[] {
    return SHADER_TEMPLATES;
  }

  /**
   * Remove all injected shaders and clean up.
   */
  destroy(): void {
    for (const id of this.injectedShaders.keys()) {
      this.graph().unregisterPass(id);
    }
    this.injectedShaders.clear();
    console.log('[ShaderInjector] Destroyed, all injected shaders removed');
  }

  // ─── Private helpers ──────────────────────────────────────

  /**
   * Build the full shader source by prepending the vertex shader.
   * The RenderGraph's registerPass does this too, but we need it for
   * standalone validation.
   */
  private buildFullShaderSource(fragmentSource: string): string {
    // Minimal vertex shader for validation
    const vertexShader = `
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
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var out: VertexOutput;
  out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}
`;
    return `${vertexShader}\n${fragmentSource}`;
  }

  /**
   * Write parameter values into a uniform Float32Array, injecting
   * built-in values (time, resolution, audio) automatically.
   */
  private updateUniformsFromParameters(
    uniforms: Float32Array,
    parameters: ShaderParameter[],
    values: Map<string, number | number[]>,
    frameParams: EffectPassParams,
  ): void {
    let offset = 0;
    for (const param of parameters) {
      // Inject built-in values
      if (param.builtIn) {
        switch (param.name) {
          case 'time':
            uniforms[offset] = frameParams.time;
            break;
          case 'resolution_x':
            uniforms[offset] = frameParams.resolution[0];
            break;
          case 'resolution_y':
            uniforms[offset] = frameParams.resolution[1];
            break;
          case 'audio_bass':
            uniforms[offset] = frameParams.audioBass;
            break;
          case 'audio_mid':
            uniforms[offset] = frameParams.audioMid;
            break;
          case 'audio_high':
            uniforms[offset] = frameParams.audioHigh;
            break;
          case 'audio_energy':
            uniforms[offset] = frameParams.audioEnergy;
            break;
          case 'dt':
            uniforms[offset] = frameParams.dt;
            break;
          default:
            uniforms[offset] = 0;
        }
        offset++;
        continue;
      }

      // User-provided values
      const val = values.get(param.name) ?? param.defaultValue;
      if (typeof val === 'number') {
        uniforms[offset] = val;
        offset++;
      } else if (Array.isArray(val)) {
        for (const v of val) {
          uniforms[offset] = v;
          offset++;
        }
      }
    }
  }
}

/**
 * ShaderOverlayPass — Renders WGSL shader presets as a fullscreen-triangle
 * overlay with alpha blending, drawn on top of existing scene content.
 *
 * Architecture:
 * - Assembles WGSL from: SHADER_PRELUDE + preset.body + SHADER_EPILOGUE
 * - Pipeline uses alpha blend (src-alpha / one-minus-src-alpha)
 * - Render pass uses loadOp:'load' to composite over existing content
 * - 160-byte uniform buffer with audio-reactive params + cosine palette + 8 router slots
 * - Built-in beat detector (bass-triggered with cooldown/decay)
 */

import type {
  ShaderOverlayConfig,
  ShaderPalette,
  ShaderPreset,
  ShaderBlendMode,
} from '@/types/effects/shader-overlay';
import { SHADER_PRELUDE } from './shaderPresets/prelude.wgsl';
import { SHADER_EPILOGUE } from './shaderPresets/epilogue.wgsl';
import { getPaletteById, getPresetById } from './shaderPresets/index';

export type { ShaderOverlayConfig };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Audio data passed per-frame by the renderer. */
interface AudioInput {
  bass: number;
  mid: number;
  high: number;
  energy: number;
}

// ---------------------------------------------------------------------------
// ShaderOverlayPass
// ---------------------------------------------------------------------------

export class ShaderOverlayPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  // GPU resources
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;

  // Blend-state pipeline cache. The shader module + layout are stable per loaded
  // preset; only the pipeline's blend state varies with config.blendMode. Cache
  // one pipeline per blend mode (≤ 4 modes) so toggling blend in the inspector
  // never recompiles the shader — it swaps a prebuilt pipeline between frames.
  private _shaderModule: GPUShaderModule | null = null;
  private _pipelineLayout: GPUPipelineLayout | null = null;
  private _pipelineCache = new Map<ShaderBlendMode, GPURenderPipeline>();
  private _activeBlendMode: ShaderBlendMode = 'alpha';

  // Current state
  private _currentPreset: ShaderPreset | null = null;
  private _currentPalette: ShaderPalette | null = null;
  private _time = 0;

  // Beat detector state
  private _bassAvg = 0;
  private _beatValue = 0;
  private _beatCooldown = 0;

  // Accumulated pulse phase (integrates pulseSpeed over time — monotonic)
  private _pulsePhase = 0;

  // Per-param AR smoothing state (attack/decay envelope followers)
  private _arSmoothed: Record<string, number> = {};

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;

    // 160-byte uniform buffer (40 x f32) — 10 x vec4f (incl. 8 audio-router slots)
    this.uniformBuffer = device.createBuffer({
      label: 'shader-overlay-uniforms',
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Bind group layout: single uniform buffer
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'shader-overlay-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' as const },
        },
      ],
    });

    // Create bind group (stable — uniform buffer doesn't change)
    this.bindGroup = device.createBindGroup({
      label: 'shader-overlay-bg',
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Preset / Palette loading
  // ─────────────────────────────────────────────────────────────

  /**
   * Compile and load a shader preset by id or object.
   * Returns true on success, false on shader compilation error.
   */
  async loadPreset(presetOrId: ShaderPreset | string): Promise<boolean> {
    const preset = typeof presetOrId === 'string' ? getPresetById(presetOrId) : presetOrId;

    if (!preset) {
      console.error(`[ShaderOverlayPass] Preset not found: "${presetOrId}"`);
      return false;
    }

    // Skip re-compile if same preset
    if (this._currentPreset?.id === preset.id && this.pipeline) return true;

    // Assemble full WGSL source: prelude + preset body + epilogue
    const source = SHADER_PRELUDE + '\n' + preset.body + '\n' + SHADER_EPILOGUE;

    const shaderModule = this.device.createShaderModule({
      label: `shader-overlay-${preset.id}`,
      code: source,
    });

    // Check for compilation errors
    const info = await shaderModule.getCompilationInfo();
    for (const msg of info.messages) {
      if (msg.type === 'error') {
        console.error(
          `[ShaderOverlayPass] Shader compilation error in "${preset.id}": ${msg.message} (line ${msg.lineNum})`,
        );
        return false;
      }
    }

    const pipelineLayout = this.device.createPipelineLayout({
      label: `shader-overlay-${preset.id}-pl`,
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // New preset → the module + layout change, so the per-blend-mode pipeline
    // cache is stale. Reset it and build the pipeline for the active blend mode.
    this._shaderModule = shaderModule;
    this._pipelineLayout = pipelineLayout;
    this._pipelineCache.clear();

    try {
      this.pipeline = await this._pipelineForBlend(this._activeBlendMode, preset.id);
    } catch (err) {
      console.error(`[ShaderOverlayPass] Pipeline creation failed for "${preset.id}":`, err);
      this._shaderModule = null;
      this._pipelineLayout = null;
      return false;
    }
    if (!this.pipeline) {
      this._shaderModule = null;
      this._pipelineLayout = null;
      return false;
    }

    this._currentPreset = preset;

    // Reset beat detector on preset change
    this._bassAvg = 0;
    this._beatValue = 0;
    this._beatCooldown = 0;
    this._time = 0;

    console.log(`[ShaderOverlayPass] Loaded preset "${preset.id}"`);
    return true;
  }

  /**
   * Map a config blend mode to a WebGPU blend state.
   *  - alpha     → standard src-alpha over (premultiplied-out) compositing.
   *  - additive  → add source color scaled by its alpha (glow/light layers).
   *  - screen    → 1-(1-a)(1-b): brightens, softer than additive.
   *  - multiply  → darkens by the source (shadow/tint layers).
   *  - replace   → overwrite (opaque overlay, no blending).
   */
  private static blendStateFor(mode: ShaderBlendMode): GPUBlendState | undefined {
    switch (mode) {
      case 'additive':
        return {
          color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        };
      case 'screen':
        return {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
        };
      case 'multiply':
        return {
          color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
          alpha: { srcFactor: 'dst-alpha', dstFactor: 'zero', operation: 'add' },
        };
      case 'replace':
        // No blend state → opaque overwrite of the target.
        return undefined;
      case 'alpha':
      default:
        return {
          color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add',
          },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        };
    }
  }

  /**
   * Build (or return a cached) render pipeline for the current shader module at
   * the given blend mode. Cached per blend mode so switching modes never
   * recompiles the shader. Requires the module + layout to be set by loadPreset.
   */
  private async _pipelineForBlend(
    mode: ShaderBlendMode,
    presetId: string,
  ): Promise<GPURenderPipeline | null> {
    const cached = this._pipelineCache.get(mode);
    if (cached) return cached;
    if (!this._shaderModule || !this._pipelineLayout) return null;

    const pipeline = await this.device.createRenderPipelineAsync({
      label: `shader-overlay-${presetId}-${mode}-pipeline`,
      layout: this._pipelineLayout,
      vertex: { module: this._shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: this._shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format, blend: ShaderOverlayPass.blendStateFor(mode) }],
      },
      primitive: { topology: 'triangle-list' as const },
    });
    this._pipelineCache.set(mode, pipeline);
    return pipeline;
  }

  /**
   * Set the active cosine palette by id or object.
   */
  setPalette(paletteOrId: ShaderPalette | string): void {
    if (typeof paletteOrId === 'string') {
      this._currentPalette = getPaletteById(paletteOrId) ?? null;
    } else {
      this._currentPalette = paletteOrId;
    }
  }

  /**
   * Get the currently loaded preset (or null).
   */
  get currentPreset(): ShaderPreset | null {
    return this._currentPreset;
  }

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────

  /**
   * Render the shader overlay onto the target view.
   * The target must already contain the scene content (loadOp: 'load').
   *
   * @param targetView - Render target with existing scene content
   * @param encoder - Command encoder to record into
   * @param config - Current shader overlay configuration
   * @param dt - Frame delta time in seconds
   * @param audio - Per-frame audio band values
   * @param resolution - Canvas [width, height]
   */
  render(
    targetView: GPUTextureView,
    encoder: GPUCommandEncoder,
    config: ShaderOverlayConfig,
    dt: number,
    audio: AudioInput,
    resolution: [number, number],
    /** Optional 8 audio-router slot values (u_value1..8). Null/short => zeros. */
    slotValues?: Float32Array | null,
  ): void {
    if (!this.pipeline || !this.bindGroup) return;

    // Sync the GPU blend state to the config's blend mode. Prebuilt pipelines are
    // cached per mode; on a cache miss we render with the current pipeline this
    // frame and kick an async build so the next frame picks up the right blend
    // (never compile on the hot path).
    const wantMode: ShaderBlendMode = config.blendMode ?? 'alpha';
    if (wantMode !== this._activeBlendMode) {
      const ready = this._pipelineCache.get(wantMode);
      if (ready) {
        this.pipeline = ready;
        this._activeBlendMode = wantMode;
      } else if (this._currentPreset) {
        void this._pipelineForBlend(wantMode, this._currentPreset.id);
        // keep drawing with the current pipeline until the new one is ready
      }
    }

    // Accumulate time
    this._time += dt;

    // Resolve palette — use config's paletteId or preset default
    const palette = this._currentPalette ?? getPaletteById(config.paletteId) ?? null;
    if (!palette) return;

    // ── Per-param audio reactivity helper ───────────────────────
    // Applies box-plot curve to audio, returns modulated value in [ar.min, ar.max]
    const processAR = (
      ar:
        | {
            enabled: boolean;
            band: string;
            intensity: number;
            min: number;
            max: number;
            lowerThreshold?: number;
            upperThreshold?: number;
            boxCenter?: number;
            boxWidth?: number;
            attack?: number;
            decay?: number;
            invert?: boolean;
          }
        | undefined,
      baseValue: number,
      paramKey?: string,
    ): number => {
      if (!ar || !ar.enabled) return baseValue;

      let rawBand = audio.bass;
      switch (ar.band) {
        case 'mid':
          rawBand = audio.mid;
          break;
        case 'high':
          rawBand = audio.high;
          break;
        case 'energy':
          rawBand = audio.energy;
          break;
      }

      const lt = ar.lowerThreshold ?? 0;
      const ut = ar.upperThreshold ?? 1;
      const bc = ar.boxCenter ?? 0.5;
      const bw = ar.boxWidth ?? 0.3;
      const intensity = ar.intensity;

      if (rawBand <= lt) return ar.invert ? ar.max : ar.min;
      if (rawBand >= ut) return ar.invert ? ar.min : ar.max * intensity;

      const boxMin = Math.max(lt, bc - bw / 2);
      const boxMax = Math.min(ut, bc + bw / 2);
      const normalized = (rawBand - lt) / (ut - lt);
      const boxMinNorm = (boxMin - lt) / (ut - lt);
      const boxMaxNorm = (boxMax - lt) / (ut - lt);
      let mapped: number;
      if (normalized < boxMinNorm) {
        const t = boxMinNorm > 0 ? normalized / boxMinNorm : 0;
        mapped = 0.1 * Math.log10(1 + 9 * t);
      } else if (normalized <= boxMaxNorm) {
        const range = boxMaxNorm - boxMinNorm;
        const t = range > 0 ? (normalized - boxMinNorm) / range : 0.5;
        mapped = 0.1 + 0.8 * t;
      } else {
        const range = 1 - boxMaxNorm;
        const t = range > 0 ? (normalized - boxMaxNorm) / range : 1;
        mapped = 0.9 + 0.1 * Math.log10(1 + 9 * t);
      }

      let target: number;
      if (ar.invert) {
        target = ar.max - mapped * (ar.max - ar.min) * intensity;
      } else {
        target = ar.min + mapped * (ar.max - ar.min) * intensity;
      }
      target = Math.max(Math.min(ar.min, ar.max), Math.min(Math.max(ar.min, ar.max), target));

      // ── Attack/Decay envelope follower ────────────────────────
      // Smooths the output so it rises with attack time and falls with decay time.
      if (paramKey && dt > 0) {
        const attackTime = ar.attack ?? 0;
        const decayTime = ar.decay ?? 0;
        const prev = this._arSmoothed[paramKey] ?? target;
        const isRising = target > prev;
        const timeConstant = isRising ? attackTime : decayTime;

        if (timeConstant > 0.001) {
          // Exponential smoothing: approach target with given time constant
          const factor = 1 - Math.exp(-dt / timeConstant);
          const smoothed = prev + (target - prev) * factor;
          this._arSmoothed[paramKey] = smoothed;
          return smoothed;
        } else {
          // No smoothing (attack/decay = 0): instant response
          this._arSmoothed[paramKey] = target;
          return target;
        }
      }

      return target;
    };

    // ── Resolve per-param values with AR ────────────────────────
    const extConfig = config as typeof config & {
      p2?: number;
      p3?: number;
      arP2?: ShaderOverlayConfig['arP0'];
      arP3?: ShaderOverlayConfig['arP0'];
    };
    const effectiveOpacity = processAR(config.arOpacity, config.opacity, 'opacity');
    const effectiveP0 = processAR(config.arP0, config.p0, 'p0');
    const effectiveP1 = processAR(config.arP1, config.p1, 'p1');
    const effectiveP2 = processAR(extConfig.arP2, extConfig.p2 ?? 0, 'p2');
    const effectiveP3 = processAR(extConfig.arP3, extConfig.p3 ?? 0, 'p3');

    const bass = audio.bass;

    // ── Beat detector ───────────────────────────────────────────
    const attack = config.attack ?? 0.02;
    const decay = config.decay ?? 0.05;
    const bassSmoothing = bass > this._bassAvg ? attack : decay;
    const bassFactor = 1 - Math.exp(-dt / Math.max(0.001, bassSmoothing));
    this._bassAvg += (bass - this._bassAvg) * bassFactor;

    this._beatCooldown -= dt;
    const thresh = this._bassAvg * 2.0;
    if (bass > thresh && bass > 0.05 && this._beatCooldown <= 0) {
      this._beatValue = 1;
      this._beatCooldown = 0.12;
    }

    if (dt > 0) {
      const beatDecayTime = Math.max(0.05, decay * 7);
      this._beatValue *= Math.pow(0.001, dt / beatDecayTime);
    }

    // ── Blend mode numeric (u_blendMode: shader-side awareness) ─
    // 0=alpha/replace, 1=additive, 2=screen, 3=multiply. The GPU pipeline blend
    // state (blendStateFor) does the real compositing; this just lets a shader
    // adapt its output if it wants to.
    let blendModeNum = 0;
    if (config.blendMode === 'additive') blendModeNum = 1;
    else if (config.blendMode === 'screen') blendModeNum = 2;
    else if (config.blendMode === 'multiply') blendModeNum = 3;

    // ── Pack uniform buffer (160 bytes = 40 x f32) ─────────────
    const a = new Float32Array(40);

    // vec4 a: time, energy, beat, pad
    // Accumulate pulse phase: integrates pulse speed over time (monotonic)
    // effectiveP1 = pulse speed (0..1). Base rate 1.0, max rate 4.5.
    const pulseRate = 1.0 + effectiveP1 * 3.5;
    this._pulsePhase += pulseRate * dt;

    a[0] = this._time;
    a[1] = audio.energy;
    a[2] = this._beatValue;
    a[3] = this._pulsePhase;

    // vec4 b: bass, mid, treb, pad
    a[4] = audio.bass;
    a[5] = audio.mid;
    a[6] = audio.high;
    a[7] = 0;

    // vec4 c: resX, resY, param0, param1
    a[8] = resolution[0];
    a[9] = resolution[1];
    a[10] = effectiveP0;
    a[11] = effectiveP1;

    // vec4 d: opacity, blendMode, p2, p3
    a[12] = effectiveOpacity;
    a[13] = blendModeNum;
    a[14] = effectiveP2;
    a[15] = effectiveP3;

    // vec4 pa: palette.a (with w=0 padding)
    a[16] = palette.a[0];
    a[17] = palette.a[1];
    a[18] = palette.a[2];
    a[19] = 0;

    // vec4 pb: palette.b
    a[20] = palette.b[0];
    a[21] = palette.b[1];
    a[22] = palette.b[2];
    a[23] = 0;

    // vec4 pc: palette.c
    a[24] = palette.c[0];
    a[25] = palette.c[1];
    a[26] = palette.c[2];
    a[27] = 0;

    // vec4 pd: palette.d
    a[28] = palette.d[0];
    a[29] = palette.d[1];
    a[30] = palette.d[2];
    a[31] = 0;

    // vec4 e/f: audio-router slots value1..value8 (0 when unrouted/absent)
    for (let i = 0; i < 8; i++) {
      a[32 + i] = slotValues && i < slotValues.length ? slotValues[i] : 0;
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, a);

    // ── Render pass ─────────────────────────────────────────────
    const renderPass = encoder.beginRenderPass({
      label: 'shader-overlay-pass',
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'load' as const, // Draw on top of existing content
          storeOp: 'store' as const,
        },
      ],
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(3); // Fullscreen triangle
    renderPass.end();
  }

  // ─────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────

  /**
   * Release all GPU resources.
   */
  destroy(): void {
    this.uniformBuffer.destroy();
    this.pipeline = null;
    this.bindGroup = null;
    this._shaderModule = null;
    this._pipelineLayout = null;
    this._pipelineCache.clear();
    this._currentPreset = null;
    this._currentPalette = null;
    console.log('[ShaderOverlayPass] Destroyed.');
  }
}

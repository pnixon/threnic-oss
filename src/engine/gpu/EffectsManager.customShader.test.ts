/**
 * EffectsManager.customShader.test.ts — contract tests for the per-instance
 * `customShader` dynamic-pass path (LLD §5, "transform half").
 *
 * Mock-device / mock-RenderGraph tests (WebGPU can't run in jsdom). They lock in:
 *   - a NEW enabled customShader instance registers a per-instance pass
 *     `customShader:<id>` compiled from its own `source`.
 *   - a SOURCE change hot-reloads that pass in place.
 *   - REMOVING/DISABLING the instance prunes its pass.
 *   - two instances get two independent passes.
 *   - resolveInstancePassId returns null for the type (per-instance, by id),
 *     while customShaderPassId derives the id, and the render split resolves it.
 *   - the factory default is enabled with a compilable-looking WGSL body + params.
 *   - with NO device (software renderer) it no-ops instead of throwing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EffectsManager,
  resolveInstancePassId,
  customShaderPassId,
  CUSTOM_SHADER_TYPE,
  CUSTOM_SHADER_FRAME_BUDGET_MS,
  CUSTOM_SHADER_SUSTAINED_FRAMES,
} from './EffectsManager';
import { createDefaultInstance } from '@/types/effects/effect-instance-factory';
import type { EffectsConfig } from '@/types/effects';
import type { EffectPassParams } from './RenderGraph';
import type { EffectInstance, CustomShaderConfig } from '@/types/effects/effect-instances';

function installGPUGlobals() {
  (globalThis as Record<string, unknown>).GPUTextureUsage = {
    RENDER_ATTACHMENT: 0x10,
    TEXTURE_BINDING: 0x04,
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    UNIFORM: 0x40,
  };
  (globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  (globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08 };
}

/** A mock GPUDevice sufficient for ShaderInjector.validate + registerPass. */
function makeMockDevice(): GPUDevice {
  return {
    createShaderModule: vi.fn(() => ({
      getCompilationInfo: async () => ({ messages: [] }),
    })),
    createBindGroupLayout: vi.fn(() => ({ __bgl: true })),
    createPipelineLayout: vi.fn(() => ({ __pl: true })),
    createRenderPipelineAsync: vi.fn(async () => ({ __pipeline: true })),
    createBuffer: vi.fn(() => ({ __buffer: true, destroy: vi.fn() })),
    createBindGroup: vi.fn(() => ({ __bindGroup: true })),
    queue: { writeBuffer: vi.fn() },
    limits: { maxTextureDimension2D: 8192 },
  } as unknown as GPUDevice;
}

/**
 * A mock RenderGraph tracking registered pass ids, enabled state, updaters and
 * order — the surface EffectsManager + ShaderInjector actually call.
 */
function makeMockGraph() {
  const passes = new Map<string, { enabled: boolean; updater?: unknown; source?: string }>();
  let lastOrder: string[] | null = null;
  const graph = {
    registerPass: vi.fn(async (cfg: { id: string; shaderSource?: string }) => {
      passes.set(cfg.id, { enabled: false, source: cfg.shaderSource });
      return true;
    }),
    unregisterPass: vi.fn((id: string) => {
      passes.delete(id);
    }),
    setPassEnabled: vi.fn((id: string, enabled: boolean) => {
      const p = passes.get(id);
      if (p) p.enabled = enabled;
    }),
    setPassUniformUpdater: vi.fn((id: string, updater: unknown) => {
      const p = passes.get(id);
      if (p) p.updater = updater;
    }),
    setPassOrder: vi.fn((order: string[] | null) => {
      lastOrder = order;
    }),
    hasPass: vi.fn((id: string) => passes.has(id)),
  };
  return {
    graph: graph as unknown as import('./RenderGraph').RenderGraph,
    passes,
    getOrder: () => lastOrder,
    raw: graph,
  };
}

function customShaderInstance(
  id: string,
  overrides: Partial<CustomShaderConfig> = {},
): EffectInstance {
  const source =
    overrides.source ??
    `@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
struct Uniforms { a: f32, _p0: f32, _p1: f32, _p2: f32 }
@group(0) @binding(2) var<uniform> params: Uniforms;
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, input.uv, 0.0) * params.a;
}`;
  return {
    id,
    type: 'customShader',
    config: { enabled: true, source, params: [{ name: 'a', value: 1 }], ...overrides },
  } as EffectInstance;
}

function cfgOf(instances: EffectInstance[]): EffectsConfig {
  return { effectInstances: instances } as unknown as EffectsConfig;
}

describe('EffectsManager — customShader per-instance passes', () => {
  beforeEach(() => installGPUGlobals());

  it('resolveInstancePassId returns null for customShader (per-instance by id)', () => {
    expect(resolveInstancePassId(CUSTOM_SHADER_TYPE)).toBeNull();
    expect(customShaderPassId('abc')).toBe('customShader:abc');
  });

  it('registers a per-instance pass for a new enabled instance', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());

    const inst = customShaderInstance('id1');
    await mgr.syncFrameAsync(cfgOf([inst]));

    const pid = customShaderPassId('id1');
    expect(passes.has(pid)).toBe(true);
    // syncFrameAsync enables needed passes.
    expect(passes.get(pid)?.enabled).toBe(true);
    // The compiled pass carries THIS instance's source.
    expect(passes.get(pid)?.source).toContain('params.a');
  });

  it('gives two instances two independent passes', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('a'), customShaderInstance('b')]));
    expect(passes.has(customShaderPassId('a'))).toBe(true);
    expect(passes.has(customShaderPassId('b'))).toBe(true);
  });

  it('hot-reloads the pass when the source changes', async () => {
    const { graph, passes, raw } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]));
    const regCallsBefore = raw.registerPass.mock.calls.length;

    // Change the source → hot-reload (unregister old + register new).
    const changed = customShaderInstance('id1', {
      source: `@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
struct Uniforms { a: f32, _p0: f32, _p1: f32, _p2: f32 }
@group(0) @binding(2) var<uniform> params: Uniforms;
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0); // CHANGED
}`,
    });
    await mgr.syncFrameAsync(cfgOf([changed]));

    expect(passes.has(pid)).toBe(true);
    expect(passes.get(pid)?.source).toContain('CHANGED');
    // A hot-reload re-registers, so registerPass was called again.
    expect(raw.registerPass.mock.calls.length).toBeGreaterThan(regCallsBefore);
  });

  it('prunes the pass when the instance is removed', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]));
    expect(passes.has(pid)).toBe(true);

    // Instance gone → pass pruned.
    await mgr.syncFrameAsync(cfgOf([]));
    expect(passes.has(pid)).toBe(false);
  });

  it('prunes the pass when the instance is disabled', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]));
    expect(passes.has(pid)).toBe(true);

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1', { enabled: false })]));
    expect(passes.has(pid)).toBe(false);
  });

  it('places the per-instance pass id into the render-graph order', async () => {
    const { graph, getOrder } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]));
    expect(getOrder()).toContain(customShaderPassId('id1'));
  });

  it('no-ops (does not throw) with no device — software renderer', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    // No setDevice call.
    await expect(mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]))).resolves.toBeTypeOf(
      'boolean',
    );
    // Nothing was registered without a device.
    expect(passes.has(customShaderPassId('id1'))).toBe(false);
  });

  it('dispose tears down all customShader passes', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    await mgr.syncFrameAsync(cfgOf([customShaderInstance('a'), customShaderInstance('b')]));
    expect(passes.size).toBeGreaterThanOrEqual(2);
    mgr.dispose();
    expect(passes.has(customShaderPassId('a'))).toBe(false);
    expect(passes.has(customShaderPassId('b'))).toBe(false);
  });
});

describe('EffectsManager — customShader audio-reactive params', () => {
  beforeEach(() => installGPUGlobals());

  /** Frame params with the given band levels (rest silent). */
  function frameParams(over: Partial<EffectPassParams> = {}): EffectPassParams {
    return {
      time: 1,
      dt: 1 / 60,
      resolution: [1920, 1080] as [number, number],
      audioBass: 0,
      audioMid: 0,
      audioHigh: 0,
      audioEnergy: 0,
      didReset: false,
      ...over,
    };
  }

  it('a NON-reactive param packs its base value; the value tracks slider edits', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    await mgr.syncFrameAsync(
      cfgOf([customShaderInstance('id1', { params: [{ name: 'a', value: 0.42 }] })]),
    );
    const updater = passes.get(pid)!.updater as (u: Float32Array, p: EffectPassParams) => void;
    const u = new Float32Array(4);
    // Even with loud audio, a param with no AR config stays at its base value.
    updater(u, frameParams({ audioBass: 1, audioEnergy: 1 }));
    expect(u[0]).toBeCloseTo(0.42, 5);
    // slot 1 is the built-in time.
    expect(u[1]).toBeCloseTo(1, 5);
  });

  it('a reactive param rises toward max on loud audio and sits at min in silence', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    const inst = customShaderInstance('id1', {
      params: [
        {
          name: 'a',
          value: 0,
          min: 0,
          max: 1,
          audioReactive: {
            enabled: true,
            band: 'bass',
            intensity: 1,
            min: 0,
            max: 1,
            attack: 0.001,
            decay: 0.001,
            lowerThreshold: 0,
            upperThreshold: 1,
            boxCenter: 0.5,
            boxWidth: 0.3,
          },
        },
      ],
    });
    await mgr.syncFrameAsync(cfgOf([inst]));
    const updater = passes.get(pid)!.updater as (u: Float32Array, p: EffectPassParams) => void;
    const u = new Float32Array(4);

    // Drive several frames of LOUD bass with a snappy envelope → approaches max.
    for (let i = 0; i < 30; i++) updater(u, frameParams({ audioBass: 1 }));
    const loud = u[0];
    expect(loud).toBeGreaterThan(0.5);

    // Now several frames of SILENCE → decays back toward min (0).
    for (let i = 0; i < 60; i++) updater(u, frameParams({ audioBass: 0 }));
    expect(u[0]).toBeLessThan(0.1);
    expect(u[0]).toBeLessThan(loud);
  });

  it('a reactive param ignores a band it is not routed to', async () => {
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    const inst = customShaderInstance('id1', {
      params: [
        {
          name: 'a',
          value: 0,
          min: 0,
          max: 1,
          audioReactive: {
            enabled: true,
            band: 'high',
            intensity: 1,
            min: 0,
            max: 1,
            attack: 0.001,
            decay: 0.001,
            lowerThreshold: 0,
            upperThreshold: 1,
            boxCenter: 0.5,
            boxWidth: 0.3,
          },
        },
      ],
    });
    await mgr.syncFrameAsync(cfgOf([inst]));
    const updater = passes.get(pid)!.updater as (u: Float32Array, p: EffectPassParams) => void;
    const u = new Float32Array(4);
    // Loud BASS but the param is routed to HIGH → stays near min.
    for (let i = 0; i < 30; i++) updater(u, frameParams({ audioBass: 1, audioHigh: 0 }));
    expect(u[0]).toBeLessThan(0.1);
  });

  it('packs a template uniformLayout in struct order, filling resolution built-ins from frame params', async () => {
    // Regression: the Edge Detection template's struct interleaves built-in
    // resolution_x/y BETWEEN user params. Without honoring uniformLayout the
    // packer put user params first and left resolution at 0 → texel = 1/0 → the
    // whole-scanline "tearing". Assert the packed floats match the struct order:
    //   [intensity, threshold, resolution_x, resolution_y, mix_original, pad×3]
    const { graph, passes } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    const inst = customShaderInstance('id1', {
      params: [
        { name: 'intensity', value: 1.0 },
        { name: 'threshold', value: 0.1 },
        { name: 'mix_original', value: 0.5 },
      ],
      uniformLayout: [
        { name: 'intensity' },
        { name: 'threshold' },
        { name: 'resolution_x', builtIn: true },
        { name: 'resolution_y', builtIn: true },
        { name: 'mix_original' },
        { name: '_pad0', builtIn: true },
        { name: '_pad1', builtIn: true },
        { name: '_pad2', builtIn: true },
      ],
    });
    await mgr.syncFrameAsync(cfgOf([inst]));
    const updater = passes.get(pid)!.updater as (u: Float32Array, p: EffectPassParams) => void;
    const u = new Float32Array(8);
    updater(u, frameParams({ resolution: [1280, 720] }));

    expect(u[0]).toBeCloseTo(1.0, 5); // intensity
    expect(u[1]).toBeCloseTo(0.1, 5); // threshold
    expect(u[2]).toBeCloseTo(1280, 5); // resolution_x ← frame params, NOT 0
    expect(u[3]).toBeCloseTo(720, 5); // resolution_y ← frame params, NOT 0
    expect(u[4]).toBeCloseTo(0.5, 5); // mix_original (after the resolution slots)
    expect(u[5]).toBe(0); // pad
  });
});

describe('effect-instance-factory — customShader default', () => {
  it('createDefaultInstance("customShader") is enabled with WGSL + params', () => {
    const inst = createDefaultInstance('customShader');
    expect(inst.type).toBe('customShader');
    const cfg = inst.config as CustomShaderConfig;
    expect(cfg.enabled).toBe(true);
    // Working transform: samples the layer beneath + declares fs_main.
    expect(cfg.source).toContain('inputTexture');
    expect(cfg.source).toContain('fn fs_main');
    expect(cfg.source).toContain('@location(0) vec4f');
    expect(cfg.params.length).toBeGreaterThan(0);
    expect(cfg.params.every((p) => typeof p.value === 'number')).toBe(true);
  });
});

describe('EffectsManager — customShader frame watchdog (§5/3b safety)', () => {
  beforeEach(() => installGPUGlobals());

  const OVER = CUSTOM_SHADER_FRAME_BUDGET_MS + 20;
  const OK = CUSTOM_SHADER_FRAME_BUDGET_MS - 20;

  it('auto-disables a pass after sustained over-budget frames and surfaces an event', async () => {
    const { graph, passes, raw } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]));
    // The pass is enabled by syncFrame (needed set).
    expect(passes.get(pid)!.enabled).toBe(true);
    raw.setPassEnabled.mockClear();

    // Sustained over-budget frames inside the watch window → trip.
    for (let i = 0; i < CUSTOM_SHADER_SUSTAINED_FRAMES; i++) mgr.feedFrameTime(OVER);

    expect(raw.setPassEnabled).toHaveBeenCalledWith(pid, false);
    expect(passes.get(pid)!.enabled).toBe(false);
    const events = mgr.consumeWatchdogEvents();
    expect(events).toHaveLength(1);
    expect(events[0].instanceId).toBe('id1');
    expect(events[0].reason).toMatch(/auto-disabled/i);
    // Events drain: a second read is empty.
    expect(mgr.consumeWatchdogEvents()).toHaveLength(0);
  });

  it('does NOT trip on a single spike (must be sustained)', async () => {
    const { graph, passes, raw } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]));
    raw.setPassEnabled.mockClear();

    // One spike, then healthy frames — overCount resets, never reaches the run.
    mgr.feedFrameTime(OVER);
    for (let i = 0; i < CUSTOM_SHADER_SUSTAINED_FRAMES + 2; i++) mgr.feedFrameTime(OK);

    expect(raw.setPassEnabled).not.toHaveBeenCalledWith(pid, false);
    expect(passes.get(pid)!.enabled).toBe(true);
    expect(mgr.consumeWatchdogEvents()).toHaveLength(0);
  });

  it('never disables when frame time is never fed (the export path)', async () => {
    const { graph, passes, raw } = makeMockGraph();
    const mgr = new EffectsManager(graph);
    mgr.setDevice(makeMockDevice());
    const pid = customShaderPassId('id1');

    await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]));
    raw.setPassEnabled.mockClear();

    // Export drives frames via syncFrameAsync but NEVER calls feedFrameTime.
    for (let i = 0; i < 20; i++) await mgr.syncFrameAsync(cfgOf([customShaderInstance('id1')]));

    expect(raw.setPassEnabled).not.toHaveBeenCalledWith(pid, false);
    expect(passes.get(pid)!.enabled).toBe(true);
  });
});

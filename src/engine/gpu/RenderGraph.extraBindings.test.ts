/**
 * RenderGraph.extraBindings.test.ts — contract tests for the additionalBindings
 * seam that lets a pass sample its own extra resources (e.g. a secondary
 * overlay image texture + sampler) beyond the standard input/sampler/uniforms.
 *
 * Mock-device tests (WebGPU can't run in jsdom). They lock in:
 *   - A pass declaring config.additionalBindings gets those layout entries.
 *   - setPassExtraBindings() attaches persistent resources that are merged
 *     into the per-frame bind group alongside bindings 0/1/2.
 *   - Clearing extra bindings (null) removes them from subsequent frames.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RenderGraph, type EffectPassConfig } from './RenderGraph';

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

function makeMockDevice() {
  const createBindGroup = vi.fn((desc: GPUBindGroupDescriptor) => ({ __bindGroup: true, desc }));
  const writeBuffer = vi.fn();
  const renderPass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const encoder = {
    beginRenderPass: vi.fn(() => renderPass),
    copyTextureToTexture: vi.fn(),
  };
  const device = {
    createSampler: vi.fn(() => ({ __sampler: true })),
    createBuffer: vi.fn(() => ({ __buffer: true, destroy: vi.fn() })),
    createBindGroupLayout: vi.fn((d: { label?: string; entries: GPUBindGroupLayoutEntry[] }) => ({
      __bgl: true,
      entries: d.entries,
    })),
    createPipelineLayout: vi.fn(() => ({ __pl: true })),
    createShaderModule: vi.fn(() => ({
      __shader: true,
      getCompilationInfo: async () => ({ messages: [] }),
    })),
    createRenderPipelineAsync: vi.fn(async () => ({ __pipeline: true })),
    createTexture: vi.fn(() => ({
      __texture: true,
      createView: vi.fn(() => ({ __view: true })),
      destroy: vi.fn(),
    })),
    createBindGroup,
    queue: { writeBuffer },
  };
  return { device, encoder, renderPass, createBindGroup };
}

const OVERLAY_CONFIG: EffectPassConfig = {
  id: 'test-overlay',
  label: 'Test Overlay',
  shaderSource: `@fragment fn fs_main(i: VertexOutput) -> @location(0) vec4f { return vec4f(0.0); }`,
  uniformBufferSize: 16,
  additionalBindings: [
    { binding: 3, visibility: 2 /* FRAGMENT */, texture: { sampleType: 'float' } },
    { binding: 4, visibility: 2 /* FRAGMENT */, sampler: { type: 'filtering' } },
  ],
};

describe('RenderGraph additionalBindings seam', () => {
  beforeEach(() => {
    installGPUGlobals();
  });

  it('includes additionalBindings in the pass bind-group layout', async () => {
    const { device } = makeMockDevice();
    const rg = new RenderGraph(device as unknown as GPUDevice, 'rgba8unorm');
    await rg.init(64, 64);
    const ok = await rg.registerPass(OVERLAY_CONFIG);
    expect(ok).toBe(true);

    // The last createBindGroupLayout call for the overlay pass must contain
    // bindings 0,1,2 (standard) plus 3,4 (the extra texture + sampler).
    const layoutCall = device.createBindGroupLayout.mock.calls.find(
      (c) => c[0]?.label === 'test-overlay-bgl',
    );
    expect(layoutCall).toBeTruthy();
    const bindings = layoutCall![0].entries.map((e) => e.binding).sort();
    expect(bindings).toEqual([0, 1, 2, 3, 4]);
  });

  it('merges setPassExtraBindings resources into the per-frame bind group', async () => {
    const { device, createBindGroup } = makeMockDevice();
    const rg = new RenderGraph(device as unknown as GPUDevice, 'rgba8unorm');
    await rg.init(64, 64);
    rg.resize(64, 64);
    await rg.registerPass(OVERLAY_CONFIG);
    rg.setPassEnabled('test-overlay', true);

    const imageView = { __imageView: true } as unknown as GPUTextureView;
    const imageSampler = { __imageSampler: true } as unknown as GPUSampler;
    rg.setPassExtraBindings('test-overlay', [
      { binding: 3, resource: imageView },
      { binding: 4, resource: imageSampler },
    ]);

    const bgView = { __bg: true } as unknown as GPUTextureView;
    const outView = { __out: true } as unknown as GPUTextureView;
    rg.execute(
      bgView,
      outView,
      {
        time: 0,
        dt: 1 / 60,
        resolution: [64, 64],
        audioBass: 0,
        audioMid: 0,
        audioHigh: 0,
        audioEnergy: 0,
        didReset: false,
      },
      encoderOf(),
    );

    // Find the frame bind group built for the overlay pass.
    const frameCall = createBindGroup.mock.calls.find(
      (c) => c[0]?.label === 'test-overlay-frame-bg',
    );
    expect(frameCall).toBeTruthy();
    const entries = frameCall![0].entries as GPUBindGroupEntry[];
    const byBinding = Object.fromEntries(entries.map((e) => [e.binding, e.resource]));
    // Standard bindings present…
    expect(byBinding[2]).toBeTruthy(); // uniform buffer
    expect(byBinding[0]).toBeTruthy(); // input texture
    expect(byBinding[1]).toBeTruthy(); // sampler
    // …plus the merged extra image bindings.
    expect(byBinding[3]).toBe(imageView);
    expect(byBinding[4]).toBe(imageSampler);
  });

  it('skips the pass when required extra bindings are cleared (avoids invalid bind group)', async () => {
    const { device, createBindGroup } = makeMockDevice();
    const rg = new RenderGraph(device as unknown as GPUDevice, 'rgba8unorm');
    await rg.init(64, 64);
    await rg.registerPass(OVERLAY_CONFIG);
    rg.setPassEnabled('test-overlay', true);
    rg.setPassExtraBindings('test-overlay', [
      { binding: 3, resource: { __v: true } as unknown as GPUTextureView },
    ]);
    rg.setPassExtraBindings('test-overlay', null);

    const bgView = { __bg: true } as unknown as GPUTextureView;
    const outView = { __out: true } as unknown as GPUTextureView;
    rg.execute(
      bgView,
      outView,
      {
        time: 0,
        dt: 1 / 60,
        resolution: [64, 64],
        audioBass: 0,
        audioMid: 0,
        audioHigh: 0,
        audioEnergy: 0,
        didReset: false,
      },
      encoderOf(),
    );

    // A pass declaring additionalBindings (3+4) whose extraBindings were
    // cleared MUST NOT build a frame bind group — doing so would produce a
    // 3-entry group against a 5-entry layout, which WebGPU rejects and which
    // invalidates the whole command buffer (blanking the canvas). Instead the
    // pass is skipped (its input blits through), so no 'test-overlay-frame-bg'
    // bind group is created this frame.
    const frameCall = createBindGroup.mock.calls.find(
      (c) => c[0]?.label === 'test-overlay-frame-bg',
    );
    expect(frameCall).toBeFalsy();
  });

  it('setPassExtraBindings is a NO-OP before the pass is registered (the aspect-change trap)', async () => {
    const { device } = makeMockDevice();
    const rg = new RenderGraph(device as unknown as GPUDevice, 'rgba8unorm');
    await rg.init(64, 64);

    // Attach extra bindings BEFORE the pass exists — this happens on a fresh
    // graph (aspect-ratio change rebuilds the renderer) when a decoded overlay
    // texture is ready before its pass has been registered on the new graph.
    expect(rg.hasPass('test-overlay')).toBe(false);
    rg.setPassExtraBindings('test-overlay', [
      { binding: 3, resource: { __v: true } as unknown as GPUTextureView },
      { binding: 4, resource: { __s: true } as unknown as GPUSampler },
    ]);

    // Now register the pass — the earlier bindings were dropped, so the pass
    // has NO extra bindings until they're re-applied. The renderer relies on
    // this exact behavior: it must re-attach after the pass appears (guarded by
    // tracking which graph the bindings were bound to). If this contract ever
    // changes to buffer pre-registration bindings, the renderer's re-attach
    // guard should be revisited.
    await rg.registerPass(OVERLAY_CONFIG);
    rg.setPassEnabled('test-overlay', true);

    const { createBindGroup } = { createBindGroup: device.createBindGroup };
    createBindGroup.mockClear?.();

    rg.execute(
      { __bg: true } as unknown as GPUTextureView,
      { __out: true } as unknown as GPUTextureView,
      {
        time: 0,
        dt: 1 / 60,
        resolution: [64, 64],
        audioBass: 0,
        audioMid: 0,
        audioHigh: 0,
        audioEnergy: 0,
        didReset: false,
      },
      encoderOf(),
    );

    // The pass declares required extra bindings (3+4) but has none attached →
    // it is skipped (no frame bind group), exactly as when they're cleared.
    const frameCall = device.createBindGroup.mock.calls.find(
      (c) => c[0]?.label === 'test-overlay-frame-bg',
    );
    expect(frameCall).toBeFalsy();

    // Re-applying AFTER registration binds successfully.
    rg.setPassExtraBindings('test-overlay', [
      { binding: 3, resource: { __v2: true } as unknown as GPUTextureView },
      { binding: 4, resource: { __s2: true } as unknown as GPUSampler },
    ]);
    rg.execute(
      { __bg: true } as unknown as GPUTextureView,
      { __out: true } as unknown as GPUTextureView,
      {
        time: 0,
        dt: 1 / 60,
        resolution: [64, 64],
        audioBass: 0,
        audioMid: 0,
        audioHigh: 0,
        audioEnergy: 0,
        didReset: false,
      },
      encoderOf(),
    );
    const frameCall2 = device.createBindGroup.mock.calls.find(
      (c) => c[0]?.label === 'test-overlay-frame-bg',
    );
    expect(frameCall2).toBeTruthy();
  });
});

// A minimal encoder object for beginRenderPass. RenderGraph calls
// device.createBindGroup (asserted via the device mock), so the encoder itself
// only needs a render-pass stub.
function encoderOf(): GPUCommandEncoder {
  const renderPass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    draw: () => {},
    end: () => {},
  };
  return {
    beginRenderPass: () => renderPass as unknown as GPURenderPassEncoder,
    copyTextureToTexture: () => {},
  } as unknown as GPUCommandEncoder;
}

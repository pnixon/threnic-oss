/**
 * BackgroundBlurPass.test.ts — contract tests for the universal background blur.
 *
 * These are mock-device tests (WebGPU can't run in jsdom). They lock in the
 * command-recording contract that makes the blur universal:
 *   - blur > 0 → render source into scratch, then copy scratch back into target
 *   - blur <= 0 → no GPU work (no-op)
 *   - uniform buffer receives blur (f32) + blurType (u32) in the documented layout
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundBlurPass } from './BackgroundBlurPass';

// ---------------------------------------------------------------------------
// Minimal WebGPU device mock — records the calls we assert on.
// ---------------------------------------------------------------------------
function makeMockDevice() {
  const writeBuffer = vi.fn();
  const createBindGroup = vi.fn(() => ({ __bindGroup: true }));

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
    createBindGroupLayout: vi.fn(() => ({ __bgl: true })),
    createPipelineLayout: vi.fn(() => ({ __pl: true })),
    createShaderModule: vi.fn(() => ({ __shader: true })),
    createRenderPipeline: vi.fn(() => ({ __pipeline: true })),
    createTexture: vi.fn(() => ({
      __texture: true,
      createView: vi.fn(() => ({ __view: true })),
      destroy: vi.fn(),
    })),
    createBindGroup,
    queue: { writeBuffer },
  };

  // GPUTextureUsage / GPUShaderStage globals used at module + call time
  (globalThis as Record<string, unknown>).GPUTextureUsage = {
    RENDER_ATTACHMENT: 0x10,
    TEXTURE_BINDING: 0x04,
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    UNIFORM: 0x40,
  };
  (globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  (globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08 };

  return { device, encoder, renderPass, writeBuffer, createBindGroup };
}

describe('BackgroundBlurPass', () => {
  let mock: ReturnType<typeof makeMockDevice>;
  let pass: BackgroundBlurPass;
  const target = { __target: true } as unknown as GPUTexture;
  const targetView = { __targetView: true } as unknown as GPUTextureView;

  beforeEach(() => {
    mock = makeMockDevice();
    pass = new BackgroundBlurPass(mock.device as unknown as GPUDevice, 'rgba8unorm');
  });

  it('is a no-op when blur <= 0 (never touches the encoder)', () => {
    pass.execute(
      target,
      targetView,
      mock.encoder as unknown as GPUCommandEncoder,
      1920,
      1080,
      0,
      1,
    );
    expect(mock.encoder.beginRenderPass).not.toHaveBeenCalled();
    expect(mock.encoder.copyTextureToTexture).not.toHaveBeenCalled();
  });

  it('is a no-op for zero-size targets', () => {
    pass.execute(target, targetView, mock.encoder as unknown as GPUCommandEncoder, 0, 0, 20, 1);
    expect(mock.encoder.beginRenderPass).not.toHaveBeenCalled();
  });

  it('blurs source → scratch, then copies scratch → target (ping-pong, no read-write hazard)', () => {
    pass.execute(
      target,
      targetView,
      mock.encoder as unknown as GPUCommandEncoder,
      1920,
      1080,
      20,
      1,
    );

    // One render pass that draws the fullscreen triangle into scratch
    expect(mock.encoder.beginRenderPass).toHaveBeenCalledTimes(1);
    expect(mock.renderPass.draw).toHaveBeenCalledWith(3);
    expect(mock.renderPass.end).toHaveBeenCalledTimes(1);

    // The blur source is the target view (sampling the composited background)
    const bgEntries = mock.createBindGroup.mock.calls[0][0].entries;
    expect(bgEntries[0].resource).toBe(targetView);

    // Then copy the blurred scratch back into the target so downstream reads it
    expect(mock.encoder.copyTextureToTexture).toHaveBeenCalledTimes(1);
    const [src, dst, size] = mock.encoder.copyTextureToTexture.mock.calls[0];
    expect(dst.texture).toBe(target);
    expect(src.texture).not.toBe(target); // scratch, not the target itself
    expect(size).toEqual([1920, 1080, 1]);
  });

  it('writes blur amount (f32) and blurType (u32) into the uniform buffer', () => {
    pass.execute(
      target,
      targetView,
      mock.encoder as unknown as GPUCommandEncoder,
      100,
      100,
      12.5,
      3,
    );

    // Last writeBuffer call is the per-frame uniform write (16-byte ArrayBuffer)
    const lastCall = mock.writeBuffer.mock.calls.at(-1)!;
    const buf: ArrayBuffer = lastCall[2];
    expect(buf.byteLength).toBe(16);
    expect(new Float32Array(buf, 0, 1)[0]).toBeCloseTo(12.5);
    expect(new Uint32Array(buf, 4, 1)[0]).toBe(3); // directional-H
  });

  it('reuses the scratch texture across same-size frames (only recreates on resize)', () => {
    pass.execute(target, targetView, mock.encoder as unknown as GPUCommandEncoder, 640, 480, 10, 0);
    const texturesAfterFirst = mock.device.createTexture.mock.calls.length;

    // Same size again → no new scratch texture
    pass.execute(target, targetView, mock.encoder as unknown as GPUCommandEncoder, 640, 480, 10, 0);
    expect(mock.device.createTexture.mock.calls.length).toBe(texturesAfterFirst);

    // Different size → scratch recreated
    pass.execute(target, targetView, mock.encoder as unknown as GPUCommandEncoder, 800, 600, 10, 0);
    expect(mock.device.createTexture.mock.calls.length).toBe(texturesAfterFirst + 1);
  });
});

// ---------------------------------------------------------------------------
// Renderer routing contract — the double-blur-avoidance rule.
// The renderers neutralise the per-image blur when the universal pass runs.
// This mirrors WebGPURenderer._universalBlurWillRun / OffscreenGPURenderer.
// ---------------------------------------------------------------------------
describe('universal blur routing rule', () => {
  // Pure re-implementation of the guard used in both renderers, kept in lockstep.
  function universalBlurWillRun(blur: number, renderGraphReady: boolean): boolean {
    return blur > 0 && renderGraphReady;
  }
  function perImageBlurUniform(blur: number, renderGraphReady: boolean): number {
    return universalBlurWillRun(blur, renderGraphReady) ? 0 : blur;
  }

  it('runs the universal pass when blur > 0 and the render graph is available', () => {
    expect(universalBlurWillRun(20, true)).toBe(true);
  });

  it('does NOT run when blur is 0', () => {
    expect(universalBlurWillRun(0, true)).toBe(false);
  });

  it('falls back to per-image blur when the render graph is unavailable', () => {
    // No intermediate target → universal pass cannot run; keep per-image blur.
    expect(universalBlurWillRun(20, false)).toBe(false);
    expect(perImageBlurUniform(20, false)).toBe(20);
  });

  it('neutralises the per-image blur uniform when the universal pass owns blur (no double-blur)', () => {
    expect(perImageBlurUniform(20, true)).toBe(0);
  });
});

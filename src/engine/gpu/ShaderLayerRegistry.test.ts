/**
 * ShaderLayerRegistry.test.ts — lifecycle contract for the per-instance shader
 * pass registry shared by the preview + export renderers (Stage 2).
 *
 * Mock-device tests (WebGPU can't run in jsdom). They lock in:
 *   - sync() creates exactly one entry per instance id, reuses on re-sync.
 *   - prune() tears down entries whose id is no longer live.
 *   - destroy() releases every entry.
 *   - ids() reflects the live set.
 *   - a fresh registry has nothing renderable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShaderLayerRegistry } from './ShaderLayerRegistry';
import type { ShaderOverlayConfig } from './ShaderOverlayPass';

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
  const device = {
    createSampler: vi.fn(() => ({ __sampler: true })),
    createBuffer: vi.fn(() => ({ __buffer: true, destroy: vi.fn() })),
    createBindGroupLayout: vi.fn((d: GPUBindGroupLayoutDescriptor) => ({
      __bgl: true,
      entries: d.entries,
    })),
    createPipelineLayout: vi.fn(() => ({ __pl: true })),
    createShaderModule: vi.fn(() => ({
      __shader: true,
      getCompilationInfo: async () => ({ messages: [] }),
    })),
    createRenderPipelineAsync: vi.fn(async () => ({ __pipeline: true })),
    createBindGroup: vi.fn(() => ({ __bindGroup: true })),
    queue: { writeBuffer: vi.fn() },
  };
  return device as unknown as GPUDevice;
}

function cfg(): ShaderOverlayConfig {
  // A minimal enabled config. presetId '' resolves to no preset (getPresetById
  // returns undefined), so no async pipeline build is attempted — keeping the
  // lifecycle test deterministic without a real preset registry.
  return {
    enabled: true,
    presetId: '',
    paletteId: '',
    opacity: 1,
    blendMode: 'alpha',
    p0: 0,
    p1: 0,
  } as unknown as ShaderOverlayConfig;
}

describe('ShaderLayerRegistry — lifecycle', () => {
  beforeEach(() => installGPUGlobals());

  it('a fresh registry has nothing renderable and no ids', () => {
    const reg = new ShaderLayerRegistry(makeMockDevice(), 'rgba8unorm');
    expect(reg.hasRenderable()).toBe(false);
    expect(reg.ids()).toEqual([]);
  });

  it('sync creates one entry per id and reuses on re-sync', () => {
    const reg = new ShaderLayerRegistry(makeMockDevice(), 'rgba8unorm');
    reg.sync('a', cfg());
    reg.sync('b', cfg());
    expect(reg.ids().sort()).toEqual(['a', 'b']);
    // Re-syncing an existing id must not create a second entry.
    reg.sync('a', cfg());
    expect(reg.ids().sort()).toEqual(['a', 'b']);
  });

  it('prune tears down entries whose id is not in the live set', () => {
    const reg = new ShaderLayerRegistry(makeMockDevice(), 'rgba8unorm');
    reg.sync('a', cfg());
    reg.sync('b', cfg());
    reg.sync('c', cfg());
    reg.prune(new Set(['b']));
    expect(reg.ids()).toEqual(['b']);
  });

  it('prune with an empty set removes everything but keeps the registry usable', () => {
    const reg = new ShaderLayerRegistry(makeMockDevice(), 'rgba8unorm');
    reg.sync('a', cfg());
    reg.prune(new Set());
    expect(reg.ids()).toEqual([]);
    // Still usable afterwards.
    reg.sync('d', cfg());
    expect(reg.ids()).toEqual(['d']);
  });

  it('destroy releases every entry', () => {
    const reg = new ShaderLayerRegistry(makeMockDevice(), 'rgba8unorm');
    reg.sync('a', cfg());
    reg.sync('b', cfg());
    reg.destroy();
    expect(reg.ids()).toEqual([]);
    expect(reg.hasRenderable()).toBe(false);
  });

  it('an entry with an unresolvable preset is not renderable', () => {
    const reg = new ShaderLayerRegistry(makeMockDevice(), 'rgba8unorm');
    reg.sync('a', cfg());
    // No preset compiled → currentPreset stays null → not renderable.
    expect(reg.isRenderable('a')).toBe(false);
    expect(reg.hasRenderable()).toBe(false);
  });
});

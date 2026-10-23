import { describe, it, expect, vi } from 'vitest';
import { ShaderInjector, MAX_WGSL_SOURCE_BYTES } from './ShaderInjector';

describe('ShaderInjector — source size cap (§5/3b safety)', () => {
  it('rejects an oversized source WITHOUT touching the device', async () => {
    const createShaderModule = vi.fn();
    const device = { createShaderModule } as unknown as GPUDevice;
    // validate-only injector (no RenderGraph needed for validate()).
    const injector = new ShaderInjector(device, null);

    const oversized = 'x'.repeat(MAX_WGSL_SOURCE_BYTES + 1);
    const result = await injector.validate(oversized);

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/too large/i);
    // The cap is a pre-compile guard: the device is never asked to compile it.
    expect(createShaderModule).not.toHaveBeenCalled();
  });

  it('lets a source at the limit through to compilation', async () => {
    const createShaderModule = vi.fn(() => ({
      getCompilationInfo: async () => ({ messages: [] }),
    }));
    const device = { createShaderModule } as unknown as GPUDevice;
    const injector = new ShaderInjector(device, null);

    const atLimit = 'x'.repeat(MAX_WGSL_SOURCE_BYTES);
    await injector.validate(atLimit);
    // At (not over) the limit, it proceeds to compile.
    expect(createShaderModule).toHaveBeenCalledTimes(1);
  });
});

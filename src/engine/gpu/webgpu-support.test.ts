/**
 * webgpu-support.test.ts — verifies the deep WebGPU support probe.
 *
 * The probe must go beyond "an adapter exists": it creates a throwaway device
 * and submits one trivial pipeline so a partial WebGPU stack (adapter present
 * but device/pipeline broken — the classic old-Linux/Mesa case) reports
 * UNSUPPORTED, letting the app engage its Canvas2D/WebGL fallback instead of
 * mounting the WebGPU canvas and rendering black.
 *
 * WebGPU can't run in jsdom, so navigator.gpu + the device are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkWebGPUSupport,
  resetWebGPUSupportCache,
  getWebGPUDiagnostics,
  isCompatibilityModeForced,
  setCompatibilityModeForced,
} from './webgpu-support';

/**
 * In-memory localStorage stub. The compatibility-mode preference persists via
 * localStorage; jsdom provides one, but we install a clean stub per test so
 * the persisted-flag assertions are deterministic and isolated.
 */
function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  return store;
}

function installGPUUsageGlobals() {
  (globalThis as Record<string, unknown>).GPUTextureUsage = {
    RENDER_ATTACHMENT: 0x10,
    TEXTURE_BINDING: 0x04,
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    UNIFORM: 0x40,
  };
}

interface MockDeviceOpts {
  /** Value the validation error scope resolves to (null = clean). */
  validationError?: unknown;
  /** When true, device.lost resolves (device is dead). */
  lost?: boolean;
  /** When true, createRenderPipeline throws (driver/pipeline failure). */
  pipelineThrows?: boolean;
}

function makeMockDevice(opts: MockDeviceOpts = {}) {
  const destroy = vi.fn();
  const device = {
    lost: opts.lost ? Promise.resolve({ message: 'device lost' }) : new Promise(() => {}),
    createShaderModule: vi.fn(() => ({ __shader: true })),
    createRenderPipeline: vi.fn(() => {
      if (opts.pipelineThrows) throw new Error('pipeline creation failed');
      return { __pipeline: true };
    }),
    createTexture: vi.fn(() => ({
      createView: vi.fn(() => ({ __view: true })),
      destroy: vi.fn(),
    })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({
        setPipeline: vi.fn(),
        draw: vi.fn(),
        end: vi.fn(),
      })),
      finish: vi.fn(() => ({ __cmd: true })),
    })),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => opts.validationError ?? null),
    queue: {
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(async () => undefined),
    },
    destroy,
  };
  return { device, destroy };
}

function installNavigatorGpu(adapter: unknown) {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    },
  });
}

/**
 * A healthy adapter that hands back `device` and advertises `info`. The `info`
 * is what the diagnostics readout surfaces to the user, so tests that assert
 * the hardware-info capture rely on it being present here.
 */
function makeHealthyAdapter(device: unknown, maxDim = 16384) {
  return {
    limits: { maxTextureDimension2D: maxDim },
    info: {
      description: 'Mock GPU 9000',
      vendor: 'mockvendor',
      architecture: 'mock-arch',
      backendType: 'vulkan',
    },
    requestDevice: vi.fn(async () => device),
  };
}

describe('checkWebGPUSupport (deep probe)', () => {
  beforeEach(() => {
    installGPUUsageGlobals();
    installLocalStorage(); // clean: compatibility mode OFF by default
    resetWebGPUSupportCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetWebGPUSupportCache();
  });

  it('returns false when navigator.gpu is absent', async () => {
    vi.stubGlobal('navigator', {});
    expect(await checkWebGPUSupport()).toBe(false);
  });

  it('returns false when no adapter is returned', async () => {
    installNavigatorGpu(null);
    expect(await checkWebGPUSupport()).toBe(false);
  });

  it('returns false when requestDevice throws (adapter present, device broken)', async () => {
    const adapter = {
      limits: { maxTextureDimension2D: 8192 },
      requestDevice: vi.fn(async () => {
        throw new Error('no usable device');
      }),
    };
    installNavigatorGpu(adapter);
    expect(await checkWebGPUSupport()).toBe(false);
  });

  it('returns false when the trivial pipeline submission raises a validation error', async () => {
    const { device } = makeMockDevice({ validationError: { message: 'validation failed' } });
    const adapter = {
      limits: { maxTextureDimension2D: 8192 },
      requestDevice: vi.fn(async () => device),
    };
    installNavigatorGpu(adapter);
    expect(await checkWebGPUSupport()).toBe(false);
  });

  it('returns false when the device is already lost', async () => {
    const { device } = makeMockDevice({ lost: true });
    const adapter = {
      limits: { maxTextureDimension2D: 8192 },
      requestDevice: vi.fn(async () => device),
    };
    installNavigatorGpu(adapter);
    expect(await checkWebGPUSupport()).toBe(false);
  });

  it('returns false when pipeline creation throws', async () => {
    const { device } = makeMockDevice({ pipelineThrows: true });
    const adapter = {
      limits: { maxTextureDimension2D: 8192 },
      requestDevice: vi.fn(async () => device),
    };
    installNavigatorGpu(adapter);
    expect(await checkWebGPUSupport()).toBe(false);
  });

  it('returns true when the full smoke test succeeds, and destroys the throwaway device', async () => {
    const { device, destroy } = makeMockDevice();
    const adapter = {
      limits: { maxTextureDimension2D: 16384 },
      requestDevice: vi.fn(async () => device),
    };
    installNavigatorGpu(adapter);

    expect(await checkWebGPUSupport()).toBe(true);
    // Probe requested the adapter's real max dimension, not the default.
    expect(adapter.requestDevice).toHaveBeenCalledWith({
      requiredLimits: { maxTextureDimension2D: 16384 },
    });
    // The throwaway device must be released so it never competes with the
    // real renderer's device.
    expect(destroy).toHaveBeenCalled();
  });

  it('memoizes the verdict — the adapter is probed only once across callers', async () => {
    const { device } = makeMockDevice();
    const requestAdapter = vi.fn(async () => ({
      limits: { maxTextureDimension2D: 8192 },
      requestDevice: vi.fn(async () => device),
    }));
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter, getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm') },
    });

    const [a, b, c] = await Promise.all([
      checkWebGPUSupport(),
      checkWebGPUSupport(),
      checkWebGPUSupport(),
    ]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });

  it('captures adapter info so the hardware-info readout can display it', async () => {
    // WHY: the diagnostics readout turns a silent "it didn't render" into a
    // reportable state (vendor / architecture / backend). This asserts the
    // probe records the adapter's info — regressing this makes the readout
    // blank and the next "didn't work" report undiagnosable.
    const { device } = makeMockDevice();
    installNavigatorGpu(makeHealthyAdapter(device));

    expect(await checkWebGPUSupport()).toBe(true);
    const diag = getWebGPUDiagnostics();
    expect(diag.supported).toBe(true);
    expect(diag.adapter).toEqual({
      description: 'Mock GPU 9000',
      vendor: 'mockvendor',
      architecture: 'mock-arch',
      backend: 'vulkan',
    });
    // The reason must be human-readable and non-empty for the UI line.
    expect(diag.reason).toMatch(/supported/i);
  });

  it('records a human-readable reason when the adapter is missing', async () => {
    // WHY: "no adapter" (unsupported/blocklisted GPU) and "device smoke test
    // failed" (broken driver) are DIFFERENT failures the user must be able to
    // tell apart from the readout. This locks the no-adapter reason distinct
    // from the black-canvas-driver case.
    //
    // NOTE: the diagnostics snapshot is intentionally module-global — it
    // reflects the LAST probe. A no-adapter probe reports supported=false with
    // its own reason but does not erase adapter info captured by an earlier
    // successful probe, so we assert the verdict + reason (the guaranteed
    // contract), not that `adapter` is nulled.
    resetWebGPUSupportCache();
    installNavigatorGpu(null);
    expect(await checkWebGPUSupport()).toBe(false);
    const diag = getWebGPUDiagnostics();
    expect(diag.supported).toBe(false);
    expect(diag.reason).toMatch(/no webgpu adapter/i);
  });
});

describe('compatibility mode (persisted fallback pin)', () => {
  beforeEach(() => {
    installGPUUsageGlobals();
    resetWebGPUSupportCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetWebGPUSupportCache();
  });

  it('round-trips the persisted flag through localStorage', () => {
    // WHY: the toggle is a GLOBAL per-browser preference that must survive a
    // reload — that persistence is the whole point (a user on flaky hardware
    // sets it once). This protects the read/write contract against a future
    // refactor that drops the localStorage write.
    installLocalStorage();
    expect(isCompatibilityModeForced()).toBe(false);
    setCompatibilityModeForced(true);
    expect(isCompatibilityModeForced()).toBe(true);
    setCompatibilityModeForced(false);
    expect(isCompatibilityModeForced()).toBe(false);
  });

  it('short-circuits the probe to the fallback WITHOUT touching navigator.gpu', async () => {
    // WHY: when the user forces compatibility mode the app must use the
    // fallback renderer unconditionally — it must NOT re-probe and silently
    // flip back to WebGPU on hardware where WebGPU is the very thing that was
    // failing. Asserting requestAdapter is never called proves the short-
    // circuit happens before any WebGPU work.
    installLocalStorage({ threnic_force_compatibility: '1' });
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter, getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm') },
    });

    expect(await checkWebGPUSupport()).toBe(false);
    expect(requestAdapter).not.toHaveBeenCalled();

    const diag = getWebGPUDiagnostics();
    expect(diag.supported).toBe(false);
    expect(diag.forcedCompatibility).toBe(true);
    expect(diag.reason).toMatch(/compatibility mode/i);
  });

  it('does NOT short-circuit when the flag is off (WebGPU fast path preserved)', async () => {
    // WHY: the flag defaulting off must leave the WebGPU path completely
    // intact — this guards against a regression where the persistence check
    // accidentally disables acceleration for everyone.
    installLocalStorage(); // flag OFF
    const { device } = makeMockDevice();
    installNavigatorGpu(makeHealthyAdapter(device));

    expect(await checkWebGPUSupport()).toBe(true);
    expect(getWebGPUDiagnostics().forcedCompatibility).toBe(false);
  });

  it('treats unavailable localStorage as "not forced" (SSR / incognito safe)', () => {
    // WHY: the module is imported during SSR and in incognito where
    // localStorage can throw or be absent. It must degrade to "not forced"
    // rather than throw, or the app fails to boot.
    vi.stubGlobal('localStorage', undefined);
    expect(isCompatibilityModeForced()).toBe(false);
    // setter must be a no-op, not a throw
    expect(() => setCompatibilityModeForced(true)).not.toThrow();
  });
});

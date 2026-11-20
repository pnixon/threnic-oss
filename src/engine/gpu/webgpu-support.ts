/**
 * WebGPU Support Detection & Adapter Utilities
 *
 * Three ways to render, tried in this order:
 *   1. the browser's WebGPU,
 *   2. the WebGL2 compatibility backend (./compat) — the same renderers and
 *      shaders running on WebGL2, for browsers without (working) WebGPU,
 *   3. the Canvas2D software renderer (lyrics and backgrounds only).
 * "Supported" below means 1 or 2: the full GPU renderer can run.
 */

import { getCompatGPU, getGPU, setGPUBackend } from './compat';

/** What the app is rendering with. */
export type RenderBackend = 'webgpu' | 'webgl2' | 'canvas2d';

/** Captured GPU adapter details, surfaced to the diagnostics readout. */
interface AdapterInfo {
  description: string;
  vendor: string;
  architecture: string;
  backend: string;
}

/** Snapshot of the last support probe, for the hardware-info readout. */
export interface WebGPUDiagnostics {
  /** true = GPU renderer usable, false = Canvas2D fallback, null = not probed yet. */
  supported: boolean | null;
  /** Which renderer the probe selected; null = not probed yet. */
  backend: RenderBackend | null;
  /** Why the probe landed where it did (human-readable, one line). */
  reason: string;
  /** Adapter details when an adapter was obtained, else null. */
  adapter: AdapterInfo | null;
  /** true when the user forced compatibility mode (probe skipped). */
  forcedCompatibility: boolean;
}

// Mutable snapshot updated by the probe / adapter logger.
let _lastAdapterInfo: AdapterInfo | null = null;
let _lastSupported: boolean | null = null;
let _lastBackend: RenderBackend | null = null;
let _lastReason = 'Hardware not yet detected.';

/** Read the latest diagnostics captured by the support probe. */
export function getWebGPUDiagnostics(): WebGPUDiagnostics {
  return {
    supported: _lastSupported,
    backend: _lastBackend,
    reason: _lastReason,
    adapter: _lastAdapterInfo,
    forcedCompatibility: isCompatibilityModeForced(),
  };
}

// ── Persisted "compatibility mode" (force the non-WebGPU fallback) ──────
const COMPAT_MODE_KEY = 'threnic_force_compatibility';

/** Whether the user has pinned the app to the WebGL2 compatibility backend. */
export function isCompatibilityModeForced(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(COMPAT_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the compatibility-mode preference (survives reloads). */
export function setCompatibilityModeForced(forced: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (forced) localStorage.setItem(COMPAT_MODE_KEY, '1');
    else localStorage.removeItem(COMPAT_MODE_KEY);
  } catch {
    /* incognito / disabled storage */
  }
}

interface RawAdapterInfo {
  description?: string;
  device?: string;
  vendor?: string;
  architecture?: string;
  backendType?: string;
}

interface AdapterInfoSource {
  info?: RawAdapterInfo;
  requestAdapterInfo?: () => Promise<RawAdapterInfo>;
}

/**
 * Extract adapter info in the standard (GPUAdapter.info) or deprecated
 * (requestAdapterInfo) shape. Returns null when neither is available.
 */
function readAdapterInfo(adapter: GPUAdapter): AdapterInfo | null {
  try {
    const info = (adapter as unknown as AdapterInfoSource).info;
    if (info) {
      return {
        description: info.description || info.device || 'unknown',
        vendor: info.vendor || '?',
        architecture: info.architecture || '?',
        backend: info.backendType || '?',
      };
    }
  } catch {
    /* info not available */
  }
  return null;
}

/**
 * Log detailed adapter info for performance diagnostics, and capture it into
 * the diagnostics snapshot so the UI readout can show it.
 */
function logAdapterInfo(label: string, adapter: GPUAdapter): void {
  const info = readAdapterInfo(adapter);
  if (info) {
    _lastAdapterInfo = info;
    console.log(
      `[${label}] GPU Adapter: ${info.description}` +
        ` | vendor: ${info.vendor}` +
        ` | architecture: ${info.architecture}` +
        ` | backend: ${info.backend}`,
    );
    return;
  }

  // Fallback: try deprecated requestAdapterInfo()
  try {
    const infoFn = (adapter as unknown as AdapterInfoSource).requestAdapterInfo;
    if (typeof infoFn === 'function') {
      infoFn.call(adapter).then((async) => {
        _lastAdapterInfo = {
          description: async.description || async.device || 'unknown',
          vendor: async.vendor || '?',
          architecture: async.architecture || '?',
          backend: async.backendType || '?',
        };
        console.log(
          `[${label}] GPU Adapter (async): ${_lastAdapterInfo.description}` +
            ` | vendor: ${_lastAdapterInfo.vendor}`,
        );
      });
      return;
    }
  } catch {
    // not available
  }

  console.log(`[${label}] GPU Adapter info unavailable.`);
}

/**
 * Request a WebGPU adapter, preferring discrete/high-performance GPU.
 *
 * Strategy:
 *   1. Try with powerPreference: 'high-performance' (all platforms)
 *   2. If that fails, retry with no preference
 *
 * Previously we skipped the high-performance hint on Windows because
 * some older Chrome versions had issues. Modern Chrome (120+) handles
 * this correctly and the hint is critical for selecting the discrete
 * GPU over integrated graphics.
 */
export async function requestHighPerformanceAdapter(
  label: string,
  gpu: GPU | null = getGPU(),
): Promise<GPUAdapter | null> {
  if (!gpu) return null;

  // Always try high-performance first
  let adapter = await gpu.requestAdapter({
    powerPreference: 'high-performance',
  });

  if (!adapter) {
    console.warn(`[${label}] High-performance adapter not found, retrying with default...`);
    adapter = await gpu.requestAdapter();
  }

  if (adapter) {
    logAdapterInfo(label, adapter);
  }

  return adapter;
}

/**
 * Minimal WGSL used by the deep support probe: a single fullscreen triangle
 * that writes a constant colour. This exercises the exact code path that a
 * broken/partial WebGPU stack (notably old Mesa on Linux) fails on even when
 * an adapter is advertised — shader compilation, pipeline creation, and a
 * command submission — without depending on any of the real renderer's shaders.
 */
const PROBE_WGSL = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
`;

/**
 * Cached verdict from {@link checkWebGPUSupport}. The probe is a one-time,
 * cheap-on-capable-hardware smoke test, and several callers (AppContent,
 * Header, DecoupledExporter) ask independently — so memoize the promise and
 * hand every caller the same in-flight/settled result. `null` = not yet run.
 */
let _supportProbe: Promise<boolean> | null = null;

/**
 * The device the probe proved working, kept for the first renderer that asks.
 *
 * Browsers cap how many WebGPU devices a page may hold, and a destroyed device
 * keeps counting until it is garbage collected. Firefox's cap is low enough
 * that probe + preview + export devices together lost the export device with
 * "Out of memory". Handing the probe's device on means one device fewer.
 */
let _probeDevice: GPUDevice | null = null;

/**
 * Take ownership of the probe's device, if it is still waiting and alive. It
 * was requested with the adapter's maximum `maxTextureDimension2D`, the same
 * descriptor the stage renderer uses. Returns null once taken; the caller owns
 * (and eventually destroys) the device it gets.
 */
export function takeProbeDevice(): GPUDevice | null {
  const device = _probeDevice;
  _probeDevice = null;
  return device;
}

/**
 * Smoke-test one `GPU` implementation: create a device, compile a trivial
 * shader, build a pipeline and submit one draw. Never throws. On success the
 * proven device is returned for the first renderer to reuse.
 */
async function smokeTest(
  gpu: GPU,
  label: string,
): Promise<{ ok: true; device: GPUDevice } | { ok: false; reason: string }> {
  let device: GPUDevice | null = null;
  try {
    const adapter = await requestHighPerformanceAdapter(label, gpu);
    if (!adapter) {
      return { ok: false, reason: 'no adapter — the GPU/driver is unsupported or blocklisted' };
    }

    // Mirror WebGPURenderer.init(): request the adapter's real max texture
    // dimension. If requestDevice itself fails (common on old Linux/Mesa where
    // an adapter is advertised but no usable device can be created), we fall
    // through to the catch and report unsupported.
    const maxDim = adapter.limits?.maxTextureDimension2D ?? 8192;
    device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: maxDim },
    });

    // A device that is already lost is not usable. Race the lost promise so a
    // stack that hands back a dead device does not pass the probe.
    let deviceLost = false;
    device.lost.then(() => {
      deviceLost = true;
    });

    // Compile a trivial shader, build a render pipeline, and submit one draw
    // into a 1×1 offscreen target. This is the smallest end-to-end exercise of
    // the pipeline that a partial implementation can still fail on.
    device.pushErrorScope('validation');
    const shaderModule = device.createShaderModule({ code: PROBE_WGSL });
    const format = gpu.getPreferredCanvasFormat();
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shaderModule, entryPoint: 'vs' },
      fragment: { module: shaderModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    const target = device.createTexture({
      size: [1, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    // Surface a GPUValidationError raised by anything above (some drivers only
    // report the failure asynchronously via the error scope).
    const validationError = await device.popErrorScope();
    // Give any synchronous device-lost a microtask to land.
    await device.queue.onSubmittedWorkDone().catch(() => {
      deviceLost = true;
    });

    target.destroy();

    if (validationError || deviceLost) {
      return {
        ok: false,
        reason: deviceLost
          ? 'the GPU device was lost during the smoke test'
          : 'the render smoke test failed validation',
      };
    }
    const proven = device;
    device = null;
    return { ok: true, device: proven };
  } catch (err) {
    return {
      ok: false,
      reason: `initialization threw during the smoke test${
        err instanceof Error ? `: ${err.message}` : ''
      }`,
    };
  } finally {
    // A failed probe owns its throwaway device; release it so it never
    // competes with the real renderer's device.
    try {
      device?.destroy();
    } catch {
      /* already gone */
    }
  }
}

/** Keep a proven device for the first renderer (see takeProbeDevice). */
function keepProbeDevice(device: GPUDevice): void {
  _probeDevice = device;
  device.lost.then(() => {
    if (_probeDevice === device) _probeDevice = null;
  });
}

/**
 * Pick the renderer: WebGPU, else the WebGL2 compatibility backend, else
 * (returning false) the Canvas2D software renderer. Never throws.
 */
async function probeWebGPUDevice(): Promise<boolean> {
  const forced = isCompatibilityModeForced();
  const nativeGPU = typeof navigator !== 'undefined' ? (navigator.gpu ?? null) : null;

  let whyNotNative: string;
  if (forced) {
    whyNotNative = 'Compatibility mode is ON.';
  } else if (!nativeGPU) {
    whyNotNative = 'WebGPU is not available in this browser.';
  } else {
    setGPUBackend('webgpu');
    const native = await smokeTest(nativeGPU, 'WebGPU-Support-Check');
    if (native.ok) {
      _lastSupported = true;
      _lastBackend = 'webgpu';
      _lastReason = 'WebGPU is fully supported and hardware-accelerated rendering is active.';
      keepProbeDevice(native.device);
      return true;
    }
    whyNotNative = `WebGPU is present but unusable (${native.reason}).`;
    console.warn(`[WebGPU-Support-Check] ${whyNotNative} Trying the WebGL2 backend.`);
  }

  // Same renderers, same shaders, on WebGL2.
  setGPUBackend('webgl2');
  const compat = await smokeTest(getCompatGPU(), 'WebGL2-Compat-Check');
  if (compat.ok) {
    _lastSupported = true;
    _lastBackend = 'webgl2';
    _lastReason = `${whyNotNative} Rendering with the WebGL2 compatibility backend; all effects are available.`;
    keepProbeDevice(compat.device);
    return true;
  }

  setGPUBackend('webgpu');
  _lastSupported = false;
  _lastBackend = 'canvas2d';
  _lastReason = `${whyNotNative} The WebGL2 backend is unavailable too (${compat.reason}), so the basic Canvas2D renderer is in use: lyrics and backgrounds only.`;
  console.warn(`[WebGPU-Support-Check] ${_lastReason}`);
  return false;
}

/**
 * Check whether this browser + driver + GPU can actually run the WebGPU
 * renderer — not merely whether an adapter is advertised.
 *
 * Older probes returned `true` as soon as `requestAdapter()` yielded a
 * non-null adapter. On weak Linux/Mesa stacks an adapter is often advertised
 * while `requestDevice()` or the first real pipeline dies, so the app mounted
 * the WebGPU canvas and rendered black. This deep probe creates a throwaway
 * device and submits one trivial pipeline, catching that partial-support case
 * so the existing Canvas2D/WebGL fallback engages instead.
 *
 * The result is memoized: capable hardware passes in ~1ms once, and the WebGPU
 * fast path is completely unaffected.
 */
export function checkWebGPUSupport(): Promise<boolean> {
  if (_supportProbe === null) {
    _supportProbe = probeWebGPUDevice();
  }
  return _supportProbe;
}

/**
 * Reset the cached support verdict. Intended for tests and for a manual
 * "re-detect hardware" action; production code should not need it.
 */
export function resetWebGPUSupportCache(): void {
  _supportProbe = null;
  // A probe device nobody took would otherwise sit there counting against the
  // device limit while the next probe makes another.
  try {
    takeProbeDevice()?.destroy();
  } catch {
    /* already gone */
  }
}

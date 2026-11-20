/**
 * Entry point of the WebGL2 compatibility backend: a `GPU` object, adapter
 * and canvas context that stand in for the browser's WebGPU ones.
 *
 * Renderers never touch `navigator.gpu` or `canvas.getContext('webgpu')`
 * directly; they go through {@link getGPU} and {@link getGPUCanvasContext},
 * which hand out either the native objects or these, depending on which
 * backend the support probe selected (see webgpu-support.ts).
 */

import { GLCanvasContext, GLDevice } from './GLDevice';
import { loadWgslTranslator } from './wgslTranslator';

export type GPUBackend = 'webgpu' | 'webgl2';

let backend: GPUBackend = 'webgpu';

/** Which implementation {@link getGPU} currently returns. */
export function getGPUBackend(): GPUBackend {
  return backend;
}

/** Whether a device came from the compatibility backend. */
export function isCompatDevice(device: unknown): boolean {
  return !!device && (device as { isCompatDevice?: boolean }).isCompatDevice === true;
}

/**
 * WebGPU's flag namespaces are globals that only exist where WebGPU does.
 * Renderer code reads them (`GPUTextureUsage.RENDER_ATTACHMENT`, …) whichever
 * backend is active, so define the missing ones with the spec's values.
 */
export function installGPUConstants(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const define = (name: string, value: Record<string, number>) => {
    if (typeof g[name] === 'undefined') g[name] = Object.freeze(value);
  };
  define('GPUTextureUsage', {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  });
  define('GPUBufferUsage', {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  });
  define('GPUMapMode', { READ: 0x0001, WRITE: 0x0002 });
  define('GPUShaderStage', { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 });
  define('GPUColorWrite', { RED: 0x1, GREEN: 0x2, BLUE: 0x4, ALPHA: 0x8, ALL: 0xf });
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  // The drawing buffer is only ever read back by a 2D canvas right after it
  // is drawn; keeping it avoids depending on when the browser clears it.
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
};

function createGLCanvas(): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  return c;
}

function createGL(): {
  gl: WebGL2RenderingContext;
  canvas: OffscreenCanvas | HTMLCanvasElement;
} | null {
  try {
    const canvas = createGLCanvas();
    const gl = (canvas as HTMLCanvasElement).getContext(
      'webgl2',
      CONTEXT_ATTRIBUTES,
    ) as WebGL2RenderingContext | null;
    if (!gl || gl.isContextLost()) return null;
    return { gl, canvas };
  } catch {
    return null;
  }
}

interface CompatAdapterFacts {
  maxTextureSize: number;
  renderer: string;
  vendor: string;
}
let adapterFacts: CompatAdapterFacts | null | undefined;

/** Limits and names from a throwaway context, read once. */
function readAdapterFacts(): CompatAdapterFacts | null {
  if (adapterFacts !== undefined) return adapterFacts;
  const made = createGL();
  if (!made) {
    adapterFacts = null;
    return null;
  }
  const { gl } = made;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  adapterFacts = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    renderer: String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
    ),
    vendor: String(
      (dbg && gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || '',
    ),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return adapterFacts;
}

class GLAdapter {
  readonly features: ReadonlySet<string> = new Set<string>();
  readonly isFallbackAdapter = false;
  readonly limits: Record<string, number>;
  readonly info: GPUAdapterInfo;

  constructor(facts: CompatAdapterFacts) {
    this.limits = { maxTextureDimension2D: facts.maxTextureSize, maxBindGroups: 4 };
    this.info = {
      vendor: facts.vendor,
      architecture: 'webgl2',
      device: '',
      description: `${facts.renderer} (WebGL2 compatibility)`,
    } as unknown as GPUAdapterInfo;
  }

  requestDevice(): Promise<GPUDevice> {
    const made = createGL();
    if (!made) {
      return Promise.reject(new Error('Could not create a WebGL2 context for the device.'));
    }
    return Promise.resolve(new GLDevice(made.gl, made.canvas, this.info) as unknown as GPUDevice);
  }
}

class GLGPU {
  readonly wgslLanguageFeatures: ReadonlySet<string> = new Set<string>();

  async requestAdapter(): Promise<GPUAdapter | null> {
    const facts = readAdapterFacts();
    if (!facts) return null;
    try {
      await loadWgslTranslator();
    } catch (e) {
      console.warn('[compat] WGSL translator failed to load:', e);
      return null;
    }
    return new GLAdapter(facts) as unknown as GPUAdapter;
  }

  getPreferredCanvasFormat(): GPUTextureFormat {
    return 'rgba8unorm';
  }
}

let compatGPU: GLGPU | null = null;

/** The compatibility backend's `GPU` object (does not select it). */
export function getCompatGPU(): GPU {
  installGPUConstants();
  if (!compatGPU) compatGPU = new GLGPU();
  return compatGPU as unknown as GPU;
}

/** Choose which backend {@link getGPU} and {@link getGPUCanvasContext} use. */
export function setGPUBackend(next: GPUBackend): void {
  backend = next;
  if (next === 'webgl2') installGPUConstants();
}

/** The active `GPU` object: the browser's, or the compatibility backend's. */
export function getGPU(): GPU | null {
  if (backend === 'webgl2') return getCompatGPU();
  if (typeof navigator === 'undefined') return null;
  return navigator.gpu ?? null;
}

const contexts = new WeakMap<object, GLCanvasContext>();

/** `canvas.getContext('webgpu')` for the active backend. */
export function getGPUCanvasContext(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): GPUCanvasContext | null {
  if (backend === 'webgl2') {
    let ctx = contexts.get(canvas);
    if (!ctx) {
      ctx = new GLCanvasContext(canvas);
      contexts.set(canvas, ctx);
    }
    return ctx as unknown as GPUCanvasContext;
  }
  return (canvas as HTMLCanvasElement).getContext('webgpu') as GPUCanvasContext | null;
}

/**
 * Expose the backend on `window.__threnicGPU` so browser tests (and a curious
 * user in the console) can drive the compatibility backend directly, e.g. to
 * render the same scene on both backends and compare.
 */
export function exposeGPUDebugHook(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__threnicGPU = {
    getCompatGPU,
    getGPU,
    getGPUBackend,
    installGPUConstants,
  };
}

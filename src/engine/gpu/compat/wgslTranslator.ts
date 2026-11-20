/**
 * WGSL → GLSL ES 3.00 translation for the WebGL2 compatibility backend.
 *
 * WHY: every effect and visualizer in Threnic is written in WGSL for WebGPU.
 * Browsers without WebGPU (Firefox on Linux and Android, older Safari) still
 * have WebGL2, so the compatibility backend runs the same shaders after
 * translating them with naga — the translator Firefox and wgpu use — compiled
 * to WebAssembly (source in tools/wgsl-compat, binary in public/compat).
 *
 * The module is loaded once, on demand, and only when the compatibility
 * backend is in use; native WebGPU never pays for it.
 */

export interface TranslatedUniform {
  group: number;
  binding: number;
  /** GLSL uniform block name. */
  name: string;
}

export interface TranslatedTexture {
  /** GLSL combined sampler uniform name. */
  name: string;
  group: number;
  binding: number;
  /** The WGSL sampler paired with the texture; null for textureLoad-only use. */
  samplerGroup: number | null;
  samplerBinding: number | null;
}

export interface TranslatedStage {
  glsl: string;
  uniforms: TranslatedUniform[];
  textures: TranslatedTexture[];
  /** The vertex shader reads `naga_vs_first_instance`. */
  firstInstance: boolean;
}

export interface TranslateRequest {
  code: string;
  /** Vertex entry point to emit, if any. */
  vertex?: string;
  /** Fragment entry point to emit, if any. */
  fragment?: string;
  constants?: Record<string, number>;
}

export type TranslateResult =
  | { ok: true; vertex?: TranslatedStage; fragment?: TranslatedStage }
  | {
      ok: false;
      stage: 'request' | 'parse' | 'validate' | 'vertex' | 'fragment' | 'internal';
      message: string;
      line?: number;
      column?: number;
    };

interface WasmExports {
  memory: WebAssembly.Memory;
  wc_alloc(len: number): number;
  wc_free(ptr: number, len: number): void;
  wc_translate(ptr: number, len: number): number;
}

/** Where the browser fetches the translator from (served from /public). */
const WASM_URL = '/compat/wgsl-compat.wasm';

let wasmBytes: BufferSource | null = null;
let wasmModule: WebAssembly.Module | null = null;
let exports: WasmExports | null = null;
let loading: Promise<void> | null = null;

/** Provide the translator binary directly (tests, or a custom host). */
export function setWgslTranslatorBinary(bytes: BufferSource): void {
  wasmBytes = bytes;
  wasmModule = null;
  exports = null;
  loading = null;
}

function instantiate(): void {
  if (!wasmModule) throw new Error('WGSL translator is not loaded');
  exports = new WebAssembly.Instance(wasmModule, {}).exports as unknown as WasmExports;
}

/** Load the translator. Resolves once `translateWgsl` can be called. */
export function loadWgslTranslator(): Promise<void> {
  if (exports) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      if (!wasmBytes) {
        const res = await fetch(WASM_URL);
        if (!res.ok) throw new Error(`WGSL translator fetch failed (${res.status})`);
        wasmBytes = await res.arrayBuffer();
      }
      wasmModule = await WebAssembly.compile(wasmBytes);
      instantiate();
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

export function isWgslTranslatorLoaded(): boolean {
  return exports !== null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Translate (or, with no entry points, just validate) a WGSL module. */
export function translateWgsl(request: TranslateRequest): TranslateResult {
  if (!exports) throw new Error('WGSL translator is not loaded');
  const ex = exports;
  try {
    const input = encoder.encode(JSON.stringify(request));
    const inPtr = ex.wc_alloc(input.length);
    new Uint8Array(ex.memory.buffer, inPtr, input.length).set(input);
    const outPtr = ex.wc_translate(inPtr, input.length);
    ex.wc_free(inPtr, input.length);
    const len = new DataView(ex.memory.buffer).getUint32(outPtr, true);
    const json = decoder.decode(new Uint8Array(ex.memory.buffer, outPtr + 4, len));
    ex.wc_free(outPtr, len + 4);
    return JSON.parse(json) as TranslateResult;
  } catch (e) {
    // The translator aborts (a wasm trap) on input it cannot handle. The
    // instance's memory may be mid-operation, so start a fresh one.
    try {
      instantiate();
    } catch {
      exports = null;
    }
    return {
      ok: false,
      stage: 'internal',
      message: `shader translator failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

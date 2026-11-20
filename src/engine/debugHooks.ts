/**
 * Hooks for browser tests, on `window.__threnicTest`.
 *
 * The GPU rendering tests (src/test/gpu) turn every effect and visualizer on
 * one at a time on each renderer. The stores are already on `window`; this
 * adds what a test cannot reach from them: the factories that build a default
 * effect instance, the preset lists, and which renderer is active.
 *
 * It only exposes existing read-only data and pure factories, so it is safe to
 * install in production — which is what lets the same tests run against the
 * deployed site.
 */

import { GLSL_PRESETS } from '@/engine/gpu/glsl/glslPresets';
import { VISUALIZER_PRESETS } from '@/engine/gpu/milkdrop/presets';
import { SHADER_PRESETS } from '@/engine/gpu/shaderPresets';
import { getWebGPUDiagnostics } from '@/engine/gpu/webgpu-support';
import { WGSL_CUSTOM_ID, WGSL_PRESETS } from '@/engine/gpu/wgslPresets';
import { createDefaultInstance } from '@/types/effects/effect-instance-factory';
import {
  EFFECT_LABELS,
  POST_PROCESSING_EFFECT_TYPES,
  SCENE_EFFECT_TYPES,
} from '@/types/effects/effect-instances';
import { createLyricFXInstance, LYRIC_FX_LABELS } from '@/types/effects/lyric-fx';

export function exposeTestHooks(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__threnicTest = {
    createDefaultInstance,
    createLyricFXInstance,
    getDiagnostics: getWebGPUDiagnostics,
    effectTypes: [...SCENE_EFFECT_TYPES, ...POST_PROCESSING_EFFECT_TYPES],
    effectLabels: EFFECT_LABELS,
    lyricFXTypes: Object.keys(LYRIC_FX_LABELS),
    shaderPresetIds: SHADER_PRESETS.map((p) => p.id),
    milkdropPresetIds: VISUALIZER_PRESETS.map((p) => p.id),
    // The config a Custom Shader instance gets when the preset is picked in
    // the editor (same mapping as CustomShaderEditor.applyPreset).
    wgslPresets: WGSL_PRESETS.filter((p) => p.id !== WGSL_CUSTOM_ID).map((p) => ({
      id: p.id,
      source: p.source,
      params: p.parameters
        .filter((q) => !q.builtIn && typeof q.defaultValue === 'number')
        .map((q) => ({
          name: q.name,
          value: q.defaultValue as number,
          min: q.min ?? 0,
          max: q.max ?? 1,
        })),
      uniformLayout: p.parameters.map((q) => ({ name: q.name, builtIn: q.builtIn })),
    })),
    /** Butterchurn preset names (loads the preset package on first call). */
    getButterchurnPresetNames: async (): Promise<string[]> => {
      const mod = await import('butterchurn-presets');
      return Object.keys(mod.default.getPresets()).sort();
    },
    glslPresets: GLSL_PRESETS.filter((p) => p.source).map((p) => ({ id: p.id, source: p.source })),
  };
}

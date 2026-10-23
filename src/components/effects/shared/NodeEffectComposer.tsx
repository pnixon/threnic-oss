/**
 * NodeEffectComposer — WebGPU-compatible post-processing compositor
 *
 * Replaces @react-three/postprocessing's EffectComposer which is WebGL-only.
 * Uses Three.js native PostProcessing class with TSL (Three Shading Language)
 * nodes for all screen-space effects.
 *
 * Architecture:
 * 1. Renders the scene via pass(scene, camera) → scenePass
 * 2. Collects active effect nodes from children via React context
 * 3. Chains effects as TSL operations on the scene color
 * 4. Outputs the final composited result
 *
 * Effect functions receive:
 * - color: the current accumulated color node (vec4)
 * - uniforms: the effect's own uniform map
 * - sceneTexture: the original scene pass texture (for UV re-sampling effects)
 */

'use client';

import React, { createContext, useContext, useRef, useCallback, useEffect, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { PostProcessing } from 'three/webgpu';
import type { Node, Renderer, TextureNode } from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';

// === Types ===

/**
 * A TSL effect function.
 * @param color - current accumulated color (vec4 node)
 * @param uniforms - the effect's uniform map
 * @param sceneTexture - the original scene pass texture node (for UV re-sampling)
 */
type TSLUniform = Node & { value: unknown };

type TSLUniforms = Record<string, TSLUniform>;

export type TSLEffectFn = (color: Node, uniforms: TSLUniforms, sceneTexture: TextureNode) => Node;

interface RegisteredEffect {
  id: string;
  priority: number; // Lower = runs first
  fn: TSLEffectFn;
  uniforms: TSLUniforms;
  enabled: boolean;
}

interface ComposerContextType {
  registerEffect: (
    id: string,
    priority: number,
    fn: TSLEffectFn,
    uniforms: TSLUniforms,
    enabled: boolean,
  ) => void;
  unregisterEffect: (id: string) => void;
  updateUniforms: (id: string, uniforms: Record<string, unknown>) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  requestRebuild: () => void;
}

const ComposerContext = createContext<ComposerContextType | null>(null);

/**
 * Hook for child effects to register themselves with the compositor.
 * Re-registers (and triggers a rebuild) whenever `fn` changes,
 * allowing closures that capture dynamic state (e.g. a loaded texture).
 */
export function useNodeEffect(
  id: string,
  priority: number,
  fn: TSLEffectFn,
  uniforms: TSLUniforms,
  enabled: boolean,
): void {
  const ctx = useContext(ComposerContext);

  // Register on mount only. fn, uniforms, and priority are all stable
  // module-level / useMemo references — no re-registration needed.
  useEffect(() => {
    if (!ctx) return;
    ctx.registerEffect(id, priority, fn, uniforms, enabled);
    return () => ctx.unregisterEffect(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ctx]);

  // Update enabled state
  useEffect(() => {
    if (!ctx) return;
    ctx.setEnabled(id, enabled);
  }, [id, enabled, ctx]);
}

// === Composer Component ===

interface NodeEffectComposerProps {
  children: React.ReactNode;
}

export function NodeEffectComposer({ children }: NodeEffectComposerProps): React.ReactElement {
  const { gl, scene, camera } = useThree();
  const postProcessingRef = useRef<PostProcessing | null>(null);
  const effectsRef = useRef<Map<string, RegisteredEffect>>(new Map());
  const needsRebuild = useRef(true);
  const [version, setVersion] = useState(0);
  // Track consecutive render failures to avoid rebuild loops
  const renderFailCount = useRef(0);
  const MAX_RENDER_FAILS = 3;

  // Build the PostProcessing pipeline
  const buildPipeline = useCallback(() => {
    if (!gl || !scene || !camera) return;

    try {
      // Dispose any existing PostProcessing instance first
      if (postProcessingRef.current) {
        postProcessingRef.current.dispose();
        postProcessingRef.current = null;
      }

      // Get sorted active effects
      const activeEffects = Array.from(effectsRef.current.values())
        .filter((e) => e.enabled)
        .sort((a, b) => a.priority - b.priority);

      needsRebuild.current = false;
      renderFailCount.current = 0; // reset on rebuild

      const isLegacyWebGL = !(gl as unknown as { backend?: unknown }).backend;

      // If no active effects or if on legacy WebGL, don't create a PostProcessing pipeline at all.
      // This avoids the depth buffer size mismatch and lets the default
      // renderer handle scene rendering correctly.
      if (activeEffects.length === 0 || isLegacyWebGL) {
        if (isLegacyWebGL) {
          console.warn(
            '[NodeEffectComposer] Legacy WebGL rendering active. TSL PostProcessing is disabled.',
          );
        }
        return;
      }

      // Create scene pass
      const scenePass = pass(scene, camera);

      // Scene texture — the original rendered scene for UV re-sampling
      const sceneTexture = scenePass.getTextureNode();

      // Start with scene color
      let color: Node = sceneTexture;

      // Apply each effect in order
      for (const effect of activeEffects) {
        try {
          color = effect.fn(color, effect.uniforms, sceneTexture);
        } catch (e) {
          console.warn(`[NodeEffectComposer] Effect "${effect.id}" failed:`, e);
        }
      }

      const postProcessing = new PostProcessing(gl as unknown as Renderer);
      postProcessing.outputNode = renderOutput(color);
      postProcessingRef.current = postProcessing;
    } catch (e) {
      console.error('[NodeEffectComposer] Pipeline build failed:', e);
    }
  }, [gl, scene, camera]);

  // Context methods
  const registerEffect = useCallback(
    (id: string, priority: number, fn: TSLEffectFn, uniforms: TSLUniforms, enabled: boolean) => {
      effectsRef.current.set(id, { id, priority, fn, uniforms, enabled });
      needsRebuild.current = true;
    },
    [],
  );

  const unregisterEffect = useCallback((id: string) => {
    effectsRef.current.delete(id);
    needsRebuild.current = true;
  }, []);

  const updateUniforms = useCallback((id: string, uniforms: Record<string, unknown>) => {
    const effect = effectsRef.current.get(id);
    if (effect) {
      // Update TSL uniform values directly (no pipeline rebuild needed)
      for (const [key, value] of Object.entries(uniforms)) {
        if (effect.uniforms[key] && effect.uniforms[key].value !== undefined) {
          effect.uniforms[key].value = value;
        }
      }
    }
  }, []);

  const setEnabled = useCallback((id: string, enabled: boolean) => {
    const effect = effectsRef.current.get(id);
    if (effect && effect.enabled !== enabled) {
      effect.enabled = enabled;
      needsRebuild.current = true;
    }
  }, []);

  const requestRebuild = useCallback(() => {
    needsRebuild.current = true;
  }, []);

  const ctxValue = React.useMemo(
    () => ({
      registerEffect,
      unregisterEffect,
      updateUniforms,
      setEnabled,
      requestRebuild,
    }),
    [registerEffect, unregisterEffect, updateUniforms, setEnabled, requestRebuild],
  );

  // Rebuild pipeline when needed (debounced to avoid thrashing)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (needsRebuild.current) {
        buildPipeline();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [version, buildPipeline]);

  // Render with PostProcessing (only when we have an active pipeline)
  useFrame(() => {
    if (needsRebuild.current) {
      buildPipeline();
      setVersion((v) => v + 1);
    }

    if (postProcessingRef.current) {
      try {
        postProcessingRef.current.render();
        renderFailCount.current = 0; // reset on success
      } catch (e) {
        renderFailCount.current++;
        console.warn(
          `[NodeEffectComposer] Render failed (${renderFailCount.current}/${MAX_RENDER_FAILS}):`,
          e,
        );
        // Dispose the broken pipeline so it stops dirtying the WebGL framebuffer.
        // Schedule a rebuild only if we haven't hit the failure cap
        // (prevents thrashing if an effect is fundamentally broken).
        postProcessingRef.current.dispose();
        postProcessingRef.current = null;
        if (renderFailCount.current < MAX_RENDER_FAILS) {
          needsRebuild.current = true;
        } else {
          console.error(
            '[NodeEffectComposer] Too many render failures — disabling pipeline. Fix the broken effect and reload.',
          );
        }
      }
    } else {
      // Manual render because we claimed the render loop (priority 1)
      const asyncGl = gl as unknown as Partial<Pick<Renderer, 'renderAsync'>>;
      if (asyncGl.renderAsync) {
        asyncGl.renderAsync(scene, camera);
      } else {
        gl.render(scene, camera);
      }
    }
  }, 1); // Priority 1 = run after default renders

  // Cleanup
  useEffect(() => {
    return () => {
      if (postProcessingRef.current) {
        postProcessingRef.current.dispose();
        postProcessingRef.current = null;
      }
    };
  }, []);

  return <ComposerContext.Provider value={ctxValue}>{children}</ComposerContext.Provider>;
}

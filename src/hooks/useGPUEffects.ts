/**
 * useGPUEffects — React hook that bridges effect instances to the WebGPU RenderGraph.
 *
 * This is a thin wrapper around the shared EffectsManager class.
 * All pass definitions, state merging, and registration logic live in
 * EffectsManager to ensure parity between preview and export pipelines.
 *
 * Architecture:
 *   ┌────────────────────┐
 *   │  Keyframe System   │──→ computedConfig (interpolated EffectsConfig)
 *   └────────────────────┘
 *            │
 *            ▼
 *   ┌────────────────────┐
 *   │  useGPUEffects      │──→ reads effectInstances[] from computedConfig
 *   │  (this hook)        │      • delegates to EffectsManager
 *   └────────────────────┘
 *            │
 *            ▼
 *   ┌────────────────────┐
 *   │  EffectsManager    │──→ registers/syncs passes on RenderGraph
 *   └────────────────────┘
 *            │
 *            ▼
 *   ┌────────────────────┐
 *   │  RenderGraph        │──→ executes WGSL passes
 *   └────────────────────┘
 */

import { useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import type { GPUCanvasRef } from '@/components/stage/GPUCanvas';
import type { EffectsConfig } from '@/types/effects';
import { EffectsManager } from '@/engine/gpu/EffectsManager';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { EngineLoop } from '@/engine/EngineLoop';
import { toast } from '@/utils/toast';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGPUEffects(
  centerStageRef: React.RefObject<GPUCanvasRef | null>,
  effectsConfig: EffectsConfig | undefined,
) {
  // Persistent manager instance
  const managerRef = useRef<EffectsManager | null>(null);
  // Ref to latest effectsConfig so frame callback can read it without stale closure
  const configRef = useRef(effectsConfig);
  // Wall-clock of the previous preview sync, for the customShader frame-watchdog.
  const lastSyncMsRef = useRef(0);

  useLayoutEffect(() => {
    configRef.current = effectsConfig;
  }, [effectsConfig]);

  // Track the active WebGPU RenderGraph to detect canvas switches
  const activeGraphRef = useRef<unknown>(null);

  // ── Get or create EffectsManager ──────────────────────────────────────
  const getManager = useCallback((): EffectsManager | null => {
    const renderer = centerStageRef.current?.getRenderer();
    // No GPU device = the Canvas2D software preview (no RenderGraph; its
    // getRenderGraph() is the async export-contract stub). Nothing to drive.
    if (!renderer || !renderer.getDevice()) return null;
    const renderGraph = renderer.getRenderGraph();
    if (!renderGraph) return null;

    if (managerRef.current && activeGraphRef.current !== renderGraph) {
      managerRef.current.dispose();
      managerRef.current = null;
    }

    if (!managerRef.current) {
      managerRef.current = new EffectsManager(renderGraph);
      activeGraphRef.current = renderGraph;
    }
    // Thread the GPU device in so per-instance customShader passes can compile.
    // Idempotent; null on a software renderer (customShader then no-ops).
    managerRef.current.setDevice(renderer.getDevice());
    return managerRef.current;
  }, [centerStageRef]);

  // ── Per-frame sync — fast, no allocations on steady state ─────────────
  const syncFrame = useCallback(() => {
    const manager = getManager();
    if (!manager) return;

    // Resolve the current effects config (keyframe-interpolated or base)
    const computed = keyframeStore.getState().effects.computedConfig;
    const base = configRef.current;
    const resolved = computed ?? base;

    manager.syncFrame(resolved);

    // ── customShader frame-watchdog (PREVIEW ONLY) ──────────────────────
    // Feed the inter-frame wall-clock delta so a freshly-compiled custom shader
    // that wedges the GPU gets auto-disabled instead of freezing the tab. Export
    // never runs this path (offline timing is meaningless). Skip the first frame
    // (no prior timestamp) and any absurd delta from a backgrounded tab.
    const nowMs = performance.now();
    const last = lastSyncMsRef.current;
    lastSyncMsRef.current = nowMs;
    if (last > 0) {
      const dtMs = nowMs - last;
      if (dtMs < 5000) manager.feedFrameTime(dtMs);
      const events = manager.consumeWatchdogEvents();
      for (const e of events) toast.warning(e.reason, 8000);
    }

    // Keep the secondary-image overlay texture (bgImageOverlay effect) bound on
    // the live renderer. Cheap on the steady state — only decodes on change.
    centerStageRef.current?.getRenderer()?.syncOverlayImage(resolved);
  }, [getManager, centerStageRef]);

  // ── Register per-frame callback ──────────────────────────────────────
  useEffect(() => {
    return EngineLoop.register(syncFrame, 50);
  }, [syncFrame]);

  // ── Also sync on React-level config changes ──────────────────────────
  useEffect(() => {
    syncFrame();
  }, [effectsConfig, syncFrame]);

  // ── Cleanup on unmount ───────────────────────────────────────────────
  useEffect(() => {
    return () => {
      managerRef.current?.dispose();
      managerRef.current = null;
    };
  }, []);
}

'use client';

/**
 * GPUCanvas — React wrapper for the native WebGPU renderer.
 *
 * Replaces CenterStage/RenderEngine. Renders a plain <canvas> element
 * and drives the WebGPURenderer via requestAnimationFrame, reading from
 * the global keyframeState each frame for zero-React-render updates.
 */

import React, { useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { WebGPURenderer, type FrameState } from '@/engine/gpu/WebGPURenderer';
import { Canvas2DPreviewRenderer } from '@/engine/gpu/Canvas2DPreviewRenderer';
import { SlideshowManager } from '@/engine/gpu/SlideshowManager';
import { timeStore } from '@/engine/stores/timeStore';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { EngineLoop } from '@/engine/EngineLoop';
import {
  BackgroundTransformManager,
  BackgroundTransformState,
} from '@/engine/gpu/BackgroundTransformManager';
import { audioStore } from '@/engine/stores/audioStore';
import { exportStore } from '@/engine/stores/exportStore';
import { trackStore } from '@/engine/stores/trackStore';
import { projectStore } from '@/stores/projectStore';
import { systemStore } from '@/stores/systemStore';
import { resolveBackgroundBlur, resolveBackgroundOpacity } from '@/utils/resolveBgEffects';
import { type ShaderOverlayConfig } from '@/engine/gpu/ShaderOverlayPass';
import { type GLSLGuestSource, type GuestChannel } from '@/engine/gpu/glsl/types';
import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';
import { resolveRenderPlan } from '@/engine/gpu/resolveRenderPlan';
import { profiler } from '@/utils/profiler';
import { resolveInstancePassId } from '@/engine/gpu/EffectsManager';
import { syncVideoElement } from './gpu/syncVideoElement';
import { resolveNLEClips } from './gpu/resolveNLEClips';
import { computePreviewRenderSize } from './gpu/previewSize';
import { computeVisuals, type ConcreteTransition } from '@/engine/slideshow/core';

// How often the render loop re-checks the on-screen stage size. The stage is
// shrunk with a CSS transform, so zoom / fullscreen / viewport changes alter
// the displayed size without any ResizeObserver firing on the canvas.
const PREVIEW_SIZE_POLL_MS = 250;

// Map blur type string → shader integer
const BLUR_TYPE_MAP: Record<string, number> = {
  box: 0,
  gaussian: 1,
  radial: 2,
  directional: 3,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GPUCanvasProps {
  /** Callback for when WebGPU initialization fails */
  onInitializationError?: (error: Error) => void;
}

export interface GPUCanvasRef {
  /** Get the underlying WebGPURenderer */
  getRenderer: () => WebGPURenderer | null;
}

type StageRenderer = WebGPURenderer & {
  __lastGlslAssetKey?: string;
  __lastParamsJson?: string;
  __lastLyricsLen?: number;
};

type ShaderFxInstance = Extract<EffectInstance, { type: 'shaderFx' }>;
type ButterchurnInstance = Extract<EffectInstance, { type: 'butterchurn' }>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a CSS hex color string to RGB 0-1 array */
function hexToRgb(hex: string | null | undefined): [number, number, number] {
  if (!hex || hex.length < 4) return [0, 0, 0];
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const full =
    clean.length === 3 ? clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2] : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) / 255, ((num >> 8) & 0xff) / 255, (num & 0xff) / 255];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const GPUCanvas = React.memo(
  forwardRef<GPUCanvasRef, GPUCanvasProps>(function GPUCanvas({ onInitializationError }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<WebGPURenderer | null>(null);
    const rafRef = useRef<number>(0);
    const previewFrameRef = useRef<number>(0);
    const lastBgUrlRef = useRef<string | null>(null);
    const defaultBgUrlRef = useRef<string | null>(null);
    const isExportingRef = useRef(false);
    // Time sync refs (replaces the TimeController from RenderEngine)
    const lastAudioTimeRef = useRef<number>(0);
    const driftRef = useRef<number>(0);
    const lastTickTimeRef = useRef<number>(0);

    const slideshowManagerRef = useRef<SlideshowManager>(new SlideshowManager());
    const effectsConfigRef = useRef(trackStore.getState().effectsConfig);
    const trackIdRef = useRef(trackStore.getState().trackId);

    // Subscribe to trackStore imperatively (no useState = no React re-renders)
    useEffect(() => {
      const unsub = trackStore.subscribe((state) => {
        // Update background URL ref
        defaultBgUrlRef.current = state.backgroundImageUrl;

        // Update export flag ref
        isExportingRef.current = state.isExporting;

        // Update effectsConfig ref
        effectsConfigRef.current = state.effectsConfig;

        // Detect track switches — reset caches
        if (state.trackId !== trackIdRef.current) {
          trackIdRef.current = state.trackId;
          if (rendererRef.current?.textureLoader) {
            rendererRef.current.textureLoader.destroy();
            rendererRef.current.clearBackgroundTexture();
            lastBgUrlRef.current = null;
          }
          slideshowManagerRef.current.reset();
          if (typeof bgTransformManagerRef.current.reset === 'function') {
            bgTransformManagerRef.current.reset();
          }
        }
      });

      // Seed initial values
      const s = trackStore.getState();
      defaultBgUrlRef.current = s.backgroundImageUrl;
      isExportingRef.current = s.isExporting;
      effectsConfigRef.current = s.effectsConfig;
      trackIdRef.current = s.trackId;

      return unsub;
    }, []);

    // Expose ref
    useImperativeHandle(
      ref,
      () => ({
        getRenderer: () => rendererRef.current,
      }),
      [],
    );

    const bgTransformManagerRef = useRef<BackgroundTransformManager>(
      new BackgroundTransformManager(),
    );

    // ─── Build FrameState from keyframeState ────────────────────
    // `fxConfig` is the keyframe-RESOLVED effects config (from keyframeStore),
    // falling back to the raw track config when the resolver has produced nothing
    // yet. Callers must pass the resolved config so keyframed effect-based
    // background props (blur, opacity, tiling, brightness) actually apply.
    const buildFrameState = useCallback(
      (dt: number, isPaused: boolean, fxConfig: EffectsConfig | null): FrameState => {
        const scene = keyframeStore.getState().scene;
        const effCfg = fxConfig ?? effectsConfigRef.current;

        const bgState: BackgroundTransformState = {
          scale: scene.backgroundScale ?? 1.0,
          offsetX: scene.backgroundOffsetX ?? 0,
          offsetY: scene.backgroundOffsetY ?? 0,
          angle: scene.backgroundAngle ?? 0,
          slideActive: false,
        };

        bgTransformManagerRef.current.update(effCfg ?? undefined, dt, bgState, isPaused);

        const audioState = audioStore.getState();
        const audio = {
          bass: audioState.bass,
          mid: audioState.mid,
          high: audioState.high,
          energy: audioState.energy,
        };
        const blurResult = resolveBackgroundBlur(effCfg, audio, scene.backgroundBlur);
        const resolvedOpacity = resolveBackgroundOpacity(effCfg, audio, scene.backgroundOpacity);

        return {
          time: timeStore.getState().currentTime,
          duration: timeStore.getState().duration,
          backgroundColor: hexToRgb(scene.backgroundColor),
          backgroundBrightness: scene.backgroundBrightness ?? effCfg?.backgroundBrightness ?? 1.0,
          backgroundScale: bgState.scale,
          backgroundOffsetX: bgState.offsetX,
          backgroundOffsetY: bgState.offsetY,
          backgroundAngle: bgState.angle,
          backgroundTiling:
            bgState.slideActive || (scene.backgroundTiling ?? effCfg?.backgroundTiling ?? false),
          backgroundFit: scene.backgroundFit ?? effCfg?.backgroundFit ?? 'cover',
          backgroundContrast: scene.backgroundContrast ?? effCfg?.backgroundContrast ?? 1.0,
          backgroundBlur: blurResult.amount,
          backgroundBlurType: BLUR_TYPE_MAP[blurResult.blurType] ?? 1,
          backgroundOpacity: resolvedOpacity,
          // Audio data — live from audioState (updated every frame by AudioManager)
          audioBass: audioState.bass,
          audioMid: audioState.mid,
          audioHigh: audioState.high,
          audioEnergy: audioState.energy,
          // Direct analyser access for Butterchurn-style raw FFT (milkdrop chain)
          audioAnalyser: audioState.analyser,
        };
      },
      [],
    );

    // ─── Resolve the effective background URL ───────────────────
    // Not entirely needed for background since that goes via SlideshowManager now
    const resolveBackgroundUrl = useCallback((): string | null => {
      const scene = keyframeStore.getState().scene;

      // In export mode, check the export schedule
      if (timeStore.getState().mode === 'export') {
        if (scene.assetUrl) return scene.assetUrl;
        // Fall back to export schedule default
        const schedule = exportStore.getState().backgroundSchedule;
        if (schedule.length > 0) {
          const t = timeStore.getState().currentTime;
          let url = exportStore.getState().defaultBackgroundUrl;
          for (const entry of schedule) {
            if (t >= entry.startTime) url = entry.url;
          }
          return url;
        }
        return exportStore.getState().defaultBackgroundUrl;
      }

      // Preview mode: keyframe override → default prop
      return scene.assetUrl || defaultBgUrlRef.current;
    }, []);

    // ─── Init renderer + animation loop ─────────────────────────
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      let renderer = new WebGPURenderer(canvas) as StageRenderer;
      rendererRef.current = renderer;

      let destroyed = false;
      // Device-loss recovery: one re-init attempt per mount, then demote.
      let recovering = false;
      let recoveryAttempted = false;

      // ── Preview sizing ──
      // Size the backing store to what's actually on screen (the CSS-scaled
      // box) × min(DPR, 2), capped at the project resolution (the canvas's
      // unscaled layout size). Export renders offscreen at full size.
      let lastSizeKey = '';
      let resizeCleanup: (() => void) | null = null;
      let lastSizeCheck = 0;
      const syncPreviewSize = () => {
        const rect = canvas.getBoundingClientRect();
        const size = computePreviewRenderSize({
          displayWidth: rect.width,
          displayHeight: rect.height,
          layoutWidth: canvas.clientWidth,
          layoutHeight: canvas.clientHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        if (!size) return;
        const key = `${size.width}x${size.height}`;
        if (key === lastSizeKey) return;
        lastSizeKey = key;
        renderer.resize(size.width, size.height);
      };

      const attachDeviceLostHandler = (r: StageRenderer) => {
        if (r instanceof WebGPURenderer) {
          r.onDeviceLost = () => {
            void recoverFromDeviceLoss();
          };
        }
      };

      // WebGPU device lost (driver reset, GPU process crash, memory pressure on
      // mobile): re-create the renderer once; if that fails (or it's lost again)
      // demote to the fallback stage via onInitializationError (AppContent toasts).
      const recoverFromDeviceLoss = async () => {
        if (destroyed || recovering) return;
        recovering = true;
        const lost = renderer;
        // Detach first so the lyric/effects bridges stop touching the dead device.
        rendererRef.current = null;
        lost.destroy();

        let next: StageRenderer | null = null;
        if (!recoveryAttempted) {
          recoveryAttempted = true;
          console.warn('[GPUCanvas] WebGPU device lost — re-initialising renderer...');
          const candidate = new WebGPURenderer(canvas) as StageRenderer;
          const ok = await candidate.init().catch(() => false);
          if (ok) next = candidate;
          else candidate.destroy();
        }

        if (destroyed) {
          next?.destroy();
          return;
        }
        if (!next) {
          systemStore.getState().setStagePipeline('fallback');
          onInitializationError?.(new Error('WebGPU device lost and could not be recovered'));
          return; // stay `recovering` — the loop idles until AppContent swaps the stage
        }

        renderer = next;
        rendererRef.current = next;
        attachDeviceLostHandler(next);
        lastSizeKey = '';
        syncPreviewSize();
        // Per-renderer caches live on the old instance; force a background reload.
        lastBgUrlRef.current = null;
        recovering = false;
      };

      (async () => {
        // NOTE: WebGPURenderer.init() may be synchronous or async but returns boolean
        let ok = await renderer.init();

        // Stage 2 fallback: If native WebGPU failed, use software fallback.
        // Canvas2DPreviewRenderer stubs every WebGPU-only method the loop calls.
        if (!ok && !destroyed) {
          console.warn(
            '[GPUCanvas] Native WebGPU failed, falling back to Canvas2D software renderer...',
          );
          renderer.destroy();
          renderer = new Canvas2DPreviewRenderer(canvas) as unknown as StageRenderer;
          rendererRef.current = renderer;
          ok = await renderer.init();
          if (ok) systemStore.getState().setStagePipeline('fallback');
        } else if (ok) {
          systemStore.getState().setStagePipeline('webgpu');
          attachDeviceLostHandler(renderer);
        }

        if (destroyed) return;

        if (!ok) {
          onInitializationError?.(new Error('WebGPURenderer (all backends) failed'));
          return;
        }

        // Layout changes (stage remount, aspect change) → resize immediately.
        // Scale-only changes are caught by the poll in tick() and window resize.
        const observer = new ResizeObserver(() => syncPreviewSize());
        observer.observe(canvas);
        window.addEventListener('resize', syncPreviewSize);
        syncPreviewSize();

        // Animation loop
        const tick = () => {
          if (destroyed) return;

          // Skip rendering when export is in progress (offscreen renderer handles
          // it) or while the renderer is being re-created after a device loss.
          if (isExportingRef.current || recovering) {
            rafRef.current = requestAnimationFrame(tick);
            return;
          }

          {
            const nowMs = performance.now();
            if (nowMs - lastSizeCheck >= PREVIEW_SIZE_POLL_MS) {
              lastSizeCheck = nowMs;
              syncPreviewSize();
            }
          }

          profiler.frameStart('preview', previewFrameRef.current++);

          // ── Time sync (replaces TimeController from RenderEngine) ──
          const now = performance.now();
          const delta =
            lastTickTimeRef.current > 0
              ? Math.min((now - lastTickTimeRef.current) / 1000, 0.1) // Cap at 100ms to avoid jumps
              : 0;
          lastTickTimeRef.current = now;

          if (timeStore.getState().mode === 'preview') {
            // Handle external seeks
            if (timeStore.getState().lastSeekTime !== -1) {
              timeStore.getState().setCurrentTime(timeStore.getState().lastSeekTime);
              timeStore.setState({ lastSeekTime: -1 });
              driftRef.current = 0;
              // Ensure audio time follows immediately
              lastAudioTimeRef.current = timeStore.getState().currentTime;

              // Reset slideshow logic to sync with audio
              slideshowManagerRef.current.reset();
            }

            if (timeStore.getState().isPlaying) {
              const sourceEl = audioStore.getState().sourceElement;
              if (sourceEl) {
                const audioTime = sourceEl.currentTime;

                // Simple smoothing in React land (or snap if difference is large)
                if (Math.abs(audioTime - lastAudioTimeRef.current) > 0.3) {
                  timeStore.getState().setCurrentTime(audioTime);
                  driftRef.current = 0;
                } else {
                  // Actually, let the GPURenderer handle the fine-grained smoothing.
                  // We just feed it the exact audio time here so it has a high fidelity signal.
                  timeStore.getState().setCurrentTime(audioTime);
                }
                lastAudioTimeRef.current = audioTime;
              } else {
                // No audio element, just pure delta time
                timeStore.getState().setCurrentTime(timeStore.getState().currentTime + delta);
              }
            }
          }

          // Run all registered frame updates (keyframe ticks, audio sync, etc.)
          EngineLoop.run(delta, timeStore.getState().currentTime);

          // Build and render frame
          const scene = keyframeStore.getState().scene;

          // Read the primary video's playback state for video-end transitions
          const primaryVideoEl = renderer.getPrimaryVideoElement();
          const videoSignals = primaryVideoEl
            ? {
                videoDuration: primaryVideoEl.duration,
                videoEnded: primaryVideoEl.ended,
                videoCurrentTime: primaryVideoEl.currentTime,
              }
            : undefined;

          const smState = slideshowManagerRef.current.updateAndGetState(
            delta,
            scene as Record<string, unknown>,
            defaultBgUrlRef.current,
            effectsConfigRef.current,
            videoSignals,
          );

          // ── NLE Timeline background clips override ──
          const clips = trackStore.getState().videoClips || [];
          const currentTime = timeStore.getState().currentTime;
          const resolved = resolveNLEClips(clips, currentTime, smState, scene.assetUrl);

          // Pass the resolved URL and type to WebGPURenderer
          renderer.setBackgroundImage(
            resolved.url,
            resolved.nextUrl,
            resolved.mixRatio,
            resolved.type as 'image' | 'video',
            resolved.nextType as 'image' | 'video',
          );

          // Push per-slot visual state for slide/zoom transitions
          if (smState.currentVisuals && smState.nextVisuals) {
            renderer.setBgTransitionState({
              opacity1: smState.currentVisuals.opacity,
              scale1: smState.currentVisuals.scale,
              offsetX1: smState.currentVisuals.offsetX,
              offsetY1: smState.currentVisuals.offsetY,
              opacity2: smState.nextVisuals.opacity,
              scale2: smState.nextVisuals.scale,
              offsetX2: smState.nextVisuals.offsetX,
              offsetY2: smState.nextVisuals.offsetY,
              blendMode: 1, // Additive for transitions
            });
          } else if (resolved.inTransition && resolved.mixRatio > 0) {
            // NLE clip-to-clip transition — compute visuals from clip transition type
            const clipTransType = resolved.activeClip?.transition?.type ?? 'crossfade';
            let coreType: ConcreteTransition = 'crossfade';
            if (clipTransType === 'fade-black' || clipTransType === 'bloom-flash')
              coreType = 'fadeBlack';
            else if (clipTransType === 'wipe-left') coreType = 'slideLeft';
            else if (clipTransType === 'wipe-right') coreType = 'slideRight';
            else if (clipTransType === 'zoom-in' || clipTransType === 'zoom-out') coreType = 'zoom';
            else if (clipTransType === 'cut') coreType = 'cut';
            else if (clipTransType === 'crossfade') coreType = 'crossfade';

            const visuals = computeVisuals(coreType, resolved.transitionProgress);
            renderer.setBgTransitionState({
              opacity1: visuals.current.opacity,
              scale1: visuals.current.scale,
              offsetX1: visuals.current.offsetX,
              offsetY1: visuals.current.offsetY,
              opacity2: visuals.next.opacity,
              scale2: visuals.next.scale,
              offsetX2: visuals.next.offsetX,
              offsetY2: visuals.next.offsetY,
              blendMode: 1, // Crossfade blend
            });
          } else if (resolved.mixRatio <= 0) {
            // No transition — reset to default single-slot display
            renderer.setBgTransitionState({
              opacity1: 1.0,
              scale1: 1.0,
              offsetX1: 0,
              offsetY1: 0,
              opacity2: 0.0,
              scale2: 1.0,
              offsetX2: 0,
              offsetY2: 0,
              blendMode: 0,
            });
          }

          // ── Video clips playback synchronization ──
          const isPlaying = timeStore.getState().isPlaying;
          const secondaryVideoEl = renderer.getSecondaryVideoElement();
          const { activeClip, inTransition, prevClip } = resolved;
          // A single-clip timeline has no successor scene, so a lone clip
          // should loop by default rather than freeze on its last frame.
          const isSoleClip = clips.length === 1;

          if (clips.length > 0) {
            if (activeClip) {
              if (inTransition && prevClip) {
                if (primaryVideoEl && resolved.type === 'video') {
                  syncVideoElement(primaryVideoEl, prevClip, currentTime, isPlaying);
                }
                if (secondaryVideoEl && resolved.nextType === 'video') {
                  syncVideoElement(secondaryVideoEl, activeClip, currentTime, isPlaying);
                }
              } else {
                if (primaryVideoEl && resolved.type === 'video') {
                  syncVideoElement(primaryVideoEl, activeClip, currentTime, isPlaying, isSoleClip);
                }
                // Pre-sync Slot 2 for upcoming clip
                if (resolved.nextUrl && secondaryVideoEl && resolved.nextType === 'video') {
                  const upcoming = clips
                    .filter((c) => c.startTime > currentTime)
                    .sort((a, b) => a.startTime - b.startTime)[0];
                  if (upcoming && upcoming.startTime - currentTime <= 2.0) {
                    syncVideoElement(secondaryVideoEl, upcoming, upcoming.startTime, false);
                  }
                }
              }
            } else {
              // Gap — pre-sync upcoming video
              if (resolved.nextUrl && secondaryVideoEl && resolved.nextType === 'video') {
                const upcoming = clips
                  .filter((c) => c.startTime > currentTime)
                  .sort((a, b) => a.startTime - b.startTime)[0];
                if (upcoming && upcoming.startTime - currentTime <= 2.0) {
                  syncVideoElement(secondaryVideoEl, upcoming, upcoming.startTime, false);
                }
              }
            }
          } else if (primaryVideoEl && resolved.type === 'video') {
            // ── Non-NLE background video sync (slideshow/keyframe mode) ──
            // The video element is created with loop=true by TextureLoader,
            // but we still need to sync play/pause with the timeline.
            if (isPlaying && primaryVideoEl.paused) {
              primaryVideoEl.play().catch(() => {});
            } else if (!isPlaying && !primaryVideoEl.paused) {
              primaryVideoEl.pause();
            }
          }

          // Build and render frame
          // Prefer the keyframe-RESOLVED effects config (interpolated per frame by
          // the resolver into keyframeStore) over the raw track config. This is what
          // makes keyframed effect + shaderFx params actually render. Falls back to
          // the raw ref before the resolver has produced a config.
          const resolvedFxConfig =
            keyframeStore.getState().effects.computedConfig ?? effectsConfigRef.current;
          const frameState = buildFrameState(
            delta,
            !timeStore.getState().isPlaying,
            resolvedFxConfig,
          );

          // Apply NLE adjustments from active background clip
          if (activeClip) {
            frameState.backgroundOpacity =
              (activeClip.opacity ?? 1.0) * (frameState.backgroundOpacity ?? 1.0);
            if (activeClip.scale !== undefined) {
              frameState.backgroundScale *= activeClip.scale;
            }
            if (activeClip.offsetX !== undefined) {
              frameState.backgroundOffsetX += activeClip.offsetX;
            }
            if (activeClip.offsetY !== undefined) {
              frameState.backgroundOffsetY += activeClip.offsetY;
            }
            if (activeClip.brightness !== undefined) {
              frameState.backgroundBrightness = activeClip.brightness;
            }
            if (activeClip.angle !== undefined) {
              frameState.backgroundAngle = activeClip.angle;
            }
            if (activeClip.contrast !== undefined) {
              frameState.backgroundContrast = activeClip.contrast;
            }
            if (activeClip.blur !== undefined) {
              frameState.backgroundBlur = activeClip.blur;
            }
            if (activeClip.fit !== undefined) {
              frameState.backgroundFit = activeClip.fit;
            }
            if (activeClip.tiling !== undefined) {
              frameState.backgroundTiling = frameState.backgroundTiling || activeClip.tiling;
            }
            if (activeClip.backgroundColor !== undefined) {
              frameState.backgroundColor = hexToRgb(activeClip.backgroundColor);
            }
          }

          // ── Shader FX: read from effect instances (unified shader + feedback chain) ──
          // Uses the keyframe-RESOLVED config so keyframed shader params (p0..p3),
          // feedback, butterchurn, and game-scene params interpolate live.
          const effectInstances = resolvedFxConfig?.effectInstances;
          const shaderFxInstance = effectInstances?.find(
            (inst): inst is ShaderFxInstance => inst.type === 'shaderFx' && !!inst.config?.enabled,
          );

          // ── N shader layers (Stage 2) ──────────────────────────────
          // Every enabled shaderFx instance in `mode: 'shader'` is composited as
          // its own layer, ordered front-to-back by its position in the resolved
          // layer order. Decoupled from the singleton mode-branch below (which
          // still wires the butterchurn/littlejs/feedback singletons). Falls back
          // to the legacy top-level shaderOverlay config when no instance exists.
          if (renderer.syncShaderLayers) {
            const orderIndex = new Map<string, number>();
            (resolvedFxConfig?.layerOrder ?? []).forEach((t, i) => {
              if (t?.kind === 'effect' && t.id) orderIndex.set(t.id, i);
            });
            const shaderLayers = (effectInstances ?? [])
              .filter(
                (inst): inst is ShaderFxInstance =>
                  inst?.type === 'shaderFx' &&
                  !!inst.config?.enabled &&
                  inst.config?.mode === 'shader' &&
                  !!inst.config?.shader,
              )
              .map((inst) => ({
                id: inst.id,
                config: inst.config.shader as ShaderOverlayConfig,
              }))
              .sort(
                (a, b) =>
                  (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                  (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
              );
            if (shaderLayers.length > 0) {
              renderer.syncShaderLayers(shaderLayers);
            } else {
              const legacyCfg = resolvedFxConfig?.shaderOverlay as ShaderOverlayConfig | undefined;
              renderer.syncShaderLayers(
                legacyCfg?.enabled ? [{ id: '__legacy_shader_overlay__', config: legacyCfg }] : [],
              );
            }
          }
          // ── GLSL guest layers (Stage 3a) ───────────────────────────
          // Every enabled shaderFx instance in `mode: 'glsl'` with a source is a
          // GLSL-compatible WebGL2 guest composited at its stack position,
          // ordered front-to-back by the resolved layer order (same as shaders).
          if (renderer.syncGLSLGuests) {
            const orderIndex = new Map<string, number>();
            (resolvedFxConfig?.layerOrder ?? []).forEach((t, i) => {
              if (t?.kind === 'effect' && t.id) orderIndex.set(t.id, i);
            });
            const glslLayers = (effectInstances ?? [])
              .filter(
                (inst): inst is ShaderFxInstance =>
                  inst?.type === 'shaderFx' &&
                  !!inst.config?.enabled &&
                  inst.config?.mode === 'glsl' &&
                  !!inst.config?.glsl?.enabled &&
                  !!inst.config?.glsl?.source,
              )
              .map((inst): GLSLGuestSource => {
                const glsl = inst.config.glsl!;
                return {
                  id: inst.id,
                  source: glsl.source,
                  composite: {
                    opacity: glsl.opacity ?? 1,
                    blendMode: glsl.blendMode ?? 'alpha',
                    preserveAlpha: false,
                  },
                  channels: glsl.channels,
                  buffers: glsl.buffers,
                  opacityReactive: glsl.audioReactive?.opacity,
                  audioRouting: glsl.audioRouting,
                };
              })
              .sort(
                (a, b) =>
                  (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                  (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
              );
            renderer.syncGLSLGuests(glslLayers);
            // Load per-channel image/cubemap textures from LOCAL IndexedDB and
            // upload them into the guest host. Only re-run when a guest's channel
            // asset binding changed (keyed by id + channel kinds + assetIds), to
            // avoid re-decoding every frame.
            if (renderer.getGLSLHost) {
              const assetKey = glslLayers
                .map((l) => {
                  const img = (chs: GuestChannel[] | undefined, tag: string) =>
                    (chs ?? [])
                      .map(
                        (c) =>
                          `${tag}${c.kind}/${c.assetId ?? ''}/${c.vflip ? 'f' : ''}/${c.videoSource ?? ''}`,
                      )
                      .join(',');
                  const bufSig = (['a', 'b', 'c', 'd'] as const)
                    .map((b) => (l.buffers?.[b] ? img(l.buffers[b]!.channels, `${b}:`) : ''))
                    .join('|');
                  return `${l.id}:${img(l.channels, '')}#${bufSig}`;
                })
                .join('|');
              if (assetKey !== renderer.__lastGlslAssetKey) {
                renderer.__lastGlslAssetKey = assetKey;
                const host = renderer.getGLSLHost();
                if (host) {
                  import('@/engine/gpu/glsl/glslGuestAssets').then(
                    ({ loadGuestImage2D, loadGuestCubemap, loadGuestAssetUrl, videoSlot }) => {
                      const loadChannels = (
                        layerId: string,
                        chs: GuestChannel[] | undefined,
                        pass?: 'a' | 'b' | 'c' | 'd',
                      ) => {
                        (chs ?? []).forEach(async (c, i) => {
                          if (c.kind === 'image2d') {
                            const bmp = await loadGuestImage2D(
                              layerId,
                              pass ? 100 + (['a', 'b', 'c', 'd'].indexOf(pass) * 4 + i) : i,
                              c.vflip,
                            );
                            if (bmp) host.setChannelImage2D(layerId, i, bmp, pass);
                            else host.clearChannel(layerId, i, pass);
                          } else if (c.kind === 'cubemap') {
                            const cubeChannel = pass
                              ? 100 + (['a', 'b', 'c', 'd'].indexOf(pass) * 4 + i)
                              : i;
                            const faces = await loadGuestCubemap(layerId, cubeChannel, c.vflip);
                            host.setChannelCubemap(layerId, i, faces, pass);
                          } else if (c.kind === 'video') {
                            if (c.videoSource === 'upload') {
                              const url = await loadGuestAssetUrl(layerId, videoSlot(i));
                              host.setChannelVideo(layerId, i, 'upload', url ?? null, pass);
                            } else {
                              host.setChannelVideo(layerId, i, 'background', null, pass);
                            }
                          } else if (c.kind !== 'buffer') {
                            host.clearChannel(layerId, i, pass);
                          }
                        });
                      };
                      for (const l of glslLayers) {
                        loadChannels(l.id, l.channels);
                        (['a', 'b', 'c', 'd'] as const).forEach((b) => {
                          if (l.buffers?.[b]) loadChannels(l.id, l.buffers[b]!.channels, b);
                        });
                      }
                    },
                  );
                }
              }
            }
          }
          // Standalone Milkdrop Visualizer effect section (independent of Shader
          // FX). When enabled it drives the milkdrop renderer in every ShaderFx
          // mode EXCEPT feedback (which aliases the same renderer). Null when the
          // section is disabled so it costs nothing.
          const standaloneMilkdrop = resolvedFxConfig?.milkdrop?.enabled
            ? resolvedFxConfig.milkdrop
            : null;
          // Butterchurn is a first-class scene effect: its config lives in a
          // 'butterchurn'-type effect instance (a row in the effects list). Read
          // it from there (keyframe-resolved), falling back to the legacy
          // singleton slot for older projects. It drives the ButterchurnRenderer
          // in every ShaderFx mode EXCEPT the ShaderFx butterchurn sub-mode (that
          // path owns it). Butterchurn needs a live AudioContext + node for
          // reactivity; applyStandaloneButterchurn wires the analyser (which
          // always has audio regardless of source type). Returns whether it
          // handled butterchurn, so branches skip their setButterchurnConfig(null).
          const butterchurnInstance = effectInstances?.find(
            (inst): inst is ButterchurnInstance =>
              inst.type === 'butterchurn' && !!inst.config?.enabled,
          );
          const standaloneButterchurn = butterchurnInstance
            ? butterchurnInstance.config
            : resolvedFxConfig?.butterchurn?.enabled
              ? resolvedFxConfig.butterchurn
              : null;
          const applyStandaloneButterchurn = (): boolean => {
            if (!standaloneButterchurn) return false;
            const audioCtx = audioStore.getState().audioContext;
            const audioNode = audioStore.getState().analyser ?? audioStore.getState().sourceNode;
            renderer.setButterchurnConfig(
              standaloneButterchurn,
              audioCtx ?? undefined,
              audioNode ?? undefined,
            );
            return true;
          };
          if (shaderFxInstance) {
            const fxConfig = shaderFxInstance.config;
            if (fxConfig.mode === 'shader') {
              renderer.setMilkdropConfig(standaloneMilkdrop);
              if (!applyStandaloneButterchurn()) renderer.setButterchurnConfig(null);
              renderer.setLittleJSConfig(null);
            } else if (fxConfig.mode === 'butterchurn') {
              renderer.setMilkdropConfig(standaloneMilkdrop);
              renderer.setLittleJSConfig(null);
              // Butterchurn needs async init — fire-and-forget, renders once ready
              const audioCtx = audioStore.getState().audioContext;
              // Use analyser node as audio source — it always has audio flowing
              // regardless of source type (playlist, mic, loopback, app capture).
              // sourceNode only works for playlist mode (MediaElementAudioSourceNode).
              const audioNode = audioStore.getState().analyser ?? audioStore.getState().sourceNode;
              // Provide default config if butterchurn sub-config is missing
              // (happens for instances created before butterchurn was added)
              const bcConfig = fxConfig.butterchurn ?? {
                enabled: true,
                presetName: '',
                blendMode: 'replace' as const,
                opacity: 1.0,
                cycleMode: 'off' as const,
                cycleInterval: 15,
                blendTime: 2.0,
              };
              // Force enabled when mode is butterchurn
              bcConfig.enabled = true;
              renderer.setButterchurnConfig(
                bcConfig,
                audioCtx ?? undefined,
                audioNode ?? undefined,
              );
            } else if (fxConfig.mode === 'littlejs') {
              renderer.setMilkdropConfig(standaloneMilkdrop);
              if (!applyStandaloneButterchurn()) renderer.setButterchurnConfig(null);
              // LittleJS game scene mode — async init, renders once ready
              const ljConfig = fxConfig.littlejs ?? {
                enabled: true,
                sceneId: 'rpgCombat',
              };
              ljConfig.enabled = true;
              renderer.setLittleJSConfig(ljConfig);

              // Pass scene params ONLY on config change (avoid per-frame overhead)
              const paramsJson = ljConfig.params ? JSON.stringify(ljConfig.params) : '';
              if (paramsJson !== renderer.__lastParamsJson) {
                renderer.__lastParamsJson = paramsJson;
                if (ljConfig.params) {
                  renderer.setGameSceneParams(
                    ljConfig.params as Record<string, number | string | boolean>,
                  );
                }

                // Load custom assets from IDB (only on config change)
                import('@/engine/gpu/littlejs/gameSceneAssets').then(
                  ({ loadAllGameSceneAssets }) => {
                    loadAllGameSceneAssets(ljConfig.sceneId || 'rpgCombat').then((urls) => {
                      renderer.setGameSceneAssets(urls);
                    });
                  },
                );
              }

              // Pass lyrics timing to scene — use length as change key
              const track = projectStore.getState().getSelectedTrack();
              const trackLyrics = track?.lyricsData;
              const lyricsLen = trackLyrics?.length ?? 0;
              if (lyricsLen !== (renderer.__lastLyricsLen ?? -1)) {
                renderer.__lastLyricsLen = lyricsLen;
                if (trackLyrics && lyricsLen > 0) {
                  renderer.setGameSceneLyrics(
                    trackLyrics.map((l) => ({ start: l.start, end: l.end })),
                  );
                } else {
                  renderer.setGameSceneLyrics([]);
                }
              }
            } else if (fxConfig.mode === 'glsl') {
              // GLSL guest mode owns ONLY the WebGL2 guest, already wired via
              // syncGLSLGuests() above. It must NOT drive the milkdrop feedback
              // chain — the feedback `else` below calls
              // setMilkdropConfig(fxConfig.feedback ?? null), which silently
              // re-enables the milkdrop feedback warp for a glsl instance that
              // carries a leftover `feedback` sub-config, painting swirling
              // feedback artifacts over the guest during playback (clean on
              // pause because the chain is gated on !isTimeFrozen). Treat glsl
              // like the shader/littlejs modes: milkdrop only from the
              // standalone section, no singleton butterchurn/littlejs.
              renderer.setMilkdropConfig(standaloneMilkdrop);
              if (!applyStandaloneButterchurn()) renderer.setButterchurnConfig(null);
              renderer.setLittleJSConfig(null);
            } else {
              renderer.setMilkdropConfig(fxConfig.feedback ?? null);
              if (!applyStandaloneButterchurn()) renderer.setButterchurnConfig(null);
              renderer.setLittleJSConfig(null);
            }
          } else {
            renderer.setMilkdropConfig(standaloneMilkdrop);
            if (!applyStandaloneButterchurn()) renderer.setButterchurnConfig(null);
            renderer.setLittleJSConfig(null);
          }

          // ── Layer ordering: effects below the lyrics token composite under
          // the lyrics; effects above it warp the lyrics. Derived target-driven
          // via the single shared resolveRenderPlan() (same resolver the export
          // path uses, so preview/export cannot drift). Null when no effect sits
          // above lyrics → legacy behavior (lyrics on top). The read==write hazard
          // this split could hit is guarded inside RenderGraph._runPassChain.
          {
            profiler.begin('layerPlan');
            const plan = resolveRenderPlan(
              resolvedFxConfig as EffectsConfig | undefined,
              resolveInstancePassId,
            );
            renderer.setLayerOrder(plan.split);
            profiler.end('layerPlan');
          }

          profiler.begin('renderFrame');
          renderer.renderFrame(frameState);
          profiler.end('renderFrame');

          profiler.frameEnd();

          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        // Cleanup observer on destroy (held in the closure, not on the renderer,
        // since device-loss recovery swaps the renderer instance)
        resizeCleanup = () => {
          observer.disconnect();
          window.removeEventListener('resize', syncPreviewSize);
        };
      })();

      // Listen for game scene asset uploads from the Inspector panel
      const handleAssetsChanged = () => {
        const r = rendererRef.current;
        if (!r) return;
        import('@/engine/gpu/littlejs/gameSceneAssets').then(({ loadAllGameSceneAssets }) => {
          // Determine the active sceneId from effectsConfig. Mirrors the render
          // loop: the first enabled shaderFx instance drives the renderer, and it
          // is a game scene only when its mode is 'littlejs'.
          const instances = effectsConfigRef.current?.effectInstances;
          const fxInst = instances?.find(
            (inst): inst is ShaderFxInstance => inst?.type === 'shaderFx' && !!inst.config?.enabled,
          );
          const ljConfig = fxInst?.config.mode === 'littlejs' ? fxInst.config.littlejs : undefined;
          const sceneId = ljConfig?.sceneId || 'rpgCombat';
          loadAllGameSceneAssets(sceneId).then((urls) => {
            r.setGameSceneAssets?.(urls);
          });
        });
      };
      window.addEventListener('gameSceneAssetsChanged', handleAssetsChanged);

      return () => {
        destroyed = true;
        cancelAnimationFrame(rafRef.current);
        resizeCleanup?.();
        window.removeEventListener('gameSceneAssetsChanged', handleAssetsChanged);
        renderer.destroy();
        rendererRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- long-lived render loop; must not tear down the renderer when the error callback identity changes
    }, [buildFrameState, resolveBackgroundUrl]);

    // No longer needed: track switches handled imperatively in the trackStore subscription above
    return (
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      />
    );
  }),
);

GPUCanvas.displayName = 'GPUCanvas';

'use client';

/**
 * LyricsCanvas — Lightweight React bridge for the unified CanvasLyricRenderer.
 *
 * Replaces the old R3F-based LyricsOverlay. No visible DOM element — all rendering
 * happens inside the WebGPU canvas via LyricCompositePass.
 *
 * Every animation frame this component:
 *   1. Grabs the current time from timeStore
 *   2. Calls CanvasLyricRenderer.render() → gets an ImageBitmap
 *   3. Passes it to WebGPURenderer.setLyricBitmap()
 *
 * The GPU renderer then alpha-blends the lyric bitmap over the scene.
 */

import React, { useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react';
import { CanvasLyricRenderer, type LyricRenderConfig } from '@/engine/lyrics/CanvasLyricRenderer';
import { threnicFontRegistry, FONTS, getFontUrl } from '@/constants/fonts';
import { defaultStyleRegistry } from '@threnic/lyrics';
import type { GPUCanvasRef } from '@/components/stage/GPUCanvas';
import type { LyricLineData, LyricTheme } from '@/types/lyrics';
import type { TrackTitleConfig } from '@/types/effects';
import { timeStore } from '@/engine/stores/timeStore';
import { audioStore } from '@/engine/stores/audioStore';
import { systemStore } from '@/stores/systemStore';
import { LyricFXDriver } from './LyricFXDriver';

interface LyricsCanvasProps {
  lyrics: LyricLineData[];
  theme?: LyricTheme;
  verticalPosition?: number;
  fontUrl?: string;
  effectScope?: 'word' | 'line' | 'background';
  fadeInDuration?: number;
  fadeOutDuration?: number;
  trackTitle?: string;
  trackTitleConfig?: TrackTitleConfig;
  trackTitleFontUrl?: string;
  /** Ref to the GPUCanvas that owns the WebGPURenderer */
  gpuCanvasRef: React.RefObject<GPUCanvasRef | null>;
  /** Canvas dimensions to render at (matches the export resolution canvas) */
  canvasWidth: number;
  canvasHeight: number;
}

const DEFAULT_THEME: LyricTheme = {
  fontSize: 0.5,
  fontWeight: 700,
  colorPre: '#555555',
  colorActive: '#ffffff',
  colorPost: '#999999',
  outlineColor: '#000000',
  effect: 'none',
  audioReactive: false,
};

export const LyricsCanvas = React.memo(function LyricsCanvas({
  lyrics,
  theme,
  verticalPosition,
  fontUrl,
  effectScope,
  fadeInDuration,
  fadeOutDuration,
  trackTitle,
  trackTitleConfig,
  trackTitleFontUrl,
  gpuCanvasRef,
  canvasWidth,
  canvasHeight,
}: LyricsCanvasProps) {
  const rendererRef = useRef<CanvasLyricRenderer | null>(null);
  const rafRef = useRef<number>(0);
  const domCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastTimeRef = useRef<number>(0);
  // GPU Lyric FX driver (built lazily once a GPU device is available).
  const fxDriverRef = useRef<LyricFXDriver | null>(null);
  const fxDriverDeviceRef = useRef<GPUDevice | null>(null);
  const prevFrameTimeRef = useRef<number>(0);
  // Track GPU renderer availability reactively — it initializes async
  const [hasGpuRenderer, setHasGpuRenderer] = useState(false);

  // The animation loop below is a long-lived RAF whose effect deliberately does
  // NOT depend on `theme`/fade durations (re-subscribing the RAF on every colour
  // tweak would thrash the driver). Without a ref, the `tick` closure captures
  // the theme from the render when the effect last ran and goes STALE — a colour
  // change then only appears after a full reload (which remounts and re-closes
  // over fresh values). Mirror the live values into refs after each render so
  // the stable loop always reads the current theme.
  const themeRef = useRef(theme);
  const fadeInRef = useRef(fadeInDuration);
  const fadeOutRef = useRef(fadeOutDuration);
  useLayoutEffect(() => {
    themeRef.current = theme;
    fadeInRef.current = fadeInDuration;
    fadeOutRef.current = fadeOutDuration;
  });

  // Build config
  const resolvedTheme = theme ?? DEFAULT_THEME;

  const config = useMemo<LyricRenderConfig>(
    () => ({
      lyrics,
      theme: resolvedTheme,
      verticalPosition,
      fontUrl,
      effectScope,
      fadeInDuration,
      fadeOutDuration,
      trackTitle,
      trackTitleConfig,
      trackTitleFontUrl,
    }),
    [
      lyrics,
      resolvedTheme,
      verticalPosition,
      fontUrl,
      effectScope,
      fadeInDuration,
      fadeOutDuration,
      trackTitle,
      trackTitleConfig,
      trackTitleFontUrl,
    ],
  );

  // (Re)create renderer when config changes
  useEffect(() => {
    if ((!lyrics || lyrics.length === 0) && !trackTitleConfig?.enabled) {
      rendererRef.current?.destroy();
      rendererRef.current = null;
      return;
    }

    if (rendererRef.current) {
      rendererRef.current.updateConfig(config);
    } else {
      rendererRef.current = new CanvasLyricRenderer(config, {
        fontRegistry: threnicFontRegistry,
        styleRegistry: defaultStyleRegistry,
      });
    }
  }, [config, lyrics, trackTitleConfig?.enabled]);

  // Animation loop — render lyrics and push bitmap to GPU
  useEffect(() => {
    if ((!lyrics || lyrics.length === 0) && !trackTitleConfig?.enabled) return;

    let running = true;

    function tick() {
      if (!running) return;
      rafRef.current = requestAnimationFrame(tick);

      const renderer = rendererRef.current;
      if (!renderer) return;

      const timeState = timeStore.getState();
      const time = timeState.currentTime;

      // Handle seeking: reset scroll state if time jumped significantly
      if (Math.abs(time - lastTimeRef.current) > 1.0) {
        renderer.resetScroll();
        fxDriverRef.current?.resetRouter();
      }
      lastTimeRef.current = time;

      const gpuCanvas = gpuCanvasRef.current;
      const gpuRenderer = gpuCanvas ? gpuCanvas.getRenderer?.() : null;

      // Update reactive state for DOM canvas visibility toggle
      const gpuAvailable = !!gpuRenderer;
      setHasGpuRenderer((prev) => (prev !== gpuAvailable ? gpuAvailable : prev));

      const audio = audioStore.getState();
      const activeTheme = themeRef.current ?? DEFAULT_THEME;

      // ── GPU Lyric FX path (derived from WebGPU availability) ───────────
      // The per-glyph MSDF chain owns the lyric layer whenever the WebGPU
      // renderer is live; the Canvas2D bitmap path below is the fallback used
      // only when WebGPU is unavailable (WebGL/Canvas2D fallback renderer).
      // There is no per-track renderer toggle anymore — GPU is the default.
      const device = gpuRenderer?.getDevice?.() ?? null;
      if (gpuRenderer && device) {
        systemStore.getState().setWebgpuActive(true);
        // Re-create the driver if the GPU device changed (GPUCanvas re-inits
        // the renderer after a device loss; the old driver's resources are dead).
        if (fxDriverRef.current && fxDriverDeviceRef.current !== device) {
          fxDriverRef.current.destroy();
          fxDriverRef.current = null;
        }
        if (!fxDriverRef.current) {
          fxDriverRef.current = new LyricFXDriver(device);
          fxDriverDeviceRef.current = device;
        }
        const fontFamily = FONTS.find((f) => f.id === activeTheme.fontId)?.name ?? 'sans-serif';
        const dt = Math.max(0, time - prevFrameTimeRef.current);
        prevFrameTimeRef.current = time;
        // Shared layout: reuse the Canvas2D renderer's positioned lines so GPU
        // wrapping/scroll matches the Canvas2D path (LLD §7 parity).
        const positioned = renderer.getPositionedLines?.(time, canvasWidth, canvasHeight);
        const handled = fxDriverRef.current.frame(
          gpuRenderer as never,
          lyrics ?? [],
          activeTheme,
          fontFamily,
          {
            time,
            dt,
            width: canvasWidth,
            height: canvasHeight,
            bass: audio.bass,
            mid: audio.mid,
            high: audio.high,
            energy: audio.energy,
            fft: audio.fftData,
            fadeInDuration: fadeInRef.current,
            fadeOutDuration: fadeOutRef.current,
            fontUrl: activeTheme.fontId ? getFontUrl(activeTheme.fontId) : undefined,
          },
          positioned,
        );
        if (handled) {
          // GPU FX owns the lyric layer this frame; clear the bitmap path.
          gpuRenderer.setLyricBitmap?.(null);
          return;
        }
      } else if (fxDriverRef.current) {
        // Left GPU mode — detach the graph so the bitmap path resumes cleanly.
        gpuRenderer?.setLyricFXGraph?.(null);
        systemStore.getState().setWebgpuActive(false);
      } else {
        systemStore.getState().setWebgpuActive(false);
      }

      const bitmap = renderer.render(time, canvasWidth, canvasHeight, {
        bass: audio.bass,
        mid: audio.mid,
        high: audio.high,
        energy: audio.energy,
      });

      if (!bitmap) {
        // Nothing visible to render. Clear DOM canvas if we are in WebGL fallback.
        if (!gpuRenderer && domCanvasRef.current) {
          const domCanvas = domCanvasRef.current;
          const ctx2d = domCanvas.getContext('2d');
          if (ctx2d) {
            ctx2d.clearRect(0, 0, domCanvas.width, domCanvas.height);
          }
        } else if (gpuRenderer) {
          // Tell GPU renderer to clear its lyric texture
          gpuRenderer.setLyricBitmap?.(null);
        }
        return;
      }

      if (gpuRenderer) {
        // Update glow intensity if supported
        const liveTheme = themeRef.current;
        const glowIntensity = liveTheme?.glowEnabled ? (liveTheme.glowIntensity ?? 0.5) : 0;
        gpuRenderer.updateLyricGlow?.(glowIntensity);

        // Pass to GPU renderer (it will composite and close the bitmap)
        gpuRenderer.setLyricBitmap(bitmap);
      } else if (domCanvasRef.current) {
        // WebGL Fallback preview uses DOM canvas overlapping CenterStage
        const domCanvas = domCanvasRef.current;
        if (domCanvas.width !== canvasWidth || domCanvas.height !== canvasHeight) {
          domCanvas.width = canvasWidth;
          domCanvas.height = canvasHeight;
        }

        const ctx2d = domCanvas.getContext('2d');
        if (ctx2d) {
          ctx2d.clearRect(0, 0, canvasWidth, canvasHeight);
          // bitmap is 2× resolution (renderScale inside CanvasLyricRenderer),
          // so we must scale it down to fit the DOM canvas.
          ctx2d.drawImage(bitmap, 0, 0, canvasWidth, canvasHeight);
        }
      } else {
        // Neither GPU renderer nor DOM canvas available, just clean up
        if ('close' in bitmap) (bitmap as ImageBitmap).close();
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [lyrics, trackTitleConfig?.enabled, gpuCanvasRef, canvasWidth, canvasHeight]);

  // Cleanup
  useEffect(() => {
    return () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
      fxDriverRef.current?.destroy();
      fxDriverRef.current = null;
    };
  }, []);

  return (
    <canvas
      ref={domCanvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 10,
        // Hide DOM canvas when GPU renderer handles compositing
        display: hasGpuRenderer ? 'none' : 'block',
      }}
    />
  );
});

LyricsCanvas.displayName = 'LyricsCanvas';

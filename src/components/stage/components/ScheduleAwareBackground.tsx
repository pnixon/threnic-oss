'use client';

/**
 * ScheduleAwareBackground — R3F/Three.js background plane (fallback path).
 *
 * NOTE: Shader overlay (ShaderOverlayPass) is WebGPU-only and not available
 * in this R3F render path. It requires the GPUCanvas/WebGPURenderer path.
 */

import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useBackgroundTransform } from '@/hooks/useBackgroundTransform';
import {
  useScheduleAwareBackgroundUrl,
  useScheduleAwareEffectsConfig,
} from '../hooks/useScheduleAware';
import { SlideshowBackgroundPlane } from '../background/SlideshowBackgroundPlane';
import { BackgroundErrorBoundary } from './BackgroundErrorBoundary';
import type { EffectsConfig, SlideshowConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';
import { DEFAULT_SLIDESHOW_CONFIG } from '@/types/effects';

import { keyframeStore } from '@/engine/stores/keyframeStore';
import { audioStore } from '@/engine/stores/audioStore';
import { resolveBackgroundOpacity } from '@/utils/resolveBgEffects';
import { usePlaylistState } from '@/contexts/PlaylistContext';

type SlideInstance = Extract<EffectInstance, { type: 'slide' }>;
type ZoomInstance = Extract<EffectInstance, { type: 'zoom' }>;
type RotateInstance = Extract<EffectInstance, { type: 'rotate' }>;

interface ScheduleAwareBackgroundProps {
  defaultUrl?: string | null;
  effectsConfig?: EffectsConfig;
  isPlaying?: boolean;
  currentTrackId?: string;
}

/**
 * ScheduleAwareBackground — Unified layer-based background rendering
 *
 * Layer stack (back to front):
 *   z=-10.2  Backdrop (solid color, always present)
 *   z=-4.5   Media layer (slideshow — handles images AND videos, single or multi)
 *   z=0+     Effects (rendered by ScheduleAwareEffects)
 *
 * All media (single image, single video, or multi-item slideshow) is rendered
 * through SlideshowBackgroundPlane. When there's no explicit slideshow config
 * but a backgroundImage URL exists, a virtual single-item slideshow is created.
 */
export function ScheduleAwareBackground({
  defaultUrl,
  effectsConfig,
  isPlaying,
  currentTrackId,
}: ScheduleAwareBackgroundProps): React.ReactElement {
  const activeUrl = useScheduleAwareBackgroundUrl(defaultUrl);
  const effectiveConfig = useScheduleAwareEffectsConfig(effectsConfig);
  const { tracks } = usePlaylistState();
  const activeTrack = tracks.find((t) => t.id === currentTrackId);
  const videoClips = activeTrack?.videoClips || [];

  // ─── Resolve current properties ──────────────────────────────────────
  const fit = effectiveConfig?.backgroundFit ?? 'cover';
  const scale = effectiveConfig?.backgroundScale ?? 1.0;
  const offsetX = effectiveConfig?.backgroundOffsetX ?? 0;
  const offsetY = effectiveConfig?.backgroundOffsetY ?? 0;
  const brightness = effectiveConfig?.backgroundBrightness ?? 1.0;
  const mediaOpacity = effectiveConfig?.backgroundOpacity ?? 1.0;
  const isTiling = effectiveConfig?.backgroundTiling ?? false;
  const explicitSlideshow = effectiveConfig?.slideshow;
  // Stable fingerprints to avoid recreating the memo on every computedConfig rebuild
  const slideshowItemsFingerprint =
    explicitSlideshow?.items?.map((i) => `${i.id}:${i.url}:${i.type}`).join('|') ?? '';
  const videoEnabled = effectiveConfig?.video?.enabled ?? false;
  const videoUrl = effectiveConfig?.video?.url ?? '';

  // ─── Build effective slideshow config ────────────────────────────────
  // If there are explicit slideshow items, use those.
  // Otherwise if there's a backgroundImage URL, wrap it as a single-item slideshow.
  const effectiveSlideshowConfig: SlideshowConfig | null = useMemo(() => {
    if (explicitSlideshow && explicitSlideshow.items.length > 0) {
      return explicitSlideshow;
    }
    const finalActiveUrl = activeUrl || (videoEnabled ? videoUrl : null);
    if (finalActiveUrl) {
      // Detect video by extension OR by the video config flag.
      // Blob URLs have no extension so we must also check if videoEnabled+videoUrl matches.
      const isVideo =
        (videoEnabled && finalActiveUrl === videoUrl) ||
        /\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(finalActiveUrl);
      return {
        ...DEFAULT_SLIDESHOW_CONFIG,
        items: [
          {
            id: '__single_bg',
            url: finalActiveUrl as string,
            type: isVideo ? ('video' as const) : ('image' as const),
            label: 'Background',
          },
        ],
      };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideshowItemsFingerprint, activeUrl, videoEnabled, videoUrl]);

  const hasMedia = effectiveSlideshowConfig !== null;

  // ─── Shared Refs ───
  const backdropMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  // Keep effectiveConfig in a ref so useFrame always reads the latest without stale closure
  const effectiveConfigRef = useRef(effectiveConfig);
  effectiveConfigRef.current = effectiveConfig;
  const mediaOpacityRef = useRef(hasMedia ? mediaOpacity : 0.0);

  // Transition effect refs
  const clipRef = useRef(new THREE.Vector4(0, 1, 0, 1));
  const extraBrightnessRef = useRef(0.0);
  const mainZoomBoostRef = useRef(1.0);

  // ─── Per-frame updates ───────────────────────────────────────────────
  useFrame(() => {
    const t = keyframeStore.getState().transition;

    // Reset shared refs
    clipRef.current.set(0, 1, 0, 1);
    extraBrightnessRef.current = 0.0;
    mainZoomBoostRef.current = 1.0;

    // Update backdrop background color (behind media)
    if (backdropMaterialRef.current) {
      let bgColor = keyframeStore.getState().scene.backgroundColor;
      if (!bgColor) {
        const cfg = effectiveConfigRef.current;
        bgColor = cfg?.backgroundColor || cfg?.visualizer?.backgroundColor || '#000000';
      }
      // Note: set() parses hex strings
      backdropMaterialRef.current.color.set(bgColor);
    }

    // Resolve opacity from effectInstances (with AR) or fallback to legacy value
    const audioState = audioStore.getState();
    const audio = {
      bass: audioState.bass,
      mid: audioState.mid,
      high: audioState.high,
      energy: audioState.energy,
    };
    const resolvedOpacity = resolveBackgroundOpacity(
      effectiveConfigRef.current,
      audio,
      keyframeStore.getState().scene.backgroundOpacity,
    );

    if (t.isActive) {
      const p = t.progress;
      let inOpacity = resolvedOpacity;

      // Only apply visual transition adjustments to track-level transitions.
      // In-track clip transitions are already cross-blended internally by SlideshowBackgroundPlane.
      const isTrackTransition = t.fromTrackIndex !== -1 && t.toTrackIndex !== -1;

      if (isTrackTransition) {
        switch (t.type) {
          case 'crossfade':
            inOpacity = p * resolvedOpacity;
            break;

          case 'bloom-flash':
            extraBrightnessRef.current = Math.sin(p * Math.PI) * 2.0;
            inOpacity = p > 0.5 ? resolvedOpacity : 0.0;
            break;

          case 'wipe-left':
            clipRef.current.set(1.0 - p, 1.0, 0, 1);
            inOpacity = resolvedOpacity;
            break;

          case 'wipe-right':
            clipRef.current.set(0, p, 0, 1);
            inOpacity = resolvedOpacity;
            break;

          case 'zoom-in':
            inOpacity = p * resolvedOpacity;
            mainZoomBoostRef.current = 0.5 + p * 0.5;
            break;

          case 'zoom-out':
            inOpacity = p * resolvedOpacity;
            mainZoomBoostRef.current = 2.0 - p * 1.0;
            break;
        }
      }

      mediaOpacityRef.current = hasMedia ? inOpacity : 0;
    } else {
      mediaOpacityRef.current = hasMedia ? resolvedOpacity : 0;
    }
  });

  // ─── Effects Setup ────────────────────────────────────────────────────
  const instances = effectiveConfig?.effectInstances ?? [];

  const slideInstance = [...instances]
    .reverse()
    .find((i): i is SlideInstance => i.type === 'slide' && !!i.config.enabled);
  const zoomInstance = [...instances]
    .reverse()
    .find((i): i is ZoomInstance => i.type === 'zoom' && !!i.config.enabled);
  const rotateInstance = [...instances]
    .reverse()
    .find((i): i is RotateInstance => i.type === 'rotate' && !!i.config.enabled);

  const slideConfig = slideInstance?.config;
  const slideEnabled = !!slideConfig;
  const zoomConfig = zoomInstance?.config;
  const zoomEnabled = !!zoomConfig;
  const rotateConfig = rotateInstance?.config;
  const rotateEnabled = !!rotateConfig;

  const transformRef = useBackgroundTransform({
    zoom: { config: zoomConfig, enabled: zoomEnabled },
    slide: { config: slideConfig, enabled: slideEnabled },
    rotate: { config: rotateConfig, enabled: rotateEnabled },
    transitionZoomBoostRef: mainZoomBoostRef,
  });

  return (
    <BackgroundErrorBoundary>
      {/* ─── 1. Backdrop (solid color, always present) ─── */}
      <mesh position={[0, 0, -10.2]} scale={[100, 100, 1]}>
        <planeGeometry />
        <meshBasicMaterial
          ref={backdropMaterialRef}
          color={
            effectiveConfig?.backgroundColor ||
            effectiveConfig?.visualizer?.backgroundColor ||
            '#000000'
          }
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* ─── 2. Media Layer (slideshow handles images + videos, single or multi) ─── */}
      <React.Suspense fallback={null}>
        {hasMedia && effectiveSlideshowConfig && (
          <group position={[0, 0, -4.5]}>
            <SlideshowBackgroundPlane
              config={effectiveSlideshowConfig}
              videoClips={videoClips}
              isPlaying={isPlaying}
              brightness={brightness}
              opacityRef={mediaOpacityRef}
              fit={fit}
              scale={scale}
              offsetX={offsetX}
              offsetY={offsetY}
              isTiling={isTiling}
              transformRef={transformRef}
            />
          </group>
        )}
      </React.Suspense>
    </BackgroundErrorBoundary>
  );
}

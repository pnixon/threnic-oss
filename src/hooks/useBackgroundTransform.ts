/**
 * Unified Background Transform Hook
 *
 * Consolidates zoom, slide, and rotation into a single transform state.
 * All geometric background transforms flow through this abstraction,
 * ensuring clean, coordinated rendering.
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useAudioReactiveEnvelope } from '@/hooks/useAudioReactive';
import type { PostProcessingConfig } from '@/types/effects';
import { timeStore } from '@/engine/stores/timeStore';
import { getFrameDelta } from '@/engine/EngineLoop';

// ─── Transform State ─────────────────────────────────────────────────────────

export interface BackgroundTransform {
  // Zoom
  scale: number;
  zoomCenterX: number;
  zoomCenterY: number;

  // Slide (accumulated offset)
  slideX: number;
  slideY: number;

  // Rotation (radians)
  rotation: number;

  // Whether any transform is active (enables tiling/wrapping)
  active: boolean;
}

const DEFAULT_BACKGROUND_TRANSFORM: BackgroundTransform = {
  scale: 1.0,
  zoomCenterX: 0.5,
  zoomCenterY: 0.5,
  slideX: 0,
  slideY: 0,
  rotation: 0,
  active: false,
};

// ─── Hook Options ─────────────────────────────────────────────────────────────

interface BackgroundTransformOptions {
  zoom?: {
    config?: PostProcessingConfig['zoom'];
    enabled: boolean;
  };
  slide?: {
    config?: PostProcessingConfig['slide'];
    enabled: boolean;
  };
  rotate?: {
    config?: PostProcessingConfig['rotate'];
    enabled: boolean;
  };

  /** Transition zoom boost multiplier (e.g. from scene transitions) */
  transitionZoomBoostRef?: React.RefObject<number>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useBackgroundTransform(
  options: BackgroundTransformOptions,
): React.RefObject<BackgroundTransform> {
  const transformRef = useRef<BackgroundTransform>({ ...DEFAULT_BACKGROUND_TRANSFORM });

  const { zoom, slide, rotate, transitionZoomBoostRef } = options;

  // ── Zoom audio envelopes ────────────────────────────────────────
  const zoomAudioEnabled = zoom?.config?.audioReactive?.enabled ?? false;
  const zoomEnvelope = useAudioReactiveEnvelope(0, zoom?.config?.audioReactive);

  // ── Zoom center audio envelopes ────────────────────────────────
  const zoomCenterXAudioEnabled = zoom?.config?.audioReactive?.centerX?.enabled ?? false;
  const zoomCenterXEnvelope = useAudioReactiveEnvelope(
    zoom?.config?.centerX ?? 0.5,
    zoom?.config?.audioReactive?.centerX,
  );
  const zoomCenterYAudioEnabled = zoom?.config?.audioReactive?.centerY?.enabled ?? false;
  const zoomCenterYEnvelope = useAudioReactiveEnvelope(
    zoom?.config?.centerY ?? 0.5,
    zoom?.config?.audioReactive?.centerY,
  );

  // ── Slide audio envelopes ───────────────────────────────────────
  const slideXEnvelope = useAudioReactiveEnvelope(0, slide?.config?.audioReactive?.x);
  const slideYEnvelope = useAudioReactiveEnvelope(0, slide?.config?.audioReactive?.y);

  // ── Rotate audio envelopes (separate for angle and speed) ───
  const rotateAngleAudioEnabled = rotate?.config?.audioReactive?.enabled ?? false;
  const rotateAngleEnvelope = useAudioReactiveEnvelope(0, rotate?.config?.audioReactive);
  const rotateSpeedAudioEnabled = rotate?.config?.speedAudioReactive?.enabled ?? false;
  const rotateSpeedEnvelope = useAudioReactiveEnvelope(0, rotate?.config?.speedAudioReactive);

  // ── Accumulated state (persists across frames) ──────────────────
  const slideAccumRef = useRef(new THREE.Vector2(0, 0));
  const rotateAccumRef = useRef(0);

  useFrame((_, delta) => {
    const t = transformRef.current;

    const zoomEnabled = zoom?.enabled ?? false;
    const slideEnabled = slide?.enabled ?? false;
    const rotateEnabled = rotate?.enabled ?? false;
    const anyActive = zoomEnabled || slideEnabled || rotateEnabled;

    // Fast path: nothing active
    if (!anyActive) {
      t.scale = 1.0;
      t.zoomCenterX = 0.5;
      t.zoomCenterY = 0.5;
      t.slideX = 0;
      t.slideY = 0;
      t.rotation = 0;
      t.active = false;

      // Reset accumulators when disabled
      slideAccumRef.current.set(0, 0);
      rotateAccumRef.current = 0;
      return;
    }

    t.active = true;

    // Get frame delta (respects playback state)
    const frameDelta = getFrameDelta(delta);
    const isPaused = !timeStore.getState().isPlaying && timeStore.getState().mode === 'preview';

    // ── Zoom ────────────────────────────────────────────────────
    if (zoomEnabled && zoom?.config) {
      if (!isPaused) {
        zoomEnvelope.update(frameDelta);
        zoomCenterXEnvelope.update(frameDelta);
        zoomCenterYEnvelope.update(frameDelta);
      }

      if (zoomAudioEnabled) {
        t.scale = zoomEnvelope.current;
      } else {
        t.scale = zoom.config.scale ?? 1.0;
      }

      // Zoom center (invert Y for WebGL coordinates)
      // Use audio reactive envelopes when enabled, otherwise use static config
      const cx = zoomCenterXAudioEnabled
        ? zoomCenterXEnvelope.current
        : (zoom.config.centerX ?? 0.5);
      const cy = zoomCenterYAudioEnabled
        ? zoomCenterYEnvelope.current
        : (zoom.config.centerY ?? 0.5);
      t.zoomCenterX = cx;
      t.zoomCenterY = 1.0 - cy;
    } else {
      t.scale = 1.0;
      t.zoomCenterX = 0.5;
      t.zoomCenterY = 0.5;
    }

    // Apply transition zoom boost
    if (transitionZoomBoostRef) {
      t.scale *= transitionZoomBoostRef.current;
    }

    // ── Slide ───────────────────────────────────────────────────
    if (slideEnabled && slide?.config && !isPaused) {
      slideXEnvelope.update(frameDelta);
      slideYEnvelope.update(frameDelta);

      const speedX = slide.config.speedX ?? 0;
      const speedY = slide.config.speedY ?? 0;

      const audioModX = slideXEnvelope.current * frameDelta;
      const audioModY = slideYEnvelope.current * frameDelta;

      slideAccumRef.current.x += speedX * frameDelta + audioModX;
      slideAccumRef.current.y += speedY * frameDelta + audioModY;
    } else if (!slideEnabled) {
      slideAccumRef.current.set(0, 0);
    }

    t.slideX = slideAccumRef.current.x;
    t.slideY = slideAccumRef.current.y;

    // ── Rotation (config values are in degrees) ──────────────────
    if (rotateEnabled && rotate?.config) {
      if (!isPaused) {
        rotateAngleEnvelope.update(frameDelta);
        rotateSpeedEnvelope.update(frameDelta);
      }

      // Base angle (degrees) — optionally driven by audio
      const angleDeg = rotateAngleAudioEnabled
        ? rotateAngleEnvelope.current
        : (rotate.config.angle ?? 0);

      // Speed (degrees/s) — optionally driven by audio
      const speedDeg = rotateSpeedAudioEnabled
        ? rotateSpeedEnvelope.current
        : (rotate.config.speed ?? 0);

      if (speedDeg === 0) {
        rotateAccumRef.current = 0;
      }

      // Accumulate speed-based rotation over time (in degrees)
      if (!isPaused && speedDeg !== 0) {
        rotateAccumRef.current += speedDeg * frameDelta;
      }

      // Total rotation = base angle + accumulated speed
      const totalDeg = angleDeg + rotateAccumRef.current;

      // Convert to radians for the shader (no clamp — speed can spin freely)
      t.rotation = totalDeg * (Math.PI / 180);
    } else {
      t.rotation = 0;
      rotateAccumRef.current = 0;
    }
  });

  return transformRef;
}

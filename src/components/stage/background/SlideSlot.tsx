'use client';

import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { ImageSlide } from './ImageSlide';
import { VideoSlide } from './VideoSlide';
import type { SlotProps } from './types';

/* ────────────────────────────────────────────────────────────────
 * SlideSlot — a wrapper that imperatively updates position,
 * scale, and visibility from refs each frame.
 * ──────────────────────────────────────────────────────────────── */

export function SlideSlot({
  item,
  opacityRef,
  offsetXRef,
  offsetYRef,
  scaleRef,
  fit,
  brightness,
  z,
  isTiling,
  transformRef,
  scale,
  offsetX,
  offsetY,
  onVideoEnded,
  onVideoDuration,
  onVideoElement,
  videoLoop,
}: SlotProps): React.ReactElement | null {
  const groupRef = useRef<THREE.Group>(null);

  // Imperatively update group visibility each frame
  // Position and tracking is now passed down via refs to TexturedPlane so tiles wrap cleanly.
  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    const op = opacityRef.current;
    g.visible = op > 0.001;
  });

  if (!item) return null;

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      <React.Suspense fallback={null}>
        {item.type === 'video' ? (
          <VideoSlide
            item={item}
            opacityRef={opacityRef}
            scaleRef={scaleRef}
            offsetXRef={offsetXRef}
            offsetYRef={offsetYRef}
            z={z}
            fit={fit}
            brightness={brightness}
            isTiling={isTiling}
            transformRef={transformRef}
            scale={scale}
            offsetX={offsetX}
            offsetY={offsetY}
            onVideoEnded={onVideoEnded}
            onVideoDuration={onVideoDuration}
            onVideoElement={onVideoElement}
            loop={videoLoop}
          />
        ) : (
          <ImageSlide
            item={item}
            opacityRef={opacityRef}
            scaleRef={scaleRef}
            offsetXRef={offsetXRef}
            offsetYRef={offsetYRef}
            z={z}
            fit={fit}
            brightness={brightness}
            isTiling={isTiling}
            transformRef={transformRef}
            scale={scale}
            offsetX={offsetX}
            offsetY={offsetY}
          />
        )}
      </React.Suspense>
    </group>
  );
}

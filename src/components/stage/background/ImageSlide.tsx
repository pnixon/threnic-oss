'use client';

import React, { useState, useEffect } from 'react';
import * as THREE from 'three';
import { TexturedPlane } from './TexturedPlane';
import type { SlideProps } from './types';

export function ImageSlide({
  item,
  opacityRef,
  scaleRef,
  offsetXRef,
  offsetYRef,
  fit,
  brightness,
  z,
  isTiling,
  transformRef,
  scale,
  offsetX,
  offsetY,
}: SlideProps): React.ReactElement | null {
  // Load imperatively instead of drei's throwing useTexture(): a
  // dead/revoked blob: URL (stale IndexedDB project data) rejects the load,
  // and useTexture would suspend forever inside SlideSlot's Suspense boundary
  // (blank slide, never resolves). Loading here with an error callback lets a
  // failed load resolve to null so the slide simply renders nothing.
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      item.url,
      (tex) => {
        if (cancelled) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        setTexture(tex);
      },
      undefined,
      () => {
        // Dead/revoked blob URL or network failure — leave texture null.
        if (!cancelled) setTexture(null);
      },
    );
    return () => {
      cancelled = true;
      setTexture((prev) => {
        prev?.dispose();
        return null;
      });
    };
  }, [item.url]);

  if (!texture) return null;

  return (
    <group position={[0, 0, z]}>
      <TexturedPlane
        texture={texture}
        opacityRef={opacityRef}
        scaleRef={scaleRef}
        offsetXRef={offsetXRef}
        offsetYRef={offsetYRef}
        brightness={brightness ?? 1.0}
        fit={fit ?? 'cover'}
        isTiling={isTiling}
        transformRef={transformRef}
        scale={scale}
        offsetX={offsetX}
        offsetY={offsetY}
      />
    </group>
  );
}

'use client';
'use no memo';

import React, { useMemo, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { BackgroundTransform } from '@/hooks/useBackgroundTransform';

type FitMode = 'cover' | 'contain' | 'fitWidth' | 'fitHeight' | 'stretch' | 'original' | 'manual';

export interface TexturedPlaneProps {
  texture: THREE.Texture;
  fit?: FitMode;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  brightness?: number;
  opacity?: number;
  extraBrightness?: number;
  opacityRef?: React.RefObject<number>;
  scaleRef?: React.RefObject<number>;
  offsetXRef?: React.RefObject<number>;
  offsetYRef?: React.RefObject<number>;
  extraBrightnessRef?: React.RefObject<number>;

  /** Whether seamless tiling is explicitly enabled */
  isTiling?: boolean;

  /** Unified background transform (zoom, slide, rotation) */
  transformRef?: React.RefObject<BackgroundTransform>;
}

/**
 * Shared plane component for rendering textures with consistent fitting/tiling logic.
 *
 * WebGPU-compatible version using MeshBasicMaterial instead of ShaderMaterial.
 *
 * Supports:
 * - Multiple fit modes (cover, contain, fitWidth, fitHeight, stretch)
 * - Background sliding (slides the source image texture, with wrapping/tiling)
 * - Rotation and zoom transforms
 * - Brightness adjustment
 * - Audio-reactive transforms via refs
 */
export function TexturedPlane({
  texture,
  fit = 'cover',
  scale = 1.0,
  offsetX = 0,
  offsetY = 0,
  brightness = 1.0,
  opacity = 1.0,
  extraBrightness = 0.0,
  opacityRef,
  scaleRef,
  offsetXRef,
  offsetYRef,
  extraBrightnessRef,
  isTiling = false,

  transformRef,
}: TexturedPlaneProps): React.ReactElement {
  const { camera, size } = useThree();

  const instancedMeshRef = useRef<THREE.InstancedMesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const dummyObj = useMemo(() => new THREE.Object3D(), []);

  const effectiveIsTiling = isTiling || fit === 'original' || fit === 'manual';

  useFrame(() => {
    if (!texture || !materialRef.current || !instancedMeshRef.current) return;

    const mat = materialRef.current;
    const inst = instancedMeshRef.current;
    const transform = transformRef?.current;

    // Detect if this is a video texture that isn't ready yet
    const sourceImg = texture.image as
      | HTMLVideoElement
      | { width: number; height: number }
      | null
      | undefined;
    const isUnreadyVideo = sourceImg instanceof HTMLVideoElement && sourceImg.readyState < 2;

    if (!texture.colorSpace || texture.colorSpace === THREE.NoColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
      if (!isUnreadyVideo) texture.needsUpdate = true;
    }

    // Always use ClampToEdge since we manually tile via instances
    // This perfectly supports videos in WebGL
    if (
      texture.wrapS !== THREE.ClampToEdgeWrapping ||
      texture.wrapT !== THREE.ClampToEdgeWrapping
    ) {
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      if (!isUnreadyVideo) texture.needsUpdate = true;
    }

    // We handle repeating manually!
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
    texture.rotation = 0;

    // Material updates
    mat.map = texture;
    mat.opacity = opacityRef ? opacityRef.current : opacity;
    const eb = extraBrightnessRef ? extraBrightnessRef.current : extraBrightness;
    const totalBrightness = Math.max(0, brightness + eb);
    mat.color.setRGB(totalBrightness, totalBrightness, totalBrightness);
    mat.needsUpdate = false;

    // Calculate viewport physics
    const fov = 'fov' in camera ? (camera.fov * Math.PI) / 180 : (50 * Math.PI) / 180;

    // Dynamically calculate actual distance to camera to prevent mismatched scales!
    const worldPos = new THREE.Vector3();
    inst.getWorldPosition(worldPos);
    const distance = Math.abs(camera.position.z - worldPos.z);

    const visibleHeight = 2 * Math.tan(fov / 2) * distance;
    const visibleWidth = visibleHeight * (size.width / size.height);
    const viewportAspect = size.width / size.height;

    // Compute original image dimensions
    let imgW = 1920;
    let imgH = 1080;
    if (sourceImg) {
      if (sourceImg instanceof HTMLVideoElement) {
        imgW = sourceImg.videoWidth || 1920;
        imgH = sourceImg.videoHeight || 1080;
      } else {
        imgW = sourceImg.width;
        imgH = sourceImg.height;
      }
    }
    const imageAspect = imgH > 0 ? imgW / imgH : 16 / 9;

    const currentScale = scaleRef ? scaleRef.current : scale;
    const safeScale = currentScale === 0 ? 0.001 : currentScale;
    const combinedScale = transform ? transform.scale * safeScale : safeScale;

    // ── Compute base tile dimensions using fit mode ──
    // Both the tiling and non-tiling paths share this so tiles
    // match the expected visual for the selected fit mode.
    let baseW = visibleWidth;
    let baseH = visibleHeight;

    switch (fit) {
      case 'fitWidth':
        baseW = visibleWidth;
        baseH = baseW / imageAspect;
        break;
      case 'fitHeight':
        baseH = visibleHeight;
        baseW = baseH * imageAspect;
        break;
      case 'contain':
        if (imageAspect > viewportAspect) {
          baseW = visibleWidth;
          baseH = baseW / imageAspect;
        } else {
          baseH = visibleHeight;
          baseW = baseH * imageAspect;
        }
        break;
      case 'stretch':
        baseW = visibleWidth;
        baseH = visibleHeight;
        break;
      case 'original':
      case 'manual':
        // For original/manual, one tile = image at natural size relative to viewport
        baseH = visibleHeight;
        baseW = baseH * imageAspect;
        break;
      case 'cover':
      default:
        if (imageAspect > viewportAspect) {
          baseH = visibleHeight;
          baseW = baseH * imageAspect;
        } else {
          baseW = visibleWidth;
          baseH = baseW / imageAspect;
        }
        break;
    }

    // Apply zoom scale
    const tileW = baseW * combinedScale;
    const tileH = baseH * combinedScale;

    // Shared slide/offset computation
    let effOffsetX = offsetXRef ? offsetXRef.current : offsetX;
    let effOffsetY = offsetYRef ? offsetYRef.current : offsetY;
    if (transform) {
      effOffsetX -= transform.slideX;
      effOffsetY -= transform.slideY;
    }

    if (effectiveIsTiling) {
      // We need enough tiles to fill the screen even when rotated.
      const diag = Math.sqrt(visibleWidth * visibleWidth + visibleHeight * visibleHeight);
      const cols = Math.ceil(diag / tileW) + 2;
      const rows = Math.ceil(diag / tileH) + 2;
      const halfCols = Math.floor(cols / 2);
      const halfRows = Math.floor(rows / 2);

      // Calculate continuous shift — wrapping keeps the grid centered
      const wrapShiftX = (-effOffsetX * tileW) % tileW;
      const wrapShiftY = (-effOffsetY * tileH) % tileH;

      // Rotate the entire instanced mesh group
      inst.rotation.z = transform ? transform.rotation : 0;

      let count = 0;
      for (let i = -halfCols; i <= halfCols; i++) {
        for (let j = -halfRows; j <= halfRows; j++) {
          if (count >= 400) break; // Hard limit for safety
          const x = i * tileW + wrapShiftX;
          const y = j * tileH + wrapShiftY;
          dummyObj.position.set(x, y, 0);
          dummyObj.scale.set(tileW, tileH, 1);
          dummyObj.updateMatrix();
          inst.setMatrixAt(count++, dummyObj.matrix);
        }
      }
      inst.count = count;
      inst.instanceMatrix.needsUpdate = true;
    } else {
      // Non-tiling: single instance positioned with offset
      const shiftX = -effOffsetX * tileW;
      const shiftY = -effOffsetY * tileH;

      inst.rotation.z = transform ? transform.rotation : 0;

      dummyObj.position.set(shiftX, shiftY, 0);
      dummyObj.scale.set(tileW, tileH, 1);
      dummyObj.updateMatrix();

      inst.setMatrixAt(0, dummyObj.matrix);
      inst.count = 1;
      inst.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <instancedMesh ref={instancedMeshRef} args={[undefined, undefined, 400]} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        ref={materialRef}
        map={texture}
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

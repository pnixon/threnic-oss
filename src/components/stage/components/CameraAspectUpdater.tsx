'use client';

import React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * CameraAspectUpdater - Updates the main camera's aspect ratio when viewport size changes
 */
export function CameraAspectUpdater(): null {
  const { camera, size, gl } = useThree();

  React.useLayoutEffect(
    function (): void {
      if (camera instanceof THREE.PerspectiveCamera) {
        const newAspect = size.width / size.height;
        if (Math.abs(camera.aspect - newAspect) > 0.001) {
          camera.aspect = newAspect;
          camera.updateProjectionMatrix();
          gl.setSize(size.width, size.height, false);
        }
      }
    },
    [camera, size.width, size.height, gl],
  );

  return null;
}

'use client';

import React, { useEffect } from 'react';
import { useVideoTexture } from '@react-three/drei';
import { TexturedPlane } from './TexturedPlane';
import type { VideoSlideProps } from './types';

export function VideoSlide({
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
  onVideoEnded,
  onVideoDuration,
  onVideoElement,
  loop,
}: VideoSlideProps): React.ReactElement | null {
  const isCrossOrigin = React.useMemo(() => {
    if (item.url.startsWith('blob:') || item.url.startsWith('data:')) return false;
    try {
      const urlObj = new URL(item.url, window.location.href);
      return urlObj.origin !== window.location.origin;
    } catch {
      return false;
    }
  }, [item.url]);

  const texture = useVideoTexture(item.url, {
    unsuspend: 'canplay',
    crossOrigin: isCrossOrigin ? 'Anonymous' : undefined,
    loop: loop ?? false, // Don't loop by default — let state machine handle transitions
    muted: true,
    start: true,
    playsInline: true,
  });

  // ── Guard: prevent InvalidStateError from Three.js texImage2D ──
  // drei's useVideoTexture uses Three.js VideoTexture, which registers
  // requestVideoFrameCallback in its CONSTRUCTOR. The rVFC callback
  // captures `this.update.bind(this)` — a reference to the ORIGINAL
  // update method. Monkey-patching texture.update() AFTER construction
  // is bypassed because rVFC holds the old reference.
  //
  // Instead, we override the `needsUpdate` property descriptor on the
  // texture instance. The rVFC callback sets `scope.needsUpdate = true`
  // (VideoTexture.js:73) which goes through our guard. If the video
  // isn't decodable, we suppress the update to prevent the renderer's
  // copyExternalImageToTexture / texImage2D from receiving a bad source.
  //
  // IMPORTANT: The original Texture.prototype setter (Texture.js:743)
  // does `this.version++` and `this.source.needsUpdate = true` — we
  // must replicate this when allowing the update through.
  useEffect(() => {
    if (!texture) return;

    const guarded = texture as typeof texture & { __threnic_guarded?: boolean };
    if (guarded.__threnic_guarded) return;
    guarded.__threnic_guarded = true;

    Object.defineProperty(texture, 'needsUpdate', {
      set(value: boolean) {
        if (value === true) {
          const video = this.image as HTMLVideoElement;
          if (
            video &&
            (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0)
          ) {
            // Video decoder not ready — suppress update to prevent
            // copyExternalImageToTexture / texImage2D from throwing
            // "InvalidStateError: The source image could not be decoded"
            return;
          }

          // Replicate Texture.prototype.needsUpdate setter behavior:
          // increment version counter and mark source for upload
          this.version++;
          this.source.needsUpdate = true;
        }
      },
      configurable: true,
      enumerable: true,
    });
  }, [texture]);

  // Report video element when available
  useEffect(() => {
    if (!texture?.source?.data) {
      onVideoElement?.(null);
      return;
    }
    const video = texture.source.data as HTMLVideoElement;
    onVideoElement?.(video);
    return () => {
      onVideoElement?.(null);
    };
  }, [texture, onVideoElement]);

  // Dynamically sync loop property
  useEffect(() => {
    if (!texture?.source?.data) return;
    const video = texture.source.data as HTMLVideoElement;
    video.loop = loop ?? false;
  }, [texture, loop]);

  // Report video duration when available
  useEffect(() => {
    if (!texture?.source?.data) return;
    const video = texture.source.data as HTMLVideoElement;
    const reportDuration = () => {
      if (video.duration && isFinite(video.duration) && onVideoDuration) {
        onVideoDuration(video.duration);
      }
    };
    if (video.readyState >= 1) {
      reportDuration();
    } else {
      video.addEventListener('loadedmetadata', reportDuration, { once: true });
    }
    return () => video.removeEventListener('loadedmetadata', reportDuration);
  }, [texture, onVideoDuration]);

  // Report when video ends
  useEffect(() => {
    if (!texture?.source?.data || !onVideoEnded) return;
    const video = texture.source.data as HTMLVideoElement;
    video.addEventListener('ended', onVideoEnded);
    return () => video.removeEventListener('ended', onVideoEnded);
  }, [texture, onVideoEnded]);

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

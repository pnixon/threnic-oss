/**
 * Shared types for slideshow background sub-components.
 * Extracted from SlideshowBackgroundPlane.tsx for cross-file reuse.
 */

import React from 'react';
import type { TexturedPlaneProps } from './TexturedPlane';
import type { SlideshowMediaItem } from '@/types/effects/background';

/** Props shared by both ImageSlide and VideoSlide */
export interface SlideProps {
  item: SlideshowMediaItem;
  opacityRef: React.RefObject<number>;
  scaleRef?: React.RefObject<number>;
  offsetXRef?: React.RefObject<number>;
  offsetYRef?: React.RefObject<number>;
  fit?: TexturedPlaneProps['fit'];
  brightness?: number;
  z: number;
  isTiling?: boolean;
  transformRef?: TexturedPlaneProps['transformRef'];
  scale?: number;
  offsetX?: number;
  offsetY?: number;
}

/** VideoSlide-specific props extend the base SlideProps */
export interface VideoSlideProps extends SlideProps {
  onVideoEnded?: () => void;
  onVideoDuration?: (duration: number) => void;
  onVideoElement?: (video: HTMLVideoElement | null) => void;
  loop?: boolean;
}

/** SlideSlot (double-buffer A/B wrapper) props */
export interface SlotProps {
  item: SlideshowMediaItem | null;
  opacityRef: React.RefObject<number>;
  offsetXRef: React.RefObject<number>;
  offsetYRef: React.RefObject<number>;
  scaleRef: React.RefObject<number>;
  fit?: TexturedPlaneProps['fit'];
  brightness?: number;
  z: number;
  isTiling?: boolean;
  transformRef?: TexturedPlaneProps['transformRef'];
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  onVideoEnded?: () => void;
  onVideoDuration?: (duration: number) => void;
  onVideoElement?: (video: HTMLVideoElement | null) => void;
  videoLoop?: boolean;
}

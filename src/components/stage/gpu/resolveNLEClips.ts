'use client';

/**
 * resolveNLEClips — Resolve NLE timeline video clips to determine
 * the active background URL, transition state, and lookahead for preloading.
 *
 * Pure function extracted from GPUCanvas tick loop. Takes the current
 * slideshow state + NLE clips and returns the resolved background state.
 */

import { isVideoUrl } from '@/engine/gpu/TextureLoader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NLEClip {
  id: string;
  url: string;
  name?: string;
  startTime: number;
  endTime: number;
  inPoint: number;
  outPoint: number;
  behavior?: 'speed' | 'loop' | 'pause';
  speed?: number;
  transition?: { duration: number; type?: string };
  opacity?: number;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  brightness?: number;
  angle?: number;
  contrast?: number;
  blur?: number;
  fit?: string;
  tiling?: boolean;
  backgroundColor?: string;
}

export interface SlideshowState {
  currentUrl: string | null;
  nextUrl: string | null;
  mixRatio: number;
  currentType: string;
  nextType: string;
}

interface ResolvedBackground {
  url: string | null;
  nextUrl: string | null;
  mixRatio: number;
  type: string;
  nextType: string;
  activeClip: NLEClip | null;
  inTransition: boolean;
  transitionProgress: number;
  prevClip: NLEClip | null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Given the current NLE clips, current time, and slideshow manager state,
 * resolve which background URL(s) to display and any transition state.
 */
export function resolveNLEClips(
  clips: NLEClip[],
  currentTime: number,
  smState: SlideshowState,
  sceneAssetUrl: string | null | undefined,
): ResolvedBackground {
  const activeClip =
    clips.find((c) => currentTime >= c.startTime && currentTime < c.endTime) ?? null;

  let url = smState.currentUrl;
  let nextUrl = smState.nextUrl;
  let mixRatio = smState.mixRatio;
  let type = smState.currentType;
  let nextType = smState.nextType;

  let inTransition = false;
  let transitionProgress = 0;
  let prevClip: NLEClip | null = null;

  if (clips.length === 0) {
    return {
      url: null,
      nextUrl: null,
      mixRatio: 0,
      type: 'image',
      nextType: 'image',
      activeClip: null,
      inTransition: false,
      transitionProgress: 0,
      prevClip: null,
    };
  }

  if (activeClip) {
    // Check for transition at clip start
    if (activeClip.transition && activeClip.transition.duration > 0) {
      const timeInClip = currentTime - activeClip.startTime;
      if (timeInClip < activeClip.transition.duration) {
        inTransition = true;
        transitionProgress = timeInClip / activeClip.transition.duration;
        prevClip =
          [...clips]
            .sort((a, b) => b.startTime - a.startTime)
            .find((c) => c.endTime <= activeClip.startTime) || null;
      }
    }

    if (inTransition && prevClip) {
      url = prevClip.url;
      nextUrl = activeClip.url;
      mixRatio = transitionProgress;
      type = isVideoUrl(prevClip.url, prevClip.name) ? 'video' : 'image';
      nextType = isVideoUrl(activeClip.url, activeClip.name) ? 'video' : 'image';
    } else if (activeClip.id === 'default-bg-clip' && (smState.currentUrl || sceneAssetUrl)) {
      // Let keyframe/slideshow take precedence over default fallback clip
      url = smState.currentUrl || sceneAssetUrl || activeClip.url;
      nextUrl = smState.nextUrl;
      mixRatio = smState.mixRatio;
      type = smState.currentType;
      nextType = smState.nextType;
    } else {
      url = activeClip.url;
      nextUrl = null;
      mixRatio = 0;
      type = isVideoUrl(activeClip.url, activeClip.name) ? 'video' : 'image';
      nextType = 'image';

      // Lookahead 2 seconds to pre-load upcoming clip in Slot 2
      const upcomingClip = findUpcomingClip(clips, currentTime);
      if (upcomingClip) {
        nextUrl = upcomingClip.url;
        nextType = isVideoUrl(upcomingClip.url, upcomingClip.name) ? 'video' : 'image';
      }
    }
  } else {
    // Timeline is active, but we are in a gap
    url = null;
    nextUrl = null;
    mixRatio = 0;
    type = 'image';
    nextType = 'image';

    // Lookahead 2 seconds to pre-load upcoming clip in Slot 2
    const upcomingClip = findUpcomingClip(clips, currentTime);
    if (upcomingClip) {
      nextUrl = upcomingClip.url;
      nextType = isVideoUrl(upcomingClip.url, upcomingClip.name) ? 'video' : 'image';
    }
  }

  return {
    url,
    nextUrl,
    mixRatio,
    type,
    nextType,
    activeClip,
    inTransition,
    transitionProgress,
    prevClip,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the next clip starting within 2 seconds for preloading. */
function findUpcomingClip(clips: NLEClip[], currentTime: number): NLEClip | null {
  return (
    clips.filter((c) => c.startTime > currentTime).sort((a, b) => a.startTime - b.startTime)[0] ??
    null
  );
  // Only return if within 2 second lookahead window
}

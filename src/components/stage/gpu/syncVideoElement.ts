'use client';

/**
 * syncVideoElement — Synchronize a <video> element to an NLE clip's timeline position.
 *
 * Handles playback rate, loop mode, seek-on-drift, and play/pause toggling.
 * Extracted from GPUCanvas to be reusable across WebGPU and WebGL paths.
 */

interface VideoClipSync {
  startTime: number;
  inPoint: number;
  outPoint: number;
  endTime: number;
  behavior?: 'speed' | 'loop' | 'pause';
  speed?: number;
}

export function syncVideoElement(
  videoEl: HTMLVideoElement,
  clip: VideoClipSync,
  currentTime: number,
  isPlaying: boolean,
  /**
   * When true this is the ONLY background clip on the timeline. A lone clip
   * has no "next" scene to hand off to, so 'pause' (freeze-on-last-frame)
   * has nothing meaningful to hold for — treat it as 'loop' so a single
   * background video repeats by default instead of playing once and freezing.
   * Only affects the pause/default branch; an explicit 'speed' clip is
   * untouched.
   */
  isSoleClip = false,
) {
  const localTime = currentTime - clip.startTime;
  let sourceTime = 0;

  // A single clip with no successor should loop rather than freeze.
  const effectiveBehavior =
    isSoleClip && (clip.behavior === 'pause' || clip.behavior === undefined)
      ? 'loop'
      : clip.behavior;

  const actualOutPoint =
    videoEl.duration && !isNaN(videoEl.duration) && videoEl.duration > 0
      ? Math.min(clip.outPoint, videoEl.duration)
      : clip.outPoint;

  if (effectiveBehavior === 'speed') {
    const clipDuration = clip.endTime - clip.startTime;
    const sourceDur = actualOutPoint - clip.inPoint;
    const speed = clipDuration > 0 ? sourceDur / clipDuration : 1.0;
    sourceTime = clip.inPoint + localTime * speed;

    if (videoEl.playbackRate !== speed) {
      videoEl.playbackRate = speed;
    }
    if (videoEl.loop) {
      videoEl.loop = false;
    }
  } else if (effectiveBehavior === 'loop') {
    const sourceDur = actualOutPoint - clip.inPoint;
    sourceTime =
      sourceDur > 0 ? clip.inPoint + ((localTime * (clip.speed ?? 1.0)) % sourceDur) : clip.inPoint;

    if (videoEl.playbackRate !== (clip.speed ?? 1.0)) {
      videoEl.playbackRate = clip.speed ?? 1.0;
    }
    if (!videoEl.loop) {
      videoEl.loop = true;
    }
  } else if (effectiveBehavior === 'pause') {
    sourceTime = Math.min(actualOutPoint, clip.inPoint + localTime * (clip.speed ?? 1.0));

    if (videoEl.playbackRate !== (clip.speed ?? 1.0)) {
      videoEl.playbackRate = clip.speed ?? 1.0;
    }
    if (videoEl.loop) {
      videoEl.loop = false;
    }
  } else {
    // Default to loop behavior
    const sourceDur = actualOutPoint - clip.inPoint;
    sourceTime =
      sourceDur > 0 ? clip.inPoint + ((localTime * (clip.speed ?? 1.0)) % sourceDur) : clip.inPoint;

    if (videoEl.playbackRate !== (clip.speed ?? 1.0)) {
      videoEl.playbackRate = clip.speed ?? 1.0;
    }
    if (!videoEl.loop) {
      videoEl.loop = true;
    }
  }

  sourceTime = Math.max(clip.inPoint, Math.min(actualOutPoint, sourceTime));

  const drift = Math.abs(videoEl.currentTime - sourceTime);
  if (drift > 0.15) {
    videoEl.currentTime = sourceTime;
  }

  if (isPlaying && videoEl.paused) {
    videoEl.play().catch(() => {});
  } else if (!isPlaying && !videoEl.paused) {
    videoEl.pause();
  }
}

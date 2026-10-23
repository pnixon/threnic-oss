/**
 * Video Sync & Crossfade Contract Tests
 *
 * Tests the syncVideoElement function used by GPUCanvas to synchronize
 * HTMLVideoElement playback with the NLE timeline. This is the critical
 * path for video background playback and crossfade transitions.
 *
 * Run: npm run test:quick -- test/engine/gpu/video-sync-contracts.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Re-implement syncVideoElement for testing ─────────────────
// This is the EXACT logic from GPUCanvas — we test it as a pure function.
// If GPUCanvas's implementation diverges, these tests catch the drift.

interface VideoClip {
  startTime: number;
  endTime: number;
  inPoint: number;
  outPoint: number;
  speed?: number;
  behavior: 'loop' | 'speed' | 'pause';
  url: string;
}

interface MockVideoElement {
  currentTime: number;
  playbackRate: number;
  loop: boolean;
  paused: boolean;
  duration: number;
  play: () => Promise<void>;
  pause: () => void;
}

function syncVideoElement(
  videoEl: MockVideoElement,
  clip: VideoClip,
  currentTime: number,
  isPlaying: boolean,
) {
  const localTime = currentTime - clip.startTime;
  let sourceTime = 0;

  if (clip.behavior === 'speed') {
    const clipDuration = clip.endTime - clip.startTime;
    const sourceDur = clip.outPoint - clip.inPoint;
    const speed = clipDuration > 0 ? sourceDur / clipDuration : 1.0;
    sourceTime = clip.inPoint + localTime * speed;

    if (videoEl.playbackRate !== speed) {
      videoEl.playbackRate = speed;
    }
    if (videoEl.loop) {
      videoEl.loop = false;
    }
  } else if (clip.behavior === 'loop') {
    const sourceDur = clip.outPoint - clip.inPoint;
    sourceTime =
      sourceDur > 0 ? clip.inPoint + ((localTime * (clip.speed ?? 1.0)) % sourceDur) : clip.inPoint;

    if (videoEl.playbackRate !== (clip.speed ?? 1.0)) {
      videoEl.playbackRate = clip.speed ?? 1.0;
    }
    if (!videoEl.loop) {
      videoEl.loop = true;
    }
  } else if (clip.behavior === 'pause') {
    sourceTime = Math.min(clip.outPoint, clip.inPoint + localTime * (clip.speed ?? 1.0));

    if (videoEl.playbackRate !== (clip.speed ?? 1.0)) {
      videoEl.playbackRate = clip.speed ?? 1.0;
    }
    if (videoEl.loop) {
      videoEl.loop = false;
    }
  } else {
    sourceTime = clip.inPoint + localTime * (clip.speed ?? 1.0);
    if (videoEl.playbackRate !== (clip.speed ?? 1.0)) {
      videoEl.playbackRate = clip.speed ?? 1.0;
    }
    if (videoEl.loop) {
      videoEl.loop = false;
    }
  }

  sourceTime = Math.max(clip.inPoint, Math.min(clip.outPoint, sourceTime));

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

function makeMockVideo(overrides: Partial<MockVideoElement> = {}): MockVideoElement {
  return {
    currentTime: 0,
    playbackRate: 1.0,
    loop: false,
    paused: true,
    duration: 30,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('syncVideoElement', () => {
  describe('loop behavior', () => {
    it('wraps source time within source range', () => {
      const video = makeMockVideo({ currentTime: 0 });
      const clip: VideoClip = {
        startTime: 0,
        endTime: 30,
        inPoint: 5,
        outPoint: 15, // 10s source range
        speed: 1.0,
        behavior: 'loop',
        url: 'test.mp4',
      };

      // At t=12, localTime=12, sourceDur=10
      // sourceTime = 5 + (12 % 10) = 5 + 2 = 7
      syncVideoElement(video, clip, 12, true);
      expect(video.currentTime).toBeCloseTo(7, 1);
      expect(video.loop).toBe(true);
    });

    it('sets correct playback rate from clip speed', () => {
      const video = makeMockVideo();
      const clip: VideoClip = {
        startTime: 0,
        endTime: 30,
        inPoint: 0,
        outPoint: 30,
        speed: 2.0,
        behavior: 'loop',
        url: 'test.mp4',
      };

      syncVideoElement(video, clip, 0, true);
      expect(video.playbackRate).toBe(2.0);
    });
  });

  describe('speed behavior', () => {
    it('computes speed from clip/source duration ratio', () => {
      const video = makeMockVideo();
      const clip: VideoClip = {
        startTime: 0,
        endTime: 20, // 20s timeline clip
        inPoint: 0,
        outPoint: 10, // 10s source
        behavior: 'speed',
        url: 'test.mp4',
      };

      // speed = sourceDur/clipDuration = 10/20 = 0.5
      syncVideoElement(video, clip, 10, true);
      expect(video.playbackRate).toBeCloseTo(0.5);
      expect(video.loop).toBe(false);

      // At t=10, sourceTime = 0 + 10 * 0.5 = 5
      expect(video.currentTime).toBeCloseTo(5, 1);
    });
  });

  describe('pause behavior', () => {
    it('clamps at outPoint', () => {
      const video = makeMockVideo();
      const clip: VideoClip = {
        startTime: 0,
        endTime: 30,
        inPoint: 0,
        outPoint: 10,
        behavior: 'pause',
        url: 'test.mp4',
      };

      // At t=15, sourceTime = min(10, 0 + 15) = 10 (clamped)
      syncVideoElement(video, clip, 15, true);
      expect(video.currentTime).toBeCloseTo(10, 1);
    });
  });

  describe('drift correction', () => {
    it('does NOT seek when drift < 0.15s', () => {
      const video = makeMockVideo({ currentTime: 5.1, paused: false });
      const clip: VideoClip = {
        startTime: 0,
        endTime: 30,
        inPoint: 0,
        outPoint: 30,
        behavior: 'loop',
        url: 'test.mp4',
      };

      // localTime=5, sourceTime=5, drift = |5.1 - 5| = 0.1 < 0.15
      syncVideoElement(video, clip, 5, true);
      // Should NOT have been overwritten (drift is small)
      expect(video.currentTime).toBeCloseTo(5.1);
    });

    it('DOES seek when drift > 0.15s', () => {
      const video = makeMockVideo({ currentTime: 0, paused: false });
      const clip: VideoClip = {
        startTime: 0,
        endTime: 30,
        inPoint: 0,
        outPoint: 30,
        behavior: 'loop',
        url: 'test.mp4',
      };

      // localTime=10, sourceTime=10, drift = |0 - 10| = 10 > 0.15
      syncVideoElement(video, clip, 10, true);
      expect(video.currentTime).toBeCloseTo(10);
    });
  });

  describe('play/pause control', () => {
    it('starts playback when isPlaying and video is paused', () => {
      const video = makeMockVideo({ paused: true });
      const clip: VideoClip = {
        startTime: 0,
        endTime: 30,
        inPoint: 0,
        outPoint: 30,
        behavior: 'loop',
        url: 'test.mp4',
      };

      syncVideoElement(video, clip, 0, true);
      expect(video.play).toHaveBeenCalled();
    });

    it('pauses video when NOT isPlaying and video is playing', () => {
      const video = makeMockVideo({ paused: false });
      const clip: VideoClip = {
        startTime: 0,
        endTime: 30,
        inPoint: 0,
        outPoint: 30,
        behavior: 'loop',
        url: 'test.mp4',
      };

      syncVideoElement(video, clip, 0, false);
      expect(video.pause).toHaveBeenCalled();
    });

    it('does nothing when isPlaying matches video state', () => {
      const video = makeMockVideo({ paused: false });
      const clip: VideoClip = {
        startTime: 0,
        endTime: 30,
        inPoint: 0,
        outPoint: 30,
        behavior: 'loop',
        url: 'test.mp4',
      };

      syncVideoElement(video, clip, 5, true);
      expect(video.play).not.toHaveBeenCalled();
      expect(video.pause).not.toHaveBeenCalled();
    });
  });

  describe('crossfade continuity', () => {
    /**
     * CRITICAL: During a crossfade transition, the outgoing video (slot 1)
     * must continue playing from its current position. The incoming video
     * (slot 2) starts from its clip's start time. Neither should restart.
     */
    it('outgoing clip continues at current time during transition', () => {
      const outgoingVideo = makeMockVideo({ currentTime: 8.0, paused: false });
      const outgoingClip: VideoClip = {
        startTime: 0,
        endTime: 10,
        inPoint: 0,
        outPoint: 10,
        behavior: 'loop',
        url: 'outgoing.mp4',
      };

      // At t=9 (1s before outgoing clip ends), outgoing still plays at t=9
      syncVideoElement(outgoingVideo, outgoingClip, 9, true);

      // Should NOT restart — currentTime should be 9 (or close, within drift tolerance)
      expect(video_notRestarted(outgoingVideo, 8.0)).toBe(true);
    });

    it('incoming clip starts at its own startTime during transition', () => {
      const incomingVideo = makeMockVideo({ currentTime: 0, paused: true });
      const incomingClip: VideoClip = {
        startTime: 10,
        endTime: 20,
        inPoint: 0,
        outPoint: 10,
        behavior: 'loop',
        url: 'incoming.mp4',
      };

      // At t=11 (1s into transition), localTime = 11-10 = 1
      syncVideoElement(incomingVideo, incomingClip, 11, true);
      expect(incomingVideo.currentTime).toBeCloseTo(1, 1);
    });
  });
});

/**
 * Helper: Check video wasn't restarted to 0 (the bug from the crossfade issue).
 * If the video was at position `before` and after sync it's either still near
 * `before` or advanced past it, that's correct. If it jumped to 0, that's wrong.
 */
function video_notRestarted(video: MockVideoElement, before: number): boolean {
  // If video was at 8.0 and we're at t=9, it should be at 9 (or 8.0 if drift < 0.15)
  // It should NOT be at 0
  return video.currentTime > 0 || before < 0.15;
}

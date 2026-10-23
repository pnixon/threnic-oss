/**
 * ExportNLEPriority.test.ts
 *
 * Tests for the two crossfade-related fixes in DecoupledExporter:
 *
 * 1. NLE videoClips take priority over effectsConfig.slideshow when both exist.
 *    The Create Slideshow dialog populates NLE videoClips with exact timing
 *    (e.g. 5-second slides), but effectsConfig.slideshow may have a stale
 *    staticDuration (e.g. 10s). The export must skip the slideshow state
 *    machine when videoClips are present.
 *
 * 2. Keyframe-driven scene.assetUrl changes must not overwrite GPU slot 1
 *    while the NLE crossfade is in progress. The keyframes also set
 *    scene.assetUrl for each clip, which races with the NLE path and
 *    causes hard cuts instead of smooth crossfades.
 *
 * These tests exercise the pure-function logic (resolveNLEClips) and
 * the priority/guard conditions extracted from DecoupledExporter.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveNLEClips,
  type NLEClip,
  type SlideshowState,
} from '@/components/stage/gpu/resolveNLEClips';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClip(
  id: string,
  url: string,
  startTime: number,
  endTime: number,
  transition?: { duration: number; type?: string },
): NLEClip {
  return {
    id,
    url,
    name: id,
    startTime,
    endTime,
    inPoint: 0,
    outPoint: endTime - startTime,
    behavior: 'pause',
    speed: 1.0,
    transition,
  };
}

const dummySM: SlideshowState = {
  currentUrl: null,
  nextUrl: null,
  mixRatio: 0,
  currentType: 'image',
  nextType: 'image',
};

// ---------------------------------------------------------------------------
// Fix 1: NLE clips priority over slideshow
// ---------------------------------------------------------------------------
describe('NLE clips priority over slideshow state machine', () => {
  it('resolveNLEClips returns correct active clip at non-transition time', () => {
    const clips = [
      makeClip('clip1', 'img1.jpg', 0, 5),
      makeClip('clip2', 'img2.jpg', 5, 10, { duration: 1, type: 'crossfade' }),
      makeClip('clip3', 'img3.jpg', 10, 15, { duration: 1, type: 'crossfade' }),
    ];

    // Mid-clip1: no transition
    const r1 = resolveNLEClips(clips, 2.5, dummySM, null);
    expect(r1.activeClip?.id).toBe('clip1');
    expect(r1.url).toBe('img1.jpg');
    expect(r1.inTransition).toBe(false);
    expect(r1.transitionProgress).toBe(0);
  });

  it('resolveNLEClips detects crossfade at clip boundary', () => {
    const clips = [
      makeClip('clip1', 'img1.jpg', 0, 5),
      makeClip('clip2', 'img2.jpg', 5, 10, { duration: 1, type: 'crossfade' }),
    ];

    // At t=5.0: clip2 starts, transition begins
    const r = resolveNLEClips(clips, 5.0, dummySM, null);
    expect(r.activeClip?.id).toBe('clip2');
    expect(r.inTransition).toBe(true);
    expect(r.transitionProgress).toBe(0);
    expect(r.prevClip?.id).toBe('clip1');
    expect(r.url).toBe('img1.jpg'); // slot 1 = outgoing
    expect(r.nextUrl).toBe('img2.jpg'); // slot 2 = incoming
  });

  it('resolveNLEClips computes correct transition progress mid-crossfade', () => {
    const clips = [
      makeClip('clip1', 'img1.jpg', 0, 5),
      makeClip('clip2', 'img2.jpg', 5, 10, { duration: 1, type: 'crossfade' }),
    ];

    // At t=5.5: halfway through 1-second transition
    const r = resolveNLEClips(clips, 5.5, dummySM, null);
    expect(r.inTransition).toBe(true);
    expect(r.transitionProgress).toBeCloseTo(0.5, 5);
    expect(r.url).toBe('img1.jpg'); // outgoing in slot 1
    expect(r.nextUrl).toBe('img2.jpg'); // incoming in slot 2
  });

  it('resolveNLEClips transition ends after duration', () => {
    const clips = [
      makeClip('clip1', 'img1.jpg', 0, 5),
      makeClip('clip2', 'img2.jpg', 5, 10, { duration: 1, type: 'crossfade' }),
    ];

    // At t=6.0: transition complete (timeInClip=1.0, duration=1.0)
    const r = resolveNLEClips(clips, 6.0, dummySM, null);
    expect(r.inTransition).toBe(false);
    expect(r.url).toBe('img2.jpg');
    expect(r.activeClip?.id).toBe('clip2');
  });

  it('first clip has no transition — no crossfade at start', () => {
    const clips = [
      makeClip('clip1', 'img1.jpg', 0, 5), // no transition
      makeClip('clip2', 'img2.jpg', 5, 10, { duration: 1, type: 'crossfade' }),
    ];

    const r = resolveNLEClips(clips, 0, dummySM, null);
    expect(r.inTransition).toBe(false);
    expect(r.url).toBe('img1.jpg');
    expect(r.prevClip).toBe(null);
  });

  it('clips with same URL crossfade (same image reused)', () => {
    // Some slideshows reuse the same image
    const clips = [
      makeClip('clip1', 'img1.jpg', 0, 5),
      makeClip('clip2', 'img1.jpg', 5, 10, { duration: 1, type: 'crossfade' }),
    ];

    const r = resolveNLEClips(clips, 5.5, dummySM, null);
    expect(r.inTransition).toBe(true);
    // Both URLs are the same — crossfade still detects
    expect(r.url).toBe('img1.jpg');
    expect(r.nextUrl).toBe('img1.jpg');
  });
});

// ---------------------------------------------------------------------------
// Fix 2: NLE skips slideshow when videoClips exist (priority logic)
// ---------------------------------------------------------------------------
describe('Export priority: videoClips suppress slideshow items', () => {
  /**
   * This test simulates the priority logic from DecoupledExporter init:
   *
   *   const hasNLEClips = (config.videoClips?.length ?? 0) > 0;
   *   const validItems = (!hasNLEClips && slideshowCfg?.items)
   *     ? slideshowCfg.items.filter(...)
   *     : [];
   *   const hasSlideshow = validItems.length > 0;
   */
  function computeSlideshowPriority(
    videoClips: unknown[] | undefined,
    slideshowItems: Array<{ url?: string; failed?: boolean }> | undefined,
  ): { hasSlideshow: boolean; hasNLEClips: boolean } {
    const hasNLEClips = (videoClips?.length ?? 0) > 0;
    const validItems =
      !hasNLEClips && slideshowItems
        ? slideshowItems.filter((item) => !item.failed && !!item.url)
        : [];
    return { hasSlideshow: validItems.length > 0, hasNLEClips };
  }

  it('uses slideshow when only slideshow items exist', () => {
    const result = computeSlideshowPriority(undefined, [{ url: 'img1.jpg', failed: false }]);
    expect(result.hasSlideshow).toBe(true);
    expect(result.hasNLEClips).toBe(false);
  });

  it('uses NLE clips when only videoClips exist', () => {
    const result = computeSlideshowPriority(
      [{ id: '1', url: 'img1.jpg', startTime: 0, endTime: 5 }],
      undefined,
    );
    expect(result.hasSlideshow).toBe(false);
    expect(result.hasNLEClips).toBe(true);
  });

  it('NLE clips suppress slideshow when BOTH exist', () => {
    const result = computeSlideshowPriority(
      [{ id: '1', url: 'img1.jpg', startTime: 0, endTime: 5 }],
      [{ url: 'img1.jpg', failed: false }],
    );
    expect(result.hasSlideshow).toBe(false);
    expect(result.hasNLEClips).toBe(true);
  });

  it('empty videoClips array falls through to slideshow', () => {
    const result = computeSlideshowPriority([], [{ url: 'img1.jpg', failed: false }]);
    expect(result.hasSlideshow).toBe(true);
    expect(result.hasNLEClips).toBe(false);
  });

  it('no items at all → neither path', () => {
    const result = computeSlideshowPriority(undefined, undefined);
    expect(result.hasSlideshow).toBe(false);
    expect(result.hasNLEClips).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: scene.assetUrl guard when NLE handles background
// ---------------------------------------------------------------------------
describe('scene.assetUrl guard prevents slot overwrite during NLE crossfade', () => {
  /**
   * Simulates the guard logic from _resolveFrameState:
   *
   *   const nleHandlesBackground = (config.videoClips?.length ?? 0) > 0;
   *   if (!nleHandlesBackground && scene.assetUrl && scene.assetUrl !== lastAssetUrl) {
   *     // update slot 1
   *   }
   */
  function shouldUpdateSlot1(
    videoClips: unknown[] | undefined,
    sceneAssetUrl: string | undefined,
    lastAssetUrl: string | null,
  ): boolean {
    const nleHandlesBackground = (videoClips?.length ?? 0) > 0;
    if (!nleHandlesBackground && sceneAssetUrl && sceneAssetUrl !== lastAssetUrl) {
      return true;
    }
    return false;
  }

  it('blocks slot 1 update when NLE clips exist', () => {
    // NLE is handling background — keyframe assetUrl must NOT overwrite
    const result = shouldUpdateSlot1(
      [{ id: '1', url: 'img1.jpg' }],
      'img2.jpg', // keyframe wants to set slot 1 to img2
      'img1.jpg',
    );
    expect(result).toBe(false);
  });

  it('allows slot 1 update when no NLE clips', () => {
    // No NLE clips — keyframe-driven assetUrl should apply
    const result = shouldUpdateSlot1(undefined, 'img2.jpg', 'img1.jpg');
    expect(result).toBe(true);
  });

  it('skips update when URL unchanged (no NLE clips)', () => {
    const result = shouldUpdateSlot1(undefined, 'img1.jpg', 'img1.jpg');
    expect(result).toBe(false);
  });

  it('skips update when assetUrl is empty', () => {
    const result = shouldUpdateSlot1(undefined, undefined, 'img1.jpg');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: resolveNLEClips with many clips (slideshow scenario)
// ---------------------------------------------------------------------------
describe('resolveNLEClips integration: 57-clip slideshow', () => {
  function make57Clips(): NLEClip[] {
    const clips: NLEClip[] = [];
    for (let i = 0; i < 57; i++) {
      clips.push(
        makeClip(
          `clip_${i}`,
          `img_${i}.jpg`,
          i * 5,
          (i + 1) * 5,
          i > 0 ? { duration: 1, type: 'crossfade' } : undefined,
        ),
      );
    }
    return clips;
  }

  it('resolves correct clip at each 5-second boundary', () => {
    const clips = make57Clips();

    for (let i = 0; i < 10; i++) {
      const t = i * 5 + 2.5; // middle of each clip
      const r = resolveNLEClips(clips, t, dummySM, null);
      expect(r.activeClip?.id).toBe(`clip_${i}`);
      expect(r.inTransition).toBe(false);
      expect(r.url).toBe(`img_${i}.jpg`);
    }
  });

  it('detects transitions at every clip boundary (except first)', () => {
    const clips = make57Clips();

    for (let i = 1; i < 10; i++) {
      const t = i * 5 + 0.5; // 0.5s into the new clip
      const r = resolveNLEClips(clips, t, dummySM, null);
      expect(r.activeClip?.id).toBe(`clip_${i}`);
      expect(r.inTransition).toBe(true);
      expect(r.transitionProgress).toBeCloseTo(0.5, 5);
      expect(r.prevClip?.id).toBe(`clip_${i - 1}`);
      expect(r.url).toBe(`img_${i - 1}.jpg`); // outgoing
      expect(r.nextUrl).toBe(`img_${i}.jpg`); // incoming
    }
  });

  it('no transition at time 0 (first clip)', () => {
    const clips = make57Clips();
    const r = resolveNLEClips(clips, 0, dummySM, null);
    expect(r.inTransition).toBe(false);
    expect(r.url).toBe('img_0.jpg');
  });

  it('returns null activeClip beyond last clip', () => {
    const clips = make57Clips();
    const r = resolveNLEClips(clips, 57 * 5 + 1, dummySM, null);
    expect(r.activeClip).toBe(null);
  });
});

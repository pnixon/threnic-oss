import { describe, it, expect } from 'vitest';
import { SlideshowStateMachine, type TickSignals } from './SlideshowStateMachine';
import type { SlideshowConfig } from '@/types/effects/background';

/** Helper: build a minimal config with N items. */
function makeConfig(n: number, overrides?: Partial<SlideshowConfig>): SlideshowConfig {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      id: `item-${i}`,
      url: `/img/${i}.jpg`,
      type: 'image' as const,
    })),
    mode: 'slideshow',
    order: 'sequential',
    transition: 'crossfade',
    transitionDuration: 1.0,
    timingMode: 'static',
    staticDuration: 5.0,
    randomDurationMin: 3,
    randomDurationMax: 8,
    videoEndTransition: false,
    ...overrides,
  };
}

describe('SlideshowStateMachine', () => {
  // ─── Basic lifecycle ──────────────────────────────────────────

  it('initialises with currentIndex=0 and correct nextIndex', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3);
    sm.init(3, cfg);
    expect(sm.currentIndex).toBe(0);
    // After init the idle frame should report index 0
    const frame = sm.tick(0.001, cfg);
    expect(frame.currentIndex).toBe(0);
    expect(frame.transitioning).toBe(false);
  });

  it('stays idle when only 1 item', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(1);
    sm.init(1, cfg);
    // Tick well past the slide duration
    const frame = sm.tick(100, cfg);
    expect(frame.currentIndex).toBe(0);
    expect(frame.transitioning).toBe(false);
    expect(frame.indicesChanged).toBe(false);
  });

  // ─── Transition start ─────────────────────────────────────────

  it('starts transition after slide duration elapses', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, { staticDuration: 2.0, transitionDuration: 1.0 });
    sm.init(3, cfg);

    // Advance past the 2s slide duration
    const frame = sm.tick(2.1, cfg);
    expect(frame.transitioning).toBe(true);
    expect(frame.indicesChanged).toBe(true);
    expect(frame.currentIndex).toBe(0);
    expect(frame.nextIndex).toBe(1);
  });

  it('does NOT start transition before slide duration', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, { staticDuration: 5.0 });
    sm.init(3, cfg);

    const frame = sm.tick(3.0, cfg);
    expect(frame.transitioning).toBe(false);
    expect(frame.indicesChanged).toBe(false);
  });

  // ─── Transition progress ──────────────────────────────────────

  it('progress ramps from 0 to 1 over transitionDuration', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(2, { staticDuration: 1.0, transitionDuration: 2.0 });
    sm.init(2, cfg);

    // Advance past show duration to start transition
    sm.tick(1.0, cfg);
    const f1 = sm.tick(0.001, cfg); // just started
    expect(f1.transitioning).toBe(true);
    expect(f1.progress).toBeCloseTo(0, 1);

    // Advance 1s into the 2s transition
    const f2 = sm.tick(1.0, cfg);
    expect(f2.transitioning).toBe(true);
    expect(f2.progress).toBeCloseTo(0.5, 1);
  });

  // ─── Transition completion ────────────────────────────────────

  it('completes transition and advances currentIndex', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, { staticDuration: 1.0, transitionDuration: 1.0 });
    sm.init(3, cfg);

    // Trigger transition at t=1.0
    sm.tick(1.0, cfg);
    // Complete it at t=2.0
    const frame = sm.tick(1.1, cfg);
    expect(frame.transitioning).toBe(false);
    expect(frame.currentIndex).toBe(1); // advanced
    expect(frame.indicesChanged).toBe(true);
  });

  it('wraps around to index 0 in sequential order', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(2, { staticDuration: 1.0, transitionDuration: 0.5 });
    sm.init(2, cfg);

    // First cycle: 0 → 1
    sm.tick(1.5, cfg); // past show + transition
    let frame = sm.tick(0.1, cfg);
    expect(frame.currentIndex).toBe(1);

    // Second cycle: 1 → 0 (wraps)
    sm.tick(1.0, cfg); // show duration
    frame = sm.tick(0.6, cfg); // transition complete
    expect(frame.currentIndex).toBe(0);
  });

  // ─── Video-end signal ─────────────────────────────────────────

  it('starts transition immediately on videoEnded signal', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, { staticDuration: 60.0 }); // very long duration
    sm.init(3, cfg);

    // Video ends well before the slide timer
    const signals: TickSignals = { videoEnded: true };
    const frame = sm.tick(2.0, cfg, signals);
    expect(frame.transitioning).toBe(true);
    expect(frame.indicesChanged).toBe(true);
  });

  // ─── Video fade anticipation ──────────────────────────────────

  it('starts transition early when videoEndTransition detects near-end', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, {
      staticDuration: 60.0,
      transitionDuration: 1.0,
      videoEndTransition: true,
      items: [
        { id: 'v0', url: '/v0.mp4', type: 'video' },
        { id: 'v1', url: '/v1.mp4', type: 'video' },
        { id: 'v2', url: '/v2.mp4', type: 'video' },
      ],
    });
    sm.init(3, cfg);

    // Video is 10s long, currently at 9.5s (within 1s fade window)
    const signals: TickSignals = {
      videoDuration: 10,
      videoCurrentTime: 9.5,
    };
    const frame = sm.tick(9.5, cfg, signals);
    expect(frame.transitioning).toBe(true);
    expect(frame.indicesChanged).toBe(true);
  });

  // ─── Crossfade visuals ────────────────────────────────────────

  it('crossfade: outgoing opacity decreases, incoming increases', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(2, {
      staticDuration: 1.0,
      transitionDuration: 2.0,
      transition: 'crossfade',
    });
    sm.init(2, cfg);

    // Start transition
    sm.tick(1.0, cfg);
    const f = sm.tick(0.001, cfg);
    expect(f.transitioning).toBe(true);

    // At start of crossfade: current (outgoing) should be opaque, next should be transparent
    expect(f.current.opacity).toBeGreaterThan(0.9);
    expect(f.next.opacity).toBeLessThan(0.1);

    // Midway through transition
    const fMid = sm.tick(1.0, cfg);
    expect(fMid.current.opacity).toBeCloseTo(0.5, 1);
    expect(fMid.next.opacity).toBeCloseTo(0.5, 1);
  });

  // ─── Reset ────────────────────────────────────────────────────

  it('reset() clears state back to initial', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, { staticDuration: 1.0, transitionDuration: 1.0 });
    sm.init(3, cfg);

    // Progress into a transition
    sm.tick(1.5, cfg);
    expect(sm.currentIndex).toBe(0);

    // Reset
    sm.reset();
    expect(sm.currentIndex).toBe(0);
    expect(sm.time).toBe(0);

    // After reset, ticking should start fresh
    const frame = sm.tick(0.1, cfg);
    expect(frame.transitioning).toBe(false);
    expect(frame.currentIndex).toBe(0);
  });

  // ─── Bounds checking ──────────────────────────────────────────

  it('clamps currentIndex when itemCount shrinks', () => {
    const sm = new SlideshowStateMachine();
    const cfg5 = makeConfig(5, { staticDuration: 1.0, transitionDuration: 0.5 });
    sm.init(5, cfg5);

    // Advance to index 3
    for (let i = 0; i < 3; i++) {
      sm.tick(1.5, cfg5); // show + transition for each
      sm.tick(0.1, cfg5);
    }

    // Now shrink to 2 items — current index (3) is out of bounds
    const cfg2 = makeConfig(2, { staticDuration: 1.0, transitionDuration: 0.5 });
    const frame = sm.tick(0.1, cfg2);
    expect(frame.currentIndex).toBeLessThan(2);
  });

  // ─── Slide transition visuals ─────────────────────────────────

  it('slideLeft: mid-transition produces horizontal offsets with full opacity', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, {
      staticDuration: 1.0,
      transitionDuration: 2.0,
      transition: 'slideLeft',
    });
    sm.init(3, cfg);

    // Trigger transition
    sm.tick(1.0, cfg);
    const f = sm.tick(1.0, cfg); // 50% through transition

    expect(f.transitioning).toBe(true);
    expect(f.progress).toBeCloseTo(0.5, 1);

    // Both slots should be fully opaque (slide doesn't fade)
    expect(f.current.opacity).toBe(1.0);
    expect(f.next.opacity).toBe(1.0);

    // Current should have moved left (negative offsetX)
    expect(f.current.offsetX).toBeLessThan(0);
    // Next should be approaching from the right (positive offsetX)
    expect(f.next.offsetX).toBeGreaterThan(0);
    // No vertical movement
    expect(f.current.offsetY).toBe(0);
    expect(f.next.offsetY).toBe(0);
  });

  it('slideRight: mid-transition current moves right, next comes from left', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, {
      staticDuration: 1.0,
      transitionDuration: 2.0,
      transition: 'slideRight',
    });
    sm.init(3, cfg);

    sm.tick(1.0, cfg);
    const f = sm.tick(1.0, cfg);

    expect(f.current.offsetX).toBeGreaterThan(0);
    expect(f.next.offsetX).toBeLessThan(0);
    expect(f.current.offsetY).toBe(0);
    expect(f.next.offsetY).toBe(0);
  });

  it('slideUp: mid-transition current moves up, next comes from below', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, {
      staticDuration: 1.0,
      transitionDuration: 2.0,
      transition: 'slideUp',
    });
    sm.init(3, cfg);

    sm.tick(1.0, cfg);
    const f = sm.tick(1.0, cfg);

    expect(f.current.offsetY).toBeGreaterThan(0);
    expect(f.next.offsetY).toBeLessThan(0);
    expect(f.current.offsetX).toBe(0);
    expect(f.next.offsetX).toBe(0);
  });

  it('slideDown: mid-transition current moves down, next comes from above', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, {
      staticDuration: 1.0,
      transitionDuration: 2.0,
      transition: 'slideDown',
    });
    sm.init(3, cfg);

    sm.tick(1.0, cfg);
    const f = sm.tick(1.0, cfg);

    expect(f.current.offsetY).toBeLessThan(0);
    expect(f.next.offsetY).toBeGreaterThan(0);
    expect(f.current.offsetX).toBe(0);
    expect(f.next.offsetX).toBe(0);
  });

  it('slide transition completes with next at center (offset=0)', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(2, {
      staticDuration: 1.0,
      transitionDuration: 1.0,
      transition: 'slideLeft',
    });
    sm.init(2, cfg);

    // Trigger and complete transition
    sm.tick(1.0, cfg);
    const f = sm.tick(1.1, cfg);

    // Transition complete — now at index 1 with default visuals
    expect(f.transitioning).toBe(false);
    expect(f.currentIndex).toBe(1);
    expect(f.current.offsetX).toBe(0);
    expect(f.current.offsetY).toBe(0);
  });

  // ─── Re-init / memory ───────────────────────────────────────

  it('init() resets wallClock to 0', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3);
    sm.init(3, cfg);

    // Accumulate 10s of wall clock
    sm.tick(10, cfg);
    expect(sm.time).toBeGreaterThan(0);

    // Re-init should reset
    sm.init(3, cfg);
    expect(sm.time).toBe(0);

    // First tick after re-init should be idle at index 0
    const frame = sm.tick(0.1, cfg);
    expect(frame.currentIndex).toBe(0);
    expect(frame.transitioning).toBe(false);
  });

  it('re-init after partial playback starts fresh timing', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, { staticDuration: 2.0, transitionDuration: 1.0 });
    sm.init(3, cfg);

    // Tick 3s — past first static + into transition
    sm.tick(3, cfg);

    // Re-init with same config
    sm.init(3, cfg);

    // Tick 0.5s — well before staticDuration=2, should NOT be transitioning
    const frame = sm.tick(0.5, cfg);
    expect(frame.transitioning).toBe(false);
    expect(frame.currentIndex).toBe(0);
  });

  it('re-init resets transition state mid-transition', () => {
    const sm = new SlideshowStateMachine();
    const cfg = makeConfig(3, { staticDuration: 1.0, transitionDuration: 2.0 });
    sm.init(3, cfg);

    // Tick past staticDuration to start transition
    sm.tick(1.0, cfg);
    const mid = sm.tick(0.5, cfg);
    expect(mid.transitioning).toBe(true);

    // Re-init clears transition state
    sm.init(3, cfg);
    const frame = sm.tick(0.1, cfg);
    expect(frame.transitioning).toBe(false);
    expect(frame.currentIndex).toBe(0);
  });
});

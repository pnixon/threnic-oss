/**
 * BgImageOverlayPass.test.ts — unit tests for the secondary-image overlay
 * updater's CPU-side logic: audio-reactive opacity, the optional gate
 * (band > threshold + cooldown), and the fade-in vs pop-to-full choice.
 *
 * These exercise createBgImageOverlayUpdater directly with a fake state +
 * EffectPassParams (no GPU needed) and assert the effective opacity written
 * to uniforms[0].
 */

import { describe, it, expect } from 'vitest';
import {
  createBgImageOverlayUpdater,
  setOverlayImageMeta,
  getOverlayImageMeta,
  type BgImageOverlayPassState,
} from './BgImageOverlayPass';
import type { EffectPassParams } from './RenderGraph';

function params(over: Partial<EffectPassParams> = {}): EffectPassParams {
  return {
    time: 0,
    dt: 1 / 60,
    resolution: [1920, 1080],
    audioBass: 0,
    audioMid: 0,
    audioHigh: 0,
    audioEnergy: 0,
    didReset: false,
    ...over,
  };
}

function baseState(over: Partial<BgImageOverlayPassState> = {}): BgImageOverlayPassState {
  return {
    opacity: 1,
    fit: 'cover',
    blendMode: 'normal',
    hasImage: 1,
    imageW: 100,
    imageH: 100,
    gateFadeIn: true,
    gateAttack: 0.3,
    ...over,
  };
}

describe('bgImageOverlay updater — no gate', () => {
  it('passes base opacity straight through when no gate and no AR', () => {
    const u = new Float32Array(8);
    const update = createBgImageOverlayUpdater(() => baseState({ opacity: 0.8 }));
    update(u, params());
    expect(u[0]).toBeCloseTo(0.8, 5);
    // fit/blend/hasImage encoded
    expect(u[1]).toBe(0); // cover
    expect(u[2]).toBe(0); // normal
    expect(u[3]).toBe(1); // hasImage
  });
});

describe('bgImageOverlay updater — gate (edge-triggered strike)', () => {
  const mkGate = (over: Partial<NonNullable<BgImageOverlayPassState['gate']>> = {}) => ({
    enabled: true as const,
    band: 'bass' as const,
    threshold: 0.5,
    cooldown: 0.5,
    duration: 0.5,
    flash: false,
    ...over,
  });

  it('is off with no signal', () => {
    const u = new Float32Array(8);
    const update = createBgImageOverlayUpdater(() => baseState({ gate: mkGate() }));
    update(u, params({ audioBass: 0.2 }));
    expect(u[0]).toBe(0);
  });

  it('fires on a rising edge and pops to full when gateFadeIn is false', () => {
    const u = new Float32Array(8);
    const update = createBgImageOverlayUpdater(() =>
      baseState({ opacity: 1, gate: mkGate({ duration: 1.0 }), gateFadeIn: false }),
    );
    update(u, params({ audioBass: 0.0, time: 0.9 })); // below → arms edge
    update(u, params({ audioBass: 0.9, time: 1.0 })); // rising edge → fire
    expect(u[0]).toBeCloseTo(1, 5);
  });

  it('stays on for `duration` then turns off (independent of signal)', () => {
    const state = baseState({ opacity: 1, gate: mkGate({ duration: 0.4 }), gateFadeIn: false });
    const update = createBgImageOverlayUpdater(() => state);
    const u = new Float32Array(8);

    update(u, params({ audioBass: 0.0, time: 0.9 }));
    update(u, params({ audioBass: 0.9, time: 1.0 })); // fire
    expect(u[0]).toBeCloseTo(1, 5);
    // Signal already dropped, but within duration → still on.
    update(u, params({ audioBass: 0.0, time: 1.3 }));
    expect(u[0]).toBeCloseTo(1, 5);
    // Past duration → off.
    update(u, params({ audioBass: 0.0, time: 1.5 }));
    expect(u[0]).toBe(0);
  });

  it('supports very short durations down to 0.01s', () => {
    const state = baseState({ opacity: 1, gate: mkGate({ duration: 0.01 }), gateFadeIn: false });
    const update = createBgImageOverlayUpdater(() => state);
    const u = new Float32Array(8);
    update(u, params({ audioBass: 0.0, time: 0.9 }));
    update(u, params({ audioBass: 0.9, time: 1.0 })); // fire
    expect(u[0]).toBeCloseTo(1, 5);
    update(u, params({ audioBass: 0.9, time: 1.02 })); // 0.02s later → past 0.01 duration
    expect(u[0]).toBe(0);
  });

  it('cooldown blocks re-firing (a lock, not a sustain)', () => {
    const state = baseState({
      opacity: 1,
      gate: mkGate({ duration: 0.1, cooldown: 1.0 }),
      gateFadeIn: false,
    });
    const update = createBgImageOverlayUpdater(() => state);
    const u = new Float32Array(8);

    update(u, params({ audioBass: 0.0, time: 0.0 }));
    update(u, params({ audioBass: 0.9, time: 0.1 })); // fire #1
    expect(u[0]).toBeCloseTo(1, 5);
    update(u, params({ audioBass: 0.0, time: 0.3 })); // past 0.1 duration → off
    expect(u[0]).toBe(0);

    // New rising edge at t=0.5, but only 0.4s since last fire < 1.0 cooldown → blocked.
    update(u, params({ audioBass: 0.9, time: 0.5 }));
    expect(u[0]).toBe(0);

    // Rising edge after cooldown (t=1.2, 1.1s since fire) → fires again.
    update(u, params({ audioBass: 0.0, time: 1.1 })); // reset edge
    update(u, params({ audioBass: 0.9, time: 1.2 }));
    expect(u[0]).toBeCloseTo(1, 5);
  });

  it('fades in linearly over gateAttack when gateFadeIn is true', () => {
    const state = baseState({
      opacity: 1,
      gate: mkGate({ duration: 2.0, cooldown: 0 }),
      gateFadeIn: true,
      gateAttack: 0.4,
    });
    const update = createBgImageOverlayUpdater(() => state);
    const u = new Float32Array(8);
    update(u, params({ audioBass: 0.0, time: 0.9 }));
    update(u, params({ audioBass: 0.9, time: 1.0 })); // fire
    expect(u[0]).toBeCloseTo(0, 2);
    update(u, params({ audioBass: 0.9, time: 1.2 })); // halfway
    expect(u[0]).toBeGreaterThan(0.3);
    expect(u[0]).toBeLessThan(0.7);
    update(u, params({ audioBass: 0.9, time: 1.5 })); // past attack
    expect(u[0]).toBeCloseTo(1, 5);
  });

  it('flash mode strobes and decays across the strike', () => {
    const state = baseState({
      opacity: 1,
      gate: mkGate({ duration: 1.0, flash: true }),
      gateFadeIn: false,
    });
    const update = createBgImageOverlayUpdater(() => state);
    const u = new Float32Array(8);
    update(u, params({ audioBass: 0.0, time: 0.0 }));
    update(u, params({ audioBass: 0.9, time: 0.1 })); // fire → bright at start
    const early = u[0];
    expect(early).toBeGreaterThan(0.5);
    // Late in the strike → decayed dimmer than the start.
    update(u, params({ audioBass: 0.9, time: 0.95 }));
    expect(u[0]).toBeLessThan(early);
  });

  it('resets the latch on didReset (seek)', () => {
    const state = baseState({
      opacity: 1,
      gate: mkGate({ duration: 5.0, cooldown: 2.0 }),
      gateFadeIn: false,
    });
    const update = createBgImageOverlayUpdater(() => state);
    const u = new Float32Array(8);
    update(u, params({ audioBass: 0.0, time: 4.9 }));
    update(u, params({ audioBass: 0.9, time: 5.0 })); // fire
    expect(u[0]).toBeCloseTo(1, 5);
    // Seek back with didReset + no signal → latch cleared → off.
    update(u, params({ audioBass: 0.0, time: 0.0, didReset: true }));
    expect(u[0]).toBe(0);
  });
});

describe('bgImageOverlay image-meta registry', () => {
  it('round-trips ready/width/height by asset id and clears on null', () => {
    setOverlayImageMeta('asset-1', { ready: true, width: 800, height: 600 });
    expect(getOverlayImageMeta('asset-1')).toEqual({ ready: true, width: 800, height: 600 });
    setOverlayImageMeta('asset-1', null);
    expect(getOverlayImageMeta('asset-1')).toEqual({ ready: false, width: 1, height: 1 });
    // Unknown / undefined id defaults to not-ready.
    expect(getOverlayImageMeta(undefined)).toEqual({ ready: false, width: 1, height: 1 });
  });
});

/**
 * fitUV semantics guard.
 *
 * The overlay fit math lives in WGSL (`fitUV` in BgImageOverlayPass.ts). This
 * mirrors it in JS so the cover/contain branch mapping can't silently invert
 * again (a prior bug made COVER render as a centered letterboxed strip when the
 * image aspect and frame aspect differed, e.g. a landscape image in a portrait
 * frame). Keep this mirror IN SYNC with the WGSL `fitUV`.
 *
 * ouv = (uv - 0.5) / scale + 0.5.  scale > 1 on an axis crops (COVER fills that
 * axis); scale < 1 letterboxes (CONTAIN).
 */
function fitUVScale(fit: 'cover' | 'contain' | 'stretch', frameAspect: number, imgAspect: number) {
  if (fit === 'stretch') return { x: 1, y: 1 };
  if (fit === 'cover') {
    return frameAspect > imgAspect
      ? { x: 1, y: frameAspect / imgAspect }
      : { x: imgAspect / frameAspect, y: 1 };
  }
  // contain
  return frameAspect > imgAspect
    ? { x: imgAspect / frameAspect, y: 1 }
    : { x: 1, y: frameAspect / imgAspect };
}

function sampledRange(scale: number) {
  // ouv at uv=0 and uv=1: (0-0.5)/scale+0.5 and (1-0.5)/scale+0.5
  return { lo: -0.5 / scale + 0.5, hi: 0.5 / scale + 0.5 };
}

describe('bgImageOverlay fitUV semantics', () => {
  const portrait = 9 / 16 / 1; // 0.5625 (9:16 frame)
  const landscapeImg = 16 / 9; // 1.777 (landscape image)

  it('COVER of a landscape image in a portrait frame fills the frame (crops width, full height)', () => {
    const s = fitUVScale('cover', portrait, landscapeImg);
    // Crop width => scale.x > 1; full height => scale.y == 1.
    expect(s.x).toBeGreaterThan(1);
    expect(s.y).toBe(1);
    // Y samples the entire image edge-to-edge (no letterbox top/bottom).
    const ry = sampledRange(s.y);
    expect(ry.lo).toBeCloseTo(0, 5);
    expect(ry.hi).toBeCloseTo(1, 5);
    // X samples a centered sub-range strictly inside [0,1] (cropped sides).
    const rx = sampledRange(s.x);
    expect(rx.lo).toBeGreaterThan(0);
    expect(rx.hi).toBeLessThan(1);
  });

  it('CONTAIN of a landscape image in a portrait frame letterboxes (full width, empty top/bottom)', () => {
    const s = fitUVScale('contain', portrait, landscapeImg);
    expect(s.x).toBe(1);
    expect(s.y).toBeLessThan(1);
    // Y sampled range spills outside [0,1] => letterbox margins top/bottom.
    const ry = sampledRange(s.y);
    expect(ry.lo).toBeLessThan(0);
    expect(ry.hi).toBeGreaterThan(1);
  });

  it('COVER of a portrait image in a landscape frame crops height, full width', () => {
    const landscapeFrame = 16 / 9;
    const portraitImg = 9 / 16;
    const s = fitUVScale('cover', landscapeFrame, portraitImg);
    expect(s.x).toBe(1);
    expect(s.y).toBeGreaterThan(1);
  });

  it('COVER of a matching-aspect image is identity (no crop, no letterbox)', () => {
    const s = fitUVScale('cover', 1.5, 1.5);
    expect(s.x).toBeCloseTo(1, 5);
    expect(s.y).toBeCloseTo(1, 5);
  });

  it('STRETCH ignores aspect entirely', () => {
    const s = fitUVScale('stretch', 9 / 16, 16 / 9);
    expect(s).toEqual({ x: 1, y: 1 });
  });
});

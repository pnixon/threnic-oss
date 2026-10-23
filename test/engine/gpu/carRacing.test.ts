import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CarRacingScene } from '@/engine/gpu/littlejs/scenes/carRacing';
import { audioStore } from '@/engine/stores/audioStore';
import type { AudioReactiveData } from '@/engine/gpu/littlejs/types';

/**
 * Contract tests for the Car Racing (Outrun-style pseudo-3D) game scene.
 *
 * Covers the four load-bearing invariants:
 *  1. transparent-first render (full-canvas clearRect when no backdrop),
 *  2. resolution independence (scale ~1 at HD, ~2 at 4K; proportional layout),
 *  3. monotonic road phase (never backtracks, including on a seek reset),
 *  4. asset-driven backdrop (empty background = no backdrop).
 */

const HD: [number, number] = [1920, 1080];
const UHD: [number, number] = [3840, 2160];
const SD: [number, number] = [1280, 720];

function makeAudio(overrides: Partial<AudioReactiveData> = {}): AudioReactiveData {
  return {
    bass: 0,
    mid: 0,
    treb: 0,
    beat: false,
    amplitude: 0,
    bpm: 120,
    time: 0,
    duration: 0,
    ...overrides,
  };
}

/**
 * Minimal recording 2D context — records op + numeric args. Includes clearRect
 * and gradient factories the scene depends on (jsdom getContext('2d') returns
 * null, so we never touch a real canvas).
 */
function makeRecordingCtx() {
  const calls: Array<{ op: string; args: number[] }> = [];
  const rec =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({ op, args: args.filter((a): a is number => typeof a === 'number') });

  const ctx = {
    calls,
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(rec('clearRect')),
    translate: vi.fn(rec('translate')),
    scale: vi.fn(rec('scale')),
    rotate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(rec('moveTo')),
    lineTo: vi.fn(rec('lineTo')),
    closePath: vi.fn(),
    arc: vi.fn(rec('arc')),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(rec('fillRect')),
    strokeRect: vi.fn(rec('strokeRect')),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    drawImage: vi.fn(rec('drawImage')),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    fillStyle: '',
    strokeStyle: '',
    lineCap: 'round',
  };
  return ctx as unknown as CanvasRenderingContext2D & { calls: typeof calls };
}

function fullCanvasClears(
  ctx: { calls: Array<{ op: string; args: number[] }> },
  w: number,
  h: number,
): number {
  return ctx.calls.filter((c) => c.op === 'clearRect' && c.args[2] === w && c.args[3] === h).length;
}

function makeScene(size: [number, number] = HD, offline = false): CarRacingScene {
  const scene = new CarRacingScene(...size);
  scene.init(...size);
  if (offline) scene.setOffline(true);
  return scene;
}

interface SceneInternals {
  _scale: number;
  _roadPhase: number;
  _bgUrl: string;
  horizonY: number;
  roadBottomWidth: number;
}
const peek = (s: CarRacingScene): SceneInternals => s as unknown as SceneInternals;

describe('CarRacingScene', () => {
  beforeEach(() => {
    audioStore.setState({ energy: 0, bass: 0, mid: 0, high: 0 });
  });

  describe('transparent-first render', () => {
    it('issues a full-canvas clearRect each frame when there is no backdrop', () => {
      const scene = makeScene();
      const ctx = makeRecordingCtx();
      scene.update(makeAudio());
      scene.render(makeAudio(), ctx);
      expect(fullCanvasClears(ctx, HD[0], HD[1])).toBeGreaterThan(0);
    });

    it('never paints an opaque full-canvas backdrop when no background is set', () => {
      const scene = makeScene();
      const ctx = makeRecordingCtx();
      scene.update(makeAudio());
      scene.render(makeAudio(), ctx);
      // No drawImage should cover the whole canvas (backdrop is gated on a
      // loaded custom bg image, which never loads in jsdom).
      for (const d of ctx.calls.filter((c) => c.op === 'drawImage')) {
        const w = d.args[d.args.length - 2];
        const h = d.args[d.args.length - 1];
        expect(w >= HD[0] && h >= HD[1]).toBe(false);
      }
    });
  });

  describe('resolution independence', () => {
    it('derives ~1x art scale at HD and ~2x at 4K', () => {
      expect(peek(makeScene(HD))._scale).toBeCloseTo(1, 6);
      expect(peek(makeScene(UHD))._scale).toBeCloseTo(2, 6);
    });

    it('scales below 1 for resolutions smaller than the design size', () => {
      expect(peek(makeScene(SD))._scale).toBeCloseTo(720 / 1080, 6);
    });

    it('keeps horizon and road layout proportional across resolutions', () => {
      const hd = peek(makeScene(HD));
      const uhd = peek(makeScene(UHD));
      expect(uhd.horizonY / UHD[1]).toBeCloseTo(hd.horizonY / HD[1], 6);
      expect(uhd.roadBottomWidth / UHD[0]).toBeCloseTo(hd.roadBottomWidth / HD[0], 6);
    });

    it('re-derives scale on setSize', () => {
      const scene = makeScene(HD);
      scene.setSize(...UHD);
      expect(peek(scene)._scale).toBeCloseTo(2, 6);
    });

    it('ignores degenerate sizes rather than producing NaN geometry', () => {
      const scene = makeScene(HD);
      scene.setSize(0, 0);
      expect(Number.isFinite(peek(scene)._scale)).toBe(true);
      expect(peek(scene)._scale).toBeCloseTo(1, 6);
    });

    it('draws proportionally larger road geometry at 4K than at HD', () => {
      const audio = makeAudio({ amplitude: 0.5 });
      const hdCtx = makeRecordingCtx();
      const hd = makeScene(HD);
      hd.update(audio);
      hd.render(audio, hdCtx);
      const uhdCtx = makeRecordingCtx();
      const uhd = makeScene(UHD);
      uhd.update(audio);
      uhd.render(audio, uhdCtx);

      const maxFill = (ctx: { calls: Array<{ op: string; args: number[] }> }) =>
        ctx.calls
          .filter((c) => c.op === 'fillRect')
          .reduce((m, c) => Math.max(m, Math.abs(c.args[2] ?? 0)), 0);

      const hdMax = maxFill(hdCtx as never);
      const uhdMax = maxFill(uhdCtx as never);
      expect(hdMax).toBeGreaterThan(0);
      expect(uhdMax / hdMax).toBeCloseTo(2, 1);
    });
  });

  describe('monotonic road phase', () => {
    it('strictly increases as audio.time advances', () => {
      const scene = makeScene();
      let last = peek(scene)._roadPhase;
      for (let i = 1; i <= 200; i++) {
        scene.update(makeAudio({ time: i * 0.05, amplitude: (i % 7) / 7 }));
        const phase = peek(scene)._roadPhase;
        expect(phase).toBeGreaterThan(last);
        last = phase;
      }
    });

    it('does not backtrack when a value it reacts to decreases', () => {
      const scene = makeScene();
      // amplitude oscillates (rises and falls); phase must still be monotonic.
      let last = peek(scene)._roadPhase;
      const amps = [0.9, 0.1, 0.8, 0.05, 1, 0.2, 0.6];
      let t = 0;
      for (let i = 0; i < 100; i++) {
        t += 0.03;
        scene.update(makeAudio({ time: t, amplitude: amps[i % amps.length] }));
        const phase = peek(scene)._roadPhase;
        expect(phase).toBeGreaterThanOrEqual(last);
        last = phase;
      }
    });

    it('does not jump backward when audio.time resets to 0 on a seek, after reset() clears it', () => {
      const scene = makeScene();
      for (let i = 1; i <= 50; i++) scene.update(makeAudio({ time: i * 0.1 }));
      const advanced = peek(scene)._roadPhase;
      expect(advanced).toBeGreaterThan(0);

      // Seek: reset clears the accumulator, then time restarts at 0.
      scene.reset();
      expect(peek(scene)._roadPhase).toBe(0);

      // A raw-time modulo would have jumped; the accumulator climbs cleanly.
      let last = 0;
      for (let i = 1; i <= 10; i++) {
        scene.update(makeAudio({ time: i * 0.1 }));
        const phase = peek(scene)._roadPhase;
        expect(phase).toBeGreaterThan(last);
        last = phase;
      }
      // And it is well below where it was before the seek (fresh start).
      expect(last).toBeLessThan(advanced);
    });

    it('is export-safe: phase advances identically in offline mode', () => {
      const live = makeScene(HD, false);
      const off = makeScene(HD, true);
      for (let i = 1; i <= 30; i++) {
        const a = makeAudio({ time: i * 0.1 });
        live.update(a);
        off.update(a);
      }
      // Offline uses audio.time for the clock too, so the road phase matches.
      expect(peek(off)._roadPhase).toBeCloseTo(peek(live)._roadPhase, 6);
    });
  });

  describe('asset-driven backdrop', () => {
    it('leaves _bgUrl empty when setAssetUrls is given an empty background', () => {
      const scene = makeScene();
      scene.setAssetUrls({ background: 'blob:fake-bg' });
      scene.setAssetUrls({ background: '' });
      expect(peek(scene)._bgUrl).toBe('');
    });

    it('starts with no backdrop URL', () => {
      expect(peek(makeScene())._bgUrl).toBe('');
    });
  });

  describe('offline asset readiness', () => {
    it('settles even when sprite loads never fire load or error', async () => {
      const scene = makeScene(HD, true);
      await expect(scene.whenAssetsReady(20)).resolves.toBeUndefined();
    });
  });
});

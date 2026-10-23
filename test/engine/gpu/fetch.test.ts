import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FetchScene } from '@/engine/gpu/littlejs/scenes/fetch';
import { audioStore } from '@/engine/stores/audioStore';
import type { AudioReactiveData } from '@/engine/gpu/littlejs/types';

/**
 * Contract tests for the Fetch (Boy & Dog) game scene.
 *
 * Covers the four invariants shared by every game scene:
 *  1. Transparent-first — a full-canvas clearRect each frame when no backdrop.
 *  2. Resolution independence — proportional anchors + a 1x/2x art scale.
 *  3. Offline/live parity — throws trigger from per-frame audio offline, and
 *     from the live store (not per-frame audio) live.
 *  4. Asset-driven backdrop — an empty background URL means "no backdrop".
 */

const HD: [number, number] = [1920, 1080];
const UHD: [number, number] = [3840, 2160];

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

/** Minimal recording 2D context — records op + numeric args. */
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
    translate: vi.fn(rec('translate')),
    scale: vi.fn(rec('scale')),
    rotate: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(rec('arc')),
    stroke: vi.fn(),
    fill: vi.fn(),
    clearRect: vi.fn(rec('clearRect')),
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

function fullCanvasClears(ctx: { calls: Array<{ op: string; args: number[] }> }): number {
  return ctx.calls.filter((c) => c.op === 'clearRect' && c.args[2] === HD[0] && c.args[3] === HD[1])
    .length;
}

interface SceneInternals {
  boyX: number;
  boyY: number;
  dogX: number;
  dogState: string;
  _scale: number;
  _offline: boolean;
  _bgUrl: string;
}

const peek = (scene: FetchScene): SceneInternals => scene as unknown as SceneInternals;

function makeScene(offline: boolean, size: [number, number] = HD): FetchScene {
  const scene = new FetchScene(...size);
  scene.init(...size);
  if (offline) scene.setOffline(true);
  return scene;
}

/** Drive one frame and report whether a throw started (dog left idle). */
function threwStick(scene: FetchScene, audio: AudioReactiveData): boolean {
  const before = peek(scene).dogState;
  scene.update(audio);
  return before === 'idle' && peek(scene).dogState !== 'idle';
}

describe('FetchScene', () => {
  beforeEach(() => {
    audioStore.setState({ energy: 0, bass: 0, mid: 0, high: 0 });
  });

  afterEach(() => {
    audioStore.setState({ energy: 0, bass: 0, mid: 0, high: 0 });
    vi.restoreAllMocks();
  });

  describe('transparent-first rendering', () => {
    it('issues a full-canvas clearRect each frame when there is no backdrop', () => {
      const scene = makeScene(false);
      const ctx = makeRecordingCtx();

      scene.update(makeAudio());
      scene.render(makeAudio(), ctx);

      expect(fullCanvasClears(ctx)).toBeGreaterThan(0);
    });

    it('never draws a full-canvas backdrop when there is no background', () => {
      const scene = makeScene(false);
      const ctx = makeRecordingCtx();

      scene.update(makeAudio());
      scene.render(makeAudio(), ctx);

      const drawImages = ctx.calls.filter((c) => c.op === 'drawImage');
      for (const d of drawImages) {
        const w = d.args[d.args.length - 2];
        const h = d.args[d.args.length - 1];
        const coversCanvas = w >= HD[0] && h >= HD[1];
        expect(coversCanvas).toBe(false);
      }
    });
  });

  describe('resolution independence', () => {
    it('places the boy anchor at the same relative position at 4K as at HD', () => {
      const hd = makeScene(false, HD);
      const uhd = makeScene(false, UHD);

      expect(peek(uhd).boyX / UHD[0]).toBeCloseTo(peek(hd).boyX / HD[0], 6);
      expect(peek(uhd).boyY / UHD[1]).toBeCloseTo(peek(hd).boyY / HD[1], 6);
    });

    it('derives a 2x art scale at 4K and 1x at the design resolution', () => {
      const hd = makeScene(false, HD);
      const uhd = makeScene(false, UHD);

      expect(peek(hd)._scale).toBeCloseTo(1, 6);
      expect(peek(uhd)._scale).toBeCloseTo(2, 6);
    });

    it('updates the boy anchor and scale via setSize', () => {
      const scene = makeScene(false, HD);
      const before = peek(scene).boyX;
      scene.setSize(...UHD);
      expect(peek(scene).boyX).toBeCloseTo(before * 2, 4);
      expect(peek(scene)._scale).toBeCloseTo(2, 6);
    });

    it('ignores degenerate sizes rather than producing NaN geometry', () => {
      const scene = makeScene(false, HD);
      scene.setSize(0, 0);
      expect(Number.isFinite(peek(scene)._scale)).toBe(true);
      expect(Number.isFinite(peek(scene).boyX)).toBe(true);
      expect(peek(scene)._scale).toBeCloseTo(1, 6);
    });
  });

  describe('offline throw triggering', () => {
    it('fires from per-frame audio while the live store is silent (offline)', () => {
      const scene = makeScene(true);
      expect(threwStick(scene, makeAudio({ bass: 0.95, time: 0 }))).toBe(true);
    });

    it('does NOT fire from per-frame audio in live mode (store is the source)', () => {
      const scene = makeScene(false);
      expect(threwStick(scene, makeAudio({ bass: 0.95, time: 0 }))).toBe(false);
    });

    it('still fires from the live store in live mode', () => {
      audioStore.setState({ bass: 0.95 });
      const scene = makeScene(false);
      expect(threwStick(scene, makeAudio({ bass: 0, time: 0 }))).toBe(true);
    });

    it('ignores the live store entirely while offline', () => {
      audioStore.setState({ bass: 0.95 });
      const scene = makeScene(true);
      expect(threwStick(scene, makeAudio({ bass: 0, time: 0 }))).toBe(false);
    });

    it('clears the throw stamp when switching clocks', () => {
      const scene = makeScene(false);
      audioStore.setState({ bass: 0.95 });
      scene.update(makeAudio({ bass: 0 }));
      const liveStamp = (scene as unknown as { _lastThrowTime: number })._lastThrowTime;
      expect(liveStamp).toBeGreaterThan(0);

      scene.setOffline(true);
      expect((scene as unknown as { _lastThrowTime: number })._lastThrowTime).toBe(-Infinity);
    });
  });

  describe('asset-driven backdrop', () => {
    it('leaves _bgUrl empty when setAssetUrls is given an empty background', () => {
      const scene = makeScene(false);
      scene.setAssetUrls({ background: 'blob:fake-bg' });
      scene.setAssetUrls({ background: '' });
      expect(peek(scene)._bgUrl).toBe('');
    });

    it('never sets a default background URL', () => {
      const scene = makeScene(false);
      expect(peek(scene)._bgUrl).toBe('');
    });
  });

  describe('asset readiness', () => {
    it('settles even when sprite loads never fire load or error', async () => {
      const scene = makeScene(true);
      await expect(scene.whenAssetsReady(20)).resolves.toBeUndefined();
    });
  });

  describe('params', () => {
    it('applies and clamps throwBand, dogSpeed, wagIntensity', () => {
      const scene = makeScene(false);
      scene.setParams({ throwBand: 'treb', dogSpeed: 99, wagIntensity: 5 });
      const inner = scene as unknown as {
        _throwBand: string;
        _dogSpeed: number;
        _wagIntensity: number;
      };
      expect(inner._throwBand).toBe('treb');
      expect(inner._dogSpeed).toBe(4); // clamped to max
      expect(inner._wagIntensity).toBe(1); // clamped to [0,1]
    });
  });
});

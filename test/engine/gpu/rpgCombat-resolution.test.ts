import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RpgCombatScene } from '@/engine/gpu/littlejs/scenes/rpgCombat';
import type { AudioReactiveData } from '@/engine/gpu/littlejs/types';

/**
 * Resolution-independence contract for the RPG Combat game scene.
 *
 * The scene authors all art constants against a 1920x1080 design resolution and
 * scales them at draw time, so a 4K export must produce proportionally larger
 * art rather than the same pixel sizes on a bigger canvas.
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
 * Minimal 2D context recorder. We only need to know the magnitude of the
 * geometry the scene emits, not to actually rasterize anything.
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

/** Largest fillRect width emitted — a proxy for overall art scale. */
function maxFillRectWidth(ctx: { calls: Array<{ op: string; args: number[] }> }): number {
  return ctx.calls
    .filter((c) => c.op === 'fillRect')
    .reduce((max, c) => Math.max(max, Math.abs(c.args[2] ?? 0)), 0);
}

describe('RpgCombatScene resolution independence', () => {
  let scene: RpgCombatScene;

  beforeEach(() => {
    scene = new RpgCombatScene(...HD);
    scene.init(...HD);
  });

  describe('character anchors scale proportionally', () => {
    it('places characters at the same relative position at 4K as at HD', () => {
      const hd = new RpgCombatScene(...HD);
      hd.init(...HD);
      const uhd = new RpgCombatScene(...UHD);
      uhd.init(...UHD);

      // Anchors are proportional, so ratios must match across resolutions.
      const hdAny = hd as unknown as { leftX: number; leftY: number; rightX: number };
      const uhdAny = uhd as unknown as { leftX: number; leftY: number; rightX: number };

      expect(uhdAny.leftX / UHD[0]).toBeCloseTo(hdAny.leftX / HD[0], 6);
      expect(uhdAny.leftY / UHD[1]).toBeCloseTo(hdAny.leftY / HD[1], 6);
      expect(uhdAny.rightX / UHD[0]).toBeCloseTo(hdAny.rightX / HD[0], 6);
    });

    it('derives a 2x art scale at 4K and 1x at the design resolution', () => {
      const hd = new RpgCombatScene(...HD);
      hd.init(...HD);
      const uhd = new RpgCombatScene(...UHD);
      uhd.init(...UHD);

      expect((hd as unknown as { _scale: number })._scale).toBeCloseTo(1, 6);
      expect((uhd as unknown as { _scale: number })._scale).toBeCloseTo(2, 6);
    });

    it('scales below 1 for resolutions smaller than the design size', () => {
      const sd = new RpgCombatScene(...SD);
      sd.init(...SD);
      expect((sd as unknown as { _scale: number })._scale).toBeLessThan(1);
      expect((sd as unknown as { _scale: number })._scale).toBeCloseTo(720 / 1080, 6);
    });
  });

  describe('setSize', () => {
    it('repositions characters when resolution changes', () => {
      const before = (scene as unknown as { leftX: number }).leftX;
      scene.setSize(...UHD);
      const after = (scene as unknown as { leftX: number }).leftX;

      expect(after).toBeCloseTo(before * 2, 4);
    });

    it('updates the art scale factor', () => {
      scene.setSize(...UHD);
      expect((scene as unknown as { _scale: number })._scale).toBeCloseTo(2, 6);
    });

    it('is a no-op when dimensions are unchanged', () => {
      const leftX = (scene as unknown as { leftX: number }).leftX;
      scene.setSize(...HD);
      expect((scene as unknown as { leftX: number }).leftX).toBe(leftX);
    });

    it('ignores degenerate sizes rather than producing NaN geometry', () => {
      scene.setSize(0, 0);
      const s = scene as unknown as { _scale: number; leftX: number };
      expect(Number.isFinite(s._scale)).toBe(true);
      expect(Number.isFinite(s.leftX)).toBe(true);
      expect(s._scale).toBeCloseTo(1, 6);
    });

    it('clears transient effects that belong to the old coordinate space', () => {
      // Drive a frame with loud audio to populate particles.
      scene.update(makeAudio({ treb: 0.95, bass: 0.95, amplitude: 1 }));
      const populated = scene as unknown as {
        particles: unknown[];
        damageNumbers: unknown[];
        slashes: unknown[];
        shakeX: number;
      };
      expect(populated.particles.length).toBeGreaterThan(0);

      scene.setSize(...UHD);

      expect(populated.particles).toHaveLength(0);
      expect(populated.damageNumbers).toHaveLength(0);
      expect(populated.slashes).toHaveLength(0);
      expect(populated.shakeX).toBe(0);
    });

    it('keeps the camera on the focused character after a resize', () => {
      scene.setSize(...UHD);
      const s = scene as unknown as {
        cameraX: number;
        cameraFocus: 'left' | 'right';
        leftX: number;
        rightX: number;
      };
      const expected = s.cameraFocus === 'left' ? s.leftX : s.rightX;
      expect(s.cameraX).toBeCloseTo(expected, 4);
    });
  });

  describe('emitted geometry scales with resolution', () => {
    it('draws proportionally larger art at 4K than at HD', () => {
      const audio = makeAudio({ amplitude: 0.5 });

      const hd = new RpgCombatScene(...HD);
      hd.init(...HD);
      const hdCtx = makeRecordingCtx();
      hd.update(audio);
      hd.render(audio, hdCtx);

      const uhd = new RpgCombatScene(...UHD);
      uhd.init(...UHD);
      const uhdCtx = makeRecordingCtx();
      uhd.update(audio);
      uhd.render(audio, uhdCtx);

      const hdMax = maxFillRectWidth(hdCtx as never);
      const uhdMax = maxFillRectWidth(uhdCtx as never);

      expect(hdMax).toBeGreaterThan(0);
      // Full-screen overlays scale with the canvas (2x), and so should art.
      expect(uhdMax).toBeGreaterThan(hdMax);
      expect(uhdMax / hdMax).toBeCloseTo(2, 1);
    });

    it('scales the life bar with resolution', () => {
      const audio = makeAudio();

      const readBarWidth = (w: number, h: number): number => {
        const sc = new RpgCombatScene(w, h);
        sc.init(w, h);
        const ctx = makeRecordingCtx();
        sc.render(audio, ctx);
        // The life bar emits strokeRect; its width tracks the scaled bar.
        const strokes = (ctx as never as { calls: Array<{ op: string; args: number[] }> }).calls
          .filter((c) => c.op === 'strokeRect')
          .map((c) => c.args[2] ?? 0);
        return Math.max(0, ...strokes);
      };

      const hdBar = readBarWidth(...HD);
      const uhdBar = readBarWidth(...UHD);

      expect(hdBar).toBeGreaterThan(0);
      expect(uhdBar / hdBar).toBeCloseTo(2, 1);
    });

    it('keeps scanline spacing at 2px or more at every resolution', () => {
      for (const [w, h] of [SD, HD, UHD, [640, 360] as [number, number]]) {
        const sc = new RpgCombatScene(w, h);
        sc.init(w, h);
        const ctx = makeRecordingCtx();
        sc.render(makeAudio(), ctx);

        // Scanlines are full-width fillRects; collect their y positions.
        const ys = (ctx as never as { calls: Array<{ op: string; args: number[] }> }).calls
          .filter((c) => c.op === 'fillRect' && c.args[2] === w)
          .map((c) => c.args[1]);

        if (ys.length > 2) {
          const step = ys[2] - ys[1];
          expect(step).toBeGreaterThanOrEqual(2);
        }
      }
    });
  });

  describe('damage numbers survive resolution changes', () => {
    it('reports the same damage value regardless of resolution', () => {
      const spawn = (w: number, h: number): number => {
        const sc = new RpgCombatScene(w, h);
        sc.init(w, h);
        const inner = sc as unknown as {
          spawnDamageNumber(x: number, y: number, dmg: number, crit: boolean): void;
          damageNumbers: Array<{ value: number }>;
        };
        inner.spawnDamageNumber(100, 100, 0.08, false);
        return inner.damageNumbers[0].value;
      };

      // Damage is a gameplay quantity, not an art constant — it must not scale.
      expect(spawn(...UHD)).toBe(spawn(...HD));
      expect(spawn(...HD)).toBe(80);
    });
  });
});

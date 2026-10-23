import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RpgCombatScene } from '@/engine/gpu/littlejs/scenes/rpgCombat';
import { audioStore } from '@/engine/stores/audioStore';
import type { AudioReactiveData } from '@/engine/gpu/littlejs/types';

/**
 * Asset-driven backdrop contract. There is no manual "overlay" toggle: the
 * scene draws a backdrop ONLY when the user has supplied a custom background
 * image. With no background (the default / removed state) the scene keeps the
 * canvas transparent so Threnic's real background shows through beneath the
 * fighters — the compositor alpha-blends the scene over it.
 *
 * (In jsdom an <img> never fires load, so imagesLoaded never flips and the
 * "has backdrop" branch cannot be exercised here; these tests lock in the
 * no-backdrop behaviour, which is the point of the change.)
 */

const HD: [number, number] = [1920, 1080];

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

function makeScene(): RpgCombatScene {
  const scene = new RpgCombatScene(...HD);
  scene.init(...HD);
  return scene;
}

describe('RpgCombatScene asset-driven backdrop', () => {
  beforeEach(() => {
    audioStore.setState({ energy: 0, bass: 0, mid: 0, high: 0 });
  });

  it('clears the canvas to transparent each frame when there is no backdrop', () => {
    const scene = makeScene();
    const ctx = makeRecordingCtx();

    scene.update(makeAudio());
    scene.render(makeAudio(), ctx);

    expect(fullCanvasClears(ctx)).toBeGreaterThan(0);
  });

  it('never draws a full-canvas backdrop fill when there is no background', () => {
    const scene = makeScene();
    const ctx = makeRecordingCtx();

    scene.update(makeAudio());
    scene.render(makeAudio(), ctx);

    // No opaque backdrop drawImage should cover the canvas — the app background
    // shows through instead.
    const fullDrawImages = ctx.calls.filter((c) => c.op === 'drawImage');
    // Any drawImage present would be a sprite, not a full-canvas backdrop; the
    // backdrop path is gated on a loaded custom bg image (never loads in jsdom).
    for (const d of fullDrawImages) {
      const w = d.args[d.args.length - 2];
      const h = d.args[d.args.length - 1];
      const coversCanvas = w >= HD[0] && h >= HD[1];
      expect(coversCanvas).toBe(false);
    }
  });

  it('setAssetUrls with an empty background clears any prior backdrop URL', () => {
    const scene = makeScene();
    // Set then clear the background; the scene must treat empty as "no backdrop".
    scene.setAssetUrls({ background: 'blob:fake-bg' });
    scene.setAssetUrls({ background: '' });
    const internal = scene as unknown as { _bgUrl: string };
    expect(internal._bgUrl).toBe('');
  });
});

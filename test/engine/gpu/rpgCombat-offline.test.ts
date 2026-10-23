import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RpgCombatScene } from '@/engine/gpu/littlejs/scenes/rpgCombat';
import { audioStore } from '@/engine/stores/audioStore';
import type { AudioReactiveData } from '@/engine/gpu/littlejs/types';

/**
 * Offline (export) behaviour contract for the RPG Combat scene.
 *
 * Live playback and offline export differ in both of the inputs the attack
 * system depends on:
 *
 *  - SIGNAL: live reads audioStore so the scene fires in lockstep with the
 *    TriggerLevelWidget's meter. During an export nothing drives audioStore, so
 *    the scene must use the per-frame audio handed to update().
 *  - CLOCK: live times cooldowns on the wall clock. An export runs at the
 *    encoder's rate (~2x real time), so it must use song time instead.
 *
 * Getting either wrong produces a video where the characters never attack.
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

/** Private surface we assert against — attack state is internal to the scene. */
interface SceneInternals {
  leftAttackFrame: number;
  rightAttackFrame: number;
  _leftLastAttackTime: number;
  _rightLastAttackTime: number;
  _offline: boolean;
}

const peek = (scene: RpgCombatScene): SceneInternals =>
  scene as unknown as unknown as SceneInternals;

function makeScene(offline: boolean): RpgCombatScene {
  const scene = new RpgCombatScene(...HD);
  scene.init(...HD);
  if (offline) scene.setOffline(true);
  return scene;
}

/** Drive one frame and report whether the left fighter's attack started. */
function leftAttacked(scene: RpgCombatScene, audio: AudioReactiveData): boolean {
  const before = peek(scene).leftAttackFrame;
  scene.update(audio);
  return before === 0 && peek(scene).leftAttackFrame > 0;
}

describe('RpgCombatScene offline export mode', () => {
  beforeEach(() => {
    // A silent live store is the real condition during an export.
    audioStore.setState({ energy: 0, bass: 0, mid: 0, high: 0 });
  });

  afterEach(() => {
    audioStore.setState({ energy: 0, bass: 0, mid: 0, high: 0 });
    vi.restoreAllMocks();
  });

  describe('trigger signal source', () => {
    it('fires from per-frame audio while the live store is silent', () => {
      const scene = makeScene(true);
      expect(leftAttacked(scene, makeAudio({ bass: 0.95, time: 0 }))).toBe(true);
    });

    it('does NOT fire from per-frame audio in live mode (store is the source)', () => {
      // This is the regression that made exports render idle characters: the
      // scene was reading the store in every mode.
      const scene = makeScene(false);
      expect(leftAttacked(scene, makeAudio({ bass: 0.95, time: 0 }))).toBe(false);
    });

    it('still fires from the live store in live mode', () => {
      audioStore.setState({ bass: 0.95 });
      const scene = makeScene(false);
      expect(leftAttacked(scene, makeAudio({ bass: 0, time: 0 }))).toBe(true);
    });

    it('ignores the live store entirely while offline', () => {
      audioStore.setState({ bass: 0.95 });
      const scene = makeScene(true);
      expect(leftAttacked(scene, makeAudio({ bass: 0, time: 0 }))).toBe(false);
    });
  });

  describe('cooldown clock', () => {
    it('times cooldowns on song time, not the wall clock', () => {
      const scene = makeScene(true);
      const loud = (time: number) => makeAudio({ bass: 0.95, time });

      expect(leftAttacked(scene, loud(0))).toBe(true);

      // Let the 12-frame attack animation finish without advancing song time
      // much — a second attack must still be blocked by the 1.5s cooldown.
      for (let i = 1; i <= 14; i++) scene.update(loud(i * 0.016));
      expect(leftAttacked(scene, loud(0.3))).toBe(false);

      // Past the cooldown, it fires again.
      expect(leftAttacked(scene, loud(2.0))).toBe(true);
    });

    it('does not stamp wall-clock time into an offline cooldown on reset', () => {
      // The two clocks are unrelated: stamping a wall-clock reading while the
      // scene is comparing against song time can put the cooldown arbitrarily
      // far in the future and suppress every remaining attack in the export.
      const scene = makeScene(true);
      scene.update(makeAudio({ bass: 0.95, time: 4 }));
      scene.reset();

      expect(peek(scene)._leftLastAttackTime).toBeCloseTo(4, 3);
    });

    it('clears stale stamps when switching clocks so attacks are not locked out', () => {
      const scene = makeScene(false);
      audioStore.setState({ bass: 0.95 });
      scene.update(makeAudio({ bass: 0 }));
      // Live mode stamped a wall-clock reading, which bears no relation to the
      // song timeline (it can be ahead of it or behind it depending on how long
      // the page has been open).
      const liveStamp = peek(scene)._leftLastAttackTime;
      expect(liveStamp).toBeGreaterThan(0);

      scene.setOffline(true);
      expect(peek(scene)._leftLastAttackTime).toBe(-Infinity);

      // And the scene is immediately usable on the song-time clock, once the
      // in-flight attack animation from the live-mode hit has played out.
      audioStore.setState({ bass: 0 });
      for (let i = 1; i <= 13; i++) scene.update(makeAudio({ bass: 0, time: i * 0.016 }));
      expect(leftAttacked(scene, makeAudio({ bass: 0.95, time: 0.25 }))).toBe(true);
    });

    it('is idempotent — repeating the same mode does not clear cooldowns', () => {
      const scene = makeScene(true);
      scene.update(makeAudio({ bass: 0.95, time: 5 }));
      const stamped = peek(scene)._leftLastAttackTime;
      scene.setOffline(true);
      expect(peek(scene)._leftLastAttackTime).toBe(stamped);
    });
  });

  describe('UI notification', () => {
    it('does not dispatch gameSceneAttack events while offline', () => {
      // The live TriggerLevelWidget listens for these; an export would flood it
      // with events on song time while the user watches at wall-clock speed.
      const spy = vi.spyOn(window, 'dispatchEvent');
      const scene = makeScene(true);
      scene.update(makeAudio({ bass: 0.95, time: 0 }));

      const attackEvents = spy.mock.calls.filter(([e]) => (e as Event).type === 'gameSceneAttack');
      expect(attackEvents).toHaveLength(0);
    });

    it('still dispatches gameSceneAttack events in live mode', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      audioStore.setState({ bass: 0.95 });
      const scene = makeScene(false);
      scene.update(makeAudio({ bass: 0 }));

      const attackEvents = spy.mock.calls.filter(([e]) => (e as Event).type === 'gameSceneAttack');
      expect(attackEvents).toHaveLength(1);
      expect(((attackEvents[0][0] as CustomEvent).detail as { id: string }).id).toBe('left');
    });
  });

  describe('asset readiness', () => {
    it('settles even when sprite loads never fire load or error', async () => {
      // jsdom's <img> resolves neither event, which is exactly the dead-blob-URL
      // case: without the timeout guard the export would hang here forever.
      const scene = makeScene(true);
      await expect(scene.whenAssetsReady(20)).resolves.toBeUndefined();
    });
  });

  describe('life bars drain over the song', () => {
    interface HpInternals {
      leftHp: number;
      rightHp: number;
      leftHpTarget: number;
      rightHpTarget: number;
    }
    const hp = (s: RpgCombatScene): HpInternals => s as unknown as HpInternals;

    it('starts both fighters at full HP', () => {
      const scene = makeScene(true);
      expect(hp(scene).leftHpTarget).toBe(1);
      expect(hp(scene).rightHpTarget).toBe(1);
    });

    it('drives HP down to ~5% by the end of the song', () => {
      const scene = makeScene(true);
      const duration = 100;
      // No combat (bass 0) — pure song-progress drain to the floor.
      for (let t = 0; t <= duration; t += 0.5) {
        scene.update(makeAudio({ time: t, duration }));
      }
      // Target sits on the 5% floor; smoothed HP is close behind it.
      expect(hp(scene).leftHpTarget).toBeCloseTo(0.05, 2);
      expect(hp(scene).rightHpTarget).toBeCloseTo(0.05, 2);
      expect(hp(scene).leftHp).toBeGreaterThanOrEqual(0.05);
      expect(hp(scene).leftHp).toBeLessThan(0.1);
    });

    it('never lets HP reach zero even with heavy combat', () => {
      const scene = makeScene(true);
      const duration = 60;
      for (let t = 0; t <= duration; t += 0.25) {
        // Constant loud bass drives attacks and damage the whole way through.
        scene.update(makeAudio({ bass: 1, treb: 1, amplitude: 1, time: t, duration }));
      }
      expect(hp(scene).leftHpTarget).toBeGreaterThanOrEqual(0.05);
      expect(hp(scene).rightHpTarget).toBeGreaterThanOrEqual(0.05);
    });

    it('keeps HP near full at the start of the song', () => {
      const scene = makeScene(true);
      const duration = 200;
      // A few early frames — progress is tiny, so the floor stays near 1.
      for (let t = 0; t <= 2; t += 0.5) {
        scene.update(makeAudio({ time: t, duration }));
      }
      expect(hp(scene).leftHpTarget).toBeGreaterThan(0.95);
    });

    it('falls back to combat-only behaviour when duration is unknown', () => {
      const scene = makeScene(true);
      // duration 0 → no song-progress floor; bars stay full without combat.
      for (let t = 0; t <= 30; t += 0.5) {
        scene.update(makeAudio({ time: t, duration: 0 }));
      }
      expect(hp(scene).leftHpTarget).toBe(1);
      expect(hp(scene).rightHpTarget).toBe(1);
    });

    it('honours a user-configured end-HP floor', () => {
      const scene = makeScene(true);
      scene.setParams({ hpFloor: 0.25 });
      const duration = 100;
      for (let t = 0; t <= duration; t += 0.5) {
        scene.update(makeAudio({ time: t, duration }));
      }
      expect(hp(scene).leftHpTarget).toBeCloseTo(0.25, 2);
      expect(hp(scene).rightHpTarget).toBeCloseTo(0.25, 2);
    });

    it('clamps an out-of-range end-HP floor into [0, 0.5]', () => {
      const scene = makeScene(true);
      scene.setParams({ hpFloor: 5 }); // absurd → clamped to 0.5
      const duration = 100;
      for (let t = 0; t <= duration; t += 0.5) {
        scene.update(makeAudio({ time: t, duration }));
      }
      expect(hp(scene).leftHpTarget).toBeCloseTo(0.5, 2);
    });

    // Regression: regen and smoothing were per-FRAME constants while the floor
    // was per-SECOND, so the visible (smoothed) HP tracked the floor at wildly
    // different rates depending on how many frames covered the song. A short
    // song / low fps left the bar lagging far behind; a long song hugged it.
    // With rate-per-second dynamics the smoothed HP must track the same fraction
    // of the way through the song regardless of the frame cadence.
    it('smoothed HP tracks the floor the same at any frame cadence', () => {
      // Same song, driven at two very different step sizes (dt).
      const drive = (dt: number): number => {
        const scene = makeScene(true);
        const duration = 40;
        for (let t = dt; t <= duration; t += dt) {
          scene.update(makeAudio({ time: t, duration }));
        }
        return hp(scene).leftHp; // the VISIBLE bar, not just the target
      };
      const at60fps = drive(1 / 60);
      const at24fps = drive(1 / 24);
      // Both should sit on the ~5% floor at song end, within a hair of each
      // other — the follower no longer depends on frame count.
      expect(at60fps).toBeCloseTo(0.05, 2);
      expect(at24fps).toBeCloseTo(0.05, 2);
      expect(Math.abs(at60fps - at24fps)).toBeLessThan(0.02);
    });

    // Regression: a short song used to under-drain because the smoothed bar
    // could not catch a floor that moved a large fraction each frame. The
    // visible HP at the midpoint should be near the 50%-progress floor
    // regardless of how long the song is.
    it('drains proportionally at the midpoint for short and long songs', () => {
      const midHp = (duration: number): number => {
        const scene = makeScene(true);
        for (let t = 1 / 60; t <= duration / 2; t += 1 / 60) {
          scene.update(makeAudio({ time: t, duration }));
        }
        return hp(scene).leftHp;
      };
      const shortSong = midHp(20);
      const longSong = midHp(300);
      // Floor at 50% progress = 1 - 0.95*0.5 ≈ 0.525. Visible HP should be near
      // it for both, and the two should agree closely.
      expect(shortSong).toBeCloseTo(0.525, 1);
      expect(longSong).toBeCloseTo(0.525, 1);
      expect(Math.abs(shortSong - longSong)).toBeLessThan(0.03);
    });
  });
});

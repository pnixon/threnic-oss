import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '@/stores/projectStore';
import { timeStore } from '@/engine/stores/timeStore';
import type { Track } from '@/contexts/types';

/**
 * Regression tests for the keyframe WRITE path (projectStore.updateTrackProperty).
 *
 * Policy (user-specified): editing an active value NEVER creates a keyframe — it
 * ALTERS an existing one.
 *  1. Editing an animated property with no explicit selection alters the ACTIVE
 *     keyframe: the latest one carrying that property at or before the playhead.
 *  2. A dropdown selection (explicit keyframeId) is authoritative and wins
 *     regardless of where the playhead sits.
 *  3. Editing before the FIRST keyframe for an animated property alters that
 *     first keyframe (still never creates one).
 *  4. A property with no keyframes at all writes base config.
 */

function seedTrack(keyframes: Track['keyframes']): string {
  const track = {
    id: 'trk-1',
    name: 'Test',
    duration: 30,
    keyframes,
    effectsConfig: { effectInstances: [] },
  } as unknown as Track;
  projectStore.setState({ tracks: [track], selectedTrackId: 'trk-1' });
  return 'trk-1';
}

function getKfs() {
  return projectStore.getState().getTrackById('trk-1')!.keyframes || [];
}

describe('projectStore.updateTrackProperty — write targeting', () => {
  beforeEach(() => {
    projectStore.setState({ tracks: [], selectedTrackId: null });
    timeStore.getState().setCurrentTime(0);
  });

  it('alters the ACTIVE (previous) keyframe and creates none when editing an animated property', () => {
    seedTrack([
      { id: 'k0', time: 0, properties: { 'scene.backgroundScale': 1 } } as any,
      { id: 'k10', time: 10, properties: { 'scene.backgroundScale': 3 } } as any,
    ]);

    // Playhead between the two keyframes → active keyframe is k0.
    timeStore.getState().setCurrentTime(4);
    projectStore.getState().updateTrackProperty('trk-1', 'scene.backgroundScale', 1.5);

    const kfs = getKfs();
    // No new keyframe created.
    expect(kfs.length).toBe(2);
    // The active (previous) keyframe k0 holds the edited value.
    expect((kfs.find((k) => k.id === 'k0')!.properties as any)['scene.backgroundScale']).toBe(1.5);
    // The later keyframe is untouched.
    expect((kfs.find((k) => k.id === 'k10')!.properties as any)['scene.backgroundScale']).toBe(3);
  });

  it('honors a dropdown selection regardless of playhead position (no new keyframe)', () => {
    seedTrack([
      { id: 'k0', time: 0, properties: { 'scene.backgroundScale': 1 } } as any,
      { id: 'k10', time: 10, properties: { 'scene.backgroundScale': 3 } } as any,
    ]);

    // Playhead at t=3 but the user has selected k10 in the dropdown → k10 wins.
    timeStore.getState().setCurrentTime(3);
    projectStore.getState().updateTrackProperty('trk-1', 'scene.backgroundScale', 2, 'k10');

    const kfs = getKfs();
    expect(kfs.length).toBe(2);
    // The SELECTED keyframe k10 receives the edit.
    expect((kfs.find((k) => k.id === 'k10')!.properties as any)['scene.backgroundScale']).toBe(2);
    // k0 untouched.
    expect((kfs.find((k) => k.id === 'k0')!.properties as any)['scene.backgroundScale']).toBe(1);
  });

  it('alters the first keyframe when editing before the earliest keyframe for the property', () => {
    // Property first animated at t=5; playhead sits before it at t=2.
    seedTrack([{ id: 'k5', time: 5, properties: { 'scene.backgroundScale': 2 } } as any]);

    timeStore.getState().setCurrentTime(2);
    projectStore.getState().updateTrackProperty('trk-1', 'scene.backgroundScale', 1.5);

    const kfs = getKfs();
    // Still exactly one keyframe — none created.
    expect(kfs.length).toBe(1);
    expect((kfs.find((k) => k.id === 'k5')!.properties as any)['scene.backgroundScale']).toBe(1.5);
  });

  it('writes base config for a property that is not animated', () => {
    // One keyframe animates a DIFFERENT property; scene.backgroundOpacity is not animated.
    seedTrack([{ id: 'k5', time: 5, properties: { 'scene.backgroundScale': 2 } } as any]);

    timeStore.getState().setCurrentTime(3);
    projectStore.getState().updateTrackProperty('trk-1', 'scene.backgroundOpacity', 0.4);

    const kfs = getKfs();
    // No keyframe gained the un-animated property.
    expect(kfs.some((k) => 'scene.backgroundOpacity' in (k.properties as any))).toBe(false);
    // Base config received it.
    const track = projectStore.getState().getTrackById('trk-1')!;
    expect((track.effectsConfig as any).backgroundOpacity).toBe(0.4);
  });
});

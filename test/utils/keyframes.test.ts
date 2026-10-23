import { describe, it, expect } from 'vitest';
import { computeStateAtTime, interpolateValue, scanKeyframesForEffects } from '@/utils/keyframes';
import { Keyframe } from '@/types/keyframes';
import { EffectType } from '@/types/effects';

describe('Keyframe Utils', () => {
  describe('interpolateValue', () => {
    it('returns null when no keyframes', () => {
      expect(interpolateValue(0, [], 'test')).toBeNull();
    });

    it('returns default value when no keyframes', () => {
      expect(interpolateValue(0, [], 'test', 'default')).toBe('default');
    });

    it('returns value from keyframe at time 0', () => {
      const kfs: Keyframe[] = [{ id: '1', time: 0, properties: { test: 10 } }];
      expect(interpolateValue(0, kfs, 'test')).toBe(10);
      expect(interpolateValue(5, kfs, 'test')).toBe(10);
    });

    it('target keyframe interpolation always wins', () => {
      // KF1 says 'hold', KF2 says 'linear' — KF2 wins because it is the target
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { test: 0 }, interpolation: 'hold' },
        { id: '2', time: 10, properties: { test: 100 }, interpolation: 'linear' },
      ];
      expect(interpolateValue(5, kfs, 'test')).toBe(50);
    });

    it('default interpolation is linear (not hold)', () => {
      // Neither keyframe specifies interpolation — defaults to 'linear'
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { test: 0 } },
        { id: '2', time: 10, properties: { test: 100 } },
      ];
      expect(interpolateValue(5, kfs, 'test')).toBe(50);
      expect(interpolateValue(0, kfs, 'test')).toBe(0);
      expect(interpolateValue(10, kfs, 'test')).toBe(100);
    });

    it('explicit hold on target keyframe causes instant snap', () => {
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { test: 0 }, interpolation: 'linear' },
        { id: '2', time: 10, properties: { test: 100 }, interpolation: 'hold' },
      ];
      // Hold means: stay at prevVal until we reach the target time
      expect(interpolateValue(5, kfs, 'test')).toBe(0);
      expect(interpolateValue(9.9, kfs, 'test')).toBe(0);
      expect(interpolateValue(10, kfs, 'test')).toBe(100);
    });

    it('explicit instant on target keyframe causes instant snap', () => {
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { test: 0 } },
        { id: '2', time: 10, properties: { test: 100 }, interpolation: 'instant' },
      ];
      expect(interpolateValue(5, kfs, 'test')).toBe(0);
      expect(interpolateValue(10, kfs, 'test')).toBe(100);
    });

    it('skips keyframes that do not define the property (3-keyframe scenario)', () => {
      // KF1: gravity=9.8, KF2: only bloom (no gravity), KF3: gravity=0
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { gravity: 9.8 }, interpolation: 'linear' },
        // KF2 at time=5 only defines bloom — NOT in the gravity propKfs list
        { id: '3', time: 10, properties: { gravity: 0 }, interpolation: 'linear' },
      ];
      // At t=5 (midpoint), gravity should be halfway between 9.8 and 0
      expect(interpolateValue(5, kfs, 'gravity')).toBeCloseTo(4.9);
      // At t=2.5 (quarter), should be 75% of 9.8
      expect(interpolateValue(2.5, kfs, 'gravity')).toBeCloseTo(7.35);
      // Endpoints
      expect(interpolateValue(0, kfs, 'gravity')).toBe(9.8);
      expect(interpolateValue(10, kfs, 'gravity')).toBe(0);
    });

    it('ease-in on target keyframe produces correct curve', () => {
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { test: 0 } },
        { id: '2', time: 10, properties: { test: 100 }, interpolation: 'ease-in' },
      ];
      const mid = interpolateValue(5, kfs, 'test') as number;
      // ease-in (cubic) at t=0.5 → 0.5^3 = 0.125, so value ≈ 12.5
      expect(mid).toBeCloseTo(12.5);
    });

    it('handles transitionDuration (transition-in)', () => {
      const kfs: Keyframe[] = [
        {
          id: '1',
          time: 10,
          properties: { test: 100 },
          transitionDuration: 5,
          interpolation: 'linear',
        },
      ];
      // Before transition starts
      expect(interpolateValue(4, kfs, 'test', 0)).toBe(0);
      // Mid transition
      expect(interpolateValue(7.5, kfs, 'test', 0)).toBe(50);
      // End of transition
      expect(interpolateValue(10, kfs, 'test', 0)).toBe(100);
    });

    it('prev keyframe interpolation is ignored when target has its own', () => {
      // Prev says ease-in-out, target says linear — target wins
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { test: 0 }, interpolation: 'ease-in-out' },
        { id: '2', time: 10, properties: { test: 100 }, interpolation: 'linear' },
      ];
      // Linear at midpoint should be exactly 50
      expect(interpolateValue(5, kfs, 'test')).toBe(50);
    });

    it('3-keyframe chain uses each target keyframe interpolation independently', () => {
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { test: 0 } },
        { id: '2', time: 10, properties: { test: 100 }, interpolation: 'linear' },
        { id: '3', time: 20, properties: { test: 0 }, interpolation: 'hold' },
      ];
      // KF1→KF2: linear, midpoint should be 50
      expect(interpolateValue(5, kfs, 'test')).toBe(50);
      // KF2→KF3: hold, should stay at 100 until snapping at t=20
      expect(interpolateValue(15, kfs, 'test')).toBe(100);
      expect(interpolateValue(19.9, kfs, 'test')).toBe(100);
      expect(interpolateValue(20, kfs, 'test')).toBe(0);
    });
  });

  describe('computeStateAtTime', () => {
    it('computes combined state', () => {
      const kfs: Keyframe[] = [
        {
          id: '1',
          time: 0,
          properties: {
            'scene.backgroundMode': 'video',
            'lyrics.fontSize': 1.0,
            'effects.postProcessing.bloom.intensity': 0.5,
          },
        },
      ];

      const state = computeStateAtTime(kfs, 0);
      expect(state.scene.backgroundMode).toBe('video');
      expect(state.lyrics.fontSize).toBe(1.0);
      expect(state.effects['bloom.intensity']).toBe(0.5);
    });

    it('resets scene properties correctly', () => {
      const kfs: Keyframe[] = [
        {
          id: '1',
          time: 5,
          properties: {
            'scene.backgroundMode': 'video',
          },
        },
      ];

      // At time 0, it should be null (reset)
      const state = computeStateAtTime(kfs, 0);
      expect(state.scene.backgroundMode).toBe('standard');
    });
  });

  describe('scanKeyframesForEffects', () => {
    it('finds all effect types in keyframes', () => {
      const kfs: Keyframe[] = [
        { id: '1', time: 0, properties: { 'effects.postProcessing.bloom.enabled': true } },
        { id: '2', time: 10, properties: { 'effects.particles.opacity': 0.5 } },
      ];

      const effects = scanKeyframesForEffects(kfs);
      expect(effects.has('bloom' as EffectType)).toBe(true);
      expect(effects.has('particles' as EffectType)).toBe(true);
      expect(effects.size).toBe(2);
    });
  });
});

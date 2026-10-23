import { describe, it, expect } from 'vitest';
import { computeStateAtTime, computeFinalEffectsConfig, parseKeyframes } from '@/utils/keyframes';
import type { Keyframe } from '@/types/keyframes';
import type { EffectsConfig } from '@/types/effects';

/**
 * Tests for the keyframe FADE + audio-reactive interpolation behavior.
 *
 * A) Only opacity parameters fade out before an effect disables. Non-opacity
 *    params (brightness, contrast, …) hard-cut at the disable keyframe.
 * B) Numeric audio-reactive sub-values interpolate between keyframes.
 */

function baseConfig(instances: any[]): EffectsConfig {
  return { effectInstances: instances } as unknown as EffectsConfig;
}

describe('keyframe fade — opacity-only', () => {
  it('fades an opacity-bearing effect out over its disable transition', () => {
    // Effect with opacity; enabled=true at t=0, enabled=false at t=2 with a 2s
    // transitionDuration so the disable eases across [0,2].
    const instances = [{ id: 'fx1', type: 'butterchurn', config: { enabled: true, opacity: 1 } }];
    const kfs: Keyframe[] = [
      { id: 'a', time: 0, properties: { 'fx.fx1.enabled': true, 'fx.fx1.opacity': 1 } },
      {
        id: 'b',
        time: 2,
        transitionDuration: 2,
        interpolation: 'linear',
        properties: { 'fx.fx1.enabled': false },
      } as any,
    ];
    const parsed = parseKeyframes(kfs);

    // Midway through the fade (t=1): still enabled, opacity ~0.5.
    const mid = computeStateAtTime(parsed, 1, undefined, baseConfig(instances));
    const merged = computeFinalEffectsConfig(baseConfig(instances), mid.scene, mid.effects);
    const inst = merged!.effectInstances!.find((i) => i.id === 'fx1')!;
    expect(inst.config.enabled).toBe(true);
    expect((inst.config as any).opacity).toBeGreaterThan(0.3);
    expect((inst.config as any).opacity).toBeLessThan(0.7);
  });

  it('hard-cuts a non-opacity effect at the disable keyframe (no fade)', () => {
    // Contrast-style effect: brightness param, NO opacity. enabled false at t=2
    // with a transitionDuration — must NOT fade; enabled stays true until t=2
    // then flips, and brightness is never scaled down.
    const instances = [{ id: 'fx2', type: 'colorGrade', config: { enabled: true, brightness: 2 } }];
    const kfs: Keyframe[] = [
      { id: 'a', time: 0, properties: { 'fx.fx2.enabled': true, 'fx.fx2.brightness': 2 } },
      {
        id: 'b',
        time: 2,
        transitionDuration: 2,
        interpolation: 'linear',
        properties: { 'fx.fx2.enabled': false },
      } as any,
    ];
    const parsed = parseKeyframes(kfs);

    // Midway (t=1): enabled still true (steps at t=2), brightness unscaled = 2.
    const mid = computeStateAtTime(parsed, 1, undefined, baseConfig(instances));
    const merged = computeFinalEffectsConfig(baseConfig(instances), mid.scene, mid.effects);
    const inst = merged!.effectInstances!.find((i) => i.id === 'fx2')!;
    expect(inst.config.enabled).toBe(true);
    expect((inst.config as any).brightness).toBe(2); // NOT faded

    // At/after t=2: disabled.
    const after = computeStateAtTime(parsed, 2.01, undefined, baseConfig(instances));
    const mergedAfter = computeFinalEffectsConfig(
      baseConfig(instances),
      after.scene,
      after.effects,
    );
    const instAfter = mergedAfter!.effectInstances!.find((i) => i.id === 'fx2')!;
    expect(instAfter.config.enabled).toBe(false);
  });

  it('interpolates non-opacity values between enabled keyframes', () => {
    // brightness 1 → 3 across [0,10], effect stays enabled.
    const instances = [{ id: 'fx3', type: 'colorGrade', config: { enabled: true, brightness: 1 } }];
    const kfs: Keyframe[] = [
      { id: 'a', time: 0, properties: { 'fx.fx3.enabled': true, 'fx.fx3.brightness': 1 } },
      { id: 'b', time: 10, interpolation: 'linear', properties: { 'fx.fx3.brightness': 3 } } as any,
    ];
    const parsed = parseKeyframes(kfs);
    const mid = computeStateAtTime(parsed, 5, undefined, baseConfig(instances));
    const merged = computeFinalEffectsConfig(baseConfig(instances), mid.scene, mid.effects);
    const inst = merged!.effectInstances!.find((i) => i.id === 'fx3')!;
    expect((inst.config as any).brightness).toBeCloseTo(2, 5);
  });
});

describe('audio-reactive sub-value interpolation', () => {
  it('interpolates a nested AR numeric value (arP0.min) between keyframes', () => {
    const instances = [
      {
        id: 'sfx',
        type: 'shaderFx',
        config: { enabled: true, arP0: { enabled: true, min: 0, max: 1 } },
      },
    ];
    const kfs: Keyframe[] = [
      { id: 'a', time: 0, properties: { 'fx.sfx.arP0.min': 0 } },
      { id: 'b', time: 10, interpolation: 'linear', properties: { 'fx.sfx.arP0.min': 1 } } as any,
    ];
    const parsed = parseKeyframes(kfs);
    const mid = computeStateAtTime(parsed, 5, undefined, baseConfig(instances));
    const merged = computeFinalEffectsConfig(baseConfig(instances), mid.scene, mid.effects);
    const inst = merged!.effectInstances!.find((i) => i.id === 'sfx')!;
    expect((inst.config as any).arP0.min).toBeCloseTo(0.5, 5);
  });

  it('interpolates a TriggerLevelWidget threshold (nested params path) between keyframes', () => {
    const instances = [
      {
        id: 'gs',
        type: 'shaderFx',
        config: {
          enabled: true,
          littlejs: { params: { leftAttack: { band: 'bass', threshold: 0.5, cooldown: 1.5 } } },
        },
      },
    ];
    const kfs: Keyframe[] = [
      { id: 'a', time: 0, properties: { 'fx.gs.littlejs.params.leftAttack.threshold': 0.4 } },
      {
        id: 'b',
        time: 10,
        interpolation: 'linear',
        properties: { 'fx.gs.littlejs.params.leftAttack.threshold': 0.8 },
      } as any,
    ];
    const parsed = parseKeyframes(kfs);
    const mid = computeStateAtTime(parsed, 5, undefined, baseConfig(instances));
    const merged = computeFinalEffectsConfig(baseConfig(instances), mid.scene, mid.effects);
    const inst = merged!.effectInstances!.find((i) => i.id === 'gs')!;
    expect((inst.config as any).littlejs.params.leftAttack.threshold).toBeCloseTo(0.6, 5);
  });
});

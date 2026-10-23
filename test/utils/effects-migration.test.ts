import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateLegacyEffects } from '@/utils/effects-migration';
import { EffectsConfig, DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import { Keyframe } from '@/types/keyframes';

// Generate consistent ids for tests
vi.mock('@/utils/effects-migration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/effects-migration')>();
  let counter = 0;
  return {
    ...actual,
    // Note: We can't easily mock the unexported makeMigrationId directly,
    // but the actual function uses crypto.randomUUID or Math.random().
    // For unit testing the logic itself, we don't necessarily have to hardcode IDs,
    // we just need to verify they exist and match certain patterns.
  };
});

describe('effects-migration', () => {
  let mockConfig: EffectsConfig;

  beforeEach(() => {
    mockConfig = JSON.parse(JSON.stringify(DEFAULT_EFFECTS_CONFIG));
  });

  it('migrates legacy scene effects into effectInstances', () => {
    mockConfig.particles = { ...mockConfig.particles, enabled: true };
    mockConfig.rain = { ...mockConfig.rain, enabled: true };

    const { config } = migrateLegacyEffects(mockConfig);

    expect(config.effectInstances).toBeDefined();
    expect(config.effectInstances.length).toBeGreaterThan(0);

    const particlesInstance = config.effectInstances.find((i) => i.type === 'particles');
    expect(particlesInstance).toBeDefined();
    expect(particlesInstance?.config.enabled).toBe(true);

    const rainInstance = config.effectInstances.find((i) => i.type === 'rain');
    expect(rainInstance).toBeDefined();
    expect(rainInstance?.config.enabled).toBe(true);
  });

  it('migrates legacy postprocessing into effectInstances in order', () => {
    mockConfig.postProcessing = {
      bloom: { enabled: true, intensity: 1.5 },
      chromaticAberration: { enabled: true, amount: 0.5 },
    } as any;
    mockConfig.effectOrder = ['chromaticAberration', 'bloom'];

    const { config } = migrateLegacyEffects(mockConfig);

    const instances = config.effectInstances.filter((i) =>
      ['bloom', 'chromaticAberration'].includes(i.type),
    );

    expect(instances.length).toBe(2);
    // Should respect effectOrder: chromaticAberration first, then bloom
    expect(instances[0].type).toBe('chromaticAberration');
    expect(instances[1].type).toBe('bloom');
    expect((instances[0].config as any).amount).toBe(0.5);
    expect((instances[1].config as any).intensity).toBe(1.5);
  });

  it('migrates legacy keyframes to use the flat effects.* prefix', () => {
    const keyframes: Keyframe[] = [
      {
        id: 'kf1',
        time: 0,
        easing: 'linear',
        properties: {
          'bloom.intensity': 2.0, // Should become effects.postProcessing.bloom.intensity
          'particles.count': 1000, // Should become effects.particles.count
        },
      },
    ];

    const { keyframes: migrated } = migrateLegacyEffects(mockConfig, keyframes);

    expect(migrated[0].properties['effects.postProcessing.bloom.intensity']).toBe(2.0);
    expect(migrated[0].properties['effects.particles.count']).toBe(1000);
    // Legacy keys should be removed
    expect(migrated[0].properties['bloom.intensity']).toBeUndefined();
    expect(migrated[0].properties['particles.count']).toBeUndefined();
  });

  it('creates an effect instance for effects only referenced in keyframes', () => {
    const keyframes: Keyframe[] = [
      {
        id: 'kf1',
        time: 1.0,
        easing: 'linear',
        properties: {
          'water.opacity': 0.8,
        },
      },
    ];

    // Note: water is effectively disabled in base config
    mockConfig.water = { enabled: false, opacity: 0 };

    const { config } = migrateLegacyEffects(mockConfig, keyframes);

    // It should have created a water instance even though it wasn't enabled in base config
    const waterInstance = config.effectInstances.find((i) => i.type === 'water');
    expect(waterInstance).toBeDefined();
    expect(waterInstance?.config.enabled).toBe(false); // Base state is false
  });

  it('migrates effectInstances property array inside keyframes', () => {
    const keyframes: Keyframe[] = [
      {
        id: 'kf1',
        time: 0,
        easing: 'linear',
        properties: {
          effectInstances: [{ type: 'bloom', config: { intensity: 5.0 } }],
        },
      },
    ];

    const { keyframes: migrated } = migrateLegacyEffects(mockConfig, keyframes);

    // effectInstances array should be flattened to properties
    expect(migrated[0].properties['effects.postProcessing.bloom.intensity']).toBe(5.0);
    expect(migrated[0].properties['effectInstances']).toBeUndefined();
  });

  it('does not auto-insert an initial keyframe at time 0', () => {
    const keyframes: Keyframe[] = [
      {
        id: 'kf1',
        time: 1.0, // starts at 1s instead of 0s
        easing: 'linear',
        properties: {
          'effects.particles.count': 500,
        },
      },
    ];

    const { keyframes: migrated } = migrateLegacyEffects(mockConfig, keyframes);

    // ensureInitialKeyframe was intentionally removed to prevent
    // effects added at later keyframes from retroactively appearing at t=0
    expect(migrated.length).toBe(1);
    expect(migrated[0].time).toBe(1.0);
  });
});

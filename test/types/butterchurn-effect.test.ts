import { describe, it, expect } from 'vitest';
import { SCENE_EFFECT_TYPES, EFFECT_LABELS } from '@/types/effects/effect-instances';
import { createDefaultInstance } from '@/types/effects/effect-instance-factory';
import { getEffectSchema } from '@/types/effects/effect-schemas';

/**
 * Butterchurn is a first-class SCENE effect (a row in the effects list), not a
 * standalone Inspector panel. This locks the registration so it stays a list
 * effect: type membership + label + a default instance + a resolvable schema.
 */
describe('butterchurn effect type registration', () => {
  it('is listed as a scene effect type', () => {
    expect(SCENE_EFFECT_TYPES).toContain('butterchurn');
  });

  it('has a human-readable label', () => {
    expect(EFFECT_LABELS.butterchurn).toBe('Butterchurn');
  });

  it('builds a disabled-by-default? enabled default instance with a ButterchurnConfig shape', () => {
    const inst = createDefaultInstance('butterchurn');
    expect(inst.type).toBe('butterchurn');
    expect(inst.config).toMatchObject({
      enabled: true,
      presetName: expect.any(String),
      blendMode: expect.any(String),
      opacity: expect.any(Number),
    });
    expect(inst.id).toBeTruthy();
  });

  it('has a resolvable schema with a preset picker + opacity field', () => {
    const schema = getEffectSchema('butterchurn');
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('butterchurn');
    const props = schema!.fields.map((f: any) => f.property);
    expect(props).toContain('presetName');
    expect(props).toContain('opacity');
    // No showWhen gating — the whole schema IS the butterchurn config.
    expect(schema!.fields.every((f: any) => !f.showWhen)).toBe(true);
  });
});

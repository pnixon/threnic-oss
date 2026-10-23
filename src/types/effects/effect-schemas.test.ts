import { describe, it, expect } from 'vitest';
import { getEffectSchema } from './effect-schemas';

describe('effect schemas - tiling refactor', () => {
  describe('zoom schema', () => {
    it('does NOT have a tiling checkbox field', () => {
      const schema = getEffectSchema('zoom');
      expect(schema).toBeDefined();
      const tilingField = schema!.fields.find((f) => f.property === 'tiling');
      expect(tilingField).toBeUndefined();
    });

    it('still has scale and center fields', () => {
      const schema = getEffectSchema('zoom');
      expect(schema).toBeDefined();
      const scaleField = schema!.fields.find(
        (f) => f.property === 'scale' || f.audioReactive?.path === 'audioReactive',
      );
      expect(scaleField).toBeDefined();

      const centerXField = schema!.fields.find((f) => f.property === 'centerX');
      expect(centerXField).toBeDefined();
    });
  });
});

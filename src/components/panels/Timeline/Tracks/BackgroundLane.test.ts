import { describe, it, expect } from 'vitest';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import { DEFAULT_POST_PROCESSING_CONFIG } from '@/types/effects/defaults';
import { POST_PROCESSING_EFFECT_TYPES } from '@/types/effects/effect-instances';
import { createDefaultInstance } from '@/types/effects/effect-instance-factory';

describe('BackgroundLane behavior changes', () => {
  describe('tiling removal from EffectsConfig', () => {
    it('backgroundTiling still exists in DEFAULT_EFFECTS_CONFIG for backward compat', () => {
      expect(DEFAULT_EFFECTS_CONFIG.backgroundTiling).toBe(false);
    });

    it('backgroundTileOffsetX/Y still exist for backward compat', () => {
      expect(DEFAULT_EFFECTS_CONFIG.backgroundTileOffsetX).toBe(0);
      expect(DEFAULT_EFFECTS_CONFIG.backgroundTileOffsetY).toBe(0);
    });
  });

  describe('tiling effect instance defaults', () => {
    it('default tiling effect has mode=both', () => {
      expect(DEFAULT_POST_PROCESSING_CONFIG.tiling.mode).toBe('both');
    });

    it('default tiling effect has offsetX=0 and offsetY=0', () => {
      expect(DEFAULT_POST_PROCESSING_CONFIG.tiling.offsetX).toBe(0);
      expect(DEFAULT_POST_PROCESSING_CONFIG.tiling.offsetY).toBe(0);
    });
  });

  describe('effect instance factory', () => {
    it('tiling is in POST_PROCESSING_EFFECT_TYPES', () => {
      expect(POST_PROCESSING_EFFECT_TYPES).toContain('tiling');
    });

    it('can create a tiling effect instance via factory', () => {
      const instance = createDefaultInstance('tiling');
      expect(instance).toBeDefined();
      expect(instance.type).toBe('tiling');
      const config = instance.config as { enabled?: boolean; mode?: string };
      expect(config.enabled).toBe(true);
      expect(config.mode).toBe('both');
    });
  });
});

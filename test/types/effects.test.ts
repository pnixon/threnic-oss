import { describe, it, expect } from 'vitest';
import { DEFAULT_EFFECTS_CONFIG, DEFAULT_CLOUD_SCENE_CONFIG } from '@/types/effects';

describe('effects types', () => {
  it('exports defaults', () => {
    expect(DEFAULT_EFFECTS_CONFIG).toBeDefined();
    expect(DEFAULT_CLOUD_SCENE_CONFIG).toBeDefined();
    expect(DEFAULT_CLOUD_SCENE_CONFIG.skyColor).toBeDefined();
  });
});

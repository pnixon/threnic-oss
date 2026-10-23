import { describe, it, expect } from 'vitest';
import { POST_PROCESSING_EFFECT_TYPES, EFFECT_LABELS } from './effect-instances';
import { DEFAULT_POST_PROCESSING_CONFIG } from './defaults';

describe('tiling effect type registration', () => {
  it('is listed in POST_PROCESSING_EFFECT_TYPES', () => {
    expect(POST_PROCESSING_EFFECT_TYPES).toContain('tiling');
  });

  it('has a human-readable label', () => {
    expect(EFFECT_LABELS.tiling).toBe('Tiling');
  });

  it('has default config with correct shape', () => {
    const defaults = DEFAULT_POST_PROCESSING_CONFIG.tiling;
    expect(defaults).toBeDefined();
    expect(defaults.enabled).toBe(false);
    expect(defaults.mode).toBe('both');
    expect(defaults.offsetX).toBe(0);
    expect(defaults.offsetY).toBe(0);
  });

  it('zoom effect does NOT contain tiling property in defaults', () => {
    const zoomDefaults = DEFAULT_POST_PROCESSING_CONFIG.zoom;
    expect(zoomDefaults).toBeDefined();
    expect((zoomDefaults as { tiling?: unknown }).tiling).toBeUndefined();
  });
});

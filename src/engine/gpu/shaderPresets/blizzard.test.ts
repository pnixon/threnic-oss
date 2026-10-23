import { describe, it, expect } from 'vitest';
import { BLIZZARD_PRESET } from './blizzard';

describe('BLIZZARD_PRESET', () => {
  it('has the expected identity fields', () => {
    expect(BLIZZARD_PRESET.id).toBe('blizzard');
    expect(BLIZZARD_PRESET.label).toBe('Blizzard');
    expect(BLIZZARD_PRESET.palette).toBe('blood-snow');
    expect(typeof BLIZZARD_PRESET.description).toBe('string');
    expect(BLIZZARD_PRESET.description.length).toBeGreaterThan(0);
  });

  it('exposes exactly two params on slots p0 and p1 with min < default < max', () => {
    expect(BLIZZARD_PRESET.params).toHaveLength(2);

    const slots = BLIZZARD_PRESET.params.map((p) => p.slot);
    expect(slots).toContain('p0');
    expect(slots).toContain('p1');

    for (const p of BLIZZARD_PRESET.params) {
      expect(p.min).toBeLessThan(p.default);
      expect(p.default).toBeLessThan(p.max);
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.step).toBeGreaterThan(0);
    }
  });

  it('has a non-empty WGSL body implementing the render entry point', () => {
    expect(typeof BLIZZARD_PRESET.body).toBe('string');
    expect(BLIZZARD_PRESET.body.length).toBeGreaterThan(0);
    expect(BLIZZARD_PRESET.body).toContain('fn render(uv: vec2f) -> vec4f');
  });

  it('body references the p0 param accessor and the palette function', () => {
    expect(BLIZZARD_PRESET.body).toContain('u_p0');
    expect(BLIZZARD_PRESET.body).toContain('palette');
  });
});

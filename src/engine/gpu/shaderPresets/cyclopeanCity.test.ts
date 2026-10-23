import { describe, it, expect } from 'vitest';
import { CYCLOPEAN_CITY_PRESET } from './cyclopeanCity';

describe('CYCLOPEAN_CITY_PRESET', () => {
  it('has the correct identity fields', () => {
    expect(CYCLOPEAN_CITY_PRESET.id).toBe('cyclopeanCity');
    expect(CYCLOPEAN_CITY_PRESET.label).toBe('Cyclopean City');
    expect(CYCLOPEAN_CITY_PRESET.palette).toBe('abyssal');
    expect(CYCLOPEAN_CITY_PRESET.description.length).toBeGreaterThan(0);
  });

  it('exposes exactly two params on slots p0 and p1 with min < default < max', () => {
    const { params } = CYCLOPEAN_CITY_PRESET;
    expect(params).toHaveLength(2);

    const slots = params.map((p) => p.slot);
    expect(slots).toContain('p0');
    expect(slots).toContain('p1');

    for (const p of params) {
      expect(p.min).toBeLessThan(p.default);
      expect(p.default).toBeLessThan(p.max);
      expect(p.step).toBeGreaterThan(0);
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('has a WGSL body defining render() and referencing the contract accessors', () => {
    const { body } = CYCLOPEAN_CITY_PRESET;
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('fn render(uv: vec2f) -> vec4f');
    expect(body).toContain('u_p0');
    expect(body).toContain('palette');
  });
});

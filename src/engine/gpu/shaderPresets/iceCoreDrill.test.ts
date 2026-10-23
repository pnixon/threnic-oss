import { describe, expect, it } from 'vitest';

import { ICE_CORE_DRILL_PRESET } from './iceCoreDrill';

describe('ICE_CORE_DRILL_PRESET', () => {
  it('has the correct identity fields', () => {
    expect(ICE_CORE_DRILL_PRESET.id).toBe('iceCoreDrill');
    expect(ICE_CORE_DRILL_PRESET.label).toBe('Ice Core Drill');
    expect(ICE_CORE_DRILL_PRESET.palette).toBe('antarctic-ice');
    expect(ICE_CORE_DRILL_PRESET.description.length).toBeGreaterThan(0);
  });

  it('exposes exactly two params mapped to p0 and p1', () => {
    const params = ICE_CORE_DRILL_PRESET.params;
    expect(params).toHaveLength(2);

    const slots = params.map((p) => p.slot);
    expect(slots).toContain('p0');
    expect(slots).toContain('p1');
  });

  it('has valid ranges for every param (min < default < max)', () => {
    for (const p of ICE_CORE_DRILL_PRESET.params) {
      expect(p.min).toBeLessThan(p.max);
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
      expect(p.default).toBeGreaterThan(p.min);
      expect(p.default).toBeLessThan(p.max);
      expect(p.step).toBeGreaterThan(0);
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('defines a render entry point and references audio/palette helpers', () => {
    const body = ICE_CORE_DRILL_PRESET.body;
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('fn render(uv: vec2f) -> vec4f');
    expect(body).toContain('u_p0');
    expect(body).toContain('u_p1');
    expect(body).toContain('palette');
    // Audio-reactive drivers required by the theme.
    expect(body).toContain('u_bass');
    expect(body).toContain('u_beat');
    expect(body).toContain('u_treb');
  });
});

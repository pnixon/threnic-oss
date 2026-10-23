import { describe, it, expect } from 'vitest';
import { ANTARCTIC_VOID_PRESET } from './antarcticVoid';

describe('ANTARCTIC_VOID_PRESET', () => {
  it('has the correct id, label, and palette', () => {
    expect(ANTARCTIC_VOID_PRESET.id).toBe('antarcticVoid');
    expect(ANTARCTIC_VOID_PRESET.label).toBe('Antarctic Void');
    expect(ANTARCTIC_VOID_PRESET.palette).toBe('antarctic-ice');
  });

  it('has a non-empty description', () => {
    expect(typeof ANTARCTIC_VOID_PRESET.description).toBe('string');
    expect(ANTARCTIC_VOID_PRESET.description.length).toBeGreaterThan(0);
  });

  it('exposes exactly 2 params mapped to slots p0 and p1', () => {
    const { params } = ANTARCTIC_VOID_PRESET;
    expect(params).toHaveLength(2);

    const slots = params.map((p) => p.slot);
    expect(slots).toContain('p0');
    expect(slots).toContain('p1');
  });

  it('has sane min < default < max (with sensible bounds) for every param', () => {
    for (const p of ANTARCTIC_VOID_PRESET.params) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.step).toBeGreaterThan(0);
      expect(p.min).toBeLessThan(p.max);
      // default is within range and strictly between the extremes here
      expect(p.default).toBeGreaterThan(p.min);
      expect(p.default).toBeLessThan(p.max);
    }
  });

  it('has a body defining render() and referencing u_p0 and palette', () => {
    const { body } = ANTARCTIC_VOID_PRESET;
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('fn render(uv: vec2f) -> vec4f');
    expect(body).toContain('u_p0');
    expect(body).toContain('palette');
  });

  it('drives both slots from the shader body (u_p0 and u_p1)', () => {
    const { body } = ANTARCTIC_VOID_PRESET;
    expect(body).toContain('u_p0()');
    expect(body).toContain('u_p1()');
  });

  it('is audio-reactive (references mid/energy/bass/beat)', () => {
    const { body } = ANTARCTIC_VOID_PRESET;
    expect(body).toContain('u_mid()');
    expect(body).toContain('u_energy()');
    expect(body).toContain('u_bass()');
    expect(body).toContain('u_beat()');
  });
});

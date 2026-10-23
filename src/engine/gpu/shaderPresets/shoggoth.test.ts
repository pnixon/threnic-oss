import { describe, it, expect } from 'vitest';
import { SHOGGOTH_PRESET } from './shoggoth';

describe('SHOGGOTH_PRESET', () => {
  it('has the correct id, label, and palette', () => {
    expect(SHOGGOTH_PRESET.id).toBe('shoggoth');
    expect(SHOGGOTH_PRESET.label).toBe('The Shoggoth');
    expect(SHOGGOTH_PRESET.palette).toBe('elder-green');
  });

  it('has a non-empty description', () => {
    expect(typeof SHOGGOTH_PRESET.description).toBe('string');
    expect(SHOGGOTH_PRESET.description.length).toBeGreaterThan(0);
  });

  it('exposes exactly 2 params mapped to slots p0 and p1', () => {
    const { params } = SHOGGOTH_PRESET;
    expect(params).toHaveLength(2);

    const slots = params.map((p) => p.slot);
    expect(slots).toContain('p0');
    expect(slots).toContain('p1');
  });

  it('has sane min < default < max for every param', () => {
    for (const p of SHOGGOTH_PRESET.params) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.step).toBeGreaterThan(0);
      expect(p.min).toBeLessThan(p.max);
      expect(p.default).toBeGreaterThan(p.min);
      expect(p.default).toBeLessThan(p.max);
    }
  });

  it('has a body defining render() and referencing u_p0 and palette', () => {
    const { body } = SHOGGOTH_PRESET;
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('fn render(uv: vec2f) -> vec4f');
    expect(body).toContain('u_p0');
    expect(body).toContain('palette');
  });

  it('drives both slots from the shader body (u_p0 and u_p1)', () => {
    const { body } = SHOGGOTH_PRESET;
    expect(body).toContain('u_p0()');
    expect(body).toContain('u_p1()');
  });

  it('is audio-reactive: bass swell, treble Tekeli-li jitter, beat burst, energy', () => {
    const { body } = SHOGGOTH_PRESET;
    expect(body).toContain('u_bass()');
    expect(body).toContain('u_treb()');
    expect(body).toContain('u_beat()');
    expect(body).toContain('u_energy()');
  });
});

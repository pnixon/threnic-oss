import { describe, it, expect } from 'vitest';
import { SHADER_PRELUDE } from './prelude.wgsl';

/**
 * Sentinel round-trip guard (review correction 3).
 *
 * A struct-size↔buffer-size assertion catches 128→160 but NOT a transposed
 * vec4. These tests pin every relevant float to a distinct meaning:
 *  - the prelude must map each accessor to the correct struct field + component
 *  - all eight u_valueN accessors exist and map to e.xyzw / f.xyzw
 *  - every legacy accessor the 15 shipped presets rely on is preserved.
 */

// accessor -> (struct field . component) as laid out in the U struct.
const ACCESSOR_MAP: Array<[string, string]> = [
  ['u_time()', 'u.a.x'],
  ['u_energy()', 'u.a.y'],
  ['u_beat()', 'u.a.z'],
  ['u_pulsePhase()', 'u.a.w'],
  ['u_bass()', 'u.b.x'],
  ['u_mid()', 'u.b.y'],
  ['u_treb()', 'u.b.z'],
  ['u_p0()', 'u.c.z'],
  ['u_p1()', 'u.c.w'],
  ['u_opacity()', 'u.d.x'],
  ['u_blendMode()', 'u.d.y'],
  ['u_p2()', 'u.d.z'],
  ['u_p3()', 'u.d.w'],
  ['u_value1()', 'u.e.x'],
  ['u_value2()', 'u.e.y'],
  ['u_value3()', 'u.e.z'],
  ['u_value4()', 'u.e.w'],
  ['u_value5()', 'u.f.x'],
  ['u_value6()', 'u.f.y'],
  ['u_value7()', 'u.f.z'],
  ['u_value8()', 'u.f.w'],
];

describe('SHADER_PRELUDE — 160-byte uniform layout (Stage 1)', () => {
  it('declares a 10 x vec4f struct with the two new slot vectors e and f', () => {
    const start = SHADER_PRELUDE.indexOf('struct U');
    const structBlock = SHADER_PRELUDE.slice(start, SHADER_PRELUDE.indexOf('};', start));
    const vec4Count = (structBlock.match(/vec4f/g) ?? []).length;
    expect(vec4Count).toBe(10); // 8 shipped + e + f = 160 bytes
    expect(structBlock).toMatch(/\be:\s*vec4f/);
    expect(structBlock).toMatch(/\bf:\s*vec4f/);
  });

  it('maps every accessor to the correct struct field + component', () => {
    for (const [accessor, field] of ACCESSOR_MAP) {
      const name = accessor.replace('()', '');
      const re = new RegExp(
        `fn\\s+${name}\\s*\\(\\)\\s*->\\s*f32\\s*\\{[^}]*return\\s+${field.replace(/\./g, '\\.')}\\s*;`,
      );
      expect(SHADER_PRELUDE, `${accessor} must return ${field}`).toMatch(re);
    }
  });

  it('exposes exactly eight u_valueN accessors (no more, no fewer)', () => {
    const matches = SHADER_PRELUDE.match(/fn\s+u_value\d+\s*\(\)/g) ?? [];
    expect(matches).toHaveLength(8);
    for (let i = 1; i <= 8; i++) {
      expect(SHADER_PRELUDE).toContain(`fn u_value${i}()`);
    }
  });
});

describe('SHADER_PRELUDE — existing accessors preserved (presets compile untouched)', () => {
  it('keeps every legacy accessor the 15 shipped presets rely on', () => {
    for (const acc of [
      'fn u_time()',
      'fn u_energy()',
      'fn u_beat()',
      'fn u_bass()',
      'fn u_mid()',
      'fn u_treb()',
      'fn u_p0()',
      'fn u_p1()',
      'fn u_p2()',
      'fn u_p3()',
      'fn u_opacity()',
      'fn u_blendMode()',
      'fn palette(',
    ]) {
      expect(SHADER_PRELUDE).toContain(acc);
    }
  });
});

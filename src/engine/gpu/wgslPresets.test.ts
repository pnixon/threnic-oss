import { describe, it, expect } from 'vitest';
import { WGSL_PRESETS, WGSL_CUSTOM_ID, getWgslPreset, matchWgslPresetId } from './wgslPresets';

describe('wgslPresets — curated customShader transform library', () => {
  it('lists custom first, then real presets that sample the layer beneath', () => {
    expect(WGSL_PRESETS[0].id).toBe(WGSL_CUSTOM_ID);
    const real = WGSL_PRESETS.filter((p) => p.id !== WGSL_CUSTOM_ID);
    expect(real.length).toBeGreaterThan(0);
    for (const p of real) {
      // Transform contract: declares fs_main and reads inputTexture.
      expect(p.source).toContain('fn fs_main');
      expect(p.source).toContain('@location(0) vec4f');
      expect(p.source).toContain('inputTexture');
    }
  });

  it('every preset uniform layout is 16-byte aligned and matches uniformSize', () => {
    for (const p of WGSL_PRESETS) {
      if (p.id === WGSL_CUSTOM_ID) continue;
      // Layout must be a multiple of 4 f32s (16 bytes) so the buffer aligns.
      expect(p.parameters.length % 4).toBe(0);
      expect(p.uniformSize).toBe(p.parameters.length * 4);
    }
  });

  it('preset struct declares its parameters IN ORDER (so uniformLayout packs correctly)', () => {
    for (const p of WGSL_PRESETS) {
      if (p.id === WGSL_CUSTOM_ID) continue;
      // Each declared field name appears in the WGSL struct, and non-_pad fields
      // appear in the same order they are declared (a cheap struct/param check).
      const names = p.parameters.map((f) => f.name).filter((n) => !n.startsWith('_pad'));
      let idx = -1;
      for (const n of names) {
        const at = p.source.indexOf(`${n}:`);
        expect(at, `${p.id}: field ${n} missing from struct`).toBeGreaterThan(-1);
        expect(at, `${p.id}: field ${n} out of order`).toBeGreaterThan(idx);
        idx = at;
      }
    }
  });

  it('getWgslPreset returns undefined for custom/unknown, the preset otherwise', () => {
    expect(getWgslPreset(WGSL_CUSTOM_ID)).toBeUndefined();
    expect(getWgslPreset('nope')).toBeUndefined();
    const first = WGSL_PRESETS[1];
    expect(getWgslPreset(first.id)?.id).toBe(first.id);
  });

  it('matchWgslPresetId identifies a known source (trim-insensitive), else custom', () => {
    const preset = WGSL_PRESETS[1];
    expect(matchWgslPresetId(preset.source)).toBe(preset.id);
    expect(matchWgslPresetId(`  ${preset.source}  `)).toBe(preset.id); // trimmed
    expect(matchWgslPresetId('@fragment fn fs_main() {}')).toBe(WGSL_CUSTOM_ID);
  });
});

import { describe, it, expect } from 'vitest';
import { createStyleRegistry, EMPTY_STYLE_REGISTRY, type LyricStyle } from './StyleRegistry';

const dummy: LyricStyle = {
  id: 'dummy',
  name: 'Dummy',
  modifyWord: () => ({ scaleMul: 2 }),
};

describe('StyleRegistry', () => {
  it('resolves a style by id', () => {
    const reg = createStyleRegistry([dummy]);
    expect(reg.getById('dummy')?.name).toBe('Dummy');
    expect(reg.getById('dummy')?.modifyWord({} as never).scaleMul).toBe(2);
  });

  it('returns undefined for an unknown id', () => {
    const reg = createStyleRegistry([dummy]);
    expect(reg.getById('nope')).toBeUndefined();
  });

  it('empty registry resolves nothing', () => {
    expect(EMPTY_STYLE_REGISTRY.getById('dummy')).toBeUndefined();
  });
});

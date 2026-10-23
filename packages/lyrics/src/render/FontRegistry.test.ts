import { describe, it, expect } from 'vitest';
import { createFontRegistry, EMPTY_FONT_REGISTRY } from './FontRegistry';

describe('FontRegistry', () => {
  it('resolves a font by id', () => {
    const reg = createFontRegistry([
      { id: 'roboto', name: 'Roboto Mono', url: '/fonts/RobotoMono-Regular.ttf' },
      { id: 'space', name: 'Space Mono', url: '/fonts/SpaceMono-Regular.ttf' },
    ]);
    expect(reg.getById('roboto')?.url).toBe('/fonts/RobotoMono-Regular.ttf');
    expect(reg.getById('space')?.name).toBe('Space Mono');
  });

  it('returns undefined for an unknown id', () => {
    const reg = createFontRegistry([
      { id: 'roboto', name: 'Roboto Mono', url: '/fonts/RobotoMono-Regular.ttf' },
    ]);
    expect(reg.getById('nope')).toBeUndefined();
  });

  it('empty registry resolves nothing', () => {
    expect(EMPTY_FONT_REGISTRY.getById('roboto')).toBeUndefined();
  });
});

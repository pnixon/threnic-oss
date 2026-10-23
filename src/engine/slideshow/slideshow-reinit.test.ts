import { describe, it, expect } from 'vitest';
import { SlideshowDriver } from './SlideshowDriver';
import type { SlideshowConfig, SlideshowMediaItem } from '@/types/effects/background';

/** Helper: build N media items with unique IDs and URLs. */
function makeItems(n: number, prefix = 'img'): SlideshowMediaItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    url: `/${prefix}/${i}.jpg`,
    type: 'image' as const,
  }));
}

/** Helper: build a config from items with optional overrides. */
function makeConfig(
  items: SlideshowMediaItem[],
  overrides?: Partial<SlideshowConfig>,
): SlideshowConfig {
  return {
    items,
    mode: 'slideshow',
    order: 'sequential',
    transition: 'crossfade',
    transitionDuration: 1.0,
    timingMode: 'static',
    staticDuration: 5.0,
    randomDurationMin: 3,
    randomDurationMax: 8,
    videoEndTransition: false,
    ...overrides,
  };
}

describe('SlideshowDriver reinitialisation', () => {
  it('init() sets slot1 URL to first item', () => {
    const driver = new SlideshowDriver();
    const items = makeItems(3);
    const cfg = makeConfig(items);
    driver.init(items, cfg);

    const state = driver.tick(0, cfg);
    expect(state.slot1.url).toBe(items[0].url);
  });

  it('init() clears slot2', () => {
    const driver = new SlideshowDriver();
    const items = makeItems(3, 'a');
    const cfg = makeConfig(items, { staticDuration: 1.0, transitionDuration: 1.0 });
    driver.init(items, cfg);

    // Tick enough to start transition — slot2 should populate
    driver.tick(1.0, cfg);
    const mid = driver.tick(0.1, cfg);
    expect(mid.transitioning).toBe(true);
    expect(mid.slot2.url).not.toBeNull();

    // Re-init with new items
    const newItems = makeItems(3, 'b');
    const newCfg = makeConfig(newItems, { staticDuration: 1.0, transitionDuration: 1.0 });
    driver.init(newItems, newCfg);

    const state = driver.tick(0, newCfg);
    expect(state.slot2.url).toBeNull();
  });

  it('re-init with different URLs resets slot tracking', () => {
    const driver = new SlideshowDriver();
    const items = makeItems(3, 'old');
    const cfg = makeConfig(items, { staticDuration: 1.0, transitionDuration: 0.5 });
    driver.init(items, cfg);

    // Advance several seconds to move past first slide
    driver.tick(2.0, cfg);
    driver.tick(1.0, cfg);

    // Re-init with completely different URLs
    const newItems = makeItems(3, 'new');
    const newCfg = makeConfig(newItems, { staticDuration: 1.0, transitionDuration: 0.5 });
    driver.init(newItems, newCfg);

    const state = driver.tick(0, newCfg);
    expect(state.slot1.url).toBe(newItems[0].url);
  });

  it('time resets to 0 after re-init', () => {
    const driver = new SlideshowDriver();
    const items = makeItems(3);
    const cfg = makeConfig(items);
    driver.init(items, cfg);

    // Accumulate 5s
    driver.tick(5, cfg);
    expect(driver.time).toBeGreaterThan(0);

    // Re-init
    driver.init(items, cfg);

    // Small tick — time should be near 0
    driver.tick(0.01, cfg);
    expect(driver.time).toBeCloseTo(0.01, 2);
  });

  it('url change in same-id item is detected via wallClock reset', () => {
    const driver = new SlideshowDriver();

    // Original items: ids a/b/c with original URLs
    const items: SlideshowMediaItem[] = [
      { id: 'a', url: '/original/a.jpg', type: 'image' },
      { id: 'b', url: '/original/b.jpg', type: 'image' },
      { id: 'c', url: '/original/c.jpg', type: 'image' },
    ];
    const cfg = makeConfig(items);
    driver.init(items, cfg);

    // Tick a few seconds
    driver.tick(3, cfg);

    // Re-init with same IDs but different URLs
    const updated: SlideshowMediaItem[] = [
      { id: 'a', url: '/updated/a.jpg', type: 'image' },
      { id: 'b', url: '/updated/b.jpg', type: 'image' },
      { id: 'c', url: '/updated/c.jpg', type: 'image' },
    ];
    const updatedCfg = makeConfig(updated);
    driver.init(updated, updatedCfg);

    const state = driver.tick(0, updatedCfg);
    expect(state.slot1.url).toBe('/updated/a.jpg');
  });
});

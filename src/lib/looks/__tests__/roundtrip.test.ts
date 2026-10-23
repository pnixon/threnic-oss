/**
 * Look serialize → apply round-trip tests (Stage 4).
 *
 * Corpus:
 *  - a Look with a `data:` URL asset (video.url) — packs + rehydrates identically
 *  - a Look with slideshow items (blob: + data: + public path)
 *  - a Look with an unknown/rejected effect instance type — dropped on apply
 *
 * `projectStore.applyPresetLook` is mocked; we assert it is called with the
 * rehydrated config (no `look-asset:` refs remain) and the right lyricTheme /
 * backgroundImageUrl. A pure blob→dataURI resolver is injected so the tests run
 * without a DOM/fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import type { EffectsConfig, EffectInstance } from '@/types/effects';
import type { Track } from '@/contexts/types';
import { SCHEMA_TAG } from '@/types/look-template';

// ── Mock the store BEFORE importing the module under test ──
const applyPresetLook = vi.fn();
vi.mock('@/stores/projectStore', () => ({
  projectStore: {
    getState: () => ({ applyPresetLook }),
  },
}));

import { serializeLook, applyLook, migrateLook } from '../serialize';
import { packEffectsAssets, rehydrateEffectsAssets } from '../assets';

/** Deterministic blob→data-URI resolver: maps a blob: URL to a fixed data URI. */
const fakeResolve = async (url: string): Promise<string> => {
  // one-byte png-ish payload, base64 "AAAA" = 3 bytes
  return `data:image/png;base64,AAAA#${url}`;
};

function cloneConfig(): EffectsConfig {
  return JSON.parse(JSON.stringify(DEFAULT_EFFECTS_CONFIG)) as EffectsConfig;
}

function makeTrack(config: EffectsConfig, over: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    name: 'Test Track',
    duration: 100,
    audioUrl: 'blob:audio',
    effectsConfig: config,
    ...over,
  };
}

beforeEach(() => {
  applyPresetLook.mockClear();
});

describe('serializeLook / applyLook round-trip', () => {
  it('packs a data: URL asset and rehydrates it identically through applyPresetLook', async () => {
    const config = cloneConfig();
    const dataUri = 'data:video/mp4;base64,QUJDRA=='; // "ABCD"
    config.video = { ...config.video, enabled: true, url: dataUri };

    const track = makeTrack(config, { lyricsTheme: { fontId: 'roboto' } as Track['lyricsTheme'] });
    const { look, warnings } = await serializeLook(track, 'My Look', { resolve: fakeResolve });

    // Schema envelope first + stamped fields.
    expect(look.schema).toBe(SCHEMA_TAG);
    expect(look.name).toBe('My Look');
    expect(look.assets.length).toBeGreaterThan(0);

    // The video url in the packed config is now an asset ref, not the data URI.
    expect(look.effectsConfig.video.url).toMatch(/^look-asset:/);
    expect(warnings).toEqual([]);

    // Apply routes through the existing mutation with the rehydrated config.
    const result = await applyLook(look, 'track-1');
    expect(result.ok).toBe(true);
    expect(applyPresetLook).toHaveBeenCalledTimes(1);

    const [calledTrackId, params] = applyPresetLook.mock.calls[0];
    expect(calledTrackId).toBe('track-1');
    // No asset refs survive rehydration — the original data URI is restored.
    expect(params.effectsConfig.video.url).toBe(dataUri);
    expect(params.lyricTheme).toEqual({ fontId: 'roboto' });
  });

  it('packs slideshow items (blob: + data: + public path) and restores them', async () => {
    const config = cloneConfig();
    config.slideshow = {
      ...config.slideshow,
      items: [
        { id: 's1', type: 'image', url: 'blob:local-image' },
        { id: 's2', type: 'image', url: 'data:image/png;base64,QUJD' },
        { id: 's3', type: 'video', url: '/public/clip.mp4' },
      ],
    };

    const track = makeTrack(config);
    const { look } = await serializeLook(track, 'Slides', { resolve: fakeResolve });

    // All three item urls become asset refs.
    for (const item of look.effectsConfig.slideshow.items) {
      expect(item.url).toMatch(/^look-asset:/);
    }

    await applyLook(look, 'track-1');
    const params = applyPresetLook.mock.calls[0][1];
    const items = params.effectsConfig.slideshow.items;

    // blob: → the fake resolved data URI; data: → itself; public path → itself.
    expect(items[0].url).toBe('data:image/png;base64,AAAA#blob:local-image');
    expect(items[1].url).toBe('data:image/png;base64,QUJD');
    expect(items[2].url).toBe('/public/clip.mp4');
  });

  it('rejects unknown effect instance types on apply (untrusted input)', async () => {
    const config = cloneConfig();
    config.effectInstances = [
      {
        id: 'e1',
        type: 'bloom',
        config: DEFAULT_EFFECTS_CONFIG.postProcessing?.bloom,
      } as unknown as EffectInstance,
      { id: 'e2', type: 'totally-made-up', config: {} } as unknown as EffectInstance,
    ];

    const track = makeTrack(config);
    const { look } = await serializeLook(track, 'Mixed', { resolve: fakeResolve });

    const result = await applyLook(look, 'track-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes('totally-made-up'))).toBe(true);
    }

    const params = applyPresetLook.mock.calls[0][1];
    const keptTypes = params.effectsConfig.effectInstances.map((i: EffectInstance) => i.type);
    expect(keptTypes).toContain('bloom');
    expect(keptTypes).not.toContain('totally-made-up');
  });

  it('packs the track-level background image and rehydrates it into backgroundImageUrl', async () => {
    const config = cloneConfig();
    const track = makeTrack(config, { backgroundImage: 'blob:bg-image' });

    const { look } = await serializeLook(track, 'BG', { resolve: fakeResolve });
    expect(look.assets.some((a) => a.id === 'look-asset:bg')).toBe(true);

    await applyLook(look, 'track-1');
    const params = applyPresetLook.mock.calls[0][1];
    expect(params.backgroundImageUrl).toBe('data:image/png;base64,AAAA#blob:bg-image');
  });

  it('drops customer-local IndexedDB asset keys with a warning', async () => {
    const config = cloneConfig();
    config.postProcessing = {
      ...config.postProcessing,
      bgImageOverlay: { ...config.postProcessing.bgImageOverlay, imageAssetId: 'idb-key-123' },
    } as EffectsConfig['postProcessing'];

    const track = makeTrack(config);
    const { look, warnings } = await serializeLook(track, 'Local', { resolve: fakeResolve });

    expect(look.effectsConfig.postProcessing.bgImageOverlay.imageAssetId).toBeUndefined();
    expect(warnings.some((w) => w.includes('bgImageOverlay.imageAssetId'))).toBe(true);
  });
});

describe('migrateLook', () => {
  it('accepts a valid schema tag', () => {
    const raw = { schema: SCHEMA_TAG, effectsConfig: {}, assets: [] };
    expect(migrateLook(raw)).not.toBeNull();
  });

  it('rejects an unknown / missing schema tag', () => {
    expect(migrateLook({ schema: 'threnic.look/999', effectsConfig: {} })).toBeNull();
    expect(migrateLook({ effectsConfig: {} })).toBeNull();
    expect(migrateLook(null)).toBeNull();
    expect(migrateLook('nope')).toBeNull();
  });

  it('rejects a document with no effectsConfig', () => {
    expect(migrateLook({ schema: SCHEMA_TAG })).toBeNull();
  });
});

describe('applyLook error paths', () => {
  it('returns ok:false for a non-Look document', async () => {
    const result = await applyLook({ not: 'a look' }, 'track-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/recognized Look/);
    expect(applyPresetLook).not.toHaveBeenCalled();
  });

  it('returns ok:false when no track id is given', async () => {
    const raw = { schema: SCHEMA_TAG, effectsConfig: cloneConfig(), assets: [] };
    const result = await applyLook(raw, '');
    expect(result.ok).toBe(false);
    expect(applyPresetLook).not.toHaveBeenCalled();
  });
});

describe('packEffectsAssets / rehydrateEffectsAssets (pure)', () => {
  it('is a pure round-trip for grain bundles', async () => {
    const config = cloneConfig();
    config.postProcessing = {
      ...config.postProcessing,
      oldFilm: {
        ...config.postProcessing.oldFilm,
        grainBundle: ['blob:g0', 'data:image/png;base64,QQ=='],
      },
    } as EffectsConfig['postProcessing'];

    const { config: packed, assets } = await packEffectsAssets(config, { resolve: fakeResolve });
    // Packed refs are asset ids.
    for (const ref of packed.postProcessing.oldFilm.grainBundle!) {
      expect(ref).toMatch(/^look-asset:/);
    }

    const restored = rehydrateEffectsAssets(packed, assets);
    expect(restored.postProcessing.oldFilm.grainBundle).toEqual([
      'data:image/png;base64,AAAA#blob:g0',
      'data:image/png;base64,QQ==',
    ]);
  });

  it('does not mutate the input config', async () => {
    const config = cloneConfig();
    config.video = { ...config.video, url: 'blob:x' };
    const snapshot = JSON.stringify(config);
    await packEffectsAssets(config, { resolve: fakeResolve });
    expect(JSON.stringify(config)).toBe(snapshot);
  });
});

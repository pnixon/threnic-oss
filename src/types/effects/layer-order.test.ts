import { describe, it, expect } from 'vitest';
import {
  resolveLayerOrder,
  layerTokenKey,
  splitPassesAroundLyrics,
  isPinnedSceneInstance,
  pinnedReasonForInstance,
  type LayerToken,
} from '@/types/effects/layer-order';
import type { EffectInstance } from '@/types/effects/effect-instances';

function fx(id: string, enabled = true): EffectInstance {
  return { id, type: 'bloom', config: { enabled } as EffectInstance['config'] } as EffectInstance;
}

function typed(id: string, type: string, enabled = true): EffectInstance {
  return { id, type, config: { enabled } as EffectInstance['config'] } as EffectInstance;
}

function typedMode(id: string, type: string, mode: string, enabled = true): EffectInstance {
  return { id, type, config: { enabled, mode } as EffectInstance['config'] } as EffectInstance;
}

describe('resolveLayerOrder — fixed bottom scene group (all shaderFx modes pinned)', () => {
  it('pins every shaderFx mode + butterchurn, and gives each a reason', () => {
    const cases: Array<[EffectInstance, boolean]> = [
      [typed('a', 'bloom'), false],
      [typed('bc', 'butterchurn'), true],
      [typed('sfx', 'shaderFx'), true], // WGSL shader (no mode)
      [typedMode('sfxs', 'shaderFx', 'shader'), true],
      [typedMode('sfxg', 'shaderFx', 'glsl'), true],
      [typedMode('sfxbc', 'shaderFx', 'butterchurn'), true],
      [typedMode('sfxlj', 'shaderFx', 'littlejs'), true],
    ];
    for (const [inst, pinned] of cases) {
      expect(isPinnedSceneInstance(inst)).toBe(pinned);
      const reason = pinnedReasonForInstance(inst);
      if (pinned) {
        expect(typeof reason).toBe('string');
        expect((reason as string).length).toBeGreaterThan(0);
      } else {
        expect(reason).toBeNull();
      }
    }
  });

  it('pins butterchurn AND shader-mode shaderFx above background, hoisting from any saved position', () => {
    // Every shaderFx mode composites at the fixed background boundary in the
    // renderer, so a shaderFx row is pinned (non-draggable) regardless of mode.
    const instances = [
      typed('bloom1', 'bloom'),
      typed('bc', 'butterchurn'),
      typed('sfx', 'shaderFx'), // no mode → WGSL shader semantics → pinned
    ];
    const saved: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'bloom1' },
      { kind: 'effect', id: 'sfx' }, // placed HIGH by the user, but must be hoisted
      { kind: 'effect', id: 'bc' },
      { kind: 'lyrics' },
    ];
    const order = resolveLayerOrder(instances, saved);
    expect(order[0]).toEqual({ kind: 'background' });
    // Both pinned scene sources hoisted above bg: butterchurn (rank 0) then shaderFx (rank 1).
    expect(order[1]).toEqual({ kind: 'effect', id: 'bc' });
    expect(order[2]).toEqual({ kind: 'effect', id: 'sfx' });
    // The draggable bloom pass and lyrics follow.
    expect(order.slice(3).map((t) => (t.kind === 'effect' ? t.id : t.kind))).toEqual([
      'bloom1',
      'lyrics',
    ]);
  });

  it('pins a shaderFx in butterchurn/littlejs mode above background', () => {
    const instances = [typed('bloom1', 'bloom'), typedMode('sfxbc', 'shaderFx', 'butterchurn')];
    const saved: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'bloom1' },
      { kind: 'effect', id: 'sfxbc' }, // placed high, but non-shader mode → pinned
      { kind: 'lyrics' },
    ];
    const order = resolveLayerOrder(instances, saved);
    expect(order[0]).toEqual({ kind: 'background' });
    expect(order[1]).toEqual({ kind: 'effect', id: 'sfxbc' }); // hoisted above bg
  });

  it('leaves order unchanged when no scene sources are enabled', () => {
    const instances = [typed('a', 'bloom'), typed('b', 'glitch')];
    const order = resolveLayerOrder(instances, undefined);
    expect(order).toEqual([
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'effect', id: 'b' },
      { kind: 'lyrics' },
    ]);
  });

  it('pins a lone butterchurn right above background even in legacy order', () => {
    const instances = [typed('a', 'bloom'), typed('bc', 'butterchurn')];
    const order = resolveLayerOrder(instances, undefined);
    expect(order[0]).toEqual({ kind: 'background' });
    expect(order[1]).toEqual({ kind: 'effect', id: 'bc' });
  });
});

describe('resolveLayerOrder', () => {
  it('produces legacy order when no saved order is present', () => {
    const instances = [fx('a'), fx('b')];
    const order = resolveLayerOrder(instances, undefined);
    expect(order).toEqual([
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'effect', id: 'b' },
      { kind: 'lyrics' },
    ]);
  });

  it('produces legacy order for an empty saved order', () => {
    const order = resolveLayerOrder([fx('a')], []);
    expect(order.map((t) => t.kind)).toEqual(['background', 'effect', 'lyrics']);
  });

  it('only includes ENABLED effects in the legacy order', () => {
    const order = resolveLayerOrder([fx('a', true), fx('b', false)], undefined);
    expect(order).toEqual([
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
    ]);
  });

  it('honors a saved order that places lyrics below one effect but above the rest', () => {
    // background, effect a, lyrics, effect b  → b is on top of lyrics, a is under
    const saved: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
      { kind: 'effect', id: 'b' },
    ];
    const order = resolveLayerOrder([fx('a'), fx('b')], saved);
    expect(order).toEqual(saved);
  });

  it('allows background to move above an effect (effect under background)', () => {
    const saved: LayerToken[] = [
      { kind: 'effect', id: 'a' },
      { kind: 'background' },
      { kind: 'lyrics' },
    ];
    const order = resolveLayerOrder([fx('a')], saved);
    expect(order).toEqual(saved);
  });

  it('drops effect tokens whose instance no longer exists', () => {
    const saved: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'gone' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
    ];
    const order = resolveLayerOrder([fx('a')], saved);
    expect(order).toEqual([
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
    ]);
  });

  it('drops effect tokens whose instance is now disabled', () => {
    const saved: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
    ];
    const order = resolveLayerOrder([fx('a', false)], saved);
    expect(order).toEqual([{ kind: 'background' }, { kind: 'lyrics' }]);
  });

  it('appends newly-enabled effects just BELOW lyrics (affect lyrics by default)', () => {
    const saved: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
    ];
    // b is enabled but not in the saved order → should land right before lyrics
    const order = resolveLayerOrder([fx('a'), fx('b')], saved);
    expect(order).toEqual([
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'effect', id: 'b' },
      { kind: 'lyrics' },
    ]);
  });

  it('materializes a missing background token at the very bottom', () => {
    const saved: LayerToken[] = [{ kind: 'effect', id: 'a' }, { kind: 'lyrics' }];
    const order = resolveLayerOrder([fx('a')], saved);
    expect(order[0]).toEqual({ kind: 'background' });
  });

  it('materializes a missing lyrics token at the very top', () => {
    const saved: LayerToken[] = [{ kind: 'background' }, { kind: 'effect', id: 'a' }];
    const order = resolveLayerOrder([fx('a')], saved);
    expect(order[order.length - 1]).toEqual({ kind: 'lyrics' });
  });

  it('dedupes duplicate background/lyrics/effect tokens', () => {
    const saved: LayerToken[] = [
      { kind: 'background' },
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
      { kind: 'lyrics' },
    ];
    const order = resolveLayerOrder([fx('a')], saved);
    expect(order).toEqual([
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
    ]);
  });

  it('always contains exactly one background and one lyrics token', () => {
    const cases: (LayerToken[] | undefined)[] = [
      undefined,
      [],
      [{ kind: 'lyrics' }],
      [{ kind: 'background' }],
      [{ kind: 'effect', id: 'a' }],
    ];
    for (const saved of cases) {
      const order = resolveLayerOrder([fx('a')], saved);
      expect(order.filter((t) => t.kind === 'background')).toHaveLength(1);
      expect(order.filter((t) => t.kind === 'lyrics')).toHaveLength(1);
    }
  });
});

describe('layerTokenKey', () => {
  it('produces stable, distinct keys per token', () => {
    expect(layerTokenKey({ kind: 'background' })).toBe('layer:background');
    expect(layerTokenKey({ kind: 'lyrics' })).toBe('layer:lyrics');
    expect(layerTokenKey({ kind: 'effect', id: 'x' })).toBe('layer:effect:x');
  });
});

describe('splitPassesAroundLyrics', () => {
  // Simple identity resolver: instance id "e:bloom" → pass id "bloom".
  const resolve = (id: string) => (id.startsWith('e:') ? id.slice(2) : null);

  it('puts all effects below when lyrics is on top (legacy)', () => {
    const order: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'e:bloom' },
      { kind: 'effect', id: 'e:glitch' },
      { kind: 'lyrics' },
    ];
    const r = splitPassesAroundLyrics(order, resolve);
    expect(r.below).toEqual(['bloom', 'glitch']);
    expect(r.above).toEqual([]);
    expect(r.anyAbove).toBe(false);
    expect(r.lyricsPresent).toBe(true);
  });

  it('splits effects below vs above the lyrics token', () => {
    // lyrics sits below glitch but above bloom
    const order: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'e:bloom' },
      { kind: 'lyrics' },
      { kind: 'effect', id: 'e:glitch' },
    ];
    const r = splitPassesAroundLyrics(order, resolve);
    expect(r.below).toEqual(['bloom']);
    expect(r.above).toEqual(['glitch']);
    expect(r.anyAbove).toBe(true);
  });

  it('treats all effects as below when there is no lyrics token', () => {
    const order: LayerToken[] = [{ kind: 'background' }, { kind: 'effect', id: 'e:bloom' }];
    const r = splitPassesAroundLyrics(order, resolve);
    expect(r.below).toEqual(['bloom']);
    expect(r.above).toEqual([]);
    expect(r.lyricsPresent).toBe(false);
    expect(r.anyAbove).toBe(false);
  });

  it('ignores effects with no pass id and de-dupes collapsed pass ids', () => {
    const order: LayerToken[] = [
      { kind: 'effect', id: 'e:bloom' },
      { kind: 'effect', id: 'nope' }, // resolves to null
      { kind: 'effect', id: 'e:bloom' }, // duplicate pass id
      { kind: 'lyrics' },
      { kind: 'effect', id: 'e:glitch' },
    ];
    const r = splitPassesAroundLyrics(order, resolve);
    expect(r.below).toEqual(['bloom']);
    expect(r.above).toEqual(['glitch']);
  });
});

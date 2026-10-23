import { describe, it, expect, vi } from 'vitest';
import { EffectsManager } from '@/engine/gpu/EffectsManager';
import type { RenderGraph } from '@/engine/gpu/RenderGraph';
import type { EffectInstance } from '@/types/effects/effect-instances';
import type { EffectsConfig } from '@/types/effects';

/**
 * Minimal RenderGraph stub that records setPassOrder / setPassEnabled calls.
 * We only need to observe that EffectsManager pushes a data-driven pass order
 * derived from the effect-instance array order.
 */
function makeStubGraph() {
  const orderCalls: (string[] | null)[] = [];
  const enabled = new Map<string, boolean>();
  const registered = new Set<string>();
  return {
    orderCalls,
    enabled,
    registered,
    hasPass: (id: string) => registered.has(id),
    // ensurePassesRegistered calls registerPass; resolve immediately + record
    registerPass: vi.fn(async (cfg: { id: string }) => {
      registered.add(cfg.id);
      return true;
    }),
    setPassUniformUpdater: vi.fn(),
    setPassEnabled: vi.fn((id: string, on: boolean) => enabled.set(id, on)),
    setPassOrder: vi.fn((order: string[] | null) => orderCalls.push(order)),
    unregisterPass: vi.fn((id: string) => registered.delete(id)),
  };
}

function inst(id: string, type: string, enabled = true): EffectInstance {
  return { id, type, config: { enabled } } as unknown as EffectInstance;
}

function cfg(instances: EffectInstance[]): EffectsConfig {
  return { effectInstances: instances } as EffectsConfig;
}

describe('EffectsManager pass ordering (Phase 1)', () => {
  it('pushes pass order matching the effect-instance array order', () => {
    const graph = makeStubGraph();
    const mgr = new EffectsManager(graph as unknown as RenderGraph);

    // bloom then distortion → order [bloom-pass, distortion-pass]
    mgr.syncFrame(cfg([inst('a', 'bloom'), inst('b', 'distortion')]));
    const first = graph.orderCalls.at(-1)!;
    expect(first).toBeTruthy();
    // The two passes appear, bloom before distortion
    expect(first.length).toBe(2);

    // Reverse the instance order → the pushed order reverses too
    graph.orderCalls.length = 0;
    mgr.syncFrame(cfg([inst('b', 'distortion'), inst('a', 'bloom')]));
    const second = graph.orderCalls.at(-1)!;
    expect(second.length).toBe(2);
    expect(second).toEqual([first[1], first[0]]);
  });

  it('collapses multiple color-grade effects to a single pass at the first index', () => {
    const graph = makeStubGraph();
    const mgr = new EffectsManager(graph as unknown as RenderGraph);

    // bloom, brightness, contrast → color grade collapses to ONE pass, placed
    // where brightness first appears (index 1)
    mgr.syncFrame(cfg([inst('a', 'bloom'), inst('b', 'brightness'), inst('c', 'contrast')]));
    const order = graph.orderCalls.at(-1)!;
    // Exactly 2 passes: bloom + the merged color-grade pass
    expect(order.length).toBe(2);
  });

  it('excludes disabled effects from the pushed order', () => {
    const graph = makeStubGraph();
    const mgr = new EffectsManager(graph as unknown as RenderGraph);
    mgr.syncFrame(cfg([inst('a', 'bloom', true), inst('b', 'distortion', false)]));
    const order = graph.orderCalls.at(-1)!;
    expect(order.length).toBe(1);
  });
});

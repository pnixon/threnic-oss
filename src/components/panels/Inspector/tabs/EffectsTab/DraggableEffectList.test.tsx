import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, vi, expect, afterEach } from 'vitest';
import { DraggableEffectList } from './DraggableEffectList';
import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';
import type { LayerToken } from '@/types/effects/layer-order';
import { systemStore } from '@/stores/systemStore';

// --- Mock the heavy / DOM-measuring dependencies -------------------------
// pragmatic-drag-and-drop needs real layout measurement; stub the adapters so
// the component mounts. The reorder MATH is exercised indirectly via
// resolveLayerOrder (unit-tested in layer-order.test.ts); here we lock the
// unified-list RENDER STRUCTURE and the enable→layerOrder wiring.
vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
  monitorForElements: () => () => {},
}));
vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine:
    (...fns: Array<() => void>) =>
    () =>
      fns.forEach((f) => f?.()),
}));
vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
  attachClosestEdge: (data: unknown) => data,
  extractClosestEdge: () => 'bottom',
  Edge: {},
}));

// The expandable editor body pulls in the whole schema/preset/context stack —
// not under test here. Stub it to a marker.
vi.mock('@/components/effects/shared/GenericEffectEditor', () => ({
  GenericEffectEditor: () => <div data-testid="editor-body" />,
}));
vi.mock('./GameSceneAssetUploader', () => ({
  GameSceneAssetUploader: () => null,
}));

function makeConfig(instances: EffectInstance[], layerOrder?: LayerToken[]): EffectsConfig {
  return {
    effectInstances: instances,
    layerOrder,
  } as unknown as EffectsConfig;
}

function bloom(id: string, enabled = true): EffectInstance {
  return { id, type: 'bloom', config: { enabled } } as EffectInstance;
}

afterEach(() => {
  cleanup();
  systemStore.getState().setStagePipeline('pending');
});

describe('DraggableEffectList — flat layer stack', () => {
  it('renders the Layers header, Background + Lyrics pinned rows, and the Add Effects group', () => {
    const instances = [bloom('a')];
    const { getByText } = render(
      <DraggableEffectList
        effectsConfig={makeConfig(instances)}
        onEffectsConfigChange={() => {}}
      />,
    );
    expect(getByText('Layers')).toBeTruthy();
    expect(getByText('Background')).toBeTruthy();
    expect(getByText('Lyrics')).toBeTruthy();
    expect(getByText('Add Effects')).toBeTruthy();
    expect(getByText('Bloom')).toBeTruthy();
  });

  it('respects a saved layerOrder placing lyrics between two effects', () => {
    const instances = [bloom('a'), bloom('b')];
    const saved: LayerToken[] = [
      { kind: 'background' },
      { kind: 'effect', id: 'a' },
      { kind: 'lyrics' },
      { kind: 'effect', id: 'b' },
    ];
    const { getAllByText, getByText } = render(
      <DraggableEffectList
        effectsConfig={makeConfig(instances, saved)}
        onEffectsConfigChange={() => {}}
      />,
    );
    expect(getAllByText('Background')).toHaveLength(1);
    expect(getByText('Lyrics')).toBeTruthy();
  });

  it('enabling a discovery effect writes a concrete layerOrder placing it below lyrics', () => {
    const instances = [bloom('a', true)];
    const onChange = vi.fn();
    const { container } = render(
      <DraggableEffectList
        effectsConfig={makeConfig(instances)}
        onEffectsConfigChange={onChange}
      />,
    );
    const toggles = container.querySelectorAll('button[role="switch"]');
    const target = toggles[toggles.length - 1] as HTMLButtonElement;
    fireEvent.click(target);

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as EffectsConfig;
    expect(next.layerOrder).toBeDefined();
    const order = next.layerOrder as LayerToken[];
    const lyricsIdx = order.findIndex((t) => t.kind === 'lyrics');
    expect(lyricsIdx).toBeGreaterThanOrEqual(0);
    expect(order.some((t) => t.kind === 'effect')).toBe(true);
  });

  it('marks GPU-only effects "Needs WebGPU" on the fallback stage and blocks enabling them', () => {
    systemStore.getState().setStagePipeline('fallback');
    const instances = [bloom('a', true)];
    const onChange = vi.fn();
    const { container, getAllByText } = render(
      <DraggableEffectList
        effectsConfig={makeConfig(instances)}
        onEffectsConfigChange={onChange}
      />,
    );
    expect(getAllByText('Needs WebGPU').length).toBeGreaterThan(0);

    const toggles = Array.from(
      container.querySelectorAll('button[role="switch"]'),
    ) as HTMLButtonElement[];
    // The enabled bloom row can still be switched OFF…
    const enabledToggle = toggles.find((t) => t.getAttribute('aria-checked') === 'true')!;
    expect(enabledToggle.disabled).toBe(false);
    // …but GPU-only discovery rows can't be switched ON.
    const blocked = toggles.filter((t) => t.disabled);
    expect(blocked.length).toBeGreaterThan(0);
    fireEvent.click(blocked[0]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows no WebGPU badges on the WebGPU stage', () => {
    systemStore.getState().setStagePipeline('webgpu');
    const { queryAllByText } = render(
      <DraggableEffectList
        effectsConfig={makeConfig([bloom('a')])}
        onEffectsConfigChange={() => {}}
      />,
    );
    expect(queryAllByText('Needs WebGPU')).toHaveLength(0);
  });
});

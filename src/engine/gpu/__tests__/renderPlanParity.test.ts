import { describe, it, expect } from 'vitest';
import { resolveRenderPlan } from '@/engine/gpu/resolveRenderPlan';
import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';
import type { LayerToken } from '@/types/effects/layer-order';

/**
 * Render-plan parity (Stage 0). Preview (GPUCanvas) and export (DecoupledExporter)
 * both consume resolveRenderPlan(), so the mechanical guard against
 * "export doesn't match preview" is: the resolver is deterministic and produces
 * the same plan for the same config no matter which path builds it. We simulate
 * "preview inputs" and "export inputs" as two independent constructions of the
 * same logical config and assert byte-identical plans.
 *
 * The split is POSITION-DRIVEN: the below/above-lyrics boundary is the position
 * of the draggable `lyrics` token in `layerOrder`. There is no per-effect
 * Above/Below toggle — dragging is the source of truth. A structural guard
 * still forces BACKGROUND-ONLY effect types below the lyrics regardless of drag
 * position (they cannot warp the text).
 */

// Identity pass-id resolver: type "bloom" → pass id "bloom", "grade" → "grade".
// shaderFx is a scene source (background-only, and pinned below background by
// resolveLayerOrder); bgBlur is a non-pinned background-only type used to prove
// the structural below-lyrics guard.
const resolvePassId = (type: string): string | null =>
  ['bloom', 'glitch', 'grade', 'vhs', 'shaderFx', 'bgBlur'].includes(type) ? type : null;

function inst(id: string, type: string): EffectInstance {
  return { id, type, config: { enabled: true } } as unknown as EffectInstance;
}

function cfg(instances: EffectInstance[], layerOrder?: LayerToken[]): EffectsConfig {
  return { effectInstances: instances, layerOrder } as unknown as EffectsConfig;
}

// A deep-ish clone so "preview" and "export" don't share object identity —
// the plan must be equal by value, not by reference.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

interface Case {
  name: string;
  config: EffectsConfig;
}

const CORPUS: Case[] = [
  {
    name: 'no saved order (legacy fixed order, nothing above lyrics)',
    config: cfg([inst('a', 'bloom'), inst('b', 'glitch')]),
  },
  {
    name: 'all effects below lyrics → split is null',
    config: cfg(
      [inst('a', 'bloom'), inst('b', 'glitch')],
      [
        { kind: 'background' },
        { kind: 'effect', id: 'a' },
        { kind: 'effect', id: 'b' },
        { kind: 'lyrics' },
      ],
    ),
  },
  {
    name: 'one effect dragged above lyrics → split has an above entry',
    config: cfg(
      [inst('a', 'bloom'), inst('b', 'glitch')],
      [
        { kind: 'background' },
        { kind: 'effect', id: 'a' },
        { kind: 'lyrics' },
        { kind: 'effect', id: 'b' },
      ],
    ),
  },
  {
    name: 'mixed positions, order preserved within each side',
    config: cfg(
      [inst('a', 'bloom'), inst('b', 'glitch'), inst('c', 'grade'), inst('d', 'vhs')],
      [
        { kind: 'background' },
        { kind: 'effect', id: 'a' },
        { kind: 'effect', id: 'c' },
        { kind: 'lyrics' },
        { kind: 'effect', id: 'b' },
        { kind: 'effect', id: 'd' },
      ],
    ),
  },
  {
    name: 'scene source (shaderFx) pinned below background even if dragged up',
    config: cfg(
      [inst('sfx', 'shaderFx'), inst('b', 'glitch')],
      [
        { kind: 'background' },
        { kind: 'effect', id: 'sfx' },
        { kind: 'lyrics' },
        { kind: 'effect', id: 'b' },
      ],
    ),
  },
  {
    name: 'non-pinned background-only effect (bgBlur) dragged above lyrics is forced below',
    config: cfg(
      [inst('blur', 'bgBlur'), inst('b', 'glitch')],
      [
        { kind: 'background' },
        { kind: 'lyrics' },
        { kind: 'effect', id: 'blur' },
        { kind: 'effect', id: 'b' },
      ],
    ),
  },
];

describe('resolveRenderPlan — preview/export parity', () => {
  it.each(CORPUS)('plan parity: $name', ({ config }) => {
    const previewPlan = resolveRenderPlan(clone(config), resolvePassId);
    const exportPlan = resolveRenderPlan(clone(config), resolvePassId);
    expect(previewPlan).toEqual(exportPlan);
  });

  it('is a pure function — repeated calls do not mutate the config', () => {
    const config = CORPUS[3].config;
    const before = clone(config);
    resolveRenderPlan(config, resolvePassId);
    resolveRenderPlan(config, resolvePassId);
    expect(config).toEqual(before);
  });

  it('null split when everything is below lyrics', () => {
    const plan = resolveRenderPlan(CORPUS[1].config, resolvePassId);
    expect(plan.split).toBeNull();
  });

  it('populates above/below buckets by position, preserving order', () => {
    const plan = resolveRenderPlan(CORPUS[3].config, resolvePassId);
    expect(plan.split).not.toBeNull();
    expect(plan.split!.below).toEqual(['bloom', 'grade']);
    expect(plan.split!.above).toEqual(['glitch', 'vhs']);
    expect(plan.split!.anyAbove).toBe(true);
  });

  it('scene sources never land in the above bucket', () => {
    const plan = resolveRenderPlan(CORPUS[4].config, resolvePassId);
    expect(plan.split!.below).toContain('shaderFx');
    expect(plan.split!.above).toEqual(['glitch']);
  });

  it('non-pinned background-only effects are forced below lyrics regardless of drag', () => {
    const plan = resolveRenderPlan(CORPUS[5].config, resolvePassId);
    // bgBlur was dragged above lyrics but must render below; glitch stays above.
    expect(plan.split!.below).toContain('bgBlur');
    expect(plan.split!.above).toEqual(['glitch']);
  });
});

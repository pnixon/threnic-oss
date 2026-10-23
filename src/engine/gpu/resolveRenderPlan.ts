/**
 * resolveRenderPlan — the single, shared resolver for the render pipeline's
 * layer plan (Stage 0 of the Effect System LLD).
 *
 * Preview (`GPUCanvas`) and export (`DecoupledExporter`) previously each resolved
 * the layer order and split the pass chain independently — duplicated logic whose
 * only failure mode was "export doesn't match preview". This module is the single
 * source of truth both call sites consume, so the two paths cannot drift.
 *
 * The plan is derived position-driven: the compositing order is the flat,
 * user-draggable `layerOrder` (front-to-back), and the boundary between "below
 * lyrics" and "above lyrics" is the POSITION of the draggable `lyrics` token in
 * that order. Dragging an effect above/below the Lyrics row is the single
 * control — there is no separate per-effect Above/Below toggle.
 * `resolveLayerOrder()` runs first to enforce scene-source pinning, drop
 * dead/disabled tokens, and materialize the background/lyrics tokens;
 * `splitPassesAroundLyrics()` then buckets the enabled instances into
 * below/above pass-id lists by their position relative to the lyrics token. A
 * structural guard forces BACKGROUND-ONLY effect types (bgBlur, bgImageOverlay,
 * scene sources) into the below bucket regardless of drag position, since they
 * cannot warp the lyric layer.
 *
 * (Historical note: the split was briefly `target`-driven via a per-instance
 * `target` field; that was reverted to
 * drag-as-source-of-truth. The `target` field is retained on the instance type
 * for back-compat and is used only to seed an initial `layerOrder` on load.)
 *
 * `split` is `null` when nothing sits above the lyrics (legacy: lyrics on top),
 * matching the renderer's `setLayerOrder(null)` fast path.
 */

import type { EffectsConfig } from '@/types/effects';
import type { EffectInstance } from '@/types/effects/effect-instances';
import { BACKGROUND_ONLY_EFFECT_TYPES } from '@/types/effects/effect-instances';
import {
  resolveLayerOrder,
  splitPassesAroundLyrics,
  type LayerToken,
} from '@/types/effects/layer-order';
import { CUSTOM_SHADER_TYPE, customShaderPassId } from './EffectsManager';

/** The split shape consumed by `IExportRenderer.setLayerOrder`. */
interface LayerSplit {
  below: string[];
  above: string[];
  anyAbove: boolean;
}

interface RenderPlan {
  /** Fully-resolved, front-to-back layer token order (scene-pinned, deduped). */
  order: LayerToken[];
  /** Below/above pass-id split, or `null` when nothing is above lyrics. */
  split: LayerSplit | null;
}

/**
 * Resolve the complete render plan for an effects config.
 *
 * @param config           the (already keyframe-resolved) effects config
 * @param resolvePassId    maps an effect *type* to its render-graph pass id
 *                         (typically `resolveInstancePassId` from EffectsManager)
 */
export function resolveRenderPlan(
  config: EffectsConfig | undefined,
  resolvePassId: (type: string) => string | null,
): RenderPlan {
  const instances: EffectInstance[] = config?.effectInstances ?? [];
  const savedOrder = config?.layerOrder;

  const order = resolveLayerOrder(instances, savedOrder);

  // No saved order → legacy fixed order → lyrics on top → nothing above.
  if (!savedOrder || savedOrder.length === 0) {
    return { order, split: null };
  }

  // Position-driven split: the boundary between "below lyrics" and "above
  // lyrics" is the draggable `lyrics` token's POSITION in the resolved order,
  // not any per-instance `target` field. Dragging an effect above/below the
  // Lyrics row IS the control. (The legacy `target`-driven split was retired
  // here in favour of drag-as-source-of-truth.)
  const instById = new Map(instances.filter((i) => i != null).map((i) => [i.id, i]));
  const resolveInstancePassId = (id: string): string | null => {
    const inst = instById.get(id);
    if (!inst) return null;
    // customShader is per-instance: its pass id derives from the instance id,
    // not the type (resolvePassId returns null for it), so resolve it here
    // where the instance is in hand.
    if (inst.type === CUSTOM_SHADER_TYPE) return customShaderPassId(inst.id);
    return resolvePassId(inst.type);
  };

  const split = splitPassesAroundLyrics(order, resolveInstancePassId);

  // Structural guard: a BACKGROUND-ONLY effect (bgBlur, bgImageOverlay, scene
  // sources, …) can never warp the lyric layer, even if the user dragged its
  // row above the Lyrics token. Its pass is dropped from `above` and appended
  // to `below` so the drag can't express an illegal arrangement. Scene sources
  // are already pinned below the lyrics by enforceFixedBottomScene, so this
  // matters for the non-pinned background-only types.
  const backgroundOnlyPassIds = new Set<string>();
  for (const inst of instances) {
    if (inst == null) continue;
    if (!BACKGROUND_ONLY_EFFECT_TYPES.has(inst.type)) continue;
    const passId = resolveInstancePassId(inst.id);
    if (passId) backgroundOnlyPassIds.add(passId);
  }
  if (backgroundOnlyPassIds.size > 0 && split.above.length > 0) {
    const stillAbove: string[] = [];
    for (const passId of split.above) {
      if (backgroundOnlyPassIds.has(passId)) {
        if (!split.below.includes(passId)) split.below.push(passId);
      } else {
        stillAbove.push(passId);
      }
    }
    split.above = stillAbove;
    split.anyAbove = stillAbove.length > 0;
  }

  return {
    order,
    split: split.anyAbove ? { below: split.below, above: split.above, anyAbove: true } : null,
  };
}

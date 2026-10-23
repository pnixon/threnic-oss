/**
 * Layer Order — user-controllable compositing order for the render pipeline.
 *
 * The render pipeline composites a stack of *layers* in a defined order. Two of
 * those layers are special (not effect instances):
 *   - `background` — the base composite (solid color + image/video/slideshow +
 *      scene sources: butterchurn / milkdrop / shader overlay / game scene).
 *   - `lyrics`     — the lyric bitmap overlay produced by CanvasLyricRenderer.
 *
 * Every other layer is a post-processing `effect` instance, addressed by id.
 *
 * `layerOrder` is a flat, front-to-back list of {@link LayerToken}s. The
 * renderer walks it in order, compositing each token into the intermediate
 * target. This makes the compositing order fully data-driven and lets the user
 * place lyrics BELOW a given effect (so that effect distorts the lyrics) while
 * still ABOVE the rest — exactly what the effect-layering feature requires.
 *
 * BACKWARD COMPATIBILITY: `layerOrder` is optional on EffectsConfig. When it is
 * absent (all existing projects), the renderer falls back to the legacy fixed
 * order: background → (effects, in effectInstances[] order) → lyrics. So old
 * projects render identically until the user reorders something, at which point
 * a concrete layerOrder is materialized and persisted.
 */

import type { EffectInstance } from './effect-instances';
import { effectLayerTarget } from './effect-instances';

/** A single compositing layer in the pipeline. */
export type LayerToken =
  | { kind: 'background' }
  | { kind: 'lyrics' }
  | { kind: 'effect'; id: string };

/** Stable string key for a layer token (used for React keys / DnD ids). */
export function layerTokenKey(token: LayerToken): string {
  switch (token.kind) {
    case 'background':
      return 'layer:background';
    case 'lyrics':
      return 'layer:lyrics';
    case 'effect':
      return `layer:effect:${token.id}`;
  }
}

/**
 * Resolve the effective, fully-populated layer order for a set of effect
 * instances and an optional saved `layerOrder`.
 *
 * Guarantees, regardless of the saved order's completeness:
 *   - Exactly one `background` token and exactly one `lyrics` token are present.
 *   - Every ENABLED effect instance appears exactly once.
 *   - Tokens referencing effects that no longer exist are dropped.
 *   - New/enabled effects not yet in the saved order are appended just BELOW
 *     lyrics (so a freshly-enabled effect still affects the lyrics by default,
 *     matching the legacy "effects under lyrics" behavior).
 *
 * When `saved` is undefined/empty, produces the legacy order:
 *   background → effects (in instance array order) → lyrics.
 */
export function resolveLayerOrder(
  instances: EffectInstance[],
  saved: LayerToken[] | undefined,
): LayerToken[] {
  const enabledEffectIds: string[] = instances
    .filter((i) => i != null && (i.config as { enabled?: boolean }).enabled)
    .map((i) => i.id);
  const enabledSet = new Set(enabledEffectIds);
  const instById = new Map(
    instances.filter((i) => i != null).map((i) => [i.id, { type: i.type, config: i.config }]),
  );

  // Legacy / empty path: background → effects (array order) → lyrics.
  if (!saved || saved.length === 0) {
    return enforceFixedBottomScene(
      [
        { kind: 'background' },
        ...enabledEffectIds.map((id) => ({ kind: 'effect', id }) as LayerToken),
        { kind: 'lyrics' },
      ],
      instById,
    );
  }

  const out: LayerToken[] = [];
  let hasBackground = false;
  let hasLyrics = false;
  const seenEffects = new Set<string>();

  for (const token of saved) {
    if (token.kind === 'background') {
      if (hasBackground) continue;
      hasBackground = true;
      out.push({ kind: 'background' });
    } else if (token.kind === 'lyrics') {
      if (hasLyrics) continue;
      hasLyrics = true;
      out.push({ kind: 'lyrics' });
    } else {
      // effect — keep only if still enabled and not already seen
      if (!enabledSet.has(token.id) || seenEffects.has(token.id)) continue;
      seenEffects.add(token.id);
      out.push({ kind: 'effect', id: token.id });
    }
  }

  // Append any enabled effect not present in the saved order, just below lyrics
  // (so newly-enabled effects affect lyrics by default). If lyrics isn't present
  // yet, we add missing effects then background/lyrics below.
  const missingEffects = enabledEffectIds.filter((id) => !seenEffects.has(id));

  if (!hasLyrics) {
    // No lyrics token in saved order — append missing effects, then lyrics last.
    for (const id of missingEffects) out.push({ kind: 'effect', id });
    if (!hasBackground) out.unshift({ kind: 'background' });
    out.push({ kind: 'lyrics' });
    return enforceFixedBottomScene(out, instById);
  }

  // Lyrics present: splice missing effects immediately before the lyrics token.
  if (missingEffects.length > 0) {
    const lyricsIdx = out.findIndex((t) => t.kind === 'lyrics');
    const insertAt = lyricsIdx >= 0 ? lyricsIdx : out.length;
    out.splice(insertAt, 0, ...missingEffects.map((id) => ({ kind: 'effect', id }) as LayerToken));
  }

  if (!hasBackground) out.unshift({ kind: 'background' });

  return enforceFixedBottomScene(out, instById);
}

/**
 * Effect types that ALWAYS form the fixed bottom "scene source" group,
 * regardless of any mode: they render as background-class layers pinned right
 * above the background.
 *
 * NOTE: `shaderFx` (ALL modes — WGSL `shader`, `glsl` guest, `butterchurn`,
 * `littlejs`) composites at the fixed background→post-FX boundary in the
 * renderer, i.e. below every post-processing pass. The renderer does NOT honor
 * a dragged position for it, so it is pinned here to reflect its real structure
 * rather than letting the UI imply an order the pipeline ignores.
 * (`isPinnedSceneInstance` handles the mode-aware shaderFx case.) `butterchurn`
 * as its own type is always pinned.
 */
const FIXED_BOTTOM_SCENE_TYPES: readonly string[] = ['butterchurn'];

/**
 * Whether an effect instance is a PINNED scene source (fixed bottom group)
 * whose compositing position the renderer forces, so the UI must NOT let the
 * user drag it.
 *
 * ALL `shaderFx` instances are pinned regardless of mode: the WGSL `shader`
 * overlay and the `glsl` guest both composite at the fixed background→post-FX
 * boundary (below every post-processing pass), and `butterchurn`/`littlejs`
 * render as background-class scene sources — none of these read a dragged
 * `layerOrder` position in the renderer. `butterchurn`-type is always pinned.
 */
export function isPinnedSceneInstance(inst: { type: string; config?: unknown }): boolean {
  if (FIXED_BOTTOM_SCENE_TYPES.includes(inst.type)) return true;
  if (inst.type === 'shaderFx') return true;
  return false;
}

/**
 * Human-readable reason a given instance is pinned (breaks the draggable
 * contract), surfaced as a row tooltip. Returns `null` for a freely-draggable
 * instance. The copy names the STRUCTURAL cause the renderer enforces.
 */
export function pinnedReasonForInstance(inst: { type: string; config?: unknown }): string | null {
  if (inst.type === 'butterchurn') {
    return 'Butterchurn composites into the background as a scene source, below every effect — its layer position is fixed by the renderer and cannot be dragged.';
  }
  if (inst.type === 'shaderFx') {
    const mode = (inst.config as { mode?: string } | undefined)?.mode;
    if (mode === 'butterchurn' || mode === 'littlejs') {
      return 'This scene source composites into the background, below every effect — its layer position is fixed by the renderer and cannot be dragged.';
    }
    // shader (WGSL) + glsl guest
    return 'Shader FX composites at the fixed background boundary, below all post-processing effects — the renderer does not honor a dragged position, so this row is pinned.';
  }
  return null;
}

/**
 * Reorder a resolved layer list so any PINNED scene source (butterchurn, or any
 * `shaderFx` instance — see {@link isPinnedSceneInstance}) sits immediately
 * above the background token, regardless of where the saved order placed it.
 * This mirrors the renderer, which composites every scene source and the
 * shaderFx overlay/guest at the fixed background boundary, below all
 * post-processing passes. Everything else keeps its relative order. Idempotent.
 */
function enforceFixedBottomScene(
  order: LayerToken[],
  instById: Map<string, { type: string; config?: unknown }>,
): LayerToken[] {
  const isScene = (t: LayerToken) => {
    if (t.kind !== 'effect') return false;
    const inst = instById.get(t.id);
    return inst ? isPinnedSceneInstance(inst) : false;
  };

  const sceneTokens = order.filter(isScene) as Array<Extract<LayerToken, { kind: 'effect' }>>;
  if (sceneTokens.length === 0) return order;

  // Sort pinned scene tokens: butterchurn-type first, then any pinned shaderFx.
  const rank = (id: string): number => {
    const type = instById.get(id)?.type ?? '';
    return type === 'butterchurn' ? 0 : 1;
  };
  sceneTokens.sort((a, b) => rank(a.id) - rank(b.id));

  const rest = order.filter((t) => !isScene(t));
  const bgIdx = rest.findIndex((t) => t.kind === 'background');
  const insertAt = bgIdx >= 0 ? bgIdx + 1 : 0; // immediately above background
  rest.splice(insertAt, 0, ...sceneTokens);
  return rest;
}

/**
 * Given a resolved layer order and a mapping from effect-instance id → pass id,
 * split the render-graph pass ids into those that must run BELOW the lyric layer
 * and those that run ABOVE it.
 *
 * "Below lyrics" passes run first (into an intermediate), then the lyric bitmap
 * is composited in, then "above lyrics" passes run — so only the above-lyrics
 * effects distort the lyrics. Pass ids are de-duplicated preserving first
 * occurrence (color-grade instances collapse to one pass id; its side is decided
 * by the FIRST color-grade instance encountered relative to lyrics).
 *
 * `lyricsPresent` is false only if the order somehow lacks a lyrics token, in
 * which case every pass is treated as below lyrics (legacy: lyrics on top).
 */
export function splitPassesAroundLyrics(
  order: LayerToken[],
  resolvePassId: (instanceId: string) => string | null,
): { below: string[]; above: string[]; lyricsPresent: boolean; anyAbove: boolean } {
  const below: string[] = [];
  const above: string[] = [];
  const seen = new Set<string>();
  let passedLyrics = false;
  let lyricsPresent = false;

  for (const token of order) {
    if (token.kind === 'lyrics') {
      lyricsPresent = true;
      passedLyrics = true;
      continue;
    }
    if (token.kind !== 'effect') continue; // background handled separately
    const passId = resolvePassId(token.id);
    if (!passId || seen.has(passId)) continue;
    seen.add(passId);
    (passedLyrics ? above : below).push(passId);
  }

  return { below, above, lyricsPresent, anyAbove: above.length > 0 };
}

/**
 * Reverse migration (drag-as-source-of-truth): materialize a `layerOrder` from
 * each instance's legacy `target` field so a project saved under the old
 * target-driven split renders identically under the new position-driven split.
 *
 * The old split rendered an effect ABOVE the lyrics iff `effectLayerTarget()`
 * returned 'lyrics'. So we build a flat order:
 *   background → [background-target effects, array order] → lyrics →
 *   [lyrics-target effects, array order]
 * from the ENABLED instances (mirroring resolveLayerOrder's membership),
 * `resolveLayerOrder()` then re-runs on it to pin scene sources and dedupe.
 *
 * Only runs when there is something to express — at least one enabled effect
 * whose effective target is 'lyrics' — AND the project does not already carry a
 * concrete `layerOrder` (never overwrite a user's dragged arrangement). Returns
 * `undefined` (meaning "leave layerOrder as-is") otherwise, so the caller can
 * cheaply detect a no-op.
 */
export function seedLayerOrderFromTargets(
  instances: EffectInstance[],
  savedOrder: LayerToken[] | undefined,
): LayerToken[] | undefined {
  // Never clobber an explicit dragged order.
  if (savedOrder && savedOrder.length > 0) return undefined;

  const enabled = instances.filter((i) => i != null && (i.config as { enabled?: boolean }).enabled);
  const anyAbove = enabled.some((i) => effectLayerTarget(i) === 'lyrics');
  // Nothing above lyrics ⇒ legacy fixed order already renders identically ⇒
  // no need to materialize an order (leave it absent so the fast path applies).
  if (!anyAbove) return undefined;

  const belowIds: string[] = [];
  const aboveIds: string[] = [];
  for (const inst of enabled) {
    (effectLayerTarget(inst) === 'lyrics' ? aboveIds : belowIds).push(inst.id);
  }

  const order: LayerToken[] = [
    { kind: 'background' },
    ...belowIds.map((id) => ({ kind: 'effect', id }) as LayerToken),
    { kind: 'lyrics' },
    ...aboveIds.map((id) => ({ kind: 'effect', id }) as LayerToken),
  ];

  // Re-resolve to pin scene sources / dedupe / drop dead tokens.
  return resolveLayerOrder(instances, order);
}

/**
 * effectAvailability — which effects can actually render on the current stage.
 *
 * Effects run in the WebGPU RenderGraph. On the fallback stage (no WebGPU:
 * CenterStage, or the Canvas2D software renderer) only a handful of
 * background-level properties are applied; everything else silently did
 * nothing. The effects list uses this to disable those rows with a reason.
 */

import type { StagePipeline } from '@/stores/systemStore';

/**
 * Effects the fallback stages still honour: background transforms (zoom /
 * slide / rotate) and background opacity are applied by both CenterStage's
 * ScheduleAwareBackground and the Canvas2D software renderer.
 */
const FALLBACK_SUPPORTED_EFFECTS: ReadonlySet<string> = new Set([
  'zoom',
  'slide',
  'rotate',
  'bgOpacity',
]);

/** Short label shown on unavailable rows. */
export const NEEDS_WEBGPU_LABEL = 'Needs WebGPU';

/** Tooltip explaining why the row is disabled. */
const NEEDS_WEBGPU_REASON =
  "Needs WebGPU, which isn't available on this device/browser — this effect won't render.";

/**
 * Reason an effect type can't render on the given stage pipeline, or null when
 * it can. 'pending' (still detecting) is treated as available to avoid a
 * flash of disabled rows on load.
 */
export function effectUnavailableReason(type: string, pipeline: StagePipeline): string | null {
  if (pipeline !== 'fallback') return null;
  return FALLBACK_SUPPORTED_EFFECTS.has(type) ? null : NEEDS_WEBGPU_REASON;
}

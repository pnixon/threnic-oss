/**
 * previewSize — pixel size for the live preview renderer.
 *
 * The stage is laid out at the full project/export resolution (e.g. 1920×1080)
 * and shrunk to fit with a CSS `transform: scale(...)`. Sizing the WebGPU
 * canvas from the UNSCALED layout box × devicePixelRatio rendered a 5760×3240
 * preview on a DPR-3 phone showing it at ~390px wide. Instead size it to what
 * is actually on screen (the transformed box) × a capped DPR, and never above
 * the project resolution — export has its own offscreen renderer at full size.
 */

/** Highest devicePixelRatio the preview honours (DPR 3 phones render at 2×). */
export const PREVIEW_MAX_DPR = 2;

export interface PreviewSizeInput {
  /** On-screen size in CSS px (getBoundingClientRect — includes CSS transforms). */
  displayWidth: number;
  displayHeight: number;
  /** Untransformed layout size in CSS px = the project/export resolution. */
  layoutWidth: number;
  layoutHeight: number;
  /** window.devicePixelRatio. */
  devicePixelRatio: number;
  /** DPR cap (default {@link PREVIEW_MAX_DPR}). */
  maxDpr?: number;
}

/**
 * Compute the preview backing-store size. Keeps the layout (project) aspect
 * ratio exactly, so the render never stretches. Returns null when the canvas
 * isn't laid out yet (zero size).
 */
export function computePreviewRenderSize(
  input: PreviewSizeInput,
): { width: number; height: number } | null {
  const { displayWidth, displayHeight, layoutWidth, layoutHeight } = input;
  if (!(layoutWidth > 0 && layoutHeight > 0)) return null;
  // Not displayed (e.g. hidden mobile tab) — keep whatever we had.
  if (!(displayWidth > 0 && displayHeight > 0)) return null;

  const rawDpr = Number.isFinite(input.devicePixelRatio) ? input.devicePixelRatio : 1;
  const dpr = Math.max(1, Math.min(rawDpr, input.maxDpr ?? PREVIEW_MAX_DPR));

  // Device pixels needed on screen, as a fraction of the layout size; ≤ 1 so
  // the preview never exceeds the project resolution.
  const scale = Math.min(
    1,
    Math.max((displayWidth * dpr) / layoutWidth, (displayHeight * dpr) / layoutHeight),
  );

  return {
    width: Math.max(1, Math.round(layoutWidth * scale)),
    height: Math.max(1, Math.round(layoutHeight * scale)),
  };
}

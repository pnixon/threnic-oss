/**
 * butterchurnSize — pure sizing helper for Butterchurn's internal render size.
 *
 * Butterchurn allocates several full-size framebuffer textures (prev/target/
 * comp + blur levels) at `width × height × pixelRatio × textureRatio`. Fed the
 * full export size on a high-DPR phone this reached 17280×9720 (GL_INVALID_VALUE
 * and ~670 MB per framebuffer). The visualizer is soft/blurry by nature, so we
 * render it at a capped size and let the WebGPU composite sampler upscale it.
 */

/** Longest side Butterchurn ever renders at, regardless of output size. */
export const BUTTERCHURN_MAX_DIM = 2048;

export interface ButterchurnSizeLimits {
  /** Soft cap on the longest side (default {@link BUTTERCHURN_MAX_DIM}). */
  maxDim?: number;
  /** gl.MAX_TEXTURE_SIZE of the WebGL context, when known. */
  maxTextureSize?: number;
  /** gl.MAX_RENDERBUFFER_SIZE of the WebGL context, when known. */
  maxRenderbufferSize?: number;
}

/**
 * Compute the aspect-preserving internal render size for Butterchurn.
 * The longest side is clamped to the smallest of the soft cap and the GL
 * limits; sizes already within limits pass through unchanged (rounded).
 */
export function computeButterchurnRenderSize(
  width: number,
  height: number,
  limits: ButterchurnSizeLimits = {},
): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;

  let cap = limits.maxDim ?? BUTTERCHURN_MAX_DIM;
  for (const lim of [limits.maxTextureSize, limits.maxRenderbufferSize]) {
    if (typeof lim === 'number' && Number.isFinite(lim) && lim > 0) cap = Math.min(cap, lim);
  }

  const largest = Math.max(w, h);
  if (largest <= cap) {
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }
  const scale = cap / largest;
  return {
    width: Math.max(1, Math.min(cap, Math.floor(w * scale))),
    height: Math.max(1, Math.min(cap, Math.floor(h * scale))),
  };
}

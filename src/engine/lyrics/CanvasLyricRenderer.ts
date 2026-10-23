/** Re-export shim → @threnic/lyrics (packages/lyrics/src/render/CanvasLyricRenderer.ts).
 *
 * Note on the FontRegistry seam: the extracted renderer resolves per-lane
 * `fontId` overrides through an injected FontRegistry (2nd constructor arg).
 * Construction sites in this app pass `threnicFontRegistry` (see
 * `@/constants/fonts`). Consumers importing the class through this shim get the
 * package class unchanged.
 */
export { CanvasLyricRenderer } from '@threnic/lyrics';
export type { LyricRenderConfig } from '@threnic/lyrics';

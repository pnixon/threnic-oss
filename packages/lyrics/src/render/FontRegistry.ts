/**
 * Font registry seam.
 *
 * The renderer needs to resolve a `fontId` (used by per-lane style overrides)
 * to a loadable font URL. In the Threnic app this came from a hardcoded
 * `@/constants/fonts` table. To keep the package framework-agnostic and free of
 * app-specific `/fonts/*.ttf` path assumptions, the registry is INJECTED:
 *
 *   new CanvasLyricRenderer(config, { fontRegistry })
 *
 * The app passes its own `FONTS` array (which is structurally a
 * `FontDefinition[]`). When no registry is supplied the renderer simply cannot
 * resolve per-lane `fontId` overrides and falls back to the global font — it
 * still renders correctly.
 */
export interface FontDefinition {
  /** Stable identifier referenced by LineStyleOverride.fontId */
  id: string;
  /** Human-readable name */
  name: string;
  /** URL the font file is loaded from (via FontFace) */
  url: string;
  /** Default word-spacing multiplier for this font (advisory) */
  defaultWordSpacing?: number;
  /** Character-width multiplier for layout estimation (advisory) */
  charWidthMultiplier?: number;
}

export interface FontRegistry {
  /** Resolve a font definition by id, or undefined if unknown. */
  getById(id: string): FontDefinition | undefined;
}

/**
 * Build a FontRegistry from a plain array of font definitions (the shape the
 * Threnic app already stores in `src/constants/fonts.ts`).
 */
export function createFontRegistry(fonts: readonly FontDefinition[]): FontRegistry {
  const byId = new Map(fonts.map((f) => [f.id, f]));
  return {
    getById: (id: string) => byId.get(id),
  };
}

/** An empty registry — resolves nothing, renderer uses the global font. */
export const EMPTY_FONT_REGISTRY: FontRegistry = { getById: () => undefined };

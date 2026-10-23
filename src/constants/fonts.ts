/**
 * Available fonts for the lyric engine
 * These will be loaded via the @react-three/drei Text component
 */

interface FontDefinition {
  id: string;
  name: string;
  url: string;
  defaultWordSpacing: number;
  charWidthMultiplier: number;
}

export const FONTS: FontDefinition[] = [
  // ── All fonts below are CC0 or MIT licensed only (verified from source). ──
  // ── Clean / modern (sans) ──
  {
    id: 'typelightsans',
    name: 'Type Light Sans', // CC0
    url: '/fonts/TypeLightSans-Regular.ttf',
    defaultWordSpacing: 0.8,
    charWidthMultiplier: 0.6,
  },
  {
    id: 'skyte',
    name: 'Skyte', // CC0
    url: '/fonts/Skyte-Regular.ttf',
    defaultWordSpacing: 0.85,
    charWidthMultiplier: 0.65,
  },
  // ── Cinematic / elegant (serif) ──
  {
    id: 'robotoslab',
    name: 'Roboto Slab', // Apache-2.0
    url: '/fonts/RobotoSlab-Variable.ttf',
    defaultWordSpacing: 0.8,
    charWidthMultiplier: 0.6,
  },
  {
    id: 'oserif',
    name: 'O Serif', // CC0
    url: '/fonts/OSerif-Regular.ttf',
    defaultWordSpacing: 0.8,
    charWidthMultiplier: 0.6,
  },
  {
    id: 'secoline',
    name: 'Secoline', // CC0
    url: '/fonts/Secoline-Regular.ttf',
    defaultWordSpacing: 0.85,
    charWidthMultiplier: 0.65,
  },
  // ── Retro / synthwave / sci-fi (display) ──
  {
    id: 'jupiteroid',
    name: 'Jupiteroid', // CC0
    url: '/fonts/Jupiteroid-Regular.ttf',
    defaultWordSpacing: 1.0,
    charWidthMultiplier: 0.7,
  },
  {
    id: 'publicpixel',
    name: 'Public Pixel', // CC0
    url: '/fonts/PublicPixel-Regular.ttf',
    defaultWordSpacing: 1.4,
    charWidthMultiplier: 1.1,
  },
  {
    id: 'homevideo',
    name: 'Home Video', // CC0
    url: '/fonts/HomeVideo-Regular.ttf',
    defaultWordSpacing: 0.9,
    charWidthMultiplier: 0.75,
  },
  {
    id: 'matrixtype',
    name: 'MatrixType', // CC0
    url: '/fonts/MatrixType-Regular.ttf',
    defaultWordSpacing: 0.95,
    charWidthMultiplier: 0.7,
  },
  {
    id: 'rainbow2000',
    name: 'Rainbow 2000', // CC0
    url: '/fonts/Rainbow2000-Regular.ttf',
    defaultWordSpacing: 1.0,
    charWidthMultiplier: 0.75,
  },
  // ── Bold impact / street ──
  {
    id: 'operationnapalm',
    name: 'Operation Napalm', // CC0
    url: '/fonts/OperationNapalm-Regular.ttf',
    defaultWordSpacing: 0.7,
    charWidthMultiplier: 0.55,
  },
  {
    id: 'novem',
    name: 'Novem', // CC0
    url: '/fonts/Novem-Regular.ttf',
    defaultWordSpacing: 0.8,
    charWidthMultiplier: 0.6,
  },
  // ── Lo-fi / handwritten ──
  {
    id: 'crayonlibre',
    name: 'Crayon Libre', // CC0
    url: '/fonts/CrayonLibre-Regular.ttf',
    defaultWordSpacing: 0.9,
    charWidthMultiplier: 0.7,
  },
  // ── Coder / monospace ──
  {
    id: 'comicmono',
    name: 'Comic Mono', // MIT
    url: '/fonts/ComicMono-Regular.ttf',
    defaultWordSpacing: 0.8,
    charWidthMultiplier: 0.6,
  },
  {
    id: 'proggy',
    name: 'ProggyVector', // MIT
    url: '/fonts/ProggyVector-Regular.ttf',
    defaultWordSpacing: 0.8,
    charWidthMultiplier: 0.6,
  },
  {
    id: '3x3mono',
    name: '3x3 Mono', // CC0
    url: '/fonts/3x3Mono-Regular.ttf',
    defaultWordSpacing: 0.85,
    charWidthMultiplier: 0.7,
  },
];

const DEFAULT_FONT_URL = FONTS[0].url;

/** The default font id (first entry). */
export const DEFAULT_FONT_ID = FONTS[0].id;

/**
 * Legacy font-id aliases. The bundled font set was replaced with CC0/MIT-only
 * families; saved projects (and hardcoded default references) may still carry
 * old ids like 'roboto'. Map those to the current default so nothing 404s or
 * silently locks every font. resolveFontId() applies these before lookup.
 */
const LEGACY_FONT_ID_ALIASES: Record<string, string> = {
  roboto: DEFAULT_FONT_ID,
  space: 'comicmono',
  sharetech: 'comicmono',
  ibmplex: 'comicmono',
  fira: 'comicmono',
  cutive: 'comicmono',
  xanh: '3x3mono',
  synemono: 'comicmono',
  majormono: '3x3mono',
  vt323: 'publicpixel',
  pressstart: 'publicpixel',
  orbitron: 'jupiteroid',
  rajdhani: 'typelightsans',
  syncopate: 'jupiteroid',
  cinzel: 'skyte',
  cinzeldecorative: 'skyte',
  medievalsharp: 'skyte',
  uncialantiqua: 'skyte',
  metalmania: 'homevideo',
  nosifer: 'homevideo',
  creepster: 'homevideo',
  bebasneue: 'typelightsans',
  anton: 'typelightsans',
  permanentmarker: 'comicmono',
  cormorantgaramond: 'skyte',
  amiri: 'typelightsans',
};

/** Resolve a possibly-legacy font id to a current one. */
function resolveFontId(id: string): string {
  if (FONTS.some((f) => f.id === id)) return id;
  return LEGACY_FONT_ID_ALIASES[id] ?? DEFAULT_FONT_ID;
}

export function getFontUrl(id: string): string {
  const resolved = resolveFontId(id);
  return FONTS.find((f) => f.id === resolved)?.url ?? DEFAULT_FONT_URL;
}

// ── @threnic/lyrics FontRegistry seam ────────────────────────────────────────
// The extracted CanvasLyricRenderer resolves per-lane `fontId` overrides through
// an injected FontRegistry rather than importing this table directly. This app
// builds one registry from FONTS and passes it at every renderer construction
// site. FONTS is structurally a @threnic/lyrics FontDefinition[] (its optional
// advisory fields are a subset of ours).
import { createFontRegistry } from '@threnic/lyrics';

export const threnicFontRegistry = createFontRegistry(FONTS);

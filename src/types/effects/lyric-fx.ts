/**
 * Lyric FX — effect types & config (Stage 3, see `docs/lyric-fx-engine-lld.md`).
 *
 * The Lyric FX chain operates on per-glyph data (the GlyphBuffer from Stage 2)
 * instead of a flat lyric bitmap. Effects are modelled exactly like the main
 * chain's instanced `EffectInstance[]` — a typed config blob per instance,
 * ordered, independently enabled — so the shipped declarative effect-schema and
 * audio-reactive-binding systems drive the inspector UI with no bespoke panels.
 *
 * Stages:
 *   - `transform` (Stage A): per-glyph arithmetic in the vertex stage.
 *   - `surface`   (Stage B): per-pixel reads of the MSDF distance field.
 *   - `post`      (Stage C): fullscreen passes over the lyric target only.
 *
 * Stage 3 implements the `surface` family; `transform` and `post` types are
 * declared here so the union is stable for later stages.
 */

import type { AudioReactiveConfig } from './audio-reactive';

type LyricFXStage = 'transform' | 'surface' | 'post';

/**
 * Lifecycle phases a Lyric FX effect can be bound to. Each glyph moves through
 * these as the media clock crosses its (granularity-derived) active window:
 *
 *   upcoming → fadeIn → active → fadeOut → past
 *
 * An effect fires only while the glyph it is drawing is in the effect's phase.
 * `fadeIn`/`fadeOut` are the transition windows (entry / exit); `active` is the
 * held highlight; `upcoming`/`past` are the not-yet / already states.
 */
export type LyricFXPhase = 'fadeIn' | 'active' | 'upcoming' | 'past' | 'fadeOut';

export const LYRIC_FX_PHASES = [
  'fadeIn',
  'active',
  'upcoming',
  'past',
  'fadeOut',
] as const satisfies readonly LyricFXPhase[];

/** Human-readable phase labels (UI section titles). */
export const LYRIC_FX_PHASE_LABELS: Record<LyricFXPhase, string> = {
  fadeIn: 'Fade-in',
  active: 'Active',
  upcoming: 'Upcoming',
  past: 'Past',
  fadeOut: 'Fade-out',
};

/** Numeric phase codes handed to the shader uniform (must match phases.wgsl). */
export const LYRIC_FX_PHASE_CODE: Record<LyricFXPhase, number> = {
  upcoming: 0,
  fadeIn: 1,
  active: 2,
  fadeOut: 3,
  past: 4,
};

/**
 * Granularity: which unit's timing anchors an effect's phase transition and how
 * per-element stagger is derived. 'letter' = per-glyph, 'word' = per-word (the
 * baked glyph timing), 'line' = the whole line moves as one.
 */
export type LyricFXGranularity = 'letter' | 'word' | 'line';

export const LYRIC_FX_GRANULARITIES = [
  'letter',
  'word',
  'line',
] as const satisfies readonly LyricFXGranularity[];

/** Numeric granularity codes for the shader uniform (must match phases.wgsl). */
export const LYRIC_FX_GRANULARITY_CODE: Record<LyricFXGranularity, number> = {
  letter: 0,
  word: 1,
  line: 2,
};

export type LyricFXType =
  // stage A — transform (Stage 4)
  | 'shatter'
  | 'kineticWave'
  | 'scatterAssemble'
  | 'springSettle'
  | 'vortex'
  | 'impactTypewriter'
  | 'glyphJitter'
  | 'cardFlip'
  // stage B — surface (Stage 3)
  | 'swell'
  | 'melt'
  | 'dissolve'
  | 'gradientFill'
  | 'chromaticSplit'
  | 'marchingOutline'
  | 'bevel'
  | 'neonCore'
  | 'refraction'
  // stage C — post (Stage 5)
  | 'textBloom'
  | 'motionTrails'
  | 'displace'
  | 'lightRays';

/** Which stage a given effect type belongs to. */
export const LYRIC_FX_STAGE: Record<LyricFXType, LyricFXStage> = {
  // transform
  shatter: 'transform',
  kineticWave: 'transform',
  scatterAssemble: 'transform',
  springSettle: 'transform',
  vortex: 'transform',
  impactTypewriter: 'transform',
  glyphJitter: 'transform',
  cardFlip: 'transform',
  // surface
  swell: 'surface',
  melt: 'surface',
  dissolve: 'surface',
  gradientFill: 'surface',
  chromaticSplit: 'surface',
  marchingOutline: 'surface',
  bevel: 'surface',
  neonCore: 'surface',
  refraction: 'surface',
  // post
  textBloom: 'post',
  motionTrails: 'post',
  displace: 'post',
  lightRays: 'post',
};

/** The set of surface effects implemented in Stage 3. */
export const LYRIC_FX_SURFACE_TYPES = [
  'swell',
  'melt',
  'dissolve',
  'gradientFill',
  'chromaticSplit',
  'marchingOutline',
  'bevel',
  'neonCore',
  'refraction',
] as const satisfies readonly LyricFXType[];

export type LyricFXSurfaceType = (typeof LYRIC_FX_SURFACE_TYPES)[number];

/** True if the given type is a Stage-3 surface effect. */
export function isSurfaceType(type: LyricFXType): type is LyricFXSurfaceType {
  return LYRIC_FX_STAGE[type] === 'surface';
}

/** The Stage-C post effect types (fullscreen passes over the lyric target). */
export const LYRIC_FX_POST_TYPES = [
  'textBloom',
  'motionTrails',
  'displace',
  'lightRays',
] as const satisfies readonly LyricFXType[];

export type LyricFXPostType = (typeof LYRIC_FX_POST_TYPES)[number];

/**
 * One numeric parameter that can be static or audio-reactive, matching the
 * shipped `AudioReactiveConfig` shape so the existing binding path applies.
 */
interface LyricFXParam {
  /** Static value used when `reactive` is disabled or absent. */
  value: number;
  /** Optional audio-reactive binding (shipped AudioReactiveConfig). */
  reactive?: AudioReactiveConfig;
}

/** A configured effect in the Lyric FX stack (mirrors the main chain's shape). */
export interface LyricEffectInstance<T extends LyricFXType = LyricFXType> {
  id: string;
  type: T;
  config: Record<string, unknown> & { enabled: boolean };
}

/** Per-frame params handed to the LyricFXGraph each render. */
export interface LyricFXFrameParams {
  /** Media clock, seconds. */
  time: number;
  /** Frame delta, seconds. */
  dt: number;
  /** Target size [width, height], device pixels. */
  resolution: [number, number];
  /** Audio bands 0..1. */
  bass: number;
  mid: number;
  high: number;
  energy: number;
  /** The eight Stage-1 router slots (index 0 == value1). */
  routedSlots: [number, number, number, number, number, number, number, number];
  /** Fade-in window length in seconds (entry transition before charStart). */
  fadeInDuration?: number;
  /** Fade-out window length in seconds (exit transition after charEnd). */
  fadeOutDuration?: number;
  /** Pre / active / post word colours [r,g,b,a] in 0..1 (karaoke coloring). */
  colorPre?: [number, number, number, number];
  colorActive?: [number, number, number, number];
  colorPost?: [number, number, number, number];
  /** Fade granularity code (0 letter / 1 word / 2 line) for the base envelope. */
  fadeGranularity?: number;
  /** Outline/stroke colour [r,g,b] in 0..1 and width in field units (0 = none). */
  outlineColor?: [number, number, number];
  outlineWidth?: number;
  /** Karaoke highlight blend easing (seconds) into/out of the active colour. */
  highlightFadeIn?: number;
  highlightFadeOut?: number;
  /** When true, the base entry uses a pop/scale (easeBackOut) instead of alpha-only. */
  entryPop?: boolean;
}

// ─── UI helpers: labels + default-instance factory ─────────────────────────

/** Human-readable labels for the inspector rows. */
export const LYRIC_FX_LABELS: Record<LyricFXType, string> = {
  shatter: 'Shatter',
  kineticWave: 'Kinetic Wave',
  scatterAssemble: 'Scatter & Assemble',
  springSettle: 'Spring Settle',
  vortex: 'Vortex',
  impactTypewriter: 'Impact Typewriter',
  glyphJitter: 'Per-Glyph Jitter',
  cardFlip: 'Card Flip',
  swell: 'Swell / Erode',
  melt: 'Melt',
  dissolve: 'Dissolve / Burn',
  gradientFill: 'Gradient Fill',
  chromaticSplit: 'Chromatic Split',
  marchingOutline: 'Marching Outline',
  bevel: 'Bevel / Emboss',
  neonCore: 'Neon Core',
  refraction: 'Refraction',
  textBloom: 'Text Bloom',
  motionTrails: 'Motion Trails',
  displace: 'Displacement',
  lightRays: 'Light Rays',
};

const p = (value: number): LyricFXParam => ({ value });

/** Default config for each Lyric FX type (surface + transform stages). */
function defaultLyricFXConfig(
  type: LyricFXType,
  phase: LyricFXPhase = defaultPhaseFor(type),
): Record<string, unknown> & { enabled: boolean } {
  const base = {
    enabled: true,
    routedSlot: 1,
    lifecyclePhase: phase,
    lifecyclePhases: [phase] as LyricFXPhase[],
    granularity: 'word' as LyricFXGranularity,
  };
  switch (type) {
    // surface
    case 'swell':
      return { ...base, amount: p(0.15), softness: 0.05 };
    case 'melt':
      return { ...base, amount: p(0.3), noiseScale: 6 };
    case 'dissolve':
      return { ...base, progress: p(0), edgeWidth: 0.08, edgeColor: [1, 0.5, 0.1] };
    case 'gradientFill':
      return {
        ...base,
        colorA: [1, 1, 1, 1],
        colorB: [0.6, 0.7, 1, 1],
        angleDeg: 0,
        offset: p(0),
        space: 'glyph',
      };
    case 'chromaticSplit':
      return { ...base, amount: p(0.01), angleDeg: 0 };
    case 'marchingOutline':
      return { ...base, width: 0.06, dash: 0, phase: p(0), color: [1, 1, 1, 1] };
    case 'bevel':
      return { ...base, lightAngleDeg: p(45), strength: 0.5 };
    case 'neonCore':
      return {
        ...base,
        coreWidth: 0.05,
        haloWidth: p(0.2),
        coreColor: [1, 1, 1],
        haloColor: [0.4, 0.6, 1],
      };
    case 'refraction':
      return { ...base, strength: p(0.05), edgeFalloff: 2 };
    // transform
    case 'shatter':
      return { ...base, strength: p(1), gravity: 1 };
    case 'kineticWave':
      return { ...base, amplitude: p(8), wavelength: 0.6, speed: 4 };
    case 'scatterAssemble':
      return { ...base, spread: p(120) };
    case 'springSettle':
      return { ...base, amplitude: p(40), stiffness: 3, stagger: 0.03 };
    case 'vortex':
      return { ...base, radius: p(120), turns: 1.5 };
    case 'impactTypewriter':
      return { ...base, recoil: p(12) };
    case 'glyphJitter':
      return { ...base, amount: p(6) };
    case 'cardFlip':
      return { ...base, speed: p(3) };
    // post (Stage 5 — declared for completeness)
    default:
      return { ...base };
  }
}

let _lyricFXSeq = 0;

/**
 * Sensible default lifecycle phase for a newly-added effect of a given type.
 * Transforms read as entry motion (fadeIn); dissolve/melt as exit (fadeOut);
 * everything else holds on the active glyph.
 */
export function defaultPhaseFor(type: LyricFXType): LyricFXPhase {
  const stage = LYRIC_FX_STAGE[type];
  if (stage === 'transform') return 'fadeIn';
  if (type === 'dissolve' || type === 'melt') return 'fadeOut';
  return 'active';
}

/**
 * Resolve the lifecycle phases an instance is bound to. Prefers the multi
 * `lifecyclePhases`; falls back to the legacy single `lifecyclePhase`; finally
 * the per-type default. Always returns a non-empty, de-duplicated list.
 */
export function phasesOf(config: Record<string, unknown>, type: LyricFXType): LyricFXPhase[] {
  const multi = config.lifecyclePhases as LyricFXPhase[] | undefined;
  if (Array.isArray(multi) && multi.length > 0) {
    return Array.from(new Set(multi));
  }
  const single = config.lifecyclePhase as LyricFXPhase | undefined;
  return [single ?? defaultPhaseFor(type)];
}

/** Create a default Lyric FX instance for a given type (fresh id), bound to a phase. */
export function createLyricFXInstance(
  type: LyricFXType,
  phase: LyricFXPhase = defaultPhaseFor(type),
): LyricEffectInstance {
  return {
    id: `lyricfx-${type}-${Date.now().toString(36)}-${_lyricFXSeq++}`,
    type,
    config: defaultLyricFXConfig(type, phase),
  };
}

// ─── Per-effect param field descriptors (drive the inspector editor) ────────

type LyricFXFieldKind = 'slider' | 'param' | 'color' | 'colorAlpha' | 'select';

export interface LyricFXField {
  /** Config key. */
  key: string;
  label: string;
  kind: LyricFXFieldKind;
  min?: number;
  max?: number;
  step?: number;
  /** For 'select'. */
  options?: string[];
}

const SLIDER = (
  key: string,
  label: string,
  min: number,
  max: number,
  step = 0.01,
): LyricFXField => ({ key, label, kind: 'slider', min, max, step });
const PARAM = (
  key: string,
  label: string,
  min: number,
  max: number,
  step = 0.01,
): LyricFXField => ({ key, label, kind: 'param', min, max, step });

/** Editable fields per Lyric FX type. Empty ⇒ no params (enable/remove only). */
export const LYRIC_FX_FIELDS: Record<LyricFXType, LyricFXField[]> = {
  // surface
  swell: [PARAM('amount', 'Amount', -0.5, 0.5), SLIDER('softness', 'Softness', 0, 0.3)],
  melt: [PARAM('amount', 'Drip', 0, 1), SLIDER('noiseScale', 'Noise scale', 1, 20, 0.1)],
  dissolve: [
    PARAM('progress', 'Progress', 0, 1),
    SLIDER('edgeWidth', 'Edge width', 0.01, 0.3),
    { key: 'edgeColor', label: 'Edge color', kind: 'color' },
  ],
  gradientFill: [
    { key: 'colorA', label: 'Color A', kind: 'colorAlpha' },
    { key: 'colorB', label: 'Color B', kind: 'colorAlpha' },
    SLIDER('angleDeg', 'Angle', 0, 360, 1),
    PARAM('offset', 'Offset', -1, 1),
    { key: 'space', label: 'Space', kind: 'select', options: ['glyph', 'line'] },
  ],
  chromaticSplit: [
    PARAM('amount', 'Amount', 0, 0.05, 0.001),
    SLIDER('angleDeg', 'Angle', 0, 360, 1),
  ],
  marchingOutline: [
    SLIDER('width', 'Width', 0.01, 0.2),
    SLIDER('dash', 'Dash', 0, 1),
    PARAM('phase', 'Phase', 0, 10),
    { key: 'color', label: 'Color', kind: 'colorAlpha' },
  ],
  bevel: [PARAM('lightAngleDeg', 'Light angle', 0, 360, 1), SLIDER('strength', 'Strength', 0, 2)],
  neonCore: [
    SLIDER('coreWidth', 'Core width', 0, 0.3),
    PARAM('haloWidth', 'Halo width', 0, 0.5),
    { key: 'coreColor', label: 'Core color', kind: 'color' },
    { key: 'haloColor', label: 'Halo color', kind: 'color' },
  ],
  refraction: [
    PARAM('strength', 'Strength', 0, 0.2),
    SLIDER('edgeFalloff', 'Falloff', 0.1, 6, 0.1),
  ],
  // transform
  shatter: [PARAM('strength', 'Strength', 0, 3), SLIDER('gravity', 'Gravity', 0, 5, 0.1)],
  kineticWave: [
    PARAM('amplitude', 'Amplitude', 0, 40, 0.5),
    SLIDER('wavelength', 'Wavelength', 0.1, 2),
    SLIDER('speed', 'Speed', 0, 12, 0.1),
  ],
  scatterAssemble: [PARAM('spread', 'Spread', 0, 400, 1)],
  springSettle: [
    PARAM('amplitude', 'Amplitude', 0, 120, 1),
    SLIDER('stiffness', 'Stiffness', 0.5, 8, 0.1),
    SLIDER('stagger', 'Stagger', 0, 0.2, 0.005),
  ],
  vortex: [PARAM('radius', 'Radius', 0, 400, 1), SLIDER('turns', 'Turns', 0, 4, 0.1)],
  impactTypewriter: [PARAM('recoil', 'Recoil', 0, 40, 0.5)],
  glyphJitter: [PARAM('amount', 'Amount', 0, 30, 0.5)],
  cardFlip: [PARAM('speed', 'Speed', 0, 10, 0.1)],
  // post (Stage 5)
  textBloom: [SLIDER('threshold', 'Threshold', 0, 1), PARAM('intensity', 'Intensity', 0, 3)],
  motionTrails: [SLIDER('decay', 'Decay', 0, 1)],
  displace: [PARAM('amount', 'Amount', 0, 0.2), SLIDER('scale', 'Scale', 1, 20, 0.1)],
  lightRays: [PARAM('intensity', 'Intensity', 0, 2), SLIDER('decay', 'Decay', 0.8, 1, 0.005)],
};

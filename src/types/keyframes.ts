/**
 * Keyframe System Types - Unified Model
 *
 * A Keyframe is a point in time that can store one or more property overrides.
 * All tabs (Scene, Lyrics, Effects, Transitions) can target the same keyframes.
 */

export interface SceneTransitionConfig {
  type:
    | 'crossfade'
    | 'wipe-left'
    | 'wipe-right'
    | 'zoom-in'
    | 'zoom-out'
    | 'bloom-flash'
    | 'cut'
    | 'fade-black';
  duration: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
}

export type SceneTransitionType = SceneTransitionConfig['type'];

type BackgroundKeyframePropertyMap = {
  // Scene properties
  'scene.backgroundColor'?: string;
  /** @deprecated Kept for backward compat with old project files */
  'scene.backgroundMode'?: 'standard' | 'video' | 'pixi' | 'space' | 'solid';
  'scene.backgroundFit'?: string;
  'scene.backgroundBrightness'?: number;
  'scene.backgroundOpacity'?: number;
  'scene.backgroundScale'?: number;
  'scene.backgroundOffsetX'?: number;
  'scene.backgroundOffsetY'?: number;
  'scene.backgroundAngle'?: number;
  'scene.backgroundTileOffsetX'?: number;
  'scene.backgroundTileOffsetY'?: number;
  'scene.assetUrl'?: string;
  'scene.backgroundMediaIndex'?: number;

  // Transition
  transition?: SceneTransitionConfig;

  // Allow custom scene properties
  [key: `scene.${string}`]: unknown;
};

type LyricsKeyframePropertyMap = {
  // Lyrics properties
  'lyrics.fontSize'?: number;
  'lyrics.wordSpacing'?: number;
  'lyrics.verticalPosition'?: number;
  'lyrics.fontId'?: string;
  'lyrics.animationType'?: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
  'lyrics.animationStagger'?: 'letter' | 'word' | 'line';
  'lyrics.fadeInDuration'?: number;
  'lyrics.fadeOutDuration'?: number;
  'lyrics.colors.pre'?: string;
  'lyrics.colors.active'?: string;
  'lyrics.colors.post'?: string;
  'lyrics.outlineColor'?: string;
  'lyrics.glowEnabled'?: boolean;
  'lyrics.glowColor'?: string;
  'lyrics.glowIntensity'?: number;

  // Allow custom lyrics properties
  [key: `lyrics.${string}`]: unknown;
};

type EffectsKeyframePropertyMap = {
  // Effects properties (keep string-indexed for dynamic effect types)
  [key: `effects.${string}`]: unknown;
};

export type KeyframePropertyMap = BackgroundKeyframePropertyMap &
  LyricsKeyframePropertyMap &
  EffectsKeyframePropertyMap &
  Record<string, unknown>;

interface BaseKeyframe {
  id: string;
  /** Time in seconds on the timeline */
  time: number;
  /** Human-readable label (optional) */
  label?: string;
  /** Which track lane this keyframe belongs to */
  lane?: 'background' | 'effects' | 'lyrics';
  /** Interpolation easing for transitions arriving at this keyframe's values */
  interpolation?:
    | 'hold'
    | 'instant'
    | 'linear'
    | 'lerp'
    | 'ease-in'
    | 'ease-out'
    | 'ease-in-out'
    | 'curve'
    | 'logarithmic'
    | 'exponential'
    | 'hermite'
    | 'tcb'
    | 'cubic-bezier';
  /** Optional duration for the transition leading TO this keyframe's values */
  transitionDuration?: number;

  // ─── Advanced Interpolation Metadata (v2) ────────────────────────

  /**
   * Tangent metadata for Hermite / TCB interpolation.
   * Only used when interpolation is 'hermite', 'tcb', or 'cubic-bezier'.
   */
  tangent?: {
    /** Incoming tangent slope (for 'hermite' mode) */
    inTangent?: number;
    /** Outgoing tangent slope (for 'hermite' mode) */
    outTangent?: number;
    /** TCB Tension parameter [-1, 1]. Default: 0 */
    tension?: number;
    /** TCB Continuity parameter [-1, 1]. Default: 0 */
    continuity?: number;
    /** TCB Bias parameter [-1, 1]. Default: 0 */
    bias?: number;
    /** Cubic-bezier control points [x1, y1, x2, y2] */
    bezierPoints?: [number, number, number, number];
    /** If true, inTangent and outTangent are independent (sharp corner) */
    broken?: boolean;
  };

  /**
   * How to extrapolate before the first keyframe.
   * Default: 'constant' (hold first value).
   */
  preExtrapolation?: 'constant' | 'linear' | 'cyclic' | 'ping-pong' | 'relative-cyclic';

  /**
   * How to extrapolate after the last keyframe.
   * Default: 'constant' (hold last value).
   */
  postExtrapolation?: 'constant' | 'linear' | 'cyclic' | 'ping-pong' | 'relative-cyclic';

  /**
   * Color interpolation space for color properties at this keyframe.
   * Default: 'oklab' (perceptually uniform).
   */
  colorSpace?: 'rgb' | 'srgb' | 'oklab' | 'oklch' | 'lch';

  /**
   * Hue interpolation mode for polar color spaces (oklch, lch).
   * Default: 'shorter'.
   */
  hueMode?: 'shorter' | 'longer' | 'increasing' | 'decreasing';
}

export interface Keyframe extends BaseKeyframe {
  properties: KeyframePropertyMap;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a summary label for what this keyframe controls */
export function getKeyframeLabel(kf: Keyframe): string {
  if (kf.label) return kf.label;

  const keys = Object.keys(kf.properties);
  if (keys.length === 0) return 'Empty';
  if (keys.length === 1) {
    const key = keys[0];
    if (key === 'transition') return kf.properties.transition?.type.toUpperCase() || 'TRANSITION';
    return key.split('.').pop()?.toUpperCase() || 'Property';
  }

  return `${keys.length} Attributes`;
}

export function getKeyframeColor(kf: Keyframe): string {
  const keys = Object.keys(kf.properties);
  if (keys.includes('transition')) return '#10b981'; // emerald

  // Color based on most prominent property type
  if (keys.some((k) => k.startsWith('effects.'))) return '#a855f7'; // purple
  if (keys.some((k) => k.startsWith('lyrics.'))) return '#22d3ee'; // cyan
  if (keys.some((k) => k.startsWith('scene.'))) return '#f59e0b'; // amber

  return '#94a3b8'; // slate
}

function getKeyframeLane(kf: Keyframe): 'background' | 'effects' | 'lyrics' {
  if (kf.lane) return kf.lane;
  const keys = Object.keys(kf.properties);
  if (keys.some((k) => k.startsWith('scene.') || k === 'transition')) return 'background';
  if (keys.some((k) => k.startsWith('lyrics.'))) return 'lyrics';
  return 'effects';
}

export function createKeyframe(
  time: number,
  properties: Partial<KeyframePropertyMap> = {},
  lane?: 'background' | 'effects' | 'lyrics',
): Keyframe {
  // Non-zero keyframes get a default crossfade transition so scene changes
  // are smooth by default. The user can change to instant/wipe/etc later.
  const defaultProps: Partial<KeyframePropertyMap> =
    time > 0 && !properties.transition
      ? { transition: { type: 'crossfade', duration: 1.0 }, ...properties }
      : { ...properties };

  const finalLane = lane || (properties ? getKeyframeLane({ properties } as Keyframe) : 'effects');

  return {
    id: crypto.randomUUID(),
    time,
    properties: defaultProps,
    interpolation: 'hold',
    lane: finalLane,
  };
}

export function sortKeyframes(kfs: Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.time - b.time);
}

interface LegacyKeyframePayload {
  type?: string;
  targetType?: string;
  data: {
    transition?: SceneTransitionConfig;
    property?: string;
    value?: unknown;
  };
}

type LegacyKeyframe = Partial<BaseKeyframe> & {
  properties?: KeyframePropertyMap;
  payload?: LegacyKeyframePayload;
};

/** Migration helper for legacy keyframes */
function migrateKeyframe(kf: LegacyKeyframe): Keyframe {
  if (kf.properties) {
    const res = kf as Keyframe;
    if (!res.lane) {
      res.lane = getKeyframeLane(res);
    }
    return res;
  }

  const newKf: Keyframe = {
    id: kf.id || crypto.randomUUID(),
    time: kf.time || 0,
    label: kf.label,
    properties: {},
    interpolation: kf.interpolation || 'linear',
    transitionDuration: kf.transitionDuration,
  };

  const payload = kf.payload;
  if (payload) {
    if (payload.type === 'transition') {
      newKf.properties.transition = payload.data.transition;
    } else if (payload.type === 'attribute') {
      newKf.properties[payload.data.property as string] = payload.data.value;
    } else if (payload.targetType) {
      // Very old format
      if (payload.targetType === 'scene-transition') {
        newKf.properties.transition = payload.data.transition;
      } else if (payload.targetType === 'lyric-style') {
        newKf.properties[`lyrics.${payload.data.property}`] = payload.data.value;
      } else if (payload.targetType === 'scene-setting') {
        newKf.properties[`scene.${payload.data.property}`] = payload.data.value;
      } else if (payload.targetType === 'effect') {
        newKf.properties[`effects.${payload.data.property}`] = payload.data.value;
      }
    }
  }

  newKf.lane = getKeyframeLane(newKf);
  return newKf;
}

export function migrateKeyframes(kfs: LegacyKeyframe[] | null | undefined): Keyframe[] {
  if (!kfs || !Array.isArray(kfs)) return [];
  return kfs.map(migrateKeyframe);
}

/**
 * All scene property keys that keyframes can control.
 * Single source of truth — used by computeStateAtTime and the export pipeline.
 */
export const ALL_SCENE_KEYS: string[] = [
  'backgroundMode', // deprecated, kept for compat
  'assetUrl',
  'backgroundFit',
  'backgroundColor',
  'backgroundBrightness',
  'backgroundOpacity',
  'backgroundScale',
  'backgroundOffsetX',
  'backgroundOffsetY',
  'backgroundAngle',
  'backgroundTileOffsetX',
  'backgroundTileOffsetY',
  'backgroundTiling',
  'backgroundMediaIndex',
];

/**
 * Subset of scene keys that are numeric (use `undefined` as null sentinel).
 */
export const NUMERIC_SCENE_PROPS: string[] = [
  'backgroundBrightness',
  'backgroundOpacity',
  'backgroundScale',
  'backgroundOffsetX',
  'backgroundOffsetY',
  'backgroundAngle',
  'backgroundTileOffsetX',
  'backgroundTileOffsetY',
  'backgroundMediaIndex',
];

/**
 * Canonical list of interpolation strategies for keyframes.
 * Used by KeyframeMenu, KeyframeDropdown, and easeValue().
 *
 * Note: 'instant' and 'hold' are semantically identical (step at t=1).
 * Note: 'lerp' is a legacy alias for 'linear' and is intentionally excluded.
 */
export const INTERPOLATION_STRATEGIES = [
  { value: 'instant' as const, label: 'INSTANT' },
  { value: 'linear' as const, label: 'LINEAR' },
  { value: 'ease-in' as const, label: 'EASE IN' },
  { value: 'ease-out' as const, label: 'EASE OUT' },
  { value: 'ease-in-out' as const, label: 'EASE IN-OUT' },
  { value: 'curve' as const, label: 'CURVE' },
  { value: 'logarithmic' as const, label: 'LOGARITHMIC' },
  { value: 'exponential' as const, label: 'EXPONENTIAL' },
  { value: 'hermite' as const, label: 'HERMITE' },
  { value: 'tcb' as const, label: 'TCB SPLINE' },
  { value: 'cubic-bezier' as const, label: 'CUBIC BEZIER' },
  { value: 'hold' as const, label: 'HOLD' },
] as const;

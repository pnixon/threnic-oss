import { type Keyframe, NUMERIC_SCENE_PROPS, ALL_SCENE_KEYS } from '@/types/keyframes';
import type { LyricTheme } from '@/types/lyrics';
import type { EffectsConfig, EffectInstance, EffectType } from '@/types/effects';
import { deepEqual } from './index';
import { getNestedValue, setNestedValue } from './objectUtils';
import {
  interpolateColor,
  isColorValue,
  interpolateGradient,
  isGradientValue,
  parseGradient,
  gradientToCSS,
  evalHermiteSegment,
  easeValue,
  type ChannelKey,
} from '@/engine/keyframes/interpolation';

type KeyframeValue = number | string | boolean | null;

/** Scene overrides resolved from keyframes; known keys are typed, custom keys are open. */
interface KeyframeSceneState {
  /** @deprecated Kept for backward compat with old project files */
  backgroundMode?: EffectsConfig['backgroundMode'];
  assetUrl?: string | null;
  backgroundFit?: EffectsConfig['backgroundFit'];
  backgroundColor?: string;
  backgroundBrightness?: number;
  backgroundOpacity?: number;
  backgroundScale?: number;
  backgroundOffsetX?: number;
  backgroundOffsetY?: number;
  backgroundAngle?: number;
  backgroundTileOffsetX?: number;
  backgroundTileOffsetY?: number;
  backgroundTiling?: boolean;
  backgroundMediaIndex?: number;
  backgroundContrast?: number;
  backgroundBlur?: number;
  [key: string]: unknown;
}

type EffectsRecord = Record<string, unknown>;

/**
 * A config key counts as an "opacity" parameter (the only kind that fades out
 * before an effect turns off). Matches `opacity`, `bgOpacity`, `imageOpacity`, …
 */
function isOpacityKey(key: string): boolean {
  return key.toLowerCase().endsWith('opacity');
}

/**
 * Whether an effect instance config exposes a numeric opacity parameter,
 * i.e. whether it can visually fade out rather than hard-cutting.
 */
function instanceHasOpacity(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  return Object.entries(config).some(([k, v]) => typeof v === 'number' && isOpacityKey(k));
}

/**
 * Computes the final EffectsConfig by applying keyframe overrides to a base config.
 * This is pure and should be called when keyframe overrides change.
 */
export function computeFinalEffectsConfig(
  baseConfig: EffectsConfig | undefined,
  sceneOverrides: Record<string, unknown>,
  effectOverrides: Record<string, unknown>,
): EffectsConfig | undefined {
  if (!baseConfig) return undefined;

  let result: EffectsConfig = { ...baseConfig };

  // Layer 1: Scene keyframe overrides
  if (
    sceneOverrides.backgroundBrightness !== undefined ||
    sceneOverrides.backgroundOpacity !== undefined ||
    sceneOverrides.backgroundColor ||
    sceneOverrides.backgroundMode || // deprecated, kept for compat
    sceneOverrides.backgroundTiling !== undefined
  ) {
    result = {
      ...result,
      backgroundMode:
        (sceneOverrides.backgroundMode as EffectsConfig['backgroundMode']) || result.backgroundMode, // deprecated
      backgroundFit:
        (sceneOverrides.backgroundFit as EffectsConfig['backgroundFit']) || result.backgroundFit,
      backgroundTiling:
        sceneOverrides.backgroundTiling !== undefined
          ? (sceneOverrides.backgroundTiling as boolean)
          : result.backgroundTiling,
      backgroundBrightness: sceneOverrides.backgroundBrightness ?? result.backgroundBrightness,
      backgroundOpacity: sceneOverrides.backgroundOpacity ?? result.backgroundOpacity,
      backgroundScale: sceneOverrides.backgroundScale ?? result.backgroundScale,
      backgroundOffsetX: sceneOverrides.backgroundOffsetX ?? result.backgroundOffsetX,
      backgroundOffsetY: sceneOverrides.backgroundOffsetY ?? result.backgroundOffsetY,
      backgroundColor:
        sceneOverrides.backgroundColor ||
        result.backgroundColor ||
        result.visualizer?.backgroundColor ||
        '#000000',
      visualizer: {
        ...result.visualizer,
        backgroundColor:
          sceneOverrides.backgroundColor || result.visualizer?.backgroundColor || '#000000',
      },
    } as EffectsConfig;
  }

  // Layer 2: Effect keyframe overrides
  const effectKeys = Object.keys(effectOverrides);
  if (effectKeys.length > 0) {
    let instancesChanged = false;
    const nextInstances = [...result.effectInstances];

    for (const rawPath of effectKeys) {
      if (rawPath === 'effectInstances') continue; // Skip structural data

      const val = effectOverrides[rawPath];

      // ── Instance-aware addressing: fx.<instanceId>.<property> ──
      // These are resolved directly by instance ID, not by type.
      if (rawPath.startsWith('fx.')) {
        const parts = rawPath.split('.');
        const instanceId = parts[1];
        const propPath = parts.slice(2).join('.');

        if (instanceId && propPath) {
          const instanceIdx = nextInstances.findIndex((inst) => inst.id === instanceId);
          if (instanceIdx !== -1) {
            const instance = nextInstances[instanceIdx];
            const currentVal = getNestedValue(instance.config, propPath);
            if (!deepEqual(currentVal, val)) {
              nextInstances[instanceIdx] = {
                ...instance,
                config: { ...instance.config },
              } as EffectInstance;
              setNestedValue(nextInstances[instanceIdx].config, propPath, val);
              instancesChanged = true;
            }
          }
        }
        continue;
      }

      // ── Legacy addressing: effects.[postProcessing.]<type>.<property> ──
      const path = rawPath.startsWith('effects.') ? rawPath.substring(8) : rawPath;

      // Update the legacy flat config
      const currentFlatVal = getNestedValue(result, path);
      if (!deepEqual(currentFlatVal, val)) {
        setNestedValue(result, path, val);
      }

      // Resolve target instance and sub-property path
      const parts = path.split('.');
      let targetType: string | null = null;
      let propPath: string | null = null;

      if (parts[0] === 'postProcessing' && parts.length >= 2) {
        targetType = parts[1];
        propPath = parts.slice(2).join('.');
      } else {
        targetType = parts[0];
        propPath = parts.slice(1).join('.');
      }

      if (targetType && propPath) {
        const instanceIdx = nextInstances.findIndex((inst) => inst.type === targetType);

        if (instanceIdx !== -1) {
          const instance = nextInstances[instanceIdx];
          const currentVal = getNestedValue(instance.config, propPath);

          if (!deepEqual(currentVal, val)) {
            nextInstances[instanceIdx] = {
              ...instance,
              config: { ...instance.config },
            } as EffectInstance;
            setNestedValue(nextInstances[instanceIdx].config, propPath, val);
            instancesChanged = true;
          }
        }
      }
    }

    // Scale numeric parameters smoothly during enabled transitions
    const fadeFactors = (effectOverrides._fadeFactors as Record<string, number> | undefined) || {};
    for (let i = 0; i < nextInstances.length; i++) {
      const inst = nextInstances[i];
      const fadeKey = `fx.${inst.id}`;
      const legacyFadeKey = inst.type;
      const finalFadeFactor =
        fadeFactors[fadeKey] !== undefined
          ? fadeFactors[fadeKey]
          : fadeFactors[legacyFadeKey] !== undefined
            ? fadeFactors[legacyFadeKey]
            : null;

      if (finalFadeFactor !== null && finalFadeFactor < 1.0) {
        const nextConfig = { ...inst.config } as Record<string, unknown>;

        // Only OPACITY parameters fade out — everything else (brightness,
        // contrast, distortion, intensity, scale, …) keeps its interpolated
        // value and the effect simply turns off at the disable keyframe.
        for (const [key, val] of Object.entries(nextConfig)) {
          if (typeof val === 'number' && isOpacityKey(key)) {
            nextConfig[key] = val * finalFadeFactor;
          }
        }

        nextInstances[i] = {
          ...inst,
          config: nextConfig,
        } as EffectInstance;
        instancesChanged = true;
      }
    }

    if (instancesChanged) {
      result.effectInstances = nextInstances;
    }
  }

  return result;
}

/**
 * Helper to compute the fade factor (0.0 to 1.0) and force enabled status
 * during an active transition of an effect's 'enabled' property.
 *
 * `canFade` — whether this effect has an opacity parameter that can visually
 * ramp. Only fade-capable effects stay enabled through the transition window so
 * their opacity can ease to 0 before turning off. Effects WITHOUT opacity
 * (contrast, brightness, distortion, etc.) hard-cut: their enabled state steps
 * at the keyframe time and no fade window is applied.
 */
function getEffectFadeFactor(
  now: number,
  propKfs: Keyframe[],
  propPath: string,
  defaultValue?: boolean,
  canFade: boolean = true,
): { enabled: boolean; fadeFactor: number } {
  if (propKfs.length === 0) {
    const val = defaultValue !== undefined ? !!defaultValue : false;
    return { enabled: val, fadeFactor: val ? 1.0 : 0.0 };
  }

  // Find prev and next
  let prevIdx = -1;
  let nextIdx = -1;
  for (let i = 0; i < propKfs.length; i++) {
    if (propKfs[i].time <= now) {
      prevIdx = i;
    } else {
      nextIdx = i;
      break;
    }
  }

  // Before first
  if (prevIdx === -1) {
    const first = propKfs[0];
    const dur = first.transitionDuration || 0;
    const nextVal = !!first.properties[propPath];
    const safeDefault = defaultValue !== undefined ? !!defaultValue : false;

    if (canFade && dur > 0 && now >= first.time - dur) {
      const progress = (now - (first.time - dur)) / dur;
      const p = easeValue(progress, first.interpolation || 'linear', first.tangent);
      if (safeDefault !== nextVal) {
        // transitioning between enabled states
        const fadeFactor = safeDefault ? 1.0 - p : p;
        return { enabled: true, fadeFactor }; // force enabled during transition
      }
      return {
        enabled: p >= 1 ? nextVal : safeDefault,
        fadeFactor: (p >= 1 ? nextVal : safeDefault) ? 1.0 : 0.0,
      };
    }
    // No fade: step to the first keyframe's value AT its time.
    const stepped = now >= first.time ? nextVal : safeDefault;
    return { enabled: stepped, fadeFactor: stepped ? 1.0 : 0.0 };
  }

  const prev = propKfs[prevIdx];
  const prevVal = !!prev.properties[propPath];

  // After last
  if (nextIdx === -1) {
    return { enabled: prevVal, fadeFactor: prevVal ? 1.0 : 0.0 };
  }

  const next = propKfs[nextIdx];
  const nextVal = !!next.properties[propPath];

  // Transition-in on NEXT
  const nextDur = next.transitionDuration || 0;
  if (canFade && nextDur > 0 && now >= next.time - nextDur) {
    const progress = (now - (next.time - nextDur)) / nextDur;
    const p = easeValue(progress, next.interpolation || 'linear', next.tangent);
    if (prevVal !== nextVal) {
      const fadeFactor = prevVal ? 1.0 - p : p;
      return { enabled: true, fadeFactor }; // force enabled during transition
    }
    return {
      enabled: p >= 1 ? nextVal : prevVal,
      fadeFactor: (p >= 1 ? nextVal : prevVal) ? 1.0 : 0.0,
    };
  }

  // Forward interpolation
  const interp = next.interpolation || 'linear';
  if (interp === 'hold' || interp === 'instant') {
    return { enabled: prevVal, fadeFactor: prevVal ? 1.0 : 0.0 };
  }

  // Regular linear or eased transition over a span
  const gap = next.time - prev.time;
  if (canFade && gap > 0) {
    const progress = (now - prev.time) / gap;
    const p = easeValue(progress, interp, next.tangent);
    if (prevVal !== nextVal) {
      const fadeFactor = prevVal ? 1.0 - p : p;
      return { enabled: true, fadeFactor }; // force enabled during transition
    }
    return {
      enabled: p >= 1 ? nextVal : prevVal,
      fadeFactor: (p >= 1 ? nextVal : prevVal) ? 1.0 : 0.0,
    };
  }

  // No fade (or hold): enabled steps to nextVal AT next.time, else holds prevVal.
  const stepped = now >= next.time ? nextVal : prevVal;
  return { enabled: stepped, fadeFactor: stepped ? 1.0 : 0.0 };
}

/**
 * Pure interpolation logic for a single property.
 *
 * Supports:
 * - Numeric LERP with all easing curves
 * - Perceptual color interpolation (Oklab / OkLCH)
 * - Gradient morphing with stop normalization
 * - Hermite / TCB spline evaluation for numeric values
 * - Boolean / string hold semantics
 */
export function interpolateValue(
  now: number,
  propKfs: Keyframe[],
  propPath: string,
  defaultValue?: KeyframeValue,
): KeyframeValue {
  if (propKfs.length === 0) return defaultValue !== undefined ? defaultValue : null;

  // Find prev (latest at or before now) and next (earliest after now)
  let prevIdx = -1;
  let nextIdx = -1;

  for (let i = 0; i < propKfs.length; i++) {
    if (propKfs[i].time <= now) {
      prevIdx = i;
    } else {
      nextIdx = i;
      break;
    }
  }

  // 1. Before first
  if (prevIdx === -1) {
    const first = propKfs[0];
    const dur = first.transitionDuration || 0;
    if (dur > 0 && now >= first.time - dur) {
      const progress = (now - (first.time - dur)) / dur;
      const p = easeValue(progress, first.interpolation || 'linear', first.tangent);
      const nextVal = first.properties[propPath] as KeyframeValue;

      const safeDefault =
        defaultValue !== undefined && defaultValue !== null
          ? defaultValue
          : typeof nextVal === 'number'
            ? 0
            : null;

      if (typeof safeDefault === 'number' && typeof nextVal === 'number') {
        return safeDefault + (nextVal - safeDefault) * p;
      }
      // Color interpolation on first-key transition
      if (isColorValue(safeDefault) && isColorValue(nextVal)) {
        const colorSpace = first.colorSpace || 'oklab';
        const hueMode = first.hueMode || 'shorter';
        return interpolateColor(safeDefault as string, nextVal as string, p, colorSpace, hueMode);
      }
      if (typeof safeDefault === 'boolean' || typeof nextVal === 'boolean') {
        return safeDefault || nextVal;
      }
      return p >= 1 ? nextVal : safeDefault;
    }
    return defaultValue !== undefined ? defaultValue : null;
  }

  const prev = propKfs[prevIdx];
  const prevVal = prev.properties[propPath] as KeyframeValue;

  // 2. After last
  if (nextIdx === -1) {
    return prevVal;
  }

  const next = propKfs[nextIdx];
  const nextVal = next.properties[propPath] as KeyframeValue;

  // 3. Transition-in on NEXT
  const nextDur = next.transitionDuration || 0;
  if (nextDur > 0 && now >= next.time - nextDur) {
    const progress = (now - (next.time - nextDur)) / nextDur;
    const p = easeValue(progress, next.interpolation || 'linear', next.tangent);
    if (typeof prevVal === 'number' && typeof nextVal === 'number') {
      return prevVal + (nextVal - prevVal) * p;
    }
    // Perceptual color blending during transitions
    if (isColorValue(prevVal) && isColorValue(nextVal)) {
      const colorSpace = next.colorSpace || 'oklab';
      const hueMode = next.hueMode || 'shorter';
      return interpolateColor(prevVal as string, nextVal as string, p, colorSpace, hueMode);
    }
    if (typeof prevVal === 'boolean' || typeof nextVal === 'boolean') {
      return p >= 1 ? nextVal : prevVal;
    }
    return p >= 1 ? nextVal : prevVal;
  }

  // 4. Forward interpolation toward NEXT
  // The TARGET keyframe always controls the easing. This is prescriptive:
  // setting "linear" on a keyframe means "ramp into my values linearly".
  // Default is 'linear' — explicit 'hold'/'instant' required to snap.
  const interp = next.interpolation || 'linear';
  if (interp === 'hold' || interp === 'instant') return prevVal;

  const duration = next.time - prev.time;
  if (duration <= 0) return prevVal;

  const progress = (now - prev.time) / duration;

  // ─── Hermite / TCB spline for numerics ─────────────────────────
  if (
    (interp === 'hermite' || interp === 'tcb') &&
    typeof prevVal === 'number' &&
    typeof nextVal === 'number'
  ) {
    // Build a minimal ChannelKey array for the segment and its neighbors
    const channelKeys: ChannelKey[] = propKfs.map((kf) => ({
      time: kf.time,
      value: typeof kf.properties[propPath] === 'number' ? (kf.properties[propPath] as number) : 0,
      interpolation: kf.interpolation || 'linear',
      tangent: kf.tangent,
    }));
    return evalHermiteSegment(channelKeys, prevIdx, progress);
  }

  const p = easeValue(progress, interp, next.tangent);

  // ─── Numeric LERP (standard) ───────────────────────────────────
  if (typeof prevVal === 'number' && typeof nextVal === 'number') {
    return prevVal + (nextVal - prevVal) * p;
  }

  // ─── Perceptual color interpolation ────────────────────────────
  if (isColorValue(prevVal) && isColorValue(nextVal)) {
    const colorSpace = next.colorSpace || 'oklab';
    const hueMode = next.hueMode || 'shorter';
    return interpolateColor(prevVal as string, nextVal as string, p, colorSpace, hueMode);
  }

  // ─── Gradient morphing ─────────────────────────────────────────
  if (isGradientValue(prevVal) && isGradientValue(nextVal)) {
    const grad0 = parseGradient(prevVal as string);
    const grad1 = parseGradient(nextVal as string);
    if (grad0 && grad1) {
      const colorSpace = next.colorSpace || 'oklab';
      const hueMode = next.hueMode || 'shorter';
      const blended = interpolateGradient(grad0, grad1, p, colorSpace, hueMode);
      return gradientToCSS(blended);
    }
  }

  // ─── Booleans and strings: hold interpolation ──────────────────
  return prevVal;
}

/**
 * Resolve which keyframe an edit to an animated property should MUTATE.
 *
 * Policy (agreed with the user):
 *  - Editing an active value NEVER creates a keyframe — it alters an existing one.
 *  - A manual dropdown selection (`selectedKeyframeId`) is authoritative: if it
 *    names a keyframe that actually carries this property, that keyframe is the
 *    target regardless of where the playhead sits. User interaction overrides the
 *    playhead-driven auto-tracking.
 *  - With no usable manual selection, the target is the ACTIVE keyframe for this
 *    property: the latest keyframe carrying `propertyPath` at or before `now`
 *    (the one currently governing the render), matching interpolateValue's `prev`.
 *  - If no keyframe at/before `now` carries the property but a LATER one does,
 *    target that first (earliest) one so a pre-first-keyframe edit still lands on
 *    a real keyframe rather than being lost.
 *  - Returns `null` when the property is NOT animated at all (no keyframe carries
 *    it) — the caller then writes base config (Option B: base before the first
 *    keyframe means "not animated", i.e. no keyframes for this property exist).
 *
 * Returns the target keyframe id, or `null` to signal "write base".
 */
export function resolveWritableKeyframeId(
  keyframes: Keyframe[] | undefined,
  propertyPath: string,
  now: number,
  selectedKeyframeId?: string | null,
): string | null {
  const kfs = keyframes || [];
  // Keyframes that actually carry this property, ascending by time.
  const propKfs = kfs
    .filter((kf) => kf.properties && propertyPath in kf.properties)
    .sort((a, b) => a.time - b.time);

  if (propKfs.length === 0) return null; // not animated → base

  // 1. Manual selection wins — but only if the selected keyframe carries this prop.
  const selId = selectedKeyframeId && selectedKeyframeId !== 'default' ? selectedKeyframeId : null;
  if (selId) {
    const sel = propKfs.find((kf) => kf.id === selId);
    if (sel) return sel.id;
    // The selected keyframe exists but doesn't carry this property yet — still
    // honor the user's intent to edit THAT keyframe (add the prop to it).
    if (kfs.some((kf) => kf.id === selId)) return selId;
  }

  // 2. Active keyframe: latest at or before `now`.
  let active: Keyframe | null = null;
  for (const kf of propKfs) {
    if (kf.time <= now + 0.05) active = kf;
    else break;
  }
  if (active) return active.id;

  // 3. Playhead is before the first keyframe for this prop → target the first one.
  return propKfs[0].id;
}

/**
 * Multi-path variant for effect-instance edits, which produce several dot-path
 * properties at once (`fx.<id>.<prop>` …). A property set counts as "animated"
 * if ANY of its paths is carried by a keyframe. The write target is:
 *  - the manual selection (if it names an existing keyframe), else
 *  - the latest keyframe (at/before `now`) that carries ANY of the paths, else
 *  - the earliest keyframe that carries any path (pre-first-keyframe edit), else
 *  - null → not animated, write base.
 */
export function resolveWritableKeyframeIdMulti(
  keyframes: Keyframe[] | undefined,
  propertyPaths: string[],
  now: number,
  selectedKeyframeId?: string | null,
): string | null {
  const kfs = keyframes || [];
  const carries = (kf: Keyframe) =>
    !!kf.properties && propertyPaths.some((p) => p in kf.properties);
  const propKfs = kfs.filter(carries).sort((a, b) => a.time - b.time);

  if (propKfs.length === 0) return null;

  const selId = selectedKeyframeId && selectedKeyframeId !== 'default' ? selectedKeyframeId : null;
  if (selId && kfs.some((kf) => kf.id === selId)) return selId;

  let active: Keyframe | null = null;
  for (const kf of propKfs) {
    if (kf.time <= now + 0.05) active = kf;
    else break;
  }
  if (active) return active.id;

  return propKfs[0].id;
}

export interface ParsedKeyframes {
  propMap: Map<string, Keyframe[]>;
  transitionKfs: Keyframe[];
}

const parsedCache = new WeakMap<Keyframe[], ParsedKeyframes>();

export function parseKeyframes(keyframes: Keyframe[]): ParsedKeyframes {
  if (parsedCache.has(keyframes)) {
    return parsedCache.get(keyframes)!;
  }

  const propMap = new Map<string, Keyframe[]>();
  const transitionKfs: Keyframe[] = [];

  for (const kf of keyframes) {
    if (kf.properties?.transition) {
      transitionKfs.push(kf);
    }
    for (const propPath of Object.keys(kf.properties)) {
      if (propPath === 'transition' || propPath === 'effectInstances') continue;
      let list = propMap.get(propPath);
      if (!list) {
        list = [];
        propMap.set(propPath, list);
      }
      list.push(kf);
    }
  }

  // Pre-sort all the prop lists
  for (const list of propMap.values()) {
    list.sort((a, b) => a.time - b.time);
  }

  // Pre-sort transitions
  transitionKfs.sort((a, b) => a.time - b.time);

  const parsed = { propMap, transitionKfs };
  // Only cache if the array is actually extensible/cacheable. Most objects are, but just in case.
  try {
    parsedCache.set(keyframes, parsed);
  } catch {}

  return parsed;
}

/**
 * Computes the unified state (scene, lyrics, effects, transitions) at a given time.
 * This is a pure function that does not modify global state.
 */
export function computeStateAtTime(
  keyframesOrParsed: Keyframe[] | ParsedKeyframes,
  time: number,
  defaultTheme?: LyricTheme,
  defaultEffects?: EffectsConfig,
  isInternal?: boolean,
): {
  effects: Record<string, unknown>;
  lyrics: Record<string, number | string | boolean>;
  scene: KeyframeSceneState;
  prevScene?: KeyframeSceneState;
  transition: {
    isActive: boolean;
    type: string | null;
    progress: number;
  };
} {
  const effects: Record<string, unknown> = {};
  const lyrics: Record<string, number | string | boolean> = {};
  const scene: KeyframeSceneState = {};
  let prevScene: KeyframeSceneState | undefined = undefined;
  const transition = {
    isActive: false,
    type: null as string | null,
    progress: 0,
  };

  if (!keyframesOrParsed) {
    return { effects, lyrics, scene, transition };
  }

  const isParsed = 'propMap' in keyframesOrParsed;
  const parsed = isParsed
    ? (keyframesOrParsed as ParsedKeyframes)
    : parseKeyframes(keyframesOrParsed as Keyframe[]);
  const { propMap, transitionKfs } = parsed;

  // ─── 1. Scene Transitions ───────────────────────────────────────────
  let activeFound = false;

  if (!isInternal) {
    for (const kf of transitionKfs) {
      const t = kf.properties.transition;
      if (!t) continue;
      const start = kf.time;
      const end = start + t.duration;

      if (time >= start && time <= end) {
        const raw = t.duration > 0 ? (time - start) / t.duration : 1;
        const easedRaw = easeValue(raw, t.easing || 'linear');
        transition.isActive = true;
        transition.type = t.type;
        transition.progress = easedRaw;
        activeFound = true;

        // Calculate outgoing state for cross-transitions
        // We look slightly back in time to get the state before this transition started
        const outState = computeStateAtTime(
          parsed,
          Math.max(0, start - 0.01),
          defaultTheme,
          defaultEffects,
          true,
        );
        prevScene = outState.scene;
        break;
      }
    }
  }

  if (!activeFound) {
    transition.isActive = false;
    transition.progress = 0;
  }

  // ─── 2. Attribute Processing ────────────────────────────────────────
  const fadeFactors: Record<string, number> = {};

  // Sort and interpolate each property
  for (const [propPath, propKfs] of propMap) {
    propKfs.sort((a, b) => a.time - b.time);

    let baseValue = undefined;
    const isEffectsProp = propPath.startsWith('effects.');
    const isFxProp = propPath.startsWith('fx.');

    if (propPath.startsWith('lyrics.')) {
      const p = propPath.replace('lyrics.', '');
      baseValue = defaultTheme ? getNestedValue(defaultTheme, p) : null;
    } else if (isFxProp) {
      // Instance-aware addressing: fx.<instanceId>.<property>
      // Resolve base value from the matching instance's config
      const parts = propPath.split('.');
      const instanceId = parts[1];
      const instanceProp = parts.slice(2).join('.');
      if (defaultEffects?.effectInstances && instanceId && instanceProp) {
        const instance = defaultEffects.effectInstances.find((inst) => inst.id === instanceId);
        if (instance) {
          baseValue = getNestedValue(instance.config, instanceProp);
        }
      }
    } else if (isEffectsProp) {
      const p = propPath.replace('effects.', '');
      baseValue = defaultEffects ? getNestedValue(defaultEffects, p) : null;
    } else if (propPath.startsWith('scene.')) {
      const p = propPath.replace('scene.', '');
      // For scene properties, we look at the root of defaultEffects or special cases
      if (p === 'assetUrl') {
        baseValue =
          (defaultEffects as { backgroundImage?: string } | undefined)?.backgroundImage || null;
      } else if (p === 'backgroundMediaIndex') {
        baseValue = 0;
      } else if (p === 'backgroundMode') {
        // deprecated — pass through for compat
        baseValue = defaultEffects?.backgroundMode || 'standard';
      } else if (p === 'backgroundOpacity') {
        baseValue = defaultEffects?.backgroundOpacity ?? 1.0;
      } else {
        baseValue = (defaultEffects as EffectsRecord | undefined)?.[p];
      }
    }

    let value: unknown;
    if (propPath.endsWith('.enabled')) {
      // Determine whether this effect has an opacity parameter it can fade.
      // Only fade-capable (opacity-bearing) effects ramp out before disabling;
      // all others hard-cut at the keyframe.
      let canFade = false;
      let fadeKey = '';
      if (propPath.startsWith('fx.')) {
        const parts = propPath.split('.');
        fadeKey = `fx.${parts[1]}`;
        const inst = defaultEffects?.effectInstances?.find((i) => i.id === parts[1]);
        canFade = instanceHasOpacity(inst?.config);
      } else if (propPath.startsWith('effects.')) {
        let key = propPath.substring(8).replace('.enabled', '');
        if (key.startsWith('postProcessing.')) {
          key = key.substring(15);
        }
        fadeKey = key;
        const inst = defaultEffects?.effectInstances?.find((i) => i.type === key);
        canFade = instanceHasOpacity(inst?.config);
      }
      const res = getEffectFadeFactor(
        time,
        propKfs,
        propPath,
        baseValue as boolean | undefined,
        canFade,
      );
      value = res.enabled;
      if (fadeKey && canFade) {
        fadeFactors[fadeKey] = res.fadeFactor;
      }
    } else {
      value = interpolateValue(time, propKfs, propPath, baseValue as KeyframeValue | undefined);
    }

    if (isFxProp) {
      // Instance-aware addressing — pass through directly as fx.<instanceId>.<property>
      // computeFinalEffectsConfig will resolve these to the correct instances
      if (value === null) continue;
      effects[propPath] = value;
    } else if (propPath.startsWith('effects.')) {
      // Legacy: Strip "effects." and also "postProcessing." if it exists
      let key = propPath.substring(8);
      if (key.startsWith('postProcessing.')) {
        key = key.substring(15);
      }
      // Skip null values for effects props: null means "no keyframe owns this time period,
      // fall back to base config". Adding null to overrides would corrupt the instance config.
      if (value === null) continue;
      effects[key] = value;
    } else if (propPath.startsWith('lyrics.')) {
      const key = propPath.replace('lyrics.', '');
      lyrics[key] = value as number | string | boolean;
    } else if (propPath.startsWith('scene.')) {
      const key = propPath.replace('scene.', '');

      scene[key] = value === null && NUMERIC_SCENE_PROPS.includes(key) ? undefined : value;
    }
  }

  if (Object.keys(fadeFactors).length > 0) {
    effects._fadeFactors = fadeFactors;
  }

  // ─── 3. Reset scene properties not in current tick ─────────────────
  for (const key of ALL_SCENE_KEYS) {
    if (scene[key] !== undefined) continue;

    if (key === 'assetUrl') {
      scene[key] =
        (defaultEffects as { backgroundImage?: string } | undefined)?.backgroundImage || null;
    } else if (key === 'backgroundMediaIndex') {
      scene[key] = 0;
    } else if (key === 'backgroundMode') {
      scene[key] = defaultEffects?.backgroundMode || 'standard';
    } else if (key === 'backgroundOpacity') {
      scene[key] = defaultEffects?.backgroundOpacity ?? 1.0;
    } else {
      const defaultVal = (defaultEffects as EffectsRecord | undefined)?.[key];
      scene[key] =
        defaultVal !== undefined
          ? defaultVal
          : NUMERIC_SCENE_PROPS.includes(key)
            ? undefined
            : null;
    }
  }

  return { effects, lyrics, scene, prevScene, transition };
}

/**
 * Scans keyframes to find all referenced effect types.
 */
export function scanKeyframesForEffects(keyframes: Keyframe[]): Set<EffectType> {
  const effects = new Set<EffectType>();

  for (const kf of keyframes) {
    for (const path of Object.keys(kf.properties)) {
      // New format: fx.<instanceId>.<property>
      // Instance-aware paths reference existing instances by their unique ID.
      // We skip these because the instances already exist — they don't need
      // to be created by the migration code. Attempting to infer an effect type
      // from the instance ID is fragile and can produce invalid types.
      if (path.startsWith('fx.')) {
        continue;
      }
      // Legacy format: effects.[postProcessing.]<type>.<property>
      const match = path.match(/^effects\.(?:postProcessing\.)?(\w+)\./);
      if (match) effects.add(match[1] as EffectType);
    }
  }

  return effects;
}

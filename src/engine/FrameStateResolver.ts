/**
 * FrameStateResolver — Unified pure function for computing visual frame state.
 *
 * This is the single source of truth for resolving what a frame looks like at
 * any given time. Both the real-time preview (`keyframeResolver.ts`) and the
 * headless export pipeline (`DecoupledExporter`) route through this function
 * to guarantee 100% visual parity.
 *
 * Architecture:
 *   (keyframes, time, defaults) → resolveVisualFrameState() → ResolvedVisualState
 *
 * The function is pure — it reads no global state and produces no side effects.
 * Callers are responsible for feeding it the correct inputs from their respective
 * data sources (stores for preview, config objects for export).
 */

import {
  computeStateAtTime,
  computeFinalEffectsConfig,
  parseKeyframes,
  type ParsedKeyframes,
} from '@/utils/keyframes';
import { applyActiveRanges } from '@/engine/keyframes/ActiveRangeFilter';
import type { Keyframe } from '@/types/keyframes';
import type { EffectsConfig } from '@/types/effects';
import type { LyricTheme } from '@/types/lyrics';

import type { VideoClip } from '@/types/video-clips';

// ── Public Types ───────────────────────────────────────────

/**
 * Fully resolved visual state for a single frame.
 * This is the contract between the resolver and all renderers.
 */
interface ResolvedVisualState {
  /** Resolved effects overrides (flat key→value map) */
  effectsOverrides: Record<string, unknown>;
  /** Resolved lyrics overrides (flat key→value map) */
  lyricsOverrides: Record<string, number | string | boolean>;
  /** Resolved scene properties */
  scene: Record<string, unknown>;
  /** Previous scene (for cross-transitions) */
  prevScene?: Record<string, unknown>;
  /** Transition state */
  transition: {
    isActive: boolean;
    type: string | null;
    progress: number;
    fromTrackIndex?: number;
    toTrackIndex?: number;
  };
  /** Fully merged EffectsConfig with keyframe overrides applied */
  computedEffectsConfig: EffectsConfig | null;
}

/**
 * Input configuration for the frame state resolver.
 */
interface FrameResolverInput {
  /** Keyframes to resolve against */
  keyframes: Keyframe[];
  /** Current time in seconds */
  time: number;
  /** Default lyric theme (used as base for lyric overrides) */
  defaultTheme?: LyricTheme;
  /** Default effects config (used as base for effects overrides) */
  defaultEffects?: EffectsConfig;
  /** Background media clips */
  videoClips?: VideoClip[];
}

// ── Resolver Cache ─────────────────────────────────────────

/**
 * Optional cache for parsed keyframes.
 * Callers can maintain a cache instance across frames to avoid
 * re-parsing the same keyframe array on every tick.
 */
export class FrameResolverCache {
  private _parsed: ParsedKeyframes | null = null;
  private _keyframesRef: Keyframe[] | null = null;

  /**
   * Get or build parsed keyframes.
   * Returns cached result if the keyframes array reference hasn't changed.
   */
  getParsed(keyframes: Keyframe[]): ParsedKeyframes {
    if (keyframes !== this._keyframesRef || !this._parsed) {
      this._parsed = parseKeyframes(keyframes);
      this._keyframesRef = keyframes;
    }
    return this._parsed;
  }

  /** Invalidate the cache (call on track switch or project load). */
  reset(): void {
    this._parsed = null;
    this._keyframesRef = null;
  }
}

// ── Core Resolver ──────────────────────────────────────────

/**
 * Resolve the complete visual state for a single frame.
 *
 * This is a **pure function** — it produces the same output for the same input,
 * regardless of whether it's called from the preview loop or the export loop.
 *
 * @param input - Keyframes, time, and default configs
 * @param cache - Optional cache for parsed keyframes (improves performance)
 * @returns The fully resolved visual state for the frame
 */
export function resolveVisualFrameState(
  input: FrameResolverInput,
  cache?: FrameResolverCache,
): ResolvedVisualState {
  const { keyframes, time, defaultTheme, defaultEffects, videoClips } = input;

  // Fast path: no keyframes
  if (!keyframes || keyframes.length === 0) {
    let computedEffectsConfig: EffectsConfig | null = defaultEffects || null;
    if (computedEffectsConfig?.effectInstances) {
      computedEffectsConfig = {
        ...computedEffectsConfig,
        effectInstances: applyActiveRanges(computedEffectsConfig.effectInstances, time),
      };
    }

    const scene: Record<string, unknown> = {};
    let prevScene: Record<string, unknown> | undefined = undefined;
    const transition = {
      isActive: false,
      type: null as string | null,
      progress: 0,
      fromTrackIndex: -1,
      toTrackIndex: -1,
    };

    // Inject active clip properties
    const activeClip = videoClips
      ? videoClips.find((c) => time >= c.startTime && time < c.endTime)
      : null;
    if (activeClip) {
      const isVideo =
        /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(activeClip.name) ||
        /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(activeClip.url) ||
        activeClip.url.startsWith('data:video/');

      if (activeClip.url) {
        scene['scene.assetUrl'] = activeClip.url;
        scene['scene.assetName'] = activeClip.name;
        scene['scene.assetType'] = isVideo ? 'video' : 'image';
      }
      if (activeClip.opacity !== undefined) scene['scene.backgroundOpacity'] = activeClip.opacity;
      if (activeClip.brightness !== undefined)
        scene['scene.backgroundBrightness'] = activeClip.brightness;
      if (activeClip.scale !== undefined) scene['scene.backgroundScale'] = activeClip.scale;
      if (activeClip.offsetX !== undefined) scene['scene.backgroundOffsetX'] = activeClip.offsetX;
      if (activeClip.offsetY !== undefined) scene['scene.backgroundOffsetY'] = activeClip.offsetY;

      if (activeClip.transition && activeClip.transition.duration > 0) {
        const timeInClip = time - activeClip.startTime;
        if (timeInClip < activeClip.transition.duration) {
          const progress = timeInClip / activeClip.transition.duration;
          transition.isActive = true;
          transition.type = activeClip.transition.type;
          transition.progress = progress;
          transition.fromTrackIndex = -1;
          transition.toTrackIndex = -1;

          const prevClip = videoClips
            ? [...videoClips]
                .sort((a, b) => b.startTime - a.startTime)
                .find((c) => c.endTime <= activeClip.startTime)
            : null;
          if (prevClip) {
            const prevSceneObj: Record<string, unknown> = {};
            prevSceneObj['scene.assetUrl'] = prevClip.url;
            if (prevClip.opacity !== undefined)
              prevSceneObj['scene.backgroundOpacity'] = prevClip.opacity;
            if (prevClip.brightness !== undefined)
              prevSceneObj['scene.backgroundBrightness'] = prevClip.brightness;
            if (prevClip.scale !== undefined)
              prevSceneObj['scene.backgroundScale'] = prevClip.scale;
            if (prevClip.offsetX !== undefined)
              prevSceneObj['scene.backgroundOffsetX'] = prevClip.offsetX;
            if (prevClip.offsetY !== undefined)
              prevSceneObj['scene.backgroundOffsetY'] = prevClip.offsetY;
            prevScene = prevSceneObj;
          }
        }
      }
    }

    return {
      effectsOverrides: {},
      lyricsOverrides: {},
      scene,
      prevScene,
      transition,
      computedEffectsConfig,
    };
  }

  // Parse keyframes (cached if possible)
  const parsed = cache ? cache.getParsed(keyframes) : parseKeyframes(keyframes);

  // Compute interpolated state at this time
  const stateAtTime = computeStateAtTime(parsed, time, defaultTheme, defaultEffects);
  const { effects, lyrics, scene } = stateAtTime;
  let prevScene: Record<string, unknown> | undefined = stateAtTime.prevScene;
  let transition: ResolvedVisualState['transition'] = stateAtTime.transition;

  // Inject active clip properties and transitions, taking absolute precedence over raw keyframes
  const activeClip = videoClips
    ? videoClips.find((c) => time >= c.startTime && time < c.endTime)
    : null;
  if (activeClip) {
    const isVideo =
      /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(activeClip.name) ||
      /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(activeClip.url) ||
      activeClip.url.startsWith('data:video/');

    if (activeClip.url) {
      scene['scene.assetUrl'] = activeClip.url;
      scene['scene.assetName'] = activeClip.name;
      scene['scene.assetType'] = isVideo ? 'video' : 'image';
    }
    if (activeClip.opacity !== undefined) scene['scene.backgroundOpacity'] = activeClip.opacity;
    if (activeClip.brightness !== undefined)
      scene['scene.backgroundBrightness'] = activeClip.brightness;
    if (activeClip.scale !== undefined) scene['scene.backgroundScale'] = activeClip.scale;
    if (activeClip.offsetX !== undefined) scene['scene.backgroundOffsetX'] = activeClip.offsetX;
    if (activeClip.offsetY !== undefined) scene['scene.backgroundOffsetY'] = activeClip.offsetY;

    if (activeClip.transition && activeClip.transition.duration > 0) {
      const timeInClip = time - activeClip.startTime;
      if (timeInClip < activeClip.transition.duration) {
        const progress = timeInClip / activeClip.transition.duration;
        transition = {
          isActive: true,
          type: activeClip.transition.type,
          progress: progress,
          fromTrackIndex: -1,
          toTrackIndex: -1,
        };

        const prevClip = videoClips
          ? [...videoClips]
              .sort((a, b) => b.startTime - a.startTime)
              .find((c) => c.endTime <= activeClip.startTime)
          : null;
        if (prevClip) {
          const prevSceneObj: Record<string, unknown> = {};
          prevSceneObj['scene.assetUrl'] = prevClip.url;
          if (prevClip.opacity !== undefined)
            prevSceneObj['scene.backgroundOpacity'] = prevClip.opacity;
          if (prevClip.brightness !== undefined)
            prevSceneObj['scene.backgroundBrightness'] = prevClip.brightness;
          if (prevClip.scale !== undefined) prevSceneObj['scene.backgroundScale'] = prevClip.scale;
          if (prevClip.offsetX !== undefined)
            prevSceneObj['scene.backgroundOffsetX'] = prevClip.offsetX;
          if (prevClip.offsetY !== undefined)
            prevSceneObj['scene.backgroundOffsetY'] = prevClip.offsetY;
          prevScene = prevSceneObj;
        }
      }
    }
  }

  // Merge keyframe overrides with base effects config to produce
  // the final EffectsConfig that renderers consume.
  let computedEffectsConfig: EffectsConfig | null = null;

  if (defaultEffects) {
    const merged = computeFinalEffectsConfig(defaultEffects, scene, effects);
    if (merged?.effectInstances) {
      computedEffectsConfig = {
        ...merged,
        effectInstances: applyActiveRanges(merged.effectInstances, time),
      };
    } else {
      computedEffectsConfig = merged || null;
    }
  }

  return {
    effectsOverrides: effects,
    lyricsOverrides: lyrics,
    scene,
    prevScene,
    transition,
    computedEffectsConfig,
  };
}

/**
 * keyframeResolver — Reactive keyframe resolution for the preview pipeline.
 *
 * Reads from timeStore (currentTime) and projectStore (selected track config)
 * to compute the resolved frame state via the Unified FrameStateResolver.
 * Results are written to keyframeStore, making the render loop a pure
 * "read & draw" operation.
 *
 * This module runs outside of React — it's initialized once at app startup
 * and cleaned up on teardown.
 *
 * Architecture:
 *   timeStore.currentTime ──┐
 *                           ├── FrameStateResolver → keyframeStore (resolved state)
 *   projectStore.tracks ────┘
 */

import { timeStore } from '@/engine/stores/timeStore';
import { keyframeStore, type KeyframeState } from '@/engine/stores/keyframeStore';
import { exportStore } from '@/engine/stores/exportStore';
import { projectStore } from '@/stores/projectStore';
import { resolveVisualFrameState, FrameResolverCache } from '@/engine/FrameStateResolver';
import { shallowEqual } from '@/utils';
import type { EffectsConfig } from '@/types/effects';
import type { VideoClip } from '@/types/video-clips';
import { createLogger } from '@/utils/logger';

const logger = createLogger({ enabled: false, prefix: 'KeyframeResolver' });

// ── Cached resolver state ──
const _cache = new FrameResolverCache();
let lastDefaultEffects: EffectsConfig | null | undefined = null;

/**
 * Tick the resolver manually (called by EngineLoop).
 * This reads the latest state from all stores, resolves the current frame
 * via the unified FrameStateResolver, and writes diffs to keyframeStore.
 */
export function tickResolver(): void {
  const tState = timeStore.getState();
  const eState = exportStore.getState();
  const pState = projectStore.getState();
  const kState = keyframeStore.getState();
  const isExport = tState.mode === 'export';

  // Get keyframes and defaults from the correct source
  const selectedTrack = pState.getSelectedTrack();
  const keyframes = isExport ? eState.keyframeSchedule : selectedTrack?.keyframes || [];
  const defaultTheme = isExport
    ? eState.defaultTheme || selectedTrack?.lyricsTheme
    : selectedTrack?.lyricsTheme;
  const defaultEffects = isExport
    ? eState.defaultEffectsConfig || selectedTrack?.effectsConfig
    : selectedTrack?.effectsConfig;
  const videoClips = isExport
    ? (eState as typeof eState & { videoClips?: VideoClip[] }).videoClips ||
      selectedTrack?.videoClips ||
      []
    : selectedTrack?.videoClips || [];

  // ── Resolve via unified pipeline ──
  const resolved = resolveVisualFrameState(
    {
      keyframes: keyframes || [],
      time: tState.currentTime,
      defaultTheme,
      defaultEffects,
      videoClips: videoClips || [],
    },
    _cache,
  );

  // ── Write diffs to keyframeStore ──

  // 1. Transition
  if (
    kState.transition.isActive !== resolved.transition.isActive ||
    kState.transition.type !== resolved.transition.type ||
    kState.transition.progress !== resolved.transition.progress
  ) {
    keyframeStore
      .getState()
      .updateTransition(resolved.transition as Partial<KeyframeState['transition']>);
  }

  // 2. Lyrics
  if (!shallowEqual(kState.lyrics.overrides, resolved.lyricsOverrides)) {
    keyframeStore.getState().updateLyrics(resolved.lyricsOverrides);
  }

  // 3. Scene
  const stripScenePrefix = (sceneObj: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(sceneObj)) {
      const cleanKey = key.startsWith('scene.') ? key.substring(6) : key;
      result[cleanKey] = val;
    }
    return result;
  };

  const cleanScene = stripScenePrefix(resolved.scene);
  let sceneChanged = false;
  for (const [key, val] of Object.entries(cleanScene)) {
    if ((kState.scene as Record<string, unknown>)[key] !== val) {
      sceneChanged = true;
      break;
    }
  }
  if (sceneChanged) {
    keyframeStore.getState().updateScene(cleanScene as Partial<KeyframeState['scene']>);
  }

  // 3b. PrevScene
  if (resolved.prevScene) {
    const cleanPrevScene = stripScenePrefix(resolved.prevScene);
    let prevChanged = false;
    for (const [key, val] of Object.entries(cleanPrevScene)) {
      if ((kState.scenePrev as Record<string, unknown>)[key] !== val) {
        prevChanged = true;
        break;
      }
    }
    if (prevChanged) {
      keyframeStore
        .getState()
        .updateScenePrev(cleanPrevScene as Partial<KeyframeState['scenePrev']>);
    }
  } else if (kState.scenePrev.assetUrl !== null) {
    keyframeStore.getState().updateScenePrev({
      assetUrl: null,
      backgroundMode: null,
      backgroundOpacity: undefined,
    });
  }

  // 4. Effects
  const effectsChanged = !shallowEqual(kState.effects.overrides, resolved.effectsOverrides);
  const defaultEffectsRefChanged = defaultEffects !== lastDefaultEffects;
  lastDefaultEffects = defaultEffects;

  if (effectsChanged || defaultEffectsRefChanged || sceneChanged || isExport) {
    keyframeStore
      .getState()
      .updateEffects(resolved.effectsOverrides, resolved.computedEffectsConfig);
  }
}

/**
 * Reset the resolver caches (call on track switch or project load).
 */
export function resetResolver(): void {
  _cache.reset();
  lastDefaultEffects = null;
  logger.debug('Resolver caches reset');
}

/**
 * Initialize the resolver's subscription to track changes.
 * Resets caches when the selected track changes.
 */
export function initResolver(): () => void {
  let prevTrackId: string | null = null;

  const unsub = projectStore.subscribe((state) => {
    if (state.selectedTrackId !== prevTrackId) {
      prevTrackId = state.selectedTrackId;
      resetResolver();
    }
  });

  logger.debug('Resolver initialized');
  return unsub;
}

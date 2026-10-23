/**
 * SlideshowManager — Thin wrapper around SlideshowStateMachine for
 * the headless GPU export pipeline. It handles the export-schedule
 * fallback logic and delegates all transition/timing logic to the
 * shared state machine.
 */

import { EffectsConfig, SlideshowConfig, SlideshowMediaItem } from '@/types/effects';
import { exportStore } from '@/engine/stores/exportStore';
import { SlideshowStateMachine, type TickSignals } from '@/engine/SlideshowStateMachine';
import { isVideoUrl } from '@/engine/gpu/TextureLoader';
import { timeStore } from '@/engine/stores/timeStore';
import { keyframeStore } from '@/engine/stores/keyframeStore';

/** Optional video playback state passed in by the caller each frame. */
interface VideoSignals {
  /** Natural duration of the current primary video (seconds). */
  videoDuration?: number;
  /** Whether the current primary video has finished playing. */
  videoEnded?: boolean;
  /** Current playback position of the primary video (seconds). */
  videoCurrentTime?: number;
}

export interface SlideshowState {
  currentUrl: string | null;
  currentType: 'image' | 'video';
  nextUrl: string | null;
  nextType: 'image' | 'video';
  mixRatio: number; // 0.0 means purely currentUrl, 1.0 means purely nextUrl
  /** True when the primary video URL changed this tick (consumer should seek video to 0). */
  videoRestart?: boolean;
  /** The concrete transition type active this tick (e.g. 'slideLeft', 'crossfade'). */
  activeTransition?: string;
  /** Per-slot visual state for transitions that use positioning (slide) or scaling (zoom). */
  currentVisuals?: { opacity: number; offsetX: number; offsetY: number; scale: number };
  nextVisuals?: { opacity: number; offsetX: number; offsetY: number; scale: number };
}

export class SlideshowManager {
  private machine = new SlideshowStateMachine();
  private lastItemFingerprint: string = '';
  /** Track the previous primary URL so we can detect changes. */
  private _prevPrimaryUrl: string | null = null;

  constructor() {}

  public updateAndGetState(
    delta: number,
    scene: Record<string, unknown> | null,
    defaultBgUrl: string | null,
    effectsConfig?: EffectsConfig | null,
    videoSignals?: VideoSignals,
  ): SlideshowState {
    // Only advance if playing
    if (!timeStore.getState().isPlaying) {
      delta = 0;
    }

    // Determine the base item pool
    let items: SlideshowMediaItem[] = [];

    const slideshowConfig = effectsConfig?.slideshow;

    const sceneAssetUrl = (scene?.['scene.assetUrl'] || scene?.assetUrl || null) as string | null;
    const sceneAssetName = (scene?.['scene.assetName'] || scene?.assetName || '') as string;
    const sceneAssetType = (scene?.['scene.assetType'] || scene?.assetType || null) as
      | SlideshowMediaItem['type']
      | null;

    if (slideshowConfig && slideshowConfig.items && slideshowConfig.items.length > 0) {
      items = slideshowConfig.items.filter((item) => !item.failed);
    } else if (effectsConfig?.video?.enabled && effectsConfig?.video?.url) {
      // Handle standalone video background
      items = [
        {
          id: 'video-bg',
          url: effectsConfig.video.url,
          type: 'video',
        },
      ];
    } else if (sceneAssetUrl) {
      items = [
        {
          id: 'scene-url',
          url: sceneAssetUrl,
          type: sceneAssetType || (isVideoUrl(sceneAssetUrl, sceneAssetName) ? 'video' : 'image'),
        },
      ];
    } else if (defaultBgUrl) {
      items = [
        {
          id: 'default-url',
          url: defaultBgUrl,
          type: isVideoUrl(defaultBgUrl) ? 'video' : 'image',
        },
      ];
    }

    if (items.length === 0) {
      return {
        currentUrl: null,
        currentType: 'image',
        nextUrl: null,
        nextType: 'image',
        mixRatio: 0,
      };
    }

    const mode = slideshowConfig?.mode ?? 'slideshow';

    // ── Static mode: always show item 0 ──
    if (mode === 'static' || items.length === 1) {
      let url = items[0].url;
      let type = items[0].type;
      // Export mode: override from schedule
      if (timeStore.getState().mode === 'export') {
        const es = exportStore.getState();
        const schedule = es.backgroundSchedule;
        if (schedule.length > 0) {
          url = es.defaultBackgroundUrl ?? url;
          for (const entry of schedule) {
            if (timeStore.getState().currentTime >= entry.startTime) url = entry.url;
          }
        }
        type = isVideoUrl(url) ? 'video' : 'image';
      }
      return {
        currentUrl: url,
        currentType: type,
        nextUrl: null,
        nextType: 'image',
        mixRatio: 0,
      };
    }

    // ── Keyframe mode: read from keyframeState ──
    if (mode === 'keyframe') {
      const idx = Math.floor(
        Math.max(
          0,
          Math.min(keyframeStore.getState().scene.backgroundMediaIndex ?? 0, items.length - 1),
        ),
      );
      const t = keyframeStore.getState().transition;
      if (t.isActive) {
        const prevIdx = Math.floor(
          Math.max(
            0,
            Math.min(
              keyframeStore.getState().scenePrev.backgroundMediaIndex ?? 0,
              items.length - 1,
            ),
          ),
        );
        const prevUrl = items[prevIdx]?.url ?? null;
        const curUrl = items[idx]?.url ?? null;
        return {
          currentUrl: prevUrl,
          currentType: prevUrl ? (isVideoUrl(prevUrl) ? 'video' : 'image') : 'image',
          nextUrl: curUrl,
          nextType: curUrl ? (isVideoUrl(curUrl) ? 'video' : 'image') : 'image',
          mixRatio: t.progress,
        };
      }
      const curUrl = items[idx]?.url ?? null;
      return {
        currentUrl: curUrl,
        currentType: curUrl ? (isVideoUrl(curUrl) ? 'video' : 'image') : 'image',
        nextUrl: null,
        nextType: 'image',
        mixRatio: 0,
      };
    }

    // ── Slideshow mode: export schedule fallback then state machine ──
    if (timeStore.getState().mode === 'export') {
      let url: string | null = items[0].url;
      const es = exportStore.getState();
      const schedule = es.backgroundSchedule;
      if (schedule.length > 0) {
        url = es.defaultBackgroundUrl ?? url;
        for (const entry of schedule) {
          if (timeStore.getState().currentTime >= entry.startTime) url = entry.url;
        }
      }
      return {
        currentUrl: url,
        currentType: url ? (isVideoUrl(url) ? 'video' : 'image') : 'image',
        nextUrl: null,
        nextType: 'image',
        mixRatio: 0,
      };
    }

    // Build a config for the state machine (use the real config or a default)
    const cfg: SlideshowConfig = slideshowConfig || {
      items: [],
      mode: 'slideshow',
      order: 'sequential',
      timingMode: 'static',
      staticDuration: 5,
      randomDurationMin: 3,
      randomDurationMax: 10,
      transition: 'crossfade',
      transitionDuration: 1,
    };

    // Re-init the state machine if items changed (include URLs to detect replacements)
    const fingerprint = items.map((i) => `${i.id}:${i.url ?? ''}`).join('|');
    if (fingerprint !== this.lastItemFingerprint) {
      this.lastItemFingerprint = fingerprint;
      this.machine.init(items.length, cfg);
    }

    // Convert caller-provided video signals to TickSignals
    const tickSignals: TickSignals | undefined = videoSignals
      ? {
          videoDuration: videoSignals.videoDuration,
          videoEnded: videoSignals.videoEnded,
          videoCurrentTime: videoSignals.videoCurrentTime,
        }
      : undefined;

    // Tick the state machine
    const frame = this.machine.tick(delta, cfg, tickSignals);

    // Determine the primary URL after this tick
    const primaryUrl = items[frame.currentIndex]?.url ?? null;
    const primaryType = items[frame.currentIndex]?.type ?? 'image';

    // Detect whether the primary video URL changed (for restarting video playback)
    let videoRestart = false;
    if (primaryUrl !== this._prevPrimaryUrl) {
      // URL changed — if the new primary is a video, the consumer should seek it to 0
      if (primaryType === 'video') {
        videoRestart = true;
      }
      this._prevPrimaryUrl = primaryUrl;
    }

    if (frame.transitioning) {
      return {
        currentUrl: primaryUrl,
        currentType: primaryType,
        nextUrl: items[frame.nextIndex]?.url ?? null,
        nextType: items[frame.nextIndex]?.type ?? 'image',
        mixRatio: frame.progress,
        videoRestart,
        activeTransition: frame.activeTransition,
        currentVisuals: frame.current,
        nextVisuals: frame.next,
      };
    } else {
      return {
        currentUrl: primaryUrl,
        currentType: primaryType,
        nextUrl: null,
        nextType: 'image',
        mixRatio: 0,
        videoRestart,
      };
    }
  }

  public reset(): void {
    this.machine.reset();
    this.lastItemFingerprint = '';
    this._prevPrimaryUrl = null;
  }
}

'use client';

/**
 * SlideshowBackgroundPlane — React/R3F component for rendering
 * slideshow backgrounds with smooth transitions.
 *
 * Delegates ALL timing and visual computation to the shared
 * SlideshowStateMachine. Uses a **double-buffer** slot approach:
 * two stable React nodes (A / B) swap roles as "current" and "next"
 * instead of re-keying, which eliminates the flicker caused by
 * React unmounting/remounting on key changes.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { type TexturedPlaneProps } from './TexturedPlane';

import type { SlideshowConfig, SlideshowMediaItem } from '@/types/effects/background';
import type { VideoClip } from '@/types/video-clips';

import { SlideshowDriver } from '@/engine/slideshow/SlideshowDriver';
import type { TickSignals } from '@/engine/SlideshowStateMachine';
import { computeVisuals, type ConcreteTransition } from '@/engine/slideshow/core';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { timeStore } from '@/engine/stores/timeStore';

import { SlideSlot } from './SlideSlot';

// ─── Cache Warmer to prevent R3F / useTexture Suspense ──────
// Loads imperatively via TextureLoader instead of the throwing useTexture()
// hook: a dead/revoked blob: URL (stale IndexedDB project data) rejects the
// load with "Could not load blob:...", which — from a bare useTexture() with
// no Suspense/error boundary around it — would crash the whole R3F tree.
// Swallowing the error here degrades a missing image to a no-op warm-up
// instead of taking down the entire background.
function ImageCacheWarmer({ url }: { url: string }) {
  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        // Warm the drei useTexture cache so the real slide load is instant,
        // then release our own copy — the cache keeps the decoded image.
        if (cancelled) {
          tex.dispose();
          return;
        }
        try {
          useTexture.preload(url);
        } catch {
          /* preload is best-effort */
        }
        tex.dispose();
      },
      undefined,
      () => {
        // Dead/revoked blob URL or a network failure — ignore. The slide
        // renderer handles the missing texture (or its own Suspense boundary
        // catches it); the warmer must never throw.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);
  return null;
}

// ─── Timeline Video Synchronisation Helper ──────────────────
function syncTimelineVideo(
  video: HTMLVideoElement,
  clip: VideoClip,
  currentTime: number,
  isPlaying: boolean,
) {
  const localTime = currentTime - clip.startTime;
  let sourceTime = 0;

  if (clip.behavior === 'speed') {
    const clipDuration = clip.endTime - clip.startTime;
    const sourceDur = clip.outPoint - clip.inPoint;
    const speed = sourceDur / clipDuration;
    sourceTime = clip.inPoint + localTime * speed;

    if (video.playbackRate !== speed) {
      video.playbackRate = speed;
    }
    if (video.loop) {
      video.loop = false;
    }
  } else if (clip.behavior === 'loop') {
    const sourceDur = clip.outPoint - clip.inPoint;
    sourceTime = clip.inPoint + ((localTime * clip.speed) % sourceDur);

    if (video.playbackRate !== clip.speed) {
      video.playbackRate = clip.speed;
    }
    if (!video.loop) {
      video.loop = true;
    }
  } else {
    // Default to loop behavior
    const sourceDur = clip.outPoint - clip.inPoint;
    sourceTime =
      sourceDur > 0 ? clip.inPoint + ((localTime * clip.speed) % sourceDur) : clip.inPoint;

    if (video.playbackRate !== clip.speed) {
      video.playbackRate = clip.speed;
    }
    if (!video.loop) {
      video.loop = true;
    }
  }

  const drift = Math.abs(video.currentTime - sourceTime);
  if (drift > 0.15) {
    video.currentTime = sourceTime;
  }

  if (isPlaying && video.paused) {
    video.play().catch(() => {});
  } else if (!isPlaying && !video.paused) {
    video.pause();
  }
}

/* ────────────────────────────────────────────────────────────────
 * Main Slideshow Component
 *
 * Uses a **double-buffer** approach: two stable React slot nodes
 * (A / B) that swap roles as "current" and "next". The slots
 * never change keys (no mount/unmount), and we control their
 * Z-order by setting their `z` prop: the active "current" slot
 * gets the higher Z so it's always in front, preventing the
 * flicker that occurred when React re-keyed slots.
 * ──────────────────────────────────────────────────────────────── */

type SlideshowBackgroundPlaneProps = Omit<TexturedPlaneProps, 'texture'> & {
  config: SlideshowConfig;
  isPlaying?: boolean;
  brightness?: number;
  opacityRef?: React.RefObject<number>;
  isTiling?: boolean;
  videoClips?: VideoClip[];
};

export function SlideshowBackgroundPlane({
  config,
  isPlaying = true,
  brightness = 1.0,
  opacityRef,
  videoClips = [],
  ...props
}: SlideshowBackgroundPlaneProps): React.ReactElement | null {
  const items = useMemo(() => config.items.filter((item) => !item.failed), [config.items]);

  // ─── State machine (single source of truth) ───────────────────
  const driverRef = useRef(new SlideshowDriver());

  // ─── Imperative refs for per-frame animation (no setState!) ───
  // Slot A refs
  const slotAOpacityRef = useRef(1.0);
  const slotAOffsetXRef = useRef(0);
  const slotAOffsetYRef = useRef(0);
  const slotAScaleRef = useRef(1.0);
  // Slot B refs
  const slotBOpacityRef = useRef(0.0);
  const slotBOffsetXRef = useRef(0);
  const slotBOffsetYRef = useRef(0);
  const slotBScaleRef = useRef(1.0);

  // Track which physical slot (A or B) currently plays the "current" role.
  // This alternates each time a transition completes. By not changing keys,
  // we avoid React unmount/remount flicker.
  const slotRoleRef = useRef<'a-is-current' | 'b-is-current'>('a-is-current');

  // Video signals for the state machine
  const videoEndedRef = useRef(false);
  const videoDurationRef = useRef<number | undefined>(undefined);
  const slotVideosRef = useRef<{ a: HTMLVideoElement | null; b: HTMLVideoElement | null }>({
    a: null,
    b: null,
  });

  // Displayed item indices — changed via React state only when the
  // state machine reports `indicesChanged`.
  const [slotItems, setSlotItems] = useState<{
    a: SlideshowMediaItem | null;
    b: SlideshowMediaItem | null;
  }>({
    a: items[0] ?? null,
    b: items.length > 1 ? items[1] : null,
  });

  // Track config ref so useFrame reads latest values
  const configRef = useRef(config);
  configRef.current = config;

  // ─── Stable item fingerprint (includes URLs to detect replacements) ──
  const itemsFingerprint = useMemo(
    () => items.map((i) => `${i.id}:${i.url}:${i.type}`).join('|'),
    [items],
  );

  // ─── Config fingerprint (detects transition/timing/order changes) ──
  const configFingerprint = useMemo(
    () =>
      `${config.mode}|${config.transition}|${config.transitionDuration}|${config.timingMode}|${config.staticDuration}|${config.order}`,
    [
      config.mode,
      config.transition,
      config.transitionDuration,
      config.timingMode,
      config.staticDuration,
      config.order,
    ],
  );

  // Re-init state machine when item set OR config changes
  useEffect(() => {
    const driver = driverRef.current;
    const cfg = configRef.current;
    driver.init(items, cfg);
    slotRoleRef.current = 'a-is-current';
    videoEndedRef.current = false;
    videoDurationRef.current = undefined;
    slotVideosRef.current = { a: null, b: null };

    const nextIdx = items.length > 1 ? 1 : 0;
    setSlotItems({
      a: items[0] ?? null,
      b: items[nextIdx] ?? null,
    });

    // Reset visual refs
    slotAOpacityRef.current = 1.0;
    slotAOffsetXRef.current = 0;
    slotAOffsetYRef.current = 0;
    slotAScaleRef.current = 1.0;
    slotBOpacityRef.current = 0.0;
    slotBOffsetXRef.current = 0;
    slotBOffsetYRef.current = 0;
    slotBScaleRef.current = 1.0;

    // Preload all images
    items.forEach((item) => {
      if (item.type === 'image') {
        useTexture.preload(item.url);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsFingerprint, configFingerprint]);

  // ─── Video signal callbacks (stable) ──────────────────────────
  const handleVideoEnded = useCallback(() => {
    videoEndedRef.current = true;
  }, []);

  const handleVideoDuration = useCallback((dur: number) => {
    videoDurationRef.current = dur;
  }, []);

  // ─── Per-frame update ─────────────────────────────────────────
  useFrame((_state, delta) => {
    const globalOpacity = opacityRef?.current ?? 1.0;

    // ── Video Clips Timeline override ──
    if (videoClips && videoClips.length > 0) {
      const currentTime = timeStore.getState().currentTime;
      const activeClip = videoClips.find(
        (c) => currentTime >= c.startTime && currentTime < c.endTime,
      );

      if (activeClip) {
        const isVideo = (url: string) =>
          /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(url) || url.startsWith('data:video/');

        const activeItem = {
          id: activeClip.id,
          url: activeClip.url,
          type: isVideo(activeClip.url) ? ('video' as const) : ('image' as const),
          label: activeClip.name,
        };

        const t = keyframeStore.getState().transition;

        const prevClip = [...videoClips]
          .sort((a, b) => a.startTime - b.startTime)
          .reverse()
          .find((c) => c.endTime <= activeClip.startTime);

        const isTransitionActive = t.isActive && t.fromTrackIndex === -1 && prevClip;

        if (isTransitionActive && prevClip) {
          const progress = t.progress;

          const prevItem = {
            id: prevClip.id,
            url: prevClip.url,
            type: isVideo(prevClip.url) ? ('video' as const) : ('image' as const),
            label: prevClip.name,
          };

          let transType: ConcreteTransition = 'crossfade';
          const tTypeStr = t.type as string;
          if (tTypeStr === 'fade-black' || tTypeStr === 'fadeBlack') transType = 'fadeBlack';
          else if (tTypeStr === 'wipe-left' || tTypeStr === 'slideLeft') transType = 'slideLeft';
          else if (tTypeStr === 'wipe-right' || tTypeStr === 'slideRight') transType = 'slideRight';
          else if (tTypeStr === 'zoom-in' || tTypeStr === 'zoom-out' || tTypeStr === 'zoom')
            transType = 'zoom';
          else if (tTypeStr === 'cut') transType = 'cut';

          const visuals = computeVisuals(transType, progress);

          const bMatchesPrev = slotItems.b?.id === prevClip.id || slotItems.b?.url === prevClip.url;

          let outgoingRef, incomingRef;
          let outgoingOX, outgoingOY, outgoingS;
          let incomingOX, incomingOY, incomingS;

          if (bMatchesPrev) {
            outgoingRef = slotBOpacityRef;
            outgoingOX = slotBOffsetXRef;
            outgoingOY = slotBOffsetYRef;
            outgoingS = slotBScaleRef;

            incomingRef = slotAOpacityRef;
            incomingOX = slotAOffsetXRef;
            incomingOY = slotAOffsetYRef;
            incomingS = slotAScaleRef;

            if (slotItems.b?.id !== prevItem.id || slotItems.a?.id !== activeItem.id) {
              setSlotItems({ a: activeItem, b: prevItem });
            }
            slotRoleRef.current = 'b-is-current';
          } else {
            outgoingRef = slotAOpacityRef;
            outgoingOX = slotAOffsetXRef;
            outgoingOY = slotAOffsetYRef;
            outgoingS = slotAScaleRef;

            incomingRef = slotBOpacityRef;
            incomingOX = slotBOffsetXRef;
            incomingOY = slotBOffsetYRef;
            incomingS = slotBScaleRef;

            if (slotItems.a?.id !== prevItem.id || slotItems.b?.id !== activeItem.id) {
              setSlotItems({ a: prevItem, b: activeItem });
            }
            slotRoleRef.current = 'a-is-current';
          }

          outgoingRef.current = visuals.current.opacity * (prevClip.opacity ?? 1.0) * globalOpacity;
          outgoingOX.current = (prevClip.offsetX ?? 0) + visuals.current.offsetX;
          outgoingOY.current = (prevClip.offsetY ?? 0) + visuals.current.offsetY;
          outgoingS.current = (prevClip.scale ?? 1.0) * visuals.current.scale;

          incomingRef.current = visuals.next.opacity * (activeClip.opacity ?? 1.0) * globalOpacity;
          incomingOX.current = (activeClip.offsetX ?? 0) + visuals.next.offsetX;
          incomingOY.current = (activeClip.offsetY ?? 0) + visuals.next.offsetY;
          incomingS.current = (activeClip.scale ?? 1.0) * visuals.next.scale;

          const activeVideo = bMatchesPrev ? slotVideosRef.current.a : slotVideosRef.current.b;
          const prevVideo = bMatchesPrev ? slotVideosRef.current.b : slotVideosRef.current.a;

          if (activeVideo) {
            syncTimelineVideo(activeVideo, activeClip, currentTime, isPlaying);
          }
          if (prevVideo) {
            syncTimelineVideo(prevVideo, prevClip, currentTime, isPlaying);
          }
        } else {
          const aMatchesActive =
            slotItems.a?.id === activeClip.id || slotItems.a?.url === activeClip.url;
          const bMatchesActive =
            slotItems.b?.id === activeClip.id || slotItems.b?.url === activeClip.url;

          let role: 'a-is-current' | 'b-is-current' = 'a-is-current';
          if (bMatchesActive) {
            role = 'b-is-current';
          } else if (aMatchesActive) {
            role = 'a-is-current';
          } else {
            role = slotRoleRef.current;
          }
          slotRoleRef.current = role;

          const currentRef = role === 'a-is-current' ? slotAOpacityRef : slotBOpacityRef;
          const currentOX = role === 'a-is-current' ? slotAOffsetXRef : slotBOffsetXRef;
          const currentOY = role === 'a-is-current' ? slotAOffsetYRef : slotBOffsetYRef;
          const currentS = role === 'a-is-current' ? slotAScaleRef : slotBScaleRef;

          const otherRef = role === 'a-is-current' ? slotBOpacityRef : slotAOpacityRef;

          currentRef.current = (activeClip.opacity ?? 1.0) * globalOpacity;
          currentOX.current = activeClip.offsetX ?? 0;
          currentOY.current = activeClip.offsetY ?? 0;
          currentS.current = activeClip.scale ?? 1.0;

          otherRef.current = 0;

          if (role === 'a-is-current') {
            if (
              slotItems.a?.id !== activeItem.id ||
              slotItems.a?.url !== activeItem.url ||
              slotItems.b !== null
            ) {
              setSlotItems({ a: activeItem, b: null });
            }
          } else {
            if (
              slotItems.b?.id !== activeItem.id ||
              slotItems.b?.url !== activeItem.url ||
              slotItems.a !== null
            ) {
              setSlotItems({ a: null, b: activeItem });
            }
          }

          const video = slotVideosRef.current.a || slotVideosRef.current.b;
          if (video) {
            syncTimelineVideo(video, activeClip, currentTime, isPlaying);
          }
        }
      } else {
        if (slotItems.a !== null || slotItems.b !== null) {
          setSlotItems({ a: null, b: null });
        }
      }
      return;
    }

    if (items.length === 0) return;

    // ── Stale slot guard: clear slots referencing items no longer in the list ──
    const itemUrls = new Set(items.map((i) => i.url));
    const aIsStale = slotItems.a && !itemUrls.has(slotItems.a.url);
    const bIsStale = slotItems.b && !itemUrls.has(slotItems.b.url);
    if (aIsStale || bIsStale) {
      setSlotItems({
        a: aIsStale ? (items[0] ?? null) : slotItems.a,
        b: bIsStale ? (items.length > 1 ? items[1] : null) : slotItems.b,
      });
      // Reset visuals to prevent old transition state from showing
      if (aIsStale) {
        slotAOpacityRef.current = slotRoleRef.current === 'a-is-current' ? globalOpacity : 0;
        slotAOffsetXRef.current = 0;
        slotAOffsetYRef.current = 0;
        slotAScaleRef.current = 1.0;
      }
      if (bIsStale) {
        slotBOpacityRef.current = slotRoleRef.current === 'b-is-current' ? globalOpacity : 0;
        slotBOffsetXRef.current = 0;
        slotBOffsetYRef.current = 0;
        slotBScaleRef.current = 1.0;
      }
      return;
    }

    const mode = configRef.current.mode ?? 'slideshow';

    // ── Static mode: always show item 0, no transitions ─────────
    if (mode === 'static' || items.length === 1) {
      // Ensure slot A shows item 0 — compare by id+url to avoid reference churn
      const target = items[0];
      if (slotItems.a?.id !== target?.id || slotItems.a?.url !== target?.url) {
        setSlotItems({ a: target ?? null, b: null });
      }
      slotAOpacityRef.current = globalOpacity;
      slotBOpacityRef.current = 0;
      return;
    }

    // ── Keyframe mode: read backgroundMediaIndex from keyframeState ──
    if (mode === 'keyframe') {
      const idx = Math.floor(
        Math.max(
          0,
          Math.min(keyframeStore.getState().scene.backgroundMediaIndex ?? 0, items.length - 1),
        ),
      );
      const targetItem = items[idx];
      const t = keyframeStore.getState().transition;

      if (t.isActive) {
        // During a transition, show both outgoing and incoming items
        const prevIdx = Math.floor(
          Math.max(
            0,
            Math.min(
              keyframeStore.getState().scenePrev.backgroundMediaIndex ?? 0,
              items.length - 1,
            ),
          ),
        );
        const prevItem = items[prevIdx];
        const progress = t.progress;

        // The outgoing (prev) item must STAY in its current slot to avoid
        // recreating the video element (which would restart playback).
        // The incoming (target) item goes into the OTHER slot.
        const role = slotRoleRef.current;
        const outgoingRef = role === 'a-is-current' ? slotAOpacityRef : slotBOpacityRef;
        const incomingRef = role === 'a-is-current' ? slotBOpacityRef : slotAOpacityRef;

        // Outgoing fades out, incoming fades in
        outgoingRef.current = (1.0 - progress) * globalOpacity;
        incomingRef.current = progress * globalOpacity;

        // Keep outgoing in its current slot; put incoming in the other slot
        if (role === 'a-is-current') {
          // A = outgoing (prevItem stays), B = incoming (targetItem)
          if (slotItems.a?.id !== prevItem?.id || slotItems.b?.id !== targetItem?.id) {
            setSlotItems({ a: prevItem ?? null, b: targetItem ?? null });
          }
        } else {
          // B = outgoing (prevItem stays), A = incoming (targetItem)
          if (slotItems.b?.id !== prevItem?.id || slotItems.a?.id !== targetItem?.id) {
            setSlotItems({ a: targetItem ?? null, b: prevItem ?? null });
          }
        }

        // When transition completes, swap roles so the incoming slot
        // becomes "current" for the next idle period
        if (progress >= 0.99) {
          slotRoleRef.current = role === 'a-is-current' ? 'b-is-current' : 'a-is-current';
        }
      } else {
        // No transition active — show only the current item in the "current" slot
        const role = slotRoleRef.current;
        if (role === 'a-is-current') {
          if (slotItems.a?.id !== targetItem?.id || slotItems.a?.url !== targetItem?.url) {
            setSlotItems({ a: targetItem ?? null, b: null });
          }
          slotAOpacityRef.current = globalOpacity;
          slotBOpacityRef.current = 0;
        } else {
          if (slotItems.b?.id !== targetItem?.id || slotItems.b?.url !== targetItem?.url) {
            setSlotItems({ a: null, b: targetItem ?? null });
          }
          slotAOpacityRef.current = 0;
          slotBOpacityRef.current = globalOpacity;
        }
      }
      return;
    }

    // ── Slideshow mode: use SlideshowDriver ────────────────
    if (!isPlaying) return;

    const cfg = configRef.current;
    const driver = driverRef.current;

    // Build signals
    const aIsCurrentVal = slotRoleRef.current === 'a-is-current';
    const activeVideo = aIsCurrentVal ? slotVideosRef.current.a : slotVideosRef.current.b;
    const signals: TickSignals = {
      videoEnded: videoEndedRef.current,
      videoDuration:
        activeVideo && isFinite(activeVideo.duration)
          ? activeVideo.duration
          : videoDurationRef.current,
      videoCurrentTime: activeVideo ? activeVideo.currentTime : undefined,
    };

    // Tick the driver (uses delta-based timing for preview)
    const renderState = driver.tick(delta, cfg, signals);

    // Clear video-ended signal after consumption
    if (videoEndedRef.current) {
      videoEndedRef.current = false;
    }

    // Determine which physical slot maps to current/next
    const aIsCurrent = slotRoleRef.current === 'a-is-current';
    const currentOpRef = aIsCurrent ? slotAOpacityRef : slotBOpacityRef;
    const currentOXRef = aIsCurrent ? slotAOffsetXRef : slotBOffsetXRef;
    const currentOYRef = aIsCurrent ? slotAOffsetYRef : slotBOffsetYRef;
    const currentSRef = aIsCurrent ? slotAScaleRef : slotBScaleRef;
    const nextOpRef = aIsCurrent ? slotBOpacityRef : slotAOpacityRef;
    const nextOXRef = aIsCurrent ? slotBOffsetXRef : slotAOffsetXRef;
    const nextOYRef = aIsCurrent ? slotBOffsetYRef : slotAOffsetYRef;
    const nextSRef = aIsCurrent ? slotBScaleRef : slotAScaleRef;

    // Write visuals from driver to refs
    currentOpRef.current = renderState.slot1.visuals.opacity * globalOpacity;
    currentOXRef.current = renderState.slot1.visuals.offsetX;
    currentOYRef.current = renderState.slot1.visuals.offsetY;
    currentSRef.current = renderState.slot1.visuals.scale;

    nextOpRef.current = renderState.slot2.visuals.opacity * globalOpacity;
    nextOXRef.current = renderState.slot2.visuals.offsetX;
    nextOYRef.current = renderState.slot2.visuals.offsetY;
    nextSRef.current = renderState.slot2.visuals.scale;

    // When slot URLs change, update React state to swap item assignments
    if (renderState.slot2Cleared) {
      // Transition just COMPLETED — swap slot roles.
      const newAIsCurrent = !aIsCurrent;
      slotRoleRef.current = newAIsCurrent ? 'a-is-current' : 'b-is-current';

      // Re-write visuals with the NEW mapping to prevent 1-frame flash
      const newCurOpRef = newAIsCurrent ? slotAOpacityRef : slotBOpacityRef;
      const newCurOXRef = newAIsCurrent ? slotAOffsetXRef : slotBOffsetXRef;
      const newCurOYRef = newAIsCurrent ? slotAOffsetYRef : slotBOffsetYRef;
      const newCurSRef = newAIsCurrent ? slotAScaleRef : slotBScaleRef;
      const newNxtOpRef = newAIsCurrent ? slotBOpacityRef : slotAOpacityRef;
      const newNxtOXRef = newAIsCurrent ? slotBOffsetXRef : slotAOffsetXRef;
      const newNxtOYRef = newAIsCurrent ? slotBOffsetYRef : slotAOffsetYRef;
      const newNxtSRef = newAIsCurrent ? slotBScaleRef : slotAScaleRef;

      newCurOpRef.current = globalOpacity;
      newCurOXRef.current = 0;
      newCurOYRef.current = 0;
      newCurSRef.current = 1.0;
      newNxtOpRef.current = 0;
      newNxtOXRef.current = 0;
      newNxtOYRef.current = 0;
      newNxtSRef.current = 1.0;

      // Reset the video duration for the new current item
      videoDurationRef.current = undefined;

      // Find the next item from the driver's render state
      const newNextItem = renderState.slot2.url
        ? (items.find((i) => i.url === renderState.slot2.url) ?? null)
        : (items.find((i) => i.url !== renderState.slot1.url) ?? null);
      if (aIsCurrent) {
        // B is now current, A becomes next
        setSlotItems((prev) => ({ ...prev, a: newNextItem }));
      } else {
        // A is now current, B becomes next
        setSlotItems((prev) => ({ ...prev, b: newNextItem }));
      }
    } else if (renderState.slot2.urlChanged && renderState.transitioning) {
      // Transition just STARTED — assign the next item to the "next" slot
      const nextItem = items.find((i) => i.url === renderState.slot2.url) ?? null;
      if (aIsCurrent) {
        setSlotItems((prev) => ({ ...prev, b: nextItem }));
      } else {
        setSlotItems((prev) => ({ ...prev, a: nextItem }));
      }
    }
  });

  if (items.length === 0) return null;

  const slideProps = {
    fit: props.fit ?? ('cover' as const),
    brightness,
    scale: props.scale,
    offsetX: props.offsetX,
    offsetY: props.offsetY,
  };

  // Determine Z-order: the "current" slot renders in front.
  // After a transition completes and roles swap, the new current
  // is automatically in front — no flicker.
  const aIsCurrent = slotRoleRef.current === 'a-is-current';
  const slotAZ = aIsCurrent ? -4.4 : -4.5;
  const slotBZ = aIsCurrent ? -4.5 : -4.4;

  const slotsShouldLoop = true;

  return (
    <group>
      {/* Hidden cache warmer to prevent R3F / useTexture suspense during transitions */}
      <group visible={false}>
        {items.map((item) => {
          if (item.type === 'image') {
            return <ImageCacheWarmer key={item.id} url={item.url} />;
          }
          return null;
        })}
        {videoClips?.map((clip) => {
          const isVideo =
            /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(clip.url) ||
            /\.(mp4|webm|mov|avi|mkv|ogg|ogv)(\?|$)/i.test(clip.name) ||
            clip.url.startsWith('data:video/');
          if (!isVideo) {
            return <ImageCacheWarmer key={clip.id} url={clip.url} />;
          }
          return null;
        })}
      </group>

      {/* Slot A — stable key, never unmounts */}
      <SlideSlot
        key="slot-a"
        item={slotItems.a}
        opacityRef={slotAOpacityRef}
        offsetXRef={slotAOffsetXRef}
        offsetYRef={slotAOffsetYRef}
        scaleRef={slotAScaleRef}
        z={slotAZ}
        onVideoEnded={aIsCurrent ? handleVideoEnded : undefined}
        onVideoDuration={aIsCurrent ? handleVideoDuration : undefined}
        onVideoElement={(el) => {
          slotVideosRef.current.a = el;
        }}
        videoLoop={slotsShouldLoop}
        {...slideProps}
        isTiling={props.isTiling}
        transformRef={props.transformRef}
      />

      {/* Slot B — stable key, never unmounts */}
      <SlideSlot
        key="slot-b"
        item={slotItems.b}
        opacityRef={slotBOpacityRef}
        offsetXRef={slotBOffsetXRef}
        offsetYRef={slotBOffsetYRef}
        scaleRef={slotBScaleRef}
        z={slotBZ}
        onVideoEnded={!aIsCurrent ? handleVideoEnded : undefined}
        onVideoDuration={!aIsCurrent ? handleVideoDuration : undefined}
        onVideoElement={(el) => {
          slotVideosRef.current.b = el;
        }}
        videoLoop={slotsShouldLoop}
        {...slideProps}
        isTiling={props.isTiling}
        transformRef={props.transformRef}
      />
    </group>
  );
}

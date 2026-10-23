'use client';

import React, { useRef, useEffect, useState, useCallback, memo } from 'react';
import { Plus, Settings2, Trash2, Repeat, Film, Scissors, type LucideIcon } from 'lucide-react';
import type { BackgroundClip } from '@/types/video-clips';
import type { Keyframe, SceneTransitionType } from '@/types/keyframes';
import type { EffectsConfig } from '@/types/effects';
import { useKeyframeSelection, usePlaylistState, type Track } from '@/contexts';
import { isVideoUrl } from '@/engine/gpu/TextureLoader';
import { TimelineMediaCapsule } from './TimelineMediaCapsule';
import { toast } from '@/utils/toast';
import { projectStore } from '@/stores/projectStore';
import { pauseAutoSave, resumeAutoSave } from '@/stores';
import { useExportUIStore } from '@/engine/stores/exportUIStore';
import { ASPECT_RATIOS } from '@/types/export';
import styles from './KeyframeTrack.module.css';

/**
 * Alignment-preview media element.
 *
 * Mirrors the offset/scale/fit math used by the real background renderer
 * (see TexturedPlane.tsx): the offset is measured in units of the media's
 * own *tile* dimensions (not the preview box), so panning reveals the full
 * image instead of clipping at the box edge.
 *
 * The renderer computes a base tile size from the fit mode relative to the
 * viewport, applies scale, then shifts by `-offset * tileSize`. We reproduce
 * that here by sizing the element to the computed tile (as a % of the box)
 * and translating it in tile-relative units.
 */
const AlignmentPreviewMedia = memo(function AlignmentPreviewMedia({
  url,
  name,
  isVideo,
  fit,
  scale,
  offsetX,
  offsetY,
  boxAspect,
}: {
  url: string;
  name?: string;
  isVideo: boolean;
  fit: string;
  scale: number;
  offsetX: number;
  offsetY: number;
  /** width / height of the preview box (matches the viewport aspect) */
  boxAspect: number;
}) {
  // Natural media aspect (w/h). Default 16:9 until the asset reports its size.
  const [mediaAspect, setMediaAspect] = useState(16 / 9);

  // ── Base tile size as a fraction of the preview box, per fit mode ──
  // Fractions of the box: 1.0 == full box width/height.
  let tileWFrac = 1;
  let tileHFrac = 1;
  switch (fit) {
    case 'contain':
      if (mediaAspect > boxAspect) {
        tileWFrac = 1;
        tileHFrac = boxAspect / mediaAspect;
      } else {
        tileHFrac = 1;
        tileWFrac = mediaAspect / boxAspect;
      }
      break;
    case 'stretch':
      tileWFrac = 1;
      tileHFrac = 1;
      break;
    case 'original':
    case 'manual':
      // One tile = image at natural size, height-fitted to the box.
      tileHFrac = 1;
      tileWFrac = mediaAspect / boxAspect;
      break;
    case 'cover':
    default:
      if (mediaAspect > boxAspect) {
        tileHFrac = 1;
        tileWFrac = mediaAspect / boxAspect;
      } else {
        tileWFrac = 1;
        tileHFrac = boxAspect / mediaAspect;
      }
      break;
  }

  const s = scale === 0 ? 0.001 : scale;
  const widthPct = tileWFrac * s * 100;
  const heightPct = tileHFrac * s * 100;

  // Renderer shifts by `-offset * tileSize`; here tileSize is the element's
  // own scaled dimension, so translate() percentages (relative to the element)
  // reproduce that shift exactly. Positive offset moves content the same
  // direction the renderer does (shiftX = -offset * tileW).
  const translateXPct = -offsetX * 100;
  const translateYPct = -offsetY * 100;

  const commonStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: `${widthPct}%`,
    height: `${heightPct}%`,
    // Center the element, then apply the offset shift in tile-relative units.
    transform: `translate(-50%, -50%) translate(${translateXPct}%, ${translateYPct}%)`,
    transformOrigin: 'center center',
    // stretch fills the tile box; every other mode fills it too since the
    // tile box already encodes the aspect. Use 'fill' so the element's box
    // (which we sized to the tile) is exactly what's shown.
    objectFit: 'fill' as React.CSSProperties['objectFit'],
    zIndex: 1,
  };

  if (isVideo) {
    return (
      <video
        src={url}
        muted
        playsInline
        style={commonStyle}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setMediaAspect(v.videoWidth / v.videoHeight);
        }}
      />
    );
  }
  return (
    <img
      src={url}
      alt={name || 'Preview'}
      draggable={false}
      style={commonStyle}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight)
          setMediaAspect(img.naturalWidth / img.naturalHeight);
      }}
    />
  );
});

type TimelineDragWindow = Window & { __threnic_timeline_dragging?: boolean };

interface BackgroundLaneProps {
  clips: BackgroundClip[];
  setClips?: React.Dispatch<React.SetStateAction<BackgroundClip[]>>;
  zoom: number;
  viewOffsetRef: React.MutableRefObject<number>;
  height: number;
  width: number;
  isVisible?: boolean;
  trackId?: string;
  keyframes?: Keyframe[];
  updateTrackKeyframes?: (id: string, keyframes: Keyframe[]) => void;
  topPadding?: number;
}

export const BackgroundLane = memo(function BackgroundLane({
  clips = [],
  setClips,
  zoom,
  viewOffsetRef,
  height,
  isVisible = true,
  trackId,
  keyframes = [],
  updateTrackKeyframes,
  topPadding = 0,
}: BackgroundLaneProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { selectedClipId, setSelectedClipId } = useKeyframeSelection();
  const { selectedTrackId, tracks } = usePlaylistState();

  // Slideshow Import Modal State
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editClips, setEditClips] = useState<BackgroundClip[]>([]);
  const [selectedEditClipId, setSelectedEditClipId] = useState<string | null>(null);
  const previewRatio = useExportUIStore((s) => s.previewRatio);
  const exportAspect = useExportUIStore((s) => s.exportAspect);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [slideshowInsertTime, setSlideshowInsertTime] = useState(0);
  const [slideDuration, setSlideDuration] = useState(5.0);
  const [transType, setTransType] = useState<SceneTransitionType>('crossfade');
  const [transDuration, setTransDuration] = useState(1.0);
  const [limitVideoDuration, setLimitVideoDuration] = useState(false);
  const [loopUntilEnd, setLoopUntilEnd] = useState(true);
  const [randomizeOrder, setRandomizeOrder] = useState(false);
  const [importOffsetX, setImportOffsetX] = useState(0.0);
  const [importOffsetY, setImportOffsetY] = useState(0.0);
  const [importFit, setImportFit] = useState<'cover' | 'contain' | 'stretch' | 'original'>('cover');
  const [importScale, setImportScale] = useState(1.0);
  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    time: number;
    clipId: string | null;
  } | null>(null);
  const lastTapRef = useRef<{ time: number; id: string }>({ time: 0, id: '' });
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [changeMediaClipId, setChangeMediaClipId] = useState<string | null>(null);

  // Drag State
  type DragType = 'clip-move' | 'clip-trim-start' | 'clip-trim-end';
  const [dragState, setDragState] = useState<{
    type: DragType;
    id: string;
    startX: number;
    originalStart: number;
    originalEndOrDuration: number;
  } | null>(null);

  // Sync drag state to global window flag to prevent auto-saves/store jumps
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (dragState) {
      (window as TimelineDragWindow).__threnic_timeline_dragging = true;
    } else {
      (window as TimelineDragWindow).__threnic_timeline_dragging = false;
    }
    return () => {
      if (typeof window !== 'undefined') {
        (window as TimelineDragWindow).__threnic_timeline_dragging = false;
      }
    };
  }, [dragState]);

  // Sync scroll offset
  useEffect(() => {
    if (!isVisible) return;
    const handleOffset = (e: CustomEvent) => {
      if (contentRef.current) {
        contentRef.current.style.transform = `translate3d(${-e.detail}px, 0, 0)`;
      }
    };
    if (contentRef.current) {
      contentRef.current.style.transform = `translate3d(${-viewOffsetRef.current}px, 0, 0)`;
    }
    window.addEventListener('threnicViewOffset', handleOffset as EventListener);
    return () => {
      window.removeEventListener('threnicViewOffset', handleOffset as EventListener);
    };
  }, [isVisible, viewOffsetRef]);

  // Click outside to close menus
  useEffect(() => {
    const handleClose = (e: PointerEvent) => {
      if ((e.target as Element).closest('[data-context-menu]')) {
        return;
      }
      setContextMenu(null);
    };
    window.addEventListener('pointerdown', handleClose, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', handleClose, { capture: true });
    };
  }, []);

  // Keep context menu on screen
  useEffect(() => {
    if (!contextMenu) {
      setMenuPos(null);
      return;
    }

    const estimatedWidth = 190;
    const estimatedHeight = clips.length > 0 ? 270 : 160;
    const targetX = Math.max(10, Math.min(contextMenu.x, window.innerWidth - estimatedWidth - 12));
    const targetY = Math.max(
      10,
      Math.min(contextMenu.y, window.innerHeight - estimatedHeight - 12),
    );

    setMenuPos({ x: targetX, y: targetY });

    const rafId = requestAnimationFrame(() => {
      if (menuRef.current) {
        const rect = menuRef.current.getBoundingClientRect();
        let exactX = contextMenu.x;
        let exactY = contextMenu.y;
        if (exactX + rect.width > window.innerWidth) {
          exactX = Math.max(10, window.innerWidth - rect.width - 12);
        }
        if (exactY + rect.height > window.innerHeight) {
          exactY = Math.max(10, window.innerHeight - rect.height - 12);
        }
        setMenuPos({ x: exactX, y: exactY });
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [contextMenu, clips.length]);

  const handlePointerDown = (
    e: React.PointerEvent,
    id: string,
    type: DragType,
    originalStart: number,
    originalEndOrDuration: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    // Synchronously lock dragging state and pause autosave to prevent main-thread lag spikes
    if (typeof window !== 'undefined') {
      (window as TimelineDragWindow).__threnic_timeline_dragging = true;
    }
    pauseAutoSave();

    setSelectedClipId(id);

    setDragState({
      type,
      id,
      startX: e.clientX,
      originalStart,
      originalEndOrDuration,
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragState || !setClips) return;
    e.preventDefault();

    const deltaX = e.clientX - dragState.startX;
    const deltaTime = deltaX / zoom;
    const minDuration = 0.5;

    setClips((prev: BackgroundClip[]) => {
      return prev.map((clip) => {
        if (clip.id !== dragState.id) return clip;

        let newStart = clip.startTime;
        let newEnd = clip.endTime;

        if (dragState.type === 'clip-move') {
          const duration = dragState.originalEndOrDuration - dragState.originalStart;
          newStart = Math.max(0, dragState.originalStart + deltaTime);
          newEnd = newStart + duration;
        } else if (dragState.type === 'clip-trim-start') {
          newStart = Math.max(
            0,
            Math.min(
              dragState.originalStart + deltaTime,
              dragState.originalEndOrDuration - minDuration,
            ),
          );
        } else if (dragState.type === 'clip-trim-end') {
          newEnd = Math.max(
            dragState.originalStart + minDuration,
            dragState.originalEndOrDuration + deltaTime,
          );
        }

        return { ...clip, startTime: newStart, endTime: newEnd };
      });
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragState) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    if (typeof window !== 'undefined') {
      (window as TimelineDragWindow).__threnic_timeline_dragging = false;
    }
    resumeAutoSave();
    setDragState(null);
    syncKeyframes(clips);
  };

  // Sync keyframes with clips for backward compatible fallback
  const syncKeyframes = useCallback(
    (newClips: BackgroundClip[]) => {
      if (!trackId || !updateTrackKeyframes) return;

      // Filter out existing background-lane keyframes
      const nonBgKeyframes = keyframes.filter((kf) => kf.lane !== 'background');

      // Create a background-lane keyframe for each clip at its startTime
      const bgKeyframes = newClips.map((clip) => {
        const kf: Keyframe = {
          id: crypto.randomUUID(),
          time: clip.startTime,
          interpolation: 'linear',
          properties: {
            'scene.assetUrl': clip.url,
            ...(clip.transition ? { transition: clip.transition } : {}),
          },
          lane: 'background',
        };
        return kf;
      });

      const combined = [...nonBgKeyframes, ...bgKeyframes].sort((a, b) => a.time - b.time);
      updateTrackKeyframes(trackId, combined);
    },
    [trackId, keyframes, updateTrackKeyframes],
  );

  // Helper to load video metadata for true duration (with robust 1000ms safety timeout)
  const getMediaDuration = (url: string): Promise<number> => {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(10);
        }
      }, 1000);

      video.onloadedmetadata = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(video.duration);
        }
      };

      video.onerror = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(10);
        }
      };

      video.src = url;
    });
  };

  // Overlap resolution logic for deterministic track layout
  const resolveOverlaps = (
    newClip: BackgroundClip,
    prevClips: BackgroundClip[],
  ): BackgroundClip[] => {
    const result: BackgroundClip[] = [];
    for (const c of prevClips) {
      if (c.id === newClip.id) continue;

      // 1. c is fully inside newClip -> deleted
      if (c.startTime >= newClip.startTime && c.endTime <= newClip.endTime) {
        continue;
      }
      // 2. c overlaps left of newClip -> truncate c's end
      if (
        c.startTime < newClip.startTime &&
        c.endTime > newClip.startTime &&
        c.endTime <= newClip.endTime
      ) {
        result.push({ ...c, endTime: newClip.startTime });
        continue;
      }
      // 3. c overlaps right of newClip -> truncate c's start
      if (
        c.startTime >= newClip.startTime &&
        c.startTime < newClip.endTime &&
        c.endTime > newClip.endTime
      ) {
        result.push({ ...c, startTime: newClip.endTime });
        continue;
      }
      // 4. c fully encompasses newClip -> split c into two parts
      if (c.startTime < newClip.startTime && c.endTime > newClip.endTime) {
        result.push({ ...c, endTime: newClip.startTime });
        result.push({
          ...c,
          id: crypto.randomUUID(),
          startTime: newClip.endTime,
        });
        continue;
      }
      // 5. no overlap
      result.push(c);
    }
    result.push(newClip);
    return result.sort((a, b) => a.startTime - b.startTime);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!setClips) return;
    const fileList = Array.from(e.target.files || []);
    if (fileList.length === 0) return;

    if (fileList.length > 1) {
      setPendingFiles(fileList);
      let insertTime = contextMenu ? contextMenu.time : 0;
      if (changeMediaClipId) {
        const targetClip = clips.find((c) => c.id === changeMediaClipId);
        if (targetClip) {
          insertTime = targetClip.startTime;
        }
      }
      setSlideshowInsertTime(insertTime);
      setImportModalOpen(true);
      e.target.value = '';
      return;
    }

    const file = fileList[0];
    const url = URL.createObjectURL(file);
    const name = file.name;

    const isVideo = file.type.startsWith('video/') || isVideoUrl(url, name);
    let duration = 600; // static default for images
    if (isVideo) {
      duration = await getMediaDuration(url);
    }

    if (changeMediaClipId) {
      const updated = clips.map((c) => {
        if (c.id !== changeMediaClipId) return c;
        return {
          ...c,
          url,
          name,
          sourceDuration: duration,
          outPoint: duration,
        };
      });
      setClips(updated);
      syncKeyframes(updated);
      setChangeMediaClipId(null);
    } else {
      // Insert at contextMenu position if available, otherwise at time 0
      const insertTime = contextMenu?.time ?? 0;
      const activeTrack = tracks.find((t) => t.id === selectedTrackId);
      const songDuration = activeTrack?.duration || 300;
      // Images fill to song end; videos use their source duration (capped at song remaining)
      const durationSec = isVideo
        ? Math.min(duration, songDuration - insertTime)
        : songDuration - insertTime;

      const newClip: BackgroundClip = {
        id: crypto.randomUUID(),
        name,
        url,
        startTime: insertTime,
        endTime: insertTime + durationSec,
        inPoint: 0,
        outPoint: isVideo ? duration : durationSec,
        sourceDuration: duration,
        speed: 1.0,
        behavior: 'loop',
        opacity: 1.0,
        scale: 1.0,
        brightness: 1.0,
        offsetX: 0,
        offsetY: 0,
        ...(clips.length > 0 ? { transition: { type: 'crossfade', duration: 1.0 } } : {}),
      };

      const updated = resolveOverlaps(newClip, clips);
      setClips(updated);
      syncKeyframes(updated);
    }

    e.target.value = '';
  };

  const handleImportSlideshow = async () => {
    if (!setClips || pendingFiles.length === 0) return;

    let currentTime = slideshowInsertTime;
    let currentClips = changeMediaClipId
      ? clips.filter((c) => c.id !== changeMediaClipId)
      : [...clips];

    const activeTrack = tracks.find((t) => t.id === selectedTrackId);
    const songDuration = activeTrack?.duration || 300;

    let hasImportedAny = false;
    let index = 0;

    const filesToProcess = [...pendingFiles];
    if (randomizeOrder) {
      filesToProcess.sort(() => Math.random() - 0.5);
    }

    while (currentTime < songDuration) {
      const file = filesToProcess[index % filesToProcess.length];
      const url = URL.createObjectURL(file);
      const name = file.name;

      let sourceDuration = 600; // default for images
      const isVideo = file.type.startsWith('video/') || isVideoUrl('', file.name);

      if (isVideo) {
        sourceDuration = await getMediaDuration(url);
      }

      let durationSec = isVideo && !limitVideoDuration ? sourceDuration : slideDuration;

      // If this video is followed by another clip in the slideshow (or we are looping),
      // we shorten its timeline duration by transDuration so the transition starts early
      // and plays smoothly to the very last frame of the video!
      const isFollowedByAnother =
        (!loopUntilEnd && index < filesToProcess.length - 1) || loopUntilEnd;
      if (
        isVideo &&
        !limitVideoDuration &&
        isFollowedByAnother &&
        transType !== 'cut' &&
        transDuration > 0
      ) {
        durationSec = Math.max(1.0, sourceDuration - transDuration);
      }

      if (loopUntilEnd) {
        durationSec = Math.min(durationSec, songDuration - currentTime);
      }

      if (durationSec < 0.1) {
        break;
      }

      const newClip: BackgroundClip = {
        id: crypto.randomUUID(),
        name,
        url,
        startTime: currentTime,
        endTime: currentTime + durationSec,
        inPoint: 0,
        outPoint: isVideo && !limitVideoDuration ? sourceDuration : durationSec,
        sourceDuration,
        speed: 1.0,
        behavior: 'loop',
        opacity: 1.0,
        scale: importScale,
        brightness: 1.0,
        offsetX: importOffsetX,
        offsetY: importOffsetY,
        fit: importFit,
        ...((hasImportedAny || currentClips.length > 0) && transType !== 'cut'
          ? { transition: { type: transType, duration: transDuration } }
          : {}),
      };

      currentClips = resolveOverlaps(newClip, currentClips);
      currentTime += durationSec;
      hasImportedAny = true;

      index++;
      if (!loopUntilEnd && index >= filesToProcess.length) {
        break;
      }
    }

    setClips(currentClips);
    syncKeyframes(currentClips);
    setImportModalOpen(false);
    setPendingFiles([]);
    setChangeMediaClipId(null);
    toast.success(
      `Imported slideshow (${currentClips.length - (changeMediaClipId ? clips.length - 1 : clips.length)} clips placed)`,
    );
  };

  const handleSplitClip = (clipId: string, splitTime: number) => {
    if (!setClips) return;
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    if (splitTime <= clip.startTime || splitTime >= clip.endTime) return;

    const elapsed = splitTime - clip.startTime;
    const splitSourceTime = clip.inPoint + elapsed * clip.speed;

    const clip1: BackgroundClip = {
      ...clip,
      endTime: splitTime,
      outPoint: splitSourceTime,
    };

    const clip2: BackgroundClip = {
      ...clip,
      id: crypto.randomUUID(),
      startTime: splitTime,
      inPoint: splitSourceTime,
      transition: {
        type: 'crossfade',
        duration: 1.0,
      },
    };

    const updated = clips.filter((c) => c.id !== clipId);
    updated.push(clip1);
    updated.push(clip2);
    updated.sort((a, b) => a.startTime - b.startTime);

    setClips(updated);
    setSelectedClipId(clip2.id);
    syncKeyframes(updated);
  };

  const handleDeleteClip = (clipId: string) => {
    if (!setClips) return;
    const updated = clips.filter((c) => c.id !== clipId);
    setClips(updated);
    syncKeyframes(updated);
    if (selectedClipId === clipId) {
      setSelectedClipId(null);
    }
  };

  const handleDeleteAllClips = () => {
    if (!setClips) return;
    setClips([]);
    syncKeyframes([]);
    if (selectedClipId) {
      setSelectedClipId(null);
    }
    toast.success('All backgrounds deleted');
  };

  const handleOpenEditModal = useCallback(() => {
    if (clips.length === 0) return;

    // Clone clips into local working copies
    setEditClips(clips.map((c) => ({ ...c })));
    setSelectedEditClipId(clips[0]?.id || null);

    // Pre-populate bulk transition controls from first clip with a transition
    const firstWithTrans = clips.find((c) => c.transition) || clips[0];
    if (firstWithTrans.transition) {
      setTransType(firstWithTrans.transition.type as SceneTransitionType);
      setTransDuration(firstWithTrans.transition.duration);
    } else {
      setTransType('crossfade');
      setTransDuration(1.0);
    }
    setEditMode(true);
    setImportModalOpen(true);
  }, [clips]);

  // Update a single clip property in the working copies
  const updateEditClip = useCallback((clipId: string, updates: Partial<BackgroundClip>) => {
    setEditClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, ...updates } : c)));
  }, []);

  const handleEditApply = useCallback(() => {
    if (!setClips || editClips.length === 0) return;

    // Apply bulk transition settings, then merge per-clip overrides
    const updated = editClips.map((clip, idx) => {
      const newClip = { ...clip };
      if (idx > 0 && transType !== 'cut') {
        newClip.transition = { type: transType, duration: transDuration };
      } else if (idx > 0 && transType === 'cut') {
        delete newClip.transition;
      }
      return newClip;
    });

    setClips(updated);
    syncKeyframes(updated);
    setImportModalOpen(false);
    setEditMode(false);
    setEditClips([]);
    setSelectedEditClipId(null);
    toast.success(`Updated ${updated.length} background clip${updated.length !== 1 ? 's' : ''}`);
  }, [editClips, setClips, transType, transDuration, syncKeyframes]);

  const handleApplyBackgroundToAll = useCallback(() => {
    if (!trackId) return;

    const state = projectStore.getState();
    const currentTrack = state.tracks.find((t) => t.id === trackId);
    if (!currentTrack) return;

    // Get background keyframes of the current track
    const currentBgKeyframes = (currentTrack.keyframes || []).filter(
      (kf) => kf.lane === 'background',
    );
    const currentVideoClips = currentTrack.videoClips || [];

    const updatedTracks = state.tracks.map((t) => {
      if (t.id === trackId) return t;

      // Keep non-background keyframes of target track, and append copy of current track's background keyframes
      const targetNonBgKeyframes = (t.keyframes || []).filter((kf) => kf.lane !== 'background');
      const clonedBgKeyframes = currentBgKeyframes.map((kf) => ({
        ...kf,
        id: crypto.randomUUID(), // assign unique IDs to cloned keyframes
      }));
      const nextKeyframes = [...targetNonBgKeyframes, ...clonedBgKeyframes].sort(
        (a, b) => a.time - b.time,
      );

      // Copy background settings from currentTrack's effectsConfig
      const currentFx = (currentTrack.effectsConfig || {}) as Partial<EffectsConfig>;
      const targetFx = (t.effectsConfig || {}) as Partial<EffectsConfig>;

      const nextEffectsConfig = {
        ...targetFx,
        backgroundFit: currentFx.backgroundFit,
        backgroundScale: currentFx.backgroundScale,
        backgroundOffsetX: currentFx.backgroundOffsetX,
        backgroundOffsetY: currentFx.backgroundOffsetY,
        backgroundTileOffsetX: currentFx.backgroundTileOffsetX,
        backgroundTileOffsetY: currentFx.backgroundTileOffsetY,
        backgroundOpacity: currentFx.backgroundOpacity,
        backgroundBrightness: currentFx.backgroundBrightness,
        backgroundContrast: currentFx.backgroundContrast,
        backgroundColor: currentFx.backgroundColor,
        backgroundMode: currentFx.backgroundMode,
        slideshow: currentFx.slideshow
          ? JSON.parse(JSON.stringify(currentFx.slideshow))
          : undefined,
      };

      return {
        ...t,
        backgroundImage: currentTrack.backgroundImage,
        backgroundImageFilePath: currentTrack.backgroundImageFilePath,
        videoClips: JSON.parse(JSON.stringify(currentVideoClips)),
        effectsConfig: nextEffectsConfig as EffectsConfig,
        keyframes: nextKeyframes,
      } as Track;
    });

    projectStore.setState({ tracks: updatedTracks as Track[] });
    toast.success('Background settings, clips, and transitions copied to all videos');
  }, [trackId]);

  const triggerContextMenuAt = useCallback(
    (clientX: number, clientY: number, currentTarget: HTMLElement) => {
      if (!contentRef.current) return;

      const containerRect = currentTarget.getBoundingClientRect();
      const clickX = clientX - containerRect.left + viewOffsetRef.current;
      const clickTime = clickX / zoom;

      const clickedClip = clips.find((c) => clickTime >= c.startTime && clickTime < c.endTime);

      setContextMenu({
        x: clientX,
        y: clientY,
        time: clickTime,
        clipId: clickedClip ? clickedClip.id : null,
      });
    },
    [clips, zoom, viewOffsetRef],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      triggerContextMenuAt(e.clientX, e.clientY, e.currentTarget as HTMLElement);
    },
    [triggerContextMenuAt],
  );

  const effectiveHeight = height - topPadding;

  return (
    <div
      className={styles.kfTrackContainer}
      style={{ height, width: '100%' }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onTouchStart={(e) => {
        const now = Date.now();
        const DOUBLE_PRESS_DELAY = 300;
        if (now - lastTapRef.current.time < DOUBLE_PRESS_DELAY) {
          e.preventDefault();
          const touch = e.touches[0] || e.changedTouches[0];
          if (touch) {
            triggerContextMenuAt(touch.clientX, touch.clientY, e.currentTarget as HTMLElement);
          }
        }
        lastTapRef.current = { time: now, id: 'background-track' };
      }}
      onContextMenu={handleContextMenu}
    >
      {/* Hidden file input picker */}
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*,video/*,.mp4,.webm,.mov,.avi,.mkv,.ogg,.ogv,.jpg,.jpeg,.png,.webp,.gif"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Glassmorphic Context Menu UI */}
      {contextMenu && menuPos && (
        <div
          ref={menuRef}
          data-context-menu
          style={{
            position: 'fixed',
            left: menuPos.x,
            top: menuPos.y,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '10px',
            padding: '6px',
            minWidth: '180px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)',
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.clipId ? (
            <>
              <ContextMenuItem
                onClick={() => {
                  setChangeMediaClipId(contextMenu.clipId);
                  fileInputRef.current?.click();
                  setContextMenu(null);
                }}
                icon={Film}
                label="Change Media..."
              />
              <ContextMenuItem
                onClick={() => {
                  handleSplitClip(contextMenu.clipId!, contextMenu.time);
                  setContextMenu(null);
                }}
                icon={Scissors}
                label="Split Background"
              />
              <div
                style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '4px 0' }}
              />
              <ContextMenuItem
                onClick={() => {
                  handleDeleteClip(contextMenu.clipId!);
                  setContextMenu(null);
                }}
                icon={Trash2}
                label="Delete Background"
              />
              <ContextMenuItem
                onClick={() => {
                  handleDeleteAllClips();
                  setContextMenu(null);
                }}
                icon={Trash2}
                label="Delete All Backgrounds"
              />
            </>
          ) : (
            <ContextMenuItem
              onClick={() => {
                setChangeMediaClipId(null);
                fileInputRef.current?.click();
                setContextMenu(null);
              }}
              icon={Plus}
              label="Insert Background..."
            />
          )}
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '4px 0' }} />
          <ContextMenuItem
            onClick={() => {
              handleApplyBackgroundToAll();
              setContextMenu(null);
            }}
            icon={Repeat}
            label="Apply BG to All Videos"
          />
          {clips.length > 0 && (
            <>
              <div
                style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '4px 0' }}
              />
              <ContextMenuItem
                onClick={() => {
                  handleOpenEditModal();
                  setContextMenu(null);
                }}
                icon={Settings2}
                label="Edit All Backgrounds..."
              />
              {!contextMenu.clipId && (
                <ContextMenuItem
                  onClick={() => {
                    handleDeleteAllClips();
                    setContextMenu(null);
                  }}
                  icon={Trash2}
                  label="Delete All Backgrounds"
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Main scrolling track elements */}
      <div
        ref={contentRef}
        style={{ height: '100%', position: 'absolute', willChange: 'transform' }}
      >
        {clips.map((clip) => {
          const left = clip.startTime * zoom;
          const widthVal = (clip.endTime - clip.startTime) * zoom;
          const isSelected = selectedClipId === clip.id;

          return (
            <div
              key={clip.id}
              className={styles.clipBlock}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedClipId(clip.id);
              }}
              style={{
                position: 'absolute',
                left,
                width: Math.max(20, widthVal),
                top: topPadding + 4,
                height: effectiveHeight - 8,
                background: isSelected
                  ? 'linear-gradient(135deg, rgba(6, 182, 212, 0.25) 0%, rgba(6, 182, 212, 0.15) 100%)'
                  : 'linear-gradient(135deg, rgba(59, 130, 246, 0.12) 0%, rgba(59, 130, 246, 0.05) 100%)',
                border: isSelected ? '1.5px solid #06b6d4' : '1px solid rgba(59, 130, 246, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 6px',
                zIndex: 10,
                boxShadow: isSelected ? '0 0 10px rgba(6, 182, 212, 0.3)' : 'none',
                pointerEvents: 'auto',
                borderRadius: 6,
              }}
            >
              {/* Media Capsule preview and title */}
              <div
                style={{
                  flex: 1,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'grab',
                  overflow: 'hidden',
                  userSelect: 'none',
                }}
                onPointerDown={(e) =>
                  handlePointerDown(e, clip.id, 'clip-move', clip.startTime, clip.endTime)
                }
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 6 }}>
                  <div
                    style={{
                      width: 2,
                      height: 2,
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.3)',
                    }}
                  />
                  <div
                    style={{
                      width: 2,
                      height: 2,
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.3)',
                    }}
                  />
                </div>

                <TimelineMediaCapsule
                  url={clip.url}
                  name={clip.name}
                  behavior={clip.behavior}
                  thumbnailOnly={widthVal < 140}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    boxShadow: 'none',
                    padding: 0,
                    margin: 0,
                  }}
                />
              </div>

              {/* LEFT TRIM HANDLE */}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  cursor: 'ew-resize',
                  zIndex: 15,
                  background: 'rgba(255,255,255,0.05)',
                  borderTopLeftRadius: 5,
                  borderBottomLeftRadius: 5,
                  touchAction: 'none',
                }}
                onPointerDown={(e) =>
                  handlePointerDown(e, clip.id, 'clip-trim-start', clip.startTime, clip.endTime)
                }
                onClick={(e) => e.stopPropagation()}
              />

              {/* RIGHT TRIM HANDLE */}
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  cursor: 'ew-resize',
                  zIndex: 15,
                  background: 'rgba(255,255,255,0.05)',
                  borderTopRightRadius: 5,
                  borderBottomRightRadius: 5,
                  touchAction: 'none',
                }}
                onPointerDown={(e) =>
                  handlePointerDown(e, clip.id, 'clip-trim-end', clip.startTime, clip.endTime)
                }
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          );
        })}
      </div>

      {importModalOpen && !editMode && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 5000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(5, 5, 8, 0.75)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            animation: 'fadeIn 0.25s ease-out',
          }}
          onClick={() => {
            setImportModalOpen(false);
            setEditMode(false);
            setPendingFiles([]);
            setChangeMediaClipId(null);
          }}
        >
          <div
            style={{
              width: '520px',
              maxWidth: '92vw',
              background: 'var(--glass-bg-heavy, rgba(5, 5, 7, 0.92))',
              backdropFilter: 'blur(var(--glass-blur, 24px))',
              WebkitBackdropFilter: 'blur(var(--glass-blur, 24px))',
              border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
              borderRadius: 'var(--radius-2xl, 16px)',
              padding: 0,
              boxShadow:
                '0 0 0 1px rgba(239, 68, 68, 0.08), 0 25px 60px -12px rgba(0, 0, 0, 0.7), 0 0 40px rgba(239, 68, 68, 0.06)',
              display: 'flex',
              flexDirection: 'column',
              color: 'var(--text-primary, #ffffff)',
              overflow: 'hidden',
              animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ── Header ── */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '18px 22px 16px',
                background: 'rgba(139, 0, 0, 0.06)',
                borderBottom: '1px solid rgba(239, 68, 68, 0.1)',
              }}
            >
              <div
                style={{
                  width: '38px',
                  height: '38px',
                  borderRadius: 'var(--radius-lg, 8px)',
                  background:
                    'linear-gradient(135deg, rgba(239, 68, 68, 0.15) 0%, rgba(139, 0, 0, 0.2) 100%)',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Film size={18} style={{ color: 'var(--accent-main, #ef4444)' }} />
              </div>
              <div style={{ minWidth: 0 }}>
                <h3
                  style={{
                    margin: 0,
                    fontSize: '15px',
                    fontWeight: 700,
                    letterSpacing: '0.02em',
                    color: 'var(--text-primary)',
                  }}
                >
                  Create Slideshow
                </h3>
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                    fontWeight: 500,
                  }}
                >
                  {pendingFiles.length} item{pendingFiles.length !== 1 ? 's' : ''} selected
                </span>
              </div>
            </div>

            {/* ── Body ── */}
            <div
              style={{
                padding: '18px 22px 22px',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
                maxHeight: '70vh',
                overflowY: 'auto',
              }}
            >
              {/* File List */}
              <div
                style={{
                  maxHeight: '110px',
                  overflowY: 'auto',
                  background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                  borderRadius: 'var(--radius-lg, 8px)',
                  padding: '8px',
                  border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                  boxShadow: 'var(--shadow-inset, inset 0 2px 4px rgba(0, 0, 0, 0.5))',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                {pendingFiles.map((file, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '12px',
                      padding: '5px 8px',
                      borderRadius: 'var(--radius-md, 4px)',
                      background: 'rgba(255, 255, 255, 0.02)',
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: '360px',
                        color: 'var(--text-secondary, rgba(255, 255, 255, 0.6))',
                      }}
                    >
                      {file.name}
                    </span>
                    <span
                      style={{
                        color: 'var(--accent-main, #ef4444)',
                        fontWeight: 600,
                        fontSize: '9px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        padding: '2px 6px',
                        borderRadius: 'var(--radius-sm, 2px)',
                        background: 'var(--accent-muted, rgba(239, 68, 68, 0.1))',
                      }}
                    >
                      {file.type.startsWith('video/') || isVideoUrl('', file.name)
                        ? 'video'
                        : 'image'}
                    </span>
                  </div>
                ))}
              </div>

              {/* ── Settings ── */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {/* Video: limit to slide duration */}
                {pendingFiles.some(
                  (f) => f.type.startsWith('video/') || isVideoUrl('', f.name),
                ) && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <label
                        style={{
                          fontSize: '13px',
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                        }}
                      >
                        Limit Videos to Slide Duration
                      </label>
                      <span
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                        }}
                      >
                        If disabled, video clips use their full source duration
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={limitVideoDuration}
                      onChange={(e) => setLimitVideoDuration(e.target.checked)}
                      style={{
                        width: '16px',
                        height: '16px',
                        accentColor: 'var(--accent-main, #ef4444)',
                        cursor: 'pointer',
                      }}
                    />
                  </div>
                )}

                {/* Slide Duration — conditional */}
                {(pendingFiles.some(
                  (f) => !f.type.startsWith('video/') && !isVideoUrl('', f.name),
                ) ||
                  (limitVideoDuration &&
                    pendingFiles.some(
                      (f) => f.type.startsWith('video/') || isVideoUrl('', f.name),
                    ))) && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <label
                        style={{
                          fontSize: '13px',
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                        }}
                      >
                        Slide Duration (seconds)
                      </label>
                      <span
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                        }}
                      >
                        {pendingFiles.some(
                          (f) => !f.type.startsWith('video/') && !isVideoUrl('', f.name),
                        )
                          ? 'How long each image is displayed'
                          : 'Max duration for each video clip'}
                      </span>
                    </div>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      step={0.5}
                      value={slideDuration}
                      onChange={(e) => setSlideDuration(parseFloat(e.target.value) || 5.0)}
                      style={{
                        width: '76px',
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-md, 4px)',
                        background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                        boxShadow: 'var(--shadow-inset)',
                        color: 'var(--text-primary)',
                        fontSize: '13px',
                        textAlign: 'center',
                        fontFamily: 'var(--font-primary)',
                      }}
                    />
                  </div>
                )}

                {/* Loop Until Song End */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <label
                      style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Loop Until Song End
                    </label>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                      }}
                    >
                      Repeat slideshow sequence until the end of the song
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={loopUntilEnd}
                    onChange={(e) => setLoopUntilEnd(e.target.checked)}
                    style={{
                      width: '16px',
                      height: '16px',
                      accentColor: 'var(--accent-main, #ef4444)',
                      cursor: 'pointer',
                    }}
                  />
                </div>

                {/* Randomize Order */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <label
                      style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Randomize Image Order
                    </label>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                      }}
                    >
                      Shuffle slide sequence randomly on import
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={randomizeOrder}
                    onChange={(e) => setRandomizeOrder(e.target.checked)}
                    style={{
                      width: '16px',
                      height: '16px',
                      accentColor: 'var(--accent-main, #ef4444)',
                      cursor: 'pointer',
                    }}
                  />
                </div>

                {/* Divider */}
                <div
                  style={{
                    height: '1px',
                    background:
                      'linear-gradient(90deg, transparent, rgba(239, 68, 68, 0.12), transparent)',
                  }}
                />

                {/* Transition Type */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <label
                      style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Transition Type
                    </label>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                      }}
                    >
                      Blending effect between slides
                    </span>
                  </div>
                  <select
                    value={transType}
                    onChange={(e) => setTransType(e.target.value as SceneTransitionType)}
                    style={{
                      width: '140px',
                      padding: '6px 10px',
                      borderRadius: 'var(--radius-md, 4px)',
                      background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                      border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                      boxShadow: 'var(--shadow-inset)',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                      fontFamily: 'var(--font-primary)',
                    }}
                  >
                    <option value="crossfade">Cross Fade</option>
                    <option value="cut">Instant Cut</option>
                    <option value="fade-black">Fade to Black</option>
                    <option value="bloom-flash">Bloom Flash</option>
                    <option value="wipe-left">Wipe Left</option>
                    <option value="wipe-right">Wipe Right</option>
                    <option value="zoom-in">Zoom In</option>
                    <option value="zoom-out">Zoom Out</option>
                  </select>
                </div>

                {/* Transition Duration */}
                {transType !== 'cut' && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <label
                        style={{
                          fontSize: '13px',
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                        }}
                      >
                        Transition Duration (seconds)
                      </label>
                      <span
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                        }}
                      >
                        Must be shorter than slide duration
                      </span>
                    </div>
                    <input
                      type="number"
                      min={0.1}
                      max={slideDuration - 0.1}
                      step={0.1}
                      value={transDuration}
                      onChange={(e) =>
                        setTransDuration(
                          Math.min(slideDuration - 0.1, parseFloat(e.target.value) || 1.0),
                        )
                      }
                      style={{
                        width: '76px',
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-md, 4px)',
                        background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                        boxShadow: 'var(--shadow-inset)',
                        color: 'var(--text-primary)',
                        fontSize: '13px',
                        textAlign: 'center',
                        fontFamily: 'var(--font-primary)',
                      }}
                    />
                  </div>
                )}

                {/* Divider */}
                <div
                  style={{
                    height: '1px',
                    background:
                      'linear-gradient(90deg, transparent, rgba(239, 68, 68, 0.12), transparent)',
                  }}
                />

                {/* Fit Mode */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <label
                      style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Fit Mode
                    </label>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                      }}
                    >
                      Sizing strategy for slides
                    </span>
                  </div>
                  <select
                    value={importFit}
                    onChange={(e) => setImportFit(e.target.value as typeof importFit)}
                    style={{
                      width: '120px',
                      padding: '6px 10px',
                      borderRadius: 'var(--radius-md, 4px)',
                      background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                      border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                    }}
                  >
                    <option value="cover">Cover</option>
                    <option value="contain">Contain</option>
                    <option value="stretch">Stretch</option>
                    <option value="original">Original</option>
                  </select>
                </div>

                {/* Scale / Zoom */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <label
                      style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Scale / Zoom
                    </label>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                      }}
                    >
                      Base visual scale factor
                    </span>
                  </div>
                  <input
                    type="number"
                    step={0.05}
                    min={0.1}
                    max={3.0}
                    value={importScale}
                    onChange={(e) => setImportScale(parseFloat(e.target.value) || 1.0)}
                    style={{
                      width: '76px',
                      padding: '6px 10px',
                      borderRadius: 'var(--radius-md, 4px)',
                      background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                      border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                      textAlign: 'center',
                    }}
                  />
                </div>

                {/* Offset X / Y */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                    <label
                      style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Shift Axes (Offset X / Y)
                    </label>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                      }}
                    >
                      Horizontal and vertical placement shift
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>X</span>
                      <input
                        type="number"
                        step={0.05}
                        min={-2}
                        max={2}
                        value={importOffsetX}
                        onChange={(e) => setImportOffsetX(parseFloat(e.target.value) || 0.0)}
                        style={{
                          width: '56px',
                          padding: '5px 8px',
                          borderRadius: 'var(--radius-md, 4px)',
                          background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                          border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                          color: 'var(--text-primary)',
                          fontSize: '12px',
                          textAlign: 'center',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>Y</span>
                      <input
                        type="number"
                        step={0.05}
                        min={-2}
                        max={2}
                        value={importOffsetY}
                        onChange={(e) => setImportOffsetY(parseFloat(e.target.value) || 0.0)}
                        style={{
                          width: '56px',
                          padding: '5px 8px',
                          borderRadius: 'var(--radius-md, 4px)',
                          background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                          border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                          color: 'var(--text-primary)',
                          fontSize: '12px',
                          textAlign: 'center',
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Footer ── */}
              <div
                style={{
                  display: 'flex',
                  gap: '10px',
                  marginTop: '4px',
                  paddingTop: '14px',
                  borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setImportModalOpen(false);
                    setEditMode(false);
                    setPendingFiles([]);
                    setChangeMediaClipId(null);
                  }}
                  style={{
                    flex: 1,
                    padding: '10px',
                    borderRadius: 'var(--radius-md, 4px)',
                    background: 'var(--bg-hover, rgba(255, 255, 255, 0.05))',
                    border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                    color: 'var(--text-secondary, rgba(255, 255, 255, 0.6))',
                    fontSize: '13px',
                    fontWeight: 600,
                    fontFamily: 'var(--font-primary)',
                    cursor: 'pointer',
                    transition: 'all var(--duration-fast, 150ms) ease',
                    letterSpacing: '0.02em',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImportSlideshow}
                  style={{
                    flex: 2,
                    padding: '10px',
                    borderRadius: 'var(--radius-md, 4px)',
                    background: 'var(--accent-main, #ef4444)',
                    border: '1px solid transparent',
                    color: '#ffffff',
                    fontSize: '13px',
                    fontWeight: 700,
                    fontFamily: 'var(--font-primary)',
                    cursor: 'pointer',
                    boxShadow: '0 4px 16px var(--accent-glow, rgba(239, 68, 68, 0.3))',
                    transition: 'all var(--duration-fast, 150ms) ease',
                    letterSpacing: '0.02em',
                  }}
                >
                  Create Slideshow
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit All Backgrounds Modal ── */}
      {importModalOpen &&
        editMode &&
        (() => {
          const selClip = editClips.find((c) => c.id === selectedEditClipId) || editClips[0];
          const selFit = selClip?.fit || 'cover';
          const selScale = selClip?.scale ?? 1.0;
          const selOffX = selClip?.offsetX ?? 0;
          const selOffY = selClip?.offsetY ?? 0;
          const selTiling = selClip?.tiling ?? false;
          const isVideo = selClip ? isVideoUrl(selClip.url, selClip.name) : false;

          return (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 5000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(5, 5, 8, 0.75)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                animation: 'fadeIn 0.25s ease-out',
              }}
              onClick={() => {
                setImportModalOpen(false);
                setEditMode(false);
                setEditClips([]);
                setSelectedEditClipId(null);
              }}
            >
              <div
                style={{
                  width: '680px',
                  maxWidth: '95vw',
                  maxHeight: '90vh',
                  background: 'var(--glass-bg-heavy, rgba(5, 5, 7, 0.92))',
                  backdropFilter: 'blur(var(--glass-blur, 24px))',
                  WebkitBackdropFilter: 'blur(var(--glass-blur, 24px))',
                  border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                  borderRadius: 'var(--radius-2xl, 16px)',
                  padding: 0,
                  boxShadow:
                    '0 0 0 1px rgba(6, 182, 212, 0.08), 0 25px 60px -12px rgba(0, 0, 0, 0.7), 0 0 40px rgba(6, 182, 212, 0.06)',
                  display: 'flex',
                  flexDirection: 'column',
                  color: 'var(--text-primary, #ffffff)',
                  overflow: 'hidden',
                  animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* ── Header ── */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '18px 22px 16px',
                    background: 'rgba(6, 182, 212, 0.04)',
                    borderBottom: '1px solid rgba(6, 182, 212, 0.1)',
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: '38px',
                      height: '38px',
                      borderRadius: 'var(--radius-lg, 8px)',
                      background:
                        'linear-gradient(135deg, rgba(6, 182, 212, 0.15) 0%, rgba(6, 182, 212, 0.2) 100%)',
                      border: '1px solid rgba(6, 182, 212, 0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Settings2 size={18} style={{ color: '#06b6d4' }} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: '15px',
                        fontWeight: 700,
                        letterSpacing: '0.02em',
                        color: 'var(--text-primary)',
                      }}
                    >
                      Edit Backgrounds
                    </h3>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted, rgba(255, 255, 255, 0.35))',
                        fontWeight: 500,
                      }}
                    >
                      {editClips.length} clip{editClips.length !== 1 ? 's' : ''} — select to edit
                      individually
                    </span>
                  </div>
                </div>

                {/* ── Body ── */}
                <div
                  style={{
                    padding: '16px 22px 22px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px',
                    overflowY: 'auto',
                    flex: 1,
                  }}
                >
                  {/* ── Top Row: Clip list + Preview ── */}
                  <div style={{ display: 'flex', gap: '14px', minHeight: 0 }}>
                    {/* Clip List (left) */}
                    <div
                      style={{
                        width: '210px',
                        flexShrink: 0,
                        maxHeight: '200px',
                        overflowY: 'auto',
                        background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                        borderRadius: 'var(--radius-lg, 8px)',
                        padding: '6px',
                        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                        boxShadow: 'var(--shadow-inset, inset 0 2px 4px rgba(0, 0, 0, 0.5))',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '3px',
                      }}
                    >
                      {editClips.map((clip, idx) => {
                        const isSel = clip.id === selectedEditClipId;
                        return (
                          <div
                            key={clip.id}
                            onClick={() => setSelectedEditClipId(clip.id)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              fontSize: '11px',
                              padding: '6px 8px',
                              borderRadius: '6px',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                              background: isSel
                                ? 'rgba(6, 182, 212, 0.12)'
                                : 'rgba(255, 255, 255, 0.02)',
                              border: isSel
                                ? '1px solid rgba(6, 182, 212, 0.3)'
                                : '1px solid transparent',
                            }}
                          >
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: '120px',
                                color: isSel ? '#ffffff' : 'rgba(255, 255, 255, 0.5)',
                                fontWeight: isSel ? 600 : 400,
                              }}
                            >
                              {clip.name || `Clip ${idx + 1}`}
                            </span>
                            <span
                              style={{
                                color: isSel ? '#06b6d4' : 'rgba(255,255,255,0.25)',
                                fontSize: '9px',
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                padding: '1px 5px',
                                borderRadius: '2px',
                                background: isSel ? 'rgba(6, 182, 212, 0.1)' : 'transparent',
                              }}
                            >
                              {isVideoUrl(clip.url, clip.name) ? 'vid' : 'img'}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Preview Panel (right) */}
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '0.08em',
                          color: 'rgba(255,255,255,0.3)',
                        }}
                      >
                        Alignment Preview ({ASPECT_RATIOS[exportAspect]?.label || '16:9'})
                      </span>
                      <div
                        style={{
                          aspectRatio: `${previewRatio}`,
                          width: '100%',
                          borderRadius: 'var(--radius-lg, 8px)',
                          overflow: 'hidden',
                          background: '#0a0a0f',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          position: 'relative',
                          boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.6)',
                        }}
                      >
                        {/* Checkerboard bg for transparent areas */}
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            backgroundImage:
                              'linear-gradient(45deg, #111 25%, transparent 25%), linear-gradient(-45deg, #111 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #111 75%), linear-gradient(-45deg, transparent 75%, #111 75%)',
                            backgroundSize: '16px 16px',
                            backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
                            opacity: 0.3,
                          }}
                        />

                        {/* Center crosshair */}
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            pointerEvents: 'none',
                            zIndex: 2,
                          }}
                        >
                          <div
                            style={{
                              position: 'absolute',
                              left: '50%',
                              top: 0,
                              bottom: 0,
                              width: '1px',
                              background: 'rgba(6, 182, 212, 0.15)',
                            }}
                          />
                          <div
                            style={{
                              position: 'absolute',
                              top: '50%',
                              left: 0,
                              right: 0,
                              height: '1px',
                              background: 'rgba(6, 182, 212, 0.15)',
                            }}
                          />
                        </div>

                        {/* Media preview */}
                        {selClip && (
                          <AlignmentPreviewMedia
                            url={selClip.url}
                            name={selClip.name}
                            isVideo={isVideo}
                            fit={selFit}
                            scale={selScale}
                            offsetX={selOffX}
                            offsetY={selOffY}
                            boxAspect={previewRatio || 16 / 9}
                          />
                        )}

                        {/* Offset indicator */}
                        {(selOffX !== 0 || selOffY !== 0) && (
                          <div
                            style={{
                              position: 'absolute',
                              bottom: '6px',
                              right: '6px',
                              fontSize: '9px',
                              fontWeight: 600,
                              fontVariantNumeric: 'tabular-nums',
                              color: '#06b6d4',
                              background: 'rgba(0,0,0,0.7)',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              zIndex: 3,
                            }}
                          >
                            X:{selOffX.toFixed(2)} Y:{selOffY.toFixed(2)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* ── Per-Clip Controls ── */}
                  {selClip && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div
                        style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '0.08em',
                          color: 'rgba(255,255,255,0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <span
                          style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.06)' }}
                        />
                        <span>{selClip.name || 'Selected Clip'} — Properties</span>
                        <span
                          style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.06)' }}
                        />
                      </div>

                      {/* Row 1: Fit + Scale + Tiling */}
                      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                        {/* Fit */}
                        <div
                          style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}
                        >
                          <label
                            style={{
                              fontSize: '11px',
                              fontWeight: 500,
                              color: 'rgba(255,255,255,0.5)',
                            }}
                          >
                            Fit
                          </label>
                          <select
                            value={selFit}
                            onChange={(e) =>
                              updateEditClip(selClip.id, {
                                fit: e.target.value as BackgroundClip['fit'],
                              })
                            }
                            style={{
                              padding: '6px 8px',
                              borderRadius: '4px',
                              background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                              border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                              color: 'var(--text-primary)',
                              fontSize: '12px',
                              fontFamily: 'var(--font-primary)',
                            }}
                          >
                            <option value="cover">Cover</option>
                            <option value="contain">Contain</option>
                            <option value="stretch">Stretch</option>
                            <option value="original">Original</option>
                          </select>
                        </div>
                        {/* Scale */}
                        <div
                          style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}
                        >
                          <label
                            style={{
                              fontSize: '11px',
                              fontWeight: 500,
                              color: 'rgba(255,255,255,0.5)',
                            }}
                          >
                            Scale
                          </label>
                          <input
                            type="number"
                            step={0.05}
                            min={0.1}
                            max={5.0}
                            value={selScale}
                            onChange={(e) =>
                              updateEditClip(selClip.id, {
                                scale: parseFloat(e.target.value) || 1.0,
                              })
                            }
                            style={{
                              padding: '6px 8px',
                              borderRadius: '4px',
                              background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                              border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                              color: 'var(--text-primary)',
                              fontSize: '12px',
                              textAlign: 'center',
                            }}
                          />
                        </div>
                        {/* Tiling */}
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                            alignItems: 'center',
                          }}
                        >
                          <label
                            style={{
                              fontSize: '11px',
                              fontWeight: 500,
                              color: 'rgba(255,255,255,0.5)',
                            }}
                          >
                            Tile
                          </label>
                          <input
                            type="checkbox"
                            checked={selTiling}
                            onChange={(e) =>
                              updateEditClip(selClip.id, { tiling: e.target.checked })
                            }
                            style={{
                              width: '16px',
                              height: '16px',
                              accentColor: '#06b6d4',
                              cursor: 'pointer',
                              marginBottom: '4px',
                            }}
                          />
                        </div>
                      </div>

                      {/* Row 2: Offset X + Y with sliders */}
                      <div style={{ display: 'flex', gap: '12px' }}>
                        {/* Offset X */}
                        <div
                          style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}
                        >
                          <label
                            style={{
                              fontSize: '11px',
                              fontWeight: 500,
                              color: 'rgba(255,255,255,0.5)',
                            }}
                          >
                            Offset X
                          </label>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <input
                              type="range"
                              min={-2}
                              max={2}
                              step={0.01}
                              value={selOffX}
                              onChange={(e) =>
                                updateEditClip(selClip.id, { offsetX: parseFloat(e.target.value) })
                              }
                              style={{ flex: 1, accentColor: '#06b6d4', height: '4px' }}
                            />
                            <input
                              type="number"
                              step={0.05}
                              min={-2}
                              max={2}
                              value={selOffX}
                              onChange={(e) =>
                                updateEditClip(selClip.id, {
                                  offsetX: parseFloat(e.target.value) || 0,
                                })
                              }
                              style={{
                                width: '52px',
                                padding: '4px 6px',
                                borderRadius: '4px',
                                background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                                border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                                color: 'var(--text-primary)',
                                fontSize: '11px',
                                textAlign: 'center',
                              }}
                            />
                          </div>
                        </div>
                        {/* Offset Y */}
                        <div
                          style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}
                        >
                          <label
                            style={{
                              fontSize: '11px',
                              fontWeight: 500,
                              color: 'rgba(255,255,255,0.5)',
                            }}
                          >
                            Offset Y
                          </label>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <input
                              type="range"
                              min={-2}
                              max={2}
                              step={0.01}
                              value={selOffY}
                              onChange={(e) =>
                                updateEditClip(selClip.id, { offsetY: parseFloat(e.target.value) })
                              }
                              style={{ flex: 1, accentColor: '#06b6d4', height: '4px' }}
                            />
                            <input
                              type="number"
                              step={0.05}
                              min={-2}
                              max={2}
                              value={selOffY}
                              onChange={(e) =>
                                updateEditClip(selClip.id, {
                                  offsetY: parseFloat(e.target.value) || 0,
                                })
                              }
                              style={{
                                width: '52px',
                                padding: '4px 6px',
                                borderRadius: '4px',
                                background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                                border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                                color: 'var(--text-primary)',
                                fontSize: '11px',
                                textAlign: 'center',
                              }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Apply to All shortcut */}
                      <button
                        type="button"
                        onClick={() => {
                          setEditClips((prev) =>
                            prev.map((c) => ({
                              ...c,
                              fit: selFit,
                              scale: selScale,
                              offsetX: selOffX,
                              offsetY: selOffY,
                              tiling: selTiling,
                            })),
                          );
                          toast.success('Visual settings copied to all clips');
                        }}
                        style={{
                          alignSelf: 'flex-start',
                          padding: '4px 10px',
                          borderRadius: '4px',
                          background: 'rgba(6, 182, 212, 0.08)',
                          border: '1px solid rgba(6, 182, 212, 0.15)',
                          color: '#06b6d4',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          fontFamily: 'var(--font-primary)',
                        }}
                      >
                        Copy to All Clips
                      </button>
                    </div>
                  )}

                  {/* ── Divider ── */}
                  <div
                    style={{
                      height: '1px',
                      background:
                        'linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.12), transparent)',
                    }}
                  />

                  {/* ── Bulk Transition Settings ── */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        color: 'rgba(255,255,255,0.3)',
                      }}
                    >
                      Transition (all clips)
                    </span>
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                      {/* Transition Type */}
                      <div
                        style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}
                      >
                        <label
                          style={{
                            fontSize: '11px',
                            fontWeight: 500,
                            color: 'rgba(255,255,255,0.5)',
                          }}
                        >
                          Type
                        </label>
                        <select
                          value={transType}
                          onChange={(e) => setTransType(e.target.value as SceneTransitionType)}
                          style={{
                            padding: '6px 8px',
                            borderRadius: '4px',
                            background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                            border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                            color: 'var(--text-primary)',
                            fontSize: '12px',
                            fontFamily: 'var(--font-primary)',
                          }}
                        >
                          <option value="crossfade">Cross Fade</option>
                          <option value="cut">Instant Cut</option>
                          <option value="fade-black">Fade to Black</option>
                          <option value="bloom-flash">Bloom Flash</option>
                          <option value="wipe-left">Wipe Left</option>
                          <option value="wipe-right">Wipe Right</option>
                          <option value="zoom-in">Zoom In</option>
                          <option value="zoom-out">Zoom Out</option>
                        </select>
                      </div>
                      {/* Transition Duration */}
                      {transType !== 'cut' && (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                            width: '90px',
                          }}
                        >
                          <label
                            style={{
                              fontSize: '11px',
                              fontWeight: 500,
                              color: 'rgba(255,255,255,0.5)',
                            }}
                          >
                            Duration (s)
                          </label>
                          <input
                            type="number"
                            min={0.1}
                            max={10}
                            step={0.1}
                            value={transDuration}
                            onChange={(e) =>
                              setTransDuration(Math.max(0.1, parseFloat(e.target.value) || 1.0))
                            }
                            style={{
                              padding: '6px 8px',
                              borderRadius: '4px',
                              background: 'var(--bg-input, rgba(0, 0, 0, 0.4))',
                              border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                              color: 'var(--text-primary)',
                              fontSize: '12px',
                              textAlign: 'center',
                              fontFamily: 'var(--font-primary)',
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ── Footer ── */}
                  <div
                    style={{
                      display: 'flex',
                      gap: '10px',
                      paddingTop: '10px',
                      borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setImportModalOpen(false);
                        setEditMode(false);
                        setEditClips([]);
                        setSelectedEditClipId(null);
                      }}
                      style={{
                        flex: 1,
                        padding: '10px',
                        borderRadius: 'var(--radius-md, 4px)',
                        background: 'var(--bg-hover, rgba(255, 255, 255, 0.05))',
                        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                        color: 'var(--text-secondary, rgba(255, 255, 255, 0.6))',
                        fontSize: '13px',
                        fontWeight: 600,
                        fontFamily: 'var(--font-primary)',
                        cursor: 'pointer',
                        transition: 'all var(--duration-fast, 150ms) ease',
                        letterSpacing: '0.02em',
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleEditApply}
                      style={{
                        flex: 2,
                        padding: '10px',
                        borderRadius: 'var(--radius-md, 4px)',
                        background: '#06b6d4',
                        border: '1px solid transparent',
                        color: '#ffffff',
                        fontSize: '13px',
                        fontWeight: 700,
                        fontFamily: 'var(--font-primary)',
                        cursor: 'pointer',
                        boxShadow: '0 4px 16px rgba(6, 182, 212, 0.3)',
                        transition: 'all var(--duration-fast, 150ms) ease',
                        letterSpacing: '0.02em',
                      }}
                    >
                      Apply Changes
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
});

// Helper component for context menu items
function ContextMenuItem({
  onClick,
  icon: Icon,
  label,
}: {
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '7px 10px',
        fontSize: '13px',
        fontWeight: 500,
        color: hovered ? '#ffffff' : 'rgba(255, 255, 255, 0.75)',
        background: hovered ? 'rgba(6, 182, 212, 0.15)' : 'transparent',
        border: 'none',
        borderRadius: '6px',
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
      }}
    >
      <Icon size={14} style={{ color: hovered ? '#06b6d4' : 'rgba(255, 255, 255, 0.5)' }} />
      {label}
    </button>
  );
}

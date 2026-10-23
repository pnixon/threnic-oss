'use client';

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AppShell, Header } from '@/components/layout';
import { PlaylistBrowser, Inspector } from '@/components/panels';
import { BottomPanel } from '@/components/panels/BottomPanel/BottomPanel';
import { MobilePlayerBar } from '@/components/panels/MobilePlayerBar/MobilePlayerBar';
import { X, Play, Pause, Monitor, Smartphone, ChevronDown } from 'lucide-react';

import { GPUCanvas, GPUCanvasRef } from '@/components/stage/GPUCanvas';
import { CenterStage } from '@/components/stage/CenterStage';
import { LyricsCanvas } from '@/components/stage/LyricsCanvas';
import { PreviewWatermark } from '@/components/stage/overlays/PreviewWatermark';
import { AudioPlayer } from '@/components/audio';
import { checkWebGPUSupport } from '@/engine/gpu/webgpu-support';
import { useExportMode } from '@/engine/export';

import {
  usePlaylistState,
  useTrackManagementAPI,
  useTrackConfigAPI,
  usePlaylistSettingsAPI,
} from '@/contexts/PlaylistContext';
import { useGlobalKeyboardShortcuts } from '@/hooks';
import { useGPUEffects } from '@/hooks/useGPUEffects';
import type { LyricLineData } from '@/types/lyrics';
import { getFontUrl } from '@/constants/fonts';
import { toast } from '@/utils/toast';

import { calcDimensions } from '@/types/exportConstants';
import { usePlaybackManager } from '@/hooks/usePlaybackManager';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useLyricsThemeState } from '@/hooks/useLyricsThemeState';
import { useTrackEffectsState } from '@/hooks/useTrackEffectsState';
import { useTrackLyricsState } from '@/hooks/useTrackLyricsState';
import { initAutoPersist } from '@/stores/autoPersist';
import { systemStore } from '@/stores/systemStore';
import { useProjectRestore } from '@/hooks/useProjectRestore';
import { useKeyframeTransitions } from '@/hooks/useKeyframeTransitions';
import { useUndoRedoShortcuts } from '@/hooks/useCommandBus';
import { useExportUIStore } from '@/engine/stores/exportUIStore';

import { trackStore } from '@/engine/stores/trackStore';
import { ThrenicProject } from '@/types/project';
import { Track } from '@/contexts/types';
import { ViewportControls } from './ViewportControls';
import { ExportProgressWidget } from './ExportProgressWidget';
import { MobileView } from '@/components/layout/MobileNavigation';
import { useMediaQuery } from '@/hooks';
import { timeStore } from '@/engine/stores/timeStore';

const DEMO_LYRICS: LyricLineData[] = [];

export function AppContent(): React.ReactElement {
  const { selectedTrackId, tracks, settings } = usePlaylistState();
  const { getSelectedTrack, selectNextTrack, selectPreviousTrack, selectTrack, restorePlaylist } =
    useTrackManagementAPI();
  const { updateTrackKeyframes, updateTrackProperty, updateTrackEffectInstance } =
    useTrackConfigAPI();
  const { updateSettings } = usePlaylistSettingsAPI();

  const [currentTime, setTime] = useState(0);
  const [duration, setDur] = useState(0);
  const [isPlaying, setPlaying] = useState(false);
  // Lyrics theme state — reads directly from projectStore via useSyncExternalStore
  const lyricsTheme = useLyricsThemeState();
  const {
    verticalPosition,
    horizontalPosition,
    wrapWidth,
    fontSize,
    selectedFontId,
    lyricColors,
    wordSpacing,
    lineSpacing,
    glowEnabled,
    glowColor,
    glowIntensity,
    outlineColor,
    fadeInDuration,
    fadeOutDuration,
    highlightFadeIn,
    highlightFadeOut,
    animationType,
    animationStagger,
    activeScaleEnabled,
    effectScope,
    setVerticalPosition,
    setHorizontalPosition,
    setWrapWidth,
    setFontSize,
    setLyricColors,
    setWordSpacing,
    setLineSpacing,
    setGlowEnabled,
    setGlowColor,
    setGlowIntensity,
    setOutlineColor,
    setFadeInDuration,
    setFadeOutDuration,
    setAnimationType,
    setAnimationStagger,
    handleFontChange,
  } = lyricsTheme;
  // Effects/keyframes/videoClips/background — reads from projectStore via useSyncExternalStore
  const trackEffects = useTrackEffectsState({ duration });
  const {
    effectsConfig,
    keyframes,
    videoClips,
    backgroundImage: localBackgroundUrl,
    handleEffectsChange,
    handleVideoClipsUpdate,
    setKeyframes,
  } = trackEffects;

  const [webGPUSupported, setWebGPUSupported] = useState<boolean | null>(null);

  useEffect(() => {
    // Allow ?webgl=1 URL param to force WebGL fallback mode for debugging
    const forceWebGL = new URLSearchParams(window.location.search).get('webgl') === '1';
    if (forceWebGL) {
      console.log('[AppContent] Forcing WebGL mode via ?webgl=1');
      setWebGPUSupported(false);
      return;
    }
    checkWebGPUSupport().then((supported) => {
      setWebGPUSupported(supported);
    });
  }, []);

  // Publish the fallback stage so the effects UI can mark GPU-only effects as
  // unavailable. The WebGPU case is published by GPUCanvas once its renderer
  // actually initialises (it may itself fall back to Canvas2D).
  useEffect(() => {
    if (webGPUSupported === false) systemStore.getState().setStagePipeline('fallback');
  }, [webGPUSupported]);

  useEffect(() => {
    const handleSwitchView = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        setMobileView(customEvent.detail);
      }
    };
    window.addEventListener('switch-mobile-view', handleSwitchView);
    return () => window.removeEventListener('switch-mobile-view', handleSwitchView);
  }, []);

  // handleEffectsChange is provided by useTrackEffectsState

  const [playbackRate, setPlaybackRate] = useState(1);
  // Words state — reads from projectStore, maintains editing draft, auto-debounce commit
  const { words, setWords } = useTrackLyricsState();
  const [isDragging, setIsDragging] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>('stage');
  // Mobile Stage tab: the compact MobilePlayerBar is the default transport.
  // The full detailed Timeline (ruler + lanes) is opt-in via this toggle so
  // the canvas gets the majority of the viewport height by default.
  const [mobileTimelineExpanded, setMobileTimelineExpanded] = useState(false);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  // Export config — reads from exportUIStore (Zustand)
  const exportQuality = useExportUIStore((s) => s.exportQuality);
  const setExportQuality = useExportUIStore((s) => s.setExportQuality);
  const exportAspect = useExportUIStore((s) => s.exportAspect);
  const setExportAspect = useExportUIStore((s) => s.setExportAspect);
  const exportBitrate = useExportUIStore((s) => s.exportBitrate);
  const setExportBitrate = useExportUIStore((s) => s.setExportBitrate);
  const selectionRange = useExportUIStore((s) => s.selectionRange);
  const setSelectionRange = useExportUIStore((s) => s.setSelectionRange);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [prevTrackId, setPrevTrackId] = useState<string | null>(null);
  const [panelOpacity] = useState(0.6);
  const [isFullscreenPreview, setIsFullscreenPreview] = useState(false);
  const [showFullscreenControls, setShowFullscreenControls] = useState(false);
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  });

  const formatTime = useCallback((seconds: number): string => {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }, []);

  // SYNC FROM SOURCE: Update effects/background when selected keyframe or track changes
  // Keyframe selection sync + keyframe external sync now handled by useTrackEffectsState.
  // Lyrics theme sync handled by useLyricsThemeState.

  const handleGPUInitializationError = React.useCallback((error: Error) => {
    console.error('GPU Initialization Error:', error);
    // Auto-fallback: a runtime WebGPU init failure that slipped past the
    // startup probe (a device lost after detection, a driver bug on the real
    // pipeline) demotes to the Canvas2D/WebGL CenterStage path instead of
    // leaving a black canvas. Guarded so we only announce the demotion once.
    setWebGPUSupported((prev) => {
      if (prev === false) return prev;
      toast.error('Hardware acceleration failed — switching to compatibility rendering.');
      return false;
    });
  }, []);

  const centerStageRef = useRef<GPUCanvasRef>(null);

  // Spatial editing mode has been removed

  // Bridge effect instances → native WebGPU RenderGraph passes
  useGPUEffects(centerStageRef, effectsConfig);

  const audioPlayerRef = useRef<HTMLAudioElement>(null);
  const gapTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const dragStartRef = useRef<{
    x: number;
    y: number;
    initialPan: { x: number; y: number };
  } | null>(null);

  const { isExporting, isSupported: exportSupported, config } = useExportMode();

  // ─── Sync rendering state to trackStore imperatively ───────────
  // This feeds GPUCanvas without triggering React re-renders on prop changes.
  // GPUCanvas subscribes to trackStore directly via Zustand vanilla subscriptions.
  // trackStore effectsConfig sync handled by useTrackEffectsState

  useEffect(() => {
    trackStore.getState().setIsExporting(!!isExporting);
  }, [isExporting]);

  // Video clip auto-creation handled by useTrackEffectsState

  const handleAudioBuffer = useCallback((buffer: AudioBuffer | null) => {
    setAudioBuffer(buffer);
    if (buffer && buffer.duration > 0) {
      setDur((prev) => Math.max(prev, buffer.duration));
    }
  }, []);

  // Sync state with selected track during render
  if (selectedTrackId !== prevTrackId) {
    setPrevTrackId(selectedTrackId);

    // Reset audio state for new track
    setDur(0);
    setAudioBuffer(null);

    // Track data sync: effects/keyframes/videoClips/background handled by useTrackEffectsState
    // Words sync handled by useTrackLyricsState (auto-resets on track switch)

    // Lyrics theme sync removed — useLyricsThemeState() reads directly from
    // the Zustand store's track.lyricsTheme. No manual copy needed.

    // Reset playback
    if (!isExporting) {
      setTime(0);
      timeStore.getState().setCurrentTime(0, true);
    }
  }

  // Calculate preview aspect ratio
  const previewRatio = useExportUIStore((s) => s.previewRatio);

  // Zoom limits
  const minZoom = isMobile ? 0.5 : 0.25;
  // Cap at 1.0: canvas must never exceed the container (no clipping).
  // zoom < 1 = canvas floats with empty space; zoom = 1 = fits container exactly.
  const maxZoom = 1.0;

  // Auto-reset zoom to fit when aspect ratio changes or export starts
  // This ensures the canvas stays visible within the preview container
  useEffect(() => {
    setPreviewZoom(1.0);
    setPan({ x: 0, y: 0 });
  }, [exportAspect]);

  // Get current track data
  const selectedTrack = getSelectedTrack();
  const audioUrl = selectedTrack?.audioUrl;
  const lyrics = selectedTrack?.lyricsData ?? DEMO_LYRICS;
  const activeSelectionRange = config.mode === 'selection' ? selectionRange : null;

  // Background and trackStore sync handled by useTrackEffectsState
  const baseTrackBackground = localBackgroundUrl;

  const { effectiveTheme: rawTrackTheme } = useAppTheme({
    selectedFontId,
    fontSize,
    lyricColors,
    verticalPosition,
    horizontalPosition,
    wrapWidth,
    animationType,
    animationStagger,
    fadeInDuration,
    fadeOutDuration,
    highlightFadeIn,
    highlightFadeOut,
    activeScaleEnabled,
    glowEnabled,
    glowColor,
    glowIntensity,
    outlineColor,
    wordSpacing,
    lineSpacing,
  });

  // Merge per-track lane overrides (laneStyles, laneCount, letterSpacing) and the
  // GPU Lyric FX stack into the theme so the renderer can resolve per-lane styling
  // and the per-glyph effect stack for preview + export.
  const baseTrackTheme = useMemo(() => {
    const trackTheme = selectedTrack?.lyricsTheme;
    if (
      !trackTheme?.laneStyles &&
      !trackTheme?.laneCount &&
      trackTheme?.letterSpacing == null &&
      trackTheme?.lineSpacing == null &&
      trackTheme?.horizontalPosition == null &&
      trackTheme?.wrapWidth == null &&
      trackTheme?.antialiasing == null &&
      !trackTheme?.lyricFX
    )
      return rawTrackTheme;
    return {
      ...rawTrackTheme,
      ...(trackTheme.laneStyles ? { laneStyles: trackTheme.laneStyles } : {}),
      ...(trackTheme.laneCount ? { laneCount: trackTheme.laneCount } : {}),
      ...(trackTheme.letterSpacing != null ? { letterSpacing: trackTheme.letterSpacing } : {}),
      ...(trackTheme.lineSpacing != null ? { lineSpacing: trackTheme.lineSpacing } : {}),
      ...(trackTheme.horizontalPosition != null
        ? { horizontalPosition: trackTheme.horizontalPosition }
        : {}),
      ...(trackTheme.wrapWidth != null ? { wrapWidth: trackTheme.wrapWidth } : {}),
      ...(trackTheme.antialiasing != null ? { antialiasing: trackTheme.antialiasing } : {}),
      ...(trackTheme.lyricFX ? { lyricFX: trackTheme.lyricFX } : {}),
    };
  }, [rawTrackTheme, selectedTrack?.lyricsTheme]);

  // Drive keyframe transitions every RAF — resolver reads from projectStore directly
  useKeyframeTransitions();

  // Mount undo/redo keyboard shortcuts (Ctrl+Z / Ctrl+Shift+Z)
  useUndoRedoShortcuts();

  const { handlePlayPause, handleSeek, handleDurationChange, handleEnded } = usePlaybackManager({
    audioUrl,
    duration,
    setDur,
    setTime,
    isPlaying,
    setPlaying,
    isExporting,
    audioPlayerRef,
    gapTimeoutRef,
    selectedTrackId,
    tracks,
    settings,
    selectNextTrack,
    selectionRange: activeSelectionRange,
  });

  // Global spacebar listener for play/pause
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const target = e.target as HTMLElement | null;
        if (target) {
          const tagName = target.tagName.toLowerCase();
          if (tagName === 'input' || tagName === 'textarea' || target.isContentEditable) {
            return;
          }
        }
        e.preventDefault();
        handlePlayPause();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handlePlayPause]);

  const handleRestoreProject = useCallback(
    (project: ThrenicProject, validTracks: Track[]) => {
      // Effects and lyrics theme are per-track in the Zustand store.
      // restorePlaylist(validTracks) populates tracks with their stored config,
      // and the hooks (useLyricsThemeState, useTrackEffectsState) pick them up automatically.

      if (project.exportSettings) {
        // NOTE: quality / aspect / bitrate / mode are GLOBAL user preferences
        // (persisted in localStorage via exportUIStore) and intentionally NOT
        // overridden by a loaded project — otherwise opening a project would
        // clobber the user's global export settings. Only selectionRange is
        // genuinely per-project (a time range inside a specific song).
        if (project.exportSettings.selectionRange)
          setSelectionRange(project.exportSettings.selectionRange);
      }

      if (validTracks.length > 0) {
        restorePlaylist(validTracks);
        if (
          project.meta?.currentTrackId &&
          validTracks.some((t) => t.id === project.meta!.currentTrackId)
        ) {
          setTimeout(() => selectTrack(project.meta!.currentTrackId!), 0);
        }
      }

      if (project.playlistSettings) {
        updateSettings(project.playlistSettings);
      }
    },
    [restorePlaylist, selectTrack, updateSettings, setSelectionRange],
  );

  // One-time project restore from IDB on startup
  useProjectRestore({ onRestore: handleRestoreProject });

  // Auto-persist: subscribe to projectStore changes → debounced IDB writes
  const isSavingToIDB = false; // Persistence is now non-blocking via middleware
  useEffect(() => {
    const cleanup = initAutoPersist();
    return cleanup;
  }, []);

  // Handle updates to video clips (instantly save to track)
  // handleVideoClipsUpdate and handleBackgroundChange provided by useTrackEffectsState
  // Words update/debounce/commit handled by useTrackLyricsState

  const calculateStageDimensions = useCallback(
    (isFullScreen = false): { width: number; height: number } => {
      const cW = isFullScreen ? windowSize.width : containerSize.width;
      const cH = isFullScreen ? windowSize.height : containerSize.height;

      if (cW <= 0 || cH <= 0) {
        return { width: 0, height: 0 };
      }

      // Clamp zoom: canvas must never exceed the container
      const effectiveZoom = Math.min(previewZoom, 1.0);

      const containerRatio = cW / cH;

      // Fit canvas entirely inside the viewable area (contain), preserving selected aspect ratio
      if (containerRatio > previewRatio) {
        return {
          width: cH * previewRatio * (isFullScreen ? 1.0 : effectiveZoom),
          height: cH * (isFullScreen ? 1.0 : effectiveZoom),
        };
      }

      return {
        width: cW * (isFullScreen ? 1.0 : effectiveZoom),
        height: (cW / previewRatio) * (isFullScreen ? 1.0 : effectiveZoom),
      };
    },
    [windowSize, containerSize, previewZoom, previewRatio],
  );

  // Scroll to zoom handler
  const handleWheelZoom = useCallback(
    (e: React.WheelEvent) => {
      // Allowing zooming during export is safe as it only affects CSS preview
      if (!containerRef.current) return;

      const container = containerRef.current;
      const rect = container.getBoundingClientRect();

      // Mouse position relative to container center normalized (-0.5 to 0.5)
      const vx = (e.clientX - rect.left) / rect.width - 0.5;
      const vy = (e.clientY - rect.top) / rect.height - 0.5;

      const direction = e.deltaY > 0 ? -1 : 1;
      const oldZoom = previewZoom;
      const next = oldZoom + direction * 0.25;
      const newZoom = Math.max(minZoom, Math.min(maxZoom, Math.round(next * 4) / 4));

      if (newZoom === oldZoom) return;

      // Current stage dimensions (at oldZoom)
      const { width: oldWidth, height: oldHeight } = calculateStageDimensions();

      if (oldWidth <= 0 || oldHeight <= 0) {
        setPreviewZoom(newZoom);
        return;
      }

      setPreviewZoom(newZoom);

      // Formula: pan.new = pan.old + mousePosFromCenter * (viewportSize / stageSize) * (1 - oldZoom / newZoom)
      setPan((prev) => ({
        x: prev.x + vx * (rect.width / oldWidth) * (1 - oldZoom / newZoom),
        y: prev.y + vy * (rect.height / oldHeight) * (1 - oldZoom / newZoom),
      }));
    },
    [previewZoom, calculateStageDimensions, minZoom, maxZoom],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 1) {
        dragStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          initialPan: { ...pan },
        };
        setIsDragging(true);
      }
    },
    [pan],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only drag with left mouse button (0)
      // Safe to allow during export as it only affects CSS preview transform
      if (e.button !== 0) return;

      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        initialPan: { ...pan },
      };
      setIsDragging(true);
    },
    [pan],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging || !dragStartRef.current || e.touches.length !== 1) return;

      const deltaX = e.touches[0].clientX - dragStartRef.current.x;
      const deltaY = e.touches[0].clientY - dragStartRef.current.y;

      const stageDims = calculateStageDimensions();
      if (stageDims.width <= 0 || stageDims.height <= 0) return;

      const panDeltaX = deltaX / stageDims.width;
      const panDeltaY = deltaY / stageDims.height;

      setPan({
        x: dragStartRef.current.initialPan.x - panDeltaX,
        y: dragStartRef.current.initialPan.y - panDeltaY,
      });
    },
    [isDragging, calculateStageDimensions],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !dragStartRef.current) return;

      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      const stageDims = calculateStageDimensions();
      if (stageDims.width <= 0 || stageDims.height <= 0) return;

      const panDeltaX = deltaX / stageDims.width;
      const panDeltaY = deltaY / stageDims.height;

      setPan({
        x: dragStartRef.current.initialPan.x - panDeltaX,
        y: dragStartRef.current.initialPan.y - panDeltaY,
      });
    },
    [isDragging, calculateStageDimensions],
  );

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  const handleSeekBackward = useCallback(
    (seconds: number) => {
      const current = timeStore.getState().currentTime;
      if (
        selectionRange &&
        (current < selectionRange.start - 0.001 || current > selectionRange.end + 0.001)
      ) {
        handleSeek(selectionRange.start);
        return;
      }
      const minTime = selectionRange ? selectionRange.start : 0;
      handleSeek(Math.max(minTime, current - seconds));
    },
    [selectionRange, handleSeek],
  );

  const handleSeekForward = useCallback(
    (seconds: number) => {
      const current = timeStore.getState().currentTime;
      if (
        selectionRange &&
        (current < selectionRange.start - 0.001 || current > selectionRange.end + 0.001)
      ) {
        handleSeek(selectionRange.start);
        return;
      }
      const maxTime = selectionRange ? selectionRange.end : duration;
      handleSeek(Math.min(maxTime, current + seconds));
    },
    [selectionRange, duration, handleSeek],
  );

  const handlePreviousTrack = useCallback(() => {
    const current = timeStore.getState().currentTime;
    if (selectionRange) {
      if (current < selectionRange.start - 0.001 || current > selectionRange.end + 0.001) {
        handleSeek(selectionRange.start);
      } else {
        handleSeek(selectionRange.start);
      }
      return;
    }

    // If there's only one track, always rewind to beginning
    if (tracks.length <= 1) {
      handleSeek(0);
      return;
    }

    if (currentTime < 1) {
      selectPreviousTrack();
    } else {
      handleSeek(0);
    }
  }, [selectionRange, currentTime, handleSeek, selectPreviousTrack, tracks.length]);

  const handleNextTrack = useCallback(() => {
    const current = timeStore.getState().currentTime;
    if (selectionRange) {
      if (current < selectionRange.start - 0.001 || current > selectionRange.end + 0.001) {
        handleSeek(selectionRange.start);
      } else {
        handleSeek(selectionRange.end);
      }
      return;
    }

    const currentIndex = tracks.findIndex((t) => t.id === selectedTrackId);
    if (currentIndex === tracks.length - 1) {
      handleSeek(duration);
    } else {
      selectNextTrack();
    }
  }, [selectionRange, tracks, selectedTrackId, duration, handleSeek, selectNextTrack]);

  const handlePreviousKeyframe = useCallback(() => {
    if (!selectedTrack?.keyframes?.length) return;
    const sorted = [...selectedTrack.keyframes].sort((a, b) => a.time - b.time);
    const prev = sorted.reverse().find((kf) => kf.time < currentTime - 0.05);
    if (prev) {
      handleSeek(prev.time);
    } else {
      handleSeek(0);
    }
  }, [selectedTrack, currentTime, handleSeek]);

  const handleNextKeyframe = useCallback(() => {
    if (!selectedTrack?.keyframes?.length) return;
    const sorted = [...selectedTrack.keyframes].sort((a, b) => a.time - b.time);
    const next = sorted.find((kf) => kf.time > currentTime + 0.05);
    if (next) {
      handleSeek(next.time);
    }
  }, [selectedTrack, currentTime, handleSeek]);

  useGlobalKeyboardShortcuts({
    onPlayPause: handlePlayPause,
    onSeekBackward: handleSeekBackward,
    onSeekForward: handleSeekForward,
    onPreviousKeyframe: handlePreviousKeyframe,
    onNextKeyframe: handleNextKeyframe,
    onPreviousTrack: handlePreviousTrack,
    onNextTrack: handleNextTrack,
    disabled: isExporting || isSavingToIDB,
  });

  // Container sizing
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Reset zoom to 100% when export starts
  // The exportScale handles fitting the high-res canvas within the container
  useEffect(() => {
    if (isExporting) {
      setPreviewZoom(1);
      setPan({ x: 0, y: 0 });
      if (isMobile) {
        setMobileView('stage');
      }
    }
  }, [isExporting, isMobile]);

  const { width: exportWidth, height: exportHeight } = calcDimensions(exportQuality, exportAspect);

  const renderStageCanvas = useCallback(
    (isFullScreen: boolean) => {
      const { width: finalW, height: finalH } = calculateStageDimensions(isFullScreen);

      if (finalW <= 0 || finalH <= 0) {
        return null;
      }

      return (
        <div
          style={{
            width: finalW,
            height: finalH,
            position: 'relative',
            boxShadow: isFullScreen
              ? 'none'
              : '0 0 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)',
            transition: isExporting ? 'none' : 'all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
            transform: isFullScreen ? 'none' : `translate(${pan.x * -100}%, ${pan.y * -100}%)`,
            overflow: 'hidden',
            borderRadius: isFullScreen ? '0' : 'var(--radius-lg)',
          }}
        >
          <div
            style={{
              width: exportWidth,
              height: exportHeight,
              transformOrigin: 'top left',
              transform: `scale(${finalW / exportWidth})`,
            }}
          >
            {(() => {
              return webGPUSupported === null ? (
                <div className="flex items-center justify-center w-full h-full text-zinc-500 bg-zinc-900/50">
                  Detecting hardware acceleration...
                </div>
              ) : webGPUSupported === false ? (
                <CenterStage
                  isPlaying={isPlaying}
                  backgroundImage={baseTrackBackground}
                  effectsConfig={effectsConfig}
                  isExporting={isExporting}
                  currentTrackId={selectedTrackId || undefined}
                />
              ) : (
                <GPUCanvas
                  key={`stage-${exportAspect}`}
                  ref={centerStageRef}
                  onInitializationError={handleGPUInitializationError}
                />
              );
            })()}
          </div>
          {/* Lyrics — rendered via Canvas2D → WebGPU composite (unified engine) */}
          <LyricsCanvas
            lyrics={lyrics}
            theme={baseTrackTheme}
            verticalPosition={verticalPosition}
            fontUrl={getFontUrl(selectedFontId)}
            effectScope={effectScope}
            fadeInDuration={fadeInDuration}
            fadeOutDuration={fadeOutDuration}
            trackTitle={selectedTrack?.name}
            trackTitleConfig={effectsConfig?.trackTitle}
            trackTitleFontUrl={getFontUrl(effectsConfig?.trackTitle?.fontId || 'roboto')}
            gpuCanvasRef={centerStageRef}
            canvasWidth={exportWidth}
            canvasHeight={exportHeight}
          />
          {/* Optional branded watermark overlay (Export tab toggle) */}
          <PreviewWatermark />
        </div>
      );
    },
    [
      calculateStageDimensions,
      exportWidth,
      exportHeight,
      selectedFontId,
      isExporting,
      pan,
      webGPUSupported,
      isPlaying,
      lyrics,
      baseTrackTheme,
      baseTrackBackground,
      verticalPosition,
      effectsConfig,
      effectScope,
      fadeInDuration,
      fadeOutDuration,
      selectedTrack,
      selectedTrackId,
      exportAspect,
      handleGPUInitializationError,
    ],
  );

  const handleSaveProject = useCallback(async () => {
    try {
      const { exportProject: doExport } = await import('@/utils/projectExport');

      doExport(
        tracks,
        effectsConfig,
        {
          fontSize,
          fontId: selectedFontId,
          colors: lyricColors,
          verticalPosition,
          effectScope,
          wordSpacing,
          glowEnabled,
          glowColor,
          glowIntensity,
          outlineColor,
          fadeInDuration,
          fadeOutDuration,
          highlightFadeIn,
          highlightFadeOut,
        },
        {
          type: animationType,
          stagger: animationStagger,
          activeScale: activeScaleEnabled,
        },
        settings,
        {
          quality: exportQuality,
          aspect: exportAspect,
          bitrate: exportBitrate,
        },
        {
          projectName: selectedTrack?.name || 'Threnic Project',
        },
      );
    } catch (error) {
      console.error('Failed to export project:', error);
      alert(
        `Failed to export project: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }, [
    tracks,
    effectsConfig,
    fontSize,
    selectedFontId,
    lyricColors,
    verticalPosition,
    effectScope,
    wordSpacing,
    glowEnabled,
    glowColor,
    glowIntensity,
    outlineColor,
    fadeInDuration,
    fadeOutDuration,
    highlightFadeIn,
    highlightFadeOut,
    animationType,
    animationStagger,
    activeScaleEnabled,
    settings,
    exportQuality,
    exportAspect,
    exportBitrate,
    selectedTrack,
  ]);

  // Apply panel opacity to document root so it can be accessed by all panel CSS
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-opacity', panelOpacity.toString());
  }, [panelOpacity]);

  // Fullscreen Preview keydown listener (Escape key)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreenPreview) {
        setIsFullscreenPreview(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreenPreview]);

  // Fullscreen Preview window resize listener
  useEffect(() => {
    if (!isFullscreenPreview) return;
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isFullscreenPreview]);

  // Fullscreen Preview auto-hide controls timer
  useEffect(() => {
    if (!isFullscreenPreview) {
      setShowFullscreenControls(false);
      return;
    }

    // Show initially
    setShowFullscreenControls(true);

    let hideTimeout: NodeJS.Timeout;

    const resetHideTimeout = () => {
      setShowFullscreenControls(true);
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        setShowFullscreenControls(false);
      }, 3000);
    };

    window.addEventListener('mousemove', resetHideTimeout);
    window.addEventListener('touchstart', resetHideTimeout);

    resetHideTimeout();

    return () => {
      clearTimeout(hideTimeout);
      window.removeEventListener('mousemove', resetHideTimeout);
      window.removeEventListener('touchstart', resetHideTimeout);
    };
  }, [isFullscreenPreview]);

  return (
    <>
      {/* WaveformVisualizer moved inside CenterStage for full canvas integration */}
      {/* Audio element (invisible) */}
      <AudioPlayer
        ref={audioPlayerRef}
        src={audioUrl}
        isPlaying={isPlaying}
        playbackRate={playbackRate}
        onDurationChange={handleDurationChange}
        onEnded={handleEnded}
        onAudioBuffer={handleAudioBuffer}
      />

      <AppShell
        header={<Header projectName={selectedTrack?.name} />}
        leftPanel={
          <PlaylistBrowser
            onSelectTrack={selectTrack}
            audioElementRef={audioPlayerRef}
            disabled={isExporting || isSavingToIDB}
            words={words}
            setWords={setWords}
          />
        }
        rightPanel={
          <Inspector
            centerStageRef={centerStageRef}
            exportSupported={exportSupported}
            verticalPosition={verticalPosition}
            onVerticalPositionChange={setVerticalPosition}
            horizontalPosition={horizontalPosition}
            onHorizontalPositionChange={setHorizontalPosition}
            wrapWidth={wrapWidth}
            onWrapWidthChange={setWrapWidth}
            fontSize={fontSize}
            onFontSizeChange={setFontSize}
            effectsConfig={effectsConfig}
            onEffectsConfigChange={handleEffectsChange}
            animationType={animationType}
            onAnimationTypeChange={setAnimationType}
            animationStagger={animationStagger}
            onAnimationStaggerChange={setAnimationStagger}
            activeScaleEnabled={activeScaleEnabled}
            glowEnabled={glowEnabled}
            onGlowEnabledChange={setGlowEnabled}
            glowColor={glowColor}
            onGlowColorChange={setGlowColor}
            glowIntensity={glowIntensity}
            onGlowIntensityChange={setGlowIntensity}
            outlineColor={outlineColor}
            onOutlineColorChange={setOutlineColor}
            fadeInDuration={fadeInDuration}
            onFadeInDurationChange={setFadeInDuration}
            fadeOutDuration={fadeOutDuration}
            onFadeOutDurationChange={setFadeOutDuration}
            selectedFontId={selectedFontId}
            onFontChange={handleFontChange}
            wordSpacing={wordSpacing}
            onWordSpacingChange={setWordSpacing}
            lineSpacing={lineSpacing}
            onLineSpacingChange={setLineSpacing}
            highlightFadeIn={highlightFadeIn}
            highlightFadeOut={highlightFadeOut}
            lyricColors={lyricColors}
            onLyricColorsChange={setLyricColors}
            exportQuality={exportQuality}
            onExportQualityChange={setExportQuality}
            exportAspect={exportAspect}
            onExportAspectChange={setExportAspect}
            exportBitrate={exportBitrate}
            onExportBitrateChange={setExportBitrate}
            disabled={isExporting}
            onSaveProject={handleSaveProject}
            audioElementRef={audioPlayerRef}
            words={words}
            setWords={setWords}
            selectionRange={activeSelectionRange}
            onSelectionRangeChange={config.mode === 'selection' ? setSelectionRange : undefined}
            keyframes={keyframes}
            onKeyframesChange={setKeyframes}
            currentTime={currentTime}
            updateTrackProperty={updateTrackProperty}
            updateTrackEffectInstance={updateTrackEffectInstance}
          />
        }
        centerStage={
          isFullscreenPreview ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                height: '100%',
                color: 'var(--text-muted)',
                fontSize: '13px',
                fontFamily: 'Inter, sans-serif',
              }}
            >
              Previewing on full screen...
            </div>
          ) : (
            <div
              ref={containerRef}
              onWheel={handleWheelZoom}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'var(--bg-app)',
                position: 'relative',
                overflow: 'hidden',
                cursor: isDragging ? 'grabbing' : 'grab',
              }}
            >
              {(!isMobile || mobileView === 'stage') && (
                <ViewportControls
                  previewZoom={previewZoom}
                  setPreviewZoom={setPreviewZoom}
                  setPan={setPan}
                  exportAspect={exportAspect}
                  setExportAspect={setExportAspect}
                  isExporting={isExporting}
                  minZoom={minZoom}
                  maxZoom={maxZoom}
                  onMaximize={() => setIsFullscreenPreview(true)}
                />
              )}
              {renderStageCanvas(false)}
            </div>
          )
        }
        overlays={
          <>
            {/* HUD layer for lyrics */}
            {/* Minimap removed as per user request */}
            {isMobile && isExporting && <ExportProgressWidget />}
          </>
        }
        activeMobileView={mobileView}
        onActiveMobileViewChange={setMobileView}
        isExporting={isExporting}
        mobileTimelineExpanded={mobileTimelineExpanded}
        timeline={
          isMobile && mobileView === 'stage' && !mobileTimelineExpanded && !isExporting ? (
            <MobilePlayerBar
              duration={duration}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              onSeek={handleSeek}
              onPreviousTrack={handlePreviousTrack}
              onNextTrack={handleNextTrack}
              isLastTrack={tracks.findIndex((t) => t.id === selectedTrackId) === tracks.length - 1}
              disabled={isExporting}
              timelineExpanded={mobileTimelineExpanded}
              onToggleTimeline={() => setMobileTimelineExpanded((v) => !v)}
              audioElementRef={audioPlayerRef}
              trackTitle={selectedTrack?.name}
            />
          ) : (
            <>
              {isMobile && mobileView === 'stage' && mobileTimelineExpanded && !isExporting && (
                <button
                  className="mobileTimelineCollapseBtn"
                  onClick={() => setMobileTimelineExpanded(false)}
                  aria-label="Collapse timeline"
                >
                  <ChevronDown size={18} />
                  <span>Collapse</span>
                </button>
              )}
              <BottomPanel
                duration={duration}
                isPlaying={isPlaying}
                playbackRate={playbackRate}
                onPlayPause={handlePlayPause}
                onSeek={handleSeek}
                onPlaybackRateChange={setPlaybackRate}
                audioBuffer={audioBuffer}
                disabled={isExporting}
                isLastTrack={
                  tracks.findIndex((t) => t.id === selectedTrackId) === tracks.length - 1
                }
                onNextTrack={selectNextTrack}
                onPreviousTrack={selectPreviousTrack}
                onNextKeyframe={handleNextKeyframe}
                words={words}
                setWords={setWords}
                audioElementRef={audioPlayerRef}
                keyframes={keyframes}
                setKeyframes={setKeyframes}
                videoClips={videoClips}
                setVideoClips={handleVideoClipsUpdate}
                selectedTrackId={selectedTrackId}
                updateTrackKeyframes={updateTrackKeyframes}
              />
            </>
          )
        }
      />

      {isFullscreenPreview && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 99999,
            backgroundColor: '#000000',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {/* Click catcher to toggle HUD controls */}
          <div
            onClick={() => setShowFullscreenControls((s) => !s)}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 40,
              background: 'transparent',
              cursor: 'pointer',
            }}
          />

          {renderStageCanvas(true)}

          {showFullscreenControls && (
            <>
              {/* Top Right Close Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsFullscreenPreview(false);
                }}
                style={{
                  position: 'absolute',
                  top: '20px',
                  right: '20px',
                  zIndex: 50,
                  background: 'rgba(5, 5, 8, 0.75)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  color: '#94a3b8',
                  width: '44px',
                  height: '44px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  backdropFilter: 'blur(8px)',
                  boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = '#ef4444';
                  (e.currentTarget as HTMLButtonElement).style.color = '#fff';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor =
                    'rgba(255, 255, 255, 0.08)';
                  (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8';
                }}
              >
                <X size={20} />
              </button>

              {/* Bottom Controls Panel */}
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  bottom: '24px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 'calc(100% - 48px)',
                  maxWidth: '800px',
                  zIndex: 50,
                  background: 'rgba(5, 5, 8, 0.85)',
                  backdropFilter: 'blur(12px)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: '16px',
                  padding: '16px 24px',
                  boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                {/* 1. Timeline Progress Bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
                  <input
                    type="range"
                    min={0}
                    max={duration || 100}
                    step={0.02}
                    value={currentTime}
                    onChange={(e) => handleSeek(parseFloat(e.target.value))}
                    style={{
                      flexGrow: 1,
                      height: '6px',
                      borderRadius: '3px',
                      accentColor: '#10b981', // Neon emerald
                      background: 'rgba(255, 255, 255, 0.12)',
                      cursor: 'pointer',
                      outline: 'none',
                    }}
                  />
                </div>

                {/* 2. Controls Row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                  }}
                >
                  {/* Play/Pause & Time */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <button
                      onClick={handlePlayPause}
                      style={{
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        color: '#fff',
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                      }}
                    >
                      {isPlaying ? (
                        <Pause size={18} />
                      ) : (
                        <Play size={18} style={{ transform: 'translateX(1px)' }} />
                      )}
                    </button>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span
                        style={{
                          fontSize: '12px',
                          fontFamily: 'monospace',
                          color: '#fff',
                          letterSpacing: '0.05em',
                        }}
                      >
                        {formatTime(currentTime)}
                      </span>
                      <span
                        style={{
                          fontSize: '10px',
                          fontFamily: 'monospace',
                          color: 'rgba(255,255,255,0.4)',
                        }}
                      >
                        {formatTime(duration)}
                      </span>
                    </div>
                  </div>

                  {/* Alignment Selector (Vertical / Horizontal) */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      padding: '4px',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <button
                      onClick={() => setExportAspect('Landscape')}
                      style={{
                        background: exportAspect === 'Landscape' ? '#10b981' : 'transparent',
                        color: exportAspect === 'Landscape' ? '#000' : 'rgba(255, 255, 255, 0.6)',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'all 0.2s',
                      }}
                    >
                      <Monitor size={12} />
                      Horizontal
                    </button>
                    <button
                      onClick={() => setExportAspect('Portrait')}
                      style={{
                        background: exportAspect === 'Portrait' ? '#10b981' : 'transparent',
                        color: exportAspect === 'Portrait' ? '#000' : 'rgba(255, 255, 255, 0.6)',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'all 0.2s',
                      }}
                    >
                      <Smartphone size={12} />
                      Vertical
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

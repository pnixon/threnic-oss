import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Music, Diamond, Zap, List, Type, Plus, Info } from 'lucide-react';
import { ExportTab } from './tabs/ExportTab/ExportTab';
import { KeyframeDropdown } from './KeyframeDropdown';
import styles from './Inspector.module.css';
import { CollapsibleSection } from './CollapsibleSection';
import type { Keyframe } from '@/types/keyframes';
import { TrackTitleSection } from './tabs/LyricsTab/TrackTitleSection';
import { useMediaQuery } from '@/hooks';
import { LyricSyncSection } from './tabs/LyricsTab/LyricSyncSection';
import { EffectsSettingsSection } from './tabs/EffectsTab/EffectsSettingsSection';
import { EffectsSummarySection } from './tabs/EffectsTab/EffectsSummarySection';
import { LyricSettingsSection } from './tabs/LyricsTab/LyricSettingsSection';
import { LyricFXSection } from './tabs/LyricsTab/LyricFXSection';
import type { LyricEffectInstance } from '@/types/effects/lyric-fx';

import { QualityKey, AspectKey, BitrateKey } from '@/types/exportConstants';

import type { EffectsConfig } from '@/types/effects';
import { FONTS } from '@/constants/fonts';
import {
  usePlaylistState,
  usePlaylistSettingsAPI,
  useTrackConfigAPI,
} from '@/contexts/PlaylistContext';
import { usePanels, useKeyframeSelection } from '@/contexts';
import type { LyricTheme, ThrenicWord, LyricLineData, LineStyleOverride } from '@/types/lyrics';
import type { GPUCanvasRef } from '@/components/stage/GPUCanvas';
import { loadLyricsFromFile } from '@/engine/lyrics/loader';
import { lyricLinesToThrenicWords } from '@/types/lyrics';
import { LyricSyncPanel } from '@/components/lyrics-sync/LyricSyncPanel';
import { useScheduleAwareEffectsConfigUI } from '@/components/stage/hooks/useScheduleAware';
import { createKeyframe } from '@/types/keyframes';
import { uiToEngineAnimationType, uiToEngineStagger } from '@/engine/lyrics/animationMap';
import { timeStore } from '@/engine/stores/timeStore';

/**
 * A high-performance time label for the Add Keyframe button
 * that updates via setTimeout to stay in sync with the engine without blocking the main thread.
 */
function KeyframeTimeLabel() {
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let timeoutId: number;
    const update = () => {
      if (spanRef.current) {
        const time = timeStore.getState().currentTime;
        const timeStr = `${time.toFixed(2)}s`;
        if (spanRef.current.textContent !== timeStr) {
          spanRef.current.textContent = timeStr;
        }
      }
      timeoutId = window.setTimeout(update, 50);
    };
    update();
    return () => window.clearTimeout(timeoutId);
  }, []);

  return <span ref={spanRef}>0.00s</span>;
}

// Map band to CSS class names for toggle meters
interface ExportSettings {
  width: number;
  height: number;
  fps: number;
}

interface InspectorProps {
  /** Lyric colors: pre (upcoming), active, post (passed) */
  lyricColors?: { pre: string; active: string; post: string };
  /** Callback when lyric colors change */
  onLyricColorsChange?: (colors: { pre: string; active: string; post: string }) => void;
  /** Whether export is supported */
  exportSupported?: boolean;
  /** Vertical position of lyrics (0-100) */
  verticalPosition?: number;
  /** Callback when position changes */
  onVerticalPositionChange?: (position: number) => void;
  /** Horizontal anchor of lyric rows */
  horizontalPosition?: 'left' | 'center' | 'right';
  /** Callback when horizontal anchor changes */
  onHorizontalPositionChange?: (position: 'left' | 'center' | 'right') => void;
  /** Auto-wrap column width as a percentage of canvas width (10-100) */
  wrapWidth?: number;
  /** Callback when wrap width changes */
  onWrapWidthChange?: (width: number) => void;
  /** Font size scaling factor */
  fontSize?: number;
  /** Callback when font size changes */
  onFontSizeChange?: (size: number) => void;
  /** Word spacing multiplier */
  wordSpacing?: number;
  /** Callback when word spacing changes */
  onWordSpacingChange?: (spacing: number) => void;
  /** Line spacing (vertical) multiplier */
  lineSpacing?: number;
  /** Callback when line spacing changes */
  onLineSpacingChange?: (spacing: number) => void;
  /** Effects configuration */
  effectsConfig?: EffectsConfig;
  /** Callback when effects config changes */
  onEffectsConfigChange?: (config: EffectsConfig) => void;

  // Animation Props
  animationType?: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter';
  onAnimationTypeChange?: (
    type: 'none' | 'fadeIn' | 'flyIn' | 'slideUp' | 'popIn' | 'typewriter',
  ) => void;
  animationStagger?: 'letter' | 'word' | 'line';
  onAnimationStaggerChange?: (stagger: 'letter' | 'word' | 'line') => void;
  activeScaleEnabled?: boolean;

  // Glow
  glowEnabled?: boolean;
  onGlowEnabledChange?: (enabled: boolean) => void;
  glowColor?: string;
  onGlowColorChange?: (color: string) => void;
  glowIntensity?: number;
  onGlowIntensityChange?: (intensity: number) => void;

  // Outline
  outlineColor?: string;
  onOutlineColorChange?: (color: string) => void;

  // Timing
  fadeInDuration?: number;
  onFadeInDurationChange?: (duration: number) => void;
  fadeOutDuration?: number;
  onFadeOutDurationChange?: (duration: number) => void;
  highlightFadeIn?: number;
  highlightFadeOut?: number;

  // Font selection
  selectedFontId?: string;
  onFontChange?: (fontId: string) => void;

  // Ref passed for export access
  centerStageRef?: React.RefObject<GPUCanvasRef | null>;

  // Export props
  onExport?: (settings: ExportSettings) => void;
  isExporting?: boolean;

  // Export State
  exportQuality?: QualityKey;
  onExportQualityChange?: (quality: QualityKey) => void;
  exportAspect?: AspectKey;
  onExportAspectChange?: (aspect: AspectKey) => void;
  exportBitrate?: BitrateKey;
  onExportBitrateChange?: (bitrate: BitrateKey) => void;
  /** Disable all interactions */
  disabled?: boolean;
  /** Callback to save project JSON */
  onSaveProject?: () => void;

  /** Audio element ref for sync panel */
  audioElementRef?: React.RefObject<HTMLAudioElement | null>;
  /** Shared words state */
  words?: ThrenicWord[];
  setWords?: (words: ThrenicWord[] | ((prev: ThrenicWord[]) => ThrenicWord[])) => void;
  /** Selection range for export and preview */
  selectionRange?: { start: number; end: number } | null;
  onSelectionRangeChange?: (range: { start: number; end: number } | null) => void;
  // Keyframes
  keyframes?: Keyframe[];
  onKeyframesChange?: (keyframes: Keyframe[]) => void;
  currentTime?: number;
  // Option 2 props
  selectedTrackId?: string | null;
  selectedKeyframeId?: string;
  updateTrackProperty?: (
    trackId: string,
    property: string,
    value: unknown,
    keyframeId?: string,
  ) => void;
  updateTrackEffectInstance?: (
    trackId: string,
    instanceId: string,
    config: unknown,
    keyframeId?: string,
  ) => void;
}

/**
 * Inspector - Multi-tab inspector with collapsible sections
 */
export function Inspector({
  lyricColors = { pre: '#666666', active: '#ef4444', post: '#444444' },
  onLyricColorsChange,
  verticalPosition = 50,
  onVerticalPositionChange,
  horizontalPosition = 'center',
  onHorizontalPositionChange,
  wrapWidth = 90,
  onWrapWidthChange,
  fontSize = 0.25,
  onFontSizeChange,
  wordSpacing = 1.0,
  onWordSpacingChange,
  lineSpacing = 1.35,
  onLineSpacingChange,
  effectsConfig,
  onEffectsConfigChange,
  animationType = 'fadeIn',
  onAnimationTypeChange,
  animationStagger = 'word',
  onAnimationStaggerChange,
  activeScaleEnabled = true,
  glowEnabled = true,
  onGlowEnabledChange,
  glowColor = '#ef4444',
  onGlowColorChange,
  glowIntensity = 0.5,
  onGlowIntensityChange,
  outlineColor = '#000000',
  onOutlineColorChange,
  fadeInDuration = 1.0,
  onFadeInDurationChange,
  fadeOutDuration = 1.0,
  onFadeOutDurationChange,
  highlightFadeIn = 0.2,
  highlightFadeOut = 0.5,
  selectedFontId = 'roboto',
  onFontChange,
  centerStageRef,
  exportQuality = 'High',
  onExportQualityChange,
  exportAspect = 'Landscape',
  onExportAspectChange,
  exportBitrate = 'Medium',
  onExportBitrateChange,
  disabled,
  audioElementRef,
  words,
  setWords,
  selectionRange,
  onSelectionRangeChange,
  keyframes = [],
  onKeyframesChange,
  currentTime = 0,
  selectedTrackId: selectedTrackIdProp,
  selectedKeyframeId: selectedKeyframeIdProp,
  updateTrackProperty: updateTrackPropertyProp,
  updateTrackEffectInstance: updateTrackEffectInstanceProp,
}: InspectorProps) {
  const { setRightCollapsed } = usePanels();
  const lyricsInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const [canScrollUp, setCanScrollUp] = useState(false);

  const lastCanScrollDown = useRef(false);
  const lastCanScrollUp = useRef(false);
  const scrollCheckFrame = useRef<number>(0);

  const checkScroll = useCallback(() => {
    if (scrollCheckFrame.current) {
      cancelAnimationFrame(scrollCheckFrame.current);
    }

    scrollCheckFrame.current = requestAnimationFrame(() => {
      const el = scrollContainerRef.current;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;

      // Show indicator if there's more content below (with 2px buffer/tolerance)
      const canDown = scrollHeight > clientHeight + scrollTop + 2;
      // Show indicator if scrolled down
      const canUp = scrollTop > 0;

      if (canDown !== lastCanScrollDown.current) {
        lastCanScrollDown.current = canDown;
        setCanScrollDown(canDown);
      }
      if (canUp !== lastCanScrollUp.current) {
        lastCanScrollUp.current = canUp;
        setCanScrollUp(canUp);
      }
      scrollCheckFrame.current = 0;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (scrollCheckFrame.current) {
        cancelAnimationFrame(scrollCheckFrame.current);
      }
    };
  }, []);

  const { selectedTrackId: selectedTrackIdCtx, tracks } = usePlaylistState();
  const { applyEffectsToAll, applyThemeToAll, applyTrackTitleToAll } = usePlaylistSettingsAPI();
  const {
    updateTrackLyrics,
    updateTrackLyricsTheme,
    updateTrackProperty: updateTrackPropertyCtx,
    updateTrackEffectInstance: updateTrackEffectInstanceCtx,
    addTrackKeyframe,
  } = useTrackConfigAPI();

  const {
    selectedKeyframeId: selectedKeyframeIdCtx,
    setSelectedKeyframeId: setSelectedKeyframeIdCtx,
    setKeyframes: syncKeyframes,
    setActiveLane,
  } = useKeyframeSelection();

  const selectedTrackId =
    selectedTrackIdProp !== undefined ? selectedTrackIdProp : selectedTrackIdCtx;
  const selectedKeyframeId =
    selectedKeyframeIdProp !== undefined ? selectedKeyframeIdProp : selectedKeyframeIdCtx;
  const updateTrackProperty = updateTrackPropertyProp ?? updateTrackPropertyCtx;
  const updateTrackEffectInstance = updateTrackEffectInstanceProp ?? updateTrackEffectInstanceCtx;

  const [activeTab, setActiveTab] = useState<'lyrics' | 'effects' | 'export'>('effects');

  // Single-open accordion state for the Lyrics tab sections. Only one of the
  // top-level lyric panels (keyframe selector / styling / content & sync /
  // track title) is expanded at a time — matching the Effects tab accordion.
  type LyricsSectionId = 'keyframes' | 'styling' | 'content' | 'lyricfx' | 'title';
  const [openLyricsSection, setOpenLyricsSection] = useState<LyricsSectionId>('styling');
  const toggleLyricsSection = useCallback((id: LyricsSectionId) => {
    setOpenLyricsSection((cur) => (cur === id ? ('' as LyricsSectionId) : id));
  }, []);

  // When the Lyrics tab is opened, auto-open a valid first section if none is
  // expanded: Styling (Appearance) when lyrics exist, otherwise Content & Sync
  // (Styling isn't rendered without lyrics, so it can't be the mobile default).
  useEffect(() => {
    if (activeTab !== 'lyrics') return;
    const track = tracks.find((t) => t.id === selectedTrackId);
    const trackHasLyrics = Boolean(track?.lyricsData && track.lyricsData.length > 0);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenLyricsSection((cur) => (cur ? cur : trackHasLyrics ? 'styling' : 'content'));
  }, [activeTab, tracks, selectedTrackId]);

  // Single-open accordion state for the Effects tab sections.
  type EffectsSectionId = 'keyframes' | 'effects' | 'summary';
  const [openEffectsSection, setOpenEffectsSection] = useState<EffectsSectionId>('effects');
  const toggleEffectsSection = useCallback((id: EffectsSectionId) => {
    setOpenEffectsSection((cur) => (cur === id ? ('' as EffectsSectionId) : id));
  }, []);

  // Sync activeLane with activeTab
  useEffect(() => {
    let lane: 'background' | 'effects' | 'lyrics' | null = null;
    if (activeTab === 'lyrics') {
      lane = 'lyrics';
    } else if (activeTab === 'effects') {
      lane = 'effects';
    }
    setActiveLane(lane);
  }, [activeTab, setActiveLane]);

  useEffect(() => {
    const handleSwitchTab = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        setActiveTab(customEvent.detail);
        setRightCollapsed(false);
      }
    };
    window.addEventListener('switch-inspector-tab', handleSwitchTab);
    return () => window.removeEventListener('switch-inspector-tab', handleSwitchTab);
  }, [setRightCollapsed]);

  const handleAddKeyframe = useCallback(() => {
    if (!selectedTrackId) return;
    const time = timeStore.getState().currentTime;

    let lane: 'background' | 'effects' | 'lyrics' | undefined;
    if (activeTab === 'lyrics') {
      lane = 'lyrics';
    } else if (activeTab === 'effects') {
      lane = 'effects';
    }

    const newKf = createKeyframe(time, {}, lane);
    addTrackKeyframe(selectedTrackId, newKf);
    setSelectedKeyframeIdCtx(newKf.id);
  }, [selectedTrackId, addTrackKeyframe, setSelectedKeyframeIdCtx, activeTab]);

  // Sync keyframes to selection context
  useEffect(() => {
    syncKeyframes(keyframes);
  }, [keyframes, syncKeyframes]);

  const scheduledEffectsConfig = useScheduleAwareEffectsConfigUI(effectsConfig);
  // When editing the 'default' keyframe (no active keyframe interpolation), prefer
  // the React-state effectsConfig over the frame-loop computedConfig. The frame-loop
  // version can lag by up to one RAF cycle, causing stale closures that silently drop
  // newly added effect instances.
  const liveEffectsConfig =
    !selectedKeyframeId || selectedKeyframeId === 'default'
      ? effectsConfig
      : (scheduledEffectsConfig ?? effectsConfig);
  // Optional: if you want the lyrics sliders to also move during playback:
  // const liveTheme = useScheduleAwareThemeUI(themeObject);

  // Use ref to track current selected track ID to avoid stale closures during rapid track switching
  const selectedTrackIdRef = useRef(selectedTrackId);
  React.useEffect(() => {
    selectedTrackIdRef.current = selectedTrackId;
  }, [selectedTrackId]);

  // Panel width is fully controlled by CSS custom properties in globals.css.
  // No JS override needed — the responsive breakpoints handle all sizes.

  useEffect(() => {
    checkScroll();
    window.addEventListener('resize', checkScroll);

    // Observer for content changes
    const el = scrollContainerRef.current;
    if (!el) return () => window.removeEventListener('resize', checkScroll);

    const observer = new ResizeObserver(checkScroll);
    observer.observe(el);

    // Also observe mutations in subtree - helps when accordions open/close
    const mutationObserver = new MutationObserver(checkScroll);
    mutationObserver.observe(el, { childList: true, subtree: true, attributes: true });

    return () => {
      window.removeEventListener('resize', checkScroll);
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, [checkScroll, activeTab]);

  // Visual feedback states for "Apply to All"
  const [lyricsApplied, setLyricsApplied] = useState(false);
  const [effectsApplied, setEffectsApplied] = useState(false);
  const [titleApplied, setTitleApplied] = useState(false);

  const isMobile = useMediaQuery('(max-width: 768px)');

  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);

  const currentTrack = tracks.find((t) => t.id === selectedTrackId);
  const hasLyrics = Boolean(currentTrack?.lyricsData && currentTrack.lyricsData.length > 0);

  /** Shared selected lane index for the lyrics tab */
  const [selectedLane, setSelectedLane] = useState(-1);

  // When there's only 1 lane, auto-select lane 0 so edits target laneStyles[0]
  // (which is what the renderer reads via _resolveLaneStyle). Without this,
  // selectedLane stays -1 (base theme mode) and the renderer ignores base changes
  // whenever laneStyles[0] already has overrides.
  React.useEffect(() => {
    if (!currentTrack?.lyricsData) return;
    const theme = currentTrack.lyricsTheme ?? ({} as LyricTheme);
    const maxLane = currentTrack.lyricsData.reduce(
      (max, line) => Math.max(max, line.laneIndex ?? 0),
      0,
    );
    const laneCount = theme.laneCount ?? maxLane + 1;
    if (laneCount <= 1 && selectedLane === -1) {
      setSelectedLane(0);
    }
  }, [currentTrack?.lyricsData, currentTrack?.lyricsTheme, selectedLane]);

  // Handler for per-lane style changes
  const handleLaneStyleChange = useCallback(
    (laneIndex: number, style: LineStyleOverride | undefined) => {
      if (!selectedTrackId || !currentTrack) return;
      const currentTheme = currentTrack.lyricsTheme ?? ({} as LyricTheme);
      const existingLaneStyles = { ...(currentTheme.laneStyles ?? {}) };
      if (style) {
        existingLaneStyles[laneIndex] = style;
      } else {
        delete existingLaneStyles[laneIndex];
      }
      const hasAny = Object.keys(existingLaneStyles).length > 0;
      updateTrackLyricsTheme(selectedTrackId, {
        ...currentTheme,
        laneStyles: hasAny ? existingLaneStyles : undefined,
      } as LyricTheme);
    },
    [selectedTrackId, currentTrack, updateTrackLyricsTheme],
  );

  const handleImportLyrics = useCallback(() => {
    lyricsInputRef.current?.click();
  }, []);

  const handleLyricsFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !selectedTrackId) return;

      try {
        const lyrics = await loadLyricsFromFile(file);
        updateTrackLyrics(
          selectedTrackId,
          lyrics,
          (file as unknown as { path: string }).path || file.name,
        );

        // Update words state immediately
        if (setWords) {
          setWords(lyricLinesToThrenicWords(lyrics));
        }
      } catch (error) {
        console.error('Failed to load lyrics:', error);
      }
      e.target.value = '';
    },
    [selectedTrackId, updateTrackLyrics, setWords],
  );

  const handleSyncLyrics = useCallback(() => {
    setIsSyncModalOpen(true);
  }, []);

  const handleSyncComplete = useCallback(
    (lyrics: LyricLineData[]) => {
      // Use ref to get the current track ID to avoid stale closures during rapid track switching
      const currentTrackId = selectedTrackIdRef.current;
      if (currentTrackId) {
        updateTrackLyrics(currentTrackId, lyrics);
      }
      setIsSyncModalOpen(false);
    },
    [updateTrackLyrics],
  );

  const currentTheme = useMemo<LyricTheme>(() => {
    const fontDef = FONTS.find((f) => f.id === selectedFontId);
    // Read letterSpacing from the current track's persisted theme
    const trackLetterSpacing = currentTrack?.lyricsTheme?.letterSpacing ?? 0;
    return {
      fontId: selectedFontId,
      fontSize,
      wordSpacing,
      letterSpacing: trackLetterSpacing,
      verticalPosition,
      charWidth: fontDef?.charWidthMultiplier ?? 0.6,
      colors: {
        pre: lyricColors.pre,
        active: lyricColors.active,
        post: lyricColors.post,
      },
      colorPre: lyricColors.pre,
      colorActive: lyricColors.active,
      colorPost: lyricColors.post,

      // Animation
      animationIn: {
        type: uiToEngineAnimationType(animationType),
        granularity: uiToEngineStagger(animationStagger),
        duration: fadeInDuration,
        stagger: 0.1,
      },
      animationOut: {
        type: 'fade',
        granularity: uiToEngineStagger(animationStagger),
        duration: fadeOutDuration,
      },

      // Timing
      highlightFadeIn,
      highlightFadeOut,

      // Effects
      effect: 'none',
      audioReactive: false,
      glowEnabled,
      glowColor,
      glowIntensity,
      outlineColor,
      activeScale: activeScaleEnabled,
    };
  }, [
    selectedFontId,
    fontSize,
    wordSpacing,
    verticalPosition,
    lyricColors,
    animationType,
    animationStagger,
    fadeInDuration,
    fadeOutDuration,
    highlightFadeIn,
    highlightFadeOut,
    glowEnabled,
    glowColor,
    glowIntensity,
    outlineColor,
    activeScaleEnabled,
    currentTrack?.lyricsTheme?.letterSpacing,
  ]);

  const handleApplyLyricsToAll = () => {
    applyThemeToAll(currentTheme);
    setLyricsApplied(true);
    setTimeout(() => setLyricsApplied(false), 2000);
  };

  const handleApplyEffectsToAll = () => {
    if (!effectsConfig) return;
    applyEffectsToAll(effectsConfig);
    setEffectsApplied(true);
    setTimeout(() => setEffectsApplied(false), 2000);
  };

  const handleApplyTrackTitleToAll = () => {
    if (!effectsConfig?.trackTitle) return;
    applyTrackTitleToAll(effectsConfig.trackTitle);
    setTitleApplied(true);
    setTimeout(() => setTitleApplied(false), 2000);
  };

  /* Determine if panel should be disabled (prop or no track selected) */
  const isDisabled = disabled || !selectedTrackId;
  const showDisabledOverlay = isDisabled && activeTab !== 'export';

  return (
    <div
      className={`${styles.panel} ${showDisabledOverlay ? styles.disabled : ''}`}
      data-testid="right-panel-content"
      data-disabled={isDisabled ? 'true' : undefined}
    >
      {showDisabledOverlay && (
        <div className={styles.disabledOverlay}>
          <div className={styles.disabledMessage}>
            <Music size={16} />
            <span>Select a track to edit</span>
          </div>
        </div>
      )}

      {/* Content Area — flex row: content + vertical tab rail */}
      <div className={styles.contentWrapper}>
        {isMobile && (
          <div
            style={{
              width: 36,
              height: 4,
              backgroundColor: 'rgba(255, 255, 255, 0.15)',
              borderRadius: 2,
              margin: '8px auto 4px',
              flexShrink: 0,
            }}
          />
        )}
        {/* Horizontal Tab Rail — top edge */}
        <div
          className={styles.horizontalTabRail}
          style={{
            pointerEvents: isDisabled ? 'none' : 'auto',
            opacity: isDisabled ? 0.5 : 1,
          }}
        >
          <button
            className={`${styles.railTab} ${activeTab === 'lyrics' ? styles.railTabActive : ''}`}
            onClick={() => setActiveTab('lyrics')}
            data-testid="tab-lyrics"
            title="Lyrics"
          >
            <Type size={14} />
            <span className={styles.railTabLabel}>Lyrics</span>
          </button>
          <button
            className={`${styles.railTab} ${activeTab === 'effects' ? styles.railTabActive : ''}`}
            onClick={() => setActiveTab('effects')}
            data-testid="tab-effects"
            title="Effects"
          >
            <Zap size={14} />
            <span className={styles.railTabLabel}>Effects</span>
          </button>

          <button
            className={`${styles.railTab} ${activeTab === 'export' ? styles.railTabActive : ''}`}
            onClick={() => setActiveTab('export')}
            data-testid="tab-export"
            title="Export"
          >
            <Diamond size={14} />
            <span className={styles.railTabLabel}>Export</span>
          </button>
        </div>

        {/* Mobile section sub-tab strip — thin horizontal tabs under the main
            rail that switch between sections instead of stacking them as
            vertical accordions (saves mobile vertical space). Keyframe
            selectors are excluded (rendered persistently above their body). */}
        {isMobile && activeTab === 'lyrics' && (
          <div className={styles.subTabStrip} data-testid="lyrics-subtab-strip">
            {(hasLyrics
              ? ([
                  { id: 'keyframes' as const, label: 'Keys', icon: <Diamond size={16} /> },
                  { id: 'styling' as const, label: 'Styling', icon: <Type size={16} /> },
                  { id: 'content' as const, label: 'Lyrics', icon: <List size={16} /> },
                  { id: 'title' as const, label: 'Title', icon: <Type size={16} /> },
                ] as const)
              : ([
                  { id: 'keyframes' as const, label: 'Keys', icon: <Diamond size={16} /> },
                  { id: 'content' as const, label: 'Lyrics', icon: <List size={16} /> },
                  { id: 'title' as const, label: 'Title', icon: <Type size={16} /> },
                ] as const)
            ).map((s) => (
              <button
                key={s.id}
                type="button"
                className={`${styles.subTab} ${openLyricsSection === s.id ? styles.subTabActive : ''}`}
                onClick={() => setOpenLyricsSection(s.id)}
                data-testid={`lyrics-subtab-${s.id}`}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        )}
        {isMobile && activeTab === 'effects' && (
          <div className={styles.subTabStrip} data-testid="effects-subtab-strip">
            {[
              { id: 'keyframes' as const, label: 'Keys', icon: <Diamond size={16} /> },
              { id: 'effects' as const, label: 'Effects', icon: <Zap size={16} /> },
              { id: 'summary' as const, label: 'Summary', icon: <Info size={16} /> },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                className={`${styles.subTab} ${openEffectsSection === s.id ? styles.subTabActive : ''}`}
                onClick={() => setOpenEffectsSection(s.id)}
                data-testid={`effects-subtab-${s.id}`}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        )}

        <div className={styles.innerWrapper}>
          <div
            ref={scrollContainerRef}
            onScroll={checkScroll}
            className={`custom-scrollbar space-y-3 ${styles.scrollContainer}`}
            style={{
              pointerEvents: isDisabled && activeTab !== 'export' ? 'none' : 'auto',
              opacity: isDisabled && activeTab !== 'export' ? 0.5 : 1,
            }}
          >
            {/* ═══════ LYRICS TAB ═══════ */}
            {activeTab === 'lyrics' && (
              <div className={`flex flex-col gap-3 h-full min-h-0 ${styles.sectionSubTabbed}`}>
                {(!isMobile || openLyricsSection === 'keyframes') && (
                  <CollapsibleSection
                    title="Lyrics Keyframe Selector"
                    icon={<Diamond size={14} />}
                    fitContent={true}
                    wrapperClassName={styles.keyframeSelectorSection}
                    forceOpen={isMobile}
                    open={openLyricsSection === 'keyframes'}
                    onToggle={() => toggleLyricsSection('keyframes')}
                  >
                    <div className="flex flex-col gap-2 pt-1 pb-2">
                      <KeyframeDropdown
                        currentTime={currentTime}
                        label=""
                        defaultProperty="scene.backgroundBrightness"
                        currentValue={liveEffectsConfig?.backgroundBrightness ?? 1.0}
                      />
                    </div>
                  </CollapsibleSection>
                )}
                {hasLyrics &&
                  currentTrack?.lyricsData &&
                  currentTrack.lyricsData.length > 0 &&
                  (() => {
                    const theme = currentTrack.lyricsTheme ?? ({} as LyricTheme);
                    const maxLane = currentTrack.lyricsData.reduce(
                      (max, line) => Math.max(max, line.laneIndex ?? 0),
                      0,
                    );
                    const laneCount = theme.laneCount ?? maxLane + 1;

                    if (laneCount <= 1) return null;

                    return (
                      <div className="flex flex-col gap-1.5 px-3 py-2 bg-[#1a1a1a]/40 border-b border-white/5 mx-[-12px] mt-[-12px] mb-2">
                        <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                          Active Lane
                        </label>
                        <select
                          className={styles.select}
                          value={selectedLane}
                          onChange={(e) => setSelectedLane(Number(e.target.value))}
                          style={{ background: '#222', borderColor: 'rgba(255,255,255,0.1)' }}
                        >
                          <option value={-1}>Base Track Styling</option>
                          {Array.from({ length: laneCount }, (_, idx) => {
                            const ls = theme.laneStyles?.[idx];
                            const label = ls?.label || `Lane ${idx + 1}`;
                            const count = ls ? Object.keys(ls).length : 0;
                            return (
                              <option key={idx} value={idx}>
                                {label}
                                {count > 0 ? ` (${count} overrides)` : ''}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    );
                  })()}

                {!hasLyrics ? (
                  (!isMobile || openLyricsSection === 'content') && (
                    <LyricSyncSection
                      hasLyrics={false}
                      onImportLyrics={handleImportLyrics}
                      onSyncLyrics={handleSyncLyrics}
                      trackName={currentTrack?.name}
                      forceOpen={isMobile}
                      open={openLyricsSection === 'content'}
                      onToggle={() => toggleLyricsSection('content')}
                    />
                  )
                ) : (
                  <>
                    {(!isMobile || openLyricsSection === 'styling') && (
                      <LyricSettingsSection
                        selectedFontId={selectedFontId}
                        onFontChange={onFontChange || (() => {})}
                        fontSize={fontSize}
                        onFontSizeChange={onFontSizeChange || (() => {})}
                        wordSpacing={wordSpacing}
                        onWordSpacingChange={onWordSpacingChange || (() => {})}
                        lineSpacing={lineSpacing}
                        onLineSpacingChange={onLineSpacingChange || (() => {})}
                        verticalPosition={verticalPosition}
                        onVerticalPositionChange={onVerticalPositionChange || (() => {})}
                        horizontalPosition={horizontalPosition}
                        onHorizontalPositionChange={onHorizontalPositionChange || (() => {})}
                        wrapWidth={wrapWidth}
                        onWrapWidthChange={onWrapWidthChange || (() => {})}
                        lyricColors={lyricColors}
                        onLyricColorsChange={onLyricColorsChange || (() => {})}
                        glowEnabled={glowEnabled}
                        onGlowEnabledChange={onGlowEnabledChange || (() => {})}
                        glowColor={glowColor}
                        onGlowColorChange={onGlowColorChange || (() => {})}
                        glowIntensity={glowIntensity}
                        onGlowIntensityChange={onGlowIntensityChange || (() => {})}
                        outlineColor={outlineColor}
                        onOutlineColorChange={onOutlineColorChange || (() => {})}
                        animationType={animationType}
                        onAnimationTypeChange={onAnimationTypeChange || (() => {})}
                        animationStagger={animationStagger}
                        onAnimationStaggerChange={onAnimationStaggerChange || (() => {})}
                        fadeInDuration={fadeInDuration}
                        onFadeInDurationChange={onFadeInDurationChange || (() => {})}
                        fadeOutDuration={fadeOutDuration}
                        onFadeOutDurationChange={onFadeOutDurationChange || (() => {})}
                        highlightFadeIn={highlightFadeIn}
                        highlightFadeOut={highlightFadeOut}
                        lyricsApplied={lyricsApplied}
                        onApplyLyricsToAll={handleApplyLyricsToAll}
                        currentTime={currentTime}
                        trackId={selectedTrackId || undefined}
                        selectedKeyframeId={selectedKeyframeId}
                        updateTrackProperty={updateTrackProperty}
                        selectedLane={selectedLane}
                        laneCount={
                          currentTrack?.lyricsTheme?.laneCount ??
                          (currentTrack?.lyricsData?.reduce(
                            (max, line) => Math.max(max, line.laneIndex ?? 0),
                            0,
                          ) ?? 0) + 1
                        }
                        laneStyles={currentTrack?.lyricsTheme?.laneStyles ?? {}}
                        onLaneStyleChange={handleLaneStyleChange}
                        forceOpen={isMobile}
                        open={openLyricsSection === 'styling'}
                        onToggle={() => toggleLyricsSection('styling')}
                      />
                    )}
                    {(!isMobile || openLyricsSection === 'content') && (
                      <LyricSyncSection
                        hasLyrics={true}
                        onImportLyrics={handleImportLyrics}
                        onSyncLyrics={handleSyncLyrics}
                        trackName={currentTrack?.name}
                        forceOpen={isMobile}
                        open={openLyricsSection === 'content'}
                        onToggle={() => toggleLyricsSection('content')}
                      />
                    )}
                    {(!isMobile || openLyricsSection === 'lyricfx') && (
                      <LyricFXSection
                        effects={
                          (currentTrack?.lyricsTheme?.lyricFX as
                            | LyricEffectInstance[]
                            | undefined) ?? []
                        }
                        onEffectsChange={(fx) =>
                          selectedTrackId &&
                          updateTrackProperty?.(selectedTrackId, 'lyricsTheme', {
                            ...(currentTrack?.lyricsTheme ?? {}),
                            lyricFX: fx,
                          })
                        }
                        fadeIn={currentTrack?.lyricsTheme?.animationIn?.duration ?? 1.0}
                        fadeOut={currentTrack?.lyricsTheme?.animationOut?.duration ?? 1.0}
                        onFadeChange={(which, seconds) => {
                          if (!selectedTrackId) return;
                          const theme = currentTrack?.lyricsTheme;
                          const existing =
                            which === 'fadeIn' ? theme?.animationIn : theme?.animationOut;
                          const next = {
                            type: existing?.type ?? ('fade' as const),
                            granularity: existing?.granularity ?? ('word' as const),
                            ...existing,
                            duration: seconds,
                          };
                          updateTrackProperty?.(
                            selectedTrackId,
                            which === 'fadeIn' ? 'lyrics.animationIn' : 'lyrics.animationOut',
                            next,
                          );
                        }}
                        fadeGranularity={
                          (currentTrack?.lyricsTheme?.animationIn?.granularity === 'char'
                            ? 'letter'
                            : currentTrack?.lyricsTheme?.animationIn?.granularity) ?? 'word'
                        }
                        onFadeGranularityChange={(g) => {
                          if (!selectedTrackId) return;
                          const eng = g === 'letter' ? 'char' : g; // engine uses 'char'
                          const theme = currentTrack?.lyricsTheme;
                          for (const key of ['animationIn', 'animationOut'] as const) {
                            const existing = theme?.[key];
                            updateTrackProperty?.(selectedTrackId, `lyrics.${key}`, {
                              type: existing?.type ?? ('fade' as const),
                              duration: existing?.duration ?? 1.0,
                              ...existing,
                              granularity: eng,
                            });
                          }
                        }}
                        forceOpen={isMobile}
                        open={openLyricsSection === 'lyricfx'}
                        onToggle={() => toggleLyricsSection('lyricfx')}
                      />
                    )}
                  </>
                )}

                {/* ═══════ TRACK TITLE SECTION (Moved from Scene/Layout Tab) ═══════ */}
                {(!isMobile || openLyricsSection === 'title') && (
                  <TrackTitleSection
                    effectsConfig={liveEffectsConfig}
                    onEffectsConfigChange={onEffectsConfigChange || (() => {})}
                    tracks={tracks}
                    titleApplied={titleApplied}
                    onApplyTrackTitleToAll={handleApplyTrackTitleToAll}
                    keyframes={keyframes}
                    onKeyframesChange={onKeyframesChange}
                    currentTime={currentTime}
                    forceOpen={isMobile}
                    open={openLyricsSection === 'title'}
                    onToggle={() => toggleLyricsSection('title')}
                  />
                )}
              </div>
            )}

            {/* ═══════ EFFECTS TAB ═══════ */}
            {activeTab === 'effects' && (
              <div className={`flex flex-col gap-3 h-full min-h-0 ${styles.sectionSubTabbed}`}>
                {(!isMobile || openEffectsSection === 'keyframes') && (
                  <CollapsibleSection
                    title="Effects Keyframe Selector"
                    icon={<Diamond size={14} />}
                    fitContent={true}
                    wrapperClassName={styles.keyframeSelectorSection}
                    forceOpen={isMobile}
                    open={openEffectsSection === 'keyframes'}
                    onToggle={() => toggleEffectsSection('keyframes')}
                  >
                    <div className="flex flex-col gap-2 pt-1 pb-2">
                      <KeyframeDropdown
                        currentTime={currentTime}
                        label=""
                        defaultProperty="scene.backgroundBrightness"
                        currentValue={liveEffectsConfig?.backgroundBrightness ?? 1.0}
                      />
                      <button
                        className={styles.primaryBtn}
                        data-testid="add-keyframe-btn"
                        style={{ marginTop: 4, height: 32, fontSize: 11 }}
                        onClick={handleAddKeyframe}
                      >
                        <Plus size={14} />
                        <span>
                          Add Keyframe at <KeyframeTimeLabel />
                        </span>
                      </button>
                    </div>
                  </CollapsibleSection>
                )}
                {(!isMobile || openEffectsSection === 'effects') && (
                  <EffectsSettingsSection
                    effectsConfig={liveEffectsConfig}
                    onEffectsConfigChange={onEffectsConfigChange || (() => {})}
                    effectsApplied={effectsApplied}
                    onApplyEffectsToAll={handleApplyEffectsToAll}
                    keyframes={keyframes}
                    onKeyframesChange={onKeyframesChange}
                    currentTime={currentTime}
                    trackId={selectedTrackId || undefined}
                    selectedKeyframeId={selectedKeyframeId}
                    updateTrackProperty={updateTrackProperty}
                    updateTrackEffectInstance={updateTrackEffectInstance}
                    centerStageRef={centerStageRef}
                    forceOpen={isMobile}
                    open={openEffectsSection === 'effects'}
                    onToggle={() => toggleEffectsSection('effects')}
                  />
                )}
                {(!isMobile || openEffectsSection === 'summary') && (
                  <EffectsSummarySection
                    effectsConfig={liveEffectsConfig}
                    forceOpen={isMobile}
                    open={openEffectsSection === 'summary'}
                    onToggle={() => toggleEffectsSection('summary')}
                  />
                )}
              </div>
            )}

            {/* ═══════ EXPORT TAB ═══════ */}
            {activeTab === 'export' && (
              <div className={styles.exportContainer} data-testid="export-tab-content">
                <ExportTab
                  quality={exportQuality}
                  onQualityChange={onExportQualityChange}
                  aspect={exportAspect}
                  onAspectChange={onExportAspectChange}
                  bitrate={exportBitrate}
                  onBitrateChange={onExportBitrateChange}
                  selectionRange={selectionRange}
                  onSelectionRangeChange={onSelectionRangeChange}
                />
              </div>
            )}
          </div>

          {/* Scroll Overflow Indicators */}
          <div
            className={`absolute top-0 left-0 right-0 h-16 pointer-events-none transition-opacity duration-300 flex items-start justify-center z-10`}
            style={{
              opacity: canScrollUp && !isDisabled ? 1 : 0,
              background: 'linear-gradient(to bottom, rgba(5,5,8,0.9) 0%, transparent 100%)',
            }}
          >
            <div className="w-full h-[1px] bg-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.6)] mt-0" />
          </div>

          <div
            className={`absolute bottom-0 left-0 right-0 h-16 pointer-events-none transition-opacity duration-300 flex items-end justify-center z-10`}
            style={{
              opacity: canScrollDown && !isDisabled ? 1 : 0,
              background: 'linear-gradient(to top, rgba(5,5,8,0.9) 0%, transparent 100%)',
            }}
          >
            <div className="w-full h-[1px] bg-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.6)] mb-0" />
          </div>
        </div>
      </div>

      <input
        ref={lyricsInputRef}
        type="file"
        accept=".lrc,.json,.srt,.txt"
        onChange={handleLyricsFileSelect}
        style={{ display: 'none' }}
      />

      <LyricSyncPanel
        isOpen={isSyncModalOpen}
        onClose={() => setIsSyncModalOpen(false)}
        audioElementRef={audioElementRef}
        onSyncComplete={handleSyncComplete}
        trackName={currentTrack?.name}
        words={words}
        setWords={setWords}
      />
    </div>
  );
}

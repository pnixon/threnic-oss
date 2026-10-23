import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  usePlaylistState,
  useProjectIOAPI,
  useTrackManagementAPI,
} from '@/contexts/PlaylistContext';
import { MultiExportConfig } from '@/types/MultiExportConfig';
import { useExportMode } from '@/engine/export/useExportMode';
import {
  DecoupledExporter,
  type DecoupledExportConfig as DecoupledConfig,
  type ExportProgress as DecoupledProgress,
} from '@/engine/export/DecoupledExporter';
import {
  acquireExportTarget,
  ExportTargetAborted,
  ExportUnsupported,
} from '@/engine/export/exportTarget';
import { AudioMixer } from '@/engine/export/AudioMixer';
import type { LyricLineData, LyricTheme } from '@/types/lyrics';
import { toast } from '@/utils/toast';
import { getFontUrl } from '@/constants/fonts';
import {
  Check,
  AlertCircle,
  Film,
  Layers,
  Monitor,
  Clock,
  Music,
  FileText,
  Smartphone,
  LayoutTemplate,
  Square,
  List,
  Copy,
  Scissors,
  Info,
} from 'lucide-react';
import styles from './ExportTab.module.css';
import {
  QUALITY_TIERS,
  ASPECT_RATIOS,
  CODEC_PROFILES,
  FPS_OPTIONS,
  BITRATE_TIERS,
  calcDimensions,
  QualityKey,
  AspectKey,
  CodecKey,
  BitrateKey,
} from '@/types/exportConstants';

import { CollapsibleSection } from '../../CollapsibleSection';
import { Cpu } from 'lucide-react';
import { CompatibilitySection } from './CompatibilitySection';
import { SelectionRangeEditor } from './SelectionRangeEditor';
import { useMediaQuery } from '@/hooks';
import inspectorStyles from '../../Inspector.module.css';

import { trackStore } from '@/engine/stores/trackStore';
import { ExportModal } from '@/components/modals/ExportModal';
import { timeStore } from '@/engine/stores/timeStore';
import { exportStore } from '@/engine/stores/exportStore';
import type { EffectsConfig } from '@/types/effects';

type LegacyFadeTheme = { fadeInDuration?: number; fadeOutDuration?: number };

interface ExportTabProps {
  quality?: QualityKey;
  onQualityChange?: (quality: QualityKey) => void;
  aspect?: AspectKey;
  onAspectChange?: (aspect: AspectKey) => void;
  bitrate?: BitrateKey;
  onBitrateChange?: (bitrate: BitrateKey) => void;
  selectionRange?: { start: number; end: number } | null;
  onSelectionRangeChange?: (range: { start: number; end: number } | null) => void;
}

// NOTE: The human-readable effects summary now lives on the Effects tab
// (EffectsSummarySection). It was moved out of Export so effect authoring and
// its summary sit together.

export function ExportTab({
  quality = 'High',
  onQualityChange,
  aspect = 'Landscape',
  onAspectChange,
  bitrate = 'Medium',
  onBitrateChange,
  selectionRange,
  onSelectionRangeChange,
}: ExportTabProps) {
  const { tracks, selectedTrackId } = usePlaylistState();
  const { getTracksForExport } = useProjectIOAPI();
  const { selectTrack } = useTrackManagementAPI();
  const {
    isExporting,
    config,
    setConfig,
    selectedFps,
    setSelectedFps,
    selectedCodec,
    setSelectedCodec,
    watermarkEnabled,
    setWatermarkEnabled,
  } = useExportMode();

  // Single-open accordion state for the Export tab sections. Only one top-level
  // panel is expanded at a time (matching the Effects/Lyrics tabs). Section ids
  // are stable strings; mode-dependent sections simply appear/disappear.
  type ExportSectionId = 'mode' | 'output' | 'tracks' | 'tracklist' | 'selection' | 'compat';
  const [openExportSection, setOpenExportSection] = useState<ExportSectionId>('output');
  const toggleExportSection = (id: ExportSectionId) =>
    setOpenExportSection((cur) => (cur === id ? ('' as ExportSectionId) : id));

  // On mobile, the Export tab shows a horizontal sub-tab strip (like the
  // Lyrics/Effects tabs) that switches which single section is visible instead
  // of stacking every panel in one long scroll. Selecting a sub-tab drives the
  // single-open accordion state so all other panels stay hidden.
  const isMobile = useMediaQuery('(max-width: 768px)');

  // If the currently-open section stops being available (e.g. leaving 'single'
  // mode hides Tracks/Tracklist), fall back to Output so mobile never shows an
  // empty body under the sub-tab strip.
  useEffect(() => {
    const availableByMode: Record<string, boolean> = {
      mode: true,
      output: true,
      tracks: config.mode === 'single',
      tracklist: config.mode === 'single',
      selection: config.mode === 'selection',
    };
    if (openExportSection && availableByMode[openExportSection] === false) {
      setOpenExportSection('output');
    }
  }, [config.mode, openExportSection]);

  const [supportedCodecs, setSupportedCodecs] = useState<Record<CodecKey, boolean>>({
    av1: true,
    hevc: true,
    h264: true,
  });

  // Probe hardware codec support on mount/load
  useEffect(() => {
    let active = true;
    if (typeof window === 'undefined' || !('VideoEncoder' in window)) {
      return;
    }

    const probeCodecs = async () => {
      const results: Record<CodecKey, boolean> = {
        av1: false,
        hevc: false,
        h264: false,
      };

      const testConfig = {
        width: 1280,
        height: 720,
        bitrate: 5_000_000,
        framerate: 30,
      };

      const codecKeys = Object.keys(CODEC_PROFILES) as CodecKey[];
      await Promise.all(
        codecKeys.map(async (key) => {
          const profile = CODEC_PROFILES[key];
          // Probe hardware candidates first (prefer-hardware), then the same
          // codec strings under no-preference so browsers that only encode in
          // software (Firefox H.264 via openh264/ffvpx) are still detected.
          const attempts: Array<{ codec: string; hardwareAcceleration: HardwarePreference }> = [
            ...profile.hardwareCandidates.map((codec) => ({
              codec,
              hardwareAcceleration: 'prefer-hardware' as const,
            })),
            ...profile.hardwareCandidates.map((codec) => ({
              codec,
              hardwareAcceleration: 'no-preference' as const,
            })),
            ...profile.softwareFallbacks.map((codec) => ({
              codec,
              hardwareAcceleration: 'no-preference' as const,
            })),
          ];
          for (const attempt of attempts) {
            try {
              const support = await VideoEncoder.isConfigSupported({
                width: testConfig.width,
                height: testConfig.height,
                bitrate: testConfig.bitrate,
                framerate: testConfig.framerate,
                codec: attempt.codec,
                hardwareAcceleration: attempt.hardwareAcceleration,
              });
              if (support.supported) {
                results[key] = true;
                return;
              }
            } catch {
              // ignore and try next
            }
          }
          // If nothing supported, results[key] stays false
        }),
      );

      if (active) {
        setSupportedCodecs(results);

        // Auto-fallback: if selectedCodec is unsupported, find the first supported one
        if (!results[selectedCodec]) {
          const firstSupported = codecKeys.find((k) => results[k]);
          if (firstSupported) {
            setSelectedCodec(firstSupported);
          }
        }
      }
    };

    probeCodecs();
    return () => {
      active = false;
    };
  }, [selectedCodec, setSelectedCodec]);

  // Track previous track IDs to detect additions
  const prevTrackIdsRef = useRef<string[]>([]);
  const prevSelectedTrackIdRef = useRef<string | null>(selectedTrackId);

  // Compute selected track
  const selectedTrack = useMemo(() => {
    return tracks.find((t) => t.id === selectedTrackId);
  }, [tracks, selectedTrackId]);

  // Audio buffer for selection mode waveform visualization
  const [selectionAudioBuffer, setSelectionAudioBuffer] = useState<AudioBuffer | null>(null);

  // Load audio buffer for selection mode
  useEffect(() => {
    if (config.mode === 'selection' && selectedTrack) {
      const loadBuffer = async () => {
        try {
          const response = await fetch(selectedTrack.audioUrl);
          const arrayBuffer = await response.arrayBuffer();
          const audioContext = new AudioContext();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          await audioContext.close();
          setSelectionAudioBuffer(audioBuffer);
        } catch (error) {
          console.error('Failed to load audio buffer:', error);
          setSelectionAudioBuffer(null);
        }
      };
      loadBuffer();
    } else {
      setSelectionAudioBuffer(null);
    }
  }, [config.mode, selectedTrack]);

  // Auto-select new tracks and clean up removed ones
  useEffect(() => {
    const currentTrackIds = tracks.map((t) => t.id);
    const prevTrackIds = prevTrackIdsRef.current;
    const prevSelectedId = prevSelectedTrackIdRef.current;

    // Identify new tracks (present in current but not in prev)
    const newTracks = currentTrackIds.filter((id) => !prevTrackIds.includes(id));
    // Identify deleted tracks
    const deletedTrackIds = prevTrackIds.filter((id) => !currentTrackIds.includes(id));

    const hasNewTracks = newTracks.length > 0;
    const hasDeletedTracks = deletedTrackIds.length > 0;
    const wasSelectedTrackDeleted =
      config.mode === 'selection' && prevSelectedId && deletedTrackIds.includes(prevSelectedId);

    // Clear selection range on any track removal
    if (hasDeletedTracks) {
      onSelectionRangeChange?.(null);
    }

    // Reset selection range to full track duration when a new track is added
    if (hasNewTracks && config.mode === 'selection') {
      const currentTrack = tracks.find((t) => t.id === selectedTrackId);
      if (currentTrack) {
        const defaultRange = { start: 0, end: currentTrack.duration };
        onSelectionRangeChange?.(defaultRange);
      }
    }

    setConfig((prev: MultiExportConfig) => {
      let nextMode = prev.mode;
      let nextSelectionRange = prev.selectionRange;

      // Revert export mode and clear selection if the selected track was deleted
      if (wasSelectedTrackDeleted) {
        nextMode = 'batch';
        nextSelectionRange = undefined;
      }

      // Clear selection range when any track is removed
      if (hasDeletedTracks && !wasSelectedTrackDeleted) {
        nextSelectionRange = undefined;
      }

      // Reset selection range when a new track is added (in selection mode)
      if (hasNewTracks && prev.mode === 'selection') {
        const currentTrack = tracks.find((t) => t.id === selectedTrackId);
        if (currentTrack) {
          nextSelectionRange = { start: 0, end: currentTrack.duration };
        }
      }

      // 1. Remove IDs that are no longer in the playlist
      const validTracks = prev.tracks.filter((id) => currentTrackIds.includes(id));

      // 2. Check if anything actually changed
      const tracksChanged = validTracks.length !== prev.tracks.length || newTracks.length > 0;
      const modeChanged = nextMode !== prev.mode;
      const rangeChanged = nextSelectionRange !== prev.selectionRange;

      if (!tracksChanged && !modeChanged && !rangeChanged) {
        return prev;
      }

      return {
        ...prev,
        mode: nextMode,
        selectionRange: nextSelectionRange,
        tracks: [...validTracks, ...newTracks],
      };
    });

    prevTrackIdsRef.current = currentTrackIds;
    prevSelectedTrackIdRef.current = selectedTrackId;
  }, [tracks, selectedTrackId, onSelectionRangeChange, config.mode, setConfig]);

  // Sync selectionRange prop to local config
  useEffect(() => {
    if (selectionRange) {
      setConfig((prev: MultiExportConfig) => {
        if (
          prev.selectionRange?.start === selectionRange.start &&
          prev.selectionRange?.end === selectionRange.end
        ) {
          return prev;
        }
        return { ...prev, selectionRange };
      });
    }
  }, [selectionRange, setConfig]);

  // Initialize selection range when switching to selection mode
  useEffect(() => {
    if (config.mode === 'selection' && !config.selectionRange && selectedTrack) {
      // If we have a prop, rely on the sync effect above.
      // If no prop, create default full range.
      if (!selectionRange) {
        const defaultRange = { start: 0, end: selectedTrack.duration };
        setConfig((prev: MultiExportConfig) => ({ ...prev, selectionRange: defaultRange }));
        // Also sync up to parent so Timeline sees it
        onSelectionRangeChange?.(defaultRange);
      }
    }
  }, [
    config.mode,
    config.selectionRange,
    selectedTrack,
    selectionRange,
    onSelectionRangeChange,
    setConfig,
  ]);

  // Ordered tracks
  const orderedSelectedTracks = useMemo(() => {
    return tracks.filter((t) => config.tracks.includes(t.id));
  }, [tracks, config.tracks]);

  const handleUpdate = (updates: Partial<MultiExportConfig>) => {
    setConfig((prev: MultiExportConfig) => ({ ...prev, ...updates }));
    // Switching to selection mode auto-opens the Selection Range editor
    // (preserving the old defaultOpen behavior under the single-open accordion).
    if (updates.mode === 'selection') setOpenExportSection('selection');
  };

  const toggleTrack = (id: string) => {
    setConfig((prev: MultiExportConfig) => {
      const newTracks = prev.tracks.includes(id)
        ? prev.tracks.filter((tid: string) => tid !== id)
        : [...prev.tracks, id];
      return { ...prev, tracks: newTracks };
    });
  };

  // ─── Decoupled export state (for batch/current-track mode) ─────────
  const [decoupledProgress, setDecoupledProgress] = useState<DecoupledProgress | null>(null);
  const [isDecoupledExporting, setIsDecoupledExporting] = useState(false);
  const decoupledExporterRef = useRef<DecoupledExporter | null>(null);

  // Merge decoupled + legacy export states for UI
  const combinedIsExporting = isExporting || isDecoupledExporting;

  const handleExport = async () => {
    timeStore.getState().setIsPlaying(false);

    // 1. Calculate suggested name and dimensions
    const { width, height } = calcDimensions(quality, aspect);
    const bitrateMultiplier = BITRATE_TIERS[bitrate]?.multiplier ?? 0.15;
    const calculatedVideoBitrate = Math.min(
      Math.floor(width * height * selectedFps * bitrateMultiplier),
      200_000_000,
    );

    let suggestedName = 'export.mp4';
    if (config.mode === 'single') {
      suggestedName = `threnic_${width}x${height}_${Date.now()}.mp4`;
    } else if (config.mode === 'selection') {
      const currentTrack = tracks.find((t) => t.id === selectedTrackId);
      const start = Math.floor(config.selectionRange?.start || 0);
      const end = Math.floor(config.selectionRange?.end || 0);
      suggestedName = `${currentTrack?.name || 'export'}_${start}s-${end}s.mp4`;
    } else {
      const currentTrack = tracks.find((t) => t.id === selectedTrackId);
      suggestedName = `${currentTrack?.name || 'export'}.mp4`;
    }

    // 2. Acquire the write target IMMEDIATELY to preserve the user gesture.
    //    Chromium streams direct-to-disk via the File System Access API;
    //    Firefox/Safari fall back to an in-memory buffer + Blob download.
    let exportTarget: Awaited<ReturnType<typeof acquireExportTarget>>;
    try {
      exportTarget = await acquireExportTarget(suggestedName, 'video/mp4');
    } catch (err) {
      if (err instanceof ExportTargetAborted) return;
      if (err instanceof ExportUnsupported) {
        toast.error(
          'Video export needs the WebCodecs API, which this browser does not support. ' +
            'Please use a current version of Chrome, Edge, or Firefox.',
        );
        return;
      }
      console.error('File picker failed:', err);
      toast.error(`Could not start export: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 3. Collect tracks for export
    let orderedTrackIds: string[] = [];
    if (config.mode === 'single') {
      orderedTrackIds = tracks.filter((t) => config.tracks.includes(t.id)).map((t) => t.id);
    } else {
      if (selectedTrackId) orderedTrackIds = [selectedTrackId];
    }

    const exportTracks = await getTracksForExport(orderedTrackIds);
    if (exportTracks.length === 0) return;

    // ════════════════════════════════════════════════════════════════════
    // DECOUPLED PATH — All modes use DecoupledExporter
    // Completely bypasses the preview UI, preview state, audio monitors, etc.
    // ════════════════════════════════════════════════════════════════════
    try {
      setIsDecoupledExporting(true);
      trackStore.getState().setIsExporting(true);
      setDecoupledProgress(null);

      const writableStream = exportTarget.writableStream;
      let exportConfig: DecoupledConfig;

      if (config.mode === 'single') {
        // ── Single Merged Video ──
        // Build merged audio, lyrics, keyframes, and per-track schedules
        let currentOffset = 0;
        const mergedLyrics: LyricLineData[] = [];
        const backgroundSchedule: Array<{ startTime: number; url: string }> = [];
        const effectsSchedule: Array<{ startTime: number; config: EffectsConfig }> = [];
        const themeSchedule: Array<{ startTime: number; theme: LyricTheme }> = [];
        const titleSchedule: Array<{ startTime: number; title: string }> = [];
        const keyframeSchedule: import('@/types/keyframes').Keyframe[] = [];
        const videoClipsSchedule: import('@/types/video-clips').VideoClip[] = [];
        const trackMergeData: Array<{ buffer: AudioBuffer; gapBefore: number }> = [];

        exportTracks.forEach((et, index) => {
          const originalTrack = tracks.find((t) => t.id === et.trackId);
          if (originalTrack) {
            const shiftedLyrics = (originalTrack.lyricsData || []).map((line) => ({
              ...line,
              start: line.start + currentOffset,
              end: line.end + currentOffset,
              words: line.words?.map((w) => ({
                ...w,
                start: w.start + currentOffset,
                end: w.end + currentOffset,
              })),
            }));
            mergedLyrics.push(...shiftedLyrics);
            titleSchedule.push({ startTime: currentOffset, title: originalTrack.name });
            if (originalTrack.backgroundImage) {
              backgroundSchedule.push({
                startTime: currentOffset,
                url: originalTrack.backgroundImage,
              });
            }
            if (originalTrack.effectsConfig) {
              effectsSchedule.push({
                startTime: currentOffset,
                config: structuredClone(originalTrack.effectsConfig),
              });
            }
            if (originalTrack.lyricsTheme) {
              themeSchedule.push({
                startTime: currentOffset,
                theme: structuredClone(originalTrack.lyricsTheme),
              });
            }
            if (originalTrack.keyframes) {
              originalTrack.keyframes.forEach((kf) => {
                keyframeSchedule.push({ ...kf, time: kf.time + currentOffset });
              });
            }
            if (originalTrack.videoClips) {
              originalTrack.videoClips.forEach((clip) => {
                videoClipsSchedule.push({
                  ...clip,
                  startTime: clip.startTime + currentOffset,
                  endTime: clip.endTime + currentOffset,
                });
              });
            }
          }

          const gap = config.trackGaps[et.trackId] || 0;
          trackMergeData.push({ buffer: et.audioBuffer, gapBefore: index === 0 ? 0 : gap });
          currentOffset += et.audioBuffer.duration + gap;
        });

        // Merge audio buffers
        const audioContext = new AudioContext();
        const mergedAudio = await AudioMixer.mergeTracks(trackMergeData, audioContext);
        await audioContext.close();

        const firstTrack = tracks.find((t) => t.id === exportTracks[0]?.trackId);

        exportConfig = {
          width,
          height,
          fps: selectedFps,
          videoBitrate: calculatedVideoBitrate,
          duration: currentOffset,
          backgroundUrl: firstTrack?.backgroundImage || undefined,
          backgroundColor: firstTrack?.effectsConfig?.visualizer?.backgroundColor || '#000000',
          effectsConfig: firstTrack?.effectsConfig || undefined,
          keyframes: keyframeSchedule.length > 0 ? keyframeSchedule : undefined,
          audioBuffer: mergedAudio,
          suggestedName,
          lyrics: mergedLyrics.length > 0 ? mergedLyrics : undefined,
          lyricTheme: firstTrack?.lyricsTheme ? structuredClone(firstTrack.lyricsTheme) : undefined,
          lyricVerticalPosition: firstTrack?.lyricsTheme?.verticalPosition,
          lyricFontUrl: firstTrack?.lyricsTheme?.fontId
            ? getFontUrl(firstTrack.lyricsTheme.fontId)
            : firstTrack?.lyricsTheme?.fontUrl,
          lyricFadeInDuration: (firstTrack?.lyricsTheme as LegacyFadeTheme | undefined)
            ?.fadeInDuration,
          lyricFadeOutDuration: (firstTrack?.lyricsTheme as LegacyFadeTheme | undefined)
            ?.fadeOutDuration,
          trackTitle: firstTrack?.name,
          trackTitleConfig: firstTrack?.effectsConfig?.trackTitle,
          trackTitleFontUrl: firstTrack?.effectsConfig?.trackTitle?.fontId
            ? getFontUrl(firstTrack.effectsConfig.trackTitle.fontId)
            : undefined,
          // Multi-track schedules
          backgroundSchedule: backgroundSchedule.length > 0 ? backgroundSchedule : undefined,
          effectsSchedule: effectsSchedule.length > 0 ? effectsSchedule : undefined,
          themeSchedule: themeSchedule.length > 0 ? themeSchedule : undefined,
          titleSchedule: titleSchedule.length > 0 ? titleSchedule : undefined,
          videoClips: videoClipsSchedule.length > 0 ? videoClipsSchedule : undefined,
          watermark: watermarkEnabled,
        };
      } else {
        // ── Batch / Selection — single track ──
        const et = exportTracks[0];
        const originalTrack = tracks.find((t) => t.id === et.trackId);
        if (!originalTrack) return;

        let startSec = 0;
        let durationSec = et.audioBuffer.duration;

        if (config.mode === 'selection' && config.selectionRange) {
          startSec = config.selectionRange.start;
          durationSec = config.selectionRange.end - config.selectionRange.start;
        }

        exportConfig = {
          width,
          height,
          fps: selectedFps,
          videoBitrate: calculatedVideoBitrate,
          startTime: startSec,
          duration: durationSec,
          backgroundUrl: originalTrack.backgroundImage || undefined,
          backgroundColor: originalTrack.effectsConfig?.visualizer?.backgroundColor || '#000000',
          effectsConfig: originalTrack.effectsConfig
            ? structuredClone(originalTrack.effectsConfig)
            : undefined,
          keyframes: originalTrack.keyframes || undefined,
          videoClips: originalTrack.videoClips || undefined,
          audioBuffer: et.audioBuffer,
          suggestedName,
          lyrics: originalTrack.lyricsData || undefined,
          lyricTheme: originalTrack.lyricsTheme
            ? structuredClone(originalTrack.lyricsTheme)
            : undefined,
          lyricVerticalPosition: originalTrack.lyricsTheme?.verticalPosition,
          lyricFontUrl: originalTrack.lyricsTheme?.fontId
            ? getFontUrl(originalTrack.lyricsTheme.fontId)
            : originalTrack.lyricsTheme?.fontUrl,
          lyricFadeInDuration: (originalTrack.lyricsTheme as LegacyFadeTheme | undefined)
            ?.fadeInDuration,
          lyricFadeOutDuration: (originalTrack.lyricsTheme as LegacyFadeTheme | undefined)
            ?.fadeOutDuration,
          trackTitle: originalTrack.name,
          trackTitleConfig: originalTrack.effectsConfig?.trackTitle,
          trackTitleFontUrl: originalTrack.effectsConfig?.trackTitle?.fontId
            ? getFontUrl(originalTrack.effectsConfig.trackTitle.fontId)
            : undefined,
          watermark: watermarkEnabled,
        };
      }

      const exporter = new DecoupledExporter(exportConfig);
      decoupledExporterRef.current = exporter;

      const result = await exporter.run(writableStream, (p) => {
        setDecoupledProgress({ ...p });
      });

      if (result.success) {
        toast.success(
          `Export complete! ${result.averageFps.toFixed(0)} fps avg ` +
            `(${result.realtimeX.toFixed(1)}x real-time)` +
            // Chromium wrote straight to the file the user picked; OPFS and the
            // memory fallback both deliver as a browser download at the end.
            (exportTarget.sink === 'file-system-access' ? '' : ' — check your downloads'),
        );
      } else if (result.error && result.error !== 'Cancelled by user') {
        toast.error(`Export failed: ${result.error}`);
      }
    } catch (err) {
      console.error('Decoupled export failed:', err);
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsDecoupledExporting(false);
      trackStore.getState().setIsExporting(false);
      setDecoupledProgress(null);
      decoupledExporterRef.current = null;
    }
  };

  // Sync UI with export progress (multi-track)
  useEffect(() => {
    if (!isExporting || config.mode !== 'single') return;

    const orderedTrackIds = tracks.filter((t) => config.tracks.includes(t.id)).map((t) => t.id);

    let lastTrackIndex = exportStore.getState().lastTrackIndex;

    const unregister = exportStore.subscribe((state) => {
      if (state.lastTrackIndex !== lastTrackIndex) {
        lastTrackIndex = state.lastTrackIndex;
        const index = state.lastTrackIndex;
        const trackId = orderedTrackIds[index];
        if (trackId) {
          selectTrack(trackId);
        }
      }
    });

    return () => unregister();
  }, [isExporting, config.mode, config.tracks, tracks, selectTrack]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const generateTracklist = () => {
    let currentTime = 0;
    return orderedSelectedTracks
      .map((track) => {
        const h = Math.floor(currentTime / 3600);
        const m = Math.floor((currentTime % 3600) / 60);
        const s = Math.floor(currentTime % 60);
        const timeStr = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

        const gap = config.trackGaps[track.id] || 0;
        currentTime += track.duration + gap;

        return `${timeStr} - ${track.name}`;
      })
      .join('\n');
  };

  const dims = calcDimensions(quality, aspect);
  const showWarning = quality === 'Ultra' && selectedFps === 60;

  // Mobile sub-tab strip items — mirror the currently-available Export panels so
  // exactly one is shown at a time (conditional panels appear with their mode).
  const exportSubTabs: { id: ExportSectionId; label: string; icon: React.ReactNode }[] = [
    { id: 'mode', label: 'Mode', icon: <Film size={13} /> },
    { id: 'output', label: 'Output', icon: <Monitor size={13} /> },
    { id: 'compat', label: 'Hardware', icon: <Cpu size={13} /> },
    ...(config.mode === 'single'
      ? ([
          { id: 'tracks' as ExportSectionId, label: 'Tracks', icon: <Layers size={13} /> },
          { id: 'tracklist' as ExportSectionId, label: 'Tracklist', icon: <List size={13} /> },
        ] as const)
      : []),
    ...(config.mode === 'selection'
      ? ([
          { id: 'selection' as ExportSectionId, label: 'Range', icon: <Scissors size={13} /> },
        ] as const)
      : []),
  ];

  return (
    <div className={styles.container}>
      {/* Mobile sub-tab strip — hides all Export panels except the selected one,
          matching the Lyrics/Effects tabs. Desktop keeps the accordion. */}
      {isMobile && (
        <div className={inspectorStyles.subTabStrip} data-testid="export-subtab-strip">
          {exportSubTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`${inspectorStyles.subTab} ${
                openExportSection === t.id ? inspectorStyles.subTabActive : ''
              }`}
              onClick={() => setOpenExportSection(t.id)}
              data-testid={`export-subtab-${t.id}`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Scrollable Settings Area */}
      <div
        className={`${styles.scrollableSettings} ${isMobile ? inspectorStyles.sectionSubTabbed : ''}`.trim()}
        style={{
          pointerEvents: isExporting ? 'none' : 'auto',
          opacity: isExporting ? 0.5 : 1,
        }}
      >
        {/* Mode Selection */}
        {(!isMobile || openExportSection === 'mode') && (
          <CollapsibleSection
            title="Export Mode"
            icon={<Film size={14} />}
            forceOpen={isMobile}
            open={openExportSection === 'mode'}
            onToggle={() => toggleExportSection('mode')}
          >
            <div className={styles.modeOptions}>
              <label
                className={`${styles.modeOption} ${config.mode === 'single' ? styles.modeActive : ''}`}
              >
                <input
                  type="radio"
                  checked={config.mode === 'single'}
                  onChange={() => handleUpdate({ mode: 'single' })}
                  className={styles.radioHidden}
                />
                <div className={styles.radioIndicator}>
                  {config.mode === 'single' && <div className={styles.radioInner} />}
                </div>
                <span className={styles.modeLabel}>Single Merged Video</span>
              </label>
              <label
                className={`${styles.modeOption} ${config.mode === 'batch' ? styles.modeActive : ''}`}
              >
                <input
                  type="radio"
                  checked={config.mode === 'batch'}
                  onChange={() => handleUpdate({ mode: 'batch' })}
                  className={styles.radioHidden}
                />
                <div className={styles.radioIndicator}>
                  {config.mode === 'batch' && <div className={styles.radioInner} />}
                </div>
                <div className={styles.modeContent}>
                  <span className={styles.modeLabel}>Export Current Track</span>
                </div>
              </label>
              <label
                className={`${styles.modeOption} ${config.mode === 'selection' ? styles.modeActive : ''}`}
              >
                <input
                  type="radio"
                  checked={config.mode === 'selection'}
                  onChange={() => handleUpdate({ mode: 'selection' })}
                  className={styles.radioHidden}
                />
                <div className={styles.radioIndicator}>
                  {config.mode === 'selection' && <div className={styles.radioInner} />}
                </div>
                <div className={styles.modeContent}>
                  <span className={styles.modeLabel}>Export Selection</span>
                  <Scissors size={12} style={{ marginLeft: 4, opacity: 0.6 }} />
                </div>
              </label>
            </div>
          </CollapsibleSection>
        )}

        {/* Output Settings */}
        {(!isMobile || openExportSection === 'output') && (
          <CollapsibleSection
            title="Output Settings"
            icon={<Monitor size={14} />}
            forceOpen={isMobile}
            open={openExportSection === 'output'}
            onToggle={() => toggleExportSection('output')}
          >
            <div className={styles.modeOptions}>
              {/* Quality */}
              <div className={styles.settingsGroup}>
                <span className={styles.groupLabel}>Quality</span>
                <div className={styles.settingsGrid}>
                  {(Object.keys(QUALITY_TIERS) as QualityKey[]).map((key) => {
                    const tier = QUALITY_TIERS[key];
                    return (
                      <div
                        key={key}
                        className={`${styles.optionItem} ${quality === key ? styles.optionActive : ''}`}
                        onClick={() => onQualityChange?.(key)}
                        title={tier.label}
                      >
                        <span>{tier.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Aspect Ratio */}
              <div className={styles.settingsGroup}>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span className={styles.groupLabel}>Aspect Ratio</span>
                </div>
                <div className={styles.settingsGrid}>
                  {(Object.keys(ASPECT_RATIOS) as AspectKey[]).map((key) => (
                    <div
                      key={key}
                      className={`${styles.optionItem} ${aspect === key ? styles.optionActive : ''}`}
                      onClick={() => onAspectChange?.(key)}
                    >
                      <div className={styles.aspectContent}>
                        {key === 'Landscape' && <LayoutTemplate size={14} />}
                        {key === 'Portrait' && <Smartphone size={14} />}
                        {key === 'Square' && <Square size={14} />}
                        <span>{ASPECT_RATIOS[key].label}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* FPS */}
              <div className={styles.settingsGroup}>
                <span className={styles.groupLabel}>Frame Rate</span>
                <div className={styles.settingsGrid}>
                  {FPS_OPTIONS.map((opt) => {
                    return (
                      <div
                        key={opt.value}
                        className={`${styles.optionItem} ${selectedFps === opt.value ? styles.optionActive : ''}`}
                        onClick={() => setSelectedFps(opt.value)}
                        title={opt.label}
                      >
                        <span>{opt.label}</span>
                        <Clock size={12} />
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Codec */}
              <div className={styles.settingsGroup}>
                <span className={styles.groupLabel}>Video Codec</span>
                <div className={styles.settingsGrid}>
                  {(Object.keys(CODEC_PROFILES) as CodecKey[]).map((key) => {
                    const isSupported = supportedCodecs[key];
                    return (
                      <div
                        key={key}
                        className={`${styles.optionItem} ${selectedCodec === key ? styles.optionActive : ''} ${!isSupported ? styles.optionLocked : ''}`}
                        onClick={() => {
                          if (!isSupported) {
                            toast.error(
                              `${CODEC_PROFILES[key].label} is not supported by your GPU/video card.`,
                            );
                            return;
                          }
                          setSelectedCodec(key);
                        }}
                        title={
                          !isSupported
                            ? 'Unsupported by your GPU/video card'
                            : CODEC_PROFILES[key].description
                        }
                        style={!isSupported ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                      >
                        <span>{CODEC_PROFILES[key].label}</span>
                        {!isSupported && (
                          <span
                            style={{
                              fontSize: '9px',
                              fontWeight: 700,
                              color: '#ef4444',
                              marginLeft: 4,
                              letterSpacing: '0.05em',
                              opacity: 0.9,
                            }}
                          >
                            UNSUPPORTED
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Target Bitrate */}
              <div className={styles.settingsGroup}>
                <span className={styles.groupLabel}>Target Bitrate</span>
                <div className={styles.settingsGrid}>
                  {(Object.keys(BITRATE_TIERS) as BitrateKey[]).map((key) => {
                    const tier = BITRATE_TIERS[key];
                    return (
                      <div
                        key={key}
                        className={`${styles.optionItem} ${bitrate === key ? styles.optionActive : ''}`}
                        onClick={() => onBitrateChange?.(key)}
                        title={tier.description}
                      >
                        <span>{tier.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Optional Threnic branding watermark (off by default) */}
              <div className={styles.settingsGroup}>
                <span className={styles.groupLabel}>Branding</span>
                <div
                  className={`${styles.optionItem} ${watermarkEnabled ? styles.optionActive : ''}`}
                  onClick={() => setWatermarkEnabled(!watermarkEnabled)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    padding: '8px 12px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Info size={14} style={{ opacity: 0.7 }} />
                    <span>Include Threnic Watermark</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={watermarkEnabled}
                    onChange={() => {}} // Click handled by parent optionItem div
                    style={{
                      cursor: 'pointer',
                      accentColor: 'var(--color-primary)',
                      pointerEvents: 'none',
                    }}
                  />
                </div>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* Compatibility & Hardware — global rendering fallback controls +
            the hardware-info readout. */}
        {(!isMobile || openExportSection === 'compat') && (
          <CollapsibleSection
            title="Compatibility & Hardware"
            icon={<Cpu size={14} />}
            open={openExportSection === 'compat'}
            onToggle={() => toggleExportSection('compat')}
          >
            <CompatibilitySection />
          </CollapsibleSection>
        )}

        {config.mode === 'single' && (!isMobile || openExportSection === 'tracks') && (
          <CollapsibleSection
            title={`Tracks (${config.tracks.length}/${tracks.length})`}
            icon={<Layers size={14} />}
            forceOpen={isMobile}
            open={openExportSection === 'tracks'}
            onToggle={() => toggleExportSection('tracks')}
            maxHeight={300}
          >
            <div className={styles.trackList}>
              {tracks.map((track) => (
                <div
                  key={track.id}
                  onClick={() => toggleTrack(track.id)}
                  className={`${styles.trackItem} ${
                    config.tracks.includes(track.id) ? styles.trackSelected : ''
                  }`}
                >
                  <div
                    className={`${styles.trackCheckbox} ${config.tracks.includes(track.id) ? styles.trackChecked : ''}`}
                  >
                    {config.tracks.includes(track.id) && <Check size={10} />}
                  </div>
                  <div className={styles.trackIcon}>
                    {track.lyricsData && track.lyricsData.length > 0 ? (
                      <FileText size={14} />
                    ) : (
                      <Music size={14} />
                    )}
                  </div>
                  <div className={styles.trackInfo}>
                    <div className={styles.trackName}>{track.name}</div>
                    <div className={styles.trackDuration}>{formatDuration(track.duration)}</div>
                  </div>
                </div>
              ))}
              {tracks.length === 0 && (
                <div className={styles.emptyState}>No tracks in playlist</div>
              )}
            </div>
          </CollapsibleSection>
        )}
        {config.mode === 'single' && (!isMobile || openExportSection === 'tracklist') && (
          <CollapsibleSection
            title="Tracklist"
            icon={<List size={14} />}
            forceOpen={isMobile}
            open={openExportSection === 'tracklist'}
            onToggle={() => toggleExportSection('tracklist')}
          >
            {config.tracks.length > 0 ? (
              <div className={styles.tracklistContainer}>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(generateTracklist());
                  }}
                  className={styles.copyBtn}
                  title="Copy"
                >
                  <Copy size={12} />
                </button>
                <textarea
                  className={styles.tracklistTextarea}
                  readOnly
                  value={generateTracklist()}
                  onClick={(e) => e.currentTarget.select()}
                />
              </div>
            ) : (
              <div className={styles.emptyState}>No tracks selected</div>
            )}
          </CollapsibleSection>
        )}

        {/* Selection Range Editor */}
        {config.mode === 'selection' &&
          selectedTrack &&
          config.selectionRange &&
          (!isMobile || openExportSection === 'selection') && (
            <CollapsibleSection
              title="Selection Range"
              icon={<Scissors size={14} />}
              forceOpen={isMobile}
              open={openExportSection === 'selection'}
              onToggle={() => toggleExportSection('selection')}
            >
              <SelectionRangeEditor
                audioBuffer={selectionAudioBuffer}
                duration={selectedTrack.duration}
                selectionRange={config.selectionRange}
                onSelectionChange={(range) => {
                  handleUpdate({ selectionRange: range });
                  onSelectionRangeChange?.(range);
                }}
              />
            </CollapsibleSection>
          )}
      </div>

      {/* Pinned Action Area */}
      <div className={styles.actionArea}>
        {combinedIsExporting ? (
          <div className={styles.progressContainer}>
            <span className={styles.progressLabel}>
              {isDecoupledExporting
                ? `⚡ Exporting: ${decoupledProgress?.phase ?? 'preparing'}…`
                : 'Export in progress…'}
            </span>
            <span className={styles.progressPercent}>
              {isDecoupledExporting && decoupledProgress
                ? `${decoupledProgress.percent.toFixed(0)}%`
                : 'See modal for details'}
            </span>
          </div>
        ) : (
          <div className={styles.exportActions}>
            <div className={styles.warningBox}>
              <AlertCircle size={12} className={styles.warningIcon} />
              <span>
                {dims.width}×{dims.height} @ {selectedFps}fps
                {showWarning && (
                  <>
                    <br />
                    This may take a while.
                  </>
                )}
              </span>
            </div>
            <button
              onClick={handleExport}
              disabled={
                config.mode === 'selection'
                  ? !config.selectionRange || !selectedTrack
                  : config.mode === 'batch'
                    ? !selectedTrack
                    : config.tracks.length === 0
              }
              className={`${styles.exportBtn} ${
                (
                  config.mode === 'selection'
                    ? !config.selectionRange || !selectedTrack
                    : config.mode === 'batch'
                      ? !selectedTrack
                      : config.tracks.length === 0
                )
                  ? styles.exportDisabled
                  : ''
              }`}
            >
              Begin Export
            </button>
          </div>
        )}
      </div>
      {/* Decoupled export modal (Crimson Obsidian) */}
      {isDecoupledExporting && decoupledProgress && (
        <ExportModal
          isOpen={isDecoupledExporting}
          progress={{
            currentFrame: decoupledProgress.currentFrame,
            totalFrames: decoupledProgress.totalFrames,
            currentTime: decoupledProgress.currentFrame / selectedFps,
            totalDuration: decoupledProgress.totalFrames / selectedFps,
            percentage: decoupledProgress.percent,
            recentFps: decoupledProgress.fps,
            etaSeconds: decoupledProgress.etaSeconds,
            phase: decoupledProgress.phase,
            snapshotUrl: decoupledProgress.snapshotUrl,
          }}
          onCancel={() => decoupledExporterRef.current?.cancel()}
          height={calcDimensions(quality, aspect).height}
          fps={selectedFps}
          codec={selectedCodec === 'h264' ? 'H.264' : selectedCodec === 'hevc' ? 'HEVC' : 'AV1'}
        />
      )}
    </div>
  );
}

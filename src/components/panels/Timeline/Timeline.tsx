'use client';

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
  Play,
  Pause,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useResizeObserver } from '@/hooks';
import { LyricsTrack } from './Tracks/LyricsTrack';
import { BackgroundLane } from './Tracks/BackgroundLane';
import { AudioWaveformSVG } from './Tracks/AudioWaveformSVG';
import { KeyframeTrack } from './Tracks/KeyframeTrack';
import { TimelineRuler } from './Tracks/TimelineRuler';
import { TrackSidebar } from './TrackSidebar';
import type { LyricTheme, ThrenicWord } from '@/types/lyrics';
import type { Keyframe } from '@/types/keyframes';
import type { VideoClip } from '@/types/video-clips';
import styles from './Timeline.module.css';
import { usePanels } from '@/contexts';
import { usePlaylist } from '@/contexts/PlaylistContext';
import { timeStore } from '@/engine/stores/timeStore';
import { useMediaQuery } from '@/hooks';

interface TimelineProps {
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  audioBuffer?: AudioBuffer | null;
  disabled?: boolean;
  onNextTrack?: () => void;
  onPreviousTrack?: () => void;
  isLastTrack?: boolean;
  words?: ThrenicWord[];
  setWords?: React.Dispatch<React.SetStateAction<ThrenicWord[]>>;
  audioElementRef?: React.RefObject<HTMLAudioElement | null>;
  keyframes?: Keyframe[];
  setKeyframes?: React.Dispatch<React.SetStateAction<Keyframe[]>>;
  videoClips?: VideoClip[];
  setVideoClips?: React.Dispatch<React.SetStateAction<VideoClip[]>>;
  selectedTrackId?: string | null;
  updateTrackKeyframes?: (id: string, keyframes: Keyframe[]) => void;
  onNextKeyframe?: () => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const RULER_HEIGHT = 34;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

export function Timeline({
  duration,
  isPlaying,
  playbackRate,
  onPlayPause,
  onSeek,
  onPlaybackRateChange,
  audioBuffer,
  disabled,
  onNextTrack,
  onPreviousTrack,
  onNextKeyframe,
  isLastTrack,
  words = [],
  setWords,
  audioElementRef,
  keyframes: keyframesProp,
  setKeyframes: setKeyframesProp,
  videoClips: videoClipsProp,
  setVideoClips: setVideoClipsProp,
  selectedTrackId,
  updateTrackKeyframes,
}: TimelineProps) {
  // Internal state for keyframes when not controlled externally
  const [internalKeyframes, setInternalKeyframes] = React.useState<Keyframe[]>([]);
  const keyframes = keyframesProp ?? internalKeyframes;
  const setKeyframes = setKeyframesProp ?? setInternalKeyframes;

  // Internal state for video clips when not controlled externally
  const [internalVideoClips, setInternalVideoClips] = React.useState<VideoClip[]>([]);
  const videoClips = videoClipsProp ?? internalVideoClips;
  const setVideoClips = setVideoClipsProp ?? setInternalVideoClips;

  const isMobile = useMediaQuery('(max-width: 768px)');

  const { bottomCollapsed } = usePanels();
  const isVisible = isMobile ? true : !bottomCollapsed;

  const [zoom, setZoom] = useState(100);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // Spectrum layers (which SVG paths render in audio track)
  const [spectrumLayers, setSpectrumLayers] = useState({
    bass: true,
    mid: true,
    high: true,
  });

  // Volume state
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  // Accumulated zoom delta
  const zoomDeltaAccum = useRef(0);
  const zoomRafId = useRef<number | null>(null);

  // viewOffset is the pixel position of the left edge of the view in the timeline
  const viewOffsetRef = useRef(0);

  // Playhead Ref for direct DOM manipulation
  const globalPlayheadRef = useRef<HTMLDivElement>(null);

  const handleSetWords = useMemo(() => setWords || (() => {}), [setWords]);

  // Resize Observer
  useResizeObserver(scrollAreaRef as React.RefObject<HTMLElement>, (entry: ResizeObserverEntry) => {
    setContainerWidth(entry.contentRect.width);
    setContainerHeight(entry.contentRect.height);
  });

  // Zoom Handlers
  const handleZoom = useCallback((delta: number) => {
    setZoom((z) => Math.max(20, Math.min(500, z + delta)));
  }, []);

  const handleWheelZoom = useCallback((e: React.WheelEvent) => {
    const direction = e.deltaY > 0 ? -1 : 1;
    zoomDeltaAccum.current += direction * 20;

    if (zoomRafId.current === null) {
      zoomRafId.current = requestAnimationFrame(() => {
        const delta = zoomDeltaAccum.current;
        zoomDeltaAccum.current = 0;
        zoomRafId.current = null;
        if (delta !== 0) {
          setZoom((z) => Math.max(20, Math.min(500, z + delta)));
        }
      });
    }
  }, []);

  // Smooth scroll loop for playhead positioning
  useEffect(
    function smoothScrollLoop() {
      let animationId: number | null = null;
      let lastTargetOffset = -1;
      let lastVisiblePlayheadX = -1;

      function render() {
        if (timeStore.getState().mode === 'export') {
          animationId = requestAnimationFrame(render);
          return;
        }

        let time = timeStore.getState().currentTime;

        if (audioElementRef?.current && isPlaying) {
          time = audioElementRef.current.currentTime;
        }

        const playheadX = time * zoom;
        const center = containerWidth / 2;
        const targetOffset = Math.max(0, playheadX - center);
        const visiblePlayheadX = playheadX - targetOffset;

        if (targetOffset !== lastTargetOffset || visiblePlayheadX !== lastVisiblePlayheadX) {
          viewOffsetRef.current = targetOffset;

          if (targetOffset !== lastTargetOffset) {
            window.dispatchEvent(new CustomEvent('threnicViewOffset', { detail: targetOffset }));
          }

          if (globalPlayheadRef.current) {
            globalPlayheadRef.current.style.transform = `translateX(${visiblePlayheadX}px)`;
          }

          // Dispatch play progress for waveform clip sync (same rAF as playhead)
          const progress = duration > 0 ? (time / duration) * 100 : 0;
          window.dispatchEvent(new CustomEvent('threnicPlayProgress', { detail: progress }));

          lastTargetOffset = targetOffset;
          lastVisiblePlayheadX = visiblePlayheadX;
        }

        animationId = requestAnimationFrame(render);
      }

      if (isVisible) {
        animationId = requestAnimationFrame(render);
      }

      return () => {
        if (animationId) cancelAnimationFrame(animationId);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- duration omitted on purpose: adding it would restart the rAF loop and re-dispatch view events
    [isPlaying, zoom, containerWidth, audioElementRef, isVisible],
  );

  const handleSeek = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    const isInsideTimelineItem = (el: HTMLElement | null): boolean => {
      if (!el) return false;
      const classList = Array.from(el.classList || []);
      const hasTimelineClass = classList.some(
        (cls) =>
          cls.includes('wordBlock') ||
          cls.includes('lineBox') ||
          cls.includes('lineHandle') ||
          cls.includes('kfChip') ||
          cls.includes('clipBlock') ||
          cls.includes('resizeHandle') ||
          cls.includes('trackHeader') ||
          cls.includes('laneDivider'),
      );
      if (hasTimelineClass) return true;
      if (el.hasAttribute('data-kf-id') || el.hasAttribute('data-kf-chip')) return true;
      return isInsideTimelineItem(el.parentElement);
    };

    if (
      isInsideTimelineItem(target) ||
      target.closest('input') ||
      target.closest('button') ||
      target.closest('select') ||
      target.closest('textarea')
    ) {
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const absoluteX = clickX + viewOffsetRef.current;
    const time = absoluteX / zoom;

    onSeek(Math.min(duration, Math.max(0, time)));
  };

  const handleAddLyrics = useCallback(
    function addLyricsAtTime(startTimeOverride?: number) {
      const text = window.prompt('Enter lyrics/words to add (separated by space):');
      if (!text) return;

      const newWordsParts = text.trim().split(/\s+/);
      if (newWordsParts.length === 0) return;

      const startTime =
        startTimeOverride !== undefined ? startTimeOverride : timeStore.getState().currentTime;
      const wordDuration = 1.0;

      const newWords: ThrenicWord[] = newWordsParts.map((wordText, index) => {
        const start = startTime + index * wordDuration;
        return {
          id: crypto.randomUUID(),
          text: wordText,
          startTime: start,
          endTime: start + wordDuration,
          isLineStart: index === 0,
        };
      });

      handleSetWords((prev) => [...prev, ...newWords].sort((a, b) => a.startTime - b.startTime));
    },
    [handleSetWords],
  );

  // Lyrics lane height calculation
  const {
    tracks: playlistTracks,
    selectedTrackId: activeTrackId,
    updateTrackLyricsTheme,
  } = usePlaylist();
  const currentTrackForLanes = playlistTracks.find((t) => t.id === activeTrackId);
  const lyricsLaneCount = currentTrackForLanes?.lyricsTheme?.laneCount ?? 1;
  const setLaneCount = useCallback(
    (updater: (prev: number) => number) => {
      if (!activeTrackId || !currentTrackForLanes) return;
      const newCount = updater(lyricsLaneCount);
      const theme = currentTrackForLanes.lyricsTheme ?? ({} as LyricTheme);
      updateTrackLyricsTheme(activeTrackId, { ...theme, laneCount: newCount });
    },
    [activeTrackId, currentTrackForLanes, lyricsLaneCount, updateTrackLyricsTheme],
  );

  // Dynamic lyrics height: base + expansion per lane
  // Grid template: 34px 1.2fr 1fr 0.7fr 1.5fr (total = 4.4fr for tracks)
  const trackAreaHeight = Math.max(0, containerHeight - RULER_HEIGHT);
  const totalFr = 4.4;
  const lyricsHeight = Math.floor(trackAreaHeight * (1.2 / totalFr));
  const backgroundHeight = Math.floor(trackAreaHeight * (1.0 / totalFr));
  const effectsHeight = Math.floor(trackAreaHeight * (0.7 / totalFr));

  // Volume control
  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      setVolume(val);
      setIsMuted(val === 0);
      if (audioElementRef?.current) {
        audioElementRef.current.volume = val;
        audioElementRef.current.muted = val === 0;
      }
    },
    [audioElementRef],
  );

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (audioElementRef?.current) {
        audioElementRef.current.muted = next;
      }
      return next;
    });
  }, [audioElementRef]);

  // Speed cycle for narrow viewport
  const cycleSpeed = useCallback(() => {
    const idx = SPEED_OPTIONS.indexOf(playbackRate);
    const nextIdx = (idx + 1) % SPEED_OPTIONS.length;
    onPlaybackRateChange(SPEED_OPTIONS[nextIdx]);
  }, [playbackRate, onPlaybackRateChange]);

  // Current time from store for display
  const [displayTime, setDisplayTime] = useState(0);
  useEffect(() => {
    let raf: number;
    function tick() {
      const t = audioElementRef?.current?.currentTime ?? timeStore.getState().currentTime;
      setDisplayTime(t);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioElementRef]);

  return (
    <div
      className={styles.container}
      style={{
        pointerEvents: disabled ? 'none' : 'auto',
        opacity: disabled ? 0.5 : 1,
      }}
      data-testid="timeline-container"
    >
      {/* ─── Toolbar ─── */}
      <div className={styles.toolbar} data-testid="timeline-toolbar">
        {/* Left: Time readout + status */}
        <div className={styles.toolbarLeft}>
          <div className={styles.timePill}>
            <span className={styles.timeMain}>{formatTime(displayTime)}</span>
            <span className={styles.timeSeparator}>/</span>
            <span className={styles.timeTotal}>{formatTime(duration)}</span>
          </div>
          <div className={styles.statusGroup}>
            <div className={styles.statusDot} data-state={isPlaying ? 'playing' : 'paused'} />
            <span className={styles.statusLabel}>{isPlaying ? 'Playing' : 'Paused'}</span>
          </div>
        </div>

        {/* Center: Transport */}
        <div className={styles.toolbarCenter}>
          <button
            className={styles.transportBtn}
            onClick={() => {
              const currentPos = timeStore.getState().currentTime;
              if (currentPos < 1 && onPreviousTrack) {
                // If at the very start, try to go to previous track.
                // If there's only one track, rewind to 0 instead.
                onPreviousTrack();
              } else {
                onSeek(0);
              }
            }}
            title="Rewind"
            data-testid="timeline-prev-track"
          >
            <SkipBack size={14} />
          </button>
          <button className={styles.transportBtn} onClick={() => onSeek(0)} title="Rewind to start">
            <Rewind size={14} />
          </button>
          <button
            className={styles.playBtn}
            onClick={onPlayPause}
            title={isPlaying ? 'Pause' : 'Play'}
            data-testid="timeline-play-pause"
          >
            {isPlaying ? <Pause size={20} /> : <Play size={20} style={{ marginLeft: 2 }} />}
          </button>
          <button className={styles.transportBtn} onClick={onNextKeyframe} title="Next keyframe">
            <FastForward size={14} />
          </button>
          <button
            className={styles.transportBtn}
            onClick={onNextTrack}
            disabled={isLastTrack}
            title="Next track"
            data-testid="timeline-next-track"
          >
            <SkipForward size={14} />
          </button>
        </div>

        {/* Right: Volume, Zoom, Speed */}
        <div className={styles.toolbarRight}>
          {/* Volume */}
          <div className={styles.volumeGroup}>
            <button
              className={styles.muteBtn}
              onClick={toggleMute}
              data-muted={isMuted}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className={styles.volumeSlider}
              aria-label="Volume"
            />
          </div>

          {/* Zoom */}
          <div className={styles.zoomGroup}>
            <button className={styles.zoomBtn} onClick={() => handleZoom(-20)} title="Zoom out">
              −
            </button>
            <span className={styles.zoomLabel}>{zoom}%</span>
            <button className={styles.zoomBtn} onClick={() => handleZoom(20)} title="Zoom in">
              +
            </button>
          </div>

          {/* Speed (full) */}
          <div className={styles.speedGroup}>
            {SPEED_OPTIONS.map((s) => (
              <button
                key={s}
                className={styles.speedBtn}
                data-active={playbackRate === s}
                onClick={() => onPlaybackRateChange(s)}
              >
                {s}×
              </button>
            ))}
          </div>

          {/* Speed cycle (narrow) */}
          <button
            className={styles.speedCycleBtn}
            onClick={cycleSpeed}
            title={`Speed: ${playbackRate}×`}
          >
            {playbackRate}×
          </button>
        </div>
      </div>

      {/* ─── Body: Sidebar + Scroll Area ─── */}
      <div className={styles.bodyRow}>
        {/* Track Sidebar */}
        {!isMobile && (
          <TrackSidebar
            lyricsLaneCount={lyricsLaneCount}
            onLaneCountChange={setLaneCount}
            spectrumLayers={spectrumLayers}
            onSpectrumLayerToggle={(layer: 'bass' | 'mid' | 'high') =>
              setSpectrumLayers((prev) => ({ ...prev, [layer]: !prev[layer] }))
            }
          />
        )}

        {/* Scrollable Track Area */}
        <div
          className={styles.scrollArea}
          ref={scrollAreaRef}
          data-testid="timeline-ruler"
          onClick={handleSeek}
          onWheel={handleWheelZoom}
        >
          {/* Playhead */}
          <div ref={globalPlayheadRef} className={styles.playhead} style={{ left: 0 }}>
            <div className={styles.playheadDiamond} />
          </div>

          {/* Ruler */}
          <div className={styles.ruler}>
            <TimelineRuler
              zoom={zoom}
              width={containerWidth}
              height={RULER_HEIGHT}
              viewOffsetRef={viewOffsetRef}
              isVisible={isVisible}
            />
          </div>

          {/* Lyrics Lane */}
          <div className={`${styles.trackLane} ${styles.lyricsLane}`}>
            <LyricsTrack
              words={words}
              setWords={handleSetWords}
              zoom={zoom}
              viewOffsetRef={viewOffsetRef}
              height={lyricsHeight}
              onAddLyricAt={handleAddLyrics}
              topPadding={0}
              isVisible={isVisible}
            />
          </div>

          {/* Background Lane */}
          <div className={`${styles.trackLane} ${styles.backgroundLane}`}>
            <BackgroundLane
              clips={videoClips}
              setClips={setVideoClips}
              zoom={zoom}
              viewOffsetRef={viewOffsetRef}
              height={backgroundHeight}
              width={containerWidth}
              isVisible={isVisible}
              trackId={selectedTrackId || undefined}
              keyframes={keyframes}
              updateTrackKeyframes={updateTrackKeyframes}
              topPadding={0}
            />
          </div>

          {/* Effects Lane */}
          <div className={`${styles.trackLane} ${styles.effectsLane}`}>
            <KeyframeTrack
              keyframes={keyframes}
              setKeyframes={setKeyframes}
              zoom={zoom}
              viewOffsetRef={viewOffsetRef}
              height={effectsHeight}
              width={containerWidth}
              topPadding={0}
              isVisible={isVisible}
              trackId={selectedTrackId || undefined}
              updateTrackKeyframes={updateTrackKeyframes}
            />
          </div>

          {/* Audio Lane */}
          <div className={`${styles.trackLane} ${styles.audioLane}`}>
            <AudioWaveformSVG
              audioBuffer={audioBuffer}
              duration={duration}
              zoom={zoom}
              width={containerWidth}
              viewOffsetRef={viewOffsetRef}
              isVisible={isVisible}
              layers={spectrumLayers}
              accentColor="#ef4a3a"
              playProgress={duration > 0 ? (displayTime / duration) * 100 : 0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

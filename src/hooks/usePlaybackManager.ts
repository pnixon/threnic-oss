import { useCallback, useEffect, useRef } from 'react';
import type { Track } from '@/contexts/types';
import { PlaylistSettings } from '@/types/project';
import { createLogger } from '@/utils/logger';
import { timeStore } from '@/engine/stores/timeStore';
import { getRelativeTrackTime } from '@/engine/stores/exportStore';

const logger = createLogger({ enabled: true, prefix: 'PlaybackManager' });

interface UsePlaybackManagerProps {
  audioUrl: string | undefined;
  duration: number;
  setDur: (v: number) => void;
  setTime: (v: number) => void;
  isPlaying: boolean;
  setPlaying: (v: boolean) => void;
  isExporting: boolean;
  audioPlayerRef: React.RefObject<HTMLAudioElement | null>;
  gapTimeoutRef: React.RefObject<NodeJS.Timeout | null>;
  selectedTrackId: string | null;
  tracks: Track[];
  settings: PlaylistSettings;
  selectNextTrack: () => void;
  selectionRange?: { start: number; end: number } | null;
}

export function usePlaybackManager({
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
  selectionRange,
}: UsePlaybackManagerProps) {
  const handleSeek = useCallback(
    (time: number) => {
      let targetTime = time;

      // If selection is active, ensure seek is within selection bounds
      if (selectionRange) {
        if (time < selectionRange.start - 0.001 || time > selectionRange.end + 0.001) {
          targetTime = selectionRange.start;
        }
      }

      const audio = audioPlayerRef.current;
      logger.debug(
        '[handleSeek] seek requested →',
        `requested=${time.toFixed(3)}s`,
        `clamped=${targetTime.toFixed(3)}s`,
        `isPlaying=${isPlaying}`,
        `audio.paused=${audio?.paused ?? 'N/A'}`,
        `audio.currentTime=${audio ? audio.currentTime.toFixed(3) + 's' : 'N/A'}`,
        `audio.readyState=${audio?.readyState ?? 'N/A'}`,
      );

      setTime(targetTime);
      timeStore.getState().setCurrentTime(targetTime, true);
      if (audio) {
        audio.currentTime = targetTime;
      }
    },
    [setTime, selectionRange, audioPlayerRef, isPlaying],
  );

  const handlePlayPause = useCallback(() => {
    if (!audioUrl) {
      console.warn('No audio loaded');
      return;
    }

    const audio = audioPlayerRef.current;
    const newState = !isPlaying;

    logger.debug(
      `[handlePlayPause] ${isPlaying ? 'PAUSE' : 'PLAY'} pressed →`,
      `newIsPlaying=${newState}`,
      `audio.paused=${audio?.paused ?? 'N/A'}`,
      `audio.currentTime=${audio ? audio.currentTime.toFixed(3) + 's' : 'N/A'}`,
      `audio.readyState=${audio?.readyState ?? 'N/A'}`,
      `audio.src=${audio?.src ? '✓' : '✗'}`,
    );

    // If selection is active and we are outside of it, jump to start before toggling play/pause
    if (selectionRange) {
      const current = timeStore.getState().currentTime;
      if (current < selectionRange.start - 0.001 || current > selectionRange.end + 0.001) {
        handleSeek(selectionRange.start);
      }
    }

    setPlaying(newState);
    timeStore.getState().setIsPlaying(newState);

    if (newState && gapTimeoutRef.current) {
      clearTimeout(gapTimeoutRef.current);
      gapTimeoutRef.current = null;
    }
  }, [isPlaying, audioUrl, setPlaying, gapTimeoutRef, selectionRange, handleSeek, audioPlayerRef]);

  const handleDurationChange = useCallback(
    (dur: number) => {
      setDur(dur);
      timeStore.getState().setDuration(dur);
    },
    [setDur],
  );

  const handleTimeUpdate = useCallback(
    (time: number) => {
      if (isExporting) return;

      // Update timeStore IMMEDIATELY so visuals/animations are smooth
      timeStore.getState().setCurrentTime(time);

      // Handle loop/limit if selection is active
      if (selectionRange && isPlaying) {
        if (time >= selectionRange.end) {
          handleSeek(selectionRange.start);
          if (audioPlayerRef.current) {
            audioPlayerRef.current.currentTime = selectionRange.start;
          }
          return;
        }
      }

      if (isPlaying && settings.autoNext && duration > 0) {
        const currentIndex = tracks.findIndex((t) => t.id === selectedTrackId);
        const isLastTrack = currentIndex === tracks.length - 1;

        if (time >= duration - 0.1) {
          if (isLastTrack) {
            setPlaying(false);
            timeStore.getState().setIsPlaying(false);
            setTime(duration);
            timeStore.getState().setCurrentTime(duration);
          }
          return;
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectNextTrack kept so the callback identity changes exactly as before
    [
      isPlaying,
      duration,
      settings.autoNext,
      tracks,
      selectedTrackId,
      selectNextTrack,
      isExporting,
      setTime,
      setPlaying,
      selectionRange,
      handleSeek,
      audioPlayerRef,
    ],
  );

  const handleEnded = useCallback(() => {
    const currentIndex = tracks.findIndex((t) => t.id === selectedTrackId);
    const isLastTrack = currentIndex === tracks.length - 1;

    if (settings.autoNext && !isLastTrack) {
      setTime(0);
      timeStore.getState().setCurrentTime(0, true);
      if (audioPlayerRef.current) {
        audioPlayerRef.current.currentTime = 0;
      }
      selectNextTrack();
      setPlaying(true);
      timeStore.getState().setIsPlaying(true);
    } else {
      setPlaying(false);
      timeStore.getState().setIsPlaying(false);
      const resetTime = selectionRange ? selectionRange.start : 0;
      setTime(resetTime);
      timeStore.getState().setCurrentTime(resetTime);
    }
  }, [
    settings.autoNext,
    selectNextTrack,
    tracks,
    selectedTrackId,
    setPlaying,
    setTime,
    selectionRange,
    audioPlayerRef,
  ]);

  // Sync timeStore.getState().isPlaying with local state
  useEffect(() => {
    let lastIsPlaying = timeStore.getState().isPlaying;
    return timeStore.subscribe((state) => {
      if (state.isPlaying !== lastIsPlaying) {
        lastIsPlaying = state.isPlaying;
        const playing = state.isPlaying;
        setPlaying(playing);
        if (!playing && audioPlayerRef.current) {
          audioPlayerRef.current.pause();
        }
      }
    });
  }, [setPlaying, audioPlayerRef]);

  // Stop playback when export starts
  useEffect(() => {
    if (isExporting) {
      timeStore.getState().setIsPlaying(false);
    }
  }, [isExporting]);

  const lastTrackIdRef = useRef<string | null>(null);

  // Reset playhead and seek to 0 whenever track selection changes to prevent skip loops
  useEffect(() => {
    if (lastTrackIdRef.current !== null && lastTrackIdRef.current !== selectedTrackId) {
      logger.debug('[selectedTrackId changed] Resetting playhead to 0');
      setTime(0);
      timeStore.getState().setCurrentTime(0, true);
      if (audioPlayerRef.current) {
        audioPlayerRef.current.currentTime = 0;
      }
    }
    lastTrackIdRef.current = selectedTrackId;
  }, [selectedTrackId, setTime, audioPlayerRef]);

  // Stop playback if audio source is removed (e.g. track deleted)
  useEffect(() => {
    if (!audioUrl && isPlaying) {
      setPlaying(false);
      timeStore.getState().setIsPlaying(false);
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        audioPlayerRef.current.currentTime = 0;
      }
    }
  }, [audioUrl, isPlaying, setPlaying, audioPlayerRef]);

  // Sync timeStore.getState().currentTime to React state during playback and export
  useEffect(() => {
    let timeoutId: number;

    const sync = () => {
      const time = timeStore.getState().currentTime;
      setTime(time);
      timeoutId = window.setTimeout(sync, 100);
    };

    if (isPlaying || isExporting) {
      if (isExporting) {
        // Lower frequency interval for export to avoid UI thrashing
        const intervalId = setInterval(() => {
          const time = getRelativeTrackTime(
            timeStore.getState().mode,
            timeStore.getState().currentTime,
          );
          setTime(time);
        }, 500);
        return () => clearInterval(intervalId);
      } else {
        // Reduced frequency setTimeout (10fps / 100ms) for preview playback instead of 60fps RAF.
        // Critical updates are handled directly by timeStore subscriptions bypassing React, so this
        // simply keeps non-critical React prop state updated.
        timeoutId = window.setTimeout(sync, 100);
        return () => clearTimeout(timeoutId);
      }
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isPlaying, isExporting, setTime]);

  return {
    handlePlayPause,
    handleSeek,
    handleDurationChange,
    handleTimeUpdate,
    handleEnded,
  };
}

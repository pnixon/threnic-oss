'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SkipBack, SkipForward, Play, Pause, ChevronUp, ChevronDown } from 'lucide-react';
import { timeStore } from '@/engine/stores/timeStore';
import styles from './MobilePlayerBar.module.css';

interface MobilePlayerBarProps {
  duration: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onPreviousTrack?: () => void;
  onNextTrack?: () => void;
  isLastTrack?: boolean;
  disabled?: boolean;
  /** Whether the full detailed timeline sheet is expanded */
  timelineExpanded: boolean;
  onToggleTimeline: () => void;
  audioElementRef?: React.RefObject<HTMLAudioElement | null>;
  trackTitle?: string;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Compact, touch-first transport bar for the mobile Stage tab.
 * Replaces the dense desktop Timeline toolbar on phones so the canvas
 * gets the majority of the viewport. The full detailed timeline (ruler +
 * lanes) is reachable via the expand toggle for power editing.
 */
export function MobilePlayerBar({
  duration,
  isPlaying,
  onPlayPause,
  onSeek,
  onPreviousTrack,
  onNextTrack,
  isLastTrack,
  disabled,
  timelineExpanded,
  onToggleTimeline,
  audioElementRef,
  trackTitle,
}: MobilePlayerBarProps): React.ReactElement {
  // Live playhead time from the audio element / time store (rAF-driven)
  const [displayTime, setDisplayTime] = useState(0);
  // While the user is actively dragging the scrubber, show the drag value
  // instead of the live playhead so the thumb doesn't fight the finger.
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const scrubbingRef = useRef(false);

  useEffect(() => {
    let raf: number;
    function tick() {
      if (!scrubbingRef.current) {
        const t = audioElementRef?.current?.currentTime ?? timeStore.getState().currentTime;
        setDisplayTime(t);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioElementRef]);

  const currentTime = scrubValue ?? displayTime;
  const max = duration > 0 ? duration : 100;
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const handleScrubStart = useCallback(() => {
    scrubbingRef.current = true;
  }, []);

  const handleScrubChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setScrubValue(parseFloat(e.target.value));
  }, []);

  const handleScrubCommit = useCallback(
    (e: React.SyntheticEvent<HTMLInputElement>) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      onSeek(val);
      scrubbingRef.current = false;
      // Keep showing the committed value briefly to avoid a flash back
      // to the pre-seek time before the audio element catches up.
      setTimeout(() => setScrubValue(null), 60);
    },
    [onSeek],
  );

  return (
    <div
      className={styles.bar}
      style={{ pointerEvents: disabled ? 'none' : 'auto', opacity: disabled ? 0.5 : 1 }}
      data-testid="mobile-player-bar"
    >
      {/* Row 1: scrubber with inline time readouts */}
      <div className={styles.scrubRow}>
        <span className={styles.time}>{formatTime(currentTime)}</span>
        <div className={styles.scrubTrack}>
          <div className={styles.scrubFill} style={{ width: `${progressPct}%` }} />
          <input
            type="range"
            min={0}
            max={max}
            step={0.05}
            value={currentTime}
            onChange={handleScrubChange}
            onPointerDown={handleScrubStart}
            onTouchStart={handleScrubStart}
            onMouseUp={handleScrubCommit}
            onTouchEnd={handleScrubCommit}
            onKeyUp={handleScrubCommit}
            className={styles.scrubInput}
            aria-label="Seek"
            disabled={disabled}
          />
        </div>
        <span className={styles.timeTotal}>{formatTime(duration)}</span>
      </div>

      {/* Row 2: transport + expand */}
      <div className={styles.controlsRow}>
        {trackTitle ? (
          <span className={styles.trackTitle} title={trackTitle}>
            {trackTitle}
          </span>
        ) : (
          <span className={styles.trackTitle} />
        )}

        <div className={styles.transport}>
          <button
            className={styles.transportBtn}
            onClick={() => {
              const pos = timeStore.getState().currentTime;
              if (pos < 1 && onPreviousTrack) onPreviousTrack();
              else onSeek(0);
            }}
            aria-label="Previous / rewind"
            data-testid="mobile-prev"
          >
            <SkipBack size={20} />
          </button>

          <button
            className={styles.playBtn}
            onClick={onPlayPause}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            data-testid="mobile-play-pause"
          >
            {isPlaying ? <Pause size={26} /> : <Play size={26} style={{ marginLeft: 3 }} />}
          </button>

          <button
            className={styles.transportBtn}
            onClick={onNextTrack}
            disabled={isLastTrack}
            aria-label="Next track"
            data-testid="mobile-next"
          >
            <SkipForward size={20} />
          </button>
        </div>

        <button
          className={`${styles.expandBtn} ${timelineExpanded ? styles.expandActive : ''}`}
          onClick={onToggleTimeline}
          aria-label={timelineExpanded ? 'Hide timeline' : 'Show timeline'}
          aria-expanded={timelineExpanded}
          data-testid="mobile-timeline-toggle"
        >
          {timelineExpanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          <span className={styles.expandLabel}>Timeline</span>
        </button>
      </div>
    </div>
  );
}

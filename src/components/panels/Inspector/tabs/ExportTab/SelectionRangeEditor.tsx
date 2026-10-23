'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';
import styles from './SelectionRangeEditor.module.css';

interface SelectionRangeEditorProps {
  /** Audio buffer to visualize */
  audioBuffer?: AudioBuffer | null;
  /** Total duration in seconds */
  duration: number;
  /** Selection range in seconds */
  selectionRange: { start: number; end: number };
  /** Callback when selection changes */
  onSelectionChange: (range: { start: number; end: number }) => void;
  /** Current playback time */
  currentTime?: number;
  /** Preview playback controls */
  isPlaying?: boolean;
  onPlayPause?: () => void;
}

type DragMode = 'none' | 'start' | 'end' | 'range';

export function SelectionRangeEditor({
  audioBuffer,
  duration,
  selectionRange,
  onSelectionChange,
  currentTime = 0,
  isPlaying = false,
  onPlayPause,
}: SelectionRangeEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragMode, setDragMode] = useState<DragMode>('none');
  const [hoverMode, setHoverMode] = useState<DragMode>('none');
  const dragStartRef = useRef<{ x: number; initialStart: number; initialEnd: number } | null>(null);

  const themeColorsRef = useRef({
    bg: '#050508',
    accent: '#ef4444',
    muted: 'rgba(255, 255, 255, 0.4)',
    selection: 'rgba(74, 158, 255, 0.3)',
  });

  // Update theme colors from CSS variables
  useEffect(() => {
    const updateColors = () => {
      const style = getComputedStyle(document.documentElement);
      themeColorsRef.current = {
        bg: style.getPropertyValue('--bg-app').trim() || '#050508',
        accent: style.getPropertyValue('--accent-main').trim() || '#ef4444',
        muted: style.getPropertyValue('--text-muted').trim() || 'rgba(255, 255, 255, 0.4)',
        selection: style.getPropertyValue('--selection-bg').trim() || 'rgba(74, 158, 255, 0.3)',
      };
    };

    updateColors();
    const observer = new MutationObserver(updateColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  // Responsive canvas sizing
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        setContainerWidth(entries[0].contentRect.width);
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer || containerWidth === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const colors = themeColorsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const height = 120;

    canvas.width = containerWidth * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, containerWidth, height);

    // Draw waveform
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / containerWidth);
    const amp = height / 2;

    ctx.fillStyle = colors.muted;
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(0, amp);

    for (let i = 0; i < containerWidth; i++) {
      const index = i * step;
      let min = 1.0;
      let max = -1.0;

      for (let j = 0; j < step && index + j < data.length; j++) {
        const datum = data[index + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }

      const yMin = (1 + min) * amp;
      const yMax = (1 + max) * amp;

      ctx.lineTo(i, yMax);
      ctx.lineTo(i, yMin);
    }

    ctx.lineTo(containerWidth, amp);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // Draw selection overlay
    const startX = (selectionRange.start / duration) * containerWidth;
    const endX = (selectionRange.end / duration) * containerWidth;

    // Dimmed areas outside selection
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, startX, height);
    ctx.fillRect(endX, 0, containerWidth - endX, height);

    // Selection background
    ctx.fillStyle = colors.selection;
    ctx.fillRect(startX, 0, endX - startX, height);

    // Selection borders
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(startX, height);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(endX, 0);
    ctx.lineTo(endX, height);
    ctx.stroke();

    // Draw playhead if within selection
    if (currentTime >= selectionRange.start && currentTime <= selectionRange.end) {
      const playheadX = (currentTime / duration) * containerWidth;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    }
  }, [audioBuffer, containerWidth, selectionRange, duration, currentTime]);

  // Pixel to time conversion
  const pixelToTime = useCallback(
    (x: number) => {
      return (x / containerWidth) * duration;
    },
    [containerWidth, duration],
  );

  // Handle mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = pixelToTime(x);

      const startX = (selectionRange.start / duration) * containerWidth;
      const endX = (selectionRange.end / duration) * containerWidth;

      // Determine what user is clicking on
      const HANDLE_THRESHOLD = 8;

      if (Math.abs(x - startX) < HANDLE_THRESHOLD) {
        setDragMode('start');
      } else if (Math.abs(x - endX) < HANDLE_THRESHOLD) {
        setDragMode('end');
      } else if (x >= startX && x <= endX) {
        setDragMode('range');
      } else {
        // Click outside - create new selection from this point
        setDragMode('end');
        onSelectionChange({ start: time, end: time });
      }

      dragStartRef.current = {
        x,
        initialStart: selectionRange.start,
        initialEnd: selectionRange.end,
      };
    },
    [containerWidth, duration, pixelToTime, selectionRange, onSelectionChange],
  );

  // Handle mouse move
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragMode === 'none' || !dragStartRef.current || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const deltaX = x - dragStartRef.current.x;
      const deltaTime = pixelToTime(deltaX) - pixelToTime(0);

      const { initialStart, initialEnd } = dragStartRef.current;

      let newStart = initialStart;
      let newEnd = initialEnd;

      if (dragMode === 'start') {
        newStart = Math.max(0, Math.min(initialEnd - 0.1, initialStart + deltaTime));
      } else if (dragMode === 'end') {
        newEnd = Math.max(initialStart + 0.1, Math.min(duration, initialEnd + deltaTime));
      } else if (dragMode === 'range') {
        const rangeDuration = initialEnd - initialStart;
        newStart = Math.max(0, Math.min(duration - rangeDuration, initialStart + deltaTime));
        newEnd = newStart + rangeDuration;
      }

      onSelectionChange({ start: newStart, end: newEnd });
    },
    [dragMode, pixelToTime, duration, onSelectionChange],
  );

  // Handle hover to show appropriate cursor
  const handleHover = useCallback(
    (e: React.MouseEvent) => {
      if (dragMode !== 'none' || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;

      const startX = (selectionRange.start / duration) * containerWidth;
      const endX = (selectionRange.end / duration) * containerWidth;

      const HANDLE_THRESHOLD = 8;

      if (Math.abs(x - startX) < HANDLE_THRESHOLD) {
        setHoverMode('start');
      } else if (Math.abs(x - endX) < HANDLE_THRESHOLD) {
        setHoverMode('end');
      } else if (x >= startX && x <= endX) {
        setHoverMode('range');
      } else {
        setHoverMode('none');
      }
    },
    [dragMode, containerWidth, duration, selectionRange],
  );

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    setDragMode('none');
    dragStartRef.current = null;
  }, []);

  // Register global mouse up listener
  useEffect(() => {
    if (dragMode !== 'none') {
      window.addEventListener('mouseup', handleMouseUp);
      return () => window.removeEventListener('mouseup', handleMouseUp);
    }
  }, [dragMode, handleMouseUp]);

  // Reset to full track
  const handleReset = () => {
    onSelectionChange({ start: 0, end: duration });
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const selectionDuration = selectionRange.end - selectionRange.start;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.timeInfo}>
          <div className={styles.timeLabel}>
            <span className={styles.label}>Start:</span>
            <span className={styles.time}>{formatTime(selectionRange.start)}</span>
          </div>
          <div className={styles.timeLabel}>
            <span className={styles.label}>End:</span>
            <span className={styles.time}>{formatTime(selectionRange.end)}</span>
          </div>
          <div className={styles.timeLabel}>
            <span className={styles.label}>Duration:</span>
            <span className={styles.time}>{formatTime(selectionDuration)}</span>
          </div>
        </div>
        <div className={styles.controls}>
          <button className={styles.controlBtn} onClick={handleReset} title="Reset to full track">
            <RotateCcw size={14} />
          </button>
          {onPlayPause && (
            <button
              className={`${styles.controlBtn} ${styles.playBtn}`}
              onClick={onPlayPause}
              title={isPlaying ? 'Pause preview' : 'Preview selection'}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className={styles.waveformContainer}
        onMouseDown={handleMouseDown}
        onMouseMove={dragMode !== 'none' ? handleMouseMove : handleHover}
        style={{
          cursor:
            dragMode !== 'none'
              ? 'grabbing'
              : hoverMode === 'start' || hoverMode === 'end'
                ? 'ew-resize'
                : hoverMode === 'range'
                  ? 'move'
                  : 'default',
        }}
      >
        <canvas ref={canvasRef} className={styles.waveform} />
        <div className={styles.instructions}>
          Click and drag edges to adjust • Drag selection to move • Click outside to reset
        </div>
      </div>
    </div>
  );
}

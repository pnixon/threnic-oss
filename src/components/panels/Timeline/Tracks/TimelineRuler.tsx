'use client';

import React, { useRef, useEffect, memo } from 'react';
import styles from '../Timeline.module.css';

interface TimelineRulerProps {
  zoom: number;
  width: number;
  height: number;
  viewOffsetRef: React.MutableRefObject<number>;
  isVisible?: boolean;
}

interface RulerColors {
  bg: string;
  major: string;
  minor: string;
  text: string;
}

const INTERVALS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];
const MIN_LABEL_SPACE = 60;

function getThemeColors(): RulerColors {
  const style = getComputedStyle(document.documentElement);
  return {
    bg: style.getPropertyValue('--bg-app').trim() || '#0f0b15',
    major: style.getPropertyValue('--text-muted').trim() || 'rgba(255, 255, 255, 0.4)',
    minor: style.getPropertyValue('--border-subtle').trim() || 'rgba(255, 255, 255, 0.15)',
    text: style.getPropertyValue('--text-secondary').trim() || 'rgba(255, 255, 255, 0.6)',
  };
}

function drawRuler(
  canvas: HTMLCanvasElement,
  zoom: number,
  width: number,
  height: number,
  scrollLeft: number,
): void {
  if (!width || !height) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  const colors = getThemeColors();

  // Clear
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);

  // Draw line at the bottom
  ctx.strokeStyle = colors.minor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height - 1);
  ctx.lineTo(width, height - 1);
  ctx.stroke();

  // Calculate intervals
  let interval = INTERVALS[0];
  for (const candidate of INTERVALS) {
    if (candidate * zoom >= MIN_LABEL_SPACE) {
      interval = candidate;
      break;
    }
  }

  const subInterval = interval / 5;
  const startTimeVisible = scrollLeft / zoom;
  const endTimeVisible = (scrollLeft + width) / zoom;
  const tStart = Math.floor(startTimeVisible / subInterval) * subInterval;

  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let t = tStart; t <= endTimeVisible; t += subInterval) {
    const x = t * zoom - scrollLeft;
    if (x < -1 || x > width + 1) continue;

    // Fix floating point accumulation errors
    const roundedT = Math.round(t * 1000) / 1000;

    const isMajor =
      Math.abs(roundedT % interval) < 0.001 || Math.abs((roundedT % interval) - interval) < 0.001;
    const tickHeight = isMajor ? 8 : 4;

    ctx.strokeStyle = isMajor ? colors.major : colors.minor;
    ctx.beginPath();
    ctx.moveTo(x, height - 1);
    ctx.lineTo(x, height - 1 - tickHeight);
    ctx.stroke();

    if (isMajor) {
      ctx.fillStyle = colors.text;
      const minutes = Math.floor(roundedT / 60);
      const seconds = Math.floor(roundedT % 60);

      let label = '';
      if (interval >= 1) {
        label = minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
      } else {
        label = `${roundedT.toFixed(1)}s`;
      }

      ctx.fillText(label, x, 2);
    }
  }
}

function TimelineRulerComponent({
  zoom,
  width,
  height,
  viewOffsetRef,
  isVisible = true,
}: TimelineRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isVisible) return;

    const redraw = (scrollLeft: number = viewOffsetRef.current) => {
      const canvas = canvasRef.current;
      if (canvas) drawRuler(canvas, zoom, width, height, scrollLeft);
    };

    redraw();

    const handleScroll = (e: Event) => {
      redraw((e as CustomEvent<{ scrollLeft: number }>).detail.scrollLeft);
    };
    window.addEventListener('threnicViewOffset', handleScroll);

    // Repaint when the theme changes (data-theme flip on <html>); nothing else
    // fires on a theme switch, so the ruler would keep its previous colors.
    const observer = new MutationObserver(() => redraw());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      window.removeEventListener('threnicViewOffset', handleScroll);
      observer.disconnect();
    };
  }, [zoom, width, height, isVisible, viewOffsetRef]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.ruler}
      style={{
        width,
        height,
      }}
    />
  );
}

export const TimelineRuler = memo(TimelineRulerComponent);

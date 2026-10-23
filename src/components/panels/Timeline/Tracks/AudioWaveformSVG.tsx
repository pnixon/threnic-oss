'use client';

import React, { memo, useMemo, useRef, useEffect } from 'react';

interface AudioWaveformSVGProps {
  audioBuffer: AudioBuffer | null | undefined;
  duration: number;
  zoom: number;
  width: number;
  viewOffsetRef: React.MutableRefObject<number>;
  isVisible?: boolean;
  layers: { bass: boolean; mid: boolean; high: boolean };
  accentColor?: string;
  playProgress: number;
}

interface WavePoint {
  x: number;
  yTop: number;
  yBot: number;
}

function computeWaveformData(audioBuffer: AudioBuffer): {
  bass: WavePoint[];
  mid: WavePoint[];
  high: WavePoint[];
} {
  const channelData = audioBuffer.getChannelData(0);
  const totalSamples = channelData.length;
  const numPoints = 1200;
  const blockSize = Math.floor(totalSamples / numPoints);

  const bass: WavePoint[] = [];
  const mid: WavePoint[] = [];
  const high: WavePoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const x = (i / numPoints) * 1000;
    const start = i * blockSize;
    const end = Math.min(start + blockSize, totalSamples);

    let sumAbs = 0;
    let sumSq = 0;
    let maxVal = 0;
    let crossings = 0;
    let prevSign = channelData[start] >= 0 ? 1 : -1;

    for (let j = start; j < end; j++) {
      const sample = channelData[j];
      const abs = Math.abs(sample);
      sumAbs += abs;
      sumSq += sample * sample;
      if (abs > maxVal) maxVal = abs;

      const sign = sample >= 0 ? 1 : -1;
      if (sign !== prevSign) crossings++;
      prevSign = sign;
    }

    const count = end - start;
    const rms = Math.sqrt(sumSq / count);
    const avg = sumAbs / count;

    // Bass: smooth low-frequency energy (RMS based, heavily smoothed)
    const bassEnergy = Math.pow(rms, 0.7) * 0.85;
    const bassAmplitude = Math.min(bassEnergy * 42, 42);
    bass.push({
      x,
      yTop: 50 - bassAmplitude,
      yBot: 50 + bassAmplitude,
    });

    // Mid: more variation, modulated by position for visual interest
    const midMod = 1 + 0.3 * Math.sin(i * 0.05) * Math.cos(i * 0.03);
    const midEnergy = avg * midMod;
    const midAmplitude = Math.min(midEnergy * 55, 38);
    mid.push({
      x,
      yTop: 50 - midAmplitude,
      yBot: 50 + midAmplitude,
    });

    // High: finest detail, spike detection (zero-crossing rate + peak)
    const highRate = crossings / count;
    const highEnergy = highRate * 8 + maxVal * 0.4;
    const highAmplitude = Math.min(highEnergy * 28, 34);
    high.push({
      x,
      yTop: 50 - highAmplitude,
      yBot: 50 + highAmplitude,
    });
  }

  // Smooth bass for organic shape
  const smoothBass = smoothPoints(bass, 5);

  return { bass: smoothBass, mid, high };
}

function smoothPoints(points: WavePoint[], radius: number): WavePoint[] {
  const result: WavePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    let sumTop = 0;
    let sumBot = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(points.length - 1, i + radius); j++) {
      sumTop += points[j].yTop;
      sumBot += points[j].yBot;
      count++;
    }
    result.push({ x: points[i].x, yTop: sumTop / count, yBot: sumBot / count });
  }
  return result;
}

function pointsToPolygon(points: WavePoint[]): string {
  if (points.length === 0) return '';
  const top = points.map((p) => `${p.x.toFixed(1)},${p.yTop.toFixed(1)}`).join(' ');
  const bot = [...points]
    .reverse()
    .map((p) => `${p.x.toFixed(1)},${p.yBot.toFixed(1)}`)
    .join(' ');
  return `${top} ${bot}`;
}

function pointsToPolylineTop(points: WavePoint[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.yTop.toFixed(1)}`).join(' ');
}

function pointsToPolylineBot(points: WavePoint[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.yBot.toFixed(1)}`).join(' ');
}

export const AudioWaveformSVG = memo(function AudioWaveformSVG({
  audioBuffer,
  duration,
  zoom,
  width,
  viewOffsetRef,
  isVisible = true,
  layers,
  accentColor = '#ef4a3a',
  playProgress,
}: AudioWaveformSVGProps) {
  const waveformData = useMemo(() => {
    if (!audioBuffer) return null;
    return computeWaveformData(audioBuffer);
  }, [audioBuffer]);

  const bassPolygon = useMemo(() => {
    if (!waveformData) return '';
    return pointsToPolygon(waveformData.bass);
  }, [waveformData]);

  const midTop = useMemo(() => {
    if (!waveformData) return '';
    return pointsToPolylineTop(waveformData.mid);
  }, [waveformData]);

  const midBot = useMemo(() => {
    if (!waveformData) return '';
    return pointsToPolylineBot(waveformData.mid);
  }, [waveformData]);

  const highTop = useMemo(() => {
    if (!waveformData) return '';
    return pointsToPolylineTop(waveformData.high);
  }, [waveformData]);

  const highBot = useMemo(() => {
    if (!waveformData) return '';
    return pointsToPolylineBot(waveformData.high);
  }, [waveformData]);

  const totalWidth = Math.max(width, duration * zoom);

  // Clip width in SVG viewBox coordinates (0-1000).
  // Since SVG width = duration * zoom (matches audio exactly), progress maps directly.
  const clipRectRef = useRef<SVGRectElement>(null);
  const clipWidth = Math.max(0, Math.min(1000, (playProgress / 100) * 1000));

  // Scroll offset tracking (same pattern as LyricsTrack/BackgroundLane)
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isVisible) return;
    const handleOffset = (e: CustomEvent) => {
      if (trackRef.current) {
        trackRef.current.style.transform = `translate3d(${-e.detail}px, 0, 0)`;
      }
    };
    const handleProgress = (e: CustomEvent) => {
      if (clipRectRef.current) {
        const w = Math.max(0, Math.min(1000, (e.detail / 100) * 1000));
        clipRectRef.current.setAttribute('width', String(w));
      }
    };
    // Set initial offset
    if (trackRef.current) {
      trackRef.current.style.transform = `translate3d(${-viewOffsetRef.current}px, 0, 0)`;
    }
    window.addEventListener('threnicViewOffset', handleOffset as EventListener);
    window.addEventListener('threnicPlayProgress', handleProgress as EventListener);
    return () => {
      window.removeEventListener('threnicViewOffset', handleOffset as EventListener);
      window.removeEventListener('threnicPlayProgress', handleProgress as EventListener);
    };
  }, [viewOffsetRef, isVisible]);

  if (!isVisible) return null;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Atmospheric background (stays fixed in viewport) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(120% 100% at 50% 50%, rgba(70,90,140,.16), transparent 70%), linear-gradient(180deg, rgba(255,255,255,.035) 0%, transparent 45%, rgba(255,255,255,.02) 100%)`,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,.06), inset 0 -1px 0 rgba(255,255,255,.03)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `repeating-linear-gradient(0deg, rgba(255,255,255,.028) 0 1px, transparent 1px 3px)`,
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: '1px',
          background: `linear-gradient(90deg, transparent, rgba(190,215,255,.35), transparent)`,
          boxShadow: `0 0 12px rgba(150,190,255,.35)`,
          pointerEvents: 'none',
        }}
      />

      {/* Scrollable waveform content */}
      <div
        ref={trackRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${totalWidth}px`,
          height: '100%',
          willChange: 'transform',
        }}
      >
        {/* SVG Waveform */}
        <svg
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          style={{
            position: 'absolute',
            top: '9px',
            left: 0,
            width: `${duration * zoom}px`,
            height: 'calc(100% - 18px)',
          }}
        >
          <defs>
            {/* Clip path for played region */}
            <clipPath id="playedClip">
              <rect ref={clipRectRef} x="0" y="0" width={clipWidth} height="100" />
            </clipPath>

            {/* Laser glow filter */}
            <filter id="laserGlow" x="-10%" y="-20%" width="120%" height="140%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Bass bloom filter */}
            <filter id="bassBloom" x="-10%" y="-20%" width="120%" height="140%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
            </filter>

            {/* Vertical gradient: hot (accent) */}
            <linearGradient id="energyHot" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
              <stop offset="50%" stopColor={accentColor} stopOpacity="1" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.9" />
            </linearGradient>

            {/* Vertical gradient: cool (blue) */}
            <linearGradient id="energyCool" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#cfe2ff" stopOpacity="0.8" />
              <stop offset="50%" stopColor="#7ea0e0" stopOpacity="1" />
              <stop offset="100%" stopColor="#cfe2ff" stopOpacity="0.8" />
            </linearGradient>

            {/* Bass fill: cool */}
            <linearGradient id="bassFillCool" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7ea0e0" stopOpacity="0.3" />
              <stop offset="50%" stopColor="#7ea0e0" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#7ea0e0" stopOpacity="0.3" />
            </linearGradient>

            {/* Bass fill: hot */}
            <linearGradient id="bassFillHot" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accentColor} stopOpacity="0.35" />
              <stop offset="50%" stopColor={accentColor} stopOpacity="0.6" />
              <stop offset="100%" stopColor={accentColor} stopOpacity="0.35" />
            </linearGradient>
          </defs>

          {/* === UNPLAYED (cool) layers === */}
          {waveformData && (
            <>
              {layers.bass && (
                <polygon
                  points={bassPolygon}
                  fill="url(#bassFillCool)"
                  filter="url(#bassBloom)"
                  opacity={0.7}
                />
              )}

              {layers.mid && (
                <g filter="url(#laserGlow)">
                  <polyline
                    points={midTop}
                    fill="none"
                    stroke="url(#energyCool)"
                    strokeWidth="1.4"
                    vectorEffect="non-scaling-stroke"
                  />
                  <polyline
                    points={midBot}
                    fill="none"
                    stroke="url(#energyCool)"
                    strokeWidth="1.4"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )}

              {layers.high && (
                <g filter="url(#laserGlow)">
                  <polyline
                    points={highTop}
                    fill="none"
                    stroke="url(#energyCool)"
                    strokeWidth="0.8"
                    vectorEffect="non-scaling-stroke"
                  />
                  <polyline
                    points={highBot}
                    fill="none"
                    stroke="url(#energyCool)"
                    strokeWidth="0.8"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )}

              {/* === PLAYED (hot) layers - clipped === */}
              <g clipPath="url(#playedClip)">
                {layers.bass && (
                  <polygon
                    points={bassPolygon}
                    fill="url(#bassFillHot)"
                    filter="url(#bassBloom)"
                    opacity={0.9}
                  />
                )}

                {layers.mid && (
                  <g filter="url(#laserGlow)">
                    <polyline
                      points={midTop}
                      fill="none"
                      stroke="url(#energyHot)"
                      strokeWidth="2.6"
                      opacity={0.8}
                      vectorEffect="non-scaling-stroke"
                    />
                    <polyline
                      points={midBot}
                      fill="none"
                      stroke="url(#energyHot)"
                      strokeWidth="2.6"
                      opacity={0.8}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                )}

                {layers.high && (
                  <>
                    <g filter="url(#laserGlow)">
                      <polyline
                        points={highTop}
                        fill="none"
                        stroke="url(#energyHot)"
                        strokeWidth="1.6"
                        vectorEffect="non-scaling-stroke"
                      />
                      <polyline
                        points={highBot}
                        fill="none"
                        stroke="url(#energyHot)"
                        strokeWidth="1.6"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                    {/* Bright core on high */}
                    <g>
                      <polyline
                        points={highTop}
                        fill="none"
                        stroke="rgba(255,240,236,.9)"
                        strokeWidth="0.7"
                        vectorEffect="non-scaling-stroke"
                      />
                      <polyline
                        points={highBot}
                        fill="none"
                        stroke="rgba(255,240,236,.9)"
                        strokeWidth="0.7"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  </>
                )}
              </g>
            </>
          )}

          {/* Fallback: no audio */}
          {!waveformData && (
            <text
              x="500"
              y="52"
              textAnchor="middle"
              fill="rgba(255,255,255,0.25)"
              fontSize="10"
              fontFamily="system-ui, sans-serif"
            >
              No audio loaded
            </text>
          )}
        </svg>
      </div>
    </div>
  );
});

'use client';

import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { audioStore } from '@/engine/stores/audioStore';
import styles from '../../modals/EffectsModal.module.css';

/**
 * TriggerLevelWidget — A compact UI for configuring audio threshold triggers.
 *
 * Shows a live audio meter with a draggable threshold line.
 * When the signal exceeds the threshold, the meter lights up (visually "triggered").
 * Includes band selector (Bass/Mid/Treb) and cooldown slider.
 *
 * Used for game scene attack triggers and any boolean "fire when level > X" effect.
 */

interface TriggerLevelConfig {
  band: 'bass' | 'mid' | 'treb';
  threshold: number; // 0–1
  cooldown: number; // seconds
}

interface TriggerLevelWidgetProps {
  label: string;
  config: TriggerLevelConfig;
  onChange: (config: TriggerLevelConfig) => void;
  /** ID matching the scene's gameSceneAttack event (e.g., 'left' or 'right') */
  triggerId?: string;
}

const BAND_OPTIONS: { value: TriggerLevelConfig['band']; label: string }[] = [
  { value: 'bass', label: 'Bass' },
  { value: 'mid', label: 'Mid' },
  { value: 'treb', label: 'Treb' },
];

export function TriggerLevelWidget({
  label,
  config,
  onChange,
  triggerId,
}: TriggerLevelWidgetProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const [isDragging, setIsDragging] = useState(false);
  const [triggered, setTriggered] = useState(false);
  const triggeredRef = useRef(false);
  const lastTriggerTimeRef = useRef(0);
  const configRef = useRef(config);
  useLayoutEffect(() => {
    configRef.current = config;
  });

  // ── Listen for scene attack events to sync cooldown bar ──
  useEffect(() => {
    if (!triggerId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id === triggerId) {
        lastTriggerTimeRef.current = detail.time;
        if (!triggeredRef.current) {
          triggeredRef.current = true;
          setTriggered(true);
        }
        // Auto-clear triggered state after a short flash
        setTimeout(() => {
          triggeredRef.current = false;
          setTriggered(false);
        }, 200);
      }
    };
    window.addEventListener('gameSceneAttack', handler);
    return () => window.removeEventListener('gameSceneAttack', handler);
  }, [triggerId]);

  // ── Live audio meter rendering via rAF ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const { bass, mid, high } = audioStore.getState();
      const cfg = configRef.current;

      // Map band name to audio value
      let level = 0;
      if (cfg.band === 'bass') level = bass;
      else if (cfg.band === 'mid') level = mid;
      else level = high; // treb = high

      const w = canvas.width;
      const h = canvas.height;
      const threshold = cfg.threshold;
      const now = performance.now() / 1000;

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Background track
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, 3);
      ctx.fill();

      // Level fill
      const fillWidth = Math.min(level, 1) * w;
      const isActive = level > threshold;
      if (isActive) {
        // Gradient from accent to red when triggered
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, 'rgba(239, 68, 68, 0.3)');
        grad.addColorStop(threshold, 'rgba(239, 68, 68, 0.6)');
        grad.addColorStop(1, 'rgba(239, 68, 68, 0.9)');
        ctx.fillStyle = grad;
      } else {
        // Normal level: subtle green/white
        ctx.fillStyle = 'rgba(100, 200, 120, 0.4)';
      }
      ctx.beginPath();
      ctx.roundRect(0, 0, fillWidth, h, 3);
      ctx.fill();

      // Threshold line
      const tx = threshold * w;
      ctx.strokeStyle = isActive ? '#ef4444' : 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Threshold handle (small triangle at top)
      ctx.fillStyle = isActive ? '#ef4444' : 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx - 4, -6);
      ctx.lineTo(tx + 4, -6);
      ctx.closePath();
      ctx.fill();

      // Cooldown indicator (dim bar at bottom when in cooldown)
      const cooldownRemaining = cfg.cooldown - (now - lastTriggerTimeRef.current);
      if (cooldownRemaining > 0 && cfg.cooldown > 0) {
        const cooldownPct = cooldownRemaining / cfg.cooldown;
        ctx.fillStyle = 'rgba(255, 200, 0, 0.3)';
        ctx.fillRect(0, h - 2, w * cooldownPct, 2);
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Threshold drag handling ──
  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.stopPropagation();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const threshold = x / rect.width;
      onChange({ ...config, threshold: Math.max(0.05, Math.min(0.99, threshold)) });
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [config, onChange],
  );

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDragging) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const threshold = x / rect.width;
      onChange({ ...config, threshold: Math.max(0.05, Math.min(0.99, threshold)) });
    },
    [isDragging, config, onChange],
  );

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    setIsDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div style={{ marginBottom: 8 }}>
      {/* Label */}
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: triggered ? '#ef4444' : 'rgba(255,255,255,0.2)',
            boxShadow: triggered ? '0 0 6px #ef4444' : 'none',
            transition: 'all 0.1s',
          }}
        />
        {label}
      </div>

      {/* Band selector buttons */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 4 }}>
        {BAND_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange({ ...config, band: opt.value })}
            style={{
              flex: 1,
              padding: '2px 6px',
              fontSize: 9,
              fontWeight: 600,
              border: '1px solid var(--border)',
              borderRadius: 3,
              cursor: 'pointer',
              background: config.band === opt.value ? 'var(--accent-main)' : 'var(--bg-input)',
              color: config.band === opt.value ? '#fff' : 'var(--text-secondary)',
              transition: 'all 0.15s',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Live meter canvas with threshold drag */}
      <canvas
        ref={canvasRef}
        width={200}
        height={20}
        style={{
          width: '100%',
          height: 20,
          borderRadius: 3,
          cursor: isDragging ? 'grabbing' : 'col-resize',
          border: '1px solid var(--border)',
          marginBottom: 4,
        }}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
      />

      {/* Threshold + Cooldown row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <label
            style={{
              fontSize: 9,
              color: 'var(--text-muted)',
              display: 'block',
              marginBottom: 1,
            }}
          >
            Level: {config.threshold.toFixed(2)}
          </label>
        </div>
        <div style={{ flex: 1 }}>
          <label
            style={{
              fontSize: 9,
              color: 'var(--text-muted)',
              display: 'block',
              marginBottom: 1,
            }}
          >
            Cooldown: {config.cooldown.toFixed(1)}s
          </label>
          <input
            type="range"
            min={0.3}
            max={5.0}
            step={0.1}
            value={config.cooldown}
            onChange={(e) => onChange({ ...config, cooldown: parseFloat(e.target.value) })}
            className={styles.slider}
            style={{ width: '100%' }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
    </div>
  );
}

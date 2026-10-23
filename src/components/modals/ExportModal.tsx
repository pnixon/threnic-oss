'use client';

/**
 * ExportModal — "Crimson Obsidian" themed export progress overlay.
 *
 * Renders a full-screen modal during export that shows:
 *   • Live preview frames (snapshot every ~3s from the offscreen renderer)
 *   • Crimson gradient progress bar
 *   • Frame/time/ETA stats
 *   • Phase indicator (rendering, audio, finalizing)
 *   • Cancel button
 *
 * Used by BOTH the useExportMode (multi-track) and DecoupledExporter
 * (single-track) pipelines.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ExportModal.module.css';

// Re-export to other consumers can use the same type
export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  currentTime: number;
  totalDuration: number;
  percentage: number;
  framePreview?: string;
  avgFps?: number;
  /** Rolling FPS over recent 5-second window */
  recentFps?: number;
  queueSize?: number;
  encoderQueueSize?: number;
  etaSeconds?: number;
  /** Object URL of a periodic snapshot from the offscreen renderer */
  snapshotUrl?: string;
  /** Track name (for multi-track) */
  trackName?: string;
  /** Phase label */
  phase?: string;
}

interface ExportModalProps {
  isOpen: boolean;
  progress: ExportProgress | null;
  onCancel: () => void;
  height: number;
  fps: number;
  codec?: string;
}

// ─── Format Helpers ──────────────────────────────────────────

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function phaseLabel(phase?: string): string {
  if (!phase) return 'Rendering video frames…';
  switch (phase) {
    case 'init':
      return 'Initializing…';
    case 'rendering':
      return 'Rendering video frames…';
    case 'audio':
      return 'Encoding audio…';
    case 'finalizing':
      return 'Finalizing MP4…';
    case 'done':
      return 'Export complete';
    case 'error':
      return 'Export failed';
    default:
      return phase;
  }
}

// ─── Export Modal ────────────────────────────────────────────

export function ExportModal({
  isOpen,
  progress,
  onCancel,
  height,
  fps,
  codec = 'H.264',
}: ExportModalProps): React.ReactElement | null {
  const [lastSnapshot, setLastSnapshot] = useState<string | null>(null);

  const prevSnapshotRef = useRef<string | null>(null);

  // ── Running elapsed-time counter ────────────────────────────
  // Wall-clock time since the export started, ticking once per second while
  // the modal is open. Anchored to the first render with an active export and
  // frozen once the phase becomes terminal (done/error), so the final value is
  // the total time the export took. Purely client-side — no plumbing through
  // the export pipeline.
  const startTimeRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const phase = progress?.phase;
  const isFinished = phase === 'done' || phase === 'error';

  useEffect(() => {
    if (!isOpen) {
      startTimeRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setElapsed(0);
      return;
    }
    // Anchor the start the first time the modal opens for this export.
    if (startTimeRef.current === null) {
      startTimeRef.current = performance.now();
    }
    // Stop ticking once the export has finished; keep the last elapsed value.
    if (isFinished) {
      setElapsed((performance.now() - (startTimeRef.current ?? performance.now())) / 1000);
      return;
    }
    const tick = () => {
      setElapsed((performance.now() - (startTimeRef.current ?? performance.now())) / 1000);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isOpen, isFinished]);

  // Track snapshot URL changes and revoke old ones
  useEffect(() => {
    const newUrl = progress?.snapshotUrl ?? progress?.framePreview ?? null;
    if (newUrl && newUrl !== prevSnapshotRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLastSnapshot(newUrl);
      prevSnapshotRef.current = newUrl;
    }
  }, [progress?.snapshotUrl, progress?.framePreview]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLastSnapshot(null);
      prevSnapshotRef.current = null;
    }
  }, [isOpen]);

  // Escape to cancel
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onCancel]);

  if (!isOpen || !progress) return null;

  const pct = progress.percentage;
  const displayFps = progress.recentFps ?? progress.avgFps ?? 0;
  const realtimeX = fps > 0 ? displayFps / fps : 0;
  const eta = progress.etaSeconds ?? (pct > 0 ? ((100 - pct) / pct) * progress.currentTime : 0);

  // Resolution badge
  const resBadge =
    height >= 2160 ? '4K' : height >= 1440 ? '1440p' : height >= 1080 ? '1080p' : `${height}p`;

  return createPortal(
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ─────────────────────────────────────── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerIcon}>⚡</span>
            <span className={styles.headerTitle}>Exporting</span>
          </div>
          <span className={styles.headerBadge}>
            {codec} · {resBadge}
          </span>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div className={styles.body}>
          {/* Preview Frame */}
          <div className={styles.previewContainer}>
            {lastSnapshot ? (
              <>
                <img src={lastSnapshot} alt="Export preview" className={styles.previewImage} />
                {progress.phase === 'done' && (
                  <div className={styles.completeOverlay}>
                    <span className={styles.completeIcon}>✓</span>
                    <span className={styles.completeText}>COMPLETE</span>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.previewPlaceholder}>
                <div className={styles.previewSpinner} />
                <span>Preparing render…</span>
              </div>
            )}
            {/* Frame counter badge */}
            <span className={styles.previewFrameLabel}>F{progress.currentFrame}</span>
          </div>

          {/* Track name (multi-track) */}
          {progress.trackName && <div className={styles.trackName}>{progress.trackName}</div>}

          {/* Progress Bar */}
          <div className={styles.progressBarTrack}>
            <div className={styles.progressBarFill} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>

          {/* Stats Row */}
          <div className={styles.statsRow}>
            <span className={styles.statsPrimary}>
              Frame {progress.currentFrame.toLocaleString()} /{' '}
              {progress.totalFrames.toLocaleString()} — {pct.toFixed(0)}%
            </span>
            <span className={styles.statsSecondary}>
              {displayFps.toFixed(0)} fps ({realtimeX.toFixed(1)}× RT)
            </span>
          </div>

          {/* Meta Row (Elapsed + ETA + Phase) */}
          <div className={styles.metaRow}>
            <span className={styles.metaLeft}>
              <span className={styles.elapsed} data-testid="export-elapsed">
                <span className={styles.etaIcon}>⏱</span>
                Elapsed: {formatTime(elapsed)}
              </span>
              <span className={styles.eta}>ETA: {formatTime(eta)}</span>
            </span>
            <span className={styles.phase}>
              <span className={styles.phaseDot} />
              {phaseLabel(progress.phase)}
            </span>
          </div>

          {/* Cancel Button */}
          <button className={styles.cancelBtn} onClick={onCancel}>
            <span className={styles.cancelIcon}>✕</span>
            Cancel Export
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

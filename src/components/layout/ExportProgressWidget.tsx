'use client';

/**
 * ExportProgressWidget — Self-contained export progress HUD.
 *
 * Reads directly from `exportUIStore` instead of receiving props,
 * eliminating the prop drill chain through AppContent.
 */

import React from 'react';
import { Loader2, X, Download } from 'lucide-react';
import { useExportUIStore } from '@/engine/export';
import styles from './ExportProgressWidget.module.css';

export function ExportProgressWidget() {
  const progress = useExportUIStore((s) => s.progress?.percentage ?? 0);
  const cancelExport = useExportUIStore((s) => s.cancelExport);

  const roundedProgress = Math.round(progress);

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.iconWrapper}>
            {progress < 100 ? (
              <Loader2 className="animate-spin" size={20} />
            ) : (
              <Download size={20} />
            )}
          </div>
          <div className={styles.titleGroup}>
            <span className={styles.title}>
              {progress < 100 ? 'Exporting Video' : 'Finishing Up'}
            </span>
            <span className={styles.subtitle}>Please stay on this page</span>
          </div>
        </div>

        <div className={styles.progressContainer}>
          <div className={styles.progressInfo}>
            <span className={styles.statusText}>
              {progress < 100 ? 'Rendering frames...' : 'Encoding and saving...'}
            </span>
            <span className={styles.percentage}>{roundedProgress}%</span>
          </div>

          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${Math.max(2, progress)}%` }} />
          </div>
        </div>

        <div className={styles.actions}>
          <button
            className={styles.cancelBtn}
            onClick={(e) => {
              e.stopPropagation();
              cancelExport();
            }}
            title="Cancel Export"
          >
            <X size={16} />
            <span>Cancel Export</span>
          </button>
        </div>
      </div>
    </div>
  );
}

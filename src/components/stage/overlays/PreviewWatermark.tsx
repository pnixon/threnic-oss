'use client';

/**
 * PreviewWatermark — HTML overlay that shows the Threnic watermark
 * on the preview canvas when the user opts in from the Export tab.
 *
 * This is a CSS overlay (not baked into the render pipeline) since
 * the preview watermark is purely visual. The export watermark is
 * baked into video frames via WatermarkCompositor.
 */

import React from 'react';
import { useExportUIStore } from '@/engine/stores/exportUIStore';
import styles from './PreviewWatermark.module.css';

export function PreviewWatermark(): React.ReactElement | null {
  // The watermark is opt-in via the Export tab; mirror that choice here so the
  // preview matches what will actually be exported.
  const watermarkEnabled = useExportUIStore((s) => s.watermarkEnabled);

  if (!watermarkEnabled) return null;

  return (
    <div className={styles.container}>
      <img src="/Threnic_Logo.png" alt="" className={styles.logo} draggable={false} />
      <span className={styles.text}>THRENIC</span>
    </div>
  );
}

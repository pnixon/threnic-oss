import React from 'react';
import { Monitor, Smartphone, Square as SquareIcon, Maximize2 } from 'lucide-react';
import { ASPECT_RATIOS, AspectKey } from '@/types/exportConstants';
import styles from './ViewportControls.module.css';
import { useMediaQuery, useIsHydrated } from '@/hooks';

interface ViewportControlsProps {
  previewZoom: number;
  setPreviewZoom: (v: number) => void;
  setPan: (v: { x: number; y: number }) => void;
  exportAspect: AspectKey;
  setExportAspect: (v: AspectKey) => void;
  isExporting: boolean;
  minZoom?: number;
  maxZoom?: number;
  onMaximize?: () => void;
}

const ASPECT_ICONS: Record<string, typeof Monitor> = {
  Landscape: Monitor,
  Portrait: Smartphone,
  Square: SquareIcon,
};

export function ViewportControls({
  previewZoom,
  setPreviewZoom,
  setPan,
  exportAspect,
  setExportAspect,
  isExporting,
  minZoom = 0.25,
  maxZoom = 2.0,
  onMaximize,
}: ViewportControlsProps): React.ReactElement {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isHydrated = useIsHydrated();
  function handleResetZoom(): void {
    setPreviewZoom(1.0);
    setPan({ x: 0, y: 0 });
  }

  const zoomDisplay = Math.round(previewZoom * 100);

  return (
    <div className={styles.container}>
      <div className={styles.controlsBar}>
        <div className={styles.zoomSection}>
          <span className={styles.zoomLabel} onClick={handleResetZoom} title="Reset Zoom">
            {zoomDisplay}%
          </span>
          <input
            type="range"
            min={minZoom}
            max={maxZoom}
            step={(maxZoom - minZoom) / 100}
            value={previewZoom}
            onChange={(e) => setPreviewZoom(parseFloat(e.target.value))}
            className={styles.zoomSlider}
          />
        </div>

        <div className={styles.divider} />

        <div className={styles.aspectSection}>
          {!isMobile &&
            Object.entries(ASPECT_RATIOS).map(([key, config]) => {
              const Icon = ASPECT_ICONS[key] || SquareIcon;
              const isSelected = isHydrated && exportAspect === key;

              return (
                <button
                  key={key}
                  onClick={() => setExportAspect(key as AspectKey)}
                  title={config.label}
                  disabled={isExporting}
                  className={`${styles.aspectBtn} ${isSelected ? styles.active : ''}`}
                >
                  <Icon size={14} />
                </button>
              );
            })}

          {onMaximize && (
            <button onClick={onMaximize} title="Fullscreen Preview" className={styles.aspectBtn}>
              <Maximize2 size={isMobile ? 16 : 14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

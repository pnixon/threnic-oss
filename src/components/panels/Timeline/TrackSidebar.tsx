'use client';

import React from 'react';
import styles from './TrackSidebar.module.css';

interface TrackSidebarProps {
  lyricsLaneCount: number;
  onLaneCountChange: (updater: (prev: number) => number) => void;
  spectrumLayers: { bass: boolean; mid: boolean; high: boolean };
  onSpectrumLayerToggle: (layer: 'bass' | 'mid' | 'high') => void;
}

const TRACKS = [
  { id: 'lyrics', label: 'LYRICS', color: 'var(--crucible-red, #ef4a3a)' },
  { id: 'background', label: 'BACKGROUND', color: '#6b8ee0' },
  { id: 'effects', label: 'EFFECTS', color: 'rgba(255,255,255,.5)' },
  { id: 'audio', label: 'AUDIO', color: 'var(--crucible-red, #ef4a3a)' },
] as const;

const LAYER_CHIPS: { id: 'bass' | 'mid' | 'high'; label: string; swatchHeight: number }[] = [
  { id: 'bass', label: 'Bass', swatchHeight: 6 },
  { id: 'mid', label: 'Mid', swatchHeight: 2 },
  { id: 'high', label: 'High', swatchHeight: 1 },
];

export function TrackSidebar({
  lyricsLaneCount,
  onLaneCountChange,
  spectrumLayers,
  onSpectrumLayerToggle,
}: TrackSidebarProps) {
  return (
    <div className={styles.sidebar} data-testid="track-sidebar">
      {/* Header row matching ruler height */}
      <div className={styles.header}>
        <span className={styles.headerLabel}>Tracks</span>
      </div>

      {/* Lyrics Track */}
      <div className={`${styles.trackRow} ${styles.trackRowLyrics}`}>
        <div className={styles.trackInfo}>
          <span className={styles.trackIndicator} style={{ background: TRACKS[0].color }} />
          <span className={styles.trackName}>LYRICS</span>
          <span className={styles.trackMeta}>
            {lyricsLaneCount === 1 ? '1 lane' : `${lyricsLaneCount} lanes`}
          </span>
        </div>
        <div className={styles.laneControls}>
          <span className={styles.laneLabel}>Lanes</span>
          <button
            className={styles.laneBtn}
            onClick={() => onLaneCountChange((c) => Math.max(1, c - 1))}
          >
            −
          </button>
          <span className={styles.laneCount}>{lyricsLaneCount}</span>
          <button
            className={styles.laneBtn}
            onClick={() => onLaneCountChange((c) => Math.min(6, c + 1))}
          >
            +
          </button>
        </div>
      </div>

      {/* Background Track */}
      <div className={`${styles.trackRow} ${styles.trackRowBackground}`}>
        <div className={styles.trackInfo}>
          <span className={styles.trackIndicator} style={{ background: TRACKS[1].color }} />
          <span className={styles.trackName}>BACKGROUND</span>
        </div>
      </div>

      {/* Effects Track */}
      <div className={`${styles.trackRow} ${styles.trackRowEffects}`}>
        <div className={styles.trackInfo}>
          <span className={styles.trackIndicator} style={{ background: TRACKS[2].color }} />
          <span className={styles.trackName}>EFFECTS</span>
        </div>
      </div>

      {/* Audio Track */}
      <div className={`${styles.trackRow} ${styles.trackRowAudio}`}>
        <div className={styles.trackInfo}>
          <span className={styles.trackIndicator} style={{ background: TRACKS[3].color }} />
          <span className={styles.trackName}>AUDIO</span>
        </div>
        {/* Spectrum layer chips */}
        <div className={styles.layerChips}>
          {LAYER_CHIPS.map((chip) => {
            const active = spectrumLayers[chip.id];
            return (
              <button
                key={chip.id}
                className={`${styles.layerChip} ${active ? styles.layerChipActive : ''}`}
                onClick={() => onSpectrumLayerToggle(chip.id)}
                title={`Toggle ${chip.label} layer`}
              >
                <span
                  className={styles.layerSwatch}
                  style={{
                    height: chip.swatchHeight,
                    opacity: active ? 1 : 0.3,
                  }}
                />
                {chip.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

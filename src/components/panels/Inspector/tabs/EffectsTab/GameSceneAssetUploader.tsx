'use client';

/**
 * GameSceneAssetUploader
 *
 * Three side-by-side thumbnail cards for game scene sprites (left, right,
 * background). Shows live preview of current asset; click a card to upload a
 * replacement. Persists images to IndexedDB. Dispatches a custom event to
 * notify GPUCanvas to reload.
 *
 * The Background slot is optional: removing it leaves the scene with NO backdrop
 * so the fighters overlay Threnic's own background. The left/right fighters
 * always fall back to their bundled default sprites.
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  saveGameSceneAsset,
  loadGameSceneAsset,
  loadCustomGameSceneAsset,
  removeGameSceneAsset,
  hasCustomGameSceneAsset,
  getDefaultAssetUrl,
  type GameSceneSlot,
} from '@/engine/gpu/littlejs/gameSceneAssets';
import styles from './GameSceneAssetUploader.module.css';

interface Props {
  sceneId: string;
}

const SLOTS: { slot: GameSceneSlot; label: string }[] = [
  { slot: 'left', label: 'Left' },
  { slot: 'right', label: 'Right' },
  { slot: 'background', label: 'Background' },
];

export function GameSceneAssetUploader({ sceneId }: Props) {
  const [previewUrls, setPreviewUrls] = useState<Record<GameSceneSlot, string>>({
    left: getDefaultAssetUrl(sceneId, 'left'),
    right: getDefaultAssetUrl(sceneId, 'right'),
    // Background has no bundled default — empty means "no backdrop".
    background: '',
  });
  const [customSlots, setCustomSlots] = useState<Record<GameSceneSlot, boolean>>({
    left: false,
    right: false,
    background: false,
  });

  const fileInputRefs = useRef<Record<GameSceneSlot, HTMLInputElement | null>>({
    left: null,
    right: null,
    background: null,
  });

  // Load current assets (custom or default) on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [leftUrl, rightUrl, bgUrl] = await Promise.all([
        loadGameSceneAsset(sceneId, 'left'),
        loadGameSceneAsset(sceneId, 'right'),
        // Background: custom-only (no default fallback).
        loadCustomGameSceneAsset(sceneId, 'background'),
      ]);
      const [hasLeft, hasRight, hasBg] = await Promise.all([
        hasCustomGameSceneAsset(sceneId, 'left'),
        hasCustomGameSceneAsset(sceneId, 'right'),
        hasCustomGameSceneAsset(sceneId, 'background'),
      ]);
      if (!cancelled) {
        setPreviewUrls({ left: leftUrl, right: rightUrl, background: bgUrl ?? '' });
        setCustomSlots({ left: hasLeft, right: hasRight, background: hasBg });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [sceneId]);

  const handleUpload = useCallback(
    async (slot: GameSceneSlot, file: File) => {
      const blobUrl = await saveGameSceneAsset(sceneId, slot, file);
      setPreviewUrls((prev) => ({ ...prev, [slot]: blobUrl }));
      setCustomSlots((prev) => ({ ...prev, [slot]: true }));
      window.dispatchEvent(new CustomEvent('gameSceneAssetsChanged', { detail: { sceneId } }));
    },
    [sceneId],
  );

  const handleReset = useCallback(
    async (slot: GameSceneSlot, e: React.MouseEvent) => {
      e.stopPropagation();
      await removeGameSceneAsset(sceneId, slot);
      // Left/right revert to their bundled default sprite; the background has no
      // default, so removing it leaves an empty preview = "no backdrop".
      const nextUrl = slot === 'background' ? '' : getDefaultAssetUrl(sceneId, slot);
      setPreviewUrls((prev) => ({ ...prev, [slot]: nextUrl }));
      setCustomSlots((prev) => ({ ...prev, [slot]: false }));
      window.dispatchEvent(new CustomEvent('gameSceneAssetsChanged', { detail: { sceneId } }));
    },
    [sceneId],
  );

  const handleFileChange = useCallback(
    (slot: GameSceneSlot) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && file.type.startsWith('image/')) {
        handleUpload(slot, file);
      }
      e.target.value = '';
    },
    [handleUpload],
  );

  return (
    <div className={styles.container}>
      <div className={styles.label}>Scene Assets</div>
      <div className={styles.grid}>
        {SLOTS.map(({ slot, label }) => {
          const url = previewUrls[slot];
          const isEmptyBg = slot === 'background' && !url;
          return (
            <div
              key={slot}
              className={styles.card}
              onClick={() => fileInputRefs.current[slot]?.click()}
              title={
                slot === 'background'
                  ? 'Click to upload a scene background (leave empty to overlay on your own background)'
                  : `Click to upload ${label.toLowerCase()}`
              }
            >
              {isEmptyBg ? (
                <div className={`${styles.preview} ${styles.previewBg}`} aria-label="No background">
                  <span className={styles.overlayIcon}>🚫</span>
                </div>
              ) : (
                <img
                  className={`${styles.preview} ${slot === 'background' ? styles.previewBg : ''}`}
                  src={url}
                  alt={label}
                  draggable={false}
                />
              )}
              <div className={styles.overlay}>
                <span className={styles.overlayIcon}>📷</span>
              </div>
              <div className={styles.slotLabel}>{label}</div>
              {customSlots[slot] && (
                <button
                  type="button"
                  className={styles.resetBtn}
                  onClick={(e) => handleReset(slot, e)}
                  title={slot === 'background' ? 'Remove background' : 'Reset to default'}
                >
                  ✕
                </button>
              )}
              <input
                ref={(el) => {
                  fileInputRefs.current[slot] = el;
                }}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleFileChange(slot)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

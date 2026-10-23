'use client';

import React, { useState } from 'react';
import {
  type Keyframe,
  type KeyframePropertyMap,
  createKeyframe,
  sortKeyframes,
  getKeyframeLabel,
  INTERPOLATION_STRATEGIES,
} from '@/types/keyframes';
import { KeyframeMenu } from '@/components/effects/shared/KeyframeMenu';
import { useKeyframes } from '@/hooks/useKeyframes';
import styles from './KeyframeDropdown.module.css';

interface KeyframeDropdownProps {
  currentTime?: number;
  /** Label for the dropdown */
  label?: string;
  /** Default property to update when creating via this dropdown (legacy compatibility) */
  defaultProperty?: string;
  /** Current value of that property */
  currentValue?: unknown;
}

export function KeyframeDropdown({
  currentTime,
  label = 'Edit Keyframe',
  defaultProperty,
  currentValue,
}: KeyframeDropdownProps): React.ReactElement {
  const { keyframes, setKeyframes, selectedKeyframeId, setSelectedKeyframeId, trackId } =
    useKeyframes();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Sort all keyframes by time
  const sortedKeyframes = [...keyframes].sort((a, b) => a.time - b.time);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (currentTime !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      setMenuPos({ x: e.clientX, y: e.clientY });
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (currentTime !== undefined) {
      e.preventDefault();
      e.stopPropagation();

      // Check if one exists at this time
      const existingKf = keyframes.find((kf) => Math.abs(kf.time - currentTime) < 0.01);

      if (existingKf) {
        setKeyframes(keyframes.filter((k) => k.id !== existingKf.id));
      } else {
        // Create basic empty keyframe
        const props: Partial<KeyframePropertyMap> = {};
        if (defaultProperty) props[defaultProperty] = currentValue;

        const newKf = createKeyframe(currentTime, props);
        setKeyframes(sortKeyframes([...keyframes, newKf]));
        setSelectedKeyframeId(newKf.id);
      }
    }
  };

  return (
    <div
      className={styles.container}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
      style={{ cursor: 'context-menu' }}
    >
      <label className={styles.label}>{label}</label>
      <div style={{ display: 'flex', gap: 4 }}>
        <select
          className={styles.select}
          value={selectedKeyframeId}
          onChange={(e) => setSelectedKeyframeId(e.target.value)}
          style={{ flex: 1 }}
        >
          <option value="default">Default (Base State)</option>
          {sortedKeyframes.length > 0 && <option disabled>────────────</option>}
          {sortedKeyframes.map((kf) => (
            <option key={kf.id} value={kf.id}>
              {kf.time.toFixed(2)}s - {getKeyframeLabel(kf)}
            </option>
          ))}
        </select>
      </div>

      {selectedKeyframeId !== 'default' && (
        <div className={styles.interpolationRow}>
          <label className={styles.subLabel}>Easing</label>
          <select
            className={styles.smallSelect}
            value={
              sortedKeyframes.find((k) => k.id === selectedKeyframeId)?.interpolation || 'linear'
            }
            onChange={(e) => {
              const val = e.target.value as Keyframe['interpolation'];
              setKeyframes(
                keyframes.map((k) => {
                  if (k.id !== selectedKeyframeId) return k;
                  const updated = { ...k, interpolation: val };
                  if (val === 'cubic-bezier' && !updated.tangent?.bezierPoints) {
                    updated.tangent = {
                      ...updated.tangent,
                      bezierPoints: [0.25, 0.1, 0.25, 1.0] as [number, number, number, number],
                    };
                  }
                  return updated;
                }),
              );
            }}
          >
            {INTERPOLATION_STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {selectedKeyframeId === 'default' && (
        <div className={styles.hint}>
          Editing default values. These apply when no keyframe is active.
        </div>
      )}
      {selectedKeyframeId !== 'default' && sortedKeyframes.length > 0 && (
        <div className={styles.hint}>
          Editing keyframe values. Changes apply at{' '}
          {sortedKeyframes.find((kf) => kf.id === selectedKeyframeId)?.time.toFixed(2)}s.
        </div>
      )}

      {menuPos && currentTime !== undefined && (
        <KeyframeMenu
          pos={menuPos}
          currentTime={currentTime}
          property={defaultProperty || 'generic'}
          currentValue={currentValue}
          trackId={trackId || undefined}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}

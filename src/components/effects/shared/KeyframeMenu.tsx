'use client';

import React, { useRef, useLayoutEffect, useState } from 'react';
import { useKeyframeSelection } from '@/contexts';
import {
  type Keyframe,
  createKeyframe,
  sortKeyframes,
  INTERPOLATION_STRATEGIES,
} from '@/types/keyframes';
import styles from './KeyframeMenu.module.css';
import { useKeyframes } from '@/hooks/useKeyframes';

interface KeyframeMenuProps {
  pos: { x: number; y: number };
  currentTime: number;
  property?: string;
  currentValue?: unknown;
  onClose: () => void;
  trackId?: string;
  existingKfId?: string;
}

export function KeyframeMenu({
  pos: rawPos,
  currentTime,
  property,
  currentValue,
  onClose,
  trackId,
  existingKfId,
}: KeyframeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(rawPos);
  const { setSelectedKeyframeId } = useKeyframeSelection();
  const { keyframes = [], setKeyframes } = useKeyframes(trackId);

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let tx = rawPos.x;
    let ty = rawPos.y;

    // Keep on screen
    if (tx + rect.width > window.innerWidth) tx = window.innerWidth - rect.width - 8;
    if (ty + rect.height > window.innerHeight) ty = window.innerHeight - rect.height - 8;

    requestAnimationFrame(() => {
      setPos({ x: Math.max(8, tx), y: Math.max(8, ty) });
    });
  }, [rawPos]);

  // Check if a keyframe already exists at this approximate time
  const existingKf = existingKfId
    ? keyframes.find((k) => k.id === existingKfId)
    : keyframes.find((kf) => Math.abs(kf.time - currentTime) < 0.01);

  // Check if the property specifically is already in that keyframe
  const hasProperty = property ? existingKf?.properties[property] !== undefined : false;

  const handleToggleKeyframe = () => {
    if (!property) {
      // If no property, act as a track-level toggler (add empty keyframe)
      if (!existingKf) {
        const newKf = createKeyframe(currentTime, {});
        setKeyframes(sortKeyframes([...keyframes, newKf]));
        setSelectedKeyframeId(newKf.id);
      }
      onClose();
      return;
    }

    if (existingKf) {
      if (hasProperty) {
        // Remove property from existing keyframe
        const newProperties = { ...existingKf.properties };
        delete newProperties[property];

        if (Object.keys(newProperties).length === 0) {
          // If keyframe is now empty, delete it
          setKeyframes(keyframes.filter((k) => k.id !== existingKf.id));
        } else {
          // Otherwise just update it
          setKeyframes(
            keyframes.map((k) =>
              k.id === existingKf.id ? { ...k, properties: newProperties } : k,
            ),
          );
        }
      } else {
        // Add property to existing keyframe
        const newProperties = { ...existingKf.properties, [property]: currentValue };
        setKeyframes(
          keyframes.map((k) => (k.id === existingKf.id ? { ...k, properties: newProperties } : k)),
        );
      }
    } else {
      // Create new keyframe with this property
      const newKf = createKeyframe(currentTime, { [property]: currentValue });
      setKeyframes(sortKeyframes([...keyframes, newKf]));
      setSelectedKeyframeId(newKf.id);
    }
    onClose();
  };

  const handleDeleteFullKeyframe = () => {
    if (existingKf) {
      setKeyframes(keyframes.filter((k) => k.id !== existingKf.id));
    }
    onClose();
  };

  return (
    <div
      ref={menuRef}
      data-kf-menu
      className={styles.contextMenu}
      style={{
        top: pos.y,
        left: pos.x,
        position: 'fixed',
        zIndex: 5000,
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {property ? (
        <button className={styles.contextMenuBtn} onClick={handleToggleKeyframe}>
          {hasProperty ? 'Remove Attribute' : 'Add Attribute'} at {currentTime.toFixed(2)}s
        </button>
      ) : (
        !existingKf && (
          <button className={styles.contextMenuBtn} onClick={handleToggleKeyframe}>
            Add Keyframe at {currentTime.toFixed(2)}s
          </button>
        )
      )}

      {existingKf && (
        <>
          <div className={styles.contextDivider} />
          <div className={styles.contextLabel}>Interpolation Strategy</div>
          {INTERPOLATION_STRATEGIES.map((strategy) => (
            <button
              key={strategy.value}
              className={`${styles.contextMenuBtn} ${existingKf.interpolation === strategy.value ? styles.active : ''}`}
              onClick={() => {
                setKeyframes(
                  keyframes.map((k) => {
                    if (k.id !== existingKf.id) return k;
                    const updated: Keyframe = { ...k, interpolation: strategy.value };
                    // Seed a default control curve when a mode needs tangent data,
                    // so the choice renders a real curve rather than silently
                    // falling back to ease-in-out (cubic-bezier) or a flat spline.
                    if (strategy.value === 'cubic-bezier' && !updated.tangent?.bezierPoints) {
                      updated.tangent = {
                        ...updated.tangent,
                        // CSS "ease" default control points
                        bezierPoints: [0.25, 0.1, 0.25, 1.0],
                      };
                    }
                    return updated;
                  }),
                );
                onClose();
              }}
            >
              {strategy.label}
            </button>
          ))}
        </>
      )}

      {existingKf && (
        <button
          className={`${styles.contextMenuBtn} ${styles.danger}`}
          onClick={handleDeleteFullKeyframe}
        >
          {property ? 'Delete Full Keyframe' : 'Delete Keyframe'}
        </button>
      )}

      <div className={styles.contextDivider} />
      <button className={styles.contextMenuBtn} onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

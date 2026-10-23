'use client';

import React, { useRef, useEffect, useState, memo, useCallback } from 'react';
import {
  type Keyframe,
  getKeyframeLabel,
  getKeyframeColor,
  sortKeyframes,
} from '@/types/keyframes';
import { useKeyframeSelection } from '@/contexts';
import { KeyframeMenu } from '@/components/effects/shared/KeyframeMenu';
import { pauseAutoSave, resumeAutoSave } from '@/stores';
import { TimelineMediaCapsule } from './TimelineMediaCapsule';
import styles from './KeyframeTrack.module.css';

type TimelineDragWindow = Window & { __threnic_timeline_dragging?: boolean };

interface KeyframeTrackProps {
  keyframes: Keyframe[];
  setKeyframes: React.Dispatch<React.SetStateAction<Keyframe[]>>;
  zoom: number;
  viewOffsetRef: React.MutableRefObject<number>;
  height: number;
  width: number;
  topPadding?: number;
  isVisible?: boolean;
  trackId?: string;
  updateTrackKeyframes?: (id: string, keyframes: Keyframe[]) => void;
}

function KeyframeTrackComponent({
  keyframes,
  setKeyframes,
  zoom,
  viewOffsetRef,
  height,
  topPadding = 0,
  isVisible = true,
  trackId,
  updateTrackKeyframes,
}: KeyframeTrackProps) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    time: number;
    existingKf?: Keyframe | null;
  } | null>(null);
  const lastTapRef = useRef<{ time: number; id: string }>({ time: 0, id: '' });
  const contentRef = useRef<HTMLDivElement>(null);
  const { selectedKeyframeId, setSelectedKeyframeId } = useKeyframeSelection();

  // Drag State
  type DragType = 'kf-move' | 'transition-start' | 'scene-transition-end';

  const [dragState, setDragState] = useState<{
    type: DragType;
    id: string; // keyframe ID
    startX: number;
    originalStart: number;
    originalEndOrDuration: number;
  } | null>(null);

  // Sync drag state to global window flag to prevent auto-saves/store jumps
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (dragState) {
      (window as TimelineDragWindow).__threnic_timeline_dragging = true;
    } else {
      (window as TimelineDragWindow).__threnic_timeline_dragging = false;
    }
    return () => {
      if (typeof window !== 'undefined') {
        (window as TimelineDragWindow).__threnic_timeline_dragging = false;
      }
    };
  }, [dragState]);

  // Sync scroll via event listener
  useEffect(() => {
    if (!isVisible) return;
    const handleOffset = (e: CustomEvent) => {
      if (contentRef.current) {
        contentRef.current.style.transform = `translate3d(${-e.detail}px, 0, 0)`;
      }
    };
    if (contentRef.current) {
      contentRef.current.style.transform = `translate3d(${-viewOffsetRef.current}px, 0, 0)`;
    }
    window.addEventListener('threnicViewOffset', handleOffset as EventListener);
    return () => {
      window.removeEventListener('threnicViewOffset', handleOffset as EventListener);
    };
  }, [isVisible, viewOffsetRef]);

  useEffect(() => {
    const handleClose = (e: PointerEvent) => {
      if (!(e.target as Element).closest('[data-kf-menu]')) {
        setMenu(null);
      }
    };
    window.addEventListener('pointerdown', handleClose, { capture: true });
    return () => window.removeEventListener('pointerdown', handleClose, { capture: true });
  }, []);

  const handlePointerDown = (
    e: React.PointerEvent,
    id: string,
    type: DragType,
    originalStart: number,
    originalEndOrDuration: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    // Synchronously lock dragging state and pause autosave to prevent main-thread lag spikes
    if (typeof window !== 'undefined') {
      (window as TimelineDragWindow).__threnic_timeline_dragging = true;
    }
    pauseAutoSave();

    setSelectedKeyframeId(id);

    setDragState({
      type,
      id,
      startX: e.clientX,
      originalStart,
      originalEndOrDuration,
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragState) return;
    e.preventDefault();

    const deltaX = e.clientX - dragState.startX;
    const deltaTime = deltaX / zoom;

    // Handle keyframe dragging
    const updateKfs = (prev: Keyframe[]) => {
      const newKfs = prev.map((kf) => {
        if (kf.id !== dragState.id) return kf;

        if (dragState.type === 'kf-move') {
          return { ...kf, time: Math.max(0, dragState.originalStart + deltaTime) };
        } else if (dragState.type === 'transition-start') {
          return {
            ...kf,
            transitionDuration: Math.max(0, dragState.originalEndOrDuration - deltaTime),
          };
        } else if (dragState.type === 'scene-transition-end') {
          if (kf.properties.transition) {
            return {
              ...kf,
              properties: {
                ...kf.properties,
                transition: {
                  ...kf.properties.transition,
                  duration: Math.max(0.1, dragState.originalEndOrDuration + deltaTime),
                },
              },
            };
          }
        }
        return kf;
      });

      return sortKeyframes(newKfs);
    };

    if (trackId && updateTrackKeyframes) {
      const nextKfs = updateKfs(keyframes);
      updateTrackKeyframes(trackId, nextKfs);
    } else {
      setKeyframes(updateKfs);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragState) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    if (typeof window !== 'undefined') {
      (window as TimelineDragWindow).__threnic_timeline_dragging = false;
    }
    resumeAutoSave();
    setDragState(null);
  };

  const chipH = 22;
  const chipTop = topPadding + (height - topPadding - chipH) / 2;

  // Filter keyframes belonging to the effects lane
  const filteredKeyframes = keyframes.filter((kf) => kf.lane === 'effects');

  const triggerMenuAt = useCallback(
    (clientX: number, clientY: number, currentTarget: HTMLElement, target: HTMLElement) => {
      const rect = currentTarget.getBoundingClientRect();
      const time = (clientX - rect.left + viewOffsetRef.current) / zoom;

      // Find if we clicked on a chip
      const chip = target.closest('[data-kf-id]');
      const kfId = chip?.getAttribute('data-kf-id');
      const existingKf = kfId ? keyframes.find((k) => k.id === kfId) : null;

      setMenu({ x: clientX, y: clientY, time, existingKf });
    },
    [keyframes, zoom, viewOffsetRef],
  );

  return (
    <div
      className={styles.kfTrackContainer}
      style={{ height, width: '100%' }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onTouchStart={(e) => {
        const now = Date.now();
        const DOUBLE_PRESS_DELAY = 300;
        if (now - lastTapRef.current.time < DOUBLE_PRESS_DELAY) {
          e.preventDefault();
          const touch = e.touches[0] || e.changedTouches[0];
          if (touch) {
            triggerMenuAt(
              touch.clientX,
              touch.clientY,
              e.currentTarget as HTMLElement,
              e.target as HTMLElement,
            );
          }
        }
        lastTapRef.current = { time: now, id: 'keyframe-track' };
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        triggerMenuAt(
          e.clientX,
          e.clientY,
          e.currentTarget as HTMLElement,
          e.target as HTMLElement,
        );
      }}
    >
      {/* Main scrolling track elements */}
      <div
        ref={contentRef}
        style={{ height: '100%', position: 'absolute', willChange: 'transform' }}
      >
        {filteredKeyframes.map((kf) => {
          const color = getKeyframeColor(kf);
          const x = kf.time * zoom;
          const isTrans = !!kf.properties.transition;
          const transDur = kf.transitionDuration || 0;
          const sceneTransDur = isTrans ? kf.properties.transition?.duration || 0 : 0;
          const isSelected = selectedKeyframeId === kf.id;

          const assetUrl = kf.properties?.['scene.assetUrl'];
          const bgColor = kf.properties?.['scene.backgroundColor'];
          const hasBg = !!(assetUrl || bgColor);

          return (
            <React.Fragment key={kf.id}>
              {/* Interpolation / Transition line */}
              {transDur > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    left: x - transDur * zoom,
                    top: chipTop + chipH / 2 - 1,
                    width: transDur * zoom,
                    height: 2,
                    background: `linear-gradient(to right, transparent, ${color})`,
                    opacity: 0.4,
                    pointerEvents: 'none',
                    zIndex: 10,
                  }}
                />
              )}

              {/* Transition Duration Handle (Left) */}
              {!isTrans && (
                <div
                  data-kf-chip="1"
                  style={{
                    position: 'absolute',
                    left: x - transDur * zoom - 4,
                    top: chipTop + 4,
                    width: 8,
                    height: chipH - 8,
                    zIndex: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'ew-resize',
                    pointerEvents: 'auto',
                    touchAction: 'none',
                  }}
                  onPointerDown={(e) =>
                    handlePointerDown(e, kf.id, 'transition-start', kf.time, transDur)
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  <div
                    style={{
                      width: 2,
                      height: '100%',
                      background: color,
                      borderRadius: 1,
                      opacity: 0.8,
                    }}
                  />
                </div>
              )}

              {/* Scene Transition End Handle (Right) */}
              {isTrans && (
                <div
                  data-kf-chip="1"
                  style={{
                    position: 'absolute',
                    left: x + sceneTransDur * zoom - 4,
                    top: chipTop + 4,
                    width: 8,
                    height: chipH - 8,
                    zIndex: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'ew-resize',
                    pointerEvents: 'auto',
                    touchAction: 'none',
                  }}
                  onPointerDown={(e) =>
                    handlePointerDown(e, kf.id, 'scene-transition-end', kf.time, sceneTransDur)
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  <div
                    style={{
                      width: 2,
                      height: '100%',
                      background: color,
                      borderRadius: 1,
                      opacity: 0.8,
                    }}
                  />
                </div>
              )}

              {/* The Keyframe Chip */}
              <div
                data-kf-id={kf.id}
                className={`${styles.kfChip} ${isSelected ? styles.selected : ''}`}
                style={
                  {
                    left: x,
                    top: chipTop,
                    height: chipH,
                    '--kf-color': color,
                    cursor: dragState?.id === kf.id ? 'grabbing' : 'grab',
                    zIndex: 15,
                    pointerEvents: 'auto',
                  } as React.CSSProperties
                }
                onPointerDown={(e) => handlePointerDown(e, kf.id, 'kf-move', kf.time, 0)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedKeyframeId(kf.id);
                }}
              >
                <div className={styles.kfDiamond} />

                {/* Embedded shared capsule thumbnail preview */}
                {hasBg && (
                  <TimelineMediaCapsule
                    url={assetUrl}
                    backgroundColor={bgColor}
                    thumbnailOnly={true}
                  />
                )}

                <span className={styles.kfLabel}>{getKeyframeLabel(kf)}</span>

                {/* Floating, glowing 16:9 Hover preview overlay card */}
                {hasBg && (
                  <div className={styles.previewOverlay}>
                    <TimelineMediaCapsule
                      url={assetUrl}
                      backgroundColor={bgColor}
                      thumbnailOnly={false}
                      name={kf.label || 'Scene Background'}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        height: '100%',
                        width: '100%',
                        borderRadius: 0,
                        padding: 0,
                      }}
                    />
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {menu && (
        <KeyframeMenu
          pos={{ x: menu.x, y: menu.y }}
          currentTime={menu.time}
          trackId={trackId || undefined}
          existingKfId={menu.existingKf?.id}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

export const KeyframeTrack = memo(KeyframeTrackComponent);

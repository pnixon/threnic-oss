import React, { useRef, useState, useEffect } from 'react';
import { FileText, Music, FilePlus, MoreVertical } from 'lucide-react';
import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  attachClosestEdge,
  extractClosestEdge,
  Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import styles from './PlaylistBrowser.module.css';
import type { Track } from '@/contexts/types';

interface TrackItemProps {
  track: Track;
  index: number;
  isSelected: boolean;
  isEditing: boolean;
  editName: string;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditNameChange: (val: string) => void;
  onEditFinish: () => void;
  onEditCancel: () => void;
  onAddLyrics: () => void;
  dragOverEdge: Edge | null;
  setDragOverInfo: (info: { index: number; edge: Edge | null } | null) => void;
}

export function TrackItem({
  track,
  index,
  isSelected,
  isEditing,
  editName,
  onSelect,
  onContextMenu,
  onEditNameChange,
  onEditFinish,
  onEditCancel,
  onAddLyrics,
  dragOverEdge,
  setDragOverInfo,
}: TrackItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    return combine(
      draggable({
        element: el,
        getInitialData: () => ({ index, id: track.id, type: 'track' }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        getData: ({ input }) =>
          attachClosestEdge(
            { index, id: track.id, type: 'track' },
            {
              element: el,
              input,
              allowedEdges: ['top', 'bottom'],
            },
          ),
        onDragEnter: ({ self }) => {
          const edge = extractClosestEdge(self.data);
          setDragOverInfo({ index, edge });
        },
        onDrag({ self }) {
          const edge = extractClosestEdge(self.data);
          setDragOverInfo({ index, edge });
        },
        onDragLeave: () => setDragOverInfo(null),
        onDrop: () => setDragOverInfo(null),
      }),
    );
  }, [index, track.id, setDragOverInfo]);

  return (
    <div
      ref={ref}
      className={`
                ${styles.trackItem} 
                ${isSelected ? styles.selected : ''} 
                ${isDragging ? styles.draggingTrack : ''}
                ${dragOverEdge === 'top' ? styles.dropTargetTop : ''}
                ${dragOverEdge === 'bottom' ? styles.dropTargetBottom : ''}
            `}
      data-testid="track-item"
      data-selected={isSelected ? 'true' : undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onSelect();
        }
      }}
    >
      <div className={styles.trackMeta}>
        <div className={styles.trackIcon}>
          {track.lyricsData && track.lyricsData.length > 0 ? (
            <FileText size={14} className={styles.hasLyrics} />
          ) : (
            <Music size={14} />
          )}
        </div>
        <span className={styles.trackDuration}>{formatDuration(track.duration)}</span>
      </div>
      <div className={styles.trackInfo}>
        {isEditing ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => onEditNameChange(e.target.value)}
            onBlur={onEditFinish}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onEditFinish();
              if (e.key === 'Escape') onEditCancel();
            }}
            className={styles.editInput}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className={styles.trackName} data-testid="track-name">
            {track.name}
          </span>
        )}
        {track.artist && <span className={styles.trackArtist}>{track.artist}</span>}
      </div>

      <div className={styles.trackActions}>
        <button
          className={styles.actionBtn}
          onClick={(e) => {
            e.stopPropagation();
            onAddLyrics();
          }}
          title="Add Lyrics"
        >
          <FilePlus size={14} />
        </button>
        <span
          className={styles.moreBtn}
          onClick={(e) => onContextMenu(e)}
          role="button"
          data-testid="track-more-btn"
        >
          <MoreVertical size={14} />
        </span>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

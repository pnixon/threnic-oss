import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Plus, Upload, Trash2, Loader2, Shuffle, HelpCircle, SkipForward } from 'lucide-react';
import styles from './PlaylistBrowser.module.css';
import { useMediaQuery } from '@/hooks';
import {
  usePlaylistState,
  useTrackManagementAPI,
  useTrackConfigAPI,
  usePlaylistSettingsAPI,
} from '@/contexts/PlaylistContext';
import { useHelp } from '@/contexts/HelpContext';
import { loadLyricsFromFile } from '@/engine/lyrics/loader';
import { LyricSyncPanel } from '@/components/lyrics-sync/LyricSyncPanel';
import type { LyricLineData, ThrenicWord } from '@/types/lyrics';
import { lyricLinesToThrenicWords } from '@/types/lyrics';
import { TrackItem } from './TrackItem';
import { AudioMonitorSection } from './AudioMonitorSection';

import { PlaylistContextMenu } from './PlaylistContextMenu';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { Track } from '@/contexts/types';

interface PlaylistBrowserProps {
  /** Callback when track is selected (optional, uses context by default) */
  onSelectTrack?: (trackId: string) => void;
  /** Audio element ref for sync panel */
  audioElementRef?: React.RefObject<HTMLAudioElement | null>;
  /** Disable all interactions (e.g. during export) */
  disabled?: boolean;
  /** Shared words state */
  words?: ThrenicWord[];
  setWords?: React.Dispatch<React.SetStateAction<ThrenicWord[]>>;
}

/**
 * PlaylistBrowser - Playlist browser with drag-drop reordering and context menu
 */
export function PlaylistBrowser({
  onSelectTrack,
  audioElementRef,
  disabled,
  words,
  setWords,
}: PlaylistBrowserProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const { tracks, selectedTrackId, isLoading, settings } = usePlaylistState();
  const {
    addTrack,
    removeTrack,
    selectTrack,
    renameTrack,
    reorderTracks,
    clearPlaylist,
    replaceTrackAudio,
    shufflePlaylist,
  } = useTrackManagementAPI();
  const { updateTrackLyrics } = useTrackConfigAPI();
  const { updateSettings } = usePlaylistSettingsAPI();

  const { openHelp } = useHelp();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const lyricsInputRef = useRef<HTMLInputElement>(null);
  const replaceAudioInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; trackId: string } | null>(
    null,
  );
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [isMonitorExpanded, setIsMonitorExpanded] = useState(false);
  const [syncModalTrackId, setSyncModalTrackId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const clearTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Drag-to-reorder state (managed by monitor now, but keeping some for UI)
  const [dragOverInfo, setDragOverInfo] = useState<{
    index: number;
    edge: Edge | null;
  } | null>(null);

  // Handle file selection
  const handleFileSelect = useCallback(
    async (files: FileList | null) => {
      if (!files) return;

      for (const file of Array.from(files)) {
        if (file.type.startsWith('audio/')) {
          try {
            await addTrack(file);
          } catch (error) {
            console.error('Failed to add track:', error);
          }
        }
      }
    },
    [addTrack],
  );

  // Handle lyrics file selection
  const handleLyricsSelect = useCallback(
    async (trackId: string, file: File) => {
      try {
        const lyrics = await loadLyricsFromFile(file);
        updateTrackLyrics(trackId, lyrics, (file as unknown as { path: string }).path || file.name);

        // Immediately update words state if this is the active track
        // to avoid stale timings being preserved by page.tsx logic
        if (trackId === selectedTrackId && setWords) {
          setWords(lyricLinesToThrenicWords(lyrics));
        }
      } catch (error) {
        console.error('Failed to load lyrics:', error);
      }
    },
    [updateTrackLyrics, selectedTrackId, setWords],
  );

  const dragCounter = useRef(0);

  // File drag and drop handlers (for adding files)
  const handleFileDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current += 1;
      setIsDragging(true);
    }
  }, []);

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    // Only handle file drops, not track reorders
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      setIsDragging(false);
      dragCounter.current = 0; // Safety reset
    }
  }, []);

  const handleFileDrop = useCallback(
    (e: React.DragEvent) => {
      // Only handle file drops
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = 0;
        setIsDragging(false);
        handleFileSelect(e.dataTransfer.files);
      }
    },
    [handleFileSelect],
  );

  // Track reorder monitor
  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const destination = location.current.dropTargets[0];
        if (!destination) return;

        const sourceData = source.data;
        const destinationData = destination.data;

        // Ensure we only handle track reorders
        if (sourceData.type !== 'track' || destinationData.type !== 'track') return;

        const sourceIndex = sourceData.index as number;
        const destinationIndex = destinationData.index as number;

        if (sourceIndex === destinationIndex) return;

        reorderTracks(sourceIndex, destinationIndex);
        setDragOverInfo(null);
      },
    });
  }, [reorderTracks]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, trackId });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Start renaming
  const startRename = useCallback(
    (track: Track) => {
      setEditingTrackId(track.id);
      setEditName(track.name);
      closeContextMenu();
    },
    [closeContextMenu],
  );

  // Finish renaming
  const finishRename = useCallback(() => {
    if (editingTrackId && editName.trim()) {
      renameTrack(editingTrackId, editName.trim());
    }
    setEditingTrackId(null);
    setEditName('');
  }, [editingTrackId, editName, renameTrack]);

  // Handle track selection
  const handleSelectTrack = useCallback(
    (trackId: string) => {
      if (disabled) return; // Prevent track switching during export or IDB writes
      selectTrack(trackId);
      onSelectTrack?.(trackId);
    },
    [selectTrack, onSelectTrack, disabled],
  );

  // Trigger lyrics file picker for specific track
  const triggerLyricsPicker = useCallback(
    (trackId: string) => {
      closeContextMenu();
      if (lyricsInputRef.current) {
        lyricsInputRef.current.setAttribute('data-track-id', trackId);
        lyricsInputRef.current.click();
      }
    },
    [closeContextMenu],
  );

  // Trigger audio file picker for replacing specifically
  const triggerAudioReplacePicker = useCallback(
    (trackId: string) => {
      closeContextMenu();
      if (replaceAudioInputRef.current) {
        replaceAudioInputRef.current.setAttribute('data-track-id', trackId);
        replaceAudioInputRef.current.click();
      }
    },
    [closeContextMenu],
  );

  // Open sync modal for specific track
  const openSyncModal = useCallback(
    (trackId: string) => {
      closeContextMenu();
      setSyncModalTrackId(trackId);
    },
    [closeContextMenu],
  );

  // Handle sync completion
  const handleSyncComplete = useCallback(
    (lyrics: LyricLineData[]) => {
      if (syncModalTrackId) {
        updateTrackLyrics(syncModalTrackId, lyrics);
      }
      setSyncModalTrackId(null);
    },
    [syncModalTrackId, updateTrackLyrics],
  );

  const syncModalTrack = syncModalTrackId ? tracks.find((t) => t.id === syncModalTrackId) : null;

  const handleClearClick = useCallback(() => {
    if (confirmClear) {
      clearPlaylist();
      setConfirmClear(false);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    } else {
      setConfirmClear(true);
      // Auto-reset after 3 seconds
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        setConfirmClear(false);
      }, 3000);
    }
  }, [confirmClear, clearPlaylist]);

  // Cleanup timer on unmount
  React.useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  return (
    <div
      className={`${styles.panel} ${isDragging ? styles.dragging : ''}`}
      style={{
        pointerEvents: disabled ? 'none' : 'auto',
        opacity: disabled ? 0.5 : 1,
      }}
      data-testid="left-panel-inner"
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onClick={closeContextMenu}
    >
      {isMobile && (
        <div
          style={{
            width: 36,
            height: 4,
            backgroundColor: 'rgba(255, 255, 255, 0.15)',
            borderRadius: 2,
            margin: '8px auto 4px',
            flexShrink: 0,
          }}
        />
      )}
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        multiple
        onChange={(e) => {
          handleFileSelect(e.target.files);
          e.target.value = '';
        }}
        style={{ display: 'none' }}
      />
      <input
        ref={replaceAudioInputRef}
        type="file"
        accept="audio/*"
        onChange={(e) => {
          const trackId = e.target.getAttribute('data-track-id');
          if (trackId && e.target.files?.[0]) {
            replaceTrackAudio(trackId, e.target.files[0]);
          }
          e.target.value = '';
        }}
        style={{ display: 'none' }}
      />
      <input
        ref={lyricsInputRef}
        type="file"
        accept=".lrc,.json,.srt,.txt"
        onChange={(e) => {
          const trackId = e.target.getAttribute('data-track-id');
          if (trackId && e.target.files?.[0]) {
            handleLyricsSelect(trackId, e.target.files[0]);
          }
          e.target.value = '';
        }}
        style={{ display: 'none' }}
      />

      {/* Header */}
      <div className={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="label">Playlist</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openHelp('playlist');
            }}
            className={styles.helpBtn}
            title="Playlist Help"
          >
            <HelpCircle size={16} />
          </button>
          {tracks.length > 1 && (
            <button
              className={styles.shuffleBtn}
              onClick={shufflePlaylist}
              title="Shuffle Playlist Order"
            >
              <Shuffle size={13} />
            </button>
          )}
          {tracks.length > 0 && (
            <button
              className={`${styles.shuffleBtn} ${settings.autoNext ? styles.active : ''}`}
              onClick={() => updateSettings({ autoNext: !settings.autoNext })}
              title={settings.autoNext ? 'Auto-play next: ON' : 'Auto-play next: OFF'}
            >
              <SkipForward size={13} />
            </button>
          )}
          {tracks.length > 0 && (
            <button
              className={`${styles.clearBtn} ${confirmClear ? styles.confirmClear : ''}`}
              onClick={handleClearClick}
              title={confirmClear ? 'Click again to confirm' : 'Clear all tracks'}
            >
              <Trash2 size={14} />
              {confirmClear && <span className={styles.clearText}>Confirm?</span>}
            </button>
          )}
        </div>
        <button
          className={styles.addBtn}
          data-testid="add-track-btn"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Add track"
          disabled={isLoading}
        >
          {isLoading ? <Loader2 size={14} className={styles.spinning} /> : <Plus size={14} />}
        </button>
      </div>

      {/* Track List */}
      <div className={styles.trackList} data-testid="track-list">
        {tracks.length === 0 ? (
          <div className={styles.emptyState} data-testid="track-list-empty">
            <Upload size={32} className={styles.emptyIcon} />
            <p>Drop audio files here</p>
            <button className="btn-ghost" onClick={() => fileInputRef.current?.click()}>
              Or browse files
            </button>
          </div>
        ) : (
          tracks.map((track, index) => (
            <TrackItem
              key={track.id}
              track={track}
              index={index}
              isSelected={selectedTrackId === track.id}
              isEditing={editingTrackId === track.id}
              editName={editName}
              onSelect={() => handleSelectTrack(track.id)}
              onContextMenu={(e) => handleContextMenu(e, track.id)}
              onEditNameChange={(val) => setEditName(val)}
              onEditFinish={finishRename}
              onEditCancel={() => {
                setEditingTrackId(null);
                setEditName('');
              }}
              onAddLyrics={() => triggerLyricsPicker(track.id)}
              dragOverEdge={dragOverInfo?.index === index ? dragOverInfo.edge : null}
              setDragOverInfo={setDragOverInfo}
            />
          ))
        )}
      </div>

      {/* Audio Monitor Section */}
      <AudioMonitorSection
        isMonitorExpanded={isMonitorExpanded}
        setIsMonitorExpanded={setIsMonitorExpanded}
      />

      {/* Drag overlay for file drops */}
      {isDragging && (
        <div className={styles.dropOverlay}>
          <Upload size={48} />
          <span>Drop audio files</span>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <PlaylistContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          trackId={contextMenu.trackId}
          tracks={tracks}
          onStartRename={startRename}
          onTriggerAudioReplace={triggerAudioReplacePicker}
          onTriggerLyricsPicker={triggerLyricsPicker}
          onOpenSyncModal={openSyncModal}
          onRemoveTrack={removeTrack}
          onClose={closeContextMenu}
        />
      )}

      {/* Lyric Sync Panel */}
      <LyricSyncPanel
        isOpen={syncModalTrackId !== null}
        onClose={() => setSyncModalTrackId(null)}
        audioElementRef={audioElementRef}
        onSyncComplete={handleSyncComplete}
        trackName={syncModalTrack?.name}
        words={words}
        setWords={setWords}
      />
    </div>
  );
}

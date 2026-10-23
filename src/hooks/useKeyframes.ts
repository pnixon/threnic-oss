import { useEffect } from 'react';
import { usePlaylistState } from '@/contexts/PlaylistContext';
import { useKeyframeSelection } from '@/contexts';
import { type Keyframe, sortKeyframes } from '@/types/keyframes';
import { lyricLinesToThrenicWords } from '@/types/lyrics';
import { projectStore } from '@/stores/projectStore';
import { timeStore } from '@/engine/stores/timeStore';
import { resolveWritableKeyframeId } from '@/utils/keyframes';
import {
  commandBusStore,
  createUpdatePropertyCommand,
  createUpdateEffectInstanceCommand,
  createUpdateKeyframesCommand,
  createAddKeyframeCommand,
  createRemoveKeyframeCommand,
} from '@/stores/commandBus';

/**
 * Read the previous value of a property for undo capture.
 * Mirrors the resolution order of projectStore.updateTrackProperty.
 */
function readPreviousProperty(trackId: string, propertyPath: string, keyframeId?: string): unknown {
  const track = projectStore.getState().getTrackById(trackId);
  if (!track) return undefined;
  const currentTime = timeStore.getState().currentTime;
  // Read from the SAME keyframe the write will alter so undo captures the value
  // being replaced (mirrors projectStore.updateTrackProperty).
  const targetId = resolveWritableKeyframeId(
    track.keyframes,
    propertyPath,
    currentTime,
    keyframeId,
  );
  if (targetId) {
    const kf = (track.keyframes || []).find((k) => k.id === targetId);
    return kf?.properties?.[propertyPath];
  }
  return undefined;
}

/**
 * Standardized hook for keyframe CRUD operations.
 * Abstracts away the underlying PlaylistContext management.
 */
export function useKeyframes(
  trackIdOverride?: string,
  laneFilter?: 'background' | 'effects' | 'lyrics',
) {
  const { selectedTrackId, tracks } = usePlaylistState();

  const {
    selectedKeyframeId,
    setSelectedKeyframeId,
    setKeyframes: syncKeyframes,
    activeLane,
  } = useKeyframeSelection();

  const currentLane = laneFilter !== undefined ? laneFilter : activeLane;

  const trackId = trackIdOverride ?? selectedTrackId;
  const track = tracks.find((t) => t.id === trackId);
  const allKeyframes = track?.keyframes || [];

  // Filter keyframes to only the ones for the current lane.
  // For 'lyrics' lane, construct keyframes from the track's word timing blocks.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt each render on purpose; the sync effect below relies on running every render
  let keyframes: Keyframe[] = [];
  if (currentLane === 'lyrics') {
    const lines = track?.lyricsData || [];
    const words = lyricLinesToThrenicWords(lines);
    keyframes = words.map((w) => ({
      id: w.id,
      time: w.startTime,
      label: w.text,
      properties: {},
      lane: 'lyrics' as const,
      interpolation: 'hold' as const,
    }));
  } else {
    keyframes = currentLane ? allKeyframes.filter((k) => k.lane === currentLane) : allKeyframes;
  }

  // Sync filtered keyframes to the selection context
  useEffect(() => {
    syncKeyframes(keyframes);
  }, [keyframes, syncKeyframes]);

  const setKeyframes = (newKfs: Keyframe[]) => {
    if (!trackId) return;
    const prev = projectStore.getState().getTrackById(trackId)?.keyframes || [];
    let next: Keyframe[];
    if (currentLane) {
      if (currentLane === 'lyrics') return; // Read-only from lyricsData
      // Keep keyframes from other lanes intact
      const otherKfs = allKeyframes.filter((k) => k.lane !== currentLane);
      const stampedKfs = newKfs.map((k) => ({ ...k, lane: currentLane }));
      next = sortKeyframes([...otherKfs, ...stampedKfs]);
    } else {
      next = newKfs;
    }
    commandBusStore.getState().dispatch(createUpdateKeyframesCommand(trackId, next, prev));
  };

  const addKeyframe = (kf: Keyframe) => {
    if (!trackId) return;
    if (currentLane === 'lyrics') return;
    const stampedKf = currentLane ? { ...kf, lane: currentLane } : kf;
    commandBusStore.getState().dispatch(createAddKeyframeCommand(trackId, stampedKf));
  };

  const removeKeyframe = (kfId: string) => {
    if (!trackId) return;
    const target = (projectStore.getState().getTrackById(trackId)?.keyframes || []).find(
      (k) => k.id === kfId,
    );
    if (!target) return;
    commandBusStore.getState().dispatch(createRemoveKeyframeCommand(trackId, target));
  };

  const updateProperty = (property: string, value: unknown, targetKeyframeId?: string | null) => {
    if (!trackId) return;

    // Pass 'default' explicitly so PlaylistContext knows to use playhead time if targetKeyframeId isn't explicitly defined.
    const finalKeyframeId = targetKeyframeId !== undefined ? targetKeyframeId : selectedKeyframeId;
    const previousValue = readPreviousProperty(trackId, property, finalKeyframeId || undefined);
    // Route through the CommandBus so every edit is undoable and shares one
    // history (previously this bypassed undo entirely).
    commandBusStore
      .getState()
      .dispatch(
        createUpdatePropertyCommand(
          trackId,
          property,
          value,
          previousValue,
          finalKeyframeId || undefined,
        ),
      );
  };

  const updateEffectInstance = (
    instanceId: string,
    config: unknown,
    targetKeyframeId?: string | null,
  ) => {
    if (!trackId) return;
    const finalKeyframeId = targetKeyframeId !== undefined ? targetKeyframeId : selectedKeyframeId;
    const track = projectStore.getState().getTrackById(trackId);
    const previousConfig = track?.effectsConfig?.effectInstances?.find(
      (i) => i.id === instanceId,
    )?.config;
    commandBusStore
      .getState()
      .dispatch(
        createUpdateEffectInstanceCommand(
          trackId,
          instanceId,
          config,
          previousConfig,
          finalKeyframeId || undefined,
        ),
      );
  };

  return {
    trackId,
    keyframes,
    selectedKeyframeId,
    setSelectedKeyframeId,
    setKeyframes,
    addKeyframe,
    removeKeyframe,
    updateProperty,
    updateEffectInstance,
  };
}

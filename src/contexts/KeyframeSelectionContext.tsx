'use client';

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
  useEffect,
  useRef,
} from 'react';
import type { Keyframe } from '@/types/keyframes';
import { timeStore } from '@/engine/stores/timeStore';
import { EngineLoop } from '@/engine/EngineLoop';

interface KeyframeSelectionContextValue {
  /** Currently selected keyframe ID, or 'default' for base state */
  selectedKeyframeId: string | 'default';
  /** Set the selected keyframe. Optionally skip moving the playhead. */
  setSelectedKeyframeId: (id: string | 'default', skipJump?: boolean) => void;
  /** Get the selected keyframe object from a list */
  getSelectedKeyframe: (keyframes: Keyframe[]) => Keyframe | null;
  /** Sync keyframes for auto-selection logic */
  setKeyframes: (keyframes: Keyframe[]) => void;
  /** Clear selection (return to default) */
  clearSelection: () => void;
  /** Whether the current selection was made by the user manually */
  isManualSelection: boolean;

  /** Currently selected background clip ID */
  selectedClipId: string | null;
  /** Set the selected background clip ID */
  setSelectedClipId: (id: string | null) => void;

  /** Active keyframe lane filter */
  activeLane: 'background' | 'effects' | 'lyrics' | null;
  /** Set active keyframe lane filter */
  setActiveLane: (lane: 'background' | 'effects' | 'lyrics' | null) => void;
}

const KeyframeSelectionContext = createContext<KeyframeSelectionContextValue | null>(null);

interface KeyframeSelectionProviderProps {
  children: ReactNode;
}

export function KeyframeSelectionProvider({
  children,
}: KeyframeSelectionProviderProps): React.ReactElement {
  const [selectedKeyframeId, setSelectedKeyframeIdState] = useState<string | 'default'>('default');
  const [selectedClipId, setSelectedClipIdState] = useState<string | null>(null);
  const [isManualSelection, setIsManualSelection] = useState(false);
  const [activeLane, setActiveLane] = useState<'background' | 'effects' | 'lyrics' | null>(null);
  const manualSelectionRef = useRef<{ id: string | 'default'; time: number } | null>(null);

  const keyframesRef = useRef<Keyframe[]>([]);

  const setSelectedClipId = useCallback((id: string | null) => {
    setSelectedClipIdState(id);
    if (id !== null) {
      setSelectedKeyframeIdState('default');
      manualSelectionRef.current = null;
      setIsManualSelection(false);
    }
  }, []);

  const setSelectedKeyframeId = useCallback((id: string | 'default', skipJump = false) => {
    setSelectedKeyframeIdState(id);
    if (id !== 'default') {
      setSelectedClipIdState(null);
    }

    if (id === 'default') {
      manualSelectionRef.current = null;
      setIsManualSelection(false);
    } else {
      const kf = keyframesRef.current.find((k) => k.id === id);
      if (kf) {
        manualSelectionRef.current = { id, time: Date.now() };
        setIsManualSelection(true);
        if (!skipJump) {
          timeStore.getState().setCurrentTime(kf.time, true);
        }
      }
    }
  }, []);

  const getSelectedKeyframe = useCallback(
    (keyframes: Keyframe[]): Keyframe | null => {
      keyframesRef.current = keyframes;
      if (selectedKeyframeId === 'default') return null;
      let filtered = keyframes;
      if (activeLane) {
        filtered = keyframes.filter((k) => k.lane === activeLane);
      }
      return filtered.find((kf) => kf.id === selectedKeyframeId) || null;
    },
    [selectedKeyframeId, activeLane],
  );

  const setKeyframes = useCallback((keyframes: Keyframe[]) => {
    keyframesRef.current = keyframes;
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedKeyframeIdState('default');
    setSelectedClipId(null);
    manualSelectionRef.current = null;
    setIsManualSelection(false);
  }, [setSelectedClipId]);

  // Keep a ref to the current selectedKeyframeId so the EngineLoop callback
  // can read the latest value without re-registering on every change.
  const selectedKfIdRef = useRef(selectedKeyframeId);
  // eslint-disable-next-line react-hooks/refs -- latest-value ref, only read from callbacks/effects
  selectedKfIdRef.current = selectedKeyframeId;

  const activeLaneRef = useRef(activeLane);
  // eslint-disable-next-line react-hooks/refs -- latest-value ref, only read from callbacks/effects
  activeLaneRef.current = activeLane;

  // Auto-selection logic based on playhead — registered once.
  useEffect(() => {
    return EngineLoop.register(() => {
      // A manual dropdown selection is STICKY: once the user picks a keyframe,
      // playhead auto-tracking must never change it out from under them. It is
      // released only when the user clears the selection (setSelectedKeyframeId
      // 'default' / clearSelection) or picks another. So bail whenever a manual
      // selection is active.
      if (manualSelectionRef.current) {
        return;
      }

      // Skip auto-selection if a clip is currently selected
      if (selectedClipId) return;

      const now = timeStore.getState().currentTime;
      let kfs = keyframesRef.current;
      if (activeLaneRef.current) {
        kfs = kfs.filter((k) => k.lane === activeLaneRef.current);
      }
      if (!kfs || kfs.length === 0) {
        if (selectedKfIdRef.current !== 'default') {
          setSelectedKeyframeIdState('default');
          setIsManualSelection(false);
        }
        return;
      }

      // Find the "active" keyframe (the latest one at or before 'now')
      let activeKf: Keyframe | null = null;
      for (const kf of kfs) {
        if (kf.time <= now + 0.05) {
          // 50ms tolerance for better UX when scrubbing
          if (!activeKf || kf.time > activeKf.time) {
            activeKf = kf;
          }
        }
      }

      const activeId = activeKf ? activeKf.id : 'default';

      if (selectedKfIdRef.current !== activeId) {
        selectedKfIdRef.current = activeId; // Update ref immediately to prevent duplicate state updates before next render
        setSelectedKeyframeIdState(activeId);
        setIsManualSelection(false);
      }
    }, 100);
  }, [selectedClipId]); // Stable — reads current values via refs

  const value = React.useMemo(
    () => ({
      selectedKeyframeId,
      setSelectedKeyframeId,
      getSelectedKeyframe,
      setKeyframes,
      clearSelection,
      isManualSelection,
      selectedClipId,
      setSelectedClipId,
      activeLane,
      setActiveLane,
    }),
    [
      selectedKeyframeId,
      setSelectedKeyframeId,
      getSelectedKeyframe,
      setKeyframes,
      clearSelection,
      isManualSelection,
      selectedClipId,
      setSelectedClipId,
      activeLane,
      setActiveLane,
    ],
  );

  return (
    <KeyframeSelectionContext.Provider value={value}>{children}</KeyframeSelectionContext.Provider>
  );
}

export function useKeyframeSelection(): KeyframeSelectionContextValue {
  const context = useContext(KeyframeSelectionContext);
  if (!context) {
    throw new Error('useKeyframeSelection must be used within a KeyframeSelectionProvider');
  }
  return context;
}

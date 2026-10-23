'use client';

import { useState, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { timeStore } from '@/engine/stores/timeStore';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { getCurrentBackgroundUrl } from '@/engine/stores/exportStore';

// ---------------------------------------------------------------------------
// Background URL
// ---------------------------------------------------------------------------

export function useScheduleAwareBackgroundUrl(
  defaultUrl?: string | null,
  isPrevious?: boolean,
): string | undefined {
  const [activeUrl, setActiveUrl] = useState<string | undefined>(defaultUrl || undefined);
  const sceneRef = isPrevious ? keyframeStore.getState().scenePrev : keyframeStore.getState().scene;
  const sceneVersionRef = useRef(sceneRef._version);
  const [, forceUpdate] = useState(0);

  useFrame(function (): void {
    if (!isPrevious && timeStore.getState().mode === 'export') {
      const scheduledUrl = getCurrentBackgroundUrl(
        timeStore.getState().mode,
        timeStore.getState().currentTime,
      );
      const url = scheduledUrl ?? defaultUrl;
      if (url !== activeUrl) {
        setActiveUrl(url || undefined);
      }
    }

    if (sceneVersionRef.current !== sceneRef._version) {
      sceneVersionRef.current = sceneRef._version;
      forceUpdate((n) => n + 1);
    }
  });

  useEffect(
    function (): () => void {
      if (timeStore.getState().mode !== 'export') {
        const timeout = setTimeout(() => setActiveUrl(defaultUrl || undefined), 0);
        return () => clearTimeout(timeout);
      }
      return () => {};
    },
    [defaultUrl],
  );

  const baseUrl = timeStore.getState().mode === 'export' ? activeUrl : defaultUrl || undefined;

  if (isPrevious) {
    const result = sceneRef.assetUrl || undefined;
    return result;
  }

  const result = sceneRef.assetUrl || baseUrl;
  return result;
}

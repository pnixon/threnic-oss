'use client';

import { useState, useEffect, useRef } from 'react';
import { setNestedValue } from '@/utils';
import type { LyricTheme } from '@/types/lyrics';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { registerFrameUpdate } from '@/engine/EngineLoop';

// ---------------------------------------------------------------------------
// Theme Hooks
// ---------------------------------------------------------------------------

/**
 * Applies keyframe-driven theme overrides to a base theme
 */
function applyThemeOverrides(base?: LyricTheme): LyricTheme | undefined {
  if (!base && Object.keys(keyframeStore.getState().lyrics.overrides).length === 0) {
    return undefined;
  }

  const result = { ...base } as LyricTheme;

  // Apply each override from keyframeState
  for (const [key, value] of Object.entries(keyframeStore.getState().lyrics.overrides)) {
    setNestedValue(result, key, value);
  }

  return result;
}

/**
 * Hook to get schedule-aware lyric theme (UI version)
 */
export function useScheduleAwareThemeUI(defaultTheme?: LyricTheme): LyricTheme | undefined {
  const lyricVersionRef = useRef(keyframeStore.getState().lyrics._version);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const check = () => {
      if (lyricVersionRef.current !== keyframeStore.getState().lyrics._version) {
        lyricVersionRef.current = keyframeStore.getState().lyrics._version;
        forceUpdate((n) => n + 1);
      }
    };
    const unreg = registerFrameUpdate(check, 100);
    check();
    return unreg;
  }, []);

  return applyThemeOverrides(defaultTheme);
}

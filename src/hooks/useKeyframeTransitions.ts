/**
 * useKeyframeTransitions — Registers the keyframe resolver with the EngineLoop.
 *
 * This hook is now a thin wrapper that:
 * 1. Initializes the reactive keyframeResolver (subscribes to track changes)
 * 2. Registers tickResolver() with EngineLoop for per-frame updates
 *
 * All keyframe/theme/effects data is read directly from projectStore/exportStore
 * by the resolver — no props needed.
 */
'use client';

import { useEffect } from 'react';
import { EngineLoop } from '@/engine/EngineLoop';
import { tickResolver, initResolver, resetResolver } from '@/engine/keyframeResolver';

/**
 * Mount this hook once in the app root to drive keyframe resolution.
 * No arguments needed — the resolver reads from Zustand stores directly.
 */
export function useKeyframeTransitions(): void {
  useEffect(() => {
    // Subscribe to track selection changes → auto-reset caches
    const unsubTrackChanges = initResolver();

    // Register the resolver tick with the engine loop
    const unregLoop = EngineLoop.register(() => {
      tickResolver();
    }, 100);

    return () => {
      unregLoop();
      unsubTrackChanges();
      resetResolver();
    };
  }, []);
}

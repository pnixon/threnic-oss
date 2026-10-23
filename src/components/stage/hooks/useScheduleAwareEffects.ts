'use client';

import { useState, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { EffectsConfig } from '@/types/effects';
import { timeStore } from '@/engine/stores/timeStore';
import { keyframeStore } from '@/engine/stores/keyframeStore';
import { getCurrentEffectsConfig } from '@/engine/stores/exportStore';
import { registerFrameUpdate } from '@/engine/EngineLoop';

// ---------------------------------------------------------------------------
// Effects Config Hooks
// ---------------------------------------------------------------------------

/**
 * Hook to get schedule-aware effects configuration (Canvas version)
 */
export function useScheduleAwareEffectsConfig(
  defaultConfig?: EffectsConfig,
): EffectsConfig | undefined {
  const [activeConfig, setActiveConfig] = useState(defaultConfig);
  const effectVersionRef = useRef(keyframeStore.getState().effects._version);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const check = () => {
      if (effectVersionRef.current !== keyframeStore.getState().effects._version) {
        effectVersionRef.current = keyframeStore.getState().effects._version;
        forceUpdate((n) => n + 1);
      }
    };
    const unreg = registerFrameUpdate(check, 200);
    check();
    return unreg;
  }, []);

  useFrame(function (): void {
    if (timeStore.getState().mode === 'export') {
      const scheduledConfig = getCurrentEffectsConfig(
        timeStore.getState().mode,
        timeStore.getState().currentTime,
      );
      if (scheduledConfig && scheduledConfig !== activeConfig) {
        setActiveConfig(scheduledConfig);
      }
    }

    if (effectVersionRef.current !== keyframeStore.getState().effects._version) {
      effectVersionRef.current = keyframeStore.getState().effects._version;
      forceUpdate((n) => n + 1);
    }
  });

  const base =
    (timeStore.getState().mode === 'export' ? activeConfig : defaultConfig) ?? defaultConfig;
  const computed = keyframeStore.getState().effects.computedConfig;
  return computed || base;
}

/**
 * Hook to get schedule-aware effects configuration (UI version - no useFrame)
 */
export function useScheduleAwareEffectsConfigUI(
  defaultConfig?: EffectsConfig,
): EffectsConfig | undefined {
  const effectVersionRef = useRef(keyframeStore.getState().effects._version);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const check = () => {
      if (effectVersionRef.current !== keyframeStore.getState().effects._version) {
        effectVersionRef.current = keyframeStore.getState().effects._version;
        forceUpdate((n) => n + 1);
      }
    };
    // Check frequently for smooth UI feedback during playback
    const unreg = registerFrameUpdate(check, 100);
    check();
    return unreg;
  }, []);

  return keyframeStore.getState().effects.computedConfig || defaultConfig;
}

'use client';

/**
 * ProfilerMenuItems — dev-only Header dropdown controls for the PerfProfiler.
 *
 * Renders NOTHING unless the build is a dev build AND the page is served from
 * localhost. Provides: a toggle (enable/disable profiling), a start/stop trace
 * capture button, and a download-trace button. All state lives in the vanilla
 * systemStore + the profiler singleton; this component just reflects/drives it.
 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Activity, Circle, Download } from 'lucide-react';
import { DropdownItem, DropdownDivider } from '@/components/shared/DropdownMenu';
import { systemStore } from '@/stores/systemStore';
import { profiler } from '@/utils/profiler';
import { useIsHydrated } from '@/hooks/useIsHydrated';

function useIsLocalDev(): boolean {
  const hydrated = useIsHydrated();
  if (!hydrated || process.env.NODE_ENV !== 'development') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function ProfilerMenuItems({
  onAction,
}: {
  onAction?: () => void;
}): React.ReactElement | null {
  const isLocalDev = useIsLocalDev();
  const enabled = useSyncExternalStore(
    systemStore.subscribe,
    () => systemStore.getState().profilingEnabled,
    () => false,
  );
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState(0);

  // Poll the captured-frame count while capturing.
  useEffect(() => {
    if (!capturing) return;
    const id = window.setInterval(() => setCaptured(profiler.capturedFrameCount), 500);
    return () => window.clearInterval(id);
  }, [capturing]);

  if (!isLocalDev) return null;

  const toggle = () => {
    const next = !enabled;
    systemStore.getState().setProfilingEnabled(next);
    // Turning off also stops any capture.
    if (!next && capturing) {
      profiler.stopCapture();
      setCapturing(false);
    }
  };

  const toggleCapture = () => {
    if (!enabled) return;
    if (capturing) {
      profiler.stopCapture();
      setCapturing(false);
      setCaptured(profiler.capturedFrameCount);
    } else {
      profiler.startCapture();
      setCapturing(true);
      setCaptured(0);
    }
  };

  const download = () => {
    profiler.downloadTrace();
    onAction?.();
  };

  return (
    <>
      <DropdownDivider />
      <DropdownItem
        icon={<Activity size={14} color={enabled ? '#4ade80' : undefined} />}
        onClick={toggle}
      >
        {enabled ? 'Profiler: ON (dev)' : 'Profiler: OFF (dev)'}
      </DropdownItem>
      {enabled && (
        <>
          <DropdownItem
            icon={<Circle size={14} color={capturing ? '#f87171' : undefined} />}
            onClick={toggleCapture}
          >
            {capturing ? `Stop capture (${captured} frames)` : 'Start trace capture'}
          </DropdownItem>
          <DropdownItem icon={<Download size={14} />} onClick={download}>
            Download trace JSON
          </DropdownItem>
        </>
      )}
    </>
  );
}

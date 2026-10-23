'use client';

/**
 * useExportMode — React hook for legacy multi-track export.
 *
 * This hook is now a thin wrapper around:
 *   - `exportUIStore` — all UI state (progress, config, fps, codec)
 *   - `runLegacyExportLoop` — the actual frame-by-frame render loop
 *
 * The hook exists to maintain the same API surface for consumers
 * (ExportTab, AppContent) while the internals
 * have been decomposed into separate modules.
 *
 * For new export features, prefer using `DecoupledExporter` directly
 * via `useDecoupledExport()`.
 */

import { useCallback, useState } from 'react';
import { exportUIStore, useExportUIStore } from '../stores/exportUIStore';

import { StreamableExportController } from './StreamableExportController';
import type { WebGPURenderer } from '../gpu/WebGPURenderer';
import type { MultiExportConfig } from '@/types/multi-export';
import type { TrackExportData } from '@/contexts/types';
import type { CodecKey, FpsKey, ExportProgress } from '@/types/export';

interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  duration: number;
  startTime?: number;
  endTime?: number;
  audioBuffer?: AudioBuffer;
  suggestedName?: string;

  multiTrack?: {
    enabled: boolean;
    config: MultiExportConfig;
    tracks: TrackExportData[];
  };
  fileHandle?: FileSystemFileHandle;
}

interface UseExportModeReturn {
  isExporting: boolean;
  isCancelled: boolean;
  progress: ExportProgress | null;
  startExport: (gpuRenderer: WebGPURenderer, options: ExportOptions) => Promise<boolean>;
  cancelExport: () => void;
  isSupported: boolean;
  config: MultiExportConfig;
  setConfig: (update: MultiExportConfig | ((prev: MultiExportConfig) => MultiExportConfig)) => void;
  selectedFps: FpsKey;
  setSelectedFps: (fps: FpsKey) => void;
  selectedCodec: CodecKey;
  setSelectedCodec: (codec: CodecKey) => void;
  useWorker: boolean;
  setUseWorker: (use: boolean) => void;
  watermarkEnabled: boolean;
  setWatermarkEnabled: (enabled: boolean) => void;
}

export function useExportMode(): UseExportModeReturn {
  // Read all state from the Zustand store
  const isExporting = useExportUIStore((s) => s.isExporting);
  const isCancelled = useExportUIStore((s) => s.isCancelled);
  const progress = useExportUIStore((s) => s.progress);
  const config = useExportUIStore((s) => s.config);
  const selectedFps = useExportUIStore((s) => s.selectedFps);
  const selectedCodec = useExportUIStore((s) => s.selectedCodec);
  const useWorker = useExportUIStore((s) => s.useWorker);
  const watermarkEnabled = useExportUIStore((s) => s.watermarkEnabled);
  const setConfig = useExportUIStore((s) => s.setConfig);
  const setSelectedFps = useExportUIStore((s) => s.setSelectedFps);
  const setSelectedCodec = useExportUIStore((s) => s.setSelectedCodec);
  const setUseWorker = useExportUIStore((s) => s.setUseWorker);
  const setWatermarkEnabled = useExportUIStore((s) => s.setWatermarkEnabled);
  const cancelExport = useExportUIStore((s) => s.cancelExport);

  const [isSupported] = useState(() => StreamableExportController.isSupported());

  const startExport = useCallback(
    async (_gpuRenderer: WebGPURenderer, options: ExportOptions): Promise<boolean> => {
      if (exportUIStore.getState().isExporting) {
        console.warn('[Export] Export already in progress');
        return false;
      }

      exportUIStore.setState({ isExporting: true, isCancelled: false });

      // Acquire File Handle early to preserve user gesture
      let fileHandle = options.fileHandle;
      if (!fileHandle && typeof window !== 'undefined') {
        try {
          fileHandle = await (
            window as unknown as {
              showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>;
            }
          ).showSaveFilePicker({
            suggestedName: options.suggestedName || 'visualization.mp4',
            types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
          });
        } catch {
          exportUIStore.setState({ isExporting: false });
          return false;
        }
      }

      if (!fileHandle) {
        exportUIStore.setState({ isExporting: false });
        return false;
      }

      try {
        await fileHandle.createWritable();
        console.error(
          '[Export] runLegacyExportLoop is deprecated and removed. Please use DecoupledExporter.',
        );
        return false;
      } catch (e) {
        console.error('[Export] Failed to open file for writing:', e);
        exportUIStore.setState({ isExporting: false });
        return false;
      }
    },
    [],
  );

  return {
    isExporting,
    isCancelled,
    progress,
    startExport,
    cancelExport,
    isSupported,
    config,
    setConfig,
    selectedFps,
    setSelectedFps,
    selectedCodec,
    setSelectedCodec,
    useWorker,
    setUseWorker,
    watermarkEnabled,
    setWatermarkEnabled,
  };
}

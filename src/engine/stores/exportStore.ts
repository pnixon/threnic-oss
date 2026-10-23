import { createStore } from 'zustand/vanilla';
import type { EffectsConfig } from '@/types/effects';
import type { LyricTheme, LyricLineData } from '@/types/lyrics';
import type { Keyframe } from '@/types/keyframes';
import type { MultiExportConfig } from '@/types/multi-export';
import { DEFAULT_MULTI_EXPORT_CONFIG } from '@/types/multi-export';
import type { CodecKey, FpsKey, ExportProgress } from '@/types/export';

interface ExportState {
  // Schedules (set before export)
  effectsSchedule: Array<{ startTime: number; config: EffectsConfig }>;
  themeSchedule: Array<{ startTime: number; theme: LyricTheme }>;
  backgroundSchedule: Array<{ startTime: number; url: string }>;
  titleSchedule: Array<{ startTime: number; title: string }>;
  keyframeSchedule: Keyframe[];
  trackBoundaries: number[];

  // Global project state for export
  mergedLyrics: LyricLineData[] | null;
  defaultEffectsConfig: EffectsConfig | null;
  defaultTheme: LyricTheme | null;
  defaultBackgroundUrl: string | null;
  defaultTrackTitle: string | null;

  // Runtime status
  isExporting: boolean;
  isCancelled: boolean;
  progress: ExportProgress | null;
  lastTrackIndex: number;

  // Configuration (persisted in session)
  config: MultiExportConfig;
  selectedFps: FpsKey;
  selectedCodec: CodecKey;
  useWorker: boolean;

  // Actions
  setLastTrackIndex: (index: number) => void;
  setExporting: (exporting: boolean) => void;
  setCancelled: (cancelled: boolean) => void;
  setProgress: (progress: ExportProgress | null) => void;
  setConfig: (config: MultiExportConfig) => void;
  setSelectedFps: (fps: FpsKey) => void;
  setSelectedCodec: (codec: CodecKey) => void;
  setUseWorker: (use: boolean) => void;
  clear: () => void;
}

export const exportStore = createStore<ExportState>((set) => ({
  effectsSchedule: [],
  themeSchedule: [],
  backgroundSchedule: [],
  titleSchedule: [],
  keyframeSchedule: [],
  trackBoundaries: [],
  mergedLyrics: null,
  defaultEffectsConfig: null,
  defaultTheme: null,
  defaultBackgroundUrl: null,
  defaultTrackTitle: null,

  isExporting: false,
  isCancelled: false,
  progress: null,
  lastTrackIndex: -1,

  config: { ...DEFAULT_MULTI_EXPORT_CONFIG, tracks: [] },
  selectedFps: 60,
  selectedCodec: 'h264',
  useWorker: true,

  setLastTrackIndex: (index) => set({ lastTrackIndex: index }),
  setExporting: (exporting) => set({ isExporting: exporting }),
  setCancelled: (cancelled) => set({ isCancelled: cancelled }),
  setProgress: (progress) => set({ progress }),
  setConfig: (config) => set({ config }),
  setSelectedFps: (fps) => set({ selectedFps: fps }),
  setSelectedCodec: (codec) => set({ selectedCodec: codec }),
  setUseWorker: (use) => set({ useWorker: use }),

  clear: () =>
    set({
      effectsSchedule: [],
      themeSchedule: [],
      backgroundSchedule: [],
      titleSchedule: [],
      keyframeSchedule: [],
      trackBoundaries: [],
      mergedLyrics: null,
      defaultEffectsConfig: null,
      defaultTheme: null,
      defaultBackgroundUrl: null,
      defaultTrackTitle: null,
      isExporting: false,
      isCancelled: false,
      progress: null,
      lastTrackIndex: -1,
    }),
}));

/**
 * Get current effects config based on mode and time
 */
export function getCurrentEffectsConfig(
  mode: 'preview' | 'export',
  time: number,
): EffectsConfig | null {
  if (mode !== 'export') return null;
  const { effectsSchedule, defaultEffectsConfig } = exportStore.getState();
  let current = defaultEffectsConfig;
  for (const entry of effectsSchedule) {
    if (time >= entry.startTime) current = entry.config;
  }
  return current;
}

export function getCurrentBackgroundUrl(mode: 'preview' | 'export', time: number): string | null {
  if (mode !== 'export') return null;
  const { backgroundSchedule, defaultBackgroundUrl } = exportStore.getState();
  let current = defaultBackgroundUrl;
  for (const entry of backgroundSchedule) {
    if (time >= entry.startTime) current = entry.url;
  }
  return current;
}

export function getRelativeTrackTime(mode: 'preview' | 'export', time: number): number {
  if (mode !== 'export') return time;
  const { trackBoundaries } = exportStore.getState();
  if (trackBoundaries.length === 0) return time;

  let boundary = 0;
  for (let i = trackBoundaries.length - 1; i >= 0; i--) {
    if (trackBoundaries[i] <= time) {
      boundary = trackBoundaries[i];
      break;
    }
  }
  return time - boundary;
}

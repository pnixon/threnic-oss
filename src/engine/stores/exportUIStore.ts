/**
 * exportUIStore — Zustand store for export UI state.
 *
 * Centralizes all export-related UI state that was previously scattered
 * across module-level singletons inside useExportMode.ts:
 *   - isExporting / isCancelled flags
 *   - progress tracking (frame count, FPS, ETA, snapshot previews)
 *   - export configuration (fps, codec, multi-track config)
 *   - encoder references for cancellation
 *
 * This store is vanilla (no React dependency), so it can be read from
 * both React components (via useStore) and engine code (via getState).
 */

import { createStore, useStore } from 'zustand';
import type { QualityKey, AspectKey, BitrateKey } from '@/types/exportConstants';
import { ASPECT_RATIOS, calcDimensions } from '@/types/exportConstants';
import type { MultiExportConfig } from '@/types/multi-export';
import { DEFAULT_MULTI_EXPORT_CONFIG } from '@/types/multi-export';
import type { FpsKey, CodecKey, ExportProgress } from '@/types/export';
import type { StreamableExportController } from '../export/StreamableExportController';
import type { EncoderWorkerBridge } from '../export/EncoderWorkerBridge';

// ── Store state ───────────────────────────────────────────
interface ExportUIState {
  isExporting: boolean;
  isCancelled: boolean;
  progress: ExportProgress | null;
  config: MultiExportConfig;
  selectedFps: FpsKey;
  selectedCodec: CodecKey;
  useWorker: boolean;
  /**
   * Whether the user has opted into the Threnic watermark (off by default).
   * Shared by the preview overlay and the export so they stay in sync.
   */
  watermarkEnabled: boolean;

  // Export rendering config
  exportQuality: QualityKey;
  exportAspect: AspectKey;
  exportBitrate: BitrateKey;
  selectionRange: { start: number; end: number } | null;

  // Encoder refs for cancellation (non-reactive, read via getState)
  _controller: StreamableExportController | null;
  _workerBridge: EncoderWorkerBridge | null;

  // Actions
  setConfig: (update: MultiExportConfig | ((prev: MultiExportConfig) => MultiExportConfig)) => void;
  setSelectedFps: (fps: FpsKey) => void;
  setSelectedCodec: (codec: CodecKey) => void;
  setUseWorker: (use: boolean) => void;
  setWatermarkEnabled: (enabled: boolean) => void;
  setProgress: (progress: ExportProgress | null) => void;
  setIsExporting: (exporting: boolean) => void;
  setIsCancelled: (cancelled: boolean) => void;
  setExportQuality: (quality: QualityKey) => void;
  setExportAspect: (aspect: AspectKey) => void;
  setExportBitrate: (bitrate: BitrateKey) => void;
  setSelectionRange: (range: { start: number; end: number } | null) => void;
  cancelExport: () => void;

  // Derived (computed from quality + aspect)
  previewRatio: number;
  exportWidth: number;
  exportHeight: number;
}

// ── LocalStorage persistence for global export preferences ──────────
// These are GLOBAL (per-user / per-browser) preferences, not per-song. They
// persist across reloads and track switches. Stored as a single JSON blob.
const EXPORT_PREFS_KEY = 'threnic_export_prefs';
// Legacy key (mode only) — migrated into the blob on first load.
const LEGACY_EXPORT_MODE_KEY = 'threnic_export_mode';

interface PersistedExportPrefs {
  mode?: MultiExportConfig['mode'];
  selectedFps?: FpsKey;
  selectedCodec?: CodecKey;
  exportQuality?: QualityKey;
  exportAspect?: AspectKey;
  exportBitrate?: BitrateKey;
  watermarkEnabled?: boolean;
}

function loadPersistedPrefs(): PersistedExportPrefs {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(EXPORT_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as PersistedExportPrefs;
    }
    // Migrate the legacy mode-only key if the new blob doesn't exist yet.
    const legacyMode = localStorage.getItem(LEGACY_EXPORT_MODE_KEY);
    if (legacyMode === 'single' || legacyMode === 'batch' || legacyMode === 'selection') {
      return { mode: legacyMode };
    }
  } catch {
    /* SSR / incognito / malformed */
  }
  return {};
}

function persistPrefs(patch: Partial<PersistedExportPrefs>) {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = loadPersistedPrefs();
    const next = { ...current, ...patch };
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
}

function isValidMode(m: unknown): m is MultiExportConfig['mode'] {
  return m === 'single' || m === 'batch' || m === 'selection';
}

// Loaded once at module init so store defaults reflect persisted prefs.
const persistedPrefs = loadPersistedPrefs();
const initialMode: MultiExportConfig['mode'] = isValidMode(persistedPrefs.mode)
  ? persistedPrefs.mode
  : DEFAULT_MULTI_EXPORT_CONFIG.mode;
const initialFps: FpsKey = persistedPrefs.selectedFps ?? 24;
const initialCodec: CodecKey = persistedPrefs.selectedCodec ?? 'h264';
const initialQuality: QualityKey = persistedPrefs.exportQuality ?? ('High' as QualityKey);
const initialAspect: AspectKey = persistedPrefs.exportAspect ?? ('Landscape' as AspectKey);
const initialBitrate: BitrateKey = persistedPrefs.exportBitrate ?? ('Medium' as BitrateKey);
const initialWatermark: boolean = persistedPrefs.watermarkEnabled ?? false;
const initialDims = calcDimensions(initialQuality, initialAspect);

// ── Store instance ────────────────────────────────────────
export const exportUIStore = createStore<ExportUIState>((set, get) => ({
  isExporting: false,
  isCancelled: false,
  progress: null,
  config: { ...DEFAULT_MULTI_EXPORT_CONFIG, mode: initialMode, tracks: [] },
  selectedFps: initialFps,
  selectedCodec: initialCodec,
  useWorker: true,
  watermarkEnabled: initialWatermark,
  exportQuality: initialQuality,
  exportAspect: initialAspect,
  exportBitrate: initialBitrate,
  previewRatio: ASPECT_RATIOS[initialAspect].ratio,
  exportWidth: initialDims.width,
  exportHeight: initialDims.height,
  selectionRange: null,
  _controller: null,
  _workerBridge: null,

  setConfig: (update) => {
    set((s) => {
      const next = typeof update === 'function' ? update(s.config) : update;
      persistPrefs({ mode: next.mode });
      return { config: next };
    });
  },

  setSelectedFps: (fps) => {
    persistPrefs({ selectedFps: fps });
    set({ selectedFps: fps });
  },
  setSelectedCodec: (codec) => {
    persistPrefs({ selectedCodec: codec });
    set({ selectedCodec: codec });
  },
  setUseWorker: (use) => set({ useWorker: use }),
  setWatermarkEnabled: (enabled) => {
    persistPrefs({ watermarkEnabled: enabled });
    set({ watermarkEnabled: enabled });
  },
  setProgress: (progress) => set({ progress }),
  setExportQuality: (quality) => {
    const aspect = get().exportAspect;
    const dims = calcDimensions(quality, aspect);
    persistPrefs({ exportQuality: quality });
    set({
      exportQuality: quality,
      exportWidth: dims.width,
      exportHeight: dims.height,
    });
  },
  setExportAspect: (aspect) => {
    const quality = get().exportQuality;
    const dims = calcDimensions(quality, aspect);
    persistPrefs({ exportAspect: aspect });
    set({
      exportAspect: aspect,
      previewRatio: ASPECT_RATIOS[aspect].ratio,
      exportWidth: dims.width,
      exportHeight: dims.height,
    });
  },
  setExportBitrate: (bitrate) => {
    persistPrefs({ exportBitrate: bitrate });
    set({ exportBitrate: bitrate });
  },
  setSelectionRange: (range) => set({ selectionRange: range }),
  setIsExporting: (exporting) => set({ isExporting: exporting }),
  setIsCancelled: (cancelled) => set({ isCancelled: cancelled }),

  cancelExport: () => {
    const { _workerBridge, _controller } = get();
    if (_workerBridge) _workerBridge.cancel();
    if (_controller) _controller.stop(true);
    set({ isCancelled: true });
  },
}));

// ── React selectors ───────────────────────────────────────
export function useExportUIStore(): ExportUIState;
export function useExportUIStore<T>(selector: (s: ExportUIState) => T): T;
export function useExportUIStore<T>(selector?: (s: ExportUIState) => T) {
  return useStore(exportUIStore, selector!);
}

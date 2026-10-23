/**
 * System Health Store — Tracks runtime performance metrics.
 *
 * Provides real-time monitoring of:
 * - Frame rate (FPS) with rolling average
 * - Dropped frames detection
 * - Audio context state
 * - Estimated memory usage
 *
 * Designed for the engine loop: `updateFps()` is called every frame (cheap).
 * React UI subscribes with granular selectors for the health indicator.
 */

import { createStore } from 'zustand/vanilla';
import { profiler } from '@/utils/profiler';

// Dev-only persisted flag key. Read once at store init so the toggle survives reloads.
const PROFILING_LS_KEY = 'threnic.dev.profilingEnabled';

function readInitialProfilingFlag(): boolean {
  if (process.env.NODE_ENV !== 'development' || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PROFILING_LS_KEY) === '1';
  } catch {
    return false;
  }
}

const _initialProfiling = readInitialProfilingFlag();
// Sync the profiler gate to the persisted flag at module load.
profiler.setEnabled(_initialProfiling);

// ── Types ──

type HealthStatus = 'good' | 'degraded' | 'critical';

/**
 * Which pipeline drives the live preview stage:
 * - 'webgpu'   — WebGPURenderer + RenderGraph (all effects available)
 * - 'fallback' — CenterStage (no WebGPU) or the Canvas2D software renderer;
 *                GPU effects don't render
 * - 'pending'  — still detecting / initialising
 */
export type StagePipeline = 'pending' | 'webgpu' | 'fallback';

interface SystemStoreState {
  /** Current FPS (rolling average) */
  fps: number;
  /** Number of dropped frames in the last second */
  droppedFrames: number;
  /** Audio context state */
  audioState: 'running' | 'suspended' | 'closed' | 'unknown';
  /** Overall system health */
  status: HealthStatus;
  /** Last frame timestamp (for FPS calculation) */
  _lastFrameTime: number;
  /** Frame times for rolling average */
  _frameTimes: number[];

  /** Dev-only: when true (and on localhost in a dev build), the PerfProfiler runs */
  profilingEnabled: boolean;

  /**
   * True when the WebGPU lyric renderer is live (GPU per-glyph Lyric FX path
   * active). Published by LyricsCanvas; the Inspector uses it to move lyric
   * animation from the styling panel into the Lyric FX panel.
   */
  webgpuActive: boolean;

  /** Live preview pipeline (see {@link StagePipeline}). Published by AppContent/GPUCanvas. */
  stagePipeline: StagePipeline;

  /** Call once per frame with the current timestamp */
  updateFps: (timestamp: number) => void;
  /** Update the audio context state */
  setAudioState: (state: SystemStoreState['audioState']) => void;
  /** Publish whether the WebGPU lyric renderer is live. */
  setWebgpuActive: (active: boolean) => void;
  /** Publish which pipeline drives the live preview stage. */
  setStagePipeline: (pipeline: StagePipeline) => void;
  /** Dev-only: toggle the perf profiler (also flips the PerfProfiler gate + persists) */
  setProfilingEnabled: (on: boolean) => void;
  /** Reset all metrics */
  reset: () => void;
}

// ── Constants ──

const FPS_SAMPLE_SIZE = 60; // Rolling window of 60 frames
const FPS_UPDATE_INTERVAL = 500; // Update FPS state every 500ms (not every frame)
const FPS_DEGRADED_THRESHOLD = 45;
const FPS_CRITICAL_THRESHOLD = 25;
const DROP_THRESHOLD_MS = 33; // Frame > 33ms = dropped (below 30fps)

// ── Store ──

let _lastFpsUpdate = 0;

export const systemStore = createStore<SystemStoreState>((set, get) => ({
  fps: 60,
  droppedFrames: 0,
  audioState: 'unknown',
  status: 'good',
  _lastFrameTime: 0,
  _frameTimes: [],
  profilingEnabled: _initialProfiling,
  webgpuActive: false,
  stagePipeline: 'pending',

  updateFps(timestamp: number) {
    const state = get();
    const { _lastFrameTime, _frameTimes } = state;

    if (_lastFrameTime === 0) {
      set({ _lastFrameTime: timestamp });
      return;
    }

    const delta = timestamp - _lastFrameTime;
    const newFrameTimes = [..._frameTimes, delta].slice(-FPS_SAMPLE_SIZE);

    // Only update visible state periodically to avoid store spam
    if (timestamp - _lastFpsUpdate < FPS_UPDATE_INTERVAL) {
      set({ _lastFrameTime: timestamp, _frameTimes: newFrameTimes });
      return;
    }

    _lastFpsUpdate = timestamp;

    // Calculate rolling average FPS
    const avgDelta = newFrameTimes.reduce((a, b) => a + b, 0) / newFrameTimes.length;
    const fps = avgDelta > 0 ? Math.round(1000 / avgDelta) : 60;

    // Count dropped frames in this window
    const droppedFrames = newFrameTimes.filter((t) => t > DROP_THRESHOLD_MS).length;

    // Determine health status
    let status: HealthStatus = 'good';
    if (fps < FPS_CRITICAL_THRESHOLD) {
      status = 'critical';
    } else if (fps < FPS_DEGRADED_THRESHOLD) {
      status = 'degraded';
    }

    set({
      fps,
      droppedFrames,
      status,
      _lastFrameTime: timestamp,
      _frameTimes: newFrameTimes,
    });
  },

  setAudioState(audioState) {
    set({ audioState });
  },

  setWebgpuActive(active: boolean) {
    if (get().webgpuActive !== active) set({ webgpuActive: active });
  },

  setStagePipeline(pipeline: StagePipeline) {
    if (get().stagePipeline !== pipeline) set({ stagePipeline: pipeline });
  },

  setProfilingEnabled(on: boolean) {
    // Gate hard: never allow the flag on in production builds.
    const effective = process.env.NODE_ENV === 'development' && on;
    set({ profilingEnabled: effective });
    profiler.setEnabled(effective);
    if (typeof window !== 'undefined') {
      try {
        if (effective) window.localStorage.setItem(PROFILING_LS_KEY, '1');
        else window.localStorage.removeItem(PROFILING_LS_KEY);
      } catch {
        /* localStorage unavailable — non-fatal */
      }
    }
  },

  reset() {
    _lastFpsUpdate = 0;
    set({
      fps: 60,
      droppedFrames: 0,
      audioState: 'unknown',
      status: 'good',
      _lastFrameTime: 0,
      _frameTimes: [],
    });
  },
}));

// ── Selectors ──

/** Whether the WebGPU lyric renderer is live. */
export function selectWebgpuActive(state: SystemStoreState): boolean {
  return state.webgpuActive;
}

/** Which pipeline drives the live preview stage. */
export function selectStagePipeline(state: SystemStoreState): StagePipeline {
  return state.stagePipeline;
}

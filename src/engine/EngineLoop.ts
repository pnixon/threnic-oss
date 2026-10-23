/**
 * EngineLoop - Centralized frame orchestration
 *
 * Provides a standardized way for features to hook into the render loop
 * with priority-based execution.
 */

import { timeStore } from './stores/timeStore';

type FrameCallback = (delta: number, time: number) => void;

interface HookEntry {
  callback: FrameCallback;
  priority: number;
}

/**
 * Get the appropriate delta time for the current frame
 */
export function getFrameDelta(delta: number): number {
  const state = timeStore.getState();
  if (state.mode === 'export') {
    return 1 / state.exportFps;
  }
  return delta;
}

/**
 * Register a frame update callback
 */
export function registerFrameUpdate(
  callback: (delta: number, time: number) => void,
  priority = 0,
): () => void {
  return EngineLoop.register(callback, priority);
}

/**
 * Call all registered frame update callbacks in priority order
 */
export function runFrameUpdates(): void {
  const { currentTime, mode, exportFps } = timeStore.getState();
  const delta = mode === 'export' ? 1 / exportFps : 0.016; // rough estimate for compat
  EngineLoop.run(delta, currentTime);
}

class EngineLoopManager {
  private hooks: HookEntry[] = [];
  private isSorted = true;

  /**
   * Register a callback to run every frame
   * @param callback - The function to call
   * @param priority - Higher runs first (e.g., 100=Keyframes, 50=Audio, 0=Rendering)
   * @returns Unregister function
   */
  register(callback: FrameCallback, priority = 0): () => void {
    this.hooks.push({ callback, priority });
    this.isSorted = false;

    return () => {
      this.hooks = this.hooks.filter((h) => h.callback !== callback);
    };
  }

  /**
   * Run all registered hooks
   * @param delta - Time since last frame
   * @param time - Current master time
   */
  run(delta: number, time: number): void {
    if (!this.isSorted) {
      this.hooks.sort((a, b) => b.priority - a.priority);
      this.isSorted = true;
    }

    for (let i = 0; i < this.hooks.length; i++) {
      this.hooks[i].callback(delta, time);
    }
  }

  /**
   * Get count of registered hooks (for leak detection)
   */
  getHookCount(): number {
    return this.hooks.length;
  }

  /**
   * Clear all hooks
   */
  clear(): void {
    this.hooks = [];
  }
}

export const EngineLoop = new EngineLoopManager();

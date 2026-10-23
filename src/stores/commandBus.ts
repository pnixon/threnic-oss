/**
 * CommandBus — Centralized command dispatch with undo/redo.
 *
 * All property mutations should flow through this bus, enabling:
 * 1. Full undo/redo history for creative editing
 * 2. Action journaling for debugging
 * 3. Future collaboration readiness (commands can be serialized/replayed)
 *
 * Architecture:
 *   UI → dispatch(command) → execute → projectStore mutation
 *   undo() → pop history → apply inverse
 *   redo() → pop future → re-apply
 */

import { createStore } from 'zustand/vanilla';
import { projectStore } from '@/stores/projectStore';
import { createLogger } from '@/utils/logger';
import type { Keyframe } from '@/types/keyframes';

const logger = createLogger({ enabled: true, prefix: 'CommandBus' });

// ── Command Types ────────────────────────────────────────────────────

type CommandType =
  | 'UPDATE_TRACK_PROPERTY'
  | 'UPDATE_EFFECT_INSTANCE'
  | 'ADD_KEYFRAME'
  | 'REMOVE_KEYFRAME'
  | 'UPDATE_KEYFRAMES';

interface Command {
  type: CommandType;
  /** Human-readable description for the action log */
  label: string;
  /** Execute the command (forward) */
  execute: () => void;
  /** Undo the command (inverse) */
  undo: () => void;
  /** Timestamp of execution */
  timestamp?: number;
}

// ── Command Bus State ────────────────────────────────────────────────

const MAX_HISTORY = 100;

interface CommandBusState {
  /** Past commands (most recent last) */
  history: Command[];
  /** Undone commands available for redo */
  future: Command[];
  /** Whether undo is available */
  canUndo: boolean;
  /** Whether redo is available */
  canRedo: boolean;
  /** Last action label (for UI display) */
  lastAction: string | null;

  // Actions
  dispatch: (command: Command) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
}

export const commandBusStore = createStore<CommandBusState>((set, get) => ({
  history: [],
  future: [],
  canUndo: false,
  canRedo: false,
  lastAction: null,

  dispatch: (command: Command) => {
    try {
      command.execute();
      command.timestamp = Date.now();

      set((state) => {
        const newHistory = [...state.history, command];
        // Trim history if it exceeds max
        if (newHistory.length > MAX_HISTORY) {
          newHistory.shift();
        }
        return {
          history: newHistory,
          future: [], // New action invalidates redo stack
          canUndo: true,
          canRedo: false,
          lastAction: command.label,
        };
      });

      logger.debug(`Dispatched: ${command.label}`);
    } catch (error) {
      logger.error(`Command failed: ${command.label}`, error as Error);
      throw error;
    }
  },

  undo: () => {
    const { history } = get();
    if (history.length === 0) return;

    const command = history[history.length - 1];
    try {
      command.undo();

      set((state) => {
        const newHistory = state.history.slice(0, -1);
        return {
          history: newHistory,
          future: [command, ...state.future],
          canUndo: newHistory.length > 0,
          canRedo: true,
          lastAction: `Undo: ${command.label}`,
        };
      });

      logger.debug(`Undo: ${command.label}`);
    } catch (error) {
      logger.error(`Undo failed: ${command.label}`, error as Error);
    }
  },

  redo: () => {
    const { future } = get();
    if (future.length === 0) return;

    const command = future[0];
    try {
      command.execute();

      set((state) => {
        const newFuture = state.future.slice(1);
        return {
          history: [...state.history, command],
          future: newFuture,
          canUndo: true,
          canRedo: newFuture.length > 0,
          lastAction: `Redo: ${command.label}`,
        };
      });

      logger.debug(`Redo: ${command.label}`);
    } catch (error) {
      logger.error(`Redo failed: ${command.label}`, error as Error);
    }
  },

  clear: () => {
    set({ history: [], future: [], canUndo: false, canRedo: false, lastAction: null });
  },
}));

// ── Command Factories ────────────────────────────────────────────────

/**
 * Create a command for updating a track property (keyframe-aware).
 */
export function createUpdatePropertyCommand(
  trackId: string,
  propertyPath: string,
  newValue: unknown,
  previousValue: unknown,
  keyframeId?: string,
): Command {
  return {
    type: 'UPDATE_TRACK_PROPERTY',
    label: `Set ${propertyPath}`,
    execute: () => {
      projectStore.getState().updateTrackProperty(trackId, propertyPath, newValue, keyframeId);
    },
    undo: () => {
      projectStore.getState().updateTrackProperty(trackId, propertyPath, previousValue, keyframeId);
    },
  };
}

/**
 * Create a command for updating an effect instance.
 */
export function createUpdateEffectInstanceCommand(
  trackId: string,
  instanceId: string,
  newConfig: unknown,
  previousConfig: unknown,
  keyframeId?: string,
): Command {
  return {
    type: 'UPDATE_EFFECT_INSTANCE',
    label: `Update effect ${instanceId.slice(0, 12)}`,
    execute: () => {
      projectStore.getState().updateTrackEffectInstance(trackId, instanceId, newConfig, keyframeId);
    },
    undo: () => {
      projectStore
        .getState()
        .updateTrackEffectInstance(trackId, instanceId, previousConfig, keyframeId);
    },
  };
}

/**
 * Create a command for replacing a track's full keyframe array (undoable).
 */
export function createUpdateKeyframesCommand(
  trackId: string,
  newKeyframes: Keyframe[],
  previousKeyframes: Keyframe[],
): Command {
  return {
    type: 'UPDATE_KEYFRAMES',
    label: `Update keyframes`,
    execute: () => {
      projectStore.getState().updateTrackKeyframes(trackId, newKeyframes);
    },
    undo: () => {
      projectStore.getState().updateTrackKeyframes(trackId, previousKeyframes);
    },
  };
}

/**
 * Create a command for adding a keyframe.
 */
export function createAddKeyframeCommand(trackId: string, keyframe: Keyframe): Command {
  return {
    type: 'ADD_KEYFRAME',
    label: `Add keyframe at ${keyframe.time?.toFixed(2)}s`,
    execute: () => {
      projectStore.getState().addTrackKeyframe(trackId, keyframe);
    },
    undo: () => {
      projectStore.getState().removeTrackKeyframe(trackId, keyframe.id);
    },
  };
}

/**
 * Create a command for removing a keyframe.
 */
export function createRemoveKeyframeCommand(trackId: string, keyframe: Keyframe): Command {
  return {
    type: 'REMOVE_KEYFRAME',
    label: `Remove keyframe at ${keyframe.time?.toFixed(2)}s`,
    execute: () => {
      projectStore.getState().removeTrackKeyframe(trackId, keyframe.id);
    },
    undo: () => {
      projectStore.getState().addTrackKeyframe(trackId, keyframe);
    },
  };
}

/**
 * useCommandBus — React hooks for the command bus.
 *
 * Provides keyboard shortcut integration for undo/redo.
 */

'use client';

import { useEffect } from 'react';
import { commandBusStore } from '@/stores/commandBus';

/**
 * Registers Ctrl+Z / Ctrl+Shift+Z keyboard shortcuts for undo/redo.
 * Mount this once near the app root.
 */
export function useUndoRedoShortcuts() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't intercept when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const isCtrl = e.ctrlKey || e.metaKey;
      if (!isCtrl) return;

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        commandBusStore.getState().undo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        commandBusStore.getState().redo();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}

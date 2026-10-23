import { useEffect, useCallback } from 'react';

interface KeyboardShortcutsConfig {
  onPlayPause: () => void;
  onSeekBackward: (seconds: number) => void;
  onSeekForward: (seconds: number) => void;
  onPreviousKeyframe?: () => void;
  onNextKeyframe?: () => void;
  onPreviousTrack?: () => void;
  onNextTrack?: () => void;
  disabled?: boolean;
}

/**
 * Global keyboard shortcuts hook
 *
 * Provides app-wide keyboard shortcuts for audio control.
 * Automatically disabled when typing in inputs/textareas.
 */
export function useGlobalKeyboardShortcuts({
  onPlayPause,
  onSeekBackward,
  onSeekForward,
  onPreviousTrack,
  onNextTrack,
  onPreviousKeyframe,
  onNextKeyframe,
  disabled = false,
}: KeyboardShortcutsConfig) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;

      const target = e.target as HTMLElement;

      // 1. Allow typing in text inputs
      const isTextInput =
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        (target.tagName === 'INPUT' &&
          [
            'text',
            'password',
            'number',
            'email',
            'search',
            'tel',
            'url',
            'date',
            'datetime-local',
          ].includes((target as HTMLInputElement).type));

      if (isTextInput) return;

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

      // 2. Space gets priority regarding prevention (stops button/checkbox toggles)
      if ((e.code === 'Space' || e.key === ' ' || e.keyCode === 32) && !ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        onPlayPause();
        return;
      }

      // 3. Allow sliders to use arrow keys
      const isSlider = target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'range';
      if (isSlider && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        return;
      }

      // Handle Ctrl+Arrow for track navigation
      if (ctrlKey && e.code === 'ArrowLeft' && onPreviousTrack) {
        e.preventDefault();
        onPreviousTrack();
        return;
      }

      if (ctrlKey && e.code === 'ArrowRight' && onNextTrack) {
        e.preventDefault();
        onNextTrack();
        return;
      }

      // Handle regular shortcuts without Ctrl
      if (ctrlKey) return;

      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        onSeekBackward(5);
        return;
      }

      if (e.code === 'ArrowRight') {
        e.preventDefault();
        onSeekForward(5);
        return;
      }

      if (e.key === '[' && onPreviousKeyframe) {
        e.preventDefault();
        onPreviousKeyframe();
        return;
      }

      if (e.key === ']' && onNextKeyframe) {
        e.preventDefault();
        onNextKeyframe();
        return;
      }
    },
    [
      disabled,
      onPlayPause,
      onSeekBackward,
      onSeekForward,
      onPreviousTrack,
      onNextTrack,
      onPreviousKeyframe,
      onNextKeyframe,
    ],
  );

  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;

      const target = e.target as HTMLElement;
      const isTextInput =
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        (target.tagName === 'INPUT' &&
          [
            'text',
            'password',
            'number',
            'email',
            'search',
            'tel',
            'url',
            'date',
            'datetime-local',
          ].includes((target as HTMLInputElement).type));

      if (isTextInput) return;

      // Prevent keyup default for space to ensure no late firing "click" events
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

      if ((e.code === 'Space' || e.key === ' ' || e.keyCode === 32) && !ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    },
    [disabled],
  );

  useEffect(() => {
    // Phase 1 (Capture): Intercept events before they hit the target element
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [handleKeyDown, handleKeyUp]);
}

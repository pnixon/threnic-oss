import { renderHook, act } from '@testing-library/react';
import { usePlaybackManager } from '@/hooks/usePlaybackManager';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock stores
vi.mock('@/engine/stores/timeStore', () => ({
  timeStore: {
    getState: vi.fn().mockReturnValue({
      currentTime: 0,
      mode: 'preview',
      setCurrentTime: vi.fn(),
      setIsPlaying: vi.fn(),
      setDuration: vi.fn(),
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('@/engine/stores/exportStore', () => ({
  getRelativeTrackTime: vi.fn(() => 0),
}));

import type { Track } from '@/contexts/types';

describe('usePlaybackManager', () => {
  const defaultProps = {
    audioUrl: 'test.mp3',
    duration: 100,
    setDur: vi.fn(),
    setTime: vi.fn(),
    isPlaying: false,
    setPlaying: vi.fn(),
    isExporting: false,
    audioPlayerRef: {
      current: { pause: vi.fn(), currentTime: 0 },
    } as unknown as React.RefObject<HTMLAudioElement | null>,
    gapTimeoutRef: { current: null } as unknown as React.RefObject<NodeJS.Timeout | null>,
    selectedTrackId: '1',
    tracks: [{ id: '1' }, { id: '2' }] as Track[],
    settings: { autoNext: true },
    selectNextTrack: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles play/pause', () => {
    const { result } = renderHook(() => usePlaybackManager(defaultProps));

    act(() => {
      result.current.handlePlayPause();
    });

    expect(defaultProps.setPlaying).toHaveBeenCalledWith(true);
  });

  it('handles seek', async () => {
    const { result } = renderHook(() => usePlaybackManager(defaultProps));

    act(() => {
      result.current.handleSeek(50);
    });

    expect(defaultProps.setTime).toHaveBeenCalledWith(50);
    const { timeStore } = await import('@/engine/stores/timeStore');
    expect(timeStore.getState().setCurrentTime).toHaveBeenCalledWith(50, true);
  });

  it('handles ended by selecting next track if autoNext is true', () => {
    const { result } = renderHook(() => usePlaybackManager(defaultProps));

    act(() => {
      result.current.handleEnded();
    });

    expect(defaultProps.selectNextTrack).toHaveBeenCalled();
  });

  it('stops playback if ended on last track', () => {
    const props = {
      ...defaultProps,
      selectedTrackId: '2',
    };
    const { result } = renderHook(() => usePlaybackManager(props));

    act(() => {
      result.current.handleEnded();
    });

    expect(props.setPlaying).toHaveBeenCalledWith(false);
  });

  it('does NOT switch to next track on time update (relies on native ended event)', () => {
    const props = { ...defaultProps, isPlaying: true };
    const { result } = renderHook(() => usePlaybackManager(props));

    act(() => {
      // Simulate time reaching near end
      result.current.handleTimeUpdate(99.9);
    });

    expect(props.selectNextTrack).not.toHaveBeenCalled();
  });

  it('handles time update and stops at end of last track', () => {
    const props = {
      ...defaultProps,
      isPlaying: true,
      selectedTrackId: '2',
    };
    const { result } = renderHook(() => usePlaybackManager(props));

    act(() => {
      result.current.handleTimeUpdate(99.9);
    });

    expect(props.setPlaying).toHaveBeenCalledWith(false);
  });

  it('updates current time on normal time update', async () => {
    const { result } = renderHook(() => usePlaybackManager(defaultProps));

    act(() => {
      result.current.handleTimeUpdate(50);
    });

    const { timeStore } = await import('@/engine/stores/timeStore');
    expect(timeStore.getState().setCurrentTime).toHaveBeenCalledWith(50);
    // setTime should NOT be called anymore to prevent re-renders
    expect(defaultProps.setTime).not.toHaveBeenCalled();
  });
});

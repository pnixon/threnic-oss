import { renderHook, act } from '@testing-library/react';
import { PlaylistProvider, usePlaylist } from '@/contexts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { projectStore, resetSwitchCooldownForTesting } from '@/stores/projectStore';

// Mock utils
vi.mock('@/contexts/utils', () => ({
  generateTrackId: vi.fn(() => `track_${Math.random()}`),
  getTrackNameFromFile: vi.fn((file: any) => file.name),
  getAudioDuration: vi.fn(() => Promise.resolve(100)),
  getAudioBuffer: vi.fn(),
  revokeBlobUrl: vi.fn(),
  shuffleArray: vi.fn((arr) => arr),
}));

describe('PlaylistContext Cooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    resetSwitchCooldownForTesting();
    vi.clearAllMocks();
    projectStore.setState({
      tracks: [],
      selectedTrackId: null,
      isLoading: false,
      settings: { autoNext: true },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PlaylistProvider>{children}</PlaylistProvider>
  );

  it('prevents rapid track switching within 1 second', async () => {
    const { result } = renderHook(() => usePlaylist(), { wrapper });

    // Add some tracks first
    await act(async () => {
      await result.current.addTrackFromUrl('test1.mp3', 'Track 1');
      await result.current.addTrackFromUrl('test2.mp3', 'Track 2');
      await result.current.addTrackFromUrl('test3.mp3', 'Track 3');
    });

    // Capture IDs
    const track1Id = result.current.tracks[0].id;
    const track2Id = result.current.tracks[1].id;
    const track3Id = result.current.tracks[2].id;

    // Initial selection is track 1
    expect(result.current.selectedTrackId).toBe(track1Id);

    // Switch to track 2
    act(() => {
      result.current.selectTrack(track2Id);
    });
    expect(result.current.selectedTrackId).toBe(track2Id);

    // Immediately try to switch to track 3 (within 1s)
    act(() => {
      result.current.selectTrack(track3Id);
    });
    // Should still be track 2 because of cooldown
    expect(result.current.selectedTrackId).toBe(track2Id);

    // Wait exactly 1 second
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Now try to switch to track 3 again
    act(() => {
      result.current.selectTrack(track3Id);
    });
    expect(result.current.selectedTrackId).toBe(track3Id);
  });

  it('allows switching if same track is selected (it does not trigger cooldown)', async () => {
    const { result } = renderHook(() => usePlaylist(), { wrapper });

    await act(async () => {
      await result.current.addTrackFromUrl('test1.mp3', 'Track 1');
      await result.current.addTrackFromUrl('test2.mp3', 'Track 2');
    });

    const track1Id = result.current.tracks[0].id;
    const track2Id = result.current.tracks[1].id;

    expect(result.current.selectedTrackId).toBe(track1Id);

    // Select same track - should not trigger cooldown because of the guard
    act(() => {
      result.current.selectTrack(track1Id);
    });

    // Switch to track 2 - should work immediately
    resetSwitchCooldownForTesting();
    act(() => {
      result.current.selectTrack(track2Id);
    });
    expect(result.current.selectedTrackId).toBe(track2Id);
  });

  it('applies cooldown to selectNextTrack and selectPreviousTrack', async () => {
    const { result } = renderHook(() => usePlaylist(), { wrapper });

    await act(async () => {
      await result.current.addTrackFromUrl('test1.mp3', 'Track 1');
      await result.current.addTrackFromUrl('test2.mp3', 'Track 2');
      await result.current.addTrackFromUrl('test3.mp3', 'Track 3');
    });

    const track1Id = result.current.tracks[0].id;
    const track2Id = result.current.tracks[1].id;
    const track3Id = result.current.tracks[2].id;

    expect(result.current.selectedTrackId).toBe(track1Id);

    // selectNextTrack
    resetSwitchCooldownForTesting();
    act(() => {
      result.current.selectNextTrack();
    });
    expect(result.current.selectedTrackId).toBe(track2Id);

    // Immediately try next again
    act(() => {
      result.current.selectNextTrack();
    });
    expect(result.current.selectedTrackId).toBe(track2Id); // Blocked

    // Wait >1s
    resetSwitchCooldownForTesting();

    // Now try previous
    act(() => {
      result.current.selectPreviousTrack();
    });
    expect(result.current.selectedTrackId).toBe(track1Id);

    // Immediately try previous again
    act(() => {
      result.current.selectPreviousTrack();
    });
    expect(result.current.selectedTrackId).toBe(track1Id); // Blocked
  });
});

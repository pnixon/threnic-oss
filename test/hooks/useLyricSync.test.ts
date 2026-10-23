import { renderHook, act } from '@testing-library/react';
import { useLyricSync } from '@/components/lyrics-sync/useLyricSync';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ThrenicWord } from '@/types/lyrics';

describe('useLyricSync', () => {
  let audioRef: any;
  let initialWords: ThrenicWord[];

  beforeEach(() => {
    audioRef = {
      current: {
        currentTime: 0,
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    };

    initialWords = [
      {
        text: 'Hello',
        isLineStart: true,
        startTime: 0,
        endTime: 0,
        rawWord: 'Hello',
        renderText: 'Hello',
      },
      {
        text: 'World',
        isLineStart: false,
        startTime: 0,
        endTime: 0,
        rawWord: 'World',
        renderText: 'World',
      },
      { text: '!', isLineStart: false, startTime: 0, endTime: 0, rawWord: '!', renderText: '!' },
    ];
  });

  it('starts sync and sets playing state', async () => {
    const { result } = renderHook(() => useLyricSync(initialWords, audioRef));

    act(() => {
      result.current.startSync();
    });

    expect(result.current.isSyncing).toBe(true);
    expect(audioRef.current.play).toHaveBeenCalled();
  });

  it('registers a hit, updates timing, and advances index', () => {
    const { result } = renderHook(() =>
      useLyricSync(initialWords, audioRef, { latencyCompensation: 0 }),
    );

    act(() => {
      result.current.startSync();
    });

    audioRef.current.currentTime = 1.0;

    act(() => {
      result.current.registerHit('WORD');
    });

    expect(result.current.words[0].startTime).toBe(1.0);
    expect(result.current.words[0].isLineStart).toBe(true);
    expect(result.current.currentIndex).toBe(1);
    expect(result.current.canUndo).toBe(true);
  });

  it('registers a LINE hit', () => {
    const { result } = renderHook(() =>
      useLyricSync(initialWords, audioRef, { latencyCompensation: 0 }),
    );

    act(() => {
      result.current.startSync();
    });

    audioRef.current.currentTime = 1.0;

    act(() => {
      result.current.registerHit('LINE');
    });

    expect(result.current.words[0].isLineStart).toBe(true);
  });

  it('undoes a hit', () => {
    const { result } = renderHook(() =>
      useLyricSync(initialWords, audioRef, { latencyCompensation: 0 }),
    );

    act(() => {
      result.current.startSync();
    });

    audioRef.current.currentTime = 1.0;
    act(() => {
      result.current.registerHit('WORD');
    });

    expect(result.current.currentIndex).toBe(1);

    act(() => {
      result.current.undo();
    });

    expect(result.current.words[0].startTime).toBe(0);
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.canUndo).toBe(false);
  });

  it('stops sync and auto-completes the last word', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useLyricSync(initialWords, audioRef, { latencyCompensation: 0, onComplete }),
    );

    act(() => {
      result.current.startSync();
    });

    act(() => {
      audioRef.current.currentTime = 1.0;
      result.current.registerHit('WORD');
    });
    act(() => {
      audioRef.current.currentTime = 2.0;
      result.current.registerHit('WORD');
    });
    act(() => {
      audioRef.current.currentTime = 3.0;
      result.current.registerHit('WORD');
    });

    // Should auto-complete and call onComplete
    expect(result.current.words[0].endTime).toBe(2.0); // Ends at hit of 2nd word
    expect(result.current.words[1].endTime).toBe(3.0);
    expect(result.current.words[2].endTime).toBe(4.0); // 3.0 + 1.0s max padding

    // Sync stays active until user explicitly finalizes
    expect(result.current.isSyncing).toBe(true);
    expect(result.current.isComplete).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();

    // User finalizes
    act(() => {
      result.current.finalizeSync();
    });

    expect(result.current.isSyncing).toBe(false);
    expect(onComplete).toHaveBeenCalled();
  });

  it('can reset sync', () => {
    const { result } = renderHook(() =>
      useLyricSync(initialWords, audioRef, { latencyCompensation: 0 }),
    );

    act(() => {
      result.current.startSync();
    });

    act(() => {
      audioRef.current.currentTime = 1.0;
      result.current.registerHit('WORD');
    });

    expect(result.current.currentIndex).toBe(1);

    act(() => {
      result.current.resetSync();
    });

    expect(result.current.currentIndex).toBe(0);
    expect(result.current.words[0].startTime).toBe(0);
    expect(result.current.canUndo).toBe(false);
  });

  it('applies latency compensation correctly', () => {
    const { result } = renderHook(() =>
      useLyricSync(initialWords, audioRef, { latencyCompensation: 0.15 }),
    );

    act(() => {
      result.current.startSync();
    });

    audioRef.current.currentTime = 1.0;

    act(() => {
      result.current.registerHit('WORD');
    });

    expect(result.current.words[0].startTime).toBe(0.85); // 1.0 - 0.15
  });
});

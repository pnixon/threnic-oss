import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExportModal, type ExportProgress } from './ExportModal';

// ---------------------------------------------------------------------------
// ExportModal — running elapsed-time counter
//
// The modal shows a wall-clock "Elapsed" readout that ticks once per second
// while an export is in flight and freezes on the total once the phase becomes
// terminal (done/error). It is anchored to the first render with an open modal
// and reset when the modal closes. These tests drive performance.now() + the
// interval with fake timers and assert the rendered mm:ss text.
// ---------------------------------------------------------------------------

function makeProgress(overrides: Partial<ExportProgress> = {}): ExportProgress {
  return {
    currentFrame: 100,
    totalFrames: 1000,
    currentTime: 1,
    totalDuration: 10,
    percentage: 10,
    ...overrides,
  };
}

/** The modal renders into document.body via createPortal. Returns the elapsed
 *  time text without the leading ⏱ icon glyph. */
function elapsedText(): string | null {
  const el = document.body.querySelector('[data-testid="export-elapsed"]');
  if (!el) return null;
  return (el.textContent ?? '').replace('⏱', '').trim();
}

describe('ExportModal elapsed counter', () => {
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    document.body.innerHTML = '';
  });

  /** Advance both the mocked wall clock and the fake interval timers. */
  function advance(seconds: number) {
    act(() => {
      nowMs += seconds * 1000;
      vi.advanceTimersByTime(seconds * 1000);
    });
  }

  it('starts at 00:00 when the export opens', () => {
    render(
      <ExportModal
        isOpen
        progress={makeProgress({ phase: 'rendering' })}
        onCancel={() => {}}
        height={2160}
        fps={60}
      />,
    );
    expect(elapsedText()).toBe('Elapsed: 00:00');
  });

  it('ticks up once per second while rendering', () => {
    render(
      <ExportModal
        isOpen
        progress={makeProgress({ phase: 'rendering' })}
        onCancel={() => {}}
        height={1080}
        fps={60}
      />,
    );
    advance(5);
    expect(elapsedText()).toBe('Elapsed: 00:05');
    advance(60);
    expect(elapsedText()).toBe('Elapsed: 01:05');
  });

  it('freezes at the total once the phase is done', () => {
    const { rerender } = render(
      <ExportModal
        isOpen
        progress={makeProgress({ phase: 'rendering' })}
        onCancel={() => {}}
        height={1080}
        fps={60}
      />,
    );
    advance(42);
    expect(elapsedText()).toBe('Elapsed: 00:42');

    // Export finishes — phase flips to done.
    act(() => {
      rerender(
        <ExportModal
          isOpen
          progress={makeProgress({ phase: 'done', percentage: 100 })}
          onCancel={() => {}}
          height={1080}
          fps={60}
        />,
      );
    });
    expect(elapsedText()).toBe('Elapsed: 00:42');

    // Further wall-clock time does NOT advance the frozen total.
    advance(30);
    expect(elapsedText()).toBe('Elapsed: 00:42');
  });

  it('resets back to 00:00 after a close and reopen', () => {
    const props = {
      onCancel: () => {},
      height: 1080,
      fps: 60,
    };
    const { rerender } = render(
      <ExportModal isOpen progress={makeProgress({ phase: 'rendering' })} {...props} />,
    );
    advance(10);
    expect(elapsedText()).toBe('Elapsed: 00:10');

    // Close the modal.
    act(() => {
      rerender(<ExportModal isOpen={false} progress={null} {...props} />);
    });
    expect(elapsedText()).toBeNull();

    // Reopen for a fresh export — counter restarts from zero.
    act(() => {
      nowMs += 100_000; // wall clock moved on while closed
      rerender(<ExportModal isOpen progress={makeProgress({ phase: 'rendering' })} {...props} />);
    });
    expect(elapsedText()).toBe('Elapsed: 00:00');
  });
});

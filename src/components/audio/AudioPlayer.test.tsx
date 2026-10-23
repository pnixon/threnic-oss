import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AudioPlayer from './AudioPlayer';

// ---------------------------------------------------------------------------
// Mock Web Audio API
// ---------------------------------------------------------------------------
class MockGainNode {
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  context: MockAudioContext | null = null;
}

class MockAnalyserNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  smoothingTimeConstant = 0.7;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteFrequencyData = vi.fn();
  getByteTimeDomainData = vi.fn();
  context: MockAudioContext | null = null;
}

class MockMediaElementSourceNode {
  connect = vi.fn();
  disconnect = vi.fn();
  context: MockAudioContext | null = null;
}

class MockAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  _gainNode = new MockGainNode();
  _analyserNode = new MockAnalyserNode();
  _sourceNode = new MockMediaElementSourceNode();

  createAnalyser = vi.fn(() => {
    this._analyserNode.context = this;
    return this._analyserNode;
  });
  createGain = vi.fn(() => {
    this._gainNode.context = this;
    return this._gainNode;
  });
  createMediaElementSource = vi.fn(() => {
    this._sourceNode.context = this;
    return this._sourceNode;
  });
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  decodeAudioData = vi.fn().mockResolvedValue({
    duration: 100,
    sampleRate: 44100,
    numberOfChannels: 2,
    getChannelData: () => new Float32Array(1024),
  });
}

global.AudioContext = MockAudioContext as unknown as typeof AudioContext;
global.window.AudioContext = MockAudioContext as unknown as typeof AudioContext;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the underlying <audio> element rendered by AudioPlayer */
const getAudioElement = () => document.getElementById('main-audio-engine') as HTMLAudioElement;

/**
 * Simulate the browser firing the native 'seeking' and 'seeked' events that
 * occur when audio.currentTime is assigned.
 *
 * JSDOM does not automatically fire these, so we dispatch them manually to
 * test the isSeekingRef gating logic.
 */
const fireSeekingEvent = (el: HTMLAudioElement) => {
  el.dispatchEvent(new Event('seeking'));
};
const fireSeekedEvent = (el: HTMLAudioElement) => {
  el.dispatchEvent(new Event('seeked'));
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AudioPlayer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();

    global.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── THE CORE BUG: seek-while-playing silently kills audio ───────────────

  it('defers play() until after the browser "seeked" event when play is pressed during a seek', async () => {
    // Start paused
    const { rerender } = render(<AudioPlayer src="test.mp3" isPlaying={false} />);
    const audioEl = getAudioElement();
    const play = HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;
    play.mockClear();

    // Step 1: Simulate the user seeking to time=60 while still paused.
    // In a real browser, setting currentTime fires 'seeking' synchronously.
    // We fire it manually here before any rerender so that isSeekingRef=true
    // when the play/pause effect runs.
    await act(async () => {
      fireSeekingEvent(audioEl);
      rerender(<AudioPlayer src="test.mp3" isPlaying={false} />);
    });

    // Step 2: User presses play → isPlaying flips true → play/pause effect fires.
    // The effect sees isSeekingRef=true and registers a 'seeked' listener.
    await act(async () => {
      rerender(<AudioPlayer src="test.mp3" isPlaying={true} />);
    });

    // play() must NOT have been called yet (we're mid-seek)
    expect(play).not.toHaveBeenCalled();

    // Step 3: Browser finishes seeking → 'seeked' fires → deferred play() runs
    await act(async () => {
      fireSeekedEvent(audioEl);
    });

    // Now play() should have been called (at least once via the deferred handler,
    // and possibly again via the seek-recovery effect — both are correct)
    expect(play).toHaveBeenCalled();
  });

  it('does NOT call play() after seek if the user paused before seeked fires', async () => {
    const { rerender } = render(<AudioPlayer src="test.mp3" isPlaying={true} />);
    const audioEl = getAudioElement();
    const play = HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;
    play.mockClear();

    Object.defineProperty(audioEl, 'currentTime', { value: 20, writable: true });

    await act(async () => {
      // Seek to 50 while playing
      rerender(<AudioPlayer src="test.mp3" isPlaying={true} />);
      fireSeekingEvent(audioEl);
    });

    await act(async () => {
      // User pauses BEFORE the seeked event fires
      rerender(<AudioPlayer src="test.mp3" isPlaying={false} />);
    });

    const callsBeforeSeeked = play.mock.calls.length;

    await act(async () => {
      // seeked finally fires — but we're paused, so play must NOT be called
      fireSeekedEvent(audioEl);
    });

    expect(play.mock.calls.length).toBe(callsBeforeSeeked);
  });

  // ── Stale-closure: pause setTimeout fires after resume ──────────────────

  it('does NOT pause the audio if the user resumes before the fade-out timer expires', async () => {
    const { rerender } = render(<AudioPlayer src="test.mp3" isPlaying={true} />);

    // Pause → triggers 50ms fade-out + setTimeout calling pause()
    await act(async () => {
      rerender(<AudioPlayer src="test.mp3" isPlaying={false} />);
    });

    const pauseFn = HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>;
    pauseFn.mockClear();

    // User resumes BEFORE 50ms elapses
    await act(async () => {
      rerender(<AudioPlayer src="test.mp3" isPlaying={true} />);
    });

    // Let the 50ms setTimeout fire
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // pause() should NOT have been called by the stale timeout
    expect(pauseFn).not.toHaveBeenCalled();
  });

  // ── play() is called when src is present and isPlaying flips true ────────

  it('calls play() when isPlaying transitions from false to true', async () => {
    const { rerender } = render(<AudioPlayer src="test.mp3" isPlaying={false} />);
    const play = HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;
    play.mockClear();

    await act(async () => {
      rerender(<AudioPlayer src="test.mp3" isPlaying={true} />);
    });

    expect(play).toHaveBeenCalledTimes(1);
  });

  it('calls pause() when isPlaying transitions from true to false (no gain node)', async () => {
    const { rerender } = render(<AudioPlayer src="test.mp3" isPlaying={true} />);
    const pauseFn = HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>;
    pauseFn.mockClear();

    await act(async () => {
      rerender(<AudioPlayer src="test.mp3" isPlaying={false} />);
      // advance past the fade timeout
      vi.advanceTimersByTime(100);
    });

    // pause() may be called immediately (no gain node path) or after timeout
    // Either way it must eventually be called
    expect(pauseFn).toHaveBeenCalled();
  });

  // ── No src: play() must not be called ───────────────────────────────────

  it('does NOT attempt to play when src is undefined even if isPlaying=true', async () => {
    render(<AudioPlayer isPlaying={true} />);
    const play = HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;

    // No src → play should not have been called
    expect(play).not.toHaveBeenCalled();
  });

  // ── REGRESSION: stale seek flag blocks playing a newly-added song ────────
  // A no-op seek (currentTime set to its current value on a fresh element) can
  // fire 'seeking' with no matching 'seeked', leaving isSeekingRef stuck true.
  // Every subsequent play then defers forever until the page is refreshed.

  it('plays despite a stuck seeking flag when the element reports it is not actually seeking', async () => {
    const { rerender } = render(<AudioPlayer src="test.mp3" isPlaying={false} />);
    const audioEl = getAudioElement();
    const play = HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;

    // The browser is ready and NOT actually seeking...
    Object.defineProperty(audioEl, 'seeking', { value: false, configurable: true });
    Object.defineProperty(audioEl, 'readyState', { value: 4, configurable: true });

    // ...but a prior 'seeking' with no 'seeked' left the internal flag stuck true.
    await act(async () => {
      fireSeekingEvent(audioEl);
    });

    play.mockClear();

    // User presses play. Even though the internal flag is stale-true, the guard
    // trusts audio.seeking=false + readyState>=2 and plays immediately.
    await act(async () => {
      rerender(<AudioPlayer src="test.mp3" isPlaying={true} />);
    });

    expect(play).toHaveBeenCalled();
  });

  it('recovers play() via the timeout safety net if seeked never fires', async () => {
    const { rerender } = render(<AudioPlayer src="test.mp3" isPlaying={false} />);
    const audioEl = getAudioElement();
    const play = HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;

    // Genuinely mid-seek (audio.seeking=true) so the fast guard does NOT fire —
    // we must fall through to the deferred listener + timeout path.
    Object.defineProperty(audioEl, 'seeking', { value: true, configurable: true });
    Object.defineProperty(audioEl, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(audioEl, 'paused', { value: true, configurable: true });

    await act(async () => {
      fireSeekingEvent(audioEl);
    });

    play.mockClear();

    // Press play → defers, arming the 300ms safety net.
    await act(async () => {
      rerender(<AudioPlayer src="test.mp3" isPlaying={true} />);
    });
    expect(play).not.toHaveBeenCalled();

    // 'seeked' never fires. The safety net fires after the grace window.
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    expect(play).toHaveBeenCalled();
  });
});

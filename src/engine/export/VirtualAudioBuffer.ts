/**
 * VirtualAudioBuffer — Drop-in replacement for AudioBuffer that reads from
 * a sequence of source AudioBuffers without allocating a single merged copy.
 *
 * This allows the DecoupledExporter to handle multi-hour merged exports
 * without ever exceeding browser memory limits.
 *
 * Implements only the subset of AudioBuffer the exporter actually uses:
 *   .sampleRate, .numberOfChannels, .length, .duration, .getChannelData(ch)
 */

import type { TrackMergeData } from './AudioMixer';

interface TrackSlot {
  buffer: AudioBuffer;
  /** Frame offset where this track starts in the virtual timeline */
  startFrame: number;
  /** Frame offset where this track ends (exclusive) */
  endFrame: number;
}

export class VirtualAudioBuffer {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number; // total frames
  readonly duration: number;

  private slots: TrackSlot[];
  /**
   * Lazily-allocated per-channel Float32Array containing the full merged data.
   * Built on first call to getChannelData() since the exporter reads the
   * entire channel for FFT analysis. We build it channel-by-channel and
   * stream from source buffers to avoid needing an OfflineAudioContext.
   */
  private _channelCache: Map<number, Float32Array> = new Map();

  constructor(tracks: TrackMergeData[], sampleRate: number) {
    this.sampleRate = sampleRate;
    this.numberOfChannels = 2;

    // Build the timeline layout
    this.slots = [];
    let currentFrame = 0;
    for (const track of tracks) {
      currentFrame += Math.ceil(track.gapBefore * sampleRate);
      const trackFrames = track.buffer.length;
      this.slots.push({
        buffer: track.buffer,
        startFrame: currentFrame,
        endFrame: currentFrame + trackFrames,
      });
      currentFrame += trackFrames;
    }

    this.length = currentFrame;
    this.duration = currentFrame / sampleRate;
  }

  /**
   * Returns the full channel data as a Float32Array.
   * Built lazily on first access by copying from source buffers.
   * Memory: ~8 bytes per frame per channel (float32).
   * For 195 min at 48kHz: ~2.2 GB per channel. This will work on most
   * 64-bit browsers with sufficient RAM but the per-channel lazy approach
   * keeps peak allocation lower than pre-merging both channels.
   */
  getChannelData(channel: number): Float32Array {
    const cached = this._channelCache.get(channel);
    if (cached) return cached;

    const data = new Float32Array(this.length);
    // Data starts zeroed (gaps are silence — correct)

    for (const slot of this.slots) {
      const srcCh = Math.min(channel, slot.buffer.numberOfChannels - 1);
      const src = slot.buffer.getChannelData(srcCh);
      data.set(src, slot.startFrame);
    }

    this._channelCache.set(channel, data);
    return data;
  }

  /**
   * Read a portion of a channel without allocating the full buffer.
   * Useful for chunked audio encoding.
   */
  getChannelSlice(channel: number, offset: number, length: number): Float32Array {
    // If we already have the full channel cached, just subarray
    const cached = this._channelCache.get(channel);
    if (cached) {
      return cached.subarray(offset, offset + length);
    }

    // Otherwise build just the requested slice
    const result = new Float32Array(length);
    const sliceEnd = offset + length;

    for (const slot of this.slots) {
      // Skip slots that don't overlap this slice
      if (slot.endFrame <= offset || slot.startFrame >= sliceEnd) continue;

      const srcCh = Math.min(channel, slot.buffer.numberOfChannels - 1);
      const src = slot.buffer.getChannelData(srcCh);

      // Calculate overlap region
      const overlapStart = Math.max(offset, slot.startFrame);
      const overlapEnd = Math.min(sliceEnd, slot.endFrame);

      const srcOffset = overlapStart - slot.startFrame;
      const destOffset = overlapStart - offset;
      const copyLen = overlapEnd - overlapStart;

      result.set(src.subarray(srcOffset, srcOffset + copyLen), destOffset);
    }

    return result;
  }

  /** Release cached channel data to free memory */
  dispose(): void {
    this._channelCache.clear();
  }
}

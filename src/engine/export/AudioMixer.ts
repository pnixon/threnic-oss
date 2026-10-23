/**
 * AudioMixer - Utility for mixing multiple audio tracks
 *
 * For short total durations (≤5 min): Uses OfflineAudioContext for a proper mix.
 * For longer durations: Returns a VirtualAudioBuffer that lazily reads from
 * source buffers, avoiding monolithic memory allocations that crash browsers.
 */

import { VirtualAudioBuffer } from './VirtualAudioBuffer';

export interface TrackMergeData {
  buffer: AudioBuffer;
  gapBefore: number; // Gap duration before this track in seconds
}

// Maximum duration for single-pass OfflineAudioContext rendering (~5 minutes)
const MAX_SINGLE_PASS_SECONDS = 300;

export class AudioMixer {
  /**
   * Merge multiple audio buffers into a single AudioBuffer (or VirtualAudioBuffer).
   *
   * Returns an object that implements the AudioBuffer interface subset needed
   * by the DecoupledExporter: sampleRate, numberOfChannels, length, duration,
   * getChannelData(ch).
   */
  static async mergeTracks(
    tracks: TrackMergeData[],
    context: AudioContext | OfflineAudioContext,
  ): Promise<AudioBuffer> {
    if (tracks.length === 0) {
      return context.createBuffer(2, context.sampleRate * 1, context.sampleRate);
    }

    const sampleRate = context.sampleRate;

    // Calculate total duration
    let totalDuration = 0;
    for (const track of tracks) {
      totalDuration += track.gapBefore + track.buffer.duration;
    }

    // Short merges: use real OfflineAudioContext (proper sample-accurate mix)
    if (totalDuration <= MAX_SINGLE_PASS_SECONDS) {
      return AudioMixer._renderSinglePass(tracks, totalDuration, sampleRate);
    }

    // Long merges: return a VirtualAudioBuffer that lazily reads from sources
    // Cast is safe: VirtualAudioBuffer implements the subset the exporter uses
    return new VirtualAudioBuffer(tracks, sampleRate) as unknown as AudioBuffer;
  }

  /**
   * Single-pass render for short total durations.
   */
  private static async _renderSinglePass(
    tracks: TrackMergeData[],
    totalDuration: number,
    sampleRate: number,
  ): Promise<AudioBuffer> {
    const totalFrames = Math.ceil(totalDuration * sampleRate);
    const offlineCtx = new OfflineAudioContext(2, totalFrames, sampleRate);

    let currentTime = 0;
    for (const track of tracks) {
      currentTime += track.gapBefore;
      const source = offlineCtx.createBufferSource();
      source.buffer = track.buffer;
      source.connect(offlineCtx.destination);
      source.start(currentTime);
      currentTime += track.buffer.duration;
    }

    return offlineCtx.startRendering();
  }
}

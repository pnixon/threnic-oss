/**
 * PlaylistAudioSource - Audio source for playlist playback
 *
 * Wraps the existing MediaElementSourceNode logic for playlist tracks.
 */

import { BaseAudioSource } from './BaseAudioSource';
import { createLogger } from '@/utils/logger';

const logger = createLogger({ enabled: true, prefix: 'PlaylistAudioSource' });

export class PlaylistAudioSource extends BaseAudioSource {
  private audioElement: HTMLAudioElement | null = null;

  constructor(audioElement: HTMLAudioElement) {
    super('playlist');
    this.audioElement = audioElement;
  }

  async connect(audioContext: AudioContext): Promise<AudioNode> {
    if (this.isConnected && this.sourceNode) {
      logger.debug('Playlist source already connected');
      return this.sourceNode;
    }

    if (!this.audioElement) {
      throw new Error('No audio element provided for playlist source');
    }

    try {
      // Create MediaElementSourceNode from the audio element
      this.sourceNode = audioContext.createMediaElementSource(this.audioElement);
      this.isConnected = true;
      logger.debug('Playlist source connected');
      return this.sourceNode;
    } catch (error) {
      logger.error('Failed to connect playlist source:', error as Error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    // MediaElementSourceNode doesn't need explicit cleanup
    // Just clear references
    this.sourceNode = null;
    this.isConnected = false;
    logger.debug('Playlist source disconnected');
  }

  /**
   * Update the audio element (for track changes)
   */
  setAudioElement(audioElement: HTMLAudioElement): void {
    this.audioElement = audioElement;
  }
}

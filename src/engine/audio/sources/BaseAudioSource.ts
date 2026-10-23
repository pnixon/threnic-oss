/**
 * BaseAudioSource - Abstract base class for audio input sources
 *
 * Provides a unified interface for different audio sources (playlist, microphone, etc.)
 * to integrate with the Web Audio API analysis pipeline.
 */

import type { AudioSourceType } from '@/types/audioSources';

export abstract class BaseAudioSource {
  protected sourceNode: AudioNode | null = null;
  protected isConnected = false;

  constructor(public readonly type: AudioSourceType) {}

  /**
   * Connect the audio source to the Web Audio context
   * @returns The source node that can be connected to the audio graph
   */
  abstract connect(audioContext: AudioContext): Promise<AudioNode>;

  /**
   * Disconnect and cleanup the audio source
   */
  abstract disconnect(): Promise<void>;

  /**
   * Get the current source node
   */
  getSourceNode(): AudioNode | null {
    return this.sourceNode;
  }

  /**
   * Check if the source is currently connected
   */
  isSourceConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Get the source type
   */
  getType(): AudioSourceType {
    return this.type;
  }
}

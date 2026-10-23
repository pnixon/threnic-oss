/**
 * LoopbackAudioSource - Audio source for system loopback
 *
 * Attempts to capture system audio using getUserMedia with specific constraints.
 * Note: Browser support is limited and platform-dependent.
 */

import { BaseAudioSource } from './BaseAudioSource';
import { createLogger } from '@/utils/logger';

const logger = createLogger({ enabled: true, prefix: 'LoopbackAudioSource' });

export class LoopbackAudioSource extends BaseAudioSource {
  private stream: MediaStream | null = null;

  constructor() {
    super('loopback');
  }

  async connect(audioContext: AudioContext): Promise<AudioNode> {
    if (this.isConnected && this.sourceNode) {
      logger.debug('Loopback source already connected');
      return this.sourceNode;
    }

    try {
      // Attempt to access system audio with loopback-like constraints
      // This is experimental and browser-dependent
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Some browsers support these for system audio (non-standard)
          chromeMediaSource: 'system',
          mandatory: {
            chromeMediaSource: 'system',
          },
        } as MediaTrackConstraints,
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Create MediaStreamSourceNode
      this.sourceNode = audioContext.createMediaStreamSource(this.stream);
      this.isConnected = true;

      logger.debug('Loopback source connected');
      return this.sourceNode;
    } catch (error) {
      // If the browser doesn't support loopback, provide clear error
      logger.error('Failed to connect loopback source:', error as Error);
      throw new Error(
        'System loopback audio is not supported in this browser. ' +
          'Try using Application Capture instead to capture audio from specific tabs or windows.',
      );
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    // Stop all tracks in the stream
    if (this.stream) {
      this.stream.getTracks().forEach((track) => {
        track.stop();
        logger.debug('Stopped loopback track:', track.label);
      });
      this.stream = null;
    }

    this.sourceNode = null;
    this.isConnected = false;
    logger.debug('Loopback source disconnected');
  }

  /**
   * Get the active media stream
   */
  getStream(): MediaStream | null {
    return this.stream;
  }
}

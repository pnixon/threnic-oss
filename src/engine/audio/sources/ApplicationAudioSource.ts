/**
 * ApplicationAudioSource - Audio source for application/tab capture
 *
 * Captures audio from browser tabs or applications using getDisplayMedia API.
 */

import { BaseAudioSource } from './BaseAudioSource';
import { createLogger } from '@/utils/logger';

const logger = createLogger({ enabled: true, prefix: 'ApplicationAudioSource' });

export class ApplicationAudioSource extends BaseAudioSource {
  private stream: MediaStream | null = null;

  constructor() {
    super('application');
  }

  async connect(audioContext: AudioContext): Promise<AudioNode> {
    if (this.isConnected && this.sourceNode) {
      logger.debug('Application source already connected');
      return this.sourceNode;
    }

    try {
      // Request display media with audio
      // Note: Some browsers require video:true even if only audio is needed
      const constraints: DisplayMediaStreamOptions = {
        video: true, // Required by some browsers
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      };

      this.stream = await navigator.mediaDevices.getDisplayMedia(constraints);

      // Check if audio track is present
      const audioTracks = this.stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error(
          'No audio track in captured stream. Make sure to select "Share audio" when choosing the tab/window.',
        );
      }

      // Stop video track if we don't need it
      const videoTracks = this.stream.getVideoTracks();
      videoTracks.forEach((track) => track.stop());

      // Create MediaStreamSourceNode
      this.sourceNode = audioContext.createMediaStreamSource(this.stream);
      this.isConnected = true;

      logger.debug('Application source connected', {
        audioTracks: audioTracks.length,
        label: audioTracks[0]?.label,
      });

      return this.sourceNode;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          throw new Error('Screen sharing permission denied.');
        } else if (error.name === 'NotFoundError') {
          throw new Error('No audio source found in the selected tab/window.');
        } else if (error.name === 'AbortError') {
          throw new Error('Screen sharing was cancelled.');
        }
      }
      logger.error('Failed to connect application source:', error as Error);
      throw error;
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
        logger.debug('Stopped application capture track:', track.label);
      });
      this.stream = null;
    }

    this.sourceNode = null;
    this.isConnected = false;
    logger.debug('Application source disconnected');
  }

  /**
   * Get the active media stream
   */
  getStream(): MediaStream | null {
    return this.stream;
  }
}

/**
 * MicrophoneAudioSource - Audio source for microphone input
 *
 * Captures audio from user's microphone using getUserMedia API.
 */

import { BaseAudioSource } from './BaseAudioSource';
import { createLogger } from '@/utils/logger';

const logger = createLogger({ enabled: true, prefix: 'MicrophoneAudioSource' });

export class MicrophoneAudioSource extends BaseAudioSource {
  private stream: MediaStream | null = null;
  private deviceId?: string;

  constructor(deviceId?: string) {
    super('microphone');
    this.deviceId = deviceId;
  }

  async connect(audioContext: AudioContext): Promise<AudioNode> {
    if (this.isConnected && this.sourceNode) {
      logger.debug('Microphone source already connected');
      return this.sourceNode;
    }

    try {
      // Request microphone access
      const constraints: MediaStreamConstraints = {
        audio: this.deviceId
          ? { deviceId: { exact: this.deviceId } }
          : {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Create MediaStreamSourceNode
      this.sourceNode = audioContext.createMediaStreamSource(this.stream);
      this.isConnected = true;

      logger.debug('Microphone source connected', { deviceId: this.deviceId });
      return this.sourceNode;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          throw new Error('Microphone access denied. Please grant permission in browser settings.');
        } else if (error.name === 'NotFoundError') {
          throw new Error('No microphone found. Please connect a microphone and try again.');
        } else if (error.name === 'NotReadableError') {
          throw new Error('Microphone is already in use by another application.');
        }
      }
      logger.error('Failed to connect microphone source:', error as Error);
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
        logger.debug('Stopped microphone track:', track.label);
      });
      this.stream = null;
    }

    this.sourceNode = null;
    this.isConnected = false;
    logger.debug('Microphone source disconnected');
  }

  /**
   * Get the active media stream
   */
  getStream(): MediaStream | null {
    return this.stream;
  }

  /**
   * Change the microphone device
   */
  async changeDevice(deviceId: string, audioContext: AudioContext): Promise<void> {
    await this.disconnect();
    this.deviceId = deviceId;
    await this.connect(audioContext);
  }
}

/**
 * AudioSourceManager - Manages audio input sources
 *
 * Central manager for switching between different audio sources (playlist, microphone, etc.)
 * and connecting them to the Web Audio API analysis pipeline.
 */

import { BaseAudioSource } from './sources/BaseAudioSource';
import { PlaylistAudioSource } from './sources/PlaylistAudioSource';
import { MicrophoneAudioSource } from './sources/MicrophoneAudioSource';
import { ApplicationAudioSource } from './sources/ApplicationAudioSource';
import { LoopbackAudioSource } from './sources/LoopbackAudioSource';
import type {
  AudioSourceType,
  AudioSourceCapabilities,
  AudioDeviceInfo,
} from '@/types/audioSources';
import { createLogger } from '@/utils/logger';

const logger = createLogger({ enabled: true, prefix: 'AudioSourceManager' });

export class AudioSourceManager {
  private currentSource: BaseAudioSource | null = null;
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;

  /**
   * Switch to a new audio source
   * @param sourceType - Type of audio source to switch to
   * @param audioContext - Web Audio API context
   * @param analyserNode - Analyser node for audio analysis
   * @param gainNode - Gain node for volume control
   * @param audioElement - HTML audio element (required for playlist source)
   * @param deviceId - Optional device ID for microphone
   */
  async switchSource(
    sourceType: AudioSourceType,
    audioContext: AudioContext,
    analyserNode: AnalyserNode,
    gainNode: GainNode,
    audioElement?: HTMLAudioElement,
    deviceId?: string,
  ): Promise<void> {
    // Disconnect current source if any
    if (this.currentSource) {
      await this.disconnectCurrentSource();
    }

    // Create new source based on type
    let newSource: BaseAudioSource;

    switch (sourceType) {
      case 'playlist':
        if (!audioElement) {
          throw new Error('Audio element required for playlist source');
        }
        newSource = new PlaylistAudioSource(audioElement);
        break;

      case 'microphone':
        newSource = new MicrophoneAudioSource(deviceId);
        break;

      case 'application':
        newSource = new ApplicationAudioSource();
        break;

      case 'loopback':
        newSource = new LoopbackAudioSource();
        break;

      default:
        throw new Error(`Unknown source type: ${sourceType}`);
    }

    try {
      // Connect the new source
      const sourceNode = await newSource.connect(audioContext);

      // Connect to the audio graph: source -> analyser -> gain -> destination
      sourceNode.connect(analyserNode);
      analyserNode.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Store references
      this.currentSource = newSource;
      this.audioContext = audioContext;
      this.analyserNode = analyserNode;
      this.gainNode = gainNode;

      logger.info(`Switched to ${sourceType} source`);
    } catch (error) {
      // If connection fails, clean up the failed source
      await newSource.disconnect();
      throw error;
    }
  }

  /**
   * Disconnect the current audio source
   */
  private async disconnectCurrentSource(): Promise<void> {
    if (!this.currentSource) {
      return;
    }

    try {
      // Disconnect from audio graph
      const sourceNode = this.currentSource.getSourceNode();
      if (sourceNode && this.analyserNode) {
        sourceNode.disconnect(this.analyserNode);
      }

      // Disconnect and cleanup the source
      await this.currentSource.disconnect();
      logger.debug(`Disconnected ${this.currentSource.getType()} source`);
    } catch (error) {
      logger.error('Error disconnecting source:', error as Error);
    }

    this.currentSource = null;
  }

  /**
   * Get the current active source type
   */
  getCurrentSourceType(): AudioSourceType | null {
    return this.currentSource?.getType() ?? null;
  }

  /**
   * Get the current source instance
   */
  getCurrentSource(): BaseAudioSource | null {
    return this.currentSource;
  }

  /**
   * Check browser capabilities for audio sources
   */
  static async getCapabilities(): Promise<AudioSourceCapabilities> {
    const capabilities: AudioSourceCapabilities = {
      supportsMicrophone: false,
      supportsApplicationCapture: false,
      supportsLoopback: false,
    };

    // Check for getUserMedia (microphone)
    if (typeof navigator.mediaDevices?.getUserMedia === 'function') {
      try {
        // Attempt to enumerate devices to verify microphone support
        const devices = await navigator.mediaDevices.enumerateDevices();
        capabilities.supportsMicrophone = devices.some((d) => d.kind === 'audioinput');
      } catch {
        capabilities.supportsMicrophone = false;
      }
    }

    // Check for getDisplayMedia (application capture)
    if (typeof navigator.mediaDevices?.getDisplayMedia === 'function') {
      capabilities.supportsApplicationCapture = true;
    }

    // Loopback is experimental and browser-dependent
    // We'll mark it as available but with caveats
    capabilities.supportsLoopback = typeof navigator.mediaDevices?.getUserMedia === 'function';

    return capabilities;
  }

  /**
   * Get available audio input devices
   */
  static async getAudioDevices(): Promise<AudioDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [];
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === 'audioinput')
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
          kind: device.kind,
        }));
    } catch (error) {
      logger.error('Failed to enumerate audio devices:', error as Error);
      return [];
    }
  }

  /**
   * Cleanup and disconnect all sources
   */
  async cleanup(): Promise<void> {
    await this.disconnectCurrentSource();
    this.audioContext = null;
    this.analyserNode = null;
    this.gainNode = null;
  }
}

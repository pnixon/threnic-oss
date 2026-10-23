/**
 * Audio Source Types
 *
 * Type definitions for multi-source audio input system supporting
 * playlist, microphone, application capture, and loopback sources.
 */

export type AudioSourceType = 'playlist' | 'microphone' | 'application' | 'loopback';

export interface AudioSourceCapabilities {
  supportsMicrophone: boolean;
  supportsApplicationCapture: boolean;
  supportsLoopback: boolean;
}

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

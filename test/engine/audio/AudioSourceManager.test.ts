import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioSourceManager } from '@/engine/audio/AudioSourceManager';
import { PlaylistAudioSource } from '@/engine/audio/sources/PlaylistAudioSource';
import { MicrophoneAudioSource } from '@/engine/audio/sources/MicrophoneAudioSource';
import { ApplicationAudioSource } from '@/engine/audio/sources/ApplicationAudioSource';
import { LoopbackAudioSource } from '@/engine/audio/sources/LoopbackAudioSource';

// Mock the source implementations
vi.mock('@/engine/audio/sources/PlaylistAudioSource');
vi.mock('@/engine/audio/sources/MicrophoneAudioSource');
vi.mock('@/engine/audio/sources/ApplicationAudioSource');
vi.mock('@/engine/audio/sources/LoopbackAudioSource');

describe('AudioSourceManager', () => {
  let manager: AudioSourceManager;
  let mockAudioContext: any;
  let mockAnalyserNode: any;
  let mockGainNode: any;
  let mockAudioElement: any;
  let mockSourceNode: any;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AudioSourceManager();

    mockSourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    mockAnalyserNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    mockGainNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    mockAudioContext = {
      destination: {},
      createMediaElementSource: vi.fn().mockReturnValue(mockSourceNode),
    };

    mockAudioElement = {};

    // Setup default mock implementation for sources
    (PlaylistAudioSource as any).prototype.connect = vi.fn().mockResolvedValue(mockSourceNode);
    (PlaylistAudioSource as any).prototype.disconnect = vi.fn().mockResolvedValue(undefined);
    (PlaylistAudioSource as any).prototype.getType = vi.fn().mockReturnValue('playlist');
    (PlaylistAudioSource as any).prototype.getSourceNode = vi.fn().mockReturnValue(mockSourceNode);

    (MicrophoneAudioSource as any).prototype.connect = vi.fn().mockResolvedValue(mockSourceNode);
    (MicrophoneAudioSource as any).prototype.disconnect = vi.fn().mockResolvedValue(undefined);
    (MicrophoneAudioSource as any).prototype.getType = vi.fn().mockReturnValue('microphone');
    (MicrophoneAudioSource as any).prototype.getSourceNode = vi
      .fn()
      .mockReturnValue(mockSourceNode);
  });

  it('should switch to playlist source and connect nodes', async () => {
    await manager.switchSource(
      'playlist',
      mockAudioContext,
      mockAnalyserNode,
      mockGainNode,
      mockAudioElement,
    );

    expect(PlaylistAudioSource).toHaveBeenCalled();
    expect(mockSourceNode.connect).toHaveBeenCalledWith(mockAnalyserNode);
    expect(mockAnalyserNode.connect).toHaveBeenCalledWith(mockGainNode);
    expect(mockGainNode.connect).toHaveBeenCalledWith(mockAudioContext.destination);
    expect(manager.getCurrentSourceType()).toBe('playlist');
  });

  it('should switch to microphone source', async () => {
    await manager.switchSource(
      'microphone',
      mockAudioContext,
      mockAnalyserNode,
      mockGainNode,
      undefined,
      'test-device-id',
    );

    expect(MicrophoneAudioSource).toHaveBeenCalledWith('test-device-id');
    expect(manager.getCurrentSourceType()).toBe('microphone');
  });

  it('should disconnect current source before switching to new one', async () => {
    await manager.switchSource(
      'playlist',
      mockAudioContext,
      mockAnalyserNode,
      mockGainNode,
      mockAudioElement,
    );

    const firstSource = manager.getCurrentSource();
    const disconnectSpy = vi.spyOn(firstSource!, 'disconnect');

    await manager.switchSource(
      'microphone',
      mockAudioContext,
      mockAnalyserNode,
      mockGainNode,
      undefined,
      'test-device-id',
    );

    expect(disconnectSpy).toHaveBeenCalled();
    expect(mockSourceNode.disconnect).toHaveBeenCalled();
    expect(manager.getCurrentSourceType()).toBe('microphone');
  });

  it('should throw error if playlist source is requested without audio element', async () => {
    await expect(
      manager.switchSource('playlist', mockAudioContext, mockAnalyserNode, mockGainNode),
    ).rejects.toThrow('Audio element required for playlist source');
  });

  it('should handle capabilities check', async () => {
    // Mock navigator.mediaDevices
    const mockMediaDevices = {
      getUserMedia: vi.fn(),
      getDisplayMedia: vi.fn(),
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([{ kind: 'audioinput', deviceId: 'mic1', label: 'Mic 1' }]),
    };

    vi.stubGlobal('navigator', {
      mediaDevices: mockMediaDevices,
    });

    const capabilities = await AudioSourceManager.getCapabilities();
    expect(capabilities.supportsMicrophone).toBe(true);
    expect(capabilities.supportsApplicationCapture).toBe(true);
    expect(capabilities.supportsLoopback).toBe(true);
  });

  it('should cleanup properly', async () => {
    await manager.switchSource(
      'playlist',
      mockAudioContext,
      mockAnalyserNode,
      mockGainNode,
      mockAudioElement,
    );

    const source = manager.getCurrentSource();
    const disconnectSpy = vi.spyOn(source!, 'disconnect');

    await manager.cleanup();

    expect(disconnectSpy).toHaveBeenCalled();
    expect(manager.getCurrentSourceType()).toBe(null);
  });
});
